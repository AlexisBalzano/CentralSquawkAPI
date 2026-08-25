/**
 * Mode S 1000 eligibility.
 *
 * A flight qualifies when it is Mode S capable per ICAO field 10 AND every
 * point of its route lies inside the Mode S area. The two halves are evaluated
 * separately on purpose: the geographic half depends only on the route, so it
 * is cached against the route text and shared by every flight filing it, while
 * the equipment half is per flight and costs nothing.
 */

import type { Navdata } from "./navdata.js";

/**
 * Field 10b surveillance letters that count as Mode S capable, matching the
 * set CCAMS uses in production. P and X are excluded: they are Mode S but carry
 * no aircraft identification, which conspicuity operation depends on.
 */
export const MODE_S_SURVEILLANCE = "EHILS";

/** `B738/M-SDE1E2E3FGHIJ1J5RWXY/LB1D1` -> the surveillance group after the last `/`. */
const AIRCRAFT_INFO = /^(\w{2,4})\/([LMHJ])-(\w+)\/(\w+)$/;

export function isModeSCapable(
  aircraftInfo: string | null,
  accepted: string = MODE_S_SURVEILLANCE,
): boolean {
  if (!aircraftInfo) return false;
  const m = AIRCRAFT_INFO.exec(aircraftInfo.trim().toUpperCase());
  if (!m) return false;
  const surveillance = m[4]!;
  return [...accepted.toUpperCase()].some((letter) => surveillance.includes(letter));
}

/** Speed/level groups such as `N0450F350` or `K0880S1130`. */
const SPEED_LEVEL = /^[KN]\d{4}[FSAM]\d{3,4}$/;
/** Tokens that carry no position and are simply skipped. */
const IGNORED_TOKENS = new Set(["DCT", "SID", "STAR", "IFR", "VFR"]);

export type RouteVerdict =
  | { inside: true }
  | { inside: false; reason: string };

/**
 * Whether every point of a route lies inside the Mode S area.
 *
 * Fails closed: a token that looks like a point but cannot be resolved denies
 * eligibility, because "outside the area" and "not in our data" are
 * indistinguishable here and both should yield a discrete code.
 */
export function routeStaysInside(
  navdata: Navdata,
  departure: string | null,
  arrival: string | null,
  route: string | null,
): RouteVerdict {
  if (!route || route.trim().length === 0) {
    return { inside: false, reason: "no route filed" };
  }

  const depProcedures = departure ? navdata.procedures.get(departure) : undefined;
  const arrProcedures = arrival ? navdata.procedures.get(arrival) : undefined;

  const tokens = route.trim().toUpperCase().split(/\s+/);
  const points: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;

    if (IGNORED_TOKENS.has(token) || SPEED_LEVEL.test(token)) continue;

    // A procedure name is only ever a procedure of this flight's own departure
    // or destination. Matching the bare designator against every airport would
    // wrongly skip the handful of identifiers that are both a procedure name
    // and a real fix (BRAVO, HON, NORTH, ROCIO, SOUTH, TSC).
    if (depProcedures?.has(token) || arrProcedures?.has(token)) continue;

    const chains = navdata.airways.get(token);
    if (chains) {
      const entry = points.at(-1) ?? null;
      const exit = tokens[i + 1] ?? null;
      const walked = walkAirway(chains, entry, exit);
      if (!walked) {
        return { inside: false, reason: `airway ${token} cannot be expanded` };
      }
      // Entry and exit are contributed by the tokens either side of the airway.
      points.push(...walked.slice(1, -1));
      continue;
    }

    points.push(token);
  }

  for (const point of points) {
    if (!navdata.fixes.has(point)) {
      return { inside: false, reason: `${point} is outside the area or unknown` };
    }
  }
  return { inside: true };
}

/**
 * Walk one airway between two fixes.
 *
 * A designator may be published as disjoint segments, so every chain is tried
 * and the one containing both endpoints wins. Order in the chain gives
 * direction: an entry later than the exit is walked backwards.
 */
function walkAirway(
  chains: string[][],
  entry: string | null,
  exit: string | null,
): string[] | null {
  if (!entry || !exit) return null;
  for (const chain of chains) {
    const from = chain.indexOf(entry);
    const to = chain.indexOf(exit);
    if (from === -1 || to === -1) continue;
    return from <= to ? chain.slice(from, to + 1) : chain.slice(to, from + 1).reverse();
  }
  return null;
}

/**
 * Route verdicts keyed on the route text rather than the callsign.
 *
 * The same city pairs are filed with identical routes all day, so a route-keyed
 * cache hits far more often than a flight-keyed one. The cache is only valid
 * for the navdata that produced it, so it MUST be cleared whenever a config
 * snapshot is swapped in -- an AIRAC that moves an airway changes the verdict
 * for routes whose text has not changed at all.
 */
export class RouteCache {
  private readonly entries = new Map<string, RouteVerdict>();
  private hits = 0;
  private misses = 0;

  constructor(private readonly limit = 20_000) {}

  verdict(
    navdata: Navdata,
    departure: string | null,
    arrival: string | null,
    route: string | null,
  ): RouteVerdict {
    const key = `${departure ?? ""}|${(route ?? "").trim().toUpperCase().replace(/\s+/g, " ")}|${arrival ?? ""}`;
    const cached = this.entries.get(key);
    if (cached) {
      this.hits++;
      return cached;
    }
    this.misses++;
    const verdict = routeStaysInside(navdata, departure, arrival, route);
    if (this.entries.size >= this.limit) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, verdict);
    return verdict;
  }

  clear(): void {
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
  }

  get stats(): { size: number; hits: number; misses: number } {
    return { size: this.entries.size, hits: this.hits, misses: this.misses };
  }
}
