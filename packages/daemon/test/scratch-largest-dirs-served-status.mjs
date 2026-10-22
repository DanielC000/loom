import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 0e701396 — the top-N-largest-scratch-dirs visibility fix, approved by the lead off the card's own
// investigation phase (a ~4GB resumable session's scratch dir surviving every boot sweep, with no size or
// age bound and no way for a human to tell which dir it was without a manual `du -sm`). Hermetic, real Db
// + real on-disk scratch dirs under a temp LOOM_HOME, no live claude, no network — mirrors
// project-work-dir-served-status.mjs's own shape for the analogous `projectsWorkRootBytes` cache.
//
// Proves:
//   (1) before any refresh, the cache's initial value is surfaced honestly: an empty array, never
//       fabricated.
//   (2) after a real refresh (injected transcriptIds/codexTranscriptExists — no real
//       ~/.claude/projects or ~/.codex/sessions touched), buildServedStatus().scratchLargestDirs:
//         - a 19-day-idle, still-resumable (claude) dir appears with resumability "resumable" — the
//           direct regression proof for the card's own investigation finding: age past the 7-day grace
//           does NOT matter once resumable;
//         - a transcript-gone, past-grace dir appears with resumability "unresumable";
//         - a no-DB-row dir appears with "no-row", a live-processState dir with "live", a resumable
//           CODEX dir with "resumable" (via the harness-aware seam, never the claude-only set);
//         - ordering is strictly by bytes DESCENDING;
//         - the N=5 cap holds: 7 real on-disk candidates exist, only the 5 largest are reported, the two
//           smallest are genuinely excluded (not merely truncated-and-still-counted somewhere).
//   (3) the "no-sync-walk-on-read" proof: a fabricated cache value that CONTRADICTS real on-disk state
//       (entries naming dirs that do not exist, while the real scratch root holds different dirs) comes
//       back from buildServedStatus() byte-for-byte unchanged — if the read path performed its own walk,
//       it would instead return the REAL (different) on-disk state, not the fabricated one.
//   (4) kickScratchLargestDirsRefresh's throttle floor itself: a fresh cached computedAt blocks the real
//       walk from starting at all (proven via a spy on measureScratchRootDirSizes's own tell —
//       db.getSession call count, since the real walk's classification step is the first thing that
//       touches the db); a stale computedAt does not block it.
//
// Run: 1) build (turbo builds shared first), 2) node test/scratch-largest-dirs-served-status.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-sld-status-${Date.now()}-${process.pid}`);
fs.mkdirSync(tmpHome, { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SCRATCH_ROOT_DIR } = await import("../dist/paths.js");
const { buildServedStatus } = await import("../dist/served-status.js");
const {
  refreshScratchLargestDirs,
  kickScratchLargestDirsRefresh,
  getCachedScratchLargestDirs,
  __resetScratchLargestDirsCacheForTest,
  __setScratchLargestDirsCacheForTest,
  SCRATCH_LARGEST_DIRS_N,
} = await import("../dist/sessions/scratch-largest-dirs.js");

fs.mkdirSync(SCRATCH_ROOT_DIR, { recursive: true });

const db = new Db();
const now = new Date().toISOString();
db.insertProject({ id: "proj1", name: "P", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agent1", projectId: "proj1", name: "A", startupPrompt: "", position: 0 });

const DAY_MS = 24 * 60 * 60 * 1000;
const nowMs = Date.now();
const nineteenDaysAgo = new Date(nowMs - 19 * DAY_MS).toISOString(); // mirrors the card's own 762116c2 profile
const oldIso = new Date(nowMs - 10 * DAY_MS).toISOString(); // past the 7-day grace

function mkScratchDir(id, bytes) {
  const dir = path.join(SCRATCH_ROOT_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "payload.bin"), Buffer.alloc(bytes, 1));
  return dir;
}

function insertSessionRow({ id, engineSessionId, processState, lastActivity, harness }) {
  db.insertSession({
    id, projectId: "proj1", agentId: "agent1", engineSessionId: engineSessionId ?? null, title: null,
    cwd: tmpHome, processState, resumability: "unknown", busy: false,
    createdAt: lastActivity, lastActivity, lastError: null, role: "worker", parentSessionId: null,
    harness: harness ?? null,
  });
}

try {
  // ===================== (1) before any refresh — honest initial value =====================
  __resetScratchLargestDirsCacheForTest();
  const beforeStatus = buildServedStatus(db);
  check("(1) before any refresh: scratchLargestDirs is an empty array, never fabricated", Array.isArray(beforeStatus.scratchLargestDirs) && beforeStatus.scratchLargestDirs.length === 0);
  // `buildServedStatus` ALSO fire-and-forgets its OWN background `kickScratchLargestDirsRefresh` on this
  // same call (never awaited) — with an empty scratch root at this instant, that refresh's synchronous
  // body (no `await` inside it before `cached = result`) runs to completion against ZERO dirs, but the
  // OUTER async function hasn't resolved its own `await run` yet, so `refreshInFlight` stays set until a
  // microtask tick happens. Yield once here (same fix project-work-dir-served-status.mjs's own section
  // (1)/(2) seam uses, for the identical reason) so that in-flight dedupe clears BEFORE section (2) below
  // calls refreshScratchLargestDirs explicitly — otherwise that call's dedupe just returns THIS stale,
  // zero-entries promise instead of starting a fresh walk against the dirs section (2) is about to create.
  await new Promise((r) => setTimeout(r, 10));

  // ===================== (2) real refresh: labels, ordering, N cap =====================
  const resumableClaudeId = randomUUID();       // 7000 bytes, 19d idle, resumable (claude)
  const unresumableId = randomUUID();           // 6000 bytes, 10d idle (past grace), transcript gone
  const noRowId = randomUUID();                 // 5000 bytes, no DB row at all
  const liveId = randomUUID();                  // 4000 bytes, processState live
  const resumableCodexId = randomUUID();        // 3000 bytes, resumable (codex, via harness-aware seam)
  const excludedA = randomUUID();               // 2000 bytes — must be excluded by the N=5 cap
  const excludedB = randomUUID();               // 1000 bytes — must be excluded by the N=5 cap

  mkScratchDir(resumableClaudeId, 7000);
  mkScratchDir(unresumableId, 6000);
  mkScratchDir(noRowId, 5000);
  mkScratchDir(liveId, 4000);
  mkScratchDir(resumableCodexId, 3000);
  mkScratchDir(excludedA, 2000);
  mkScratchDir(excludedB, 1000);

  const engineResumable = randomUUID();
  const engineUnresumable = randomUUID();
  const engineLive = randomUUID();
  const engineCodex = randomUUID();
  const engineExcludedA = randomUUID();
  const engineExcludedB = randomUUID();

  insertSessionRow({ id: resumableClaudeId, engineSessionId: engineResumable, processState: "exited", lastActivity: nineteenDaysAgo });
  insertSessionRow({ id: unresumableId, engineSessionId: engineUnresumable, processState: "exited", lastActivity: oldIso });
  // noRowId: deliberately NO insertSessionRow call.
  insertSessionRow({ id: liveId, engineSessionId: engineLive, processState: "live", lastActivity: now });
  insertSessionRow({ id: resumableCodexId, engineSessionId: engineCodex, processState: "exited", lastActivity: oldIso, harness: "codex" });
  insertSessionRow({ id: excludedA, engineSessionId: engineExcludedA, processState: "exited", lastActivity: oldIso });
  insertSessionRow({ id: excludedB, engineSessionId: engineExcludedB, processState: "exited", lastActivity: oldIso });

  check("(2) SCRATCH_LARGEST_DIRS_N is 5 (the manager's own decision on card 0e701396)", SCRATCH_LARGEST_DIRS_N === 5);

  const transcriptIds = new Set([engineResumable]); // engineUnresumable/excludedA/excludedB deliberately absent
  const codexTranscriptExists = (_cwd, id) => id === engineCodex;

  const refreshed = await refreshScratchLargestDirs(db, SCRATCH_LARGEST_DIRS_N, { transcriptIds, codexTranscriptExists });
  check("(2) exactly N=5 entries reported, not 7", refreshed.entries.length === 5);

  const byId = Object.fromEntries(refreshed.entries.map((e) => [e.id, e]));
  check("(2) the two smallest dirs are genuinely EXCLUDED by the N cap (not present at all)", !(excludedA in byId) && !(excludedB in byId));
  check("(2) resumable claude dir: bytes correct", byId[resumableClaudeId]?.bytes === 7000);
  check("(2) resumable claude dir: resumability is 'resumable' DESPITE 19 days idle (past the 7-day grace) — the card's own finding", byId[resumableClaudeId]?.resumability === "resumable");
  check("(2) resumable claude dir: ageDays reflects the real 19-day-old lastActivity", byId[resumableClaudeId]?.ageDays === 19);
  check("(2) unresumable dir: resumability is 'unresumable'", byId[unresumableId]?.resumability === "unresumable");
  check("(2) no-DB-row dir: resumability is 'no-row'", byId[noRowId]?.resumability === "no-row");
  check("(2) no-DB-row dir: ageDays is 0 (no row to derive it from — honest, not fabricated)", byId[noRowId]?.ageDays === 0);
  check("(2) live-processState dir: resumability is 'live'", byId[liveId]?.resumability === "live");
  check("(2) resumable CODEX dir: resumability is 'resumable' via the harness-aware seam, never the claude-only transcriptIds set", byId[resumableCodexId]?.resumability === "resumable");

  check("(2) ordering is strictly DESCENDING by bytes",
    refreshed.entries.every((e, i) => i === 0 || refreshed.entries[i - 1].bytes >= e.bytes));
  check("(2) buildServedStatus surfaces the SAME refreshed figure (no separate walk on the read path)",
    JSON.stringify(buildServedStatus(db).scratchLargestDirs) === JSON.stringify(refreshed.entries));
  check("(2) the cache now carries a real computedAt timestamp", typeof refreshed.computedAt === "string");

  // ===================== (3) no-sync-walk-on-read proof =====================
  // Inject a cache that CONTRADICTS real on-disk state (fabricated ids that exist nowhere on disk, real
  // bytes figures that don't match anything). If buildServedStatus's read path ever performed its own
  // walk instead of reading the cache, it would come back with the REAL 5 entries from (2) above, not
  // these fabricated ones.
  const fabricated = {
    entries: [
      { id: "not-a-real-dir-aaaaaaaa-0000-4000-8000-000000000000", bytes: 999_999_999, ageDays: 999, resumability: "resumable" },
    ],
    computedAt: new Date().toISOString(),
  };
  __setScratchLargestDirsCacheForTest(fabricated);
  const statusAfterFabrication = buildServedStatus(db);
  check("(3) NO-SYNC-WALK-ON-READ: buildServedStatus returns the FABRICATED entry unchanged, not a real walk's result",
    JSON.stringify(statusAfterFabrication.scratchLargestDirs) === JSON.stringify(fabricated.entries));
  check("(3) ...specifically, it does NOT contain any of the 5 REAL on-disk ids from (2) — proving it did not re-walk",
    !statusAfterFabrication.scratchLargestDirs.some((e) => e.id in byId));

  // ===================== (4) kickScratchLargestDirsRefresh's throttle floor =====================
  let getSessionCalls = 0;
  const realGetSession = db.getSession.bind(db);
  db.getSession = (...args) => { getSessionCalls++; return realGetSession(...args); };
  try {
    // (4a) FRESH computedAt — the floor must block the kick entirely; the real walk's classification
    // step (which calls db.getSession) never starts.
    __setScratchLargestDirsCacheForTest({ entries: [{ id: "sentinel", bytes: 1, ageDays: 0, resumability: "no-row" }], computedAt: new Date().toISOString() });
    getSessionCalls = 0;
    kickScratchLargestDirsRefresh(db);
    check("(4a) FLOOR BLOCKS the kick while computedAt is fresh — db.getSession was never called", getSessionCalls === 0);
    check("(4a) ...and the cache is therefore still the untouched sentinel", getCachedScratchLargestDirs()[0]?.id === "sentinel");

    // (4b) STALE computedAt (6 minutes old, past the 5-minute floor) — the floor must NOT block.
    const staleComputedAt = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    __setScratchLargestDirsCacheForTest({ entries: [{ id: "sentinel2", bytes: 1, ageDays: 0, resumability: "no-row" }], computedAt: staleComputedAt });
    getSessionCalls = 0;
    kickScratchLargestDirsRefresh(db);
    check("(4b) FLOOR DOES NOT BLOCK the kick once computedAt is stale — db.getSession WAS called", getSessionCalls > 0);
    await waitUntil(() => getCachedScratchLargestDirs()[0]?.id !== "sentinel2",
      { label: "the stale-triggered real walk to replace the sentinel" });
    check("(4b) ...and the sentinel was genuinely replaced by a real re-walk (the real 5 entries from (2) are back)",
      getCachedScratchLargestDirs().length === 5);
  } finally {
    db.getSession = realGetSession;
  }

  // Restore a realistic cache before this file exits, so a reader who extends it later doesn't inherit
  // a deliberately fabricated/injected cache.
  await refreshScratchLargestDirs(db, SCRATCH_LARGEST_DIRS_N, { transcriptIds, codexTranscriptExists });
} finally {
  db.close();
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — served_status's scratchLargestDirs reports the N=5 largest scratch dirs (strictly ordered by bytes descending, the rest genuinely excluded), each labeled via the SAME classifyScratchDirResumability predicates the real GC sweep uses (resumable/unresumable/no-row/live, including a resumable session surviving well past the 7-day grace — the card's own finding), is read on served_status's hot path as a pure in-memory cache (proven: a fabricated, disk-contradicting value survives a read unchanged), and is refreshed in the background on a throttle (proven both ways: fresh computedAt blocks the walk, stale computedAt does not)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
