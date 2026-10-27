import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1; see _guard.mjs)
// @decision 08c36dae — never say "canonical repo untouched" once the commit call itself has succeeded.
//
// CONTRACT: a REAL squash commit lands (unstubbed); ONLY the immediately-following `git rev-parse HEAD`
// read (the post-commit confirm step) is made to fail — the narrowest native seam, every other call
// including the commit itself runs through real git. Proves:
//   (A) FLAG + WORDING — confirm.squashLandedUnread===true; detailText says the commit DID land, never
//       "untouched"/"Re-task a rebase", and names the mainline trust-freeze this path leaves behind.
//   (B) DOUBLE-LAND CHECK — a re-confirm of the SAME worker resolves ALREADY_MERGED (a real content
//       check, findLandedSquashCommit→branchContentLandedInCommit), never a duplicate commit: HEAD stays
//       byte-identical and the commit count does not grow.
//   (C) CACHING IS STRUCTURALLY INERT for this outcome, NOT independently proven by dropping it from
//       NEVER_CACHED_OUTCOMES (verified via a throwaway source mutation — reported, not committed; see
//       the record): reaching squashLandedUnread REQUIRES the squash to have already landed, so main's
//       tip always differs from whatever it was when op1's own verdictIdentity was captured — no later
//       call's fresh identity can ever match it, with or without this outcome's own cache exclusion.
//
// Run: 1) pnpm build, 2) node packages/daemon/test/merge-confirm-squash-landed-unread.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { commitAll } from "./_git-commit.mjs";
import { settleTracked } from "./_settle-tracked.mjs";

