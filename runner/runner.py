"""fleet-runner — local fleet agent (one per machine), as a small CLI.

Commands:
  python runner.py start     # connect to backend and serve (default)
  python runner.py doctor    # check env, backend reachability, claude CLI

Holds one outbound WS to fleet-backend (push channel), heartbeats up, and handles
commands: spawn, deliver, kill, restart, stop, usage, compact.
  headless: runs `claude --resume -p --dangerously-skip-permissions` per message.
  cli: TODO (needs live inject) — must also use --dangerously-skip-permissions.

Env (.env next to this file or process env):
  FLEET_BACKEND_HTTP, FLEET_BACKEND_WS, MACHINE_NAME, RUNNER_TOKEN
"""
import os
import sys
import json
import asyncio
import pathlib
import argparse
import logging
import urllib.parse
from logging.handlers import RotatingFileHandler

import httpx
import websockets

try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))
except Exception:
    pass

BACKEND_HTTP = os.environ.get("FLEET_BACKEND_HTTP", "").rstrip("/")
BACKEND_WS = os.environ.get("FLEET_BACKEND_WS", "").rstrip("/")
MACHINE = os.environ.get("MACHINE_NAME", "home")
TOKEN = os.environ.get("RUNNER_TOKEN", "dev")

_agent_locks = {}  # serialize claude runs per agent (one session at a time)

# ── logging ──────────────────────────────────────────────────────────────────
LOG_DIR = os.path.join(os.path.dirname(__file__), ".fleet", "logs")
os.makedirs(LOG_DIR, exist_ok=True)
log = logging.getLogger("runner")
log.setLevel(logging.INFO)
_fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s", "%H:%M:%S")
_fh = RotatingFileHandler(os.path.join(LOG_DIR, "runner.log"), maxBytes=2_000_000,
                          backupCount=3, encoding="utf-8")
_fh.setFormatter(_fmt)
_ch = logging.StreamHandler()
_ch.setFormatter(_fmt)
log.addHandler(_fh)
log.addHandler(_ch)

# ── usage stats (real spend, accumulated from claude json) ───────────────────
STATS_PATH = os.path.join(LOG_DIR, "..", "stats.json")


def _load_stats():
    try:
        with open(STATS_PATH, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"agents": {}}


def _save_stats(s):
    with open(STATS_PATH, "w", encoding="utf-8") as f:
        json.dump(s, f)


def _record_stats(name, data):
    s = _load_stats()
    a = s["agents"].setdefault(name, {"cost": 0.0, "in": 0, "out": 0, "runs": 0})
    a["cost"] += float(data.get("total_cost_usd") or 0)
    u = data.get("usage") or {}
    a["in"] += int(u.get("input_tokens") or 0)
    a["out"] += int(u.get("output_tokens") or 0)
    a["runs"] += 1
    _save_stats(s)


# ── helpers ──────────────────────────────────────────────────────────────────
async def post(path, payload):
    try:
        async with httpx.AsyncClient(timeout=300) as c:
            await c.post(f"{BACKEND_HTTP}{path}", json=payload)
    except Exception as e:
        log.error(f"POST {path} failed: {e}")


async def download(url, dest_dir):
    name = os.path.basename(urllib.parse.urlparse(url).path) or "file"
    pathlib.Path(dest_dir).mkdir(parents=True, exist_ok=True)
    dest = os.path.join(dest_dir, name)
    async with httpx.AsyncClient(timeout=120) as c:
        r = await c.get(url)
        r.raise_for_status()
        with open(dest, "wb") as f:
            f.write(r.content)
    log.info(f"downloaded {url} -> {dest}")
    return dest


