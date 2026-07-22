// Local config for @fleet/runner. Lives in the user's HOME, NEVER in a repo, so secrets
// (bot token, API keys) cannot be committed. Path priority:
//   1. $FLEET_CONFIG                  (explicit override)
//   2. <cwd>/.fleet/config.json       (project-local, if present)
//   3. ~/.fleet/config.json           (default, global for the machine)
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

export function fleetDir() {
  if (process.env.FLEET_CONFIG) return dirname(process.env.FLEET_CONFIG);
  const local = join(process.cwd(), ".fleet");
  if (existsSync(join(local, "config.json"))) return local;
  return join(homedir(), ".fleet");
}

export function configPath() {
  return process.env.FLEET_CONFIG || join(fleetDir(), "config.json");
}

// Schema (all fields optional until `init`/`/link` fill them):
// {
//   botToken:      string,   // Telegram bot token
//   ownerId:       number,   // owner's Telegram user id (set by /link)
//   supergroupId:  number,   // supergroup chat id (set by /link)
//   whisper:       { provider: "groq"|"openai"|"local", key: string },
//   debounceSeconds: number, // batch fast messages (default 15)
//   model:         string,   // default model for spawned agents
//   machineName:   string,   // this machine's label (default "home")
//   port:          number,   // localhost port the runner hosts (default 9987)
//   runnerToken:   string,   // shared secret between runner and its MCP (auto-generated)
// }
const DEFAULTS = {
  whisper: { provider: "groq", key: "" },
  debounceSeconds: 15,
  model: "",
  machineName: "home",
  port: 9987,
  runnerToken: "",
};

export function loadConfig() {
  const p = configPath();
  let cfg = {};
  if (existsSync(p)) {
    try { cfg = JSON.parse(readFileSync(p, "utf-8")); } catch { cfg = {}; }
  }
  return { ...DEFAULTS, ...cfg, whisper: { ...DEFAULTS.whisper, ...(cfg.whisper || {}) } };
}

export function saveConfig(cfg) {
  const dir = fleetDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
  return cfg;
}

// /link: bind owner + supergroup, learned from the first `/link` message. Idempotent.
export function linkOwner(ownerId, supergroupId) {
  const cfg = loadConfig();
  cfg.ownerId = ownerId;
  cfg.supergroupId = supergroupId;
  return saveConfig(cfg);
}

export function isLinked(cfg = loadConfig()) {
  return Boolean(cfg.ownerId && cfg.supergroupId);
}
