import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card c013e8a5 — concurrency guards closing three races in the mainline-watch machinery, plus the
// repeated-first-sight-resolver-failure notice carried in from 787dd2a7 round 2's own follow-up. REAL git,
// direct calls into the private methods under test (mirroring mainline-watch.mjs's own (S7d)/(S7e)/(D5b)
// style), each injected via the SAME seams existing tests already use (`mainlineHeadReader`,
// `resolveMainlineBranchStateReader`).
//
//   (R1) checkMainlineMove: a reset that runs DURING the head-read await must never let the check resume
//        with the stale (pre-reset) watermark and file a divert/alert describing the pre-reset branch.
//   (R2) advanceMainlineWatermark / its batch twin: a concurrent writer (standing in for boot's own
//        first-sight CAS seed) that sets W DURING the first-sight resolver's own await must never be
//        clobbered by this call's own, now-stale decision.
//   (R3) advanceMainlineWatermark / its batch twin: a repoPath REBIND that runs DURING that same await
//        must never let this call seed W with the OLD repo's head data under a key that now names the
//        NEW repo. (R2's CAS alone does not catch this: a true first-sight rebind never touches W, since
//        there was nothing stored to reset — a SEPARATE repoPath reconfirmation is required.)
//   (defer) a repeated TRANSIENT `resolveMainlineBranchState` failure files exactly ONE addressed
//        low-severity notice at the 3rd consecutive occurrence (never before, never silently repeating
//        after), the streak resets on any SETTLED read, and — Code Review ruling — the notice actually
//        reaches an addressable manager (never a bare unaddressed event) with its OWN wording, never the
//        generic sha-level "bypass of the merge gate" framing.
//
// Round 2 (gen 392, from Code Review 2af61378) adds five more:
//   (R4) checkMainlineMove: a reset DURING the facts-read await (the SECOND await the sha-level path makes,
//        past R1's own CAS) must also never let the check act on the pre-reset watermark.
//   (R5) checkMainlineMove's boot first-sight "allow" path lacked the repoPath reconfirmation
//        advanceMainlineWatermark already has; a rebind during the resolver await must skip the store.
//   (notice-reorder) advanceMainlineWatermark / its batch twin: the seeded-stray NOTICE must fire only
//        AFTER the R2/R3 guards pass, never before — firing it first told a manager a seed happened on a
//        pass that then skipped it.
//   (defer-unbounded) the defer-streak notice must fire exactly ONCE at the threshold, never re-append on
//        every later attempt — the old `>=` test re-fired it forever whenever the marker slot was held by
//        an unrelated undelivered alert (so its own dedupe marker could never get written).
//   (defer-deliver) a boot-sourced defer notice must reach a LIVE manager immediately via
//        `deliverPendingBootAlerts`, not wait on a later `onOrchestrationMcpFirstSeen`.
//
// Run: 1) build daemon (pnpm build), 2) LOOM_CODEX_BIN=<nonexistent> node test/mainline-watch-race-guards.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), `loom-mwrace-no-such-codex-bin-${Date.now()}-${process.pid}`);
useOwnLoomHome("loom-mw-race-home-");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const MW = await import("../dist/git/mainline-watch.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const IDENT = { GIT_AUTHOR_NAME: "mwrace", GIT_AUTHOR_EMAIL: "mwrace@loom", GIT_COMMITTER_NAME: "mwrace", GIT_COMMITTER_EMAIL: "mwrace@loom" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENT }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const GIT_ID = "-c user.email=mwrace@loom -c user.name=mwrace";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const noReap = async () => ({ killedPids: [] });
// `enqueueStdin` returns a shaped result (never bare `undefined`) so `enqueueDurableMessage`'s own
// `r.delivered` read never throws — needed for the round-2 (defer-deliver) test, which reaches a REAL
// delivery attempt (a live manager) through `deliverPendingBootAlerts`, unlike every other test here,
// which either has no live manager or has its own enqueueDurableMessage failure already swallowed deeper
// (recordFirstSightResolveDeferred's own try/catch).
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; } };

