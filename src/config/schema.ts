/**
 * Shape of the ingested configuration, and its validators.
 *
 * Two files feed this: config.json, which is hand-maintained policy, and
 * ssr_pool.json, which is generated from the EUROCONTROL CAL and should never
 * be edited by hand.
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

/**
 * One CAL allocation: an inclusive octal range plus the destinations it may be
 * issued for.
 *
 * ORCAM allocates by destination, so a range is not usable for every flight.
 * Destinations are ICAO prefixes of one, two or four characters matched against
 * the arrival aerodrome; `["*"]` means any destination.
 */
export interface CodeRange {
  from: string;
  to: string;
  destinations: string[];
}

export interface ModeSConfig {
  /**
   * ICAO region prefixes of the Mode S participating states.
   *
   * Used to decide whether a flight's DESTINATION is in the area. The route
   * itself is tested against fix.txt, but fix.txt holds no aerodromes, so the
   * last leg of the remaining route needs this instead. Should match the
   * PARTICIPATING list that built modes_area.geojson.
   */
  states: string[];
}

export interface RawConfig {
  version: number;
  aor: AorConfig;
  codes: CodesConfig;
  timing: TimingConfig;
  modeS: ModeSConfig;
  /** Codes inside the CAL ranges that must never be issued. */
  exclusions: string[];
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid config:\n  ${problems.join("\n  ")}`);
    this.name = "ConfigError";
  }
}

const SQUAWK = /^[0-7]{4}$/;
/** ICAO prefix: one, two or four characters, or the any-destination wildcard. */
const DESTINATION = /^(\*|[A-Z]{1,2}|[A-Z]{4})$/;

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

  const modeSRaw = c.object(root["modeS"], "config.modeS");
  const states = c.stringList(modeSRaw["states"], "config.modeS.states").map((s) => s.toUpperCase());
  for (const s of states) {
    if (!/^[A-Z]{2}$/.test(s)) {
      c.fail(`config.modeS.states: ${JSON.stringify(s)} is not a two-letter ICAO region prefix`);
    }
  }
  if (states.length === 0) {
    // With no states nothing is ever destined to the area, so nothing would
    // ever qualify for 1000 and the whole Mode S rule would silently be off.
    c.fail("config.modeS.states: at least one participating state is required");
  }

  const exclusions = c.squawkList(root["exclusions"] ?? [], "config.exclusions");

  if (c.problems.length > 0) throw new ConfigError(c.problems);
  return { version, aor, codes, timing, modeS: { states }, exclusions };
}

/** Validate ssr_pool.json, the generated CAL allocation table. */
export function parsePool(input: unknown): CodeRange[] {
  const c = new Check();
  const root = c.object(input, "ssr_pool");

  const raw = root["ranges"];
  const ranges: CodeRange[] = [];
  if (!Array.isArray(raw)) {
    c.fail("ssr_pool.ranges: expected an array");
  } else {
    raw.forEach((entry, i) => {
      const at = `ssr_pool.ranges[${i}]`;
      const r = c.object(entry, at);
      const from = typeof r["from"] === "string" ? r["from"] : "";
      const to = typeof r["to"] === "string" ? r["to"] : "";
      if (!SQUAWK.test(from) || !SQUAWK.test(to)) {
        c.fail(`${at}: from/to must be four-digit octal codes, got ${from}-${to}`);
        return;
      }
      if (parseInt(from, 8) > parseInt(to, 8)) {
        c.fail(`${at}: ${from} is above ${to}`);
        return;
      }
      const destinations = c.stringList(r["destinations"], `${at}.destinations`)
        .map((d) => d.toUpperCase());
      if (destinations.length === 0) {
        c.fail(`${at}.destinations: at least one destination is required ("*" for any)`);
        return;
      }
      for (const d of destinations) {
        if (!DESTINATION.test(d)) {
          c.fail(`${at}.destinations: ${JSON.stringify(d)} is not an ICAO prefix or "*"`);
        }
      }
      ranges.push({ from, to, destinations });
    });
  }

  if (ranges.length === 0) c.fail("ssr_pool.ranges: no usable ranges");
  if (c.problems.length > 0) throw new ConfigError(c.problems);
  return ranges;
}
