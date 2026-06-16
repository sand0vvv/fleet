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
    """Transcribe a voice file. NEVER returns a silent empty string on failure — returns a visible
    marker so the agent/owner knows it failed (a silent '' reads as 'нихуя' to the owner). Order:
    Groq (1 retry) -> local faster-whisper fallback -> marker."""
    try:
        audio = await _download(file_url)
    except Exception as e:
        log("download failed:", e)
        return "[🎤 не смог скачать голосовое — повтори]"

    if GROQ_API_KEY:
        for attempt in (1, 2):
            try:
                txt = await _groq(audio)
                if txt:
                    return txt
                log(f"groq returned empty (attempt {attempt})")
            except Exception as e:
                log(f"groq failed (attempt {attempt}):", e)
        # Groq exhausted/limited/erroring -> try local whisper as a fallback
        try:
            log("groq unavailable -> local faster-whisper fallback")
            txt = _local(audio)
            if txt:
                return txt
        except Exception as e:
            log("local fallback failed:", e)
        return "[🎤 голос не распознал — транскрипция недоступна (вероятно лимит Groq). Повтори текстом]"

    # no Groq key -> local only
    try:
        return _local(audio) or "[🎤 голос не распознал — повтори текстом]"
    except Exception as e:
        log("local failed:", e)
        return "[🎤 голос не распознал — повтори текстом]"
