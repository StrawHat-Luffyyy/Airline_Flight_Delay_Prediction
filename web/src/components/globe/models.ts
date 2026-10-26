/**
 * Procedural models for the globe's 3D layer: a twin-engine airliner and an airport (control tower
 * plus a small airfield). Both are built from a few hundred triangles at runtime, so nothing is
 * downloaded, and each is one geometry drawn with instancing (one draw call per layer).
 *
 * Every vertex carries `aPart`, the material it belongs to, so one shader paints the whole model.
 * The airport also carries `aRide`: how a vertex follows its tower's data height (see AirportRide).
 * Units: the airliner is 2 long (nose at +y), the airport is in tower units (see Airports.tsx).
 */
import {
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  Matrix4,
  Shape,
  ShapeGeometry,
  SphereGeometry,
  Vector3,
} from 'three';

/** Airliner materials. */
export const PLANE_PART = { body: 0, livery: 1, metal: 2 } as const;

/** Airport materials. */
export const AIRPORT_PART = {
  shaft: 0,
  glass: 1,
  structure: 2,
  runway: 3,
  terminal: 4,
  apron: 5,
} as const;

/**
 * How an airport vertex follows its tower's data height: the shaft stretches to it, the cab rides
 * on top of it (and scales with the airport's size), and the airfield stays on the ground.
 */
export const AIRPORT_RIDE = { shaft: 0, cab: 1, ground: 2 } as const;

type Vec = readonly [number, number, number];

interface Piece {
  geometry: BufferGeometry;
  part: number;
  ride?: number;
}

/**
 * A convex slab between four planform corners (leading root, trailing root, trailing tip, leading
 * tip), `thick` deep along `axis` at the root and `thickTip` at the tip. Faces are wound outward
 * automatically, so mirrored copies (the left wing) need no special handling. Flat-shaded.
 */
function slab(
  corners: readonly [Vec, Vec, Vec, Vec],
  thick: number,
  thickTip: number,
  axis: Vec = [0, 0, 1],
): BufferGeometry {
  const ax = new Vector3(...axis);
  const half = [thick / 2, thick / 2, thickTip / 2, thickTip / 2];
  const top = corners.map((c, i) => new Vector3(...c).addScaledVector(ax, half[i]!));
  const bottom = corners.map((c, i) => new Vector3(...c).addScaledVector(ax, -half[i]!));
  const v = [...top, ...bottom];
  const centre = v.reduce((sum, p) => sum.add(p), new Vector3()).multiplyScalar(1 / v.length);
  const quads = [
    [0, 1, 2, 3],
    [4, 7, 6, 5],
    [0, 4, 5, 1],
    [1, 5, 6, 2],
    [2, 6, 7, 3],
    [3, 7, 4, 0],
  ];
  const out: number[] = [];
  const ab = new Vector3();
  const ac = new Vector3();
  const mid = new Vector3();
  for (const [a, b, c, d] of quads) {
    for (const tri of [
      [a!, b!, c!],
      [a!, c!, d!],
    ]) {
      const [p, q, r] = tri.map((index) => v[index]!) as [Vector3, Vector3, Vector3];
      ab.subVectors(q, p);
      ac.subVectors(r, p);
      mid
        .copy(p)
        .add(q)
        .add(r)
        .multiplyScalar(1 / 3)
        .sub(centre);
      const outward = ab.cross(ac).dot(mid) >= 0;
      for (const point of outward ? [p, q, r] : [p, r, q]) out.push(point.x, point.y, point.z);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(out), 3));
  geometry.computeVertexNormals();
  return geometry;
}

const mirror = ([x, y, z]: Vec): Vec => [-x, y, z];

/** Merges pieces into one non-indexed geometry with position, normal, aPart and (optionally) aRide. */
function merge(pieces: readonly Piece[], withRide: boolean): BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const parts: number[] = [];
  const rides: number[] = [];
  for (const { geometry, part, ride = 0 } of pieces) {
    const flat = geometry.index ? geometry.toNonIndexed() : geometry;
    const position = flat.getAttribute('position');
    if (!flat.getAttribute('normal')) flat.computeVertexNormals();
    const normal = flat.getAttribute('normal');
    for (let i = 0; i < position.count; i += 1) {
      positions.push(position.getX(i), position.getY(i), position.getZ(i));
      normals.push(normal.getX(i), normal.getY(i), normal.getZ(i));
      parts.push(part);
      rides.push(ride);
    }
    if (flat !== geometry) flat.dispose();
    geometry.dispose();
  }
  const merged = new BufferGeometry();
  merged.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  merged.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  merged.setAttribute('aPart', new BufferAttribute(new Float32Array(parts), 1));
  if (withRide) merged.setAttribute('aRide', new BufferAttribute(new Float32Array(rides), 1));
  merged.computeBoundingSphere();
  return merged;
}

