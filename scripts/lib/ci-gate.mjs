// Shared "is <workflow> green for a given commit sha" evidence-check against the GitHub Actions REST
// API. Used by scripts/check-main-ci.mjs (the release-cut `npm version` preversion hook) and
// scripts/check-release-ci.mjs (the release.yml structural gate, card b854b35f) so both consumers read
// the same GitHub evidence the same way instead of drifting into two independently-maintained copies.
import { execFileSync } from "node:child_process";

export function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

// Parses `owner/repo` out of a git remote's URL (https or ssh form).
export function originOwnerRepo(remote = "origin") {
  const url = git(["config", "--get", `remote.${remote}.url`]);
  const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (!m) throw new Error(`could not parse owner/repo from remote.${remote}.url: ${url}`);
  return { owner: m[1], repo: m[2] };
}

// Resolves whether `workflowFile` is green for `sha`. FAIL-CLOSED: `ok` is true ONLY when a run for
// `sha` exists, is `completed`, AND concluded exactly `"success"` — every other outcome (no run found,
// still running, any other conclusion, a fetch/API error) returns `ok:false`, with no fallthrough to
// success for any of them. `subject` is the human-readable label used in the returned reason/detail
// text (callers pass e.g. `HEAD (abc1234567)` or `the released commit (abc1234567)`); it defaults to
// the sha's short form. `fetchImpl` is injectable so tests can substitute a fake without hitting the
// network; production callers omit it and get the real global `fetch`.
export async function checkCiGreenForSha({ owner, repo, sha, workflowFile, token, subject, fetchImpl = fetch }) {
  const label = subject ?? sha.slice(0, 10);
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowFile}/runs?head_sha=${sha}&per_page=1`;
  const headers = { "User-Agent": "loom-release-check", Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetchImpl(apiUrl, { headers });
  } catch (err) {
    return {
      ok: false,
      reason: `could not reach GitHub to check ${workflowFile} for ${label}`,
      detail: String(err.message || err),
    };
  }

  if (!res.ok) {
    return { ok: false, reason: `GitHub API returned ${res.status} ${res.statusText} for ${apiUrl}` };
  }

  const body = await res.json();
  const run = body.workflow_runs && body.workflow_runs[0];

  if (!run) {
    return {
      ok: false,
      reason: `no ${workflowFile} run found for ${label} yet`,
      detail: "CI may not have started for this commit yet — wait for it to appear, then retry.",
    };
  }

  if (run.status !== "completed") {
    return {
      ok: false,
      reason: `${workflowFile} for ${label} hasn't finished yet (status: ${run.status})`,
      detail: `This is NOT a red run — it just hasn't completed. Wait for it, then retry: ${run.html_url}`,
      run,
    };
  }

  if (run.conclusion !== "success") {
    return {
      ok: false,
      reason: `${workflowFile} for ${label} is RED`,
      detail: `conclusion: ${run.conclusion}\ncompleted: ${run.updated_at}\nrun: ${run.html_url}`,
      run,
    };
  }

  return { ok: true, run };
}
