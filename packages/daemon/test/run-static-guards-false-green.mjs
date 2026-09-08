import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure child_process
// Test for card 61d75a3c: card 616e5ec2 shipped a false-green detector inside
// `packages/daemon/scripts/run-static-guards.mjs`'s quiet mode — a guard that exits 0 while its own
// captured output contains >=1 `FAIL  ` line is reported as `⛔ FALSE GREEN`, pushed into the failure
// list, and the overall run exits non-zero. It shipped with no committed test: the worker who wrote it
// verified the detector via an ad-hoc harness that REIMPLEMENTED the regex/status check — a copy of the
// predicate, not the predicate. This file drives the REAL script instead.
//
// THE SEAM: run-static-guards.mjs always imports STATIC_GUARD_REPO_PATHS from the real, checked-in
// dist/git/worktrees.js — this test must never mutate that list (a fleet-wide behavior change, off-limits
// per this card's own kickoff) or reimplement its quiet-mode PASS/FAIL/exit-code logic. Instead it drives
// the script's own `--paths <repo/relative,...>` test seam (added by this same card, same posture as
// negative-control.mjs's `--repo-root`): passing it swaps in a synthetic fixture path list for THIS
// invocation only, while every real invocation (no --paths) still runs the authoritative list. The
// freshness check and the STATIC_GUARD_REPO_PATHS import both still execute either way — this is a
// narrow override of WHICH paths get iterated, not a bypass of the script's other real behavior.
//
// Two fixtures (both underscore-prefixed — never real guards, never added to STATIC_GUARD_REPO_PATHS):
//   _run-static-guards-fixture-false-green.mjs — prints one PASS line and one FAIL line, exits 0.
//   _run-static-guards-fixture-all-pass.mjs     — prints only PASS lines, exits 0 (the negative control:
//                                                  a genuinely-passing guard must NOT be flagged).
//
// Run: node packages/daemon/test/run-static-guards-false-green.mjs
// Prerequisite: `pnpm --filter @loom/daemon build` must have run first (the script's own freshness check
// refuses otherwise — this test does not build for you, matching how a worker actually invokes `guards`).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const SCRIPT = path.join(repoRoot, "packages", "daemon", "scripts", "run-static-guards.mjs");

const FALSE_GREEN_FIXTURE = "packages/daemon/test/_run-static-guards-fixture-false-green.mjs";
const ALL_PASS_FIXTURE = "packages/daemon/test/_run-static-guards-fixture-all-pass.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function runGuards(paths) {
  const result = spawnSync(process.execPath, [SCRIPT, "--paths", paths.join(",")], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// ── (1) THE POSITIVE CASE: a guard that exits 0 but printed a FAIL line must be caught. ────────────────
{
  const r = runGuards([FALSE_GREEN_FIXTURE]);
  check("false-green fixture: overall run exits non-zero", r.status !== 0);
  check(
    "false-green fixture: the fixture path itself is named in the failure list",
    r.stderr.includes(FALSE_GREEN_FIXTURE) || r.stdout.includes(FALSE_GREEN_FIXTURE)
  );
  check(
    "false-green fixture: the 'FALSE GREEN' wording is present",
    r.stderr.includes("FALSE GREEN") || r.stdout.includes("FALSE GREEN")
  );
  // The detector's own diagnostic promise (run-static-guards.mjs's quiet-mode branch): it never swallows
  // a false-green guard's captured output — assert the fixture's own FAIL line actually surfaced, not
  // just the summary wording.
  check(
    "false-green fixture: the guard's own FAIL line is surfaced, not swallowed",
    r.stdout.includes("FAIL  fixture check two") || r.stderr.includes("FAIL  fixture check two")
  );
}

// ── (2) THE NEGATIVE CONTROL: a genuinely-passing guard (only PASS lines, exit 0) must NOT be flagged. ─
// Without this, the test above cannot distinguish a working detector from one that flags every guard.
{
  const r = runGuards([ALL_PASS_FIXTURE]);
  check("all-pass fixture: overall run exits zero", r.status === 0);
  check(
    "all-pass fixture: NOT reported as a false green",
    !r.stdout.includes("FALSE GREEN") && !r.stderr.includes("FALSE GREEN")
  );
  check(
    "all-pass fixture: NOT named in a failure list",
    !/guard\(s\) failed/.test(r.stderr) && !/guard\(s\) failed/.test(r.stdout)
  );
  check("all-pass fixture: reported as passed", /all 1 guard\(s\) passed/.test(r.stdout));
}

// ── (3) BOTH TOGETHER: a mixed path list correctly isolates the false-green fixture from the clean one. ─
{
  const r = runGuards([ALL_PASS_FIXTURE, FALSE_GREEN_FIXTURE]);
  check("mixed list: overall run exits non-zero (one of two is a false green)", r.status !== 0);
  check(
    "mixed list: only the false-green fixture is named in the failure list, not the all-pass one",
    (r.stderr.includes(FALSE_GREEN_FIXTURE) || r.stdout.includes(FALSE_GREEN_FIXTURE)) &&
      // Deliberately NOT pinned to "1/2" (manager review finding, card 61d75a3c): the count is not
      // incidental to an over-fire failure — it necessarily changes (1/2 -> 2/2) in exactly the case
      // this assertion is guarding, so pinning it would guarantee the miss rather than merely risk it.
      // Manufactured the over-fire state directly (temporarily made the all-pass fixture also print a
      // FAIL line) and confirmed: the OLD pinned pattern stayed green against that real "2/2 ...
      // fixture-all-pass, ... fixture-false-green" stderr; this pattern correctly goes red.
      !/guard\(s\) failed:[^\n]*fixture-all-pass/.test(r.stderr)
  );
}

console.log(
  failures === 0
    ? "\n✅ ALL PASS — run-static-guards.mjs's quiet-mode false-green detector, driven via its own real " +
      "code path (not a reimplementation), correctly flags a guard that exits 0 while printing a FAIL " +
      "line, correctly leaves a genuinely-passing guard unflagged, and correctly isolates the two inside " +
      "a mixed path list."
    : `\n❌ ${failures} FAILURE(S).`
);
process.exit(failures === 0 ? 0 : 1);
