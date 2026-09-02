import { describe, expect, it } from "vitest";
import {
  angleDiff, baseImages, baseResources, centreOf, chebGap, DEFAULT_SPEC, DEFAULT_VALUES, GEYSER, HALL, inMap, layoutBase, MINERAL, MINERAL_FIELDS,
  outwardDirection, overlaps, rectAt, rectImages, ringPositions, snapAngle, summarizeBases, swapsAxes, symmetryAvailable, symmetryAxes, symmetryGaps, symmetryImages,
  TILE, VESPENE_GEYSER, type TileRect,
} from "../layout";

const hall: TileRect = { x: 12, y: 12, w: 4, h: 3 };

describe("rectangles", () => {
  it("chebGap is the larger of the empty columns and rows, -1 when overlapping", () => {
    expect(chebGap(hall, { x: 7, y: 12, w: 2, h: 1 })).toBe(3);
    expect(chebGap(hall, { x: 7, y: 8, w: 2, h: 1 })).toBe(3);
    expect(chebGap(hall, { x: 5, y: 8, w: 2, h: 1 })).toBe(5);
    expect(chebGap(hall, { x: 10, y: 13, w: 2, h: 1 })).toBe(0);
    expect(chebGap(hall, { x: 11, y: 13, w: 2, h: 1 })).toBe(-1);
    expect(overlaps(hall, { x: 11, y: 13, w: 2, h: 1 })).toBe(true);
  });
  it("centreOf and rectAt are inverses on the grid", () => {
    const c = centreOf(hall);
    expect(c).toEqual({ x: 14 * TILE, y: 13.5 * TILE });
    expect(rectAt(c.x, c.y, HALL)).toEqual(hall);
    expect(rectAt(c.x + 10, c.y - 9, HALL)).toEqual(hall);
    expect(inMap(hall, 16, 15)).toBe(true);
    expect(inMap(hall, 15, 15)).toBe(false);
  });
  it("angles fold and snap", () => {
    expect(angleDiff(Math.PI - 0.1, -Math.PI + 0.1)).toBeCloseTo(-0.2, 6);
    expect(snapAngle(0.5)).toBe(Math.PI / 4);
    expect(snapAngle(-0.5)).toBe(-Math.PI / 4);
    expect(snapAngle(0.3)).toBe(0);
  });
});

describe("ringPositions", () => {
  it("lists every patch position exactly three tiles from the hall, sorted by angle", () => {
    const ring = ringPositions(hall, MINERAL, 3);
    expect(ring.length).toBeGreaterThan(20);
    for (const r of ring) expect(chebGap(r, hall)).toBe(3);
    // The column to the left, x = 7 (patch spans 7..8, gap columns 9, 10, 11).
    expect(ring.some((r) => r.x === 7 && r.y === 13)).toBe(true);
    // Not four tiles away, and not two.
    expect(ring.some((r) => r.x === 6)).toBe(false);
    expect(ring.some((r) => r.x === 8 && r.y === 13)).toBe(false);
  });
});

