import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 9bf0db97 round 3, item 1 — hermetic coverage for
// pty/codex-doctrine.ts#removeStaleCodexDoctrineArtifact: a worktree is retained/reused per taskId (and a
// recycle can separately flip a session's harness codex→claude) without necessarily clobbering a prior
// codex worker's injected AGENTS.md first. This file proves the standalone predicate (marker + tracked +
// live-codex-owner checks) directly, then proves the REAL, WIRED `PtyHost.spawn()` non-codex branch
// actually calls it (mirrors codex-doctrine-spawn-wiring.mjs's own "a function existing in isolation is
// not the same claim as it being wired in" posture). See docs/decisions/
// 9bf0db97-codex-doctrine-exclude-scoped-to-worktree.md's "Round 3" section for the design.
//
// Run: 1) build (turbo builds shared first), 2) node test/codex-doctrine-stale-artifact.mjs
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { pollUntil } from "./_timing-guard.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Hermetic for every git block below: never depend on whatever (if anything) the host's own real global
// gitconfig/excludes happen to set (mirrors codex-doctrine-injection.mjs's own global-excludes block).
const TMP_HOME = mkdtempManaged("loom-codex-stale-home-");
process.env.GIT_CONFIG_GLOBAL = path.join(TMP_HOME, "global-gitconfig");
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, "");
process.env.GIT_CONFIG_SYSTEM = path.join(TMP_HOME, "nonexistent-system-gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;

const { removeStaleCodexDoctrineArtifact } = await import("../dist/pty/codex-doctrine.js");

const MARKER_CONTENT = "<!-- LOOM:CODEX-DOCTRINE:BEGIN (managed by Loom — regenerated every spawn; do not edit by hand) -->\nTEST DOCTRINE BODY\n<!-- LOOM:CODEX-DOCTRINE:END -->\n";
const FOREIGN_CONTENT = "# This project's own real AGENTS.md\n\nSome real, human-authored project instructions.\n";

function makeGitRepo(prefix) {
  const cwd = mkdtempManaged(prefix);
  const git = (args) => execSync(`git ${args}`, { cwd, stdio: "pipe" }).toString();
  git("init -q");
  git('config user.email "test@test.com"');
  git('config user.name "test"');
  fs.writeFileSync(path.join(cwd, "README.md"), "hi");
  git("add README.md");
  git('commit -q -m "init"');
  return { cwd, git };
}

const neverLiveCodex = () => false;

// --- 1: marker + untracked → removed --------------------------------------------------------------------
{
  const { cwd } = makeGitRepo("loom-codex-stale-removed-");
  const target = path.join(cwd, "AGENTS.md");
  fs.writeFileSync(target, MARKER_CONTENT);
  const outcome = await removeStaleCodexDoctrineArtifact(cwd, neverLiveCodex);
  check("marker + untracked → outcome 'removed'", outcome === "removed");
  check("marker + untracked → the file is actually gone from disk", !fs.existsSync(target));
}

// --- 2: marker + TRACKED → kept (out of scope entirely; never remove something committed) ----------------
{
  const { cwd, git } = makeGitRepo("loom-codex-stale-tracked-");
  const target = path.join(cwd, "AGENTS.md");
  fs.writeFileSync(target, MARKER_CONTENT);
  git("add AGENTS.md"); // staged — `git ls-files` already reports a staged-but-uncommitted path
  const outcome = await removeStaleCodexDoctrineArtifact(cwd, neverLiveCodex);
  check("marker + tracked → outcome 'skip-tracked'", outcome === "skip-tracked");
  check("marker + tracked → file left in place", fs.existsSync(target));
  check("marker + tracked → content byte-identical (never touched)", fs.readFileSync(target, "utf8") === MARKER_CONTENT);
}

// --- 3: marker-LESS + untracked → kept (the project's own real AGENTS.md; never clobbered) ----------------
{
  const { cwd } = makeGitRepo("loom-codex-stale-foreign-");
  const target = path.join(cwd, "AGENTS.md");
  fs.writeFileSync(target, FOREIGN_CONTENT);
  const outcome = await removeStaleCodexDoctrineArtifact(cwd, neverLiveCodex);
  check("marker-less + untracked → outcome 'skip-foreign'", outcome === "skip-foreign");
  check("marker-less + untracked → content byte-identical (never touched)", fs.readFileSync(target, "utf8") === FOREIGN_CONTENT);
}

// --- 3b: no AGENTS.md at all → kept (the common case: a fresh/claude-only worktree) ------------------------
{
  const { cwd } = makeGitRepo("loom-codex-stale-absent-");
  const outcome = await removeStaleCodexDoctrineArtifact(cwd, neverLiveCodex);
  check("no AGENTS.md present at all → outcome 'skip-foreign' (nothing to remove)", outcome === "skip-foreign");
}

// --- 4: marker + untracked, but a live codex session shares this cwd → kept -------------------------------
// Checked RIGHT BEFORE the unlink per @decision 9bf0db97 — asserted here by proving the callback is
// actually invoked with this cwd, not merely that the outcome matches.
{
  const { cwd } = makeGitRepo("loom-codex-stale-livecodex-");
  const target = path.join(cwd, "AGENTS.md");
  fs.writeFileSync(target, MARKER_CONTENT);
  let calledWith = null;
  const outcome = await removeStaleCodexDoctrineArtifact(cwd, (c) => { calledWith = c; return true; });
  check("live codex owner present → outcome 'skip-live-codex'", outcome === "skip-live-codex");
  check("live codex owner present → file left in place", fs.existsSync(target));
  check("the live-codex guard was actually invoked (not short-circuited earlier)", calledWith === cwd);
}

// --- 5: git itself errors (not a git repo at all) → fail CLOSED, kept -------------------------------------
{
  const cwd = mkdtempManaged("loom-codex-stale-notgit-"); // deliberately NO `git init` — git ls-files must fail
  const target = path.join(cwd, "AGENTS.md");
  fs.writeFileSync(target, MARKER_CONTENT);
  const outcome = await removeStaleCodexDoctrineArtifact(cwd, neverLiveCodex);
  check("not a git repo → git ls-files errors → outcome 'skip-error'", outcome === "skip-error");
  check("git-error case → file left in place (unknown ⇒ never delete)", fs.existsSync(target));
}

// --- 6: spawn()-level wiring — a REAL (fake-pty) claude spawn into a worktree carrying a stale cross-
// harness artifact actually triggers removal, not just the isolated function in test 1 above -------------
{
  process.env.LOOM_HOME = mkdtempManaged("loom-codex-stale-wiring-home-");
  const { PtyHost } = await import("../dist/pty/host.js");
  const { createSeamHost } = await import("./_seam-host-fixture.mjs");
  const host = new (createSeamHost(PtyHost))({
    onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onBusy() {}, onExit() {},
  });

  const { cwd } = makeGitRepo("loom-codex-stale-wiring-");
  const target = path.join(cwd, "AGENTS.md");
  fs.writeFileSync(target, MARKER_CONTENT);

  host.spawn({
    sessionId: "wiring-claude-reuse", cwd, permission: {}, geometry: { cols: 120, rows: 40 },
    sessionEnv: {}, role: "worker", harness: "claude",
  });

  // spawn() fires the removal fire-and-forget (never awaited at the call site) — poll for the real
  // completion signal (the file disappearing) instead of a fixed sleep.
  const removed = await pollUntil(() => !fs.existsSync(target), { timeoutMs: 5000, intervalMs: 25 });
  check("a claude spawn() into a worktree carrying a stale codex doctrine artifact removes it", removed);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — removeStaleCodexDoctrineArtifact only ever removes an untracked, marker-carrying AGENTS.md with no live codex owner, fails closed on any uncertainty, and is actually wired into PtyHost.spawn()'s non-codex branch."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
