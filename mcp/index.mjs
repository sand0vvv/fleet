#!/usr/bin/env node
/**
 * fleet-mcp — MCP server given to every opt-in Claude Code (server name: "fleet").
 *
 * Tools (always): send_message, send_file -> POST to fleet-backend -> owner's topic.
 * cli mode (FLEET_MODE=cli): opens a WS to the backend per-agent stream and injects
 *   incoming owner messages into the LIVE session via `notifications/claude/channel`.
 *
 * Logs to <cwd>/.fleet/fleet-mcp.log (cwd = the agent's project dir).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import WebSocket from "ws";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";

const BACKEND = (process.env.FLEET_BACKEND_HTTP || "").replace(/\/$/, "");
const AGENT = process.env.FLEET_AGENT_NAME || "";
const MODE = process.env.FLEET_MODE || "headless";
const STREAM_WS = process.env.FLEET_STREAM_WS || "";
const TOKEN = process.env.FLEET_TOKEN || "";
const CONTROL = process.env.FLEET_CONTROL === "1";  // coordinator gets fleet_command

const LOGDIR = join(process.cwd(), ".fleet");
try { mkdirSync(LOGDIR, { recursive: true }); } catch { /* ignore */ }
const LOGFILE = join(LOGDIR, "fleet-mcp.log");
function flog(...a) {
  const line = `${new Date().toISOString()} ${a.join(" ")}\n`;
  try { appendFileSync(LOGFILE, line); } catch { /* ignore */ }
  console.error("[fleet-mcp]", ...a);
}

// ── delivery dedup: persisted high-water (skip mid <= seen) ──
const CURSOR = join(LOGDIR, "cursor.json");
function hw() { try { return JSON.parse(readFileSync(CURSOR, "utf-8")).hw || 0; } catch { return 0; } }
function setHw(mid) { try { writeFileSync(CURSOR, JSON.stringify({ hw: mid })); } catch { /* ignore */ } }
async function ack(mid) {
  try {
    await fetch(`${BACKEND}/agent/${encodeURIComponent(AGENT)}/ack`, {
      method: "POST", headers: { "content-type": "application/json", "x-fleet-token": TOKEN },
      body: JSON.stringify({ mid }),
    });
  } catch { /* ignore */ }
}

const INSTRUCTIONS =
  "You are a fleet agent. Messages arrive as channel notifications (📨), often with a source label " +
  "like `[📍 where · from whom]` — read it to know WHERE a message came from and where to answer. " +
  "You have TWO surfaces: (1) your PERSONAL topic with the owner — answer there via `send_message`; " +
  "(2) ROOMS — topics shared with other agents — write there via `say_in_room(room, text)` to " +
  "coordinate with a teammate. List your rooms with `my_rooms`. " +
  "Rule: owner in your topic → send_message; teammate in a room → say_in_room. " +
  "Plain console text is INVISIBLE to the owner; only these tools reach them.";

const server = new Server(
  { name: "fleet", version: "0.1.0" },
  {
    capabilities: {
      tools: {},
      logging: {},
      // Claude Code Channels — REQUIRED so claude treats this server as a channel
      // provider and accepts notifications/claude/channel into the live session.
      experimental: { "claude/channel": {}, "claude/channel/permission": {} },
    },
    instructions: INSTRUCTIONS,
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = [
    { name: "send_message", description: "Send text to the owner in Telegram (this agent's topic).",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    { name: "send_file", description: "Send a file to the owner in Telegram. path = local file path.",
      inputSchema: { type: "object", properties: { path: { type: "string" }, caption: { type: "string" } }, required: ["path"] } },
    { name: "say_in_room",
      description: "Write into a ROOM — a topic shared with another agent. This is how you coordinate with a teammate, visibly to the owner. To answer the OWNER in your personal topic use plain send_message. room = room name (see my_rooms).",
      inputSchema: { type: "object", properties: { room: { type: "string" }, text: { type: "string" } }, required: ["room", "text"] } },
    { name: "my_rooms",
      description: "List which ROOMS (shared topics) you are in and with whom — your coordination surfaces besides the personal topic.",
      inputSchema: { type: "object", properties: {} } },
  ];
  if (CONTROL) {
    tools.push({
      name: "fleet_command",
      description: "Fleet control — run a slash command: /spawn <machine> <path> [headless|cli] [model], "
        + "/list, /machines, /kill <name>, /restart <name>, /mode <name> <m>, /model, /rename, /sessions, /use, /new, /stop, /compact.",
      inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    });
  }
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    if (name === "send_message") {
      await fetch(`${BACKEND}/agent/${encodeURIComponent(AGENT)}/out`, {
        method: "POST", headers: { "content-type": "application/json", "x-fleet-token": TOKEN },
        body: JSON.stringify({ text: args.text }),
      });
      flog("send_message ok");
      return { content: [{ type: "text", text: "sent" }] };
    }
    if (name === "send_file") {
      // The runner is LOCAL (same machine) — no need to upload bytes, just hand it the path.
      // (The old multipart body got JSON-parsed to {} by the runner and the file silently died.)
      readFileSync(args.path); // fail fast with a clear error if the path is wrong
      const r = await fetch(`${BACKEND}/agent/${encodeURIComponent(AGENT)}/file`, {
        method: "POST", headers: { "content-type": "application/json", "x-fleet-token": TOKEN },
        body: JSON.stringify({ path: args.path, caption: args.caption || "" }),
      });
      flog("send_file", r.ok ? "ok" : `HTTP ${r.status}`, args.path);
      return { content: [{ type: "text", text: r.ok ? "sent" : `send failed (HTTP ${r.status})` }] };
    }
    if (name === "say_in_room") {
      const r = await fetch(`${BACKEND}/room/say`, {
        method: "POST", headers: { "content-type": "application/json", "x-fleet-token": TOKEN },
        body: JSON.stringify({ from: AGENT, room: args.room, text: args.text }),
      });
      const j = await r.json().catch(() => ({}));
      flog("say_in_room", args.room, j.ok);
      return { content: [{ type: "text", text: j.ok ? `sent to room ${args.room}` : `error: ${j.error || "failed"}` }] };
    }
    if (name === "my_rooms") {
      const r = await fetch(`${BACKEND}/agent/${encodeURIComponent(AGENT)}/rooms`, { headers: { "x-fleet-token": TOKEN } });
      const j = await r.json().catch(() => []);
      flog("my_rooms", JSON.stringify(j).slice(0, 120));
      return { content: [{ type: "text", text: JSON.stringify(j) }] };
    }
    if (name === "fleet_command" && CONTROL) {
      await fetch(`${BACKEND}/fleet/command`, {
        method: "POST", headers: { "content-type": "application/json", "x-fleet-token": TOKEN },
        body: JSON.stringify({ command: args.command }),
      });
      flog("fleet_command:", args.command);
      return { content: [{ type: "text", text: "executed: " + args.command }] };
    }
    return { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true };
  } catch (e) {
    flog("tool error:", e.message);
    return { content: [{ type: "text", text: `error: ${e.message}` }], isError: true };
  }
});

