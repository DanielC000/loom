import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 57f9cdd9 — the PRE-GATE union-merge's own bare-refusal fallthrough never carried a distinguishing
// flag (unlike the POST-squash sites card 08c36dae already fixed): a structural `CanonicalGitRefusal`
// (commondir redirect / pin mismatch) during `mergeMainIntoWorktree`'s own main-tip read, identity probe,
// or `merge --no-edit` call fell through to the generic "union merge failed" shape, which
// `classifyOutcome` (sessions/service.ts) classified plain `"rejected"` — NOT in `NEVER_CACHED_OUTCOMES` —
// so a re-confirm at the same (branch tip, main tip) identity after a human repaired the canonical repo
// replayed the stale rejection forever instead of genuinely re-attempting the union-merge.
//
// Round 2 (Code Review of 5913bfdf) found the SAME drift at two further call sites — the admission-time
// re-union (AdmissionReunionFailedError) and the batch fast-forward's own PRE-ff HEAD read — plus a
// swallowed-refusal gap at the latter. Both are now covered here too, routed through the ONE shared
// `classifyUnionMergeFailureKind` the fix extracted.
//
// The fix REUSES the existing post-squash `canonicalTrustRefusal`/"canonical-trust-refusal" classification
// (card 08c36dae) rather than minting a new one — that outcome is already `NEVER_CACHED_OUTCOMES`, and its
// wording ("nothing was squashed … untouched … a canonical-git TRUST refusal") is equally true here.
//
// (A1) SOLO, IDENTITY PROBE — mirrors merge-confirm-canonical-trust-refusal.mjs's own real
//      commondir-trust-pin-mismatch fault (via registerCommondirTrustPinLookup) but threaded through
//      `unionMergeGitFactory`, firing at the PRE-GATE union-merge's own identity probe
//      (git/worktrees.ts ~:9700ish).
// (A2) SOLO, MAIN-TIP READ — a bare CanonicalGitRefusal at the FIRST `rev-parse HEAD` read against the
//      canonical repo (~:9650ish), before the merge-base shortcut / identity probe ever run.
// (A3) SOLO, MERGE CALL — a bare CanonicalGitRefusal at the real `git merge --no-edit` call itself
//      (~:9980ish), with everything before it (main-tip read, identity probe) proxied through cleanly.
// (B1) BATCH, PRE-FF READ — a real commondir-trust-pin-mismatch fault at `fastForwardCanonicalMain`'s own
//      pre-`--ff-only` `readHeadShaAndBranch` call (batch-merge.ts ~:1366) — the swallowed-refusal gap:
//      `readHeadShaAndBranch` returns `null` on ANY raw error, so without the `onRawError` hook this
//      refusal was indistinguishable from an ordinary read failure and never reached the fix at all.
// (B2) BATCH, --FF-ONLY CALL — a bare CanonicalGitRefusal at the `--ff-only` call itself.
//
// Every scenario asserts: (1) the refusal carries NO quarantined/dirtyWorktree/transient/branchDiverted/
// etc flag — just canonicalTrustRefusal:true; (2) op 2, after the fault clears with branch/main tips
// UNCHANGED, carries NO cacheHit and genuinely re-attempts (a real merge/ff call count rises, and it
// lands).
//
// RED-PROOFED: this file's own op-2 "no cacheHit" + attempt-count-rose assertions, for EVERY scenario,
// fail against the pre-fix code at the card's own commit — verified via `negative-control --ref
// 5913bfdf` (see the card's own report).
//
// Run: 1) pnpm build, 2) node packages/daemon/test/merge-confirm-verdict-cache-union-merge-refusal.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { commitAll } from "./_git-commit.mjs";
import { settleTracked } from "./_settle-tracked.mjs";
import { awaitTrackedSettle } from "./_settle-tracked-monotonic.mjs";

