-- =============================================================================
-- 005_rooms — reusable multi-agent "rooms" + reply-follows-origin routing.
-- A room is a topic that links 2+ agents, each speaking via its own bot.
-- ISOLATION: only topics present in fleet.rooms get room routing; every other
-- (folder-bound) topic keeps the existing 1-agent behaviour untouched.
-- =============================================================================
CREATE TABLE IF NOT EXISTS fleet.rooms (
    topic_id    BIGINT PRIMARY KEY,
    name        TEXT,
    kind        TEXT NOT NULL DEFAULT 'pair',          -- pair (2-agent) | backend (telemetry)
    members     JSONB NOT NULL DEFAULT '[]',           -- [{"agent":"tac-trader","bot":"hud112"},{"agent":"poly","bot":"hud113"}]
    backend_url TEXT,                                  -- for kind='backend'
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- reply-follows-origin: where this agent currently replies (topic + which bot).
-- NULL = default (its own folder topic via the main bot) — preserves old behaviour.
ALTER TABLE fleet.agents ADD COLUMN IF NOT EXISTS reply_topic BIGINT;
ALTER TABLE fleet.agents ADD COLUMN IF NOT EXISTS reply_bot   TEXT;
