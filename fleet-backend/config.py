"""Env config for fleet-backend."""
import os

DATABASE_URL = os.environ.get("DATABASE_URL", "")
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
OWNER_TG_ID = int(os.environ.get("OWNER_TG_ID", "0") or "0")
# Supergroup chat id (negative number). If empty, backend learns it from the first owner update.
SUPERGROUP_CHAT_ID = os.environ.get("SUPERGROUP_CHAT_ID", "")
# faster-whisper model size: tiny|base|small|medium. base is a good cpu default.
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "base")
PORT = int(os.environ.get("PORT", "8000"))

TG_API = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}"
TG_FILE = f"https://api.telegram.org/file/bot{TELEGRAM_BOT_TOKEN}"
