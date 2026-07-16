// Small, dependency-free loader for a file-based .env, used by daemon-supervisor.mjs so an operator
// can toggle feature flags (e.g. LOOM_CODESCAPE_ENABLED) in <LOOM_HOME>/.env and have a daemon_restart
// (in-process, exit 75 — reuses this process's env, not a fresh shell) pick them up, instead of
// requiring shell state + a full manual relaunch. No dotenv dependency in the tree; Node built-ins only.
import fs from "node:fs";

/**
 * Parse simple `KEY=VALUE` dotenv content: one assignment per line, blank lines and `#`-prefixed
 * comment lines ignored, surrounding whitespace trimmed, and a value optionally wrapped in matching
 * single/double quotes (stripped). No interpolation, no `export`, no multiline values — just enough
 * for a feature-flag file.
 */
export function parseDotEnv(content) {
  const result = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value[0] === '"' && value[value.length - 1] === '"') ||
        (value[0] === "'" && value[value.length - 1] === "'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/** Load `filePath` as a dotenv file. A missing file (or any read error) is a clean no-op — never throws. */
export function loadDotEnvFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    return parseDotEnv(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    console.error(`[env-file] load failed for ${filePath} (continuing): ${err.message}`);
    return {};
  }
}

/**
 * Fill any key `fileEnv` sets that `target` does NOT already have, mutating `target` in place and
 * returning it. A key `target` already sets always wins — so a real shell var is never clobbered by
 * the file; the file only fills in vars the shell doesn't set.
 */
export function fillEnvDefaults(target, fileEnv) {
  for (const [key, value] of Object.entries(fileEnv)) {
    if (!(key in target)) target[key] = value;
  }
  return target;
}
