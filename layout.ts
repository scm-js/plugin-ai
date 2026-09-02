/**
 * The pure part of the Melee Wizard: where the resources of a base go, and where the
 * mirror images of anything fall under a map's symmetry. Nothing here touches the
 * editor; `plugin.ts` turns what comes back into units through `api.document.edit`.
 *
 * Units of measure: a *tile* is 32 map pixels. Rectangles here are in tiles with an
 * exclusive far edge; unit positions are the pixel centres of those rectangles, which
 * is what a UNIT record stores.
 *
 * The one rule everything else follows: the game refuses a resource depot within three
 * tiles of a mineral field or geyser — the *gap*, measured as the larger of the empty
 * columns and the empty rows between the two footprints (Chebyshev) — and mining is
 * fastest when the gap is exactly that. So a mineral line is a set of 2 × 1 patches on
 * the ring of positions whose gap to the town hall's 4 × 3 footprint is exactly three,
 * spread around the direction the map maker points, wrapping round the hall's corners
 * the way the lines on Blizzard's own maps do; the geyser is a 4 × 2 box on the same
 * ring, just past one end of the line.
 *
 * Vendored from github.com/scm-js/plugin-melee-wizard (layout.ts, MIT) so this plugin lays
 * bases and mirrors plans the same way; keep it identical to the original.
 */

export const TILE = 32;

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  w: number;
  h: number;
}

/** A footprint in tiles, far edges exclusive. */
export interface TileRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** units.dat placement boxes, in tiles. */
export const HALL: Size = { w: 4, h: 3 };
export const MINERAL: Size = { w: 2, h: 1 };
export const GEYSER: Size = { w: 4, h: 2 };

/** units.dat ids. */
export const START_LOCATION = 214;
export const MINERAL_FIELDS = [176, 177, 178] as const;
export const VESPENE_GEYSER = 188;
/** The neutral player, who owns every resource on a melee map. */
export const NEUTRAL = 11;

export const DEFAULT_MINERALS = 1500;
export const DEFAULT_GAS = 5000;

/* ── Rectangles ─────────────────────────────────────────── */

export function overlaps(a: TileRect, b: TileRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * The gap between two footprints as the game measures it for resource placement: the
 * larger of the empty columns and the empty rows between them; -1 when they overlap.
 */
export function chebGap(a: TileRect, b: TileRect): number {
  const gx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
  const gy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
  if (gx < 0 && gy < 0) return -1;
  return Math.max(gx, gy);
}

/** The pixel centre of a footprint: what a UNIT record stores for it. */
export function centreOf(r: TileRect): Point {
  return { x: (r.x + r.w / 2) * TILE, y: (r.y + r.h / 2) * TILE };
}

/**
 * The footprint of a `size` box whose centre is nearest to a pixel, snapped to the tile
 * grid. A centre exactly between two grid positions — a 4 × 3 hall's image under a
 * rotation by 90° — takes the one nearer `toward` (the map's centre), so the two
 * quarter-turn images stay exact half-turn images of each other; without `toward`, the
 * plain rounding.
 */
export function rectAt(px: number, py: number, size: Size, toward?: Point): TileRect {
  const axis = (p: number, n: number, c: number | undefined) => {
    const v = p / TILE - n / 2;
    if (c === undefined || Math.abs(v - Math.floor(v) - 0.5) > 1e-9) return Math.round(v);
    const lo = Math.floor(v);
    const hi = lo + 1;
    return Math.abs((lo + n / 2) * TILE - c) <= Math.abs((hi + n / 2) * TILE - c) ? lo : hi;
  };
  return { x: axis(px, size.w, toward?.x), y: axis(py, size.h, toward?.y), w: size.w, h: size.h };
}

export function inMap(r: TileRect, width: number, height: number): boolean {
  return r.x >= 0 && r.y >= 0 && r.x + r.w <= width && r.y + r.h <= height;
}

/* ── Angles ─────────────────────────────────────────────── */

/** The signed difference `a - b` folded into (-π, π]. */
export function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d <= -Math.PI) d += Math.PI * 2;
  while (d > Math.PI) d -= Math.PI * 2;
  return d;
}

/** The direction from a hall's centre to a footprint's centre. Screen coordinates: 0 is east, π/2 south. */
export function angleOf(hall: TileRect, r: TileRect): number {
  const h = centreOf(hall);
  const c = centreOf(r);
  return Math.atan2(c.y - h.y, c.x - h.x);
}

