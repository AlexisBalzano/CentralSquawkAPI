/**
 * Tests for the pushed feed: the picture a client supplies when there is no
 * VATSIM datafeed behind the session at all.
 *
 * The point worth proving is the one the design rests on -- that the engine
 * does not care where an observation came from. A pushed feed drives adoption,
 * allocation, DUPE and release through exactly the same phases, so these tests
 * are deliberately written against behaviour rather than against the parser.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Engine } from "../src/engine/engine.js";
import { parsePushedFeed, parseSeed } from "../src/domain/observation.js";
import { makeConfig, range, INSIDE, FAR_AWAY } from "./helpers.js";

const TINY_POOL = [range("0301", "0304")];

/** What a plugin sends for one aircraft: a radar target plus its flight plan. */
function target(callsign: string, transponder: string, overrides: object = {}) {
  return {
    callsign,
    ...INSIDE,
    altitude: 35_000,
    groundspeed: 450,
    transponder,
    flightRules: "I",
    departure: "LFPG",
    arrival: "LFBO",
    equipment: "B738/M-SDFGIRWY/C", // not Mode S capable: never diverts onto 1000
    route: "INSID",
    ...overrides,
  };
}

function pushedEngine(): Engine {
  const engine = new Engine(0);
  engine.setConfig(makeConfig(TINY_POOL));
  return engine;
}

function push(engine: Engine, targets: object[]) {
  const feed = parsePushedFeed({ observations: targets });
  assert.ok(feed, "the feed parsed");
  return engine.tick(feed);
}

function snapshotOf(engine: Engine): Record<string, { ssr: string; dupe: boolean }> {
  return JSON.parse(engine.snapshotJson) as Record<string, { ssr: string; dupe: boolean }>;
}

describe("an engine driven entirely by pushed feeds", () => {
  it("assigns, adopts and detects DUPE exactly as it would from the datafeed", () => {
    const engine = pushedEngine();

    push(engine, [
      target("NEEDY", "2000"), // default code: wants an assignment
      target("KEEPER", "0303"), // already discrete: adopted, not reissued
      target("DUPE1", "0304"),
      target("DUPE2", "0304"), // two aircraft on one exclusive code
    ]);

    const snapshot = snapshotOf(engine);
    assert.match(snapshot["NEEDY"]!.ssr, /^030[12]$/, "assigned from what is left");
    assert.equal(snapshot["KEEPER"]!.ssr, "0303", "adopted what it was squawking");
    assert.equal(snapshot["DUPE1"]!.dupe, true);
    assert.equal(snapshot["DUPE2"]!.dupe, true);
    assert.equal(snapshot["KEEPER"]!.dupe, false);
  });

  it("releases a flight that leaves the picture, once the grace period is out", () => {
    const engine = pushedEngine();
    push(engine, [target("GONE", "2000")]);
    assert.ok(snapshotOf(engine)["GONE"], "assigned while present");

    // Still inside the 300 s grace period: the instructor may just have paused.
    push(engine, []);
    assert.ok(snapshotOf(engine)["GONE"], "held through the grace period");
  });

  it("drops a flight outside the zone without waiting", () => {
    const engine = pushedEngine();
    push(engine, [target("WANDERER", "2000")]);
    assert.ok(snapshotOf(engine)["WANDERER"]);

    push(engine, [target("WANDERER", "2000", FAR_AWAY)]);
    assert.equal(snapshotOf(engine)["WANDERER"], undefined, "demonstrably gone, not possibly gone");
  });
});

describe("parsing a pushed feed", () => {
  it("takes the transponder, unlike a seed", () => {
    // The whole difference between the two trust models. There is no datafeed
    // behind a sweatbox to correct a wrong code, and no live pool to protect.
    const feed = parsePushedFeed({ observations: [target("SIMJET", "0301")] });
    assert.ok(feed);
    assert.equal(feed.observations[0]!.transponder, "0301");

    const seed = parseSeed("SIMJET", target("SIMJET", "0301"));
    assert.ok(seed);
    assert.equal(seed.transponder, "0000", "a seed's code is always discarded");
  });

  it("stamps its own generatedAt rather than trusting the client clock", () => {
    // Every age the tick computes -- the grace period, the seed TTL -- is
    // measured against generatedAt, so a client an hour fast would otherwise
    // expire the entire map on its first push.
    const before = Date.now();
    const feed = parsePushedFeed({
      observations: [target("SIMJET", "2000")],
      generatedAt: Date.now() + 3_600_000,
    });
    assert.ok(feed);
    assert.ok(feed.generatedAt >= before && feed.generatedAt <= Date.now());
  });

  it("falls back to 0000 for a missing or malformed code, as the datafeed does", () => {
    const feed = parsePushedFeed({
      observations: [target("NOCODE", "9999"), target("BLANK", "")],
    });
    assert.ok(feed);
    assert.equal(feed.observations[0]!.transponder, "0000");
    assert.equal(feed.observations[1]!.transponder, "0000");
  });

  it("skips the entries it cannot use and counts them, rather than failing the push", () => {
    const feed = parsePushedFeed({
      observations: [
        target("GOOD", "2000"),
        { callsign: "NOPOS", transponder: "2000" }, // unplaceable
        { ...target("", "2000") }, // no callsign
        "not an object",
      ],
    });
    assert.ok(feed);
    assert.equal(feed.observations.length, 1);
    assert.equal(feed.skipped, 3);
  });

  it("refuses a body that is not a list of observations", () => {
    assert.equal(parsePushedFeed(null), null);
    assert.equal(parsePushedFeed({}), null);
    assert.equal(parsePushedFeed({ observations: "AFR1234" }), null);
    assert.equal(
      parsePushedFeed({ observations: Array.from({ length: 2001 }, () => target("X", "2000")) }),
      null,
      "a backstop against a client pushing something enormous",
    );
  });
});