async function injectChannel(text) {
  const content = `📨 Message from the owner:\n\n${text}\n\n⚠️ Reply to the owner ONLY via the send_message tool — your console text is INVISIBLE to them.`;
  try {
    await server.notification({ method: "notifications/claude/channel", params: { content, meta: { source: "fleet" } } });
    flog("injected channel notification");
  } catch (e) {
    flog("channel notify failed:", e.message);
  }
}

async function downloadToInbox(url) {
  const inbox = join(process.cwd(), ".inbox");
  try { mkdirSync(inbox, { recursive: true }); } catch { /* ignore */ }
  const name = decodeURIComponent((url.split("/").pop() || "file").split("?")[0]) || "file";
  const dest = join(inbox, name);
  const res = await fetch(url);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

function connectStream() {
  if (!STREAM_WS) { flog("cli mode but FLEET_STREAM_WS empty!"); return; }
  flog("connecting stream:", STREAM_WS);
  const ws = new WebSocket(STREAM_WS);
  // Heartbeat: without it a half-open socket (Railway idle-timeout / network blip) never fires "close",
  // so the client thinks it's connected while the backend has already dropped it -> "agent offline"
  // until a manual /restart. Ping every 20s; if the prior ping got no pong, the link is dead -> kill it
  // (which fires "close" -> the 3s reconnect below). This is what stops the bogus offline state.
  let alive = true, pingTimer = null;
  ws.on("open", () => {
    flog("stream OPEN for", AGENT);
    alive = true;
    pingTimer = setInterval(() => {
      if (!alive) { flog("stream no pong -> terminate"); try { ws.terminate(); } catch {} return; }
      alive = false;
      try { ws.ping(); } catch {}
    }, 20000);
  });
  ws.on("pong", () => { alive = true; });
  ws.on("message", async (data) => {
    flog("stream msg:", data.toString().slice(0, 200));
    try {
      const msg = JSON.parse(data.toString());
      const mid = msg.mid || 0;
      if (mid && mid <= hw()) { await ack(mid); return; }  // already injected -> no duplicate
      let text = msg.text || "";
      if (msg.files && msg.files.length) {
        const paths = [];
        for (const u of msg.files) {
          try { paths.push(await downloadToInbox(u)); }
          catch (e) { flog("download fail:", e.message); paths.push(u); }
        }
        text += `\n[files received: ${paths.join(", ")}]`;
      }
      if (text.trim()) injectChannel(text);
      if (mid) { setHw(mid); await ack(mid); }
    } catch (e) { flog("bad stream frame:", e.message); }
  });
  ws.on("close", (c) => {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    flog("stream CLOSE", c, "-> reconnect 3s");
    setTimeout(connectStream, 3000);
  });
  ws.on("error", (e) => { flog("stream ERROR:", e.message); try { ws.terminate(); } catch {} });
}

async function main() {
  flog(`startup agent=${AGENT} mode=${MODE} backend=${BACKEND} stream=${STREAM_WS || "(none)"}`);
  if (MODE === "cli") connectStream();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  flog("MCP connected (stdio)");
}

main().catch((e) => { flog("fatal:", e.message); process.exit(1); });
