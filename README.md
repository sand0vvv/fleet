# fleet — legacy-docker (cloud architecture + Docker jail)

> ⚠️ **This is a LEGACY branch.** The current, recommended version of fleet is on the
> [`standalone`](https://github.com/sand0vvv/fleet/tree/standalone) branch — fully local,
> no backend to host, installable with `npm i -g @sand0vvv/fleet`.
> This branch = the legacy cloud architecture (see the [`legacy`](https://github.com/sand0vvv/fleet/tree/legacy)
> branch) **plus a Docker sandbox** that jails the runner and its agents in a container.

## What the Docker jail adds

The whole point of this branch: give a **second operator** their own isolated fleet on your
machine without exposing your files. The runner (and every agent it spawns) lives inside a
container that can only see ONE host folder:

```
host:  C:\operator            ←→   container: /workspace
```

Everything else on the host is invisible to the jailed agents. The operator gets their own bot,
their own supergroup, their own Postgres — a parallel stack that doesn't touch yours.

- `docker-compose.yml` / `docker-compose.wsl.yml` — the runner container (plain Docker Desktop or
  WSL2 variants).
- `docker-start.bat` / `docker-stop.bat` / `docker-*-wsl.bat` — start/stop helpers.
- `docker-autostart.ps1` — keep the container alive across reboots (registered at logon).
- `DOCKER_SETUP.md` — the full step-by-step (bot, group, DB migrations, backend env, container).

Setup summary (details in `DOCKER_SETUP.md`):

1. Create a separate bot + supergroup (Topics on, bot is admin) for the operator.
2. Fresh Postgres → run `migrations/` (schema `fleet`).
3. Deploy `fleet-backend/` + `receiver/` for this stack (own env: bot token, owner ids, shared
   `RUNNER_SECRET`, DB URL). One backend replica only.
4. `docker compose up -d` on the host — the jailed runner connects out to the backend via WS.
   No inbound ports on the host.

## The rest = legacy fleet

Everything else works exactly like the `legacy` branch: Telegram webhook → receiver → backend
(Postgres, Whisper, routing, debounce) → WS push down to the runner → agents (headless or cli)
with the `fleet` MCP for `send_message` / `send_file` and live channel-inject. See the
[`legacy` README](https://github.com/sand0vvv/fleet/blob/legacy/README.md) for the full
architecture, commands, modes, and deploy guide.

## License

MIT
