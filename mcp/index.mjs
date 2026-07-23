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
  "Ты — агент флота. Сообщения приходят как channel-уведомления (📨), часто с меткой источника " +
  "вида `[📍 откуда · от кого]` — смотри её, чтобы понять, ОТКУДА сообщение и куда отвечать. " +
  "У тебя ДВА вида поверхностей: (1) твой ЛИЧНЫЙ топик с владельцем — отвечай туда через `send_message`; " +
  "(2) КОМНАТЫ — общие топики с другими агентами (напр. war-room с poly) — пиши туда через " +
  "`say_in_room(room, text)` для координации с напарником. Узнать свои комнаты — `my_rooms`. " +
  "Правило: владельцу в личке → send_message; напарнику в комнате → say_in_room. " +
  "Обычный текст в консоли владелец НЕ видит; видит только отправленное через эти тулзы.";

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
    { name: "send_message", description: "Отправить текст владельцу в Telegram (топик агента).",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    { name: "send_file", description: "Отправить файл владельцу в Telegram. path — локальный путь.",
      inputSchema: { type: "object", properties: { path: { type: "string" }, caption: { type: "string" } }, required: ["path"] } },
    { name: "say_in_room",
      description: "Написать в КОМНАТУ — общий топик с другим агентом (напр. war-room). Так ты координируешься с напарником (напр. poly), и это видно владельцу. Для ответа ВЛАДЕЛЬЦУ в своём личном топике — обычный send_message. room = название комнаты (узнать через my_rooms).",
      inputSchema: { type: "object", properties: { room: { type: "string" }, text: { type: "string" } }, required: ["room", "text"] } },
    { name: "my_rooms",
      description: "Узнать, в каких КОМНАТАХ (общих топиках) ты состоишь и с кем — чтобы понимать, где можешь координироваться помимо личного топика.",
      inputSchema: { type: "object", properties: {} } },
  ];
  if (CONTROL) {
    tools.push({
      name: "fleet_command",
      description: "Управление флотом — выполнить слэш-команду: /spawn <machine> <path> [headless|cli] [model], "
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
      return { content: [{ type: "text", text: j.ok ? `отправлено в комнату ${args.room}` : `ошибка: ${j.error || "не вышло"}` }] };
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
  const content = `📨 Сообщение от владельца:\n\n${text}\n\n⚠️ Ответь владельцу ТОЛЬКО через инструмент send_message — твой текст в консоли он НЕ видит.`;
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
  // so the client thinks it's connected while the backend has already dropped it -> "cli не на связи"
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
        text += `\n[файлы получены: ${paths.join(", ")}]`;
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
