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
import datetime
import httpx
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect, UploadFile, File, Form
from fastapi.responses import JSONResponse

import db
import telegram as tg
import transcribe
import util
from wsmanager import manager
import config

# backend-topic commands -> which endpoint to GET on the bound backend_url
BACKEND_CMD_MAP = {"paper": "paper", "stats": "paper", "status": "health",
                   "rejections": "rejections/summary", "signals": "signals", "config": "config"}

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


# ── rooms: a reusable topic linking 2+ agents, each speaking via its own bot. Owner tags
#    @<bot> to target one member, no tag -> all. Reply-follows-origin (an agent replies into
#    the topic it was last addressed in). Folder-bound topics (not in fleet.rooms) are untouched. ──
ARCHITECT = "poly"   # the architect agent talks to the owner in its OWN topic (send_message) and to
#                      rooms explicitly via /room/say — so its owner-channel never gets stuck on a room.


def _room_targets(text, members):
    """Which room members an owner message targets: @<bot> tags pick those; no tag -> all."""
    t = (text or "").lower()
    tagged = [m for m in members if m.get("bot") and f"@{m['bot']}" in t]
    return tagged if tagged else list(members)


async def _fetch_backend(url, path):
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.get(f"{url.rstrip('/')}/{path}")
            return r.text[:1800]
    except Exception as e:
        return f"(ошибка запроса: {e})"


async def _handle_backend_topic(topic_id, room, text):
    """Backend topic: owner runs /paper /stats /rejections /signals /config /status -> GET the
    bound backend and post the result. Telemetry is pushed here by the backend via /backend/post."""
    t = (text or "").strip()
    if not t:
        return
    cmd = t.lstrip("/").split()[0].split("@")[0].lower()   # strip @botname suffix (group commands)
    path = BACKEND_CMD_MAP.get(cmd)
    if path and room.get("backend_url"):
        result = await _fetch_backend(room["backend_url"], path)
        await reply(topic_id, f"📊 /{cmd}\n{result}")
    else:
        await reply(topic_id, "команды: /paper · /stats · /rejections · /signals · /config · /status")


# ── debounce + reliable delivery (per-agent cursor; deliver carries `mid`) ──────
DEBOUNCE_SECONDS = int(os.environ.get("DEBOUNCE_SECONDS", "15"))
_pending = {}   # agent_name -> {"texts": [...], "files": [...], "mid": int}
_timers = {}    # agent_name -> asyncio.Task


def _enqueue(name, text, files, mid):
    buf = _pending.setdefault(name, {"texts": [], "files": [], "mid": 0})
    if text:
        buf["texts"].append(text)
    if files:
        buf["files"].extend(files)
    if mid:
        buf["mid"] = max(buf["mid"], mid)
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
    await _deliver(a, text, buf["files"], buf["mid"])


async def _deliver(a, text, files, mid):
    """Deliver to a cli stream or headless runner, carrying `mid` (for ack/dedup)."""
    name = a["name"]
    if a["mode"] == "cli":
        ok = await push_stream(name, {"type": "message", "text": text, "files": files, "mid": mid})
        log(f"deliver(cli) {name} mid={mid} ok={ok}")
        if not ok:
            await reply(a["topic_id"], f"⚠️ cli-агент не на связи. /restart {name}")
        return
    machine = _machine_of(a)
    pushed = await manager.push(machine, {
        "type": "deliver", "agent": name, "mode": a["mode"], "model": a["model"],
        "project_path": a["project_path"], "session_id": a["session_id"],
        "text": text, "files": files, "mid": mid,
    })
    log(f"deliver(headless) {name} mid={mid} pushed={pushed}")
    if not pushed:
        await reply(a["topic_id"], "⚠️ машина агента оффлайн — runner не на связи")


