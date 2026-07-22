// In-memory agent registry — replaces the Postgres DB (db.py) of the cloud backend.
// Holds every agent + a supergroup topic->agent map, and persists a lightweight snapshot to
// ~/.fleet/state.json so agents survive a runner restart (the watchdog can then re-spawn them).
//
// An agent record:
//   { name, projectPath, mode ("cli"|"headless"), model, engine ("claude"|"claudex"),
//     topicId, sessionId, status, lastDeliveredId, pinMsgId, replyTopic, replyBot }
//
// Live (non-persisted) state — pty handles, timers, streams — lives in agents.js / delivery.js.
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fleetDir } from "./config.js";

function statePath() {
  return join(fleetDir(), "state.json");
}

const agents = new Map();        // name -> record
const topics = new Map();        // topicId -> name  (fast topic->agent routing)

function reindexTopics() {
  topics.clear();
  for (const a of agents.values()) if (a.topicId != null) topics.set(Number(a.topicId), a.name);
}

// ── persistence ────────────────────────────────────────────────────────────
export function loadState() {
  const p = statePath();
  if (!existsSync(p)) return;
  try {
    const data = JSON.parse(readFileSync(p, "utf-8"));
    agents.clear();
    for (const rec of data.agents || []) {
      // agents always start "stopped" after a restart — the process is gone; watchdog re-spawns.
      agents.set(rec.name, { ...defaults(rec.name), ...rec, status: "stopped" });
    }
    reindexTopics();
  } catch {
    /* corrupt snapshot -> start empty rather than crash */
  }
}

export function saveState() {
  const dir = fleetDir();
  try {
    mkdirSync(dir, { recursive: true });
    const snapshot = { agents: [...agents.values()] };
    writeFileSync(statePath(), JSON.stringify(snapshot, null, 2));
  } catch {
    /* ignore — persistence is best-effort */
  }
}

function defaults(name) {
  return {
    name,
    projectPath: "",
    mode: "cli",
    model: "",
    engine: "claude",
    topicId: null,
    sessionId: "",
    status: "stopped",
    lastDeliveredId: 0,
    pinMsgId: null,
    replyTopic: null,
    replyBot: null,
  };
}

// ── CRUD (mirrors db.py get_agent / create_agent / update_agent / delete_agent) ──
export function createAgent(name, { projectPath, mode = "cli", model = "", topicId = null, engine = "claude" }) {
  const rec = { ...defaults(name), name, projectPath, mode, model, topicId, engine };
  agents.set(name, rec);
  if (topicId != null) topics.set(Number(topicId), name);
  saveState();
  return rec;
}

export function getAgent(name) {
  return agents.get(name) || null;
}

export function getAgentByTopic(topicId) {
  if (topicId == null) return null;
  const name = topics.get(Number(topicId));
  return name ? agents.get(name) || null : null;
}

export function updateAgent(name, patch) {
  const a = agents.get(name);
  if (!a) return null;
  const prevTopic = a.topicId;
  Object.assign(a, patch);
  if (patch && "topicId" in patch && prevTopic !== a.topicId) reindexTopics();
  saveState();
  return a;
}

export function deleteAgent(name) {
  const a = agents.get(name);
  if (!a) return false;
  agents.delete(name);
  if (a.topicId != null) topics.delete(Number(a.topicId));
  saveState();
  return true;
}

export function listAgents() {
  return [...agents.values()];
}

// ── delivery cursor (mirrors db.ack_delivered / last_delivered_id) ───────────
export function ackDelivered(name, mid) {
  const a = agents.get(name);
  if (!a) return;
  if (Number(mid) > (a.lastDeliveredId || 0)) {
    a.lastDeliveredId = Number(mid);
    saveState();
  }
}

// ── reply-follows-origin (mirrors db.set_reply_target) ───────────────────────
// Single-owner local build has no rooms/multi-bot, but keep the hook so an agent's replies can be
// steered back to whichever topic last addressed it (default = its own folder topic).
export function setReplyTarget(name, topicId, bot = null) {
  const a = agents.get(name);
  if (!a) return;
  a.replyTopic = topicId;
  a.replyBot = bot;
  saveState();
}
