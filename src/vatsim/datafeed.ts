/**
 * VATSIM datafeed ingest.
 *
 * The feed regenerates roughly every 15 s, so polling faster buys nothing. It
 * is the only source of truth about what aircraft are actually squawking, which
 * makes it the input to both assignment and DUPE detection.
 */

import type { Observation } from "../domain/types.js";

interface RawFlightPlan {
  flight_rules?: string;
  aircraft?: string;
  departure?: string;
  arrival?: string;
  route?: string;
}

interface RawPilot {
  cid?: number;
  callsign?: string;
  latitude?: number;
  longitude?: number;
  altitude?: number;
  groundspeed?: number;
  transponder?: string;
  flight_plan?: RawFlightPlan | null;
}

interface RawFeed {
  general?: { update_timestamp?: string };
  pilots?: RawPilot[];
}

export interface FeedResult {
  /** When VATSIM generated the feed, not when we fetched it. */
  generatedAt: number;
  observations: Observation[];
  /** Pilots dropped because a field we depend on was missing or malformed. */
  skipped: number;
}

function normaliseIcao(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toUpperCase();
  return trimmed.length === 4 ? trimmed : null;
}

export async function fetchDatafeed(
  url: string,
  timeoutMs = 10_000,
): Promise<FeedResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let feed: RawFeed;
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "CentralSquawk" },
    });
    if (!response.ok) {
      throw new Error(`datafeed returned HTTP ${response.status}`);
    }
    feed = (await response.json()) as RawFeed;
  } finally {
    clearTimeout(timer);
  }

  if (!Array.isArray(feed.pilots)) {
    throw new Error("datafeed contained no pilots array");
  }

  const generatedAt = feed.general?.update_timestamp
    ? Date.parse(feed.general.update_timestamp)
    : Date.now();

  const observations: Observation[] = [];
  let skipped = 0;

  for (const pilot of feed.pilots) {
    const callsign = pilot.callsign?.trim().toUpperCase();
    if (
      !callsign ||
      typeof pilot.cid !== "number" ||
      typeof pilot.latitude !== "number" ||
      typeof pilot.longitude !== "number"
    ) {
      skipped++;
      continue;
    }

    const plan = pilot.flight_plan ?? null;
    const rules = plan?.flight_rules?.trim().toUpperCase();

    observations.push({
      callsign,
      cid: pilot.cid,
      latitude: pilot.latitude,
      longitude: pilot.longitude,
      altitude: typeof pilot.altitude === "number" ? pilot.altitude : 0,
      groundspeed: typeof pilot.groundspeed === "number" ? pilot.groundspeed : 0,
      // An absent or malformed transponder is treated as 0000, which is a
      // default code and so triggers assignment rather than adoption.
      transponder: /^[0-7]{4}$/.test(pilot.transponder ?? "")
        ? pilot.transponder!
        : "0000",
      flightRules: rules === "I" || rules === "V" ? rules : null,
      departure: normaliseIcao(plan?.departure),
      arrival: normaliseIcao(plan?.arrival),
      equipment: plan?.aircraft?.trim() ?? null,
      route: plan?.route?.trim() ?? null,
    });
  }

  return { generatedAt: Number.isFinite(generatedAt) ? generatedAt : Date.now(), observations, skipped };
}