async def replay_agent(a):
    """Re-deliver inbound messages newer than the agent's cursor (combined). Idempotent:
    consumer dedups by `mid`, so re-delivery never produces duplicates."""
    rows = db.undelivered(a["id"], a.get("last_delivered_id") or 0)
    if not rows:
        return
    text = "\n".join(r["text"] for r in rows if r["text"]).strip()
    files = []
    for r in rows:
        if r.get("files_path"):
            files.extend(r["files_path"])
    mid = rows[-1]["id"]
    log(f"replay {a['name']}: {len(rows)} undelivered -> mid={mid}")
    await _deliver(a, text or "(вложение)", files, mid)


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

    if config.OWNER_TG_IDS and frm not in config.OWNER_TG_IDS:
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

    # log inbound to DB (always; agent_id null for General) — capture id for delivery cursor
    mid = None
    try:
        mid = db.log_message(agent["id"] if agent else None, "in", text, mtype,
                             files or None, voice_text=(text if mtype == "voice" else None),
                             tg_message_id=msg.get("message_id"), reply_to=reply_to_id)
    except Exception as e:
        log(f"log_message FAILED: {e}")

    # General -> commands
    if not thread_id:
        cmdtext = _command_of(text)
        if cmdtext:
            log(f"command(General): {cmdtext}")
            await handle_command(cmdtext)
        elif text.strip():
            log(f"coordinate(General): {text[:80]}")
            await cmd_coordinate(text)
        return {"ok": True}

    # room topic? (reusable; reply-follows-origin). Folder topics fall through unchanged.
    room = db.get_room(thread_id)
    if room:
        if room.get("kind") == "backend":
            await _handle_backend_topic(thread_id, room, text)
            return {"ok": True}
        # pair room: route owner message to members by @<bot> tag (no tag -> both)
        if text.startswith("/"):
            await handle_command(text)
            return {"ok": True}
        targets = _room_targets(text, room.get("members") or [])
        log(f"room '{room.get('name')}' -> {[m.get('agent') for m in targets]}")
        for m in targets:
            if m.get("agent") != ARCHITECT:        # poly keeps its own owner-channel; replies to rooms via /room/say
                db.set_reply_target(m["agent"], thread_id, m.get("bot"))
            _enqueue(m["agent"], f"[📍 {room.get('name')} · от владельца] {text}", files, mid)
        return {"ok": True}

    if not agent:
        log(f"no agent bound to topic {thread_id}")
        return {"ok": True}

    if text.startswith("/"):
        log(f"command(topic {agent['name']}): {text}")
        await handle_command(text, agent=agent)
        return {"ok": True}

    # folder topic (1:1): reply-follows-origin -> reset this agent back to its own topic + main bot
    db.set_reply_target(agent["name"], agent["topic_id"], None)
    log(f"enqueue -> agent={agent['name']} mid={mid} (debounce {DEBOUNCE_SECONDS}s)")
    _enqueue(agent["name"], text, files, mid)
    return {"ok": True}


# ─────────────────────────────────────────────────────────────────────────────
# Commands
# ─────────────────────────────────────────────────────────────────────────────
KNOWN_COMMANDS = {"spawn", "list", "machines", "status", "kill", "restart", "mode", "model",
                  "rename", "sessions", "use", "new", "stop", "compact", "usage", "help", "create", "backend"}


def _command_of(text):
    """General-topic only: a message is a command if it starts with '/' OR its first word
    is a known command (so commands are always commands, never sent to the coordinator)."""
    t = (text or "").strip()
    if not t:
        return None
    if t.startswith("/"):
        return t
    first = t.split()[0].split("@")[0].lower()
    return "/" + t if first in KNOWN_COMMANDS else None


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
    elif cmd == "create":
        await cmd_create(args)
    elif cmd == "backend":
        await cmd_backend(args)
    else:
        await reply(None, f"неизвестная команда: /{cmd}")


async def cmd_backend(args):
    """/backend <name> <url> — telemetry topic bound to a backend. The backend pushes statuses here
    (via /backend/post) and the owner queries it with /paper /stats /rejections /signals /config /status."""
    if len(args) < 2:
        return await reply(None, "usage: /backend <название> <url>")
    name, url = args[0], args[1]
    topic_id = await tg.create_forum_topic(SUPERGROUP, name)
    if not topic_id:
        return await reply(None, "не смог создать топик")
    db.create_room(topic_id, name, [], kind="backend", backend_url=url)
    await reply(topic_id, f"📊 Бэкенд-топик «{name}» → {url}\n"
                          f"Команды: /paper · /stats · /rejections · /signals · /config · /status")
    await reply(None, f"✅ бэкенд-топик «{name}» создан (topic {topic_id})")


