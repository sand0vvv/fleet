"""Voice transcription.

Priority: Groq API (no local RAM, fast, accurate) if GROQ_API_KEY set,
otherwise local faster-whisper (heavy — may OOM small containers).
"""
import sys
import httpx
from config import WHISPER_MODEL, GROQ_API_KEY

_model = None


def log(*a):
    print("[transcribe]", *a, file=sys.stderr, flush=True)


def _get_model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel  # heavy, lazy
        _model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
    return _model


async def _download(url: str) -> bytes:
    async with httpx.AsyncClient(timeout=60) as c:
        r = await c.get(url)
        r.raise_for_status()
        return r.content


async def _groq(audio: bytes) -> str:
    async with httpx.AsyncClient(timeout=120) as c:
        r = await c.post(
            "https://api.groq.com/openai/v1/audio/transcriptions",
            headers={"Authorization": f"Bearer {GROQ_API_KEY}"},
            data={"model": "whisper-large-v3-turbo"},
            # Telegram voice is OGG/Opus; Groq validates by extension -> use .ogg
            files={"file": ("audio.ogg", audio, "audio/ogg")},
        )
        if r.status_code >= 400:
            log("groq error", r.status_code, r.text[:400])
        r.raise_for_status()
        return (r.json().get("text") or "").strip()


def _local(audio: bytes) -> str:
    tmp = "/tmp/voice_in.oga"
    with open(tmp, "wb") as f:
        f.write(audio)
    segments, _ = _get_model().transcribe(tmp, beam_size=1)
    return " ".join(s.text for s in segments).strip()


async def transcribe_url(file_url: str) -> str:
    try:
        audio = await _download(file_url)
        if GROQ_API_KEY:
            log("using Groq API")
            return await _groq(audio)
        log(f"using local faster-whisper ({WHISPER_MODEL})")
        return _local(audio)
    except Exception as e:
        log("failed:", e)
        return ""
