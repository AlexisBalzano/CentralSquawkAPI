/** Bootstrap: config, persistence, HTTP server, and the reconciliation loop. */

import { loadConfigSnapshot, type ConfigSnapshot } from "./config/loader.js";
import { Engine } from "./engine/engine.js";
import { env } from "./env.js";
import { buildServer, type Services } from "./server.js";
import { PersistenceStore } from "./store/redis.js";
import { fetchDatafeed } from "./vatsim/datafeed.js";

/** Feed considered stale after this long without a successful poll. */
const FEED_STALE_MS = 90_000;

async function main(): Promise<void> {
  const engine = new Engine(env.warmupCycles);

  let config: ConfigSnapshot | null = null;
  let lastFeedOk = 0;

  const reload = async (): Promise<ConfigSnapshot> => {
    // Parse and validate into a new snapshot first; only a fully valid result
    // is swapped in, so a rejected config leaves the running one untouched.
    const next = await loadConfigSnapshot(env.configDir);
    config = next;
    engine.setConfig(next);
    return next;
  };

  // Startup is the one place a bad config is fatal: there is nothing to fall
  // back to, and running without one would serve an empty map as if it were real.
  const initial = await reload();

  const bootLog = {
    info: (m: string) => console.log(m),
    warn: (m: string) => console.warn(m),
    error: (m: string) => console.error(m),
  };
  const store = new PersistenceStore(env.redisUrl, bootLog);
  await store.connect();
  engine.restore(await store.load());

  const services: Services = {
    engine,
    store,
    config: () => config,
    reload: async () => {
      await reload();
    },
    feedHealthy: () => lastFeedOk > 0 && Date.now() - lastFeedOk < FEED_STALE_MS,
  };

  const app = buildServer(services);
  await app.listen({ port: env.port, host: env.host });
  app.log.info(
    `navdata AIRAC ${initial.navdata.cycle}, ${initial.navdata.fixes.size} fixes, ` +
      `${initial.pools.capacity} issuable codes across ${initial.ranges.length} CAL ranges ` +
      `(${initial.pools.utilisation().anyDestination.capacity} any-destination)`,
  );

  const tickMs = initial.raw.timing.tickIntervalSec * 1000;

  const poll = async (): Promise<void> => {
    try {
      const feed = await fetchDatafeed(env.vatsimDatafeedUrl);
      lastFeedOk = Date.now();
      const stats = engine.tick(feed);
      app.log.info(
        {
          inScope: stats.inScope,
          assigned: stats.assigned,
          adopted: stats.adopted,
          released: stats.released,
          dupes: stats.dupes,
          ms: stats.durationMs,
        },
        engine.isReady ? "tick" : "tick (warming up)",
      );
      if (stats.exhausted > 0) {
        app.log.error(`${stats.exhausted} flights got no code: every pool is full`);
      }
      await store.save(engine.all());
    } catch (err) {
      app.log.error({ err }, "tick failed");
    }
  };

  void poll();
  const timer = setInterval(() => void poll(), tickMs);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`${signal} received, shutting down`);
    clearInterval(timer);
    await store.save(engine.all());
    await store.disconnect();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error("failed to start:", err);
  process.exit(1);
});
