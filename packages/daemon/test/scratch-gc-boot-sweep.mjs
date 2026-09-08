import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 9775559c — the BUILD half of card 2c8589c9's retention/GC design for the shared scratch root
// (`~/.loom/tmp/scratch/<sessionId>`, which nothing has ever deleted). Hermetic, deterministic, no live
// claude, no network: exercises `sessions/scratch-gc.ts`'s `sweepUnresumableScratchDirs` directly against
// a REAL Db (temp LOOM_HOME) + an injected `transcriptIds` set (standing in for a real
// `~/.claude/projects` scan) + an injected `removeDir` seam (mirrors runs/snapshot.ts's own
// RunSnapshotRemoveDeps convention) for the wedged/concurrency cases.
//
// Proves the card's full DoD list:
//   1. a live/starting dir is NEVER reaped, regardless of transcript state or age;
//   2. transcript-PRESENT but the (unread) `resumability` column says 'dead' is NOT reaped — the direct
//      regression guard for the measured stale-stamp incident (this sweep never even reads that column);
//   3. transcript-gone + past grace IS reaped;
//   4. transcript-gone but INSIDE the grace is NOT reaped;
//   5. a no-DB-row dir is NOT reaped;
//   6. a non-uuid-shaped entry and a root-level loose file are NEVER touched (not even scanned);
//   7. a wedged removal resolves (never hangs) and leaves the dir for the next boot sweep;
//   8. concurrency stays bounded under a large reap set (never one OS process per candidate);
//   9. card cb8b7eff — a resumable "codex" row is NOT reaped (predicate 5 must consult the harness-aware
//      per-session codexTranscriptExists seam, never the claude-only bulk transcriptIds set);
//  10. and the reverse polarity: a genuinely dead "codex" row past grace IS still reaped.
//
// Run: 1) build (turbo builds shared first), 2) node test/scratch-gc-boot-sweep.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
// MONOTONIC (see CLAUDE.md's CI timing-flake note) + slack, so a loaded runner can't flake a lower bound.
const TIMER_SLACK_MS = 80;

