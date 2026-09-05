/**
 * Genre guides: what a madness map, a defense, an RPG, a bound *is* — how it plays, how
 * its players and forces are set up, which systems it runs on, what goes wrong — written
 * once here rather than rediscovered by the model on every request. They are fetched by
 * the assistant's `guide` tool when a conversation turns to a genre, and the Scenario
 * workflow sends the matching one with the design request; neither puts them in the
 * cached prefix, so a guide costs tokens only when it is read. The system kinds they name
 * are the toolkit's (`ums.ts`), so a guide is also the worked example of the toolkit.
 */

export interface Guide {
  id: string;
  title: string;
  /** Words in a prompt that point at this guide. */
  keywords: string[];
  text: string;
}

const BASICS = `# Scenario basics (UMS)

**Players.** Slots 1–8 are the game's players; slot 12 is neutral (resources, critters, props). A *Human* slot is a person; a *Computer* slot owns what the triggers create for the enemy or the shop; *Rescuable* units join whoever touches them; *Neutral* units belong to nobody. Every human needs a start location. The game's AI does nothing for a computer slot in a scenario unless a trigger runs an AI script — which is usually what you want: the triggers are the AI.

**Forces.** Four. Players in one force can be allied (they do not attack each other), share victory (one wins, all win) and share vision. A team of humans is one force with Allied Victory; the enemy computer is another force. Force names are shown in the lobby.

**Triggers.** Each trigger has conditions (all must hold), actions (run in order) and a player list (it runs once *per player* it is listed for, with "Current Player" meaning that player). A trigger fires once, then never again, unless it has Preserve Trigger. The list runs top to bottom about every two seconds; with *hyper triggers* — a preserved trigger of ~62 Wait(0) actions, kept in three copies — it runs about twelve times a second, which is what makes spawns, timers and reactions feel instant. A Wait inside any *other* preserved trigger stalls that player's whole trigger queue, hyper triggers included: time with death counters instead.

**Death counters.** Deaths(player, unit) is the game's counter per player per unit type, and Set Deaths writes it — so a unit that is never placed ("Cave (Unused)", "Cantina (Unused)", the Markers) is a free integer variable per player. Timers: add 1 every cycle, act when it reaches N, set it to 0. Twelve cycles a second with hypers, one every two seconds without.

**Switches.** 256 booleans shared by everyone. Good for one-off flags ("boss spawned"), poor for anything counted.

**Locations.** Named rectangles (254 of them, Anywhere is the whole map). Bring(player, unit, location) is how a map sees where a unit is; Create Unit, Move Unit, Kill Unit At Location, Order all take one. Make locations a little larger than the thing they watch. A location can exclude heights (ground / air) so a flier overhead does not trigger a ground beacon.

**Resources and score.** Set Resources adds minerals or gas; Accumulate tests them. Kill score (Score … Kills) grows by roughly a unit's cost per kill and can be subtracted from, which is how "kill to cash" is paid. Leaderboards show kills, control, resources or points.

**Ending the game.** Nothing ends a scenario by itself. Victory and Defeat are actions; the melee rule "no buildings, you lose" does not apply. Every human needs a path to each. Opponents(Current Player, Exactly, 0) is true when every non-allied player is gone or defeated — the usual last-standing victory.

**Limits.** 1700 units on the map at once (Create Unit silently fails past it); 65535 strings in a Brood War map; 254 locations; text messages of a few hundred characters; a Wait longer than ~2 minutes is a bad idea. Units created on unwalkable ground or on top of a building are placed at the nearest free spot, or not at all when the location is packed.

**Text.** Display Text Message shows a line at the top left; Set Mission Objectives fills the objectives box (F10 ▸ Objectives). Colour codes are bytes below 0x20 in the string (the editor's string fields have a picker).`;

