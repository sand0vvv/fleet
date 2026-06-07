-- =============================================================================
-- fleet schema — lean: machines, agents, messages
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS fleet;

-- machines: registered runner hosts
CREATE TABLE IF NOT EXISTS fleet.machines (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    token_hash  TEXT NOT NULL,                 -- hashed runner auth token
    status      TEXT NOT NULL DEFAULT 'offline', -- online | offline
    last_seen   TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- agents: one per opt-in Claude Code (= one Telegram topic)
CREATE TABLE IF NOT EXISTS fleet.agents (
    id            BIGSERIAL PRIMARY KEY,
    name          TEXT NOT NULL UNIQUE,
    machine_id    BIGINT REFERENCES fleet.machines(id),
    project_path  TEXT NOT NULL,
    mode          TEXT NOT NULL DEFAULT 'headless', -- headless | cli
    model         TEXT,
    topic_id      INTEGER,                          -- Telegram forum topic thread id
    session_id    TEXT,                             -- claude --resume session id
    status        TEXT NOT NULL DEFAULT 'idle',     -- idle | running | dead
    last_seen     TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- messages: lean chat log (history of record is Telegram itself)
CREATE TABLE IF NOT EXISTS fleet.messages (
    id            BIGSERIAL PRIMARY KEY,
    agent_id      BIGINT REFERENCES fleet.agents(id),
    direction     TEXT NOT NULL,                    -- in | out
    text          TEXT,
    type          TEXT NOT NULL DEFAULT 'text',     -- text | photo | voice | doc
    files_path    TEXT[],
    voice_text    TEXT,
    tg_message_id BIGINT,
    status        TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fleet_messages_agent_time ON fleet.messages (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fleet_agents_machine ON fleet.agents (machine_id);
