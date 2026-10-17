import { describe, expect, it } from 'vitest';
import {
  arcLift,
  buildRouteArcs,
  chapterAt,
  frame,
  greatCirclePoints,
  latLonToVec3,
  parseRouteKey,
  poseAt,
  vec3ToLatLon,
  type Pose,
} from './geo';

const close = (actual: number, expected: number) => expect(actual).toBeCloseTo(expected, 6);
const length = ([x, y, z]: readonly [number, number, number]) => Math.hypot(x, y, z);

describe('latLonToVec3', () => {
  it('puts lat 0, lon 0 facing +z (the camera)', () => {
    const [x, y, z] = latLonToVec3(0, 0, 1);
    close(x, 0);
    close(y, 0);
    close(z, 1);
  });

  it('puts the north pole on +y and lon 90 on +x', () => {
    close(latLonToVec3(90, 0, 1)[1], 1);
    close(latLonToVec3(0, 90, 1)[0], 1);
  });

  it('scales by the radius', () => {
    close(length(latLonToVec3(33.9, -118.4, 2.5)), 2.5);
  });
});

describe('vec3ToLatLon', () => {
  it('inverts latLonToVec3 at any radius', () => {
    const { lat, lon } = vec3ToLatLon(latLonToVec3(33.94, -118.41, 1.3));
    close(lat, 33.94);
    close(lon, -118.41);
  });
});

describe('greatCirclePoints', () => {
  const lax = latLonToVec3(33.94254, -118.40807, 1);
  const jfk = latLonToVec3(40.63975, -73.77893, 1);

  it('starts and ends on the two airports, on the surface', () => {
    const points = greatCirclePoints(lax, jfk, 32, 0.2);
    expect(points).toHaveLength(33);
    const first = points[0]!;
    const last = points[32]!;
    close(first[0], lax[0]);
    close(last[2], jfk[2]);
    close(length(first), 1);
    close(length(last), 1);
  });

  it('lifts the middle by the requested height', () => {
    const points = greatCirclePoints(lax, jfk, 32, 0.2);
    close(length(points[16]!), 1.2);
  });

  it('handles identical endpoints without NaN', () => {
    const points = greatCirclePoints(lax, lax, 4, 0.1);
    expect(points.flat().every(Number.isFinite)).toBe(true);
  });
});

describe('arcLift', () => {
  it('grows with distance and stays within bounds', () => {
    const short = arcLift(latLonToVec3(40, -74, 1), latLonToVec3(39, -77, 1));
    const long = arcLift(latLonToVec3(40, -74, 1), latLonToVec3(34, -118, 1));
    expect(short).toBeGreaterThanOrEqual(0.03);
    expect(long).toBeGreaterThan(short);
    expect(long).toBeLessThanOrEqual(0.32);
  });
});

describe('parseRouteKey', () => {
  it('splits ORIGIN-DEST', () => {
    expect(parseRouteKey('DCA-JFK')).toEqual({ origin: 'DCA', dest: 'JFK' });
  });

  it('rejects anything else', () => {
    expect(parseRouteKey('DCAJFK')).toBeNull();
    expect(parseRouteKey(42)).toBeNull();
  });
});

describe('buildRouteArcs', () => {
  const airports = new Map([
    ['DCA', { latitude: 38.85, longitude: -77.04 }],
    ['JFK', { latitude: 40.64, longitude: -73.78 }],
    ['ABQ', { latitude: 35.04, longitude: -106.61 }],
  ]);

  it('keeps routes whose two airports have coordinates, tagged by kind', () => {
    const arcs = buildRouteArcs(
      [
        { key: 'DCA-JFK', delayRate: 0.35, flights: 1027, completed: 913 },
        { key: 'ABQ-SLC', delayRate: 0.05, flights: 1036, completed: 1031 },
      ],
      airports,
      'late',
      16,
    );
    expect(arcs).toHaveLength(1);
    expect(arcs[0]).toMatchObject({
      id: 'DCA-JFK',
      kind: 'late',
      delayRate: 0.35,
      flights: 1027,
      completed: 913,
    });
    expect(arcs[0]!.points).toHaveLength(17);
    // The midpoint lies between the two airports.
    expect(arcs[0]!.mid.lat).toBeGreaterThan(38.85);
    expect(arcs[0]!.mid.lat).toBeLessThan(40.64);
    expect(arcs[0]!.mid.lon).toBeGreaterThan(-77.04);
    expect(arcs[0]!.mid.lon).toBeLessThan(-73.78);
  });
});

describe('chapterAt', () => {
  const mids = [500, 1500, 2500];

  it('is the fractional index of the section whose middle is at the viewport middle', () => {
    expect(chapterAt(mids, 500)).toBe(0);
    expect(chapterAt(mids, 1000)).toBe(0.5);
    expect(chapterAt(mids, 2500)).toBe(2);
  });

  it('clamps before the first and after the last section', () => {
    expect(chapterAt(mids, 0)).toBe(0);
    expect(chapterAt(mids, 9000)).toBe(2);
  });

  it('is 0 with no sections', () => {
    expect(chapterAt([], 100)).toBe(0);
  });
});

describe('poseAt', () => {
  const a: Pose = { lat: 0, lon: 0, size: 0.6, x: 0, y: 0, arcs: 1, airports: 1 };
  const b: Pose = { lat: 20, lon: -100, size: 1, x: 1, y: -1, arcs: 0, airports: 2 };

  it('returns the exact pose on a whole chapter', () => {
    expect(poseAt([a, b], 1)).toEqual(b);
  });

  it('eases between neighbours (smoothstep: the midpoint is halfway)', () => {
    const mid = poseAt([a, b], 0.5);
    close(mid.size, 0.8);
    close(mid.lon, -50);
  });

  it('clamps out-of-range chapters', () => {
    expect(poseAt([a, b], -3)).toEqual(a);
    expect(poseAt([a, b], 7)).toEqual(b);
  });
});

describe('frame', () => {
  const pose: Pose = { lat: 0, lon: 0, size: 1, x: 0.5, y: -1, arcs: 1, airports: 1 };

  it('makes a size-1 globe exactly fill the height of a landscape viewport', () => {
    const { distance } = frame(pose, 16 / 9, 30);
    // Visible half-height at that distance equals the radius.
    close(distance * Math.tan((15 * Math.PI) / 180), 1);
  });

  it('fits the width instead on a portrait viewport', () => {
    const { distance } = frame(pose, 0.5, 30);
    close(distance * Math.tan((15 * Math.PI) / 180) * 0.5, 1);
  });

  it('offsets by fractions of the visible half-width and half-height', () => {
    const { distance, x, y } = frame(pose, 2, 30);
    const halfHeight = distance * Math.tan((15 * Math.PI) / 180);
    close(x, 0.5 * halfHeight * 2);
    close(y, -halfHeight);
  });
});
