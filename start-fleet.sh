#!/usr/bin/env bash
# Fleet runner launcher (Linux). Run: ./start-fleet.sh  (chmod +x first)
# Auto-restarts the runner if it exits, so the machine stays online.
cd "$(dirname "$0")/runner" || exit 1
echo "FLEET RUNNER - keep this terminal open (closing it takes your machine offline)"
PY="$(command -v python3 || command -v python)"
while true; do
  "$PY" runner.py start
  echo "[Fleet] runner exited. Restarting in 5s... (Ctrl+C to quit)"
  sleep 5
done
