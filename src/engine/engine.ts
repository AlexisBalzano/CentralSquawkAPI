/**
 * The reconciliation engine.
 *
 * The loop is reconciliation-based rather than event-based: every tick rebuilds
 * the intended state from the datafeed and the current map. Cold start is
 * therefore not a special mode, it is the same loop with an empty prior, which
 * is what makes traffic already airborne inside the AOR at startup behave
 * correctly without a separate bootstrap path.
 *
 * PHASE ORDER IS LOAD-BEARING. Every observed exclusive code is reserved before
 * anything is allocated. Allocating while iterating would let the pool hand out
 * a code that an aircraft later in the same pass is already squawking,
 * manufacturing a DUPE the server invented itself.
 */

import { gzipSync } from "node:zlib";

import type { ConfigSnapshot } from "../config/loader.js";
import { isWellFormed } from "../domain/codes.js";
import type {
  Assignment,
  ManualRejection,
  ManualResult,
  Observation,
  Snapshot,
  Squawk,
} from "../domain/types.js";
import { isModeSCapable, RouteCache } from "../navdata/modes.js";
import type { FeedResult } from "../vatsim/datafeed.js";

export interface TickStats {
  at: number;
  observed: number;
  inScope: number;
  adopted: number;
  assigned: number;
  reassigned: number;
  released: number;
  dupes: number;
  borrowed: number;
  exhausted: number;
  conspicuity: number;
  durationMs: number;
}

export class Engine {
  private config: ConfigSnapshot | null = null;
  private readonly assignments = new Map<string, Assignment>();
  private readonly observations = new Map<string, Observation>();
  /**
   * Every pilot in the feed, in scope or not. Release needs to tell "flew out
   * of the padded zone" from "vanished from the feed": the first releases at
   * once, the second waits out the grace period. Filtering to in-scope traffic
   * alone makes those two indistinguishable.
   */
  private readonly observedAnywhere = new Map<string, Observation>();
  private readonly routeCache = new RouteCache();
  private serialised = "{}";
  private serialisedGzip = gzipSync("{}");
  private warmupRemaining: number;
  private ready = false;
  private lastTick: TickStats | null = null;

  constructor(private readonly warmupCycles: number) {
    this.warmupRemaining = warmupCycles;
  }

  /**
   * Swap in a new config snapshot. The route cache is cleared because verdicts
   * are keyed on route text but are only valid for the navdata that produced
   * them: a cycle that moves an airway changes the answer for routes whose text
   * has not changed at all.
   */
  setConfig(snapshot: ConfigSnapshot): void {
    this.config = snapshot;
    this.routeCache.clear();
  }

  /** Restore a persisted map on startup, before the first tick. */
  restore(assignments: Assignment[]): void {
    for (const assignment of assignments) {
      this.assignments.set(assignment.callsign, assignment);
    }
  }

  get isReady(): boolean {
    return this.ready && this.config !== null;
  }

  /** Pre-serialised once per tick: every controller polling gets this buffer. */
  get snapshotJson(): string {
    return this.serialised;
  }

  /**
   * The same snapshot, gzipped once per tick rather than once per request. At
   * 60 controllers on a 5 s poll against a 15 s tick this buffer is served
   * around 180 times over, so compressing per request would be that much wasted
   * CPU for a byte-identical result.
   */
  get snapshotGzip(): Buffer {
    return this.serialisedGzip;
  }

  get stats(): TickStats | null {
    return this.lastTick;
  }

  get size(): number {
    return this.assignments.size;
  }

  all(): Assignment[] {
    return [...this.assignments.values()];
  }

  get routeCacheStats(): { size: number; hits: number; misses: number } {
    return this.routeCache.stats;
  }

  // ---------------------------------------------------------------- the tick

