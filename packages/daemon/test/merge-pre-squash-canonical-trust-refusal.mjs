import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision c395b4fb — classify a canonicalGit refusal by `instanceof CanonicalGitRefusal`
// (trustRefusalResult), never by message text, at every pre-squash mergeBranchLocked call site.
//
// PROVES: a REAL CanonicalGitRefusal (registerCommondirTrustPinLookup, never a message-text fake)
// classifies as canonicalTrustRefusal at 7 sites (A-G): gate-base HEAD re-check, mainline pre-check,
// cut-base target-tip read, checkCutBaseAncestry's merge-base probe, residue-clear's ls-files probe,
// staged-at-entry, status-at-entry. (E2) proves the SAME ls-files site's non-trust ordinary-failure
// path classifies residuePossible instead, never canonicalTrustRefusal.
//
// HOW + full narrative: docs/decisions/c395b4fb-residue-flags-and-pre-squash-trust-refusal-sites.md
// ("Test design").
//
// RED/GREEN: `pnpm --filter @loom/daemon negative-control --file packages/daemon/src/git/worktrees.ts
// --file packages/daemon/src/git/mainline-watch.ts --test
// packages/daemon/test/merge-pre-squash-canonical-trust-refusal.mjs --ref 16af28e9`.
// Run: pnpm build, then node test/merge-pre-squash-canonical-trust-refusal.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { commitAll } from "./_git-commit.mjs";
import { useOwnLoomHome, registerForCleanup } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";

useOwnLoomHome("loom-pstr-");
requireHermeticEnv();

