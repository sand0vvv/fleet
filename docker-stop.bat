@echo off
REM ── Docker STOP — двойной клик. Останавливает и убирает контейнер оператора. ──
REM Тома (логин Claude, состояние) сохраняются — следующий старт быстрый, логин не слетит.
cd /d "%~dp0"
echo Останавливаю Docker...
docker compose -f docker-compose.docker.yml down
echo.
echo Docker остановлен. Запустить снова: docker-start.bat
pause