const MADNESS = `# Madness maps

A *madness* map is a symmetric free-for-all where the map spawns each player's army for them and the armies fight on their own. The player's job is to spend what they earn on the right things and to pick the moment to push.

**Layout.** One base per player, each a small walled plateau or corner with its hall (or a beacon that stands for it) and its *spawn location* beside it, all opening onto a common arena in the middle. Distances equal; the arena open; no resources to mine.

**Players.** One human per base; one computer slot for props if any; humans each in their own force (or two forces for a team game with Allied Victory). All humans start hostile to each other.

**Systems (toolkit kinds).**
- \`hyper\`, always.
- \`spawn\`: a unit every few seconds at \`Spawn {p}\`, owned by the player (\`owner: each\`), with \`attack\` set to the arena so the units go and fight. Several spawn systems for several unit types; \`limit\` keeps the unit count under control.
- \`auto-attack\` on each player's units from Anywhere to the arena keeps stragglers moving.
- \`kill-to-cash\` or \`income\` so there is something to spend; unit and upgrade costs go through Unit Settings.
- \`last-standing\` with \`unit: Buildings\` (the hall is the life) or a hero unit.
- \`leaderboard\` kills, \`objectives\`.

**Pitfalls.** Spawns without a limit hit the 1700-unit cap in minutes and the game stops creating units for everyone. A base with two exits is a base that dies to a flank; one ramp. Spawned units that are not ordered sit at the spawn until attacked.`;

const DEFENSE = `# Defense and tower defense

Waves of enemy units walk from a spawn to a goal; the players kill them on the way. In a *tower defense* the players build static defence (turrets, cannons, sunkens) along a lane and cannot fight themselves; in a *hero defense* they control units.

**Layout.** A lane from a spawn location to a goal location — a corridor of unbuildable ground with buildable strips beside it for towers, or a maze. The goal is a small location the enemies path into. Players start beside the lane with a builder each and no minerals to mine.

**Players.** Humans in one force with Allied Victory and shared vision; one computer as the enemy, hostile to all; its units must be ordered, or they stand at the spawn.

**Systems.**
- \`hyper\`.
- \`waves\`: units by wave, count and growth, interval, spawn and goal; the last wave cleared is the victory.
- \`lives\`: a leak (an enemy reaching the goal) is removed and costs a shared life; zero lives is defeat.
- \`kill-to-cash\` for the bounty (\`scorePerKill\` ≈ the enemy unit's cost, so a Zergling pays half a Hydralisk).
- \`income\` per wave or per tower (\`perUnit\`) if the map wants a steady economy.
- \`leaderboard\` kills, \`objectives\`, \`message\` for the first wave.

**Pitfalls.** Towers on the lane block it and the wave stops: make the lane unbuildable. Bounty through kill score pays in lumps of \`scorePerKill\`; set it to the cheapest enemy's score. A wave stronger than the towers ends the game in one leak — give lives.`;

const RPG = `# RPG maps

Each player controls a hero (a named unit, or an ordinary unit with Unit Settings) through a world of quests, shops and bosses. Progression is minerals from kills spent at shops, upgrades bought at beacons, and story told by text.

**Layout.** A town (start locations, a heal spot, shops as beacon locations, a save/teleport gate) and regions of rising difficulty joined by paths; a boss room at the end. Enemy units are placed by hand (they belong to the computer) or spawned in regions when a player enters. Locations: the town, each shop's beacon, each region, each boss room, teleport pairs.

**Players.** Humans in one force, allied, shared vision, Allied Victory. The computer owns the enemies and the shopkeepers; a *rescuable* slot for units that join when found.

**Systems.**
- \`hyper\`.
- \`kill-to-cash\` for the economy; \`shop\` per item (bring the hero to the beacon with the price; \`deliver\` next to the shop); \`heal\` in the town.
- \`respawn\` for the hero (with \`lives\`, or unlimited), or \`defeat-when-lost\` for permadeath.
- \`spawn\` with \`owner: computer\` in a region for monsters that keep coming; \`give\` for a rescued companion; \`teleport\` between the town and the regions.
- \`message\` on entering a region (\`location\`) for the story; \`objectives\`.
- Victory: \`victory-on-kills\` of the boss unit (\`unit: <the boss>\`, \`count: 1\`), or a custom system for a staged fight.

**Pitfalls.** Heroes need Unit Settings (hit points, damage) to survive at all; the default marine dies to two zerglings. A shop beacon inside the walking path buys by accident — set it off the path. Enemies placed by hand for the computer stand still unless the computer runs an AI script or a trigger orders them: \`auto-attack\` from a region to the town is the simplest guard behaviour.`;

