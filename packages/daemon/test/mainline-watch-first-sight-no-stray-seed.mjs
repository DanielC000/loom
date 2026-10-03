import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 787dd2a7 — checkMainlineMove's own "absent" (first-sight) branch used to store() unconditionally,
// seeding the watermark from whatever happened to be checked out AT THE INSTANT of the call — even when
// the landing/ff that call was guarding never actually succeeded. A mid-gate divert then poisoned W with a
// branch nothing ever landed on, and every LATER landing hard-refused against that stray baseline.
//
// REAL git, REAL SessionService. Three scenarios, RED-FIRST against the pre-787dd2a7 code (reverting the
// `store()`-removal in checkMainlineMove's "absent" branch reproduces each RED case; confirmed by hand
// during development, not re-asserted mechanically here — see the file's own git history for the revert
// used to verify each PASS below actually fails on the old code):
//   (A) BATCH — no watermark ever stamped, a mid-gate divert refuses the batch's own ff for an unrelated
//       (branch-pin) reason; W must stay unseeded. Restore + a fresh batch call then lands.
//   (B) SOLO — no watermark ever stamped; the gate's own closure diverts canonical AND moves the worker's
//       branch tip, so the squash itself refuses for an UNRELATED reason (gateTipMoved, in-lock) — proving
//       the stray seed used to happen regardless of whether anything actually landed. W must stay
//       unseeded. Restore + a fresh solo confirm (a different worker) then lands.
//   (C) LANDING ONTO A STRAY BRANCH, RESOLVABLE DEFAULT DISAGREES — round 2: nothing refuses a first
//       landing for this (see 787dd2a7's own "Residual" section): the squash SUCCEEDS on the stray
//       branch, and advanceMainlineWatermark SEEDS from it anyway, filing ONE addressed low-severity
//       notice to the manager instead of leaving W unseeded. A repeated first-sight landing on the SAME
//       stray branch (after a reset) re-seeds but dedupes the notice.
// Run: 1) build daemon (pnpm build), 2) LOOM_CODEX_BIN=<nonexistent> node test/mainline-watch-first-sight-no-stray-seed.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");
useOwnLoomHome("loom-mwfs-home-");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { GitWriter } = await import("../dist/git/writer.js");
const MW = await import("../dist/git/mainline-watch.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const IDENT = { GIT_AUTHOR_NAME: "mwfs", GIT_AUTHOR_EMAIL: "mwfs@loom", GIT_COMMITTER_NAME: "mwfs", GIT_COMMITTER_EMAIL: "mwfs@loom" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENT }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const GIT_ID = "-c user.email=mwfs@loom -c user.name=mwfs";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const noReap = async () => ({ killedPids: [] });
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };

function freshRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mwfs-${tag}-repo-${sfx}`);
  fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# ${tag}\n`);
  git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "mwfs@loom"); git(repo, "config", "user.name", "mwfs");
  commitAll(repo, "init", GIT_ID);
  return repo;
}

