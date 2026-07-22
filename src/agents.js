// Agent lifecycle via node-pty — the PROVEN de-risk spawn pattern, packaged for the runner.
//
// spawnAgent wires the bundled fleet MCP (mcp/index.mjs) into the agent's project via
// .mcp.json + .claude/settings.local.json + .fleet/rule.txt (env FLEET_BACKEND_HTTP / FLEET_AGENT_NAME /
// FLEET_TOKEN / FLEET_MODE=cli / FLEET_STREAM_WS), then launches `claude` inside a node-pty and
// auto-confirms the startup prompts by ANSI-sniffing the pty output (dev-channels bypass-permissions).
// The live pty is kept so writeInput() can dispatch native slash commands (/clear, /compact).
//
// Ported watchdog: a crashed pty is auto-restarted with a crash-loop guard (>=3 restarts / 5min -> stop).
// sessionTokens() ports runner.py _session_tokens (newest ~/.claude/projects/<enc>/*.jsonl last usage).
import { spawn as ptySpawn } from "node-pty";
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { registerCodexMcp, codexHome, CODEX_SHELL } from "./engine-codex.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// The bundled MCP wired into every agent's project. Package layout: src/agents.js -> ../mcp/index.mjs.
const FLEET_MCP = join(__dirname, "..", "mcp", "index.mjs").replace(/\\/g, "/");

// node-pty on Windows needs an ABSOLUTE exe path (it does not resolve PATH). We DON'T hard-require
// git-bash: prefer it on Windows if present (tested path), else fall back to cmd.exe (always present,
// so fleet works on Windows machines WITHOUT git-bash). On Unix use bash/sh.
function resolveShell() {
  if (process.platform !== "win32") {
    for (const p of ["/bin/bash", "/usr/bin/bash", "/bin/sh"]) { try { if (existsSync(p)) return { file: p, kind: "unix" }; } catch {} }
    return { file: "/bin/sh", kind: "unix" };
  }
  const gits = [
    "C:/Program Files/Git/bin/bash.exe",
    "C:/Program Files (x86)/Git/bin/bash.exe",
    join(process.env.LOCALAPPDATA || "", "Programs", "Git", "bin", "bash.exe"),
  ];
  for (const p of gits) { try { if (p && existsSync(p)) return { file: p, kind: "bash" }; } catch {} }
  return { file: process.env.ComSpec || "C:/Windows/System32/cmd.exe", kind: "cmd" };
}
// Build the (file, args) for node-pty. cwd is set via the pty option, so no `cd` needed.
function buildLaunch(claudeCmd) {
  const sh = resolveShell();
  if (sh.kind === "cmd") return { file: sh.file, args: ["/d", "/s", "/c", claudeCmd] };
  return { file: sh.file, args: ["-lc", claudeCmd] }; // bash / sh
}

const RULE_TEXT =
  "You are a fleet agent. The owner talks to you from Telegram and sees ONLY messages sent via the " +
  "send_message tool (files via send_file). Your text in this terminal is INVISIBLE to the owner. " +
  "ALWAYS reply to the owner via send_message. For coordination in a shared room use say_in_room; " +
  "list your rooms with my_rooms.";

const procs = new Map();          // name -> { pty, meta, buf:[], len, listeners:Set }
const restartTimes = new Map();   // name -> [recent auto-restart epochs] (crash-loop guard)
const ATTACH_BUF = 200_000;       // ~scrollback bytes replayed to a freshly attached terminal

