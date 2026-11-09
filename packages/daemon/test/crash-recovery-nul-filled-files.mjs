import { commitAll } from "./_git-commit.mjs";
import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
import { useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
// Card 5643ce01 — crash recovery flags NUL-filled uncommitted worktree files (NTFS delayed-write loss).
// NO claude, NO daemon boot. Drives scanWorktreeForNulFilledFiles (real git, real fixture worktree) and
// SessionService.recoverCrashOrphanedWorkers (PtyStub, resumeOne stub) directly.
//   (A) detection: a NUL-filled MODIFIED file and a NUL-filled UNTRACKED file are named; a normally
//       modified file, an untouched file, a deleted file and an empty file are not.
//   (B) caps: file cap, size cap, sample cap (a head/tail-only sample can't see a zeroed middle), and the
//       named-paths cap (count stays exact).
//   (C) failure: a git failure / a non-repo / no path => undefined (check could not run), never a throw.
//   (D) notices: worker kickoff nudge AND manager summary name exactly the NUL file; a clean/undefined scan
//       leaves both texts byte-identical to a run with no scan at all; a clean-stop boot adds nothing.
// Run: 1) build daemon, 2) node test/crash-recovery-nul-filled-files.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

useOwnLoomHome("nulscan-");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { deriveCrashOrphanedWorkers } = await import("../dist/orchestration/crash-orphaned-workers.js");
const wt = await import("../dist/git/worktrees.js");
const { scanWorktreeForNulFilledFiles, nulFilledNoticeLine, looksNulFilled, NUL_SCAN_MAX_PATHS_NAMED } = wt;
const { startNulFilledScan, recoverCrashOrphanedWorkersWithNulScan } = await import("../dist/orchestration/nul-scan-boot.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=nul@loom -c user.name=nul";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

const mkRepo = (label, files) => {
  const repo = mkdtempManaged(`nul-${label}-`);
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    fs.writeFileSync(path.join(repo, name), content);
  }
  execSync("git init -q", { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
};
const zeros = (n) => Buffer.alloc(n, 0);
const write = (repo, name, buf) => fs.writeFileSync(path.join(repo, name), buf);

// ============================ (0) the pure predicate ============================
check("(0) all-zero sample looks NUL-filled", looksNulFilled(zeros(64)));
check("(0) 95% zeros does NOT (needs 100%: a sparse SQLite/WAL/.wasm fixture is not delayed-write loss)", !looksNulFilled(Buffer.concat([zeros(95), Buffer.from("abcde")])));
check("(0) ONE non-zero byte in a zero sample does NOT", !looksNulFilled(Buffer.concat([zeros(4095), Buffer.from("a")])));
check("(0) 50% zeros does NOT", !looksNulFilled(Buffer.concat([zeros(50), Buffer.alloc(50, 0x61)])));
check("(0) ordinary text does NOT", !looksNulFilled(Buffer.from("# hello\n")));
check("(0) empty sample does NOT", !looksNulFilled(Buffer.alloc(0)));

// ============================ (A) detection ============================
const repoA = mkRepo("a", {
  "doc-a.md": "# readme\nline\n", "recherche.md": "# notes\nbody\n", "clean.md": "untouched\n",
  "normal.md": "before\n", "gone.md": "to delete\n", "empty-me.md": "was full\n", "mostly.md": "x\n",
});
write(repoA, "doc-a.md", zeros(8192));                       // modified, tracked, entirely NUL (the incident shape)
write(repoA, "normal.md", "after, a real edit\n");            // modified, tracked, ordinary
write(repoA, "untracked-nul.bin", zeros(5000));               // untracked, entirely NUL
write(repoA, "untracked-ok.md", "# fine\n");                  // untracked, ordinary
fs.mkdirSync(path.join(repoA, "sub", "deep"), { recursive: true });
write(repoA, "sub/deep/nested-nul.md", zeros(300));           // untracked inside a new directory (needs -uall)
fs.rmSync(path.join(repoA, "gone.md"));                       // deleted: nothing on disk to inspect
write(repoA, "empty-me.md", Buffer.alloc(0));                 // zero-length is not NUL damage
write(repoA, "mostly.md", Buffer.concat([zeros(950), Buffer.from("a".repeat(50))])); // 95% zeros
const scanA = await scanWorktreeForNulFilledFiles(repoA);
check("(A) scan ran (not undefined)", scanA !== undefined);
const namedA = new Set(scanA?.paths ?? []);
const namedUntrackedA = new Set(scanA?.untrackedPaths ?? []);
check("(A) flags EXACTLY the three fully-NUL files (count 3: 1 tracked + 2 untracked)", scanA?.count === 3 && scanA?.trackedCount === 1 && scanA?.untrackedCount === 2);
check("(A) names the tracked NUL-filled doc-a.md under TRACKED", namedA.has("doc-a.md") && !namedUntrackedA.has("doc-a.md"));
check("(A) names the untracked NUL-filled file under UNTRACKED", namedUntrackedA.has("untracked-nul.bin") && !namedA.has("untracked-nul.bin"));
check("(A) names an untracked NUL file inside a NEW directory (-uall)", namedUntrackedA.has("sub/deep/nested-nul.md"));
check("(A) does NOT flag the 95%-zero file (100% rule)", !namedA.has("mostly.md") && !namedUntrackedA.has("mostly.md"));
check("(A) does NOT name the normally-edited file", !namedA.has("normal.md"));
check("(A) does NOT name the untouched file", !namedA.has("clean.md"));
check("(A) does NOT name the ordinary untracked file", !namedA.has("untracked-ok.md"));
check("(A) does NOT name the deleted file", !namedA.has("gone.md"));
check("(A) does NOT name the empty file", !namedA.has("empty-me.md"));
check("(A) read-only: the NUL file is left exactly as found (never auto-restored)", fs.statSync(path.join(repoA, "doc-a.md")).size === 8192 && fs.readFileSync(path.join(repoA, "doc-a.md")).every((b) => b === 0));
const lineA = nulFilledNoticeLine(scanA);
check("(A) tracked wording: 'modified', the path, and 'restore from HEAD and re-apply'",
  lineA.startsWith("1 modified file looks NUL-filled after the crash: doc-a.md; restore from HEAD and re-apply"));
check("(A) untracked wording: never 'modified', says there is no HEAD copy and to recreate them",
  lineA.includes("2 untracked files look NUL-filled after the crash (untracked: no HEAD copy, recreate them): ") && lineA.includes("untracked-nul.bin") && !/2 modified/.test(lineA));
const emptyScan = { count: 0, trackedCount: 0, untrackedCount: 0, paths: [], untrackedPaths: [], examined: 3, skippedOversize: 0, fileCapHit: false };
check("(A) notice line is '' for a clean scan / undefined (byte-identical text)", nulFilledNoticeLine(undefined) === "" && nulFilledNoticeLine(emptyScan) === "");
check("(A) tracked-only singular form reads naturally, with no untracked clause", (() => { const l = nulFilledNoticeLine({ ...emptyScan, count: 1, trackedCount: 1, paths: ["a.md"] }); return l.startsWith("1 modified file looks NUL-filled") && !l.includes("untracked"); })());

// A fully clean worktree (only ordinary edits) => count 0.
const repoClean = mkRepo("clean", { "a.md": "a\n", "b.md": "b\n" });
write(repoClean, "a.md", "edited\n");
const scanClean = await scanWorktreeForNulFilledFiles(repoClean);
check("(A) clean worktree: scan ran and flagged nothing", scanClean !== undefined && scanClean.count === 0 && scanClean.examined === 1);

// ============================ (B) caps ============================
// file cap
const repoB = mkRepo("b", { "f1.md": "1\n", "f2.md": "2\n", "f3.md": "3\n" });
write(repoB, "f1.md", zeros(100)); write(repoB, "f2.md", zeros(100)); write(repoB, "f3.md", zeros(100));
const capFiles = await scanWorktreeForNulFilledFiles(repoB, { maxFiles: 2 });
check("(B) file cap: examines at most maxFiles and says the cap was hit", capFiles?.examined === 2 && capFiles?.count === 2 && capFiles?.fileCapHit === true);
const uncapped = await scanWorktreeForNulFilledFiles(repoB);
check("(B) file cap control: same worktree uncapped flags all 3 and cap not hit", uncapped?.count === 3 && uncapped?.fileCapHit === false);
// size cap
const capSize = await scanWorktreeForNulFilledFiles(repoB, { maxFileBytes: 50 });
check("(B) size cap: files over the cap are skipped UNREAD and counted, not flagged", capSize?.count === 0 && capSize?.skippedOversize === 3 && capSize?.examined === 0);
// sample cap: a 100 kB file that is all zeros except ONE non-zero byte in the middle. A 16-byte head+tail
// sample provably never reads that byte (so it is flagged — the documented trade-off of a bounded read); a
// wide sample does read it (so it is not). pure.bin (all zeros) is flagged by both.
const repoS = mkRepo("s", { "mid.bin": "x\n", "pure.bin": "y\n" });
write(repoS, "mid.bin", Buffer.concat([zeros(50000), Buffer.from([0x61]), zeros(49999)]));
write(repoS, "pure.bin", zeros(100000));
const capSample = await scanWorktreeForNulFilledFiles(repoS, { sampleBytes: 16 });
check("(B) sample cap: a 16-byte head+tail sample never reads the middle byte (bounded read) => both flagged", capSample?.count === 2 && capSample?.examined === 2);
const wide = await scanWorktreeForNulFilledFiles(repoS, { sampleBytes: 60000 });
check("(B) sample cap control: a wide sample reads the middle byte => only the pure-zero file is flagged", wide?.count === 1 && wide.paths[0] === "pure.bin");
// named-paths cap
const manyFiles = {}; for (let i = 0; i < 8; i++) manyFiles[`n${i}.md`] = "x\n";
const repoM = mkRepo("m", manyFiles);
for (let i = 0; i < 8; i++) write(repoM, `n${i}.md`, zeros(64));
const scanM = await scanWorktreeForNulFilledFiles(repoM);
check("(B) named-paths cap: count stays exact (8) while only NUL_SCAN_MAX_PATHS_NAMED paths are named", scanM?.count === 8 && scanM.paths.length === NUL_SCAN_MAX_PATHS_NAMED);
check("(B) named-paths cap: the line says how many more", nulFilledNoticeLine(scanM).includes(`(+${8 - NUL_SCAN_MAX_PATHS_NAMED} more)`));

// ============================ (C) failure never throws ============================
const failingGit = () => ({ raw: () => Promise.reject(new Error("fatal: simulated git failure")) });
check("(C) a git failure => undefined (check could not run), no throw", (await scanWorktreeForNulFilledFiles(repoA, { gitFactory: failingGit })) === undefined);
const hangingGit = () => ({ raw: () => new Promise(() => {}) });
const t0 = performance.now();
const hung = await scanWorktreeForNulFilledFiles(repoA, { gitFactory: hangingGit, timeoutMs: 150 });
check("(C) a HUNG git is bounded by the timeout => undefined, within a few seconds", hung === undefined && performance.now() - t0 < 5000);
check("(C) no worktree path => undefined", (await scanWorktreeForNulFilledFiles(null)) === undefined && (await scanWorktreeForNulFilledFiles(undefined)) === undefined);
const notRepo = mkdtempManaged("nul-notrepo-");
check("(C) a non-repo directory => undefined", (await scanWorktreeForNulFilledFiles(notRepo)) === undefined);

// ============================ (D) the recovery notices ============================
class PtyStub {
  constructor() { this.q = new Map(); this.aliveIds = new Set(); }
  isAlive(id) { return this.aliveIds.has(id); }
  spawn(o) { this.aliveIds.add(o.sessionId); }
  enqueueStdin(id, text) { const a = this.q.get(id) ?? []; a.push(text); this.q.set(id, a); return { delivered: false, position: a.length }; }
  getPending(id) { return [...(this.q.get(id) ?? [])]; }
  waitForMcpSeen() { return Promise.resolve(true); }
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const db = new Db();
const pty = new PtyStub();
const sessions = new SessionService(db, pty, new OrchestrationControl());
const projId = `nul-proj-${sfx}`, agentId = `nul-ag-${sfx}`;
db.insertProject({ id: projId, name: projId, repoPath: repoA, vaultPath: repoA, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
const mkSession = (o) => db.insertSession({
  id: o.id, projectId: projId, agentId, engineSessionId: `eng-${o.id}`, title: null, cwd: o.cwd ?? os.tmpdir(),
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role: o.role, parentSessionId: o.parent ?? null, taskId: o.taskId ?? null, worktreePath: o.worktreePath ?? null, branch: null,
});
const mgrId = `nul-mgr-${sfx}`, wkrId = `nul-wkr-${sfx}`, taskId = `nul-task-${sfx}`;
db.insertTask({ id: taskId, projectId: projId, title: taskId, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
mkSession({ id: mgrId, role: "manager" });
mkSession({ id: wkrId, role: "worker", parent: mgrId, taskId, worktreePath: repoA, cwd: repoA });
const derived = deriveCrashOrphanedWorkers(db, [db.getSession(mgrId), db.getSession(wkrId)]);
check("(D-pre) the worker is a crash-orphan candidate", derived.length === 1);
const fixedNow = new Date("2026-11-08T21:08:53.000Z");
const run = async (extra = {}) => {
  const before = { w: pty.getPending(wkrId).length, m: pty.getPending(mgrId).length };
  sessions.recoverCrashOrphanedWorkers(derived, { resumeOne: () => true, now: fixedNow, bootedAt: fixedNow, hadCrashLogAtBoot: true, ...extra });
  await flush();
  return { w: pty.getPending(wkrId).slice(before.w), m: pty.getPending(mgrId).slice(before.m) };
};
const baseline = await run();                                                    // no scan option at all
const cleanScan = await run({ nulScanByWorkerId: new Map([[wkrId, emptyScan]]) });
const undefScan = await run({ nulScanByWorkerId: new Map([[wkrId, undefined]]) }); // scan could not run
check("(D) baseline produced one worker nudge and one manager nudge", baseline.w.length === 1 && baseline.m.length === 1);
check("(D) a CLEAN scan leaves the worker and manager text byte-identical to no scan", cleanScan.w[0] === baseline.w[0] && cleanScan.m[0] === baseline.m[0]);
check("(D) a scan that could not run leaves both texts byte-identical", undefScan.w[0] === baseline.w[0] && undefScan.m[0] === baseline.m[0]);
check("(D) baseline mentions no NUL damage", !/NUL-filled/.test(baseline.w[0] + baseline.m[0]));
const flaggedScan = { ...emptyScan, count: 1, trackedCount: 1, paths: ["doc-a.md"] };
const hit = await run({ nulScanByWorkerId: new Map([[wkrId, flaggedScan]]) });
check("(D) the worker's resume kickoff names exactly the NUL file", hit.w[0].includes("1 modified file looks NUL-filled after the crash: doc-a.md; restore from HEAD and re-apply") && !hit.w[0].includes("normal.md"));
check("(D) the manager's [loom:crash-recovered] notice names it too, tied to the worker in a parenthesised group", hit.m[0].startsWith("[loom:crash-recovered]") && hit.m[0].includes(`(worker ${wkrId.slice(0, 8)}: 1 modified file looks NUL-filled after the crash: doc-a.md; restore from HEAD and re-apply)`));
const wLine = nulFilledNoticeLine(flaggedScan);
const mClause = `NUL-filled worktree files after the crash (worker ${wkrId.slice(0, 8)}: ${wLine})`;
check("(D) the flagged worker text is the baseline text plus the NUL line (nothing else changed)", hit.w[0].replace(` ${wLine}.`, "") === baseline.w[0] && hit.w[0] !== baseline.w[0]);
check("(D) the flagged manager text is the baseline text plus the NUL clause (nothing else changed)", hit.m[0].replace(`; ${mClause}`, "") === baseline.m[0] && hit.m[0] !== baseline.m[0]);
const evs = db.listEvents(mgrId).filter((e) => e.kind === "crash_recovery_nul_filled" && e.workerSessionId === wkrId);
check("(D) a DURABLE crash_recovery_nul_filled event is filed per flagged worker run, carrying the worker id, task and paths only", evs.length >= 1 && evs[evs.length - 1].taskId === taskId && evs[evs.length - 1].detail.paths[0] === "doc-a.md" && evs[evs.length - 1].detail.count === 1 && !JSON.stringify(evs[evs.length - 1].detail).includes("\u0000"));
const evsBefore = db.listEvents(mgrId).filter((e) => e.kind === "crash_recovery_nul_filled").length;
await run({ nulScanByWorkerId: new Map([[wkrId, emptyScan]]) });
check("(D) a clean scan files NO event", db.listEvents(mgrId).filter((e) => e.kind === "crash_recovery_nul_filled").length === evsBefore);
const evsPreClean = db.listEvents(mgrId).filter((e) => e.kind === "crash_recovery_nul_filled").length;
const cleanStopHit = await run({ nulScanByWorkerId: new Map([[wkrId, flaggedScan]]), shutdownMarker: { reason: "signal" } });
check("(D) a CLEAN-stop boot (shutdown marker) adds no NUL line and files no event even if a scan is supplied",
  !/NUL-filled/.test(cleanStopHit.w.join("") + cleanStopHit.m.join("")) && db.listEvents(mgrId).filter((e) => e.kind === "crash_recovery_nul_filled").length === evsPreClean);
// real scan result end-to-end into the notices: doc-a.md (NUL) flagged, normal.md (edited) not.
const real = await run({ nulScanByWorkerId: new Map([[wkrId, scanA]]) });
check("(D) with a REAL scan of the fixture worktree the worker nudge names the NUL files and not the normal edit", real.w[0].includes("doc-a.md") && !real.w[0].includes("normal.md") && !real.w[0].includes("clean.md"));

// ============================ (E) suppressed + blocked branches ============================
// Fresh manager+worker per scenario so state never bleeds between them.
let fleetN = 0;
const mkFleet = (extraWorker = {}) => {
  const n = ++fleetN;
  const m = `nul-e${n}-mgr-${sfx}`, w = `nul-e${n}-wkr-${sfx}`, t = `nul-e${n}-task-${sfx}`;
  db.insertTask({ id: t, projectId: projId, title: t, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  mkSession({ id: m, role: "manager" });
  mkSession({ id: w, role: "worker", parent: m, taskId: t, worktreePath: repoA, cwd: repoA, ...extraWorker });
  return { m, w, t, derived: deriveCrashOrphanedWorkers(db, [db.getSession(m), db.getSession(w)]) };
};
const recoverFleet = async (f, scan, extra = {}) => {
  sessions.recoverCrashOrphanedWorkers(f.derived, { resumeOne: () => true, now: fixedNow, bootedAt: fixedNow, hadCrashLogAtBoot: true, nulScanByWorkerId: new Map([[f.w, scan]]), ...extra });
  await flush();
};
const nulEvents = (f) => db.listEvents(f.m).filter((e) => e.kind === "crash_recovery_nul_filled" && e.workerSessionId === f.w);

// (E1) PARKED worker: resumed live but gets NO nudge (usage hold) — the damage must still be named durably.
const fPark = mkFleet();
db.setRateLimitedUntil(fPark.w, new Date(Date.now() + 3_600_000).toISOString(), "usage limit — parked");
await recoverFleet(fPark, flaggedScan);
check("(E1) parked worker: the NUL line is suppressed from the worker (it gets no nudge at all)", pty.getPending(fPark.w).length === 0);
check("(E1) parked worker: the durable event still names the damage (worker id + paths)", nulEvents(fPark).length === 1 && nulEvents(fPark)[0].detail.paths[0] === "doc-a.md");
check("(E1) parked worker: the manager summary still carries the line", pty.getPending(fPark.m).some((m) => m.includes("NUL-filled") && m.includes("doc-a.md")));

// (E2) PARKED manager: the summary nudge is skipped to honor the park — the event is the only durable record.
const fPm = mkFleet();
db.setRateLimitedUntil(fPm.m, new Date(Date.now() + 3_600_000).toISOString(), "usage limit — parked");
await recoverFleet(fPm, flaggedScan);
check("(E2) parked manager: no summary nudge is sent (the park is honored)", pty.getPending(fPm.m).length === 0);
check("(E2) parked manager: the durable crash_recovery_nul_filled event is still filed", nulEvents(fPm).length === 1);

// (E3) awaiting-review DONE worker: no continue-nudge — the event still lands, and the manager line too.
const fDone = mkFleet();
db.appendEvent({ id: `evt-${sfx}-done`, ts: now, managerSessionId: fDone.m, workerSessionId: fDone.w, taskId: fDone.t, kind: "worker_report", detail: { status: "done" } });
fDone.derived = deriveCrashOrphanedWorkers(db, [db.getSession(fDone.m), db.getSession(fDone.w)]);
await recoverFleet(fDone, flaggedScan);
check("(E3) done-awaiting-review worker: no nudge to the worker, yet the event is filed", pty.getPending(fDone.w).length === 0 && nulEvents(fDone).length === 1);

// (E4) BLOCKED-report worker: gets the distinct re-state-your-blocker nudge — it must now carry the NUL line too.
const fBlk = mkFleet();
db.appendEvent({ id: `evt-${sfx}-blk`, ts: now, managerSessionId: fBlk.m, workerSessionId: fBlk.w, taskId: fBlk.t, kind: "worker_report", detail: { status: "blocked", summary: "need creds", needs: "key" } });
fBlk.derived = deriveCrashOrphanedWorkers(db, [db.getSession(fBlk.m), db.getSession(fBlk.w)]);
await recoverFleet(fBlk, flaggedScan);
const blkNudge = pty.getPending(fBlk.w).find((m) => /re-state your blocker/i.test(m)) ?? "";
check("(E4) blocked worker: the re-state-your-blocker nudge carries the NUL line", blkNudge.includes("1 modified file looks NUL-filled after the crash: doc-a.md; restore from HEAD and re-apply"));
const fBlkClean = mkFleet();
db.appendEvent({ id: `evt-${sfx}-blk2`, ts: now, managerSessionId: fBlkClean.m, workerSessionId: fBlkClean.w, taskId: fBlkClean.t, kind: "worker_report", detail: { status: "blocked", summary: "need creds", needs: "key" } });
fBlkClean.derived = deriveCrashOrphanedWorkers(db, [db.getSession(fBlkClean.m), db.getSession(fBlkClean.w)]);
await recoverFleet(fBlkClean, emptyScan);
check("(E4) blocked worker, clean scan: the same nudge has NO NUL text and no event", !/NUL-filled/.test(pty.getPending(fBlkClean.w).join("")) && nulEvents(fBlkClean).length === 0);

// (E5) a worker whose RESUME FAILS still gets its event (filed before the resume attempt).
const fFail = mkFleet();
await recoverFleet(fFail, flaggedScan, { resumeOne: () => false });
check("(E5) a worker that failed to resume still has the durable event", nulEvents(fFail).length === 1);

// (E6) CONSOLIDATED predecessor manager: its candidate workers go straight to `failed` and the manager is never
// resumed or nudged — the pre-pass event must still name the damage (this branch used to skip the event).
const fCons = mkFleet();
sessions.consolidatedPredecessorIds.add(fCons.m); // the real skip-set recoverCrashOrphanedWorkers consults (private TS field)
const resCons = sessions.recoverCrashOrphanedWorkers(fCons.derived, { resumeOne: () => true, now: fixedNow, bootedAt: fixedNow, hadCrashLogAtBoot: true, nulScanByWorkerId: new Map([[fCons.w, flaggedScan]]) });
await flush();
check("(E6) consolidated predecessor: the branch was really taken (worker in `failed`, manager skipped, nothing nudged)", resCons.failed.includes(fCons.w) && resCons.consolidatedSkipped.includes(fCons.m) && pty.getPending(fCons.w).length === 0 && pty.getPending(fCons.m).length === 0);
check("(E6) consolidated predecessor: the durable event is still filed, under that manager, with the paths", nulEvents(fCons).length === 1 && nulEvents(fCons)[0].detail.paths[0] === "doc-a.md");

// ============================ (F) real containment: a junction/symlinked dir must not be followed ============================
const outside = mkdtempManaged("nul-outside-");
write(outside, "secret.bin", zeros(2048)); // entirely NUL, OUTSIDE the worktree
const repoJ = mkRepo("j", { "ok.md": "tracked\n" });
write(repoJ, "ok.md", "edited\n");
fs.mkdirSync(path.join(repoJ, "real"), { recursive: true });
write(repoJ, "real/inside.bin", zeros(512)); // entirely NUL, INSIDE the worktree (positive control)
let linkMade = true;
try { fs.symlinkSync(outside, path.join(repoJ, "link"), process.platform === "win32" ? "junction" : "dir"); } catch (e) { linkMade = false; console.log(`SKIP  (F) could not create a directory link here: ${e.message}`); }
if (linkMade) {
  const scanJ = await scanWorktreeForNulFilledFiles(repoJ);
  const flaggedJ = [...(scanJ?.paths ?? []), ...(scanJ?.untrackedPaths ?? [])];
  check("(F) positive control: the NUL file INSIDE the worktree is flagged", flaggedJ.includes("real/inside.bin"));
  check("(F) the all-NUL file reached through a directory link pointing OUTSIDE the worktree is NOT read or flagged", !flaggedJ.some((p) => p.startsWith("link")) && scanJ?.count === 1);
} else if (process.platform === "win32") { failures++; console.log("FAIL  (F) junction creation must work on win32"); }

// ============================ (G) boot scheduling: hard budget + hand-off ============================
const cand = (id) => ({ workerSessionId: id });
// (G1) a never-settling read for one worker must not hold the others or the whole scan past the budget.
let lateResolve; const lateSettled = new Promise((r) => { lateResolve = r; });
const seam = (p) => {
  if (p === "/hang") return new Promise(() => {});
  if (p === "/late") return lateSettled.then(() => flaggedScan);
  return Promise.resolve(flaggedScan);
};
const paths = { a: "/ok-a", b: "/hang", c: "/ok-c", d: "/late" };
// Test-level watchdog: if the code under test lets a hang through, this turns "the test hangs forever" into a
// FAIL line (a timer raced against the awaited promise, cleared on the winning path).
const within = (p, ms) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ timedOut: true, value: undefined }), ms);
  p.then((value) => { clearTimeout(timer); resolve({ timedOut: false, value }); }, () => { clearTimeout(timer); resolve({ timedOut: false, value: undefined }); });
});
const g1 = await within(startNulFilledScan([cand("a"), cand("b"), cand("c"), cand("d")], { getWorktreePath: (id) => paths[id], scan: seam, budgetMs: 300, parallelism: 2 }), 5000);
const mapG = g1.value ?? new Map();
check("(G1) a never-settling scan is cut off: the scan resolves within a few seconds of a 300ms budget", !g1.timedOut);
check("(G1) the finished scans are present, the hung/late ones are absent (treated as not scanned)", mapG.get("a")?.count === 1 && mapG.get("c")?.count === 1 && !mapG.has("b") && !mapG.has("d"));
lateResolve(); await lateSettled.then(() => null); // our .then runs after the scan's own handlers on lateSettled — event-anchored, not a sleep
check("(G1) a scan that settles AFTER the budget cannot mutate the returned snapshot", !mapG.has("d"));
// (G2) lanes: a hang on one lane must not block the other lane's remaining work.
const mapG2 = (await within(startNulFilledScan([cand("b"), cand("a"), cand("c")], { getWorktreePath: (id) => paths[id], scan: seam, budgetMs: 300, parallelism: 2 }), 5000)).value ?? new Map();
check("(G2) parallelism: work queued behind a hung scan still completes on the other lane", mapG2.get("a")?.count === 1 && mapG2.get("c")?.count === 1);
// (G3) a throwing seam never rejects the scan.
const mapG3 = await startNulFilledScan([cand("a")], { getWorktreePath: () => "/x", scan: () => Promise.reject(new Error("boom")), budgetMs: 300 });
check("(G3) a rejecting scan yields an empty map, not a rejection", mapG3.size === 0);

// (G4) hand-off: the map REALLY reaches recovery (a dropped `nulScanByWorkerId` fails here), and recovery
// still runs, text unchanged, when the scan hangs past the budget.
const fHand = mkFleet();
const scanOk = startNulFilledScan(fHand.derived, { getWorktreePath: () => "/x", scan: () => Promise.resolve(flaggedScan), budgetMs: 300 });
const resHand = await recoverCrashOrphanedWorkersWithNulScan(sessions, fHand.derived, { resumeOne: () => true, now: fixedNow, bootedAt: fixedNow, hadCrashLogAtBoot: true }, scanOk);
await flush();
check("(G4) hand-off: recovery ran and resumed the worker", resHand.resumed.includes(fHand.w));
check("(G4) hand-off: the worker's kickoff carries the scan result that was handed through", pty.getPending(fHand.w).some((m) => m.includes("1 modified file looks NUL-filled after the crash: doc-a.md")));
check("(G4) hand-off: the manager's notice and the durable event carry it too", pty.getPending(fHand.m).some((m) => m.includes("NUL-filled")) && nulEvents(fHand).length === 1);
const fHang = mkFleet();
const scanHang = startNulFilledScan(fHang.derived, { getWorktreePath: () => "/hang", scan: () => new Promise(() => {}), budgetMs: 300 });
const g5 = await within(recoverCrashOrphanedWorkersWithNulScan(sessions, fHang.derived, { resumeOne: () => true, now: fixedNow, bootedAt: fixedNow, hadCrashLogAtBoot: true }, scanHang), 5000);
const resHang = g5.value ?? { resumed: [] };
await flush();
check("(G5) a HUNG scan cannot block recovery: it ran within the budget window and resumed the worker", !g5.timedOut && resHang.resumed.includes(fHang.w));
check("(G5) hung scan: the worker/manager text is the unflagged text (no NUL line) and no event", !/NUL-filled/.test(pty.getPending(fHang.w).join("") + pty.getPending(fHang.m).join("")) && nulEvents(fHang).length === 0);
const fNone = mkFleet();
const resNone = await recoverCrashOrphanedWorkersWithNulScan(sessions, fNone.derived, { resumeOne: () => true, now: fixedNow, bootedAt: fixedNow, hadCrashLogAtBoot: true }, undefined);
const resRej = await recoverCrashOrphanedWorkersWithNulScan(sessions, mkFleet().derived, { resumeOne: () => true, now: fixedNow, bootedAt: fixedNow, hadCrashLogAtBoot: true }, Promise.reject(new Error("scan exploded")));
check("(G6) no scan promise / a rejected one: recovery still runs", resNone.resumed.length === 1 && resRej.resumed.length === 1);

db.close();
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
// Explicit exit: this just ends the process (a leaked long timer would otherwise keep it alive). The real
// hang protection is the `within(...)` watchdogs in section G. The tmp-fixture sync `exit` backstop still
// cleans the temp dirs.
process.exit(failures === 0 ? 0 : 1);
