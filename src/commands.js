// Command handling — ports app.py handle_command + the cmd_* handlers, adapted to the LOCAL runner:
// DB -> registry, manager.push (WS to a remote runner) -> direct calls into the local lifecycle.
//
// Local-single-machine simplifications vs the cloud backend:
//   - no /machines, no remote push: this process IS the machine, so spawn/kill/restart act directly.
//   - /link binds owner+supergroup into config (linkOwner) and works BEFORE the runner is linked.
//   - native /clear and /compact are written straight into the live pty (agents.writeInput).
//
// Commands supported: /spawn /list /kill /restart /new /stop /context /sessions /use /mode /model
//                     /status /rename /link /clear /compact /help
import { linkOwner, isLinked } from "./config.js";

// last path segment (splits on / and \) — ports util.agent_name_from_path
function agentNameFromPath(path) {
  const parts = String(path || "").trim().replace(/[\\/]+$/, "").split(/[\\/]+/);
  return parts.length && parts[parts.length - 1] ? parts[parts.length - 1] : String(path || "");
}

const KNOWN = new Set([
  "spawn", "list", "kill", "restart", "new", "stop", "context", "sessions", "use",
  "mode", "model", "status", "rename", "link", "clear", "compact", "help",
]);

// A General-topic message is a command if it starts with '/' OR its first word is a known command.
export function commandOf(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  if (t.startsWith("/")) return t;
  const first = t.split(/\s+/)[0].split("@")[0].toLowerCase();
  return KNOWN.has(first) ? "/" + t : null;
}

