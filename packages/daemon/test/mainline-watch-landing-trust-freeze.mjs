import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card aa7677fa (decision record 2a6a292a round 19) — the shared mainline tripwire's own `store()`
// (card f683a5ad, round 16) no longer writes the per-branch TRUST record from `classifyMainlineMove`'s
// forgeable verdict. But the trust writes made directly inside `advanceMainlineWatermark{,ForBatch}` were
// left UNCONDITIONAL (round 16's own text: "a verified real landing ... confirms the landed commit's own
// parentage — unaffected by this round"). That premise only confirms PARENTAGE relative to `checkedTip`
// (nothing slipped in between the check and the squash) — it never re-verifies that `checkedTip` ITSELF
// was ever a Loom-trusted tip. `checkedTip` is `checkMainlineMove`'s own return value, which for an
// "explained" (forged porcelain message + forged `Loom-Worker-Branch:` trailer), "unverifiable" (cap
// exceeded) or cap-skipped verdict is just the LIVE tip, with zero cryptographic verification. So: forge a
// commit that classifies "explained", then let ANY real subsequent landing squash on top of it, and the
// forgery's own descendant gets stamped straight into the authenticated trust record — exactly the
// forged-trailer laundering round 9 closed for `project_checkout_branch`'s own gates, one hop removed.
//
// FIX: both `advanceMainlineWatermark` and `advanceMainlineWatermarkForBatch` now read the branch's
// EXISTING trust record before stamping. `trusted === null` (first establishment) or `trusted ===
// checkedTip` (the ordinary, lockstep case) ⇒ stamp as before. Any other `trusted` ⇒ do NOT stamp
// (trust stays frozen at its pre-existing value); the watermark `W` still advances (4fa36502's own
// bookkeeping, never a trust decision, and 4fa36502's "Do not" forbids turning this into a refusal/block/
// retry — the landing has already happened by the time these functions run), and ONE HIGH
// `mainline_moved_outside_loom` event (`detail.source: "landing-trust-freeze"`) + ONE manager nudge fires,
// deduped on `from` ALONE (not the exact (from, to) pair `fileManagerCheckoutRefusalEvent`'s own m4 dedupe
// uses) via `Db.hasLandingTrustFreezeEvent` — every later landing mints its own distinct `to`, so an
// exact-pair dedupe would re-alert on every single one.
//
// Readers of `getMainlineBranchTrust(` verified (grep, packages/daemon/src): exactly two, both inside
// `project_checkout_branch`'s own gates (`refuseIfTargetBranchUntrusted` service.ts:6483,
// `refuseIfWatermarkUntrusted` service.ts:6546) — a frozen trust record costs ONLY that tool's own
// switch/create-from-W path until a human resets it; nothing else reads this record.
//
//   (SOLO-FREEZE) forge an "explained" move, then a REAL confirmWorkerMergeTracked lands on top of it:
//       trust stays frozen at its pre-forgery value, W still advances onto the real landed tip, exactly
//       ONE HIGH event/nudge fires, NO marker is written (mirrors checkMainlineMove's own landing-path
//       sha-level alert — only project_checkout_branch's own precondition writes a marker), and the
//       END-TO-END checkoutProjectBranch({branch:"main"}) switch is refused afterward.
//   (SOLO-NO-STORM) a SECOND real landing after the SAME freeze does NOT re-fire the event/nudge.
//   (SOLO-NULL-TRUST) a landing on a branch with NO trust record yet (never forged, never established)
//       establishes it unconditionally — the ordinary first-landing case is untouched by this card.
//   (SOLO-NULL-TRUST-FORGE-RACE) card aa7677fa round 4 (CR 5882d8cb Minor 2): a forge racing the VERY
//       FIRST trust establishment (trust null, a VERIFIED mergeSha mismatching the live tip) used to be
//       FULLY SILENT (console.warn only, no durable event) — now files one HIGH event, deduped on `from:
//       ""`, with wording that does not blame a hand commit. Calls `advanceMainlineWatermark` DIRECTLY
//       (same pattern as mainline-watch.mjs/mainline-watch-race-guards.mjs/mainline-watch-trust-ledger.mjs)
//       since the race window it tests (strictly between mergeBranchLocked's own verified read and this
//       function's LATER readMainlineHead() re-read) has no git call in between to hang a hook off.
//   (BATCH-FREEZE) / (BATCH-NULL-TRUST) — the batch twins of the above, through a real mergeBatchTracked.
//   (HAND-COMMIT-THEN-LANDING) an ORDINARY (non-forged) owner hand commit, boot-advanced per round 16's
//       own fix (W moves, trust doesn't — mirrors mainline-watch-trust-store.mjs's own HAND-COMMIT-LOCKOUT
//       setup), followed by a fully legitimate real landing: trust freezes anyway (this card's accepted
//       cost — round 16's own "self-heals the moment a real landing lands" claim for TRUST no longer
//       holds; see the decision record's round-19 section) — then the human-only reset route unfreezes it,
//       and the NEXT real landing after that stamps trust again normally, no further human step needed.
//   (NEW-EPISODE-AFTER-RESET) the freeze dedupe (Db.hasLandingTrustFreezeEvent) keys on `from` alone, so
//       this proves it is ALSO correctly scoped by `sinceTs` (anchored to the LAST human-reset event), not
//       just by the `from` value: a human reset that re-adopts the SAME sha an earlier, now-resolved
//       freeze episode already used as `from` must not let that OLD episode's row suppress a genuinely
//       NEW, later mismatch that happens to reuse the same value — the two episodes differ only in TIME
//       (which side of the reset they're on), never in `from`, so this is the one case a bare `from`-only
//       dedupe (with no `sinceTs` scoping at all) would get wrong.
//
// RED-then-GREEN proof (recorded here, not re-derived every run): reverting this card's own service.ts
// diff (the two `trustedBefore === null || trustedBefore === checkedTip` gates + `fileLandingTrustFreezeEvent`)
// makes (SOLO-FREEZE)/(BATCH-FREEZE)'s "trust stays frozen" assertions fail — pre-fix code silently
// stamps the forged descendant into trust instead. Verified by the author at authoring time: see the
// worker_report for this card for the actual revert/build/test/restore/rebuild/retest transcript.
//
// NOT covered here (out of scope, unaffected by this card): mainline-watch-trust-store.mjs owns
// `checkMainlineMove`'s own `store()` (round 16/17/18 — the DIRECT-call forgery shapes, with no
// subsequent landing); project-checkout-branch.mjs owns the full refuseIfTargetBranchUntrusted/
// createProjectBranch surface this card's frozen trust is eventually consumed by.
// Run: 1) build daemon (pnpm build), 2) LOOM_CODEX_BIN=<nonexistent> node test/mainline-watch-landing-trust-freeze.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), `loom-no-such-codex-bin-${process.pid}`);
useOwnLoomHome("loom-mw-ltf-home-");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const MW = await import("../dist/git/mainline-watch.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const IDENT = { GIT_AUTHOR_NAME: "mwltf", GIT_AUTHOR_EMAIL: "mwltf@loom", GIT_COMMITTER_NAME: "mwltf", GIT_COMMITTER_EMAIL: "mwltf@loom" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENT }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const GIT_ID = "-c user.email=mwltf@loom -c user.name=mwltf";
const now = new Date().toISOString();
const noReap = async () => ({ killedPids: [] });
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };

function makeRepo(sfx) {
  const repo = mkdtempManaged(`loom-mwltf-repo-${sfx}-`);
  fs.writeFileSync(path.join(repo, "README.md"), "# mwltf\n");
  git(repo, "init", "-q", "-b", "main"); git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "user.email", "mwltf@loom"); git(repo, "config", "user.name", "mwltf");
  commitAll(repo, "init", GIT_ID);
  return repo;
}

function newProject(tag, repo) {
  const sfx = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const projId = `mwltf-proj-${sfx}`, agentId = `mwltf-agent-${sfx}`, mgrId = `mwltf-mgr-${sfx}`;
  const db = new Db();
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, runGate: async () => ({ passed: true, steps: [] }), reapWorktreeProcesses: noReap });
  const nudges = [];
  const origEnqueue = sessions.enqueueDurableMessage.bind(sessions);
  sessions.enqueueDurableMessage = (target, text, ...rest) => { if (String(text).startsWith("[loom:mainline-moved]")) nudges.push(text); return origEnqueue(target, text, ...rest); };
  db.insertProject({ id: projId, name: `MWLTF-${tag}`, repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null });
  return { db, sessions, nudges, projId, mgrId, agentId, sfx, repo };
}

const eventsFor = (db, projId) => db.listEventsSince(0, 100000).filter((e) => e.kind === "mainline_moved_outside_loom" && e.detail?.projectId === projId);
const freezeEventsFor = (db, projId) => eventsFor(db, projId).filter((e) => e.detail?.source === "landing-trust-freeze");