def _write_mcp_config(project, name):
    """Write a per-agent .fleet-mcp.json wiring the channels MCP; return its path."""
    server = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "channels-mcp", "server.py"))
    cfg = {"mcpServers": {"channels": {
        "command": "python", "args": [server],
        "env": {"FLEET_BACKEND_HTTP": BACKEND_HTTP, "FLEET_AGENT_NAME": name}}}}
    path = os.path.join(project, ".fleet-mcp.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cfg, f)
    return path


async def _exec(args, project, prompt):
    if os.name == "nt":
        def _q(a):
            return f'"{a}"' if " " in a else a
        proc = await asyncio.create_subprocess_shell(
            "claude " + " ".join(_q(a) for a in args), cwd=project,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE)
    else:
        proc = await asyncio.create_subprocess_exec(
            "claude", *args, cwd=project,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE)
    out, err = await proc.communicate(prompt.encode("utf-8"))
    return out.decode("utf-8", "replace").strip(), proc.returncode, err.decode("utf-8", "replace")


async def run_claude(project, prompt, model, session_id, name):
    """Invoke claude headless (channels MCP, skip-permissions). Returns (text, session_id).

    No stored session yet -> try --continue (attach to the latest existing session
    in this folder so it remembers prior context), fall back to a fresh session.
    """
    cfg = _write_mcp_config(project, name)
    base = ["-p", "--output-format", "json", "--dangerously-skip-permissions", "--mcp-config", cfg]
    if model:
        base += ["--model", model]
    if session_id:
        attempts = [("resume", base + ["--resume", session_id])]
    elif session_id == "":
        attempts = [("fresh", base)]                       # /new -> force fresh
    else:
        attempts = [("continue", base + ["--continue"]), ("fresh", base)]  # never ran -> attach

    last = ""
    for label, args in attempts:
        log.info(f"run_claude name={name} via={label} model={model or 'default'}")
        raw, rc, err = await _exec(args, project, prompt)
        last = raw
        if rc != 0:
            log.error(f"claude({label}) exit={rc} stderr={err[:300]}")
            continue
        try:
            data = json.loads(raw)
        except Exception:
            log.error(f"claude({label}) non-json: {raw[:200]!r}")
            continue
        try:
            _record_stats(name, data)
        except Exception as e:
            log.error(f"stats record failed: {e}")
        return data.get("result", raw), data.get("session_id", session_id)
    return last or "(пустой ответ)", session_id


async def handle(cmd):
    t = cmd.get("type")
    name = cmd.get("agent")
    project = cmd.get("project_path")
    log.info(f"cmd {t} agent={name}")

    if t == "spawn":
        if project:
            pathlib.Path(os.path.join(project, ".inbox")).mkdir(parents=True, exist_ok=True)
        await post(f"/agent/{name}/out", {"text": f"🟢 {name} на связи ({cmd.get('mode')})"})

    elif t == "deliver":
        if cmd.get("mode") == "cli":
            await post(f"/agent/{name}/out", {"text": f"⚠️ cli-режим ещё не готов, поставь /mode {name} headless"})
            return
        lock = _agent_locks.setdefault(name, asyncio.Lock())
        async with lock:
            note = ""
            for url in cmd.get("files") or []:
                try:
                    dest = await download(url, os.path.join(project, ".inbox"))
                    note += f"[файл получен: {dest}]\n"
                except Exception as e:
                    log.error(f"download failed: {e}")
            prompt = (note + (cmd.get("text") or "")).strip() or "(пусто)"
            await post(f"/agent/{name}/session", {"session_id": cmd.get("session_id"), "status": "running"})
            result, sid = await run_claude(project, prompt, cmd.get("model"), cmd.get("session_id"), name)
            await post(f"/agent/{name}/out", {"text": result})
            await post(f"/agent/{name}/session", {"session_id": sid, "status": "idle"})

    elif t == "compact":
        # slash commands don't run in -p, so do a "soft compact":
        # summarize the session, then start a fresh one seeded with that summary.
        sid = cmd.get("session_id")
        if not sid:
            await post(f"/agent/{name}/out", {"text": "compact: нет активной сессии"})
            return
        summary, _ = await run_claude(
            project,
            "Сделай сжатое резюме нашего диалога для продолжения в НОВОЙ сессии: "
            "ключевые факты, решения, открытые задачи, важный контекст. Только резюме.",
            cmd.get("model"), sid, name)
        seed = f"[Резюме предыдущей сессии]\n{summary}\n\nЭто контекст для продолжения. Подтверди коротко."
        _, newsid = await run_claude(project, seed, cmd.get("model"), "", name)  # "" = fresh
        await post(f"/agent/{name}/session", {"session_id": newsid, "status": "idle"})
        await post(f"/agent/{name}/out", {"text": f"🗜 контекст сжат в новую сессию.\n\n{summary[:600]}"})

    elif t == "usage":
        s = _load_stats()
        a = s["agents"].get(name, {"cost": 0.0, "in": 0, "out": 0, "runs": 0})
        total = sum(x.get("cost", 0) for x in s["agents"].values())
        await post(f"/agent/{name}/out", {"text":
            f"📊 {name}\nрасход: ${a['cost']:.4f} · токены in/out: {a['in']}/{a['out']} · "
            f"запусков: {a['runs']}\nвсего по флоту: ${total:.4f}\n"
            f"(лимиты 5h/неделя через headless недоступны — это фактический расход)"})

    elif t in ("kill", "stop", "restart"):
        log.info(f"{t} {name} (no-op for headless)")


async def heartbeat(ws):
    while True:
        await asyncio.sleep(25)
        try:
            await ws.send(json.dumps({"type": "heartbeat"}))
        except Exception:
            return


async def serve_once():
    url = f"{BACKEND_WS}?machine={MACHINE}&token={TOKEN}"
    async with websockets.connect(url, max_size=None) as ws:
        log.info(f"connected to {BACKEND_WS} as {MACHINE}")
        hb = asyncio.create_task(heartbeat(ws))
        try:
            async for raw in ws:
                try:
                    cmd = json.loads(raw)
                except Exception:
                    log.error(f"bad ws frame: {raw[:120]!r}")
                    continue
                asyncio.create_task(handle(cmd))
        finally:
            hb.cancel()


async def start():
    if not BACKEND_WS or not BACKEND_HTTP:
        log.error("set FLEET_BACKEND_HTTP and FLEET_BACKEND_WS in .env")
        sys.exit(1)
    log.info(f"runner starting (machine={MACHINE}, logs={LOG_DIR})")
    while True:
        try:
            await serve_once()
        except Exception as e:
            log.error(f"ws error, reconnecting in 5s: {e}")
        await asyncio.sleep(5)


def doctor():
    print(f"machine        : {MACHINE}")
    print(f"backend http   : {BACKEND_HTTP or '(unset!)'}")
    print(f"backend ws     : {BACKEND_WS or '(unset!)'}")
    print(f"runner token   : {'set' if TOKEN and TOKEN != 'dev' else '(default/dev)'}")
    print(f"logs           : {LOG_DIR}")
    # backend health
    try:
        r = httpx.get(f"{BACKEND_HTTP}/health", timeout=10)
        print(f"backend /health: {r.status_code} {r.text}")
    except Exception as e:
        print(f"backend /health: FAIL {e}")
    # claude
    import subprocess
    try:
        v = subprocess.run("claude --version", shell=True, capture_output=True, text=True, timeout=20)
        print(f"claude         : {(v.stdout or v.stderr).strip()}")
    except Exception as e:
        print(f"claude         : FAIL {e}")


def main():
    p = argparse.ArgumentParser(prog="fleet-runner")
    p.add_argument("cmd", nargs="?", default="start", choices=["start", "doctor"])
    args = p.parse_args()
    if args.cmd == "doctor":
        doctor()
    else:
        asyncio.run(start())


if __name__ == "__main__":
    main()