// createCommands binds the deps every handler needs. Returns { handle(text, agent) }.
//   deps.telegram : makeTelegram() instance (sendMessage(chatId,text,thread), create/edit/deleteForumTopic)
//   deps.registry : registry.js module
//   deps.agents   : agents.js module (writeInput, killAgent, sessionTokens, listSessions, isAlive)
//   deps.spawn(name)          -> spawn/register a fresh pty for an existing registry agent (returns pid)
//   deps.restart(name)        -> kill+respawn (returns pid)
//   deps.config()             -> current loaded config (for supergroupId)
//   deps.onLinked(owner, sg)  -> optional hook so runner can (re)start the poll loop after /link
//   deps.log
export function createCommands(deps) {
  const { telegram, registry, agents, spawn, restart, hide = () => {}, show = () => {}, config, onLinked = () => {}, log = () => {} } = deps;

  const sg = () => config().supergroupId;

  // reply into the supergroup: General (thread null) or a specific topic.
  async function reply(threadId, text) {
    const chat = sg();
    if (!chat) { log("reply skipped — supergroup unknown"); return; }
    await telegram.sendMessage(chat, text, threadId ?? undefined);
  }

  async function handle(text, agent = null) {
    const parts = String(text).trim().split(/\s+/);
    const cmd = parts[0].replace(/^\//, "").split("@")[0].toLowerCase();
    const args = parts.slice(1);
    switch (cmd) {
      case "help": return reply(null, helpText());
      case "link": return cmdLink(args);
      case "spawn": return cmdSpawn(args);
      case "list": return cmdList(agent);
      case "status": return cmdStatus(args);
      case "context": return cmdContext(args, agent);
      case "kill": return cmdAgentOp("kill", args, agent);
      case "restart": return cmdAgentOp("restart", args, agent);
      case "hide": return cmdHideShow("hide", args, agent);
      case "show": return cmdHideShow("show", args, agent);
      case "new": return cmdAgentOp("new", args, agent);
      case "stop": return cmdAgentOp("stop", args, agent);
      case "clear": return cmdNative("clear", args, agent);
      case "compact": return cmdNative("compact", args, agent);
      case "sessions": return cmdSessions(args, agent);
      case "use": return cmdUse(args, agent);
      case "mode": return cmdSet(args, "mode");
      case "model": return cmdModel(args, agent);
      case "usage": return cmdUsage();
      case "rename": return cmdRename(args, agent);
      default: return reply(null, `unknown command: /${cmd}`);
    }
  }

  // /link <owner_id> <supergroup_id> — or the runner may pre-fill from the update; here we accept
  // explicit ids so the owner can bind from General before auth is on.
  async function cmdLink(args) {
    if (args.length < 2) return reply(null, "usage: /link <owner_id> <supergroup_id>");
    const owner = Number(args[0]);
    const supergroup = Number(args[1]);
    if (!owner || !supergroup) return reply(null, "owner_id and supergroup_id must be numbers");
    linkOwner(owner, supergroup);
    onLinked(owner, supergroup);
    await reply(null, `linked: owner ${owner}, supergroup ${supergroup}`);
  }

  // /spawn <project_path> [model] — no <machine> arg (this process is the only machine); mode is cli.
  async function cmdSpawn(args) {
    if (args.length < 1) return reply(null, "usage: /spawn <project_path> [model]");
    let path = args[0];
    let model = null;
    let engine = "claude";
    for (const tok of args.slice(1)) {
      const low = tok.toLowerCase();
      if (low === "cli" || low === "headless") continue; // mode is always cli locally; ignore
      if (low === "claude") { engine = "claude"; continue; }
      if (low === "codex" || low === "claudex") { engine = "codex"; continue; }
      model = tok;
    }
    if (!isLinked(config())) return reply(null, "not linked yet — send /link <owner_id> <supergroup_id> first");
    // codex + claude of the same folder coexist as distinct agents (…-codex), so no collision.
    const base = agentNameFromPath(path);
    const name = engine === "codex" ? `${base}-codex` : base;
    // permissive: if this agent already exists, just re-spawn it (no "kill it first" wall).
    const existing = registry.getAgent(name);
    if (existing) {
      try {
        const pid = restart(name);
        registry.updateAgent(name, { status: "running" });
        return reply(existing.topicId, `agent ${name} re-spawned (pid ${pid})`);
      } catch (e) { return reply(existing.topicId, `re-spawn error: ${String(e?.message || e)}`); }
    }
    const topicId = await telegram.createForumTopic(sg(), name);
    if (!topicId) return reply(null, "could not create topic");
    registry.createAgent(name, { projectPath: path, mode: "cli", model: model || "", topicId, engine });
    try {
      const pid = spawn(name);
      registry.updateAgent(name, { status: "running" });
      await reply(topicId, `agent ${name} (${engine}) started, pid ${pid}`);
    } catch (e) {
      await reply(topicId, `spawn error: ${String(e?.message || e)}`);
    }
  }

  async function cmdList(agent) {
    if (agent) return reply(agent.topicId, "/list works only in General");
    const rows = registry.listAgents();
    if (!rows.length) return reply(null, "no agents");
    const lines = rows.map((r) =>
      `- ${r.name} - ${r.mode} - ${r.model || "default"} - ${r.status}`);
    await reply(null, "Agents:\n" + lines.join("\n"));
  }

  // /hide -> close the window, keep the agent running headless. /show -> (re)open the window,
  // waking the agent (--continue) if it was parked. The runner implements hide()/show().
  async function cmdHideShow(op, args, agent) {
    const a = agent || (args.length ? registry.getAgent(args[0]) : null);
    if (!a) return reply(null, `usage: /${op} <agent> (or use it inside the agent's topic)`);
    try {
      if (op === "hide") { await hide(a.name); return reply(a.topicId, `${a.name}: window hidden, still running in the background. /show to reopen.`); }
      await show(a.name); return reply(a.topicId, `${a.name}: window opened${agents.isAlive(a.name) ? "" : " (woke it up)"}.`);
    } catch (e) { return reply(a.topicId, `/${op} error: ${String(e?.message || e)}`); }
  }

  async function cmdStatus(args) {
    const a = args.length ? registry.getAgent(args[0]) : null;
    if (!a) return reply(null, args.length ? "no such agent" : "usage: /status <agent>");
    const alive = agents.isAlive(a.name);
    const tok = agents.sessionTokens(a.projectPath, a.sessionId || null);
    const bits = [`process ${alive ? "alive" : "not running"}`];
    if (tok != null) {
      const warn = tok > 150000 ? " - consider /compact" : "";
      bits.push(`context ~${Math.floor(tok / 1000)}k tokens${warn}`);
    }
    await reply(a.topicId, `${a.name}: ${a.status} · ${a.mode} · ${a.model || "default"} · session=${a.sessionId || "-"}\nrunner: ${bits.join(" · ")}`);
  }

  // /context -> show the agent's context size + a "Compact now" button; also push native /context to the window.
  async function cmdContext(args, agent) {
    const a = agent || (args.length ? registry.getAgent(args[0]) : null);
    if (!a) return reply(null, "usage: /context <agent>");
    const tok = agents.sessionTokens(a.projectPath, a.sessionId || null);
    const size = tok != null ? `~${Math.floor(tok / 1000)}k tokens` : "unknown (spawn/talk first)";
    if (agents.isAlive(a.name)) agents.writeInput(a.name, "/context");
    await telegram.sendKeyboard(sg(), `${a.name} — context: ${size}`, a.topicId,
      [[{ text: "Compact now", data: `compact:${a.name}:` }]]);
  }

  // /clear, /compact -> native slash command straight into the live pty (with progress for /compact).
  async function cmdNative(op, args, agent) {
    const a = agent || (args.length ? registry.getAgent(args[0]) : null);
    if (!a) return reply(null, `usage: /${op} <agent>`);
    if (!agents.isAlive(a.name)) return reply(a.topicId, "agent process is not running — /restart it first");
    const ok = agents.writeInput(a.name, `/${op}`);
    if (!ok) return reply(a.topicId, `/${op} failed — pty not writable`);
    if (op === "compact") {
      await reply(a.topicId, "compacting… (watch the window)");
      setTimeout(async () => {
        const tok = agents.sessionTokens(a.projectPath, a.sessionId || null);
        await reply(a.topicId, tok != null ? `✓ compacted — context now ~${Math.floor(tok / 1000)}k tokens` : "✓ compact done");
      }, 18000);
    } else {
      await reply(a.topicId, `/${op} sent to session`);
    }
  }

  // /model -> in a topic with no arg: show a model picker (buttons). With an arg: set it.
  async function cmdModel(args, agent) {
    const picker = (a) => telegram.sendKeyboard(sg(), `${a.name}: pick a model (current: ${a.model || "default"})`, a.topicId,
      [["opus", "sonnet", "haiku", "default"].map((m) => ({ text: m, data: `model:${a.name}:${m}` }))]);
    if (agent) {
      if (args.length === 0) return picker(agent);
      registry.updateAgent(agent.name, { model: args[0] === "default" ? "" : args[0] });
      return reply(agent.topicId, `${agent.name}: model → ${args[0]} · /restart to apply`);
    }
    const a = registry.getAgent(args[0]);
    if (!a) return reply(null, "usage: /model <agent> [value]");
    if (!args[1]) return picker(a);
    registry.updateAgent(a.name, { model: args[1] === "default" ? "" : args[1] });
    return reply(a.topicId, `${a.name}: model → ${args[1]} · /restart to apply`);
  }

  // /usage -> a fleet overview (each agent's status + context size) into General.
  async function cmdUsage() {
    const rows = registry.listAgents();
    if (!rows.length) return reply(null, "no agents");
    const lines = rows.map((r) => {
      const tok = agents.sessionTokens(r.projectPath, r.sessionId || null);
      return `- ${r.name}: ${r.status}${tok != null ? ` · ~${Math.floor(tok / 1000)}k ctx` : ""}`;
    });
    await reply(null, "Fleet usage:\n" + lines.join("\n"));
  }

  async function cmdAgentOp(op, args, agent) {
    const a = agent || (args.length ? registry.getAgent(args[0]) : null);
    if (!a) return reply(null, `usage: /${op} <agent>`);
    if (op === "kill") {
      agents.killAgent(a.name);
      try { await telegram.deleteForumTopic(sg(), a.topicId); } catch {}
      registry.deleteAgent(a.name);
      return reply(null, `${a.name} removed: process stopped, topic and record deleted`);
    }
    if (op === "restart") {
      try {
        const pid = restart(a.name);
        registry.updateAgent(a.name, { status: "running" });
        return reply(a.topicId, `${a.name} restarted, pid ${pid}`);
      } catch (e) {
        return reply(a.topicId, `restart error: ${String(e?.message || e)}`);
      }
    }
    if (op === "new") {
      registry.updateAgent(a.name, { sessionId: "" }); // "" = force fresh on next restart
      return reply(a.topicId, "new session armed (resume cleared) — /restart to apply");
    }
    // stop
    agents.killAgent(a.name);
    registry.updateAgent(a.name, { status: "stopped" });
    return reply(a.topicId, `${a.name} stopped`);
  }

  async function cmdSessions(args, agent) {
    const a = agent || (args.length ? registry.getAgent(args[0]) : null);
    if (!a) return reply(null, "usage: /sessions <agent>");
    const sessions = agents.listSessions(a.projectPath);
    if (!sessions.length) return reply(a.topicId, "no sessions found in this folder");
    const lines = sessions.slice(0, 15).map((s, i) =>
      `${i + 1}. ${s.id}  (${s.sizeKb}KB)`);
    await reply(a.topicId, "Folder sessions (newest first):\n" + lines.join("\n") + "\n\nselect: /use <agent> <id>");
  }

  async function cmdUse(args, agent) {
    let a, sid;
    if (agent) {
      if (!args.length) return reply(agent.topicId, "usage: /use <session_id>");
      a = agent; sid = args[0];
    } else {
      if (args.length < 2) return reply(null, "usage: /use <agent> <session_id>");
      a = registry.getAgent(args[0]); sid = args[1];
    }
    if (!a) return reply(null, "no such agent");
    registry.updateAgent(a.name, { sessionId: sid });
    await reply(a.topicId, `session set: ${sid} (do /restart to attach it)`);
  }

  async function cmdSet(args, field) {
    if (args.length < 2) return reply(null, `usage: /${field} <agent> <value>`);
    const a = registry.getAgent(args[0]);
    if (!a) return reply(null, "no such agent");
    registry.updateAgent(a.name, { [field]: args[1] });
    await reply(a.topicId, `${a.name}: ${field} = ${args[1]} (do /restart to apply)`);
  }

  async function cmdRename(args, agent) {
    let a, title;
    if (agent) { a = agent; title = args.join(" "); }
    else {
      if (args.length < 2) return reply(null, "usage: /rename <agent> <title>");
      a = registry.getAgent(args[0]); title = args.slice(1).join(" ");
    }
    if (!a || !title) return reply(null, "no agent or empty title");
    await telegram.editForumTopic(sg(), a.topicId, title);
    await reply(a.topicId, `topic renamed: ${title}`);
  }

  function helpText() {
    return (
      "Commands:\n" +
      "/spawn <path> [model]\n" +
      "/list · /status <a> · /context <a>\n" +
      "/kill <a> · /restart <a> · /stop <a> · /new <a>\n" +
      "/mode <a> <m> · /model <a> <m> · /rename <a> <title>\n" +
      "/sessions <a> · /use <a> <id> · /clear <a> · /compact <a>\n" +
      "/link <owner_id> <supergroup_id> · /help"
    );
  }

  return { handle, reply, commandOf };
}
