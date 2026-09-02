import { describe, expect, it } from "vitest";
import { assignLegend, charAt, diamondTerrain, heightAt, paintOrder, rankByCount, sampleGrid, terrainOfGroup, terrainSampler } from "../grid";
import type { LayoutPlan, TerrainVocab } from "../protocol";

const terrains: TerrainVocab[] = [
  { id: 2, name: "Dirt", height: 0, buildable: true },
  { id: 4, name: "High Dirt", height: 1, buildable: true },
  { id: 8, name: "Water", height: 0, buildable: false },
];

describe("legend", () => {
  it("hands out readable characters by rank", () => {
    expect(assignLegend([2, 8, 4])).toEqual({ ".": 2, "#": 8, "~": 4 });
    expect(rankByCount(new Map([[4, 3], [2, 10], [8, 3]]))).toEqual([2, 4, 8]);
  });
  it("maps a CV5 group to its flat pair's terrain", () => {
    expect(terrainOfGroup(2, [{ id: 2, group: 2 }, { id: 4, group: 6 }])).toBe(2);
    expect(terrainOfGroup(7, [{ id: 2, group: 2 }, { id: 4, group: 6 }])).toBe(4);
    expect(terrainOfGroup(9, [{ id: 2, group: 2 }, { id: 4, group: 6 }])).toBeNull();
  });
});

describe("sampleGrid", () => {
  it("takes the majority of each cell and marks unknown cells", () => {
    // 8 × 4 tiles: left half dirt, right half water, one cliff column at x = 4.
    const at = (x: number, y: number) => (x === 4 ? null : x < 4 ? 2 : y === 0 ? 8 : 8);
    const g = sampleGrid(at, { x0: 0, y0: 0, x1: 8, y1: 4 }, 2);
    expect(g.columns).toBe(4);
    expect(g.rows).toBe(2);
    expect(g.grid).toEqual(["..##", "..##"]);
    expect(g.legend).toEqual({ ".": 2, "#": 8 });
    const unknown = sampleGrid(() => null, { x0: 0, y0: 0, x1: 4, y1: 2 }, 2);
    expect(unknown.grid).toEqual(["??"]);
    expect(unknown.legend).toEqual({});
  });
  it("keeps the origin and pads partial cells", () => {
    const g = sampleGrid(() => 2, { x0: 3, y0: 5, x1: 8, y1: 8 }, 2);
    expect(g).toMatchObject({ originX: 3, originY: 5, columns: 3, rows: 2 });
  });
});

describe("plan sampling", () => {
  const plan: LayoutPlan = { cellSize: 2, columns: 2, rows: 2, legend: { ".": 2, "#": 4 }, grid: [".#", "#."], bases: [], ramps: [], doodads: [], units: [], locations: [], notes: [] };
  it("charAt and terrainSampler read cells at an origin", () => {
    expect(charAt(plan, 10, 10, 10, 10)).toBe(".");
    expect(charAt(plan, 10, 10, 12, 10)).toBe("#");
    expect(charAt(plan, 10, 10, 9, 10)).toBe("?");
    const s = terrainSampler(plan, 0, 0);
    expect(s(3, 3)).toBe(2);
    expect(s(2, 0)).toBe(4);
    expect(s(4, 0)).toBeNull();
  });
  it("diamondTerrain votes over the four tiles round a corner, top-left winning ties", () => {
    const s = terrainSampler(plan, 0, 0);
    expect(diamondTerrain(s, 2, 2)).toBe(2);
    expect(diamondTerrain(s, 0, 0)).toBe(2);
    expect(diamondTerrain(s, 4, 0)).toBe(4);
    expect(diamondTerrain(() => null, 1, 1)).toBeNull();
  });
  it("paintOrder puts low ground first, then the commonest", () => {
    expect(paintOrder([4, 8, 2], terrains, new Map([[2, 5], [8, 9], [4, 1]]))).toEqual([8, 2, 4]);
  });
  it("heightAt reads the vocabulary", () => {
    expect(heightAt(plan, terrains, 1, 0)).toBe(1);
    expect(heightAt(plan, terrains, 0, 0)).toBe(0);
    expect(heightAt(plan, terrains, 5, 0)).toBe(-1);
  });
});
