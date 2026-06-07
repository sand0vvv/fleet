"""Thin psycopg2 helpers + registry CRUD for schema `fleet`.

Single-user scale → a fresh connection per call is fine (Supabase pooler handles it).
"""
import psycopg2
from psycopg2.extras import RealDictCursor
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
    q("DELETE FROM fleet.agents WHERE name=%s", (name,), fetch=None)


# ---- messages ----
def log_message(agent_id, direction, text, mtype="text", files=None, voice_text=None, tg_message_id=None):
    q("""INSERT INTO fleet.messages (agent_id, direction, text, type, files_path, voice_text, tg_message_id, status)
         VALUES (%s,%s,%s,%s,%s,%s,%s,'ok')""",
      (agent_id, direction, text, mtype, files, voice_text, tg_message_id), fetch=None)
