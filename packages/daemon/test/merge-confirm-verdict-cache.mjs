import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
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

async function setupWorkerProject(sfx, reposDir) {
  registerForCleanup(reposDir);
  const db = new Db();
  const mgrId = `mcvc-mgr-${sfx}`, projId = `mcvc-p-${sfx}`, taskId = `mcvc-t-${sfx}`, workerId = `mcvc-w-${sfx}`;
  const repo = path.join(reposDir, "repo");
  makeRepo(repo);
  const config = { orchestration: { gateCommand: "pnpm gate" } };
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
    runGate: async () => { gateCalls++; return { passed: false, failedStep: "test", failedStatus: 1, steps: [] }; },
  });

  const r1 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  check("(same-identity) op 1 settled", r1.settled === true && r1.ok === true);
  check("(same-identity) op 1 was rejected (gate stub always fails)", r1.ok && r1.value.merged === false);
  check("(same-identity) op 1 announces genuinely-new (nothing cached yet)", r1.freshMint?.reason === "genuinely-new");
  check("(same-identity) the gate ran exactly once for op 1", gateCalls === 1);

  // No new commits — main never moved (single-commit repo, no other branch touched it), the worker made no
  // further commits. A plain re-call with NOTHING changed must return the CACHED rejection, not run a
  // second real gate.
  const r2 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
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
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    runGate: async () => { gateCalls++; return { passed: false, failedStep: "test", failedStatus: 1, steps: [] }; },
  });

  // Advance MAIN (in the canonical repo, not the worktree) — the worker's branch is now genuinely behind.
  fs.writeFileSync(path.join(repo, "main-advance.txt"), "advanced\n");
  commitAll(repo, "main advanced", GIT_ID);
  const mainShaAfterAdvance = headSha(repo);
  check("(identity-mismatch/main-advanced setup) main genuinely moved past the worker's branch point", mainShaAfterAdvance !== workerSha);

  const r1 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  check("(identity-mismatch/main-advanced) op 1 settled", r1.settled === true && r1.ok === true);
  check("(identity-mismatch/main-advanced) op 1 was rejected (gate stub always fails)", r1.ok && r1.value.merged === false);
  check("(identity-mismatch/main-advanced) op 1 announces genuinely-new — nothing was cached before this call", r1.freshMint?.reason === "genuinely-new");
  check("(identity-mismatch/main-advanced) the gate ran exactly once for op 1", gateCalls === 1);

  // op 1's OWN pre-gate union-merge (mergeMainIntoWorktree) should have advanced the worktree's branch tip
  // to a NEW commit that unions the worker's work with main's advance — never the worker's original sha.
  const shaAfterOp1 = headSha(worktreePath);
  check("(identity-mismatch/main-advanced) op 1's own union-merge advanced the branch tip past the worker's original commit", shaAfterOp1 !== workerSha);

  // The worker pushed NOTHING new — this re-call's only difference from a plain poll is that the branch
  // tip moved underneath the cache, entirely via Loom's own prior confirm.
  const r2 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  check("(identity-mismatch/main-advanced) op 2 settled", r2.settled === true && r2.ok === true);
  check("(identity-mismatch/main-advanced) the gate genuinely ran a SECOND time — this is real re-gating, not a cache replay", gateCalls === 2);
  check("(identity-mismatch/main-advanced) op 2 is a genuinely fresh op (different opId from op 1)", r2.ok && r1.ok && r2.value.opId !== r1.value.opId);
  check("(identity-mismatch/main-advanced) op 2 announces identity-mismatch", r2.freshMint?.reason === "identity-mismatch");
  check("(identity-mismatch/main-advanced) op 2's priorIdentity is the CACHED verdict's identity (the worker's original commit, resolved BEFORE op 1's union-merge ran)", r2.freshMint?.priorIdentity === workerSha);
  check("(identity-mismatch/main-advanced) op 2's currentIdentity is the branch's tip AS OF op 2's own call (op 1's union-merge result)", r2.freshMint?.currentIdentity === shaAfterOp1);
  // DoD-4(ii), card 4aedde84 — the OTHER polarity in this SAME run: a genuinely fresh re-gate (this is a
  // REAL second gate run, asserted above via gateCalls === 2) must NEVER carry the cache marker either —
  // proves cacheHit isn't just "always absent" by some unrelated bug, it's absent specifically because a
  // gate genuinely ran, mirroring the freshMint assertion right above it.
  check("(identity-mismatch/main-advanced) op 1 (genuine fresh mint) carries NO cacheHit", r1.cacheHit === undefined);
  check("(identity-mismatch/main-advanced) op 2 (genuine re-gate, NOT a cache hit) carries NO cacheHit either", r2.cacheHit === undefined);
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
    runGate: async () => { gateCalls++; return { passed: false, failedStep: "test", failedStatus: 1, steps: [] }; },
  });

  const r1 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
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

  const r2 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  check("(identity-mismatch/own-commit) op 2 settled", r2.settled === true && r2.ok === true);
  check("(identity-mismatch/own-commit) the gate genuinely ran a SECOND time — this is real re-gating, not a cache replay", gateCalls === 2);
  check("(identity-mismatch/own-commit) op 2 is a genuinely fresh op (different opId from op 1)", r2.ok && r1.ok && r2.value.opId !== r1.value.opId);
  check("(identity-mismatch/own-commit) op 2 announces the SAME renamed value as the main-advanced cause (b)", r2.freshMint?.reason === "identity-mismatch");
  check("(identity-mismatch/own-commit) op 2's priorIdentity is the CACHED verdict's identity (the worker's original commit)", r2.freshMint?.priorIdentity === workerSha);
  check("(identity-mismatch/own-commit) op 2's currentIdentity is the branch tip AFTER the worker's own new commit", r2.freshMint?.currentIdentity === shaAfterWorkerCommit);
  check("(identity-mismatch/own-commit) op 1 (genuine fresh mint) carries NO cacheHit", r1.cacheHit === undefined);
  check("(identity-mismatch/own-commit) op 2 (genuine re-gate, NOT a cache hit) carries NO cacheHit either", r2.cacheHit === undefined);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — confirmWorkerMergeTracked verdict cache (card 615967c5): a settled verdict on a branch that was NEVER behind main, re-called with no new commits, still returns the CACHED verdict (no second gate run, no freshMint) — DoD-4a, previously unverified behaviorally; and a behind-main branch's own pre-gate union-merge advances the identity the cache is keyed on, so a re-call genuinely re-gates and SELF-ANNOUNCES it via freshMint:{reason:\"identity-mismatch\", priorIdentity, currentIdentity} instead of looking like an invisible re-run — DoD-4b. CARD 4aedde84: the cache-hit branch above now ALSO carries a POSITIVE `cacheHit` marker (never inferred from freshMint's absence), and BOTH polarities are proven in this one run — a cache hit is positively marked, and a genuinely fresh/re-gated run carries freshMint and NEVER the cache marker. CARD a98f97bd: the reason was renamed from \"base-advanced\" to \"identity-mismatch\" (an OBSERVED field, not an assertion of cause), and (c) above proves the renamed value ALSO fires when the mismatch is caused by the worker pushing its own new commit — not just main advancing — since the registry cannot and should not try to tell the two apart."
  : `\n❌ ${failures} FAILURE(S).`);

// Card 82bb198a: this file previously had NO exit-code decision at all — Node's default exit(0)
// applied regardless of `failures`, so the gate's exit-code-only verdict (test-daemon.mjs `runOne`)
// reported PASS even with printed FAIL lines above. registerForCleanup (imported above) already
// installs _tmp-fixture.mjs's `exit`-event sync backstop, so a plain process.exit here still gets
// guaranteed cleanup — matching the corpus's own dominant idiom rather than inventing a second one.
process.exit(failures === 0 ? 0 : 1);
