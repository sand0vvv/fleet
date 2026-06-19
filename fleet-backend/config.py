"""Env config for fleet-backend."""
import os

DATABASE_URL = os.environ.get("DATABASE_URL", "")
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
# OWNER_TG_ID accepts MULTIPLE ids (comma/semicolon-separated) — Docker's group has two "owners":
# the human owner (who created the supergroup) AND Operator (who drives his agents). Both may command.
OWNER_TG_IDS = set()
for _x in (os.environ.get("OWNER_TG_ID", "") or "").replace(";", ",").split(","):
    _x = _x.strip()
    if _x:
        try:
            OWNER_TG_IDS.add(int(_x))
        except ValueError:
            pass
OWNER_TG_ID = next(iter(OWNER_TG_IDS), 0)   # back-compat: primary/first id
# Shared secret: runners/fleet-mcp/receiver must present it. Empty = auth disabled (dev).
RUNNER_SECRET = os.environ.get("RUNNER_SECRET", "")
# Supergroup chat id (negative number). If empty, backend learns it from the first owner update.
SUPERGROUP_CHAT_ID = os.environ.get("SUPERGROUP_CHAT_ID", "")
# Voice transcription. If GROQ_API_KEY is set -> Groq API (no RAM, fast, recommended).
# Else local faster-whisper (heavy; can OOM small containers).
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "base")
PORT = int(os.environ.get("PORT", "8000"))

TG_API = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}"
TG_FILE = f"https://api.telegram.org/file/bot{TELEGRAM_BOT_TOKEN}"

# Docker (@hud113) — the architect/poly agent's OWN bot identity in the war-room (tac-trader topic),
# so the owner visually distinguishes its messages from tac-trader's. Token env name is flexible.
DOCKER_BOT_TOKEN = (os.environ.get("DOCKER_BOT_TOKEN") or os.environ.get("AGENTCUP_BOT_TOKEN")
                    or os.environ.get("AGENT_DOCKER_BOT_TOKEN") or os.environ.get("HUD113_BOT_TOKEN") or "")
DOCKER_API = f"https://api.telegram.org/bot{DOCKER_BOT_TOKEN}" if DOCKER_BOT_TOKEN else ""

# Bot identities for rooms: bot_key -> token. @hud112 = main bot, @hud113 = Docker.
BOT_TOKENS = {"hud112": TELEGRAM_BOT_TOKEN, "hud113": DOCKER_BOT_TOKEN}


def bot_api(bot_key):
    """API base for a room member's bot (falls back to the main bot)."""
    return f"https://api.telegram.org/bot{BOT_TOKENS.get(bot_key) or TELEGRAM_BOT_TOKEN}"
