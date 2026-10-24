import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure git + bounded.ts
// CARD 3a5c5d4a (round 5), B-1 — the four BARE caller shapes the 4th Code Review found still refused on
// EVERY subdir-bound project call, even after round 4's own fix: readMainlineHead/readFirstParent/
// isAncestorCommit/readMainlineFacts (git/mainline-watch.ts), fastForwardCanonicalMain
// (git/batch-merge.ts), resolveMainlineBranchState (git/worktrees.ts), and SessionService's private
// `canonicalReadGit` — none of these ever pass `trustedMainRoot` at all, so round 4's per-call-walk
// default never reached them; round 5's durable pin (consulted by `checkCommondirTrust` itself,
// unconditionally, independent of whatever `trustedMainRoot` a caller supplies) fixes every one of them
// at the ONE shared chokepoint, with no per-site edit to any of these four callers.
//
// `canonicalReadGit` itself is a one-line private wrapper (`return canonicalGit(repoPath, timeoutMs)`,
// sessions/service.ts) — proving the mechanism it delegates to (a bare `canonicalGit(repoPath, ms)` call)
// is proof enough; it needs no SessionService instantiation.
//
// Run: 1) pnpm build, 2) node packages/daemon/test/canonical-git-commondir-pin-bare-callers.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { useOwnLoomHome, registerForCleanup, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

useOwnLoomHome("loom-cgcr-bare-home-");

const { canonicalGit, CanonicalGitUnpinnedRefusal, resolveTrustedToplevel, registerCommondirTrustPinLookup } = await import("../dist/git/bounded.js");
const { literalRepoPathKey } = await import("../dist/git/repo-lock.js");
const { readMainlineHead, readFirstParent, isAncestorCommit } = await import("../dist/git/mainline-watch.js");
const { fastForwardCanonicalMain } = await import("../dist/git/batch-merge.js");
const { resolveMainlineBranchState } = await import("../dist/git/worktrees.js");

const pinMap = new Map();
registerCommondirTrustPinLookup((repoPath) => pinMap.get(literalRepoPathKey(repoPath)) ?? null);
function pinFor(repoPath, projectId = "bare-caller-test", repoKey = "primary") {
  const toplevel = resolveTrustedToplevel(repoPath);
  if (!toplevel.ok) throw new Error(`pinFor(${repoPath}): ${toplevel.reason}`);
  pinMap.set(literalRepoPathKey(repoPath), { toplevel: toplevel.toplevel, pinnedAt: new Date().toISOString(), source: "bind", projectId, repoKey });
}
function unpinFor(repoPath) { pinMap.delete(literalRepoPathKey(repoPath)); }

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), `loom-cgcr-bare-${sfx}-`));
registerForCleanup(SCRATCH);
const git = (cwd, args) => execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const GIT_ID = "-c user.email=cgcrb@loom -c user.name=cgcrb";

