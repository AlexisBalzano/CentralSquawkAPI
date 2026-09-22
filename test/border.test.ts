/**
 * Tests for the border band: the ring either side of the AOR boundary where a
 * new flight needs altitude before it is taken into scope.
 *
 * What it prevents is invisible from here. A low flight near the boundary is
 * usually a neighbouring unit's departure or arrival, and the plugin writes the
 * central code into any flight nobody is tracking, so taking one into the map
 * would have every French plugin overwrite a foreign controller's code in the
 * middle of a handoff.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ConfigError, parseConfig } from "../src/config/schema.js";
import { Engine } from "../src/engine/engine.js";
import type { Observation } from "../src/domain/types.js";
import { feed, makeConfig, pilot, range, INSIDE } from "./helpers.js";

const TINY_POOL = [range("0301", "0304")];
const INSET_NM = 10;
const FLOOR_FT = 10_000;

// The helpers' square ends at 5E, and at 48N a degree of longitude is 40 NM.
/** 12 NM outside the boundary: well within the 40 NM entry ring. */
const JUST_OUTSIDE = { latitude: 48, longitude: 5.3 };
/** 4 NM inside the boundary: in the AOR, but short of the inset. */
const JUST_INSIDE = { latitude: 48, longitude: 4.9 };
/** 20 NM inside the boundary: past the inset, in the core. */
const PAST_THE_INSET = { latitude: 48, longitude: 4.5 };

function engineWith(ranges = TINY_POOL, aor = { borderInsetNm: INSET_NM, borderMinAltitudeFt: FLOOR_FT }): Engine {
  const engine = new Engine(0); // no warm-up: ready after the first tick
  engine.setConfig(makeConfig(ranges, [], aor));
  return engine;
}

/** A departure a minute or two after takeoff: airborne, IFR, still on 2000. */
function climbing(
  callsign: string,
  where: { latitude: number; longitude: number },
  altitude = 4_000,
  overrides: Partial<Observation> = {},
): Observation {
  return pilot(callsign, "2000", { ...where, altitude, groundspeed: 220, ...overrides });
}

function ssrOf(engine: Engine, callsign: string): string | undefined {
  const snapshot = JSON.parse(engine.snapshotJson) as Record<string, { ssr: string }>;
  return snapshot[callsign]?.ssr;
}

describe("a new flight in the border band", () => {
  it("is left alone below the floor just outside the boundary", () => {
    const engine = engineWith();
    const stats = engine.tick(feed([climbing("SWR1", JUST_OUTSIDE)]));

    assert.equal(ssrOf(engine, "SWR1"), undefined, "no code published for a neighbour's departure");
    assert.equal(stats.heldAtBorder, 1, "and counted, so the band's effect is visible");
  });

  it("is left alone below the floor inside the boundary too, as far as the inset", () => {
    const engine = engineWith();
    engine.tick(feed([climbing("INBAND", JUST_INSIDE), climbing("INCORE", PAST_THE_INSET)]));

    assert.equal(ssrOf(engine, "INBAND"), undefined, "4 NM inside is still the band");
    assert.match(ssrOf(engine, "INCORE") ?? "", /^030[1-4]$/, "20 NM inside is the core");
  });

  it("is taken at the floor", () => {
    const engine = engineWith();
    engine.tick(feed([climbing("HIGH", JUST_OUTSIDE, FLOOR_FT)]));
    assert.match(ssrOf(engine, "HIGH") ?? "", /^030[1-4]$/);
  });

  it("is taken the tick it climbs through the floor, with nothing remembered in between", () => {
    const engine = engineWith();
    assert.equal(engine.tick(feed([climbing("SWR1", JUST_OUTSIDE, 6_000)])).heldAtBorder, 1);

    engine.tick(feed([climbing("SWR1", JUST_OUTSIDE, 11_000)]));
    assert.match(ssrOf(engine, "SWR1") ?? "", /^030[1-4]$/);
  });

  it("is not adopted either, since an adopted code is published and written just the same", () => {
    const engine = engineWith();
    engine.tick(feed([pilot("SWR1", "0303", { ...JUST_OUTSIDE, altitude: 4_000, groundspeed: 220 })]));
    assert.equal(ssrOf(engine, "SWR1"), undefined);
  });
});

describe("what the border band leaves alone", () => {
  it("assigns in the core as soon as the flight is airborne, as before", () => {
    const engine = engineWith();
    engine.tick(feed([climbing("AFR1", INSIDE, 300, { groundspeed: 140 })]));
    assert.match(ssrOf(engine, "AFR1") ?? "", /^030[1-4]$/, "on the takeoff roll, as it always was");
  });

  it("keeps the code of a flight already in the map when it descends into the band", () => {
    // The band decides entry, not release. A French departure bound for a
    // foreign airport stays ours until it lands or leaves the padded zone.
    const engine = engineWith();
    engine.tick(feed([pilot("AFR1", "2000")]));
    const code = ssrOf(engine, "AFR1");
    assert.ok(code, "assigned at cruise, in the core");

    const stats = engine.tick(
      feed([pilot("AFR1", code, { ...JUST_OUTSIDE, altitude: 3_000, groundspeed: 180 })]),
    );
    assert.equal(ssrOf(engine, "AFR1"), code, "the code is kept");
    assert.equal(stats.released, 0);
    assert.equal(stats.heldAtBorder, 0, "a flight already in the map is not a new one");
  });

  it("still observes a held flight, so its code stays reserved and a controller can take it", () => {
    // The gate lives in classification, not observation. Moved into phase 1 it
    // would stop reserving what held flights squawk, and the pool would hand
    // their codes straight out again as DUPEs.
    const engine = engineWith([range("0301", "0301")]);
    const stats = engine.tick(
      feed([
        pilot("SWR1", "0301", { ...JUST_OUTSIDE, altitude: 4_000, groundspeed: 220 }),
        pilot("NEEDY", "2000"),
      ]),
    );

    assert.equal(stats.heldAtBorder, 1);
    assert.equal(ssrOf(engine, "NEEDY"), undefined, "the only code is on the wire, so it is not reissued");
    assert.equal(stats.exhausted, 1);
    assert.deepEqual(
      engine.setCode("SWR1", "0301", "LFMM_CTR"),
      { ssr: "0301", dupe: false },
      "a controller asking is never gated",
    );
  });

  it("with no inset and no floor, admits everything the entry ring does, as before", () => {
    const engine = engineWith(TINY_POOL, { borderInsetNm: 0, borderMinAltitudeFt: 0 });
    engine.tick(feed([climbing("SWR1", JUST_OUTSIDE, 1_500)]));
    assert.match(ssrOf(engine, "SWR1") ?? "", /^030[1-4]$/);
  });
});

describe("configuring the border band", () => {
  it("refuses a config.json that does not set it", () => {
    // Required, not defaulted: a config.json from before the band existed must
    // fail loudly rather than run with the safeguard quietly switched off.
    const { raw } = makeConfig(TINY_POOL);
    const { borderInsetNm: _inset, borderMinAltitudeFt: _floor, ...older } = raw.aor;

    assert.throws(
      () => parseConfig({ ...raw, aor: older }),
      (err: unknown) =>
        err instanceof ConfigError &&
        err.problems.some((p) => p.startsWith("config.aor.borderInsetNm")) &&
        err.problems.some((p) => p.startsWith("config.aor.borderMinAltitudeFt")),
    );
    assert.deepEqual(parseConfig(raw).aor, raw.aor, "and accepts one that does");
  });
});