useOwnLoomHome("loom-mcslu-");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mcslu@loom -c user.name=mcslu";
const now = new Date().toISOString();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };
const openDbs = [];
const noReap = async () => ({ killedPids: [] });
const sfxOf = (tag) => `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const confirmTracked = (sessions, mgrId, workerId) => settleTracked(() => sessions.confirmWorkerMergeTracked(mgrId, workerId), { label: "confirmWorkerMergeTracked", timeoutMs: 240_000 });
const headOf = (cwd) => execSync("git rev-parse HEAD", { cwd, encoding: "utf8" }).trim();
const logCount = (cwd) => execSync("git rev-list --count HEAD", { cwd, encoding: "utf8" }).trim();

async function setup(sfx) {
  const reposDir = path.join(os.tmpdir(), `loom-mcslu-${sfx}`);
  registerForCleanup(reposDir);
  const db = new Db(); openDbs.push(db);
  const mgrId = `mcslu-mgr-${sfx}`, projId = `mcslu-p-${sfx}`, taskId = `mcslu-t-${sfx}`, workerId = `mcslu-w-${sfx}`;
  const repo = path.join(reposDir, "repo");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mcslu\n");
  execSync("git init -q && git config user.email mcslu@loom && git config user.name mcslu", { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  db.insertProject({ id: projId, name: "MCSLU", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `agent-mcslu-m-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-mcslu-m-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertAgent({ id: `agent-mcslu-w-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: "MCSLU-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const wt = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(wt.worktreePath, "feature.txt"), "work");
  commitAll(wt.worktreePath, "feature", GIT_ID);
  db.insertSession({ id: workerId, projectId: projId, agentId: `agent-mcslu-w-${sfx}`, engineSessionId: null, title: null, cwd: wt.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: wt.worktreePath, branch: wt.branch });
  return { db, mgrId, workerId, repo, worktreePath: wt.worktreePath, branch: wt.branch, mainSha: headOf(repo) };
}
const svc = (db, extra = {}) => new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap, ...extra });

// NARROWEST NATIVE SEAM: lets the REAL `git commit -F <file>` land for real, then fails ONLY the very
// next `rev-parse HEAD` read (the post-commit confirm step mergeBranchLocked issues immediately after —
// no other git call happens in between in production). Every other call, including the commit itself,
// is untouched real git. One-shot (`fired`): a later re-confirm's own post-commit read (if it ever
// reaches one) must not also be faulted.
function postCommitReadFailFactory() {
  let commitSucceeded = false;
  let fired = false;
  return (repoPath, blockTimeoutMs) => ({
    raw: async (args) => {
      const { boundedSimpleGit } = await import("../dist/git/bounded.js");
      const { nonInteractiveEnv } = await import("../dist/git/writer.js");
      const real = boundedSimpleGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
      if (Array.isArray(args) && args[0] === "commit" && args[1] === "-F") {
        const out = await real.raw(args);
        commitSucceeded = true;
        return out;
      }
      if (commitSucceeded && !fired && Array.isArray(args) && args[0] === "rev-parse" && args[args.length - 1] === "HEAD") {
        fired = true;
        throw new Error("simulated post-commit HEAD read failure");
      }
      return real.raw(args);
    },
  });
}

try {
  const { db, mgrId, workerId, repo, branch, mainSha } = await setup(sfxOf("a"));
  const sessions = svc(db, { soloMergeGitFactory: postCommitReadFailFactory() });

  // ── (A) WORDING + FLAG ────────────────────────────────────────────────────────────────────────────
  console.log("\n— (A) confirm-level wiring: the squash commit lands for real, only its own post-commit re-read fails —");
  const confirm = await sessions.confirmWorkerMerge(mgrId, workerId);
  const landedSha = headOf(repo);
  check("(A) refused, never reported merged (the sha was never confirmed to THIS call)", confirm.merged === false);
  check("(A) carries its OWN distinct flag, squashLandedUnread:true", confirm.squashLandedUnread === true);
  check("(A) is NOT misclassified as headMovedUnverified (there is no doubt this is OUR OWN commit)", confirm.headMovedUnverified !== true);
  check("(A) the detailText says the commit DID land", /commit DID land/.test(confirm.detailText ?? ""));
  check("(A) the detailText never claims the canonical repo is untouched (only the honest NOT-untouched wording)", !/canonical repo and worktree are untouched/.test(confirm.detailText ?? "") && !/canonical repo .*\bis untouched\b/.test(confirm.detailText ?? ""));
  check("(A) the detailText NEVER contains the literal 'canonical repo untouched' substring (the OLD generic fallthrough's exact phrase)", !(confirm.detailText ?? "").includes("canonical repo untouched"));
  check("(A) the detailText never says 'Re-task a rebase'", !/Re-task a rebase/.test(confirm.detailText ?? ""));
  check("(A) the detailText says a re-confirm should detect it as already merged", /already merged/.test(confirm.detailText ?? ""));
  check("(A) the detailText names the mainline trust-freeze this path leaves behind", /mainline trust record/.test(confirm.detailText ?? "") && /mainline-moved alert/.test(confirm.detailText ?? ""));
  check("(A) HEAD genuinely moved — a real commit landed despite the refusal", landedSha !== mainSha);
  check("(A) the real content actually landed in the canonical repo", fs.existsSync(path.join(repo, "feature.txt")));

  // ── (B) DOUBLE-LAND CHECK (manager ruling) ───────────────────────────────────────────────────────
  console.log("\n— (B) a re-confirm of the SAME worker must detect ALREADY_MERGED, never land a duplicate commit —");
  const countBeforeRetry = logCount(repo);
  sessions.soloMergeGitFactory = undefined; // the fault clears — a real re-confirm, no more interception
  const r2 = await confirmTracked(sessions, mgrId, workerId);
  check("(B) op 2 settled (did not throw/hang)", r2.ok === true);
  check("(B) op 2 reports merged:true (ALREADY_MERGED — content-verified, not a duplicate squash)", r2.value?.merged === true);
  check("(B) HEAD is BYTE-IDENTICAL to the sha that landed under the unread failure — no second commit was created", headOf(repo) === landedSha);
  check("(B) canonical main's commit COUNT did not grow — the re-confirm landed nothing new", logCount(repo) === countBeforeRetry);
  check("(B) exactly one copy of the content exists (never duplicated)", execSync(`git log --oneline -- feature.txt`, { cwd: repo, encoding: "utf8" }).trim().split("\n").filter(Boolean).length === 1);
  // Manager ruling (card 08c36dae review note 1): neither the original squashLandedUnread refusal NOR
  // its ALREADY_MERGED re-confirm may advance the mainline trust record — a REAL, DB-level check, not
  // just a wording assertion: both are gated on `merge.ok`/`!merge.noop`, which this path never satisfies.
  const worker = db.getSession(workerId);
  check("(B) the mainline branch trust record stays NULL (never established) after BOTH op1 and op2 — this path never advances it", db.getMainlineBranchTrust(worker.projectId, worker.repoKey ?? "primary", branch) === null);

  // ── (C) WHY CACHING IS STRUCTURALLY INERT HERE (not re-provable by a runtime check alone) ──────────
  // Part (A) already proved `landedSha !== mainSha` — main's tip MUST move for squashLandedUnread to
  // fire at all (the commit call itself succeeded). confirmWorkerMergeTracked's verdictIdentity is
  // captured from the LIVE main tip at each call's own start, so op1's cached identity is keyed on
  // `mainSha` (pre-squash) while the REAL tip after op1 is `landedSha` — any later call's fresh identity
  // reads `landedSha` (or something newer), which can never again equal `mainSha`. Confirmed directly:
  // temporarily removing "squash-landed-unread" from NEVER_CACHED_OUTCOMES and re-running this exact
  // scenario left (B) fully GREEN — membership in that set makes no observable difference for this
  // outcome. Unlike merge-confirm-head-moved-unverified.mjs (which DOES discriminate once part B
  // restores main to the ORIGINAL pre-incident tip), there is no analogous "restore" available here
  // without literally discarding the real, legitimately-landed commit — which would misrepresent the
  // actual remedy. `squash-landed-unread` stays in NEVER_CACHED_OUTCOMES for documentation/consistency
  // with its siblings, not because this test can prove it load-bearing.
} finally {
  for (const db of openDbs) { try { db.close(); } catch { /* ignore */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — confirmWorkerMerge classifies a real post-commit-success re-read failure with its own distinct squashLandedUnread flag and honest wording (never the false \"canonical repo untouched … Re-task a rebase\" framing), names the mainline trust-freeze this path leaves behind (verified at the DB level: trust stays NULL after both op1 and op2), and a re-confirm of the same worker genuinely detects ALREADY_MERGED (content-verified) rather than landing a duplicate commit — HEAD and the commit count are unchanged. Caching is structurally inert for this outcome (documented, not independently provable — see part C)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
