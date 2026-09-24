import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// SPLIT (card 4e8e2d82): 801b6b39's retry-link block (h/i/j) took this file to 1m59s against the 120s per-file
// ceiling in its own merge gate; a further split followed since ~70s solo left too little in-suite margin. This file
// keeps (a)-(c) and (e); (f)/(g) moved verbatim to merge-confirm-verdict-cache-squash-refusal.mjs and (h/i/j) to
// merge-confirm-verdict-cache-retry-links.mjs. The description below covers all three.
//
// Regression/behavioral tests for card 615967c5 — the until-superseded merge verdict cache is keyed on a
// branch tip that Loom's OWN pre-gate union-merge advances, so the cached-verdict guarantee silently never
// applied to a branch that was behind main. The fix does NOT change the caching (a re-gate of a moved base
// is semantically correct) — it makes the re-mint SELF-ANNOUNCING via `AttachResult.freshMint`, so a
// caller can never mistake an invisible re-run for a replayed cached verdict.
//
// DoD-4's own framing: "a settled verdict on a branch that was NEVER behind main, re-called with no new
// commits, must still return the CACHED verdict" — this is the case the original reporter explicitly
// could NOT manufacture (they refused to fabricate a failed merge) and flagged as UNTESTED behaviorally.
// This file is that test, plus its (b) counterpart: a behind-main branch re-call announces
// identity-mismatch (renamed by card a98f97bd from "base-advanced" — an OBSERVED field, not an assertion
// of cause) with both identities; and its (c) counterpart: the SAME renamed value fires when the mismatch
// is instead caused by the worker pushing its own new commit, with no main advance at all.
//
// Exercises `SessionService.confirmWorkerMergeTracked` directly against a REAL git repo/worktree (no
// stubbed git — only the gate command itself is stubbed, same seam merge-rest-route-tracked.mjs uses),
// since the identity resolution this card is about (`resolveGitRef`, `mergeMainIntoWorktree`) is real git
// plumbing that a synthetic in-memory PendingOpRegistry test (pending-ops-registry.mjs) can't exercise.
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-confirm-verdict-cache.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";
import { settleTracked } from "./_settle-tracked.mjs";

