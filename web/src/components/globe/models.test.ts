import { Box3, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  AIRPORT_PART,
  AIRPORT_RIDE,
  airlinerGeometry,
  airlinerShadowGeometry,
  airportGeometry,
  CAB_HEIGHT,
  PLANE_PART,
} from './models';

function triangles(geometry: { getAttribute(name: string): { count: number } }): number {
  return geometry.getAttribute('position').count / 3;
}

function values(geometry: ReturnType<typeof airportGeometry>, name: string): Set<number> {
  return new Set(geometry.getAttribute(name).array as Float32Array);
}

describe('airlinerGeometry', () => {
  const plane = airlinerGeometry();

  it('stays inside a small triangle budget, so dozens can be instanced cheaply', () => {
    expect(triangles(plane)).toBeLessThan(1200);
  });

  it('is about 2 long with the nose at +y and roughly as wide as it is long', () => {
    const box = new Box3().setFromBufferAttribute(
      plane.getAttribute('position') as Parameters<Box3['setFromBufferAttribute']>[0],
    );
    const size = box.getSize(new Vector3());
    expect(size.y).toBeGreaterThan(1.9);
    expect(size.y).toBeLessThan(2.4);
    expect(size.x).toBeGreaterThan(1.7);
    expect(box.max.y).toBeGreaterThan(-box.min.y * 0.9);
    // The fin stands up from the roof.
    expect(box.max.z).toBeGreaterThan(0.4);
  });

  it('paints body, livery and metal, with unit normals', () => {
    expect(values(plane, 'aPart')).toEqual(
      new Set([PLANE_PART.body, PLANE_PART.livery, PLANE_PART.metal]),
    );
    const normal = plane.getAttribute('normal');
    for (let i = 0; i < normal.count; i += 1) {
      const length = Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i));
      expect(length).toBeCloseTo(1, 3);
    }
  });
});

describe('airlinerShadowGeometry', () => {
  it('is a flat, symmetric silhouette', () => {
    const shadow = airlinerShadowGeometry();
    const box = new Box3().setFromBufferAttribute(
      shadow.getAttribute('position') as Parameters<Box3['setFromBufferAttribute']>[0],
    );
    expect(box.max.z - box.min.z).toBe(0);
    expect(box.max.x).toBeCloseTo(-box.min.x, 6);
  });
});

describe('airportGeometry', () => {
  const airport = airportGeometry();
  const position = airport.getAttribute('position');
  const ride = airport.getAttribute('aRide');

  it('has a shaft spanning 0..1 for the shader to stretch to the data height', () => {
    let low = Infinity;
    let high = -Infinity;
    for (let i = 0; i < position.count; i += 1) {
      if (ride.getX(i) !== AIRPORT_RIDE.shaft) continue;
      low = Math.min(low, position.getZ(i));
      high = Math.max(high, position.getZ(i));
    }
    expect(low).toBeCloseTo(0, 6);
    expect(high).toBeCloseTo(1, 6);
  });

  it('tops the cab out at CAB_HEIGHT, so tower height stays the data height', () => {
    let high = -Infinity;
    for (let i = 0; i < position.count; i += 1) {
      if (ride.getX(i) === AIRPORT_RIDE.cab) high = Math.max(high, position.getZ(i));
    }
    expect(high).toBeCloseTo(CAB_HEIGHT, 5);
  });

  it('keeps the airfield on the ground, and every material present', () => {
    for (let i = 0; i < position.count; i += 1) {
      if (ride.getX(i) === AIRPORT_RIDE.ground) expect(position.getZ(i)).toBeGreaterThan(-0.2);
    }
    expect(values(airport, 'aPart')).toEqual(new Set(Object.values(AIRPORT_PART)));
    expect(triangles(airport)).toBeLessThan(800);
  });
});