/** A real two-commit repo (so `HEAD~1` is a valid parent, matching advanceMainlineWatermark's own first-parent check). */
function mkRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mwrace-${tag}-repo-${sfx}`);
  fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# ${tag}\n`);
  git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "mwrace@loom"); git(repo, "config", "user.name", "mwrace");
  commitAll(repo, "init", GIT_ID);
  fs.writeFileSync(path.join(repo, "second.txt"), "second\n"); git(repo, "add", "second.txt"); git(repo, "commit", "-q", "-m", "feat(x): second");
  return repo;
}

/** One "daemon": a Db + a SessionService; `nudges` records every mainline nudge text regardless of delivery outcome. */
function boot() {
  const db = new Db();
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, runGate: async () => ({ passed: true, steps: [] }), reapWorktreeProcesses: noReap });
  const nudges = [];
  const orig = sessions.enqueueDurableMessage.bind(sessions);
  sessions.enqueueDurableMessage = (target, text, ...rest) => { if (String(text).startsWith("[loom:mainline-moved]")) nudges.push(text); return orig(target, text, ...rest); };
  return { db, sessions, nudges };
}

const mwEvents = (d, projId) => d.db.listEventsSince(0, 100000).filter((e) => e.kind === "mainline_moved_outside_loom" && e.detail?.projectId === projId);
const watermark = (d, projId, repoKey = "primary") => MW.parseMainlineWatermark(d.db.getMeta(MW.mainlineWatermarkKey(projId, repoKey)));

