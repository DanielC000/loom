#!/usr/bin/env node
// Refuse to publish a release unless ci.yml (Linux, incl. its e2e job) is green FOR THE EXACT COMMIT
// release.yml is about to package — card b854b35f, the structural half of the fix.
//
// scripts/check-main-ci.mjs already blocks the ORDINARY `npm version` cut path (docs/releasing.md step
// 3, npm's `preversion` hook) — but three paths route around it entirely, and THIS script is what
// closes them, by running INSIDE release.yml itself, after checkout, before any build/publish work:
//   1. `workflow_dispatch` — no tag, no `npm version`, no preversion hook anywhere in the path.
//   2. A manual `git tag -a` + push (docs/releasing.md's own `--no-git-tag-version` escape) — a raw
//      git command outside npm's lifecycle hooks entirely.
//   3. Anyone who just forgets to re-check by hand before either of the above.
//
// Deliberately does NOT re-run e2e, or anything else — the owner's explicit constraint (Platform card
// 35c66e80, quoted verbatim on card b854b35f) is that e2e must never become mandatory for a merge or
// added to any reduced-gate tier. This script adds NOTHING to that path: it only READS a verdict
// ci.yml already produced, on its own separate schedule (PRs + main pushes). ci.yml runs e2e as one of
// its two jobs (`build-test` + `e2e`), and a GitHub Actions workflow run is reported `success` only if
// EVERY job in it succeeded — so a green ci.yml run for this exact sha already implies e2e passed for
// it, with zero extra runtime spent here.
//
// FAIL-CLOSED (DoD-2): "no ci.yml run found for this sha" is NOT treated as a pass — it refuses, same
// as a red or still-running run. See scripts/lib/ci-gate.mjs's checkCiGreenForSha for the shared
// evaluation (also used by check-main-ci.mjs) — `ok` is true ONLY for a completed, "success" run; every
// other outcome, including absence, is `ok:false` with no implicit fallthrough to success.
//
// WHICH SHA (DoD-4): always `git rev-parse HEAD` after actions/checkout, unless --sha overrides it.
// This is correct for BOTH trigger shapes without a separate branch: a tag push checks out the tag's
// own commit, and a workflow_dispatch run checks out the dispatched ref's HEAD — in both cases that IS
// the exact commit this job is about to pack and publish. There is no unpushed-commit check here (unlike
// check-main-ci.mjs) because it doesn't apply: release.yml only ever runs against a commit GitHub
// already has (that's what triggered the run), so "is HEAD pushed" is always trivially true here.
//
// --sha <sha> (testing only, mirrors check-main-ci.mjs's own --sha): overrides which commit gets
// checked, so the refusal branches can be exercised directly against the real GitHub API — e.g. a real,
// never-pushed local commit — without waiting for an actual tag or workflow_dispatch run.
//
// Escape hatch: LOOM_SKIP_CI_CHECK=1 skips this check entirely (loudly) — the SAME env var
// check-main-ci.mjs already honors, so a single flag disables both release-time CI-green checks at
// once. For a genuine emergency, or when GitHub is unreachable — never as a routine habit.
import { originOwnerRepo, checkCiGreenForSha, git } from "./lib/ci-gate.mjs";

const WORKFLOW_FILE = "ci.yml";

if (process.env.LOOM_SKIP_CI_CHECK === "1") {
  console.warn(`⚠️  LOOM_SKIP_CI_CHECK=1 — skipping the release ${WORKFLOW_FILE}-green check. Its status is UNKNOWN to this release.`);
  process.exit(0);
}

function refuse(reason, detail) {
  console.error(`\n❌ REFUSING to publish: ${reason}`);
  if (detail) console.error(detail);
  console.error(
    "\nrelease.yml only publishes a commit whose ci.yml (Linux, incl. e2e) run concluded success — see " +
    "CLAUDE.md and docs/releasing.md (card b854b35f).\n" +
    `Check by hand: gh run list --workflow=${WORKFLOW_FILE} --limit 5\n` +
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
      refuse(`unrecognized argument: ${arg}`, "usage: node scripts/check-release-ci.mjs [--sha <sha>]");
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
const sha = shaArg !== undefined ? resolveSha(shaArg) : git(["rev-parse", "HEAD"]);
const label = `the released commit (${sha.slice(0, 10)})`;

const result = await checkCiGreenForSha({
  owner,
  repo,
  sha,
  workflowFile: WORKFLOW_FILE,
  subject: label,
  token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
});

if (!result.ok) {
  refuse(result.reason, result.detail);
}

console.log(`✅ ${WORKFLOW_FILE} is green for ${label} — ${result.run.html_url}. Publishing.`);
