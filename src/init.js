// `fleet init` — interactive setup wizard. Writes ~/.fleet/config.json. Secrets never leave home.
import prompts from "prompts";
import { randomBytes } from "node:crypto";
import { loadConfig, saveConfig, configPath } from "./config.js";

export async function runInit() {
  const cur = loadConfig();
  console.log("\n  \x1b[36m🛰  fleet setup\x1b[0m — stored locally at " + configPath() + "\n");

  const a = await prompts([
    {
      type: "text",
      name: "botToken",
      message: "Telegram bot token (from @BotFather)",
      initial: cur.botToken || "",
      validate: (v) => (/^\d+:[\w-]{30,}$/.test(String(v).trim()) ? true : "Looks like that's not a bot token"),
    },
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
    {
      type: (prev) => (prev === "groq" || prev === "openai" ? "text" : null),
      name: "whisperKey",
      message: (prev) => `${prev === "groq" ? "Groq" : "OpenAI"} API key`,
      initial: cur.whisper?.key || "",
    },
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
  ], { onCancel: () => { console.log("\n  cancelled."); process.exit(1); } });

  const cfg = {
    ...cur,
    botToken: String(a.botToken).trim(),
    whisper: { provider: a.provider === "none" ? "groq" : a.provider, key: a.whisperKey ? String(a.whisperKey).trim() : (cur.whisper?.key || "") },
    debounceSeconds: Number.isFinite(Number(a.debounceSeconds)) ? Math.max(0, Number(a.debounceSeconds)) : 15,
    model: String(a.model || "").trim(),
    machineName: String(a.machineName || "home").trim(),
    runnerToken: cur.runnerToken || randomBytes(16).toString("hex"),
  };
  saveConfig(cfg);

  console.log(`\n  \x1b[32m✓ saved\x1b[0m ${configPath()}`);
  console.log(`  Next:  \x1b[36mfleet start\x1b[0m   then send \x1b[36m/link\x1b[0m in your Telegram supergroup.\n`);
}
