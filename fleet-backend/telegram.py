"""Telegram Bot API client (async, httpx)."""
import httpx
from config import TG_API, TG_FILE


async def _post(method, **params):
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(f"{TG_API}/{method}", json={k: v for k, v in params.items() if v is not None})
        return r.json()


async def send_message(chat_id, text, message_thread_id=None, reply_to=None):
    # Telegram text limit 4096; chunk if needed.
    chunks = [text[i:i + 4000] for i in range(0, len(text or " "), 4000)] or [" "]
    last = None
    for ch in chunks:
        last = await _post("sendMessage", chat_id=chat_id, text=ch,
                           message_thread_id=message_thread_id, reply_to_message_id=reply_to)
    return last


async def send_document(chat_id, file_path, caption=None, message_thread_id=None):
    async with httpx.AsyncClient(timeout=120) as c:
        with open(file_path, "rb") as f:
            data = {"chat_id": str(chat_id)}
            if caption:
                data["caption"] = caption[:1024]
            if message_thread_id:
                data["message_thread_id"] = str(message_thread_id)
            r = await c.post(f"{TG_API}/sendDocument", data=data, files={"document": f})
            return r.json()


async def send_photo(chat_id, file_path, caption=None, message_thread_id=None):
    async with httpx.AsyncClient(timeout=120) as c:
        with open(file_path, "rb") as f:
            data = {"chat_id": str(chat_id)}
            if caption:
                data["caption"] = caption[:1024]
            if message_thread_id:
                data["message_thread_id"] = str(message_thread_id)
            r = await c.post(f"{TG_API}/sendPhoto", data=data, files={"photo": f})
            return r.json()


async def create_forum_topic(chat_id, name):
    res = await _post("createForumTopic", chat_id=chat_id, name=name[:128])
    return (res.get("result") or {}).get("message_thread_id")


async def delete_forum_topic(chat_id, message_thread_id):
    return await _post("deleteForumTopic", chat_id=chat_id, message_thread_id=message_thread_id)


async def get_file_url(file_id):
    """Resolve a Telegram file_id to a temporary downloadable URL."""
    res = await _post("getFile", file_id=file_id)
    path = (res.get("result") or {}).get("file_path")
    return f"{TG_FILE}/{path}" if path else None


async def set_webhook(url, secret=None):
    return await _post("setWebhook", url=url, secret_token=secret,
                       allowed_updates=["message", "edited_message"])
