import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card aa7677fa round 2 (decision record 2a6a292a round 20) — Code Review ead08b1c found a BLOCKING Major
// in round 19's own fix: Loom's OWN advance-skip lag now causes a PERMANENT FALSE FREEZE. L1 lands
// (trust=L1); L2's tripwire fails open once (checkMainlineMove returns null — a reader deadline, a
// throw, an unreadable W, a CAS miss), so L2 lands normally but trust stays at L1 (advanceMainlineWatermark
// is never even called, since mainlineCheckedTip is null); L3 is an entirely ORDINARY landing, but its own
// checkedTip is now L2 (the live tip), which mismatches trust=L1 — round 19's exact-match-only gate froze
// trust there PERMANENTLY, filing a HIGH alert telling the owner it looks like a manual commit or a
// forgery, even though EVERY commit involved was a genuine Loom landing.
//
// FIX: a Loom-OWNED ledger (`mainline_landed_commits`, Db.recordMainlineLandedCommit / .isMainlineLedgerReachable
// — see that table's own CREATE TABLE doc in db.ts). Written UNCONDITIONALLY right after a squash/ff
// succeeds — independent of the tripwire's own verdict — so `advanceMainlineWatermark{,ForBatch}` can
// additionally advance trust when `checkedTip` is reachable from the EXISTING trust record by walking
// `tip -> base -> base -> ...` through rows ONLY Loom's own merge code ever writes. A forged commit never
// gets a row, so a walk through one still breaks and still freezes — the ledger closes the Loom-caused lag
// without reopening the git-derived-classification hole round 9 closed.
//
//   (LAG-SOLO) checkMainlineMove fails open ONCE (an injected `mainlineHeadReader` throw) on an otherwise
//       ORDINARY solo landing (L2): L2 still lands, writes its own ledger row, but neither W nor trust
//       advance for it (mainlineCheckedTip is null, so advanceMainlineWatermark is never even called). A
//       THIRD, ordinary landing (L3) then walks the ledger from its own checkedTip (L2's tip) back to the
//       still-frozen trust (L1's tip) and advances cleanly — NO freeze, NO alert.
//   (LAG-BATCH) the same shape through a real mergeBatchTracked: L2's batch gate-closure checkMainlineMove
//       call fails open (same injected head-reader throw), so `batchCheckedTip` stays null/falsy and
//       `advanceMainlineWatermarkForBatch`'s own first guard returns before touching anything — but the
//       ledger row (written unconditionally, keyed on `baseMainSha` directly, no git call needed) still
//       lets L3 walk through it.
//   (LAG-ADVANCE-SKIP) feeder (b) from the Code Review: `advanceMainlineWatermark` returning early on its
//       OWN internal guard (here: the TOCTOU first-parent mismatch), NOT because checkMainlineMove failed.
//       No test seam reaches this guard end-to-end through a real landing (same limitation (S7b)/(S7d)/
//       (S7e) in mainline-watch.mjs already accept — see their own comments), so this reproduces the exact
//       EXTERNALLY-OBSERVABLE state that guard leaves behind: a real commit lands, a ledger row for it
//       exists (seeded here exactly as the real unconditional write would have produced it), but trust/W
//       are proven untouched via a DIRECT call to `advanceMainlineWatermark` with a deliberately-wrong
//       checkedTip (mirroring (S7b)'s own technique). A later ordinary landing still walks through the
//       seeded row and advances cleanly.
//   (FORGE-STILL-FREEZES) a forged "explained" move, with a REAL ledger-covered landing chain reaching
//       right up to it from the other side, still freezes — the forged commit itself has NO ledger row
//       (nothing but Loom's own merge code ever writes one), so the walk breaks exactly at that point,
//       proving the ledger cannot be used to launder a forgery regardless of how much genuine Loom history
//       surrounds it.
//   (RESIDUAL) the accepted, NAMED gap: a real Loom landing whose own ledger row never made it to disk
//       (simulating a crash between the squash and the write) still freezes on the next landing, with the
//       new alert text naming this as a possible cause alongside a hand commit or a forgery — never a
//       silent launder, and never a false "it's definitely not a forgery" claim either.
//
// NOT covered here (owned by mainline-watch-landing-trust-freeze.mjs, unaffected by this card): the basic
// freeze/no-storm/null-trust/human-reset/new-episode shapes from round 19 — all re-verified still green
// against this round's gate change as part of this card's own DoD, not re-tested in this file.
// Run: 1) build daemon (pnpm build), 2) LOOM_CODEX_BIN=<nonexistent> node test/mainline-watch-trust-ledger.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), `loom-no-such-codex-bin-${process.pid}`);
useOwnLoomHome("loom-mw-ledger-home-");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const MW = await import("../dist/git/mainline-watch.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const IDENT = { GIT_AUTHOR_NAME: "mwl", GIT_AUTHOR_EMAIL: "mwl@loom", GIT_COMMITTER_NAME: "mwl", GIT_COMMITTER_EMAIL: "mwl@loom" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENT }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const GIT_ID = "-c user.email=mwl@loom -c user.name=mwl";
const now = new Date().toISOString();
const noReap = async () => ({ killedPids: [] });
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };

