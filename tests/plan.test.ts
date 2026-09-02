import { describe, expect, it } from "vitest";
import {
  angleDirection, baseFootprint, cellsWith, checkPlan, chooseRamp, directionAngle, enforceSymmetry, groundHeight, hashString, paintGroups, placeBases, prng, scatterDoodads,
  usableSymmetry, type PlanContext,
} from "../plan";
import type { LayoutPlan, MapPlan, TerrainVocab } from "../protocol";

const terrains: TerrainVocab[] = [
  { id: 2, name: "Dirt", height: 0, buildable: true },
  { id: 4, name: "High Dirt", height: 1, buildable: true },
  { id: 8, name: "Water", height: 0, buildable: false },
];

const ctx: PlanContext = { terrains, width: 16, height: 16, originX: 0, originY: 0 };

function plan(over: Partial<LayoutPlan> = {}): LayoutPlan {
  return { cellSize: 4, columns: 4, rows: 4, legend: { ".": 2, "#": 4, "~": 8 }, grid: ["....", ".##.", ".##.", "...."], bases: [], ramps: [], doodads: [], units: [], locations: [], notes: [], ...over };
}

describe("checkPlan", () => {
  it("mends row counts and lengths and reports it", () => {
    const { plan: p, problems } = checkPlan(plan({ grid: ["..", ".##.#", "...."] }), ctx);
    expect(p.grid).toEqual(["....", ".##.", "....", "...."]);
    expect(problems.some((s) => s.includes("3 rows"))).toBe(true);
    expect(problems.some((s) => s.includes("wrong length"))).toBe(true);
  });
  it("replaces unknown terrain ids and marks unknown characters", () => {
    const { plan: p, problems } = checkPlan(plan({ legend: { ".": 2, "#": 99 }, grid: ["..x.", "....", "....", "...."] }), ctx);
    expect(p.legend["#"]).toBe(2);
    expect(p.grid[0]).toBe("..?.");
    expect(problems).toHaveLength(2);
  });
  it("keeps coordinates on the map and drops nonsense", () => {
    const { plan: p, problems } = checkPlan(plan({
      bases: [{ kind: "main", x: 14, y: 15, mineralDirection: "up" as never, minerals: 30, geysers: 5 }],
      ramps: [{ x: 40, y: 2, direction: "n" }, { x: 2, y: 2, direction: "sideways" as never }],
      units: [{ unit: "Terran Marine", player: 20, x: -3, y: 2 }],
      locations: [{ name: "Empty", x0: 3, y0: 3, x1: 3, y1: 9 }, { name: "Flip", x0: 9, y0: 9, x1: 1, y1: 1 }],
    }), ctx);
    expect(p.bases[0]).toMatchObject({ x: 12, y: 13, mineralDirection: "w", minerals: 12, geysers: 2 });
    expect(p.ramps).toEqual([]);
    expect(p.units[0]).toMatchObject({ x: 0, y: 2, player: 12 });
    expect(p.locations).toEqual([{ name: "Flip", x0: 1, y0: 1, x1: 9, y1: 9 }]);
    expect(problems.length).toBeGreaterThanOrEqual(5);
  });
  it("does not mutate its input", () => {
    const input = plan({ grid: ["..", "..", "..", ".."] });
    checkPlan(input, ctx);
    expect(input.grid[0]).toBe("..");
  });
});

describe("symmetry", () => {
  it("square-only modes fall back to none on a wide map", () => {
    expect(usableSymmetry("rot90", 16, 12)).toBe("none");
    expect(usableSymmetry("rot180", 16, 12)).toBe("rot180");
    expect(usableSymmetry(undefined, 16, 16)).toBe("none");
  });
  it("makes the grid exactly symmetric with the top-left cell winning", () => {
    const p: MapPlan = { ...plan({ grid: ["#...", "....", "....", "...~"] }), name: "n", description: "d", symmetry: "rot180" };
    const out = enforceSymmetry(p, 16, 16);
    expect(out.grid).toEqual(["#...", "....", "....", "...#"]);
    const q = enforceSymmetry({ ...p, symmetry: "mirror-x", grid: ["#..~", "....", "....", "...."] }, 16, 16);
    expect(q.grid[0]).toBe("#..#");
  });
});

