/**
 * Tests for measuring an area made of overlapping rings.
 *
 * The AOR is the five French FIRs plus the UIR covering all of them, so most
 * ring edges are seams through the middle of the country rather than its
 * border. Measured to those, an airport deep inside France looks like it sits
 * on the border, and nothing looks wrong except that its departures quietly
 * stop getting codes.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Area, type Ring } from "../src/geo.js";

/** A lon/lat box as a closed GeoJSON ring. */
function box(west: number, south: number, east: number, north: number): Ring {
  return [[west, south], [east, south], [east, north], [west, north], [west, south]];
}

/**
 * Two areas measure the same distance to their edge from every point of a grid
 * over the boxes below and a margin around them, inside and out.
 */
function assertSameEdge(pieced: Area, whole: Area): void {
  for (let lat = 45; lat <= 51; lat += 0.25) {
    for (let lon = -1; lon <= 11; lon += 0.25) {
      const got = pieced.distanceToEdgeNm(lat, lon);
      const want = whole.distanceToEdgeNm(lat, lon);
      assert.ok(Math.abs(got - want) < 1e-9, `at ${lat},${lon}: ${got} NM, expected ${want} NM`);
    }
  }
}

describe("the edge of an area made of overlapping rings", () => {
  it("ignores the seam where two rings meet", () => {
    // Two FIRs side by side, and the UIR covering both, just as config.aor.firs
    // matches them in production.
    const pieced = new Area([box(0, 46, 5, 50), box(5, 46, 10, 50), box(0, 46, 10, 50)]);

    // 4 NM from the seam at 5E, but two degrees of latitude from the real edge.
    assert.ok(Math.abs(pieced.distanceToEdgeNm(48, 5.1) - 120) < 1e-9);
    assertSameEdge(pieced, new Area([box(0, 46, 10, 50)]));
  });

  it("follows whichever ring reaches further where two disagree", () => {
    // Crossing rings: the true edge zigzags between them, so an edge has to be
    // cut where the other crosses it rather than kept or dropped whole.
    const pieced = new Area([box(0, 46, 5, 50), box(3, 47, 8, 49)]);
    const whole = new Area([
      [[0, 46], [5, 46], [5, 47], [8, 47], [8, 49], [5, 49], [5, 50], [0, 50], [0, 46]],
    ]);
    assertSameEdge(pieced, whole);
  });
});

describe("insideByNm", () => {
  it("is the area shrunk by that distance", () => {
    const area = new Area([box(0, 46, 5, 50)]);

    // A tenth of a degree of longitude inside the east edge: 4 NM at 48N.
    assert.equal(area.insideByNm(48, 4.9, 3), true);
    assert.equal(area.insideByNm(48, 4.9, 5), false);
    assert.equal(area.insideByNm(48, 4.9, 0), true, "0 is the area itself");
    assert.equal(area.insideByNm(48, 5.1, 0), false, "outside is never inside, by any margin");
  });
});
