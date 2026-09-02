# AI

An experimental plugin for [scmJS](https://github.com/jeany55/scm-js), the browser-based
StarCraft: Brood War map editor. It puts a language model to work on the open map: laying
a map out from a description, redoing one area, writing and explaining triggers, naming
the map, writing a briefing, reviewing the map from a picture, rewriting strings, and an
assistant that edits the map with you through the editor's own tools.

It needs a server. The plugin holds no model key; it talks to an
[ai-server](https://github.com/scm-js/ai-server), which holds the key, the prompts, the
access rules and the budgets. Nothing leaves the browser until you press the button in
one of the dialogs, and every one of them says what it is about to send.

## Setting up

Install the plugin from Plugins ▸ Browse Plugins…, or paste

```
https://github.com/scm-js/plugin-ai
```

into Plugins ▸ Manage Plugins… and press Add. Then open Tools ▸ AI ▸ Settings… and enter
the server's address and either an access token from whoever runs it or your own
Anthropic key. Press Test: the reply says which features the server has on and what you
have left to spend. Both the token and the key are kept in this browser's storage, under
the editor's own keys, and go nowhere but the server you named. A key of your own is
forwarded to Anthropic by the server and not kept there.

The model and effort can be left to the server's defaults. Effort trades thoroughness for
time and money; the features that lay out maps and write triggers default to high, the
rest to low or medium.

## What each item does

All of them are under Tools ▸ AI. Every change to the map is one undo step with an
"AI: …" label, except the ones that write the tables the settings dialogs write
(properties, strings, triggers, players, unit settings …), which say so and are not in
the undo model, as in StarEdit.

**Generate Map…** describes a map and gets a plan back: a coarse grid of terrain types,
the bases with their mineral lines, ramps, decoration, a name and a description. The
dialog shows the plan as a coloured grid with the designer's notes before anything is
painted. Apply renders it — the isometric brush per lattice diamond, lowest ground
first, so cliffs and shores draw themselves; bases laid out the way the Melee Wizard lays
them; doodads scattered on the cells the plan names — onto a new map, made first so the
model can be told which terrains the tileset has, or onto the open map when it is the
same size. Afterwards, Refine sends the plan back with what you want changed, a picture
of the result and everything the editor refused or found wrong, and the revised plan
replaces the applied one. Ramps come as doodads chosen by footprint, since the tilesets
give them no direction of their own; check them against the cliffs.

**Redo Area…** does the same for one rectangle: the marked area, a right-click on it, or
a drag on the map. The model sees the area and a margin round it as it is now, plus a
picture, so the edges join.

**Write Triggers…** turns a description into a trigger script in the editor's own
language (see `docs/trigger-script.md` in the editor). The model is given this map's
declarations, so it can name every unit, location and switch as the map calls them. The
script is compiled here; if it does not compile, the compiler's complaints go back for up
to two repair rounds. Build installs it exactly as the Script Editor's Build does, and the
source stays with the map. It can extend the map's current script or replace every
trigger with the script.

**Explain Triggers…** walks through what the triggers (or a range of them, or the
briefing) do in play, or answers a question about them. The text streams as it is
written.

**Name and Describe…** offers three name and description pairs from the map's facts;
pick one and it goes into Map Properties.

**Write Briefing…** writes objectives and narration and puts them into one mission
briefing trigger for every player: the objectives as a Mission Objectives action, each
line as a Text Message. Edit the text before writing it.

**Review Map…** sends a picture of the map with its statistics and what Check Map says,
and shows a critique with a list of findings; the ones that point somewhere have a Go to
button.

**Rewrite Strings…** takes an instruction — translate, fix spelling, shorten, retone — over
the strings in use, or only the trigger text, the briefing, or the names, and shows a
before-and-after table with a tick per row. Apply writes the ticked rows back in place,
never renumbering, so triggers keep pointing at the same strings.

**Assistant** (Ctrl+Shift+A) is a panel beside the map. Say what you want to know or
change; the model reads the map through tools and changes it through others. It can
read everything: the map's facts and statistics, units (with every record field), doodads,
sprites, locations, strings, switches, sounds, the triggers as text, the trigger script and
its declarations, the settings of any unit type, upgrade or technology, the fog, a coarse
terrain grid or one tile, Check Map, a screenshot of any area, and what you have selected.
It can change nearly everything the editor can: paint terrain, place / move / remove /
edit units, doodads and sprites, add / edit / remove locations, fog, the map's name and
description, triggers (append, replace, remove, reorder, preserve), strings, switch names,
the script (compile and build), player types / races / colours / forces, unit, upgrade and
technology settings, the sound table, the map revision, and the map's size. Every tool
call shows as a row in the transcript with its result on hover, screenshots inline; each
edit is its own undo step, and a settings change is a transaction outside undo, as in
StarEdit, marked so in the row. After a turn that changed the map the panel says what
changed and offers to undo that turn's edits in one press.

With every message the model gets the map's current state — the players, counts,
locations, what you have selected or marked, where the view is, the top of the undo stack
— and, once per map, a reference block: the tileset's terrains, the doodads, the unit
table with sizes, costs and weapons, the trigger vocabulary with every argument's values,
the text trigger format and the script language. The server caches it, so the second
message costs little more than the words you typed. Right-click on the map and choose
*Ask AI about this…* to start a message about the spot, the marked area or the selection;
the chips above the input hold the usual questions. The picture tick sends a screenshot of
the visible area with the message. It stops after the rounds of tool calls the Settings
allow (24 by default) and offers to continue.

## Costs

Every dialog shows the model, how long it has been waiting, and once the answer is back
what it cost and what the session has cost so far. Roughly, at the server's default
model: a map plan is a few tens of cents, a trigger script and a review about the same, a
name or a translation a few cents. The server's operator sets the allowances; the
Settings dialog's Test shows what you have left.

## Files

- `plugin.ts` — activation: the menu, the context-menu item, the hotkey, the commands.
- `protocol.ts` — the wire contract shared with the server, copied verbatim from
  ai-server; keep the two identical.
- `client.ts` — the server client: recipes over server-sent events, errors, the ledger.
- `settings.ts` — the persisted settings and the Settings dialog.
- `facts.ts` — what the fact-based features tell the model about the map, and the
  assistant's selection / view / history lines.
- `reference.ts` — the per-map reference block the assistant's server caches.
- `grid.ts`, `plan.ts` — the layout language: sampling the map into it and checking,
  mirroring and laying out a plan, all pure and tested.
- `layout.ts` — the Melee Wizard's base and symmetry geometry, vendored.
- `render.ts` — a plan onto the map as one transaction.
- `tools.ts`, `tools/` — the assistant's tools by subject (reads, terrain, objects,
  triggers, settings, script); `assistant.ts` — its panel.
- `markdown.ts` — a small renderer for the model's prose.
- `dialogs/` — one file per menu item.
- `plugin-api/` — the editor's emitted type declarations, so this repository type-checks
  alone (`npm run typecheck`); `npm test` runs the tests under `tests/`.
