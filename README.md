# AI

> **Moved.** The AI tools are now part of the
> [scmjs.dev plugin](https://github.com/scm-js/plugin-scmjs-dev), together with the account
> and map storage. The editor ships with that plugin, turned on. This repository is kept
> for its history. It is not maintained, and it is no longer listed in
> Plugins ▸ Browse Plugins….

This was an experimental plugin for [scmJS](https://github.com/scm-js/scm-js), the
browser-based StarCraft: Brood War map editor. It used a language model on the open map:

- **Make Scenario…** designed a whole scenario from a sentence, then built it step by step
- **Generate Map…** and **Redo Area…** laid out a map, or one part of it, from a
  description
- **Write Triggers…** and **Explain Triggers…** wrote and explained triggers
- **Name and Describe…**, **Write Briefing…**, **Review Map…** and **Rewrite Strings…**
  worked on the map's text
- **Assistant** (Ctrl+Shift+A) was a panel that read and edited the map with you

All of these are in the scmjs.dev plugin now, under **Tools ▸ AI**. Its
[README](https://github.com/scm-js/plugin-scmjs-dev#readme) and the editor's guide
([The AI](https://docs.scmjs.dev/guide/the-ai/)) describe them as they work today.

## How it worked

The plugin held no model key. It talked to an ai-server, which held the key, the prompts,
the access rules and the budgets. By default that was `api.scmjs.dev`, with a free trial
and a Discord sign-in. **Tools ▸ AI ▸ Settings…** also took an access token from whoever
ran a server, or your own Anthropic key.

Nothing left the browser until you pressed a button in one of the dialogs. Every change to
the map was one undo step labelled "AI: …".

## Installing it anyway

Paste this into **Plugins ▸ Manage Plugins…** and press **Add**:

```
https://github.com/scm-js/plugin-ai
```

The last release is v0.5.0. Use the scmjs.dev plugin instead where you can.

## Files

- `plugin.ts`: the menu, the context-menu item, the hotkey and the commands
- `account.ts`: the trial, the sign-in popup and the balance
- `settings.ts`: the stored settings and the Settings dialog
- `protocol.ts`: the wire contract shared with the server
- `client.ts`: the server client
- `facts.ts`, `reference.ts`: what the model was told about the map
- `grid.ts`, `plan.ts`, `layout.ts`, `render.ts`: the layout language and how a plan was
  painted
- `tools.ts`, `tools/`, `assistant.ts`, `intent.ts`: the assistant and its tools
- `ums.ts`, `guides.ts`: the toolkit of trigger systems and the genre guides
- `slots.ts`: the buttons inside the editor's own dialogs
- `dialogs/`: one file per menu item
- `dist/plugin.js`: the bundle the editor loads (`npm run build` writes it)
