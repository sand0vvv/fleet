"""fleet-backend — routing brain.

Telegram --webhook--> receiver --POST /tg/update--> here
  -> auth (OWNER_TG_ID), transcribe voice, log inbound, route:
       General topic -> command
       agent topic   -> push 'deliver' to that agent's runner (WS)
Agent reply: runner --POST /agent/{name}/out--> here -> sendMessage to topic.
Runners connect via WS /ws/runner?machine=&token=.
"""
import os
import sys
import hmac
import asyncio
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect, UploadFile, File, Form
from fastapi.responses import JSONResponse

import db
import telegram as tg
import transcribe
import util
from wsmanager import manager
import config

app = FastAPI(title="fleet-backend")
SUPERGROUP = config.SUPERGROUP_CHAT_ID or None


def log(*a):
    print("[fleet]", *a, file=sys.stderr, flush=True)


def _ok_token(tok):
    if not config.RUNNER_SECRET:
        return True  # auth disabled until secret is set
    return bool(tok) and hmac.compare_digest(tok, config.RUNNER_SECRET)


@app.middleware("http")
async def auth_mw(request: Request, call_next):
    if config.RUNNER_SECRET:
        path = request.url.path
        protected = path.startswith("/agent/") or path in (
            "/usage_report", "/coordinate_result", "/coordinate_reply", "/fleet/command", "/tg/update")
        if protected and not _ok_token(request.headers.get("x-fleet-token")):
            return JSONResponse({"ok": False, "error": "unauthorized"}, status_code=403)
    return await call_next(request)


# ── cli streams: fleet-mcp (cli mode) connects here; backend pushes msgs to inject ──
_streams = {}  # agent_name -> WebSocket


async def push_stream(name, payload) -> bool:
    ws = _streams.get(name)
    if not ws:
        return False
    try:
        await ws.send_json(payload)
        return True
    except Exception:
        _streams.pop(name, None)
        return False


# ── debounce: collect a burst of messages per agent, deliver as one ──────────
DEBOUNCE_SECONDS = int(os.environ.get("DEBOUNCE_SECONDS", "15"))
_pending = {}   # agent_name -> {"texts": [...], "files": [...]}
_timers = {}    # agent_name -> asyncio.Task


def _enqueue(name, text, files):
    buf = _pending.setdefault(name, {"texts": [], "files": []})
    if text:
        buf["texts"].append(text)
    if files:
        buf["files"].extend(files)
    old = _timers.get(name)
    if old:
        old.cancel()
    _timers[name] = asyncio.create_task(_flush_after(name))


async def _flush_after(name):
    try:
        await asyncio.sleep(DEBOUNCE_SECONDS)
    except asyncio.CancelledError:
        return
    buf = _pending.pop(name, None)
    _timers.pop(name, None)
    if not buf:
        return
    a = db.get_agent(name)
    if not a:
        return
    text = "\n".join(t for t in buf["texts"] if t).strip()
    files = buf["files"]
    if a["mode"] == "cli":
        ok = await push_stream(name, {"type": "message", "text": text, "files": files})
        log(f"flush(cli) -> agent={name} stream_ok={ok}")
        if not ok:
            await reply(a["topic_id"], f"⚠️ cli-агент не на связи (окно закрыто?). /restart {name}")
        return
    machine = _machine_of(a)
    log(f"flush(headless) -> agent={name} machine={machine}")
    pushed = await manager.push(machine, {
        "type": "deliver", "agent": a["name"], "mode": a["mode"], "model": a["model"],
        "project_path": a["project_path"], "session_id": a["session_id"],
        "text": text, "files": files,
    })
    if not pushed:
        await reply(a["topic_id"], "⚠️ машина агента оффлайн — runner не на связи")


@app.get("/health")
async def health():
    return {"ok": True}


def _machine_of(agent):
    if not agent or not agent.get("machine_id"):
        return None
    m = db.q("SELECT name FROM fleet.machines WHERE id=%s", (agent["machine_id"],), fetch="one")
    return m["name"] if m else None


