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
// Escape hatch: LOOM_SKIP_CI_CHECK=1 skips this check entirely (loudly). For a genuine emergency or
// when GitHub is unreachable — never as a routine habit; a skipped check defeats the point of it existing.
import { execFileSync } from "node:child_process";

const WORKFLOW_FILE = "ci.yml";
const REMOTE = "origin";
const REMOTE_BRANCH = "main";

if (process.env.LOOM_SKIP_CI_CHECK === "1") {
  console.warn("⚠️  LOOM_SKIP_CI_CHECK=1 — skipping the main-CI-green check. main's Linux CI status is UNKNOWN to this release.");
  process.exit(0);
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function originOwnerRepo() {
  const url = git(["config", "--get", `remote.${REMOTE}.url`]);
  const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (!m) throw new Error(`could not parse owner/repo from remote.${REMOTE}.url: ${url}`);
  return { owner: m[1], repo: m[2] };
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

let owner, repo;
try {
  ({ owner, repo } = originOwnerRepo());
} catch (err) {
  refuse("could not determine the GitHub repo to check", String(err.message || err));
}

const headSha = git(["rev-parse", "HEAD"]);

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
  unpushedCount = Number(git(["rev-list", "--count", `${REMOTE}/${REMOTE_BRANCH}..HEAD`]));
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

const apiUrl = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${WORKFLOW_FILE}/runs?head_sha=${headSha}&per_page=1`;
const headers = { "User-Agent": "loom-release-check", Accept: "application/vnd.github+json" };
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
if (token) headers.Authorization = `Bearer ${token}`;

let res;
try {
  res = await fetch(apiUrl, { headers });
} catch (err) {
  refuse(`could not reach GitHub to check ${WORKFLOW_FILE} for HEAD (${headSha.slice(0, 10)})`, String(err.message || err));
}

if (!res.ok) {
  refuse(`GitHub API returned ${res.status} ${res.statusText} for ${apiUrl}`);
}

const body = await res.json();
const run = body.workflow_runs && body.workflow_runs[0];

if (!run) {
  refuse(
    `no ${WORKFLOW_FILE} run found for HEAD (${headSha.slice(0, 10)}) yet`,
    "CI may not have started for this commit yet — wait for it to appear, then retry."
  );
}

if (run.status !== "completed") {
  refuse(
    `${WORKFLOW_FILE} for HEAD (${headSha.slice(0, 10)}) hasn't finished yet (status: ${run.status})`,
    `This is NOT a red run — it just hasn't completed. Wait for it, then retry: ${run.html_url}`
  );
}

if (run.conclusion !== "success") {
  refuse(
    `${WORKFLOW_FILE} for HEAD (${headSha.slice(0, 10)}) is RED`,
    `conclusion: ${run.conclusion}\ncompleted: ${run.updated_at}\nrun: ${run.html_url}`
  );
}

console.log(`✅ ${WORKFLOW_FILE} is green for HEAD (${headSha.slice(0, 10)}) — ${run.html_url}. Proceeding.`);
