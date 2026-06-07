"""Env config for fleet-backend."""
import os

DATABASE_URL = os.environ.get("DATABASE_URL", "")
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
OWNER_TG_ID = int(os.environ.get("OWNER_TG_ID", "0") or "0")
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
