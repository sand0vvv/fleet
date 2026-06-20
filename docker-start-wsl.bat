@echo off
REM ── Docker START (Docker в WSL) — двойной клик. Поднимает контейнер в фоне. ──
REM Окно можно закрыть — контейнер продолжит работать.
wsl -d Ubuntu-22.04 -e bash -lc "sudo service docker start >/dev/null 2>&1; cd /mnt/c/Users/vovav/Desktop/fleet && sudo docker compose -f docker-compose.docker.wsl.yml up -d"
echo.
echo Docker запущен в WSL. Окно можно закрыть.
echo Остановить: docker-stop-wsl.bat  |  После обновления кода: docker-rebuild-wsl.bat
pause
