import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1; see _guard.mjs)
// @decision 08c36dae — never classify this flag from message text; always `instanceof CanonicalGitRefusal`.
//
// CONTRACT: a REAL commondir-trust-pin mismatch (the same production seam
// identity-fallback-probe-residue.mjs uses) trips the pre-squash identity probe via
// confirmWorkerMergeTracked. Proves:
//   (A) FLAG + WORDING — confirm.canonicalTrustRefusal===true; detailText never says "untouched …
//       Re-task a rebase"; merge.reason's own canonicalFailureMessage remedy survives verbatim.
//   (B) NEVER-CACHED — op 1 refuses; once the condition clears, op 2 genuinely re-attempts and lands.
//
// Run: 1) pnpm build, 2) node packages/daemon/test/merge-confirm-canonical-trust-refusal.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { commitAll } from "./_git-commit.mjs";
import { settleTracked } from "./_settle-tracked.mjs";

useOwnLoomHome("loom-mcctr-");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { registerCommondirTrustPinLookup } = await import("../dist/git/bounded.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mcctr@loom -c user.name=mcctr";
const now = new Date().toISOString();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };
const openDbs = [];
const noReap = async () => ({ killedPids: [] });
const sfxOf = (tag) => `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const confirmTracked = (sessions, mgrId, workerId) => settleTracked(() => sessions.confirmWorkerMergeTracked(mgrId, workerId), { label: "confirmWorkerMergeTracked", timeoutMs: 240_000 });
const headOf = (cwd) => execSync("git rev-parse HEAD", { cwd, encoding: "utf8" }).trim();

async function setup(sfx) {
  const reposDir = path.join(os.tmpdir(), `loom-mcctr-${sfx}`);
  registerForCleanup(reposDir);
  const db = new Db(); openDbs.push(db);
  const mgrId = `mcctr-mgr-${sfx}`, projId = `mcctr-p-${sfx}`, taskId = `mcctr-t-${sfx}`, workerId = `mcctr-w-${sfx}`;
  const repo = path.join(reposDir, "repo");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mcctr\n");
  execSync("git init -q && git config user.email mcctr@loom && git config user.name mcctr", { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  db.insertProject({ id: projId, name: "MCCTR", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `agent-mcctr-m-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-mcctr-m-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertAgent({ id: `agent-mcctr-w-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: "MCCTR-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const wt = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(wt.worktreePath, "feature.txt"), "work");
  commitAll(wt.worktreePath, "feature", GIT_ID);
  db.insertSession({ id: workerId, projectId: projId, agentId: `agent-mcctr-w-${sfx}`, engineSessionId: null, title: null, cwd: wt.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: wt.worktreePath, branch: wt.branch });
  return { db, mgrId, workerId, repo, worktreePath: wt.worktreePath, branch: wt.branch, mainSha: headOf(repo) };
}
const svc = (db, extra = {}) => new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap, ...extra });

// PRODUCTION-SHAPED fault: a real commondir-trust-pin mismatch via checkCommondirTrust (same mechanism
// `identity-fallback-probe-residue.mjs` already proves at the mergeBranch layer), triggered via
// `soloMergeGitFactory` — mergeBranchLocked's identity probe falls back to
// `unpinnedProbeFactoryFromLegacy(deps.gitFactory)` when no dedicated `identityProbeGitFactory` is
// threaded (confirmWorkerMergeTracked never sets one), so this single seam reaches the SAME real throw
// path a production call would. `untrusted` flips true only on the probe's own `git var` call, never on
// the earlier reads (resolveBranchTip/gate-base/entry checks), so those still see a clean, trusted repo.
function identityProbeTrustFlipFactory() {
  let untrusted = false;
  registerCommondirTrustPinLookup((_p) => (untrusted
    ? { toplevel: "C:\\fake\\pinned", pinnedAt: "2026-01-01T00:00:00.000Z", source: "bind", projectId: "p", repoKey: "r" }
    : null));
  return (repoPath, blockTimeoutMs) => ({
    raw: async (args) => {
      if (Array.isArray(args) && args[0] === "var" && (args[1] === "GIT_AUTHOR_IDENT" || args[1] === "GIT_COMMITTER_IDENT")) {
        untrusted = true;
      }
      const { canonicalGit } = await import("../dist/git/bounded.js");
      const { nonInteractiveEnv } = await import("../dist/git/writer.js");
      const real = canonicalGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
      return real.raw(args);
    },
  });
}

try {
  // ── (A) WORDING + FLAG ────────────────────────────────────────────────────────────────────────────
  {
    console.log("\n— (A) confirm-level wiring: a real commondir-trust-pin mismatch trips the identity probe —");
    const { db, mgrId, workerId, repo, branch, mainSha } = await setup(sfxOf("a"));
    const sessions = svc(db, { soloMergeGitFactory: identityProbeTrustFlipFactory() });

    const confirm = await sessions.confirmWorkerMerge(mgrId, workerId);
    check("(A) refused, never merged", confirm.merged === false);
    check("(A) carries its OWN distinct flag, canonicalTrustRefusal:true", confirm.canonicalTrustRefusal === true);
    check("(A) is NOT misclassified as a conflict", confirm.conflict !== true);
    check("(A) is NOT misclassified as quarantined/transient (a clean, structural trust refusal)", !confirm.quarantined && !confirm.transient);
    check("(A) the detailText states nothing was squashed / canonical repo untouched", /nothing was squashed — canonical repo and worktree are untouched/.test(confirm.detailText ?? ""));
    check("(A) the detailText never says 'squash was attempted' (the generic merge_failed wording)", !/squash was attempted/.test(confirm.detailText ?? ""));
    check("(A) the detailText never says 'Re-task a rebase' (the generic — and here actively wrong — remedy)", !/Re-task a rebase/.test(confirm.detailText ?? ""));
    check("(A) the detailText instead names this a canonical-git TRUST refusal", /TRUST refusal/.test(confirm.detailText ?? ""));
    check("(A) the identity-fallback probe's own canonicalFailureMessage remedy survives verbatim in reason", (confirm.reason ?? "").includes("identity-fallback probe:") && (confirm.reason ?? "").includes("refused, nothing changed"));
    check("(A) nothing landed — HEAD unchanged", headOf(repo) === mainSha);
    const staged = execSync("git diff --cached --name-only", { cwd: repo, encoding: "utf8" }).trim();
    check("(A) canonical index genuinely untouched (nothing staged)", staged === "");
  }

  // (A)'s own factory left the GLOBAL commondir-trust-pin lookup registered with `untrusted:true` —
  // reset it BEFORE (B)'s own `setup()` runs, or `createWorktree`'s own canonicalGit calls there would
  // see A's stale trust mismatch and throw before (B) ever gets to exercise anything of its own.
  registerCommondirTrustPinLookup(undefined);

  // ── (B) NEVER-CACHED ──────────────────────────────────────────────────────────────────────────────
  {
    console.log("\n— (B) a re-confirm after the trust condition clears must genuinely re-attempt, not replay the refusal —");
    const { db, mgrId, workerId, repo, branch, mainSha } = await setup(sfxOf("b"));
    const factory = identityProbeTrustFlipFactory();
    const sessions = svc(db, { soloMergeGitFactory: factory });

    const r1 = await confirmTracked(sessions, mgrId, workerId);
    check("(B) op 1: refused via canonicalTrustRefusal (a genuine fresh mint)", r1.ok === true && r1.value?.merged === false && r1.value?.canonicalTrustRefusal === true);
    check("(B) op 1: nothing landed", headOf(repo) === mainSha);

    // Remove the fault (the real remedy: a human re-pins/clears the condition) — a cached rejection
    // would replay op 1's refusal verbatim; the actual fix re-derives and merges.
    registerCommondirTrustPinLookup(undefined);
    sessions.soloMergeGitFactory = undefined;
    const r2 = await confirmTracked(sessions, mgrId, workerId);
    check("(B) op 2: genuinely re-attempted and LANDED (not a replayed rejection)", r2.ok === true && r2.value?.merged === true);
    check("(B) THE NEVER-CACHED PROOF (structural): op 2 carries NO cacheHit — canonical-trust-refusal is excluded from the until-superseded cache", r2.cacheHit === undefined);
    check("(B) the real content actually landed", fs.existsSync(path.join(repo, "feature.txt")));
  }
} finally {
  registerCommondirTrustPinLookup(undefined);
  for (const db of openDbs) { try { db.close(); } catch { /* ignore */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — confirmWorkerMerge classifies a real canonical-git trust refusal with its own distinct canonicalTrustRefusal flag and honest wording (never the generic merge_failed/\"Re-task a rebase\" framing), while preserving the identity probe's own specific remedy text verbatim, and the refusal is never cached — a re-confirm after the trust condition clears genuinely re-attempts and lands."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
