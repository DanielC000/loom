import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card f26339d7, AMENDMENT 1 — proves the ACTUAL production mechanism `served-status.ts` uses: its
// `processBuiltSha` is captured EXACTLY ONCE, at module load, from THIS checkout's real
// `packages/daemon/dist/build-info.json` — and stays FROZEN even when that file changes on disk
// afterward, unlike `deployStaleness.distBuiltSha`, which is a fresh read on every call.
//
// WHY THIS TEST EXISTS SEPARATELY FROM deploy-staleness.mjs: that file proves `computeDeployStaleness`
// itself is PURE (given the same `processBuiltShaOverride`, always the same answer) — it never touches
// this "read once at module load" mechanism at all, by design (see deploy-staleness.ts's own module doc:
// this function does its own caching of nothing, the caller does). The "captured once, frozen despite a
// later on-disk change" property lives ENTIRELY in served-status.ts's top-level assignment, which a
// fixture-driven test of computeDeployStaleness structurally cannot exercise — there is no fixture stand-
// in for "this module was already imported". So this test mutates the REAL, ALREADY-BUILT
// packages/daemon/dist/build-info.json (restored in a `finally`) rather than a throwaway fixture — a
// fixture dist dir would only prove the SAME thing computeDeployStaleness's own tests already prove
// (a fresh read reflects new content), not the thing that's actually in question here (a value captured
// BEFORE that content changed staying unchanged).
//
// Proves:
//   (A) POSITIVE CONTROL — the captured value is a real, resolvable sha, not vacuously null (this
//       checkout has a real build; a null result here would mean the test corpus itself can't demonstrate
//       the property, not that the mechanism works).
//   (B) THE PROPERTY — after rewriting the real build-info.json on disk to a different sha, a SECOND call
//       into the SAME already-imported module still returns the ORIGINAL captured value for
//       `processBuiltSha`, while `distBuiltSha` (the fresh-read companion in the SAME payload) DOES
//       reflect the new on-disk content — proving the two are genuinely decoupled, not both frozen or
//       both fresh by accident.
//   (C) `distBuiltShaDiffersFromProcess:true` once they've diverged — the definitive, content-based
//       "this process needs a restart" signal this amendment introduces.
//   (D) restore: the real dist file is back to its original bytes when this test exits, whatever the
//       outcome (a `finally`, not a happy-path-only cleanup).
//
// Run: pnpm build (needs a real packages/daemon/dist/build-info.json), then
//   node packages/daemon/test/served-status-process-sha.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

const TMP = mkdtempManaged("loom-served-status-sha-");
process.env.LOOM_HOME = TMP; // skillStoreStaleness (part of buildServedStatus's payload) reads LOOM_HOME
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX
requireHermeticEnv();

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const daemonDistDir = path.join(__dirname, "..", "dist");
const buildInfoPath = path.join(daemonDistDir, "build-info.json");

const originalBuildInfoExists = fs.existsSync(buildInfoPath);
const originalBuildInfoBytes = originalBuildInfoExists ? fs.readFileSync(buildInfoPath) : null;
check("(setup) this checkout's real packages/daemon/dist/build-info.json exists (run `pnpm build` first if this fails)", originalBuildInfoExists);

const stubDb = { listAllSessions: () => [] };

try {
  // Import AFTER confirming the real file is there — this is the moment `processBuiltSha`'s module-level
  // top-level assignment evaluates, exactly once, for the rest of this process's life.
  const { buildServedStatus } = await import("../dist/served-status.js");

  const before = buildServedStatus(stubDb);
  const capturedProcessSha = before.deployStaleness.processBuiltSha;

  // ===================== (A) POSITIVE CONTROL — not vacuously null =====================
  const realInfoOnDiskAtImport = JSON.parse(originalBuildInfoBytes.toString("utf8"));
  const realShaOnDiskAtImport = realInfoOnDiskAtImport.sha;
  const capturedProcessDirty = before.deployStaleness.processBuiltDirty;
  check("(A) processBuiltSha captured a real sha, not null (this checkout's own real build)", typeof capturedProcessSha === "string" && capturedProcessSha.length > 0);
  check("(A) the captured value matches what was ACTUALLY on disk at import time (proves it read the real file, not a stub)", capturedProcessSha === realShaOnDiskAtImport);
  check("(A) processBuiltDirty ALSO matches what was actually on disk at import time", capturedProcessDirty === (realInfoOnDiskAtImport.dirty ?? null));
  check("(A) distBuiltSha (the fresh-read companion) ALSO matches, before anything has changed", before.deployStaleness.distBuiltSha === realShaOnDiskAtImport);
  check("(A) sanity: they agree before any mutation, so (B) below is a genuine divergence, not a pre-existing one", before.deployStaleness.distBuiltShaDiffersFromProcess === false);

  // ===================== (B)/(C) THE PROPERTY — rewrite the REAL file, call again =====================
  const fakeSha = "0123456789abcdef0123456789abcdef01234567"; // distinguishable, not a real object in this repo
  const fakeDirty = capturedProcessDirty === true ? false : true; // deliberately the OPPOSITE of the captured value, so a leak would be unmistakable
  fs.writeFileSync(buildInfoPath, JSON.stringify({ sha: fakeSha, dirty: fakeDirty }));

  const after = buildServedStatus(stubDb);
  check("(B) THE PROPERTY: processBuiltSha is UNCHANGED after the real dist file was rewritten on disk — a restart cannot change it, only a build (a fresh process) can",
    after.deployStaleness.processBuiltSha === capturedProcessSha);
  check("(B) processBuiltDirty is ALSO UNCHANGED — captured together with the sha, at the same module load, frozen the same way",
    after.deployStaleness.processBuiltDirty === capturedProcessDirty);
  check("(B) distBuiltSha DOES reflect the new on-disk content — it is a fresh read, unlike processBuiltSha",
    after.deployStaleness.distBuiltSha === fakeSha);
  check("(B) distBuiltDirty DOES reflect the new on-disk content too",
    after.deployStaleness.distBuiltDirty === fakeDirty);
  check("(C) distBuiltShaDiffersFromProcess:true once they've genuinely diverged — the definitive content-based restart signal",
    after.deployStaleness.distBuiltShaDiffersFromProcess === true);
} finally {
  // ===================== (D) restore the real dist file, whatever happened above =====================
  if (originalBuildInfoExists) {
    fs.writeFileSync(buildInfoPath, originalBuildInfoBytes);
  } else {
    try { fs.rmSync(buildInfoPath, { force: true }); } catch { /* best-effort */ }
  }
  const restoredBytes = fs.existsSync(buildInfoPath) ? fs.readFileSync(buildInfoPath) : null;
  check("(D) the real dist/build-info.json was restored to its exact original bytes",
    originalBuildInfoExists ? (restoredBytes !== null && restoredBytes.equals(originalBuildInfoBytes)) : restoredBytes === null);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — served-status.ts's processBuiltSha is captured exactly once at module load from the real dist/build-info.json, stays frozen after that file changes on disk (proven against the REAL production module, not a fixture stand-in), while distBuiltSha in the SAME payload correctly reads fresh — and distBuiltShaDiffersFromProcess flags the divergence, the definitive content-based restart signal. The real dist file was restored to its original bytes."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