useOwnLoomHome("loom-mcvcumr-");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { registerCommondirTrustPinLookup, canonicalGit, CanonicalGitRefusal } = await import("../dist/git/bounded.js");
const { nonInteractiveEnv } = await import("../dist/git/writer.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mcvcumr@loom -c user.name=mcvcumr";
const now = new Date().toISOString();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };
const openDbs = [];
const noReap = async () => ({ killedPids: [] });
const sfxOf = (tag) => `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const confirmTracked = (sessions, mgrId, workerId) => settleTracked(() => sessions.confirmWorkerMergeTracked(mgrId, workerId), { label: "confirmWorkerMergeTracked", timeoutMs: 240_000 });

// Shared SOLO project setup: one worker branch, main advanced past the worktree's own fork point (on a
// file the branch never touches) so mergeMainIntoWorktree's own "already caught up" merge-base shortcut
// never fires — without this, none of the three sites under test (main-tip read, identity probe, the
// merge call) is ever reached at all. A gateCommand is REQUIRED for the pre-gate union-merge to run at
// all (card c0aeb5b2: with no gate to validate the worktree, mergeMainIntoWorktree is skipped entirely).
async function setupSoloProject(tag) {
  const sfx = sfxOf(tag);
  const reposDir = path.join(os.tmpdir(), `loom-mcvcumr-${sfx}`);
  registerForCleanup(reposDir);
  const db = new Db(); openDbs.push(db);
  const mgrId = `mcvcumr-mgr-${sfx}`, projId = `mcvcumr-p-${sfx}`, taskId = `mcvcumr-t-${sfx}`, workerId = `mcvcumr-w-${sfx}`;
  const repo = path.join(reposDir, "repo");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mcvcumr\n");
  execSync("git init -q && git config user.email mcvcumr@loom && git config user.name mcvcumr", { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  db.insertProject({ id: projId, name: "MCVCUMR", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `agent-mcvcumr-m-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-mcvcumr-m-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertAgent({ id: `agent-mcvcumr-w-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: "MCVCUMR-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(worktreePath, "feature.txt"), "work\n");
  commitAll(worktreePath, "feature.txt", GIT_ID);
  fs.writeFileSync(path.join(repo, "main-advance.txt"), "main advance\n");
  execSync(`git ${GIT_ID} add -A && git ${GIT_ID} commit -q -m "main advance"`, { cwd: repo });
  db.insertSession({ id: workerId, projectId: projId, agentId: `agent-mcvcumr-w-${sfx}`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
  return { db, mgrId, workerId, repo, worktreePath, branch };
}

try {
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (A1) SOLO, IDENTITY PROBE — real commondir-trust-pin mismatch
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    console.log("\n— (A1) SOLO identity probe: a real commondir-trust-pin mismatch —");
    const { db, mgrId, workerId, repo } = await setupSoloProject("a1");

    // PRODUCTION-SHAPED fault — same real mechanism as merge-confirm-canonical-trust-refusal.mjs's own
    // (A)/(B): checkCommondirTrust disagrees with a planted pin the instant the identity-fallback probe's
    // own `git var GIT_AUTHOR_IDENT`/`GIT_COMMITTER_IDENT` call runs. Also counts how many times the real
    // `git merge --no-edit` call actually ran, the cache-independent observable this file uses to tell
    // "replayed" (count stays flat) apart from "genuinely re-attempted" (count rises).
    const state = { untrusted: false, mergeAttempts: 0 };
    registerCommondirTrustPinLookup((_p) => (state.untrusted
      ? { toplevel: "C:\\fake\\pinned", pinnedAt: "2026-01-01T00:00:00.000Z", source: "bind", projectId: "p", repoKey: "r" }
      : null));
    const factory = (repoPath, blockTimeoutMs) => ({
      raw: async (args) => {
        const a = Array.isArray(args) ? args : [args];
        if (a[0] === "var" && (a[1] === "GIT_AUTHOR_IDENT" || a[1] === "GIT_COMMITTER_IDENT")) state.untrusted = true;
        if (a.includes("merge") && a.includes("--no-edit")) state.mergeAttempts++;
        // `repoPath` here is sometimes the WORKTREE path (a FILE-shaped .git) — trustedMainRoot must be
        // threaded through to the real canonical repo, or every call is refused structurally regardless
        // of the deliberate fault below (mirrors mergeMainIntoWorktree's own `resolvedTrustedMainRoot`).
        const real = canonicalGit(repoPath, blockTimeoutMs, nonInteractiveEnv(), undefined, undefined, repo);
        return real.raw(args);
      },
    });
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
      syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap,
      runGate: async () => ({ passed: true, steps: [] }),
      unionMergeGitFactory: factory,
    });

    const r1 = await confirmTracked(sessions, mgrId, workerId);
    check("(A1, op 1) settled, not merged, never reached the gate", r1.ok === true && r1.value?.merged === false);
    check("(A1, op 1) carries its OWN distinct flag, canonicalTrustRefusal:true", r1.value?.canonicalTrustRefusal === true);
    check("(A1, op 1) carries NO quarantined/dirtyWorktree/unionMergeTransient flag", !r1.value?.quarantined && !r1.value?.dirtyWorktree && !r1.value?.unionMergeTransient);
    check("(A1, op 1) detailText states squash phase never reached / canonical repo untouched", /squash phase never reached, canonical repo untouched/.test(r1.value?.detailText ?? ""));
    check("(A1, op 1) detailText names this a canonical-git TRUST refusal, never 'Re-task a rebase'", /TRUST refusal/.test(r1.value?.detailText ?? "") && !/Re-task a rebase/.test(r1.value?.detailText ?? ""));
    const attemptsAfterOp1 = state.mergeAttempts;

    registerCommondirTrustPinLookup(undefined);
    state.untrusted = false;

    const r2 = await confirmTracked(sessions, mgrId, workerId);
    check("(A1, op 2 — re-confirm) NOT served from the until-superseded verdict cache", r2.cacheHit === undefined);
    check("(A1, op 2 — re-confirm) a REAL new merge attempt happened (count rose), not a replay", state.mergeAttempts > attemptsAfterOp1);
    check("(A1, op 2 — re-confirm) genuinely re-attempted and LANDED", r2.ok === true && r2.value?.merged === true);
  }
  registerCommondirTrustPinLookup(undefined);

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (A2) SOLO, MAIN-TIP READ — bare CanonicalGitRefusal
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    console.log("\n— (A2) SOLO main-tip read: a bare CanonicalGitRefusal —");
    const { db, mgrId, workerId, repo } = await setupSoloProject("a2");
    const state = { mainTipAttempts: 0, refused: true };
    // `repoGit` (the main-tip read) is the ONLY caller in mergeMainIntoWorktree that invokes the factory
    // with `p === repo` (the canonical repo path) — every other call (merge-base, identity probe, the
    // merge itself) targets the WORKTREE path. Scoping on `p` isolates this one site precisely.
    const factory = (p, ms) => ({
      raw: async (args) => {
        const a = Array.isArray(args) ? args : [args];
        if (p === repo && a[0] === "rev-parse" && a.includes("HEAD") && !a.includes("-q")) {
          state.mainTipAttempts++;
          if (state.refused) throw new CanonicalGitRefusal("refused: a commondir redirect was detected for this repo (simulated)");
        }
        const real = canonicalGit(p, ms, nonInteractiveEnv(), undefined, undefined, repo);
        return real.raw(args);
      },
    });
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
      syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap,
      runGate: async () => ({ passed: true, steps: [] }),
      unionMergeGitFactory: factory,
    });

    const r1 = await confirmTracked(sessions, mgrId, workerId);
    check("(A2, op 1) settled, not merged, never reached the gate", r1.ok === true && r1.value?.merged === false);
    check("(A2, op 1) carries its OWN distinct flag, canonicalTrustRefusal:true", r1.value?.canonicalTrustRefusal === true);
    check("(A2, op 1) carries NO quarantined/dirtyWorktree/unionMergeTransient flag", !r1.value?.quarantined && !r1.value?.dirtyWorktree && !r1.value?.unionMergeTransient);
    const attemptsAfterOp1 = state.mainTipAttempts;

    state.refused = false;

    const r2 = await confirmTracked(sessions, mgrId, workerId);
    check("(A2, op 2 — re-confirm) NOT served from the until-superseded verdict cache", r2.cacheHit === undefined);
    check("(A2, op 2 — re-confirm) a REAL new main-tip read happened (count rose), not a replay", state.mainTipAttempts > attemptsAfterOp1);
    check("(A2, op 2 — re-confirm) genuinely re-attempted and LANDED", r2.ok === true && r2.value?.merged === true);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (A3) SOLO, MERGE CALL — bare CanonicalGitRefusal
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    console.log("\n— (A3) SOLO merge call: a bare CanonicalGitRefusal —");
    const { db, mgrId, workerId, repo } = await setupSoloProject("a3");
    const state = { mergeAttempts: 0, refused: true };
    const factory = (p, ms) => ({
      raw: async (args) => {
        const a = Array.isArray(args) ? args : [args];
        if (a.includes("merge") && a.includes("--no-edit")) {
          state.mergeAttempts++;
          if (state.refused) throw new CanonicalGitRefusal("refused: a commondir redirect was detected for this repo (simulated)");
        }
        const real = canonicalGit(p, ms, nonInteractiveEnv(), undefined, undefined, repo);
        return real.raw(args);
      },
    });
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
      syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap,
      runGate: async () => ({ passed: true, steps: [] }),
      unionMergeGitFactory: factory,
    });

    const r1 = await confirmTracked(sessions, mgrId, workerId);
    check("(A3, op 1) settled, not merged, never reached the gate", r1.ok === true && r1.value?.merged === false);
    check("(A3, op 1) carries its OWN distinct flag, canonicalTrustRefusal:true", r1.value?.canonicalTrustRefusal === true);
    check("(A3, op 1) carries NO quarantined/dirtyWorktree/unionMergeTransient flag", !r1.value?.quarantined && !r1.value?.dirtyWorktree && !r1.value?.unionMergeTransient);
    const attemptsAfterOp1 = state.mergeAttempts;

    state.refused = false;

    const r2 = await confirmTracked(sessions, mgrId, workerId);
    check("(A3, op 2 — re-confirm) NOT served from the until-superseded verdict cache", r2.cacheHit === undefined);
    check("(A3, op 2 — re-confirm) a REAL new merge attempt happened (count rose), not a replay", state.mergeAttempts > attemptsAfterOp1);
    check("(A3, op 2 — re-confirm) genuinely re-attempted and LANDED", r2.ok === true && r2.value?.merged === true);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (A4) SOLO, ADMISSION-TIME RE-UNION — bare CanonicalGitRefusal on the SECOND merge attempt
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Mirrors merge-confirm-verdict-cache-union-merge-transient.mjs's own "ADMISSION-TIME THREADING"
  // scenario exactly (same gate-semaphore-holder dance), swapping the injected error for a structural
  // CanonicalGitRefusal and asserting canonicalTrustRefusal:true instead of unionMergeTransient:true.
  // NO op-2/cache-replay check here, by the SAME precedent that sibling scenario sets: the "never cached"
  // property is a fact about `classifyOutcome`/`NEVER_CACHED_OUTCOMES`, already proven generically by
  // (A1)/(A2)/(A3) above (every mergeMainIntoWorktree caller's result flows through the SAME
  // classifyOutcome ternary regardless of which caller produced it) — an admission-time scenario cannot
  // cleanly repeat that proof anyway, since the SAME main-advance that triggers this code path also moves
  // `verdictIdentity` itself (captured at confirm-START, before the triggering advance), so a fresh op-2
  // calling with main genuinely repaired-and-advanced would be a real identity MISS regardless of caching
  // correctness — testing nothing (the exact "don't build a vacuous discrimination test" trap card
  // 08c36dae's own decision record names explicitly).
  {
    console.log("\n— (A4) SOLO admission-time re-union: a bare CanonicalGitRefusal on the 2nd merge attempt —");
    const sfx = sfxOf("a4");
    const repo = path.join(os.tmpdir(), `loom-mcvcumr-${sfx}`);
    fs.mkdirSync(repo, { recursive: true });
    registerForCleanup(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "mcvcumr@loom"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "mcvcumr"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "README.md"), "# mcvcumr-adm\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", [...GIT_ID.split(" "), "commit", "-q", "-m", "init"], { cwd: repo });

    const db = new Db(); openDbs.push(db);
    const projId = `mcvcumr-adm-p-${sfx}`, taskId = `mcvcumr-adm-t-${sfx}`, mgrId = `mcvcumr-adm-mgr-${sfx}`, workerId = `mcvcumr-adm-w-${sfx}`;
    db.insertProject({ id: projId, name: "MCVCUMR-ADM", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: `agent-mcvcumr-adm-m-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertAgent({ id: `agent-mcvcumr-adm-w-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertTask({ id: taskId, projectId: projId, title: "MCVCUMR-ADM-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-mcvcumr-adm-m-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    registerForCleanup(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "feature-adm.txt"), "work\n");
    commitAll(worktreePath, "feature-adm.txt", GIT_ID);
    db.insertSession({ id: workerId, projectId: projId, agentId: `agent-mcvcumr-adm-w-${sfx}`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
    // Main must already be AHEAD of the branch's fork point before the FIRST confirm — otherwise the
    // pre-gate union-merge takes the "already caught up" shortcut and the admission-time reunion below
    // would be the FIRST (not second) real merge attempt.
    fs.writeFileSync(path.join(repo, "main-pre-advance.txt"), "main pre-advance\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", [...GIT_ID.split(" "), "commit", "-q", "-m", "main pre-advance"], { cwd: repo });

    const admState = { mergeCalls: 0 };
    const proxyFailSecondMergeCall = (p, ms) => {
      const real = canonicalGit(p, ms, undefined, undefined, undefined, repo);
      return {
        async raw(args) {
          const a = Array.isArray(args) ? args : [args];
          if (a.includes("merge") && a.includes("--no-edit")) {
            admState.mergeCalls++;
            if (admState.mergeCalls === 2) throw new CanonicalGitRefusal("refused: a commondir redirect was detected for this repo (simulated)");
          }
          return real.raw(args);
        },
      };
    };
    let gateCalls = 0;
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
      runGate: async () => { gateCalls++; return { passed: true, steps: [] }; },
      reapWorktreeProcesses: noReap,
      unionMergeGitFactory: proxyFailSecondMergeCall,
    });

    let releaseHolder;
    const holderPromise = new Promise((resolve) => { releaseHolder = resolve; });
    const holderRun = sessions.gateSemaphore.runExclusive(
      1, { gateType: "merge", projectId: `mcvcumr-adm-holder-${sfx}`, sessionId: `mcvcumr-adm-holder-sess-${sfx}` }, () => holderPromise,
    );

    const confirmPromise = confirmTracked(sessions, mgrId, workerId);
    const queueDeadline = Date.now() + 20_000;
    let queued = false;
    while (Date.now() <= queueDeadline) {
      if (sessions.gateSemaphore.snapshot().queued >= 1) { queued = true; break; }
      await new Promise((r) => setTimeout(r, 5));
    }
    check("(A4) precondition: confirmWorkerMergeTracked is genuinely queued (pre-gate union-merge already ran once, cleanly)", queued && admState.mergeCalls === 1);
    if (!queued) {
      releaseHolder();
      await Promise.allSettled([holderRun, confirmPromise]);
    } else {
      // Main advances WHILE queued, on a file the worker's branch never touches — a trivial,
      // non-conflicting re-union, so the ONLY reason the admission-time attempt fails is the injected
      // refusal.
      fs.writeFileSync(path.join(repo, "main-advance.txt"), "main advance\n");
      execFileSync("git", ["add", "-A"], { cwd: repo });
      execFileSync("git", [...GIT_ID.split(" "), "commit", "-q", "-m", "main advance during queue"], { cwd: repo });

      releaseHolder();
      await holderRun;
      const r1 = await confirmPromise;

      check("(A4) the gate NEVER ran — the admission-time re-union fails before the gate spawns", gateCalls === 0);
      check("(A4) settled, rejected — a defined, observable outcome", r1.ok === true && r1.value?.merged === false);
      check("(A4) the SECOND merge attempt (admission-time) is the one that failed", admState.mergeCalls === 2);
      check("(A4) carries its OWN distinct flag, canonicalTrustRefusal:true", r1.value?.canonicalTrustRefusal === true);
      check("(A4) carries NO quarantined/dirtyWorktree/unionMergeTransient flag", !r1.value?.quarantined && !r1.value?.dirtyWorktree && !r1.value?.unionMergeTransient);
      check("(A4) detailText names this a canonical-git TRUST refusal, never the stale 'may be a transient git/filesystem issue' wording", /TRUST refusal/.test(r1.value?.detailText ?? "") && !/may be a transient/.test(r1.value?.detailText ?? ""));
      check("(A4) worktree retained for a retry", fs.existsSync(worktreePath) === true);
    }
  }

  // Shared BATCH project setup: TWO worker branches (mergeBatchTracked needs >= 2 eligible candidates —
  // with just 1 it short-circuits straight to a per-candidate solo fallback and never reaches
  // assembly/fast-forward at all, so the fault injection below would never fire).
  async function setupBatchProject(tag) {
    const sfx = sfxOf(tag);
    const repo = path.join(os.tmpdir(), `loom-mcvcumr-${sfx}`);
    fs.mkdirSync(repo, { recursive: true });
    registerForCleanup(repo);
    const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "mcvcumr", GIT_AUTHOR_EMAIL: "mcvcumr@loom", GIT_COMMITTER_NAME: "mcvcumr", GIT_COMMITTER_EMAIL: "mcvcumr@loom" }, stdio: ["ignore", "pipe", "pipe"] }).trim();
    fs.writeFileSync(path.join(repo, "README.md"), "# mcvcumr-b\n");
    git(repo, "init", "-q");
    git(repo, "config", "core.autocrlf", "false");
    git(repo, "config", "user.email", "mcvcumr@loom");
    git(repo, "config", "user.name", "mcvcumr");
    commitAll(repo, "init", GIT_ID);
    git(repo, "branch", "-M", "main");
    git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    const db = new Db(); openDbs.push(db);
    const projId = `mcvcumr-b-proj-${sfx}`, agentId = `mcvcumr-b-agent-${sfx}`, mgrId = `mcvcumr-b-mgr-${sfx}`;
    db.insertProject({ id: projId, name: "MCVCUMR-B", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    async function addBatchWorker(wtag) {
      const taskId = `mcvcumr-b-task-${wtag}-${sfx}`, workerId = `mcvcumr-b-wkr-${wtag}-${sfx}`;
      db.insertTask({ id: taskId, projectId: projId, title: `feat(x): batch change ${wtag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
      const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
      registerForCleanup(worktreePath);
      fs.writeFileSync(path.join(worktreePath, `batch-feature-${wtag}.txt`), `batch work ${wtag}\n`);
      commitAll(worktreePath, `feat(x): batch change ${wtag}`, GIT_ID);
      db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
      return workerId;
    }
    const workerId1 = await addBatchWorker("1");
    const workerId2 = await addBatchWorker("2");
    return { db, mgrId, workerId1, workerId2, repo };
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (B1) BATCH, PRE-FF READ — real commondir-trust-pin mismatch (the swallowed-refusal gap)
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    console.log("\n— (B1) BATCH pre-ff read: a real commondir-trust-pin mismatch at readHeadShaAndBranch —");
    const { db, mgrId, workerId1, workerId2, repo } = await setupBatchProject("b1");
    const state = { preFfReadAttempts: 0, refused: true };
    // `registerCommondirTrustPinLookup` is GLOBAL (not scoped by which call is asking) — arming it for
    // the WHOLE scenario would ALSO refuse `assembleBatchBranches`'s own calls against the batch
    // worktree, dropping every candidate at assembly and never reaching the ff phase at all. `lookupArmed`
    // is instead flipped true ONLY around a call that targets `repo` (the canonical repo) directly —
    // never a batch-worktree-targeting assembly call — isolating the fault to exactly the ff phase.
    let lookupArmed = false;
    registerCommondirTrustPinLookup((_p) => (lookupArmed
      ? { toplevel: "C:\\fake\\pinned", pinnedAt: "2026-01-01T00:00:00.000Z", source: "bind", projectId: "p", repoKey: "r" }
      : null));
    const factory = (p, ms) => ({
      async raw(args) {
        const a = Array.isArray(args) ? args : [args];
        const isCanonicalRepoCall = p === repo;
        if (isCanonicalRepoCall && a[0] === "rev-parse" && a.includes("--symbolic-full-name")) state.preFfReadAttempts++;
        lookupArmed = isCanonicalRepoCall && state.refused;
        try {
          const real = canonicalGit(p, ms, undefined, undefined, undefined, repo);
          return await real.raw(args);
        } finally {
          lookupArmed = false;
        }
      },
    });
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
      syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap,
      runGate: async () => ({ passed: true, steps: [] }),
      batchFfGitFactory: factory,
    });

    const r1 = await awaitTrackedSettle(() => sessions.mergeBatchTracked(mgrId, [workerId1, workerId2]), { label: "mergeBatchTracked", timeoutMs: 240_000, pendingOps: sessions.pendingOps });
    const v1 = r1.ok ? r1.value : { __unsettled: r1 };
    check("(B1, op 1) refused, nothing landed", v1.ok === false && (v1.landed ?? []).length === 0);
    check("(B1, op 1) carries its OWN distinct flag, canonicalTrustRefusal:true", v1.canonicalTrustRefusal === true);
    check("(B1, op 1) carries NO quarantined/indexLockPresent/branchDiverted/unverified/batchHeadMoved flag", !v1.quarantined && !v1.indexLockPresent && !v1.branchDiverted && !v1.unverified && !v1.batchHeadMoved);
    check("(B1, op 1) NO per-candidate fallback was started (same no-fallback posture as quarantined)", (v1.fallback ?? []).every((f) => f.started === false));
    const attemptsAfterOp1 = state.preFfReadAttempts;

    registerCommondirTrustPinLookup(undefined);
    state.refused = false;

    const r2 = await awaitTrackedSettle(() => sessions.mergeBatchTracked(mgrId, [workerId1, workerId2]), { label: "mergeBatchTracked", timeoutMs: 240_000, pendingOps: sessions.pendingOps });
    check("(B1, op 2 — re-fire) NOT served from the until-superseded verdict cache", r2.ok === true && r2.cacheHit === undefined);
    check("(B1, op 2 — re-fire) a REAL new pre-ff read happened (count rose), not a replay", state.preFfReadAttempts > attemptsAfterOp1);
    const v2 = r2.ok ? r2.value : { __unsettled: r2 };
    check("(B1, op 2 — re-fire) genuinely re-attempted and LANDED", v2.ok === true && (v2.landed ?? []).length === 2);
  }
  registerCommondirTrustPinLookup(undefined);

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (B2) BATCH, --FF-ONLY CALL — bare CanonicalGitRefusal
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    console.log("\n— (B2) BATCH --ff-only call: a bare CanonicalGitRefusal —");
    const { db, mgrId, workerId1, workerId2, repo } = await setupBatchProject("b2");
    const state = { ffAttempts: 0, refused: true };
    const factory = (p, ms) => {
      const real = canonicalGit(p, ms, undefined, undefined, undefined, repo);
      return {
        async raw(args) {
          const a = Array.isArray(args) ? args : [args];
          if (a.includes("merge") && a.includes("--ff-only")) {
            state.ffAttempts++;
            if (state.refused) throw new CanonicalGitRefusal("refused: a commondir redirect was detected for this repo (simulated)");
          }
          return real.raw(args);
        },
      };
    };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
      syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap,
      runGate: async () => ({ passed: true, steps: [] }),
      batchFfGitFactory: factory,
    });

    const r1 = await awaitTrackedSettle(() => sessions.mergeBatchTracked(mgrId, [workerId1, workerId2]), { label: "mergeBatchTracked", timeoutMs: 240_000, pendingOps: sessions.pendingOps });
    const v1 = r1.ok ? r1.value : { __unsettled: r1 };
    check("(B2, op 1) refused, nothing landed", v1.ok === false && (v1.landed ?? []).length === 0);
    check("(B2, op 1) carries its OWN distinct flag, canonicalTrustRefusal:true", v1.canonicalTrustRefusal === true);
    check("(B2, op 1) carries NO quarantined/indexLockPresent/branchDiverted/unverified/batchHeadMoved flag", !v1.quarantined && !v1.indexLockPresent && !v1.branchDiverted && !v1.unverified && !v1.batchHeadMoved);
    check("(B2, op 1) NO per-candidate fallback was started (same no-fallback posture as quarantined)", (v1.fallback ?? []).every((f) => f.started === false));
    const attemptsAfterOp1 = state.ffAttempts;

    state.refused = false;

    const r2 = await awaitTrackedSettle(() => sessions.mergeBatchTracked(mgrId, [workerId1, workerId2]), { label: "mergeBatchTracked", timeoutMs: 240_000, pendingOps: sessions.pendingOps });
    check("(B2, op 2 — re-fire) NOT served from the until-superseded verdict cache", r2.ok === true && r2.cacheHit === undefined);
    check("(B2, op 2 — re-fire) a REAL new fast-forward attempt happened (count rose), not a replay", state.ffAttempts > attemptsAfterOp1);
    const v2 = r2.ok ? r2.value : { __unsettled: r2 };
    check("(B2, op 2 — re-fire) genuinely re-attempted and LANDED", v2.ok === true && (v2.landed ?? []).length === 2);
  }
} finally {
  registerCommondirTrustPinLookup(undefined);
  for (const db of openDbs) { try { db.close(); } catch { /* ignore */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a structural CanonicalGitRefusal at any of the solo pre-gate union-merge's three call " +
    "sites (main-tip read, identity probe, merge call), the admission-time re-union, or the batch " +
    "fast-forward (pre-ff read or --ff-only) classifies as the existing never-cached " +
    "canonicalTrustRefusal/\"canonical-trust-refusal\" outcome, never the generic cacheable \"rejected\" " +
    "fallthrough, so a re-confirm/re-fire after a human repairs the canonical repo genuinely re-attempts " +
    "instead of replaying the stale refusal."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
