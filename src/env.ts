/** Process environment. Everything operational lives here; everything about
 *  the airspace lives in the ingested config repository instead. */

function str(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function int(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Where observations come from.
 *
 *  - `vatsim` polls the datafeed. Production.
 *  - `push`   waits for a client to POST the picture. There is no datafeed
 *             behind a sweatbox, so a simulator session has to supply its own.
 *
 * This is deliberately an instance-wide mode rather than a per-request flag. A
 * simulator world must never share a pool with the live one: sim traffic would
 * consume real ORCAM codes and raise DUPEs against real aircraft. Making the
 * separation a deployment fact rather than a branch inside the engine means
 * `POST /api/feed` does not exist at all on the production instance, whatever
 * anybody sends it.
 */
const feedSource: "vatsim" | "push" =
  str("FEED_SOURCE", "vatsim").trim().toLowerCase() === "push" ? "push" : "vatsim";

export const env = {
  feedSource,
  nodeEnv: str("NODE_ENV", "development"),
  port: int("PORT", 3000),
  host: str("HOST", "0.0.0.0"),
  logLevel: str("LOG_LEVEL", "info"),

  /** Where the config repository is checked out inside the container. */
  configDir: str("CONFIG_DIR", "/app/data"),
  configRepoUrl: str("CONFIG_REPO_URL", ""),
  configBranch: str("CONFIG_BRANCH", "main"),
  /** HMAC secret for the GitHub config webhook. Unset disables verification. */
  githubSecret: str("GH_SECRET", ""),

  redisUrl: str("REDIS_URL", "redis://localhost:6379"),
  /** Shared secret behind SHA256(secret + controller callsign). */
  authSecret: str("AUTH_SECRET", ""),

  vatsimDatafeedUrl: str(
    "VATSIM_DATAFEED_URL",
    "https://data.vatsim.net/v3/vatsim-data.json",
  ),

  /**
   * Datafeed cycles to observe before the first allocation. The feed refreshes
   * about every 15 s, so two cycles means the first sweep runs against a
   * complete picture rather than a partial one.
   *
   * Zero by default in push mode: warm-up exists because the first datafeed
   * generation can arrive partial, and a pushed feed never is -- the client
   * sends the whole picture or nothing. Waiting would only open a simulator
   * session with half a minute of 503.
   */
  warmupCycles: int("WARMUP_CYCLES", feedSource === "push" ? 0 : 2),

  /**
   * How long a client-seeded flight survives without the datafeed confirming
   * it. Two feed generations is about 30 s, so this is generous several times
   * over; anything still unconfirmed by then is a wrong callsign, not lag.
   */
  seedTtlSec: int("SEED_TTL_SEC", 120),
  /**
   * Unconfirmed seeds one controller may hold at once. A seed is a client
   * writing into the authoritative map, so the blast radius of a buggy or
   * hostile plugin is capped rather than trusted.
   */
  seedMaxPerController: int("SEED_MAX_PER_CONTROLLER", 10),

  /**
   * Push mode only: how long a feeder keeps the lease without pushing again.
   *
   * Long enough to ride out a missed push at any sane interval, short enough
   * that an instructor whose EuroScope crashed is replaced within a few seconds
   * rather than leaving the session with no picture at all.
   */
  feederLeaseSec: int("FEEDER_LEASE_SEC", 45),
} as const;
