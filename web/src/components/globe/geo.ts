/**
 * Pure geometry for the landing globe: no three.js, so it is unit-tested without WebGL.
 * Coordinates are a right-handed unit sphere with +y north and lat 0 / lon 0 facing +z.
 */

export type Vec3 = readonly [number, number, number];

const RAD = Math.PI / 180;

export function latLonToVec3(lat: number, lon: number, radius: number): Vec3 {
  const phi = lat * RAD;
  const lambda = lon * RAD;
  return [
    radius * Math.cos(phi) * Math.sin(lambda),
    radius * Math.sin(phi),
    radius * Math.cos(phi) * Math.cos(lambda),
  ];
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (v: Vec3): number => Math.hypot(v[0], v[1], v[2]);

/** Central angle between two points on a sphere, in radians. */
function centralAngle(a: Vec3, b: Vec3): number {
  const cos = dot(a, b) / (norm(a) * norm(b));
  return Math.acos(Math.min(1, Math.max(-1, cos)));
}

/**
 * Arc height above the surface: a short hop stays low, a coast-to-coast arc climbs. Capped low,
 * because the camera sits close over the US and a tall arc would fly out of frame.
 */
export function arcLift(a: Vec3, b: Vec3): number {
  return Math.min(0.14, Math.max(0.012, centralAngle(a, b) * 0.2));
}

/** Central angle between two lat/lon points (degrees in), in radians. */
export function angleBetween(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  return centralAngle(latLonToVec3(a.lat, a.lon, 1), latLonToVec3(b.lat, b.lon, 1));
}

/**
 * Globe size (see Pose.size) that frames a feature spanning `angle` radians: a short hop is framed
 * closer than a long haul, within [min, max].
 */
export function fitSize(angle: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, 0.8 / Math.max(angle, 1e-3)));
}

/**
 * The two ends of an airport delay-rate ranking (each capped at `limit` rows) merged into one list.
 * It is `complete` (every airport over the minimum is present) when the ends overlap or either came
 * back short; otherwise the middle of the ranking is missing and the caller must say so.
 */
export function mergeAirportRankings<T extends { key: string | number }>(
  worst: readonly T[],
  best: readonly T[],
  limit: number,
): { rows: T[]; complete: boolean } {
  const byKey = new Map<string | number, T>();
  for (const row of [...worst, ...best]) byKey.set(row.key, row);
  const overlap = worst.length + best.length - byKey.size;
  return {
    rows: [...byKey.values()],
    complete: overlap > 0 || worst.length < limit || best.length < limit,
  };
}

/** How far a delay rate sits from the national rate: -1 (well below) .. 0 .. 1 (well above). */
export function delayTone(
  rate: number | null,
  national: number | null,
  spread = 0.08,
): number | null {
  if (rate === null || national === null) return null;
  return Math.min(1, Math.max(-1, (rate - national) / spread));
}

/** Moving lights along a route: one per 1,000 scheduled 2015 flights, between 1 and 14. */
export function flowCount(flights: number): number {
  return Math.min(14, Math.max(1, Math.round(flights / 1000)));
}

/**
 * `segments + 1` points along the great circle from `a` to `b` (both on the unit sphere), lifted
 * by a sine bump that peaks at `lift` above the surface halfway along.
 */
export function greatCirclePoints(a: Vec3, b: Vec3, segments: number, lift: number): Vec3[] {
  const omega = centralAngle(a, b);
  const sinOmega = Math.sin(omega);
  const points: Vec3[] = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    // Slerp; identical endpoints fall back to a plain lerp (which is the point itself).
    const wa = sinOmega < 1e-6 ? 1 - t : Math.sin((1 - t) * omega) / sinOmega;
    const wb = sinOmega < 1e-6 ? t : Math.sin(t * omega) / sinOmega;
    const p: Vec3 = [a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb];
    const scale = (1 + lift * Math.sin(Math.PI * t)) / (norm(p) || 1);
    points.push([p[0] * scale, p[1] * scale, p[2] * scale]);
  }
  return points;
}

export function parseRouteKey(key: string | number): { origin: string; dest: string } | null {
  if (typeof key !== 'string') return null;
  const match = /^([A-Z0-9]{3})-([A-Z0-9]{3})$/.exec(key);
  return match ? { origin: match[1]!, dest: match[2]! } : null;
}

/** late / punctual: the delay-rate ranking. network: a selected airport's busiest destinations. */
export type ArcKind = 'late' | 'punctual' | 'network';

export interface RouteArc {
  id: string;
  origin: string;
  dest: string;
  kind: ArcKind;
  delayRate: number | null;
  flights: number;
  /** Completed flights; null where the source (an airport's network) does not report it. */
  completed: number | null;
  /** Mean arrival delay of completed flights, minutes (negative = early). */
  avgArrDelay: number | null;
  points: Vec3[];
  /** The great-circle midpoint, so the globe can turn to face the route. */
  mid: { lat: number; lon: number };
}

/** Latitude and longitude, in degrees, of a direction from the globe centre. */
export function vec3ToLatLon([x, y, z]: Vec3): { lat: number; lon: number } {
  const r = Math.hypot(x, y, z) || 1;
  return { lat: Math.asin(y / r) / RAD, lon: Math.atan2(x, z) / RAD };
}

