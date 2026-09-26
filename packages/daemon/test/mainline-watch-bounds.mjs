import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 0eb7ff27 — the mainline tripwire's TOTAL work is bounded (the spawn-count cases live in mainline-watch-spawns.mjs) (card 4fa36502, docs/decisions/4fa36502-mainline-move-tripwire.md). REAL git on temp repos.
//
//   (D)  DEADLINE: one aggregate budget per check. (D1) a facts reader that never returns ⇒ the check returns inside the budget, the landing still merges, no event, W is NOT
//        advanced, and the next landing (reader restored) still catches the move. (D2) a head reader that never returns: same. (D3) a deadline that expires DURING the loom-tip
//        signal skips ONLY that signal — the reflog-raw-write evidence already read still alerts.
// Run: 1) build daemon (pnpm build), 2) node test/mainline-watch-bounds.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");
useOwnLoomHome("loom-mainline-bounds-home-");
const traceDir = mkdtempManaged("loom-mw-trace-");
const TRACE = path.join(traceDir, "trace2.jsonl");
process.env.GIT_TRACE2_EVENT = TRACE; // every git process (fixture AND daemon) appends its events here

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const MW = await import("../dist/git/mainline-watch.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const IDENT = { GIT_AUTHOR_NAME: "mw", GIT_AUTHOR_EMAIL: "mw@loom", GIT_COMMITTER_NAME: "mw", GIT_COMMITTER_EMAIL: "mw@loom" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENT }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const GIT_ID = "-c user.email=mw@loom -c user.name=mw";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const noReap = async () => ({ killedPids: [] });
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
const NEVER = () => new Promise(() => {});
/** Top-level git processes recorded so far (a child process's sid contains a "/"). */
const traceLines = () => (fs.existsSync(TRACE) ? fs.readFileSync(TRACE, "utf8").split("\n").filter(Boolean) : []).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const topStarts = () => traceLines().filter((e) => e.event === "start" && !String(e.sid).includes("/"));
const withWatchdog = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`WATCHDOG: ${what} did not return in ${ms}ms`)), ms))]);

function initRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mwb-${tag}-${sfx}`);
  fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# mwb\n");
  git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "mw@loom"); git(repo, "config", "user.name", "mw");
  commitAll(repo, "init", GIT_ID);
  return repo;
}
const mainOf = (repo) => git(repo, "rev-parse", "--abbrev-ref", "HEAD");
const treeOf = (repo, c) => git(repo, "rev-parse", `${c}^{tree}`);

// ============ (D) deadline ============
const P = { projId: `mwd-proj-${sfx}`, agentId: `mwd-agent-${sfx}`, mgrId: `mwd-mgr-${sfx}`, repo: initRepo("d") };
const MAIN = mainOf(P.repo), MAINREF = `refs/heads/${MAIN}`;
const db = new Db();
const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, runGate: async () => ({ passed: true, steps: [] }), reapWorktreeProcesses: noReap });
const nudges = [];
const origEnqueue = sessions.enqueueDurableMessage.bind(sessions);
sessions.enqueueDurableMessage = (target, text, ...rest) => { if (String(text).startsWith("[loom:mainline-moved]")) nudges.push(text); return origEnqueue(target, text, ...rest); };
db.insertProject({ id: P.projId, name: "MWD", repoPath: P.repo, vaultPath: P.repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
db.insertAgent({ id: P.agentId, projectId: P.projId, name: "t", startupPrompt: "", position: 0 });
db.insertSession({ id: P.mgrId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: P.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null });
let seq = 0;
async function addWorker(tag) {
  const n = `${tag}${++seq}`;
  const taskId = `mwd-${n}-task-${sfx}`, workerId = `mwd-${n}-wkr-${sfx}`;
  db.insertTask({ id: taskId, projectId: P.projId, title: `feat(x): change ${n}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(P.repo, P.projId, taskId);
  registerForCleanup(worktreePath);
  fs.mkdirSync(path.join(worktreePath, "src"), { recursive: true });
  fs.writeFileSync(path.join(worktreePath, "src", `${n}.ts`), `export const ${tag}${seq} = ${seq};\n`);
  commitAll(worktreePath, `feat(x): change ${n}`, GIT_ID);
  db.insertSession({ id: workerId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: P.mgrId, taskId, worktreePath, branch });
  return { taskId, workerId, worktreePath, branch };
}
const confirm = async (w) => { const r = await sessions.confirmWorkerMergeTracked(P.mgrId, w.workerId); return r.settled && r.ok ? r.value : { __unsettled: r }; };
const evFor = (w) => db.listEventsForWorker(w.workerId).filter((e) => e.kind === "mainline_moved_outside_loom");
const KEY = MW.mainlineWatermarkKey(P.projId, "primary");
const watermark = () => MW.parseMainlineWatermark(db.getMeta(KEY));
const canonHead = () => git(P.repo, "rev-parse", "HEAD");
const HUNG_BUDGET_MS = 4000; // the hung-reader cases (D1/D2) shrink ONLY the aggregate budget (`mainlineDeadlineMs`) so they wait out 4s, not 12s. NOT the per-call git timeout: `mainlineGitMs` also bounds the landing's own reads, and a 1s call timeout under load made the landing itself refuse
const BUDGET_MS = 30_000; // the default gitOpMs (10s) ⇒ the check's aggregate budget is min(4 × 10s, 30s). A small gitOpMs made real landing git time out under load (flaky), so only the budget is shrunk, for the hung-reader cases
const warned = []; const realWarn = console.warn; console.warn = (...a) => { warned.push(a.join(" ")); };
const realFactsReader = sessions.mainlineFactsReader, realHeadReader = sessions.mainlineHeadReader;