# ─────────────────────────────────────────────────────────────────────────────
# Telegram updates (forwarded by receiver)
# ─────────────────────────────────────────────────────────────────────────────
@app.post("/tg/update")
async def tg_update(req: Request):
    global SUPERGROUP
    upd = await req.json()
    msg = upd.get("message") or upd.get("edited_message")
    if not msg:
        return {"ok": True}

    frm = (msg.get("from") or {}).get("id")
    chat = msg.get("chat") or {}
    thread_id = msg.get("message_thread_id")
    log(f"update from={frm} chat={chat.get('id')} thread={thread_id} keys={[k for k in msg if k not in ('from','chat')]}")

    if config.OWNER_TG_ID and frm != config.OWNER_TG_ID:
        log(f"ignored non-owner {frm}")
        return {"ok": True}

    if chat.get("type") in ("supergroup", "group") and SUPERGROUP is None:
        SUPERGROUP = chat.get("id")
        log(f"learned supergroup chat_id={SUPERGROUP}")

    text = msg.get("text") or msg.get("caption") or ""
    files = []
    mtype = "text"

    if msg.get("voice"):
        mtype = "voice"
        url = await tg.get_file_url(msg["voice"]["file_id"])
        log(f"voice file_url={'ok' if url else 'NONE'}")
        text = await transcribe.transcribe_url(url) if url else ""
        log(f"transcribed: {text[:120]!r}")
    elif msg.get("photo"):
        mtype = "photo"
        url = await tg.get_file_url(msg["photo"][-1]["file_id"])
        if url:
            files.append(url)
    elif msg.get("document"):
        mtype = "doc"
        url = await tg.get_file_url(msg["document"]["file_id"])
        if url:
            files.append(url)

    text = util.forward_prefix(msg) + text  # tag forwarded messages

    # reply linkage: if owner replies to a specific message, tag it for the agent
    reply_to_id = None
    rt = msg.get("reply_to_message")
    if rt and not rt.get("forum_topic_created") and rt.get("message_id") != thread_id:
        reply_to_id = rt.get("message_id")
        quoted = (rt.get("text") or rt.get("caption") or "")[:200]
        text = f'[↩ ответ на #{reply_to_id}: "{quoted}"]\n' + text

    agent = db.get_agent_by_topic(thread_id) if thread_id else None

    # log inbound to DB (always; agent_id null for General)
    try:
        db.log_message(agent["id"] if agent else None, "in", text, mtype,
                       files or None, voice_text=(text if mtype == "voice" else None),
                       tg_message_id=msg.get("message_id"), reply_to=reply_to_id)
        log("inbound logged to db")
    except Exception as e:
        log(f"log_message FAILED: {e}")

    # General -> commands
    if not thread_id:
        if text.startswith("/"):
            log(f"command(General): {text}")
            await handle_command(text)
        elif text.strip():
            log(f"coordinate(General): {text[:80]}")
            await cmd_coordinate(text)
        return {"ok": True}

    if not agent:
        log(f"no agent bound to topic {thread_id}")
        return {"ok": True}

    if text.startswith("/"):
        log(f"command(topic {agent['name']}): {text}")
        await handle_command(text, agent=agent)
        return {"ok": True}

    log(f"enqueue -> agent={agent['name']} (debounce {DEBOUNCE_SECONDS}s)")
    _enqueue(agent["name"], text, files)
    return {"ok": True}


# ─────────────────────────────────────────────────────────────────────────────
# Commands
# ─────────────────────────────────────────────────────────────────────────────
async def handle_command(text, agent=None):
    parts = text.strip().split()
    cmd = parts[0].lstrip("/").split("@")[0].lower()  # strip @botusername in groups
    args = parts[1:]
    if cmd == "help":
        await reply(None, _help_text())
    elif cmd == "spawn":
        await cmd_spawn(args)
    elif cmd == "list":
        await cmd_list()
    elif cmd == "machines":
        await cmd_machines()
    elif cmd == "status":
        await cmd_status(args)
    elif cmd in ("kill", "restart", "new", "stop", "compact"):
        await cmd_agent_op(cmd, args, agent)
    elif cmd == "usage":
        if agent is not None:
            await reply(agent["topic_id"], "/usage работает только в General")
        else:
            await cmd_usage_all()
    elif cmd == "sessions":
        await cmd_sessions(args, agent)
    elif cmd == "use":
        await cmd_use(args, agent)
    elif cmd == "mode":
        await cmd_set(args, "mode")
    elif cmd == "model":
        await cmd_set(args, "model")
    elif cmd == "rename":
        await cmd_rename(args, agent)
    else:
        await reply(None, f"неизвестная команда: /{cmd}")


