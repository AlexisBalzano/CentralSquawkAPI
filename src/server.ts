/** Fastify instance and route registration. */

import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";

import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

import { verifyGithubSignature, verifyToken } from "./auth.js";
import type { ConfigSnapshot } from "./config/loader.js";
import type { Engine, TickStats } from "./engine/engine.js";
import { env } from "./env.js";
import { by, logbook } from "./logbook.js";
import { parsePushedFeed, parseSeed } from "./domain/observation.js";
import { Pictures } from "./domain/pictures.js";
import type { PersistenceStore } from "./store/redis.js";
import type { FeedResult } from "./vatsim/datafeed.js";

const run = promisify(execFile);

export interface Services {
  engine: Engine;
  store: PersistenceStore;
  /** Run one reconciliation pass over a picture and persist the result. */
  ingest: (feed: FeedResult) => Promise<TickStats>;
  /** Current snapshot, or null before the first successful load. */
  config: () => ConfigSnapshot | null;
  /** Re-read the config directory and swap the snapshot in if it validates. */
  reload: () => Promise<void>;
  /** Whether a picture has arrived recently, by poll or by push. */
  feedHealthy: () => boolean;
}

/** The raw body, kept so the webhook can verify its HMAC. */
type RawRequest = FastifyRequest & { rawBody?: Buffer };

/**
 * Human-readable logs when pino-pretty is available, JSON when it is not.
 *
 * pino-pretty is a dev dependency, so it is absent from the production image
 * where `npm ci --omit=dev` runs. Asking for it unconditionally in development
 * mode means a container started with NODE_ENV=development refuses to boot over
 * log formatting, which is not a good enough reason to fail to start.
 */
function prettyTransport(): { target: string; options: object } | undefined {
  if (env.nodeEnv !== "development") return undefined;
  try {
    createRequire(import.meta.url).resolve("pino-pretty");
    return { target: "pino-pretty", options: { translateTime: "HH:MM:ss" } };
  } catch {
    return undefined;
  }
}

export function buildServer(services: Services): FastifyInstance {
  const transport = prettyTransport();
  const app = Fastify({
    logger: {
      level: env.logLevel,
      ...(transport ? { transport } : {}),
    },
    trustProxy: true,
  });

  // Keep the raw buffer alongside the parsed body. The config webhook signs the
  // exact bytes GitHub sent, so a re-serialised body would never match.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (req, body, done) => {
      (req as RawRequest).rawBody = body as Buffer;
      try {
        done(null, JSON.parse((body as Buffer).toString("utf8")) as unknown);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  registerHealth(app, services);
  registerLogs(app, services);
  registerSnapshot(app, services);
  registerManual(app, services);
  registerNetwork(app, services);
  registerFeed(app, services);
  registerWebhook(app, services);

  return app;
}

// ------------------------------------------------------------------ health

function registerHealth(app: FastifyInstance, services: Services): void {
  app.get("/health", async (_req, reply) => {
    const { engine, store } = services;
    const config = services.config();
    const feedHealthy = services.feedHealthy();

    // Redis is a persistence sink, not a dependency of assignment, so losing it
    // is degraded rather than unhealthy. Losing config or the feed is not.
    const status = !config || !feedHealthy
      ? "unhealthy"
      : !engine.isReady || !store.isConnected
        ? "degraded"
        : "healthy";

    return reply.code(status === "unhealthy" ? 503 : 200).send({
      status,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      checks: {
        config: config ? "loaded" : "missing",
        datafeed: feedHealthy ? "ok" : "stale",
        redis: store.isConnected ? "connected" : "disconnected",
        engine: engine.isReady ? "ready" : "warming",
      },
      navdata: config
        ? { cycle: config.navdata.cycle, fixes: config.navdata.fixes.size, airways: config.navdata.airways.size }
        : null,
      assignments: engine.size,
      // How many controllers the network shows logged on; null on a push instance.
      controllersOnline: engine.rosterSize,
      // Client seeds still waiting for the datafeed to confirm them.
      seeds: engine.seedCount,
      pools: config?.pools.utilisation() ?? null,
      routeCache: engine.routeCacheStats,
      lastTick: engine.stats,
    });
  });
}

// -------------------------------------------------------------------- logs

interface LogsQuery {
  /** Keep only the most recent N matching lines. */
  lines?: string;
  /** Case-insensitive substring: a callsign, an airport, a category. */
  q?: string;
}

/** Without a limit the whole buffer is served, which is a few hundred kB. */
const DEFAULT_LOG_LINES = 500;

function registerLogs(app: FastifyInstance, services: Services): void {
  app.get<{ Querystring: LogsQuery }>("/logs", async (req, reply) => {
    const parsed = Number.parseInt(req.query.lines ?? "", 10);
    const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, logbook.size) : DEFAULT_LOG_LINES;

    const config = services.config();
    // A header, so a line pulled out of context still says which process and
    // which navdata produced it.
    const header = [
      `# Central Squawk -- ${new Date().toISOString()}`,
      `# uptime ${Math.round(process.uptime())}s` +
        `  engine ${services.engine.isReady ? "ready" : "warming"}` +
        `  datafeed ${services.feedHealthy() ? "ok" : "STALE"}` +
        `  redis ${services.store.isConnected ? "connected" : "disconnected"}` +
        `  navdata ${config?.navdata.cycle ?? "none"}` +
        `  assignments ${services.engine.size}`,
      `# ${logbook.size} lines held` +
        `${req.query.q ? `, filtered on "${req.query.q}"` : ""}` +
        `, showing at most ${limit}`,
      "#",
      "# /logs?q=AFR1234        one flight",
      "# /logs?q=denied+1000    every refusal of Mode S conspicuity",
      "# /logs?lines=2000       further back",
      "",
    ].join("\n");

    reply.header("content-type", "text/plain; charset=utf-8");
    // Diagnostics go stale in one tick; never let a proxy hold on to them.
    reply.header("cache-control", "no-store");
    return reply.send(header + logbook.render({ limit, ...(req.query.q ? { q: req.query.q } : {}) }));
  });
}

