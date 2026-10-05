<div align="center">

![OpenCode Model Router](assets/banner.svg)

**English** | [Türkçe](README.tr.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-4cc38a.svg)](LICENSE)
![Platform: Windows](https://img.shields.io/badge/platform-Windows-0078D6.svg)
![Zero dependencies](https://img.shields.io/badge/dependencies-0-4cc38a.svg)
![OpenCode plugin](https://img.shields.io/badge/OpenCode-plugin-6e7681.svg)
![Works with OMO-Slim](https://img.shields.io/badge/works%20with-oh--my--opencode--slim-4cc38a.svg)

**Give every OpenCode agent a primary, secondary, and tertiary model — and a local web UI to manage them.**

**First-class support for [oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim) (OMO-Slim):** chains are written as native `agents.<agent>.model` arrays, and OMO-Slim's own failover engine picks them up.

Stop editing config files by hand. Pick the models your setup actually has, chain them for failover,
and apply everything with one click.

</div>

---

## Why this exists

OpenCode lets you set **one model per agent**. When that model hits a rate limit, gets overloaded, or goes down, the agent stops working — and fixing it means hand-editing JSON files that are easy to get wrong.

**OpenCode Model Router** adds a missing layer on top of OpenCode:

- 🧩 **3-slot model chains** — `primary → secondary → tertiary` per agent, with automatic fallback.
- 🖥️ **Local web UI** — a clean, dark-themed control panel served by the plugin itself. No npm install, no build step, no cloud.
- ✅ **Only real models** — the picker lists exactly the models that are enabled in your OpenCode **Settings → Models** screen. No phantom entries, no guesses.
- 🔁 **Provider-aware refs** — the same model served by two different providers counts as two independent chain steps (`deepseek/deepseek-flash` ≠ `opencode-go/deepseek-v4.1-flash`).
- 🛡️ **Safe apply** — every write takes a `.model-router.bak` backup first, then updates the right file for `oh-my-opencode-slim` or plain OpenCode.
- 📦 **Zero dependencies** — one plugin file, built entirely on Bun/Node built-ins (`Bun.serve`, `bun:sqlite`, `node:fs`).

## How it works

![How it works](assets/how-it-works.svg)

Every agent gets a chain. When the primary model can't answer, the next step in the chain takes over — so a single rate limit no longer breaks your whole session.

Chains live in **one JSON state file**. The web UI reads and writes it; the plugin applies it to your real OpenCode configuration.

## Features

| | |
|---|---|
| **Agent coverage** | Works with every agent OpenCode knows: `orchestrator`, `explorer`, `librarian`, `oracle`, `designer`, `fixer`, `observer`, `build`, `plan`, and any custom agents you define. |
| **oh-my-opencode-slim first** | When the oh-my plugin is detected, chains are written as native `agents.<agent>.model` arrays — oh-my's own failover engine picks them up. Otherwise chains are written to the host `opencode.jsonc`. |
| **Variant preservation** | Models with reasoning variants (e.g. `max`, `xhigh`) keep their variant through save/apply cycles. |
| **Visibility-aware picker** | The model list mirrors your desktop app's *visible/enabled* models — read directly from the settings store. |
| **Terminal fallback** | Prefer keyboards? The `/model-router` command walks you through the same selection flow with interactive questions. |
| **Safe by default** | Apply never invents new config keys, never touches preset blocks, and leaves a backup next to every file it edits. |

## Quick start

### Requirements

- **OpenCode** desktop app (v2.x) — [opencode.ai](https://opencode.ai)
- **Windows** (the install script targets Windows paths; macOS/Linux work by copying files manually — see [Configuration](#configuration))
- Optional but recommended: **oh-my-opencode-slim** plugin

### Install

```powershell
git clone https://github.com/sertdisk/OpenCode-Model-Router
cd OpenCode-Model-Router
powershell -ExecutionPolicy Bypass -File tools\install-dev.ps1
```

The script copies two things:

| From (repo) | To (OpenCode) |
|---|---|
| `src\model-router.js` | `~\.config\opencode\plugins\model-router.js` |
| `web\` | `~\.config\opencode\model-router-web\` |

**Restart OpenCode** to load the plugin.

### First run

1. Open **[http://127.0.0.1:37337](http://127.0.0.1:37337)** in your browser. The server starts automatically with OpenCode — no separate process.
2. Pick an agent from the left panel.
3. Click a slot (`1. Primary`, `2. Secondary`, `3. Tertiary`) and choose a model from the searchable drawer.
4. Hit **Save** — your chains are written to the state file.
5. Hit **Apply** — the plugin writes the chains to your real configuration (with backups) and reloads agents.

> 💡 An agent with an empty primary slot is left exactly as it is — the router only touches what you configure.

## The web UI

The interface is served locally at `127.0.0.1:37337` — it never leaves your machine.

- **Agent list** — every agent, its current effective model, and 1-2-3 chain badges.
- **Chain editor** — three slots with a visible "if it fails → next" flow, per-slot clear buttons, and unsaved-change tracking.
- **Model drawer** — search across provider, model ID, and display name; grouped by provider; keyboard navigable (`↑ ↓`, `Enter`, `Esc`).
- **Save / Apply** — Save snapshots your selection; Apply writes backups and updates your configuration.
- **Status bar** — catalog size, visible model count, whether oh-my is detected, and the state file path.

If the server can't be reached, the UI tells you plainly instead of showing stale data.

## Concepts

### Provider-qualified model references

A model reference is a triple: **`{ providerID, id, variant? }`**. This matters because the same underlying model can be served by different providers with different quotas, speeds, and costs:

```
1. Primary    deepseek/deepseek-flash              (your DeepSeek account)
2. Secondary  opencode-go/deepseek-v4.1-flash      (the same model, different provider)
3. Tertiary   commandcode/xiaomi/mimo-v2.6-flash   (a genuinely different model)
```

Chain steps are deduplicated by the full triple — `deepseek/deepseek-flash` and `opencode-go/deepseek-v4.1-flash` are distinct steps even though both are "DeepSeek Flash".

### Where chains are applied

| Detected setup | Written where | Fallback handled by |
|---|---|---|
| **oh-my-opencode-slim** present | `oh-my-opencode-slim.json` → `agents.<agent>.model` (array) | oh-my's native model-chain failover |
| Plain OpenCode | `opencode.jsonc` → existing `agent.<agent>.model` entries | Primary model only (host config) |

Host config updates only touch agents **already present** in `opencode.jsonc` — the router never adds new keys behind your back.

## Configuration

### State file

`~\.config\opencode\model-router.json` — the single source of truth for your chains:

```json
{
  "version": 1,
  "updatedAt": "2026-10-05T19:54:16.363Z",
  "chains": {
    "orchestrator": {
      "primary":   { "providerID": "deepseek", "id": "deepseek-flash", "variant": "max" },
      "secondary": { "providerID": "commandcode", "id": "deepseek/deepseek-v4.1-flash" },
      "tertiary":  { "providerID": "opencode", "id": "mimo-v2.6-flash-free" }
    }
  }
}
```

### Environment overrides

Useful for development and custom setups:

| Variable | Default |
|---|---|
| `MODEL_ROUTER_PORT` | `37337` |
| `MODEL_ROUTER_STATE_PATH` | `~\.config\opencode\model-router.json` |
| `MODEL_ROUTER_OHMY_PATH` | `~\.config\opencode\oh-my-opencode-slim.json` |
| `MODEL_ROUTER_HOST_CONFIG` | `~\.config\opencode\opencode.jsonc` |
| `MODEL_ROUTER_WEB_DIR` | `~\.config\opencode\model-router-web` |

### Manual install (macOS / Linux)

```sh
cp src/model-router.js ~/.config/opencode/plugins/model-router.js
mkdir -p ~/.config/opencode/model-router-web
cp web/* ~/.config/opencode/model-router-web/
```

## The `/model-router` command

Prefer staying in the terminal? The plugin also registers a `/model-router` command inside OpenCode. It asks you 4 questions (agent → primary → secondary → tertiary) using OpenCode's native question UI and writes the same state file — no browser required.

## HTTP API

The local server exposes a small JSON API (handy for scripting):

| Endpoint | Description |
|---|---|
| `GET /api/state` | Agents, chains, visible models, catalog counts, detected setup |
| `GET /api/models` | Visible models only (`?all=1` for the full catalog) |
| `POST /api/save` | Merge chains into the state file — body: `{ "chains": { "<agent>": { "primary": "provider/id", "secondary": null, "tertiary": null } } }` |
| `POST /api/apply` | Apply stored chains to real configs (with `.model-router.bak` backups) |
| `GET /api/probe` | Runtime diagnostics |

## Development

```sh
bun tools/dev-server.mjs
```

Runs the plugin standalone against a mock context (12 agents, sample models), executes a full self-test of `state → save → apply` on **temporary files only** — your real configuration is never touched — then keeps the server open for manual testing.

Syntax check:

```sh
node --check src/model-router.js
node --check tools/dev-server.mjs
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| Web UI unreachable | Is OpenCode running? The server starts with the plugin. Check `~\.config\opencode\model-router-server.log`. |
| `EADDRINUSE` in the log | Another instance already owns port 37337 — close the duplicate or set `MODEL_ROUTER_PORT`. |
| Picker shows no models | Make sure at least one provider is connected and models are enabled in OpenCode's settings. |
| Apply says "skipped" | Some agents (e.g. `build`, `plan`) aren't oh-my agents — the router intentionally leaves them alone. |
| Changes don't take effect | Restart OpenCode. oh-my reads its config at startup; host config changes apply after a reload/restart. |

## Status & roadmap

- [x] Web UI with agent chain editor, provider-grouped model picker, save/apply
- [x] Visibility-aware model catalog (mirrors Settings → Models)
- [x] oh-my-opencode-slim integration with variant-preserving writes
- [x] Backups on every apply
- [ ] In-session retry steering (switch to the next chain step on failure, without restarting)
- [ ] Cross-platform install script
- [ ] npm package publishing

## Contributing

Issues and pull requests are welcome — especially if you test the plugin against setups I don't have (Linux, plain OpenCode without oh-my, custom agents).

If this saved you from a dead agent mid-session, **star the repo** ⭐ — it helps more people find it, and it tells me to keep building. Fork it and adapt it to your own workflow; the whole plugin is one readable file.

## License

[MIT](LICENSE) — use it, fork it, ship it.
