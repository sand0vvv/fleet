"""Voice transcription via faster-whisper (lazy-loaded so the app boots without the model)."""
import httpx
from config import WHISPER_MODEL

_model = None


def _get_model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel  # heavy import, lazy
        _model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
    return _model


async def transcribe_url(file_url: str) -> str:
    """Download a Telegram voice file and transcribe it. Returns '' on failure."""
    try:
        async with httpx.AsyncClient(timeout=60) as c:
            r = await c.get(file_url)
            r.raise_for_status()
            tmp = "/tmp/voice_in.oga"
            with open(tmp, "wb") as f:
                f.write(r.content)
        model = _get_model()
        segments, _ = model.transcribe(tmp, beam_size=1)
        return " ".join(s.text for s in segments).strip()
    except Exception as e:
        print(f"[transcribe] failed: {e}")
        return ""
