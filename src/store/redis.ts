/**
 * Redis as a persistence sink.
 *
 * The assignment map is authoritative in process; Redis exists so a restart
 * resumes exactly rather than losing every manual override. Redis being down is
 * therefore degraded, not fatal: the reconciliation sweep rebuilds a correct map
 * from the datafeed on its own, and the only thing actually lost is provenance.
 */

import { createClient, type RedisClientType } from "redis";

import type { Assignment } from "../domain/types.js";

const KEY = "centralsquawk:assignments";

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export class PersistenceStore {
  private client: RedisClientType | null = null;
  private connected = false;

  constructor(
    private readonly url: string,
    private readonly log: Logger,
  ) {}

  get isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    try {
      const client: RedisClientType = createClient({
        url: this.url,
        // Do not retry forever behind the scenes: a hard failure surfaces as
        // "degraded" in health rather than as a hang in the tick.
        socket: { reconnectStrategy: (retries) => (retries > 10 ? false : 250) },
      });
      client.on("error", (err: Error) => {
        if (this.connected) this.log.warn(`redis error, continuing without persistence: ${err.message}`);
        this.connected = false;
      });
      client.on("ready", () => {
        this.connected = true;
        this.log.info("redis connected");
      });
      await client.connect();
      this.client = client;
      this.connected = true;
    } catch (err) {
      this.log.warn(
        `redis unavailable, running without persistence: ${(err as Error).message}`,
      );
      this.connected = false;
    }
  }

  async save(assignments: Assignment[]): Promise<void> {
    if (!this.client || !this.connected) return;
    try {
      await this.client.set(KEY, JSON.stringify(assignments));
    } catch (err) {
      this.log.warn(`persist failed: ${(err as Error).message}`);
    }
  }

  async load(): Promise<Assignment[]> {
    if (!this.client || !this.connected) return [];
    try {
      const raw = await this.client.get(KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      // Persisted state is reconciled against the datafeed on the first tick,
      // so a partially stale entry is corrected rather than trusted.
      return parsed.filter(
        (a): a is Assignment =>
          typeof a === "object" && a !== null && typeof (a as Assignment).callsign === "string",
      );
    } catch (err) {
      this.log.warn(`restore failed, starting from an empty map: ${(err as Error).message}`);
      return [];
    }
  }

  async disconnect(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.quit();
    } catch {
      // Shutting down anyway.
    }
    this.connected = false;
  }
}
