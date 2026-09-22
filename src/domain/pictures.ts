/**
 * The simulator world, assembled from what every connected client can see.
 *
 * A sweatbox has no datafeed, so its clients describe it -- and none of them
 * can describe all of it. EuroScope only receives traffic inside a client's
 * visibility range, so the instructor running the scenario and a TWR student
 * see different subsets of one world. Taking any single client's picture as
 * the whole world would leave every aircraft outside its range without a code,
 * and would treat a flight that merely left that range as one that had
 * disconnected.
 *
 * So every client's latest picture is kept, and the world is their union. That
 * is sound because the clients share one FSD server, which refuses a second
 * connection under a callsign already in use: the same callsign in two
 * pictures is one aircraft, seen twice.
 *
 * Three rules keep the union honest:
 *
 *  - A push REPLACES its client's previous picture; it never adds to it. An
 *    aircraft that has left every range has to be able to leave the world.
 *  - The most recent push that carries a callsign describes it. Clients see one
 *    aircraft a few seconds apart, and the later view is the better one.
 *  - A picture lapses once its client has gone quiet for the TTL, so a
 *    EuroScope that crashed does not hold its aircraft in the world forever.
 *
 * An aircraft is therefore absent only when no live picture has it, which is
 * exactly when the engine's grace period should start.
 */

import type { FeedResult } from "../vatsim/datafeed.js";
import type { Observation } from "./types.js";

interface Picture {
  /** Server time of the push that delivered it. */
  at: number;
  observations: Observation[];
}

export interface Merged {
  /** The world as every live picture describes it, ready to tick. */
  feed: FeedResult;
  /** Clients whose picture is part of it, the one that just pushed included. */
  feeders: number;
  /** Whether this push brought its client in, rather than renewing it. */
  joined: boolean;
  /** Clients whose picture had lapsed for want of a push, dropped by this one. */
  lapsed: string[];
}

export class Pictures {
  /** Kept in push order, oldest first: the merge depends on it. */
  private readonly held = new Map<string, Picture>();

  constructor(private readonly ttlMs: number) {}

  /**
   * Take one client's whole view and return the world as every live picture
   * now describes it.
   *
   * The picture's `generatedAt` is the clock. It is stamped server-side on
   * receipt, so lapse is judged on the same clock as every age the tick
   * computes, never on a client's.
   */
  submit(client: string, picture: FeedResult): Merged {
    const now = picture.generatedAt;

    // Before anything else, so a client returning after a lapse reads as
    // having left and come back rather than as having never been away.
    const lapsed: string[] = [];
    for (const [held, previous] of this.held) {
      if (now - previous.at > this.ttlMs) {
        this.held.delete(held);
        lapsed.push(held);
      }
    }

    const joined = !this.held.has(client);
    // Deleted first so the entry moves to the end: setting an existing key
    // would leave it where the client first joined, out of push order.
    this.held.delete(client);
    this.held.set(client, { at: now, observations: picture.observations });

    // Oldest push first, so a later push overwrites an earlier one's view of
    // the same callsign: the most recent push that carries it describes it.
    const world = new Map<string, Observation>();
    for (const { observations } of this.held.values()) {
      for (const obs of observations) world.set(obs.callsign, obs);
    }

    return {
      // No `controllers`: a pushed world has no roster, and absent is what
      // tells the engine it cannot judge who is logged on.
      feed: { generatedAt: now, observations: [...world.values()], skipped: picture.skipped },
      feeders: this.held.size,
      joined,
      lapsed,
    };
  }
}