// ---------------------------------------------------------------- snapshot

function registerSnapshot(app: FastifyInstance, services: Services): void {
  app.get("/api/squawks", async (req, reply) => {
    // 503 until the first full sweep completes. DUPE state computed from an
    // incomplete map is misleading, and 503 keeps the payload contract exactly
    // `{callsign: {ssr, dupe}}` -- clients simply retain their last snapshot.
    if (!services.engine.isReady) {
      return reply.code(503).send({ error: "warming up" });
    }

    reply.header("content-type", "application/json; charset=utf-8");
    reply.header("vary", "accept-encoding");

    // Both bodies were produced by the tick, so serving either is a buffer
    // write. Compression happens once per tick, not once per request.
    const accepts = String(req.headers["accept-encoding"] ?? "");
    if (/\bgzip\b/.test(accepts)) {
      return reply
        .header("content-encoding", "gzip")
        .send(services.engine.snapshotGzip);
    }
    return reply.send(services.engine.snapshotJson);
  });
}

// ------------------------------------------------------------------ manual

interface ManualBody {
  callsign?: string;
  controller?: string;
  token?: string;
  /** Present means "set exactly this code"; it wins over `mode`. */
  code?: string;
  /**
   * "auto" re-runs the server's whole decision, Mode S included, so a flight
   * that still qualifies gets 1000 back. "discrete" forces a pool code and
   * bypasses Mode S, which is the only way off conspicuity without typing a
   * code by hand. Defaults to "auto".
   */
  mode?: "auto" | "discrete";
  /**
   * The datafeed-shaped view of this flight, for a callsign the feed has not
   * reached yet. EuroScope received the same flight plan over the same FSD
   * connection the feed is built from, so the client can supply it a cycle
   * early. Ignored outright when the feed already carries the callsign.
   */
  flight?: unknown;
}

const REJECTION_STATUS: Record<string, number> = {
  unknown_callsign: 404,
  malformed_code: 400,
  excluded_code: 409,
  not_authorised: 403,
  pool_exhausted: 503,
  seed_malformed: 400,
  seed_out_of_scope: 422,
  seed_limit: 429,
  not_on_network: 403,
};

