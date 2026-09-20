/**
 * Tests for client seeds: observations the plugin supplies for a flight the
 * datafeed has not reached yet.
 *
 * The seed is the one path by which a client writes into the authoritative map,
 * so the cases worth pinning are the ones where getting it wrong is invisible:
 * a seed that outlives its welcome holds a code nobody can use, and a seed
 * trusted with a transponder lets any client empty the pool.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Engine } from "../src/engine/engine.js";
import { parseSeed } from "../src/domain/observation.js";
import type { ManualResult } from "../src/domain/types.js";
import { feed, makeConfig, pilot, range, FAR_AWAY, INSIDE } from "./helpers.js";

const TINY_POOL = [range("0301", "0304")];
const SINGLE_CODE = [range("0301", "0301")];

const CTR = "LFFF_CTR";

/** Ready after the first tick, with a seed TTL and cap the test can control. */
function engineWith(
  ranges: Parameters<typeof makeConfig>[0],
  seedTtlMs = 120_000,
  seedLimit = 10,
): Engine {
  const engine = new Engine(0, seedTtlMs, seedLimit);
  engine.setConfig(makeConfig(ranges));
  engine.tick(feed([])); // reach ready, with nothing observed
  return engine;
}

/** A flight at the gate: no code, not moving. The case the seed exists for. */
function atTheGate(callsign: string) {
  return pilot(callsign, "0000", { groundspeed: 0, cid: 0 });
}

function ssrOf(engine: Engine, callsign: string): string | undefined {
  const snapshot = JSON.parse(engine.snapshotJson) as Record<string, { ssr: string }>;
  return snapshot[callsign]?.ssr;
}

describe("seeding a flight the datafeed has not reached", () => {
  it("answers the assignment now instead of a datafeed cycle later", () => {
    const engine = engineWith(TINY_POOL);

    assert.equal(engine.seed(atTheGate("NEWBIE"), CTR), null, "the seed is admitted");
    const result = engine.forceReassign("NEWBIE", CTR);

    assert.notEqual(typeof result, "string", "a seeded flight is no longer unknown");
    assert.match((result as ManualResult).ssr, /^030[1-4]$/);
    assert.equal(engine.seedCount, 1);
  });

  it("is still unknown without one", () => {
    const engine = engineWith(TINY_POOL);
    assert.equal(engine.forceReassign("NEWBIE", CTR), "unknown_callsign");
  });

  it("survives ticks the datafeed still does not carry it", () => {
    const engine = engineWith(TINY_POOL);
    engine.seed(atTheGate("NEWBIE"), CTR);
    const code = (engine.forceReassign("NEWBIE", CTR) as ManualResult).ssr;

    engine.tick(feed([]));
    engine.tick(feed([]));

    assert.equal(ssrOf(engine, "NEWBIE"), code, "the code held across both ticks");
    assert.equal(engine.seedCount, 1, "still unconfirmed, so still seeded");
  });

  it("hands over to the datafeed once the flight appears, keeping the code", () => {
    const engine = engineWith(TINY_POOL);
    engine.seed(atTheGate("NEWBIE"), CTR);
    const code = (engine.forceReassign("NEWBIE", CTR) as ManualResult).ssr;

    // The pilot reaches the feed, still at the gate and still squawking 0000.
    engine.tick(feed([pilot("NEWBIE", "0000", { groundspeed: 0 })]));

    assert.equal(engine.seedCount, 0, "confirmed, so no longer seeded");
    assert.equal(ssrOf(engine, "NEWBIE"), code, "the assignment carried straight over");
  });

  it("releases a seed the datafeed never confirms, without waiting out the grace period", () => {
    // One code in the whole pool, so the reallocation below can only succeed if
    // the release really did return it.
    const engine = engineWith(SINGLE_CODE, 60_000);
    engine.seed(atTheGate("GHOST"), CTR);
    assert.equal((engine.forceReassign("GHOST", CTR) as ManualResult).ssr, "0301");

    // Past the seed TTL but well inside the 300 s grace period: if release
    // waited for the grace clock too, the code would still be held here.
    const stats = engine.tick(feed([], Date.now() + 90_000));

    assert.equal(stats.released, 1);
    assert.equal(engine.seedCount, 0);
    assert.equal(ssrOf(engine, "GHOST"), undefined, "the entry is gone");

    engine.seed(atTheGate("REAL"), CTR);
    assert.equal(
      (engine.forceReassign("REAL", CTR) as ManualResult).ssr,
      "0301",
      "the code went back to the pool rather than being stranded",
    );
  });

  it("ignores a seed for a flight the datafeed already carries", () => {
    const engine = engineWith(TINY_POOL);
    engine.tick(feed([pilot("KNOWN", "2000")]));

    assert.equal(engine.seed(atTheGate("KNOWN"), CTR), null, "not an error");
    assert.equal(engine.seedCount, 0, "but not recorded either: the feed outranks it");
  });
});