export interface Coordinates {
  latitude: number | null;
  longitude: number | null;
}

/** Routes whose two airports both have coordinates, as arcs. The rest are skipped, not guessed. */
export function buildRouteArcs(
  rows: readonly {
    key: string | number;
    delayRate: number | null;
    flights: number;
    completed: number | null;
    avgArrDelay: number | null;
  }[],
  airports: ReadonlyMap<string, Coordinates>,
  kind: ArcKind,
  segments = 64,
): RouteArc[] {
  const arcs: RouteArc[] = [];
  for (const row of rows) {
    const route = parseRouteKey(row.key);
    if (!route) continue;
    const from = airports.get(route.origin);
    const to = airports.get(route.dest);
    if (from?.latitude == null || from.longitude == null) continue;
    if (to?.latitude == null || to.longitude == null) continue;
    const a = latLonToVec3(from.latitude, from.longitude, 1);
    const b = latLonToVec3(to.latitude, to.longitude, 1);
    const points = greatCirclePoints(a, b, segments, arcLift(a, b));
    arcs.push({
      id: `${route.origin}-${route.dest}`,
      ...route,
      kind,
      delayRate: row.delayRate,
      flights: row.flights,
      completed: row.completed,
      avgArrDelay: row.avgArrDelay,
      points,
      mid: vec3ToLatLon(points[Math.floor(segments / 2)]!),
    });
  }
  return arcs;
}

/**
 * Which chapter the reader is on, as a float: the fractional index of the section whose middle
 * sits at the viewport middle (`center`, a document offset). `mids` are section middles, ascending.
 */
export function chapterAt(mids: readonly number[], center: number): number {
  if (mids.length === 0) return 0;
  if (center <= mids[0]!) return 0;
  for (let i = 0; i < mids.length - 1; i += 1) {
    const from = mids[i]!;
    const to = mids[i + 1]!;
    if (center <= to) return i + (center - from) / (to - from);
  }
  return mids.length - 1;
}

/** Where the globe sits and how lit it is, per chapter. */
export interface Pose {
  /** The point turned toward the camera. */
  lat: number;
  lon: number;
  /** Globe radius as a fraction of half the viewport's shorter side (1 = touches both edges). */
  size: number;
  /** Globe centre offset as a fraction of half the viewport (x 0.5 = three quarters across). */
  x: number;
  y: number;
  /** Route-arc and airport brightness multipliers. */
  arcs: number;
  airports: number;
}

const smoothstep = (t: number): number => t * t * (3 - 2 * t);

/**
 * Camera distance and world-space centre for a pose in a viewport of `aspect` (width / height),
 * for a perspective camera with vertical field of view `fovDeg`. Globe radius is 1.
 */
export function frame(
  pose: Pose,
  aspect: number,
  fovDeg: number,
): { distance: number; x: number; y: number } {
  const tan = Math.tan((fovDeg * RAD) / 2);
  const distance = 1 / (pose.size * tan * Math.min(1, aspect));
  const halfHeight = distance * tan;
  return { distance, x: pose.x * halfHeight * aspect, y: pose.y * halfHeight };
}

/** The pose at a fractional chapter, smoothstep-eased between neighbours and clamped at the ends. */
export function poseAt(poses: readonly Pose[], chapter: number): Pose {
  const last = poses.length - 1;
  const clamped = Math.min(last, Math.max(0, chapter));
  const index = Math.min(last - 1, Math.floor(clamped));
  if (index < 0) return poses[0]!;
  const a = poses[index]!;
  const b = poses[index + 1]!;
  const t = smoothstep(clamped - index);
  if (t === 0) return a;
  if (t === 1) return b;
  const mix = (key: keyof Pose) => a[key] + (b[key] - a[key]) * t;
  return {
    lat: mix('lat'),
    lon: mix('lon'),
    size: mix('size'),
    x: mix('x'),
    y: mix('y'),
    arcs: mix('arcs'),
    airports: mix('airports'),
  };
}

const EARTH_RADIUS_MILES = 3958.8;

/** Haversine distance between two airports, in statute miles. */
export function greatCircleMiles(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const dLat = (b.latitude - a.latitude) * RAD;
  const dLon = (b.longitude - a.longitude) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * RAD) * Math.cos(b.latitude * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The whole revolution (a multiple of 360 degrees) closest to an accumulated spin. */
export function nearestTurn(degrees: number): number {
  return Math.round(degrees / 360) * 360 + 0;
}

/**
 * The opening camera move, as offsets on the hero pose: it starts wide and turned toward the
 * Pacific, then settles with an exponential ease. `t` is 0..1 of the shot; past 1 it holds.
 */
export function introShot(t: number): { size: number; lon: number; lat: number } {
  const clamped = Math.min(1, Math.max(0, t));
  const e = clamped >= 1 ? 1 : 1 - Math.pow(2, -10 * clamped);
  if (e === 1) return { size: 1, lon: 0, lat: 0 };
  return { size: 0.2 + 0.8 * e, lon: -40 * (1 - e), lat: 10 * (1 - e) };
}
