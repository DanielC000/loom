import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 047af53b item 4 — the create/reuse dep-provisioning ASYMMETRY. REAL git on temp repos under
// %TEMP%, NO claude and NO live daemon — mirrors spawn-recut-stale-branch.mjs's harness shape.
//
// The BUG: createWorktree's dir-present REUSE path (fs.existsSync(worktreePath) branch) calls
// resolveStaleBase, which can auto-forward the branch by REALLY merging main into the worktree
// (mergeMainIntoWorktree — a real file mutation that can bring in a package.json/lockfile change) — then
// returns EARLY with NO provisionWorktreeDeps call, unlike the REATTACH path (branch-present/dir-gone),
// which always provisions after the same resolveStaleBase call. A dependency change the forward just
// brought in is silently never installed on the dir-present path.
//
// This proves the fix is TARGETED, not a blanket "always provision on reuse" — that would cost every
// worker resume a redundant install for zero benefit, since a genuinely unchanged reused worktree's
// node_modules is already current ("already provisioned"). Three states, all asserted:
//   (1) a CLEAN AUTO-FORWARD occurs (main's advance is unrelated to the recovery commit's own file, so it
//       merges clean) → provision MUST fire, because the forward is a real mutation that can carry a dep
//       change.
//   (2) NO staleness at all (branch already at current main) → provision MUST NOT fire — the ordinary
//       "nothing moved, nothing to reinstall" case must stay cheap, unchanged from before this fix.
//   (3) card 1008e305 — NO staleness, but node_modules is simply ABSENT (a worktree whose deps were
//       reclaimed by the node_modules reclaimer while it sat idle) → provision MUST fire even with
//       nothing to forward, closing the gap where a reused worktree would otherwise silently ship with
//       no deps and no trigger to install them.
//   (4) card 1008e305 review finding [2] — NO staleness, node_modules PRESENT but missing pnpm's own
//       `.modules.yaml` completion marker (the shape a wedged/partial reclaim attempt can leave behind —
//       some package dirs deleted, node_modules itself still there) → provision MUST still fire. Plain
//       existence is not enough; the guard must be INTEGRITY-based.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/worktree-reuse-forward-provisions.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-reuse-provision-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const GIT_ID = "-c user.email=reuseprov@loom -c user.name=reuseprov";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const head = (cwd) => git(cwd, "rev-parse HEAD");
const commitInto = (dir, file, body, msg) => {
  fs.writeFileSync(path.join(dir, file), body);
  commitAll(dir, `${msg}`, GIT_ID);
};

// A fake `provision` seam (ProvisionDeps.provision) that never runs a real installer — just records
// how many times + against which worktreePath it was invoked, and always reports success so the
// (unrelated) monorepo-build phase never engages (no pnpm-workspace.yaml is committed below). It DOES
// drop a marker `node_modules` dir ON DISK, INCLUDING pnpm's own `.modules.yaml` completion marker,
// mirroring what a real install leaves behind — card 1008e305's createWorktree reuse-path fix now checks
// for a genuinely INTACT node_modules (existence + the manager's completion marker), not just existence,
// so a stub that never wrote either would make every reuse in this file look "unprovisioned"/"corrupted"
// and fire spuriously.
const provisionCalls = [];
const trackingDeps = {
  provision: async (worktreePath) => {
    provisionCalls.push(worktreePath);
    fs.mkdirSync(path.join(worktreePath, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, "node_modules", ".modules.yaml"), "hoistedDependencies: {}\n");
    return { ok: true };
  },
};

const repo = path.join(os.tmpdir(), `loom-reuse-provision-repo-${Date.now()}-${process.pid}`);
const PROJ = "projReuseProvision";

