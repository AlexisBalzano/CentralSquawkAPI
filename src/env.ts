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

export const env = {
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
   */
  warmupCycles: int("WARMUP_CYCLES", 2),
} as const;
