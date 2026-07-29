// Which codex thread is live? The app-server announces it under different event names depending on
// how the TUI started: `thread/started` for a NEW thread, `thread/loaded` when `codex resume`
// re-opens one, and turn/item events carry it while it works.
//
// Keying on `thread/started` alone is what broke owner messages after session-continuity shipped:
// with `codex resume --last` that event never fires, so every message queued forever
// ("queued message mid=… — no active thread yet"). Accept the id from ANY event that names one.
export function threadIdOf(msg) {
  const p = msg?.params;
  if (!p || typeof p !== "object") return null;
  const direct = p.thread?.id || p.threadId || p.thread_id;
  if (typeof direct === "string" && direct) return direct;
  // thread/* events may put the id straight on params.id
  if (typeof msg.method === "string" && msg.method.startsWith("thread/") && typeof p.id === "string" && p.id) {
    return p.id;
  }
  return null;
}

// Pull the newest thread id out of a `thread/list` reply (shape varies by version).
export function newestThreadId(result) {
  const list = result?.threads || result?.items || (Array.isArray(result) ? result : []);
  if (!Array.isArray(list) || !list.length) return null;
  const withTime = list
    .map((t) => ({ id: t?.id || t?.threadId || t?.thread?.id, ts: t?.updatedAt || t?.updated_at || t?.createdAt || t?.created_at || 0 }))
    .filter((t) => typeof t.id === "string" && t.id);
  if (!withTime.length) return null;
  withTime.sort((a, b) => new Date(b.ts || 0) - new Date(a.ts || 0));
  return withTime[0].id;
}
