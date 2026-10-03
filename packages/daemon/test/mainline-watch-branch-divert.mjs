import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 2a6a292a — `checkMainlineMove`'s "first sight of a branch" rule used to read `!w || w.branch !== head.branch`
// as ONE condition, so a watermark that ALREADY existed got silently RE-STAMPED to whatever branch happened to be
// checked out on any branch CHANGE — including a transient, non-landing divert (a human REST GitWriter checkout, a
// batch's own mid-gate divert). After b801bad0, a batch's branch pin preferring that watermark would then also point
// at the stray branch, so both checks could pass while landing off mainline. REAL git, real batch path.
//
//   (D1) RED-FIRST: a divert DURING a batch's own gate run ⇒ the watermark's branch AND sha are left UNCHANGED (not
//        re-stamped to the stray branch), exactly ONE `mainline_moved_outside_loom` event fires with
//        `evidence:["branch-diverted"]`, and the batch's OWN pre-existing pin (git/batch-merge.ts, untouched by this
//        card) still refuses the fast-forward — proving the fix does not disturb that existing protection.
//   (D2) DEDUPE: a second batch whose gate ALSO diverts to the SAME still-live stray branch does not re-alert
//        (the stored marker's `sameMove` check against (from, to) — NOT `dropBootAlert`, which only ever CLEARS
//        a marker, never dedupes a repeat — recognises the identical move and skips a second event/nudge).
//   (D3) SELF-CORRECTS: once canonical is genuinely back on the true mainline branch, an ordinary batch lands
//        normally and the watermark advances via `advanceMainlineWatermarkForBatch` — the branch-vs-watermark
//        guard round 2 added there (see D5) is a no-op on this path since the live branch already agrees with W.
//   (D4) BOOT: the identical branch-mismatch alert, through `checkMainlineMovesOnBoot` (source:"boot") — same
//        watermark-unchanged guarantee, filed once per (from, to), no nudge (no live manager at boot).
//   (D5) ROUND 2, SOLO: a divert that PREDATES the confirm (not during it). UPDATED once card d69d4858 landed
//        its own solo branch-pin refusal: the confirm now REFUSES (branchDiverted) instead of landing onto the
//        stray branch — this file's own concern (does checkMainlineMove's tripwire still fire + leave the
//        watermark untouched) is unaffected either way, since checkMainlineMove runs before d69d4858's own
//        check and never depends on whether the squash itself proceeds. See `batch-merge-watermark-branch-pin.mjs`'s
//        (P1) for the identical batch-side fix (card ba663984, landed the same way).
//   (D6) MARKER SHARING: an undelivered sha-level alert marker (different evidence, coincidentally the same
//        (from, to) as a later divert — a same-commit checkout never moves the tip) is never clobbered.
//   (D7) THE NUDGE TEXT for a divert names the expected/observed branch and a checkout/reset-route remedy, never
//        the generic sha-level "git log A..B" / "bypass the merge gate" framing.
//
// Run: 1) build daemon (pnpm build), 2) LOOM_CODEX_BIN=<nonexistent> node test/mainline-watch-branch-divert.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), `loom-mwbd-no-such-codex-bin-${Date.now()}-${process.pid}`);
useOwnLoomHome("loom-mwbd-home-");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const MW = await import("../dist/git/mainline-watch.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const IDENT = { GIT_AUTHOR_NAME: "mwbd", GIT_AUTHOR_EMAIL: "mwbd@loom", GIT_COMMITTER_NAME: "mwbd", GIT_COMMITTER_EMAIL: "mwbd@loom" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENT }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const GIT_ID = "-c user.email=mwbd@loom -c user.name=mwbd";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const noReap = async () => ({ killedPids: [] });
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
const PASS = { passed: true, steps: [{ step: "gate", durationMs: 1, status: 0 }] };

const P = { projId: `mwbd-proj-${sfx}`, agentId: `mwbd-agent-${sfx}`, mgrId: `mwbd-mgr-${sfx}`, repo: path.join(os.tmpdir(), `loom-mwbd-repo-${sfx}`) };
fs.mkdirSync(P.repo, { recursive: true }); registerForCleanup(P.repo);
fs.writeFileSync(path.join(P.repo, "README.md"), "# mwbd\n");
git(P.repo, "init", "-q"); git(P.repo, "config", "core.autocrlf", "false"); git(P.repo, "config", "user.email", "mwbd@loom"); git(P.repo, "config", "user.name", "mwbd");
commitAll(P.repo, "init", GIT_ID);
const MAIN = git(P.repo, "rev-parse", "--abbrev-ref", "HEAD");
const MAINREF = `refs/heads/${MAIN}`;
const canonHead = () => git(P.repo, "rev-parse", "HEAD");
const canonBranch = () => { try { return git(P.repo, "symbolic-ref", "--short", "HEAD"); } catch { return null; } };

const db = new Db();
db.insertProject({ id: P.projId, name: "MWBD", repoPath: P.repo, vaultPath: P.repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
db.insertAgent({ id: P.agentId, projectId: P.projId, name: "t", startupPrompt: "", position: 0 });
// `processState: "exited"` ⇒ no LIVE manager, matching mainline-watch-boot.mjs's (D1): no nudge is expected either way.
db.insertSession({ id: P.mgrId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: P.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

const KEY = MW.mainlineWatermarkKey(P.projId, "primary");
const watermark = () => MW.parseMainlineWatermark(db.getMeta(KEY));
const mwEvents = () => db.listEventsSince(0, 100000).filter((e) => e.kind === "mainline_moved_outside_loom" && e.detail?.projectId === P.projId);

let seq = 0;
async function addWorker(sessions, tag) {
  const n = `${tag}${++seq}`;
  const taskId = `mwbd-${n}-task-${sfx}`, workerId = `mwbd-${n}-wkr-${sfx}`;
  db.insertTask({ id: taskId, projectId: P.projId, title: `feat(x): change ${n}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(P.repo, P.projId, taskId);
  registerForCleanup(worktreePath);
  fs.writeFileSync(path.join(worktreePath, `${n}.ts`), `export const ${n} = 1;\n`);
  commitAll(worktreePath, `feat(x): change ${n}`, GIT_ID);
  db.insertSession({ id: workerId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: P.mgrId, taskId, worktreePath, branch });
  return { taskId, workerId, worktreePath, branch };
}
const batch = async (sessions, ws) => { const r = await sessions.mergeBatchTracked(P.mgrId, ws.map((w) => w.workerId)); return r.settled && r.ok ? r.value : { __unsettled: r }; };

try {
  // ── seed the watermark with a real, ordinary first landing (branch = MAIN) ─────────────────────────────
  const seedSessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, runGate: async () => PASS, reapWorktreeProcesses: noReap });
  const seed1 = await addWorker(seedSessions, "seed"), seed2 = await addWorker(seedSessions, "seed");
  check("setup: no watermark before the first landing", watermark() === null);
  const seedResult = await batch(seedSessions, [seed1, seed2]);
  check("setup: the first batch lands normally", seedResult.ok === true && seedResult.landed?.length === 2);
  check("setup: the watermark is now stored at branch MAIN", watermark()?.branch === MAIN && watermark()?.sha === canonHead());
  const wBeforeD1 = watermark();

  // ── (D1) RED-FIRST: a divert DURING a batch's own gate run ──────────────────────────────────────────────
  const strayBranch = `mwbd-stray-${sfx}`;
  let diverted = false;
  const d1Sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap,
    runGate: async () => { if (!diverted) { git(P.repo, "checkout", "-q", "-b", strayBranch); diverted = true; } return PASS; },
  });
  const w1 = await addWorker(d1Sessions, "d1a"), w2 = await addWorker(d1Sessions, "d1b");
  const r1 = await batch(d1Sessions, [w1, w2]);
  check("(D1) setup control: the gate's own divert actually ran", diverted === true);
  check("(D1) the batch's OWN pre-existing pin still refuses the fast-forward (unrelated to this card, must not regress)", r1.ok === false && r1.branchDiverted === true);
  check("(D1) mainline's own ref was NOT advanced", git(P.repo, "rev-parse", MAINREF) === wBeforeD1.sha);
  check("(D1) THE FIX: the watermark's branch is NOT re-stamped to the stray branch", watermark()?.branch === MAIN);
  check("(D1) THE FIX: the watermark's sha is UNCHANGED too (never a partial re-stamp)", watermark()?.sha === wBeforeD1.sha);
  const ev1 = mwEvents();
  check("(D1) exactly ONE mainline_moved_outside_loom event, evidence branch-diverted, severity high", ev1.length === 1 && ev1[0].detail.evidence?.join() === "branch-diverted" && ev1[0].detail.severity === "high");
  check("(D1) the event names the expected vs observed branch and the stray tip as suspect", ev1[0].detail.expectedBranch === MAIN && ev1[0].detail.observedBranch === strayBranch && ev1[0].detail.suspectShas?.includes(canonHead()));
  check("(D1) no boot-source marker on a landing-path alert", ev1[0].detail.source === undefined);

  // ── (D2) DEDUPE: a second batch whose gate diverts to the SAME still-live stray branch does not re-alert ──
  const d2Sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap,
    runGate: async () => { git(P.repo, "checkout", "-q", strayBranch); return PASS; },
  });
  // canonical is left on `strayBranch` by (D1)'s own gate divert; put it back on MAIN first so the cut/pin sees a
  // "normal" base, then let THIS batch's own gate divert again onto the SAME stray tip — the (from, to) pair repeats.
  git(P.repo, "checkout", "-q", MAIN);
  const w3 = await addWorker(d2Sessions, "d2a"), w4 = await addWorker(d2Sessions, "d2b");
  const r2 = await batch(d2Sessions, [w3, w4]);
  check("(D2) the batch is refused again by the same pre-existing pin", r2.ok === false && r2.branchDiverted === true);
  check("(D2) the watermark is STILL untouched", watermark()?.branch === MAIN && watermark()?.sha === wBeforeD1.sha);
  check("(D2) DEDUPE: still exactly ONE event for the same (from, to) move", mwEvents().length === 1);
  git(P.repo, "checkout", "-q", MAIN);
  git(P.repo, "branch", "-q", "-D", strayBranch);

  // ── (D3) SELF-CORRECTS: a real landing back on the true mainline branch advances the watermark normally ──
  const d3Sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, runGate: async () => PASS, reapWorktreeProcesses: noReap });
  const w5 = await addWorker(d3Sessions, "d3a"), w6 = await addWorker(d3Sessions, "d3b");
  const r3 = await batch(d3Sessions, [w5, w6]);
  check("(D3) an ordinary batch (no divert) lands normally after the corruption attempt", r3.ok === true && r3.landed?.length === 2);
  check("(D3) advanceMainlineWatermarkForBatch (never touched by this card) correctly advances branch+sha", watermark()?.branch === MAIN && watermark()?.sha === canonHead());
  check("(D3) still exactly ONE event total — a real landing on the expected branch is silent", mwEvents().length === 1);

  // ── (D4) BOOT: the identical branch-mismatch alert through checkMainlineMovesOnBoot ─────────────────────
  const wBeforeD4 = watermark();
  const strayBranch2 = `mwbd-stray-boot-${sfx}`;
  git(P.repo, "checkout", "-q", "-b", strayBranch2);
  const bootSessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, runGate: async () => PASS, reapWorktreeProcesses: noReap });
  const bootNudges = [];
  const origEnqueue = bootSessions.enqueueDurableMessage.bind(bootSessions);
  bootSessions.enqueueDurableMessage = (target, text, ...rest) => { if (String(text).startsWith("[loom:mainline-moved]")) bootNudges.push(text); return origEnqueue(target, text, ...rest); };
  await bootSessions.checkMainlineMovesOnBoot();
  check("(D4) THE FIX at boot too: the watermark is NOT re-stamped to the stray branch", watermark()?.branch === MAIN && watermark()?.sha === wBeforeD4.sha);
  const ev4 = mwEvents();
  check("(D4) exactly ONE new boot-sourced event, evidence branch-diverted, empty managerSessionId", ev4.length === 2 && ev4[1].detail.evidence?.join() === "branch-diverted" && ev4[1].detail.source === "boot" && ev4[1].managerSessionId === "");
  check("(D4) no nudge at boot (no live manager)", bootNudges.length === 0);
  await bootSessions.checkMainlineMovesOnBoot();
  check("(D4) DEDUPE across repeated boot passes on the same unresolved divert", mwEvents().length === 2);
  git(P.repo, "checkout", "-q", MAIN);
  git(P.repo, "branch", "-q", "-D", strayBranch2);
  // D4 leaves its own undelivered marker behind (never cleared — no live manager at boot) for the SAME
  // (from, to) + evidence D5 is about to reproduce (nothing has moved the watermark's sha since D3); clear
  // it first so D5's own divert is not deduped against D4's as "the same move" (dedup itself is D2/D6's own
  // concern, proven there — D5 is about the solo advance-helper guard, a different thing entirely).
  db.deleteMeta(MW.mainlineBootAlertKey(P.projId, "primary"));

  // ── (D5) SOLO: a divert that PREDATES a worker's confirm (no divert during the confirm itself) —
  //        card 2a6a292a round 2's own repro. UPDATED once card d69d4858 round 2 landed: the solo path
  //        now ALSO has its own, SEPARATE branch-pin refusal (mergeBranchLocked's own pre-squash check),
  //        so the squash never even runs here — this scenario's own checks (below) that rely on
  //        `rd5.merged === false` / the watermark staying untouched pass for THAT reason, not because of
  //        `checkMainlineMove`'s own null-on-branch-mismatch guard this scenario originally existed to
  //        prove (round 3, delta review b39e8972 item 2 — proven by reverting ONLY that guard's
  //        `return null` to `return head.tip`: every check above stayed green). (D5b) below calls
  //        `checkMainlineMove` directly, in isolation from d69d4858's own refusal, to actually discriminate it.
  const wBeforeD5 = watermark();
  const strayBranch3 = `mwbd-stray-solo-${sfx}`;
  const preD5Sha = canonHead();
  git(P.repo, "checkout", "-q", "-b", strayBranch3); // same-commit divert, entirely before the worker is even spawned
  const d5Sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, runGate: async () => PASS, reapWorktreeProcesses: noReap });
  const confirmSolo = async (sessions, w) => { const r = await sessions.confirmWorkerMergeTracked(P.mgrId, w.workerId); return r.settled && r.ok ? r.value : { __unsettled: r }; };
  const countBeforeD5 = mwEvents().length;
  const w7 = await addWorker(d5Sessions, "d5a");
  const rd5 = await confirmSolo(d5Sessions, w7);
  check("(D5) setup control: canonical really diverted before the confirm, same commit as the watermark", canonBranch() === strayBranch3 && preD5Sha === wBeforeD5.sha);
  check("(D5) the solo path's OWN branch-pin refusal (card d69d4858) fires: the confirm refuses instead of landing", rd5.merged === false && rd5.branchDiverted === true && rd5.observedBranch === strayBranch3);
  check("(D5) nothing lands anywhere: mainline's own ref untouched", git(P.repo, "rev-parse", MAINREF) === preD5Sha);
  check("(D5) nothing lands anywhere: the stray branch is untouched too (refused before the squash)", git(P.repo, "rev-parse", `refs/heads/${strayBranch3}`) === preD5Sha);
  check("(D5) the watermark's branch stays MAIN — but note nothing landed at all here, so this alone doesn't prove checkMainlineMove's own guard (see D5b)", watermark()?.branch === MAIN);
  check("(D5) the watermark's sha is unchanged too", watermark()?.sha === wBeforeD5.sha);
  const evD5New = mwEvents().slice(countBeforeD5);
  check("(D5) a NEW branch-diverted event fired for this move", evD5New.length === 1 && evD5New[0].detail.evidence.join() === "branch-diverted" && evD5New[0].detail.expectedBranch === MAIN && evD5New[0].detail.observedBranch === strayBranch3);

  // ── (D5b) THE ACTUAL DISCRIMINATOR (round 3, delta review b39e8972 item 2): call `checkMainlineMove`
  //        directly, in isolation from d69d4858's own unrelated branch-pin refusal above — canonical is
  //        STILL diverted onto the same stray branch at the same sha, so this re-exercises the exact
  //        mismatch 2a6a292a's round 2 guard exists to catch. RED-FIRST: revert ONLY that guard's
  //        `return null` (the branch-mismatch arm) to `return head.tip` and this goes red while every
  //        (D5) check above stays green — proving THIS is the check that actually pins the guard.
  const wBeforeD5b = watermark();
  const tipD5b = await d5Sessions.checkMainlineMove({ projectId: P.projId, repoKey: "primary", repoPath: P.repo, managerSessionId: P.mgrId, workerSessionId: w7.workerId, taskId: w7.taskId });
  check("(D5b) checkMainlineMove itself returns null on a branch mismatch (2a6a292a's own guard, not d69d4858's)", tipD5b === null);
  // Round 3 Code Review (reviewer 7497f7cf): a SANITY check, not a discriminator — the branch-mismatch arm
  // never calls `store()` either way, so this can't fail under the C6 revert above (only `tipD5b` can).
  check("(D5b) sanity: the watermark is still untouched by this direct call", watermark()?.branch === wBeforeD5b.branch && watermark()?.sha === wBeforeD5b.sha);
  git(P.repo, "checkout", "-q", MAIN);
  git(P.repo, "branch", "-q", "-D", strayBranch3);

  // ── (D6) MARKER SHARING: an UNDELIVERED sha-level alert marker (nudgedAt:null, a DIFFERENT evidence
  //        kind) must not be clobbered by a later branch-diverted detection that happens to share the
  //        same (from, to) pair — a same-commit checkout never moves the tip, so this collision is real ─
  const wBeforeD6 = watermark();
  const alertKeyD6 = MW.mainlineBootAlertKey(P.projId, "primary");
  db.setMeta(alertKeyD6, JSON.stringify({ branch: MAIN, from: wBeforeD6.sha, to: wBeforeD6.sha, evidence: ["reflog-raw-write"], suspectShas: [wBeforeD6.sha], nudgedAt: null }));
  const strayBranch4 = `mwbd-stray-d6-${sfx}`;
  let divertedD6 = false;
  const d6Sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap,
    runGate: async () => { if (!divertedD6) { git(P.repo, "checkout", "-q", "-b", strayBranch4); divertedD6 = true; } return PASS; },
  });
  const countBeforeD6 = mwEvents().length;
  const w8 = await addWorker(d6Sessions, "d6a"), w9 = await addWorker(d6Sessions, "d6b");
  const r6 = await batch(d6Sessions, [w8, w9]);
  check("(D6) setup control: the gate's own divert ran, on the SAME commit as the synthetic marker's (from,to)", divertedD6 === true && git(P.repo, "rev-parse", "HEAD") === wBeforeD6.sha);
  check("(D6) the batch's OWN pre-existing pin still refuses (unrelated to this card)", r6.ok === false && r6.branchDiverted === true);
  const evD6New = mwEvents().slice(countBeforeD6);
  check("(D6) a NEW durable event fired for the divert even though (from,to) coincided with the undelivered marker's own — the evidence kind discriminates", evD6New.length === 1 && evD6New[0].detail.evidence.join() === "branch-diverted");
  const markerAfterD6 = MW.parseMainlineBootAlert(db.getMeta(alertKeyD6));
  check("(D6) THE FIX: the undelivered PRIOR marker's own evidence is preserved, never clobbered by the divert", markerAfterD6?.evidence.join() === "reflog-raw-write" && markerAfterD6?.nudgedAt === null);
  check("(D6) the watermark itself is still untouched throughout", watermark()?.branch === MAIN && watermark()?.sha === wBeforeD6.sha);
  git(P.repo, "checkout", "-q", MAIN);
  git(P.repo, "branch", "-q", "-D", strayBranch4);
  db.deleteMeta(alertKeyD6);

  // ── (D7) THE NUDGE TEXT for a divert names expected/observed and the remedy (pure function, no git) ──
  const nudgeTextD7 = MW.mainlineMovedNudgeText({ branch: "stray-branch-name", repoKey: "primary", from: "a".repeat(40), to: "b".repeat(40), evidence: ["branch-diverted"], suspectShas: ["b".repeat(40)], atBoot: false, expectedBranch: "main" });
  check("(D7) the divert nudge names the OBSERVED (stray) branch and the EXPECTED (watermark) branch", nudgeTextD7.includes("stray-branch-name") && nudgeTextD7.includes('"main"'));
  check("(D7) the divert nudge gives a checkout remedy and a reset-for-rename remedy naming the real route, never the generic sha-level 'git log A..B' / 'bypass the merge gate' framing", /check out "main"/.test(nudgeTextD7) && nudgeTextD7.includes("/api/projects/:id/mainline-watermark/reset") && !/git log/.test(nudgeTextD7) && !/bypass of the merge gate/.test(nudgeTextD7));
  const nudgeTextD7boot = MW.mainlineMovedNudgeText({ branch: "stray-branch-name", repoKey: "primary", from: "a".repeat(40), to: "b".repeat(40), evidence: ["branch-diverted"], suspectShas: ["b".repeat(40)], atBoot: true, expectedBranch: "main" });
  check("(D7) atBoot wording differs (found when the daemon started) while the remedy stays the same", nudgeTextD7boot.includes("found when the daemon started") && nudgeTextD7boot.includes('"main"'));
} finally {
  try { db.close(); } catch { /* already closed */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a transient checkout divert, whether during a batch's gate, at boot, or predating a solo/batch landing's own reference point, never re-stamps the mainline watermark's branch (or sha); it alerts once (evidence branch-diverted, naming expected/observed and a checkout/rebind remedy), dedupes on the same move without clobbering an unrelated undelivered marker, and a real landing back on the true mainline branch still self-corrects normally."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
