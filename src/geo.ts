/**
 * Geometry helpers.
 *
 * Two questions are asked of geometry in this service: is a point inside a set
 * of rings, and how far is a point from the edge of those rings. The second is
 * what implements the entry ring and the padded release zone without needing a
 * buffered polygon: "within 40 NM of the FIR" is "inside, or within 40 NM of
 * the boundary".
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

  /** Shortest distance to any boundary segment. Zero-ish when on the edge. */
  distanceToEdgeNm(lat: number, lon: number): number {
    let best = Infinity;
    for (const ring of this.rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const d = distanceToSegmentNm(lat, lon, ring[i]!, ring[j]!);
        if (d < best) best = d;
      }
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