/** Snap a direction to the nearest multiple of 45°. */
export function snapAngle(angle: number): number {
  const step = Math.PI / 4;
  return Math.round(angle / step) * step;
}

/* ── The ring ───────────────────────────────────────────── */

/**
 * Every tile position of a `size` box whose gap to `hall` is exactly `gap`, in order of
 * angle around the hall's centre.
 */
export function ringPositions(hall: TileRect, size: Size, gap: number): TileRect[] {
  const out: TileRect[] = [];
  for (let y = hall.y - gap - size.h; y <= hall.y + hall.h + gap; y++) {
    for (let x = hall.x - gap - size.w; x <= hall.x + hall.w + gap; x++) {
      const r = { x, y, w: size.w, h: size.h };
      if (chebGap(r, hall) === gap) out.push(r);
    }
  }
  return out.sort((a, b) => angleOf(hall, a) - angleOf(hall, b));
}

export type GeyserSide = "auto" | "left" | "right";

export interface BaseSpec {
  /** How many mineral patches. */
  minerals: number;
  /** 0, 1 or 2 geysers. */
  geysers: number;
  /** Tiles between the hall and the patches; 3 is the game's minimum and the fastest mining. */
  gap: number;
  /** Tiles between the hall and the geyser. */
  geyserGap: number;
  /** Tiles kept between the geyser and the nearest patch. */
  geyserSpacing: number;
  /** Which end of the line the geyser goes on, seen from the hall looking at the minerals; `auto` takes the nearer. */
  geyserSide: GeyserSide;
  /** Where the line goes, from the hall's centre; screen angle, 0 east, π/2 south. */
  direction: number;
}

export const DEFAULT_SPEC: BaseSpec = { minerals: 8, geysers: 1, gap: 3, geyserGap: 3, geyserSpacing: 1, geyserSide: "auto", direction: Math.PI };

export interface BaseLayout {
  hall: TileRect;
  /** In line order, from the left end to the right end as seen from the hall. */
  minerals: TileRect[];
  geysers: TileRect[];
  /** What could not be placed: patches or geysers the ring had no room for. */
  short: { minerals: number; geysers: number };
}

/**
 * Lay a base out around a hall footprint. Patches go on the ring at `gap`, starting
 * with the position nearest the direction and growing along the ring to either side,
 * always taking the side that keeps the line centred on the direction; positions along
 * the hall's top and bottom step by a patch width, positions along its sides by a row,
 * so the line wraps round a corner on its own. A geyser then goes on its ring past the
 * end of the line on the chosen side, keeping `geyserSpacing` from every patch; two
 * geysers take one end each.
 */
