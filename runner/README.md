# runner (local, per machine)

Long-running local process. One outbound WS to `fleet-backend`. Spawns/watchdogs local
Claude Code processes (headless `claude --resume -p` / cli Windows Terminal tabs `wt -w fleet new-tab`),
handles `.inbox/.outbox` files, relays agent POSTs up. Does NOT do Whisper (that's on backend).

_TODO: implement._
