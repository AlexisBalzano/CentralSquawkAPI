/** Core domain types. See ARCHITECTURE.md for how these fit together. */

/** A four-digit octal SSR code, e.g. "7201". Always four characters. */
export type Squawk = string;

/**
 * Where an assignment came from. This drives whether the reconciliation loop is
 * allowed to change it.
 *
 *  - `auto`     issued by the loop; the loop may reassign it freely.
 *  - `adopted`  the aircraft was already squawking a non-default code when it
 *               entered scope, and we took that code as its assignment.
 *  - `manual`   a controller set it through the plugin. Protected from the loop.
 */
export type Provenance = "auto" | "adopted" | "manual";

/** How a code behaves, decided by config. See domain/codes.ts. */
export type CodeClass =
  | "discrete" // from an ORCAM pool: exclusive, reserved, DUPE-checked
  | "default" // 0000/1200/1234/2000/7000: means "no meaningful code"
  | "conspicuity" // 1000: a valid outcome, but shared
  | "emergency" // 7500/7600/7700: never touched automatically
  | "excluded"; // on a FIR exclusion list: never issued

/** One flight as the datafeed sees it, narrowed to what we actually use. */
export interface Observation {
  callsign: string;
  cid: number;
  latitude: number;
  longitude: number;
  altitude: number;
  groundspeed: number;
  /** The code the aircraft is currently transmitting. */
  transponder: Squawk;
  flightRules: "I" | "V" | null;
  departure: string | null;
  arrival: string | null;
  /** ICAO field 10 equipment string, used for the Mode S capability test. */
  equipment: string | null;
  /** ICAO field 15 route, used for the Mode S containment test. */
  route: string | null;
}

/** What we have decided for one flight. */
export interface Assignment {
  callsign: string;
  /** Recorded so a reconnect inside the grace period can be recognised. */
  cid: number;
  code: Squawk;
  provenance: Provenance;
  /** FIR whose pool issued the code; null for adopted and manual codes. */
  issuedBy: string | null;
  /** Epoch ms when the flight was last present in the datafeed. */
  lastSeen: number;
  /** Epoch ms when this code was assigned. */
  assignedAt: number;
  /**
   * Set once the flight has been seen above the ground speed threshold. It is
   * what makes landing detectable without airport positions: on the ground and
   * previously airborne means the flight has arrived, whereas on the ground and
   * never airborne is a departure still waiting to go.
   */
  wasAirborne: boolean;
}

/** One entry of the snapshot served to clients. Deliberately minimal. */
export interface SnapshotEntry {
  ssr: Squawk;
  dupe: boolean;
}

/** The whole client-facing payload: `{ callsign: { ssr, dupe } }`. */
export type Snapshot = Record<string, SnapshotEntry>;

/** Result of a manual operation, returned synchronously to the plugin. */
export interface ManualResult {
  ssr: Squawk;
  dupe: boolean;
}

export type ManualRejection =
  | "unknown_callsign"
  | "excluded_code"
  | "malformed_code"
  | "not_authorised"
  /** No range serving this flight's destination has a free code. */
  | "pool_exhausted";
