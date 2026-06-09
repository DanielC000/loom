import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Releases v1 Part 3 — the daemon surfaces its version. HERMETIC + CLAUDE-FREE + NETWORK-FREE (Db +
// buildServer via app.inject). Proves the version contract:
//   (a) GET /api/version → 200 + { version: <string> };
//   (b) that version is IN SYNC with the umbrella `loom` package.json (the single source of truth) —
//       read from disk at test time, so a future `npm version` bump keeps the endpoint correct;
//   (c) it is NOT a hardcoded literal but READ AT RUNTIME — a child process with LOOM_VERSION set sees
//       that value from the SAME built module, which a baked-in constant could never reflect.
// (a)+(b) are the DoD; (c) is what actually defeats a drift-prone hardcoded copy.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..", "..", ".."); // packages/daemon/test → repo root
const DIST_VERSION = path.join(__dirname, "..", "dist", "version.js");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "loom-version-"));
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = "45330";
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX
delete process.env.LOOM_VERSION;       // (a)+(b) exercise the package.json walk-up, not the override
requireHermeticEnv();

// The single source of truth the endpoint must mirror: the umbrella `loom` package.json `version`.
const pkgVersion = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).version;

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const stub = {};
const db = new Db(path.join(TMP, "loom.db"));
const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });
try {
  // (a) the endpoint exists and returns a { version } string
  const res = await app.inject({ method: "GET", url: "/api/version" });
  check("(a) GET /api/version → 200", res.statusCode === 200);
  const body = res.json();
  check("(a) body has a string `version`", typeof body.version === "string" && body.version.length > 0);

  // (b) IN SYNC with package.json (the source of truth) — NOT a separately-edited literal
  check(`(b) version matches package.json (${pkgVersion})`, body.version === pkgVersion);
} finally {
  try { await app.close(); } catch { /* ignore */ }
  db.close();
}

// (c) READ AT RUNTIME, not baked in: a fresh child process with LOOM_VERSION set must see that value
// from the SAME compiled dist module. A hardcoded constant could never reflect an env override.
{
  const SENTINEL = "9.9.9-runtime-proof";
  const child = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    `import { loomVersion } from ${JSON.stringify(pathToFileURL(DIST_VERSION).href)}; process.stdout.write(loomVersion());`,
  ], { env: { ...process.env, LOOM_VERSION: SENTINEL }, encoding: "utf8" });
  check("(c) child resolved without error", child.status === 0);
  check(`(c) LOOM_VERSION override is honored at runtime (got "${(child.stdout || "").trim()}")`, (child.stdout || "").trim() === SENTINEL);
}

// cleanup (retry for the WAL handle on Windows)
for (let i = 0; i < 5; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch { /* retry */ } }

console.log(failures === 0
  ? "\n✅ ALL PASS — GET /api/version returns the umbrella `loom` package version, stays in sync with package.json (not a hardcoded literal), and resolves the version at runtime."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
