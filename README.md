# fleet

Управление локальными Claude Code'ами из Telegram: чат (голос/файлы), спавн, управление флотом.
Отдельный проект (не AEON). Принцип — максимально просто.

Полный спек: `ARCHITECTURE.md` + `CONTRACT.md` в репозитории `take-a-chance-main`.

## Структура
- `receiver/` — Telegram webhook (Railway): валидирует owner, форвардит в backend.
- `fleet-backend/` — мозг (Railway): реестр, роутинг, WS-сервер для runner'ов, координатор, отправка в TG, Whisper (faster-whisper в контейнере).
- `runner/` — локально: WS к backend, спавн/watchdog локальных CC (headless/cli), `.inbox/.outbox`.
- `channels-mcp/` — MCP в каждом агенте: 1 тул `send_message(text, files?)`.
- `fleet-control-mcp/` — MCP координатора: `spawn_agent`, `list_agents`, `kill_agent`, ...
- `migrations/` — SQL-миграции схемы `fleet` (+ раннер `db.py`).

## Миграции
```
DATABASE_URL=... python migrations/db.py "$(cat migrations/001_fleet_schema.sql)"
```

## БД (схема `fleet`)
`machines`, `agents`, `messages`. owner whitelist = env `OWNER_TG_ID`.
Continuity агента = `claude --resume <session_id>`; история = сам Telegram.

## Транспорт
WS вниз (backend→runner, push) · HTTP POST вверх (runner/agent→backend).

## Railway
2 сервиса: `receiver` + `fleet-backend`. Без Redis, без Storage.
