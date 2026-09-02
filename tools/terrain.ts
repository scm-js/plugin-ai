/** Terrain writes and the map-level transactions. */
import { capResult, num, obj, rectOf, rectSchema, str, type Tool } from "./common";

export function terrainTools(): Tool[] {
  return [
    {
      def: { name: "paint_terrain", description: "Paint a tile rect with a terrain type id (see the reference or list_terrains) using the isometric brush, so cliffs and shores form on their own. Diamonds the tileset cannot join to their neighbours are refused and counted. One undo step.", inputSchema: obj({ ...rectSchema, terrain: { type: "integer" } }, ["x0", "y0", "x1", "y1", "terrain"]) },
      writes: true,
      run: (input, { api }) => {
        const rect = rectOf(input, api);
        const terrain = num(input.terrain);
        const type = api.terrain.types().find((t) => t.id === terrain) ?? api.terrain.types().find((t) => t.name.toLowerCase() === str(input.terrain).toLowerCase());
        if (!type) return `Terrain ${str(input.terrain)} is not one of this tileset's types; see the reference.`;
        const r = api.document.edit(`AI: paint ${type.name}`, (tx) => {
          if (api.terrain.hasIsom() && api.tileset.isLoaded()) {
            let refused = 0;
            for (const d of api.terrain.diamondsIn(rect)) if (!tx.paintIsom(d, type.id, 1)) refused++;
            if (refused) tx.note(`${refused} diamonds refused`);
          } else tx.stampTerrain(rect, type.id);
        });
        return capResult({ changed: r.changed, tiles: r.tiles, isom: r.isom, notes: r.notes });
      },
    },
    {
      def: { name: "resize_map", description: "Scenario ▸ Resize / Crop Map to width × height tiles. `anchor` says where the current content stays: 0 top-left, 1 top, 2 top-right, 3 left, 4 centre (default), 5 right, 6 bottom-left, 7 bottom, 8 bottom-right. Objects outside the new bounds are dropped and the undo history is cleared, so ask before doing this.", inputSchema: obj({ width: { type: "integer" }, height: { type: "integer" }, anchor: { type: "integer" }, terrain: { type: "integer", description: "terrain id for the new ground" } }, ["width", "height"]) },
      writes: true,
      settings: true,
      run: (input, { api }) => {
        const r = api.document.resize({ width: Math.round(num(input.width)), height: Math.round(num(input.height)), anchor: Math.round(num(input.anchor, 4)), terrainId: input.terrain === undefined ? undefined : Math.round(num(input.terrain)) });
        if (!r) return "No map is open.";
        const info = api.document.info();
        return `Resized to ${info?.width} × ${info?.height}. Dropped ${r.unitsDropped} units, ${r.spritesDropped} sprites, ${r.doodadsDropped} doodads; clamped ${r.locationsClamped} locations${r.isomRebuilt ? "" : "; ISOM is the fill's lattice"}. The undo history was cleared.`;
      },
    },
  ];
}
