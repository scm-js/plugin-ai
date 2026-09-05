/**
 * The assistant's tools: what the model may ask the plugin to do on its behalf. Each
 * has a JSON schema the server forwards and an executor that runs here, in the
 * browser, against the open map. Reads answer JSON; writes go through one
 * `document.edit` (an undo step) or `document.update` (a settings transaction) each
 * with an "AI: …" label. A screenshot answers with an image, so the model can look.
 * The tools live under `tools/` by subject; this is the list.
 */
import { objectTools } from "./tools/objects";
import { readTools } from "./tools/read";
import { scriptTools } from "./tools/script";
import { settingsTools } from "./tools/settings";
import { terrainTools } from "./tools/terrain";
import { triggerTools } from "./tools/triggers";
import { umsTools } from "./tools/ums";
import type { Tool } from "./tools/common";

export { capResult, describeCall, RESULT_CAP, summarizeResult, toContent, type Tool, type ToolResult } from "./tools/common";

export function tools(): Tool[] {
  return [...readTools(), ...terrainTools(), ...objectTools(), ...triggerTools(), ...umsTools(), ...settingsTools(), ...scriptTools()];
}
