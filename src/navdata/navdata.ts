/**
 * Parsers for the three generated navdata files.
 *
 * fix.txt is clipped to the Mode S area, so MEMBERSHIP IN `fixes` IS THE
 * CONTAINMENT TEST. The polygon was applied when the file was generated; this
 * service never runs point-in-polygon on a route point.
 *
 * airway.txt is not clipped, which is what keeps that correct: an airway that
 * leaves the area and returns names fixes that fix.txt does not contain, so the
 * excursion is detected instead of being hidden by clipping.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

export interface Navdata {
  /** AIRAC cycle, read from the file headers. */
  cycle: string;
  /** Every fix inside the Mode S area. Presence here means "inside". */
  fixes: Map<string, { lat: number; lon: number }>;
  /** Designator to its chains. A designator may have more than one. */
  airways: Map<string, string[][]>;
  /** Airport ICAO to the SID/STAR designators it publishes. */
  procedures: Map<string, Set<string>>;
}

const CYCLE_PATTERN = /AIRAC\s+(\d{4})/;

function* dataLines(text: string): Generator<string> {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    yield line;
  }
}

function cycleOf(text: string): string | null {
  const header = text.slice(0, 4096);
  return CYCLE_PATTERN.exec(header)?.[1] ?? null;
}

function parseFixes(text: string): Map<string, { lat: number; lon: number }> {
  const fixes = new Map<string, { lat: number; lon: number }>();
  for (const line of dataLines(text)) {
    const [ident, lat, lon] = line.split(/\s+/);
    if (!ident || lat === undefined || lon === undefined) continue;
    const latitude = Number(lat);
    const longitude = Number(lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    fixes.set(ident, { lat: latitude, lon: longitude });
  }
  return fixes;
}

function parseAirways(text: string): Map<string, string[][]> {
  const airways = new Map<string, string[][]>();
  let current: string[] | null = null;
  for (const line of dataLines(text)) {
    if (line.startsWith("AIRWAY ")) {
      const name = line.slice(7).trim().split(/\s+/)[0];
      if (!name) continue;
      current = [];
      const chains = airways.get(name);
      if (chains) chains.push(current);
      else airways.set(name, [current]);
      continue;
    }
    current?.push(line);
  }
  return airways;
}

function parseProcedures(text: string): Map<string, Set<string>> {
  const procedures = new Map<string, Set<string>>();
  for (const line of dataLines(text)) {
    const [airport, kind, designator] = line.split(/\s+/);
    if (!airport || !designator) continue;
    if (kind !== "SID" && kind !== "STAR") continue;
    let set = procedures.get(airport);
    if (!set) {
      set = new Set<string>();
      procedures.set(airport, set);
    }
    set.add(designator);
  }
  return procedures;
}

export async function loadNavdata(dir: string): Promise<Navdata> {
  const [fixText, airwayText, procedureText] = await Promise.all([
    readFile(path.join(dir, "fix.txt"), "utf8"),
    readFile(path.join(dir, "airway.txt"), "utf8"),
    readFile(path.join(dir, "procedure.txt"), "utf8"),
  ]);

  const cycles = [cycleOf(fixText), cycleOf(airwayText), cycleOf(procedureText)];
  const distinct = new Set(cycles.filter((c): c is string => c !== null));
  if (distinct.size > 1) {
    // Mixed cycles mean someone regenerated one file and not the others, which
    // silently changes eligibility for routes whose text has not moved.
    throw new Error(
      `navdata files disagree on AIRAC cycle: ${[...distinct].join(", ")} -- regenerate all three together`,
    );
  }

  const navdata: Navdata = {
    cycle: [...distinct][0] ?? "unknown",
    fixes: parseFixes(fixText),
    airways: parseAirways(airwayText),
    procedures: parseProcedures(procedureText),
  };

  if (navdata.fixes.size === 0) {
    throw new Error("fix.txt contained no fixes -- refusing to load");
  }
  return navdata;
}
