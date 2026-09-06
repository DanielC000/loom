// Hermetic unit test for scripts/lib/ci-gate.mjs (the shared "is <workflow> green for this sha"
// evidence check used by both scripts/check-main-ci.mjs and scripts/check-release-ci.mjs, card
// b854b35f). NO real network — every checkCiGreenForSha() case below injects a fake `fetchImpl`.
// originOwnerRepo() IS exercised against a real (throwaway, temp) git repo, since that's the cheapest
// way to prove the regex against both remote URL forms without mocking child_process.
//
// The REAL, live-network refusal proof (a genuinely unpushed local commit, and a genuinely green one,
// both queried against the actual GitHub API) is run separately and reported alongside this file's
// result — see the worker_report for those two commands' output; a mocked fetch here can only prove
// the RESOLUTION logic is correct, not that the real API integration behaves the same way.
//
// Card 3f04a19f: lives under packages/daemon/test/ (not scripts/) so `test-daemon.mjs`'s hermetic
// discovery walk picks it up automatically — no wiring edit needed anywhere. `scripts/lib/ci-gate.mjs`
// lives outside packages/daemon, but a plain relative import across that boundary already has a
// precedent in this same directory (see codescape-privacy-guard.mjs's `../../../scripts/...` imports).
// Run directly: node packages/daemon/test/ci-gate.mjs
// Run through the real gate entry point, scoped to just this file: pnpm --filter @loom/daemon test:daemon -- --only=ci-gate
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { originOwnerRepo, checkCiGreenForSha } from "../../../scripts/lib/ci-gate.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function fakeFetch(handler) {
  return async (url, opts) => handler(url, opts);
}
function jsonResponse(body, { ok = true, status = 200, statusText = "OK" } = {}) {
  return { ok, status, statusText, json: async () => body };
}

const OWNER = "acme";
const REPO = "widgets";
const SHA = "deadbeefcafefeed0000111122223333deadbeef";
const WORKFLOW = "ci.yml";

// --- checkCiGreenForSha: the FAIL-CLOSED cases (DoD-2's whole point) ---

{
  // No run at all for this sha — the case that "reads like success" if you're not careful (empty list).
  const result = await checkCiGreenForSha({
    owner: OWNER, repo: REPO, sha: SHA, workflowFile: WORKFLOW,
    fetchImpl: fakeFetch(() => jsonResponse({ workflow_runs: [] })),
  });
  check("no run found -> ok:false (not treated as a pass)", result.ok === false);
  check("no run found -> reason names 'no ... run found'", /no .* run found/.test(result.reason));
}

{
  // The API technically returned something, but with no workflow_runs key at all.
  const result = await checkCiGreenForSha({
    owner: OWNER, repo: REPO, sha: SHA, workflowFile: WORKFLOW,
    fetchImpl: fakeFetch(() => jsonResponse({})),
  });
  check("missing workflow_runs key -> ok:false", result.ok === false);
}