const tmpHome = path.join(os.tmpdir(), `loom-scgc-${Date.now()}-${process.pid}`);
fs.mkdirSync(tmpHome, { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { sweepUnresumableScratchDirs, SCRATCH_GC_CONCURRENCY } = await import("../dist/sessions/scratch-gc.js");
const { SCRATCH_ROOT_DIR } = await import("../dist/paths.js");

fs.mkdirSync(SCRATCH_ROOT_DIR, { recursive: true });

const db = new Db();
const now = new Date().toISOString();
db.insertProject({ id: "proj1", name: "P", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agent1", projectId: "proj1", name: "A", startupPrompt: "", position: 0 });

const DAY_MS = 24 * 60 * 60 * 1000;
const nowMs = Date.now();
const oldIso = new Date(nowMs - 8 * DAY_MS).toISOString(); // past the 7-day grace
const freshIso = new Date(nowMs - 1 * DAY_MS).toISOString(); // inside the 7-day grace

function mkScratchDir(id) {
  const dir = path.join(SCRATCH_ROOT_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "spill.json"), "{}");
  return dir;
}

function insertSessionRow({ id, engineSessionId, processState, resumability, lastActivity, harness }) {
  db.insertSession({
    id, projectId: "proj1", agentId: "agent1", engineSessionId: engineSessionId ?? null, title: null,
    cwd: tmpHome, processState, resumability: resumability ?? "unknown", busy: false,
    createdAt: lastActivity, lastActivity, lastError: null, role: "worker", parentSessionId: null,
    harness,
  });
}

// A `removeDir` seam that NEVER settles — proves a wedged removal is bounded, never looped (bd9fc808's
// shape). Also records calls so we can positive-control-verify the code under test really routes removal
// through the injected seam.
function neverSettlingRemoveDir() {
  const calls = [];
  const fn = (target, timeoutMs) => { calls.push({ target, timeoutMs }); return new Promise(() => {}); };
  fn.calls = calls;
  return fn;
}

// A `removeDir` seam that resolves after `delayMs`, tracking the CONCURRENT in-flight call count at every
// resolution instant — the instrument case 8 needs to prove concurrency is bounded, not merely that it
// finishes.
function trackingRemoveDir(delayMs) {
  let inFlight = 0;
  let maxInFlight = 0;
  const calls = [];
  const fn = async (target) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    calls.push(target);
    await new Promise((r) => setTimeout(r, delayMs));
    inFlight--;
    return { removed: true, killed: false };
  };
  fn.calls = calls;
  fn.maxInFlight = () => maxInFlight;
  return fn;
}

// ============================== 1. live/starting is NEVER reaped ==============================
{
  const liveId = randomUUID();
  const startingId = randomUUID();
  const engineLive = randomUUID();
  const engineStarting = randomUUID();
  mkScratchDir(liveId);
  mkScratchDir(startingId);
  insertSessionRow({ id: liveId, engineSessionId: engineLive, processState: "live", lastActivity: oldIso });
  insertSessionRow({ id: startingId, engineSessionId: engineStarting, processState: "starting", lastActivity: oldIso });

  // transcript ABSENT for both, and past grace — the only thing saving them must be processState.
  const result = await sweepUnresumableScratchDirs(db, { transcriptIds: new Set(), nowMs });
  check("1 a LIVE session's scratch dir is never reaped even with no transcript and past grace", fs.existsSync(path.join(SCRATCH_ROOT_DIR, liveId)));
  check("1 a STARTING session's scratch dir is never reaped even with no transcript and past grace", fs.existsSync(path.join(SCRATCH_ROOT_DIR, startingId)));
  check("1 neither dir is reported reaped", !result.reaped.includes(liveId) && !result.reaped.includes(startingId));
  fs.rmSync(path.join(SCRATCH_ROOT_DIR, liveId), { recursive: true, force: true });
  fs.rmSync(path.join(SCRATCH_ROOT_DIR, startingId), { recursive: true, force: true });
}

// ============================== 2. transcript-PRESENT but resumability:'dead' is NOT reaped ================
// The direct regression guard: this sweep must never trust the cached `resumability` column — it must
// re-verify via the live transcript-id set instead. `resumability:'dead'` here is deliberately WRONG.
{
  const id = randomUUID();
  const engineId = randomUUID();
  mkScratchDir(id);
  insertSessionRow({ id, engineSessionId: engineId, processState: "exited", resumability: "dead", lastActivity: oldIso });

  const result = await sweepUnresumableScratchDirs(db, { transcriptIds: new Set([engineId]), nowMs });
  check("2 transcript-PRESENT + resumability:'dead' (stale stamp) is NOT reaped — the sweep re-verifies live", fs.existsSync(path.join(SCRATCH_ROOT_DIR, id)));
  check("2 not reported reaped", !result.reaped.includes(id));
  fs.rmSync(path.join(SCRATCH_ROOT_DIR, id), { recursive: true, force: true });
}

// ============================== 3. transcript-gone + past grace IS reaped ==============================
{
  const id = randomUUID();
  const engineId = randomUUID();
  mkScratchDir(id);
  insertSessionRow({ id, engineSessionId: engineId, processState: "exited", resumability: "resumable", lastActivity: oldIso });

  const result = await sweepUnresumableScratchDirs(db, { transcriptIds: new Set(), nowMs });
  check("3 transcript-gone + past grace ⇒ actually removed from disk", !fs.existsSync(path.join(SCRATCH_ROOT_DIR, id)));
  check("3 reported as reaped", result.reaped.includes(id));
}

// ============================== 4. transcript-gone but INSIDE the grace is NOT reaped ==============================
{
  const id = randomUUID();
  const engineId = randomUUID();
  mkScratchDir(id);
  insertSessionRow({ id, engineSessionId: engineId, processState: "exited", resumability: "resumable", lastActivity: freshIso });

  const result = await sweepUnresumableScratchDirs(db, { transcriptIds: new Set(), nowMs });
  check("4 transcript-gone but inside grace ⇒ NOT removed", fs.existsSync(path.join(SCRATCH_ROOT_DIR, id)));
  check("4 not reported reaped", !result.reaped.includes(id));
  fs.rmSync(path.join(SCRATCH_ROOT_DIR, id), { recursive: true, force: true });
}

// ============================== 5. a no-DB-row dir is NOT reaped ==============================
{
  const id = randomUUID(); // v4-uuid-shaped, but NO sessions row exists for it (live daemon-test fixture shape)
  mkScratchDir(id);

  const result = await sweepUnresumableScratchDirs(db, { transcriptIds: new Set(), nowMs });
  check("5 a v4-uuid dir with no DB row is NOT reaped", fs.existsSync(path.join(SCRATCH_ROOT_DIR, id)));
  check("5 not reported reaped", !result.reaped.includes(id));
  fs.rmSync(path.join(SCRATCH_ROOT_DIR, id), { recursive: true, force: true });
}

// ============================== 6. non-uuid entries and loose root files are NEVER touched ==============================
{
  const nonUuidDir = path.join(SCRATCH_ROOT_DIR, "not-a-uuid-dir");
  fs.mkdirSync(nonUuidDir, { recursive: true });
  fs.writeFileSync(path.join(nonUuidDir, "f.txt"), "x");
  const looseFile = path.join(SCRATCH_ROOT_DIR, "loose-root-file.txt");
  fs.writeFileSync(looseFile, "y");

  const scannedBefore = (await sweepUnresumableScratchDirs(db, { transcriptIds: new Set(), nowMs })).scanned;
  check("6 a non-uuid-shaped dir is untouched", fs.existsSync(nonUuidDir));
  check("6 a loose root file is untouched", fs.existsSync(looseFile));
  check("6 neither is even counted as scanned (scope is by-construction, not an exclusion list)", scannedBefore === 0);
  fs.rmSync(nonUuidDir, { recursive: true, force: true });
  fs.rmSync(looseFile, { force: true });
}

// ============================== 7. a wedged removal resolves and leaves the dir for next boot ==============================
{
  const id = randomUUID();
  const engineId = randomUUID();
  mkScratchDir(id);
  insertSessionRow({ id, engineSessionId: engineId, processState: "exited", resumability: "resumable", lastActivity: oldIso });

  const removeDir = neverSettlingRemoveDir();
  const timeoutMs = 150;
  const t0 = performance.now();
  const result = await Promise.race([
    sweepUnresumableScratchDirs(db, { transcriptIds: new Set(), nowMs, removeDir, timeoutMs }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("watchdog: sweep did not settle")), timeoutMs * 10)),
  ]);
  const elapsed = performance.now() - t0;

  check("7 a wedged removal routes through the injected removeDir seam", removeDir.calls.length === 1);
  check("7 the sweep resolves (never hangs) against a never-settling removeDir", elapsed < timeoutMs * 10);
  check(`7 the outer bound fires ~at timeoutMs (${Math.round(elapsed)}ms >= ${timeoutMs}ms)`, elapsed >= timeoutMs - TIMER_SLACK_MS);
  check("7 the dir is left on disk (never removed) for the next boot sweep", fs.existsSync(path.join(SCRATCH_ROOT_DIR, id)));
  check("7 reported as wedged, not reaped", result.wedged.includes(id) && !result.reaped.includes(id));
  fs.rmSync(path.join(SCRATCH_ROOT_DIR, id), { recursive: true, force: true });
}