const BOUND = `# Bound maps

A *bound* is an obstacle course: a narrow path of explosions (usually Scourge, Scarabs or nukes killed on the tiles) the player's unit must run through with the right timing, with checkpoints to respawn at. Pure timing and pattern; no economy.

**Layout.** A winding path one to three tiles wide, high ground or platform, walled by unwalkable terrain, with a checkpoint location every so often and a finish location at the end. Each explosion spot is a location; a level is a set of them fired in a repeating sequence.

**Players.** Humans each with one unit (a Zergling, a fast Terran unit), in one force or none; a computer owns the explosion units. Lives per player.

**Systems.**
- \`hyper\`, essential: the timing is the game.
- Obstacle sequences are *custom*: each is a death-counter timer that cycles through the spots, creating a unit at a spot for the computer and killing it there (Create Unit + Kill Unit At Location) a fraction of a second later, so the death animation is the explosion. Say the spot names, the order and the tempo in the system's description.
- \`kill-zone\` on the explosion spots is not it — the explosion itself kills; the zone kind is for pits.
- \`respawn\` at the last checkpoint: a checkpoint is a \`message\` + a switch or death counter set when the player brings the unit there, and the respawn location moves with it (custom, or one \`respawn\` per checkpoint gated on that counter).
- \`victory-on-kills\` does not apply; victory is a \`message\` + Victory when the unit is brought to the finish (custom, one trigger).

**Pitfalls.** Without hyper triggers a bound is unplayable — the explosions come every two seconds. Explosion units owned by a human hurt only enemies; give them to the computer and make it hostile.`;

const DIPLOMACY = `# Diplomacy and risk maps

Territories on a world map, each with a building or beacon that marks control; income per territory held; alliances made and broken in the game's diplomacy menu; last empire standing wins.

**Layout.** Regions of buildable ground separated by water, mountains and chokes, each with a capital location and a few resource-free building spots; start locations spread evenly; a legend of region names in the description or the objectives.

**Players.** Up to eight humans, each in their own force so alliances are up to them (no shared vision); a computer for rebels or barbarians, hostile to all.

**Systems.**
- \`hyper\` is optional; a slow tempo suits.
- \`income\` per region: one system per region with \`perUnit\` the region's capital building and \`players: humans\`, or a flat income plus \`kill-to-cash\`.
- \`spawn\` with \`owner: computer\` in neutral regions for rebels; \`auto-attack\` to send them at the nearest capital.
- \`last-standing\` with \`unit: Buildings\`; \`leaderboard\` control of the capital building; \`objectives\`.
- A \`countdown\` with \`onEnd: draw\` if the game must end.

**Pitfalls.** Eight players and Allied Victory in one force means everyone wins together — leave the humans in separate forces. Income systems each take a death counter; the toolkit has about eighteen.`;

const ARENA = `# Arena and micro maps

Rounds in a walled arena: each side gets the same units, the survivor of the round scores, first to N rounds wins. All skill, no economy.

**Layout.** A flat arena with two (or four) spawn locations at its sides and a wall around it; a lobby location per player outside. Symmetric.

**Players.** Two humans (or two forces of humans with Allied Victory), hostile.

**Systems.**
- \`hyper\`.
- Round flow is custom: when the arena holds units of only one side, that side's score counter goes up, everything in the arena is removed, and after a short pause both sides get the round's units at their spawns. Say the unit list per round in the description.
- \`spawn\` does not fit (it is periodic); use it only for a practice mode.
- \`victory-on-kills\` does not fit either; the win is the round score — custom, or \`countdown\` with \`onEnd: victory:<the leader>\` when a timed match is enough.
- \`leaderboard\` points with the round score in Set Score (Custom); \`objectives\`.

**Pitfalls.** Units left from the last round decide the next; remove everything in the arena between rounds. A wall the units can shoot over is not a wall.`;