let seq = 0;
async function addWorker(db, projId, agentId, mgrId, repo, tag) {
  const n = `${tag}${++seq}`;
  const taskId = `mwfs-${n}-task-${sfx}`, workerId = `mwfs-${n}-wkr-${sfx}`;
  db.insertTask({ id: taskId, projectId: projId, title: `feat(x): change ${n}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  registerForCleanup(worktreePath);
  fs.writeFileSync(path.join(worktreePath, `${n}.txt`), `${n}\n`);
  commitAll(worktreePath, `feat(x): change ${n}`, GIT_ID);
  db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
  return { taskId, workerId, worktreePath, branch };
}

function setupProject(tag, repo) {
  const db = new Db();
  const projId = `mwfs-${tag}-proj-${sfx}`, agentId = `mwfs-${tag}-agent-${sfx}`, mgrId = `mwfs-${tag}-mgr-${sfx}`;
  db.insertProject({ id: projId, name: tag, repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  return { db, projId, agentId, mgrId };
}

const watermark = (db, projId, repoKey = "primary") => MW.parseMainlineWatermark(db.getMeta(MW.mainlineWatermarkKey(projId, repoKey)));
const mwEvents = (db, projId) => db.listEventsSince(0, 100000).filter((e) => e.kind === "mainline_moved_outside_loom" && e.detail?.projectId === projId);

try {
  // ───────────────────────────────── (A) BATCH: no watermark, mid-gate divert, restore, re-lands ─────────
  {
    const repoA = freshRepo("a");
    const MAIN = git(repoA, "rev-parse", "--abbrev-ref", "HEAD");
    const canonBranch = () => git(repoA, "rev-parse", "--abbrev-ref", "HEAD");
    const strayName = `mwfs-a-stray-${sfx}`;
    const P = setupProject("a", repoA);
    check("(A) setup: no watermark before anything", watermark(P.db, P.projId) === null);

    let gateCalls = 0;
    const sessions = new SessionService(P.db, ptyStub, new OrchestrationControl(), {
      syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap,
      runGate: async () => {
        gateCalls++;
        if (gateCalls === 1) await new GitWriter(repoA).createBranch(strayName); // same-sha divert, mid-gate
        return { passed: true, steps: [{ step: "gate", durationMs: 1, status: 0 }] };
      },
    });

    const w1 = await addWorker(P.db, P.projId, P.agentId, P.mgrId, repoA, "a");
    const w2 = await addWorker(P.db, P.projId, P.agentId, P.mgrId, repoA, "a");

    const r1 = await sessions.mergeBatchTracked(P.mgrId, [w1.workerId, w2.workerId]);
    check("(A) call #1 settled synchronously", r1.settled === true);
    const v1 = r1.settled && r1.ok ? r1.value : { __unsettled: r1 };
    check("(A) call #1 refused for the branch-pin mismatch (unrelated to the watermark)", v1.ok === false && v1.branchDiverted === true);
    check("(A) RED-FIRST: the watermark is STILL unseeded after a refused, diverted first-sight call", watermark(P.db, P.projId) === null);

    check("(A) precondition: canonical really is diverted before the restore", canonBranch() === strayName);
    git(repoA, "checkout", "-q", MAIN);
    git(repoA, "branch", "-q", "-D", strayName);
    check("(A) precondition: checkout is restored to mainline", canonBranch() === MAIN);

    const r2 = await sessions.mergeBatchTracked(P.mgrId, [w1.workerId, w2.workerId]);
    check("(A) call #2 settled synchronously", r2.settled === true);
    const v2 = r2.settled && r2.ok ? r2.value : { __unsettled: r2 };
    check("(A) the NEXT batch lands cleanly (never hard-refused against a stray baseline)", v2.ok === true);
    check("(A) the watermark now correctly reflects the real landing on mainline", watermark(P.db, P.projId)?.branch === MAIN);
    P.db.close();
  }

  // ───────────────────────────────── (B) SOLO: no watermark, mid-gate divert, restore, re-lands ──────────
  {
    const repoB = freshRepo("b");
    const MAIN = git(repoB, "rev-parse", "--abbrev-ref", "HEAD");
    const canonBranch = () => git(repoB, "rev-parse", "--abbrev-ref", "HEAD");
    const strayName = `mwfs-b-stray-${sfx}`;
    // A worker branch tip move (an alternative unrelated-failure shape) is NOT usable here: it is caught
    // by an EARLIER pre-squash check that runs before checkMainlineMove is even called, so it would never
    // exercise the bug this test is about. Instead, the stub adds a REAL new commit onto canonical's own
    // diverted branch — moving canonical's sha, not just its branch name — which `mergeBranch`'s own
    // `requireCanonicalHead` re-check catches (`gateBaseInvalidated`) for a reason that has nothing to do
    // with WHICH branch is checked out, only that canonical moved since the gate was decided.
    const P = setupProject("b", repoB);
    check("(B) setup: no watermark before anything", watermark(P.db, P.projId) === null);

    let gateCalls = 0;
    const sessions = new SessionService(P.db, ptyStub, new OrchestrationControl(), {
      syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap,
      runGate: async () => {
        gateCalls++;
        if (gateCalls === 1) {
          await new GitWriter(repoB).createBranch(strayName); // same-sha divert, mid-gate
          fs.writeFileSync(path.join(repoB, "stray-extra.txt"), "stray\n");
          git(repoB, "add", "stray-extra.txt"); git(repoB, "commit", "-q", "-m", "feat(x): a commit that lands mid-gate on the stray branch");
        }
        return { passed: true, steps: [{ step: "gate", durationMs: 1, status: 0 }] };
      },
    });

    const w1 = await addWorker(P.db, P.projId, P.agentId, P.mgrId, repoB, "b");

    const r1 = await sessions.confirmWorkerMergeTracked(P.mgrId, w1.workerId);
    const v1 = r1.settled && r1.ok ? r1.value : { __unsettled: r1 };
    check("(B) call #1 refused for an UNRELATED reason (canonical's sha moved mid-gate, not a branch-pin issue)", v1.merged === false && v1.gateBaseInvalidated === true);
    check("(B) RED-FIRST: the watermark is STILL unseeded after a refused, diverted first-sight call", watermark(P.db, P.projId) === null);

    check("(B) precondition: canonical really is diverted before the restore", canonBranch() === strayName);
    git(repoB, "checkout", "-q", MAIN);
    git(repoB, "branch", "-q", "-D", strayName);
    check("(B) precondition: checkout is restored to mainline", canonBranch() === MAIN);

    const w2 = await addWorker(P.db, P.projId, P.agentId, P.mgrId, repoB, "b");
    const r2 = await sessions.confirmWorkerMergeTracked(P.mgrId, w2.workerId);
    const v2 = r2.settled && r2.ok ? r2.value : { __unsettled: r2 };
    check("(B) the NEXT solo confirm lands cleanly (never hard-refused against a stray baseline)", v2.merged === true);
    check("(B) the watermark now correctly reflects the real landing on mainline", watermark(P.db, P.projId)?.branch === MAIN);
    P.db.close();
  }

  // ───────────────────────────────── (C) LANDING onto a stray branch, a RESOLVABLE default disagrees ─────
  // Round 2 (manager ruling, card 787dd2a7's own "Round 2 scope" item 1): a first landing that actually
  // lands on a stray branch (nothing in this card refuses that; see the Residual) now SEEDS W from it
  // anyway and files ONE addressed notice to the manager, rather than leaving W unseeded forever. No real
  // remote is needed: `resolveMainlineBranch` only reads the symbolic ref `refs/remotes/origin/HEAD`.
  {
    const repoC = freshRepo("c");
    const MAIN = git(repoC, "rev-parse", "--abbrev-ref", "HEAD");
    const canonBranch = () => git(repoC, "rev-parse", "--abbrev-ref", "HEAD");
    git(repoC, "symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${MAIN}`);
    check("(C) setup control: resolveMainlineBranch resolves the configured default", git(repoC, "symbolic-ref", "--short", "refs/remotes/origin/HEAD") === `origin/${MAIN}`);
    const strayName = `mwfs-c-stray-${sfx}`;
    const P = setupProject("c", repoC);
    check("(C) setup: no watermark before anything", watermark(P.db, P.projId) === null);

    const sessions = new SessionService(P.db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, runGate: async () => ({ passed: true, steps: [{ step: "gate", durationMs: 1, status: 0 }] }), reapWorktreeProcesses: noReap });
    const nudges = [];
    const origEnqueue = sessions.enqueueDurableMessage.bind(sessions);
    sessions.enqueueDurableMessage = (target, text, ...rest) => { if (String(text).startsWith("[loom:mainline-moved]")) nudges.push(text); return origEnqueue(target, text, ...rest); };
    const w1 = await addWorker(P.db, P.projId, P.agentId, P.mgrId, repoC, "c");
    git(repoC, "checkout", "-q", "-b", strayName); // same-commit divert BEFORE confirm — nothing refuses this on first sight (no watermark ⇒ no branch pin)

    const r1 = await sessions.confirmWorkerMergeTracked(P.mgrId, w1.workerId);
    const v1 = r1.settled && r1.ok ? r1.value : { __unsettled: r1 };
    check("(C) the first landing itself is NOT refused (this card adds no landing refusal)", v1.merged === true);
    check("(C) the landing really did land on the stray branch", canonBranch() === strayName);
    check("(C) the watermark IS seeded from the stray branch (not left unseeded)", watermark(P.db, P.projId)?.branch === strayName && watermark(P.db, P.projId)?.sha === git(repoC, "rev-parse", "HEAD"));
    const seeded = mwEvents(P.db, P.projId);
    check("(C) exactly one low-severity first-sight-seeded-stray event was filed", seeded.length === 1 && seeded[0].detail.severity === "low" && seeded[0].detail.evidence?.includes("first-sight-seeded-stray") && seeded[0].detail.branch === strayName && seeded[0].detail.expectedBranch === MAIN);
    check("(C) exactly one addressed manager nudge, naming both branches and the real remedy", nudges.length === 1 && nudges[0].includes(strayName) && nudges[0].includes(MAIN) && /git remote set-head origin -a/.test(nudges[0]));

    // Repeated-landing dedupe (round 2 scope item 5; round 3 nit 4 — label corrected): deleting W ALONE
    // (never the alert marker too) is NOT what any production reset path does — resetMainlineWatermark
    // (db.ts) deletes the watermark key AND the alert-marker key together, so a real human reset always
    // clears both. This instead proves the DEDUPE PREDICATE directly: with the delivered alert marker
    // from the first landing still intact, a second first-sight landing onto the SAME stray branch with
    // the SAME disagreeing default must not re-fire the notice, while the seed itself still happens.
    P.db.deleteMeta(MW.mainlineWatermarkKey(P.projId, "primary"));
    const w2 = await addWorker(P.db, P.projId, P.agentId, P.mgrId, repoC, "c");
    const r2 = await sessions.confirmWorkerMergeTracked(P.mgrId, w2.workerId);
    const v2 = r2.settled && r2.ok ? r2.value : { __unsettled: r2 };
    check("(C) DEDUPE: the second first-sight landing on the SAME stray branch still lands", v2.merged === true);
    check("(C) DEDUPE: no second event or nudge for the same (branch, defaultBranch) fact", mwEvents(P.db, P.projId).length === 1 && nudges.length === 1);
    check("(C) DEDUPE: the watermark still correctly re-seeds despite the deduped notice", watermark(P.db, P.projId)?.branch === strayName && watermark(P.db, P.projId)?.sha === git(repoC, "rev-parse", "HEAD"));
    P.db.close();
  }
} finally {
  // (each scenario closes its own db above)
}

console.log(failures === 0
  ? "\n✅ ALL PASS — checkMainlineMove's own first-sight (absent) branch never seeds the watermark from a mid-gate divert for a LANDING path; seeding defers to advanceMainlineWatermark{,ForBatch}, which apply the same resolvable-default rule and seed anyway (with one deduped addressed notice) rather than leave W unseeded forever."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