async def cmd_spawn(args):
    if len(args) < 2:
        return await reply(None, "usage: /spawn <machine> <project_path> [headless|cli] [model]")
    machine, path = args[0], args[1]
    mode = args[2] if len(args) > 2 else "headless"
    model = args[3] if len(args) > 3 else None
    m = db.get_machine(machine)
    if not m:
        return await reply(None, f"машина '{machine}' не зарегистрирована (runner не подключался)")
    name = util.agent_name_from_path(path) or machine
    if not SUPERGROUP:
        return await reply(None, "не знаю chat_id супергруппы — напиши что-нибудь в группе")
    topic_id = await tg.create_forum_topic(SUPERGROUP, name)
    db.create_agent(name, m["id"], path, mode, model, topic_id)
    await manager.push(machine, {"type": "spawn", "agent": name, "mode": mode,
                                 "model": model, "project_path": path})
    log(f"spawned {name} on {machine} topic={topic_id}")
    await reply(topic_id, f"🟢 {name} ({mode}) поднят на {machine}")


async def cmd_list():
    rows = db.list_agents() or []
    if not rows:
        return await reply(None, "агентов нет")
    await reply(None, "Агенты:\n" + "\n".join(
        f"• {r['name']} — {r['machine_name'] or '?'} · {r['mode']} · {r['model'] or 'default'} · {r['status']}"
        for r in rows))


async def cmd_machines():
    rows = db.list_machines() or []
    if not rows:
        return await reply(None, "машин нет")
    await reply(None, "Машины:\n" + "\n".join(f"• {r['name']} — {r['status']}" for r in rows))


async def cmd_status(args):
    if not args:
        return await reply(None, "usage: /status <agent>")
    a = db.get_agent(args[0])
    if not a:
        return await reply(None, "нет такого агента")
    await reply(a["topic_id"], f"{a['name']}: {a['status']} · {a['mode']} · {a['model'] or 'default'} · "
                               f"session={a['session_id'] or '—'}")
    machine = _machine_of(a)
    await manager.push(machine, {"type": "status", "agent": a["name"],
                                 "project_path": a["project_path"], "session_id": a["session_id"]})


async def cmd_coordinate(text):
    machines = manager.machines()
    if not machines:
        return await reply(None, "нет онлайн-машин (runner не на связи) — координатор недоступен")
    agents = db.list_agents() or []
    ag = [{"name": a["name"], "machine": a.get("machine_name"), "mode": a["mode"],
           "path": a["project_path"]} for a in agents]
    mc = [m["name"] for m in (db.list_machines() or [])]
    await manager.push(machines[0], {"type": "coordinate", "text": text, "agents": ag, "machines": mc})


async def cmd_usage_all():
    sent = 0
    for m in manager.machines():
        if await manager.push(m, {"type": "usage_all"}):
            sent += 1
    if not sent:
        await reply(None, "нет онлайн-машин (runner не на связи)")


async def cmd_sessions(args, agent):
    if agent is None:
        if not args:
            return await reply(None, "usage: /sessions <agent>")
        agent = db.get_agent(args[0])
    if not agent:
        return await reply(None, "нет такого агента")
    machine = _machine_of(agent)
    await manager.push(machine, {"type": "list_sessions", "agent": agent["name"],
                                 "project_path": agent["project_path"]})


async def cmd_use(args, agent):
    if agent is not None:
        if not args:
            return await reply(agent["topic_id"], "usage: /use <session_id>")
        sid = args[0]
    else:
        if len(args) < 2:
            return await reply(None, "usage: /use <agent> <session_id>")
        agent = db.get_agent(args[0])
        sid = args[1]
    if not agent:
        return await reply(None, "нет такого агента")
    db.update_agent(agent["name"], session_id=sid)
    await reply(agent["topic_id"], f"сессия установлена: {sid}\n(headless подхватит сразу; cli — сделай /restart)")


