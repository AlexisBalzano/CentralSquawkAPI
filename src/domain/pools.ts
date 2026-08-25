/**
 * Per-FIR ORCAM pools.
 *
 * Reservations are rebuilt from scratch every tick. That is what makes the
 * reserve-before-allocate ordering enforceable: the registry cannot hand out a
 * code that this tick has already seen in use, whether we issued it or an
 * aircraft simply arrived squawking it.
 */

import type { Squawk } from "./types.js";
import type { PoolsConfig } from "../config/schema.js";

export interface Allocation {
  code: Squawk;
  /** FIR whose range the code came from. Differs from the requested FIR when borrowed. */
  issuedBy: string;
  borrowed: boolean;
}

function expandRange(first: Squawk, last: Squawk): Squawk[] {
  const from = parseInt(first, 8);
  const to = parseInt(last, 8);
  const codes: Squawk[] = [];
  for (let n = from; n <= to; n++) {
    // Octal digits only: a code is four base-8 digits, so every value in the
    // numeric range is a valid code by construction.
    codes.push(n.toString(8).padStart(4, "0"));
  }
  return codes;
}

export class PoolRegistry {
  /** FIR to the codes its ranges publish, in issue order. */
  private readonly byFir = new Map<string, Squawk[]>();
  /** Code to the FIR that publishes it. */
  private readonly owner = new Map<Squawk, string>();
  /** Code to the callsign currently holding it, rebuilt each tick. */
  private readonly reserved = new Map<Squawk, string>();
  /** Round-robin cursor per FIR, so codes are not reissued immediately. */
  private readonly cursor = new Map<string, number>();

  constructor(pools: PoolsConfig) {
    for (const [fir, pool] of Object.entries(pools)) {
      const excluded = new Set(pool.exclusions);
      const codes: Squawk[] = [];
      for (const [first, last] of pool.ranges) {
        for (const code of expandRange(first, last)) {
          if (excluded.has(code) || this.owner.has(code)) continue;
          this.owner.set(code, fir);
          codes.push(code);
        }
      }
      this.byFir.set(fir, codes);
      this.cursor.set(fir, 0);
    }
  }

  /** Total codes published across all pools. */
  get capacity(): number {
    let total = 0;
    for (const codes of this.byFir.values()) total += codes.length;
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

  /** Which FIR publishes this code, if any. Adopted foreign codes return undefined. */
  ownerOf(code: Squawk): string | undefined {
    return this.owner.get(code);
  }

  /**
   * Take a free code for a flight, preferring the given FIR's own range and
   * borrowing from another pool when it is exhausted. Returns null only when
   * every pool is full, which means the configuration is wrong.
   */
  allocate(fir: string, callsign: string): Allocation | null {
    const own = this.takeFrom(fir, callsign);
    if (own) return { code: own, issuedBy: fir, borrowed: false };

    for (const other of this.byFir.keys()) {
      if (other === fir) continue;
      const borrowed = this.takeFrom(other, callsign);
      if (borrowed) return { code: borrowed, issuedBy: other, borrowed: true };
    }
    return null;
  }

  private takeFrom(fir: string, callsign: string): Squawk | null {
    const codes = this.byFir.get(fir);
    if (!codes || codes.length === 0) return null;
    const start = this.cursor.get(fir) ?? 0;
    for (let i = 0; i < codes.length; i++) {
      const index = (start + i) % codes.length;
      const code = codes[index]!;
      if (this.reserved.has(code)) continue;
      this.reserved.set(code, callsign);
      this.cursor.set(fir, (index + 1) % codes.length);
      return code;
    }
    return null;
  }

  /** Free capacity per FIR, for the health endpoint. */
  utilisation(): Record<string, { capacity: number; free: number }> {
    const out: Record<string, { capacity: number; free: number }> = {};
    for (const [fir, codes] of this.byFir) {
      let free = 0;
      for (const code of codes) if (!this.reserved.has(code)) free++;
      out[fir] = { capacity: codes.length, free };
    }
    return out;
  }
}
