import { describe, expect, it } from "vitest";
import { byName, capResult, colorIndexOf, describeCall, ownerName, ownerOf, slotOf, summarizeResult } from "../tools/common";

describe("tool helpers", () => {
  it("maps 1-based tool players to 0-based owners and back", () => {
    expect(ownerOf(1)).toBe(0);
    expect(ownerOf(8)).toBe(7);
    expect(ownerOf(12)).toBe(11);
    expect(ownerOf("neutral")).toBe(11);
    expect(ownerOf(undefined, 3)).toBe(3);
    expect(ownerName(0)).toBe("Player 1");
    expect(ownerName(11)).toBe("Neutral");
    expect(slotOf(1)).toBe(0);
    expect(slotOf("default")).toBe("default");
    expect(slotOf(13)).toBeNull();
    expect(slotOf(undefined)).toBeNull();
  });

  it("matches names loosely: exact, unique prefix, substring, or an id", () => {
    const items = [{ value: 0, label: "Terran Marine" }, { value: 1, label: "Terran Ghost" }, { value: 7, label: "Terran SCV" }, { value: 37, label: "Zerg Zergling" }];
    expect(byName(items, "terran marine")?.value).toBe(0);
    expect(byName(items, "Zerg Z")?.value).toBe(37);
    expect(byName(items, "ghost")?.value).toBe(1);
    expect(byName(items, "7")?.value).toBe(7);
    expect(byName(items, "Terran")?.value).toBe(0); // several: the first substring hit
    expect(byName(items, "")).toBeNull();
    expect(byName(items, "protoss")).toBeNull();
  });

  it("reads colours by name or index", () => {
    expect(colorIndexOf("Red")).toBe(0);
    expect(colorIndexOf("teal")).toBe(2);
    expect(colorIndexOf(5)).toBe(5);
    expect(colorIndexOf("9")).toBe(9);
    expect(colorIndexOf("mauve")).toBeNull();
  });

  it("caps results and describes calls for the transcript", () => {
    expect(capResult("short")).toBe("short");
    expect(capResult("x".repeat(20), 10)).toContain("… cut: 10 more characters");
    const call = describeCall("place_units", { units: [1, 2], name: "a very long name that goes on and on and on and on", n: 3, o: { a: 1 } });
    expect(call.startsWith('place_units(units=[2], name="a very long name')).toBe(true);
    expect(call.endsWith('…", n=3, o={…})')).toBe(true);
    expect(summarizeResult("Placed 3.\nmore")).toBe("Placed 3.");
    expect(summarizeResult({ image: { mediaType: "image/png", data: "AA" } })).toBe("(picture)");
  });
});
