@echo off
REM ── Docker START — двойной клик. Поднимает контейнер оператора в ФОНЕ. ──
REM После запуска это окно можно закрыть — контейнер продолжит работать сам.
cd /d "%~dp0"
echo Запускаю Docker (фоновый контейнер)...
docker compose -f docker-compose.docker.yml up -d --build
if %errorlevel% neq 0 (
  echo.
  echo ОШИБКА запуска. Проверь, что Docker Desktop запущен и runner\.env заполнен.
  pause
  exit /b 1
)
echo.
echo Docker работает в фоне. Это окно можно закрыть — контейнер не остановится.
echo Остановить: двойной клик docker-stop.bat
pause