function registerManual(app: FastifyInstance, services: Services): void {
  app.post<{ Body: ManualBody }>("/api/assign", async (req, reply) => {
    const { callsign, controller, token, code, mode, flight } = req.body ?? {};
    if (!callsign || !controller) {
      return reply.code(400).send({ error: "callsign and controller are required" });
    }
    if (!verifyToken(env.authSecret, controller, token)) {
      logbook.record("manual", `${by(controller.toUpperCase())}  ${callsign.toUpperCase()}  -> REFUSED  bad token`);
      return reply.code(403).send({ error: "not_authorised" });
    }
    if (!services.engine.isReady) {
      return reply.code(503).send({ error: "warming up" });
    }

    const target = callsign.toUpperCase();
    const actor = controller.toUpperCase();

    // THE isolation boundary, and the only one that actually holds.
    //
    // EuroScope reports a student connected to a sweatbox through an ordinary
    // connection as DIRECT, exactly as it reports VATSIM, so a plugin cannot
    // know which world it is in and a controller who forgets to say so would
    // otherwise write simulator traffic straight into the live pool -- seeding
    // flights that do not exist and holding real ORCAM codes for them.
    //
    // The datafeed settles it: a callsign absent from the roster is not on this
    // network, whatever its plugin believes. Refusing costs a genuine
    // controller nothing but a retry in the ~20 s before their logon reaches
    // the feed, and it is the difference between a forgotten command being an
    // inconvenience and being a live incident.
    if (env.feedSource === "vatsim") {
      const online = services.engine.isControllerOnline(actor);
      if (online === false) {
        logbook.record("manual", `${by(actor)}  ${target}  -> REFUSED  not logged on to this network`);
        return reply.code(REJECTION_STATUS.not_on_network!).send({ error: "not_on_network" });
      }
    }

    // Seed before the operation, so the operation below finds the flight. A
    // rejected seed fails the whole request rather than falling through to
    // unknown_callsign, which would report the wrong reason for the refusal.
    if (flight !== undefined && flight !== null) {
      const seeded = parseSeed(target, flight);
      const rejection = seeded
        ? services.engine.seed(seeded, actor)
        : ("seed_malformed" as const);
      if (rejection) {
        logbook.record("manual", `${by(actor)}  ${target}  -> REJECTED  ${rejection}`);
        return reply.code(REJECTION_STATUS[rejection] ?? 400).send({ error: rejection });
      }
    }

    const result = code
      ? services.engine.setCode(target, code, actor)
      : mode === "discrete"
        ? services.engine.forceDiscrete(target, actor)
        : services.engine.forceReassign(target, actor);

    if (typeof result === "string") {
      // The engine logs the rejections it can explain; these are the ones it
      // never saw, because they failed before it was reached.
      if (result === "unknown_callsign" || result === "malformed_code" || result === "excluded_code") {
        logbook.record("manual", `${by(actor)}  ${target}  -> REJECTED  ${result}`);
      }
      return reply.code(REJECTION_STATUS[result] ?? 400).send({ error: result });
    }
    req.log.info(
      { callsign, controller, mode: code ? "set" : (mode ?? "auto"), code: result.ssr },
      "manual assignment",
    );
    return reply.send(result);
  });
}

// ----------------------------------------------------------------- network

interface NetworkQuery {
  controller?: string;
}

/**
 * `GET /api/network?controller=LFPG_TWR` -- "is this callsign on my network?"
 *
 * The same question the assign route answers by refusing, asked ahead of time
 * so a plugin can point itself at the right server before a controller needs a
 * code rather than after they have been turned away. No authentication: who is
 * logged on is published in the datafeed itself.
 *
 * `onNetwork: null` means this instance cannot judge, which is the honest
 * answer from a push-mode server -- it has no roster and refuses nobody.
 */
function registerNetwork(app: FastifyInstance, services: Services): void {
  app.get<{ Querystring: NetworkQuery }>("/api/network", async (req, reply) => {
    const controller = req.query.controller?.trim().toUpperCase();
    if (!controller) {
      return reply.code(400).send({ error: "controller is required" });
    }

    const online = env.feedSource === "vatsim"
      ? services.engine.isControllerOnline(controller)
      : null;

    reply.header("cache-control", "no-store");
    return reply.send({
      controller,
      onNetwork: online,
      /** Whether this instance refuses callsigns it cannot see. */
      enforced: env.feedSource === "vatsim" && services.engine.rosterSize !== null,
      controllersOnline: services.engine.rosterSize,
    });
  });
}

// -------------------------------------------------------------- pushed feed

