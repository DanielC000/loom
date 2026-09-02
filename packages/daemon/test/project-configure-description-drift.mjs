import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card b3a89191 — project_configure's tool description (mcp/platform.ts) enumerated its settable
// top-level keys as a hand-typed sentence, and that sentence had ALREADY silently drifted from
// projectConfigOverrideSchema TWICE (missing `codescape` and `memory`, both deliberately agent-settable
// — see their own doc comments in mcp/platform.ts). Since the description also says "unknown keys
// rejected", the two together read as an authoritative CLOSED list — a Platform Lead hit this
// first-hand mid-triage and nearly escalated an agent-settable knob to the owner as human-only.
//
// This test makes that class of drift mechanically impossible to reintroduce silently: it derives the
// schema's REAL top-level key set (CONFIG_TOP_LEVEL_KEYS, itself built once from
// projectConfigOverrideSchema.shape so it can't itself drift from the validator — see mcp/platform.ts)
// and asserts EVERY key appears, as a whole word, in the LIVE registered project_configure tool
// description — read via a real MCP client over the real PlatformMcpRouter, never a hand-copied string.
// A THIRD hand-typed copy (a duplicate expected-keys array in this file) would rot the exact same way
// the description itself already has, so this test deliberately has none.
//
// Run: 1) build (turbo builds shared first), 2) node test/project-configure-description-drift.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (so nothing touches the real ~/.loom or ~/.claude). Set
// BEFORE importing dist (paths.ts reads LOOM_HOME at import time). ---
const tmpHome = path.join(os.tmpdir(), `loom-pcd-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv(); // confirm LOOM_HOME is the temp dir (no port — this test runs no HTTP daemon)

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { PlatformMcpRouter, CONFIG_TOP_LEVEL_KEYS } = await import("../dist/mcp/platform.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// --- a real temp git repo so SessionService's constructor has something valid to reference; nothing
// here is actually spawned (project_configure's handler never touches sessions/pty). ---
const repo = path.join(os.tmpdir(), `loom-pcd-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# project-configure description drift test repo\n");
execSync("git init -q && git add . && git -c user.email=pcd@loom -c user.name=pcd commit -q -m init", { cwd: repo });

const db = new Db();
class SeamHost extends createSeamHost(PtyHost) {}
const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());
const router = new PlatformMcpRouter(db, svc);

try {
  const server = router.buildServer();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "project-configure-description-drift-test", version: "0" });
  await client.connect(clientT);

  const tools = (await client.listTools()).tools;
  const tool = tools.find((t) => t.name === "project_configure");
  check("project_configure is registered on the platform surface", !!tool);
  const description = tool?.description ?? "";

  check("sanity: CONFIG_TOP_LEVEL_KEYS is non-empty (a vacuous pass would hide a broken import)", CONFIG_TOP_LEVEL_KEYS.length > 0);

  const hasWholeWord = (key) => new RegExp(`\\b${key}\\b`).test(description);

  // POSITIVE CONTROL: a key long known to be correctly documented (kanbanColumns, present since before
  // this card) must be found by this exact matching logic — proves the whole-word regex itself works,
  // so a later "missing" verdict on codescape/memory can't be a broken matcher masquerading as drift.
  check("positive control: a key long known to be documented (kanbanColumns) is found by the match logic", hasWholeWord("kanbanColumns"));

  // NEGATIVE CONTROL: a key that is deliberately NOT part of the schema must NOT be found — proves the
  // match logic is specific to real key names, not just "the description is long so everything matches".
  check("negative control: a made-up key not in the schema is NOT found", !hasWholeWord("notARealConfigKey"));

  const missing = CONFIG_TOP_LEVEL_KEYS.filter((k) => !hasWholeWord(k));
  if (missing.length) console.log(`  missing from description: ${missing.join(", ")}`);
  check(
    `project_configure's description names every settable top-level key the schema accepts (${CONFIG_TOP_LEVEL_KEYS.join(", ")})`,
    missing.length === 0,
  );
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — project_configure's description names every CONFIG_TOP_LEVEL_KEYS entry; adding a key to projectConfigOverrideSchema without mentioning it in the description now fails this test."
  : `\n❌ ${failures} FAILURE(S) — project_configure's description text has drifted from projectConfigOverrideSchema's real key set. Update the description in mcp/platform.ts's project_configure registration.`);
process.exit(failures === 0 ? 0 : 1);
