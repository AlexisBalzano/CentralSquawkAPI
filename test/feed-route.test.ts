/**
 * Tests for `POST /api/feed` and the feeder lease.
 *
 * Every EuroScope in a sweatbox sees the same traffic, so without a lease they
 * would all push and the map would be rebuilt several times a tick from
 * pictures that disagree. The lease is the whole of that, and it is small
 * enough to get subtly wrong: hence a route-level test rather than a unit one.
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

describe("the feeder lease", () => {
  let server: Server;
  before(async () => {
    server = await build();
  });

  it("goes to whoever pushes first", async () => {
    assert.equal((await push(server, INSTRUCTOR, [target("SIM1")])).statusCode, 200);
  });

  it("locks everyone else out while it is held", async () => {
    const res = await push(server, TRAINEE, [target("SIM1")]);
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error, "not_the_feeder");
    assert.equal(res.json().feeder, INSTRUCTOR, "and says who to blame");
  });

  it("renews on every push, so the holder never locks itself out", async () => {
    assert.equal((await push(server, INSTRUCTOR, [target("SIM1")])).statusCode, 200);
    assert.equal((await push(server, INSTRUCTOR, [target("SIM1")])).statusCode, 200);
  });

  it("is taken over once it goes stale, so a feeder that drops is not fatal", async () => {
    // The instructor's EuroScope has crashed and stopped pushing.
    await sleep(1_100); // FEEDER_LEASE_SEC=1

    const res = await push(server, TRAINEE, [target("SIM1"), target("SIM2")]);
    assert.equal(res.statusCode, 200, "the session keeps going under a new feeder");

    // And the new feeder now holds it against the old one.
    assert.equal((await push(server, INSTRUCTOR, [target("SIM1")])).statusCode, 409);
  });
});
