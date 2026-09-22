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
import {
  destinationParticipates,
  isModeSCapable,
  remainingRouteInside,
  RouteCache,
} from "../navdata/modes.js";
import type { FeedResult } from "../vatsim/datafeed.js";
import { by, logbook } from "../logbook.js";

type ModeSVerdict = { eligible: true } | { eligible: false; reason: string };

/**
 * A flight a controller asked about before the datafeed carried it.
 *
 * Deliberately NOT a parallel lifecycle: a seed is merged into phase 1 as an
 * ordinary observation and dropped the moment the feed carries the same
 * callsign, so reserve, classify, allocate, release and DUPE all see one
 * uniform observation set and need to know nothing about where it came from.
 */
interface Seed {
  obs: Observation;
  /** Held across re-seeds, so re-sending cannot extend the TTL indefinitely. */
  seededAt: number;
  /** Who asked, for the per-controller cap and for the logbook. */
  controller: string | null;
}

/** `LNR4778  LFSB->LFRS` -- the identity every decision line opens with. */
function who(obs: Observation): string {
  return `${obs.callsign.padEnd(8)} ${obs.departure ?? "????"}->${obs.arrival ?? "????"}`;
}

export interface TickStats {
  at: number;
  observed: number;
  inScope: number;
  adopted: number;
  assigned: number;
  reassigned: number;
  released: number;
  dupes: number;
  /** Assignments drawn from an any-destination range rather than a specific one. */
  wildcard: number;
  exhausted: number;
  conspicuity: number;
  /** New flights left alone because they were low in the border band. */
  heldAtBorder: number;
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
  /** Client seeds still waiting for the datafeed to confirm them. See Seed. */
  private readonly seeded = new Map<string, Seed>();
  /**
   * Controller and ATIS callsigns logged on to VATSIM as of the last feed.
   *
   * Null until a feed carrying a roster has arrived, which on a push-mode
   * instance is never. Null means "cannot judge" and nobody is refused; a set
   * -- even an empty one -- means the answer is known.
   */
  private roster: ReadonlySet<string> | null = null;
  private readonly routeCache = new RouteCache();
  /**
   * Who was transmitting which exclusive code as of the last tick, kept so the
   * snapshot can be rebuilt between ticks after a manual assignment.
   */
  private squawkedBy = new Map<Squawk, string[]>();
  private modeSStates: ReadonlySet<string> = new Set();
  private serialised = "{}";
  private serialisedGzip = gzipSync("{}");
  private warmupRemaining: number;
  private ready = false;
  private lastTick: TickStats | null = null;