function makeRepo(sfx) {
  const repo = mkdtempManaged(`loom-mwl-repo-${sfx}-`);
  fs.writeFileSync(path.join(repo, "README.md"), "# mwl\n");
  git(repo, "init", "-q", "-b", "main"); git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "user.email", "mwl@loom"); git(repo, "config", "user.name", "mwl");
  commitAll(repo, "init", GIT_ID);
  return repo;
}

function newProject(tag, repo) {
  const sfx = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const projId = `mwl-proj-${sfx}`, agentId = `mwl-agent-${sfx}`, mgrId = `mwl-mgr-${sfx}`;
  const db = new Db();
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, runGate: async () => ({ passed: true, steps: [] }), reapWorktreeProcesses: noReap });
  const nudges = [];
  const origEnqueue = sessions.enqueueDurableMessage.bind(sessions);
  sessions.enqueueDurableMessage = (target, text, ...rest) => { if (String(text).startsWith("[loom:mainline-moved]")) nudges.push(text); return origEnqueue(target, text, ...rest); };
  db.insertProject({ id: projId, name: `MWL-${tag}`, repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null });
  return { db, sessions, nudges, projId, mgrId, agentId, sfx, repo };
}

const eventsFor = (db, projId) => db.listEventsSince(0, 100000).filter((e) => e.kind === "mainline_moved_outside_loom" && e.detail?.projectId === projId);
const freezeEventsFor = (db, projId) => eventsFor(db, projId).filter((e) => e.detail?.source === "landing-trust-freeze");