export function layoutBase(hall: TileRect, spec: BaseSpec): BaseLayout {
  const ring = ringPositions(hall, MINERAL, spec.gap);
  const n = ring.length;
  const minerals: TileRect[] = [];
  const short = { minerals: 0, geysers: 0 };
  let leftEnd = spec.direction;
  let rightEnd = spec.direction;
  if (n > 0 && spec.minerals > 0) {
    const angles = ring.map((r) => angleOf(hall, r));
    let i0 = 0;
    for (let i = 1; i < n; i++) if (Math.abs(angleDiff(angles[i], spec.direction)) < Math.abs(angleDiff(angles[i0], spec.direction))) i0 = i;
    const used = new Set<number>([i0]);
    minerals.push(ring[i0]);
    const free = (i: number) => minerals.every((m) => !overlaps(m, ring[i]));
    let left = i0;
    let right = i0;
    // Left is the way of decreasing angle, right increasing; both walk the ring cyclically.
    const nextLeft = () => { for (let k = 1; k < n; k++) { const i = (left - k + n) % n; if (used.has(i)) return -1; if (free(i)) return i; } return -1; };
    const nextRight = () => { for (let k = 1; k < n; k++) { const i = (right + k) % n; if (used.has(i)) return -1; if (free(i)) return i; } return -1; };
    while (minerals.length < spec.minerals) {
      const l = nextLeft();
      const r = nextRight();
      if (l < 0 && r < 0) break;
      const dl = l < 0 ? Infinity : Math.abs(angleDiff(angles[l], spec.direction));
      const dr = r < 0 ? Infinity : Math.abs(angleDiff(angles[r], spec.direction));
      if (dl <= dr) { minerals.unshift(ring[l]); used.add(l); left = l; } else { minerals.push(ring[r]); used.add(r); right = r; }
    }
    short.minerals = spec.minerals - minerals.length;
    leftEnd = angles[left];
    rightEnd = angles[right];
  } else {
    short.minerals = spec.minerals;
  }

  const geysers: TileRect[] = [];
  if (spec.geysers > 0) {
    const gring = ringPositions(hall, GEYSER, spec.geyserGap);
    const clear = (g: TileRect) => minerals.every((m) => chebGap(m, g) >= spec.geyserSpacing) && geysers.every((o) => chebGap(o, g) >= 1);
    // The nearest clear position past an end of the line on a given side.
    const pastEnd = (side: "left" | "right"): TileRect | null => {
      let best: TileRect | null = null;
      let bestD = Infinity;
      for (const g of gring) {
        if (!clear(g)) continue;
        const d = side === "left" ? -angleDiff(angleOf(hall, g), leftEnd) : angleDiff(angleOf(hall, g), rightEnd);
        if (d < 0) continue;
        if (d < bestD) { bestD = d; best = g; }
      }
      return best;
    };
    const sides: ("left" | "right")[] = spec.geysers >= 2 ? ["left", "right"] : spec.geyserSide === "auto" ? [] : [spec.geyserSide];
    if (spec.geysers === 1 && spec.geyserSide === "auto") {
      const l = pastEnd("left");
      const r = pastEnd("right");
      const dl = l ? Math.abs(angleDiff(angleOf(hall, l), spec.direction)) : Infinity;
      const dr = r ? Math.abs(angleDiff(angleOf(hall, r), spec.direction)) : Infinity;
      const pick = dl < dr ? l : r;
      if (pick) geysers.push(pick);
    } else {
      for (const side of sides) {
        const g = pastEnd(side);
        if (g) geysers.push(g);
      }
    }
    short.geysers = spec.geysers - geysers.length;
  }
  return { hall, minerals, geysers, short };
}

/** The direction from a map's centre to a point: where a main's minerals usually go (against the back of the base). */
export function outwardDirection(px: number, py: number, width: number, height: number): number {
  const cx = (width * TILE) / 2;
  const cy = (height * TILE) / 2;
  const dx = px - cx;
  const dy = py - cy;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return Math.PI;
  return Math.atan2(dy, dx);
}

/* ── Symmetry ───────────────────────────────────────────── */

export type SymmetryMode = "none" | "mirror-x" | "mirror-y" | "rot180" | "rot90" | "diag" | "antidiag" | "quad" | "octo";

export interface SymmetryInfo {
  id: SymmetryMode;
  label: string;
  /** How many images, the identity included. */
  players: number;
  /** Needs a square map. */
  square: boolean;
}

export const SYMMETRIES: SymmetryInfo[] = [
  { id: "none", label: "None (one player)", players: 1, square: false },
  { id: "mirror-x", label: "Mirror left ↔ right (2)", players: 2, square: false },
  { id: "mirror-y", label: "Mirror top ↔ bottom (2)", players: 2, square: false },
  { id: "rot180", label: "Rotate 180° (2)", players: 2, square: false },
  { id: "diag", label: "Mirror on the diagonal (2, square)", players: 2, square: true },
  { id: "antidiag", label: "Mirror on the other diagonal (2, square)", players: 2, square: true },
  { id: "rot90", label: "Rotate 90° (4, square)", players: 4, square: true },
  { id: "quad", label: "Mirror both ways (4)", players: 4, square: false },
  { id: "octo", label: "Mirror both ways and both diagonals (8, square)", players: 8, square: true },
];

export function symmetryInfo(mode: SymmetryMode): SymmetryInfo {
  return SYMMETRIES.find((s) => s.id === mode) ?? SYMMETRIES[0];
}

export function symmetryAvailable(mode: SymmetryMode, width: number, height: number): boolean {
  return !symmetryInfo(mode).square || width === height;
}

export type PointMap = (p: Point) => Point;

/**
 * The images of a map pixel under a symmetry, the identity first, in player order: the
 * second image is the one furthest from the first (across the map), so a 2-of-4 game
 * on a 4-player layout still puts the players opposite each other. `W` and `H` are the
 * map's size in pixels.
 */
