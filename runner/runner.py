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
import re
import sys
import json
import asyncio
import pathlib
import argparse
import logging
import datetime
import subprocess
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
# "channels" = approved path (no prompt); "dev" = --dangerously-load-development-channels (prompts)
CHANNEL_MODE = os.environ.get("FLEET_CHANNEL_MODE", "channels")

_agent_locks = {}  # serialize claude runs per agent (one session at a time)
_cli_procs = {}    # name -> Popen (cli-mode visible windows)

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


def _write_mcp_config(project, name, mode="headless"):
    """Write a per-agent .fleet-mcp.json wiring the fleet MCP (server name 'fleet'); return path."""
    server = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "fleet-mcp", "index.mjs"))
    env = {"FLEET_BACKEND_HTTP": BACKEND_HTTP, "FLEET_AGENT_NAME": name}
    if mode == "cli":
        env["FLEET_MODE"] = "cli"
        base_ws = BACKEND_WS.replace("/ws/runner", "")
        env["FLEET_STREAM_WS"] = f"{base_ws}/agent/{urllib.parse.quote(name)}/stream"
    cfg = {"mcpServers": {"fleet": {"command": "node", "args": [server], "env": env}}}
    path = os.path.join(project, ".fleet-mcp.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cfg, f)
    return path


def _register_project_mcp(project, name, mode):
    """Merge the 'fleet' MCP into <project>/.mcp.json so Claude Code loads it
    persistently (required for channels: `server:fleet`). Also auto-trust project MCP."""
    server = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "fleet-mcp", "index.mjs"))
    env = {"FLEET_BACKEND_HTTP": BACKEND_HTTP, "FLEET_AGENT_NAME": name}
    if mode == "cli":
        env["FLEET_MODE"] = "cli"
        base_ws = BACKEND_WS.replace("/ws/runner", "")
        env["FLEET_STREAM_WS"] = f"{base_ws}/agent/{urllib.parse.quote(name)}/stream"
    mcp_path = os.path.join(project, ".mcp.json")
    data = {}
    if os.path.exists(mcp_path):
        try:
            with open(mcp_path, encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            data = {}
    data.setdefault("mcpServers", {})["fleet"] = {"command": "node", "args": [server], "env": env}
    with open(mcp_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    # auto-approve project MCP servers (no trust prompt)
    sdir = os.path.join(project, ".claude")
    pathlib.Path(sdir).mkdir(parents=True, exist_ok=True)
    spath = os.path.join(sdir, "settings.local.json")
    sdata = {}
    if os.path.exists(spath):
        try:
            with open(spath, encoding="utf-8") as f:
                sdata = json.load(f)
        except Exception:
            sdata = {}
    sdata["enableAllProjectMcpServers"] = True
    with open(spath, "w", encoding="utf-8") as f:
        json.dump(sdata, f, indent=2)


def _unregister_project_mcp(project):
    mcp_path = os.path.join(project, ".mcp.json")
    if not os.path.exists(mcp_path):
        return
    try:
        with open(mcp_path, encoding="utf-8") as f:
            data = json.load(f)
        if data.get("mcpServers", {}).pop("fleet", None) is not None:
            with open(mcp_path, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
    except Exception:
        pass


def _spawn_cli(name, project, model):
    """Launch a visible interactive claude window (cli mode) with channel injection."""
    _register_project_mcp(project, name, "cli")
    if CHANNEL_MODE == "dev":
        chan = ["--dangerously-load-development-channels", "server:fleet"]
    else:
        chan = ["--channels", "server:fleet"]  # approved path, no confirm prompt
    parts = ["claude", *chan, "--dangerously-skip-permissions"]
    if model:
        parts += ["--model", model]
    if os.name == "nt":
        def _q(a):
            return f'"{a}"' if " " in a else a
        claude_cmd = " ".join(_q(a) for a in parts)
        # cmd /k -> the new console window STAYS open (so errors are visible);
        # CREATE_NEW_CONSOLE -> its own window.
        full = f'cmd /k {claude_cmd}'
        log.info(f"cli launch: {full}")
        proc = subprocess.Popen(full, cwd=project, creationflags=subprocess.CREATE_NEW_CONSOLE)
    else:
        proc = subprocess.Popen(parts, cwd=project)
    _cli_procs[name] = proc
    log.info(f"cli spawned {name} pid={proc.pid}")
    return proc.pid


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


def _list_sessions(project):
    """List Claude Code sessions stored for this project dir (newest first)."""
    enc = re.sub(r"[:\\/]", "-", project or "")
    d = os.path.join(os.path.expanduser("~"), ".claude", "projects", enc)
    if not os.path.isdir(d):
        return []
    out = []
    for f in os.listdir(d):
        if f.endswith(".jsonl"):
            p = os.path.join(d, f)
            out.append((f[:-6], os.path.getmtime(p)))
    out.sort(key=lambda x: x[1], reverse=True)
    return [(sid, datetime.datetime.fromtimestamp(ts).strftime("%m-%d %H:%M")) for sid, ts in out]


async def handle(cmd):
    t = cmd.get("type")
    name = cmd.get("agent")
    project = cmd.get("project_path")
    log.info(f"cmd {t} agent={name}")

    if t == "spawn":
        if project:
            pathlib.Path(os.path.join(project, ".inbox")).mkdir(parents=True, exist_ok=True)
        if cmd.get("mode") == "cli":
            try:
                pid = _spawn_cli(name, project, cmd.get("model"))
                await post(f"/agent/{name}/out", {"text": f"🟢 {name} (cli) — окно открыто, pid {pid}"})
            except Exception as e:
                log.error(f"cli spawn failed: {e}")
                await post(f"/agent/{name}/out", {"text": f"cli spawn ошибка: {e}"})
        else:
            await post(f"/agent/{name}/out", {"text": f"🟢 {name} на связи (headless)"})

    elif t == "deliver":
        if cmd.get("mode") == "cli":
            return  # cli messages delivered via backend stream to fleet-mcp, not here
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

    elif t == "usage_all":
        s = _load_stats()
        if not s["agents"]:
            await post("/usage_report", {"text": "📊 расход пока нулевой (трекинг с момента запуска)"})
        else:
            lines = [f"• {n}: ${a['cost']:.4f} · {a['in']}/{a['out']} tok · {a['runs']} зап."
                     for n, a in s["agents"].items()]
            total = sum(a["cost"] for a in s["agents"].values())
            await post("/usage_report", {"text": "📊 Расход флота (фактический):\n" + "\n".join(lines)
                                         + f"\nИТОГО: ${total:.4f}\n(реальная панель 5h/неделя — отдельным шагом)"})

    elif t == "list_sessions":
        sessions = _list_sessions(project)
        if not sessions:
            await post(f"/agent/{name}/out", {"text": "сессий в этой папке не найдено"})
        else:
            lines = [f"{i + 1}. {sid}  ({ts})" for i, (sid, ts) in enumerate(sessions[:15])]
            await post(f"/agent/{name}/out", {"text": "Сессии папки (новые сверху):\n" + "\n".join(lines)
                                              + "\n\nвыбрать: /use <agent> <id>"})

    elif t == "status":
        p = _cli_procs.get(name)
        alive = p is not None and p.poll() is None
        txt = f"runner: cli-процесс {'жив, pid ' + str(p.pid) if alive else 'не запущен'}"
        await post(f"/agent/{name}/out", {"text": txt})

    elif t in ("kill", "stop", "restart"):
        p = _cli_procs.pop(name, None)
        if p:
            try:
                p.terminate()
            except Exception:
                pass
        if t == "kill" and cmd.get("project_path"):
            _unregister_project_mcp(cmd["project_path"])
        if t == "restart" and cmd.get("mode") == "cli" and cmd.get("project_path"):
            try:
                pid = _spawn_cli(name, cmd["project_path"], cmd.get("model"))
                await post(f"/agent/{name}/out", {"text": f"♻️ {name} (cli) перезапущен, pid {pid}"})
            except Exception as e:
                await post(f"/agent/{name}/out", {"text": f"restart ошибка: {e}"})
        log.info(f"{t} {name}")


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
    log.info("=" * 56)
    log.info(f"  FLEET RUNNER · machine={MACHINE} · channels={CHANNEL_MODE}")
    log.info(f"  backend : {BACKEND_HTTP}")
    log.info(f"  logs    : {os.path.join(LOG_DIR, 'runner.log')}")
    log.info("=" * 56)
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


def _kill_cli_procs():
    for name, p in list(_cli_procs.items()):
        try:
            p.terminate()
            log.info(f"terminated cli proc {name}")
        except Exception:
            pass
    _cli_procs.clear()


def main():
    p = argparse.ArgumentParser(prog="fleet-runner")
    p.add_argument("cmd", nargs="?", default="start", choices=["start", "doctor"])
    args = p.parse_args()
    if args.cmd == "doctor":
        doctor()
        return
    try:
        asyncio.run(start())
    except KeyboardInterrupt:
        log.info("shutting down (Ctrl+C)")
    finally:
        _kill_cli_procs()  # close cli windows so their streams don't zombie


if __name__ == "__main__":
    main()
