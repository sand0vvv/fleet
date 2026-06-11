"""Telegram Bot API client (async, httpx)."""
import os
import asyncio
import httpx
from config import TG_API, TG_FILE


# Short, bounded timeout so a Telegram egress blip can never wedge the event loop
# (a long hang here cascades into WS-handshake timeouts and crash-loops). Failures are
# swallowed and reported as {"ok": False} — outbound delivery degrades, control plane survives.
_TG_TIMEOUT = httpx.Timeout(8.0, connect=5.0)
_TG_RETRIES = 3


async def _post(method, **params):
    """POST to the Telegram API with a few quick retries — Railway↔Telegram egress is intermittently
    flaky, and a brief blip shouldn't lose a reply/restart confirmation. Logs the REAL exception type
    (the old empty error told us nothing) so an ongoing outage is diagnosable, not a mystery."""
    payload = {k: v for k, v in params.items() if v is not None}
    last = None
    for attempt in range(1, _TG_RETRIES + 1):
        try:
            async with httpx.AsyncClient(timeout=_TG_TIMEOUT) as c:
                r = await c.post(f"{TG_API}/{method}", json=payload)
                return r.json()
        except Exception as e:
            last = e
            print(f"[telegram] {method} attempt {attempt}/{_TG_RETRIES} failed: {type(e).__name__}: {e!r}")
            if attempt < _TG_RETRIES:
                await asyncio.sleep(0.8 * attempt)
    return {"ok": False, "error": f"{type(last).__name__}: {last}"}


async def send_message(chat_id, text, message_thread_id=None, reply_to=None):
    # Telegram text limit 4096; chunk if needed.
    chunks = [text[i:i + 4000] for i in range(0, len(text or " "), 4000)] or [" "]
    last = None
    for ch in chunks:
        last = await _post("sendMessage", chat_id=chat_id, text=ch,
                           message_thread_id=message_thread_id, reply_to_message_id=reply_to)
    return last


async def send_message_as(api_base, chat_id, text, message_thread_id=None):
    """Send a message through a SPECIFIC bot token (api_base = https://api.telegram.org/bot<token>).
    Used for the Docker (@hud113) identity in the war-room so the owner sees a distinct sender."""
    chunks = [text[i:i + 4000] for i in range(0, len(text or " "), 4000)] or [" "]
    last = None
    try:
        async with httpx.AsyncClient(timeout=_TG_TIMEOUT) as c:
            for ch in chunks:
                r = await c.post(f"{api_base}/sendMessage",
                                 json={k: v for k, v in {"chat_id": chat_id, "text": ch,
                                                         "message_thread_id": message_thread_id}.items() if v is not None})
                last = r.json()
    except Exception as e:
        print(f"[telegram] send_message_as failed: {e}")
        return {"ok": False, "error": str(e)}
    return last


async def send_document(chat_id, file_path, caption=None, message_thread_id=None, filename=None):
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=5.0)) as c:
            with open(file_path, "rb") as f:
                data = {"chat_id": str(chat_id)}
                if caption:
                    data["caption"] = caption[:1024]
                if message_thread_id:
                    data["message_thread_id"] = str(message_thread_id)
                r = await c.post(f"{TG_API}/sendDocument", data=data,
                                 files={"document": (filename or os.path.basename(file_path), f)})
                return r.json()
    except Exception as e:
        print(f"[telegram] send_document failed: {e}")
        return {"ok": False, "error": str(e)}


async def send_photo(chat_id, file_path, caption=None, message_thread_id=None, filename=None):
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=5.0)) as c:
            with open(file_path, "rb") as f:
                data = {"chat_id": str(chat_id)}
                if caption:
                    data["caption"] = caption[:1024]
                if message_thread_id:
                    data["message_thread_id"] = str(message_thread_id)
                r = await c.post(f"{TG_API}/sendPhoto", data=data,
                                 files={"photo": (filename or os.path.basename(file_path), f)})
                return r.json()
    except Exception as e:
        print(f"[telegram] send_photo failed: {e}")
        return {"ok": False, "error": str(e)}


async def create_forum_topic(chat_id, name):
    res = await _post("createForumTopic", chat_id=chat_id, name=name[:128])
    return (res.get("result") or {}).get("message_thread_id")


async def delete_forum_topic(chat_id, message_thread_id):
    return await _post("deleteForumTopic", chat_id=chat_id, message_thread_id=message_thread_id)


async def edit_forum_topic(chat_id, message_thread_id, name):
    return await _post("editForumTopic", chat_id=chat_id,
                       message_thread_id=message_thread_id, name=name[:128])


async def pin_message(chat_id, message_id):
    return await _post("pinChatMessage", chat_id=chat_id, message_id=message_id,
                       disable_notification=True)


async def unpin_message(chat_id, message_id):
    return await _post("unpinChatMessage", chat_id=chat_id, message_id=message_id)


async def get_file_url(file_id):
    """Resolve a Telegram file_id to a temporary downloadable URL."""
    res = await _post("getFile", file_id=file_id)
    path = (res.get("result") or {}).get("file_path")
    return f"{TG_FILE}/{path}" if path else None


async def set_webhook(url, secret=None):
    return await _post("setWebhook", url=url, secret_token=secret,
                       allowed_updates=["message", "edited_message"])