try {
  // A real repo with a committed pnpm-lock.yaml so detectPackageManager() finds "pnpm" — the ONLY thing
  // provisionWorktreeDeps needs to decide there's something to install (no pnpm-workspace.yaml, so the
  // monorepo build phase never engages — this test is scoped to the install call alone).
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "package.json"), '{"name":"reuse-provision-fixture"}\n');
  fs.writeFileSync(path.join(repo, "pnpm-lock.yaml"), "lockfileVersion: '6.0'\n");
  execSync(`git init -q`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);

  // ============================================================================================
  // (1) CLEAN AUTO-FORWARD on the DIR-PRESENT reuse path → provisionWorktreeDeps MUST fire.
  // ============================================================================================
  const t1 = "reuse-forward-1111";
  const First = await createWorktree(repo, PROJ, t1, trackingDeps); // fresh cut → provisions once
  check("(1 setup) fresh cut provisioned once", provisionCalls.length === 1 && provisionCalls[0] === First.worktreePath);
  provisionCalls.length = 0;
  commitInto(First.worktreePath, "recovery.txt", "real prior work\n", "recovery commit"); // 1 ahead, recovery shape
  // main advances with an UNRELATED file (so the forward merges clean) that also bumps the lockfile —
  // the exact "package.json/lockfile change the forward brings in" shape the reattach path's own comment
  // names.
  commitInto(repo, "main-advance.txt", "advance\n", "advance main");
  fs.writeFileSync(path.join(repo, "pnpm-lock.yaml"), "lockfileVersion: '6.0'\n# bumped\n");
  commitAll(repo, "bump lockfile", GIT_ID);
  const mainAfterAdvance = head(repo);
  check("(1 setup) branch is stale relative to current main", git(repo, `rev-list --count ${mainAfterAdvance}..${First.branch}`) === "1");
  // Review finding [4]: assert the precondition EXPLICITLY rather than leaving it an unasserted mock
  // side effect — if the stub's own node_modules/marker writes are ever removed, (2) fails loudly (safe)
  // while (1) would otherwise keep PASSING for the wrong reason (the forward, not the reuse guard, would
  // be the only thing exercised).
  check("(1 setup) node_modules is genuinely INTACT before the reuse call (both marker + dir present)",
    fs.existsSync(path.join(First.worktreePath, "node_modules", ".modules.yaml")));

  // Re-spawn on the SAME task → dir-present REUSE path (worktree dir still exists).
  const Reused = await createWorktree(repo, PROJ, t1, trackingDeps);
  check("(1) dir-present reuse: clean auto-forward → staleBase ABSENT (resolved transparently)", Reused.staleBase === undefined);
  check("(1) dir-present reuse: worktree WAS forwarded (real mutation happened)",
    fs.readFileSync(path.join(Reused.worktreePath, "main-advance.txt"), "utf8").trim() === "advance");
  check("(1) dir-present reuse: forwarded lockfile content landed in the worktree",
    fs.readFileSync(path.join(Reused.worktreePath, "pnpm-lock.yaml"), "utf8").includes("bumped"));
  check("(1) FIX: provisionWorktreeDeps fired exactly once for this forward (asymmetry closed)",
    provisionCalls.length === 1 && provisionCalls[0] === Reused.worktreePath);
  execSync(`git worktree remove --force "${Reused.worktreePath}"`, { cwd: repo });
  execSync(`git ${GIT_ID} branch -D ${Reused.branch}`, { cwd: repo });
  provisionCalls.length = 0;

  // ============================================================================================
  // (2) NO staleness at all on the DIR-PRESENT reuse path → provisionWorktreeDeps must NOT fire.
  // ============================================================================================
  const t2 = "reuse-forward-2222";
  const Second = await createWorktree(repo, PROJ, t2, trackingDeps); // fresh cut off current main → provisions once
  check("(2 setup) fresh cut provisioned once", provisionCalls.length === 1);
  provisionCalls.length = 0;

  // Re-spawn immediately, main unchanged → branch is 0-ahead/0-behind current main: no staleness, no
  // forward, nothing new to install. The ordinary "already provisioned" case must stay cheap.
  const Untouched = await createWorktree(repo, PROJ, t2, trackingDeps);
  check("(2) dir-present reuse, no staleness: staleBase ABSENT (nothing to forward)", Untouched.staleBase === undefined);
  check("(2) NOT REGRESSED: provisionWorktreeDeps did NOT fire when nothing was forwarded",
    provisionCalls.length === 0);

  // ============================================================================================
  // (3) card 1008e305: node_modules ABSENT (e.g. reclaimed from a retained-but-dead worktree between
  //     spawns) on the DIR-PRESENT reuse path, with NO staleness to forward → provisionWorktreeDeps MUST
  //     still fire. Without this, a worktree reused after a node_modules reclaim would silently ship with
  //     no deps and nothing to trigger installing them.
  // ============================================================================================
  fs.rmSync(path.join(Untouched.worktreePath, "node_modules"), { recursive: true, force: true });
  const Reprovisioned = await createWorktree(repo, PROJ, t2, trackingDeps);
  check("(3) dir-present reuse, no staleness, node_modules ABSENT: staleBase still absent (nothing to forward)", Reprovisioned.staleBase === undefined);
  check("(3) FIX: provisionWorktreeDeps fires when node_modules is missing, even with no forward",
    provisionCalls.length === 1 && provisionCalls[0] === Reprovisioned.worktreePath);
  check("(3) node_modules is back on disk after the reinstall trigger", fs.existsSync(path.join(Reprovisioned.worktreePath, "node_modules")));
  provisionCalls.length = 0;

  // ============================================================================================
  // (4) card 1008e305 review finding [2]: node_modules PRESENT but missing the pnpm completion marker —
  //     the shape a wedged/partial reclaim attempt can leave behind (some package dirs already deleted,
  //     the directory itself still there) → provisionWorktreeDeps MUST still fire. Plain existence would
  //     wrongly treat this as "already provisioned".
  // ============================================================================================
  fs.rmSync(path.join(Reprovisioned.worktreePath, "node_modules", ".modules.yaml"), { force: true });
  check("(4 setup) node_modules still exists, marker removed (simulates a partial/wedged residue)",
    fs.existsSync(path.join(Reprovisioned.worktreePath, "node_modules"))
    && !fs.existsSync(path.join(Reprovisioned.worktreePath, "node_modules", ".modules.yaml")));
  const Reintegrityfixed = await createWorktree(repo, PROJ, t2, trackingDeps);
  check("(4) dir-present reuse, no staleness, node_modules PRESENT but NOT INTACT: staleBase still absent", Reintegrityfixed.staleBase === undefined);
  check("(4) FIX: provisionWorktreeDeps fires on a present-but-corrupted node_modules (integrity check, not mere existence)",
    provisionCalls.length === 1 && provisionCalls[0] === Reintegrityfixed.worktreePath);
  check("(4) the marker is back after reinstall", fs.existsSync(path.join(Reintegrityfixed.worktreePath, "node_modules", ".modules.yaml")));
  execSync(`git worktree remove --force "${Untouched.worktreePath}"`, { cwd: repo });
} finally {
  try { execSync("git worktree prune", { cwd: repo }); } catch { /* ignore */ }
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — createWorktree's dir-present REUSE path now provisions deps exactly when resolveStaleBase actually forwarded the branch (a real mutation that can carry a dep change), OR node_modules is not INTACT (absent, or present-but-missing-its-completion-marker, both card 1008e305's reclaim gaps), and stays a no-op (unchanged cost) only when nothing was stale to forward AND deps are genuinely intact — closing all three asymmetries without making every ordinary reuse pay for a redundant install."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