// ── project wiring (ports runner.py _register_project_mcp) ────────────────────
function wireProject(project, name, { backendHttp, streamWs, token }) {
  mkdirSync(join(project, ".claude"), { recursive: true });
  mkdirSync(join(project, ".fleet"), { recursive: true });
  mkdirSync(join(project, ".inbox"), { recursive: true });

  const env = {
    FLEET_BACKEND_HTTP: backendHttp,
    FLEET_AGENT_NAME: name,
    FLEET_TOKEN: token,
    FLEET_MODE: "cli",
    FLEET_STREAM_WS: streamWs,
  };

  // merge (don't clobber) an existing .mcp.json so a project's other MCP servers survive
  const mcpPath = join(project, ".mcp.json");
  let mcp = {};
  if (existsSync(mcpPath)) { try { mcp = JSON.parse(readFileSync(mcpPath, "utf-8")); } catch { mcp = {}; } }
  if (!mcp.mcpServers) mcp.mcpServers = {};
  mcp.mcpServers.fleet = { command: "node", args: [FLEET_MCP], env };
  writeFileSync(mcpPath, JSON.stringify(mcp, null, 2));

  // auto-trust project MCP servers (no trust prompt)
  const sPath = join(project, ".claude", "settings.local.json");
  let s = {};
  if (existsSync(sPath)) { try { s = JSON.parse(readFileSync(sPath, "utf-8")); } catch { s = {}; } }
  s.enableAllProjectMcpServers = true;
  writeFileSync(sPath, JSON.stringify(s, null, 2));

  writeFileSync(join(project, ".fleet", "rule.txt"), RULE_TEXT);
  // fresh cursor so the MCP high-water doesn't suppress the first pushed message
  const cursorPath = join(project, ".fleet", "cursor.json");
  if (!existsSync(cursorPath)) writeFileSync(cursorPath, JSON.stringify({ hw: 0 }));
}

// Force the project's MCP replay-cursor to the runner's authoritative high-water. A stale/foreign
// hw in .fleet/cursor.json (e.g. a Date.now() left behind by tests) makes the MCP silently drop
// every real message — telegram mids are tiny — which reads as "deliver ok=true but nothing ever
// appears in the session". Call before EVERY spawn; the runner's ~/.fleet/cursors.json is truth.
export function syncCursor(project, hw) {
  try {
    mkdirSync(join(project, ".fleet"), { recursive: true });
    writeFileSync(join(project, ".fleet", "cursor.json"), JSON.stringify({ hw: Number(hw) || 0 }));
  } catch {}
}

