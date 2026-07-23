// Telegram Bot API over plain fetch (no SDK). Long-polling (getUpdates), NOT webhook —
// the runner is fully local, so there is no public URL Telegram could call. Ports the LOGIC of
// fleet-standalone/fleet-backend/telegram.py, but the transport is inbound long-poll here.
//
// The bot token comes from config (loadConfig().botToken). All functions take it explicitly so
// this module stays pure and testable; runner.js binds a token-closured instance via makeTelegram().
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const API = (token) => `https://api.telegram.org/bot${token}`;
const FILE = (token) => `https://api.telegram.org/file/bot${token}`;

// Short, bounded timeout so a Telegram egress blip can never wedge the poll loop. Failures are
// swallowed and reported as {ok:false} so outbound delivery degrades while the control plane survives.
const REQ_TIMEOUT_MS = 8000;
const RETRIES = 3;

async function post(token, method, params, { timeoutMs = REQ_TIMEOUT_MS, retries = RETRIES } = {}) {
  const payload = {};
  for (const [k, v] of Object.entries(params || {})) if (v !== null && v !== undefined) payload[k] = v;
  let last = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(`${API(token)}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      return await r.json();
    } catch (e) {
      last = e;
      if (attempt < retries) await sleep(800 * attempt);
    } finally {
      clearTimeout(t);
    }
  }
  return { ok: false, error: String(last?.message || last) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── outbound ──────────────────────────────────────────────────────────────────
// Telegram text limit is 4096; chunk defensively at 4000 so multi-byte tails never overflow.
export async function sendMessage(token, chatId, text, threadId = null, replyTo = null) {
  const body = String(text ?? " ") || " ";
  const chunks = [];
  for (let i = 0; i < body.length; i += 4000) chunks.push(body.slice(i, i + 4000));
  if (chunks.length === 0) chunks.push(" ");
  let last = null;
  for (const ch of chunks) {
    last = await post(token, "sendMessage", {
      chat_id: chatId,
      text: ch,
      message_thread_id: threadId,
      reply_to_message_id: replyTo,
    });
  }
  return last;
}

export async function sendDocument(token, chatId, filePath, { caption = null, threadId = null, filename = null } = {}) {
  try {
    const buf = readFileSync(filePath);
    const fd = new FormData();
    fd.append("chat_id", String(chatId));
    if (caption) fd.append("caption", String(caption).slice(0, 1024));
    if (threadId) fd.append("message_thread_id", String(threadId));
    fd.append("document", new Blob([buf]), filename || basename(filePath));
    const r = await fetch(`${API(token)}/sendDocument`, { method: "POST", body: fd });
    return await r.json();
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

export async function sendPhoto(token, chatId, filePath, { caption = null, threadId = null, filename = null } = {}) {
  try {
    const buf = readFileSync(filePath);
    const fd = new FormData();
    fd.append("chat_id", String(chatId));
    if (caption) fd.append("caption", String(caption).slice(0, 1024));
    if (threadId) fd.append("message_thread_id", String(threadId));
    fd.append("photo", new Blob([buf]), filename || basename(filePath));
    const r = await fetch(`${API(token)}/sendPhoto`, { method: "POST", body: fd });
    return await r.json();
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// ── forum topics ────────────────────────────────────────────────────────────
export async function createForumTopic(token, chatId, name) {
  const res = await post(token, "createForumTopic", { chat_id: chatId, name: String(name).slice(0, 128) });
  return (res?.result || {}).message_thread_id ?? null;
}

export async function editForumTopic(token, chatId, threadId, name) {
  return post(token, "editForumTopic", { chat_id: chatId, message_thread_id: threadId, name: String(name).slice(0, 128) });
}

export async function deleteForumTopic(token, chatId, threadId) {
  return post(token, "deleteForumTopic", { chat_id: chatId, message_thread_id: threadId });
}

export async function pinMessage(token, chatId, messageId) {
  return post(token, "pinChatMessage", { chat_id: chatId, message_id: messageId, disable_notification: true });
}

export async function unpinMessage(token, chatId, messageId) {
  return post(token, "unpinChatMessage", { chat_id: chatId, message_id: messageId });
}

// Resolve a Telegram file_id to a temporary downloadable URL.
export async function getFileUrl(token, fileId) {
  const res = await post(token, "getFile", { file_id: fileId });
  const path = (res?.result || {}).file_path;
  return path ? `${FILE(token)}/${path}` : null;
}

// Register the bot's slash-command menu so users see the commands in Telegram's "/" UI.
export async function setMyCommands(token, commands) {
  return post(token, "setMyCommands", { commands });
}

// Send a message with an inline keyboard (rows of [{text, data}] buttons -> callback_query).
export async function sendKeyboard(token, chatId, text, threadId, rows) {
  const inline_keyboard = rows.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data })));
  return post(token, "sendMessage", {
    chat_id: chatId, text, message_thread_id: threadId ?? undefined,
    reply_markup: { inline_keyboard },
  });
}

// Acknowledge a callback_query (removes the "loading" spinner on the tapped button; optional toast).
export async function answerCallback(token, callbackId, text) {
  return post(token, "answerCallbackQuery", { callback_query_id: callbackId, text: text || undefined });
}

// Remove any webhook so getUpdates (long-poll) works — needed when reusing a bot that was on a webhook.
export async function deleteWebhook(token) {
  return post(token, "deleteWebhook", { drop_pending_updates: false });
}

// ── inbound: long-polling ─────────────────────────────────────────────────────
// pollUpdates runs forever: getUpdates with a 30s server-side long poll + offset tracking so each
// update is delivered exactly once. onUpdate(update) is awaited per update; a throwing handler is
// logged and skipped (never wedges the loop). Returns a stopper: call it to end the loop cleanly.
export function pollUpdates(token, onUpdate, { log = () => {} } = {}) {
  let offset = 0;
  let running = true;
  let abort = null;

  (async () => {
    log("telegram: long-poll started");
    let netFails = 0; // consecutive network failures — drives backoff + keeps the log quiet
    while (running) {
      const ctrl = new AbortController();
      abort = ctrl;
      // getUpdates timeout=30 (server holds the request); client timeout a bit longer so we don't
      // abort a healthy long poll. allowed_updates keeps the stream to messages we care about.
      const clientTimeout = setTimeout(() => ctrl.abort(), 45000);
      try {
        const r = await fetch(`${API(token)}/getUpdates`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            offset,
            timeout: 30,
            allowed_updates: ["message", "edited_message", "callback_query"],
          }),
          signal: ctrl.signal,
        });
        const data = await r.json();
        if (netFails) { log(`telegram: reconnected (after ${netFails} failed poll${netFails > 1 ? "s" : ""})`); netFails = 0; }
        if (data?.ok && Array.isArray(data.result)) {
          for (const upd of data.result) {
            offset = Math.max(offset, (upd.update_id || 0) + 1); // advance past this update
            try {
              await onUpdate(upd);
            } catch (e) {
              log("telegram: onUpdate error:", String(e?.message || e));
            }
          }
        } else if (data && data.ok === false) {
          // e.g. 409 Conflict (another getUpdates / webhook set). Back off so we don't hammer.
          log("telegram: getUpdates not ok:", JSON.stringify(data).slice(0, 200));
          await sleep(3000);
        }
      } catch (e) {
        if (running) {
          // AbortError on our own client-timeout is normal when Telegram returns nothing; only
          // pause on real network errors. Backoff grows to 30s; log the 1st failure then every
          // 10th so a flaky wifi doesn't flood the console (messages are never lost — long-poll
          // just retries and Telegram redelivers from the same offset).
          if (e?.name !== "AbortError") {
            netFails++;
            if (netFails === 1 || netFails % 10 === 0) {
              log(`telegram: network hiccup (${String(e?.message || e)}) — retrying (x${netFails})`);
            }
            await sleep(Math.min(30000, 2000 * netFails));
          }
        }
      } finally {
        clearTimeout(clientTimeout);
      }
    }
    log("telegram: long-poll stopped");
  })();

  return () => {
    running = false;
    try { abort?.abort(); } catch {}
  };
}

// Convenience: bind a token so callers write telegram.sendMessage(chatId, text, thread) instead of
// threading the token everywhere. runner.js uses this.
export function makeTelegram(token, { log } = {}) {
  return {
    token,
    sendMessage: (chatId, text, threadId, replyTo) => sendMessage(token, chatId, text, threadId, replyTo),
    sendDocument: (chatId, filePath, opts) => sendDocument(token, chatId, filePath, opts),
    sendPhoto: (chatId, filePath, opts) => sendPhoto(token, chatId, filePath, opts),
    createForumTopic: (chatId, name) => createForumTopic(token, chatId, name),
    editForumTopic: (chatId, threadId, name) => editForumTopic(token, chatId, threadId, name),
    deleteForumTopic: (chatId, threadId) => deleteForumTopic(token, chatId, threadId),
    pinMessage: (chatId, messageId) => pinMessage(token, chatId, messageId),
    unpinMessage: (chatId, messageId) => unpinMessage(token, chatId, messageId),
    getFileUrl: (fileId) => getFileUrl(token, fileId),
    setMyCommands: (commands) => setMyCommands(token, commands),
    sendKeyboard: (chatId, text, threadId, rows) => sendKeyboard(token, chatId, text, threadId, rows),
    answerCallback: (callbackId, text) => answerCallback(token, callbackId, text),
    deleteWebhook: () => deleteWebhook(token),
    pollUpdates: (onUpdate) => pollUpdates(token, onUpdate, { log }),
  };
}
