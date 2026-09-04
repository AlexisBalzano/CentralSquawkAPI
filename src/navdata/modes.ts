/**
 * Mode S 1000 eligibility.
 *
 * A flight qualifies when it is Mode S capable per ICAO field 10, its
 * destination is in a participating state, and the REMAINING route -- from
 * where the aircraft is now to the destination -- stays inside the Mode S area.
 *
 * Remaining, not whole. An inbound from Montreal has most of its filed route
 * over the Atlantic and North America, but once it is over Brittany everything
 * ahead of it is Mode S airspace and it should be squawking 1000. Judging the
 * whole route would deny conspicuity to every long-haul arrival.
 */

import { greatCircleNm } from "../geo.js";
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

/** Whether a destination aerodrome sits in a Mode S participating state. */
export function destinationParticipates(
  arrival: string | null,
  states: ReadonlySet<string>,
): boolean {
  if (!arrival || arrival.length < 2) return false;
  return states.has(arrival.slice(0, 2).toUpperCase());
}

/**
 * Speed/level groups: `N0450F350`, `M085F400`, `K0880S1130`.
 * Speed is knots, Mach or km/h; level is flight level, metric level or altitude.
 *
 * `VFR` stands in for the level at a change of flight rules -- `DISVU/N0290VFR`
 * is the point a flight goes VFR, not a fix called DISVU/N0290VFR. Missing that
 * form leaves an unknown point in the route and silently costs the flight its
 * conspicuity code.
 */
const SPEED_LEVEL = /^(?:[KN]\d{4}|M\d{3})(?:[FSAM]\d{3,4}|VFR)$/;
/** Tokens that carry no position and are simply skipped. */
const IGNORED_TOKENS = new Set(["DCT", "SID", "STAR", "IFR", "VFR"]);

/** A SID/STAR designator: a fix name, a revision number, an optional letter. */
const DESIGNATOR = /^([A-Z]+)(\d{1,2}[A-Z]?)$/;

/**
 * Whether a token names a procedure published by the given aerodrome.
 *
 * ARINC 424 caps procedure identifiers at six characters and truncates the fix
 * name to fit, so the DFD holds BIKM1A where the AIP publishes -- and the pilot
 * files -- BIKMU1A. Matching the strings directly misses every designator that
 * was long enough to be truncated, which is most of them: 9,212 of the 11,172
 * we ship sit at exactly six characters.
 *
 * So a match requires the revision suffix to be equal and one fix name to be a
 * prefix of the other.
 */
function namesProcedure(token: string, designators: ReadonlySet<string> | undefined): boolean {
  if (!designators || designators.size === 0) return false;
  if (designators.has(token)) return true;

  const m = DESIGNATOR.exec(token);
  if (!m) return false;
  const filedFix = m[1]!;
  const filedSuffix = m[2]!;

  for (const published of designators) {
    const p = DESIGNATOR.exec(published);
    if (!p || p[2] !== filedSuffix) continue;
    const publishedFix = p[1]!;
    if (filedFix.startsWith(publishedFix) || publishedFix.startsWith(filedFix)) return true;
  }
  return false;
}

/**
 * Marks a position in the route we could not resolve to a point.
 *
 * Prefixed with a character no identifier contains, so it can never collide
 * with a real fix and is never found in fix.txt. Recording it in place rather
 * than aborting is what makes the remaining-route rule work: an airway that
 * cannot be expanded matters only if it is still ahead of the aircraft.
 */
const UNRESOLVED_PREFIX = "?";

export function unresolved(token: string): string {
  return UNRESOLVED_PREFIX + token;
}

export function isUnresolved(point: string): boolean {
  return point.startsWith(UNRESOLVED_PREFIX);
}

/**
 * Tokenise a filed route into the points it crosses, in order.
 *
 * Depends only on the route text and the navdata, never on where the aircraft
 * is, which is what lets the result be cached and shared between every flight
 * filing the same route.
 */
/**
 * The point a field 15 token names, dropping any speed or level change attached
 * to it: `DITAL/N0389F270` -> `DITAL`, `UN491` -> `UN491`.
 *
 * Applied to every token, including the one peeked at as an airway's exit fix --
 * a suffix left on there makes the whole airway unexpandable.
 */
function pointName(token: string): string {
  const slash = token.indexOf("/");
  if (slash <= 0) return token;
  return SPEED_LEVEL.test(token.slice(slash + 1)) ? token.slice(0, slash) : token;
}

