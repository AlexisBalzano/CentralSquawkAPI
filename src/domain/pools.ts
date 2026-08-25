/**
 * The French ORCAM pool, as allocated by the EUROCONTROL CAL.
 *
 * The CAL allocates nationally to LF rather than per FIR, so this is one pool
 * rather than five. It also allocates BY DESTINATION: 0401-0477 may only be
 * issued to flights landing in France, 7440-7477 only to flights bound for the
 * UK, Ireland or North America, and only some ranges carry "ALL". Allocation
 * therefore has to know where the flight is going.
 *
 * Reservations are rebuilt from scratch every tick. That is what makes the
 * reserve-before-allocate ordering enforceable: the registry cannot hand out a
 * code that this tick has already seen in use, whether we issued it or an
 * aircraft simply arrived squawking it.
 */

import type { Squawk } from "./types.js";
import type { CodeRange } from "../config/schema.js";

export interface Allocation {
  code: Squawk;
  /** The CAL range the code came from, e.g. "0401-0477". */
  range: string;
  /** True when it came from an any-destination range. */
  wildcard: boolean;
}

interface LoadedRange {
  label: string;
  destinations: string[];
  wildcard: boolean;
  codes: Squawk[];
  cursor: number;
}

function expand(first: Squawk, last: Squawk): Squawk[] {
  const from = parseInt(first, 8);
  const to = parseInt(last, 8);
  const codes: Squawk[] = [];
  for (let n = from; n <= to; n++) {
    // Four base-8 digits, so every value in the range is a valid code.
    codes.push(n.toString(8).padStart(4, "0"));
  }
  return codes;
}

export class PoolRegistry {
  private readonly ranges: LoadedRange[] = [];
  /** Code to the range that publishes it. */
  private readonly owner = new Map<Squawk, LoadedRange>();
  /** Code to the callsign currently holding it, rebuilt each tick. */
  private readonly reserved = new Map<Squawk, string>();

  /**
   * @param excluded codes that must never be issued even though a CAL range
   *   covers them. The caller folds in the reserved and conspicuity codes, so
   *   the pool can never hand out 1000, 7000 or 7700 by accident.
   */
  constructor(ranges: readonly CodeRange[], excluded: ReadonlySet<Squawk>) {
    for (const range of ranges) {
      const label = `${range.from}-${range.to}`;
      const loaded: LoadedRange = {
        label,
        destinations: range.destinations,
        wildcard: range.destinations.includes("*"),
        codes: [],
        cursor: 0,
      };
      for (const code of expand(range.from, range.to)) {
        // A code covered by two ranges belongs to the first that claims it;
        // the CAL does contain such overlaps.
        if (excluded.has(code) || this.owner.has(code)) continue;
        this.owner.set(code, loaded);
        loaded.codes.push(code);
      }
      if (loaded.codes.length > 0) this.ranges.push(loaded);
    }
  }

  get capacity(): number {
    let total = 0;
    for (const range of this.ranges) total += range.codes.length;
    return total;
  }

  get inUse(): number {
    return this.reserved.size;
  }

  /** Drop every reservation. Called at the start of each tick's reserve phase. */
  beginTick(): void {
    this.reserved.clear();
  }

  /**
   * Mark a code as in use. Returns false when someone else already holds it,
   * which is how a collision is detected rather than silently overwritten.
   */
  reserve(code: Squawk, callsign: string): boolean {
    const holder = this.reserved.get(code);
    if (holder !== undefined && holder !== callsign) return false;
    this.reserved.set(code, callsign);
    return true;
  }

  release(code: Squawk): void {
    this.reserved.delete(code);
  }

  holderOf(code: Squawk): string | undefined {
    return this.reserved.get(code);
  }

  isReserved(code: Squawk): boolean {
    return this.reserved.has(code);
  }

  /** Which CAL range publishes this code, if any. Adopted foreign codes: none. */
  rangeOf(code: Squawk): string | undefined {
    return this.owner.get(code)?.label;
  }

  /**
   * How well a range serves a destination: the length of the matching ICAO
   * prefix, 0 for an any-destination range, or -1 for no match.
   */
  private static score(range: LoadedRange, destination: string | null): number {
    let best = range.wildcard ? 0 : -1;
    if (destination) {
      for (const prefix of range.destinations) {
        if (prefix !== "*" && destination.startsWith(prefix) && prefix.length > best) {
          best = prefix.length;
        }
      }
    }
    return best;
  }

  /**
   * Take a free code for a flight bound to `destination`.
   *
   * The most specific matching range wins, so any-destination ranges are held
   * back for traffic that has no specific allocation. A flight with no known
   * destination can only draw from an any-destination range.
   *
   * Returns null when nothing is available, which means the pool is exhausted
   * for that destination rather than exhausted outright.
   */
  allocate(destination: string | null, callsign: string): Allocation | null {
    const dest = destination ? destination.toUpperCase() : null;

    const candidates = this.ranges
      .map((range) => ({ range, score: PoolRegistry.score(range, dest) }))
      .filter((c) => c.score >= 0)
      .sort((a, b) => b.score - a.score);

    for (const { range } of candidates) {
      const code = this.takeFrom(range, callsign);
      if (code) return { code, range: range.label, wildcard: range.wildcard };
    }
    return null;
  }

  private takeFrom(range: LoadedRange, callsign: string): Squawk | null {
    // Round-robin within the range so a released code is not immediately
    // reissued to the next aircraft that asks.
    for (let i = 0; i < range.codes.length; i++) {
      const index = (range.cursor + i) % range.codes.length;
      const code = range.codes[index]!;
      if (this.reserved.has(code)) continue;
      this.reserved.set(code, callsign);
      range.cursor = (index + 1) % range.codes.length;
      return code;
    }
    return null;
  }

  /** Capacity summary for the health endpoint. */
  utilisation(): {
    capacity: number;
    inUse: number;
    ranges: number;
    anyDestination: { capacity: number; free: number };
  } {
    let wildcardCapacity = 0;
    let wildcardFree = 0;
    for (const range of this.ranges) {
      if (!range.wildcard) continue;
      wildcardCapacity += range.codes.length;
      for (const code of range.codes) if (!this.reserved.has(code)) wildcardFree++;
    }
    return {
      capacity: this.capacity,
      inUse: this.reserved.size,
      ranges: this.ranges.length,
      anyDestination: { capacity: wildcardCapacity, free: wildcardFree },
    };
  }
}