export function symmetryImages(mode: SymmetryMode, W: number, H: number): PointMap[] {
  const id: PointMap = (p) => ({ x: p.x, y: p.y });
  const mx: PointMap = (p) => ({ x: W - p.x, y: p.y });
  const my: PointMap = (p) => ({ x: p.x, y: H - p.y });
  const r180: PointMap = (p) => ({ x: W - p.x, y: H - p.y });
  const r90: PointMap = (p) => ({ x: W - p.y, y: p.x });
  const r270: PointMap = (p) => ({ x: p.y, y: H - p.x });
  const dg: PointMap = (p) => ({ x: p.y, y: p.x });
  const adg: PointMap = (p) => ({ x: W - p.y, y: H - p.x });
  switch (mode) {
    case "none": return [id];
    case "mirror-x": return [id, mx];
    case "mirror-y": return [id, my];
    case "rot180": return [id, r180];
    case "diag": return [id, dg];
    case "antidiag": return [id, adg];
    case "rot90": return [id, r180, r90, r270];
    case "quad": return [id, r180, mx, my];
    case "octo": return [id, r180, mx, my, dg, adg, r90, r270];
  }
}

/** A footprint's images: its centre is mapped and the box snapped back to the grid (exact for mirrors and rotations by 180°; a half-tile goes `toward` the map's centre otherwise). */
export function rectImages(r: TileRect, images: PointMap[], toward?: Point): TileRect[] {
  const c = centreOf(r);
  return images.map((f) => { const p = f(c); return rectAt(p.x, p.y, { w: r.w, h: r.h }, toward); });
}

/** The axes a symmetry mirrors across, as pixel line segments, for drawing. */
export function symmetryAxes(mode: SymmetryMode, W: number, H: number): [Point, Point][] {
  const v: [Point, Point] = [{ x: W / 2, y: 0 }, { x: W / 2, y: H }];
  const hz: [Point, Point] = [{ x: 0, y: H / 2 }, { x: W, y: H / 2 }];
  const d: [Point, Point] = [{ x: 0, y: 0 }, { x: W, y: H }];
  const ad: [Point, Point] = [{ x: W, y: 0 }, { x: 0, y: H }];
  switch (mode) {
    case "none": return [];
    case "mirror-x": return [v];
    case "mirror-y": return [hz];
    case "rot180": return [];
    case "rot90": return [];
    case "diag": return [d];
    case "antidiag": return [ad];
    case "quad": return [v, hz];
    case "octo": return [v, hz, d, ad];
  }
}

/* ── Whole bases and their images ───────────────────────── */

export interface PlacedResource {
  unitId: number;
  rect: TileRect;
  amount: number;
}

export interface BaseUnits {
  /** The image's index: 0 is the base as laid out, 1… its mirror images. */
  image: number;
  hall: TileRect;
  /** The layout behind the resources: the original's, or a fresh one for an image that swaps the axes. */
  layout: BaseLayout;
  resources: PlacedResource[];
}

export type MineralLook = "mixed" | 0 | 1 | 2;

export interface ResourceValues {
  minerals: number;
  gas: number;
  /** A different amount for the outermost patch at each end, or null for the same as the rest. */
  endPatches: number | null;
  look: MineralLook;
}

export const DEFAULT_VALUES: ResourceValues = { minerals: DEFAULT_MINERALS, gas: DEFAULT_GAS, endPatches: null, look: "mixed" };

/** The resources of a laid-out base as unit types with amounts, in line order. */
export function baseResources(layout: BaseLayout, values: ResourceValues): PlacedResource[] {
  const out: PlacedResource[] = [];
  const n = layout.minerals.length;
  layout.minerals.forEach((rect, i) => {
    const end = i === 0 || i === n - 1;
    const amount = end && values.endPatches !== null ? values.endPatches : values.minerals;
    const unitId = values.look === "mixed" ? MINERAL_FIELDS[i % 3] : MINERAL_FIELDS[values.look];
    out.push({ unitId, rect, amount });
  });
  for (const rect of layout.geysers) out.push({ unitId: VESPENE_GEYSER, rect, amount: values.gas });
  return out;
}

/** Whether an image turns rows into columns (a rotation by 90° or a diagonal mirror), so a 2 × 1 patch's image would be 1 × 2. */
export function swapsAxes(f: PointMap): boolean {
  const o = f({ x: 1000, y: 1000 });
  const p = f({ x: 1100, y: 1000 });
  return Math.abs(p.y - o.y) > Math.abs(p.x - o.x);
}

