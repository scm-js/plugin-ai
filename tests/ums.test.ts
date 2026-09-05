import { describe, expect, it } from "vitest";
import { buildSystem, buildSystems, cyclesFor, dcUnitsFrom, kindByName, kindsText, paramsOf, systemKinds, ToolkitError, trigger, type ToolkitContext } from "../ums";

const ctx: ToolkitContext = { humans: [1, 2], computers: [5], hyper: true, dcUnits: ["Cave (Unused)", "Cantina (Unused)"], locations: ["Spawn 1", "Spawn 2", "Arena", "Goal", "Shop"] };

describe("the UMS toolkit", () => {
  it("lists a catalogue the server can design against", () => {
    const kinds = systemKinds();
    expect(kinds.map((k) => k.kind)).toContain("hyper");
    expect(kinds.map((k) => k.kind)).toContain("waves");
    for (const k of kinds) {
      expect(k.description.length).toBeGreaterThan(20);
      for (const p of k.params) expect(p.description.length).toBeGreaterThan(3);
    }
    expect(kindByName("spawn")?.params.find((p) => p.name === "location")?.required).toBe(true);
    expect(kindByName("nothing")).toBeNull();
    expect(kindsText()).toContain("spawn:");
  });

  it("counts trigger cycles at the map's rate", () => {
    expect(cyclesFor(10, true)).toBe(120);
    expect(cyclesFor(10, false)).toBe(5);
    expect(cyclesFor(1, false)).toBe(1);
  });

  it("prints a trigger in the editor's text format", () => {
    expect(trigger([1, "Force 2"], [], ["Victory()"])).toBe('Trigger("Player 1", "Force 2"){\nConditions:\n\tAlways();\nActions:\n\tVictory();\n}\n');
  });

  it("builds hyper triggers as three preserved Wait(0) triggers", () => {
    const b = buildSystem("hyper", {}, ctx);
    expect(b.count).toBe(3);
    expect(b.text.match(/Wait\(0\)/g)?.length).toBe(62 * 3);
    expect(b.text).toContain('Trigger("All Players"){');
    expect(b.text).toContain("Preserve Trigger();");
  });

  it("spawns per human with {p} substituted, a death-counter timer and an optional attack order", () => {
    const b = buildSystem("spawn", { location: "Spawn {p}", unit: "Zerg Zergling", count: "4", every: "5", attack: "Arena", limit: "40" }, ctx);
    expect(b.count).toBe(4);
    expect(b.text).toContain('Deaths("Player 1", "Cave (Unused)", At least, 60)');
    expect(b.text).toContain('Create Unit("Player 1", "Zerg Zergling", 4, "Spawn 1")');
    expect(b.text).toContain('Create Unit("Player 2", "Zerg Zergling", 4, "Spawn 2")');
    expect(b.text).toContain('Command("Player 2", "Zerg Zergling", At most, 39)');
    expect(b.text).toContain('Order("Player 1", "Zerg Zergling", "Spawn 1", "Arena", attack)');
    expect(b.text).toContain('Set Deaths("Player 1", "Cave (Unused)", Add, 1)');
    expect(b.dcUsed).toEqual(["Cave (Unused)"]);
    expect(b.notes[0]).toContain("60 trigger cycles ≈ 5 s with hyper triggers");
    const slow = buildSystem("spawn", { location: "Spawn {p}", unit: "Zerg Zergling", every: "10", owner: "computer" }, { ...ctx, hyper: false });
    expect(slow.text).toContain("At least, 5)");
    expect(slow.text).toContain('Create Unit("Player 5", "Zerg Zergling", 1, "Spawn 1")');
  });

  it("names every problem instead of guessing", () => {
    expect(() => buildSystem("spawn", { unit: "Zerg Zergling" }, ctx)).toThrow(ToolkitError);
    try {
      buildSystem("spawn", { location: "Nowhere", unit: "Zerg Zergling", every: "fast", speed: "3", players: "everyone" }, ctx);
    } catch (err) {
      const problems = (err as ToolkitError).problems;
      expect(problems.some((p) => p.includes('"every" should be a number'))).toBe(true);
      expect(problems.some((p) => p.includes('"speed" is not a parameter of spawn'))).toBe(true);
      expect(problems.some((p) => p.includes('"players" should be humans'))).toBe(true);
    }
    expect(() => buildSystem("teleport", { from: "Nowhere", to: "Arena" }, ctx)).toThrow(/names location "Nowhere"/);
    expect(() => buildSystem("wave", {}, ctx)).toThrow(/no system kind called "wave"/);
    // Without a location list nothing is checked.
    expect(buildSystem("teleport", { from: "Nowhere", to: "Arena" }, { ...ctx, locations: [] }).count).toBe(1);
  });

  it("pays kills through the kill score and gives income on a timer", () => {
    const k = buildSystem("kill-to-cash", { minerals: "25", scorePerKill: "50" }, ctx);
    expect(k.text).toContain('Score("Current Player", Kills, At least, 50)');
    expect(k.text).toContain('Set Score("Current Player", Subtract, 50, Kills)');
    expect(k.text).toContain('Set Resources("Current Player", Add, 25, ore)');
    expect(k.text.startsWith('Trigger("Player 1", "Player 2"){')).toBe(true);
    const i = buildSystem("income", { minerals: "8", every: "1", perUnit: "Terran Command Center" }, ctx);
    expect(i.text).toContain('Deaths("Current Player", "Cave (Unused)", At least, 12)');
    expect(i.text).toContain('Command("Current Player", "Terran Command Center", At least, 1)');
  });

  it("ends the game: last standing, lost unit, kills, and a countdown", () => {
    const ls = buildSystem("last-standing", { unit: "Buildings" }, ctx);
    expect(ls.text).toContain('Command("Current Player", "Buildings", Exactly, 0)');
    expect(ls.text).toContain('Opponents("Current Player", Exactly, 0)');
    expect(ls.text).toContain("Victory();");
    const cd = buildSystem("countdown", { seconds: "600", onEnd: "victory:Force 1", message: "Time." }, ctx);
    expect(cd.text).toContain("Set Countdown Timer(Set To, 600)");
    expect(cd.text).toContain('Trigger("Force 1"){\nConditions:\n\tCountdown Timer(Exactly, 0);\nActions:\n\tDisplay Text Message(Always Display, "Time.");\n\tVictory();');
    const draw = buildSystem("countdown", { seconds: "60" }, ctx);
    expect(draw.text).toContain("Draw()");
    const vk = buildSystem("victory-on-kills", { count: "50" }, ctx);
    expect(vk.text).toContain('Kill("Current Player", "Any unit", At least, 50)');
    expect(vk.text).toContain('Kill("Foes", "Any unit", At least, 50)');
  });

  it("builds defense: lives on the enemy's counter and waves that grow", () => {
    const [lives, waves] = buildSystems([
      { kind: "lives", params: { lives: "10", goal: "Goal" } },
      { kind: "waves", params: { spawn: "Spawn 1", goal: "Goal", units: "Zerg Zergling, Zerg Hydralisk", waves: "3", interval: "30", count: "5", growth: "5" } },
    ], ctx);
    expect(lives.dcUsed).toEqual(["Cave (Unused)"]);
    expect(waves.dcUsed).toEqual(["Cantina (Unused)"]);
    expect(lives.text).toContain('Set Deaths("Player 5", "Cave (Unused)", Set To, 10)');
    expect(lives.text).toContain('Remove Unit At Location("Player 5", "Any unit", All, "Goal")');
    expect(waves.count).toBe(4);
    expect(waves.text).toContain('Elapsed Time(At least, 60);\n\tDeaths("Player 5", "Cantina (Unused)", Exactly, 1);');
    expect(waves.text).toContain('Create Unit("Player 5", "Zerg Hydralisk", 10, "Spawn 1")');
    expect(waves.text).toContain('Order("Player 5", "Any unit", "Spawn 1", "Goal", attack)');
    expect(waves.text).toContain('Deaths("Player 5", "Cantina (Unused)", At least, 3);\n\tCommand("Player 5", "Any unit", Exactly, 0);\n\tElapsed Time(At least, 100);');
    expect(() => buildSystems([{ kind: "lives", params: { lives: "1", goal: "Goal" } }, { kind: "waves", params: { spawn: "Spawn 1", goal: "Goal", units: "Zerg Zergling" } }, { kind: "income", params: {} }], ctx)).toThrow(/no death-counter unit left/);
  });

  it("builds the RPG pieces: shop, heal, respawn, give, teleport, kill zone", () => {
    expect(buildSystem("shop", { location: "Shop", unit: "Terran Marine", price: "150", deliver: "Arena" }, ctx).text).toContain('Accumulate("Current Player", At least, 150, ore);\nActions:\n\tSet Resources("Current Player", Subtract, 150, ore);\n\tCreate Unit("Current Player", "Terran Marine", 1, "Arena");\n\tMove Unit("Current Player", "Any unit", All, "Shop", "Arena");');
    expect(buildSystem("heal", { location: "Shop" }, ctx).text).toContain('Modify Unit Hit Points("Current Player", "Any unit", 100, All, "Shop")');
    const r = buildSystem("respawn", { unit: "Jim Raynor (Marine)", location: "Arena", lives: "3" }, ctx);
    expect(r.text).toContain('Deaths("Current Player", "Cave (Unused)", At most, 2)');
    expect(r.text).toContain('Create Unit("Current Player", "Jim Raynor (Marine)", 1, "Arena")');
    expect(buildSystem("give", { location: "Shop", unit: "Terran Marine" }, ctx).text).toContain('Give Units to Player("Player 5", "Current Player", "Terran Marine", All, "Shop")');
    expect(buildSystem("kill-zone", { location: "Goal" }, ctx).text).toContain('Trigger("Player 1", "Player 2", "Player 5"){');
    expect(buildSystem("alliance", { with: "computer", status: "enemy" }, ctx).text).toContain('Set Alliance Status("Player 5", Enemy)');
    expect(buildSystem("auto-attack", { owner: "computer", from: "Anywhere", to: "Arena" }, ctx).text).toContain('Order("Player 5", "Any unit", "Anywhere", "Arena", attack)');
    expect(buildSystem("leaderboard", { kind: "control", unit: "Buildings" }, ctx).text).toContain('Leader Board Control("Units", "Buildings")');
    expect(buildSystem("objectives", { text: "Survive.\\nWin." }, ctx).text).toContain('Set Mission Objectives("Survive.\\nWin.")');
    expect(buildSystem("message", { text: "Go!", after: "5" }, ctx).text).toContain("Elapsed Time(At least, 5)");
  });

  it("converts wire params and picks death-counter units the map has", () => {
    expect(paramsOf([{ key: "a", value: "1" }, { key: "b", value: "x" }])).toEqual({ a: "1", b: "x" });
    expect(dcUnitsFrom(["Terran Marine", "cantina (unused)", "Cave (Unused)"])).toEqual(["Cave (Unused)", "Cantina (Unused)"]);
  });
});
