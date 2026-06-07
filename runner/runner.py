"""runner — local fleet agent (one per machine).

- Holds one outbound WS to fleet-backend (push channel down).
- Heartbeats up over the WS.
- Handles commands: spawn, deliver, kill, restart, stop, usage, compact.
- headless mode: runs `claude --resume -p` per message; posts result + session up.
- cli mode: TODO (needs channels-mcp). For now headless is the working path.

Env (.env next to this file or process env):
  FLEET_BACKEND_HTTP   e.g. https://fleet-backend.up.railway.app
  FLEET_BACKEND_WS     e.g. wss://fleet-backend.up.railway.app/ws/runner
  MACHINE_NAME         e.g. home
  RUNNER_TOKEN         shared secret for this machine
"""
import os
import sys
import json
import asyncio
import pathlib
import urllib.parse

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


def log(*a):
    print("[runner]", *a, file=sys.stderr, flush=True)


async def post(path, payload):
    try:
        async with httpx.AsyncClient(timeout=300) as c:
            await c.post(f"{BACKEND_HTTP}{path}", json=payload)
    except Exception as e:
        log("post failed", path, e)


async def download(url, dest_dir):
    name = os.path.basename(urllib.parse.urlparse(url).path) or "file"
    pathlib.Path(dest_dir).mkdir(parents=True, exist_ok=True)
    dest = os.path.join(dest_dir, name)
    async with httpx.AsyncClient(timeout=120) as c:
        r = await c.get(url)
        r.raise_for_status()
        with open(dest, "wb") as f:
            f.write(r.content)
    return dest


async def run_claude(project, prompt, model, session_id):
    """Invoke claude headless, return (result_text, session_id)."""
    flags = "-p --output-format json --dangerously-skip-permissions"
    if model:
        flags += f" --model {model}"
    if session_id:
        flags += f" --resume {session_id}"

    if os.name == "nt":
        proc = await asyncio.create_subprocess_shell(
            f"claude {flags}", cwd=project,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE)
    else:
        proc = await asyncio.create_subprocess_exec(
            "claude", *flags.split(), cwd=project,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE)

    out, err = await proc.communicate(prompt.encode("utf-8"))
    raw = out.decode("utf-8", "replace").strip()
    if err and not raw:
        log("claude stderr:", err.decode("utf-8", "replace")[:500])
    try:
        data = json.loads(raw)
        return data.get("result", raw), data.get("session_id", session_id)
    except Exception:
        return raw or "(пустой ответ)", session_id


async def handle(cmd):
    t = cmd.get("type")
    name = cmd.get("agent")
    project = cmd.get("project_path")

    if t == "spawn":
        if project:
            pathlib.Path(os.path.join(project, ".inbox")).mkdir(parents=True, exist_ok=True)
        await post(f"/agent/{name}/out", {"text": f"🟢 {name} на связи ({cmd.get('mode')})"})

    elif t == "deliver":
        mode = cmd.get("mode", "headless")
        if mode == "cli":
            await post(f"/agent/{name}/out", {"text": "⚠️ cli-режим ещё не готов, поставь /mode " + name + " headless"})
            return
        # download incoming files into .inbox, note their paths in the prompt
        note = ""
        for url in cmd.get("files") or []:
            try:
                dest = await download(url, os.path.join(project, ".inbox"))
                note += f"[файл получен: {dest}]\n"
            except Exception as e:
                log("download failed", e)
        prompt = (note + (cmd.get("text") or "")).strip() or "(пусто)"
        await post(f"/agent/{name}/session", {"session_id": cmd.get("session_id"), "status": "running"})
        result, sid = await run_claude(project, prompt, cmd.get("model"), cmd.get("session_id"))
        await post(f"/agent/{name}/out", {"text": result})
        await post(f"/agent/{name}/session", {"session_id": sid, "status": "idle"})

    elif t in ("kill", "stop", "restart"):
        # headless has no persistent process; ack only (cli will use this later)
        log(f"{t} {name} (no-op for headless)")

    elif t in ("usage", "compact"):
        await post(f"/agent/{name}/out", {"text": f"/{t}: ещё не реализовано"})


async def heartbeat(ws):
    while True:
        await asyncio.sleep(25)
        try:
            await ws.send(json.dumps({"type": "heartbeat"}))
        except Exception:
            return


async def session():
    url = f"{BACKEND_WS}?machine={MACHINE}&token={TOKEN}"
    async with websockets.connect(url, max_size=None) as ws:
        log("connected to", BACKEND_WS, "as", MACHINE)
        hb = asyncio.create_task(heartbeat(ws))
        try:
            async for raw in ws:
                try:
                    cmd = json.loads(raw)
                except Exception:
                    continue
                asyncio.create_task(handle(cmd))
        finally:
            hb.cancel()


async def main():
    if not BACKEND_WS or not BACKEND_HTTP:
        log("set FLEET_BACKEND_HTTP and FLEET_BACKEND_WS")
        sys.exit(1)
    while True:
        try:
            await session()
        except Exception as e:
            log("ws error, reconnecting in 5s:", e)
        await asyncio.sleep(5)


if __name__ == "__main__":
    asyncio.run(main())
