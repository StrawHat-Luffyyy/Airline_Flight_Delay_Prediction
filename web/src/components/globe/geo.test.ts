import { describe, expect, it } from 'vitest';
import {
  angleBetween,
  arcLift,
  buildRouteArcs,
  chapterAt,
  delayTone,
  fitSize,
  flowCount,
  frame,
  mergeAirportRankings,
  greatCircleMiles,
  introShot,
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
  it('grows with distance and stays low enough for a close US framing', () => {
    const short = arcLift(latLonToVec3(40, -74, 1), latLonToVec3(39, -77, 1));
    const long = arcLift(latLonToVec3(40, -74, 1), latLonToVec3(34, -118, 1));
    expect(short).toBeGreaterThanOrEqual(0.012);
    expect(long).toBeGreaterThan(short);
    expect(long).toBeLessThanOrEqual(0.14);
  });
});

describe('mergeAirportRankings', () => {
  const row = (key: string, delayRate: number) => ({ key, delayRate });

  it('is complete when the two ends of the ranking overlap, and drops the duplicates', () => {
    const worst = [row('ASE', 0.29), row('ORD', 0.2), row('ATL', 0.15)];
    const best = [row('ITO', 0.08), row('SLC', 0.1), row('ATL', 0.15)];
    const merged = mergeAirportRankings(worst, best, 3);
    expect(merged.complete).toBe(true);
    expect(merged.rows.map((r) => r.key).sort()).toEqual(['ASE', 'ATL', 'ITO', 'ORD', 'SLC']);
  });

  it('is complete when either end came back short of the limit', () => {
    expect(mergeAirportRankings([row('A', 1)], [row('B', 0)], 3).complete).toBe(true);
  });

  it('is incomplete when both ends are full and disjoint (the middle is missing)', () => {
    const merged = mergeAirportRankings([row('A', 1), row('B', 1)], [row('C', 0), row('D', 0)], 2);
    expect(merged.complete).toBe(false);
    expect(merged.rows).toHaveLength(4);
  });
});

describe('delayTone', () => {
  it('is 0 at the national rate, positive above it and negative below, clamped to 1', () => {
    expect(delayTone(0.18, 0.18)).toBe(0);
    expect(delayTone(0.22, 0.18)).toBeCloseTo(0.5, 6);
    expect(delayTone(0.05, 0.18)).toBe(-1);
    expect(delayTone(0.9, 0.18)).toBe(1);
  });

  it('is null when either rate is unknown', () => {
    expect(delayTone(null, 0.18)).toBeNull();
    expect(delayTone(0.2, null)).toBeNull();
  });
});

describe('flowCount', () => {
  it('lights one moving point per 1,000 scheduled flights, at least 1 and at most 14', () => {
    expect(flowCount(400)).toBe(1);
    expect(flowCount(4_600)).toBe(5);
    expect(flowCount(90_000)).toBe(14);
  });
});

describe('fitSize', () => {
  it('frames a short hop closer than a long haul, within the bounds', () => {
    const hop = fitSize(0.05, 2, 4.5);
    const haul = fitSize(0.6, 2, 4.5);
    expect(hop).toBe(4.5);
    expect(haul).toBeGreaterThanOrEqual(2);
    expect(haul).toBeLessThan(hop);
  });
});

describe('angleBetween', () => {
  it('is the central angle in radians between two lat/lon points', () => {
    close(angleBetween({ lat: 0, lon: 0 }, { lat: 0, lon: 90 }), Math.PI / 2);
    close(angleBetween({ lat: 10, lon: 20 }, { lat: 10, lon: 20 }), 0);
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
        { key: 'DCA-JFK', delayRate: 0.35, flights: 1027, completed: 913, avgArrDelay: 20.3 },
        { key: 'ABQ-SLC', delayRate: 0.05, flights: 1036, completed: 1031, avgArrDelay: -8.4 },
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
      avgArrDelay: 20.3,
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

describe('greatCircleMiles', () => {
  it('measures LAX to JFK at about 2,475 statute miles', () => {
    const miles = greatCircleMiles(
      { latitude: 33.94254, longitude: -118.40807 },
      { latitude: 40.63975, longitude: -73.77893 },
    );
    expect(miles).toBeGreaterThan(2460);
    expect(miles).toBeLessThan(2490);
  });

  it('is 0 for the same airport', () => {
    expect(greatCircleMiles({ latitude: 10, longitude: 20 }, { latitude: 10, longitude: 20 })).toBe(
      0,
    );
  });
});


describe('introShot', () => {
  it('starts wide and turned, and lands exactly on the framed pose', () => {
    const start = introShot(0);
    expect(start.size).toBeLessThan(1);
    expect(start.lon).not.toBe(0);
    expect(introShot(1)).toEqual({ size: 1, lon: 0, lat: 0 });
    expect(introShot(5)).toEqual({ size: 1, lon: 0, lat: 0 });
  });

  it('is monotonic: the camera never backs out while settling', () => {
    const sizes = [0, 0.2, 0.4, 0.6, 0.8, 1].map((t) => introShot(t).size);
    for (let i = 1; i < sizes.length; i += 1)
      expect(sizes[i]!).toBeGreaterThanOrEqual(sizes[i - 1]!);
  });
});
