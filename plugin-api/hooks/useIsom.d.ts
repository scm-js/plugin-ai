import { type IsomCheck } from "../editor/isom";
export { STALE_ISOM_SHARE } from "../editor/isom";
export type IsomStatus = {
    kind: "no-map";
} | {
    kind: "loading";
} | {
    kind: "no-tileset";
}
/** The map has no ISOM section (or a truncated one): the brush has nothing to work on. */
 | {
    kind: "missing";
} | {
    kind: "ready";
    check: IsomCheck;
    stale: boolean;
};
/**
 * Whether the open map can be painted isometrically, and how well its ISOM section
 * describes its tiles. Measured when a map opens (and after a lattice is rebuilt — the
 * Repair plugin's job, through `tx.rebuildIsom`), the way SCMDraft checks on load — not
 * after every stroke.
 */
export declare function useIsomStatus(): IsomStatus;
