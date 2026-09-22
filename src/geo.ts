/**
 * Geometry helpers.
 *
 * Two questions are asked of geometry in this service: is a point inside a set
 * of rings, and how far is a point from the edge of those rings. The second is
 * what implements the entry ring and the padded release zone without needing a
 * buffered polygon: "within 40 NM of the FIR" is "inside, or within 40 NM of
 * the boundary". The border band's inner edge is the same question asked from
 * the other side: "5 NM inside" is "inside, and at least 5 NM from the
 * boundary".
 *
 * Distances use a locally-projected plane rather than full great-circle
 * segment maths. Over the tens of nautical miles these thresholds involve, at
 * European latitudes, the error is far below the precision the thresholds
 * themselves are chosen to.
 */

/** GeoJSON order: [longitude, latitude]. */
export type Position = readonly [number, number];
export type Ring = readonly Position[];

const NM_PER_DEGREE = 60;

export function greatCircleNm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const cos =
    Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(dl);
  return 3440.065 * Math.acos(Math.max(-1, Math.min(1, cos)));
}

function pointInRing(lat: number, lon: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a[1] > lat !== b[1] > lat) {
      const x = a[0] + ((lat - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
      if (lon < x) inside = !inside;
    }
  }
  return inside;
}

/** Distance from a point to a segment, in a plane scaled around that point. */
function distanceToSegmentNm(
  lat: number,
  lon: number,
  a: Position,
  b: Position,
): number {
  const kx = Math.cos((lat * Math.PI) / 180) * NM_PER_DEGREE;
  const ky = NM_PER_DEGREE;
  const px = (a[0] - lon) * kx;
  const py = (a[1] - lat) * ky;
  const qx = (b[0] - lon) * kx;
  const qy = (b[1] - lat) * ky;
  const dx = qx - px;
  const dy = qy - py;
  const lenSq = dx * dx + dy * dy;
  // t is where the perpendicular from the point lands along the segment,
  // clamped so a point "beyond" an end measures to the end itself.
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, -(px * dx + py * dy) / lenSq));
  const cx = px + t * dx;
  const cy = py + t * dy;
  return Math.hypot(cx, cy);
}

type Segment = readonly [Position, Position];

/** Below this sine of the angle between them, two edges count as parallel. */
const PARALLEL = 1e-9;
/** Degrees, about a tenth of a millimetre: closer than this, a point is on a line. */
const ON_LINE_DEG = 1e-9;
/** Degrees, about a centimetre: how far either side of an edge to probe. */
const SIDE_STEP_DEG = 1e-7;

/**
 * Add to `cuts` the fractions along a-b, strictly between its ends, at which
 * c-d crosses or touches it. Collinear edges overlap rather than cross, so they
 * cut where the overlap starts and stops: where an edge shared with another
 * ring comes to an end.
 */
function cutsAlong(a: Position, b: Position, c: Position, d: Position, cuts: number[]): void {
  const rx = b[0] - a[0];
  const ry = b[1] - a[1];
  const sx = d[0] - c[0];
  const sy = d[1] - c[1];
  const qx = c[0] - a[0];
  const qy = c[1] - a[1];
  const rr = rx * rx + ry * ry;
  const cross = rx * sy - ry * sx;
  const keep = (t: number): void => {
    if (t > 0 && t < 1) cuts.push(t);
  };

  if (Math.abs(cross) > PARALLEL * Math.sqrt(rr * (sx * sx + sy * sy))) {
    const u = (qx * ry - qy * rx) / cross;
    if (u >= 0 && u <= 1) keep((qx * sy - qy * sx) / cross);
    return;
  }
  // Parallel: only an edge on the same line can share a stretch of this one.
  if (Math.abs(qx * ry - qy * rx) > ON_LINE_DEG * Math.sqrt(rr)) return;
  keep((qx * rx + qy * ry) / rr);
  keep(((d[0] - a[0]) * rx + (d[1] - a[1]) * ry) / rr);
}

/**
 * The parts of a set of rings' edges that separate the area from the outside.
 *
 * Rings overlap. The AOR is the five French FIRs AND the UIR covering all of
 * them, so most FIR edges are seams through the middle of the area rather than
 * its boundary, and a depth measured to them would put every airport near an
 * internal FIR boundary on the border of France. Rings also disagree slightly
 * about where a shared border runs, which makes the true boundary a zigzag
 * between them.
 *
 * Each edge is cut wherever another edge crosses or joins it, and a piece is
 * kept when a point just to one side of it is inside the area and a point just
 * to the other is not. That one test settles seams, shared outer edges and
 * disagreeing rings alike, using the same containment test as everything else.
 */