// A subdir-bound project: `.git` lives at `root`, the project is bound to `root/proj` (no .git of its own).
const root = path.join(SCRATCH, "root");
const boundSub = path.join(root, "proj");
fs.mkdirSync(boundSub, { recursive: true });
git(root, "init -q -b main");
fs.writeFileSync(path.join(boundSub, "a.txt"), "a\n");
git(root, "add -A");
git(root, `${GIT_ID} commit -q -m "bare-callers: init"`);
const headSha = git(root, "rev-parse HEAD");
git(root, "symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main"); // no real remote needed — resolveMainlineBranchState only reads this ref file

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// readMainlineHead — never throws; caught internally and returns null when the pin is missing, succeeds
// once pinned. Both sides of the contrast prove the check is meaningful (not just "it didn't throw").
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const unpinnedHead = await readMainlineHead(boundSub, 5_000);
  check("(mainline-head, unpinned) returns null — no durable pin, refused internally", unpinnedHead === null);
  pinFor(boundSub);
  const pinnedHead = await readMainlineHead(boundSub, 5_000);
  check("(mainline-head, pinned) resolves the real HEAD once the subdir binding is pinned", pinnedHead?.branch === "main" && pinnedHead?.tip === headSha);
  unpinFor(boundSub);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// readFirstParent / isAncestorCommit — same contrast, two more mainline-watch.ts bare callers.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const unpinnedParent = await readFirstParent(boundSub, headSha, 5_000);
  check("(readFirstParent, unpinned) returns null (the initial commit has no parent anyway, but an unpinned repo must refuse before even trying)", unpinnedParent === null);

  // isAncestorCommit THROWS on a git failure (its own doc: "the caller fails open") — unlike
  // readHeadShaAndBranch's internal try/catch, there is no swallowing here to rely on.
  let unpinnedThrew = null;
  try { await isAncestorCommit(boundSub, headSha, headSha, 5_000); } catch (e) { unpinnedThrew = e; }
  check("(isAncestorCommit, unpinned) THROWS CanonicalGitUnpinnedRefusal — never silently trusted", unpinnedThrew instanceof CanonicalGitUnpinnedRefusal);

  pinFor(boundSub);
  const pinnedAncestor = await isAncestorCommit(boundSub, headSha, headSha, 5_000);
  check("(isAncestorCommit, pinned) a commit is its own ancestor, once the subdir binding is pinned", pinnedAncestor === true);
  unpinFor(boundSub);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// fastForwardCanonicalMain (git/batch-merge.ts) — never throws; returns ok:false when the pin is missing
// (the underlying HEAD read is refused and caught), ok:true for a no-op fast-forward once pinned.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  unpinFor(boundSub);
  const ffUnpinned = await fastForwardCanonicalMain(boundSub, headSha, headSha, {});
  check("(fastForwardCanonicalMain, unpinned) refuses (ok:false) — no durable pin for this subdir-bound repoPath", ffUnpinned.ok === false);
  pinFor(boundSub);
  const ffPinned = await fastForwardCanonicalMain(boundSub, headSha, headSha, {});
  check("(fastForwardCanonicalMain, pinned) succeeds (a no-op fast-forward: targetSha === expectedBaseSha)", ffPinned.ok === true);
  unpinFor(boundSub);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// resolveMainlineBranchState (git/worktrees.ts) — {state:"failed"} when the pin is missing (the
// underlying symbolic-ref read is refused and caught), {state:"resolved", branch:"main"} once pinned.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const stateUnpinned = await resolveMainlineBranchState(boundSub, {});
  check("(resolveMainlineBranchState, unpinned) reports state:\"failed\" — never silently resolved against an unpinned repo", stateUnpinned.state === "failed");
  pinFor(boundSub);
  const statePinned = await resolveMainlineBranchState(boundSub, {});
  check("(resolveMainlineBranchState, pinned) resolves refs/remotes/origin/HEAD to \"main\"", statePinned.state === "resolved" && statePinned.branch === "main");
  unpinFor(boundSub);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// canonicalReadGit (sessions/service.ts) is `return canonicalGit(repoPath, timeoutMs)` verbatim — a bare
// call with no trustedMainRoot, same shape proven directly here rather than instantiating SessionService.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  let threw = null;
  try { await canonicalGit(boundSub, 5_000).raw(["status", "--porcelain"]); } catch (e) { threw = e; }
  check("(canonicalReadGit-shaped, unpinned) throws CanonicalGitUnpinnedRefusal end to end", threw instanceof CanonicalGitUnpinnedRefusal);
  pinFor(boundSub);
  const status = await canonicalGit(boundSub, 5_000).raw(["status", "--porcelain"]);
  check("(canonicalReadGit-shaped, pinned) succeeds end to end (a clean tree reports empty status)", status.trim() === "");
  unpinFor(boundSub);
}

await finishAndExit(failures === 0 ? 0 : 1);
