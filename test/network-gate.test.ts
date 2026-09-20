/**
 * Tests for the network gate: the live server refusing a controller who is not
 * logged on to the network it describes.
 *
 * This is the boundary that actually holds between a simulator session and the
 * live pool. EuroScope reports a student connected to a sweatbox through an
 * ordinary connection as DIRECT, identically to VATSIM, so the plugin cannot
 * know which world it is in -- and a plugin that guesses wrong would seed
 * flights that do not exist into the real map and hold real ORCAM codes for
 * them. Nothing here can be allowed to regress quietly.
 */

process.env.FEED_SOURCE = "vatsim";
process.env.AUTH_SECRET = "";

import assert from "node:assert/strict";
import { describe, it, before, beforeEach } from "node:test";

import { Engine } from "../src/engine/engine.js";
import type { FeedResult } from "../src/vatsim/datafeed.js";
import type { PersistenceStore } from "../src/store/redis.js";
import { makeConfig, pilot, range, feed as plainFeed } from "./helpers.js";

const STUDENT = "LFPG_TWR";
const REAL = "LFFF_CTR";

type Harness = Awaited<ReturnType<typeof build>>;

/** A datafeed generation that also says who is controlling. */
function feedWithRoster(observations: ReturnType<typeof pilot>[], controllers: string[]): FeedResult {
  return { ...plainFeed(observations), controllers: new Set(controllers) };
}

async function build() {
  const { buildServer } = await import("../src/server.js");
  const engine = new Engine(0);
  engine.setConfig(makeConfig([range("0301", "0304")]));

  const app = buildServer({
    engine,
    store: { isConnected: true, save: async () => {} } as unknown as PersistenceStore,
    ingest: async (f) => engine.tick(f),
    config: () => null,
    reload: async () => {},
    feedHealthy: () => true,
  });
  return { app, engine };
}

function assign(h: Harness, controller: string, body: object = {}) {
  return h.app.inject({
    method: "POST",
    url: "/api/assign",
    payload: { callsign: "AFR1234", controller, token: "any", mode: "auto", ...body },
  });
}

describe("the network gate", () => {
  let h: Harness;
  before(async () => {
    h = await build();
  });
  beforeEach(() => {
    // AFR1234 is airborne and in scope, so the only thing that can refuse the
    // request below is the gate itself.
    h.engine.tick(feedWithRoster([pilot("AFR1234", "2000")], [REAL]));
  });

  it("serves a controller the network shows logged on", async () => {
    const res = await assign(h, REAL);
    assert.equal(res.statusCode, 200);
    assert.match(res.json().ssr, /^030[1-4]$/);
  });

  it("refuses one it does not, whatever their plugin believes", async () => {
    const res = await assign(h, STUDENT);
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error, "not_on_network");
  });

  it("refuses a seed from one, so no invented flight reaches the live map", async () => {
    // The case that makes this matter. Without the gate this call conjures a
    // sweatbox aircraft into the live map and holds a real code for it.
    const before = h.engine.size;
    const res = await assign(h, STUDENT, {
      callsign: "SIMJET",
      flight: {
        latitude: 48, longitude: 2.5, groundspeed: 0,
        flightRules: "I", departure: "LFPG", arrival: "LFBO",
      },
    });

    assert.equal(res.statusCode, 403);
    assert.equal(h.engine.seedCount, 0, "nothing was seeded");
    assert.equal(h.engine.size, before, "and no assignment was created");
  });

  it("is case and whitespace insensitive about the callsign", async () => {
    assert.equal((await assign(h, "  lfff_ctr  ")).statusCode, 200);
  });

  it("lets a controller in as soon as their logon reaches the feed", async () => {
    assert.equal((await assign(h, STUDENT)).statusCode, 403);

    // One datafeed generation later, they are on it.
    h.engine.tick(feedWithRoster([pilot("AFR1234", "2000")], [REAL, STUDENT]));
    assert.equal((await assign(h, STUDENT)).statusCode, 200);
  });

  it("holds the last roster when a feed carries none, rather than refusing everyone", async () => {
    // A pushed feed, or any generation without a controller list. Dropping the
    // roster here would refuse every controller in the country.
    h.engine.tick(plainFeed([pilot("AFR1234", "2000")]));
    assert.equal((await assign(h, REAL)).statusCode, 200);
    assert.equal((await assign(h, STUDENT)).statusCode, 403);
  });

  it("refuses everyone when the network genuinely shows nobody controlling", async () => {
    // Empty is an answer; absent is not. This is the distinction the whole
    // roster-vs-null design turns on.
    h.engine.tick(feedWithRoster([pilot("AFR1234", "2000")], []));
    assert.equal((await assign(h, REAL)).statusCode, 403);
  });
});

describe("GET /api/network", () => {
  let h: Harness;
  before(async () => {
    h = await build();
    h.engine.tick(feedWithRoster([pilot("AFR1234", "2000")], [REAL]));
  });

  it("tells a plugin which world it is in before it needs a code", async () => {
    const online = await h.app.inject({ method: "GET", url: `/api/network?controller=${REAL}` });
    assert.equal(online.statusCode, 200);
    assert.equal(online.json().onNetwork, true);
    assert.equal(online.json().enforced, true);

    const offline = await h.app.inject({ method: "GET", url: `/api/network?controller=${STUDENT}` });
    assert.equal(offline.json().onNetwork, false, "which is how the plugin learns to switch servers");
    assert.equal(offline.json().controllersOnline, 1);
  });

  it("wants a callsign to answer about", async () => {
    const res = await h.app.inject({ method: "GET", url: "/api/network" });
    assert.equal(res.statusCode, 400);
  });
});

describe("before the first datafeed", () => {
  it("judges nobody, because it cannot", async () => {
    const h = await build();
    assert.equal(h.engine.isControllerOnline(REAL), null);
    assert.equal(h.engine.rosterSize, null);

    // The engine is not ready either, so the request is refused for that
    // reason -- never for a roster that does not exist yet.
    const res = await assign(h, STUDENT);
    assert.equal(res.statusCode, 503);
  });
});