describe("what a seed is not trusted with", () => {
  it("never reserves a code the client claims the aircraft is squawking", () => {
    // The security-critical one. Phase 2 reserves every observed exclusive code
    // before allocating, so a trusted client transponder would let any client
    // empty the pool one claim at a time.
    const engine = engineWith(SINGLE_CODE);

    const claimed = parseSeed("LIAR", {
      ...INSIDE,
      groundspeed: 0,
      transponder: "0301", // the only code the pool has
      departure: "LFPG",
      arrival: "LFBO",
    });
    assert.ok(claimed);
    assert.equal(claimed.transponder, "0000", "the claim is discarded at the parse");
    engine.seed(claimed, CTR);

    // An ordinary flight can still be given 0301, which it could not if the
    // claim had reserved it.
    engine.tick(feed([pilot("HONEST", "2000")]));
    assert.equal(ssrOf(engine, "HONEST"), "0301");
  });

  it("refuses a position outside the padded zone", () => {
    const engine = engineWith(TINY_POOL);
    const far = pilot("ELSEWHERE", "0000", { ...FAR_AWAY, groundspeed: 0 });
    assert.equal(engine.seed(far, CTR), "seed_out_of_scope");
    assert.equal(engine.seedCount, 0);
  });

  it("caps how many unconfirmed seeds one controller may hold", () => {
    const engine = engineWith(TINY_POOL, 120_000, 2);

    assert.equal(engine.seed(atTheGate("ONE"), CTR), null);
    assert.equal(engine.seed(atTheGate("TWO"), CTR), null);
    assert.equal(engine.seed(atTheGate("THREE"), CTR), "seed_limit");

    // Re-seeding one already held is a refresh, not a new claim against the cap.
    assert.equal(engine.seed(atTheGate("ONE"), CTR), null);
    // And the cap is per controller, not global.
    assert.equal(engine.seed(atTheGate("THREE"), "LFMM_CTR"), null);
  });
});

describe("parsing a client flight payload", () => {
  const base = { ...INSIDE, departure: "LFPG", arrival: "LFBO", route: "INSID" };

  it("takes the fields the datafeed would have given us", () => {
    const obs = parseSeed("AFR1234", {
      ...base,
      altitude: 400,
      groundspeed: 12,
      flightRules: "i",
      equipment: "  B738/M-SDE3FGHIRWY/LB1  ",
    });
    assert.ok(obs);
    assert.equal(obs.callsign, "AFR1234", "the callsign comes from the request, not the payload");
    assert.equal(obs.cid, 0, "EuroScope has no CID for a pilot");
    assert.equal(obs.flightRules, "I");
    assert.equal(obs.departure, "LFPG");
    assert.equal(obs.equipment, "B738/M-SDE3FGHIRWY/LB1");
    assert.equal(obs.groundspeed, 12);
  });

  it("rejects anything it cannot place on the map", () => {
    assert.equal(parseSeed("X", null), null);
    assert.equal(parseSeed("X", "LFPG"), null);
    assert.equal(parseSeed("X", []), null);
    assert.equal(parseSeed("X", { latitude: 48 }), null, "longitude missing");
    assert.equal(parseSeed("X", { ...base, latitude: 91 }), null, "off the globe");
    assert.equal(parseSeed("X", { ...base, longitude: "2.5" }), null, "not a number");
  });

  it("absorbs the fields it can defensibly do without", () => {
    const obs = parseSeed("X", INSIDE);
    assert.ok(obs, "position alone is enough");
    assert.equal(obs.arrival, null, "an any-destination range will serve it");
    assert.equal(obs.route, null, "and an unfiled route denies 1000");
    assert.equal(obs.groundspeed, 0);

    const junk = parseSeed("X", { ...base, departure: "LFPGX", groundspeed: -5 });
    assert.ok(junk);
    assert.equal(junk.departure, null, "not an ICAO code");
    assert.equal(junk.groundspeed, 0, "clamped rather than left negative");
  });
});
