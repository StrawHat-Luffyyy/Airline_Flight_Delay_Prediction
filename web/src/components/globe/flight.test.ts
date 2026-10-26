import { Matrix4, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { attitude, bankAngle, presence, towerShaft } from './flight';

const close = (actual: number, expected: number, digits = 6) =>
  expect(actual).toBeCloseTo(expected, digits);

function axes(matrix: Matrix4) {
  const right = new Vector3();
  const forward = new Vector3();
  const up = new Vector3();
  matrix.extractBasis(right, forward, up);
  return { right, forward, up };
}

describe('attitude', () => {
  it('points the nose along the tangent and the roof away from the globe', () => {
    const point = new Vector3(0, 0, 1.05);
    const tangent = new Vector3(1, 0, 0);
    const { right, forward, up } = axes(attitude(point, tangent, 0, new Matrix4()));
    close(forward.x, 1);
    close(up.z, 1);
    // Right-handed: right x forward = up.
    close(new Vector3().crossVectors(right, forward).dot(up), 1);
  });

  it('pitches the nose up on the climb, keeping an orthonormal frame', () => {
    const point = new Vector3(0, 0, 1);
    const climbing = new Vector3(1, 0, 0.3).normalize();
    const matrix = attitude(point, climbing, 0, new Matrix4());
    const { right, forward, up } = axes(matrix);
    expect(forward.z).toBeGreaterThan(0.25);
    close(right.length(), 1);
    close(up.length(), 1);
    close(right.dot(forward), 0);
    close(up.dot(forward), 0);
    // Wings stay level with the local horizon when there is no bank.
    close(right.z, 0);
  });

  it('dips the right wing for a positive bank', () => {
    const point = new Vector3(0, 0, 1);
    const tangent = new Vector3(1, 0, 0);
    const { right, up } = axes(attitude(point, tangent, 0.3, new Matrix4()));
    expect(right.z).toBeLessThan(0);
    close(right.z, -Math.sin(0.3));
    expect(up.z).toBeCloseTo(Math.cos(0.3), 6);
  });

  it('places the frame at the point', () => {
    const point = new Vector3(0.2, 0.3, 0.95);
    const matrix = attitude(point, new Vector3(0, 1, 0), 0, new Matrix4());
    const at = new Vector3().setFromMatrixPosition(matrix);
    close(at.distanceTo(point), 0);
  });
});

describe('bankAngle', () => {
  const right = new Vector3(0, -1, 0);
  it('is zero on a straight track', () => {
    close(bankAngle(new Vector3(1, 0, 0), new Vector3(1, 0, 0), right, 0.01), 0);
  });

  it('banks into a turn toward the right wing, and the other way for a left turn', () => {
    const before = new Vector3(1, 0, 0);
    const turningRight = new Vector3(1, -0.02, 0).normalize();
    const turningLeft = new Vector3(1, 0.02, 0).normalize();
    expect(bankAngle(before, turningRight, right, 0.01)).toBeGreaterThan(0);
    expect(bankAngle(before, turningLeft, right, 0.01)).toBeLessThan(0);
  });

  it('never exceeds the limit', () => {
    const sharp = new Vector3(0, -1, 0);
    expect(bankAngle(new Vector3(1, 0, 0), sharp, right, 0.0001, 0.4)).toBeLessThanOrEqual(0.4);
  });

  it('is zero for a zero step', () => {
    close(bankAngle(new Vector3(1, 0, 0), new Vector3(0, -1, 0), right, 0), 0);
  });
});

describe('presence', () => {
  it('grows in on the take-off roll and shrinks away on landing', () => {
    close(presence(0), 0);
    close(presence(0.5), 1);
    close(presence(1), 0);
    expect(presence(0.02)).toBeGreaterThan(0);
    expect(presence(0.02)).toBeLessThan(1);
    expect(presence(0.98)).toBeLessThan(1);
  });

  it('is zero off the route', () => {
    close(presence(-0.1), 0);
    close(presence(1.2), 0);
  });
});

describe('towerShaft', () => {
  it('keeps the whole tower, cab included, exactly as tall as the data height', () => {
    close(towerShaft(150, 7.5) + 7.5, 150);
    close(towerShaft(40, 5) + 5, 40);
  });

  it('keeps a short stub of shaft under the cab for the smallest airports', () => {
    expect(towerShaft(2, 7.5)).toBeGreaterThan(0);
    close(towerShaft(2, 7.5), towerShaft(3, 7.5));
  });
});