process.env.LOOM_GATE_RETRY_SETTLE_MS = "20"; // the retry-link scenarios below wait this long between links
process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mcvc-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mcvc@loom -c user.name=mcvc";
const now = new Date().toISOString();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mcvc\n");
  execSync(`git init -q && git config user.email mcvc@loom && git config user.name mcvc`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

function headSha(cwd) {
  return execSync(`git ${GIT_ID} rev-parse HEAD`, { cwd }).toString().trim();
}

async function setupWorkerProject(sfx, reposDir, gateCommand = "pnpm gate") {
  registerForCleanup(reposDir);
  const db = new Db();
  const mgrId = `mcvc-mgr-${sfx}`, projId = `mcvc-p-${sfx}`, taskId = `mcvc-t-${sfx}`, workerId = `mcvc-w-${sfx}`;
  const repo = path.join(reposDir, "repo");
  makeRepo(repo);
  const config = { orchestration: { gateCommand } };
  db.insertProject({ id: projId, name: "MCVC", repoPath: repo, vaultPath: repo, config, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `agent-mcvc-m-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-mcvc-m-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertAgent({ id: `agent-mcvc-w-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: "MCVC-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(worktreePath, "feature.txt"), "work\n");
  commitAll(worktreePath, "feature.txt", GIT_ID);
  const workerSha = headSha(worktreePath);
  db.insertSession({ id: workerId, projectId: projId, agentId: `agent-mcvc-w-${sfx}`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
  return { db, mgrId, projId, taskId, workerId, repo, worktreePath, branch, workerSha };
}

// ── (a) THE ACTUAL DELIBERATE, PREVIOUSLY-UNTESTED DELIVERABLE (card 615967c5, DoD-4a): a settled verdict
//        on a branch that was NEVER behind main, re-called with no new commits, must still return the
//        CACHED verdict — no second gate run, freshMint absent (the signal a cache hit is distinguishable
//        by). This is `1555e361`'s central claim, verified here for the first time.
//
//        CARD 4aedde84 EXTENSION — this is ALSO the exact incident shape (DoD-3): a gate FAILS (tip
//        unmoved) → re-confirm at the identical tip. Before card 4aedde84 the only signal op 2 carried was
//        the ABSENCE of freshMint (checked above) — this block now also asserts the POSITIVE marker
//        (`cacheHit`, the registry-level field `servedFromCache` is built from — see mcp/orchestration.ts)
//        so a caller never has to infer "nothing ran" from a missing field.
{
  const sfx = `same-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const reposDir = path.join(os.tmpdir(), `loom-mcvc-same-${sfx}`);
  const { db, mgrId, workerId, workerSha } = await setupWorkerProject(sfx, reposDir);
  let gateCalls = 0;
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000, runGate: async () => { gateCalls++; return { passed: false, failedStep: "test", failedStatus: 1, steps: [] }; },
  });

  const r1 = await settleTracked(() => sessions.confirmWorkerMergeTracked(mgrId, workerId), { label: "confirmWorkerMergeTracked" });
  check("(same-identity) op 1 settled", r1.settled === true && r1.ok === true);
  check("(same-identity) op 1 was rejected (gate stub always fails)", r1.ok && r1.value.merged === false);
  check("(same-identity) op 1 announces genuinely-new (nothing cached yet)", r1.freshMint?.reason === "genuinely-new");
  check("(same-identity) the gate ran exactly once for op 1", gateCalls === 1);

  // No new commits — main never moved (single-commit repo, no other branch touched it), the worker made no
  // further commits. A plain re-call with NOTHING changed must return the CACHED rejection, not run a
  // second real gate.
  const r2 = await settleTracked(() => sessions.confirmWorkerMergeTracked(mgrId, workerId), { label: "confirmWorkerMergeTracked" });
  check("(same-identity) op 2 settled", r2.settled === true && r2.ok === true);
  check("(same-identity) the gate did NOT run a second time — POSITIVE CONTROL for the cache hit", gateCalls === 1);
  check("(same-identity) op 2 returns the SAME cached opId, not a fresh one", r2.ok && r1.ok && r2.value.opId === r1.value.opId);
  check("(same-identity) op 2 carries NO freshMint — the cache-hit signal", r2.freshMint === undefined);
  // POSITIVE MARKER (card 4aedde84, DoD-1/DoD-3/DoD-4i): op 2 must ALSO carry the POSITIVE `cacheHit`
  // field — the incident's whole point is that a caller must never have to notice an absence.
  check("(same-identity) op 2 carries a POSITIVE cacheHit marker — this is the DoD-4(i) polarity", r2.cacheHit !== undefined);
  check("(same-identity) op 2's cacheHit names the identity the replayed verdict was validated against (the worker's own commit)", r2.cacheHit?.identity === workerSha);
  check("(same-identity) op 2's cacheHit and freshMint are mutually exclusive by construction — never both set", !(r2.cacheHit && r2.freshMint));
  // op 1 (the genuinely fresh run) must NOT carry the cache marker — DoD-4(ii), the other polarity in the
  // SAME run: a test that only exercised the cache-hit branch would leave a false positive undetected.
  check("(same-identity) op 1 (a genuine fresh mint) carries NO cacheHit — DoD-4(ii)", r1.cacheHit === undefined);
}

// ── (b) IDENTITY-MISMATCH VIA MAIN ADVANCING: a branch that WAS behind main gets its tip advanced by THIS
//        call's OWN pre-gate union-merge (mergeMainIntoWorktree) — so a re-call's freshly-resolved identity
//        no longer matches the cached verdict's, even though the WORKER pushed no new commits at all. The
//        re-call must announce identity-mismatch with BOTH the cached (prior) identity and the current tip
//        — never a silent re-run indistinguishable from a cache hit.
{
  const sfx = `adv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const reposDir = path.join(os.tmpdir(), `loom-mcvc-adv-${sfx}`);
  const { db, mgrId, workerId, repo, worktreePath, workerSha } = await setupWorkerProject(sfx, reposDir);
  let gateCalls = 0;
  // GENEROUS per-instance sync budget (DI seam, NOT the production constant): op 1's own union-merge moves the
  // branch identity, so a re-poll landing after op 1 settled would mint a SECOND op instead of re-attaching (see
  // _settle-tracked.mjs's RE-MINT GUARD) — this fixture must not degrade in the first place.
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000,
    runGate: async () => { gateCalls++; return { passed: false, failedStep: "test", failedStatus: 1, steps: [] }; },
  });

  // Advance MAIN (in the canonical repo, not the worktree) — the worker's branch is now genuinely behind.
  fs.writeFileSync(path.join(repo, "main-advance.txt"), "advanced\n");
  commitAll(repo, "main advanced", GIT_ID);
  const mainShaAfterAdvance = headSha(repo);
  check("(identity-mismatch/main-advanced setup) main genuinely moved past the worker's branch point", mainShaAfterAdvance !== workerSha);

  const r1 = await settleTracked(() => sessions.confirmWorkerMergeTracked(mgrId, workerId), { label: "confirmWorkerMergeTracked" });
  check("(identity-mismatch/main-advanced) op 1 settled", r1.settled === true && r1.ok === true);
  check("(identity-mismatch/main-advanced) op 1 was rejected (gate stub always fails)", r1.ok && r1.value.merged === false);
  check("(identity-mismatch/main-advanced) op 1 announces genuinely-new — nothing was cached before this call", r1.freshMint?.reason === "genuinely-new");
  check("(identity-mismatch/main-advanced) the gate ran exactly once for op 1", gateCalls === 1);

  // op 1's OWN pre-gate union-merge (mergeMainIntoWorktree) should have advanced the worktree's branch tip
  // to a NEW commit that unions the worker's work with main's advance — never the worker's original sha.
  const shaAfterOp1 = headSha(worktreePath);
  check("(identity-mismatch/main-advanced) op 1's own union-merge advanced the branch tip past the worker's original commit", shaAfterOp1 !== workerSha);

  // The worker pushed NOTHING new — the branch tip moved underneath the cache entirely via Loom's own
  // prior confirm. Card 8b1fb28f: the gate op 1 ran validated shaAfterOp1 (the POST-forward tip), so the
  // cache records THAT as the verdict's identity and this plain re-call — same commit — is a cache hit,
  // NOT a second gate (before the fix it recorded the pre-forward workerSha and re-gated the same commit).
  const r2 = await settleTracked(() => sessions.confirmWorkerMergeTracked(mgrId, workerId), { label: "confirmWorkerMergeTracked" });
  check("(same-commit-after-forward) op 2 settled", r2.settled === true && r2.ok === true);
  check("(same-commit-after-forward) the gate did NOT run a second time — the forwarded tip is the commit op 1 already validated", gateCalls === 1);
  check("(same-commit-after-forward) op 2 returns the SAME cached opId", r2.ok && r1.ok && r2.value.opId === r1.value.opId);
  check("(same-commit-after-forward) op 2 carries NO freshMint", r2.freshMint === undefined);
  check("(same-commit-after-forward) op 2's cacheHit names the POST-forward tip the gate actually validated", r2.cacheHit?.identity === shaAfterOp1);
  check("(same-commit-after-forward) op 1 (genuine fresh mint) carries NO cacheHit", r1.cacheHit === undefined);

  // (d) Card 8b1fb28f DoD-3 — a behaviour PIN, not a design endorsement: identity is branch-tip-only, so if
  // MAIN advances AGAIN after op 1 (worker pushes nothing) a re-call still replays the cached rejection.
  fs.writeFileSync(path.join(repo, "main-advance-2.txt"), "advanced again\n");
  commitAll(repo, "main advanced again", GIT_ID);
  const r3 = await settleTracked(() => sessions.confirmWorkerMergeTracked(mgrId, workerId), { label: "confirmWorkerMergeTracked" });
  check("(main-advanced-again) re-call settled", r3.settled === true && r3.ok === true);
  check("(main-advanced-again) PIN: the cached rejection is replayed (no second gate) even though main moved again", gateCalls === 1 && r3.cacheHit?.identity === shaAfterOp1);
}

// ── (c) IDENTITY-MISMATCH VIA THE WORKER'S OWN NEW COMMIT (card a98f97bd DoD-6): the registry compares an
//        opaque identity string and has no way to tell WHY it changed — this proves the SAME renamed value
//        ("identity-mismatch") fires for a mismatch that has NOTHING to do with main moving: main never
//        advances in this block at all, the worker's branch alone gets a new commit between op 1 and op 2 —
//        the third cause the card names (main moved / a sibling's squash landed / the worker pushed a new
//        commit), previously untested here since (b) only exercises the main-advanced cause.
{
  const sfx = `own-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const reposDir = path.join(os.tmpdir(), `loom-mcvc-own-${sfx}`);
  const { db, mgrId, workerId, worktreePath, workerSha } = await setupWorkerProject(sfx, reposDir);
  let gateCalls = 0;
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000, runGate: async () => { gateCalls++; return { passed: false, failedStep: "test", failedStatus: 1, steps: [] }; },
  });

  const r1 = await settleTracked(() => sessions.confirmWorkerMergeTracked(mgrId, workerId), { label: "confirmWorkerMergeTracked" });
  check("(identity-mismatch/own-commit) op 1 settled", r1.settled === true && r1.ok === true);
  check("(identity-mismatch/own-commit) op 1 was rejected (gate stub always fails)", r1.ok && r1.value.merged === false);
  check("(identity-mismatch/own-commit) op 1 announces genuinely-new — nothing was cached before this call", r1.freshMint?.reason === "genuinely-new");
  check("(identity-mismatch/own-commit) the gate ran exactly once for op 1", gateCalls === 1);

  // The WORKER pushes a genuinely new commit onto its own branch — main is untouched, no union-merge ever
  // runs, so this is the OTHER cause colliding into the same observed label.
  fs.writeFileSync(path.join(worktreePath, "worker-followup.txt"), "more work\n");
  commitAll(worktreePath, "worker followup commit", GIT_ID);
  const shaAfterWorkerCommit = headSha(worktreePath);
  check("(identity-mismatch/own-commit setup) the worker's own new commit moved the branch tip", shaAfterWorkerCommit !== workerSha);

  const r2 = await settleTracked(() => sessions.confirmWorkerMergeTracked(mgrId, workerId), { label: "confirmWorkerMergeTracked" });
  check("(identity-mismatch/own-commit) op 2 settled", r2.settled === true && r2.ok === true);
  check("(identity-mismatch/own-commit) the gate genuinely ran a SECOND time — this is real re-gating, not a cache replay", gateCalls === 2);
  check("(identity-mismatch/own-commit) op 2 is a genuinely fresh op (different opId from op 1)", r2.ok && r1.ok && r2.value.opId !== r1.value.opId);
  check("(identity-mismatch/own-commit) op 2 announces the SAME renamed value as the main-advanced cause (b)", r2.freshMint?.reason === "identity-mismatch");
  check("(identity-mismatch/own-commit) op 2's priorIdentity is the CACHED verdict's identity (the worker's original commit)", r2.freshMint?.priorIdentity === workerSha);
  check("(identity-mismatch/own-commit) op 2's currentIdentity is the branch tip AFTER the worker's own new commit", r2.freshMint?.currentIdentity === shaAfterWorkerCommit);
  check("(identity-mismatch/own-commit) op 1 (genuine fresh mint) carries NO cacheHit", r1.cacheHit === undefined);
  check("(identity-mismatch/own-commit) op 2 (genuine re-gate, NOT a cache hit) carries NO cacheHit either", r2.cacheHit === undefined);
}

// ── (e) THE TIP MOVES DURING THE GATE (card 8b1fb28f, Code Review MAJOR 1): the worker is live while its merge
//        gate runs, so it can commit a FIX mid-gate. The gate then FAILS — but on the tree it started with. The
//        rejection must NOT be cached under the fix commit (never gated): a re-confirm to test the fix must
//        re-gate for real. Behind-main branch (forwarded) so the stamp path is the one exercised.
{
  const sfx = `mid-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const reposDir = path.join(os.tmpdir(), `loom-mcvc-mid-${sfx}`);
  const { db, mgrId, workerId, repo, worktreePath, workerSha } = await setupWorkerProject(sfx, reposDir);
  let gateCalls = 0;
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000, runGate: async () => {
      gateCalls++;
      if (gateCalls === 1) { fs.writeFileSync(path.join(worktreePath, "fix.txt"), "fix\n"); commitAll(worktreePath, "fix mid-gate", GIT_ID); }
      return { passed: false, failedStep: "test", failedStatus: 1, steps: [] };
    },
  });
  fs.writeFileSync(path.join(repo, "main-advance.txt"), "advanced\n");
  commitAll(repo, "main advanced", GIT_ID);
  const r1 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  check("(tip-moves-during-gate) op 1 settled + rejected", r1.settled === true && r1.ok && r1.value.merged === false && gateCalls === 1);
  const fixSha = headSha(worktreePath);
  check("(tip-moves-during-gate setup) the worker's mid-gate commit moved the tip", fixSha !== workerSha);
  const r2 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  check("(tip-moves-during-gate) the re-call RE-GATES the fix commit for real — the rejection was never cached under a commit the gate never ran on", gateCalls === 2 && r2.cacheHit === undefined);
  check("(tip-moves-during-gate) op 2 announces identity-mismatch", r2.freshMint?.reason === "identity-mismatch");
}

console.log(failures === 0
  ? "\n✅ ALL PASS — confirmWorkerMergeTracked verdict cache (card 615967c5), scenarios (a)-(c)/(e): cached-verdict replay on an unmoved branch, identity-mismatch announcements, and tip-moves-during-the-gate. Scenarios (f)/(g) are in merge-confirm-verdict-cache-squash-refusal.mjs and (h/i/j) in merge-confirm-verdict-cache-retry-links.mjs."
  : `\n❌ ${failures} FAILURE(S).`);

// Card 82bb198a: this file previously had NO exit-code decision at all — Node's default exit(0)
// applied regardless of `failures`, so the gate's exit-code-only verdict (test-daemon.mjs `runOne`)
// reported PASS even with printed FAIL lines above. registerForCleanup (imported above) already
// installs _tmp-fixture.mjs's `exit`-event sync backstop, so a plain process.exit here still gets
// guaranteed cleanup — matching the corpus's own dominant idiom rather than inventing a second one.
process.exit(failures === 0 ? 0 : 1);
