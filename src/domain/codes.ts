/**
 * Code classification.
 *
 * Only DISCRETE codes are exclusive. Every other class is shared by design:
 * several aircraft may legitimately squawk 7000, 1000 or 7700 at once, so those
 * codes are never reserved against a pool and never raise a DUPE. Getting this
 * wrong would flag a large share of the traffic on any busy evening.
 */

import type { CodeClass, Squawk } from "./types.js";
import type { CodesConfig } from "../config/schema.js";

const SQUAWK_PATTERN = /^[0-7]{4}$/;

export function isWellFormed(code: string): code is Squawk {
  return SQUAWK_PATTERN.test(code);
}

export class CodeBook {
  private readonly defaults: ReadonlySet<Squawk>;
  private readonly emergency: ReadonlySet<Squawk>;
  private readonly manuallyAssignable: ReadonlySet<Squawk>;
  private readonly excluded: ReadonlySet<Squawk>;
  readonly conspicuity: Squawk;

  constructor(codes: CodesConfig, exclusions: readonly Squawk[]) {
    this.defaults = new Set(codes.default);
    this.emergency = new Set(codes.emergency);
    this.manuallyAssignable = new Set(codes.manuallyAssignable);
    this.conspicuity = codes.conspicuity;
    this.excluded = new Set(exclusions);
  }

  /**
   * Every code the pool must never issue, even where a CAL range covers it.
   *
   * The CAL is an allocation table, not a policy statement: a range can span a
   * conspicuity or emergency code, and nothing in the file stops it. Folding
   * these into the pool's exclusions is what guarantees 1000, 7000 or 7700 can
   * never be handed out as if it were a discrete code.
   */
  nonIssuable(): Set<Squawk> {
    return new Set<Squawk>([
      ...this.defaults,
      ...this.emergency,
      ...this.excluded,
      this.conspicuity,
    ]);
  }

  classify(code: string): CodeClass {
    if (code === this.conspicuity) return "conspicuity";
    if (this.emergency.has(code)) return "emergency";
    if (this.defaults.has(code)) return "default";
    if (this.excluded.has(code)) return "excluded";
    return "discrete";
  }

  /**
   * True when the code means "this aircraft has no meaningful assignment yet"
   * and so qualifies for automatic assignment once airborne. 1000 counts:
   * conspicuity is only valid if the route stays inside the Mode S area, so an
   * inbound already squawking it is re-evaluated rather than taken at face
   * value.
   */
  isDefault(code: string): boolean {
    return this.defaults.has(code) || code === this.conspicuity;
  }

  /** Exclusive codes are the only ones reserved in a pool or raising a DUPE. */
  isExclusive(code: string): boolean {
    return this.classify(code) === "discrete";
  }

  /** Never modified or reassigned by any automatic rule. */
  isEmergency(code: string): boolean {
    return this.emergency.has(code);
  }

  /**
   * Whether a controller may set this code by hand. Typed codes are accepted
   * regardless of range and flagged manual, but the exclusion list is an
   * absolute floor -- with the deliberate exception of the emergency codes
   * listed in `manuallyAssignable`, so a radio failure or an emergency can be
   * marked.
   */
  isManuallyAssignable(code: string): boolean {
    if (!isWellFormed(code)) return false;
    if (this.manuallyAssignable.has(code)) return true;
    if (this.emergency.has(code)) return false;
    return !this.excluded.has(code);
  }
}