async def cmd_create(args):
    """/create <name> <agent1> <agent2> — make a room topic where the two agents talk,
    agent1 via @hud112, agent2 via @hud113. Owner tags @hud112_bot/@hud113_bot or no tag -> both."""
    if len(args) < 3:
        return await reply(None, "usage: /create <название> <агент1> <агент2>")
    name, a1, a2 = args[0], args[1], args[2]
    for an in (a1, a2):
        if not db.get_agent(an):
            return await reply(None, f"нет агента «{an}» (сначала /spawn его)")
    topic_id = await tg.create_forum_topic(SUPERGROUP, name)
    if not topic_id:
        return await reply(None, "не смог создать топик")
    members = [{"agent": a1, "bot": "hud112"}, {"agent": a2, "bot": "hud113"}]
    db.create_room(topic_id, name, members)
    await reply(topic_id, f"🏗🦅 Комната «{name}». {a1} → @hud112_bot · {a2} → @hud113_bot.\n"
                          f"Тегай @hud112_bot / @hud113_bot чтобы адресовать одному, без тега — обоим.")
    await reply(None, f"✅ комната «{name}» создана (topic {topic_id})")


async def cmd_spawn(args):
    if len(args) < 2:
        return await reply(None, "usage: /spawn <machine> <project_path> [headless|cli] [model]")
    machine, path = args[0], args[1]
    mode = args[2] if len(args) > 2 else "headless"
    model = args[3] if len(args) > 3 else None
    m = db.get_machine(machine)
    if not m:
        return await reply(None, f"машина '{machine}' не зарегистрирована (runner не подключался)")
    # presence-aware: a registered-but-offline machine can't receive the spawn push — fail-closed
    if not manager.is_online(machine):
        return await reply(None, f"машина '{machine}' оффлайн (runner не на связи) — подними runner и повтори")
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

    def _line(r):
        # status is presence-based (recent heartbeat). Show last_seen age for offline ones.
        mark = "🟢" if r["status"] == "online" else "🔴"
        age = ""
        if r["status"] != "online" and r.get("last_seen"):
            try:
                secs = int((datetime.datetime.now(datetime.timezone.utc) - r["last_seen"]).total_seconds())
                age = f" (последний раз {secs // 60}м {secs % 60}с назад)" if secs >= 60 else f" ({secs}с назад)"
            except Exception:
                pass
        return f"{mark} {r['name']} — {r['status']}{age}"

    await reply(None, "Машины:\n" + "\n".join(_line(r) for r in rows))


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
    """Agent reply -> reply-follows-origin: posts to the topic it was last addressed in, via that
    topic's bot. Default = its own folder topic via the main bot (unchanged for plain agents)."""
    body = await req.json()
    a = db.get_agent(name)
    if not a or not SUPERGROUP:
        log(f"agent_out: no agent '{name}' or no supergroup")
        return {"ok": False}
    text = body.get("text", "")
    if not text:
        return {"ok": True}
    topic = a.get("reply_topic") or a["topic_id"]          # reply-follows-origin
    api = config.bot_api(a.get("reply_bot")) if a.get("reply_bot") else config.TG_API
    log(f"agent_out {name} -> topic {topic} bot {a.get('reply_bot') or 'main'}: {text[:70]!r}")
    r = await tg.send_message_as(api, SUPERGROUP, text, message_thread_id=topic)
    tgid = (r.get("result") or {}).get("message_id") if r else None
    db.log_message(a["id"], "out", text, tg_message_id=tgid)
    # if the agent spoke INTO a room, deliver to the other members so they see it (and reply there)
    room = db.get_room(topic)
    if room:
        for m in (room.get("members") or []):
            if m.get("agent") != name:
                if m.get("agent") != ARCHITECT:    # poly receives the message but replies via /room/say
                    db.set_reply_target(m["agent"], topic, m.get("bot"))
                _enqueue(m["agent"], f"[📍 {room.get('name')} · от {name}] {text}", [], None)
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


@app.post("/agent/{name}/inject")
async def agent_inject(name: str, req: Request):
    """External services (e.g. tac-backend) push a message/alert into a cli agent's live session."""
    body = await req.json()
    ok = await push_stream(name, {"type": "message", "text": body.get("text", "")})
    if not ok:
        a = db.get_agent(name)
        if a and a.get("topic_id"):
            await reply(a["topic_id"], body.get("text", ""))  # fallback: post to topic
    return {"ok": True}


