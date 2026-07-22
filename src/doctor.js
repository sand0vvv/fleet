// `fleet doctor` — environment check. Green = ready, yellow = optional/missing, red = blocking.
import { spawnSync } from "node:child_process";
import { loadConfig, isLinked, configPath } from "./config.js";

const G = "\x1b[32m●\x1b[0m", Y = "\x1b[33m●\x1b[0m", R = "\x1b[31m●\x1b[0m";

function bin(name) {
  try {
    const r = spawnSync(name, ["--version"], { encoding: "utf-8", shell: process.platform === "win32" });
    if (r.status === 0) return (r.stdout || r.stderr || "").split("\n")[0].trim();
  } catch {}
  return null;
}

export async function runDoctor() {
  const cfg = loadConfig();
  const rows = [];

  const node = process.versions.node;
  rows.push([Number(node.split(".")[0]) >= 18 ? G : R, "node", node]);

  const claude = bin("claude");
  rows.push([claude ? G : R, "claude", claude || "NOT FOUND — install Claude Code (required)"]);

  const codex = bin("codex");
  rows.push([codex ? G : Y, "codex", codex || "not found (optional — needed only for engine=codex)"]);

  rows.push([cfg.botToken ? G : R, "bot token", cfg.botToken ? "set" : "missing — run: fleet init"]);

  const wp = cfg.whisper?.provider || "groq";
  const wok = wp === "local" || !!cfg.whisper?.key;
  rows.push([wok ? G : Y, "whisper", `${wp}${cfg.whisper?.key ? " (key set)" : wp === "local" ? "" : " — no key (voice disabled)"}`]);

  rows.push([isLinked(cfg) ? G : Y, "linked", isLinked(cfg) ? `owner ${cfg.ownerId} · group ${cfg.supergroupId}` : "not yet — send /link in your supergroup"]);

  console.log(`\n  \x1b[36m🛰  fleet doctor\x1b[0m   (${configPath()})\n`);
  for (const [dot, label, val] of rows) console.log(`  ${dot} ${label.padEnd(12)} ${val}`);
  const blocking = rows.some((r) => r[0] === R);
  console.log(blocking ? "\n  \x1b[31mFix the red items before `fleet start`.\x1b[0m\n" : "\n  \x1b[32mReady.\x1b[0m Run: fleet start\n");
}