describe("layoutBase", () => {
  const paint = (lay: ReturnType<typeof layoutBase>) => [lay.hall, ...lay.minerals, ...lay.geysers];
  it("puts eight patches in a straight column west of the hall, none overlapping, and the geyser past one end", () => {
    const lay = layoutBase(hall, { ...DEFAULT_SPEC, direction: Math.PI });
    expect(lay.minerals.length).toBe(8);
    expect(lay.geysers.length).toBe(1);
    expect(lay.short).toEqual({ minerals: 0, geysers: 0 });
    for (const m of lay.minerals) { expect(m.x).toBe(7); expect(chebGap(m, hall)).toBe(3); }
    // Line order runs from the left end to the right end as seen from the hall: looking west, left is south.
    const rows = lay.minerals.map((m) => m.y);
    expect(rows).toEqual([16, 15, 14, 13, 12, 11, 10, 9]);
    const g = lay.geysers[0];
    expect(chebGap(g, hall)).toBe(3);
    expect(lay.minerals.every((m) => chebGap(m, g) >= 1)).toBe(true);
    const all = paint(lay);
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) expect(overlaps(all[i], all[j])).toBe(false);
  });
  it("wraps round the corner for a diagonal direction", () => {
    const lay = layoutBase(hall, { ...DEFAULT_SPEC, direction: -3 * Math.PI / 4 });
    expect(lay.minerals.length).toBe(8);
    const onLeft = lay.minerals.filter((m) => m.x === 7).length;
    const onTop = lay.minerals.filter((m) => m.y === 8).length;
    expect(onLeft).toBeGreaterThan(2);
    expect(onTop).toBeGreaterThan(2);
    expect(onLeft + onTop).toBe(8);
  });
  it("runs along the top for a northward direction, stepping a patch width at a time", () => {
    const lay = layoutBase(hall, { ...DEFAULT_SPEC, direction: -Math.PI / 2, minerals: 6, geysers: 0 });
    expect(lay.minerals.every((m) => m.y === 8)).toBe(true);
    const xs = lay.minerals.map((m) => m.x).sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBe(2);
    expect(lay.geysers).toEqual([]);
  });
  it("respects the geyser side and puts two geysers at the two ends", () => {
    const left = layoutBase(hall, { ...DEFAULT_SPEC, direction: Math.PI, geyserSide: "left" });
    const right = layoutBase(hall, { ...DEFAULT_SPEC, direction: Math.PI, geyserSide: "right" });
    // Looking west from the hall, left is south (screen y down), right is north.
    expect(left.geysers[0].y).toBeGreaterThan(hall.y);
    expect(right.geysers[0].y).toBeLessThan(hall.y);
    const two = layoutBase(hall, { ...DEFAULT_SPEC, direction: Math.PI, geysers: 2 });
    expect(two.geysers.length).toBe(2);
    expect(two.geysers[0].y).not.toBe(two.geysers[1].y);
    expect(chebGap(two.geysers[0], two.geysers[1])).toBeGreaterThanOrEqual(1);
  });
  it("reports what the ring had no room for", () => {
    const lay = layoutBase(hall, { ...DEFAULT_SPEC, minerals: 40, geysers: 2 });
    expect(lay.minerals.length).toBeLessThan(40);
    expect(lay.short.minerals).toBe(40 - lay.minerals.length);
    expect(lay.minerals.every((m) => chebGap(m, hall) === 3)).toBe(true);
  });
  it("a wider gap moves the ring out", () => {
    const lay = layoutBase(hall, { ...DEFAULT_SPEC, gap: 4, geyserGap: 5 });
    expect(lay.minerals.every((m) => chebGap(m, hall) === 4)).toBe(true);
    expect(chebGap(lay.geysers[0], hall)).toBe(5);
  });
  it("outwardDirection points from the map centre to the base", () => {
    expect(outwardDirection(100, 64 * 16, 64, 64)).toBeCloseTo(Math.PI, 6);
    expect(outwardDirection(64 * 16, 100, 64, 64)).toBeCloseTo(-Math.PI / 2, 6);
  });
});

describe("resources", () => {
  it("baseResources alternates the three mineral types, values the end patches and the geyser", () => {
    const lay = layoutBase(hall, DEFAULT_SPEC);
    const res = baseResources(lay, { ...DEFAULT_VALUES, endPatches: 750 });
    expect(res.length).toBe(9);
    expect(res.slice(0, 8).map((r) => r.unitId)).toEqual([176, 177, 178, 176, 177, 178, 176, 177]);
    expect(res[0].amount).toBe(750);
    expect(res[7].amount).toBe(750);
    expect(res[3].amount).toBe(1500);
    expect(res[8]).toMatchObject({ unitId: VESPENE_GEYSER, amount: 5000 });
    const plain = baseResources(lay, { ...DEFAULT_VALUES, look: 1 });
    expect(plain.slice(0, 8).every((r) => r.unitId === MINERAL_FIELDS[1])).toBe(true);
  });
});

