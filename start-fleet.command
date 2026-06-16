#!/usr/bin/env bash
# Fleet runner launcher (macOS — double-click opens Terminal and runs this).
# Auto-restarts the runner if it exits, so the machine stays online.
cd "$(dirname "$0")/runner" || exit 1
echo "================================================"
echo " FLEET RUNNER  -  keep this window open"
echo " (closing it takes your machine offline)"
echo "================================================"
PY="$(command -v python3 || command -v python)"
while true; do
  "$PY" runner.py start
  echo
  echo "[Fleet] runner exited. Restarting in 5s... (Ctrl+C to quit)"
  sleep 5
done
