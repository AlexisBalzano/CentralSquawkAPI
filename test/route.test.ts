/**
 * Tests for field 15 route expansion.
 *
 * A route that fails to expand is not an error anywhere: the flight simply drops
 * out of Mode S eligibility and receives a discrete code, which looks like a
 * policy decision rather than a parsing failure. These pin the cases that were
 * silently getting it wrong.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { expandRoute } from "../src/navdata/modes.js";
import type { Navdata } from "../src/navdata/navdata.js";

/**
 * UN491 as actually published: DITAL sits *earlier* in the chain than RESMI, so
 * a flight routing RESMI -> DITAL walks it backwards.
 */
const NAVDATA: Navdata = {
  cycle: "test",
  fixes: new Map([
    ["COHPA", { lat: 48.444, lon: 2.851 }],
    ["RESMI", { lat: 48.569, lon: 2.192 }],
    ["TABOV", { lat: 48.644, lon: 1.649 }],
    ["PIGOP", { lat: 48.686, lon: 1.339 }],
    ["DITAL", { lat: 48.745, lon: 0.889 }],
  ]),
  airways: new Map([["UN491", [["DITAL", "PIGOP", "TABOV", "RESMI"]]]]),
  procedures: new Map(),
};

const EXPANDED = ["COHPA", "RESMI", "TABOV", "PIGOP", "DITAL"];

describe("field 15 route expansion", () => {
  it("expands an airway whose exit fix carries a speed or level change", () => {
    // LNR4778 (LFSB-LFRS) filed "... RESMI UN491 DITAL/N0389F270 ...". The exit
    // fix used to be read straight from the token with the suffix still attached,
    // so no chain could contain it, the airway went unexpanded, and the flight
    // lost its Mode S conspicuity code over a step climb.
    assert.deepEqual(
      expandRoute(NAVDATA, "LFSB", "LFRS", "COHPA RESMI UN491 DITAL/N0389F270"),
      EXPANDED,
    );
  });

  it("expands the same airway when the exit fix is bare", () => {
    assert.deepEqual(expandRoute(NAVDATA, "LFSB", "LFRS", "COHPA RESMI UN491 DITAL"), EXPANDED);
  });

  it("strips a change of flight rules from a point", () => {
    // DISVU/N0290VFR is the point a flight goes VFR. `VFR` sits where the level
    // normally would, so a pattern expecting only levels leaves the whole token
    // standing as a fix name nothing can resolve.
    assert.deepEqual(expandRoute(NAVDATA, "LFSB", "LFRS", "COHPA RESMI/N0290VFR"), [
      "COHPA",
      "RESMI",
    ]);
  });

  it("still marks an airway whose exit fix genuinely is not on it", () => {
    // The suffix must not become a way to paper over a real mismatch: NOWAY is
    // not on UN491 with or without one.
    assert.deepEqual(
      expandRoute(NAVDATA, "LFSB", "LFRS", "COHPA RESMI UN491 NOWAY/N0389F270"),
      ["COHPA", "RESMI", "?UN491", "NOWAY"],
    );
  });
});
