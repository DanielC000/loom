// Hermetic unit test for scripts/lib/env-file.mjs (the daemon-supervisor's file-based .env loader).
// NO daemon, NO build — pure fs against a throwaway temp dir. Run: node scripts/test-env-file.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseDotEnv, loadDotEnvFile, fillEnvDefaults } from "./lib/env-file.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- parseDotEnv ---
const parsed = parseDotEnv([
  "# a comment",
  "",
  "LOOM_CODESCAPE_ENABLED=1",
  "  SPACED = padded  ",
  'QUOTED_DOUBLE="value with spaces"',
  "QUOTED_SINGLE='also spaced'",
  "# ANOTHER=ignored",
  "NO_EQUALS_SIGN",
  "=NO_KEY",
].join("\n"));
check("parses a plain KEY=VALUE", parsed.LOOM_CODESCAPE_ENABLED === "1");
check("trims whitespace around key and value", parsed.SPACED === "padded");
check("strips matching double quotes", parsed.QUOTED_DOUBLE === "value with spaces");
check("strips matching single quotes", parsed.QUOTED_SINGLE === "also spaced");
check("ignores a comment line", !("ANOTHER" in parsed));
check("ignores a line with no '='", !("NO_EQUALS_SIGN" in parsed));
check("ignores a line with an empty key", !("" in parsed));
check("no stray keys beyond the expected four", Object.keys(parsed).length === 4);

// --- loadDotEnvFile ---
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-envfile-"));
const envPath = path.join(dir, ".env");
fs.writeFileSync(envPath, "FOO=bar\nBAZ=qux\n");
const loaded = loadDotEnvFile(envPath);
check("loads a real file's key/value pairs", loaded.FOO === "bar" && loaded.BAZ === "qux");

const missingPath = path.join(dir, "does-not-exist.env");
check("a missing file is a clean no-op (empty object)", Object.keys(loadDotEnvFile(missingPath)).length === 0);

// loadDotEnvFile must never throw, even for an unreadable path (e.g. a directory in place of a file)
const dirAsFile = path.join(dir, "a-directory");
fs.mkdirSync(dirAsFile);
try {
  const result = loadDotEnvFile(dirAsFile);
  check("reading a directory as a file is swallowed, not thrown", Object.keys(result).length === 0);
} catch {
  check("reading a directory as a file is swallowed, not thrown", false);
}

// --- fillEnvDefaults: shell always wins, file only fills gaps ---
const shellEnv = { EXISTING: "from-shell" };
const fileEnv = { EXISTING: "from-file", NEW_FLAG: "from-file" };
const merged = fillEnvDefaults(shellEnv, fileEnv);
check("a var already in the target is NOT overridden by the file", merged.EXISTING === "from-shell");
check("a var missing from the target IS filled in from the file", merged.NEW_FLAG === "from-file");
check("fillEnvDefaults mutates and returns the same target object", merged === shellEnv);

fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${failures === 0 ? "✅" : "❌"} env-file: ${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
process.exit(failures ? 1 : 0);
