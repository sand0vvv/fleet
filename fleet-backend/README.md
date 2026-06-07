# fleet-backend (Railway)

The brain: agent/machine registry, routing, WS server for runners, coordinator (haiku),
sends to Telegram, Whisper (faster-whisper) for voice transcription.

- Down to runners: WebSocket (push: messages, spawn/kill, inject, file-URL).
- Up from runners/agents: HTTP POST (replies, send_message, status, usage).

_TODO: implement._