interface FeedBody {
  controller?: string;
  token?: string;
  observations?: unknown;
}

/**
 * `POST /api/feed` -- one client's picture of a world the VATSIM datafeed does
 * not describe. Registered ONLY when FEED_SOURCE=push, so a production instance
 * has no such route to send anything to.
 *
 * Every client in the session pushes, and every push counts. No one EuroScope
 * sees the whole sweatbox -- each only receives traffic inside its own
 * visibility range -- so taking any single client's picture as the world would
 * leave everything outside that range uncoded. Each push replaces its client's
 * own picture, and the engine ticks against the union of every picture still
 * live; `Pictures` holds the rules that keep that union honest.
 */
function registerFeed(app: FastifyInstance, services: Services): void {
  if (env.feedSource !== "push") return;

  const pictures = new Pictures(env.feederLeaseSec * 1000);

  app.post<{ Body: FeedBody }>("/api/feed", async (req, reply) => {
    const { controller, token, observations } = req.body ?? {};
    if (!controller) {
      return reply.code(400).send({ error: "controller is required" });
    }
    if (!verifyToken(env.authSecret, controller, token)) {
      return reply.code(403).send({ error: "not_authorised" });
    }

    const actor = controller.toUpperCase();
    const picture = parsePushedFeed({ observations });
    if (!picture) {
      return reply.code(400).send({ error: "malformed_feed" });
    }

    const merged = pictures.submit(actor, picture);
    for (const client of merged.lapsed) {
      req.log.info({ controller: client }, "feeder lapsed");
      logbook.record(
        "status",
        `${by(client)}  stopped feeding: no push for ${env.feederLeaseSec}s, picture dropped`,
      );
    }
    if (merged.joined) {
      req.log.info({ controller: actor, feeders: merged.feeders }, "feeder joined");
      logbook.record(
        "status",
        `${by(actor)}  now feeding the simulator picture (${merged.feeders} feeding)`,
      );
    }

    const stats = await services.ingest(merged.feed);
    req.log.info(
      {
        controller: actor,
        observed: picture.observations.length,
        skipped: picture.skipped,
        world: merged.feed.observations.length,
        feeders: merged.feeders,
        inScope: stats.inScope,
        assigned: stats.assigned,
        released: stats.released,
        dupes: stats.dupes,
        ms: stats.durationMs,
      },
      "pushed feed",
    );

    // The feeder is usually a controller too, so hand back enough that it can
    // tell a rejected push from an accepted one that simply saw nothing.
    // `inScope` is the whole merged world's, not this picture's.
    return reply.send({
      accepted: picture.observations.length,
      skipped: picture.skipped,
      inScope: stats.inScope,
      feeders: merged.feeders,
      leaseSeconds: env.feederLeaseSec,
    });
  });
}

// ----------------------------------------------------------------- webhook

function registerWebhook(app: FastifyInstance, services: Services): void {
  app.post("/api/config-webhook", async (req, reply) => {
    const raw = (req as RawRequest).rawBody ?? Buffer.alloc(0);
    const signature = req.headers["x-hub-signature-256"];
    if (!verifyGithubSignature(env.githubSecret, raw, typeof signature === "string" ? signature : undefined)) {
      req.log.error("invalid webhook signature");
      return reply.code(403).send({ error: "invalid signature" });
    }

    try {
      await run("git", ["pull", "origin", env.configBranch], { cwd: env.configDir });
    } catch (err) {
      req.log.error({ err }, "config pull failed");
      logbook.record("config", `pull failed: ${(err as Error).message}`);
      return reply.code(500).send({ error: "pull failed" });
    }

    try {
      await services.reload();
    } catch (err) {
      // The running snapshot is untouched: a bad config cannot stop assignment.
      req.log.error({ err }, "config rejected, keeping the running snapshot");
      logbook.record("config", `REJECTED, keeping the running snapshot: ${(err as Error).message}`);
      return reply.code(422).send({
        error: "config rejected",
        detail: (err as Error).message,
      });
    }

    const config = services.config();
    req.log.info("config reloaded");
    logbook.record("config", `reloaded, navdata AIRAC ${config?.navdata.cycle ?? "unknown"}`);
    return reply.send({
      status: "reloaded",
      cycle: config?.navdata.cycle ?? null,
      timestamp: new Date().toISOString(),
    });
  });
}
