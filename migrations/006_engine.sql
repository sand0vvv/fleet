-- Engine per agent: 'claude' (default, Claude Code) | 'claudex' (Codex fork w/ channels).
-- Additive + default -> existing agents keep behaving exactly as before.
ALTER TABLE fleet.agents ADD COLUMN IF NOT EXISTS engine TEXT NOT NULL DEFAULT 'claude';
