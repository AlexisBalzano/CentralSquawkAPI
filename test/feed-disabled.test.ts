/**
 * The isolation guarantee, pinned.
 *
 * A simulator world must never share a pool with the live one: sim traffic
 * would consume real ORCAM codes and raise DUPEs against real aircraft. That
 * separation is structural rather than a check inside the engine -- the route
 * is not registered at all unless FEED_SOURCE=push -- and this is the test that
 * says so. Its own file because `env` reads the process environment once, at
 * import, and the runner gives each test file its own process.
 */

process.env.FEED_SOURCE = "vatsim";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Engine } from "../src/engine/engine.js";
import type { PersistenceStore } from "../src/store/redis.js";
import { makeConfig, range, INSIDE } from "./helpers.js";

describe("a production instance", () => {
  it("has no feed route to push anything at", async () => {
    const { buildServer } = await import("../src/server.js");
    const engine = new Engine(0);
    engine.setConfig(makeConfig([range("0301", "0304")]));

    let ingested = false;
    const app = buildServer({
      engine,
      store: { isConnected: true, save: async () => {} } as unknown as PersistenceStore,
      ingest: async (feed) => {
        ingested = true;
        return engine.tick(feed);
      },
      config: () => null,
      reload: async () => {},
      feedHealthy: () => true,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/feed",
      payload: {
        controller: "LFPG_TWR",
        token: "anything",
        observations: [{ callsign: "SIM1", ...INSIDE, transponder: "2000" }],
      },
    });

    assert.equal(res.statusCode, 404, "there is nothing there to send to");
    assert.equal(ingested, false, "and nothing reached the engine");
  });
});