/** A cylinder standing along +z from `z0` to `z1` (three builds them along +y). */
function column(radiusTop: number, radiusBottom: number, z0: number, z1: number, sides: number) {
  return new CylinderGeometry(radiusTop, radiusBottom, z1 - z0, sides, 1, false)
    .rotateX(Math.PI / 2)
    .translate(0, 0, (z0 + z1) / 2);
}

/** A flat box on the ground, `w` by `l` by `h`, centred at (x, y), turned `angle` about +z. */
function block(w: number, l: number, h: number, x: number, y: number, z = 0, angle = 0) {
  return slab(
    [
      [-w / 2, l / 2, h / 2],
      [-w / 2, -l / 2, h / 2],
      [w / 2, -l / 2, h / 2],
      [w / 2, l / 2, h / 2],
    ],
    h,
    h,
  )
    .applyMatrix4(new Matrix4().makeRotationZ(angle))
    .translate(x, y, z);
}

/**
 * A twin-engine narrow-body airliner, about 2 long and 1.9 across: a round fuselage with a domed
 * nose and an upswept tail cone, swept low wings with dihedral and winglets, two underwing
 * nacelles, a tailplane and a fin. The fin and winglets are the livery (tinted per route).
 */
export function airlinerGeometry(): BufferGeometry {
  const r = 0.105;
  const fuselage = new CylinderGeometry(r, r, 1.46, 14, 1, true).translate(0, 0.06, 0);
  const nose = new SphereGeometry(r, 14, 7, 0, Math.PI * 2, 0, Math.PI / 2)
    .scale(1, 2.3, 1)
    .translate(0, 0.79, 0);
  const tail = new CylinderGeometry(r, 0.026, 0.4, 14, 1, true)
    .translate(0, -0.87, 0)
    // Sweep the cone up toward the tail (z rises as y falls).
    .applyMatrix4(new Matrix4().makeShear(0, 0, 0, -0.25, 0, 0))
    .translate(0, 0, -0.1675);
  const wing: [Vec, Vec, Vec, Vec] = [
    [0.08, 0.24, -0.05],
    [0.08, -0.22, -0.05],
    [0.95, -0.46, 0.04],
    [0.95, -0.3, 0.04],
  ];
  const winglet: [Vec, Vec, Vec, Vec] = [
    [0.95, -0.3, 0.04],
    [0.95, -0.46, 0.04],
    [0.99, -0.5, 0.17],
    [0.99, -0.42, 0.17],
  ];
  const stabiliser: [Vec, Vec, Vec, Vec] = [
    [0.02, -0.74, 0.04],
    [0.02, -0.96, 0.04],
    [0.38, -1.04, 0.08],
    [0.38, -0.95, 0.08],
  ];
  const fin: [Vec, Vec, Vec, Vec] = [
    [0, -0.6, 0.08],
    [0, -1.0, 0.08],
    [0, -1.07, 0.47],
    [0, -0.9, 0.47],
  ];
  // A nacelle along the nose axis, its intake (the wider end) forward.
  const nacelle = (x: number) =>
    column(0.058, 0.05, -0.15, 0.15, 12)
      .rotateX(-Math.PI / 2)
      .translate(x, 0.08, -0.115);
  const pylon = (x: number) => block(0.02, 0.16, 0.07, x, 0.05, -0.07);
  const sym = ([a, b, c, d]: [Vec, Vec, Vec, Vec]): [Vec, Vec, Vec, Vec] => [
    mirror(a),
    mirror(b),
    mirror(c),
    mirror(d),
  ];
  return merge(
    [
      { geometry: fuselage, part: PLANE_PART.body },
      { geometry: nose, part: PLANE_PART.body },
      { geometry: tail, part: PLANE_PART.body },
      { geometry: slab(wing, 0.05, 0.018), part: PLANE_PART.body },
      { geometry: slab(sym(wing), 0.05, 0.018), part: PLANE_PART.body },
      { geometry: slab(winglet, 0.018, 0.012, [0, 0, 1]), part: PLANE_PART.livery },
      { geometry: slab(sym(winglet), 0.018, 0.012, [0, 0, 1]), part: PLANE_PART.livery },
      { geometry: slab(stabiliser, 0.025, 0.012), part: PLANE_PART.body },
      { geometry: slab(sym(stabiliser), 0.025, 0.012), part: PLANE_PART.body },
      { geometry: slab(fin, 0.03, 0.014, [1, 0, 0]), part: PLANE_PART.livery },
      { geometry: nacelle(0.34), part: PLANE_PART.metal },
      { geometry: nacelle(-0.34), part: PLANE_PART.metal },
      { geometry: pylon(0.34), part: PLANE_PART.metal },
      { geometry: pylon(-0.34), part: PLANE_PART.metal },
    ],
    false,
  );
}

