/**
 * Pure flight and tower geometry for the globe's 3D layer, kept free of React so it can be tested
 * without a canvas. Model space everywhere: +x the right wing, +y the nose, +z the roof (or, for a
 * tower, up the shaft), all on the unit globe.
 */
import { type Matrix4, Vector3 } from 'three';

const right = new Vector3();
const up = new Vector3();
const forward = new Vector3();
const rolledRight = new Vector3();
const rolledUp = new Vector3();

/**
 * Fills `out` with an aircraft's attitude at `point`: the nose along the track tangent (so it
 * pitches up on the climb and down on the approach), the wings level with the local horizon, then
 * rolled by `bank` radians about the nose (positive dips the right wing).
 */
export function attitude(point: Vector3, tangent: Vector3, bank: number, out: Matrix4): Matrix4 {
  forward.copy(tangent).normalize();
  up.copy(point).normalize();
  right.crossVectors(forward, up).normalize();
  up.crossVectors(right, forward).normalize();
  const cos = Math.cos(bank);
  const sin = Math.sin(bank);
  rolledRight.copy(right).multiplyScalar(cos).addScaledVector(up, -sin);
  rolledUp.copy(up).multiplyScalar(cos).addScaledVector(right, sin);
  return out.makeBasis(rolledRight, forward, rolledUp).setPosition(point);
}

/**
 * The bank of a coordinated turn: the track's sideways curvature between two tangents `ds` apart
 * (arc length), toward `side` (the right wing), mapped through atan so it saturates smoothly at `max` radians. A
 * great-circle route flies wings level; a curving one leans into the turn.
 */
export function bankAngle(
  before: Vector3,
  after: Vector3,
  side: Vector3,
  ds: number,
  max = 0.45,
  gain = 0.6,
): number {
  if (ds <= 0) return 0;
  const sideways = (after.dot(side) - before.dot(side)) / ds;
  return (Math.atan(sideways * gain) / (Math.PI / 2)) * max;
}

const smooth = (edge0: number, edge1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/** How much of an aircraft shows at `u` along its route: it grows in on take-off, shrinks on landing. */
export function presence(u: number): number {
  if (u < 0 || u > 1) return 0;
  return smooth(0, 0.045, u) * (1 - smooth(0.95, 1, u));
}

/** The shortest shaft left under the cab, in model units, so even a small airport reads as a tower. */
const SHAFT_STUB = 1.5;

/**
 * Shaft height for a tower whose total height (shaft plus cab) is the data height, so the column's
 * top still sits at its departures, linear, exactly as the map key says.
 */
export function towerShaft(height: number, cab: number): number {
  return Math.max(SHAFT_STUB, height - cab);
}
