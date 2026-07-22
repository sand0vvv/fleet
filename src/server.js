// Local HTTP + WS server the runner hosts on localhost. Replaces the old cloud fleet-backend:
// each spawned agent's fleet MCP dials THIS server (FLEET_BACKEND_HTTP=http://localhost:PORT,
// FLEET_STREAM_WS=ws://localhost:PORT/agent/<name>/stream). Proven working in the de-risk spike.
//
// Endpoints the MCP uses:
//   GET  /health
//   POST /agent/:name/out      { text }          -> agent reply to owner  (handlers.onReply)
//   POST /agent/:name/file     (multipart-ish)   -> agent sends a file    (handlers.onFile)
//   POST /agent/:name/ack      { mid }           -> delivery ack          (handlers.onAck)
//   POST /agent/:name/notify   { text }          -> internal status       (handlers.onNotify)
//   POST /agent/:name/session  { session_id }    -> session tracking      (handlers.onSession)
//   POST /room/say             { from,room,text} -> room message          (handlers.onRoomSay)
//   GET  /agent/:name/rooms                      -> rooms for agent       (handlers.rooms)
//   WS   /agent/:name/stream?token=              -> push {mid,text,files} down to the live cli agent
import http from "node:http";
import { WebSocketServer } from "ws";

export function startServer({ port, token, handlers = {} }) {
  const streams = new Map(); // agent name -> ws (the MCP's cli stream)

  const ok = (req) => !token || (req.headers["x-fleet-token"] === token) ||
    (req.url && req.url.includes(`token=${encodeURIComponent(token)}`));

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const url = (req.url || "").split("?")[0];
      const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj || {})); };
      if (url === "/health") return send(200, { ok: true });
      if (!ok(req)) return send(401, { error: "unauthorized" });

      const m = url.match(/^\/agent\/([^/]+)\/(out|file|ack|notify|session|rooms)$/);
      if (m) {
        const name = decodeURIComponent(m[1]);
        const kind = m[2];
        let j = {};
        try { j = body ? JSON.parse(body) : {}; } catch {}
        try {
          if (kind === "out") { await handlers.onReply?.(name, j.text || "", j); return send(200, { ok: true }); }
          if (kind === "file") { await handlers.onFile?.(name, j); return send(200, { ok: true }); }
          if (kind === "ack") { await handlers.onAck?.(name, Number(j.mid) || 0); return send(200, { ok: true }); }
          if (kind === "notify") { await handlers.onNotify?.(name, j.text || ""); return send(200, { ok: true }); }
          if (kind === "session") { await handlers.onSession?.(name, j.session_id || "", j.status); return send(200, { ok: true }); }
          if (kind === "rooms") { return send(200, (await handlers.rooms?.(name)) || []); }
        } catch (e) { return send(500, { error: String(e?.message || e).slice(0, 200) }); }
      }
      if (url === "/room/say") {
        let j = {}; try { j = body ? JSON.parse(body) : {}; } catch {}
        await handlers.onRoomSay?.(j); return send(200, { ok: true });
      }
      if (req.method === "POST" && url === "/spawn") {
        let j = {}; try { j = body ? JSON.parse(body) : {}; } catch {}
        const r = (await handlers.onSpawn?.(j)) || { ok: false, error: "spawn not supported" };
        return send(r.ok ? 200 : 400, r);
      }
      send(404, {});
    });
  });

  // WS upgrades:
  //  /agent/:name/stream  — the MCP's cli stream (one per agent; a fresh connect replaces the old)
  //  /agent/:name/attach  — an interactive terminal viewer (many allowed; the runner wires it to the pty)
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = req.url || "";
    if (!ok(req)) return socket.destroy();
    const sm = url.match(/^\/agent\/([^/?]+)\/stream/);
    if (sm) {
      const name = decodeURIComponent(sm[1]);
      return wss.handleUpgrade(req, socket, head, (ws) => {
        const old = streams.get(name);
        if (old && old !== ws) { try { old.close(); } catch {} }
        streams.set(name, ws);
        handlers.onStreamConnect?.(name);
        ws.on("close", () => { if (streams.get(name) === ws) streams.delete(name); handlers.onStreamDisconnect?.(name); });
        ws.on("message", () => {}); // keepalive
      });
    }
    const am = url.match(/^\/agent\/([^/?]+)\/attach/);
    if (am) {
      const name = decodeURIComponent(am[1]);
      return wss.handleUpgrade(req, socket, head, (ws) => { handlers.onAttach?.(name, ws); });
    }
    socket.destroy();
  });

  return {
    server,
    // reject on bind errors (EADDRINUSE etc.) — without the once("error") handler the error is
    // emitted as an unhandled event and crashes the process before any caller's try/catch sees it.
    listen: () => new Promise((resolve, reject) => {
      const onErr = (e) => { server.removeListener("error", onErr); reject(e); };
      server.once("error", onErr);
      server.listen(port, () => { server.removeListener("error", onErr); resolve(port); });
    }),
    close: () => new Promise((r) => server.close(() => r())),
    isOnline: (name) => streams.has(name),
    // push a message down to a live cli agent. Returns false if the agent isn't connected.
    pushToAgent: (name, payload) => {
      const ws = streams.get(name);
      if (!ws || ws.readyState !== 1) return false;
      try { ws.send(JSON.stringify(payload)); return true; } catch { streams.delete(name); return false; }
    },
  };
}