let seq = 0;
async function addWorker(ctx, tag) {
  const n = `${tag}${++seq}`;
  const taskId = `mwl-${n}-task-${ctx.sfx}`, workerId = `mwl-${n}-wkr-${ctx.sfx}`;
  ctx.db.insertTask({ id: taskId, projectId: ctx.projId, title: `feat(x): change ${n}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(ctx.repo, ctx.projId, taskId);
  registerForCleanup(worktreePath);
  fs.writeFileSync(path.join(worktreePath, `${n}.ts`), `export const ${n} = 1;\n`);
  commitAll(worktreePath, `feat(x): change ${n}`, GIT_ID);
  ctx.db.insertSession({ id: workerId, projectId: ctx.projId, agentId: ctx.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: ctx.mgrId, taskId, worktreePath, branch });
  return { taskId, workerId, worktreePath, branch };
}
const confirm = async (ctx, w) => ctx.sessions.confirmWorkerMergeTracked(ctx.mgrId, w.workerId);
const batchLand = async (ctx, ws) => ctx.sessions.mergeBatchTracked(ctx.mgrId, ws.map((w) => w.workerId));

function forgeExplainedMove(repo, parentSha) {
  const tree = git(repo, "rev-parse", `${parentSha}^{tree}`);
  const forged = git(repo, "commit-tree", tree, "-p", parentSha, "-m", "feat(x): innocuous", "-m", "Loom-Worker-Branch: loom/deadbeef0000");
  git(repo, "update-ref", "-m", "commit: x", "refs/heads/main", forged);
  return forged;
}

// ===================== (LAG-SOLO): one tripwire fail-open, then an ordinary landing self-heals ==========
{
  const repo = makeRepo("lagsolo");
  const ctx = newProject("lagsolo", repo);

  const w1 = await addWorker(ctx, "a");
  const r1 = await confirm(ctx, w1);
  check("(LAG-SOLO) setup: L1 lands and establishes trust (null -> first landing)", r1.settled === true && r1.ok === true);
  const l1Tip = git(repo, "rev-parse", "HEAD");
  check("(LAG-SOLO) setup: trust matches L1's own tip", ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main") === l1Tip);

  // L2: an ORDINARY landing, but checkMainlineMove's own head read fails open (injected throw) — the
  // squash still lands and writes its own ledger row, but neither W nor trust advance for it, since
  // mainlineCheckedTip stays null and advanceMainlineWatermark is never even called.
  const realHeadReader = ctx.sessions.mainlineHeadReader;
  ctx.sessions.mainlineHeadReader = async () => { throw new Error("injected head-read failure (LAG-SOLO L2)"); };
  const w2 = await addWorker(ctx, "b");
  const r2 = await confirm(ctx, w2);
  ctx.sessions.mainlineHeadReader = realHeadReader;
  check("(LAG-SOLO) L2 lands normally despite the injected tripwire failure", r2.settled === true && r2.ok === true);
  const l2Tip = git(repo, "rev-parse", "HEAD");
  check("(LAG-SOLO) setup: L2 genuinely moved main", l2Tip !== l1Tip);
  check("(LAG-SOLO) THE LAG: neither W nor trust advanced for L2 (checkMainlineMove fail-opened, so advanceMainlineWatermark never ran)", MW.parseMainlineWatermark(ctx.db.getMeta(MW.mainlineWatermarkKey(ctx.projId, "primary")))?.sha === l1Tip && ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main") === l1Tip);
  check("(LAG-SOLO) NO event/nudge fired for the fail-open itself (silent, per 4fa36502)", eventsFor(ctx.db, ctx.projId).length === 0 && ctx.nudges.length === 0);

  // L3: a genuinely ORDINARY landing. Its own checkedTip is L2's tip, which mismatches the still-frozen
  // trust (L1's tip) — but the ledger row L2's own landing wrote lets this walk through cleanly.
  const w3 = await addWorker(ctx, "c");
  const r3 = await confirm(ctx, w3);
  check("(LAG-SOLO) L3 lands normally", r3.settled === true && r3.ok === true);
  const l3Tip = git(repo, "rev-parse", "HEAD");
  check("(LAG-SOLO) THE FIX: trust self-heals to L3's own tip — the ledger walk (L2 -> L1) bridged the lag", ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main") === l3Tip);
  check("(LAG-SOLO) W also matches L3's tip", MW.parseMainlineWatermark(ctx.db.getMeta(MW.mainlineWatermarkKey(ctx.projId, "primary")))?.sha === l3Tip);
  check("(LAG-SOLO) NO freeze event, NO nudge — this was never treated as suspicious", freezeEventsFor(ctx.db, ctx.projId).length === 0 && ctx.nudges.length === 0);
}

// ===================== (LAG-BATCH): the same shape through a real mergeBatchTracked =======================
{
  const repo = makeRepo("lagbatch");
  const ctx = newProject("lagbatch", repo);

  const w1 = await addWorker(ctx, "d");
  const r1 = await confirm(ctx, w1);
  check("(LAG-BATCH) setup: L1 (solo) lands and establishes trust", r1.settled === true && r1.ok === true);
  const l1Tip = git(repo, "rev-parse", "HEAD");

  // L2: a batch, with checkMainlineMove's own gate-closure call failing open. `batchCheckedTip` stays
  // null/falsy, so advanceMainlineWatermarkForBatch's own first guard returns before touching anything —
  // but the ledger row (written unconditionally, base=baseMainSha, no git call needed) still lands.
  const realHeadReader = ctx.sessions.mainlineHeadReader;
  ctx.sessions.mainlineHeadReader = async () => { throw new Error("injected head-read failure (LAG-BATCH L2)"); };
  const a = await addWorker(ctx, "e"), b = await addWorker(ctx, "f");
  const r2 = await batchLand(ctx, [a, b]);
  ctx.sessions.mainlineHeadReader = realHeadReader;
  check("(LAG-BATCH) L2 (batch) lands normally despite the injected tripwire failure", r2.settled === true && r2.ok === true && r2.value?.landed?.length === 2);
  const l2Tip = git(repo, "rev-parse", "HEAD");
  check("(LAG-BATCH) THE LAG: neither W nor trust advanced for L2", MW.parseMainlineWatermark(ctx.db.getMeta(MW.mainlineWatermarkKey(ctx.projId, "primary")))?.sha === l1Tip && ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main") === l1Tip);

  // L3: an ordinary solo landing walks the ledger row L2's own batch wrote.
  const w3 = await addWorker(ctx, "g");
  const r3 = await confirm(ctx, w3);
  check("(LAG-BATCH) L3 lands normally", r3.settled === true && r3.ok === true);
  const l3Tip = git(repo, "rev-parse", "HEAD");
  check("(LAG-BATCH) THE FIX: trust self-heals to L3's own tip via the batch's own ledger row", ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main") === l3Tip);
  check("(LAG-BATCH) NO freeze event, NO nudge", freezeEventsFor(ctx.db, ctx.projId).length === 0 && ctx.nudges.length === 0);
  void l2Tip;
}

// ===================== (LAG-ADVANCE-SKIP): feeder (b) — advanceMainlineWatermark's OWN guard, not
//                        checkMainlineMove's. No end-to-end seam reaches this guard (same limitation
//                        (S7b)/(S7d)/(S7e) in mainline-watch.mjs already accept) — reproduces the exact
//                        externally-observable state it leaves behind instead. ==========================
{
  const repo = makeRepo("lagskip");
  const ctx = newProject("lagskip", repo);

  const w1 = await addWorker(ctx, "h");
  const r1 = await confirm(ctx, w1);
  check("(LAG-ADVANCE-SKIP) setup: L1 lands and establishes trust", r1.settled === true && r1.ok === true);
  const l1Tip = git(repo, "rev-parse", "HEAD");

  // Simulate "a real Loom landing happened, its own unconditional ledger write succeeded, but
  // advanceMainlineWatermark's OWN guard then returned early" by seeding the exact ledger row that write
  // would have produced, backed by a REAL commit (a plain hand commit stands in for the landing's own
  // squash — its OWN classification shape is irrelevant here since we never let checkMainlineMove near
  // it; only the ledger row and the real parent/child sha relationship matter for this guard).
  fs.writeFileSync(path.join(repo, "skip.txt"), "x\n");
  commitAll(repo, "chore(x): stands in for a landing whose advance got skipped", GIT_ID);
  const l2Tip = git(repo, "rev-parse", "HEAD");
  ctx.db.recordMainlineLandedCommit(ctx.projId, "primary", "main", l2Tip, l1Tip);

  // Prove the guard itself: a DIRECT call with a deliberately-wrong checkedTip fails the TOCTOU
  // first-parent check and leaves BOTH W and trust exactly as L1's own real landing left them (still at
  // l1Tip) — mirrors (S7b)'s own technique. This call never reaches the trust/W write at all.
  await ctx.sessions.advanceMainlineWatermark(ctx.projId, "primary", repo, "f".repeat(40), "f".repeat(40), undefined, ctx.mgrId, null, null);
  check("(LAG-ADVANCE-SKIP) THE GUARD: a mismatched checkedTip leaves trust untouched at l1Tip", ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main") === l1Tip);
  check("(LAG-ADVANCE-SKIP) THE GUARD: W is ALSO untouched at l1Tip", MW.parseMainlineWatermark(ctx.db.getMeta(MW.mainlineWatermarkKey(ctx.projId, "primary")))?.sha === l1Tip);

  // L3: an ordinary landing on top of l2Tip. Its own checkMainlineMove sees the hand commit as an
  // ordinary "explained" move (no trailer, porcelain reflog) and returns checkedTip=l2Tip; the gate then
  // walks the SEEDED ledger row (l2Tip -> l1Tip) and advances cleanly.
  const w3 = await addWorker(ctx, "i");
  const r3 = await confirm(ctx, w3);
  check("(LAG-ADVANCE-SKIP) L3 lands normally", r3.settled === true && r3.ok === true);
  const l3Tip = git(repo, "rev-parse", "HEAD");
  check("(LAG-ADVANCE-SKIP) THE FIX: trust self-heals to L3's own tip via the seeded ledger row", ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main") === l3Tip);
  check("(LAG-ADVANCE-SKIP) NO freeze event, NO nudge", freezeEventsFor(ctx.db, ctx.projId).length === 0 && ctx.nudges.length === 0);
}

// ===================== (FORGE-STILL-FREEZES): a forged move with a real ledger-covered chain reaching
//                        right up to it still freezes — the forgery itself has no row, so the walk breaks
//                        exactly there, regardless of how much genuine history surrounds it. ============
{
  const repo = makeRepo("forgefreeze");
  const C0 = git(repo, "rev-parse", "HEAD");
  const ctx = newProject("forgefreeze", repo);
  ctx.db.setMeta(MW.mainlineWatermarkKey(ctx.projId, "primary"), JSON.stringify({ branch: "main", sha: C0 }));
  ctx.db.setMainlineBranchTrust(ctx.projId, "primary", "main", C0);

  const forged = forgeExplainedMove(repo, C0);
  check("(FORGE-STILL-FREEZES) setup: the forged tip has NO ledger row of its own", ctx.db.isMainlineLedgerReachable(ctx.projId, "primary", "main", forged, C0) === false);

  const w1 = await addWorker(ctx, "j");
  const r1 = await confirm(ctx, w1);
  check("(FORGE-STILL-FREEZES) the real landing on top of the forgery still succeeds", r1.settled === true && r1.ok === true);
  const landedTip = git(repo, "rev-parse", "HEAD");
  check("(FORGE-STILL-FREEZES) THE FIX HOLDS: trust stays frozen at C0 — the forged commit breaks the chain", ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main") === C0);
  check("(FORGE-STILL-FREEZES) a ledger row DOES exist for the real landing's own tip (base=forged) — proving the walk reaches the forgery and stops there, not that no row exists at all", ctx.db.isMainlineLedgerReachable(ctx.projId, "primary", "main", landedTip, forged) === true && ctx.db.isMainlineLedgerReachable(ctx.projId, "primary", "main", landedTip, C0) === false);
  check("(FORGE-STILL-FREEZES) exactly one freeze event fires", freezeEventsFor(ctx.db, ctx.projId).length === 1);

  // A second real landing after the freeze still cannot bridge it — the chain is broken at the forgery,
  // no matter how much further genuine Loom history piles up on top.
  const w2 = await addWorker(ctx, "k");
  const r2 = await confirm(ctx, w2);
  check("(FORGE-STILL-FREEZES) a second real landing also succeeds", r2.settled === true && r2.ok === true);
  check("(FORGE-STILL-FREEZES) trust is STILL frozen at C0", ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main") === C0);
  check("(FORGE-STILL-FREEZES) still exactly one freeze event (deduped on `from`)", freezeEventsFor(ctx.db, ctx.projId).length === 1);
}

// ===================== (RESIDUAL): the accepted, named gap — a real landing whose own ledger write never
//                        made it to disk (a crash-shaped loss) still freezes, with the new alert text ====
{
  const repo = makeRepo("residual");
  const ctx = newProject("residual", repo);

  const w1 = await addWorker(ctx, "l");
  const r1 = await confirm(ctx, w1);
  check("(RESIDUAL) setup: L1 lands and establishes trust", r1.settled === true && r1.ok === true);
  const l1Tip = git(repo, "rev-parse", "HEAD");

  const w2 = await addWorker(ctx, "m");
  const r2 = await confirm(ctx, w2);
  check("(RESIDUAL) setup: L2 lands and self-advances normally (no injection this time)", r2.settled === true && r2.ok === true);
  const l2Tip = git(repo, "rev-parse", "HEAD");
  check("(RESIDUAL) setup control: L2's own landing DID write a ledger row and DID advance trust normally", ctx.db.isMainlineLedgerReachable(ctx.projId, "primary", "main", l2Tip, l1Tip) === true && ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main") === l2Tip);

  // Simulate the crash: L3 lands normally (a real, genuine landing)...
  const w3 = await addWorker(ctx, "n");
  const r3 = await confirm(ctx, w3);
  check("(RESIDUAL) L3 lands and advances normally too (setup control, before we erase its row)", r3.settled === true && r3.ok === true);
  const l3Tip = git(repo, "rev-parse", "HEAD");
  check("(RESIDUAL) setup control: trust matches L3's tip before the simulated crash", ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main") === l3Tip);
  // ...but we roll trust BACK to l2Tip (simulating "L3's advance itself also never happened") AND
  // PHYSICALLY DELETE L3's own ledger row (simulating "the crash took the ledger write with it too") —
  // the exact state a genuine crash between the squash and the ledger write would leave: a real landing
  // on disk, no row, no trust advance. `ctx.db.db` is Db's own TS-private sqlite handle, reachable at
  // runtime from the compiled dist/db.js this file imports — the same "call the private thing directly"
  // posture (S7b)/(S7d)/(S7e) in mainline-watch.mjs already use for advanceMainlineWatermark itself.
  ctx.db.setMainlineBranchTrust(ctx.projId, "primary", "main", l2Tip);
  ctx.db.setMeta(MW.mainlineWatermarkKey(ctx.projId, "primary"), JSON.stringify({ branch: "main", sha: l2Tip }));
  ctx.db.db.prepare("DELETE FROM mainline_landed_commits WHERE project_id = ? AND repo_key = ? AND branch = ? AND tip = ?").run(ctx.projId, "primary", "main", l3Tip);
  check("(RESIDUAL) setup: erased — the walk from L3's tip no longer reaches trust at all", ctx.db.isMainlineLedgerReachable(ctx.projId, "primary", "main", l3Tip, l2Tip) === false);

  // L4: an ordinary landing on top of L3. Its own checkedTip is l3Tip (an "explained" move, since L3's
  // own commit IS genuinely Loom-trailered) — but the ledger walk from l3Tip can never reach trust
  // (l2Tip), since the row that would have proven it was "erased" (the crash). THE FIX must still freeze
  // here, not silently launder a gap it cannot prove is safe.
  const w4 = await addWorker(ctx, "o");
  const r4 = await confirm(ctx, w4);
  check("(RESIDUAL) L4 still lands (never a landing block)", r4.settled === true && r4.ok === true);
  check("(RESIDUAL) THE ACCEPTED GAP: trust freezes at l2Tip — the ledger cannot prove a gap it has no record of", ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main") === l2Tip);
  const freezeResidual = freezeEventsFor(ctx.db, ctx.projId);
  check("(RESIDUAL) exactly one freeze event fires", freezeResidual.length === 1);
  check("(RESIDUAL) THE NEW ALERT TEXT: names a skipped Loom landing as a possible cause, not only a hand commit or a forgery", /genuine Loom landing whose own trust stamp was skipped/.test(freezeResidual[0].detail.reason ?? ""));
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