// ============================== 8. concurrency stays BOUNDED under a large reap set ==============================
{
  const n = SCRATCH_GC_CONCURRENCY * 3; // large enough that an unbounded Promise.all would visibly exceed the bound
  const ids = [];
  for (let i = 0; i < n; i++) {
    const id = randomUUID();
    const engineId = randomUUID();
    mkScratchDir(id);
    insertSessionRow({ id, engineSessionId: engineId, processState: "exited", resumability: "resumable", lastActivity: oldIso });
    ids.push(id);
  }

  const removeDir = trackingRemoveDir(60);
  const result = await sweepUnresumableScratchDirs(db, { transcriptIds: new Set(), nowMs, removeDir, timeoutMs: 5000 });

  check(`8 removeDir was invoked for every candidate (${removeDir.calls.length} of ${n})`, removeDir.calls.length === n);
  check(`8 concurrency never exceeded SCRATCH_GC_CONCURRENCY (max observed ${removeDir.maxInFlight()}, cap ${SCRATCH_GC_CONCURRENCY})`, removeDir.maxInFlight() <= SCRATCH_GC_CONCURRENCY);
  check("8 concurrency is genuinely PARALLELIZED, not serial (max observed > 1)", removeDir.maxInFlight() > 1);
  check("8 every candidate reported reaped (the injected removeDir always resolves {removed:true})", ids.every((id) => result.reaped.includes(id)));
}

