/**
 * Tests for `POST /api/feed` and the merging of every client's picture.
 *
 * No EuroScope in a sweatbox sees all of it -- each only receives traffic
 * inside its own visibility range -- so every push counts toward one world.
 * `test/pictures.test.ts` pins the merge rules; these pin what the engine is
 * finally handed, which is the part a client actually experiences.
 */

// Set before the modules that read it are loaded. `env` snapshots the process
// environment at import time, so these have to precede the dynamic imports.
process.env.FEED_SOURCE = "push";
process.env.AUTH_SECRET = "test-secret";
process.env.FEEDER_LEASE_SEC = "1";

import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, it, before } from "node:test";

import { expectedToken } from "../src/auth.js";
import { Engine } from "../src/engine/engine.js";
import type { PersistenceStore } from "../src/store/redis.js";
import { makeConfig, range, INSIDE } from "./helpers.js";

type Server = Awaited<ReturnType<typeof build>>;

const INSTRUCTOR = "LFPG_GND";
const TRAINEE = "LFPG_TWR";

function token(controller: string): string {
  return expectedToken("test-secret", controller);
}

function target(callsign: string, transponder = "2000") {
  return {
    callsign,
    ...INSIDE,
    altitude: 35_000,
    groundspeed: 450,
    transponder,
    flightRules: "I",
    departure: "LFPG",
    arrival: "LFBO",
    equipment: "B738/M-SDFGIRWY/C",
    route: "INSID",
  };
}

async function build() {
  const { buildServer } = await import("../src/server.js");
  const engine = new Engine(0);
  engine.setConfig(makeConfig([range("0301", "0304")]));

  const ticked: number[] = [];
  const app = buildServer({
    engine,
    store: { isConnected: true, save: async () => {} } as unknown as PersistenceStore,
    ingest: async (feed) => {
      ticked.push(feed.observations.length);
      return engine.tick(feed);
    },
    config: () => null,
    reload: async () => {},
    feedHealthy: () => true,
  });
  return { app, engine, ticked };
}

function push(server: Server, controller: string, observations: object[]) {
  return server.app.inject({
    method: "POST",
    url: "/api/feed",
    payload: { controller, token: token(controller), observations },
  });
}

describe("the pushed feed route", () => {
  let server: Server;
  before(async () => {
    server = await build();
  });

  it("accepts a picture and reconciles against it", async () => {
    const res = await push(server, INSTRUCTOR, [target("SIM1"), target("SIM2")]);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      accepted: 2,
      skipped: 0,
      inScope: 2,
      feeders: 1,
      leaseSeconds: 1,
    });
    assert.deepEqual(server.ticked, [2], "the engine ran once, on what was pushed");

    const snapshot = JSON.parse(server.engine.snapshotJson) as Record<string, unknown>;
    assert.ok(snapshot["SIM1"], "and the assignment is being served");
  });

  it("refuses a bad token before doing anything with the body", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/feed",
      payload: { controller: TRAINEE, token: "wrong", observations: [target("SIM3")] },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error, "not_authorised");
  });

  it("refuses a body that is not a list of observations", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/feed",
      payload: { controller: INSTRUCTOR, token: token(INSTRUCTOR), observations: "SIM1" },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, "malformed_feed");
  });
});

describe("merging every client's picture", () => {
  let server: Server;
  before(async () => {
    server = await build();
  });

  function snapshot(): Record<string, unknown> {
    return JSON.parse(server.engine.snapshotJson) as Record<string, unknown>;
  }

  it("accepts every client and ticks against what they see between them", async () => {
    // Overlapping views: both see SIM2, only one sees each of the others.
    assert.equal((await push(server, INSTRUCTOR, [target("SIM1"), target("SIM2")])).statusCode, 200);
    const res = await push(server, TRAINEE, [target("SIM2"), target("SIM3")]);

    assert.equal(res.statusCode, 200, "the second client is not turned away");
    assert.equal(res.json().feeders, 2);
    assert.equal(res.json().inScope, 3, "the union, with the shared aircraft counted once");
    const served = snapshot();
    assert.ok(served["SIM1"] && served["SIM2"] && served["SIM3"], "and every aircraft is coded");
  });

  it("does not let one client's empty picture blank anyone else's", async () => {
    const res = await push(server, "LFPG_DEL", []);

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().feeders, 3);
    assert.equal(res.json().inScope, 3);
  });

  it("drops a client that stops pushing, leaving its aircraft to the grace period", async () => {
    // The instructor's EuroScope has crashed; the trainee carries on.
    await sleep(1_100); // FEEDER_LEASE_SEC=1
    const res = await push(server, TRAINEE, [target("SIM2"), target("SIM3")]);

    assert.equal(res.json().feeders, 1);
    assert.equal(res.json().inScope, 2, "SIM1 is in nobody's picture any more");
    assert.ok(snapshot()["SIM1"], "but it is held through the grace period, not released on the spot");
  });
});
