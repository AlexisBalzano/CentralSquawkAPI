/**
 * Loading a config snapshot from the ingested config repository.
 *
 * A snapshot is all-or-nothing. Everything is parsed and validated into a new
 * object, and only a fully valid result is handed back for the caller to swap
 * in. A push that fails validation therefore leaves the running snapshot
 * untouched: a bad config must never be able to stop code assignment.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { Area, ringsFromGeoJson } from "../geo.js";
import { CodeBook } from "../domain/codes.js";
import { PoolRegistry } from "../domain/pools.js";
import { loadNavdata, type Navdata } from "../navdata/navdata.js";
import { ConfigError, parseConfig, parsePool, type CodeRange, type RawConfig } from "./schema.js";

export interface ConfigSnapshot {
  raw: RawConfig;
  /** The CAL allocation table, as loaded from ssr_pool.json. */
  ranges: CodeRange[];
  codeBook: CodeBook;
  pools: PoolRegistry;
  /** The Mode S conspicuity area. Kept for provenance and health reporting. */
  modesArea: Area;
  /** Our area of responsibility: the FIRs listed in config.aor.firs. */
  aor: Area;
  /** Each AOR FIR on its own, so a flight can be attributed to the pool that owns it. */
  firAreas: Map<string, Area>;
  navdata: Navdata;
  loadedAt: number;
}

export async function loadConfigSnapshot(dir: string): Promise<ConfigSnapshot> {
  const configText = await readFile(path.join(dir, "config.json"), "utf8");
  let raw: RawConfig;
  try {
    raw = parseConfig(JSON.parse(configText) as unknown);
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new ConfigError([`config.json is not valid JSON: ${err.message}`]);
    }
    throw err;
  }

  const areaDoc = JSON.parse(
    await readFile(path.join(dir, "modes_area.geojson"), "utf8"),
  ) as unknown;

  const modesArea = new Area(ringsFromGeoJson(areaDoc));
  if (modesArea.isEmpty) {
    throw new ConfigError(["modes_area.geojson contained no polygon geometry"]);
  }

  const wanted = new Set(raw.aor.firs);
  const aor = new Area(
    ringsFromGeoJson(areaDoc, (props) => wanted.has(String(props["id"] ?? ""))),
  );
  if (aor.isEmpty) {
    // Without this the AOR is empty, nothing is ever in scope, and the service
    // would run happily while assigning nothing at all.
    throw new ConfigError([
      `config.aor.firs matched no feature in modes_area.geojson: ${raw.aor.firs.join(", ")}`,
    ]);
  }

  const firAreas = new Map<string, Area>();
  for (const fir of raw.aor.firs) {
    const rings = ringsFromGeoJson(areaDoc, (props) => String(props["id"] ?? "") === fir);
    if (rings.length > 0) firAreas.set(fir, new Area(rings));
  }

  const navdata = await loadNavdata(dir);

  const poolText = await readFile(path.join(dir, "ssr_pool.json"), "utf8");
  let ranges: CodeRange[];
  try {
    ranges = parsePool(JSON.parse(poolText) as unknown);
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new ConfigError([`ssr_pool.json is not valid JSON: ${err.message}`]);
    }
    throw err;
  }

  const codeBook = new CodeBook(raw.codes, raw.exclusions);
  const pools = new PoolRegistry(ranges, codeBook.nonIssuable());
  if (pools.capacity === 0) {
    throw new ConfigError(["ssr_pool.json published no issuable codes"]);
  }

  return {
    raw,
    ranges,
    codeBook,
    pools,
    modesArea,
    aor,
    firAreas,
    navdata,
    loadedAt: Date.now(),
  };
}
