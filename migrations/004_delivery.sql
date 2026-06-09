-- Reliable delivery: per-agent cursor (highest inbound id confirmed processed).
-- at-least-once replay + consumer id-dedup = no loss, no duplicates.
ALTER TABLE fleet.agents ADD COLUMN IF NOT EXISTS last_delivered_id BIGINT NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_fleet_messages_inbox ON fleet.messages (agent_id, direction, id);
