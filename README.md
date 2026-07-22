# fleet — legacy (cloud architecture)

> ⚠️ **This is the LEGACY branch.** The current, recommended version of fleet is on the
> [`standalone`](https://github.com/sand0vvv/fleet/tree/standalone) branch — fully local,
> no backend to host, installable with `npm i -g @sand0vvv/fleet`.
> This branch is kept for reference: it's the original client-server architecture.

Drive local Claude Code agents from Telegram: chat (text / voice / files), spawn, manage a whole
fleet. Each agent lives in its own topic of one Telegram supergroup.

## Architecture

```
Telegram ──webhook──► receiver (any PaaS) ──► fleet-backend (any PaaS)
                                                  │  Postgres (schema `fleet`)
                                                  │  Whisper (faster-whisper) for voice
                                   WS (push)  ◄───┤
   local machine:  runner ◄───────────────────────┘
     ├─ headless agents: claude --resume -p   (spawned per message)
     └─ cli agents:      claude in its own window + live channel-inject
            └─ fleet-mcp (server name `fleet`) — send_message/send_file + incoming inject
```

- **receiver** — thin Telegram webhook, forwards updates to the backend.
- **fleet-backend** — the brain: agent/machine registry, routing, debounce, Whisper, sending to
  Telegram, WS server for runners and cli streams.
- **runner** — on the local machine: WS to the backend, spawns/controls agents, logs (`.fleet/logs/`).
- **fleet-mcp** — MCP server (name `fleet`) inside every agent: `send_message` / `send_file` tools;
  in cli mode it also injects incoming messages into the live session via
  `notifications/claude/channel`.

## Two agent modes

- **headless** — claude runs per message (`--resume -p`), the reply is the output. Cheap at idle.
- **cli** — claude lives in its own window; messages are injected into the live session (channel),
  replies go **strictly through `send_message`** (enforced by a system-prompt rule at spawn + a
  reminder in every inject — console text is invisible to the owner). Warm context.

Pick the mode in `/spawn` or `/mode`. cli requires `--dangerously-load-development-channels`
(the prompt is auto-confirmed by the runner).

## Files

- **You → agent:** drop a file into the topic → it's downloaded into `<project>/.inbox/` → the
  agent reads it natively. Works in both modes.
- **Agent → you:** `send_file(path)` → arrives in the topic with its original name.

## Messages & threading

Every message maps to a Telegram `message_id` (in and out) in `fleet.messages`. Replying to a
specific Telegram message tags the agent with `[↩ reply to #<id>: "<quote>"]` so it knows what
you're answering. `reply_to` is stored in the DB (thread linkage).

## Voice

Voice note → backend → Whisper (faster-whisper, or Groq if `GROQ_API_KEY` is set) → text → agent.

## Telegram commands

- `/spawn <machine> <path> [headless|cli] [model]` — start an agent (its topic is created)
- `/list` · `/machines` · `/status <a>` · `/kill <a>` (full removal: process + topic + DB)
- `/restart <a>` · `/mode <a> <headless|cli>` · `/model <a> <m>` · `/rename <a> <title>`
- `/sessions <a>` · `/use <a> <id>` — list the folder's sessions / pick one
- `/status <a>` — shows the session's **context size in tokens** (+ a "time to /compact" hint
  above 150k) and whether the cli process is alive
- `/compact <a>` — soft-compact (summary → fresh session). headless: new session. **cli: closes
  the window → summarizes → reopens on the compacted session.**
- `/new <a>` · `/stop <a>` · `/help`
- `/usage` (General only) — the real Claude limits panel (5h session / week) via
  `/api/oauth/usage` (token from `~/.claude/.credentials.json` on the runner machine)

**Pinned session:** the agent's current `session_id` is pinned in its topic and stored in
`fleet.agents` — both you and the agent know the active session. Updated on compact/new.

**Coordinator:** in General you can type **free text** (no `/`) — a coordinator (claude haiku on
the runner) turns the request into a command and runs it. Slash commands always work.

## Repo layout

`receiver/` · `fleet-backend/` · `runner/` · `fleet-mcp/` · `migrations/`

## Deploying (self-hosted)

1. **Postgres** — any instance; run the SQL in `migrations/` (schema `fleet`).
2. **fleet-backend** — deploy anywhere that runs Python (one replica ONLY — the WS manager keeps
   connections in memory). Env: `DATABASE_URL`, `TG_BOT_TOKEN`, `OWNER_TG_ID`, `RUNNER_SECRET`,
   optional `GROQ_API_KEY`.
3. **receiver** — thin webhook service; point Telegram's webhook at it (`FLEET_TOKEN` shared with
   the backend). Or point the webhook straight at the backend's `/tg/update`.
4. **runner** (local machine with the agents): `claude` installed and logged in, Node, Python.
   - `cd fleet-mcp && npm install`
   - `runner/.env`: `FLEET_BACKEND_HTTP`, `FLEET_BACKEND_WS`, `MACHINE_NAME`, `RUNNER_TOKEN`
   - `python runner/runner.py` — start (banner + logs to console and `.fleet/logs/`)
   - `python runner/runner.py doctor` — self-check (env, backend /health, claude)
   - `python runner/runner.py status` — live state (`.fleet/status.json`)

The runner is a CLI app: WS auto-reconnect, watchdog (catches dead cli windows → posts `/restart`
to the topic), log rotation, cli-window cleanup on Ctrl+C. See `DEPLOY.md` for the step-by-step.

## Security

- Telegram: the bot only obeys `OWNER_TG_ID`.
- **Shared-secret auth** (active once set): the same secret in three places —
  `RUNNER_SECRET` (backend) = `FLEET_TOKEN` (receiver) = `RUNNER_TOKEN` (runner). Checked on WS
  (runner + cli streams) and on every POST (`X-Fleet-Token`). Empty everywhere = auth off (dev).
- Spawning agents is an RCE surface → owner only, machines by secret.

## CI / releases

GitHub Actions (ruff + pytest + py_compile + node --check) on every push. Releases per feature
(`v0.x.0`).

## License

MIT