export function expandRoute(
  navdata: Navdata,
  departure: string | null,
  arrival: string | null,
  route: string | null,
): string[] {
  if (!route || route.trim().length === 0) return [];

  const depProcedures = departure ? navdata.procedures.get(departure) : undefined;
  const arrProcedures = arrival ? navdata.procedures.get(arrival) : undefined;

  const tokens = route.trim().toUpperCase().split(/\s+/);
  const points: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = pointName(tokens[i]!);

    if (IGNORED_TOKENS.has(token) || SPEED_LEVEL.test(token)) continue;

    // A procedure name is only ever a procedure of this flight's own departure
    // or destination. Matching the bare designator against every airport would
    // wrongly skip the handful of identifiers that are both a procedure name
    // and a real fix (BRAVO, HON, NORTH, ROCIO, SOUTH, TSC).
    if (namesProcedure(token, depProcedures) || namesProcedure(token, arrProcedures)) continue;

    const chains = navdata.airways.get(token);
    if (chains) {
      const entry = points.at(-1) ?? null;
      // pointName again: the exit fix is just as likely to carry a speed/level
      // change as any other point, and `UN491 DITAL/N0389F270` must leave the
      // airway at DITAL, not at a name no chain can contain.
      const next = tokens[i + 1];
      const exit = next === undefined ? null : pointName(next);
      const walked = walkAirway(chains, entry, exit);
      if (!walked) {
        // Cannot expand it. Leave a marker so the segment is treated as
        // outside-or-unknown if it is still ahead of the aircraft, and ignored
        // if it has already been flown.
        points.push(unresolved(token));
        continue;
      }
      // Entry and exit are contributed by the tokens either side of the airway.
      points.push(...walked.slice(1, -1));
      continue;
    }

    points.push(token);
  }

  return points;
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

export type RemainingVerdict =
  | { inside: true; fromIndex: number }
  | { inside: false; reason: string };

/**
 * Whether everything still ahead of the aircraft lies inside the Mode S area.
 *
 * Progress along the route is estimated as the nearest point we have a position
 * for. Only in-area points have positions -- fix.txt is clipped to the area --
 * so the estimate is only meaningful for an aircraft that is itself in or near
 * the area, which every flight in scope is by definition.
 */
export function remainingRouteInside(
  navdata: Navdata,
  points: readonly string[],
  latitude: number,
  longitude: number,
): RemainingVerdict {
  if (points.length === 0) return { inside: false, reason: "no route filed" };

  let nearest = -1;
  let nearestNm = Infinity;
  for (let i = 0; i < points.length; i++) {
    const fix = navdata.fixes.get(points[i]!);
    if (!fix) continue;
    const d = greatCircleNm(latitude, longitude, fix.lat, fix.lon);
    if (d < nearestNm) {
      nearestNm = d;
      nearest = i;
    }
  }

  if (nearest < 0) {
    // Nothing on the route is inside the area, so either the flight is nowhere
    // near it or the route is unusable. Either way, no conspicuity.
    return { inside: false, reason: "no route point lies inside the area" };
  }

  for (let i = nearest; i < points.length; i++) {
    const point = points[i]!;
    if (!navdata.fixes.has(point)) {
      return {
        inside: false,
        reason: isUnresolved(point)
          ? `${point.slice(1)} ahead cannot be expanded`
          : `${point} ahead is outside the area`,
      };
    }
  }
  return { inside: true, fromIndex: nearest };
}

/**
 * Expanded routes keyed on the route text.
 *
 * Expansion is the expensive half and depends only on the text, so the same
 * city pair filed all day costs one expansion. The remaining-route test is
 * cheap and runs per flight, because it depends on where the aircraft is.
 *
 * The cache MUST be cleared whenever a config snapshot is swapped in: an
 * expansion is only valid for the navdata that produced it, and an AIRAC that
 * moves an airway changes the result for routes whose text has not changed.
 */
export class RouteCache {
  private readonly entries = new Map<string, string[]>();
  private hits = 0;
  private misses = 0;

  constructor(private readonly limit = 20_000) {}

  expand(
    navdata: Navdata,
    departure: string | null,
    arrival: string | null,
    route: string | null,
  ): string[] {
    const key = `${departure ?? ""}|${(route ?? "").trim().toUpperCase().replace(/\s+/g, " ")}|${arrival ?? ""}`;
    const cached = this.entries.get(key);
    if (cached) {
      this.hits++;
      return cached;
    }
    this.misses++;
    const points = expandRoute(navdata, departure, arrival, route);
    if (this.entries.size >= this.limit) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, points);
    return points;
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