  constructor(
    private readonly warmupCycles: number,
    /**
     * How long an unconfirmed seed survives. A pilot who really is connected
     * reaches the feed inside two generations, so anything still unconfirmed
     * after this was never there: a typo in the callsign, or a client bug.
     */
    private readonly seedTtlMs = 120_000,
    /** Unconfirmed seeds one controller may hold at once. */
    private readonly seedLimit = 10,
  ) {
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
    this.modeSStates = new Set(snapshot.raw.modeS.states);
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

  /** Client seeds still waiting for the datafeed to confirm them. */
  get seedCount(): number {
    return this.seeded.size;
  }

  /** How many controllers the last feed showed logged on; null if unknown. */
  get rosterSize(): number | null {
    return this.roster?.size ?? null;
  }

  /**
   * Whether a controller callsign is logged on to the network this server
   * describes. Null when there is no roster to judge by, which is the case on
   * a push-mode instance and before the first datafeed arrives.
   *
   * This is the only reliable answer to "is the client talking to me actually
   * on my network?". EuroScope reports a student connected to a training
   * server through an ordinary connection as DIRECT, identically to VATSIM, so
   * no amount of care on the client can establish it.
   */
  isControllerOnline(callsign: string): boolean | null {
    if (!this.roster) return null;
    return this.roster.has(callsign.trim().toUpperCase());
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

    // Held from the last feed that carried one, rather than cleared when one
    // does not. A feed we failed to fetch says nothing about who is logged on,
    // and dropping the roster would refuse every controller in the country.
    if (feed.controllers) this.roster = feed.controllers;

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

    // Client seeds are merged in as ordinary observations, on exactly the same
    // terms as the feed's own. A seed the feed has caught up with is dropped
    // rather than merged: the feed is authoritative, always, and this is the
    // whole of "clear it from the temporary list once the flight is seen".
    const expiredSeeds: string[] = [];
    for (const [callsign, seed] of this.seeded) {
      if (this.observedAnywhere.has(callsign)) {
        this.seeded.delete(callsign);
        logbook.record("manual", `SEED  ${callsign.padEnd(8)}  confirmed by the datafeed`);
        continue;
      }
      if (now - seed.seededAt > this.seedTtlMs) {
        this.seeded.delete(callsign);
        expiredSeeds.push(callsign);
        continue;
      }
      this.observedAnywhere.set(callsign, seed.obs);
      if (!aor.withinNm(seed.obs.latitude, seed.obs.longitude, raw.aor.zonePaddingNm)) continue;
      this.observations.set(callsign, seed.obs);
      inScope.push(seed.obs);
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
    this.squawkedBy = squawkedBy;

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
    let heldAtBorder = 0;

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

      // The border band. Low and near the boundary, a flight is far more likely
      // a neighbouring unit's departure or arrival than ours, and the plugin
      // writes the central code into any flight nobody is tracking -- mid-handoff
      // between two foreign controllers included. So it is not taken, adopted
      // or allocated, until it climbs through the floor or reaches the core.
      // Nothing is remembered: the next tick simply asks again.
      if (
        obs.altitude < raw.aor.borderMinAltitudeFt &&
        !aor.insideByNm(obs.latitude, obs.longitude, raw.aor.borderInsetNm)
      ) {
        heldAtBorder++;
        continue;
      }

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
    let wildcard = 0;
    let exhausted = 0;
    let conspicuity = 0;

    for (const obs of queue) {
      const modeS = this.modeSVerdict(config, obs);
      if (modeS.eligible) {
        this.put(obs, codeBook.conspicuity, "auto", null, now);
        logbook.record("auto", `${who(obs)}  -> ${codeBook.conspicuity}  Mode S conspicuity`);
        conspicuity++;
        assigned++;
        continue;
      }

      // ORCAM allocates by destination, so where the flight is going decides
      // which ranges may serve it. A flight with no filed destination can only
      // be served from an any-destination range.
      const allocation = pools.allocate(obs.arrival, obs.callsign);
      if (!allocation) {
        logbook.record("auto", `${who(obs)}  -> NO CODE  every pool serving this destination is full`);
        exhausted++;
        continue;
      }
      if (allocation.wildcard) wildcard++;
      this.put(obs, allocation.code, "auto", allocation.range, now);
      // The reason rides along with the code it produced: a discrete assignment
      // and the refusal of 1000 that caused it are one decision, not two.
      logbook.record(
        "auto",
        `${who(obs)}  -> ${allocation.code}` +
          `${allocation.range ? `  [${allocation.range}]` : ""}` +
          `${allocation.wildcard ? "  (any-destination)" : ""}` +
          `  denied 1000: ${modeS.reason}`,
      );
      assigned++;
    }

    // ---- Phase 5: release -------------------------------------------------
    let released = 0;
    const graceMs = raw.timing.gracePeriodSec * 1000;

    // A seed the datafeed never confirmed. Released at the seed TTL rather than
    // waiting out the grace period on top of it: the grace period exists so a
    // flight that really was there can reconnect onto its code, and this one
    // never was. Runs before the sweep below so these never reach it.
    for (const callsign of expiredSeeds) {
      const assignment = this.assignments.get(callsign);
      if (!assignment) continue;
      this.drop(assignment, pools);
      released++;
      logbook.record(
        "manual",
        `SEED  ${callsign.padEnd(8)}  -> RELEASED ${assignment.code}  never appeared in the datafeed`,
      );
    }

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
    const wasReady = this.ready;
    if (this.warmupRemaining > 0) {
      this.warmupRemaining--;
    } else {
      this.ready = true;
    }
    if (this.ready && !wasReady) {
      logbook.record("status", `engine ready, serving ${this.assignments.size} assignments`);
    }
    const dupes = this.ready ? this.rebuildSnapshot() : 0;

    logbook.record(
      "tick",
      `observed=${feed.observations.length} scope=${inScope.length} ` +
        `assigned=${assigned} (1000=${conspicuity}) adopted=${adopted} ` +
        `released=${released} dupes=${dupes} held=${heldAtBorder}` +
        `${exhausted > 0 ? ` EXHAUSTED=${exhausted}` : ""}` +
        `${this.ready ? "" : " (warming up)"} ${Date.now() - started}ms`,
    );

    this.lastTick = {
      at: now,
      observed: feed.observations.length,
      inScope: inScope.length,
      adopted,
      assigned,
      reassigned: mustReassign.length,
      released,
      dupes,
      wildcard,
      exhausted,
      conspicuity,
      heldAtBorder,
      durationMs: Date.now() - started,
    };
    return this.lastTick;
  }

  // ------------------------------------------------------------- manual ops

  /**
   * Admit a client-supplied observation for a flight the datafeed has not
   * reached yet, so the manual operation carrying it can be answered now rather
   * than a datafeed cycle later.
   *
   * The seed is made visible to `observations` immediately, not merely queued
   * for the next tick: the whole point is that the setCode/forceReassign call
   * in this same request finds the flight. `seeded` is what carries it across
   * subsequent ticks until the feed confirms it.
   *
   * Returns null when the seed was admitted OR harmlessly ignored. A client
   * cannot know what the server has already observed, so seeding a flight the
   * feed already carries is not an error -- it is simply dropped on the floor,
   * because the feed outranks it.
   */
  seed(obs: Observation, controller: string | null): ManualRejection | null {
    const config = this.config;
    if (!config) return "unknown_callsign";

    if (this.observedAnywhere.has(obs.callsign)) return null;

    if (!config.aor.withinNm(obs.latitude, obs.longitude, config.raw.aor.zonePaddingNm)) {
      return "seed_out_of_scope";
    }

    const existing = this.seeded.get(obs.callsign);
    if (!existing) {
      let held = 0;
      for (const seed of this.seeded.values()) {
        if (seed.controller === controller) held++;
      }
      if (held >= this.seedLimit) return "seed_limit";
    }

    const now = Date.now();
    this.seeded.set(obs.callsign, {
      obs,
      seededAt: existing?.seededAt ?? now,
      controller,
    });
    this.observedAnywhere.set(obs.callsign, obs);
    this.observations.set(obs.callsign, obs);

    if (!existing) {
      logbook.record("manual", `SEED  ${by(controller)}  ${who(obs)}  ahead of the datafeed`);
    }
    return null;
  }

  /**
   * Set a specific code by hand. Accepted regardless of range and flagged
   * manual, with the exclusion list as an absolute floor apart from the
   * emergency codes config marks as manually assignable.
   */
  setCode(callsign: string, code: string, controller: string | null = null): ManualResult | ManualRejection {
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
    logbook.record("manual", `SET   ${by(controller)}  ${obs ? who(obs) : callsign.padEnd(8)}  -> ${code}`);
    // Publish immediately: the next poll must not serve the pre-change code.
    if (this.ready) this.rebuildSnapshot();
    return { ssr: code, dupe: this.isDupe(callsign, code) };
  }

  /**
   * Re-run the server's own assignment decision, discarding any manual flag.
   *
   * This is the whole decision, Mode S included, not just a draw from the pool.
   * Skipping the eligibility test would mean a flight already on 1000 could
   * never be given 1000 again: pressing AUTO would drop it to a discrete code
   * and there would be no way back to conspicuity.
   */
  forceReassign(callsign: string, controller: string | null = null): ManualResult | ManualRejection {
    const config = this.config;
    if (!config) return "unknown_callsign";
    const obs = this.observations.get(callsign);
    const existing = this.assignments.get(callsign);
    if (!obs && !existing) return "unknown_callsign";

    const now = Date.now();

    if (existing && config.codeBook.isExclusive(existing.code)) {
      config.pools.release(existing.code);
    }

    // No observation means the flight is out of the feed, so there is no route
    // to test and conspicuity cannot be justified.
    let denied = "flight is not in the datafeed";

    if (obs) {
      const modeS = this.modeSVerdict(config, obs);
      if (modeS.eligible) {
        const code = config.codeBook.conspicuity;
        this.reassign(obs, existing, code, null, "auto", now);
        logbook.record("manual", `AUTO  ${by(controller)}  ${who(obs)}  -> ${code}  Mode S conspicuity`);
        if (this.ready) this.rebuildSnapshot();
        return { ssr: code, dupe: this.isDupe(callsign, code) };
      }
      denied = modeS.reason;
    }

    const allocation = config.pools.allocate(obs?.arrival ?? null, callsign);
    if (!allocation) {
      logbook.record("manual", `AUTO  ${by(controller)}  ${callsign}  -> REJECTED  pool exhausted`);
      return "pool_exhausted";
    }

    // The line a controller comes looking for after pressing AUTO and getting a
    // discrete code back.
    logbook.record(
      "manual",
      `AUTO  ${by(controller)}  ${obs ? who(obs) : callsign.padEnd(8)}  -> ${allocation.code}` +
        `${allocation.range ? `  [${allocation.range}]` : ""}` +
        `  denied 1000: ${denied}`,
    );

    this.reassign(obs, existing, allocation.code, allocation.range, "auto", now);
    // Publish immediately: the next poll must not serve the pre-change code.
    if (this.ready) this.rebuildSnapshot();
    return { ssr: allocation.code, dupe: this.isDupe(callsign, allocation.code) };
  }

  /**
   * Issue a discrete code, bypassing the Mode S decision entirely.
   *
   * The escape hatch from conspicuity: AUTO re-runs the server's judgement and
   * will hand 1000 straight back to a flight that still qualifies, which is no
   * use to a controller whose aircraft has a misbehaving transponder.
   *
   * Flagged `manual`, so the reconciliation loop cannot undo it. The controller
   * has deliberately overridden the server, and that has to survive the flight
   * being reassigned for any other reason.
   */
  forceDiscrete(callsign: string, controller: string | null = null): ManualResult | ManualRejection {
    const config = this.config;
    if (!config) return "unknown_callsign";
    const obs = this.observations.get(callsign);
    const existing = this.assignments.get(callsign);
    if (!obs && !existing) return "unknown_callsign";

    const now = Date.now();

    if (existing && config.codeBook.isExclusive(existing.code)) {
      config.pools.release(existing.code);
    }

    const allocation = config.pools.allocate(obs?.arrival ?? null, callsign);
    if (!allocation) {
      logbook.record("manual", `DISC  ${by(controller)}  ${callsign}  -> REJECTED  pool exhausted`);
      return "pool_exhausted";
    }

    this.reassign(obs, existing, allocation.code, allocation.range, "manual", now);
    logbook.record(
      "manual",
      `DISC  ${by(controller)}  ${obs ? who(obs) : callsign.padEnd(8)}  -> ${allocation.code}` +
        `${allocation.range ? `  [${allocation.range}]` : ""}  Mode S bypassed on request`,
    );
    if (this.ready) this.rebuildSnapshot();
    return { ssr: allocation.code, dupe: this.isDupe(callsign, allocation.code) };
  }

  /** Point an assignment at a new code, creating the entry if it is new. */
  private reassign(
    obs: Observation | undefined,
    existing: Assignment | undefined,
    code: Squawk,
    issuedBy: string | null,
    provenance: Assignment["provenance"],
    now: number,
  ): void {
    if (existing) {
      existing.code = code;
      existing.provenance = provenance;
      existing.issuedBy = issuedBy;
      existing.assignedAt = now;
      existing.lastSeen = now;
    } else if (obs) {
      this.put(obs, code, provenance, issuedBy, now);
    }
  }

  // ------------------------------------------------------------- internals

  /**
   * Rebuild the served snapshot from the current map. Returns the DUPE count.
   *
   * Called at the end of every tick AND after every manual assignment. The
   * second is not an optimisation: the map changes the moment a controller
   * acts, but the tick only runs every 15 s, so without this the plugin would
   * fetch a snapshot still holding the old code and push the aircraft straight
   * back to it -- the code visibly changing and then reverting.
   */
  private rebuildSnapshot(): number {
    const snapshot: Snapshot = {};
    let dupes = 0;
    for (const assignment of this.assignments.values()) {
      const holders = this.squawkedBy.get(assignment.code);
      const dupe = holders !== undefined && holders.some((c) => c !== assignment.callsign);
      if (dupe) dupes++;
      snapshot[assignment.callsign] = { ssr: assignment.code, dupe };
    }
    this.serialised = JSON.stringify(snapshot);
    this.serialisedGzip = gzipSync(this.serialised);
    return dupes;
  }

  /**
   * Mode S 1000 eligibility: capable equipment, a destination in a
   * participating state, and a REMAINING route that stays inside the area.
   *
   * Returns the reason rather than a bare false. "Why did this flight not get
   * 1000" is the question the logbook exists to answer, and the answer only
   * exists here: by the time the caller holds a discrete code, every
   * distinction between the three ways of failing has been thrown away.
   */
  private modeSVerdict(config: ConfigSnapshot, obs: Observation): ModeSVerdict {
    if (!isModeSCapable(obs.equipment)) {
      return {
        eligible: false,
        reason: `equipment ${obs.equipment ?? "(not filed)"} is not Mode S capable`,
      };
    }
    if (!destinationParticipates(obs.arrival, this.modeSStates)) {
      return {
        eligible: false,
        reason: `destination ${obs.arrival ?? "(not filed)"} is not a participating state`,
      };
    }
    const points = this.routeCache.expand(
      config.navdata, obs.departure, obs.arrival, obs.route,
    );
    const remaining = remainingRouteInside(config.navdata, points, obs.latitude, obs.longitude);
    return remaining.inside ? { eligible: true } : { eligible: false, reason: remaining.reason };
  }

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

}
