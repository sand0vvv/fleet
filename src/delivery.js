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
  const { server, registry, ensureAlive = () => {}, notifyOffline = () => {}, onDelivered = () => {}, debounceSeconds = 15, log = () => {} } = deps;

  const pending = new Map(Object.entries(loadJson(pendingPath()))); // name -> { texts, files, mid }
  const timers = new Map();
  const readyGate = new Map(); // name -> earliest ms we may inject (a freshly-spawned agent needs a
  //   few seconds after its stream connects before it can process a channel notification; injecting
  //   too early silently drops the message). Set by markReady() on stream connect.
  let cursors = loadJson(cursorsPath());

  // A freshly (re)connected agent isn't ready to receive an injection for ~a few seconds.
  function markReady(name, delayMs = 5000) { readyGate.set(name, Date.now() + delayMs); }

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
    // not ready yet (just connected) -> keep queued; the sweep retries once the gate passes.
    const gate = readyGate.get(name) || 0;
    if (Date.now() < gate) { log(`deliver ${name}: warming up (${Math.ceil((gate - Date.now()) / 1000)}s)`); return false; }
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
