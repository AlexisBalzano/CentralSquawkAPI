/**
 * Tests for the two invariants that break silently.
 *
 * Both failure modes leave a service that starts, serves traffic and looks
 * entirely healthy, which is exactly why they are worth pinning down.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Engine } from "../src/engine/engine.js";
import { feed, makeConfig, pilot, range, FAR_AWAY } from "./helpers.js";

/** A pool holding exactly the codes 0301..0304, issuable anywhere. */
const TINY_POOL = [range("0301", "0304")];
/** A pool holding exactly one code. */
const SINGLE_CODE = [range("0301", "0301")];

function engineWith(ranges: Parameters<typeof makeConfig>[0]): Engine {
  const engine = new Engine(0); // no warm-up: ready after the first tick
  engine.setConfig(makeConfig(ranges));
  return engine;
}

describe("reserve before allocate", () => {
  it("never issues a code another aircraft is already squawking", () => {
    const engine = engineWith(SINGLE_CODE);

    // SQUATTER is already transmitting the only code the pool has. NEEDY has a
    // default code and so wants an assignment. If allocation ran before every
    // observed code was reserved, NEEDY would be handed 0301 and the server
    // would have manufactured a DUPE out of nothing.
    const stats = engine.tick(
      feed([pilot("SQUATTER", "0301"), pilot("NEEDY", "2000")]),
    );

    const snapshot = JSON.parse(engine.snapshotJson) as Record<string, { ssr: string }>;
    assert.equal(snapshot["SQUATTER"]?.ssr, "0301", "the squatter keeps what it squawks");
    assert.equal(snapshot["NEEDY"], undefined, "no code was available, so none was invented");
    assert.equal(stats.exhausted, 1, "exhaustion is reported rather than hidden");
  });

  it("assigns around occupied codes rather than through them", () => {
    const engine = engineWith(TINY_POOL);

    // Three of the four pool codes are already on the wire.
    engine.tick(
      feed([
        pilot("OCC1", "0301"),
        pilot("OCC2", "0302"),
        pilot("OCC3", "0303"),
        pilot("NEEDY", "2000"),
      ]),
    );

    const snapshot = JSON.parse(engine.snapshotJson) as Record<string, { ssr: string }>;
    assert.equal(snapshot["NEEDY"]?.ssr, "0304", "the only free code is the one issued");
  });

  it("issues no duplicate codes on a cold start with heavy traffic", () => {
    // The realistic shape of the bug: an empty map, many aircraft already
    // squawking pool codes, and many more needing one, all in a single pass.
    const engine = engineWith([range("0301", "0377")]);

    const observations = [
      ...Array.from({ length: 20 }, (_, i) =>
        pilot(`OCC${i}`, (0o301 + i).toString(8).padStart(4, "0")),
      ),
      ...Array.from({ length: 30 }, (_, i) => pilot(`NEW${i}`, "2000")),
    ];
    engine.tick(feed(observations));

    const assignments = engine.all();
    const codes = assignments.map((a) => a.code);
    assert.equal(
      new Set(codes).size,
      codes.length,
      `duplicate codes issued: ${codes.filter((c, i) => codes.indexOf(c) !== i).join(", ")}`,
    );
    assert.equal(assignments.length, 50, "every aircraft ended up with a code");
  });
});

describe("tick idempotence", () => {
  it("changes nothing on a second pass over the same feed", () => {
    const engine = engineWith(TINY_POOL);
    const sample = feed([
      pilot("ADOPTED", "0301"), // non-default: adopted as-is
      pilot("NEEDY", "2000"), // default: assigned
      pilot("SHARED", "7000"), // default, but stays default until assigned
    ]);

    const first = engine.tick(sample);
    const before = engine.snapshotJson;

    const second = engine.tick(sample);
    const after = engine.snapshotJson;

    assert.equal(before, after, "the snapshot must be byte-identical");
    assert.equal(second.assigned, 0, "nothing reassigned");
    assert.equal(second.adopted, 0, "nothing re-adopted");
    assert.equal(second.released, 0, "nothing released");
    assert.equal(second.reassigned, 0, "nothing yielded its code");
    assert.ok(first.assigned > 0, "the first pass did do work");
  });

  it("stays idempotent once flights have left and been released", () => {
    const engine = engineWith(TINY_POOL);
    engine.tick(feed([pilot("GOING", "2000")]));

    const gone = feed([pilot("GOING", "2000", FAR_AWAY)]);
    const release = engine.tick(gone);
    assert.equal(release.released, 1, "leaving the padded zone releases the code");

    const after = engine.snapshotJson;
    const repeat = engine.tick(gone);
    assert.equal(repeat.released, 0, "a released flight is not released twice");
    assert.equal(engine.snapshotJson, after, "the snapshot is stable");
  });
});

describe("shared codes are not exclusive", () => {
  it("does not raise a DUPE for two aircraft on the same conspicuity code", () => {
    const engine = engineWith(TINY_POOL);
    // Both are Mode S capable with a route that stays inside, so both earn 1000.
    const modeS = { equipment: "B738/M-SDE1E2E3FGHIRWY/LB1", route: "INSID" };
    engine.tick(feed([pilot("MS1", "2000", modeS), pilot("MS2", "2000", modeS)]));

    const snapshot = JSON.parse(engine.snapshotJson) as Record<string, { ssr: string; dupe: boolean }>;
    assert.equal(snapshot["MS1"]?.ssr, "1000");
    assert.equal(snapshot["MS2"]?.ssr, "1000");
    assert.equal(snapshot["MS1"]?.dupe, false, "1000 is shared by design");
    assert.equal(snapshot["MS2"]?.dupe, false, "1000 is shared by design");
  });

  it("does raise a DUPE for two aircraft on the same discrete code", () => {
    const engine = engineWith(TINY_POOL);
    engine.tick(feed([pilot("A", "0301"), pilot("B", "0301")]));

    const snapshot = JSON.parse(engine.snapshotJson) as Record<string, { ssr: string; dupe: boolean }>;
    assert.equal(snapshot["A"]?.dupe, true, "a discrete code on two aircraft is a DUPE");
  });
});

