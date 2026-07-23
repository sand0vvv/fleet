#!/usr/bin/env node
// fleet CLI. Cross-platform (Win/Mac/Linux).
// Subcommands: init | start | stop | update | logs | autostart | claude | codex | doctor | status | help.
import { loadConfig, isLinked, configPath, fleetDir } from "./config.js";
import { BANNER } from "./banner.js";
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { spawnSync, spawn as spawnProc } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

const cmd = (process.argv[2] || "").toLowerCase();
const rest = process.argv.slice(3);

// Non-blocking: tell the user if a newer fleet is on npm. Runs on EVERY subcommand.
async function checkVersion() {
  try {
    const r = await fetch(`https://registry.npmjs.org/${pkg.name}/latest`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return;
    const latest = (await r.json()).version;
    if (latest && latest !== pkg.version) {
      console.log(`\x1b[33m↑ fleet ${latest} is available (you have ${pkg.version}). Update: fleet update\x1b[0m`);
    }
  } catch { /* offline / unpublished — ignore */ }
}

// Stop the running runner via its pid file. Returns true if something was stopped.
function stopRunner({ quiet = false } = {}) {
  const pidPath = join(fleetDir(), "runner.pid");
  if (!existsSync(pidPath)) { if (!quiet) console.log("fleet: no runner.pid — nothing to stop."); return false; }
  const pid = Number(readFileSync(pidPath, "utf-8").trim());
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch {}
  if (!alive) { rmSync(pidPath, { force: true }); if (!quiet) console.log("fleet: runner not running (stale pid file removed)."); return false; }
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  else { try { process.kill(pid, "SIGTERM"); } catch {} }
  rmSync(pidPath, { force: true });
  if (!quiet) console.log(`\x1b[32m✓\x1b[0m fleet runner stopped (pid ${pid}).`);
  return true;
}

const STARTUP_BAT = () => join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "fleet-autostart.bat");

async function main() {
  switch (cmd) {
    case "init": {
      checkVersion().catch(() => {});
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
    case "stop": {
      checkVersion().catch(() => {});
      stopRunner();
      return;
    }
    case "update": {
      // stop -> npm i -g latest -> relaunch the runner in its own console (Windows locks native
      // files of a RUNNING runner, so the stop must come first).
      const wasRunning = stopRunner({ quiet: true });
      console.log(`updating ${pkg.name}…`);
      const r = spawnSync("npm", ["i", "-g", `${pkg.name}@latest`], { stdio: "inherit", shell: process.platform === "win32" });
      if (r.status !== 0) { console.log("\x1b[31mupdate failed\x1b[0m — see npm output above."); process.exit(1); }
      console.log(`\x1b[32m✓ updated\x1b[0m`);
      if (wasRunning && process.platform === "win32") {
        spawnProc("cmd.exe", ["/c", "start", "fleet", "cmd", "/k", "fleet start"], { detached: true, stdio: "ignore" });
        console.log("runner restarted in a new console window.");
      } else if (wasRunning) {
        console.log("restart the runner:  fleet start");
      }
      return;
    }
    case "logs": {
      const n = Math.max(1, Number(rest[0]) || 60);
      const lf = join(fleetDir(), "logs", "runner.log");
      if (!existsSync(lf)) { console.log("fleet: no runner log yet (start the runner once)."); return; }
      const lines = readFileSync(lf, "utf-8").trimEnd().split("\n");
      console.log(lines.slice(-n).join("\n"));
      return;
    }
    case "autostart": {
      const mode = (rest[0] || "").toLowerCase();
      if (process.platform !== "win32") { console.log("fleet: autostart is Windows-only for now (mac/linux: use launchd/systemd)."); return; }
      const bat = STARTUP_BAT();
      if (mode === "on") {
        writeFileSync(bat, `@echo off\r\nstart "fleet" cmd /k fleet start\r\n`);
        console.log(`\x1b[32m✓\x1b[0m autostart ON — the fleet starts at logon (${bat})`);
      } else if (mode === "off") {
        rmSync(bat, { force: true });
        console.log("\x1b[32m✓\x1b[0m autostart OFF");
      } else {
        console.log(`autostart is ${existsSync(bat) ? "ON" : "OFF"}.  Usage: fleet autostart on|off`);
      }
      return;
    }
    case "claude":
    case "codex": {
      // spawn an agent for the CURRENT folder via the already-running runner
      checkVersion().catch(() => {});
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
      checkVersion().catch(() => {});
      const { runDoctor } = await import("./doctor.js");
      return runDoctor();
    }
    case "status": {
      checkVersion().catch(() => {});
      const cfg = loadConfig();
      const line = (label, val) => console.log(`  ${label.padEnd(14)} ${val}`);
      process.stdout.write(BANNER);
      line("version", pkg.version);
      line("config", configPath());
      line("bot token", cfg.botToken ? "set" : "\x1b[33mmissing (run: fleet init)\x1b[0m");
      line("linked", isLinked(cfg) ? `owner ${cfg.ownerId} · group ${cfg.supergroupId}` : "\x1b[33mno (send /link in your supergroup)\x1b[0m");
      line("whisper", `${cfg.whisper?.provider || "groq"}${cfg.whisper?.key ? " (key set)" : " \x1b[33m(no key)\x1b[0m"}`);
      line("model", cfg.model || "(default)");
      line("machine", cfg.machineName || "home");
      line("autostart", process.platform === "win32" ? (existsSync(STARTUP_BAT()) ? "on" : "off") : "n/a");
      return;
    }
    case "help":
    default: {
      checkVersion().catch(() => {});
      process.stdout.write(BANNER);
      console.log(`  Usage:
    fleet init          set up bot token, whisper, defaults
    fleet start         run the fleet (Telegram long-poll, local)
    fleet stop          stop the running fleet
    fleet update        stop → npm i -g latest → restart
    fleet logs [n]      last n lines of the runner log (default 60)
    fleet autostart on|off   start the fleet at logon (Windows)
    fleet claude        spawn a Claude agent for the current folder
    fleet codex         spawn a Codex agent for the current folder
    fleet doctor        check your environment
    fleet status        show current config
    fleet help          this text
`);
    }
  }
}

main().catch((e) => { console.error("fleet:", e?.message || e); process.exit(1); });
