/**
 * Observations supplied by a client rather than read from the VATSIM datafeed.
 *
 * There are two of them, and they sit in one file deliberately: they differ
 * almost entirely in how much they are trusted, and that difference is only
 * visible when they are read side by side.
 *
 *  - `parseSeed` is the LIVE world. A controller asks for a code the moment a
 *    pilot connects, which is a datafeed cycle or more before the feed carries
 *    them, so the plugin supplies the flight plan it already holds. The feed
 *    remains authoritative and overrides the seed the instant it catches up, so
 *    the seed is trusted with as little as possible.
 *
 *  - `parsePushed` is the SIMULATOR world, reached only when the server runs
 *    with FEED_SOURCE=push. There is no datafeed behind a sweatbox, so the
 *    pushed picture is not competing with a better source -- it is the only
 *    source, and has to carry everything the feed would have.
 *
 * The one field that separates them is the transponder. A seed never carries
 * one, because phase 2 of the tick reserves every observed exclusive code
 * before allocating anything and a code taken on a client's word would let any
 * client drain the live pool and manufacture DUPEs against real traffic. A
 * pushed observation must carry one, because adoption and DUPE detection have
 * nothing else to work from. That is safe precisely because a push-mode server
 * is a separate instance holding a separate pool: there is no real traffic
 * there to collide with.
 */

import type { FeedResult } from "../vatsim/datafeed.js";
import type { Observation } from "./types.js";

/** Long enough for any real field 15; short enough that the route cache is safe. */
const MAX_ROUTE_CHARS = 2048;
/** Field 10 with a full equipment string is ~100 characters. */
const MAX_EQUIPMENT_CHARS = 256;
/** Nothing on VATSIM moves this fast; a bad parse should not classify as airborne. */
const MAX_GROUNDSPEED_KT = 2000;
/** A sweatbox runs tens of aircraft. This is a backstop, not a working limit. */
const MAX_PUSHED_OBSERVATIONS = 2000;

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function icao(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toUpperCase();
  return trimmed.length === 4 ? trimmed : null;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, max);
}

/**
 * The fields both parsers read identically, or null if the payload is unusable.
 *
 * Position is the only hard requirement. Everything else has a defensible
 * absent value -- an unfiled route denies 1000, an unfiled destination draws
 * from an any-destination range -- but a flight with no position cannot be
 * placed inside or outside the zone at all, and one built from a guessed
 * position would be issued a code on the strength of the guess.
 */
function common(
  body: Record<string, unknown>,
  callsign: string,
): Omit<Observation, "transponder"> | null {
  const latitude = finite(body.latitude);
  const longitude = finite(body.longitude);
  if (latitude === null || longitude === null) return null;
  if (latitude < -90 || latitude > 90) return null;
  if (longitude < -180 || longitude > 180) return null;

  const rules = typeof body.flightRules === "string" ? body.flightRules.trim().toUpperCase() : "";
  const groundspeed = finite(body.groundspeed) ?? 0;

  return {
    callsign,
    // EuroScope does not expose a pilot's CID, and the field only feeds
    // reconnect recognition, which needs the datafeed to mean anything.
    cid: 0,
    latitude,
    longitude,
    altitude: Math.trunc(finite(body.altitude) ?? 0),
    groundspeed: Math.min(Math.max(Math.trunc(groundspeed), 0), MAX_GROUNDSPEED_KT),
    flightRules: rules === "I" || rules === "V" ? rules : null,
    departure: icao(body.departure),
    arrival: icao(body.arrival),
    equipment: text(body.equipment, MAX_EQUIPMENT_CHARS),
    route: text(body.route, MAX_ROUTE_CHARS),
  };
}

function asObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

/**
 * Parse a `flight` payload attached to a manual request, or null if unusable.
 *
 * The callsign comes from the request rather than the payload: they name one
 * flight, and the request's is the one every other field of the operation is
 * keyed on. Any transponder in the payload is discarded -- see the file header.
 */
export function parseSeed(callsign: string, raw: unknown): Observation | null {
  const body = asObject(raw);
  if (!body) return null;
  const base = common(body, callsign);
  if (!base) return null;
  return { ...base, transponder: "0000" };
}

/** Parse one observation of a pushed feed, taking its callsign and its code. */
export function parsePushed(raw: unknown): Observation | null {
  const body = asObject(raw);
  if (!body) return null;

  const callsign =
    typeof body.callsign === "string" ? body.callsign.trim().toUpperCase() : "";
  if (!callsign) return null;

  const base = common(body, callsign);
  if (!base) return null;

  // Matching the datafeed's own handling: an absent or malformed transponder
  // becomes 0000, which is a default code and so triggers assignment rather
  // than adoption. Failing closed here would adopt a garbage code instead.
  const transponder = typeof body.transponder === "string" ? body.transponder.trim() : "";
  return {
    ...base,
    transponder: /^[0-7]{4}$/.test(transponder) ? transponder : "0000",
  };
}

/**
 * Parse a whole pushed feed body into the same shape `fetchDatafeed` returns.
 *
 * `generatedAt` is stamped here from the server clock and never taken from the
 * payload. Every age the tick computes -- the grace period, the seed TTL --
 * is measured against it, so a client whose clock is minutes off would
 * otherwise expire or preserve assignments wholesale.
 */
export function parsePushedFeed(raw: unknown): FeedResult | null {
  const body = asObject(raw);
  if (!body || !Array.isArray(body.observations)) return null;
  if (body.observations.length > MAX_PUSHED_OBSERVATIONS) return null;

  const observations: Observation[] = [];
  let skipped = 0;
  for (const entry of body.observations) {
    const parsed = parsePushed(entry);
    if (parsed) observations.push(parsed);
    else skipped++;
  }

  return { generatedAt: Date.now(), observations, skipped };
}
