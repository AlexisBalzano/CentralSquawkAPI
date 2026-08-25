/** Synthetic fixtures so tests never need the real config repository. */

import type { ConfigSnapshot } from "../src/config/loader.js";
import { CodeBook } from "../src/domain/codes.js";
import { PoolRegistry } from "../src/domain/pools.js";
import type { Observation } from "../src/domain/types.js";
import { Area } from "../src/geo.js";
import type { Navdata } from "../src/navdata/navdata.js";
import type { RawConfig, PoolsConfig } from "../src/config/schema.js";
import type { FeedResult } from "../src/vatsim/datafeed.js";

/** A square covering roughly northern France, in GeoJSON [lon, lat] order. */
const SQUARE: [number, number][] = [
  [0, 46],
  [5, 46],
  [5, 50],
  [0, 50],
  [0, 46],
];

export const INSIDE = { latitude: 48, longitude: 2.5 };
/** Comfortably beyond the padded zone used below. */
export const FAR_AWAY = { latitude: 20, longitude: -40 };

export function makeConfig(pools: PoolsConfig): ConfigSnapshot {
  const raw: RawConfig = {
    version: 1,
    aor: { firs: ["LFFF"], entryRingNm: 40, zonePaddingNm: 100 },
    codes: {
      default: ["0000", "1200", "1234", "2000", "7000"],
      conspicuity: "1000",
      emergency: ["7500", "7600", "7700"],
      manuallyAssignable: ["7600", "7700"],
    },
    timing: { gracePeriodSec: 300, groundSpeedThresholdKt: 50, tickIntervalSec: 15 },
    pools,
  };

  const area = new Area([SQUARE]);
  const navdata: Navdata = {
    cycle: "test",
    fixes: new Map([["INSID", { lat: 48, lon: 2.5 }]]),
    airways: new Map(),
    procedures: new Map(),
  };

  return {
    raw,
    codeBook: new CodeBook(raw.codes, pools),
    pools: new PoolRegistry(pools),
    modesArea: area,
    aor: area,
    firAreas: new Map([["LFFF", area]]),
    navdata,
    loadedAt: Date.now(),
  };
}

let nextCid = 1000;

export function pilot(
  callsign: string,
  transponder: string,
  overrides: Partial<Observation> = {},
): Observation {
  return {
    callsign,
    cid: nextCid++,
    latitude: INSIDE.latitude,
    longitude: INSIDE.longitude,
    altitude: 35_000,
    groundspeed: 450,
    transponder,
    flightRules: "I",
    departure: "LFPG",
    arrival: "LFBO",
    // Not Mode S capable, so eligibility never diverts a test flight onto 1000
    // unless the test asks for it.
    equipment: "B738/M-SDFGIRWY/C",
    route: "INSID",
    ...overrides,
  };
}

export function feed(observations: Observation[]): FeedResult {
  return { generatedAt: Date.now(), observations, skipped: 0 };
}
