#!/usr/bin/env node
/**
 * fleet-mcp — MCP server given to every opt-in Claude Code (server name: "fleet").
 *
 * Tools (always): send_message, send_file  -> POST to fleet-backend -> owner's topic.
 * cli mode (FLEET_MODE=cli): opens a WS to the backend per-agent stream and injects
 *   incoming owner messages into the LIVE session via `notifications/claude/channel`
 *   (Claude Code Channels — requires launching claude with
 *    `--dangerously-load-development-channels server:fleet`).
 *
 * Env (injected by runner):
 *   FLEET_BACKEND_HTTP, FLEET_AGENT_NAME, [FLEET_MODE=cli], [FLEET_STREAM_WS]
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import WebSocket from "ws";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const BACKEND = (process.env.FLEET_BACKEND_HTTP || "").replace(/\/$/, "");
const AGENT = process.env.FLEET_AGENT_NAME || "";
const MODE = process.env.FLEET_MODE || "headless";
const STREAM_WS = process.env.FLEET_STREAM_WS || "";

const INSTRUCTIONS =
  "Ты — агент флота. Сообщения владельца приходят как channel-уведомления (📨). " +
  "Чтобы ответить владельцу — вызови инструмент `send_message`. Чтобы отправить файл — `send_file`. " +
  "Обычный текст ответа в консоли владелец НЕ видит; видит только то, что ты отправил через эти тулзы.";

const server = new Server(
  { name: "fleet", version: "0.1.0" },
  { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
);

// ── tools ────────────────────────────────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "send_message",
      description: "Отправить текстовое сообщение владельцу в Telegram (в топик этого агента).",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
    {
      name: "send_file",
      description: "Отправить файл (картинку/документ) владельцу в Telegram. path — локальный путь.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, caption: { type: "string" } },
        required: ["path"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    if (name === "send_message") {
      await fetch(`${BACKEND}/agent/${encodeURIComponent(AGENT)}/out`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: args.text }),
      });
      return { content: [{ type: "text", text: "sent" }] };
    }
    if (name === "send_file") {
      const buf = readFileSync(args.path);
      const fd = new FormData();
      fd.append("file", new Blob([buf]), basename(args.path));
      fd.append("caption", args.caption || "");
      await fetch(`${BACKEND}/agent/${encodeURIComponent(AGENT)}/file`, { method: "POST", body: fd });
      return { content: [{ type: "text", text: "sent" }] };
    }
    return { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true };
  } catch (e) {
    return { content: [{ type: "text", text: `error: ${e.message}` }], isError: true };
  }
});

// ── cli mode: receive owner messages over WS, inject into live session ────────
function injectChannel(text) {
  const content = `📨 Сообщение от владельца:\n\n${text}`;
  // Native Claude Code channel (server:fleet). Falls back to a log notification.
  server.notification({ method: "notifications/claude/channel", params: { content, meta: { source: "fleet" } } })
    .catch(() => {});
  server.notification({ method: "notifications/message", params: { level: "info", logger: "fleet", data: content } })
    .catch(() => {});
}

function connectStream() {
  if (!STREAM_WS) {
    console.error("[fleet-mcp] cli mode but FLEET_STREAM_WS not set");
    return;
  }
  const ws = new WebSocket(STREAM_WS);
  ws.on("open", () => console.error(`[fleet-mcp] stream open for @${AGENT}`));
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      let text = msg.text || "";
      if (msg.files && msg.files.length) text += `\n[файлы: ${msg.files.join(", ")}]`;
      if (text.trim()) injectChannel(text);
    } catch (e) {
      console.error("[fleet-mcp] bad stream frame:", e.message);
    }
  });
  ws.on("close", () => { setTimeout(connectStream, 3000); });
  ws.on("error", (e) => console.error("[fleet-mcp] stream error:", e.message));
}

async function main() {
  if (MODE === "cli") connectStream();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[fleet-mcp] ready (agent=${AGENT}, mode=${MODE})`);
}

main().catch((e) => { console.error("[fleet-mcp] fatal:", e); process.exit(1); });