describe("manual assignments are protected from the loop", () => {
  it("keeps a manual code across ticks", () => {
    const engine = engineWith(TINY_POOL);
    engine.tick(feed([pilot("MANUAL", "2000")]));

    const result = engine.setCode("MANUAL", "0304");
    assert.deepEqual(result, { ssr: "0304", dupe: false });

    engine.tick(feed([pilot("MANUAL", "2000")]));
    const snapshot = JSON.parse(engine.snapshotJson) as Record<string, { ssr: string }>;
    assert.equal(snapshot["MANUAL"]?.ssr, "0304", "the loop must not overwrite it");
    assert.equal(engine.all()[0]?.provenance, "manual");
  });

  it("refuses 7500 but allows 7600 and 7700", () => {
    const engine = engineWith(TINY_POOL);
    engine.tick(feed([pilot("EMG", "2000")]));

    assert.equal(engine.setCode("EMG", "7500"), "excluded_code");
    assert.deepEqual(engine.setCode("EMG", "7600"), { ssr: "7600", dupe: false });
    assert.deepEqual(engine.setCode("EMG", "7700"), { ssr: "7700", dupe: false });
  });
});

describe("scope rules", () => {
  it("does not assign to traffic on the ground", () => {
    const engine = engineWith(TINY_POOL);
    engine.tick(feed([pilot("TAXI", "2000", { groundspeed: 5 })]));
    assert.equal(engine.all().length, 0, "ground traffic is controller request only");
  });

  it("does not assign to VFR automatically", () => {
    const engine = engineWith(TINY_POOL);
    engine.tick(feed([pilot("VFR1", "7000", { flightRules: "V" })]));
    assert.equal(engine.all().length, 0, "VFR is assigned only on request");
  });

  it("assigns a VFR flight when a controller asks", () => {
    const engine = engineWith(TINY_POOL);
    engine.tick(feed([pilot("VFR1", "7000", { flightRules: "V" })]));
    const result = engine.forceReassign("VFR1");
    assert.ok(typeof result !== "string", `expected a code, got ${String(result)}`);
  });
});

describe("destination-aware allocation", () => {
  it("does not issue a range whose destination does not match the flight", () => {
    // The only codes available are reserved for flights bound to the UK, and
    // this one is going to Toulouse.
    const engine = engineWith([range("0301", "0304", ["EG"])]);
    const stats = engine.tick(feed([pilot("NEEDY", "2000", { arrival: "LFBO" })]));

    assert.equal(engine.all().length, 0, "no code may be issued for the wrong destination");
    assert.equal(stats.exhausted, 1, "reported as exhausted for that destination");
  });

  it("issues a destination-restricted range to a matching flight", () => {
    const engine = engineWith([range("0301", "0304", ["LF"])]);
    engine.tick(feed([pilot("NEEDY", "2000", { arrival: "LFBO" })]));
    assert.equal(engine.all()[0]?.code, "0301");
  });

  it("prefers the specific range so any-destination capacity is conserved", () => {
    // Both ranges could serve an LF-bound flight. Spending the wildcard range
    // on it would strand traffic that has no specific allocation at all.
    const engine = engineWith([
      range("0501", "0504", ["*"]),
      range("0301", "0304", ["LF"]),
    ]);
    engine.tick(feed([pilot("TOULOUSE", "2000", { arrival: "LFBO" })]));

    const code = engine.all()[0]?.code ?? "";
    assert.ok(code.startsWith("03"), `expected the LF range, got ${code}`);
  });

  it("falls back to any-destination when nothing specific matches", () => {
    const engine = engineWith([
      range("0501", "0504", ["*"]),
      range("0301", "0304", ["LF"]),
    ]);
    engine.tick(feed([pilot("BERLIN", "2000", { arrival: "EDDB" })]));

    const code = engine.all()[0]?.code ?? "";
    assert.ok(code.startsWith("05"), `expected the wildcard range, got ${code}`);
  });

  it("serves a flight with no filed destination only from any-destination ranges", () => {
    const engine = engineWith([range("0301", "0304", ["LF"])]);
    engine.tick(feed([pilot("NOPLAN", "2000", { arrival: null })]));
    assert.equal(engine.all().length, 0, "an unknown destination matches no specific range");
  });

  it("matches on ICAO prefix, so a one-letter token covers a whole region", () => {
    const engine = engineWith([range("0301", "0304", ["K"])]);
    engine.tick(feed([pilot("NEWYORK", "2000", { arrival: "KJFK" })]));
    assert.equal(engine.all()[0]?.code, "0301", "K should match KJFK");
  });
});

describe("the pool never issues a reserved code", () => {
  it("skips conspicuity, default and emergency codes a CAL range covers", () => {
    // A real CAL range can span codes that must never be handed out. 7677-7702
    // contains 7700, and 0777-1002 contains 1000.
    const engine = engineWith([range("7677", "7702"), range("0777", "1002")]);

    const flights = Array.from({ length: 6 }, (_, i) => pilot(`F${i}`, "2000"));
    engine.tick(feed(flights));

    const issued = engine.all().map((a) => a.code);
    assert.ok(!issued.includes("7700"), `7700 was issued: ${issued.join(", ")}`);
    assert.ok(!issued.includes("1000"), `1000 was issued: ${issued.join(", ")}`);
    assert.ok(issued.length > 0, "the surrounding codes are still usable");
  });
});
