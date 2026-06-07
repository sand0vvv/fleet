"""receiver — thin Telegram webhook front door.

Validates the optional secret header, forwards the raw update to fleet-backend,
always returns 200 so Telegram never backs off.
"""
import os
import httpx
from fastapi import FastAPI, Request

app = FastAPI(title="fleet-receiver")
BACKEND = os.environ.get("FLEET_BACKEND_URL", "").rstrip("/")
SECRET = os.environ.get("TELEGRAM_WEBHOOK_SECRET", "")
FLEET_TOKEN = os.environ.get("FLEET_TOKEN", "")


@app.get("/health")
async def health():
    return {"ok": True}


@app.post("/webhook/telegram")
async def webhook(req: Request):
    if SECRET and req.headers.get("x-telegram-bot-api-secret-token") != SECRET:
        return {"ok": True}
    body = await req.body()
    try:
        async with httpx.AsyncClient(timeout=20) as c:
            await c.post(f"{BACKEND}/tg/update", content=body,
                         headers={"content-type": "application/json", "x-fleet-token": FLEET_TOKEN})
    except Exception as e:
        print(f"[receiver] forward failed: {e}")
    return {"ok": True}