@app.post("/agent/{name}/notify")
async def agent_notify(name: str, req: Request):
    """SYSTEM/runner notification -> the agent's FOLDER topic ALWAYS (never reply-origin).
    Keeps 'window closed / restarted' etc. out of rooms — they belong where the agent lives."""
    body = await req.json()
    a = db.get_agent(name)
    if not a or not SUPERGROUP:
        return {"ok": False}
    r = await tg.send_message(SUPERGROUP, body.get("text", ""), message_thread_id=a["topic_id"])
    tgid = (r.get("result") or {}).get("message_id") if r else None
    db.log_message(a["id"], "out", body.get("text", ""), tg_message_id=tgid)
    return {"ok": True}


@app.get("/agent/{name}/rooms")
async def agent_rooms(name: str):
    """Rooms this agent can speak in (so the agent knows its surfaces). For the say_in_room tool."""
    return [{"room": r["name"], "kind": r["kind"],
             "with": [m.get("agent") for m in (r["members"] or []) if m.get("agent") != name]}
            for r in db.rooms_for_agent(name)]


@app.post("/backend/post")
async def backend_post(req: Request):
    """A backend pushes telemetry into its dedicated backend topic. Body: {room, text}."""
    body = await req.json()
    ref = str(body.get("room", ""))
    room = db.get_room(int(ref)) if ref.lstrip("-").isdigit() else db.get_room_by_name(ref)
    if not room or not SUPERGROUP:
        return {"ok": False}
    await tg.send_message(SUPERGROUP, body.get("text", ""), message_thread_id=room["topic_id"])
    return {"ok": True}


@app.post("/room/say")
async def room_say(req: Request):
    """An agent proactively speaks INTO a room it belongs to (e.g. poly initiating in the war-room).
    Posts via that member's bot, sets reply-targets, delivers to other members. Body: {from, room, text}."""
    body = await req.json()
    frm, text, room_ref = body.get("from", ""), body.get("text", ""), body.get("room")
    room = (db.get_room(int(room_ref)) if str(room_ref).lstrip("-").isdigit()
            else db.get_room_by_name(room_ref))
    if not room:
        return {"ok": False, "error": "room not found"}
    member = next((m for m in (room.get("members") or []) if m.get("agent") == frm), None)
    if not member:
        return {"ok": False, "error": f"{frm} not a member"}
    topic = room["topic_id"]
    if SUPERGROUP:
        await tg.send_message_as(config.bot_api(member.get("bot")), SUPERGROUP, text, message_thread_id=topic)
    # NOTE: do NOT set the SENDER's reply_target here — the sender is INITIATING, not being addressed.
    # (That was the bug: poly /room/say to the war-room stuck poly's reply_target -> owner replies leaked.)
    a = db.get_agent(frm)
    if a:
        db.log_message(a["id"], "out", text)
    for m in (room.get("members") or []):
        if m.get("agent") != frm:
            db.set_reply_target(m["agent"], topic, m.get("bot"))   # recipient replies back into the room
            _enqueue(m["agent"], f"[📍 {room.get('name')} · от {frm}] {text}", [], None)
    return {"ok": True, "room": room.get("name"), "topic": topic}


@app.post("/agent/{name}/ack")
async def agent_ack(name: str, req: Request):
    """Consumer confirms it processed up to message id `mid` -> advance the delivery cursor."""
    body = await req.json()
    mid = body.get("mid")
    if mid:
        db.ack_delivered(name, mid)
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
    m = db.get_machine(machine)
    if m:
        for a in (db.agents_on_machine(m["id"]) or []):
            if a["mode"] != "cli":   # cli agents replay via their own stream reconnect
                await replay_agent(a)
    try:
        while True:
            data = await ws.receive_json()
            if data.get("type") == "heartbeat":
                db.touch_machine(machine)   # presence = recent heartbeat
    except WebSocketDisconnect:
        log(f"runner disconnected: {machine}")
    except Exception as e:
        # CLOSE 1006 / abnormal drop won't always surface as WebSocketDisconnect — catch all so
        # the machine never stays a zombie 'online'. Pass `ws` so a fresh reconnect isn't evicted.
        log(f"runner ws error ({machine}): {e}")
    finally:
        manager.disconnect(machine, ws)


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
    a = db.get_agent(name)
    if a:
        await replay_agent(a)   # drain undelivered into the freshly-connected cli session
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
