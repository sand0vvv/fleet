// `fleet init` — interactive setup wizard. Writes ~/.fleet/config.json. Secrets never leave home.
// Existing secrets are shown MASKED (8853…HTI) with keep/change/show — re-running init never
// forces you to retype (or even see) a token.
import prompts from "prompts";
import { randomBytes } from "node:crypto";
import { loadConfig, saveConfig, configPath } from "./config.js";

const onCancel = () => { console.log("\n  cancelled."); process.exit(1); };

const mask = (s) => { s = String(s || ""); return s.length <= 8 ? "•••" : s.slice(0, 4) + "…" + s.slice(-3); };

// Ask for a secret. No current value -> plain text prompt. Has one -> masked keep/change/show menu.
async function secretPrompt(label, current, validate) {
  if (!current) {
    const a = await prompts({ type: "text", name: "v", message: label, validate }, { onCancel });
    return String(a.v || "").trim();
  }
  for (;;) {
    const a = await prompts({
      type: "select", name: "act",
      message: `${label}  \x1b[2m${mask(current)}\x1b[0m`,
      choices: [
        { title: "keep", value: "keep" },
        { title: "change", value: "change" },
        { title: "show", value: "show" },
      ],
      initial: 0,
    }, { onCancel });
    if (a.act === "keep") return current;
    if (a.act === "change") {
      const b = await prompts({ type: "text", name: "v", message: `new ${label}`, validate }, { onCancel });
      const v = String(b.v || "").trim();
      return v || current; // blank = keep the old one
    }
    console.log(`  ${label}: ${current}`); // show, then ask again
  }
}

export async function runInit() {
  const cur = loadConfig();
  console.log("\n  \x1b[36m🛰  fleet setup\x1b[0m — stored locally at " + configPath() + "\n");

  const botToken = await secretPrompt(
    "Telegram bot token (from @BotFather)",
    cur.botToken || "",
    (v) => (/^\d+:[\w-]{30,}$/.test(String(v).trim()) ? true : "Looks like that's not a bot token"),
  );

  const a = await prompts([
    {
      type: "select",
      name: "provider",
      message: "Voice transcription (Whisper) provider",
      choices: [
        { title: "Groq API (fast, recommended)", value: "groq" },
        { title: "OpenAI API", value: "openai" },
        { title: "Local whisper (faster-whisper)", value: "local" },
        { title: "None (text only for now)", value: "none" },
      ],
      initial: 0,
    },
  ], { onCancel });

  let whisperKey = cur.whisper?.key || "";
  if (a.provider === "groq" || a.provider === "openai") {
    whisperKey = await secretPrompt(`${a.provider === "groq" ? "Groq" : "OpenAI"} API key`, whisperKey);
  }

  const b = await prompts([
    {
      type: "number",
      name: "debounceSeconds",
      message: "Debounce seconds — batch fast messages before the agent replies (0 = no debounce)",
      initial: cur.debounceSeconds ?? 15,
      min: 0,
    },
    {
      type: "text",
      name: "model",
      message: "Default model for agents (blank = provider default)",
      initial: cur.model || "",
    },
    {
      type: "text",
      name: "machineName",
      message: "Name for this machine",
      initial: cur.machineName || "home",
    },
  ], { onCancel });

  const cfg = {
    ...cur,
    botToken,
    whisper: { provider: a.provider === "none" ? "groq" : a.provider, key: whisperKey },
    debounceSeconds: Number.isFinite(Number(b.debounceSeconds)) ? Math.max(0, Number(b.debounceSeconds)) : 15,
    model: String(b.model || "").trim(),
    machineName: String(b.machineName || "home").trim(),
    runnerToken: cur.runnerToken || randomBytes(16).toString("hex"),
  };
  saveConfig(cfg);

  console.log(`\n  \x1b[32m✓ saved\x1b[0m ${configPath()}`);
  console.log(`  Next:  \x1b[36mfleet start\x1b[0m   then send \x1b[36m/link\x1b[0m in your Telegram supergroup.\n`);
}
