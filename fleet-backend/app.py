"""fleet-backend — routing brain.

Flow:
  Telegram --webhook--> receiver --POST /tg/update--> here
    -> auth (OWNER_TG_ID), transcribe voice, route:
         General topic  -> command / coordinator
         agent topic    -> push 'deliver' to that agent's runner (WS)
  Agent reply: runner --POST /agent/{name}/out--> here -> sendMessage to topic
  Runners connect via WS /ws/runner?machine=&token= (push channel down).
"""
import os
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect

import db
import telegram as tg
import transcribe
from wsmanager import manager
import config

app = FastAPI(title="fleet-backend")

# Supergroup chat id (learned from first owner update if not set in env).
SUPERGROUP = config.SUPERGROUP_CHAT_ID or None


@app.get("/health")
async def health():
    return {"ok": True}


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
    if config.OWNER_TG_ID and frm != config.OWNER_TG_ID:
        return {"ok": True}  # not the owner — ignore

    chat = msg.get("chat") or {}
    if chat.get("type") in ("supergroup", "group") and SUPERGROUP is None:
        SUPERGROUP = chat.get("id")

    thread_id = msg.get("message_thread_id")  # None in General topic
    text = msg.get("text") or msg.get("caption") or ""
    files = []          # local file-URLs for runner to fetch
    mtype = "text"

    # voice -> transcribe
    if msg.get("voice"):
        url = await tg.get_file_url(msg["voice"]["file_id"])
        text = await transcribe.transcribe_url(url) if url else ""
        mtype = "voice"
    # photo / document -> pass file-URL to runner
    elif msg.get("photo"):
        url = await tg.get_file_url(msg["photo"][-1]["file_id"])
        if url:
            files.append(url)
        mtype = "photo"
    elif msg.get("document"):
        url = await tg.get_file_url(msg["document"]["file_id"])
        if url:
            files.append(url)
        mtype = "doc"

    # General topic -> commands / coordinator
    if not thread_id:
        if text.startswith("/"):
            await handle_command(text)
        else:
            await reply(None, "В General — командой (/help) или из топика агента.")
        return {"ok": True}

    # Agent topic -> route to that agent
    agent = db.get_agent_by_topic(thread_id)
    if not agent:
        return {"ok": True}

    if text.startswith("/"):
        await handle_command(text, agent=agent)
        return {"ok": True}

    db.log_message(agent["id"], "in", text, mtype, files or None)
    pushed = await manager.push(agent["machine_name"] if "machine_name" in agent else _machine_of(agent), {
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
        await reply(thread_id, f"⚠️ машина агента оффлайн — runner не на связи")
    return {"ok": True}


def _machine_of(agent):
    m = db.q("SELECT name FROM fleet.machines WHERE id=%s", (agent["machine_id"],), fetch="one")
    return m["name"] if m else None


# ─────────────────────────────────────────────────────────────────────────────
# Commands
# ─────────────────────────────────────────────────────────────────────────────
async def handle_command(text, agent=None):
    parts = text.strip().split()
    cmd = parts[0].lstrip("/").lower()
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
    if not db.get_machine(machine):
        return await reply(None, f"машина '{machine}' не зарегистрирована (runner не подключался)")
    name = os.path.basename(path.rstrip("/\\")) or machine
    if not SUPERGROUP:
        return await reply(None, "не знаю chat_id супергруппы — напиши что-нибудь в группе сначала")
    topic_id = await tg.create_forum_topic(SUPERGROUP, name)
    m = db.get_machine(machine)
    db.create_agent(name, m["id"], path, mode, model, topic_id)
    await manager.push(machine, {"type": "spawn", "agent": name, "mode": mode,
                                 "model": model, "project_path": path})
    await reply(topic_id, f"🟢 {name} ({mode}) поднят на {machine}")


async def cmd_list():
    rows = db.list_agents() or []
    if not rows:
        return await reply(None, "агентов нет")
    lines = [f"• {r['name']} — {r['machine_name'] or '?'} · {r['mode']} · {r['model'] or 'default'} · {r['status']}"
             for r in rows]
    await reply(None, "Агенты:\n" + "\n".join(lines))


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
            return await reply(None, f"usage: /{op} <agent> (или из топика агента)")
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
        await manager.push(machine, {"type": op, "agent": agent["name"]})


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
    body = await req.json()
    a = db.get_agent(name)
    if not a or not SUPERGROUP:
        return {"ok": False}
    text = body.get("text", "")
    files = body.get("files") or []
    if text:
        r = await tg.send_message(SUPERGROUP, text, message_thread_id=a["topic_id"])
        tgid = (r.get("result") or {}).get("message_id") if r else None
        db.log_message(a["id"], "out", text, tg_message_id=tgid)
    for fp in files:
        is_img = fp.lower().endswith((".png", ".jpg", ".jpeg", ".webp", ".gif"))
        send = tg.send_photo if is_img else tg.send_document
        await send(SUPERGROUP, fp, caption=text if not text else None, message_thread_id=a["topic_id"])
    return {"ok": True}


@app.post("/agent/{name}/session")
async def agent_session(name: str, req: Request):
    body = await req.json()
    db.update_agent(name, session_id=body.get("session_id"), status=body.get("status", "running"))
    return {"ok": True}


# ─────────────────────────────────────────────────────────────────────────────
# Runner WebSocket (push channel down) + heartbeat
# ─────────────────────────────────────────────────────────────────────────────
@app.websocket("/ws/runner")
async def ws_runner(ws: WebSocket):
    machine = ws.query_params.get("machine")
    token = ws.query_params.get("token")
    if not machine or not token:
        await ws.close(code=4001)
        return
    # NOTE: token check is a placeholder — compare hash in fleet.machines (TODO).
    db.upsert_machine(machine, token_hash=token)
    await manager.connect(machine, ws)
    try:
        while True:
            data = await ws.receive_json()  # heartbeats / acks up
            if data.get("type") == "heartbeat":
                db.touch_machine(machine)
    except WebSocketDisconnect:
        manager.disconnect(machine)


async def reply(thread_id, text):
    """Send a backend message to the supergroup (a topic, or General if thread_id None)."""
    if SUPERGROUP:
        await tg.send_message(SUPERGROUP, text, message_thread_id=thread_id)
