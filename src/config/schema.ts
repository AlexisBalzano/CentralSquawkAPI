/**
 * Shape of config.json in the CentralSquawk-config repository, and its
 * validator.
 *
 * Validation is deliberately strict and total: a config snapshot is either
 * fully valid and gets swapped in, or it is rejected in one piece and the
 * running snapshot is left alone. A bad push must never be able to half-apply.
 */

export interface AorConfig {
  /** FIR identifiers, matched against feature ids in modes_area.geojson. */
  firs: string[];
  /** Distance outside the AOR at which inbound traffic enters scope. */
  entryRingNm: number;
  /** Distance outside the AOR at which a code is released. */
  zonePaddingNm: number;
}

export interface CodesConfig {
  /** Codes meaning "no meaningful assignment"; trigger automatic assignment. */
  default: string[];
  /** The Mode S conspicuity code. */
  conspicuity: string;
  /** Never touched automatically. */
  emergency: string[];
  /** Emergency codes a controller is nonetheless allowed to set by hand. */
  manuallyAssignable: string[];
}

export interface TimingConfig {
  /** Absence from the datafeed before a code is released. */
  gracePeriodSec: number;
  /** At or above this groundspeed a flight counts as airborne. */
  groundSpeedThresholdKt: number;
  /** How often the reconciliation loop runs. */
  tickIntervalSec: number;
}

export interface PoolConfig {
  /** Inclusive [first, last] octal code ranges. */
  ranges: [string, string][];
  /** Codes inside those ranges that must never be issued. */
  exclusions: string[];
}

export type PoolsConfig = Record<string, PoolConfig>;

export interface RawConfig {
  version: number;
  aor: AorConfig;
  codes: CodesConfig;
  timing: TimingConfig;
  pools: PoolsConfig;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid config:\n  ${problems.join("\n  ")}`);
    this.name = "ConfigError";
  }
}

const SQUAWK = /^[0-7]{4}$/;

class Check {
  readonly problems: string[] = [];

  fail(message: string): void {
    this.problems.push(message);
  }

  object(value: unknown, at: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      this.fail(`${at}: expected an object`);
      return {};
    }
    return value as Record<string, unknown>;
  }

  number(value: unknown, at: string, min: number, max: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      this.fail(`${at}: expected a number`);
      return min;
    }
    if (value < min || value > max) {
      this.fail(`${at}: ${value} is outside ${min}..${max}`);
      return min;
    }
    return value;
  }

  squawkList(value: unknown, at: string): string[] {
    if (!Array.isArray(value)) {
      this.fail(`${at}: expected an array of codes`);
      return [];
    }
    const out: string[] = [];
    value.forEach((code, i) => {
      if (typeof code !== "string" || !SQUAWK.test(code)) {
        this.fail(`${at}[${i}]: ${JSON.stringify(code)} is not a four-digit octal code`);
      } else {
        out.push(code);
      }
    });
    return out;
  }

  stringList(value: unknown, at: string): string[] {
    if (!Array.isArray(value)) {
      this.fail(`${at}: expected an array of strings`);
      return [];
    }
    const out: string[] = [];
    value.forEach((s, i) => {
      if (typeof s !== "string" || s.length === 0) this.fail(`${at}[${i}]: expected a non-empty string`);
      else out.push(s);
    });
    return out;
  }
}

export function parseConfig(input: unknown): RawConfig {
  const c = new Check();
  const root = c.object(input, "config");

  const version = c.number(root["version"], "config.version", 1, 1_000_000);

  const aorRaw = c.object(root["aor"], "config.aor");
  const aor: AorConfig = {
    firs: c.stringList(aorRaw["firs"], "config.aor.firs"),
    entryRingNm: c.number(aorRaw["entryRingNm"], "config.aor.entryRingNm", 0, 500),
    zonePaddingNm: c.number(aorRaw["zonePaddingNm"], "config.aor.zonePaddingNm", 0, 2000),
  };
  if (aor.firs.length === 0) c.fail("config.aor.firs: at least one FIR is required");
  if (aor.zonePaddingNm <= aor.entryRingNm) {
    // Without a gap, a flight can cross the release boundary and immediately
    // re-enter scope, churning its assignment.
    c.fail(
      `config.aor: zonePaddingNm (${aor.zonePaddingNm}) must exceed entryRingNm (${aor.entryRingNm}) so scope entry and release cannot oscillate`,
    );
  }

  const codesRaw = c.object(root["codes"], "config.codes");
  const conspicuity = typeof codesRaw["conspicuity"] === "string" && SQUAWK.test(codesRaw["conspicuity"])
    ? (codesRaw["conspicuity"] as string)
    : (c.fail("config.codes.conspicuity: expected a four-digit octal code"), "1000");
  const codes: CodesConfig = {
    default: c.squawkList(codesRaw["default"], "config.codes.default"),
    conspicuity,
    emergency: c.squawkList(codesRaw["emergency"], "config.codes.emergency"),
    manuallyAssignable: c.squawkList(codesRaw["manuallyAssignable"], "config.codes.manuallyAssignable"),
  };
  for (const code of codes.manuallyAssignable) {
    if (!codes.emergency.includes(code)) {
      c.fail(`config.codes.manuallyAssignable: ${code} is not in codes.emergency, so it needs no exception`);
    }
  }

  const timingRaw = c.object(root["timing"], "config.timing");
  const timing: TimingConfig = {
    gracePeriodSec: c.number(timingRaw["gracePeriodSec"], "config.timing.gracePeriodSec", 0, 86_400),
    groundSpeedThresholdKt: c.number(timingRaw["groundSpeedThresholdKt"], "config.timing.groundSpeedThresholdKt", 0, 500),
    tickIntervalSec: c.number(timingRaw["tickIntervalSec"], "config.timing.tickIntervalSec", 1, 3600),
  };

  const poolsRaw = c.object(root["pools"], "config.pools");
  const pools: PoolsConfig = {};
  for (const [fir, value] of Object.entries(poolsRaw)) {
    const at = `config.pools.${fir}`;
    const poolRaw = c.object(value, at);
    const ranges: [string, string][] = [];
    if (!Array.isArray(poolRaw["ranges"])) {
      c.fail(`${at}.ranges: expected an array of [first, last] pairs`);
    } else {
      poolRaw["ranges"].forEach((pair, i) => {
        if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || typeof pair[1] !== "string") {
          c.fail(`${at}.ranges[${i}]: expected a [first, last] pair of code strings`);
          return;
        }
        const [first, last] = pair as [string, string];
        if (!SQUAWK.test(first) || !SQUAWK.test(last)) {
          c.fail(`${at}.ranges[${i}]: ${first}-${last} are not four-digit octal codes`);
          return;
        }
        if (parseInt(first, 8) > parseInt(last, 8)) {
          c.fail(`${at}.ranges[${i}]: ${first} is above ${last}`);
          return;
        }
        ranges.push([first, last]);
      });
    }
    if (ranges.length === 0) c.fail(`${at}.ranges: at least one usable range is required`);
    pools[fir] = { ranges, exclusions: c.squawkList(poolRaw["exclusions"] ?? [], `${at}.exclusions`) };
  }
  for (const fir of aor.firs) {
    if (!(fir in pools)) c.fail(`config.pools: no pool for ${fir}, which config.aor.firs lists`);
  }

  if (c.problems.length > 0) throw new ConfigError(c.problems);
  return { version, aor, codes, timing, pools };
}
