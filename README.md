# fleet

Управление локальными Claude Code'ами из Telegram: чат (текст/голос/файлы), спавн, управление флотом.
Отдельный проект (не AEON). Принцип — максимально просто.

## Архитектура

```
Telegram ──webhook──► receiver (Railway) ──► fleet-backend (Railway)
                                                  │  Postgres (Supabase, схема fleet)
                                                  │  Whisper (faster-whisper) для голоса
                                   WS (push)  ◄───┤
   локально:  runner ◄────────────────────────────┘
     ├─ headless-агенты: claude --resume -p  (запуск на сообщение)
     └─ cli-агенты:      claude в отдельном окне + channel-inject
            └─ fleet-mcp (server: fleet) — send_message/send_file + приём канала
```

- **receiver** — тонкий вебхук Telegram, форвардит в backend.
- **fleet-backend** — мозг: реестр агентов/машин, роутинг, debounce, Whisper, отправка в TG, WS-сервер для runner'ов и cli-стримов.
- **runner** — локально на машине: WS к backend, спавн/контроль агентов, логирование (`.fleet/logs/`).
- **fleet-mcp** — MCP-сервер (имя `fleet`) внутри каждого агента: тулзы `send_message`/`send_file`; в cli ещё и инжект входящих в живую сессию через `notifications/claude/channel`.

## Два режима агента
- **headless** — claude запускается на каждое сообщение (`--resume -p`), ответ = вывод. Дёшев в простое.
- **cli** — claude живёт в отдельном окне; сообщения инжектятся в живую сессию (channel), ответ через `send_message`. Тёплый контекст.

Режим в команде `/spawn` или `/mode`. cli требует `--dangerously-load-development-channels` (промпт авто-подтверждается runner'ом через SendKeys).

## Файлы
- **Тебе → агенту:** кидаешь файл в топик → скачивается в `<project>/.inbox/` → агент читает нативно (`Read`). Работает и в headless, и в cli.
- **Агент → тебе:** `send_file(path)` → приходит в топик с оригинальным именем.

## Голос
Голосовое → backend → Whisper (faster-whisper, либо Groq если задан `GROQ_API_KEY`) → текст → агенту.

## Команды (Telegram)
- `/spawn <machine> <path> [headless|cli] [model]` — поднять агента (создаётся топик)
- `/list` · `/machines` · `/status <a>` · `/kill <a>` (полный снос: процесс+топик+БД)
- `/restart <a>` · `/mode <a> <headless|cli>` · `/model <a> <m>` · `/rename <a> <title>`
- `/sessions <a>` · `/use <a> <id>` — список/выбор сессии папки
- `/new <a>` · `/stop <a>` · `/compact <a>` · `/help`
- `/usage` (только в General) — реальная панель лимитов Claude (сессия 5ч / неделя / неделя Sonnet) через `/api/oauth/usage` (токен из `~/.claude/.credentials.json` на runner-машине)

## Структура репо
`receiver/` · `fleet-backend/` · `runner/` · `fleet-mcp/` · `migrations/`

## Локальная установка (на машину с агентами)
1. `claude` установлен и залогинен, Node, Python.
2. `cd fleet-mcp && npm install`
3. `runner/.env`: `FLEET_BACKEND_HTTP`, `FLEET_BACKEND_WS`, `MACHINE_NAME`, `RUNNER_TOKEN`
4. `python runner/runner.py` — старт (баннер + логи в консоль/`.fleet/logs/`).
   - `python runner/runner.py doctor` — самопроверка (env, backend /health, claude)
   - `python runner/runner.py status` — живое состояние (`.fleet/status.json`: connected, cli-агенты, PID)

Runner — это CLI-приложение: автoreconnect WS, watchdog (ловит упавшие cli-окна → пишет в топик `/restart`), ротация логов, чистка cli-окон при Ctrl+C.

## CI / релизы
GitHub Actions (ruff + pytest + py_compile + node --check) на каждый push. Релизы — по фичам (`v0.x.0`).
