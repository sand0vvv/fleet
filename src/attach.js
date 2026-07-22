#!/usr/bin/env node
// Interactive terminal window attached to a live fleet agent's pty.
// The runner opens one of these (by default) when it spawns an agent, so the owner gets a real
// window to WATCH and WORK in. Keystrokes go to the agent's stdin; fleet still injects Telegram
// messages via the MCP channel and can send native /clear /compact — all share the one pty.
//
//   detach: Ctrl+]   (closes this window without killing the agent)
import WebSocket from "ws";

const agent = process.argv[2] || process.env.FLEET_ATTACH_AGENT;
const port = process.env.FLEET_ATTACH_PORT || "9987";
const token = process.env.FLEET_ATTACH_TOKEN || "";
if (!agent) { console.error("usage: node attach.js <agent>"); process.exit(1); }

const url = `ws://localhost:${port}/agent/${encodeURIComponent(agent)}/attach?token=${encodeURIComponent(token)}`;
process.stdout.write(`\x1b]0;fleet: ${agent}\x07`); // window title
console.log(`\x1b[2m[fleet] attaching to "${agent}" — detach with Ctrl+]\x1b[0m\r`);

const ws = new WebSocket(url);

ws.on("open", () => {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  const sendResize = () => { try { ws.send(JSON.stringify({ resize: [process.stdout.columns || 100, process.stdout.rows || 30] })); } catch {} };
  sendResize();
  process.stdout.on("resize", sendResize);

  process.stdin.on("data", (d) => {
    // Ctrl+]  (0x1d) = detach
    if (d.length === 1 && d[0] === 0x1d) { cleanup(); process.exit(0); }
    try { ws.send(d); } catch {}
  });
});

ws.on("message", (data) => { process.stdout.write(typeof data === "string" ? data : data.toString("utf8")); });
// clean close (detach / agent parked or killed) -> exit immediately so the console window closes.
ws.on("close", () => { cleanup(); process.exit(0); });
// error (e.g. runner not reachable) -> pause so the message is readable before the window closes.
ws.on("error", (e) => { console.log(`\r\n\x1b[31m[fleet] attach error: ${e.message}\x1b[0m\r`); cleanup(); setTimeout(() => process.exit(1), 4000); });

function cleanup() { try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch {} }