describe("bases", () => {
  it("mirrors a main under rot180 and numbers the players in image order", () => {
    const out = placeBases([{ kind: "main", x: 1, y: 1, mineralDirection: "w", minerals: 6, geysers: 1 }], "rot180", 32, 32);
    expect(out).toHaveLength(2);
    expect(out.map((b) => b.player)).toEqual([1, 2]);
    expect(out[1].hall).toEqual({ x: 32 - 1 - 4, y: 32 - 1 - 3, w: 4, h: 3 });
    expect(angleDirection(out[1].direction)).toBe("e");
    expect(out[0].layout.minerals.length).toBeGreaterThan(0);
  });
  it("keeps the plan's own numbers without a symmetry and skips clashes", () => {
    const out = placeBases([
      { kind: "main", x: 1, y: 1, mineralDirection: "w", minerals: 6, geysers: 1, player: 3 },
      { kind: "main", x: 20, y: 20, mineralDirection: "e", minerals: 6, geysers: 1, player: 3 },
      { kind: "expansion", x: 10, y: 10, mineralDirection: "n", minerals: 6, geysers: 1 },
    ], "none", 32, 32);
    expect(out.map((b) => b.player)).toEqual([3, 1, null]);
  });
  it("re-lays a base that a 90° image turns", () => {
    const out = placeBases([{ kind: "main", x: 2, y: 2, mineralDirection: "w", minerals: 8, geysers: 1 }], "rot90", 64, 64);
    expect(out).toHaveLength(4);
    for (const b of out) expect(b.layout.minerals.length).toBe(8);
    expect(out.map((b) => angleDirection(b.direction)).sort()).toEqual(["e", "n", "s", "w"]);
  });
  it("footprints cover the resources with a margin", () => {
    const [b] = placeBases([{ kind: "main", x: 8, y: 8, mineralDirection: "w", minerals: 4, geysers: 0 }], "none", 32, 32);
    const f = baseFootprint(b);
    expect(f.x0).toBeLessThan(8);
    expect(f.x1).toBe(8 + 4 + 1);
  });
  it("directions round trip", () => {
    for (const d of ["n", "ne", "e", "se", "s", "sw", "w", "nw"] as const) expect(angleDirection(directionAngle(d))).toBe(d);
  });
});

describe("terrain", () => {
  it("groups diamonds by the terrain under them, low ground first", () => {
    const p = plan({ grid: ["~~..", "~~..", "..##", "..##"] });
    const diamonds: { x: number; y: number }[] = [];
    for (let y = 0; y <= 16; y++) for (let x = 0; x <= 8; x++) if ((x + y) % 2 === 0) diamonds.push({ x, y });
    const groups = paintGroups(p, ctx, diamonds);
    expect(groups.map((g) => g.terrainId)).toEqual([2, 8, 4]);
    const total = groups.reduce((n, g) => n + g.diamonds.length, 0);
    expect(total).toBe(diamonds.length);
    // The diamond centred on tile corner (0,0) sees only the top-left cell: water.
    expect(groups.find((g) => g.terrainId === 8)!.diamonds).toContainEqual({ x: 0, y: 0 });
  });
  it("cellsWith lists the cells with the given characters in tiles", () => {
    const cells = cellsWith(plan(), ctx, "#");
    expect(cells).toHaveLength(4);
    expect(cells[0]).toEqual({ x0: 4, y0: 4, x1: 8, y1: 8 });
  });
  it("groundHeight answers a uniform height or -1", () => {
    expect(groundHeight(plan(), ctx, { x0: 4, y0: 4, x1: 8, y1: 8 })).toBe(1);
    expect(groundHeight(plan(), ctx, { x0: 2, y0: 2, x1: 6, y1: 6 })).toBe(-1);
  });
});

describe("ramps and decoration", () => {
  const ramps = [
    { id: 1, name: "Ramp tall", category: "Ramps", width: 4, height: 8 },
    { id: 2, name: "Ramp wide", category: "Ramps", width: 8, height: 4 },
    { id: 3, name: "Ramp square", category: "Ramps", width: 5, height: 5 },
  ];
  it("chooses a ramp by the shape the direction needs", () => {
    expect(chooseRamp("n", 10, 10, ramps)?.doodadId).toBe(1);
    expect(chooseRamp("e", 10, 10, ramps)?.doodadId).toBe(2);
    expect(chooseRamp("ne", 10, 10, ramps)?.doodadId).toBe(3);
    expect(chooseRamp("s", 10, 10, ramps)).toMatchObject({ tx: 8, ty: 6, width: 4, height: 8 });
    expect(chooseRamp("s", 10, 10, [])).toBeNull();
  });
  it("scatters doodads only on the listed cells, never overlapping, deterministically", () => {
    const p = plan({ doodads: [{ category: "trees", on: "#", density: 1 }] });
    const categories = new Map([["Trees", [{ id: 7, name: "Trees #1", category: "Trees", width: 2, height: 2 }]]]);
    const a = scatterDoodads(p, ctx, categories, () => false);
    const b = scatterDoodads(p, ctx, categories, () => false);
    expect(a.placed).toEqual(b.placed);
    expect(a.placed.length).toBeGreaterThan(0);
    for (const d of a.placed) {
      expect(d.tx).toBeGreaterThanOrEqual(4);
      expect(d.tx + d.width).toBeLessThanOrEqual(12);
      expect(d.ty).toBeGreaterThanOrEqual(4);
      expect(d.ty + d.height).toBeLessThanOrEqual(12);
    }
    for (let i = 0; i < a.placed.length; i++) for (let j = i + 1; j < a.placed.length; j++) {
      const p1 = a.placed[i], p2 = a.placed[j];
      expect(p1.tx < p2.tx + p2.width && p2.tx < p1.tx + p1.width && p1.ty < p2.ty + p2.height && p2.ty < p1.ty + p1.height).toBe(false);
    }
    const none = scatterDoodads(p, ctx, categories, () => true);
    expect(none.placed).toEqual([]);
    const missing = scatterDoodads(plan({ doodads: [{ category: "Rocks", on: ".", density: 0.5 }] }), ctx, categories, () => false);
    expect(missing.problems[0]).toContain("Rocks");
  });
  it("prng is deterministic and in range", () => {
    const a = prng(hashString("seed")), b = prng(hashString("seed"));
    for (let i = 0; i < 100; i++) { const v = a(); expect(v).toBe(b()); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); }
  });
});
