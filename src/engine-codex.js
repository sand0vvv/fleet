// Codex engine for @fleet/runner — the engine=codex counterpart of agents.js (Claude).
//
// Mechanism (no Rust fork): the official codex CLI is driven by codex-shell/index.mjs, which spawns
// `codex app-server` + `codex --remote` and injects owner messages via JSON-RPC turn/start. This module
// is what the runner calls for engine=codex: it (1) wires a per-agent CODEX_HOME/config.toml so codex
// can call the fleet MCP (send_message), then (2) launches codex-shell/index.mjs as a node child with
// the fleet identity env. Returns a handle with .kill().
//
// The config.toml layout mirrors runner.py:_register_codex_mcp — codex configures MCP via config.toml
// in CODEX_HOME (NOT Claude's .mcp.json). The per-agent CODEX_HOME must be a CLONE of the user's working
// ~/.codex, otherwise codex shows the "Set up the sandbox" screen even with sandbox_mode=danger-full-access.
// So: seed from the global config (carries [windows] trust + danger-full-access), append [mcp_servers.fleet],
// and copy the login + sandbox-setup dirs.
import { spawn } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  copyFileSync,
  cpSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Package layout: src/engine-codex.js -> ../codex-shell/index.mjs and ../mcp/index.mjs.
export const CODEX_SHELL = join(__dirname, "..", "codex-shell", "index.mjs").replace(/\\/g, "/");
const FLEET_MCP = join(__dirname, "..", "mcp", "index.mjs");

// TOML string escaping (backslash + double-quote), matches runner.py:_esc.
function esc(s) {
  return (s || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// Per-agent CODEX_HOME (where codex reads config.toml + auth). Ports runner.py:_codex_home.
export function codexHome(project) {
  return join(project, ".codex");
}

// Build CODEX_HOME/config.toml for one agent. Ports runner.py:_register_codex_mcp.
// env: { backendHttp, agentName, token, streamWs } (streamWs => cli-mode inject stream).
export function registerCodexMcp(project, { backendHttp, agentName, token, streamWs }) {
  const home = codexHome(project);
  mkdirSync(home, { recursive: true });
  const realHome = join(homedir(), ".codex");

  // base = the user's working global config (has the Windows sandbox setup state, trust, danger-full-access)
  let base = "";
  const gcfg = join(realHome, "config.toml");
  if (existsSync(gcfg)) {
    try { base = readFileSync(gcfg, "utf-8"); } catch { base = ""; }
  }

  // Ensure no-sandbox / never even if the global config somehow lacks them (top-level keys go first).
  let head = "";
  if (!base.includes("approval_policy")) head += 'approval_policy = "never"\n';
  if (!base.includes("sandbox_mode")) head += 'sandbox_mode = "danger-full-access"\n';

  // Append the fleet MCP (the global config has no [mcp_servers.fleet], so no dup).
  const fleet = [
    "", "",
    "[mcp_servers.fleet]",
    'command = "node"',
    `args = ["${esc(FLEET_MCP)}"]`,
    "",
    "[mcp_servers.fleet.env]",
    `FLEET_BACKEND_HTTP = "${esc(backendHttp)}"`,
    `FLEET_AGENT_NAME = "${esc(agentName)}"`,
    `FLEET_TOKEN = "${esc(token)}"`,
  ];
  if (streamWs) {
    fleet.push('FLEET_MODE = "cli"', `FLEET_STREAM_WS = "${esc(streamWs)}"`);
  }

  writeFileSync(join(home, "config.toml"), head + base + fleet.join("\n") + "\n");

  // Clone login + the Windows sandbox-setup dirs so codex treats this home as already set up.
  for (const item of ["auth.json", ".sandbox", ".sandbox-bin", ".sandbox-secrets"]) {
    const src = join(realHome, item);
    const dst = join(home, item);
    try {
      if (existsSync(src) && !existsSync(dst)) {
        // cpSync handles both files and dirs (recursive) — replaces runner.py's copytree/copyfile split.
        cpSync(src, dst, { recursive: true });
      }
    } catch {
      // best-effort; a missing sandbox dir is non-fatal on non-Windows or fresh installs
    }
  }
}

// Launch a codex agent. Mirrors agents.js:spawnAgent's signature style but returns a .kill() handle.
//
// agent: registry record { name, projectPath, model, ... }.
// env:   { backendHttp, streamWs, token, onExit(name, exitInfo), log }.
//        (streamWs is the ws://localhost:PORT/agent/<name>/stream?token=... the runner hosts.)
export function spawnCodexAgent(agent, env = {}) {
  const {
    backendHttp,
    streamWs,
    token,
    onExit,
    log = () => {},
  } = env;
  const name = agent.name;
  const project = agent.projectPath;

  mkdirSync(join(project, ".fleet"), { recursive: true });
  mkdirSync(join(project, ".inbox"), { recursive: true });
  // fresh cursor so the MCP high-water doesn't suppress the first pushed message (matches agents.js)
  const cursorPath = join(project, ".fleet", "cursor.json");
  if (!existsSync(cursorPath)) writeFileSync(cursorPath, JSON.stringify({ hw: 0 }));

  // Wire CODEX_HOME/config.toml so codex can call the fleet MCP (send_message).
  registerCodexMcp(project, { backendHttp, agentName: name, token, streamWs });

  // Env for the codex-shell child: fleet identity + CODEX_HOME so codex loads the per-agent config.
  const childEnv = {
    ...process.env,
    CODEX_HOME: codexHome(project),
    FLEET_BACKEND_HTTP: backendHttp || "",
    FLEET_AGENT_NAME: name,
    FLEET_TOKEN: token || "",
    FLEET_STREAM_WS: streamWs || "",
  };
  if (agent.model) childEnv.CODEX_MODEL = agent.model; // informational; TUI model set via config/-m if needed

  log(`spawn codex ${name}: new console -> node ${CODEX_SHELL} (CODEX_HOME=${childEnv.CODEX_HOME})`);

  // codex's TUI (`codex --remote`) needs a REAL console TTY (AttachConsole) — node-pty's pty isn't
  // enough on Windows. So we open codex in its OWN new console window; the owner sees + works in it.
  let child;
  if (process.platform === "win32") {
    child = spawn("cmd.exe", ["/c", "start", `fleet: ${name} (codex)`, "cmd", "/c", "node", CODEX_SHELL],
      { cwd: project, env: childEnv, detached: true, stdio: "ignore" });
  } else if (process.platform === "darwin") {
    child = spawn("osascript", ["-e",
      `tell app "Terminal" to do script "cd '${project}' && CODEX_HOME='${childEnv.CODEX_HOME}' node '${CODEX_SHELL}'"`],
      { env: childEnv, detached: true, stdio: "ignore" });
  } else {
    child = spawn("x-terminal-emulator", ["-e", `node ${CODEX_SHELL}`], { cwd: project, env: childEnv, detached: true, stdio: "ignore" });
  }

  child.on("error", (e) => log(`codex ${name}: spawn error ${e.message}`));

  return {
    pid: child.pid,
    child,
    // best-effort: kill the codex process tree by its per-agent CODEX_HOME (the launcher already exited).
    kill: () => {
      try {
        if (process.platform === "win32") {
          spawn("powershell", ["-NoProfile", "-Command",
            `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${codexHome(project).replace(/\\/g, "/")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`],
            { stdio: "ignore" });
        } else { child.kill(); }
        return true;
      } catch { return false; }
    },
  };
}
