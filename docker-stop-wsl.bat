@echo off
REM ── Docker STOP (Docker в WSL) — двойной клик. Останавливает контейнер. ──
REM Тома (логин Claude, состояние) сохраняются — следующий старт быстрый.
wsl -d Ubuntu-22.04 -e bash -lc "cd /mnt/c/Users/vovav/Desktop/fleet && sudo docker compose -f docker-compose.docker.wsl.yml down"
echo.
echo Docker остановлен. Запустить снова: docker-start-wsl.bat
pause