try {
  // first sight, silently, via a landing
  // W is seeded directly (a landing's own first-sight init is covered by mainline-watch.mjs (S0)); the landings below are the ones the deadline cases need.
  db.setMeta(KEY, JSON.stringify({ branch: MAIN, sha: canonHead() }));
  check("(D0) setup: W is the canonical head", watermark()?.sha === canonHead() && watermark()?.branch === MAIN);

  // a raw write of main onto an untrailered commit no loom/* branch holds (the reflog-raw-write shape)
  const orphan = git(P.repo, "commit-tree", "-p", canonHead(), "-m", "sneaky", `${canonHead()}^{tree}`);
  git(P.repo, "update-ref", MAINREF, orphan); git(P.repo, "reset", "-q", "--hard");

  // ── (D1) a facts reader that NEVER returns ──
  const wBefore = watermark()?.sha;
  const b = await addWorker("b"), c = await addWorker("c");
  const head1 = await realHeadReader(P.repo, 3000); // the head read is real git — take it BEFORE the per-call timeout shrinks, and serve it from memory while it is small
  sessions.mainlineDeadlineMs = () => HUNG_BUDGET_MS; sessions.mainlineHeadReader = async () => head1;
  sessions.mainlineFactsReader = NEVER;
  const t0 = performance.now();
  let rb, hung = null;
  try { rb = await withWatchdog(confirm(b), 90_000, "confirm with a hung facts reader"); } catch (e) { hung = e; }
  console.log(`      hung facts reader: the whole landing (worktree git + squash + check) returned in ${Math.round(performance.now() - t0)}ms`);
  check("(D1) DEADLINE: a facts reader that never returns does not wedge the landing (returns; watchdog did not fire)", hung === null);
  // The landing's own git dominates its wall time on a loaded host, so the BOUND is measured on the check alone (W is untouched by the failed check, so this is the same call again).
  const t0b = performance.now();
  const direct = await withWatchdog(sessions.checkMainlineMove({ projectId: P.projId, repoKey: "primary", repoPath: P.repo, managerSessionId: P.mgrId, workerSessionId: null, taskId: null }), 30_000, "direct check with a hung facts reader");
  const msDirect = performance.now() - t0b;
  console.log(`      hung facts reader: the check alone returned null in ${Math.round(msDirect)}ms against a ${HUNG_BUDGET_MS}ms budget`);
  check("(D1) BOUND: the check alone resolves null inside budget + grace + slack (< 2× the budget) — not after per-call timeouts stack", direct === null && msDirect < HUNG_BUDGET_MS * 2);
  check("(D1) FAIL-OPEN: the landing still merges, files NO event, sends NO nudge", rb?.merged === true && evFor(b).length === 0 && nudges.length === 0);
  check("(D1) the timeout is logged as a fail-open skip naming the deadline", warned.some((w) => /mainline-watch\] check skipped \(fail-open\).*deadline exceeded/.test(w)));
  check("(D1) W was NOT advanced past the unverified move (the landing's advance is skipped with the check)", watermark()?.sha === wBefore);
  sessions.mainlineFactsReader = realFactsReader; sessions.mainlineHeadReader = realHeadReader; delete sessions.mainlineDeadlineMs;
  await confirm(c);
  check("(D1) the next landing (reader restored) STILL sees the move: ONE high event with reflog-raw-write naming the orphan", evFor(c).length === 1 && evFor(c)[0].detail.severity === "high" && evFor(c)[0].detail.evidence.includes("reflog-raw-write") && evFor(c)[0].detail.suspectShas.includes(orphan) && nudges.length === 1);

  // ── (D2) a HEAD reader that never returns ──
  const orphan2 = git(P.repo, "commit-tree", "-p", canonHead(), "-m", "sneaky2", `${canonHead()}^{tree}`);
  git(P.repo, "update-ref", MAINREF, orphan2); git(P.repo, "reset", "-q", "--hard");
  const wD2 = watermark()?.sha; const nudgesD2 = nudges.length;
  sessions.mainlineDeadlineMs = () => HUNG_BUDGET_MS; sessions.mainlineHeadReader = NEVER;
  const t1 = performance.now();
  let v2, hung2 = null;
  try { v2 = await withWatchdog(sessions.checkMainlineMove({ projectId: P.projId, repoKey: "primary", repoPath: P.repo, managerSessionId: P.mgrId, workerSessionId: null, taskId: null }), 30_000, "check with a hung head reader"); } catch (e) { hung2 = e; }
  const ms2 = performance.now() - t1;
  sessions.mainlineHeadReader = realHeadReader; delete sessions.mainlineDeadlineMs;
  check("(D2) DEADLINE: a head reader that never returns ⇒ the check resolves null (fail-open, never throws) inside the budget", hung2 === null && v2 === null && ms2 < HUNG_BUDGET_MS * 2);
  check("(D2) …W untouched, no nudge", watermark()?.sha === wD2 && nudges.length === nudgesD2);
  const d = await addWorker("d"); // never landed: a worker row to hang the events on (a landing costs ~7s; the check is what is under test)
  await sessions.checkMainlineMove({ projectId: P.projId, repoKey: "primary", repoPath: P.repo, managerSessionId: P.mgrId, workerSessionId: d.workerId, taskId: d.taskId });
  check("(D2) …and the next check (reader restored) still sees the move", evFor(d).length === 1 && evFor(d)[0].detail.evidence.includes("reflog-raw-write") && evFor(d)[0].detail.suspectShas.includes(orphan2));

  // ── (D3) the deadline expires DURING the loom-tip signal: only that signal is skipped ──
  const orphan3 = git(P.repo, "commit-tree", "-p", canonHead(), "-m", "sneaky3", `${canonHead()}^{tree}`);
  git(P.repo, "update-ref", MAINREF, orphan3); git(P.repo, "reset", "-q", "--hard");
  git(P.repo, "branch", `loom/z-${sfx}`, orphan3); // a loom ref so the scan has a stage AFTER for-each-ref (rev-list) for the deadline to cut off
  const feBefore = traceLines().filter((e) => e.event === "start" && JSON.stringify(e.argv).includes("for-each-ref")).length;
  const realNow = performance.now.bind(performance);
  // Deterministic "time runs out right after the for-each-ref": the (monotonic) clock jumps once git's own trace2 log shows a for-each-ref newer than the baseline.
  const forEachRefs = () => traceLines().filter((e) => e.event === "start" && JSON.stringify(e.argv).includes("for-each-ref")).length;
  performance.now = () => realNow() + (forEachRefs() > feBefore ? 3_600_000 : 0);
  let facts3;
  try {
    const head = { branch: MAIN, tip: orphan3 };
    facts3 = await MW.readMainlineFacts(P.repo, watermark().sha, head, 5000, realNow() + BUDGET_MS);
  } finally { performance.now = realNow; }
  check("(D3) an expired deadline during the loom-tip stage skips ONLY that signal (loomTipsSkipped) — the reflog and the untrailered commits already read are kept", facts3.loomTipsSkipped === true && facts3.loomTipsDeadline === true && facts3.reflog !== null && facts3.untrailered.includes(orphan3));
  check("(D3) …so the classifier still ALERTS on reflog-raw-write (the raw-write evidence is not absorbed into 'unverifiable')", MW.classifyMainlineMove(watermark().sha, facts3).verdict === "alert" && MW.classifyMainlineMove(watermark().sha, facts3).evidence.join() === "reflog-raw-write");
  // A deadline already past BEFORE the reflog/range reads is not a skipped signal — nothing usable was read — it THROWS (the caller fails open).
  let threw = null;
  try { await MW.readMainlineFacts(P.repo, watermark().sha, { branch: MAIN, tip: orphan3 }, 5000, realNow() - 1); } catch (e) { threw = e; }
  check("(D3) a deadline that is already past before any evidence is read THROWS MainlineDeadlineError (fail-open, W untouched)", threw instanceof MW.MainlineDeadlineError);

  // ── (D5) the timer ITSELF rejects with MainlineDeadlineError — the cause is never inferred from the clock afterwards ──
  // The clock is FROZEN (a timer that fires "early" relative to the clock, the reproduced 1/400 case, made deterministic): 1ms of budget is gone long before git can answer, and a clock re-read
  // would still say "before the deadline" and misfile the timeout as an ordinary error (⇒ watermarkMissing ⇒ "unverifiable" ⇒ W stored).
  {
    const frozen = realNow();
    performance.now = () => frozen;
    let r5 = null, e5 = null;
    try { r5 = await MW.readMainlineFacts(P.repo, watermark().sha, { branch: MAIN, tip: orphan3 }, 5000, frozen + 1); } catch (e) { e5 = e; } finally { performance.now = realNow; }
    check("(D5) a deadline-driven timeout on the FIRST read throws MainlineDeadlineError even when the clock never passes the deadline (not watermarkMissing / unverifiable)", e5 instanceof MW.MainlineDeadlineError && r5 === null);
  }

  // ── (D4) a PORCELAIN-looking bypass + a deadline in the loom-tip stage must NOT be absorbed ──
  // `git merge --ff-only loom/x` from a worker writes "merge loom/x: Fast-forward" (not raw), so the loom-tip signal is the only one that sees it. If the deadline cuts that signal off and the verdict is
  // "explained", storing W would erase the move for good: the check must fail open instead (W untouched, no event), and the next un-deadlined check must alert.
  {
    const f = d, evBefore = evFor(d).length; // reuse the D2 worker row: events are counted relative to what it already holds
    const head0 = canonHead();
    db.setMeta(KEY, JSON.stringify({ branch: MAIN, sha: head0 }));
    const cf = git(P.repo, "commit-tree", "-p", head0, "-m", "work pf", `${head0}^{tree}`);
    git(P.repo, "update-ref", "-m", "commit: work", `refs/heads/loom/pf-${sfx}`, cf);
    git(P.repo, "update-ref", "-m", `merge loom/pf-${sfx}: Fast-forward`, MAINREF, cf); git(P.repo, "reset", "-q", "--hard");
    check("(D4) setup control: the main reflog message of the bypass is PORCELAIN (not raw) — only the loom-tip signal can see it", !MW.isRawReflogMessage(git(P.repo, "reflog", "show", "--format=%gs", "-n1", MAINREF)));
    const args = { projectId: P.projId, repoKey: "primary", repoPath: P.repo, managerSessionId: P.mgrId, workerSessionId: f.workerId, taskId: f.taskId };
    const fe0 = forEachRefs();
    performance.now = () => realNow() + (forEachRefs() > fe0 ? 3_600_000 : 0);
    let r4; const nudgesD4 = nudges.length;
    try { r4 = await sessions.checkMainlineMove(args); } finally { performance.now = realNow; }
    check("(D4) DEADLINE + porcelain bypass: the check fails open (returns null), files NO event, sends NO nudge", r4 === null && evFor(f).length === evBefore && nudges.length === nudgesD4);
    check("(D4) …and W is UNTOUCHED (the move is not absorbed)", watermark()?.sha === head0);
    const r4b = await sessions.checkMainlineMove(args);
    check("(D4) the next un-deadlined check ALERTS (loom-branch-reachable, naming the worker tip) and stores W", r4b === cf && evFor(f).length === evBefore + 1 && evFor(f)[evBefore].detail.severity === "high" && evFor(f)[evBefore].detail.evidence.join() === "loom-branch-reachable" && evFor(f)[evBefore].detail.suspectShas.includes(cf) && watermark()?.sha === cf);
  }

  // ── (D6) the service really hands the facts reader a deadline (D1 alone would pass on the outer race) ──
  {
    let seen; const wrapped = (...a) => { seen = a[4]; return realFactsReader(...a); };
    const head1 = canonHead();
    const cg = git(P.repo, "commit-tree", "-p", head1, "-m", "sneaky6", `${head1}^{tree}`);
    git(P.repo, "update-ref", MAINREF, cg); git(P.repo, "reset", "-q", "--hard");
    sessions.mainlineFactsReader = wrapped;
    const before = realNow();
    try { await sessions.checkMainlineMove({ projectId: P.projId, repoKey: "primary", repoPath: P.repo, managerSessionId: P.mgrId, workerSessionId: null, taskId: null }); } finally { sessions.mainlineFactsReader = realFactsReader; }
    check("(D6) the facts reader is called with a 5th arg: a monotonic deadline within (now, now + budget + slack]", typeof seen === "number" && seen > before && seen <= realNow() + BUDGET_MS);
  }
} finally {
  console.warn = realWarn;
  try { db.close(); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the mainline check's total work is bounded (aggregate deadline, fail-open) and its authored-tip reflog check is one git call."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
