// Card f9b47cd1's ASYNC, non-blocking claude-version cache (usage-status.ts) — the thing that lets the
// session-naming version gate (pty/session-name.ts's meetsMinVersion) read an already-known version from
// createPty's hot path WITHOUT ever risking a synchronous execSync stall there (the load-bearing "no
// blocking work on the spawn hot path" invariant — see prewarmClaudeVersionAsync's doc). HERMETIC:
// LOOM_CLAUDE_BIN is redirected at this test's OWN node binary (a real, always-present executable) so the
// real `execFile` path is exercised without depending on a real `claude` install. Order matters below —
// the FAILURE case must run FIRST, while the module-level cache is still cold.
//
// Run (after a build): node test/claude-version-prewarm.mjs
import "./_guard.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (!process.env.LOOM_HOME) process.env.LOOM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "loom-cvp-"));
const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { getCachedClaudeVersion, prewarmClaudeVersionAsync } = await import("../dist/orchestration/usage-status.js");
const { meetsMinVersion } = await import("../dist/pty/session-name.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

async function waitUntil(fn, timeoutMs = 4000, stepMs = 25) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

// --- Cold start: nothing has warmed the cache yet -------------------------------------------------
check("cold cache: getCachedClaudeVersion() is null before anything runs", getCachedClaudeVersion() === null);
check("cold cache: the version gate fails closed on a null cache (no -n)", meetsMinVersion(getCachedClaudeVersion()) === false);

// --- Failure path: LOOM_CLAUDE_BIN points at nothing → execFile errors → cache stays null (never throws) ---
{
  process.env.LOOM_CLAUDE_BIN = path.join(os.tmpdir(), `loom-cvp-nonexistent-${process.pid}.exe`);
  let threw = false;
  try { prewarmClaudeVersionAsync(); } catch { threw = true; }
  check("prewarm never throws SYNCHRONOUSLY even for a bogus binary (fire-and-forget)", threw === false);
  // Give the async execFile callback a beat to fire (it should error and no-op — never populate the cache).
  await new Promise((r) => setTimeout(r, 500));
  check("a nonexistent LOOM_CLAUDE_BIN leaves the cache null (graceful degrade, not a hang/throw)", getCachedClaudeVersion() === null);
  check("the gate still fails closed after a failed prewarm", meetsMinVersion(getCachedClaudeVersion()) === false);
}

// --- Success path: LOOM_CLAUDE_BIN → this test's own node binary (always present, always executable) ---
{
  process.env.LOOM_CLAUDE_BIN = process.execPath;
  const expected = process.version.replace(/^v/, "").match(/(\d+\.\d+\.\d+)/)?.[1];
  const before = Date.now();
  prewarmClaudeVersionAsync(); // fire-and-forget — real `execFile(node, ["--version"])` under the hood
  const warmed = await waitUntil(() => getCachedClaudeVersion() !== null);
  const elapsedMs = Date.now() - before;
  check("prewarm populates the cache asynchronously (within a few seconds)", warmed);
  check("the cached value is the real, regex-extracted X.Y.Z from `--version` output", getCachedClaudeVersion() === expected);
  check("prewarm resolved well under the 8s execFile timeout (a real probe, not a stall)", elapsedMs < 4000);
}

// --- Idempotent: a second call once warm is a synchronous no-op (never re-probes) -----------------
{
  const warmValue = getCachedClaudeVersion();
  prewarmClaudeVersionAsync(); // should short-circuit on the `if (cachedClaudeVersion) return;` guard
  check("a second prewarm call once warm leaves the cache unchanged (idempotent)", getCachedClaudeVersion() === warmValue);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the claude-version cache stays null (never hangs/throws) on a failed probe, warms asynchronously via a REAL execFile call on success, and a second prewarm once warm is a no-op."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
