"""channels-mcp — lean MCP given to every opt-in Claude Code.

Lets the agent proactively message the owner (and send files) into its own
Telegram topic, by POSTing to fleet-backend. Env injected by the runner:
  FLEET_BACKEND_HTTP, FLEET_AGENT_NAME
"""
import os
import httpx
from mcp.server.fastmcp import FastMCP

BACKEND = os.environ.get("FLEET_BACKEND_HTTP", "").rstrip("/")
AGENT = os.environ.get("FLEET_AGENT_NAME", "")

mcp = FastMCP("channels")


@mcp.tool()
def send_message(text: str) -> str:
    """Send a text message to the owner in this agent's Telegram topic."""
    httpx.post(f"{BACKEND}/agent/{AGENT}/out", json={"text": text}, timeout=30)
    return "sent"


@mcp.tool()
def send_file(path: str, caption: str = "") -> str:
    """Send a local file (image or document) to the owner in this agent's topic."""
    with open(path, "rb") as f:
        httpx.post(
            f"{BACKEND}/agent/{AGENT}/file",
            files={"file": (os.path.basename(path), f)},
            data={"caption": caption},
            timeout=120,
        )
    return "sent"


if __name__ == "__main__":
    mcp.run()
