// runner.js — the integration entry the CLI's `start` imports and calls.
//
// startRunner(config) wires the whole local fleet:
//   config -> localhost server (startServer) -> telegram long-poll (pollUpdates) -> watchdog.
//
// Flow:
//   owner (Telegram) --getUpdates--> routeUpdate:
//       auth (config.ownerId once linked; /link works before) ->
//       General topic  -> command (commands.js)
//       agent topic    -> command (if it starts '/') OR enqueue owner message (delivery.js, 15s debounce)
//   agent reply: MCP --POST /agent/:name/out--> server.handlers.onReply --> telegram.sendMessage to its topic
//   stream (re)connect: server.handlers.onStreamConnect --> delivery.replay(name)
//   crashed pty: agents.onExit --> watchdog auto-restart (crash-loop guarded)
import { startServer } from "./server.js";
import { makeTelegram, pollUpdates } from "./telegram.js";
import * as registry from "./registry.js";
import * as agents from "./agents.js";
import { createDelivery } from "./delivery.js";
import { createCommands, commandOf } from "./commands.js";
import { spawnCodexAgent } from "./engine-codex.js";
import { transcribeUrl } from "./transcribe.js";
import { linkOwner, isLinked, loadConfig, fleetDir } from "./config.js";
import { randomBytes } from "node:crypto";
import { spawn as spawnProc, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));

// Slash-commands the RUNNER handles inside an agent topic. Anything else (`/model`, `/cost`, `/doctor`…)
// is treated as a native Claude/Codex command and forwarded straight into the agent's terminal.
const FLEET_TOPIC_CMDS = new Set([
  "kill", "restart", "hide", "show", "new", "stop", "sessions", "use", "rename",
  "status", "context", "clear", "compact", "list", "spawn", "link", "help", "model", "usage",
]);

// The bot's slash-command menu (setMyCommands) — shows up in Telegram's "/" UI once the bot is running.
const BOT_COMMANDS = [
  { command: "spawn", description: "Start an agent in a folder: /spawn <path> [codex]" },
  { command: "list", description: "List your agents (General only)" },
  { command: "restart", description: "Restart the agent" },
  { command: "hide", description: "Hide the window, keep the agent running" },
  { command: "show", description: "Show / wake the agent's window" },
  { command: "kill", description: "Delete the agent and its topic" },
  { command: "context", description: "Show the agent's context size" },
  { command: "model", description: "Pick the agent's model" },
  { command: "usage", description: "Fleet overview (agents + context)" },
  { command: "sessions", description: "List the agent's saved sessions" },
  { command: "clear", description: "Clear the agent's session" },
  { command: "compact", description: "Compact the agent's session" },
  { command: "link", description: "Bind this supergroup to you" },
  { command: "help", description: "Show help" },
];

