/** Bootstrap: config, persistence, HTTP server, and the reconciliation loop. */

import { loadConfigSnapshot, type ConfigSnapshot } from "./config/loader.js";
import { Engine } from "./engine/engine.js";
import { env } from "./env.js";
import { logbook } from "./logbook.js";
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

  logbook.record(
    "status",
    `listening on ${env.host}:${env.port} -- navdata AIRAC ${initial.navdata.cycle}, ` +
      `${initial.pools.capacity} issuable codes across ${initial.ranges.length} CAL ranges, ` +
      `${engine.size} assignments restored`,
  );

  // Read per poll rather than captured once, so a config reload that changes
  // tickIntervalSec takes effect on the next cycle instead of at the next
  // restart -- every other value in `timing` is already read live.
  const tickMs = (): number => (config?.raw.timing.tickIntervalSec ?? 15) * 1000;

  /**
   * Where in VATSIM's 15 s cycle we currently poll.
   *
   * `pipelineLagMs` is the shortest gap we have seen between a generation's own
   * timestamp and the moment its bytes became fetchable. That is VATSIM's own
   * processing and CDN propagation, not something polling can shorten, and it
   * moves with their load -- measured at 22 s one morning and 11 s the same
   * afternoon -- which is exactly why it is learned rather than configured.
   * Scheduling from it puts each fetch just after the next generation lands
   * rather than at an arbitrary point in the cycle.
   *
   * Until we have found that edge we creep earlier by PHASE_CREEP_MS each cycle.
   * A fixed interval can never find it: our period and VATSIM's are both 15.000
   * s, so every poll returns exactly one new generation whatever the phase, and
   * the offset the container booted with is held for the whole session. Probing
   * earlier eventually returns a generation we have already processed, and that
   * duplicate is the edge -- the one observation that locates the cycle.
   */
  let pipelineLagMs: number | null = null;
  let lastGeneratedAt = 0;
  /** Set by the first duplicate: from then on the phase is held, not hunted. */
  let locked = false;

  /** Creep per cycle while hunting the edge: ~15 cycles to cross a full period. */
  const PHASE_CREEP_MS = 1_000;
  /** Land this far after the expected arrival, absorbing VATSIM's own jitter. */
  const PHASE_MARGIN_MS = 250;
  /** Re-probe delay after a duplicate: the next generation is imminent. */
  const RELOCK_DELAY_MS = 3_000;
  /** Never hammer, whatever the arithmetic says. */
  const MIN_DELAY_MS = 1_000;

  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(() => void poll(), Math.max(delayMs, MIN_DELAY_MS));
  };

  const poll = async (): Promise<void> => {
    // A failed fetch says nothing about phase, so fall back to a plain period
    // rather than dropping the lock over a transient network error.
    let nextDelay = tickMs();
    try {
      const wasStale = lastFeedOk > 0 && Date.now() - lastFeedOk >= FEED_STALE_MS;
      // Stamped BEFORE the request. The feed is tens of megabytes, so transfer
      // and parse cost a couple of hundred milliseconds, and phase is about when
      // we ASK -- the only part we control. Measuring afterwards folds our own
      // download time into the estimate, which then re-adds it to the next
      // target and cancels almost the whole creep.
      const requestedAt = Date.now();
      const feed = await fetchDatafeed(env.vatsimDatafeedUrl);
      lastFeedOk = Date.now();
      if (wasStale) logbook.record("status", "datafeed recovered");

      if (feed.generatedAt === lastGeneratedAt) {
        // Polled ahead of the next generation. That is the edge we were hunting:
        // the smallest lag seen so far brackets VATSIM's true delivery delay to
        // within one creep step, so stop creeping and hold this phase.
        if (!locked) {
          locked = true;
          logbook.record(
            "status",
            `datafeed phase locked: generations reach us ~${Math.round((pipelineLagMs ?? 0) / 1000)}s ` +
              "after their own timestamp",
          );
        } else if (pipelineLagMs !== null) {
          // Locked and still early, so delivery has slipped. Without this the
          // estimate could only ever fall, and one unusually fast generation
          // would leave us polling early -- and duplicating -- for good.
          pipelineLagMs += PHASE_CREEP_MS;
        }
        // No engine.tick: reconciliation is idempotent, so re-running it on
        // identical input changes nothing and only adds a misleading tick line.
        schedule(RELOCK_DELAY_MS);
        return;
      }

      const previousGeneratedAt = lastGeneratedAt;
      lastGeneratedAt = feed.generatedAt;
      /** How old the generation was when we asked for it: what phase controls. */
      const askLag = requestedAt - feed.generatedAt;
      /** How old it is by the time we act on it: what actually matters to a controller. */
      const lag = Date.now() - feed.generatedAt;
      // A generation we caught sooner than any before it moves the floor down;
      // the estimate only ever improves.
      if (pipelineLagMs === null || askLag < pipelineLagMs) pipelineLagMs = askLag;

      // Aim at when the NEXT generation should become fetchable, as an ABSOLUTE
      // time derived from the feed -- not a delay measured from whenever this
      // tick happens to finish, which would let engine and Redis time leak into
      // the phase. While hunting, PHASE_CREEP_MS pulls each poll a little
      // earlier than the last, dragging the observed lag -- and so the estimate
      // -- down with it until a duplicate finds the edge. Once locked the creep
      // drops out and the poll simply sits PHASE_MARGIN_MS past each arrival.
      const creep = locked ? 0 : PHASE_CREEP_MS;
      const nextAt = feed.generatedAt + tickMs() + pipelineLagMs + PHASE_MARGIN_MS - creep;

      const stats = engine.tick(feed);
      app.log.info(
        {
          inScope: stats.inScope,
          assigned: stats.assigned,
          adopted: stats.adopted,
          released: stats.released,
          dupes: stats.dupes,
          feedAgeMs: lag,
          askLagMs: askLag,
          lagFloorMs: pipelineLagMs,
          genIntervalMs: previousGeneratedAt ? feed.generatedAt - previousGeneratedAt : null,
          nextInMs: nextAt - Date.now(),
          phase: locked ? "locked" : "hunting",
          ms: stats.durationMs,
        },
        engine.isReady ? "tick" : "tick (warming up)",
      );
      if (stats.exhausted > 0) {
        app.log.error(`${stats.exhausted} flights got no code: every pool is full`);
      }
      await store.save(engine.all());

      nextDelay = nextAt - Date.now();
    } catch (err) {
      app.log.error({ err }, "tick failed");
      logbook.record("status", `tick FAILED: ${(err as Error).message}`);
    }
    schedule(nextDelay);
  };

  void poll();

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`${signal} received, shutting down`);
    logbook.record("status", `${signal} received, shutting down`);
    stopped = true;
    if (timer) clearTimeout(timer);
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
