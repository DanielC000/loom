import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// SPLIT OFF merge-confirm-verdict-cache.mjs (card 4e8e2d82): carries ONLY scenarios (h/i/j), the retry-link
// captures (card 801b6b39); (a)-(g) live in merge-confirm-verdict-cache.mjs and merge-confirm-verdict-cache-squash-refusal.mjs. The description below covers both halves.
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
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-confirm-verdict-cache-retry-links.mjs
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

// ── (h/i/j) THE RETRY-LINK CAPTURES (card 801b6b39). Every fixture above returns `{failedStatus:1, steps:[]}`, which is
//        never retry-eligible, so only attempt 1's `captureGatedTip` was ever exercised. Each scenario here drives ONE
//        retry link of the chain and asserts the cached identity is the tip THAT link's gate ran on:
//          (h) transient-kill link  — attempt 1 is a SIGKILL classification; main advances during it, so the link's own
//              admission-time re-union forwards the branch tip before the retry gate spawns.
//          (i) single-file link     — attempt 1 is a genuine failure naming one re-runnable test file; the worker
//              commits mid-attempt-1, so the retry gate (which runs NO re-union) sees a newer tip.
//          (j) resumed-steps link   — same as (i) but the retry passes and a never-run step is resumed; the worker
//              commits mid-retry, so only the resume link's own capture names the tip it ran on.
//        Two variants each. "moved": the tip differs between the previous link and the final one and STAYS there, so
//        a missing final-link capture leaves a stamp that mismatches the settle-time tip and is dropped — the re-call
//        re-gates instead of hitting the cache. "aba": the final link's stub puts the tip BACK where the previous
//        link's capture saw it before failing, so a missing capture leaves a stamp that MATCHES the settle-time tip
//        and survives — the one shape where the missing capture is NOT fail-safe (a verdict cached under a tip the
//        final gate never ran on). Both variants go RED if that link's `captureGatedTip` is removed.
{
  const GATE_3STEP = "pnpm build && node packages/daemon/test/flaky-mid.mjs && pnpm true-final";
  const GATE_2STEP = "pnpm build && node packages/daemon/test/flaky-mid.mjs";
  const plantTestFile = (worktreePath, name) => {
    fs.mkdirSync(path.join(worktreePath, "packages", "daemon", "scripts"), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "scripts", "test-daemon.mjs"), "// stub\n");
    fs.mkdirSync(path.join(worktreePath, "packages", "daemon", "test"), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "test", `${name}.mjs`), "// stub\n");
  };
  const commitFile = (worktreePath, name) => { fs.writeFileSync(path.join(worktreePath, name), `${name}\n`); commitAll(worktreePath, name, GIT_ID); };
  const genuineFail = (steps) => ({
    passed: false, failedStep: "node packages/daemon/test/flaky-mid.mjs", failedStatus: 1, failedSignal: null, failedTimedOut: false,
    outputTail: "FAIL  flaky-mid", failingTest: "FAIL  flaky-mid", failingTestCount: 1, failTierTest: "FAIL  flaky-mid", failTierTestCount: 1, failTierAll: ["FAIL  flaky-mid"],
    steps,
  });
  const killed = { passed: false, failedStep: "pnpm gate", failedStatus: null, failedSignal: "SIGKILL", failedTimedOut: false, steps: [] };

  // `stubs[n]` runs on gate call n+1 with (tipAtEntry, worktreePath, repo) and returns that call's GateSequentialResult; a call
  // past the end (only the re-call in an "aba" variant reaches it) is a plain non-retriable failure. `tipAtEntry` is read
  // from the real worktree the instant the stub is entered — i.e. exactly the tip `captureGatedTip` would have captured.
  const scenarios = [
    { link: "h-transient-kill", gate: "pnpm gate", plant: false, calls: 2,
      stubs: [
        (_t, _w, repo) => { fs.writeFileSync(path.join(repo, "main-advance.txt"), "advanced\n"); commitAll(repo, "main advanced mid-attempt-1", GIT_ID); return killed; },
        () => killed,
      ] },
    { link: "i-single-file", gate: GATE_2STEP, plant: true, calls: 2, lastCommand: "node packages/daemon/scripts/test-daemon.mjs --only=flaky-mid",
      stubs: [
        (_t, w) => { commitFile(w, "fix-i.txt"); return genuineFail([{ step: "pnpm build", durationMs: 1, status: 0 }, { step: "node packages/daemon/test/flaky-mid.mjs", durationMs: 1, status: 1 }]); },
        () => ({ passed: false, failedStep: "node packages/daemon/scripts/test-daemon.mjs --only=flaky-mid", failedStatus: 1, failedSignal: null, failedTimedOut: false, steps: [] }),
      ] },
    { link: "j-resumed-steps", gate: GATE_3STEP, plant: true, calls: 3, lastCommand: "pnpm true-final",
      stubs: [
        () => genuineFail([{ step: "pnpm build", durationMs: 1, status: 0 }, { step: "node packages/daemon/test/flaky-mid.mjs", durationMs: 1, status: 1 }]),
        (_t, w) => { commitFile(w, "fix-j.txt"); return { passed: true, steps: [{ step: "node packages/daemon/scripts/test-daemon.mjs --only=flaky-mid", durationMs: 1, status: 0 }] }; },
        () => ({ passed: false, failedStep: "pnpm true-final", failedStatus: 1, failedSignal: null, failedTimedOut: false, steps: [{ step: "pnpm true-final", durationMs: 1, status: 1 }] }),
      ] },
  ];

  for (const sc of scenarios) for (const variant of ["moved", "aba"]) {
    const tag = `(${sc.link}/${variant})`;
    const sfx = `retry-${sc.link}-${variant}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const reposDir = path.join(os.tmpdir(), `loom-mcvc-${sfx}`);
    const { db, mgrId, workerId, repo, worktreePath, workerSha } = await setupWorkerProject(sfx, reposDir, sc.gate);
    if (sc.plant) plantTestFile(worktreePath, "flaky-mid");
    // Main advances BEFORE op 1 in every scenario so the branch is forwarded: the pre-forward tip (`workerSha`) is then the
    // verdict's unstamped fallback identity and can never coincide with a tip a gate actually ran on.
    fs.writeFileSync(path.join(repo, "main-advance-0.txt"), "advanced\n");
    commitAll(repo, "main advanced before op 1", GIT_ID);
    const tips = [];
    let gateCalls = 0;
    const gateCommands = [];
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
      syncAttachBudgetMs: 60_000,
      runGate: async (gate) => {
        const n = gateCalls++;
        gateCommands.push(gate);
        tips.push(headSha(worktreePath));
        if (n >= sc.calls) return { passed: false, failedStep: "x", failedStatus: 1, failedSignal: null, failedTimedOut: false, steps: [] };
        const res = sc.stubs[n](tips[n], worktreePath, repo);
        // "aba": the FINAL link puts the tip back where the previous link's capture saw it, then fails.
        if (variant === "aba" && n === sc.calls - 1) execSync(`git reset --hard ${tips[n - 1]}`, { cwd: worktreePath });
        return res;
      },
    });
    const r1 = await settleTracked(() => sessions.confirmWorkerMergeTracked(mgrId, workerId), { label: "confirmWorkerMergeTracked" });
    check(`${tag} op 1 settled + rejected after exactly ${sc.calls} gate calls (the chain reached the ${sc.link} link)`, r1.settled === true && r1.ok && r1.value.merged === false && gateCalls === sc.calls);
    if (sc.lastCommand) check(`${tag} the final call ran the ${sc.link} link's own command`, gateCommands[sc.calls - 1] === sc.lastCommand);
    check(`${tag} setup: the tip the final link ran on differs from the previous link's`, tips[sc.calls - 1] !== tips[sc.calls - 2]);
    check(`${tag} setup: the branch was forwarded, so no gate tip is the pre-forward tip`, tips.every((t) => t !== workerSha));
    const callsAfterOp1 = gateCalls;
    const tipAtSettle = headSha(worktreePath);
    const r2 = await settleTracked(() => sessions.confirmWorkerMergeTracked(mgrId, workerId), { label: "confirmWorkerMergeTracked" });
    if (variant === "moved") {
      check(`${tag} the re-call is a cache hit — no further gate call`, r2.settled === true && gateCalls === callsAfterOp1);
      check(`${tag} the cached identity is the tip the FINAL link ran on (RED if that link's captureGatedTip is removed)`, r2.cacheHit?.identity === tips[sc.calls - 1]);
    } else {
      check(`${tag} setup: the final link's stub put the tip back where the previous link saw it`, tipAtSettle === tips[sc.calls - 2]);
      check(`${tag} the re-call RE-GATES — a verdict from a tip the final link never ran on is not cached (RED if that link's captureGatedTip is removed)`, r2.cacheHit === undefined && gateCalls > callsAfterOp1);
    }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — each retry link's own captureGatedTip caches the tip THAT link's gate ran on (card 801b6b39, scenarios h/i/j, moved and aba variants). Scenarios (a)-(g) are in the sibling files."
  : `\n❌ ${failures} FAILURE(S).`);

// Card 82bb198a: this file previously had NO exit-code decision at all — Node's default exit(0)
// applied regardless of `failures`, so the gate's exit-code-only verdict (test-daemon.mjs `runOne`)
// reported PASS even with printed FAIL lines above. registerForCleanup (imported above) already
// installs _tmp-fixture.mjs's `exit`-event sync backstop, so a plain process.exit here still gets
// guaranteed cleanup — matching the corpus's own dominant idiom rather than inventing a second one.
process.exit(failures === 0 ? 0 : 1);