describe("symmetry", () => {
  const W = 128 * TILE;
  const H = 96 * TILE;
  it("mirror images map the map onto itself and keep footprints on the grid", () => {
    const [, mx] = symmetryImages("mirror-x", W, H);
    expect(mx({ x: 100, y: 200 })).toEqual({ x: W - 100, y: 200 });
    const patch: TileRect = { x: 7, y: 9, w: 2, h: 1 };
    const [same, mirrored] = rectImages(patch, symmetryImages("mirror-x", W, H));
    expect(same).toEqual(patch);
    expect(mirrored).toEqual({ x: 128 - 7 - 2, y: 9, w: 2, h: 1 });
    expect(centreOf(mirrored).x).toBe(W - centreOf(patch).x);
    const [, r180] = rectImages(hall, symmetryImages("rot180", W, H));
    expect(r180).toEqual({ x: 128 - 12 - 4, y: 96 - 12 - 3, w: 4, h: 3 });
  });
  it("square-only modes are refused on a wide map", () => {
    expect(symmetryAvailable("rot90", 128, 96)).toBe(false);
    expect(symmetryAvailable("rot90", 128, 128)).toBe(true);
    expect(symmetryAvailable("quad", 128, 96)).toBe(true);
  });
  it("four-fold modes put the second player across the map", () => {
    const S = 128 * TILE;
    for (const mode of ["rot90", "quad", "octo"] as const) {
      const imgs = symmetryImages(mode, S, S);
      const p = { x: 300, y: 500 };
      expect(imgs[1](p)).toEqual({ x: S - 300, y: S - 500 });
      // Applying each image twice, or four times, comes back to the point.
      for (const f of imgs) { const q = f(f(f(f(p)))); expect(q).toEqual(p); }
    }
    expect(symmetryImages("octo", S, S).length).toBe(8);
    expect(symmetryAxes("quad", W, H).length).toBe(2);
    expect(symmetryAxes("rot180", W, H).length).toBe(0);
  });
  it("baseImages mirrors every resource of a base", () => {
    const bases = baseImages(hall, DEFAULT_SPEC, DEFAULT_VALUES, symmetryImages("mirror-y", W, H));
    expect(bases.length).toBe(2);
    expect(bases[1].image).toBe(1);
    expect(bases[1].resources.length).toBe(9);
    bases[1].resources.forEach((r, i) => {
      const src = bases[0].resources[i];
      expect(r.unitId).toBe(src.unitId);
      expect(centreOf(r.rect).y).toBe(H - centreOf(src.rect).y);
      expect(r.rect.w).toBe(src.unitId === VESPENE_GEYSER ? GEYSER.w : MINERAL.w);
    });
  });
  it("a half-tile rounds towards the map's centre, so the quarter-turn images of a hall are exact half-turn images of each other", () => {
    const S = 128 * TILE;
    const imgs = symmetryImages("rot90", S, S);
    const toward = { x: S / 2, y: S / 2 };
    const h: TileRect = { x: 12, y: 19, w: 4, h: 3 };
    const [, r180, r90, r270] = rectImages(h, imgs, toward);
    expect(r180).toEqual({ x: 128 - 12 - 4, y: 128 - 19 - 3, w: 4, h: 3 });
    // r270 is the half turn of r90.
    expect(r270).toEqual({ x: 128 - r90.x - 4, y: 128 - r90.y - 3, w: 4, h: 3 });
    // Without a centre the plain rounding takes the two the same way, which is not a half turn.
    const [, , p90, p270] = rectImages(h, imgs);
    expect(p270.x === 128 - p90.x - 4 && p270.y === 128 - p90.y - 3).toBe(false);
  });
  it("baseImages lays a base out again under a rotation by 90°, so no two patches overlap", () => {
    const S = 128 * TILE;
    const imgs = symmetryImages("rot90", S, S);
    expect(swapsAxes(imgs[0])).toBe(false);
    expect(swapsAxes(imgs[1])).toBe(false);
    expect(swapsAxes(imgs[2])).toBe(true);
    expect(swapsAxes(imgs[3])).toBe(true);
    const bases = baseImages(hall, { ...DEFAULT_SPEC, direction: Math.PI }, DEFAULT_VALUES, imgs);
    expect(bases.length).toBe(4);
    for (const b of bases) {
      expect(b.resources.length).toBe(9);
      const rects = [b.hall, ...b.resources.map((r) => r.rect)];
      for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(overlaps(rects[i], rects[j])).toBe(false);
      for (const r of b.resources) expect(chebGap(r.rect, b.hall)).toBe(3);
    }
    // The 90° image's line runs north of its hall: the west line turned a quarter turn clockwise.
    const turned = bases[2];
    expect(turned.resources.slice(0, 8).every((r) => r.rect.y < turned.hall.y)).toBe(true);
  });
  it("symmetryGaps finds the units without a counterpart", () => {
    const imgs = symmetryImages("mirror-x", W, H);
    const units = [
      { index: 0, unitId: 214, owner: 0, x: 200, y: 300 },
      { index: 1, unitId: 214, owner: 1, x: W - 200, y: 300 },
      { index: 2, unitId: 176, owner: 11, x: 100, y: 300 },
      // Another mineral field type still counts as the counterpart.
      { index: 3, unitId: 178, owner: 11, x: W - 100, y: 310 },
      { index: 4, unitId: 188, owner: 11, x: 100, y: 400 },
    ];
    const gaps = symmetryGaps(units, imgs, (o) => o);
    expect(gaps).toEqual([{ index: 4, image: 1 }]);
    // Owners must match through the mapping for anything but a start location.
    const owned = [{ index: 0, unitId: 7, owner: 0, x: 200, y: 300 }, { index: 1, unitId: 7, owner: 0, x: W - 200, y: 300 }];
    expect(symmetryGaps(owned, imgs, (o, k) => (o + k) % 2)).toEqual([{ index: 0, image: 1 }, { index: 1, image: 1 }]);
    expect(symmetryGaps(owned, imgs, (o) => o)).toEqual([]);
  });
  it("summarizeBases counts the resources near each start location", () => {
    const lay = layoutBase(hall, DEFAULT_SPEC);
    const res = baseResources(lay, { ...DEFAULT_VALUES, endPatches: 750 });
    const units = [
      { index: 0, unitId: 214, owner: 0, ...centreOf(hall) },
      ...res.map((r, i) => ({ index: i + 1, unitId: r.unitId, owner: 11, ...centreOf(r.rect) })),
      { index: 99, unitId: 176, owner: 11, x: 3000, y: 3000 },
    ];
    const amounts = (index: number) => (index === 0 ? 0 : res[index - 1].amount);
    expect(summarizeBases(units, amounts)).toEqual([{ owner: 0, x: centreOf(hall).x, y: centreOf(hall).y, patches: 8, mineralTotal: 6 * 1500 + 2 * 750, geysers: 1 }]);
  });
});
