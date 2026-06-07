# CLAUDE.md — fleet

Operating guide for any Claude Code session working **on** this repo. Read it before touching code. Everything here is verified against the source; don't add features that aren't in the code.

## What fleet is

Control your **local** Claude Code agents from Telegram: chat (text / voice / files), spawn them, manage the fleet. Separate project — **not AEON** (only borrowed the `send_message` shape and a "keep it simple" attitude). The differentiator: agents are real `claude` processes on *your* machines, not containerized.

One Telegram supergroup with topics = the UI. Each agent = one topic. **General topic = coordinator.**

### Components

| Component | Where | Role |
|---|---|---|
| `receiver/` | Railway | Thin TG webhook front door. Validates optional secret header, forwards raw update to backend, always returns 200. |
| `fleet-backend/` | Railway | The brain: agent/machine registry, routing, debounce, voice transcription (Whisper), Telegram send, WS server for runners + cli streams. FastAPI. |
| `runner/runner.py` | local (one per machine) | Holds the WS to backend, spawns/controls local `claude`, watchdog, file logging. CLI app. |
| `fleet-mcp/index.mjs` | inside every agent | MCP server (server name **`fleet`**): tools `send_message` / `send_file`; in cli mode also injects incoming messages into the live session. |
| Supabase Postgres | external | Schema `fleet`: `machines`, `agents`, `messages` (lean log). |

`fleet-control-mcp/` is a stub (README only) — the NL coordinator is implemented in `runner.py` (`_coordinate`, haiku), not as a separate MCP.

## Two agent modes

**headless** — `claude --resume -p` runs per message; stdout (the `result` field of `--output-format json`) is the reply. Cheap when idle. The runner runs the process in `handle()` under a per-agent lock.

**cli** — a visible `claude` window stays alive; owner messages are injected into the live session via `notifications/claude/channel`; the agent replies through `send_message`. Warm context. Spawned with `_spawn_cli`.

Set mode via `/spawn ... cli` or `/mode <a> cli`.

### Non-obvious gotchas (all load-bearing — verified in code)

- **fleet-mcp must declare the channel capability.** `index.mjs` sets `capabilities.experimental = { "claude/channel": {}, "claude/channel/permission": {} }`. Without it, `claude` does **not** treat the server as a channel provider and drops `notifications/claude/channel` — cli injection silently dies.
- **`server:` channels need the dev flag.** cli windows launch with `--dangerously-load-development-channels server:fleet`. The "approved" `--channels server:fleet` path does **not** work for `server:` channels (kept only as `FLEET_CHANNEL_MODE=channels` override). The dev flag pops a safety prompt that can't be disabled by flags/settings → the runner auto-confirms it ~3s later via a hidden PowerShell `SendKeys('~')` (Enter = option 1). Windows-only.
- **cli MCP must live in the project's `.mcp.json`.** `_register_project_mcp` merges the `fleet` server into `<project>/.mcp.json` (persistent) so channels can see it, and writes `.claude/settings.local.json` with `enableAllProjectMcpServers: true` (auto-trust, no prompt). Passing the MCP via `--mcp-config` works for *tools* but channels can't see it — so **headless** uses `--mcp-config .fleet-mcp.json` (`_write_mcp_config`, tools only, no channels needed), **cli** uses `.mcp.json` registration.
- **Debounce.** Backend buffers a burst per agent for `DEBOUNCE_SECONDS` (default 15), then delivers as one message (`_enqueue` / `_flush_after`). Each new message resets the timer. The runner serializes runs per agent with `_agent_locks` (one session at a time).
- **Message linkage.** Every in/out message logs `tg_message_id`. Replying to a specific Telegram message tags the agent with `[↩ ответ на #<id>: "<quote>"]` and stores `reply_to` in `fleet.messages`. Forwarded messages get a `[переслано от X]` prefix (`util.forward_prefix`, handles modern `forward_origin` + legacy fields).
- **Shared-secret auth.** One secret in three places: `RUNNER_SECRET` (backend) = `FLEET_TOKEN` (receiver) = `RUNNER_TOKEN` (runner & fleet-mcp). Checked on WS (`?token=`) and all protected POSTs via `X-Fleet-Token` (`/agent/*`, `/usage_report`, `/coordinate_result`, `/tg/update`). **Empty everywhere = auth disabled (dev).** When set, comparison is `hmac.compare_digest`.
- **`/usage`** hits `https://api.anthropic.com/api/oauth/usage` with the local OAuth token from `~/.claude/.credentials.json` on the runner machine. Returns 5h-session / weekly-all / weekly-Sonnet utilization. General-topic only.
- **`/compact` is a soft compact.** Slash commands don't run under `-p`, so the runner summarizes the session then seeds a fresh one with the summary (`handle` → `compact` branch).
- **Voice** → backend → Whisper. Groq API (`whisper-large-v3-turbo`) if `GROQ_API_KEY` is set, else local `faster-whisper` (heavy; can OOM small containers).
- **Owner-only.** Backend ignores any update whose sender isn't `OWNER_TG_ID`. Spawning agents is an RCE surface — owner + machine-secret only.

## Transport