  tick(feed: FeedResult): TickStats {
    const started = Date.now();
    const config = this.config;
    if (!config) throw new Error("tick() before a config snapshot was loaded");

    const { codeBook, pools, aor, raw } = config;
    const now = feed.generatedAt || started;
    const groundThreshold = raw.timing.groundSpeedThresholdKt;

    // ---- Phase 1: observe -------------------------------------------------
    // Everything inside the padded zone. The wider zone is used here because
    // release is judged on it too, and a flight must stay observable right up
    // to the point it is released.
    this.observations.clear();
    this.observedAnywhere.clear();
    const inScope: Observation[] = [];
    for (const obs of feed.observations) {
      this.observedAnywhere.set(obs.callsign, obs);
      if (!aor.withinNm(obs.latitude, obs.longitude, raw.aor.zonePaddingNm)) continue;
      this.observations.set(obs.callsign, obs);
      inScope.push(obs);
    }

    // Who is transmitting what, for DUPE detection. Only exclusive codes can
    // collide: several aircraft may legitimately share 7000, 1000 or 7700.
    const squawkedBy = new Map<Squawk, string[]>();
    for (const obs of inScope) {
      if (!codeBook.isExclusive(obs.transponder)) continue;
      const holders = squawkedBy.get(obs.transponder);
      if (holders) holders.push(obs.callsign);
      else squawkedBy.set(obs.transponder, [obs.callsign]);
    }

    // ---- Phase 2: reserve -------------------------------------------------
    pools.beginTick();

    // Reality first: a code an aircraft is actually transmitting is taken,
    // whoever we think owns it.
    for (const obs of inScope) {
      if (codeBook.isExclusive(obs.transponder)) {
        pools.reserve(obs.transponder, obs.callsign);
      }
    }

    // Then our own assignments. One that loses its code to an aircraft actively
    // squawking it yields, per "a squawked code always beats an assigned one".
    const mustReassign: Assignment[] = [];
    for (const assignment of this.assignments.values()) {
      if (!codeBook.isExclusive(assignment.code)) continue;
      if (!pools.reserve(assignment.code, assignment.callsign)) {
        mustReassign.push(assignment);
      }
    }

    // ---- Phase 3: classify ------------------------------------------------
    const queue: Observation[] = [];
    let adopted = 0;

    for (const obs of inScope) {
      const existing = this.assignments.get(obs.callsign);
      const airborne = obs.groundspeed >= groundThreshold;

      if (existing) {
        existing.lastSeen = now;
        existing.cid = obs.cid;
        if (airborne) existing.wasAirborne = true;
        // A manual code is protected from the loop entirely. Anything else that
        // lost its code in phase 2 is queued for a fresh one; otherwise the
        // central assignment stands and the plugin re-pushes it.
        if (existing.provenance !== "manual" && mustReassign.includes(existing)) {
          queue.push(obs);
        }
        continue;
      }

      // New to scope.
      if (!airborne) continue; // ground traffic is controller request only
      if (obs.flightRules !== "I") continue; // VFR and no-flight-plan on request only
      if (!aor.withinNm(obs.latitude, obs.longitude, raw.aor.entryRingNm)) continue;

      if (codeBook.isEmergency(obs.transponder)) {
        // Never touched, but recorded so the code is visible and never reissued.
        this.adopt(obs, now);
        adopted++;
      } else if (codeBook.isDefault(obs.transponder)) {
        queue.push(obs);
      } else {
        this.adopt(obs, now);
        adopted++;
      }
    }

    // ---- Phase 4: allocate ------------------------------------------------
    let assigned = 0;
    let borrowed = 0;
    let exhausted = 0;
    let conspicuity = 0;

    for (const obs of queue) {
      const eligible =
        isModeSCapable(obs.equipment) &&
        this.routeCache.verdict(config.navdata, obs.departure, obs.arrival, obs.route)
          .inside;

      if (eligible) {
        this.put(obs, codeBook.conspicuity, "auto", null, now);
        conspicuity++;
        assigned++;
        continue;
      }

      const fir = this.resolveFir(config, obs.latitude, obs.longitude);
      const allocation = pools.allocate(fir, obs.callsign);
      if (!allocation) {
        exhausted++;
        continue;
      }
      if (allocation.borrowed) borrowed++;
      this.put(obs, allocation.code, "auto", allocation.issuedBy, now);
      assigned++;
    }

    // ---- Phase 5: release -------------------------------------------------
    let released = 0;
    const graceMs = raw.timing.gracePeriodSec * 1000;

    for (const assignment of [...this.assignments.values()]) {
      const anywhere = this.observedAnywhere.get(assignment.callsign);

      if (!anywhere) {
        // Absent from the feed entirely. The grace period lets a CTD or a brief
        // feed gap reconnect onto the same code.
        if (now - assignment.lastSeen > graceMs) {
          this.drop(assignment, pools);
          released++;
        }
        continue;
      }

      // Still connected, but has flown out of the padded zone. No grace: it is
      // demonstrably gone rather than possibly gone.
      if (!this.observations.has(assignment.callsign)) {
        this.drop(assignment, pools);
        released++;
        continue;
      }

      // Landed: on the ground having previously been airborne.
      if (assignment.wasAirborne && anywhere.groundspeed < groundThreshold) {
        this.drop(assignment, pools);
        released++;
      }
    }

    // ---- Serialise --------------------------------------------------------
    const snapshot: Snapshot = {};
    let dupes = 0;
    for (const assignment of this.assignments.values()) {
      const holders = squawkedBy.get(assignment.code);
      const dupe = holders !== undefined && holders.some((c) => c !== assignment.callsign);
      if (dupe) dupes++;
      snapshot[assignment.callsign] = { ssr: assignment.code, dupe };
    }

    if (this.warmupRemaining > 0) {
      this.warmupRemaining--;
    } else {
      this.ready = true;
    }
    if (this.ready) {
      this.serialised = JSON.stringify(snapshot);
      this.serialisedGzip = gzipSync(this.serialised);
    }

    this.lastTick = {
      at: now,
      observed: feed.observations.length,
      inScope: inScope.length,
      adopted,
      assigned,
      reassigned: mustReassign.length,
      released,
      dupes,
      borrowed,
      exhausted,
      conspicuity,
      durationMs: Date.now() - started,
    };
    return this.lastTick;
  }