// ============================== 9. a RESUMABLE codex session is NOT reaped (card cb8b7eff) ==============================
// `listAllTranscriptIds` (the claude-only bulk set) scans ONLY `~/.claude/projects` — a codex
// conversation id can NEVER appear in it, so before the fix, predicate 5 always fell through to reap a
// still-resumable codex session past the grace period. This is the RED case: it must fail on unfixed
// predicate-5 logic (bulk-Set-only) and pass once a "codex" row instead consults its own per-session
// `codexTranscriptExists` seam.
{
  const id = randomUUID();
  const engineId = randomUUID();
  mkScratchDir(id);
  insertSessionRow({ id, engineSessionId: engineId, processState: "exited", resumability: "resumable", lastActivity: oldIso, harness: "codex" });

  // The claude bulk set is EMPTY (this codex id would never be in it even in production), and the
  // injected codex check reports the rollout file still exists ⇒ genuinely resumable.
  const codexCalls = [];
  const codexTranscriptExists = (cwd, checkedId) => { codexCalls.push({ cwd, checkedId }); return checkedId === engineId; };
  const result = await sweepUnresumableScratchDirs(db, { transcriptIds: new Set(), nowMs, codexTranscriptExists });
  check("9 a resumable codex session's scratch dir is NOT reaped", fs.existsSync(path.join(SCRATCH_ROOT_DIR, id)));
  check("9 not reported reaped", !result.reaped.includes(id));
  check("9 the injected codex check was actually consulted, with the row's own cwd+engineSessionId", codexCalls.length === 1 && codexCalls[0].cwd === tmpHome && codexCalls[0].checkedId === engineId);
  fs.rmSync(path.join(SCRATCH_ROOT_DIR, id), { recursive: true, force: true });
}

// ============================== 10. a genuinely DEAD codex session IS still reaped (both polarities) ==============================
// The GC's real job must keep working for codex: a session whose rollout file is genuinely gone (never
// resumable) must still be collected past grace, not spared by construction just because it's codex.
{
  const id = randomUUID();
  const engineId = randomUUID();
  mkScratchDir(id);
  insertSessionRow({ id, engineSessionId: engineId, processState: "exited", resumability: "resumable", lastActivity: oldIso, harness: "codex" });

  const codexTranscriptExists = () => false; // rollout file gone
  const result = await sweepUnresumableScratchDirs(db, { transcriptIds: new Set(), nowMs, codexTranscriptExists });
  check("10 a genuinely dead codex session's scratch dir IS reaped", !fs.existsSync(path.join(SCRATCH_ROOT_DIR, id)));
  check("10 reported as reaped", result.reaped.includes(id));
}

db.close();
fs.rmSync(tmpHome, { recursive: true, force: true });

console.log(failures === 0
  ? "\n✅ ALL PASS — sweepUnresumableScratchDirs never reaps a live/starting session, never trusts the stale cached resumability column (re-verifies the live transcript-id set instead), reaps only transcript-gone dirs past the grace period, never touches a no-DB-row dir / non-uuid entry / loose root file, bounds a wedged removal instead of hanging, bounds concurrency under a large reap set, and — per harness — never reaps a resumable codex row while still reaping a genuinely dead one."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