async def cmd_agent_op(op, args, agent):
    if agent is None:
        if not args:
            return await reply(None, f"usage: /{op} <agent>")
        agent = db.get_agent(args[0])
    if not agent:
        return await reply(None, "нет такого агента")
    machine = _machine_of(agent)
    if op == "kill":
        await manager.push(machine, {"type": "kill", "agent": agent["name"],
                                     "project_path": agent["project_path"]})
        try:
            await tg.delete_forum_topic(SUPERGROUP, agent["topic_id"])
        except Exception:
            pass
        db.delete_agent(agent["name"])
        await reply(None, f"🔴 {agent['name']} удалён: процесс остановлен, топик и записи в БД снесены")
    elif op == "restart":
        await manager.push(machine, {"type": "restart", "agent": agent["name"],
                                     "mode": agent["mode"], "project_path": agent["project_path"],
                                     "model": agent["model"]})
        await reply(agent["topic_id"], f"♻️ {agent['name']} перезапуск")
    elif op == "new":
        db.update_agent(agent["name"], session_id="")  # "" = force fresh (not attach)
        await reply(agent["topic_id"], "🆕 новая сессия (resume сброшен)")
    else:  # stop | compact
        await manager.push(machine, {"type": op, "agent": agent["name"], "mode": agent["mode"],
                                     "project_path": agent["project_path"],
                                     "session_id": agent["session_id"],
                                     "model": agent["model"]})


async def cmd_set(args, field):
    if len(args) < 2:
        return await reply(None, f"usage: /{field} <agent> <value>")
    a = db.get_agent(args[0])
    if not a:
        return await reply(None, "нет такого агента")
    db.update_agent(a["name"], **{field: args[1]})
    await reply(a["topic_id"], f"{a['name']}: {field} = {args[1]}")


async def cmd_rename(args, agent):
    """Rename an agent's Telegram topic. In topic: /rename <title>. In General: /rename <agent> <title>."""
    if agent is None:
        if len(args) < 2:
            return await reply(None, "usage: /rename <agent> <title>")
        agent = db.get_agent(args[0])
        title = " ".join(args[1:])
    else:
        title = " ".join(args)
    if not agent or not title:
        return await reply(None, "нет агента или пустой заголовок")
    await tg.edit_forum_topic(SUPERGROUP, agent["topic_id"], title)
    await reply(agent["topic_id"], f"топик переименован: {title}")


def _help_text():
    return ("Команды:\n/spawn <machine> <path> [headless|cli] [model]\n/list · /machines · /status <a>\n"
            "/kill <a> · /restart <a> · /mode <a> <m> · /model <a> <m> · /rename <a> <title>\n"
            "/sessions <a> · /use <a> <id> · /new · /stop · /compact\n/usage (только в General)")


# ─────────────────────────────────────────────────────────────────────────────
# Outbound: agent -> owner (runner POSTs here)
# ─────────────────────────────────────────────────────────────────────────────
@app.post("/agent/{name}/out")
async def agent_out(name: str, req: Request):
    """Text reply from an agent -> its Telegram topic."""
    body = await req.json()
    a = db.get_agent(name)
    if not a or not SUPERGROUP:
        log(f"agent_out: no agent '{name}' or no supergroup")
        return {"ok": False}
    text = body.get("text", "")
    log(f"agent_out {name}: text={text[:80]!r}")
    if text:
        r = await tg.send_message(SUPERGROUP, text, message_thread_id=a["topic_id"])
        tgid = (r.get("result") or {}).get("message_id") if r else None
        db.log_message(a["id"], "out", text, tg_message_id=tgid)
    return {"ok": True}


@app.post("/agent/{name}/file")
async def agent_file(name: str, file: UploadFile = File(...), caption: str = Form("")):
    """File upload from an agent (via channels-mcp) -> its Telegram topic."""
    a = db.get_agent(name)
    if not a or not SUPERGROUP:
        return {"ok": False}
    fname = file.filename or "file"
    tmp = f"/tmp/out_{abs(hash(name))}_{os.path.basename(fname)}"
    with open(tmp, "wb") as f:
        f.write(await file.read())
    is_img = fname.lower().endswith((".png", ".jpg", ".jpeg", ".webp", ".gif"))
    send = tg.send_photo if is_img else tg.send_document
    await send(SUPERGROUP, tmp, caption=caption or None, message_thread_id=a["topic_id"], filename=fname)
    db.log_message(a["id"], "out", caption or f"[file: {fname}]", "doc")
    log(f"agent_file {name}: {fname}")
    try:
        os.remove(tmp)
    except OSError:
        pass
    return {"ok": True}


