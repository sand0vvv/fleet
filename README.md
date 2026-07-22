<p align="center">
  <img src="assets/logo.svg" width="110" alt="fleet logo">
</p>

<h1 align="center">fleet</h1>

<p align="center">
  <b>A fleet of AI coding agents in your Telegram supergroup.</b><br>
  Self-hosted · local · no account.
</p>

---

Fleet lets you drive a whole team of AI coding agents — [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and [Codex](https://github.com/openai/codex) — from your phone, in a single Telegram supergroup. Each agent gets its own **topic** in the group. You text (or voice-message) them, they work on your machine and text back: code, files, questions, progress.

Everything runs **locally**. No cloud service, no sign-up, no dashboard. Your Telegram bot token and API keys stay on your machine in `~/.fleet/config.json`. Telegram is reached via long-polling — no public URL, no webhook, works behind any NAT.

> Built in public and still early — expect rough edges. Issues and PRs welcome.

## Quickstart

**0. Prerequisites** — [Node.js](https://nodejs.org) ≥ 18 and [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and logged in (`claude` in your PATH). Codex is optional.

**1. Make a bot** — talk to [@BotFather](https://t.me/BotFather) in Telegram: `/newbot`, pick a name, copy the token.

**2. Make the group** — create a Telegram group, enable **Topics** (group settings → Topics), and add your bot as **admin** (it needs to manage topics).

**3. Install & configure:**

```bash
npm i -g @sand0vvv/fleet
fleet init          # asks for the bot token, voice provider, defaults
fleet doctor        # green lights = ready
fleet start         # the runner — keep this terminal open
```

**4. Link** — send `/link` in your supergroup. The runner binds itself to **you** (your Telegram user id) and **that group**. From then on only you can command the fleet.

**5. Spawn an agent** — in the group's General topic:

```
/spawn C:\path\to\your\project
```

A topic appears named after the folder, a terminal window opens on your machine, and the agent is live. Text the topic — the agent answers there. Or from a terminal on the machine: `cd` into any project and run `fleet claude` (or `fleet codex`).

## What it looks like

```
Telegram supergroup
├─ General          ← fleet commands: /spawn /list /usage …
├─ my-webapp        ← Claude Code agent working in ~/code/my-webapp
├─ my-webapp-codex  ← Codex agent in the same folder
└─ data-pipeline    ← another Claude agent, another folder
```

Every agent runs on **your** machine. Claude agents live in a real terminal window you can watch and type into; close the window and the agent parks (frees resources) — it wakes automatically on your next message, with its session continued. Codex agents open their own console window, driven live by the bundled `codex-shell`.

## Commands

Send these in Telegram (the bot's `/` menu shows them too):

| Command | Where | What it does |
|---|---|---|
| `/link` | anywhere in the group | bind the fleet to you + this supergroup (first run) |
| `/spawn <path> [codex] [model]` | General | new agent for a folder (its own topic + window) |
| `/list` | General | all agents and their state |
| `/usage` | General / topic | fleet overview / this agent's native usage screen |
| `/status <agent>` | General | one agent's state, session, context size |
| `/context` | topic | the agent's real `/context` output, relayed to Telegram |
| `/compact` `/clear` | topic | native Claude commands, typed into the live terminal |
| `/model` | topic | model picker (buttons) |
| `/hide` / `/show` | topic | close the window (agent keeps running) / reopen it |
| `/stop` / `/restart` | topic | stop the process / kill + respawn |
| `/new` | topic | arm a fresh session (applied on next restart) |
| `/sessions` / `/use <id>` | topic | list this folder's sessions / resume a specific one |
| `/rename <name>` | topic | rename agent + topic |
| `/kill` | topic | remove the agent: process, topic, record |

Any **other** slash command you type in an agent's topic (e.g. `/cost`, `/doctor`, `/review`) is forwarded straight into the agent's terminal as a native command.

**Voice**: send a voice message in an agent's topic — it's transcribed (Groq / OpenAI / local Whisper, your choice in `fleet init`) and delivered as text.

**Files**: agents send files and screenshots back into their topic; anything you attach in the topic is handed to the agent.

## The CLI

```
fleet init      set up bot token, whisper, defaults  (safe to re-run; secrets shown masked)
fleet start     run the fleet (single instance — a stale runner is replaced automatically)
fleet claude    spawn a Claude agent for the current folder
fleet codex     spawn a Codex agent for the current folder
fleet doctor    check node/claude/codex/token/link
fleet status    show current config
```

## How it works

```
Telegram  ⇄ long-poll ⇄  fleet runner (your machine)
                            ├─ localhost HTTP+WS (for the MCP below — nothing exposed)
                            ├─ Claude agents  → node-pty terminal + fleet MCP (send_message/send_file,
                            │                   channel injection for incoming messages)
                            └─ Codex agents   → own console window; codex-shell drives the official
                                                `codex app-server` JSON-RPC to inject your messages live
```

1. The **runner** long-polls the Telegram Bot API — no inbound ports, no webhook, no public URL.
2. A message in an agent's topic is routed to that agent's local process.
3. Each agent has a small **fleet MCP** that dials the runner back on `localhost` to push replies and files up to Telegram; incoming messages are injected into the live session (Claude: channel notification; Codex: `turn/start` over the app-server protocol).
4. The runner posts the agent's reply into the right topic.

**Reliability**: messages to a parked/offline agent are queued on disk and delivered when it wakes — nothing is lost if you closed the window. Rapid consecutive messages are debounced into one delivery (configurable, `0` = instant). A crashed agent is auto-restarted (crash-loop guarded).

**State**: everything lives in `~/.fleet/` — `config.json` (token, owner, group, defaults), `state.json` (agents/topics/sessions), delivery queue + cursors. Secrets never touch a project directory, so they can't be committed by accident. Delete the folder to factory-reset. (Override the config path with the `FLEET_CONFIG` env var.)

## Troubleshooting

- `fleet doctor` first — it checks everything.
- **Port busy**: `fleet start` kills a stale runner and takes over by itself. If a non-fleet process holds the port, set `"port"` in `~/.fleet/config.json`.
- **Bot doesn't react**: make sure the bot is an **admin** of the group and Topics are enabled; then `/link` again.
- **Windows**: if git-bash is installed agents use it, otherwise plain `cmd.exe` — both work.

## Repo layout

| Branch | What |
|---|---|
| `standalone` | **this version** — local, npm, long-polling. The one to use. |
| `legacy` | the original cloud architecture (FastAPI backend + Postgres + webhook) |
| `legacy-docker` | legacy variant that jails agents in a Docker sandbox |

## Author

Built by [@sand0vvv](https://x.com/sand0vvv).

## License

MIT
