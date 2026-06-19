@echo off
REM ── Docker REBUILD (Docker в WSL) — после обновления кода (git pull на ветке operator). ──
REM Пересобирает образ и перезапускает контейнер. Логин Claude и состояние НЕ слетают (в томах).
wsl -d Ubuntu-22.04 -e bash -lc "cd /mnt/c/Users/vovav/Desktop/fleet && sudo docker compose -f docker-compose.docker.wsl.yml up -d --build"
echo.
echo Docker пересобран и перезапущен.
pause
