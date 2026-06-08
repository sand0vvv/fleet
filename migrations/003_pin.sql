-- Pinned session-info message per agent topic.
ALTER TABLE fleet.agents ADD COLUMN IF NOT EXISTS pin_msg_id BIGINT;