const SURVIVAL = `# Survival, hero survival, cat and mouse

Hold out until a timer runs out, or hunt the survivors before it does. In *cat and mouse* one side (the cats) hunts the others (the mice), who build walls and hide; in *hero survival* every player fights the map's spawns and the last one alive wins.

**Layout.** A large open area with hiding places and chokes for the mice; spawn locations for the map's monsters at the edges; a safe start for each human.

**Players.** Cats and mice in two forces (no Allied Victory across them); or every human alone; a computer for the monsters.

**Systems.**
- \`hyper\`.
- \`countdown\` with \`onEnd: victory:Force 2\` (the mice) — the cats must win before it ends; or \`victory:humans\` in a co-op survival.
- \`spawn\` with \`owner: computer\` at the edges, \`attack\` toward the centre, and \`auto-attack\` so the monsters hunt.
- \`defeat-when-lost\` on each player's hero, or \`last-standing\`.
- \`income\` for the mice to build with; \`kill-to-cash\` for the cats.
- \`leaderboard\` control of the hero unit shows who is still alive; \`objectives\`.

**Pitfalls.** A countdown victory for a force while another system gives Defeat on the same cycle is a race — put the defeat's grace period after the timer. Monsters spawned without an order stand still.`;

export const GUIDES: Guide[] = [
  { id: "basics", title: "Scenario basics", keywords: ["ums", "scenario", "trigger", "death counter", "hyper", "switch", "location"], text: BASICS },
  { id: "madness", title: "Madness maps", keywords: ["madness", "mass", "spawn war", "auto spawn"], text: MADNESS },
  { id: "defense", title: "Defense and tower defense", keywords: ["defense", "defence", "tower", "td", "waves", "sunken", "cannon"], text: DEFENSE },
  { id: "rpg", title: "RPG maps", keywords: ["rpg", "hero", "quest", "adventure", "shop", "boss", "dungeon"], text: RPG },
  { id: "bound", title: "Bound maps", keywords: ["bound", "obstacle", "dodge", "explosion", "scourge"], text: BOUND },
  { id: "diplomacy", title: "Diplomacy and risk", keywords: ["diplomacy", "risk", "empire", "territory", "nations", "world map"], text: DIPLOMACY },
  { id: "arena", title: "Arena and micro", keywords: ["arena", "micro", "rounds", "duel", "1v1", "pvp", "tournament"], text: ARENA },
  { id: "survival", title: "Survival, hero survival, cat and mouse", keywords: ["survival", "survive", "cat and mouse", "hunt", "zombie", "horror", "hold out", "last man"], text: SURVIVAL },
];

export function guideById(id: string): Guide | null {
  const wanted = id.trim().toLowerCase();
  return GUIDES.find((g) => g.id === wanted || g.title.toLowerCase() === wanted) ?? null;
}

/** The genre guide a prompt points at — the one whose keywords it mentions most — or null when none do. */
export function guideFor(prompt: string): Guide | null {
  const text = ` ${prompt.toLowerCase()} `;
  let best: Guide | null = null;
  let score = 0;
  for (const g of GUIDES) {
    if (g.id === "basics") continue;
    let n = 0;
    for (const k of g.keywords) if (text.includes(` ${k} `) || text.includes(`${k} `) || text.includes(` ${k}`)) n += k.length > 3 ? 2 : 1;
    if (n > score) { best = g; score = n; }
  }
  return best;
}

/** What the `guide` tool answers with no argument: the list. */
export function guideIndex(): string {
  return GUIDES.map((g) => `${g.id}: ${g.title}`).join("\n");
}
