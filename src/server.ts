/** Fastify instance and route registration. */

import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";

import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

import { verifyGithubSignature, verifyToken } from "./auth.js";
import type { ConfigSnapshot } from "./config/loader.js";
import type { Engine } from "./engine/engine.js";
import { env } from "./env.js";
import { by, logbook } from "./logbook.js";
import type { PersistenceStore } from "./store/redis.js";

const run = promisify(execFile);

export interface Services {
  engine: Engine;
  store: PersistenceStore;
  /** Current snapshot, or null before the first successful load. */
  config: () => ConfigSnapshot | null;
  /** Re-read the config directory and swap the snapshot in if it validates. */
  reload: () => Promise<void>;
  /** Whether the datafeed poller has succeeded recently. */
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
}

const REJECTION_STATUS: Record<string, number> = {
  unknown_callsign: 404,
  malformed_code: 400,
  excluded_code: 409,
  not_authorised: 403,
  pool_exhausted: 503,
};

function registerManual(app: FastifyInstance, services: Services): void {
  app.post<{ Body: ManualBody }>("/api/assign", async (req, reply) => {
    const { callsign, controller, token, code, mode } = req.body ?? {};
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