// ── spawn (ports derisk.mjs step 3 + runner.py _spawn_cli) ───────────────────
// agent: the registry record { name, projectPath, model, sessionId, ... }.
// opts: { backendHttp, streamWs, token, channelMode, onExit(name, exitInfo), log }
export function spawnAgent(agent, opts = {}) {
  const {
    backendHttp,
    streamWs,
    token,
    channelMode = "dev",
    onExit,
    log = () => {},
  } = opts;
  const name = agent.name;
  const project = agent.projectPath;
  const engine = agent.engine || "claude";

  // Both engines run inside node-pty (real TTY -> attach window + native input work). Claude gets its
  // MCP via .mcp.json + dev-channels; Codex is driven by codex-shell (app-server + JSON-RPC inject) with
  // its MCP wired via CODEX_HOME/config.toml.
  let file, args, env;
  if (engine === "codex") {
    registerCodexMcp(project, { backendHttp, agentName: name, token, streamWs });
    env = { ...process.env, CODEX_HOME: codexHome(project), FLEET_BACKEND_HTTP: backendHttp || "",
            FLEET_AGENT_NAME: name, FLEET_TOKEN: token || "", FLEET_STREAM_WS: streamWs || "" };
    ({ file, args } = buildLaunch(`node "${CODEX_SHELL}"`));
  } else {
    wireProject(project, name, { backendHttp, streamWs, token });
    const chan = channelMode === "dev"
      ? "--dangerously-load-development-channels server:fleet"
      : "--channels server:fleet";
    const resume = agent.sessionId ? ` --resume ${agent.sessionId}` : "";
    const flags = `${chan} --dangerously-skip-permissions --append-system-prompt-file .fleet/rule.txt`;
    const model = agent.model ? ` --model ${agent.model}` : "";
    env = process.env;
    ({ file, args } = buildLaunch(`claude ${flags}${model}${resume}`));
  }
  log(`spawn ${name} (${engine}): ${file} ${args.join(" ")}`);

  const pty = ptySpawn(file, args, { name: "xterm-256color", cols: 100, rows: 30, cwd: project, env });

  // ANSI-sniff auto-confirm of Claude's startup prompts (codex uses --bypass so has none).
  let sniff = "", chanOk = false, sawBypass = false;
  pty.onData((d) => {
    if (engine === "claude" && !chanOk) {
      sniff = (sniff + d).slice(-6000);
      const flat = sniff
        .replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, "")
        .replace(/\s+/g, "")
        .toLowerCase();
      if (!sawBypass && /bypasspermissions/.test(flat) && /yes,?iaccept/.test(flat)) {
        sawBypass = true; sniff = ""; log(`${name}: auto-confirm bypass permissions -> '2'`);
        setTimeout(() => { try { pty.write("2\r"); } catch {} }, 400);
      } else if (/loadingdevelopmentchannels|usingthisforlocaldevelopment|newmcpserverfound|entertoconfirm|dodev/.test(flat)) {
        sniff = ""; log(`${name}: auto-confirm dev-channels/mcp prompt -> Enter`);
        setTimeout(() => { try { pty.write("\r"); } catch {} }, 400);
      }
      if (/bypasspermissionson|welcometoclaudecode|\/help/.test(flat)) {
        chanOk = true; log(`${name}: claude prompt ready`);
      }
    }
    // scrollback buffer + live broadcast to any attached terminals
    const rec = procs.get(name);
    if (rec) {
      rec.buf.push(d); rec.len += d.length;
      while (rec.len > ATTACH_BUF && rec.buf.length > 1) rec.len -= rec.buf.shift().length;
      for (const cb of rec.listeners) { try { cb(d); } catch {} }
    }
  });

  const meta = { project, model: agent.model, engine: agent.engine || "claude", opts };
  pty.onExit((e) => {
    log(`${name}: pty EXIT ${JSON.stringify(e)}`);
    if (procs.get(name)?.pty === pty) procs.delete(name);
    if (deliberate.delete(name)) return; // killed on purpose — not a crash, no watchdog
    try { onExit?.(name, e); } catch {}
  });

  procs.set(name, { pty, meta, buf: [], len: 0, listeners: new Set() });
  return pty.pid;
}

// ── native slash commands: write straight into the live pty (/clear, /compact) ──
// The Enter goes SEPARATELY after a beat: a single "text\r" chunk can be treated as a PASTE by the
// TUI (the \r becomes a literal newline in the input box and the command never runs). A detached \r
// after the command has rendered reliably submits it.
export function writeInput(name, text) {
  const p = procs.get(name);
  if (!p) return false;
  try {
    p.pty.write(text);
    setTimeout(() => { try { p.pty.write("\r"); } catch {} }, 350);
    return true;
  } catch { return false; }
}

// ── attach: forward raw keystrokes from an attached terminal into the live pty ──
export function writeRaw(name, data) {
  const p = procs.get(name);
  if (!p) return false;
  try { p.pty.write(typeof data === "string" ? data : data.toString("utf8")); return true; } catch { return false; }
}

// Last N chars of the agent's scrollback (raw pty bytes incl. ANSI) — used to capture the output
// of a native command (/context, /usage) so it can be relayed to Telegram.
export function tailOutput(name, chars = 6000) {
  const p = procs.get(name);
  if (!p) return null;
  return p.buf.join("").slice(-chars);
}

// Subscribe an attached terminal to the agent's live output. Replays scrollback first,
// then streams new chunks. Returns an unsubscribe fn. onData receives raw pty bytes (string).
export function subscribeOutput(name, onData) {
  const p = procs.get(name);
  if (!p) return null;
  try { onData(p.buf.join("")); } catch {}
  p.listeners.add(onData);
  return () => { const q = procs.get(name); if (q) q.listeners.delete(onData); };
}

