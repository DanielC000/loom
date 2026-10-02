import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 59d2577a — the mainline-move tripwire (card 4fa36502, docs/decisions/4fa36502-mainline-move-tripwire.md) on `merge_batch`. REAL git on temp repos, an injected
// always-green `runGate` seam, the real `mergeBatchTracked`. (Boot lives in mainline-watch-boot.mjs, the TOCTOU/fail-open cases in mainline-watch-batch-edges.mjs — split so each file stays fast.)
//
//   (B0)  FIRST SIGHT via a batch: the first landing being a batch initialises the watermark SILENTLY, and it equals the batch's landed tip.
//   (B1)  RED-FIRST: a worker's bare `update-ref` of main BETWEEN two batch landings ⇒ exactly ONE event at the second batch (both evidences), ONE
//         manager nudge, and the batch STILL lands (never a refusal).
//   (B2)  DEDUPE: the batch after that does not re-alert (the batch landing advanced the watermark to its own tip — through SEVERAL commits, so the
//         solo first-parent rule would not have).
//   (B3)  a human commit between batches is silent.
//   (B4)  card 2a6a292a round 3: guard 1b exercised ALONE on advanceMainlineWatermarkForBatch — refuses a branch-mismatched W even with a fully valid (checkedTip, isAncestor) pair.
// Run: 1) build daemon (pnpm build), 2) LOOM_CODEX_BIN=<nonexistent> node test/mainline-watch-batch.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");
useOwnLoomHome("loom-mw-batch-home-");

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
const PASS = { passed: true, steps: [{ step: "gate", durationMs: 1, status: 0 }] };

const P = { projId: `mwbb-proj-${sfx}`, agentId: `mwbb-agent-${sfx}`, mgrId: `mwbb-mgr-${sfx}`, repo: path.join(os.tmpdir(), `loom-mwbb-repo-${sfx}`) };
fs.mkdirSync(P.repo, { recursive: true }); registerForCleanup(P.repo);
fs.writeFileSync(path.join(P.repo, "README.md"), "# mwbb\n");
git(P.repo, "init", "-q"); git(P.repo, "config", "core.autocrlf", "false"); git(P.repo, "config", "user.email", "mw@loom"); git(P.repo, "config", "user.name", "mw");
commitAll(P.repo, "init", GIT_ID);
const MAIN = git(P.repo, "rev-parse", "--abbrev-ref", "HEAD");
const MAINREF = `refs/heads/${MAIN}`;
const canonHead = () => git(P.repo, "rev-parse", "HEAD");

