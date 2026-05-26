import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** All daemon-owned state lives under ~/.loom (overridable via LOOM_HOME). */
export const LOOM_HOME = process.env.LOOM_HOME || path.join(os.homedir(), ".loom");
export const DB_PATH = path.join(LOOM_HOME, "loom.db");
export const SETTINGS_DIR = path.join(LOOM_HOME, "tmp", "settings");

/** hook-relay.mjs ships as an asset alongside the built daemon. */
export const RELAY_SCRIPT = path.join(__dirname, "..", "assets", "hook-relay.mjs");

export const PORT = Number(process.env.LOOM_PORT || 4317);

export function ensureDirs(): void {
  for (const d of [LOOM_HOME, SETTINGS_DIR]) fs.mkdirSync(d, { recursive: true });
}
