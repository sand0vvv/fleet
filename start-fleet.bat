@echo off
REM Fleet runner launcher (Windows). Double-click to start your machine.
REM Auto-restarts the runner if it ever exits, so your machine stays online.
title Fleet Runner
cd /d "%~dp0runner"
echo ================================================
echo  FLEET RUNNER  -  keep this window open
echo  (closing it takes your machine offline)
echo ================================================
echo.
:loop
python runner.py start
echo.
echo [Fleet] runner exited. Restarting in 5s... (close window or Ctrl+C to quit)
timeout /t 5 /nobreak >nul
goto loop