/** One "daemon": a Db on the shared LOOM_HOME + a SessionService with an always-green gate. `nudges` records mainline nudges. */
function boot() {
  const db = new Db();
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, runGate: async () => PASS, reapWorktreeProcesses: noReap });
  const nudges = [];
  const orig = sessions.enqueueDurableMessage.bind(sessions);
  sessions.enqueueDurableMessage = (target, text, ...rest) => { if (String(text).startsWith("[loom:mainline-moved]")) nudges.push(text); return orig(target, text, ...rest); };
  return { db, sessions, nudges };
}
let d1 = boot();
d1.db.insertProject({ id: P.projId, name: "MWBB", repoPath: P.repo, vaultPath: P.repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
d1.db.insertAgent({ id: P.agentId, projectId: P.projId, name: "t", startupPrompt: "", position: 0 });
d1.db.insertSession({ id: P.mgrId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: P.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

let seq = 0;
async function addWorker(db, tag) {
  const n = `${tag}${++seq}`;
  const taskId = `mwbb-${n}-task-${sfx}`, workerId = `mwbb-${n}-wkr-${sfx}`;
  db.insertTask({ id: taskId, projectId: P.projId, title: `feat(x): change ${n}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(P.repo, P.projId, taskId);
  registerForCleanup(worktreePath);
  fs.mkdirSync(path.join(worktreePath, "src"), { recursive: true });
  fs.writeFileSync(path.join(worktreePath, "src", `${n}.ts`), `export const ${tag}${seq} = ${seq};\n`);
  commitAll(worktreePath, `feat(x): change ${n}`, GIT_ID);
  db.insertSession({ id: workerId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: P.mgrId, taskId, worktreePath, branch });
  return { taskId, workerId, worktreePath, branch, tip: git(worktreePath, "rev-parse", "HEAD") };
}
const batch = async (d, ws) => { const r = await d.sessions.mergeBatchTracked(P.mgrId, ws.map((w) => w.workerId)); return r.settled && r.ok ? r.value : { __unsettled: r }; };
const confirm = async (d, w) => { const r = await d.sessions.confirmWorkerMergeTracked(P.mgrId, w.workerId); return r.settled && r.ok ? r.value : { __unsettled: r }; };
const mwEvents = (d) => d.db.listEventsSince(0, 100000).filter((e) => e.kind === "mainline_moved_outside_loom" && e.detail?.projectId === P.projId);
const watermark = (d) => MW.parseMainlineWatermark(d.db.getMeta(MW.mainlineWatermarkKey(P.projId, "primary")));
const bypass = (w) => { git(w.worktreePath, "update-ref", MAINREF, w.tip); git(P.repo, "reset", "-q", "--hard"); };

try {
  // ── (B0) first sight via a batch ───────────────────────────────────────────
  const a = await addWorker(d1.db, "a"), b = await addWorker(d1.db, "b");
  check("(B0) before the first landing there is no watermark", watermark(d1) === null);
  const r0 = await batch(d1, [a, b]);
  check("(B0) the first batch landed both branches (setup control)", r0.ok === true && r0.landed?.length === 2);
  check("(B0) FIRST SIGHT: no event, no nudge", mwEvents(d1).length === 0 && d1.nudges.length === 0);
  check("(B0) the watermark equals the batch's landed tip (advanced after the fast-forward)", watermark(d1)?.sha === canonHead() && watermark(d1)?.branch === MAIN);

  // ── (B1) RED-FIRST: a bare update-ref between two batches ──────────────────
  const c = await addWorker(d1.db, "c"), e = await addWorker(d1.db, "e"), f = await addWorker(d1.db, "f");
  bypass(c);
  check("(B1) setup control: the worker's write DID move the canonical branch to its tip", canonHead() === c.tip);
  const r1 = await batch(d1, [e, f]);
  check("(B1) the batch STILL lands (a tripwire, never a refusal)", r1.ok === true && r1.landed?.length === 2);
  const ev1 = mwEvents(d1);
  check("(B1) exactly ONE mainline_moved_outside_loom event at the second batch, severity high", ev1.length === 1 && ev1[0].detail.severity === "high");
  check("(B1) it carries BOTH evidences and names the worker's tip, branch, repoKey", ev1[0]?.detail.evidence?.includes("reflog-raw-write") && ev1[0]?.detail.evidence?.includes("loom-branch-reachable") && ev1[0]?.detail.suspectShas?.includes(c.tip) && ev1[0]?.detail.to === c.tip && ev1[0]?.detail.branch === MAIN && ev1[0]?.detail.repoKey === "primary");
  check("(B1) exactly ONE manager nudge, tagged", d1.nudges.length === 1 && /\[loom:mainline-moved\]/.test(d1.nudges[0]));
  check("(B1) the watermark advanced to the batch's landed tip (several commits above the checked tip)", watermark(d1)?.sha === canonHead());

  // ── (B2) dedupe ────────────────────────────────────────────────────────────
  const g = await addWorker(d1.db, "g"), h = await addWorker(d1.db, "h");
  const r2 = await batch(d1, [g, h]);
  check("(B2) DEDUPE: the next batch lands and does not re-alert", r2.ok === true && mwEvents(d1).length === 1 && d1.nudges.length === 1);

  // ── (B3) a human commit between batches is silent ──────────────────────────
  fs.writeFileSync(path.join(P.repo, "human1.txt"), "h1\n"); git(P.repo, "add", "human1.txt"); git(P.repo, "commit", "-q", "-m", "docs: human commit");
  const i = await addWorker(d1.db, "i"), j = await addWorker(d1.db, "j");
  const r3 = await batch(d1, [i, j]);
  check("(B3) a human commit between batches ⇒ the batch lands, NO new event", r3.ok === true && mwEvents(d1).length === 1 && watermark(d1)?.sha === canonHead());

  // ── (B4) card 2a6a292a round 3 item 4: guard 1b EXERCISED ALONE on the BATCH twin —
  //        advanceMainlineWatermarkForBatch must refuse to change W.branch even with a fully valid
  //        (checkedTip === baseMainSha, isAncestor) pair, independent of checkMainlineMove ever refusing
  //        anything (the defense-in-depth guard round 2 added to this helper, tested directly). ───────────
  {
    const key = MW.mainlineWatermarkKey(P.projId, "primary");
    const strayGuardBranch = "stray-guard-branch-batch";
    const baseShaB4 = canonHead();
    const kk = await addWorker(d1.db, "kk"), ll = await addWorker(d1.db, "ll");
    const rk = await batch(d1, [kk, ll]);
    check("(B4) setup control: a real batch landed on top of baseShaB4", rk.ok === true && canonHead() !== baseShaB4);
    const batchHeadShaB4 = canonHead();
    d1.db.setMeta(key, JSON.stringify({ branch: strayGuardBranch, sha: baseShaB4 })); // W disagrees with the LIVE checked-out branch (MAIN)
    await d1.sessions.advanceMainlineWatermarkForBatch(P.projId, "primary", P.repo, baseShaB4, baseShaB4, batchHeadShaB4);
    check("(B4) THE GUARD: a branch-mismatched W is left COMPLETELY untouched despite a fully valid (checkedTip, isAncestor) pair", watermark(d1)?.branch === strayGuardBranch && watermark(d1)?.sha === baseShaB4);
    // control: the SAME call, with branch agreement restored, DOES advance — the guard is branch-specific.
    d1.db.setMeta(key, JSON.stringify({ branch: MAIN, sha: baseShaB4 }));
    await d1.sessions.advanceMainlineWatermarkForBatch(P.projId, "primary", P.repo, baseShaB4, baseShaB4, batchHeadShaB4);
    check("(B4) control: with branch agreement restored, the identical call DOES advance W", watermark(d1)?.branch === MAIN && watermark(d1)?.sha === batchHeadShaB4);
  }

} finally {
  try { d1.db.close(); } catch { /* already closed */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — merge_batch runs the mainline tripwire: one event per move, first sight silent, deduped, fail-open, TOCTOU-safe."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
