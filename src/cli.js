#!/usr/bin/env node
// @fleet/runner CLI. Cross-platform (Win/Mac/Linux). Subcommands: init | start | doctor | status.
import { loadConfig, isLinked, configPath } from "./config.js";
import { BANNER } from "./banner.js";

const cmd = (process.argv[2] || "").toLowerCase();
const rest = process.argv.slice(3);

// Non-blocking: tell the user if a newer @fleet/runner is on npm.
async function checkVersion() {
  try {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf-8"));
    const r = await fetch(`https://registry.npmjs.org/${pkg.name}/latest`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return;
    const latest = (await r.json()).version;
    if (latest && latest !== pkg.version) {
      console.log(`\x1b[33m↑ fleet ${latest} is available (you have ${pkg.version}). Update: npm i -g ${pkg.name}\x1b[0m`);
    }
  } catch { /* offline / unpublished — ignore */ }
}

async function main() {
  switch (cmd) {
    case "init": {
      const { runInit } = await import("./init.js");
      return runInit();
    }
    case "start": {
      const cfg = loadConfig();
      if (!cfg.botToken) {
        console.log("No bot token configured. Run:  fleet init");
        process.exit(1);
      }
      process.stdout.write(BANNER);
      if (!isLinked(cfg)) {
        console.log("\x1b[33mNot linked yet.\x1b[0m Add your bot to a Telegram supergroup (with topics enabled) and send \x1b[36m/link\x1b[0m there.");
      }
      checkVersion().catch(() => {});
      const { startRunner } = await import("./runner.js");
      return startRunner(cfg);
    }
    case "claude":
    case "codex": {
      // spawn an agent for the CURRENT folder via the already-running runner
      const cfg = loadConfig();
      const port = cfg.port || 9987;
      const path = process.cwd();
      try {
        const r = await fetch(`http://localhost:${port}/spawn`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-fleet-token": cfg.runnerToken || "" },
          body: JSON.stringify({ path, engine: cmd }),
        });
        const j = await r.json().catch(() => ({}));
        if (j.ok) console.log(`\x1b[32m✓\x1b[0m spawned a ${cmd} agent for ${path} — open its topic in your Telegram supergroup.`);
        else console.log(`fleet: ${j.error || "spawn failed"}`);
      } catch {
        console.log("fleet: runner not reachable. Start it first in another terminal:  fleet start");
      }
      return;
    }
    case "doctor": {
      const { runDoctor } = await import("./doctor.js");
      return runDoctor();
    }
    case "status": {
      const cfg = loadConfig();
      const line = (label, val) => console.log(`  ${label.padEnd(14)} ${val}`);
      process.stdout.write(BANNER);
      line("config", configPath());
      line("bot token", cfg.botToken ? "set" : "\x1b[33mmissing (run: fleet init)\x1b[0m");
      line("linked", isLinked(cfg) ? `owner ${cfg.ownerId} · group ${cfg.supergroupId}` : "\x1b[33mno (send /link in your supergroup)\x1b[0m");
      line("whisper", `${cfg.whisper?.provider || "groq"}${cfg.whisper?.key ? " (key set)" : " \x1b[33m(no key)\x1b[0m"}`);
      line("model", cfg.model || "(default)");
      line("machine", cfg.machineName || "home");
      return;
    }
    default:
      process.stdout.write(BANNER);
      console.log(`  Usage:
    fleet init        set up bot token, whisper, defaults
    fleet start       run the fleet (Telegram long-poll, local)
    fleet claude      spawn a Claude agent for the current folder
    fleet codex       spawn a Codex agent for the current folder
    fleet doctor      check your environment
    fleet status      show current config
`);
  }
}

main().catch((e) => { console.error("fleet:", e?.message || e); process.exit(1); });