- **Down (backend → runner):** WebSocket push (`/ws/runner`, `wsmanager.py`). Carries `spawn`/`deliver`/`kill`/`restart`/`stop`/`compact`/`usage_all`/`status`/`coordinate`/`list_sessions`.
- **Down (backend → fleet-mcp), cli only:** a second WS, the per-agent stream `/agent/{name}/stream` (`_streams` in app.py). Backend pushes the message to inject; fleet-mcp injects it.
- **Up (runner/agent → backend):** HTTP POST (`/agent/{name}/out`, `/file`, `/session`, `/usage_report`, `/coordinate_result`). Agent → localhost runner is not used; fleet-mcp POSTs the backend directly.

> Known open item (not a bug): two downstream WS connections — the runner WS and the fleet-mcp cli stream — are a candidate for consolidation later.

## Dev conventions — HARD RULES

- **Commit author:** `sand0vvv <sand0vvv>`. **No Claude co-author trailer.** (Override the global default for this repo.)
- **Before every commit, run locally and ensure all green:**
  ```
  python -m py_compile fleet-backend/*.py runner/*.py receiver/*.py
  node --check fleet-mcp/index.mjs
  ruff check .
  python -m pytest -q
  ```
- **CI** (`.github/workflows/ci.yml`, GitHub Actions on every push/PR to main) runs exactly those: ruff → py_compile + node --check → pytest. Keep it green.
- **Per feature:** update `README.md`, create a GitHub release (`vX.Y.0`), commit, push. After push, sanity-check the deploy (CI green + backend `/health`).
- **Migrations:** add a numbered SQL file in `migrations/`; apply via `migrations/db.py` with `DATABASE_URL` set:
  `DATABASE_URL=... python migrations/db.py "$(cat migrations/00X_xxx.sql)"`. SQL is idempotent (`IF NOT EXISTS`). Supabase, schema `fleet`.
- **Secrets never committed.** `.env` / `.env.*` are gitignored (`.env.example` is the template). `node_modules/`, `.fleet/`, `.inbox/`, `.outbox/`, `.fleet-mcp.json`, `*.log` are gitignored too.
- `ruff.toml`: line-length 120, selects E/F/W, ignores E501/E402. Tests ignore F401/E401.

## File / dir map

```
fleet-backend/
  app.py          routing brain: /tg/update, commands, debounce, WS endpoints, outbound
  db.py           psycopg2 + registry CRUD (schema fleet) — fresh conn per call
  telegram.py     TG Bot API client (httpx): send/forum-topic/getFile/setWebhook
  wsmanager.py    runner WS registry + push()
  config.py       env config
  transcribe.py   voice → text (Groq or faster-whisper)
  util.py         pure helpers: agent_name_from_path, forward_prefix
runner/runner.py  local agent: WS link, spawn/handle, run_claude, _spawn_cli, watchdog, doctor/status
fleet-mcp/index.mjs  MCP server (fleet): send_message/send_file + cli channel inject
receiver/app.py   webhook → backend
migrations/       *.sql + db.py applier
tests/            test_util, test_forward, test_smoke (import-only; no DB/network)
conftest.py       puts fleet-backend/ on sys.path for tests
```

### Where to change things for common tasks

- **New Telegram command** → `app.py`: add to `handle_command` dispatch + a `cmd_*` handler; add to `_help_text` and `README.md`.
- **New runner-side action** (something the backend tells the machine to do) → push a new `type` via `manager.push` in `app.py`, handle it in `runner.handle()`.
- **New MCP tool for agents** → `fleet-mcp/index.mjs` (`ListTools` + `CallTool`); if it sends to the owner, add a backend POST endpoint in `app.py`.
- **DB shape change** → new `migrations/00X_*.sql` + update CRUD in `db.py` (and `INSERT`/`SELECT` column lists).
- **cli channel/launch behavior** → `runner.py` `_spawn_cli` / `_register_project_mcp` and `fleet-mcp` `connectStream` / `injectChannel`.
- **Voice / transcription** → `fleet-backend/transcribe.py`.

## DB schema (fleet)

- `machines(id, name UNIQUE, token_hash, status[online|offline], last_seen, created_at)`
- `agents(id, name UNIQUE, machine_id→machines, project_path, mode[headless|cli], model, topic_id, session_id, status[idle|running|dead], last_seen, created_at)`
- `messages(id, agent_id→agents, direction[in|out], text, type[text|photo|voice|doc], files_path[], voice_text, tg_message_id, reply_to, status, created_at)`

History of record is Telegram itself — `messages` is a lean log. Owner whitelist is `OWNER_TG_ID` env, not a table.

## Telegram commands

`/spawn <machine> <path> [headless|cli] [model]` · `/list` · `/machines` · `/status <a>` · `/kill <a>` (full removal: process + topic + DB rows) · `/restart <a>` · `/mode <a> <headless|cli>` · `/model <a> <m>` · `/rename <a> <title>` · `/sessions <a>` · `/use <a> <id>` · `/new <a>` · `/stop <a>` · `/compact <a>` · `/usage` (General only) · `/help`.

In an agent's topic: free text / voice / files → the agent. In General: free text → NL coordinator (`cmd_coordinate` → runner haiku → one slash command). Slash commands work in both.

## Local run (machine with agents)

`claude` installed & logged in; Node; Python. `runner/.env`: `FLEET_BACKEND_HTTP`, `FLEET_BACKEND_WS` (`wss://.../ws/runner`), `MACHINE_NAME`, `RUNNER_TOKEN`. Then `python runner/runner.py` (or `doctor` / `status`). `MACHINE_NAME` must match the `<machine>` in `/spawn`. Deploy details: `DEPLOY.md`.