function setupProject(d, tag, repo) {
  const projId = `mwrace-${tag}-proj-${sfx}`, agentId = `mwrace-${tag}-agent-${sfx}`, mgrId = `mwrace-${tag}-mgr-${sfx}`;
  d.db.insertProject({ id: projId, name: tag, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  d.db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  d.db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  return { projId, agentId, mgrId };
}

/** Same as {@link setupProject}, but the manager is `processState: "live"` — for the round-2 (defer-deliver)
 *  test, which needs `deliverPendingBootAlerts` (`db.listLiveManagersInProject`) to find someone addressable. */
function setupProjectLiveManager(d, tag, repo) {
  const projId = `mwrace-${tag}-proj-${sfx}`, agentId = `mwrace-${tag}-agent-${sfx}`, mgrId = `mwrace-${tag}-mgr-${sfx}`;
  d.db.insertProject({ id: projId, name: tag, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  d.db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  d.db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  return { projId, agentId, mgrId };
}

try {
  // ══════════════════════ (R1) checkMainlineMove vs a reset mid-await ══════════════════════
  {
    const repo = mkRepo("r1");
    const d = boot();
    const { projId, mgrId } = setupProject(d, "r1", repo);
    await d.sessions.checkMainlineMovesOnBoot(); // true first sight: silent seed
    const wBefore = watermark(d, projId);
    check("(R1) setup: first sight seeded W silently", wBefore !== null && mwEvents(d, projId).length === 0);
    const MAIN = git(repo, "rev-parse", "--abbrev-ref", "HEAD");
    git(repo, "checkout", "-q", "-b", "trunk"); // git-level rename, same commit (2a6a292a round 3's own scenario)

    const realReader = d.sessions.mainlineHeadReader;
    let resetRanDuringAwait = false;
    d.sessions.mainlineHeadReader = async (repoPath, ms) => {
      const r = d.db.resetMainlineWatermark(projId, "primary"); // the owner's concurrent reset, landing DURING this await
      resetRanDuringAwait = r.reset === true;
      return realReader(repoPath, ms);
    };
    const countBefore = mwEvents(d, projId).length;
    const tip = await d.sessions.checkMainlineMove({ projectId: projId, repoKey: "primary", repoPath: repo, managerSessionId: mgrId, workerSessionId: null, taskId: null });
    d.sessions.mainlineHeadReader = realReader;
    check("(R1) setup control: the reset genuinely ran during the head-read await", resetRanDuringAwait === true);
    check("(c013e8a5) (R1) THE FIX: checkMainlineMove returns null rather than acting on the stale watermark", tip === null);
    // the reset itself ALWAYS files its own "human-reset" audit event (db.resetMainlineWatermark) — the
    // bug this card closes is a SECOND, stale "branch-diverted" event on top of that one, never this.
    const evAfterR1 = mwEvents(d, projId).slice(countBefore);
    check("(c013e8a5) (R1) THE FIX: ONLY the reset's own human-reset audit event exists — no stale divert/alert event filed off the pre-reset watermark", evAfterR1.length === 1 && evAfterR1[0].detail.source === "human-reset");
    check("(c013e8a5) (R1) THE FIX: no stale nudge telling the manager to undo the reset was enqueued", d.nudges.length === 0);
    check("(R1) the reset's own effect stands: W is absent, exactly as the reset left it", d.db.getMeta(MW.mainlineWatermarkKey(projId, "primary")) === undefined);
    git(repo, "checkout", "-q", MAIN);
    d.db.close();
  }

  // ══════════════════════ (R2) advanceMainlineWatermark CAS vs a concurrent seed mid-await ══════════════════════
  {
    const repo = mkRepo("r2");
    const d = boot();
    const { projId, mgrId } = setupProject(d, "r2", repo);
    const key = MW.mainlineWatermarkKey(projId, "primary");
    check("(R2) setup: no watermark yet (true first sight)", watermark(d, projId) === null);
    const parentOfHead = git(repo, "rev-parse", "HEAD~1");
    const concurrentWinner = { branch: "concurrent-winner-branch", sha: "c".repeat(40) };

    const realResolver = d.sessions.resolveMainlineBranchStateReader;
    d.sessions.resolveMainlineBranchStateReader = async () => {
      d.db.setMeta(key, JSON.stringify(concurrentWinner)); // a concurrent writer wins the race DURING this await
      return { state: "no-default" }; // this call's OWN decision would otherwise seed unconditionally
    };
    await d.sessions.advanceMainlineWatermark(projId, "primary", repo, parentOfHead, mgrId, null, null);
    d.sessions.resolveMainlineBranchStateReader = realResolver;
    check("(c013e8a5) (R2) THE FIX: the concurrent writer's value survives — this call's own stale decision never clobbers it", watermark(d, projId)?.branch === concurrentWinner.branch && watermark(d, projId)?.sha === concurrentWinner.sha);
    d.db.close();
  }
  {
    const repo = mkRepo("r2b");
    const d = boot();
    const { projId, mgrId } = setupProject(d, "r2b", repo);
    const key = MW.mainlineWatermarkKey(projId, "primary");
    const headTip = git(repo, "rev-parse", "HEAD");
    const concurrentWinner = { branch: "concurrent-winner-branch-batch", sha: "d".repeat(40) };
    const realResolver = d.sessions.resolveMainlineBranchStateReader;
    d.sessions.resolveMainlineBranchStateReader = async () => { d.db.setMeta(key, JSON.stringify(concurrentWinner)); return { state: "no-default" }; };
    await d.sessions.advanceMainlineWatermarkForBatch(projId, "primary", repo, headTip, headTip, headTip, mgrId);
    d.sessions.resolveMainlineBranchStateReader = realResolver;
    check("(c013e8a5) (R2-batch) THE FIX: the concurrent writer's value survives for the batch twin too", watermark(d, projId)?.branch === concurrentWinner.branch && watermark(d, projId)?.sha === concurrentWinner.sha);
    d.db.close();
  }

  // ══════════════════════ (R3) advanceMainlineWatermark vs a repoPath rebind mid-await ══════════════════════
  {
    const repo = mkRepo("r3-old");
    const repoNew = mkRepo("r3-new");
    const d = boot();
    const { projId, mgrId } = setupProject(d, "r3", repo);
    const key = MW.mainlineWatermarkKey(projId, "primary");
    check("(R3) setup: no watermark yet", watermark(d, projId) === null);
    const parentOfHead = git(repo, "rev-parse", "HEAD~1");

    const realResolver = d.sessions.resolveMainlineBranchStateReader;
    let rebindRan = false;
    d.sessions.resolveMainlineBranchStateReader = async () => {
      d.db.updateProject(projId, { repoPath: repoNew }); // a repoPath rebind landing DURING this await
      rebindRan = true;
      return { state: "no-default" };
    };
    await d.sessions.advanceMainlineWatermark(projId, "primary", repo, parentOfHead, mgrId, null, null);
    d.sessions.resolveMainlineBranchStateReader = realResolver;
    check("(R3) setup control: the rebind genuinely ran during the await", rebindRan === true);
    check("(c013e8a5) (R3) THE FIX: the key (now naming the NEW repo) is never seeded with the OLD repo's head data", d.db.getMeta(key) === undefined);
    d.db.close();
  }
  {
    const repo = mkRepo("r3b-old");
    const repoNew = mkRepo("r3b-new");
    const d = boot();
    const { projId, mgrId } = setupProject(d, "r3b", repo);
    const key = MW.mainlineWatermarkKey(projId, "primary");
    const headTip = git(repo, "rev-parse", "HEAD");
    let rebindRan = false;
    const realResolver = d.sessions.resolveMainlineBranchStateReader;
    d.sessions.resolveMainlineBranchStateReader = async () => { d.db.updateProject(projId, { repoPath: repoNew }); rebindRan = true; return { state: "no-default" }; };
    await d.sessions.advanceMainlineWatermarkForBatch(projId, "primary", repo, headTip, headTip, headTip, mgrId);
    d.sessions.resolveMainlineBranchStateReader = realResolver;
    check("(R3-batch) setup control: the rebind genuinely ran during the await", rebindRan === true);
    check("(c013e8a5) (R3-batch) THE FIX: the key is never seeded with the OLD repo's head data for the batch twin either", d.db.getMeta(key) === undefined);
    d.db.close();
  }

  // ══════════════════════ (defer) repeated transient resolver failure ══════════════════════
  {
    const repo = mkRepo("defer");
    const d = boot();
    const { projId } = setupProject(d, "defer", repo);
    check("(defer) setup: no watermark yet", watermark(d, projId) === null);
    const realResolver = d.sessions.resolveMainlineBranchStateReader;
    d.sessions.resolveMainlineBranchStateReader = async () => ({ state: "failed" });

    check("(c013e8a5) (defer) THE THRESHOLD is 3 (named, not re-derived)", MW.MAINLINE_FIRST_SIGHT_DEFER_ALERT_THRESHOLD === 3);

    await d.sessions.checkMainlineMovesOnBoot();
    await d.sessions.checkMainlineMovesOnBoot();
    check("(defer) setup control: the watermark stays unseeded through repeated transient failures", watermark(d, projId) === null);
    check("(c013e8a5) (defer) below the threshold: no event yet", mwEvents(d, projId).length === 0);
    check("(c013e8a5) (defer) below the threshold: no nudge yet", d.nudges.length === 0);

    await d.sessions.checkMainlineMovesOnBoot(); // the 3rd consecutive defer
    const ev = mwEvents(d, projId);
    check("(c013e8a5) (defer) THE FIX: the 3rd consecutive defer files exactly ONE low-severity event", ev.length === 1 && ev[0].detail.severity === "low" && ev[0].detail.evidence?.join() === "first-sight-resolve-deferred");

    await d.sessions.checkMainlineMovesOnBoot();
    await d.sessions.checkMainlineMovesOnBoot();
    check("(c013e8a5) (defer) past the threshold: no re-fire for the unchanged fact", mwEvents(d, projId).length === 1);

    d.sessions.resolveMainlineBranchStateReader = realResolver;
    await d.sessions.checkMainlineMovesOnBoot(); // a SETTLED read (this repo has no remote ⇒ "no-default" ⇒ allow ⇒ seeds)
    check("(defer) a settled read seeds the watermark normally once it succeeds", watermark(d, projId) !== null);
    d.db.close();
  }

  // the streak RESETS on any settled read, on a FRESH project so the reset itself never seeds (a BOOT-path
  // "decline" never seeds — 787dd2a7 round 2 — unlike a LANDING decline, so the absent branch stays live)
  {
    const repo = mkRepo("defer-reset");
    const d = boot();
    const { projId } = setupProject(d, "defer-reset", repo);
    d.sessions.resolveMainlineBranchStateReader = async () => ({ state: "failed" });
    await d.sessions.checkMainlineMovesOnBoot();
    await d.sessions.checkMainlineMovesOnBoot();
    const countAfterTwoDefers = mwEvents(d, projId).length;
    check("(defer-reset) setup control: 2 defers alone file nothing", countAfterTwoDefers === 0);

    d.sessions.resolveMainlineBranchStateReader = async () => ({ state: "resolved", branch: "some-other-default-branch" }); // a SETTLED decline
    await d.sessions.checkMainlineMovesOnBoot();
    check("(defer-reset) setup control: a boot-path decline never seeds either (unchanged by this card)", watermark(d, projId) === null);
    const countAfterDecline = mwEvents(d, projId).length;
    check("(defer-reset) setup control: the decline itself files its OWN (first-sight-declined) event", countAfterDecline === countAfterTwoDefers + 1 && mwEvents(d, projId).at(-1).detail.evidence?.join() === "first-sight-declined");

    d.sessions.resolveMainlineBranchStateReader = async () => ({ state: "failed" });
    await d.sessions.checkMainlineMovesOnBoot();
    await d.sessions.checkMainlineMovesOnBoot();
    check("(c013e8a5) (defer-reset) THE FIX: 2 defers after a reset-breaking settled read do NOT fire — the streak restarted at 0, now below threshold again", mwEvents(d, projId).length === countAfterDecline);
    await d.sessions.checkMainlineMovesOnBoot(); // the 3rd in the NEW streak
    const evAfterThird = mwEvents(d, projId);
    check("(c013e8a5) (defer-reset) THE FIX: the 3rd defer in the NEW streak fires", evAfterThird.length === countAfterDecline + 1 && evAfterThird.at(-1).detail.evidence?.join() === "first-sight-resolve-deferred");
    d.db.close();
  }

  // the notice is ACTUALLY DELIVERED (never a bare unaddressed event) when a manager is addressable — the
  // LANDING path threads a real managerSessionId through (ruling: route it exactly like
  // recordFirstSightSeededStray, never recordFirstSightDeclined's passive immediately-stamped marker)
  {
    const repo = mkRepo("defer-land");
    const d = boot();
    const { projId, mgrId } = setupProject(d, "defer-land", repo);
    const parentOfHead = git(repo, "rev-parse", "HEAD~1");
    const realResolver = d.sessions.resolveMainlineBranchStateReader;
    d.sessions.resolveMainlineBranchStateReader = async () => ({ state: "failed" });
    await d.sessions.advanceMainlineWatermark(projId, "primary", repo, parentOfHead, mgrId, null, null);
    await d.sessions.advanceMainlineWatermark(projId, "primary", repo, parentOfHead, mgrId, null, null);
    check("(defer-land) below threshold: no nudge yet", d.nudges.length === 0);
    await d.sessions.advanceMainlineWatermark(projId, "primary", repo, parentOfHead, mgrId, null, null); // 3rd
    d.sessions.resolveMainlineBranchStateReader = realResolver;
    check("(c013e8a5) (defer-land) THE FIX (Code Review ruling): the 3rd consecutive defer on the LANDING path ACTUALLY DELIVERS a nudge to the addressable manager", d.nudges.length === 1 && d.nudges[0].includes("first-sight-resolve-deferred"));
    check("(c013e8a5) (defer-land) the nudge carries its OWN wording, never the generic bypass framing", !/bypass of the merge gate/.test(d.nudges[0]) && /git remote set-head origin -a/.test(d.nudges[0]));
    check("(defer-land) the watermark is STILL unseeded (a defer never seeds)", watermark(d, projId) === null);
    d.db.close();
  }

  // ══════════════════════ (R4) checkMainlineMove vs a reset mid-facts-read-await (round 2, item 4) ══════════════════════
  {
    const repo = mkRepo("r4");
    const d = boot();
    const { projId, mgrId } = setupProject(d, "r4", repo);
    await d.sessions.checkMainlineMovesOnBoot(); // true first sight: silent seed
    check("(R4) setup: first sight seeded W silently", watermark(d, projId) !== null && mwEvents(d, projId).length === 0);
    // a second commit so head.tip differs from W's sha while the branch still agrees — only this shape
    // reaches the facts-read await at all (a branch mismatch or an unchanged tip both return earlier).
    fs.writeFileSync(path.join(repo, "r4-extra.txt"), "extra\n");
    git(repo, "add", "r4-extra.txt"); git(repo, "commit", "-q", "-m", "feat(x): r4 extra");

    const realFactsReader = d.sessions.mainlineFactsReader;
    let resetRanDuringFactsAwait = false;
    d.sessions.mainlineFactsReader = async (repoPath, sha, head, ms, deadlineAt) => {
      const r = d.db.resetMainlineWatermark(projId, "primary"); // the owner's concurrent reset, landing DURING this await
      resetRanDuringFactsAwait = r.reset === true;
      return realFactsReader(repoPath, sha, head, ms, deadlineAt);
    };
    const countBefore = mwEvents(d, projId).length;
    const tip = await d.sessions.checkMainlineMove({ projectId: projId, repoKey: "primary", repoPath: repo, managerSessionId: mgrId, workerSessionId: null, taskId: null });
    d.sessions.mainlineFactsReader = realFactsReader;
    check("(R4) setup control: the reset genuinely ran during the facts-read await", resetRanDuringFactsAwait === true);
    check("(c013e8a5 r2) (R4) THE FIX: checkMainlineMove returns null rather than acting on the stale watermark", tip === null);
    const evAfterR4 = mwEvents(d, projId).slice(countBefore);
    check("(c013e8a5 r2) (R4) THE FIX: ONLY the reset's own human-reset audit event exists — no stale alert/unverifiable event filed off the pre-reset watermark", evAfterR4.length === 1 && evAfterR4[0].detail.source === "human-reset");
    check("(c013e8a5 r2) (R4) THE FIX: no stale nudge was enqueued off the pre-reset watermark", d.nudges.length === 0);
    check("(R4) the reset's own effect stands: W is absent, exactly as the reset left it", d.db.getMeta(MW.mainlineWatermarkKey(projId, "primary")) === undefined);
    d.db.close();
  }

  // ══════════════════════ (R5) checkMainlineMove boot first-sight "allow" vs a repoPath rebind mid-await (round 2, item 5) ══════════════════════
  {
    const repo = mkRepo("r5-old");
    const repoNew = mkRepo("r5-new");
    const d = boot();
    const { projId } = setupProject(d, "r5", repo);
    const key = MW.mainlineWatermarkKey(projId, "primary");
    check("(R5) setup: no watermark yet (true first sight)", watermark(d, projId) === null);

    const realResolver = d.sessions.resolveMainlineBranchStateReader;
    let rebindRan = false;
    d.sessions.resolveMainlineBranchStateReader = async () => {
      d.db.updateProject(projId, { repoPath: repoNew }); // a repoPath rebind landing DURING this await
      rebindRan = true;
      return { state: "no-default" }; // "allow": no resolvable default disagrees
    };
    const tip = await d.sessions.checkMainlineMove({ projectId: projId, repoKey: "primary", repoPath: repo, managerSessionId: null, workerSessionId: null, taskId: null, source: "boot" });
    d.sessions.resolveMainlineBranchStateReader = realResolver;
    check("(R5) setup control: the rebind genuinely ran during the resolver await", rebindRan === true);
    check("(c013e8a5 r2) (R5) THE FIX: the key (now naming the NEW repo) is never seeded with the OLD repo's head data", d.db.getMeta(key) === undefined);
    check("(R5) checkMainlineMove still returns the observed tip (the repoPath mismatch skips ONLY the store)", tip !== null);
    d.db.close();
  }

  // ══════════════════════ (notice-reorder) the seeded-stray notice fires only AFTER the CAS/repoPath guards pass (round 2, item 2) ══════════════════════
  {
    const repo = mkRepo("nr-r2");
    const d = boot();
    const { projId, mgrId } = setupProject(d, "nr-r2", repo);
    const key = MW.mainlineWatermarkKey(projId, "primary");
    const parentOfHead = git(repo, "rev-parse", "HEAD~1");
    check("(notice-reorder-R2) setup: no watermark yet", watermark(d, projId) === null);

    const concurrentWinner = { branch: "concurrent-winner-nr", sha: "f".repeat(40) };
    const realResolver = d.sessions.resolveMainlineBranchStateReader;
    d.sessions.resolveMainlineBranchStateReader = async () => {
      d.db.setMeta(key, JSON.stringify(concurrentWinner)); // a concurrent writer wins the race DURING this await
      return { state: "resolved", branch: "some-other-default-nr" }; // "decline": this call's own default disagrees
    };
    await d.sessions.advanceMainlineWatermark(projId, "primary", repo, parentOfHead, mgrId, null, null);
    d.sessions.resolveMainlineBranchStateReader = realResolver;
    check("(notice-reorder-R2) THE FIX: the concurrent writer's value survives", watermark(d, projId)?.branch === concurrentWinner.branch);
    check("(c013e8a5 r2) (notice-reorder-R2) THE FIX: no seeded-stray event or nudge was filed — the CAS skipped the notice along with the store", mwEvents(d, projId).length === 0 && d.nudges.length === 0);
    d.db.close();
  }
  {
    const repo = mkRepo("nr-r3-old");
    const repoNew = mkRepo("nr-r3-new");
    const d = boot();
    const { projId, mgrId } = setupProject(d, "nr-r3", repo);
    const key = MW.mainlineWatermarkKey(projId, "primary");
    const parentOfHead = git(repo, "rev-parse", "HEAD~1");

    const realResolver = d.sessions.resolveMainlineBranchStateReader;
    let rebindRan = false;
    d.sessions.resolveMainlineBranchStateReader = async () => {
      d.db.updateProject(projId, { repoPath: repoNew }); // a repoPath rebind landing DURING this await
      rebindRan = true;
      return { state: "resolved", branch: "some-other-default-nr3" }; // "decline"
    };
    await d.sessions.advanceMainlineWatermark(projId, "primary", repo, parentOfHead, mgrId, null, null);
    d.sessions.resolveMainlineBranchStateReader = realResolver;
    check("(notice-reorder-R3) setup control: the rebind genuinely ran during the await", rebindRan === true);
    check("(c013e8a5 r2) (notice-reorder-R3) THE FIX: the key is never seeded, and no seeded-stray event or nudge was filed", d.db.getMeta(key) === undefined && mwEvents(d, projId).length === 0 && d.nudges.length === 0);
    d.db.close();
  }

  // ══════════════════════ (defer-unbounded) THE FIX: fire once at the threshold, never re-append past it
  // while the marker slot is held by an unrelated undelivered alert (round 2, item 3) ══════════════════════
  {
    const repo = mkRepo("defer-unbounded");
    const d = boot();
    const { projId, mgrId } = setupProject(d, "defer-unbounded", repo);
    const alertKey = MW.mainlineBootAlertKey(projId, "primary");
    // an UNRELATED undelivered marker already occupies the slot (e.g. a branch-diverted alert nobody has read)
    d.db.setMeta(alertKey, JSON.stringify({ branch: "unrelated-branch", from: "a".repeat(40), to: "b".repeat(40), evidence: ["branch-diverted"], suspectShas: [], expectedBranch: "main", source: "landing", nudgedAt: null }));
    const parentOfHead = git(repo, "rev-parse", "HEAD~1");
    d.sessions.resolveMainlineBranchStateReader = async () => ({ state: "failed" });
    for (let i = 0; i < 5; i++) await d.sessions.advanceMainlineWatermark(projId, "primary", repo, parentOfHead, mgrId, null, null);
    const ev = mwEvents(d, projId).filter((e) => e.detail.evidence?.includes("first-sight-resolve-deferred"));
    check("(c013e8a5 r2) (defer-unbounded) THE FIX: exactly ONE defer notice fires across 5 consecutive attempts past the threshold, even though the marker slot stays held by the unrelated alert", ev.length === 1);
    check("(defer-unbounded) setup control: the unrelated marker's own slot really is still undelivered (never overwritten)", MW.parseMainlineBootAlert(d.db.getMeta(alertKey))?.evidence?.join() === "branch-diverted");
    d.db.close();
  }

  // ══════════════════════ (defer-deliver) THE FIX: a boot-sourced defer notice is delivered immediately
  // when a manager is live, never waiting on a later onOrchestrationMcpFirstSeen (round 2, item 1) ══════════════════════
  {
    const repo = mkRepo("defer-deliver");
    const d = boot();
    const { projId } = setupProjectLiveManager(d, "defer-deliver", repo);
    d.sessions.resolveMainlineBranchStateReader = async () => ({ state: "failed" });
    await d.sessions.checkMainlineMovesOnBoot();
    await d.sessions.checkMainlineMovesOnBoot();
    check("(defer-deliver) below threshold: no nudge yet", d.nudges.length === 0);
    await d.sessions.checkMainlineMovesOnBoot(); // the 3rd consecutive defer, at boot
    check("(c013e8a5 r2) (defer-deliver) THE FIX: the boot-sourced notice reaches the LIVE manager's queue immediately, via deliverPendingBootAlerts — never waiting on a later onOrchestrationMcpFirstSeen", d.nudges.length === 1 && d.nudges[0].includes("first-sight-resolve-deferred"));
    d.db.close();
  }

  // ══════════════════════ pure-function: the new evidence tag's OWN wording ══════════════════════
  {
    const text = MW.mainlineMovedNudgeText({ branch: "some-branch", repoKey: "primary", from: "", to: "", evidence: ["first-sight-resolve-deferred"], suspectShas: [], atBoot: false });
    check("(c013e8a5) (nudge-text) first-sight-resolve-deferred gets its OWN wording", text.includes("first-sight-resolve-deferred") && text.includes("some-branch"));
    check("(c013e8a5) (nudge-text) never the generic bypass framing or the misleading git-log-range instruction", !/bypass of the merge gate/.test(text) && !/git log --oneline/.test(text));
    check("(c013e8a5) (nudge-text) names the real git-health remedy", /git remote set-head origin -a/.test(text));
  }
} catch (err) {
  console.error(err);
  failures++;
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a reset/rebind landing mid-await never lets checkMainlineMove or advanceMainlineWatermark{,ForBatch} act on stale state (R1/R2/R3/R4/R5, solo and batch); the seeded-stray notice only fires after its own guards pass; a repeated transient first-sight resolver failure files exactly one addressed low-severity notice at the 3rd consecutive occurrence (never re-appending past it), resets its streak on any settled read, and actually reaches an addressable manager — at boot immediately via deliverPendingBootAlerts, on a landing with its own wording — never the generic bypass framing."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