/**
 * Where the airliner's lights sit, in its model space: red port and green starboard wingtips, a
 * white strobe on the tail cone and a red beacon on the roof.
 */
export const NAV_LIGHTS = [
  { at: [-0.99, -0.42, 0.06] as Vec, color: '#ff4a3d', strobe: false },
  { at: [0.99, -0.42, 0.06] as Vec, color: '#3dff8b', strobe: false },
  { at: [0, -1.08, 0.0] as Vec, color: '#ffffff', strobe: true },
  { at: [0, 0.1, 0.12] as Vec, color: '#ff5a3a', strobe: true },
] as const;

/** The airliner's top-down silhouette (nose +y, 2 long), flat: its ground shadow. */
export function airlinerShadowGeometry(): ShapeGeometry {
  const shape = new Shape();
  const points: [number, number][] = [
    [0, 1.03],
    [0.07, 0.85],
    [0.1, 0.25],
    [0.95, -0.3],
    [0.97, -0.46],
    [0.1, -0.22],
    [0.08, -0.74],
    [0.38, -0.95],
    [0.38, -1.04],
    [0.03, -0.98],
    [0, -1.08],
  ];
  points.forEach(([x, y], index) => (index === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y)));
  for (const [x, y] of [...points].reverse().slice(1)) shape.lineTo(-x, y);
  shape.closePath();
  return new ShapeGeometry(shape);
}

/** The cab, in tower units above the shaft top: neck, glass, roof and mast. Light at the top. */
export const CAB_HEIGHT = 7.6;

/**
 * An airport in tower units: an octagonal tapered shaft standing on the ground (z 0..1, stretched
 * to the data height by the shader), a flared control cab with a slanted glass band, a roof and a
 * mast riding on its top, and at its foot a small airfield (two parallel runways, a terminal with
 * a pier, and an apron). The layout is generic, the same for every airport: only the tower height
 * (departures) and colour (delay rate) carry data.
 */
export function airportGeometry(): BufferGeometry {
  const { shaft, cab, ground } = AIRPORT_RIDE;
  const P = AIRPORT_PART;
  return merge(
    [
      { geometry: column(1.25, 1.9, 0, 1, 8), part: P.shaft, ride: shaft },
      { geometry: column(3.1, 1.25, 0, 1.7, 8), part: P.structure, ride: cab },
      { geometry: column(3.55, 3.0, 1.7, 4.3, 8), part: P.glass, ride: cab },
      { geometry: column(2.3, 3.8, 4.3, 5.0, 8), part: P.structure, ride: cab },
      { geometry: column(0.16, 0.24, 5.0, CAB_HEIGHT, 4), part: P.structure, ride: cab },
      { geometry: block(30, 1.5, 0.12, 3, 7.5), part: P.runway, ride: ground },
      { geometry: block(26, 1.3, 0.12, -1, -17.5), part: P.runway, ride: ground },
      { geometry: block(18, 8, 0.05, -1, -8.6), part: P.apron, ride: ground },
      { geometry: block(12, 3.4, 1.7, -2, -5.6, 0.85), part: P.terminal, ride: ground },
      { geometry: block(1.6, 5.2, 1.1, -2, -9.5, 0.55), part: P.terminal, ride: ground },
    ],
    true,
  );
}