{
  // A run exists but hasn't finished yet — NOT a red run, must still refuse (it isn't success yet).
  const result = await checkCiGreenForSha({
    owner: OWNER, repo: REPO, sha: SHA, workflowFile: WORKFLOW,
    fetchImpl: fakeFetch(() => jsonResponse({ workflow_runs: [{ status: "in_progress", html_url: "https://x/1" }] })),
  });
  check("run still in_progress -> ok:false", result.ok === false);
  check("run still in_progress -> reason says hasn't finished", /hasn't finished/.test(result.reason));
}

{
  // A completed run, but red (failure).
  const result = await checkCiGreenForSha({
    owner: OWNER, repo: REPO, sha: SHA, workflowFile: WORKFLOW,
    fetchImpl: fakeFetch(() => jsonResponse({
      workflow_runs: [{ status: "completed", conclusion: "failure", html_url: "https://x/2", updated_at: "2026-01-01T00:00:00Z" }],
    })),
  });
  check("completed + conclusion:failure -> ok:false", result.ok === false);
  check("completed + conclusion:failure -> reason says RED", /is RED/.test(result.reason));
}

{
  // A completed run with a non-failure, non-success conclusion (cancelled) — must ALSO refuse; only
  // an EXPLICIT "success" may pass.
  const result = await checkCiGreenForSha({
    owner: OWNER, repo: REPO, sha: SHA, workflowFile: WORKFLOW,
    fetchImpl: fakeFetch(() => jsonResponse({
      workflow_runs: [{ status: "completed", conclusion: "cancelled", html_url: "https://x/3", updated_at: "2026-01-01T00:00:00Z" }],
    })),
  });
  check("completed + conclusion:cancelled -> ok:false (only 'success' passes)", result.ok === false);
}

{
  // A network-level failure (fetch throws) must ALSO refuse, not silently pass.
  const result = await checkCiGreenForSha({
    owner: OWNER, repo: REPO, sha: SHA, workflowFile: WORKFLOW,
    fetchImpl: fakeFetch(() => { throw new Error("ECONNRESET"); }),
  });
  check("fetch throws -> ok:false", result.ok === false);
  check("fetch throws -> detail carries the underlying error", /ECONNRESET/.test(result.detail));
}

{
  // A non-2xx HTTP response (e.g. rate-limited or repo not found) must ALSO refuse.
  const result = await checkCiGreenForSha({
    owner: OWNER, repo: REPO, sha: SHA, workflowFile: WORKFLOW,
    fetchImpl: fakeFetch(() => jsonResponse({}, { ok: false, status: 403, statusText: "Forbidden" })),
  });
  check("HTTP 403 -> ok:false", result.ok === false);
  check("HTTP 403 -> reason names the status", /403/.test(result.reason));
}

// --- checkCiGreenForSha: the ONE passing case, so the checks above aren't vacuous (positive control) ---
{
  const result = await checkCiGreenForSha({
    owner: OWNER, repo: REPO, sha: SHA, workflowFile: WORKFLOW,
    fetchImpl: fakeFetch(() => jsonResponse({
      workflow_runs: [{ status: "completed", conclusion: "success", html_url: "https://x/4", updated_at: "2026-01-01T00:00:00Z" }],
    })),
  });
  check("completed + conclusion:success -> ok:true (positive control: the checker CAN pass)", result.ok === true);
  check("ok:true carries the run through for the caller's success message", result.run?.html_url === "https://x/4");
}

// --- subject label: callers can override the human-readable name used in the refusal text ---
{
  const result = await checkCiGreenForSha({
    owner: OWNER, repo: REPO, sha: SHA, workflowFile: WORKFLOW, subject: "the released commit (deadbee)",
    fetchImpl: fakeFetch(() => jsonResponse({ workflow_runs: [] })),
  });
  check("custom subject label is used in the reason text", result.reason.includes("the released commit (deadbee)"));
}

// --- originOwnerRepo: exercised against a real throwaway git repo (both URL forms) ---
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-ci-gate-test-"));
const originalCwd = process.cwd();
try {
  execFileSync("git", ["init", "--quiet"], { cwd: tmpDir });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/DanielC000/loom.git"], { cwd: tmpDir });
  process.chdir(tmpDir);
  const { owner, repo } = originOwnerRepo();
  check("originOwnerRepo parses an https remote URL", owner === "DanielC000" && repo === "loom");

  execFileSync("git", ["remote", "set-url", "origin", "git@github.com:DanielC000/loom.git"], { cwd: tmpDir });
  const sshResult = originOwnerRepo();
  check("originOwnerRepo parses an ssh remote URL", sshResult.owner === "DanielC000" && sshResult.repo === "loom");

  // Negative control: a non-GitHub remote must not silently resolve to something plausible-looking.
  execFileSync("git", ["remote", "set-url", "origin", "https://gitlab.com/someone/other.git"], { cwd: tmpDir });
  let threw = false;
  try {
    originOwnerRepo();
  } catch {
    threw = true;
  }
  check("negative control: a non-github.com remote throws rather than guessing", threw);
} finally {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "✅" : "❌"} ci-gate: ${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
process.exit(failures ? 1 : 0);
