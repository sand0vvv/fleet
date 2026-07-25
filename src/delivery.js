// Debounce + RELIABLE delivery. Fast successive owner messages to one agent are batched
// (debounceSeconds; 0 = deliver immediately) into a single injection. Delivery is bulletproof:
//   - pending messages are persisted to ~/.fleet/pending.json (survive a runner crash/restart),
//   - if the target agent isn't running we WAKE it (ensureAlive) and keep the message queued,
//   - on the agent's stream (re)connect we replay the queue,
//   - a background sweep retries anything still queued for a now-connected agent,
//   - a persisted per-agent cursor (~/.fleet/cursors.json) dedups by mid (the MCP acks each mid),
// so a message is never lost even if you closed the window and the agent was parked.
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fleetDir } from "./config.js";

const cursorsPath = () => join(fleetDir(), "cursors.json");
const pendingPath = () => join(fleetDir(), "pending.json");

function loadJson(p) { try { return existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : {}; } catch { return {}; } }
function saveJson(p, o) { try { mkdirSync(fleetDir(), { recursive: true }); writeFileSync(p, JSON.stringify(o)); } catch { /* best-effort */ } }

//   deps.server        -> { pushToAgent(name,{mid,text,files}), isOnline(name) }
//   deps.registry      -> { getAgent, ackDelivered }
//   deps.ensureAlive   -> (name) => void   wake a parked agent so it can receive (runner provides)
//   deps.notifyOffline -> (agent, mid) => void
//   deps.debounceSeconds, deps.log
export function createDelivery(deps) {
  const {
    server, registry, ensureAlive = () => {}, notifyOffline = () => {}, onDelivered = () => {},
    // isReady(name) -> has the agent's CLI actually reached its prompt? (agents.js sniffs the pty).
    // Pushing a channel notification before that is silently swallowed = message lost forever.
    isReady = () => true,
    debounceSeconds = 15, log = () => {},
  } = deps;

  const pending = new Map(Object.entries(loadJson(pendingPath()))); // name -> { texts, files, mid }
  const timers = new Map();
  // name -> { min, hard }: earliest ms we may inject, and the deadline after which we inject even
  // without a readiness signal (so an unrecognised prompt can't wedge delivery forever).
  const readyGate = new Map();
  const HARD_WAIT_MS = 180000;
  let cursors = loadJson(cursorsPath());

  // Called when an agent's stream (re)connects: it is NOT ready yet — a resumed session can take
  // tens of seconds to reach the prompt. deliver() waits for isReady() (or the hard deadline).
  function markReady(name, delayMs = 3000) { readyGate.set(name, { min: Date.now() + delayMs, hard: Date.now() + HARD_WAIT_MS }); }

  const persist = () => saveJson(pendingPath(), Object.fromEntries(pending));
  const hw = (name) => Number(cursors[name] || 0);
  const setHw = (name, mid) => { cursors[name] = Number(mid); saveJson(cursorsPath(), cursors); };

  function enqueue(name, text, files, mid) {
    const buf = pending.get(name) || { texts: [], files: [], mid: 0 };
    if (text) buf.texts.push(text);
    if (files && files.length) buf.files.push(...files);
    if (mid) buf.mid = Math.max(buf.mid, mid);
    pending.set(name, buf);
    persist();
    const old = timers.get(name);
    if (old) clearTimeout(old);
    timers.set(name, setTimeout(() => flush(name), Math.max(0, debounceSeconds) * 1000));
  }

  async function flush(name) {
    timers.delete(name);
    if (!pending.has(name)) return;
    const a = registry.getAgent(name);
    if (!a) { pending.delete(name); persist(); return; }
    // agent not connected -> wake it and leave the message queued; it delivers on stream connect.
    if (!server.isOnline(name)) { ensureAlive(name); notifyOffline(a, pending.get(name).mid); return; }
    await deliver(name);
  }

  // Push the queued buffer for `name` to its live stream. Keeps the buffer if the push fails.
  async function deliver(name) {
    const a = registry.getAgent(name);
    const buf = pending.get(name);
    if (!a || !buf) return true;
    const mid = buf.mid;
    if (mid && mid <= hw(name)) { pending.delete(name); persist(); log(`deliver ${name}: mid=${mid} <= hw -> skip`); return true; }
    // Not ready yet -> keep queued; the sweep retries. Readiness is the AGENT'S OWN signal (its CLI
    // reached the prompt), not a timer: a 5s guess raced heavy `--resume` sessions and the message
    // was swallowed mid-boot (owner-caught: "window opens, message never arrives").
    const gate = readyGate.get(name);
    if (gate) {
      const now = Date.now();
      if (now < gate.min) { log(`deliver ${name}: warming up (${Math.ceil((gate.min - now) / 1000)}s)`); return false; }
      if (!isReady(name)) {
        if (now < gate.hard) {
          if (!gate.logged || now - gate.logged > 15000) { gate.logged = now; log(`deliver ${name}: waiting for the agent's prompt…`); }
          return false;
        }
        log(`deliver ${name}: no prompt signal after ${Math.round(HARD_WAIT_MS / 1000)}s — delivering anyway`);
      }
    }
    const text = buf.texts.filter(Boolean).join("\n").trim();
    const ok = server.pushToAgent(name, { mid, text: text || "(attachment)", files: buf.files || [] });
    log(`deliver(cli) ${name} mid=${mid} ok=${ok}`);
    if (ok) {
      pending.delete(name); persist(); readyGate.delete(name); // proven ready
      if (mid) { setHw(name, mid); registry.ackDelivered?.(name, mid); }
      try { onDelivered(name); } catch {} // e.g. show "typing…" while the agent works
      return true;
    }
    return false; // keep it queued; replay / sweep will retry
  }

  // Called on stream (re)connect: deliver whatever is queued for this agent.
  async function replay(name) {
    if (pending.has(name)) { log(`replay ${name}`); await deliver(name); }
  }

  // Drop everything queued for `name` (killed agent — nothing should resurrect it).
  function clear(name) {
    const t = timers.get(name);
    if (t) { clearTimeout(t); timers.delete(name); }
    pending.delete(name);
    readyGate.delete(name);
    persist();
  }

  // Background safety net: retry any queued message whose agent is now online (covers debounce=0
  // races and a woken agent that connected without a fresh onStreamConnect firing).
  const sweep = setInterval(() => {
    for (const name of pending.keys()) {
      if (!registry.getAgent(name)) { clear(name); continue; } // ghost (agent deleted) — GC, don't resurrect
      if (server.isOnline(name)) deliver(name).catch(() => {});
      else ensureAlive(name);
    }
  }, 3000);
  if (sweep.unref) sweep.unref();

  return { enqueue, flush, deliver, replay, markReady, clear, hw, setHw, stop: () => clearInterval(sweep) };
}