// Resize the pty to match an attached terminal.
export function resizeAgent(name, cols, rows) {
  const p = procs.get(name);
  if (!p) return false;
  try { p.pty.resize(Math.max(20, cols | 0), Math.max(5, rows | 0)); return true; } catch { return false; }
}

export function isAlive(name) {
  return procs.has(name);
}

// Deliberate kills must NOT look like crashes: killAgent marks the name so the async pty-exit
// event skips the onExit callback. Without this the watchdog races /kill's `await deleteForumTopic`
// gap, sees a still-registered "running" agent and respawns it — new pty + new window on every kill.
const deliberate = new Set();

export function killAgent(name) {
  const p = procs.get(name);
  if (!p) return false;
  deliberate.add(name);
  procs.delete(name);
  try { p.pty.kill(); } catch {}
  return true;
}

export function killAll() {
  for (const [name] of procs) killAgent(name);
}

// ── watchdog (ports runner.py monitor): auto-restart a crashed pty, crash-loop guarded ─────
// Because node-pty fires onExit, we don't poll; instead each exit calls back into here via runner.
// This helper decides whether to restart and returns { action, pid?, message } for the caller to
// report to Telegram. respawn(name) actually spawns a fresh pty (closure over spawn opts kept in meta
// isn't enough — the caller passes a bound spawner so registry.sessionId is current).
export function shouldRestart(name) {
  const now = Date.now() / 1000;
  const times = (restartTimes.get(name) || []).filter((t) => now - t < 300);
  restartTimes.set(name, times);
  if (times.length >= 3) return { restart: false, loop: true, count: times.length };
  return { restart: true, loop: false, count: times.length };
}

export function noteRestart(name) {
  const now = Date.now() / 1000;
  const times = (restartTimes.get(name) || []).filter((t) => now - t < 300);
  times.push(now);
  restartTimes.set(name, times);
}

// ── session helpers (port runner.py _proj_dir / _session_tokens / _list_sessions) ──
function projDir(project) {
  // Claude Code encodes cwd by replacing EVERY non-alphanumeric char (separators AND non-ASCII) with '-'.
  const enc = (project || "").replace(/[^a-zA-Z0-9]/g, "-");
  return join(homedir(), ".claude", "projects", enc);
}

export function listSessions(project) {
  const d = projDir(project);
  if (!existsSync(d)) return [];
  const out = [];
  for (const f of readdirSync(d)) {
    if (f.endsWith(".jsonl")) {
      const p = join(d, f);
      const st = statSync(p);
      out.push({ id: f.slice(0, -6), mtime: st.mtimeMs, sizeKb: Math.floor(st.size / 1024) });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

// Current context size of a session's last turn = input + cache_read + cache_creation tokens.
// If no session_id passed, uses the newest session in the project (matches _detect_cli_session use).
export function sessionTokens(project, sessionId = null) {
  const d = projDir(project);
  let file;
  if (sessionId) {
    file = join(d, `${sessionId}.jsonl`);
  } else {
    const s = listSessions(project);
    if (!s.length) return null;
    file = join(d, `${s[0].id}.jsonl`);
  }
  if (!existsSync(file)) return null;
  let last = null;
  try {
    const lines = readFileSync(file, "utf-8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const u = (JSON.parse(line).message || {}).usage;
        if (u) last = u;
      } catch { /* skip bad line */ }
    }
  } catch {
    return null;
  }
  if (!last) return null;
  return (
    Number(last.input_tokens || 0) +
    Number(last.cache_read_input_tokens || 0) +
    Number(last.cache_creation_input_tokens || 0)
  );
}

// Detect the freshest session id for a just-spawned agent (newest .jsonl). Returns id or null.
export function detectSession(project) {
  const s = listSessions(project);
  return s.length ? s[0].id : null;
}
