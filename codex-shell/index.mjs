/**
 * fleet-codex — single-terminal wrapper around the official Codex CLI that
 * delivers fleet (Telegram) messages directly into the live conversation via
 * the codex app-server JSON-RPC protocol.
 *
 * Ported VERBATIM (in spirit) from @inbetweenai/codex-shell. The injection
 * mechanism — app-server spawn, `codex --remote`, JSON-RPC turn/start, seen
 * dedup — is unchanged. Only the IDENTITY / MESSAGE SOURCE is rebranded:
 * instead of the InBetween backend WS + ~/.inbetween session file, we connect
 * to the LOCAL fleet runner stream (the same stream the fleet MCP dials) and
 * inject the `{mid,text}` frames it pushes down.
 *
 * Architecture:
 *   1. Spawn `codex app-server --listen ws://127.0.0.1:0` in the background
 *      (stdio piped — we read its port from stderr).
 *   2. Open WS to the app-server, `initialize`, listen for `thread/started`
 *      from the TUI, capture its threadId.
 *   3. Spawn `codex --remote ws://127.0.0.1:PORT --dangerously-bypass-approvals-and-sandbox`
 *      with stdio: 'inherit' — Codex TUI takes over the *current* terminal.
 *   4. Open WS to the LOCAL runner stream (FLEET_STREAM_WS). On each incoming
 *      `{mid,text}` frame → `turn/start` in Codex (or `turn/steer` if a turn is
 *      already active). Dedup by mid. Ack via POST /agent/<name>/ack.
 *   5. When the Codex TUI exits, the wrapper exits.
 *
 * Codex OUTGOING (agent → owner) goes through the fleet MCP (send_message),
 * exactly like Claude — this file only owns the INCOMING inject path.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, appendFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

// ---------------------------------------------------------------------------
// CONFIG — fleet identity from the environment (wired by the runner).
// ---------------------------------------------------------------------------
const AGENT = process.env.FLEET_AGENT_NAME || "";
const TOKEN = process.env.FLEET_TOKEN || "";
const STREAM_WS = process.env.FLEET_STREAM_WS || "";
const BACKEND_HTTP = (process.env.FLEET_BACKEND_HTTP || "").replace(/\/$/, "");

// ---------------------------------------------------------------------------
// LOGGING — to a file, not stderr. Codex TUI uses an alt-screen buffer; any
// console.* call after launch corrupts the rendering. Banner is the only
// thing we print to stderr (briefly, before TUI starts).
// ---------------------------------------------------------------------------
// Keep a per-user marker home too, matching the ~/.inbetween → ~/.fleet rename.
try { mkdirSync(join(homedir(), ".fleet"), { recursive: true }); } catch {}
const LOG_DIR = join(process.cwd(), ".fleet");
const LOG_FILE = join(LOG_DIR, "codex-shell.log");
let logReady = false;
function ensureLogReady() {
  if (logReady) return;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(
      LOG_FILE,
      `\n\n=== fleet-codex started at ${new Date().toISOString()} (cwd=${process.cwd()} agent=${AGENT}) ===\n`,
    );
    logReady = true;
  } catch {
    // best-effort; if we can't write logs, just silently drop them
  }
}
function log(...parts) {
  ensureLogReady();
  if (!logReady) return;
  const line = `[${new Date().toISOString()}] ${parts.join(" ")}\n`;
  try {
    appendFileSync(LOG_FILE, line);
  } catch {}
}

// ANSI helpers (zero deps).
const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  gray: "\x1b[90m",
};

function printBanner() {
  const lines = [
    "",
    `  ${C.bold}${C.cyan}╭─────────────────────────────────────────────╮${C.reset}`,
    `  ${C.bold}${C.cyan}│${C.reset}  ${C.bold}fleet${C.reset} ${C.dim}x${C.reset} ${C.bold}Codex${C.reset}                              ${C.bold}${C.cyan}│${C.reset}`,
    `  ${C.bold}${C.cyan}│${C.reset}  ${C.dim}native push messaging for AI agents${C.reset}        ${C.bold}${C.cyan}│${C.reset}`,
    `  ${C.bold}${C.cyan}╰─────────────────────────────────────────────╯${C.reset}`,
    "",
  ];
  if (AGENT) {
    lines.push(`  ${C.green}●${C.reset} agent ${C.bold}@${AGENT}${C.reset}`);
  } else {
    lines.push(`  ${C.yellow}●${C.reset} ${C.dim}FLEET_AGENT_NAME not set${C.reset}`);
  }
  lines.push(
    `  ${C.gray}stream${C.reset}   ${STREAM_WS || "(none)"}`,
    `  ${C.gray}backend${C.reset}  ${BACKEND_HTTP || "(none)"}`,
    `  ${C.gray}log${C.reset}      ${LOG_FILE}`,
    "",
    `  ${C.dim}Codex TUI starts below. /exit to quit.${C.reset}`,
    "",
  );
  process.stderr.write(lines.join("\n") + "\n");
}

printBanner();

// ---------------------------------------------------------------------------
// 1. Spawn codex app-server, capture port
// ---------------------------------------------------------------------------
const server = spawn("codex", ["app-server", "--listen", "ws://127.0.0.1:0"], {
  stdio: ["ignore", "pipe", "pipe"],
  shell: platform() === "win32",
});

server.on("error", (err) => {
  process.stderr.write(
    `[fleet-codex] failed to spawn codex app-server: ${err.message}\n` +
      `is \`codex\` in PATH? Try: codex --version\n`,
  );
  process.exit(1);
});

server.on("exit", (code) => {
  log(`codex app-server exited (${code})`);
});

let appServerPort = null;
let onAppServerReadyCalled = false;
// The app-server prints its bound address to stderr (and sometimes stdout).
// Scan both so we don't miss the port.
function scanForPort(line) {
  log("[codex-server]", line);
  const m = line.match(/127\.0\.0\.1:(\d+)/);
  if (m && !appServerPort) {
    appServerPort = Number(m[1]);
    if (!onAppServerReadyCalled) {
      onAppServerReadyCalled = true;
      onAppServerReady();
    }
  }
}
createInterface({ input: server.stderr }).on("line", scanForPort);
createInterface({ input: server.stdout }).on("line", scanForPort);

// ---------------------------------------------------------------------------
// 2. Once app-server is up: connect ourselves, then spawn TUI inline
// ---------------------------------------------------------------------------
async function onAppServerReady() {
  log(`app-server listening on ws://127.0.0.1:${appServerPort}`);

  // 2a. Open our control-plane connection to the app-server.
  const appWs = new WebSocket(`ws://127.0.0.1:${appServerPort}`);
  let nextId = 1;
  const pending = new Map();
  function rpc(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      appWs.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  // State.
  let activeThreadId = null;
  const messageQueue = [];

  // Dedup: avoid re-injecting messages that the runner replays after a WS
  // reconnect. Tracks last N seen mids.
  const seenMessageIds = new Set();
  const SEEN_MAX = 500;
  function markSeen(id) {
    if (!id) return;
    seenMessageIds.add(id);
    if (seenMessageIds.size > SEEN_MAX) {
      const toDrop = seenMessageIds.size - SEEN_MAX / 2;
      let i = 0;
      for (const k of seenMessageIds) {
        if (i++ >= toDrop) break;
        seenMessageIds.delete(k);
      }
    }
  }

  // Ack delivery back to the runner (so it advances its cursor / stops replay).
  async function ackToRunner(mid) {
    if (!mid || !BACKEND_HTTP || !AGENT) return;
    try {
      await fetch(`${BACKEND_HTTP}/agent/${encodeURIComponent(AGENT)}/ack`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-fleet-token": TOKEN },
        body: JSON.stringify({ mid }),
      });
      log(`acked mid=${mid}`);
    } catch (e) {
      log(`ack failed for mid=${mid}: ${e.message}`);
    }
  }

  async function deliverToCodex(item) {
    // item: { mid, text }
    if (!activeThreadId) {
      messageQueue.push(item);
      log(`queued message mid=${item.mid} (no active thread yet)`);
      return;
    }
    if (item.mid && seenMessageIds.has(item.mid)) {
      log(`skip duplicate mid=${item.mid}`);
      await ackToRunner(item.mid);
      return;
    }
    markSeen(item.mid);
    // The fleet MCP normally wraps the owner's text with a reminder to reply via
    // send_message; the runner stream gives us the raw text, so we add the same
    // guidance here so the codex agent knows the owner only sees send_message.
    const text =
      `📨 Message from the owner:\n\n${item.text}\n\n` +
      `⚠️ Reply to the owner ONLY via the send_message tool — your console text is invisible to him.`;
    try {
      await rpc("turn/start", {
        threadId: activeThreadId,
        input: [{ type: "text", text }],
      });
      log(`delivered mid=${item.mid} → turn/start`);
    } catch (e) {
      const msg = JSON.stringify(e);
      if (
        msg.includes("ActiveTurn") ||
        msg.includes("active") ||
        msg.includes("busy")
      ) {
        try {
          await rpc("turn/steer", {
            threadId: activeThreadId,
            input: [{ type: "text", text }],
          });
          log(`delivered mid=${item.mid} → turn/steer (turn was busy)`);
        } catch (e2) {
          log("failed to steer:", JSON.stringify(e2));
        }
      } else {
        log("failed to start turn:", msg);
      }
    }
    await ackToRunner(item.mid);
  }

  appWs.on("open", async () => {
    try {
      await rpc("initialize", {
        clientInfo: { name: "fleet-codex", version: "0.1.0" },
        capabilities: {},
      });
      log("app-server initialized");
      // Now that our control plane is connected, launch the TUI in this same
      // terminal. It will create a thread, fire thread/started, and the message
      // handler below will pick up the threadId and flush the queue.
      spawnTuiInline(appServerPort);
    } catch (e) {
      log("initialize failed:", JSON.stringify(e));
    }
  });

  appWs.on("message", async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(msg.error);
      else resolve(msg.result);
      return;
    }
    if (msg.method === "thread/started" && msg.params?.thread?.id) {
      const newId = msg.params.thread.id;
      if (newId !== activeThreadId) {
        activeThreadId = newId;
        log(`active thread = ${newId} (queued: ${messageQueue.length})`);
        while (messageQueue.length > 0) {
          const item = messageQueue.shift();
          await deliverToCodex(item);
        }
      }
    }
  });

  appWs.on("close", () => {
    log("app-server WS closed");
  });
  appWs.on("error", (e) => log("app-server WS error:", e.message));

  // ---------------------------------------------------------------------------
  // 3. Connect to the LOCAL fleet runner stream (the identity/source rebrand).
  //    Same shape the fleet MCP consumes: {mid,text[,files]} frames. Injects
  //    each into codex via deliverToCodex(). Auto-reconnects on drop.
  // ---------------------------------------------------------------------------
  let streamWs = null;
  let reconnectTimer = null;

  function connectStream() {
    if (!STREAM_WS) {
      log("no FLEET_STREAM_WS set — running without inject stream");
      return;
    }
    log(`connecting to runner stream ${STREAM_WS} as @${AGENT}`);
    streamWs = new WebSocket(STREAM_WS);

    // Heartbeat: a half-open socket never fires "close", so the client thinks
    // it's connected while the runner has already dropped it. Ping every 20s;
    // if the prior ping got no pong, the link is dead → terminate → reconnect.
    let alive = true;
    let pingTimer = null;

    streamWs.on("open", () => {
      log(`runner stream OPEN for @${AGENT}`);
      alive = true;
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (!alive) {
          log("runner stream no pong → terminate");
          try {
            streamWs.terminate();
          } catch {}
          return;
        }
        alive = false;
        try {
          streamWs.ping();
        } catch {}
      }, 20000);
    });
    streamWs.on("pong", () => {
      alive = true;
    });

    streamWs.on("message", (data) => {
      log("runner stream msg:", data.toString().slice(0, 200));
      let frame;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return;
      }
      const mid = frame.mid || 0;
      let text = frame.text || "";
      // Files arrive as URLs; note them inline so the agent knows they exist.
      if (frame.files && frame.files.length) {
        text += `\n[files received: ${frame.files.join(", ")}]`;
      }
      if (!text.trim()) {
        // Nothing to inject but still ack so the runner advances its cursor.
        ackToRunner(mid);
        return;
      }
      deliverToCodex({ mid, text });
    });

    streamWs.on("close", (code, reason) => {
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      log(`runner stream CLOSE (code=${code} reason=${reason || "-"}) → reconnect 3s`);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectStream, 3000);
    });
    streamWs.on("error", (e) => {
      log(`runner stream ERROR: ${e.message}`);
      try {
        streamWs.terminate();
      } catch {}
    });
  }

  connectStream();
}

// ---------------------------------------------------------------------------
// Spawn TUI inline — same terminal, no second window.
// ---------------------------------------------------------------------------
function spawnTuiInline(port) {
  const args = [
    "--remote",
    `ws://127.0.0.1:${port}`,
    "--dangerously-bypass-approvals-and-sandbox",
  ];
  log(`launching TUI inline: codex ${args.join(" ")}`);
  const tui = spawn("codex", args, {
    stdio: "inherit",
    shell: platform() === "win32",
  });
  tui.on("error", (err) => {
    process.stderr.write(`\n[fleet-codex] failed to launch TUI: ${err.message}\n`);
    process.exit(1);
  });
  tui.on("exit", (code) => {
    log(`TUI exited (code=${code})`);
    try {
      server.kill();
    } catch {}
    process.exit(code ?? 0);
  });
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
process.on("SIGINT", () => {
  log("SIGINT received, stopping");
  try {
    server.kill();
  } catch {}
  process.exit(0);
});
