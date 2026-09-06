#!/usr/bin/env node
// Refuse to cut a release unless main's Linux CI (ci.yml) is green FOR THE COMMIT BEING RELEASED. Runs
// automatically as npm's `preversion` lifecycle hook (see root package.json), so `npm version <bump>`
// — docs/releasing.md step 3, the action every release actually goes through — hard-refuses instead of
// relying on someone remembering to read the doc's advisory step 1 first.
//
// Why this exists (card 4e762baf): the merge gate runs on the owner's Windows host; ci.yml runs on
// ubuntu-latest. A Linux-only failure is invisible to the merge gate, ships green, and previously sat
// unread on main for 12 days / ~271 commits (card f33830d1) before anyone noticed. Project memory
// `shipping-a-detector-is-not-someone-reading-it` found a blocking precondition in the ACTION path is
// the only remedy that has actually worked here — an advisory doc step is not.
//
// IDENTITY, not just recency (card 4e762baf, manager review round 2): "latest completed run on the
// branch" answers a different question than "did CI actually build the commit I'm about to release" —
// the newest completed run can be a STALE previous commit's if HEAD's own run hasn't finished yet, and
// unpushed commits on HEAD are invisible to CI entirely. So this checks `origin/main..HEAD` is empty
// (nothing unpushed) and looks up the run BY head_sha, not just "most recent on the branch".
//
// This does NOT cover the release.yml bypass paths (workflow_dispatch, a manual `git tag -a` push,
// LOOM_SKIP_CI_CHECK itself) — card b854b35f closes those with a SEPARATE, structural gate that runs
// INSIDE release.yml (scripts/check-release-ci.mjs). Both scripts share the actual evidence-evaluation
// logic via scripts/lib/ci-gate.mjs; this file keeps its own CLI shape (the unpushed-HEAD check below
// is specific to the local, pre-push `npm version` flow and doesn't apply to release.yml, which only
// ever runs against a commit GitHub already has).
//
// Escape hatch: LOOM_SKIP_CI_CHECK=1 skips this check entirely (loudly). For a genuine emergency or
// when GitHub is unreachable — never as a routine habit; a skipped check defeats the point of it existing.
//
// --sha <sha> (testing only, card 06b23a41): overrides which commit gets checked, so the refusal
// branches below can be driven through THIS file directly instead of a copy. No args (the real release
// path, docs/releasing.md step 3) is unaffected — it still resolves `git rev-parse HEAD`.
import { originOwnerRepo, checkCiGreenForSha, git } from "./lib/ci-gate.mjs";

const WORKFLOW_FILE = "ci.yml";
const REMOTE = "origin";
const REMOTE_BRANCH = "main";

if (process.env.LOOM_SKIP_CI_CHECK === "1") {
  console.warn("⚠️  LOOM_SKIP_CI_CHECK=1 — skipping the main-CI-green check. main's Linux CI status is UNKNOWN to this release.");
  process.exit(0);
}

function refuse(reason, detail) {
  console.error(`\n❌ REFUSING to bump the version: ${reason}`);
  if (detail) console.error(detail);
  console.error(
    "\nThe Windows merge gate cannot see Linux/POSIX-only failures — a red, stale, or unknown ci.yml " +
    `verdict for the commit being released means it may not actually be releasable (docs/releasing.md, ` +
    "CLAUDE.md).\n" +
    `Check by hand: gh run list --workflow=${WORKFLOW_FILE} --branch ${REMOTE_BRANCH} --limit 1\n` +
    "If you are certain it's safe to proceed anyway, re-run with LOOM_SKIP_CI_CHECK=1 (loudly, not silently).\n"
  );
  process.exit(1);
}

function parseArgs(argv) {
  let sha; // undefined = flag absent (use HEAD); any string, including "", = flag present
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--sha") {
      const value = argv[i + 1];
      if (value === undefined) {
        refuse("--sha given with no value", "usage: --sha <sha> (or --sha=<sha>)");
      }
      sha = value;
      i++;
    } else if (arg.startsWith("--sha=")) {
      sha = arg.slice("--sha=".length);
    } else {
      refuse(`unrecognized argument: ${arg}`, "usage: node scripts/check-main-ci.mjs [--sha <sha>]");
    }
  }
  return { sha };
}

function resolveSha(input) {
  try {
    return git(["rev-parse", "--verify", `${input}^{commit}`]);
  } catch (err) {
    refuse(`--sha ${JSON.stringify(input)} is not a valid commit`, String(err.message || err));
  }
}

let owner, repo;
try {
  ({ owner, repo } = originOwnerRepo());
} catch (err) {
  refuse("could not determine the GitHub repo to check", String(err.message || err));
}

const { sha: shaArg } = parseArgs(process.argv.slice(2));
const headSha = shaArg !== undefined ? resolveSha(shaArg) : git(["rev-parse", "HEAD"]);

try {
  git(["fetch", REMOTE, REMOTE_BRANCH, "--quiet"]);
} catch (err) {
  refuse(
    `could not fetch ${REMOTE}/${REMOTE_BRANCH} to confirm HEAD (${headSha.slice(0, 10)}) is actually pushed`,
    String(err.message || err)
  );
}

let unpushedCount;
try {
  unpushedCount = Number(git(["rev-list", "--count", `${REMOTE}/${REMOTE_BRANCH}..${headSha}`]));
} catch (err) {
  refuse(`could not compare HEAD against ${REMOTE}/${REMOTE_BRANCH}`, String(err.message || err));
}

if (unpushedCount > 0) {
  refuse(
    `${unpushedCount} commit(s) on HEAD are not on ${REMOTE}/${REMOTE_BRANCH} — GitHub has never built them`,
    `HEAD: ${headSha}\n` +
    `Push first (\`git push ${REMOTE} ${REMOTE_BRANCH}\`), wait for ci.yml to complete, then retry.`
  );
}

const result = await checkCiGreenForSha({
  owner,
  repo,
  sha: headSha,
  workflowFile: WORKFLOW_FILE,
  subject: `HEAD (${headSha.slice(0, 10)})`,
  token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
});

if (!result.ok) {
  refuse(result.reason, result.detail);
}

console.log(`✅ ${WORKFLOW_FILE} is green for HEAD (${headSha.slice(0, 10)}) — ${result.run.html_url}. Proceeding.`);
