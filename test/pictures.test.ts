/**
 * Tests for merging the pictures simulator clients push.
 *
 * The union has to let an aircraft leave as readily as it lets one in. A merge
 * that only ever added would hold every flight any client had ever seen, and
 * nothing would be released for the length of a session -- with no symptom
 * beyond a pool slowly draining.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Pictures, type Merged } from "../src/domain/pictures.js";
import { feed, pilot } from "./helpers.js";

const TTL = 45_000;
const T0 = 1_000_000;

function callsigns(merged: Merged): string[] {
  return merged.feed.observations.map((obs) => obs.callsign).sort();
}

describe("merging pushed pictures", () => {
  it("unites what each client can see", () => {
    const pictures = new Pictures(TTL);
    pictures.submit("LFPG_TWR", feed([pilot("SIM1", "2000")], T0));
    const merged = pictures.submit("LFMN_APP", feed([pilot("SIM2", "2000")], T0 + 1_000));

    assert.deepEqual(callsigns(merged), ["SIM1", "SIM2"]);
    assert.equal(merged.feeders, 2);
  });

  it("counts an aircraft several clients see once", () => {
    const pictures = new Pictures(TTL);
    pictures.submit("LFPG_TWR", feed([pilot("SIM1", "2000")], T0));
    const merged = pictures.submit("LFPG_APP", feed([pilot("SIM1", "2000")], T0 + 1_000));

    assert.deepEqual(callsigns(merged), ["SIM1"]);
  });

  it("replaces a client's own picture rather than adding to it", () => {
    const pictures = new Pictures(TTL);
    pictures.submit("LFPG_TWR", feed([pilot("SIM1", "2000"), pilot("SIM2", "2000")], T0));
    const merged = pictures.submit("LFPG_TWR", feed([pilot("SIM2", "2000")], T0 + 5_000));

    assert.deepEqual(callsigns(merged), ["SIM2"], "SIM1 left the only range it was in, so it left the world");
  });

  it("keeps an aircraft one client lost while another still sees it", () => {
    const pictures = new Pictures(TTL);
    pictures.submit("LFPG_TWR", feed([pilot("SIM1", "2000")], T0));
    pictures.submit("LFPG_APP", feed([pilot("SIM1", "2000")], T0 + 1_000));
    const merged = pictures.submit("LFPG_TWR", feed([], T0 + 5_000));

    assert.deepEqual(callsigns(merged), ["SIM1"], "an empty picture withdraws only its own client's view");
  });

  it("describes an aircraft by the most recent push that carries it", () => {
    const pictures = new Pictures(TTL);
    pictures.submit("LFPG_TWR", feed([pilot("SIM1", "2000", { altitude: 3_000 })], T0));

    let merged = pictures.submit("LFPG_APP", feed([pilot("SIM1", "4521", { altitude: 4_000 })], T0 + 1_000));
    assert.equal(merged.feed.observations[0]?.transponder, "4521");

    // A client that joined first is no less current for it once it pushes again.
    merged = pictures.submit("LFPG_TWR", feed([pilot("SIM1", "4521", { altitude: 5_000 })], T0 + 2_000));
    assert.equal(merged.feed.observations[0]?.altitude, 5_000);
  });

  it("drops a picture whose client has gone quiet for longer than the TTL", () => {
    const pictures = new Pictures(TTL);
    pictures.submit("LFPG_TWR", feed([pilot("SIM1", "2000")], T0));

    const atTtl = pictures.submit("LFPG_APP", feed([pilot("SIM2", "2000")], T0 + TTL));
    assert.deepEqual(callsigns(atTtl), ["SIM1", "SIM2"], "exactly at the TTL it still counts");
    assert.deepEqual(atTtl.lapsed, []);

    const past = pictures.submit("LFPG_APP", feed([pilot("SIM2", "2000")], T0 + TTL + 1));
    assert.deepEqual(callsigns(past), ["SIM2"]);
    assert.deepEqual(past.lapsed, ["LFPG_TWR"]);
    assert.equal(past.feeders, 1);
  });

  it("reports a client joining, not renewing, and rejoining after a lapse", () => {
    const pictures = new Pictures(TTL);
    assert.equal(pictures.submit("LFPG_TWR", feed([], T0)).joined, true);
    assert.equal(pictures.submit("LFPG_TWR", feed([], T0 + 5_000)).joined, false);

    const back = pictures.submit("LFPG_TWR", feed([], T0 + 5_000 + TTL + 1));
    assert.equal(back.joined, true);
    assert.deepEqual(back.lapsed, ["LFPG_TWR"], "and its departure is reported first");
  });

  it("stamps the world with the push that produced it, and no roster", () => {
    const pictures = new Pictures(TTL);
    pictures.submit("LFPG_TWR", feed([pilot("SIM1", "2000")], T0));
    const merged = pictures.submit("LFPG_APP", { generatedAt: T0 + 3_000, observations: [], skipped: 2 });

    assert.equal(merged.feed.generatedAt, T0 + 3_000);
    assert.equal(merged.feed.skipped, 2);
    // Absent, not empty: an empty roster would read as "nobody is logged on".
    assert.equal(merged.feed.controllers, undefined);
  });
});
