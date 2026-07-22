// Voice transcription for Telegram voice messages. Provider chosen in config.whisper.provider:
//   "groq"   -> Groq API   (whisper-large-v3-turbo)  — fast, recommended
//   "openai" -> OpenAI API (whisper-1)
//   "local"  -> local faster-whisper via a `whisper`/`faster-whisper` CLI on PATH (optional)
// Keys live in ~/.fleet/config.json (never in a repo). On failure returns a visible marker, not "".
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, readFileSync, rmSync } from "node:fs";

async function download(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function viaApi(endpoint, key, model, audio) {
  const form = new FormData();
  form.append("model", model);
  form.append("file", new Blob([audio], { type: "audio/ogg" }), "audio.ogg");
  const r = await fetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 120)}`);
  return ((await r.json()).text || "").trim();
}

function viaLocal(audio) {
  // Best-effort: write ogg to temp, call a `whisper`-style CLI, read the produced text.
  const base = join(tmpdir(), `fleet-voice-${Date.now()}`);
  const ogg = base + ".ogg";
  writeFileSync(ogg, audio);
  try {
    const r = spawnSync("whisper", [ogg, "--model", "base", "--output_format", "txt", "--output_dir", tmpdir()],
      { encoding: "utf-8", shell: process.platform === "win32", timeout: 120000 });
    if (r.status === 0) { try { return readFileSync(base + ".txt", "utf-8").trim(); } catch {} return (r.stdout || "").trim(); }
    throw new Error(r.stderr?.slice(0, 120) || "local whisper failed");
  } finally { try { rmSync(ogg); } catch {} }
}

// transcribeUrl(fileUrl, whisperCfg) -> text (or a visible [voice: ...] marker on failure).
export async function transcribeUrl(fileUrl, whisper = {}) {
  const provider = whisper.provider || "groq";
  const key = whisper.key || "";
  if (provider !== "local" && !key) return "[voice: no whisper key set — run `fleet init`, or reply with text]";
  let audio;
  try { audio = await download(fileUrl); } catch { return "[voice: couldn't download — resend]"; }
  for (let i = 0; i < 2; i++) {
    try {
      if (provider === "groq") { const t = await viaApi("https://api.groq.com/openai/v1/audio/transcriptions", key, "whisper-large-v3-turbo", audio); if (t) return t; }
      else if (provider === "openai") { const t = await viaApi("https://api.openai.com/v1/audio/transcriptions", key, "whisper-1", audio); if (t) return t; }
      else { const t = viaLocal(audio); if (t) return t; }
    } catch { /* retry once */ }
  }
  return "[voice: couldn't transcribe (rate limit or bad audio) — resend as text]";
}
