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

const LOGDIR = join(process.cwd(), ".fleet");
try { mkdirSync(LOGDIR, { recursive: true }); } catch { /* ignore */ }
const LOGFILE = join(LOGDIR, "fleet-mcp.log");
function flog(...a) {
  const line = `${new Date().toISOString()} ${a.join(" ")}\n`;
  try { appendFileSync(LOGFILE, line); } catch { /* ignore */ }
  console.error("[fleet-mcp]", ...a);
}

const INSTRUCTIONS =
  "Ты — агент флота. Сообщения владельца приходят как channel-уведомления (📨). " +
  "Чтобы ответить владельцу — вызови инструмент `send_message`. Файлы — `send_file`. " +
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

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "send_message", description: "Отправить текст владельцу в Telegram (топик агента).",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    { name: "send_file", description: "Отправить файл владельцу в Telegram. path — локальный путь.",
      inputSchema: { type: "object", properties: { path: { type: "string" }, caption: { type: "string" } }, required: ["path"] } },
  ],
}));

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
      const buf = readFileSync(args.path);
      const fd = new FormData();
      fd.append("file", new Blob([buf]), basename(args.path));
      fd.append("caption", args.caption || "");
      await fetch(`${BACKEND}/agent/${encodeURIComponent(AGENT)}/file`,
        { method: "POST", headers: { "x-fleet-token": TOKEN }, body: fd });
      flog("send_file ok", args.path);
      return { content: [{ type: "text", text: "sent" }] };
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
  ws.on("open", () => flog("stream OPEN for", AGENT));
  ws.on("message", async (data) => {
    flog("stream msg:", data.toString().slice(0, 200));
    try {
      const msg = JSON.parse(data.toString());
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
    } catch (e) { flog("bad stream frame:", e.message); }
  });
  ws.on("close", (c) => { flog("stream CLOSE", c, "-> reconnect 3s"); setTimeout(connectStream, 3000); });
  ws.on("error", (e) => flog("stream ERROR:", e.message));
}

async function main() {
  flog(`startup agent=${AGENT} mode=${MODE} backend=${BACKEND} stream=${STREAM_WS || "(none)"}`);
  if (MODE === "cli") connectStream();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  flog("MCP connected (stdio)");
}

main().catch((e) => { flog("fatal:", e.message); process.exit(1); });
