# Docker runner — the CONTAINERIZED fleet runner = the JAIL for the operator's agents.
# Only the host workspace folder (see docker-compose: C:\operator -> /workspace) is mounted in.
# Nothing else on the host disk is visible, so --dangerously-skip-permissions is SAFE here:
# the container IS the cage. Outbound network goes through the host's IP (geo = owner's region).
FROM node:20-bookworm-slim

# python3 (runs runner.py) + git (agents clone/push their repos) + ca-certs for TLS.
# NO gh CLI by design — Operator wires his own git/GitHub auth inside the workspace.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Claude Code CLI — the engine the runner spawns per agent.
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app
COPY . /app

# runner deps (httpx/websockets/dotenv) + fleet-mcp deps (the MCP agents load: send_message/channels).
RUN pip3 install --no-cache-dir --break-system-packages -r runner/requirements.txt \
    && (cd fleet-mcp && npm install --omit=dev)

# /workspace = the ONLY host folder mounted in (docker-compose). Operator /spawn's agents into it.
RUN mkdir -p /workspace

WORKDIR /app/runner
CMD ["python3", "runner.py", "start"]
