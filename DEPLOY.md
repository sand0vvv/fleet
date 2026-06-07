# fleet — деплой и тест (headless v1)

Цель: поднять `fleet-backend` на Railway, запустить `runner` локально, протестить петлю
на финансисте в Telegram. Быстрый путь — 1 сервис на Railway (receiver добавим позже).

## 0. Telegram (один раз)
1. @BotFather → новый бот → **скопировать token**.
2. Создать **супергруппу**, в настройках включить **Topics (форум)**.
3. Добавить бота в группу, сделать **админом** с правом **Manage Topics**.
4. Узнать свой **user_id** (@userinfobot) → это `OWNER_TG_ID`.

## 1. Railway — сервис `fleet-backend`
1. New Project → Deploy from GitHub → репо `fleet`.
2. В настройках сервиса **Root Directory = `fleet-backend`**.
3. Variables:
   - `DATABASE_URL` = строка Supabase
   - `TELEGRAM_BOT_TOKEN` = токен бота
   - `OWNER_TG_ID` = твой id
   - (опц.) `WHISPER_MODEL` = base
4. Deploy → скопировать публичный URL (напр. `https://fleet-backend-xxxx.up.railway.app`).

## 2. Webhook Telegram → backend
```
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<backend-url>/tg/update"
```

## 3. Backend узнаёт группу
Напиши в General группы **/help** — бэк запомнит chat_id группы и ответит подсказкой.

## 4. Локально — runner
1. `claude` установлен и **залогинен** (агенты запускаются через него).
2. Зависимости: `pip install httpx websockets python-dotenv`
3. `runner/.env`:
   ```
   FLEET_BACKEND_HTTP=https://<backend-url>
   FLEET_BACKEND_WS=wss://<backend-url>/ws/runner
   MACHINE_NAME=home
   RUNNER_TOKEN=любая-строка
   ```
4. Запуск: `python runner/runner.py` → в логе «connected ... as home», машина `home` появилась.

## 5. Тест на финансисте
В General:
```
/machines                       # должна быть home — online
/spawn home C:\путь\к\financier headless        # (можно добавить модель: ... headless sonnet)
```
→ появится топик с именем папки, агент напишет «на связи». Пиши ему в топик — он отвечает.
Файл киданёшь в топик → упадёт в `<financier>\.inbox\`, агент его прочитает.
Голос → backend транскрибирует (первый раз скачает whisper-модель, чуть подождать).

## Что НЕ в этой версии (следующий заход)
- cli-режим (живое окно + инжект) — пока работает только headless.
- channels-mcp (агент сам шлёт `send_message`/файлы по ходу) — в headless ответ = финальный вывод claude.
- `/usage`, `/compact` — заглушки.
- receiver как отдельный сервис (сейчас webhook напрямую в backend).

## Заметки
- Имя машины в `/spawn` (`home`) должно совпадать с `MACHINE_NAME` раннера.
- `.fleet.json`/`.mcp.json` в папке агента пока НЕ нужны — runner берёт путь/режим/модель из команды.
