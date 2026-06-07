-- Message linkage: tie messages to Telegram message ids + reply threading.
ALTER TABLE fleet.messages ADD COLUMN IF NOT EXISTS reply_to BIGINT;
CREATE INDEX IF NOT EXISTS idx_fleet_messages_tgid ON fleet.messages (tg_message_id);
CREATE INDEX IF NOT EXISTS idx_fleet_messages_replyto ON fleet.messages (reply_to);