/**
 * A base and its images under a symmetry. Under a mirror or a rotation by 180° every
 * resource's footprint is mapped and lands on the grid exactly. Under an image that
 * swaps the axes a patch's footprint would turn on its side, so the base is laid out
 * again round the hall's image with the direction's image — the same line, as close
 * as 2 × 1 patches can come to it.
 */
export function baseImages(hall: TileRect, spec: BaseSpec, values: ResourceValues, images: PointMap[], toward?: Point): BaseUnits[] {
  const layout = layoutBase(hall, spec);
  const resources = baseResources(layout, values);
  const c = centreOf(hall);
  return images.map((f, image) => {
    const hallImage = rectImages(hall, [f], toward)[0];
    if (image > 0 && swapsAxes(f)) {
      const o = f(c);
      const d = f({ x: c.x + 100 * Math.cos(spec.direction), y: c.y + 100 * Math.sin(spec.direction) });
      const turned = layoutBase(hallImage, { ...spec, direction: Math.atan2(d.y - o.y, d.x - o.x) });
      return { image, hall: hallImage, layout: turned, resources: baseResources(turned, values) };
    }
    return { image, hall: hallImage, layout, resources: resources.map((r) => ({ ...r, rect: rectImages(r.rect, [f], toward)[0] })) };
  });
}

/* ── Symmetry checks ────────────────────────────────────── */

/** Whether a unit type is a mineral field or a geyser. */
export function isResource(unitId: number): boolean {
  return (MINERAL_FIELDS as readonly number[]).includes(unitId) || unitId === VESPENE_GEYSER;
}

/** The same kind of unit: equal ids, except that the three mineral field types are one kind. */
export function sameKind(a: number, b: number): boolean {
  if (a === b) return true;
  const minerals = MINERAL_FIELDS as readonly number[];
  return minerals.includes(a) && minerals.includes(b);
}

export interface Placed {
  index: number;
  unitId: number;
  owner: number;
  x: number;
  y: number;
}

/**
 * Units with no counterpart under the symmetry: for every unit and every image, a unit
 * of the same kind (the three mineral field types count as one) must sit within `tolerance` pixels of the image's position (a number,
 * or a function of the unit and the image — a mineral line laid out again under a
 * rotation by 90° deserves more slack than a mirrored one). Start
 * locations may belong to different players; everything else must match owners through
 * `ownerImage` (a player's slot under the image, or the same slot for the neutral and
 * unassigned ones).
 */
export function symmetryGaps(units: Placed[], images: PointMap[], ownerImage: (owner: number, image: number) => number, tolerance: number | ((unit: Placed, image: number) => number) = 16): { index: number; image: number }[] {
  const out: { index: number; image: number }[] = [];
  for (const u of units) {
    for (let k = 1; k < images.length; k++) {
      const p = images[k]({ x: u.x, y: u.y });
      const owner = u.unitId === START_LOCATION ? -1 : ownerImage(u.owner, k);
      const tol = typeof tolerance === "function" ? tolerance(u, k) : tolerance;
      const found = units.some((v) => sameKind(v.unitId, u.unitId) && (owner < 0 || v.owner === owner) && Math.abs(v.x - p.x) <= tol && Math.abs(v.y - p.y) <= tol);
      if (!found) out.push({ index: u.index, image: k });
    }
  }
  return out;
}

/** A summary of a player's resources near a start location: patches, their total, geysers. */
export interface BaseSummary {
  owner: number;
  x: number;
  y: number;
  patches: number;
  mineralTotal: number;
  geysers: number;
}

/** Resources within `radius` pixels of each start location. */

export function summarizeBases(units: Placed[], amounts: (index: number) => number, radius = 12 * TILE): BaseSummary[] {
  const starts = units.filter((u) => u.unitId === START_LOCATION);
  return starts.map((s) => {
    let patches = 0;
    let mineralTotal = 0;
    let geysers = 0;
    for (const u of units) {
      if (Math.abs(u.x - s.x) > radius || Math.abs(u.y - s.y) > radius) continue;
      if ((MINERAL_FIELDS as readonly number[]).includes(u.unitId)) { patches++; mineralTotal += amounts(u.index); }
      else if (u.unitId === VESPENE_GEYSER) geysers++;
    }
    return { owner: s.owner, x: s.x, y: s.y, patches, mineralTotal, geysers };
  });
}