  // ------------------------------------------------------------- manual ops

  /**
   * Set a specific code by hand. Accepted regardless of range and flagged
   * manual, with the exclusion list as an absolute floor apart from the
   * emergency codes config marks as manually assignable.
   */
  setCode(callsign: string, code: string): ManualResult | ManualRejection {
    const config = this.config;
    if (!config) return "unknown_callsign";
    if (!isWellFormed(code)) return "malformed_code";
    if (!config.codeBook.isManuallyAssignable(code)) return "excluded_code";

    const obs = this.observations.get(callsign);
    const existing = this.assignments.get(callsign);
    if (!obs && !existing) return "unknown_callsign";

    const now = Date.now();
    if (existing) {
      if (config.codeBook.isExclusive(existing.code)) config.pools.release(existing.code);
      existing.code = code;
      existing.provenance = "manual";
      existing.issuedBy = null;
      existing.assignedAt = now;
      existing.lastSeen = now;
    } else if (obs) {
      this.put(obs, code, "manual", null, now);
    }
    if (config.codeBook.isExclusive(code)) config.pools.reserve(code, callsign);
    return { ssr: code, dupe: this.isDupe(callsign, code) };
  }

  /** Issue a fresh code from the appropriate pool, discarding any manual flag. */
  forceReassign(callsign: string): ManualResult | ManualRejection {
    const config = this.config;
    if (!config) return "unknown_callsign";
    const obs = this.observations.get(callsign);
    const existing = this.assignments.get(callsign);
    if (!obs && !existing) return "unknown_callsign";

    const lat = obs?.latitude ?? 0;
    const lon = obs?.longitude ?? 0;
    const now = Date.now();

    if (existing && config.codeBook.isExclusive(existing.code)) {
      config.pools.release(existing.code);
    }

    const fir = this.resolveFir(config, lat, lon);
    const allocation = config.pools.allocate(fir, callsign);
    if (!allocation) return "excluded_code";

    if (existing) {
      existing.code = allocation.code;
      existing.provenance = "auto";
      existing.issuedBy = allocation.issuedBy;
      existing.assignedAt = now;
      existing.lastSeen = now;
    } else if (obs) {
      this.put(obs, allocation.code, "auto", allocation.issuedBy, now);
    }
    return { ssr: allocation.code, dupe: this.isDupe(callsign, allocation.code) };
  }

  // ------------------------------------------------------------- internals

  private isDupe(callsign: string, code: Squawk): boolean {
    const config = this.config;
    if (!config || !config.codeBook.isExclusive(code)) return false;
    for (const obs of this.observations.values()) {
      if (obs.callsign !== callsign && obs.transponder === code) return true;
    }
    return false;
  }

  private adopt(obs: Observation, now: number): void {
    this.put(obs, obs.transponder, "adopted", null, now);
    const config = this.config;
    if (config && config.codeBook.isExclusive(obs.transponder)) {
      config.pools.reserve(obs.transponder, obs.callsign);
    }
  }

  private put(
    obs: Observation,
    code: Squawk,
    provenance: Assignment["provenance"],
    issuedBy: string | null,
    now: number,
  ): void {
    const groundThreshold = this.config?.raw.timing.groundSpeedThresholdKt ?? 50;
    const existing = this.assignments.get(obs.callsign);
    this.assignments.set(obs.callsign, {
      callsign: obs.callsign,
      cid: obs.cid,
      code,
      provenance,
      issuedBy,
      lastSeen: now,
      assignedAt: now,
      wasAirborne: existing?.wasAirborne === true || obs.groundspeed >= groundThreshold,
    });
  }

  private drop(assignment: Assignment, pools: ConfigSnapshot["pools"]): void {
    this.assignments.delete(assignment.callsign);
    pools.release(assignment.code);
  }

  /**
   * Which FIR's pool should issue for a position: the one containing it, or
   * failing that the nearest, which is what attributes traffic sitting inside
   * the entry ring but not yet inside any FIR.
   */
  private resolveFir(config: ConfigSnapshot, lat: number, lon: number): string {
    let nearest = config.raw.aor.firs[0] ?? "";
    let best = Infinity;
    for (const [fir, area] of config.firAreas) {
      if (area.contains(lat, lon)) return fir;
      const d = area.distanceToEdgeNm(lat, lon);
      if (d < best) {
        best = d;
        nearest = fir;
      }
    }
    return nearest;
  }
}
