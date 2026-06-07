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
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect, UploadFile, File, Form

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

    agent = db.get_agent_by_topic(thread_id) if thread_id else None

    # log inbound to DB (always; agent_id null for General)
    try:
        db.log_message(agent["id"] if agent else None, "in", text, mtype,
                       files or None, voice_text=(text if mtype == "voice" else None),
                       tg_message_id=msg.get("message_id"))
        log("inbound logged to db")
    except Exception as e:
        log(f"log_message FAILED: {e}")

    # General -> commands
    if not thread_id:
        if text.startswith("/"):
            log(f"command(General): {text}")
            await handle_command(text)
        else:
            await reply(None, "В General — командой (/help) или из топика агента.")
        return {"ok": True}

    if not agent:
        log(f"no agent bound to topic {thread_id}")
        return {"ok": True}

    if text.startswith("/"):
        log(f"command(topic {agent['name']}): {text}")
        await handle_command(text, agent=agent)
        return {"ok": True}

    machine = _machine_of(agent)
    online = manager.is_online(machine) if machine else False
    log(f"route -> agent={agent['name']} machine={machine} online={online} mode={agent['mode']}")
    pushed = await manager.push(machine, {
        "type": "deliver",
        "agent": agent["name"],
        "mode": agent["mode"],
        "model": agent["model"],
        "project_path": agent["project_path"],
        "session_id": agent["session_id"],
        "text": text,
        "files": files,
    })
    if not pushed:
        log("push FAILED — runner offline")
        await reply(thread_id, "⚠️ машина агента оффлайн — runner не на связи")
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
    elif cmd in ("kill", "restart", "new", "stop", "compact", "usage"):
        await cmd_agent_op(cmd, args, agent)
    elif cmd == "mode":
        await cmd_set(args, "mode")
    elif cmd == "model":
        await cmd_set(args, "model")
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


async def cmd_agent_op(op, args, agent):
    if agent is None:
        if not args:
            return await reply(None, f"usage: /{op} <agent>")
        agent = db.get_agent(args[0])
    if not agent:
        return await reply(None, "нет такого агента")
    machine = _machine_of(agent)
    if op == "kill":
        await manager.push(machine, {"type": "kill", "agent": agent["name"]})
        db.update_agent(agent["name"], status="dead")
        await reply(agent["topic_id"], f"🔴 {agent['name']} остановлен")
    elif op == "restart":
        await manager.push(machine, {"type": "restart", "agent": agent["name"]})
        await reply(agent["topic_id"], f"♻️ {agent['name']} перезапуск")
    elif op == "new":
        db.update_agent(agent["name"], session_id=None)
        await reply(agent["topic_id"], "🆕 новая сессия (resume сброшен)")
    else:  # stop | compact | usage
        await manager.push(machine, {"type": op, "agent": agent["name"],
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


def _help_text():
    return ("Команды:\n/spawn <machine> <path> [headless|cli] [model]\n/list · /machines · /status <a>\n"
            "/kill <a> · /restart <a> · /mode <a> <m> · /model <a> <m>\n/new · /stop · /compact · /usage")


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
    await send(SUPERGROUP, tmp, caption=caption or None, message_thread_id=a["topic_id"])
    db.log_message(a["id"], "out", caption or f"[file: {fname}]", "doc")
    log(f"agent_file {name}: {fname}")
    try:
        os.remove(tmp)
    except OSError:
        pass
    return {"ok": True}


@app.post("/agent/{name}/session")
async def agent_session(name: str, req: Request):
    body = await req.json()
    db.update_agent(name, session_id=body.get("session_id"), status=body.get("status", "running"))
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


async def reply(thread_id, text):
    if SUPERGROUP:
        r = await tg.send_message(SUPERGROUP, text, message_thread_id=thread_id)
        if r and not r.get("ok"):
            log(f"sendMessage not ok: {r}")
    else:
        log("reply skipped — supergroup unknown")
