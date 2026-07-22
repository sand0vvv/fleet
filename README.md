# @fleet/runner

**Run a _fleet_ of AI coding agents — self-hosted, on your own machine, no account.**

Fleet lets you drive a whole team of AI coding agents ([Claude Code](https://docs.anthropic.com/en/docs/claude-code) and [Codex](https://github.com/openai/codex)) from your phone, in a single Telegram supergroup. Each agent gets its own topic in the group. You text them, they work on your machine and text back — code, files, questions, progress.

Everything runs **locally**. There is no cloud service, no sign-up, no dashboard to log into. Your Telegram bot token and any API keys stay on your own machine, in `~/.fleet/config.json`. Fleet just wires your local agents to a Telegram group you own.

> Built in public and still early — expect rough edges. Issues and PRs welcome.

## Quickstart

```bash
# 1. Configure (asks for your Telegram bot token, picks a machine name, etc.)
npx @fleet/runner init

# 2. Start the runner (keeps running; this is your fleet's home base)
npx @fleet/runner start
```

Then, in the Telegram supergroup you want to use:

```
/link
```

Send `/link` in the group and the runner binds itself to **you** (your Telegram user id) and **that group**. From then on, only you can command the fleet, and only in that group. Spawn an agent, give it a topic, start texting.

## Requirements

- **Node.js 18+**
- A **Telegram bot** (create one with [@BotFather](https://t.me/BotFather), grab the token)
- A **Telegram supergroup** with topics enabled, where the bot is an admin
- At least one agent CLI installed and logged in on the machine:
  - **Claude Code** — used natively
  - **Codex** — driven through the bundled `codex-shell`

## The engines

Fleet is engine-agnostic. Each agent you spawn runs one of:

- **Claude Code** — launched directly as a local CLI process.
- **Codex** — wrapped by the bundled **codex-shell** so it speaks the same protocol as the rest of the fleet.

You can mix engines in the same group: one topic can be a Claude Code agent, the next a Codex agent, side by side.

## Configuration

All configuration lives in a single JSON file **outside** any repo:

```
~/.fleet/config.json
```

(Override the location with the `FLEET_CONFIG` environment variable, or drop a project-local `.fleet/config.json` next to where you run the command.)

Secrets — your bot token, whisper/transcription key, etc. — live only in this file, on your machine. **Nothing secret is ever written into the project directory**, so nothing secret can be committed by accident. `init` creates and fills this file for you; `/link` adds your owner id and group id to it.

## How it works

```
Telegram supergroup  ──long-poll──▶  local runner (this package)
        ▲                                    │
        │  replies / files                   │ spawns
        └────────────────────────────────────┤
                                             ▼
                             node-pty agent processes
                       (Claude Code / Codex), each with a
                          fleet MCP that dials the runner
                          on localhost to send replies up
```

1. The **runner** long-polls the Telegram Bot API for messages in your group — no inbound ports, no webhook, no public URL.
2. When you message an agent's topic, the runner routes the text to that agent's local process (spawned via **node-pty**).
3. Each agent has a small **fleet MCP** server that dials the runner back on `localhost` to push replies, files, and status up to Telegram.
4. The runner posts the agent's reply into the right topic in your group.

That's the whole loop: **Telegram long-poll → local runner → node-pty agents + MCP → back to Telegram.** No account, no server you don't control.

## Author

Built by [@sand0vvv](https://x.com/sand0vvv).

## License

MIT