let seq = 0;
async function addWorker(ctx, tag) {
  const n = `${tag}${++seq}`;
  const taskId = `mwltf-${n}-task-${ctx.sfx}`, workerId = `mwltf-${n}-wkr-${ctx.sfx}`;
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

/** A commit that `classifyMainlineMove` reads as "explained" (forged porcelain reflog message + forged
 *  Loom-Worker-Branch trailer) — zero events on its own, mirrors mainline-watch-trust-store.mjs's (A). */
function forgeExplainedMove(repo, parentSha) {
  const tree = git(repo, "rev-parse", `${parentSha}^{tree}`);
  const forged = git(repo, "commit-tree", tree, "-p", parentSha, "-m", "feat(x): innocuous", "-m", "Loom-Worker-Branch: loom/deadbeef0000");
  git(repo, "update-ref", "-m", "commit: x", "refs/heads/main", forged);
  return forged;
}

// ===================== (SOLO-FREEZE) forge, then a REAL landing squashes on top of it =====================
{
  const repo = makeRepo("sf");
  const C0 = git(repo, "rev-parse", "HEAD");
  const ctx = newProject("sf", repo);
  ctx.db.setMeta(MW.mainlineWatermarkKey(ctx.projId, "primary"), JSON.stringify({ branch: "main", sha: C0 }));
  ctx.db.setMainlineBranchTrust(ctx.projId, "primary", "main", C0);

  const forged = forgeExplainedMove(repo, C0);

  const w1 = await addWorker(ctx, "a");
  const r1 = await confirm(ctx, w1);
  check("(SOLO-FREEZE) the real landing itself still succeeds — never refused/blocked by the freeze", r1.settled === true && r1.ok === true);
  const landedSha = git(repo, "rev-parse", "HEAD");
  check("(SOLO-FREEZE) setup: the landed tip's first parent IS the forged commit (squashed directly on top)", git(repo, "rev-parse", `${landedSha}^1`) === forged);

  const trustAfter = ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main");
  const wAfter = MW.parseMainlineWatermark(ctx.db.getMeta(MW.mainlineWatermarkKey(ctx.projId, "primary")));
  check("(SOLO-FREEZE) THE FIX: trust stays frozen at its pre-forgery sha — never laundered via the landing", trustAfter === C0);
  check("(SOLO-FREEZE) W itself still advances to the real landed tip (4fa36502's bookkeeping, unaffected)", wAfter?.sha === landedSha);

  const freeze = freezeEventsFor(ctx.db, ctx.projId);
  check("(SOLO-FREEZE) exactly ONE landing-trust-freeze event, HIGH, untrusted-tip-mismatch, from=C0 to=forged", freeze.length === 1 && freeze[0].detail.severity === "high" && freeze[0].detail.evidence.includes("untrusted-tip-mismatch") && freeze[0].detail.from === C0 && freeze[0].detail.to === forged);
  check("(SOLO-FREEZE) exactly one manager nudge", ctx.nudges.length === 1);
  check("(SOLO-FREEZE) NO mainline-boot-alert marker is written by the landing-path freeze itself (only project_checkout_branch's own precondition writes one)", ctx.db.getMeta(MW.mainlineBootAlertKey(ctx.projId, "primary")) === undefined);

  // ── (SOLO-NO-STORM): a SECOND real landing after the SAME freeze must NOT re-fire the event/nudge ──────
  const w2 = await addWorker(ctx, "b");
  const r2 = await confirm(ctx, w2);
  check("(SOLO-NO-STORM) a second real landing after the same freeze still succeeds", r2.settled === true && r2.ok === true);
  check("(SOLO-NO-STORM) THE FIX: trust is STILL frozen at C0 (the second landing's checkedTip mismatches too)", ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main") === C0);
  check("(SOLO-NO-STORM) W advanced AGAIN to the new landed tip", MW.parseMainlineWatermark(ctx.db.getMeta(MW.mainlineWatermarkKey(ctx.projId, "primary")))?.sha === git(repo, "rev-parse", "HEAD"));
  check("(SOLO-NO-STORM) NO ALERT STORM: still exactly ONE landing-trust-freeze event (deduped on `from` alone)", freezeEventsFor(ctx.db, ctx.projId).length === 1);
  check("(SOLO-NO-STORM) NO ALERT STORM: still exactly one manager nudge", ctx.nudges.length === 1);

  // ── END-TO-END: the manager-facing gate independently refuses on this now-frozen trust ──────────────────
  const switchResult = await ctx.sessions.checkoutProjectBranch(ctx.mgrId, { branch: "main" });
  check("(SOLO-FREEZE) END-TO-END: checkoutProjectBranch({branch:\"main\"}) is refused — the live tip no longer matches the frozen trust record", switchResult.ok === false && /does not match its own trusted baseline/.test(switchResult.error ?? ""));
}

// ===================== (SOLO-NULL-TRUST) a branch with no trust record yet establishes it unconditionally
//                        — the ordinary first-landing case must stay untouched by this card =============
{
  const repo = makeRepo("sn");
  const ctx = newProject("sn", repo);
  await ctx.sessions.checkMainlineMovesOnBoot(); // true first sight: seeds W, leaves trust null (round 16)
  check("(SOLO-NULL-TRUST) setup: boot seeded W, left trust null", ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main") === null);

  const w = await addWorker(ctx, "c");
  const r = await confirm(ctx, w);
  check("(SOLO-NULL-TRUST) the real landing settles ok", r.settled === true && r.ok === true);

  const landedSha = git(repo, "rev-parse", "HEAD");
  check("(SOLO-NULL-TRUST) THE CONTROL: a null trust establishes unconditionally — no freeze, trust matches the landed tip", ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main") === landedSha);
  check("(SOLO-NULL-TRUST) NO freeze event fired for this ordinary first landing", freezeEventsFor(ctx.db, ctx.projId).length === 0);
  check("(SOLO-NULL-TRUST) NO nudge either", ctx.nudges.length === 0);
}

// ===================== (SOLO-NULL-TRUST-FORGE-RACE): CR 5882d8cb Minor 2 — a forge racing the VERY FIRST
//                        trust establishment for (projectId, repoKey, branch) used to be FULLY SILENT
//                        (only a console.warn): `advanceMainlineWatermark` is called DIRECTLY here (same
//                        pattern as mainline-watch.mjs/mainline-watch-race-guards.mjs/
//                        mainline-watch-trust-ledger.mjs) because simulating a race strictly AFTER
//                        mergeBranchLocked's own verified commit returns, but BEFORE this function's own
//                        later readMainlineHead() re-read, has no git-hook-triggerable window to hang a
//                        real end-to-end repro off — there is no git call in between to hook into ========
{
  const repo = makeRepo("sntfr");
  const ctx = newProject("sntfr", repo);
  check("(SOLO-NULL-TRUST-FORGE-RACE) setup: no trust established yet", ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main") === null);

  // L1: what we claim as OUR OWN verified landing (parent = the repo's init commit).
  const C0 = git(repo, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(repo, "l1.txt"), "l1\n");
  commitAll(repo, "feat(x): L1", GIT_ID);
  const L1 = git(repo, "rev-parse", "HEAD");

  // The racer: a SEPARATE commit on top of L1, forged trailer, genuinely different content — struck in
  // the window between mergeBranchLocked's own verified read and advanceMainlineWatermark's later one.
  fs.writeFileSync(path.join(repo, "EVIL.txt"), "evil\n");
  execFileSync("git", ["add", "EVIL.txt"], { cwd: repo });
  const F = execFileSync("git", ["commit-tree", git(repo, "write-tree"), "-p", L1, "-m", "feat(x): innocuous", "-m", "Loom-Worker-Branch: loom/deadbeef0001"], { cwd: repo, encoding: "utf8", env: { ...process.env, ...IDENT } }).trim();
  git(repo, "update-ref", "-m", "commit: x", "refs/heads/main", F);
  git(repo, "reset", "--hard");
  check("(SOLO-NULL-TRUST-FORGE-RACE) setup: the racer F sits on top of L1, live HEAD is F", git(repo, "rev-parse", "HEAD") === F);

  // Direct call: checkedTip = L1 (F's own first parent — must match `readFirstParent(head.tip=F)` for the
  // function's own entry guard to pass at all), mergeSha = L1 (our own VERIFIED commit — a defined value,
  // not `undefined`, exercising the "verified mismatch" branch rather than the plain-unverified one).
  // mergeVerify explicit (card aa7677fa round 5 added this 6th positional param): "verified", matching
  // mergeSha being defined — omitting it would shift every later arg by one slot.
  await ctx.sessions.advanceMainlineWatermark(ctx.projId, "primary", repo, L1, L1, "verified", ctx.mgrId, null, null);
  check("(SOLO-NULL-TRUST-FORGE-RACE) THE FIX: trust is still null — never auto-established onto the racer F", ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main") === null);
  const forgeRaceEvents = eventsFor(ctx.db, ctx.projId).filter((e) => e.detail?.evidence?.includes("first-establishment-forge-race"));
  check("(SOLO-NULL-TRUST-FORGE-RACE) THE FIX: exactly ONE HIGH event, from=\"\" to=F — was fully silent before this round", forgeRaceEvents.length === 1 && forgeRaceEvents[0].detail.severity === "high" && forgeRaceEvents[0].detail.from === "" && forgeRaceEvents[0].detail.to === F);
  check("(SOLO-NULL-TRUST-FORGE-RACE) exactly one manager nudge for the forge-race event", ctx.nudges.length === 1);
  check("(SOLO-NULL-TRUST-FORGE-RACE) the nudge wording does not blame a hand commit — names several plausible causes", /forged commit racing|Loom stamp that was itself skipped|ordinary concurrent commit/.test(ctx.nudges[0]));

  // DEDUPE: a second forge race (same null trust, same `from:""`) must NOT re-fire.
  await ctx.sessions.advanceMainlineWatermark(ctx.projId, "primary", repo, L1, L1, "verified", ctx.mgrId, null, null);
  check("(SOLO-NULL-TRUST-FORGE-RACE) DEDUPE: trust is STILL null", ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main") === null);
  check("(SOLO-NULL-TRUST-FORGE-RACE) DEDUPE: still exactly ONE forge-race event", eventsFor(ctx.db, ctx.projId).filter((e) => e.detail?.evidence?.includes("first-establishment-forge-race")).length === 1);
  check("(SOLO-NULL-TRUST-FORGE-RACE) DEDUPE: still exactly one manager nudge", ctx.nudges.length === 1);

  // CONTROL: an entirely ordinary call (checkedTip and mergeSha both matching the SAME real, unforged tip)
  // still establishes trust unconditionally — this round's fix did not make the null-trust path itself
  // more paranoid; it only reacts to a genuine mismatch.
  fs.writeFileSync(path.join(repo, "l2.txt"), "l2\n");
  commitAll(repo, "feat(x): L2 (ordinary, no race)", GIT_ID);
  const L2 = git(repo, "rev-parse", "HEAD");
  await ctx.sessions.advanceMainlineWatermark(ctx.projId, "primary", repo, F, L2, "verified", ctx.mgrId, null, null);
  check("(SOLO-NULL-TRUST-FORGE-RACE) CONTROL: an ordinary, unraced call establishes trust at its own tip", ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main") === L2);
  check("(SOLO-NULL-TRUST-FORGE-RACE) CONTROL: still no SECOND forge-race event from the ordinary call", eventsFor(ctx.db, ctx.projId).filter((e) => e.detail?.evidence?.includes("first-establishment-forge-race")).length === 1);
  void C0;
}

// ===================== (BATCH-FREEZE) the batch twin: forge, then a REAL mergeBatchTracked ff lands on it
{
  const repo = makeRepo("bf");
  const C0 = git(repo, "rev-parse", "HEAD");
  const ctx = newProject("bf", repo);
  ctx.db.setMeta(MW.mainlineWatermarkKey(ctx.projId, "primary"), JSON.stringify({ branch: "main", sha: C0 }));
  ctx.db.setMainlineBranchTrust(ctx.projId, "primary", "main", C0);

  const forged = forgeExplainedMove(repo, C0);

  const a = await addWorker(ctx, "d"), b = await addWorker(ctx, "e");
  const r1 = await batchLand(ctx, [a, b]);
  check("(BATCH-FREEZE) the real batch landing still succeeds — never refused/blocked by the freeze", r1.settled === true && r1.ok === true && r1.value?.landed?.length === 2);
  const landedSha = git(repo, "rev-parse", "HEAD");
  check("(BATCH-FREEZE) setup: the batch fast-forwarded directly on top of the forged commit", git(repo, "merge-base", forged, landedSha) === forged);

  const trustAfter = ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main");
  const wAfter = MW.parseMainlineWatermark(ctx.db.getMeta(MW.mainlineWatermarkKey(ctx.projId, "primary")));
  check("(BATCH-FREEZE) THE FIX: trust stays frozen at its pre-forgery sha — never laundered via the batch", trustAfter === C0);
  check("(BATCH-FREEZE) W itself still advances to the real landed tip", wAfter?.sha === landedSha);

  const freeze = freezeEventsFor(ctx.db, ctx.projId);
  check("(BATCH-FREEZE) exactly ONE landing-trust-freeze event, HIGH, untrusted-tip-mismatch, from=C0 to=forged", freeze.length === 1 && freeze[0].detail.severity === "high" && freeze[0].detail.evidence.includes("untrusted-tip-mismatch") && freeze[0].detail.from === C0 && freeze[0].detail.to === forged);
  check("(BATCH-FREEZE) exactly one manager nudge", ctx.nudges.length === 1);

  // ── NO ALERT STORM for the batch twin too: a second batch after the same freeze does not re-fire ───────
  const c = await addWorker(ctx, "f"), d = await addWorker(ctx, "g");
  const r2 = await batchLand(ctx, [c, d]);
  check("(BATCH-FREEZE/no-storm) a second real batch after the same freeze still succeeds", r2.settled === true && r2.ok === true && r2.value?.landed?.length === 2);
  check("(BATCH-FREEZE/no-storm) trust is STILL frozen at C0", ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main") === C0);
  check("(BATCH-FREEZE/no-storm) NO ALERT STORM: still exactly ONE landing-trust-freeze event", freezeEventsFor(ctx.db, ctx.projId).length === 1);
  check("(BATCH-FREEZE/no-storm) NO ALERT STORM: still exactly one manager nudge", ctx.nudges.length === 1);

  const switchResult = await ctx.sessions.checkoutProjectBranch(ctx.mgrId, { branch: "main" });
  check("(BATCH-FREEZE) END-TO-END: checkoutProjectBranch({branch:\"main\"}) is refused on the now-frozen trust record", switchResult.ok === false && /does not match its own trusted baseline/.test(switchResult.error ?? ""));
}

// ===================== (BATCH-NULL-TRUST) the batch twin of (SOLO-NULL-TRUST) ============================
{
  const repo = makeRepo("bn");
  const ctx = newProject("bn", repo);
  await ctx.sessions.checkMainlineMovesOnBoot();
  check("(BATCH-NULL-TRUST) setup: boot seeded W, left trust null", ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main") === null);

  const a = await addWorker(ctx, "h"), b = await addWorker(ctx, "i");
  const r = await batchLand(ctx, [a, b]);
  check("(BATCH-NULL-TRUST) the real batch landing settles ok", r.settled === true && r.ok === true && r.value?.landed?.length === 2);

  const landedSha = git(repo, "rev-parse", "HEAD");
  check("(BATCH-NULL-TRUST) THE CONTROL: a null trust establishes unconditionally from the batch's own landed tip", ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main") === landedSha);
  check("(BATCH-NULL-TRUST) NO freeze event fired for this ordinary first landing", freezeEventsFor(ctx.db, ctx.projId).length === 0);
}

// ===================== (HAND-COMMIT-THEN-LANDING): an ordinary (non-forged) owner hand commit, boot-
//                        advanced (W moves, trust doesn't — round 16), followed by a FULLY LEGITIMATE real
//                        landing: trust still freezes (this card's accepted cost) — then the human-only
//                        reset route unfreezes it, and the NEXT real landing stamps trust again normally
//                        ===========================================================================
{
  const repo = makeRepo("hc");
  const C0 = git(repo, "rev-parse", "HEAD");
  const ctx = newProject("hc", repo);
  ctx.db.setMeta(MW.mainlineWatermarkKey(ctx.projId, "primary"), JSON.stringify({ branch: "main", sha: C0 }));
  ctx.db.setMainlineBranchTrust(ctx.projId, "primary", "main", C0);

  // The owner's own, perfectly ordinary hand commit — nothing forged about it (mirrors
  // mainline-watch-trust-store.mjs's own HAND-COMMIT-LOCKOUT setup).
  fs.writeFileSync(path.join(repo, "owner.txt"), "owner change\n");
  commitAll(repo, "chore(x): an ordinary hand commit by the owner", GIT_ID);
  const C1 = git(repo, "rev-parse", "HEAD");
  check("(HAND-COMMIT-THEN-LANDING) setup: the hand commit genuinely moved main", C1 !== C0);

  await ctx.sessions.checkMainlineMovesOnBoot(); // W advances (4fa36502's dedupe), trust does NOT (round 16)
  check("(HAND-COMMIT-THEN-LANDING) setup: W advanced to the hand commit, trust did NOT", MW.parseMainlineWatermark(ctx.db.getMeta(MW.mainlineWatermarkKey(ctx.projId, "primary")))?.sha === C1 && ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main") === C0);

  // A FULLY LEGITIMATE real landing, right on top of the hand commit.
  const w1 = await addWorker(ctx, "j");
  const r1 = await confirm(ctx, w1);
  check("(HAND-COMMIT-THEN-LANDING) the legitimate landing itself still succeeds", r1.settled === true && r1.ok === true);
  const landedSha = git(repo, "rev-parse", "HEAD");

  check("(HAND-COMMIT-THEN-LANDING) THE ACCEPTED COST: trust freezes anyway — a hand commit's own landing no longer self-heals trust the way round 16 claimed", ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main") === C0);
  check("(HAND-COMMIT-THEN-LANDING) W still advanced to the real landed tip", MW.parseMainlineWatermark(ctx.db.getMeta(MW.mainlineWatermarkKey(ctx.projId, "primary")))?.sha === landedSha);
  check("(HAND-COMMIT-THEN-LANDING) exactly one landing-trust-freeze event fired for this episode", freezeEventsFor(ctx.db, ctx.projId).length === 1);

  // The human-only reset route — the owner has already checked out main, so `adopt` reads its real
  // current tip (the landed sha).
  const resetResult = ctx.db.resetMainlineWatermark(ctx.projId, "primary", { branch: "main", sha: landedSha });
  check("(HAND-COMMIT-THEN-LANDING) the human-only reset route adopts the landed tip", resetResult.reset === true && ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main") === landedSha);

  // THE PROOF: the NEXT real landing after the reset stamps trust again normally — no further human step.
  const w2 = await addWorker(ctx, "k");
  const r2 = await confirm(ctx, w2);
  check("(HAND-COMMIT-THEN-LANDING) a second real landing after the reset settles ok", r2.settled === true && r2.ok === true);
  const landedSha2 = git(repo, "rev-parse", "HEAD");
  check("(HAND-COMMIT-THEN-LANDING) THE SELF-HEAL: trust now matches the SECOND landing's own tip — unfrozen, no further human step", ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main") === landedSha2);
  check("(HAND-COMMIT-THEN-LANDING) NO second freeze event — the reset cleared the mismatch", freezeEventsFor(ctx.db, ctx.projId).length === 1);
}

// ===================== (NEW-EPISODE-AFTER-RESET): a human reset that happens to re-adopt the SAME sha an
//                        earlier, now-resolved freeze episode used as `from` must not let that old
//                        episode's dedupe row suppress a genuinely NEW, LATER mismatch sharing that same
//                        value — `sinceTs` (anchored to the reset) is what distinguishes the two episodes,
//                        since `from` alone is identical on both sides ================================
{
  const repo = makeRepo("ner");
  const C0 = git(repo, "rev-parse", "HEAD");
  const ctx = newProject("ner", repo);
  ctx.db.setMeta(MW.mainlineWatermarkKey(ctx.projId, "primary"), JSON.stringify({ branch: "main", sha: C0 }));
  ctx.db.setMainlineBranchTrust(ctx.projId, "primary", "main", C0);

  // Episode 1: forge an "explained" move from C0, land, freeze — from=C0.
  const forged1 = forgeExplainedMove(repo, C0);
  const w1 = await addWorker(ctx, "x");
  const r1 = await confirm(ctx, w1);
  check("(NEW-EPISODE-AFTER-RESET) setup: episode 1's landing settles ok", r1.settled === true && r1.ok === true);
  check("(NEW-EPISODE-AFTER-RESET) setup: episode 1 froze trust at C0, exactly ONE freeze event", ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main") === C0 && freezeEventsFor(ctx.db, ctx.projId).length === 1);

  // The human reset: the owner reverts the live branch to C0 themselves and adopts it — trust becomes C0
  // again, the SAME value episode 1 already used as `from`, but via a FRESH, LATER human-authenticated
  // act (which files its own source:"human-reset" event, moving lastHumanResetTs forward).
  git(repo, "checkout", "-q", "-B", "main", C0);
  const resetResult = ctx.db.resetMainlineWatermark(ctx.projId, "primary", { branch: "main", sha: C0 });
  check("(NEW-EPISODE-AFTER-RESET) setup: the human reset re-adopts C0 — the SAME value episode 1 used as `from`", resetResult.reset === true && ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main") === C0);
  ctx.db.setMeta(MW.mainlineWatermarkKey(ctx.projId, "primary"), JSON.stringify({ branch: "main", sha: C0 })); // reseed W, mirroring what a subsequent plain checkout would do

  // Episode 2: a SECOND, LATER forged "explained" move, also from C0 — same `from` as episode 1, but this
  // mismatch happens strictly after the human reset above.
  const forged2 = forgeExplainedMove(repo, C0);
  check("(NEW-EPISODE-AFTER-RESET) setup: episode 2's forged tip differs from episode 1's", forged2 !== forged1);
  const w2 = await addWorker(ctx, "y");
  const r2 = await confirm(ctx, w2);
  check("(NEW-EPISODE-AFTER-RESET) episode 2's landing settles ok", r2.settled === true && r2.ok === true);
  const freezeAfter = freezeEventsFor(ctx.db, ctx.projId);
  check("(NEW-EPISODE-AFTER-RESET) THE PROOF: a SECOND, distinct freeze event fires for episode 2 — sinceTs (the reset) stops episode 1's row from suppressing it, even though both share from=C0", freezeAfter.length === 2 && freezeAfter[0].detail.to === forged1 && freezeAfter[1].detail.from === C0 && freezeAfter[1].detail.to === forged2);
  check("(NEW-EPISODE-AFTER-RESET) trust is frozen again, still at C0 — episode 2 also declined to stamp", ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main") === C0);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
