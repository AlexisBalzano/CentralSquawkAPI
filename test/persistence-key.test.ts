/**
 * The Redis key the map is persisted under, per mode.
 *
 * The live and simulator instances may share one Redis, kept apart only by this
 * key. Getting it wrong is invisible while both run -- each holds its own map in
 * memory -- and surfaces only on a restart, when one instance restores the
 * other's state: a sweatbox session's invented aircraft, restored into the live
 * map, holding real codes.
 *
 * Its own file because `env` reads the process environment once, at import,
 * and the runner gives each test file its own process.
 */

// Exactly as production runs: FEED_SOURCE is not set anywhere in the
// deployment, so the default has to be the case that is right.
delete process.env.FEED_SOURCE;

import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("the persistence key", () => {
  it("is the live key when FEED_SOURCE is unset, as it is in production", async () => {
    const { env } = await import("../src/env.js");
    const { assignmentsKey } = await import("../src/store/redis.js");

    assert.equal(env.feedSource, "vatsim", "an unset source means the datafeed");
    assert.equal(
      assignmentsKey(env.feedSource),
      "centralsquawk:assignments",
      "and the key agrees -- the existing live key, so a deploy loses no persisted overrides",
    );
  });

  it("keeps the simulator's state apart from the live one", async () => {
    const { assignmentsKey } = await import("../src/store/redis.js");
    assert.notEqual(assignmentsKey("push"), assignmentsKey("vatsim"));
    assert.equal(assignmentsKey("push"), "sweatbox:centralsquawk:assignments");
  });
});