const { mergeBranch } = await import("../dist/git/worktrees.js");
const { registerCommondirTrustPinLookup, canonicalGit, CanonicalGitRefusal } = await import("../dist/git/bounded.js");
const { nonInteractiveEnv } = await import("../dist/git/writer.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=pstr@loom -c user.name=pstr";

function freshDir(tag) {
  const dir = path.join(os.tmpdir(), `loom-pstr-${tag}-${Date.now()}-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  registerForCleanup(dir);
  return dir;
}

function makeRepoWithBranch(tag, branch) {
  const repo = freshDir(`repo-${tag}`);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "pstr@loom"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "pstr"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "init\n");
  commitAll(repo, "init", GIT_ID);
  // A branch pointing at the SAME commit — resolveBranchTip only needs refs/heads/<branch> to resolve;
  // none of these scenarios ever reach the actual squash.
  execFileSync("git", ["branch", branch], { cwd: repo });
  return repo;
}

/** Flips `untrusted` the FIRST time `matchFn(args)` is true, then stays flipped; delegates every call to
 *  the REAL canonicalGit, which re-checks trust fresh via the registered lookup on every call. */
function trustFlipFactory(matchFn) {
  let untrusted = false;
  registerCommondirTrustPinLookup((_p) => (untrusted
    ? { toplevel: "C:\\fake\\pinned", pinnedAt: "2026-01-01T00:00:00.000Z", source: "bind", projectId: "p", repoKey: "r" }
    : null));
  return (repoPath, blockTimeoutMs) => ({
    raw: async (args) => {
      const argv = Array.isArray(args) ? args : [args];
      if (!untrusted && matchFn(argv)) untrusted = true;
      const real = canonicalGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
      return real.raw(args);
    },
  });
}

function assertTrustRefusal(label, result) {
  check(`${label} refused, never merged`, result.ok === false);
  check(`${label} carries its own distinct flag, canonicalTrustRefusal:true`, result.canonicalTrustRefusal === true);
  check(`${label} is NOT misclassified as a conflict`, result.conflict !== true);
  check(`${label} is NOT misclassified as quarantined/transient (a clean, structural trust refusal)`, !result.quarantined && !result.transient);
  check(`${label} is NOT the new preSquashResidueUnclearable flag either (a different site/cause)`, result.preSquashResidueUnclearable !== true);
  check(`${label} never says "squash was attempted" (the generic merge_failed wording)`, !/squash was attempted/.test(result.reason ?? ""));
  check(`${label} never says "Re-task a rebase" (the generic — and here actively wrong — remedy)`, !/Re-task a rebase/.test(result.reason ?? ""));
  check(`${label} reason carries the structural refusal's own text`, /canonicalGit: refusing/.test(result.reason ?? ""));
}

try {
  // ── (A) gate-base HEAD re-check ──────────────────────────────────────────────────────────────────
  {
    console.log("\n— (A) the gate-base HEAD re-check hits a persistent trust refusal —");
    const repo = makeRepoWithBranch("a", "loom/pstr-a");
    const factory = trustFlipFactory((args) => args[0] === "rev-parse" && args[1] === "HEAD" && args.length === 2);
    // requireCanonicalHead set to ANY value (never compared — the trust refusal fires first);
    // gateBaseBranchHead left undefined so branchStableSinceGateBase stays false.
    const result = await mergeBranch(repo, "loom/pstr-a", "Fix A", { gitFactory: factory }, "0".repeat(40));
    assertTrustRefusal("(A)", result);
    registerCommondirTrustPinLookup(undefined);
  }

  // ── (B) mainline-branch pre-check ────────────────────────────────────────────────────────────────
  {
    console.log("\n— (B) the mainline-branch pre-check hits a persistent trust refusal —");
    const repo = makeRepoWithBranch("b", "loom/pstr-b");
    const factory = trustFlipFactory((args) => args[0] === "rev-parse" && args.includes("--symbolic-full-name"));
    const result = await mergeBranch(repo, "loom/pstr-b", "Fix B", { gitFactory: factory }, undefined, undefined, undefined, undefined, "main");
    assertTrustRefusal("(B)", result);
    check("(B) is NOT the generic 'unverified' branch-divert shape", result.unverified !== true);
    registerCommondirTrustPinLookup(undefined);
  }

  // ── (C) cut-base ancestry check's own canonical-target-tip read ─────────────────────────────────
  {
    console.log("\n— (C) the cut-base ancestry check's own target-tip read hits a persistent trust refusal —");
    const repo = makeRepoWithBranch("c", "loom/pstr-c");
    const anySha = "0".repeat(40);
    const factory = trustFlipFactory((args) => args[0] === "rev-parse" && args[1] === "HEAD" && args.length === 2);
    const result = await mergeBranch(repo, "loom/pstr-c", "Fix C", { gitFactory: factory }, undefined, undefined, undefined, undefined, undefined, undefined, undefined, anySha);
    assertTrustRefusal("(C)", result);
    check("(C) is NOT the generic 'fork-point-unverified' shape", result.forkPointUnverified !== true);
    registerCommondirTrustPinLookup(undefined);
  }

  // ── (D) checkCutBaseAncestry's own merge-base probe ──────────────────────────────────────────────
  {
    console.log("\n— (D) checkCutBaseAncestry's own merge-base probe hits a persistent trust refusal —");
    const repo = makeRepoWithBranch("d", "loom/pstr-d");
    const anySha = "0".repeat(40);
    const factory = trustFlipFactory((args) => args[0] === "merge-base");
    const result = await mergeBranch(repo, "loom/pstr-d", "Fix D", { gitFactory: factory }, undefined, undefined, undefined, undefined, undefined, undefined, undefined, anySha);
    assertTrustRefusal("(D)", result);
    check("(D) is NOT the generic 'fork-point-unverified' shape", result.forkPointUnverified !== true);
    registerCommondirTrustPinLookup(undefined);
  }

  // ── (E) residue-clear block's ls-files probe (outer catch, narrowed from a catch-all) ───────────
  // Code Review round 2, finding 2: a PERSISTENT flip (trustFlipFactory) doesn't isolate the fault to
  // THIS call alone — it stays flipped for every LATER canonicalGit call in the same mergeBranch
  // invocation too (sites F/G), so reverting only ls-files's own catch to a bare `catch {}` would still
  // leave F/G's own (untouched) checks refusing next, and this test would stay GREEN for the wrong
  // reason. Throw directly, ONLY for the ls-files argv, never touching the shared trust-pin lookup at
  // all — every OTHER call (including F/G) stays genuinely, unconditionally trusted.
  {
    console.log("\n— (E) the residue-clear block's ls-files probe hits a persistent trust refusal —");
    const repo = makeRepoWithBranch("e", "loom/pstr-e");
    const factory = (repoPath, blockTimeoutMs) => ({
      raw: async (args) => {
        const argv = Array.isArray(args) ? args : [args];
        if (argv[0] === "ls-files") throw new CanonicalGitRefusal("canonicalGit: refusing — simulated trust refusal, ls-files only");
        const real = canonicalGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
        return real.raw(args);
      },
    });
    const result = await mergeBranch(repo, "loom/pstr-e", "Fix E", { gitFactory: factory });
    assertTrustRefusal("(E)", result);
  }

  // ── (E2) the SAME ls-files site, a non-trust ordinary failure ──────────────────────────────────────
  // Code Review round 2, finding 2: the fail-closed, residuePossible-on-any-OTHER-failure half of the
  // Part-4 narrowing had zero coverage. A plain Error (never CanonicalGitRefusal, never "not a git
  // repository") on the SAME ls-files call, isolated the same way as (E).
  {
    console.log("\n— (E2) the SAME ls-files site, a plain non-trust failure, fails closed with residuePossible —");
    const repo = makeRepoWithBranch("e2", "loom/pstr-e2");
    const factory = (repoPath, blockTimeoutMs) => ({
      raw: async (args) => {
        const argv = Array.isArray(args) ? args : [args];
        if (argv[0] === "ls-files") throw new Error("simulated ordinary ls-files probe failure");
        const real = canonicalGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
        return real.raw(args);
      },
    });
    const result = await mergeBranch(repo, "loom/pstr-e2", "Fix E2", { gitFactory: factory });
    check("(E2) refused, never merged", result.ok === false);
    check("(E2) THE FIX: fails closed with residuePossible:true (never silently 'no residue')", result.residuePossible === true);
    check("(E2) is NOT canonicalTrustRefusal (an ordinary failure, not a trust refusal)", result.canonicalTrustRefusal !== true);
    check("(E2) is NOT preSquashResidueUnclearable (a different site/cause)", result.preSquashResidueUnclearable !== true);
    check("(E2) is NOT quarantined/transient", !result.quarantined && !result.transient);
    check("(E2) reason names the real pre-squash probe failure", /failed to inspect canonical repo for in-progress-merge residue before squashing/.test(result.reason ?? ""));
  }

  // ── (F) staged-at-entry check ─────────────────────────────────────────────────────────────────────
  {
    console.log("\n— (F) the staged-at-entry check hits a persistent trust refusal —");
    const repo = makeRepoWithBranch("f", "loom/pstr-f");
    const factory = trustFlipFactory((args) => args[0] === "diff" && args.includes("--cached") && args.includes("--name-only"));
    const result = await mergeBranch(repo, "loom/pstr-f", "Fix F", { gitFactory: factory });
    assertTrustRefusal("(F)", result);
    registerCommondirTrustPinLookup(undefined);
  }

  // ── (G) status-at-entry check ─────────────────────────────────────────────────────────────────────
  {
    console.log("\n— (G) the status-at-entry check hits a persistent trust refusal —");
    const repo = makeRepoWithBranch("g", "loom/pstr-g");
    const factory = trustFlipFactory((args) => args[0] === "status" && args.includes("--porcelain"));
    const result = await mergeBranch(repo, "loom/pstr-g", "Fix G", { gitFactory: factory });
    assertTrustRefusal("(G)", result);
    registerCommondirTrustPinLookup(undefined);
  }
} finally {
  registerCommondirTrustPinLookup(undefined);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — every pre-squash mergeBranchLocked canonicalGit call site this card touched classifies a real, structural CanonicalGitRefusal as canonicalTrustRefusal, never the generic merge_failed/\"Re-task a rebase\" framing."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
