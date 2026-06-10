"""Thin psycopg2 helpers + registry CRUD for schema `fleet`.

Single-user scale → a fresh connection per call is fine (Supabase pooler handles it).
"""
import psycopg2
from psycopg2.extras import RealDictCursor, Json
from config import DATABASE_URL


def _conn():
    return psycopg2.connect(DATABASE_URL, connect_timeout=10)


def q(sql, params=None, fetch="all"):
    """Run a query. fetch: 'all' | 'one' | None."""
    conn = _conn()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(sql, params or ())
            out = None
            if cur.description:
                out = cur.fetchone() if fetch == "one" else cur.fetchall()
            conn.commit()
            return out
    finally:
        conn.close()


# ---- machines ----
def upsert_machine(name, token_hash):
    return q(
        """INSERT INTO fleet.machines (name, token_hash, status, last_seen)
           VALUES (%s, %s, 'online', now())
           ON CONFLICT (name) DO UPDATE SET status='online', last_seen=now()
           RETURNING *""",
        (name, token_hash), fetch="one")


def touch_machine(name):
    q("UPDATE fleet.machines SET last_seen=now(), status='online' WHERE name=%s", (name,), fetch=None)


def set_machine_offline(name):
    q("UPDATE fleet.machines SET status='offline' WHERE name=%s", (name,), fetch=None)


def list_machines():
    return q("SELECT name, status, last_seen FROM fleet.machines ORDER BY name")


def get_machine(name):
    return q("SELECT * FROM fleet.machines WHERE name=%s", (name,), fetch="one")


# ---- agents ----
def create_agent(name, machine_id, project_path, mode, model, topic_id):
    return q(
        """INSERT INTO fleet.agents (name, machine_id, project_path, mode, model, topic_id, status)
           VALUES (%s,%s,%s,%s,%s,%s,'idle')
           ON CONFLICT (name) DO UPDATE
             SET machine_id=EXCLUDED.machine_id, project_path=EXCLUDED.project_path,
                 mode=EXCLUDED.mode, model=EXCLUDED.model, topic_id=EXCLUDED.topic_id
           RETURNING *""",
        (name, machine_id, project_path, mode, model, topic_id), fetch="one")


def get_agent(name):
    return q("SELECT * FROM fleet.agents WHERE name=%s", (name,), fetch="one")


def get_agent_by_topic(topic_id):
    return q("SELECT * FROM fleet.agents WHERE topic_id=%s", (topic_id,), fetch="one")


def list_agents():
    return q("""SELECT a.*, m.name AS machine_name, m.status AS machine_status
                FROM fleet.agents a LEFT JOIN fleet.machines m ON m.id=a.machine_id
                ORDER BY a.name""")


def update_agent(name, **fields):
    if not fields:
        return
    cols = ", ".join(f"{k}=%s" for k in fields)
    q(f"UPDATE fleet.agents SET {cols} WHERE name=%s", (*fields.values(), name), fetch=None)


def delete_agent(name):
    a = get_agent(name)
    if a:
        q("DELETE FROM fleet.messages WHERE agent_id=%s", (a["id"],), fetch=None)
    q("DELETE FROM fleet.agents WHERE name=%s", (name,), fetch=None)


# ---- rooms (reusable multi-agent topics; reply-follows-origin) ----
def get_room(topic_id):
    return q("SELECT * FROM fleet.rooms WHERE topic_id=%s", (topic_id,), fetch="one")


def get_room_by_name(name):
    return q("SELECT * FROM fleet.rooms WHERE name=%s ORDER BY topic_id DESC LIMIT 1", (name,), fetch="one")


def list_rooms():
    return q("SELECT topic_id, name, kind, members FROM fleet.rooms ORDER BY created_at")


def create_room(topic_id, name, members, kind="pair", backend_url=None):
    return q("""INSERT INTO fleet.rooms (topic_id, name, kind, members, backend_url)
                VALUES (%s,%s,%s,%s,%s)
                ON CONFLICT (topic_id) DO UPDATE SET name=EXCLUDED.name, kind=EXCLUDED.kind,
                    members=EXCLUDED.members, backend_url=EXCLUDED.backend_url
                RETURNING *""",
             (topic_id, name, kind, Json(members), backend_url), fetch="one")


def set_reply_target(name, topic_id, bot):
    """reply-follows-origin: the agent now replies into this topic via this bot."""
    q("UPDATE fleet.agents SET reply_topic=%s, reply_bot=%s WHERE name=%s",
      (topic_id, bot, name), fetch=None)


# ---- messages ----
def log_message(agent_id, direction, text, mtype="text", files=None, voice_text=None,
                tg_message_id=None, reply_to=None):
    row = q("""INSERT INTO fleet.messages
            (agent_id, direction, text, type, files_path, voice_text, tg_message_id, reply_to, status)
         VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'pending') RETURNING id""",
            (agent_id, direction, text, mtype, files, voice_text, tg_message_id, reply_to), fetch="one")
    return row["id"] if row else None


# ── reliable delivery: per-agent cursor + replay (no loss, no dup) ──
def ack_delivered(name, mid):
    q("UPDATE fleet.agents SET last_delivered_id = GREATEST(last_delivered_id, %s) WHERE name=%s",
      (int(mid), name), fetch=None)


def undelivered(agent_id, cursor):
    """Inbound messages newer than the cursor (for replay on reconnect)."""
    return q("""SELECT id, text, type, files_path FROM fleet.messages
                WHERE agent_id=%s AND direction='in' AND id > %s ORDER BY id""",
             (agent_id, cursor or 0), fetch="all")


def agents_on_machine(machine_id):
    return q("SELECT * FROM fleet.agents WHERE machine_id=%s", (machine_id,), fetch="all")


def get_message_by_tgid(tg_message_id):
    return q("SELECT * FROM fleet.messages WHERE tg_message_id=%s ORDER BY id DESC LIMIT 1",
             (tg_message_id,), fetch="one")