// forwarded-message tag (ports util.forward_prefix)
function person(u) {
  if (!u) return "";
  return [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || "";
}
function forwardPrefix(msg) {
  const fo = msg.forward_origin || {};
  let name = "";
  if (fo.type === "user") name = person(fo.sender_user || {});
  else if (fo.type === "hidden_user") name = fo.sender_user_name || "";
  else if (fo.type === "channel") name = (fo.chat || {}).title || "";
  else if (fo.type === "chat") name = (fo.sender_chat || {}).title || "";
  const forwarded = Boolean(fo.type || msg.forward_from || msg.forward_sender_name || msg.forward_from_chat || msg.forward_date);
  if (!forwarded) return "";
  return name ? `[forwarded from ${name}]\n` : "[forwarded]\n";
}

export async function startRunner(config) {
  let cfg = config || loadConfig();
  const log = (...a) => console.error("[fleet]", ...a);

  if (!cfg.botToken) throw new Error("no botToken in config — run `fleet init` first");

  // a shared secret between the runner's localhost server and the MCP it wires into each project.
  if (!cfg.runnerToken) cfg.runnerToken = randomBytes(16).toString("hex");
  const token = cfg.runnerToken;
  const port = cfg.port || 9987;
  const backendHttp = `http://localhost:${port}`;
  const streamWsFor = (name) => `ws://localhost:${port}/agent/${encodeURIComponent(name)}/stream?token=${encodeURIComponent(token)}`;

  registry.loadState();

  // ── agent window/lifecycle state (park on window-close; /hide keeps it running) ──
  const attachWs = new Map();     // name -> current attach-window ws
  const hideKeep = new Set();     // names whose window is being closed by /hide (don't park)
  const codexHandles = new Map(); // name -> codex handle (codex runs in its OWN console window, not a pty)

  // "alive" = a Claude pty in agents, OR a running codex window.
  const isAgentAlive = (name) => agents.isAlive(name) || codexHandles.has(name);

  // window closed by the owner -> PARK: kill the pty to free resources; registry + sessionId kept so
  // the next message (or /show) wakes it with --continue. Set status BEFORE kill so the watchdog skips it.
  function parkAgent(name) {
    registry.updateAgent(name, { status: "parked" });
    agents.killAgent(name);
    const h = codexHandles.get(name); if (h) { try { h.kill(); } catch {} codexHandles.delete(name); }
    log(`parked ${name} — freed; wakes on next message or /show`);
  }
  function hide(name) { // /hide: close the window but keep the agent running headless
    hideKeep.add(name);
    registry.updateAgent(name, { status: "hidden" });
    const ws = attachWs.get(name);
    try { ws?.send("\r\n\x1b[33m[fleet] hidden — agent keeps running. /show to reopen.\x1b[0m\r\n"); ws?.close(); } catch {}
  }
  function wakeAgent(name) { // spawn a parked agent (--continue via saved sessionId)
    if (isAgentAlive(name)) return false;
    spawnBound(name);
    registry.updateAgent(name, { status: "running" });
    log(`woke ${name}`);
    return true;
  }
  function show(name) { // /show: (re)open the window; wake if parked
    if (agents.isAlive(name)) { openAttachWindow(name); registry.updateAgent(name, { status: "running" }); }
    else wakeAgent(name);
  }

  const telegram = makeTelegram(cfg.botToken, { log });

  // ── outbound: agent reply -> its Telegram topic (reply-follows-origin) ──────
  async function onReply(name, text) {
    const a = registry.getAgent(name);
    const chat = cfg.supergroupId;
    if (!a || !chat || !text) return;
    const topic = a.replyTopic ?? a.topicId;
    log(`agent_out ${name} -> topic ${topic}: ${String(text).slice(0, 70)}`);
    await telegram.sendMessage(chat, text, topic);
  }

  async function onFile(name, j) {
    const a = registry.getAgent(name);
    const chat = cfg.supergroupId;
    if (!a || !chat) return;
    // the MCP posts JSON with a local path (it already downloaded/produced the file); send it.
    const path = j?.path;
    if (!path) return;
    const isImg = /\.(png|jpe?g|webp|gif)$/i.test(path);
    const fn = isImg ? telegram.sendPhoto : telegram.sendDocument;
    await fn(chat, path, { caption: j.caption || null, threadId: a.topicId });
  }

  async function onSession(name, sessionId, status) {
    const a = registry.getAgent(name);
    if (!a || !sessionId) return;
    const changed = a.sessionId !== sessionId;
    registry.updateAgent(name, { sessionId, status: status || "running" });
    if (changed && cfg.supergroupId && a.topicId) {
      const r = await telegram.sendMessage(cfg.supergroupId, `session: ${sessionId}`, a.topicId);
      const mid = (r?.result || {}).message_id;
      if (mid) {
        await telegram.pinMessage(cfg.supergroupId, mid);
        const old = a.pinMsgId;
        if (old && old !== mid) await telegram.unpinMessage(cfg.supergroupId, old);
        registry.updateAgent(name, { pinMsgId: mid });
      }
    }
  }

  async function onNotify(name, text) {
    const a = registry.getAgent(name);
    if (!a || !cfg.supergroupId || !text) return;
    await telegram.sendMessage(cfg.supergroupId, text, a.topicId); // always the agent's own topic
  }

  async function onAck(name, mid) {
    if (mid) registry.ackDelivered(name, mid);
  }

  // ── localhost server (MCP dials this) ───────────────────────────────────────
  const server = startServer({
    port,
    token,
    handlers: {
      onReply,
      onFile,
      onAck,
      onSession,
      onNotify,
      onStreamConnect: (name) => {
        registry.updateAgent(name, { status: "running" });
        delivery.markReady(name, 5000);                    // give a fresh agent time before injecting
        setTimeout(() => delivery.replay(name).catch(() => {}), 5200);
      },
      onStreamDisconnect: (name) => { log(`stream disconnect ${name}`); codexHandles.delete(name); }, // codex window closed -> allow re-spawn
      onRoomSay: () => {}, // rooms are a cloud-only feature; local single-owner build has none
      rooms: () => [],
      // `fleet claude` / `fleet codex` from a terminal: the CLI POSTs here to spawn an agent for a folder.
      onSpawn: async ({ path, engine }) => {
        if (!isLinked(cfg)) return { ok: false, error: "not linked — send /link in your supergroup first" };
        if (!path) return { ok: false, error: "no path" };
        await commands.handle(`/spawn ${path}${engine === "codex" ? " codex" : ""}`);
        return { ok: true };
      },
      // attach: wire an interactive terminal window to the agent's live pty (output + raw input + resize)
      onAttach: (name, ws) => {
        const unsub = agents.subscribeOutput(name, (chunk) => { try { ws.send(chunk); } catch {} });
        if (!unsub) { try { ws.send(`\r\n[fleet] agent "${name}" is not running.\r\n`); ws.close(); } catch {} return; }
        attachWs.set(name, ws);
        ws.on("message", (data, isBinary) => {
          if (!isBinary) { // control frame (resize) as text JSON
            try { const j = JSON.parse(data.toString()); if (Array.isArray(j.resize)) { agents.resizeAgent(name, j.resize[0], j.resize[1]); return; } } catch {}
          }
          agents.writeRaw(name, data); // raw keystrokes -> pty stdin (owner can work in the window)
        });
        ws.on("close", () => {
          try { unsub(); } catch {}
          if (attachWs.get(name) === ws) attachWs.delete(name);
          // /hide closed the window on purpose -> keep the agent running; otherwise the owner closed
          // the window -> PARK (kill the pty to free resources; it wakes on the next message / /show).
          if (hideKeep.has(name)) { hideKeep.delete(name); return; }
          if (agents.isAlive(name)) parkAgent(name);
        });
      },
    },
  });

  // ── delivery (debounce + dedup) ─────────────────────────────────────────────
  const delivery = createDelivery({
    server,
    registry,
    ensureAlive: (name) => { try { wakeAgent(name); } catch {} }, // wake a parked agent so the message lands
    debounceSeconds: cfg.debounceSeconds ?? 15, // 0 = deliver immediately (?? keeps a real 0)
    log,
    notifyOffline: () => {}, // waking handles it; no need to nag the owner
  });

  // ── attach: open a real terminal window that mirrors the agent's pty (owner can work in it) ──
  // Default ON (config.attach !== false). The attach client connects back to the localhost server.
  function openAttachWindow(name) {
    if (cfg.attach === false) return;
    const client = join(__dirname, "attach.js").replace(/\\/g, "/");
    const env = { ...process.env, FLEET_ATTACH_PORT: String(port), FLEET_ATTACH_TOKEN: token, FLEET_ATTACH_AGENT: name };
    try {
      if (process.platform === "win32") {
        // new console window that connects to the agent's pty; closes when the client exits
        // (i.e. on kill/park/detach) — /c not /k, so a killed agent doesn't leave a dead window.
        spawnProc("cmd.exe", ["/c", "start", `fleet: ${name}`, "cmd", "/c", "node", client, name],
          { detached: true, stdio: "ignore", env });
      } else if (process.platform === "darwin") {
        spawnProc("osascript", ["-e", `tell app "Terminal" to do script "FLEET_ATTACH_PORT=${port} FLEET_ATTACH_TOKEN=${token} FLEET_ATTACH_AGENT=${name} node '${client}' ${name}"`],
          { detached: true, stdio: "ignore", env });
      } else {
        spawnProc("x-terminal-emulator", ["-e", `node ${client} ${name}`], { detached: true, stdio: "ignore", env });
      }
      log(`attach window opened for ${name}`);
    } catch (e) { log(`attach window failed for ${name}: ${String(e?.message || e)}`); }
  }

  // ── lifecycle: spawn / restart bound to current config + registry ────────────
  function spawnBound(name) {
    const a = registry.getAgent(name);
    if (!a) throw new Error(`no agent ${name}`);
    // Authoritative cursor sync (see agents.syncCursor): a stale hw silently eats every message.
    agents.syncCursor(a.projectPath, delivery.hw(name));
    if ((a.engine || "claude") === "codex") {
      // codex needs a real console TTY -> its own window (no node-pty / no attach model)
      const h = spawnCodexAgent(a, { backendHttp, streamWs: streamWsFor(name), token, log });
      codexHandles.set(name, h);
      if (a.freshNext) registry.updateAgent(name, { freshNext: false }); // /new consumed by this spawn
      return h.pid;
    }
    const pid = agents.spawnAgent(a, {
      backendHttp,
      streamWs: streamWsFor(name),
      token,
      channelMode: "dev",
      log,
      onExit: (n, e) => onAgentExit(n, e),
    });
    if (a.freshNext) registry.updateAgent(name, { freshNext: false }); // /new consumed by this spawn
    // Capture the ACTIVE session id (newest .jsonl in the project) once claude has booted, so the
    // next wake is an exact --resume (and the id gets pinned in the topic via onSession). Without
    // this the registry never learns the session and park/wake would rely on --continue alone.
    setTimeout(() => {
      try {
        if (!agents.isAlive(name)) return;
        const cur = registry.getAgent(name);
        const sid = agents.listSessions(cur?.projectPath || a.projectPath)[0]?.id;
        if (sid && cur && sid !== cur.sessionId) onSession(name, sid).catch(() => {});
      } catch {}
    }, 15000);
    return pid;
  }
  function killCodex(name) { const h = codexHandles.get(name); if (h) { try { h.kill(); } catch {} codexHandles.delete(name); } }
  function restartBound(name) {
    killCodex(name);
    agents.killAgent(name);
    return spawnBound(name);
  }

  // watchdog: a pty exit triggers auto-restart with a crash-loop guard (ports runner.py monitor).
  function onAgentExit(name, exitInfo) {
    const a = registry.getAgent(name);
    if (!a) return; // killed on purpose (record already deleted)
    if (a.status === "stopped" || a.status === "parked") return; // deliberate stop / window-close park
    if (isAgentAlive(name)) return; // a newer pty is already running (restart raced the old exit) — don't double-spawn
    const g = agents.shouldRestart(name);
    if (g.loop) {
      onNotify(name, `crash loop (${g.count}x in 5min) — auto-restart stopped. Fix it, then /restart ${name}.`);
      return;
    }
    try {
      agents.noteRestart(name);
      const pid = spawnBound(name);
      onNotify(name, `watchdog: "${name}" crashed -> restarted (pid ${pid}).`);
    } catch (e) {
      onNotify(name, `watchdog: auto-restart "${name}" failed: ${String(e?.message || e)}. /restart manually.`);
    }
  }

  // ── commands ────────────────────────────────────────────────────────────────
  const commands = createCommands({
    telegram,
    registry,
    agents,
    spawn: spawnBound,
    restart: restartBound,
    // engine-agnostic full stop for /kill /stop: mark stopped FIRST (watchdog checks status), kill
    // both engines, drop queued msgs (nothing resurrects it), close the attach window (attach.js
    // exits on ws close -> its console window closes).
    stopAgent: (n) => {
      registry.updateAgent(n, { status: "stopped" });
      const ws = attachWs.get(n);
      if (ws) hideKeep.add(n); // this attach-ws close must NOT be treated as a window-close park
      killCodex(n);
      agents.killAgent(n);
      delivery.clear(n);
      try { ws?.send("\r\n\x1b[31m[fleet] agent killed.\x1b[0m\r\n"); ws?.close(); } catch {}
      attachWs.delete(n);
    },
    hide,
    show,
    config: () => cfg,
    log,
    onLinked: (owner, sg) => { cfg = loadConfig(); log(`linked owner=${owner} supergroup=${sg}`); },
  });

  // ── inline-button taps (from /model, /context) ──────────────────────────────
  async function handleCallback(cq) {
    const from = (cq.from || {}).id;
    if (cfg.ownerId && from !== cfg.ownerId) { await telegram.answerCallback(cq.id); return; }
    const [action, agentName, value] = String(cq.data || "").split(":");
    const a = registry.getAgent(agentName);
    if (action === "model" && a) {
      registry.updateAgent(agentName, { model: value === "default" ? "" : value });
      await telegram.answerCallback(cq.id, `model: ${value}`);
      await telegram.sendMessage(cfg.supergroupId, `${agentName}: model → ${value} · /restart to apply`, a.topicId);
    } else if (action === "compact" && a) {
      if (!agents.isAlive(agentName)) wakeAgent(agentName);
      agents.writeInput(agentName, "/compact");
      await telegram.answerCallback(cq.id, "compacting…");
      await telegram.sendMessage(cfg.supergroupId, `${agentName}: compacting… (watch the window; /context to see the new size)`, a.topicId);
    } else {
      await telegram.answerCallback(cq.id);
    }
  }

  // ── inbound routing (ports app.py tg_update) ────────────────────────────────
  async function routeUpdate(upd) {
    if (upd.callback_query) return handleCallback(upd.callback_query);
    const msg = upd.message || upd.edited_message;
    if (!msg) return;
    const frm = (msg.from || {}).id;
    const chat = msg.chat || {};
    const threadId = msg.message_thread_id;

    // owner auth once linked; before linking we only accept /link (so the owner can bind).
    const linked = isLinked(cfg);
    if (linked && cfg.ownerId && frm !== cfg.ownerId) { log(`ignored non-owner ${frm}`); return; }

    // learn the supergroup id the first time the owner speaks in a group (helps /link autopfill)
    if ((chat.type === "supergroup" || chat.type === "group") && !cfg.supergroupId) {
      // don't auto-link owner, but remember the chat so /link can use it / spawn can create topics
      cfg.supergroupId = chat.id;
    }

    let text = msg.text || msg.caption || "";
    const files = [];
    if (msg.voice) {
      const url = await telegram.getFileUrl(msg.voice.file_id);
      text = url ? await transcribeUrl(url, cfg.whisper || {}) : "[voice: couldn't fetch audio]";
      log(`voice -> ${String(text).slice(0, 60)}`);
    } else if (msg.photo) {
      const url = await telegram.getFileUrl(msg.photo[msg.photo.length - 1].file_id);
      if (url) files.push(url);
    } else if (msg.document) {
      const url = await telegram.getFileUrl(msg.document.file_id);
      if (url) files.push(url);
    }

    text = forwardPrefix(msg) + text;

    // reply linkage: owner replies to a specific message -> tag it for the agent
    const rt = msg.reply_to_message;
    if (rt && !rt.forum_topic_created && rt.message_id !== threadId) {
      const quoted = (rt.text || rt.caption || "").slice(0, 200);
      text = `[reply to #${rt.message_id}: "${quoted}"]\n` + text;
    }

    // before-link fast path: allow /link from anywhere so the owner can bootstrap.
    if (!linked) {
      const c = commandOf(text);
      if (c && c.toLowerCase().startsWith("/link")) {
        // auto-fill owner + supergroup from the update if the owner just typed "/link"
        const bare = c.trim().split(/\s+/).length === 1;
        if (bare && frm && (chat.id != null)) {
          linkOwner(frm, chat.id);
          cfg = loadConfig();
          await telegram.sendMessage(chat.id, `linked: owner ${frm}, supergroup ${chat.id}`, threadId ?? undefined);
          return;
        }
        await commands.handle(c);
        return;
      }
      log("not linked yet — ignoring non-/link message");
      return;
    }

    const mid = msg.message_id;

    // General (no thread) -> commands only.
    if (!threadId) {
      const c = commandOf(text);
      if (c) { log(`command(General): ${c}`); await commands.handle(c); }
      else if (text.trim()) await telegram.sendMessage(cfg.supergroupId, "General topic takes commands only. /help", undefined);
      return;
    }

    // agent topic?
    const agent = registry.getAgentByTopic(threadId);
    if (!agent) { log(`no agent bound to topic ${threadId}`); return; }

    if (text.startsWith("/")) {
      const c = text.slice(1).split(/\s+/)[0].split("@")[0].toLowerCase();
      // fleet commands are handled by the runner; ANY other slash-command is a native Claude/Codex
      // command -> forward it straight into the agent's terminal (wake it first if parked).
      if (FLEET_TOPIC_CMDS.has(c)) { log(`command(topic ${agent.name}): ${text}`); await commands.handle(text, agent); return; }
      if (!isAgentAlive(agent.name)) wakeAgent(agent.name);
      log(`native -> pty ${agent.name}: ${text}`);
      agents.writeInput(agent.name, text);
      return;
    }

    // plain message: wake a parked agent (--continue), then deliver.
    if (!isAgentAlive(agent.name)) wakeAgent(agent.name);
    registry.setReplyTarget(agent.name, agent.topicId, null);
    log(`enqueue -> agent=${agent.name} mid=${mid} (debounce ${cfg.debounceSeconds ?? 15}s)`);
    delivery.enqueue(agent.name, text, files, mid);
  }

  // ── start everything ────────────────────────────────────────────────────────
  // Single instance: exactly ONE runner per machine. A stale/zombie runner (old code, forgotten
  // window) holds both the port AND the Telegram poll — every symptom looks like "fleet is broken"
  // while the zombie answers with stale code. So: pid file -> kill the old runner tree -> take over.
  const pidPath = join(fleetDir(), "runner.pid");
  function killStaleRunner() {
    if (!existsSync(pidPath)) return;
    const oldPid = Number(readFileSync(pidPath, "utf-8").trim());
    if (!oldPid || oldPid === process.pid) return;
    try { process.kill(oldPid, 0); } catch { return; } // not running — stale file only
    console.log(`\x1b[33m→ another fleet runner is running (pid ${oldPid}) — taking over.\x1b[0m`);
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(oldPid), "/T", "/F"], { stdio: "ignore" });
    else { try { process.kill(oldPid, "SIGTERM"); } catch {} }
  }
  // Fallback for pre-pid-file zombies: resolve who LISTENS on our port; if it's a node process
  // (i.e. an old runner), kill its tree and take the port.
  function killPortHolder() {
    try {
      if (process.platform === "win32") {
        const r = spawnSync("powershell", ["-NoProfile", "-Command",
          `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue; if ($p -and $p.ProcessName -match 'node') { taskkill /PID $($c.OwningProcess) /T /F | Out-Null; 'killed' } else { \"busy:$($p.ProcessName)\" } }`],
          { encoding: "utf-8" });
        return (r.stdout || "").trim();
      }
      const r = spawnSync("sh", ["-c", `pid=$(lsof -ti tcp:${port} -s tcp:listen | head -1); if [ -n "$pid" ]; then if ps -p $pid -o comm= | grep -q node; then kill -9 $pid && echo killed; else echo busy:$(ps -p $pid -o comm=); fi; fi`], { encoding: "utf-8" });
      return (r.stdout || "").trim();
    } catch { return ""; }
  }
  killStaleRunner();
  try {
    await server.listen();
  } catch (e) {
    if (e?.code === "EADDRINUSE") {
      const who = killPortHolder();
      if (who === "killed") console.log(`\x1b[33m→ a stale runner held port ${port} — killed it, taking over.\x1b[0m`);
      // taskkill releases the port asynchronously — short grace, then one retry; then a clean
      // one-liner instead of a traceback.
      await new Promise((r) => setTimeout(r, 1500));
      try { await server.listen(); } catch (e2) {
        if (e2?.code === "EADDRINUSE") {
          console.log(`\x1b[31mfleet: port ${port} is busy${who && who !== "killed" ? ` (${who.replace("busy:", "process: ")})` : ""} and it's not a runner I can replace.\x1b[0m`);
          console.log(`Stop that process, or set a different "port" in ${join(fleetDir(), "config.json")}.`);
          process.exit(1);
        }
        throw e2;
      }
    } else throw e;
  }
  writeFileSync(pidPath, String(process.pid));
  const dropPid = () => { try { if (Number(readFileSync(pidPath, "utf-8").trim()) === process.pid) rmSync(pidPath); } catch {} };
  process.on("exit", dropPid);
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { dropPid(); process.exit(0); }); // Ctrl+C doesn't fire "exit"
  log(`localhost server on ${backendHttp}`);

  // make sure no webhook is set (long-poll won't receive updates while a webhook is active) + register menu
  telegram.deleteWebhook().catch(() => {});
  telegram.setMyCommands(BOT_COMMANDS).then((r) => log(r?.ok ? "bot command menu registered" : "setMyCommands not ok")).catch(() => {});

  // On boot we do NOT auto-spawn agents (saves resources) — known agents load PARKED and wake on the
  // first message to their topic (--continue) or on /show. Topics/sessions persist in state.json.
  for (const a of registry.listAgents()) registry.updateAgent(a.name, { status: "parked" });

  const stopPoll = pollUpdates(cfg.botToken, routeUpdate, { log });
  log(isLinked(cfg) ? `linked (owner ${cfg.ownerId}) — polling` : "not linked — send /link in your supergroup");

  return {
    server,
    stop: async () => {
      try { stopPoll(); } catch {}
      agents.killAll();
      await server.close();
    },
  };
}