@app.post("/usage_report")
async def usage_report(req: Request):
    body = await req.json()
    await reply(None, body.get("text", ""))
    return {"ok": True}


@app.post("/coordinate_result")
async def coordinate_result(req: Request):
    body = await req.json()
    cmdline = (body.get("command") or "").strip()
    if cmdline.startswith("/"):
        await reply(None, f"→ {cmdline}")
        await handle_command(cmdline)
    else:
        await reply(None, "не понял запрос — уточни или используй команды (/help)")
    return {"ok": True}


@app.post("/coordinate_reply")
async def coordinate_reply(req: Request):
    """Coordinator agent's natural-language reply -> General."""
    body = await req.json()
    await reply(None, body.get("text", ""))
    return {"ok": True}


@app.post("/fleet/command")
async def fleet_command(req: Request):
    """Coordinator's fleet_command tool -> execute a slash command."""
    body = await req.json()
    cmd = (body.get("command") or "").strip()
    if cmd.startswith("/"):
        log(f"fleet_command: {cmd}")
        await handle_command(cmd)
    return {"ok": True}


@app.post("/agent/{name}/session")
async def agent_session(name: str, req: Request):
    body = await req.json()
    sid = body.get("session_id")
    a = db.get_agent(name)
    changed = bool(a and sid and a.get("session_id") != sid)
    db.update_agent(name, session_id=sid, status=body.get("status", "running"))
    if changed and SUPERGROUP and a.get("topic_id"):
        r = await tg.send_message(SUPERGROUP, f"📌 Сессия: {sid}", message_thread_id=a["topic_id"])
        mid = (r.get("result") or {}).get("message_id") if r else None
        if mid:
            await tg.pin_message(SUPERGROUP, mid)
            old = a.get("pin_msg_id")
            if old and old != mid:
                await tg.unpin_message(SUPERGROUP, old)
            db.update_agent(name, pin_msg_id=mid)
    return {"ok": True}


# ─────────────────────────────────────────────────────────────────────────────
# Runner WebSocket
# ─────────────────────────────────────────────────────────────────────────────
@app.websocket("/ws/runner")
async def ws_runner(ws: WebSocket):
    machine = ws.query_params.get("machine")
    token = ws.query_params.get("token")
    if not machine or not token:
        await ws.close(code=4001)
        return
    if not _ok_token(token):
        log(f"runner auth rejected: {machine}")
        await ws.close(code=4003)
        return
    db.upsert_machine(machine, token_hash=token)
    await manager.connect(machine, ws)
    log(f"runner connected: {machine}")
    try:
        while True:
            data = await ws.receive_json()
            if data.get("type") == "heartbeat":
                db.touch_machine(machine)
    except WebSocketDisconnect:
        manager.disconnect(machine)
        log(f"runner disconnected: {machine}")


@app.websocket("/agent/{name}/stream")
async def agent_stream(ws: WebSocket, name: str):
    if not _ok_token(ws.query_params.get("token")):
        await ws.close(code=4003)
        return
    await ws.accept()
    old = _streams.get(name)
    if old:
        try:
            await old.close()
        except Exception:
            pass
    _streams[name] = ws
    log(f"stream connected: {name}")
    try:
        while True:
            await ws.receive_text()  # keepalive; content ignored
    except WebSocketDisconnect:
        if _streams.get(name) is ws:
            _streams.pop(name, None)
        log(f"stream disconnected: {name}")


async def reply(thread_id, text):
    if SUPERGROUP:
        r = await tg.send_message(SUPERGROUP, text, message_thread_id=thread_id)
        if r and not r.get("ok"):
            log(f"sendMessage not ok: {r}")
    else:
        log("reply skipped — supergroup unknown")
