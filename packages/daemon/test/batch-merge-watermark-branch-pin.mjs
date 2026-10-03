import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card ba663984 — REINTRODUCES the watermark-preferred pin `b801bad0` round 3 reverted (see that record's
// own "Round 4" correction), now that card `2a6a292a` has closed `checkMainlineMove`'s silent re-stamp of
// the watermark onto a stray checkout. The branch half of the batch fast-forward's pin
// (`expectedBaseBranch`, sessions/service.ts's `mergeBatchTracked`) again prefers the STORED mainline
// watermark over a LIVE read of canonical HEAD taken at batch-cut time — catching a divert that PREDATES
// the batch's own dispatch, which a live read alone cannot see (it would capture the already-diverted
// branch as "expected" and agree with itself).
//
// THIS FILE NOW PROVES THE REINTRODUCTION:
//
//   (W1) a stored watermark that disagrees with the LIVE checkout (corrupted/stale via a direct db.setMeta,
//        standing in for an out-of-band write — 2a6a292a's own fix means an ORDINARY landing can no longer
//        produce this organically) is now TRUSTED over the live read: the batch REFUSES, naming the
//        expected branch (the watermark's), the observed branch (the live checkout), and the human-only
//        mainline-watermark reset route as the remedy if the disagreement is actually a deliberate rename.
//   (P1) a divert BEFORE the batch is even dispatched (no divert during the gate itself) is now CAUGHT —
//        this is the whole point of the card, and the exact self-defeating case `b801bad0` round 3 accepted
//        as the cost of its revert. The refusal fires at the PRE-ff check (before anything is cherry-picked
//        or merged), so neither mainline's own ref NOR the stray branch is touched.
//   (P2) control: a divert DURING the gate run (after cut, before the fast-forward) was already caught
//        before this card (the live read at cut time pins the real branch) and is UNCHANGED by it — both
//        the live read and the watermark agree at cut time in this scenario. (Already covered end-to-end by
//        batch-merge-branch-diverted-no-fallback.mjs; this is a brief confirming control, not a duplicate.)
//   (P3) no live branch available (canonical HEAD is DETACHED) AND no watermark exists yet (true first
//        sight): this is LOGGED (not silently degraded), and the batch still proceeds WITHOUT a
//        branch-divert check (the sha-only forfeit check alone still applies) — unchanged by this card.
//   (U1) the watermark row EXISTS but fails to parse (non-JSON content) on an otherwise-undiverted
//        canonical: the batch REFUSES outright (before any worktree is cut or gate run) rather than
//        silently falling back to the live read, which would reopen the exact pre-existing-divert gap this
//        pin exists to close for the case most likely to be tampering.
//   (U2) the watermark's `getMeta` read THROWS (monkey-patched for the one key under test): refused the
//        same fail-closed way as (U1), never treated as "no watermark".
//
// Run: 1) build daemon (pnpm build), 2) LOOM_CODEX_BIN=<nonexistent> node test/batch-merge-watermark-branch-pin.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");
useOwnLoomHome("loom-bmwp-home-");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const MW = await import("../dist/git/mainline-watch.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const IDENT = { GIT_AUTHOR_NAME: "bmwp", GIT_AUTHOR_EMAIL: "bmwp@loom", GIT_COMMITTER_NAME: "bmwp", GIT_COMMITTER_EMAIL: "bmwp@loom" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENT }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const GIT_ID = "-c user.email=bmwp@loom -c user.name=bmwp";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const noReap = async () => ({ killedPids: [] });
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
const PASS = { passed: true, steps: [{ step: "gate", durationMs: 1, status: 0 }] };

const P = { projId: `bmwp-proj-${sfx}`, agentId: `bmwp-agent-${sfx}`, mgrId: `bmwp-mgr-${sfx}`, repo: path.join(os.tmpdir(), `loom-bmwp-repo-${sfx}`) };
fs.mkdirSync(P.repo, { recursive: true }); registerForCleanup(P.repo);
fs.writeFileSync(path.join(P.repo, "README.md"), "# bmwp\n");
git(P.repo, "init", "-q"); git(P.repo, "config", "core.autocrlf", "false"); git(P.repo, "config", "user.email", "bmwp@loom"); git(P.repo, "config", "user.name", "bmwp");
commitAll(P.repo, "init", GIT_ID);
const MAIN = git(P.repo, "rev-parse", "--abbrev-ref", "HEAD");
const MAINREF = `refs/heads/${MAIN}`;
const canonHead = () => git(P.repo, "rev-parse", "HEAD");
const canonBranch = () => { try { return git(P.repo, "symbolic-ref", "--short", "HEAD"); } catch { return null; } };

const db = new Db();
const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, runGate: async () => PASS, reapWorktreeProcesses: noReap });
db.insertProject({ id: P.projId, name: "BMWP", repoPath: P.repo, vaultPath: P.repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
db.insertAgent({ id: P.agentId, projectId: P.projId, name: "t", startupPrompt: "", position: 0 });
db.insertSession({ id: P.mgrId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: P.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

const KEY = MW.mainlineWatermarkKey(P.projId, "primary");
const watermark = () => MW.parseMainlineWatermark(db.getMeta(KEY));
const warned = []; const realWarn = console.warn; console.warn = (...a) => { warned.push(a.join(" ")); realWarn(...a); };

let seq = 0;
async function addWorker(tag) {
  const n = `${tag}${++seq}`;
  const taskId = `bmwp-${n}-task-${sfx}`, workerId = `bmwp-${n}-wkr-${sfx}`;
  db.insertTask({ id: taskId, projectId: P.projId, title: `feat(x): change ${n}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(P.repo, P.projId, taskId);
  registerForCleanup(worktreePath);
  fs.writeFileSync(path.join(worktreePath, `${n}.ts`), `export const ${n} = 1;\n`);
  commitAll(worktreePath, `feat(x): change ${n}`, GIT_ID);
  db.insertSession({ id: workerId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: P.mgrId, taskId, worktreePath, branch });
  return { taskId, workerId, worktreePath, branch };
}
const batch = async (ws) => { const r = await sessions.mergeBatchTracked(P.mgrId, ws.map((w) => w.workerId)); return r.settled && r.ok ? r.value : { __unsettled: r }; };

try {
  // ── seed the watermark with a real, ordinary first landing (branch = MAIN) ─────────────────────────────
  const seed1 = await addWorker("seed"), seed2 = await addWorker("seed");
  const seedResult = await batch([seed1, seed2]);
  check("seed: the first batch lands normally", seedResult.ok === true && seedResult.landed?.length === 2);
  check("seed: the watermark is now stored at branch MAIN", watermark()?.branch === MAIN);

  // ── (W1) the stored watermark is now TRUSTED for the pin: a branch that doesn't exist disagrees with the
  //        live checkout, and the batch REFUSES rather than silently proceeding ──────────────────────────
  const bogusBranch = `bmwp-bogus-watermark-branch-${sfx}`;
  const w1CorruptSha = canonHead();
  db.setMeta(KEY, JSON.stringify({ branch: bogusBranch, sha: w1CorruptSha }));
  check("(W1) precondition: canonical is genuinely on MAIN (no divert in effect)", canonBranch() === MAIN);
  const w1a = await addWorker("w1a"), w1b = await addWorker("w1b");
  const rw1 = await batch([w1a, w1b]);
  check("(ba663984) (W1) a stored watermark that disagrees with the live checkout now REFUSES — the pin prefers the watermark over the live read", rw1.ok === false && rw1.branchDiverted === true && rw1.landed?.length === 0);
  check("(ba663984) (W1) mainline's own ref was NOT advanced", canonHead() === w1CorruptSha);
  check("(ba663984) (W1) nothing was started (no fallback ran): both candidates report started:false", rw1.fallback?.every((f) => f.started !== true));
  check("(ba663984) (W1) REFUSAL TEXT names the expected branch (the watermark's)", rw1.reason?.includes(`"${bogusBranch}"`));
  check("(ba663984) (W1) REFUSAL TEXT names the observed branch (the live checkout)", rw1.reason?.includes(`"${MAIN}"`));
  check("(ba663984) (W1) REFUSAL TEXT names the human-only mainline-watermark reset route as the remedy", rw1.reason?.includes("POST /api/projects/:id/mainline-watermark/reset"));
  // @decision 2a6a292a round 2 — a corrupted watermark BRANCH no longer self-corrects via an ordinary
  // landing — unchanged by ba663984, since this refusal never reaches advanceMainlineWatermarkForBatch at
  // all (result.ok is false). Reset it directly here (simulating a human reset) so the rest of this file
  // tests against a known-sane baseline.
  check("(2a6a292a) a merely-corrupted watermark branch is NOT silently self-corrected — it stays stuck at the bogus branch until explicitly corrected", watermark()?.branch === bogusBranch && watermark()?.sha === w1CorruptSha);
  db.setMeta(KEY, JSON.stringify({ branch: MAIN, sha: canonHead() }));

  // ── (P1) divert BEFORE dispatching the next batch — no divert during the gate this time ────────────────
  // THE CARD THIS FIX CLOSES: the watermark-preferred pin now catches this — a live read at cut time alone
  // could never see it (it would capture the already-diverted branch as "expected" and agree with itself).
  const preCutSha = canonHead();
  const strayBranch = `bmwp-stray-${sfx}`;
  git(P.repo, "checkout", "-q", "-b", strayBranch); // same-commit divert, entirely before the batch call
  check("(P1) precondition: canonical is on the stray branch BEFORE the batch is even dispatched", canonBranch() === strayBranch && canonHead() === preCutSha);

  const w1 = await addWorker("p1a"), w2 = await addWorker("p1b");
  const r1 = await sessions.mergeBatchTracked(P.mgrId, [w1.workerId, w2.workerId]);
  const v1 = r1.settled && r1.ok ? r1.value : { __unsettled: r1 };
  check("(ba663984) (P1) the batch now REFUSES — the watermark-preferred pin catches a divert that predates the cut", v1.ok === false && v1.branchDiverted === true);
  check("(ba663984) (P1) mainline's own ref was NOT advanced", git(P.repo, "rev-parse", MAINREF) === preCutSha);
  check("(ba663984) (P1) the stray branch was ALSO untouched — the refusal fires at the PRE-ff check, before anything is cherry-picked or merged", git(P.repo, "rev-parse", `refs/heads/${strayBranch}`) === preCutSha);
  check("(ba663984) (P1) nothing was started (no fallback ran)", v1.fallback?.every((f) => f.started !== true));
  check("(ba663984) (P1) REFUSAL TEXT names the expected branch (MAIN, the watermark's)", v1.reason?.includes(`"${MAIN}"`));
  check("(ba663984) (P1) REFUSAL TEXT names the observed branch (the stray branch)", v1.reason?.includes(`"${strayBranch}"`));
  check("(ba663984) (P1) REFUSAL TEXT names the human-only mainline-watermark reset route as the remedy", v1.reason?.includes("POST /api/projects/:id/mainline-watermark/reset"));
  // @decision 2a6a292a round 2 — the watermark was never at risk here either: this refusal never reaches
  // advanceMainlineWatermarkForBatch (result.ok is false), so both fields stay exactly as seeded.
  check("(2a6a292a) the watermark's branch is still MAIN (never touched by a refusal)", watermark()?.branch === MAIN);
  check("(2a6a292a) the watermark's sha is unchanged too", watermark()?.sha === preCutSha);

  // ── (P2) control: a divert DURING the gate (after cut, before the fast-forward) is unaffected by this
  //         revert and is still caught — confirming the pin itself still works, just not for a pre-existing
  //         divert. (Full no-fallback/event coverage lives in batch-merge-branch-diverted-no-fallback.mjs.) ─
  git(P.repo, "checkout", "-q", MAIN);
  git(P.repo, "branch", "-q", "-D", strayBranch);
  const preCutSha2 = canonHead();
  const strayBranch2 = `bmwp-stray2-${sfx}`;
  let divertedDuringGate = false;
  const sessions2 = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap,
    runGate: async () => { if (!divertedDuringGate) { git(P.repo, "checkout", "-q", "-b", strayBranch2); divertedDuringGate = true; } return PASS; },
  });
  const w3 = await addWorker("p2a"), w4 = await addWorker("p2b");
  const r2 = await sessions2.mergeBatchTracked(P.mgrId, [w3.workerId, w4.workerId]);
  const v2 = r2.settled && r2.ok ? r2.value : { __unsettled: r2 };
  check("(P2) a divert DURING the gate run is still caught: branchDiverted", v2.ok === false && v2.branchDiverted === true);
  check("(P2) mainline's own ref is untouched", git(P.repo, "rev-parse", MAINREF) === preCutSha2);
  check("(P2) the stray branch was NOT advanced (refused pre-mutation)", git(P.repo, "rev-parse", `refs/heads/${strayBranch2}`) === preCutSha2);
  git(P.repo, "checkout", "-q", MAIN);
  git(P.repo, "branch", "-q", "-D", strayBranch2);

  // ── (U1) the watermark row EXISTS but fails to parse (non-JSON content), canonical is genuinely
  //         undiverted: refuses outright rather than silently falling back to the live read ────────────────
  const u1PreSha = canonHead();
  db.setMeta(KEY, "this is not json at all");
  check("(U1) precondition: canonical is genuinely on MAIN (no divert in effect)", canonBranch() === MAIN && canonHead() === u1PreSha);
  const u1a = await addWorker("u1a"), u1b = await addWorker("u1b");
  const ru1 = await batch([u1a, u1b]);
  check("(ba663984) (U1) an unparseable watermark row REFUSES outright — never falls back to the live read", ru1.ok === false && ru1.branchDiverted === true && ru1.landed?.length === 0);
  check("(ba663984) (U1) mainline's own ref was NOT advanced", canonHead() === u1PreSha);
  check("(ba663984) (U1) nothing was started (no fallback ran)", ru1.fallback?.every((f) => f.started !== true));
  check("(ba663984) (U1) REFUSAL TEXT names the record as corrupt", ru1.reason?.includes("corrupt"));
  check("(ba663984) (U1) REFUSAL TEXT names the observed (live) branch", ru1.reason?.includes(`"${MAIN}"`));
  check("(ba663984) (U1) REFUSAL TEXT names the human-only mainline-watermark reset route as the remedy", ru1.reason?.includes("POST /api/projects/:id/mainline-watermark/reset"));
  check("(ba663984) (U1) the unparseable row itself is left untouched (never silently repaired)", db.getMeta(KEY) === "this is not json at all");
  // Code Review minor 1 (card ba663984): this early refusal must settle with a REAL verdict, never a bare row.
  const stU1 = ru1.opId ? sessions.gateStatus(ru1.opId) : undefined;
  check("(ba663984) (U1) gate_status resolves this refusal as settled, never a bare row", stU1?.state === "settled" && stU1?.passed === false);
  check("(ba663984) (U1) gate_status carries the same reason", stU1?.reason === ru1.reason);
  db.setMeta(KEY, JSON.stringify({ branch: MAIN, sha: canonHead() })); // simulate the human reset route

  // ── (U2) the watermark's own `getMeta` read THROWS (monkey-patched for the one key under test): refused
  //         the same fail-closed way as (U1), never treated as "no watermark" ──────────────────────────────
  const u2PreSha = canonHead();
  const realGetMeta = db.getMeta.bind(db);
  db.getMeta = (k) => { if (k === KEY) throw new Error("simulated db read failure"); return realGetMeta(k); };
  try {
    check("(U2) precondition: canonical is genuinely on MAIN (no divert in effect)", canonBranch() === MAIN && canonHead() === u2PreSha);
    const u2a = await addWorker("u2a"), u2b = await addWorker("u2b");
    const ru2 = await batch([u2a, u2b]);
    check("(ba663984) (U2) a watermark read that THROWS REFUSES outright — never falls back to the live read", ru2.ok === false && ru2.branchDiverted === true && ru2.landed?.length === 0);
    check("(ba663984) (U2) mainline's own ref was NOT advanced", canonHead() === u2PreSha);
    check("(ba663984) (U2) nothing was started (no fallback ran)", ru2.fallback?.every((f) => f.started !== true));
    check("(ba663984) (U2) REFUSAL TEXT names the record as unreadable", ru2.reason?.includes("unreadable"));
    check("(ba663984) (U2) REFUSAL TEXT names the human-only mainline-watermark reset route as the remedy", ru2.reason?.includes("POST /api/projects/:id/mainline-watermark/reset"));
    // Code Review minor 1 (card ba663984): this early refusal must settle with a REAL verdict, never a bare row.
    const stU2 = ru2.opId ? sessions.gateStatus(ru2.opId) : undefined;
    check("(ba663984) (U2) gate_status resolves this refusal as settled, never a bare row", stU2?.state === "settled" && stU2?.passed === false);
    check("(ba663984) (U2) gate_status carries the same reason", stU2?.reason === ru2.reason);
  } finally {
    db.getMeta = realGetMeta;
  }
} finally {
  try { db.close(); } catch { /* already closed */ }
}

// ── (P3) a FRESH project (no watermark) + a DETACHED canonical HEAD — no pin source is available ─────────
{
  const P3 = { projId: `bmwp3-proj-${sfx}`, agentId: `bmwp3-agent-${sfx}`, mgrId: `bmwp3-mgr-${sfx}`, repo: path.join(os.tmpdir(), `loom-bmwp3-repo-${sfx}`) };
  fs.mkdirSync(P3.repo, { recursive: true }); registerForCleanup(P3.repo);
  fs.writeFileSync(path.join(P3.repo, "README.md"), "# bmwp3\n");
  git(P3.repo, "init", "-q"); git(P3.repo, "config", "core.autocrlf", "false"); git(P3.repo, "config", "user.email", "bmwp@loom"); git(P3.repo, "config", "user.name", "bmwp");
  commitAll(P3.repo, "init", GIT_ID);
  const main3 = git(P3.repo, "rev-parse", "--abbrev-ref", "HEAD");
  git(P3.repo, "checkout", "-q", "--detach", "HEAD");
  check("(P3) precondition: canonical HEAD is genuinely detached", canonBranchOf(P3.repo) === null);

  const db3 = new Db();
  const sessions3 = new SessionService(db3, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, runGate: async () => PASS, reapWorktreeProcesses: noReap });
  db3.insertProject({ id: P3.projId, name: "BMWP3", repoPath: P3.repo, vaultPath: P3.repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db3.insertAgent({ id: P3.agentId, projectId: P3.projId, name: "t", startupPrompt: "", position: 0 });
  db3.insertSession({ id: P3.mgrId, projectId: P3.projId, agentId: P3.agentId, engineSessionId: null, title: null, cwd: P3.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  async function addWorker3(tag) {
    const n = `${tag}${++seq}`;
    const taskId = `bmwp3-${n}-task-${sfx}`, workerId = `bmwp3-${n}-wkr-${sfx}`;
    db3.insertTask({ id: taskId, projectId: P3.projId, title: `feat(x): change ${n}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const { worktreePath, branch } = await createWorktree(P3.repo, P3.projId, taskId);
    registerForCleanup(worktreePath);
    fs.writeFileSync(path.join(worktreePath, `${n}.ts`), `export const ${n} = 1;\n`);
    commitAll(worktreePath, `feat(x): change ${n}`, GIT_ID);
    db3.insertSession({ id: workerId, projectId: P3.projId, agentId: P3.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: P3.mgrId, taskId, worktreePath, branch });
    return { taskId, workerId, worktreePath, branch };
  }

  try {
    const warnedBefore = warned.length;
    const w1 = await addWorker3("p3a"), w2 = await addWorker3("p3b");
    const r3 = await sessions3.mergeBatchTracked(P3.mgrId, [w1.workerId, w2.workerId]);
    const v3 = r3.settled && r3.ok ? r3.value : { __unsettled: r3 };
    check("(P3) no live branch (detached HEAD): this is LOGGED (not silent)", warned.slice(warnedBefore).some((w) => /no mainline branch available to pin/.test(w)));
    // No branch pin at all ⇒ fastForwardCanonicalMain's branch-divert check never runs (same as the
    // pre-card, unpinned behavior) — only the sha-only forfeit check applies, and nothing diverted here, so
    // the batch lands normally (never reads `branchDiverted` at all).
    check("(P3) with no pin available, the batch still proceeds (sha-only forfeit check alone) and lands", v3.ok === true && v3.landed?.length === 2 && v3.branchDiverted === undefined);
  } finally {
    try { db3.close(); } catch { /* already closed */ }
  }
}

function canonBranchOf(repo) { try { return execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } }

console.warn = realWarn;
console.log(failures === 0
  ? "\n✅ ALL PASS — the batch's branch-divert pin now PREFERS the stored mainline watermark over a live read (card ba663984): a stale/corrupted watermark branch (W1) and a divert that PREDATES the batch's own dispatch (P1) both REFUSE outright, each naming the expected branch, the observed branch and the human-only reset route; a divert DURING the gate run (P2) is still caught as before; a watermark row that exists but fails to parse, or whose read throws (U1/U2), refuses fail-closed rather than silently falling back; and this file still logs (never silently degrades) when no live branch AND no watermark are available (P3)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