function outlineOf(
  rings: readonly Ring[],
  contains: (lat: number, lon: number) => boolean,
): Segment[] {
  const edges: Segment[] = [];
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j]!;
      const b = ring[i]!;
      // A closed GeoJSON ring repeats its first point, so one edge is empty.
      if (a[0] !== b[0] || a[1] !== b[1]) edges.push([a, b]);
    }
  }

  // [west, east, south, north] of each edge, a hair wider than the edge itself
  // so that edges which only just touch are still compared.
  const boxes = edges.map(([a, b]) => [
    Math.min(a[0], b[0]) - ON_LINE_DEG,
    Math.max(a[0], b[0]) + ON_LINE_DEG,
    Math.min(a[1], b[1]) - ON_LINE_DEG,
    Math.max(a[1], b[1]) + ON_LINE_DEG,
  ] as const);

  const outline: Segment[] = [];
  for (let e = 0; e < edges.length; e++) {
    const [a, b] = edges[e]!;
    const box = boxes[e]!;
    const cuts = [0, 1];
    for (let o = 0; o < edges.length; o++) {
      const other = boxes[o]!;
      // Edges whose boxes do not meet cannot touch, and most pairs end here.
      if (o === e || other[1] < box[0] || other[0] > box[1] || other[3] < box[2] || other[2] > box[3]) {
        continue;
      }
      cutsAlong(a, b, edges[o]![0], edges[o]![1], cuts);
    }
    cuts.sort((x, y) => x - y);

    const rx = b[0] - a[0];
    const ry = b[1] - a[1];
    const length = Math.hypot(rx, ry);
    const nx = (-ry / length) * SIDE_STEP_DEG;
    const ny = (rx / length) * SIDE_STEP_DEG;

    for (let k = 1; k < cuts.length; k++) {
      const t0 = cuts[k - 1]!;
      const t1 = cuts[k]!;
      // Too short to probe reliably, and dropping it moves nothing measurable.
      if ((t1 - t0) * length < SIDE_STEP_DEG) continue;
      const mx = a[0] + ((t0 + t1) / 2) * rx;
      const my = a[1] + ((t0 + t1) / 2) * ry;
      if (contains(my + ny, mx + nx) === contains(my - ny, mx - nx)) continue;
      outline.push([
        [a[0] + t0 * rx, a[1] + t0 * ry],
        [a[0] + t1 * rx, a[1] + t1 * ry],
      ]);
    }
  }
  return outline;
}

/**
 * A set of rings treated as one area. Containment means inside any ring, which
 * is union semantics without needing a geometry library to compute the union.
 */
export class Area {
  private readonly bbox: {
    south: number;
    west: number;
    north: number;
    east: number;
  };
  /**
   * Built on first use, not here: cutting every edge against every other is
   * quadratic, and the Mode S area -- six times the AOR's size -- is never
   * measured at all.
   */
  private outline: readonly Segment[] | null = null;

  constructor(readonly rings: readonly Ring[]) {
    let south = 90;
    let west = 180;
    let north = -90;
    let east = -180;
    for (const ring of rings) {
      for (const [lon, lat] of ring) {
        if (lat < south) south = lat;
        if (lat > north) north = lat;
        if (lon < west) west = lon;
        if (lon > east) east = lon;
      }
    }
    this.bbox = { south, west, north, east };
  }

  get isEmpty(): boolean {
    return this.rings.length === 0;
  }

  contains(lat: number, lon: number): boolean {
    const { south, west, north, east } = this.bbox;
    if (lat < south || lat > north || lon < west || lon > east) return false;
    return this.rings.some((ring) => pointInRing(lat, lon, ring));
  }

  /**
   * Shortest distance to the edge of the area, from inside or out. Zero-ish on
   * the edge. A seam where rings overlap is not an edge; see outlineOf.
   */
  distanceToEdgeNm(lat: number, lon: number): number {
    this.outline ??= outlineOf(this.rings, (la, lo) => this.contains(la, lo));
    let best = Infinity;
    for (const [a, b] of this.outline) {
      const d = distanceToSegmentNm(lat, lon, a, b);
      if (d < best) best = d;
    }
    return best;
  }

  /** Inside, or outside but no further than `nm` from the boundary. */
  withinNm(lat: number, lon: number, nm: number): boolean {
    if (this.contains(lat, lon)) return true;
    // Cheap reject before walking every segment: the bbox grown by nm.
    const dLat = nm / NM_PER_DEGREE;
    const dLon = dLat / Math.max(0.05, Math.cos((lat * Math.PI) / 180));
    const { south, west, north, east } = this.bbox;
    if (
      lat < south - dLat ||
      lat > north + dLat ||
      lon < west - dLon ||
      lon > east + dLon
    ) {
      return false;
    }
    return this.distanceToEdgeNm(lat, lon) <= nm;
  }

  /** Inside, and at least `nm` from the edge: the area shrunk by `nm`. */
  insideByNm(lat: number, lon: number, nm: number): boolean {
    return this.contains(lat, lon) && this.distanceToEdgeNm(lat, lon) >= nm;
  }
}

/** Pull rings out of a GeoJSON document, optionally filtering by feature id. */
export function ringsFromGeoJson(
  doc: unknown,
  keepFeature?: (properties: Record<string, unknown>) => boolean,
): Ring[] {
  const rings: Ring[] = [];

  const walk = (node: unknown, properties: Record<string, unknown>): void => {
    if (typeof node !== "object" || node === null) return;
    const obj = node as Record<string, unknown>;
    switch (obj["type"]) {
      case "FeatureCollection":
        for (const f of (obj["features"] as unknown[]) ?? []) walk(f, properties);
        return;
      case "Feature": {
        const props = (obj["properties"] as Record<string, unknown>) ?? {};
        if (keepFeature && !keepFeature(props)) return;
        walk(obj["geometry"], props);
        return;
      }
      case "Polygon":
        for (const ring of (obj["coordinates"] as Position[][]) ?? []) {
          if (ring.length >= 4) rings.push(ring);
        }
        return;
      case "MultiPolygon":
        for (const poly of (obj["coordinates"] as Position[][][]) ?? []) {
          for (const ring of poly) if (ring.length >= 4) rings.push(ring);
        }
        return;
      default:
        return;
    }
  };

  walk(doc, {});
  return rings;
}
