import { describe, expect, it } from "vitest";
import { buildReference, type ReferenceParts } from "../reference";
import { QUICK_PROMPTS, trimHistory } from "../assistant";
import type { AgentMessage } from "../protocol";

const parts: ReferenceParts = {
  mapName: "Lost Temple",
  width: 128,
  height: 128,
  tileset: "Jungle",
  versionLabel: "Brood War 1.04",
  terrains: [{ id: 1, name: "Dirt", height: 0, buildable: true }, { id: 3, name: "Water", height: 0, buildable: false }, { id: 7, name: "High Dirt", height: 1, buildable: true }],
  doodadCategories: [{ name: "Trees", doodads: [{ id: 10, name: "Jungle Tree", width: 2, height: 2 }] }],
  units: [{ id: 0, name: "Terran Marine", race: "T", width: 1, height: 1, building: false, flyer: false, hitPoints: 40, shields: 0, armor: 0, minerals: 50, gas: 0, buildTime: 360, weapons: "Gauss Rifle 6" }],
  upgrades: [{ id: 0, name: "Terran Infantry Armor" }],
  techs: [{ id: 0, name: "Stim Packs" }],
  conditions: [{ name: "Bring", args: [{ label: "Player", kind: "player" }, { label: "Unit", kind: "unit" }, { label: "Location", kind: "location" }, { label: "Comparison", kind: "comparison" }, { label: "Count", kind: "count" }] }],
  actions: [{ name: "Display Text Message", args: [{ label: "Flags", kind: "textFlags" }, { label: "Text", kind: "text" }] }],
  briefingActions: [{ name: "Mission Objectives", args: [{ label: "Text", kind: "text" }] }],
  choices: [{ kind: "comparison", labels: ["At least", "At most", "Exactly"] }, { kind: "order", labels: [] }],
  aiScripts: ["Terran Custom Level", "Zerg Custom Level"],
  sprites: [{ label: "Doodads", count: 3 }],
  hasScript: false,
};

describe("reference block", () => {
  it("lists what the assistant needs and is deterministic", () => {
    const text = buildReference(parts);
    expect(text).toContain('# Reference for "Lost Temple" — 128 × 128 tiles, tileset Jungle, Brood War 1.04');
    expect(text).toContain("- 7: High Dirt — height 1, buildable");
    expect(text).toContain("- Trees (1): Jungle Tree 2×2");
    expect(text).toContain("0: Terran Marine | T | 1×1 | ground | 40/0/0 | 50/0 | 360 | Gauss Rifle 6");
    expect(text).toContain("- Bring(Player: player, Unit: unit, Location: location, Comparison: comparison, Count: count)");
    expect(text).toContain("- comparison: At least, At most, Exactly");
    expect(text).not.toContain("- order:");
    expect(text).toContain("## AI scripts (Run AI Script): Terran Custom Level; Zerg Custom Level");
    expect(text).toContain("This map has no script yet.");
    expect(text).toContain('Trigger("Player 1", "Force 2"){');
    expect(buildReference(parts)).toBe(text);
    expect(buildReference({ ...parts, hasScript: true })).toContain("already has a script");
  });
});

describe("assistant history", () => {
  it("trims from the front on a clean user message and offers quick prompts", () => {
    const m: AgentMessage[] = [];
    for (let i = 0; i < 10; i++) {
      m.push({ role: "user", content: [{ type: "text", text: `q${i}` }] });
      m.push({ role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "x", input: {} }] });
      m.push({ role: "user", content: [{ type: "tool_result", toolUseId: `t${i}`, content: "ok" }] });
      m.push({ role: "assistant", content: [{ type: "text", text: `a${i}` }] });
    }
    const t = trimHistory(m, 10);
    expect(t.length).toBeLessThanOrEqual(10);
    expect(t[0].role).toBe("user");
    expect(t[0].content[0].type).toBe("text");
    expect(trimHistory(m.slice(0, 4), 10)).toHaveLength(4);
    expect(QUICK_PROMPTS.length).toBeGreaterThan(3);
  });
});
