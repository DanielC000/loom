#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────────────────────
// negative-control.mjs — one-call RED→GREEN→clean-tree proof (card 616e5ec2, half 1).
//
// WHY THIS EXISTS: the /worker doctrine mandates "prove your check can FAIL before you report its
// green — show it going RED on a known-bad case, then GREEN after." Every worker on this project
// performs that by hand: edit a marker/regression into the source, build, run the test, confirm RED,
// edit it back out, build, run the test again, confirm GREEN, then grep to prove nothing was left
// behind. Six manual steps plus a live correctness hazard (a temporary marker surviving into a real
// commit) that the last step exists purely to guard against. Measured directly from one archived
// session (`c6b53877`, 732 turns): this exact cycle ran FIVE separate times, 18 `pnpm --filter
// @loom/daemon build` invocations total, ~50 turns, ~25M cache-read tokens — for a procedure that is
// entirely mechanical and identical every time. This script is that procedure as ONE call.
//
// MECHANISM: for each `--file`, snapshot its CURRENT on-disk bytes exactly (the fix, as it sits in
// your worktree right now — committed or not), overwrite it with the content at `--ref` (default
// `HEAD` — ordinarily the pre-fix/broken code your fix hasn't been committed on top of yet; pass e.g.
// `--ref HEAD~1` if your fix is already committed), build, and run every `--test` file, requiring at
// least one of them to FAIL (the RED phase). Then restore the EXACT snapshot bytes — a plain
// node:fs write-back, never `git apply`/`git checkout` for the restore — rebuild, and run the same
// tests again, requiring them all to PASS (the GREEN phase). Finally it re-reads every reverted file
// and asserts its restored bytes are byte-identical to the original snapshot: the generalized form of
// the hand-run procedure's own step 7 (`grep -n TEMP-NEGATIVE-CONTROL ...; echo exit=$?`) — a leftover
// marker of ANY shape fails this, not just one specific string.
//
// WHY A REF-KEYED FS SNAPSHOT, NOT THE `--revert-to <sha|patch>` SHAPE THE FILING CARD SKETCHED: the
// card is explicit that shape is "a described outcome, NOT a checked API." A `git apply`-based patch
// restore can fail on whitespace/context fuzz and (via `git checkout <ref> -- <file>`) touches the git
// INDEX as a side effect — leaving a file's staged blob out of sync with its working-tree bytes if the
// process is interrupted mid-run. Reading `--ref`'s content once via `git show <ref>:<path>` and doing
// every mutation/restore as a raw in-memory Buffer write is index-free (only working-tree bytes ever
// move) and restore-exact by construction — a byte-for-byte comparison, not a text/whitespace-fuzzy
// one. It also generalizes past a single hunk: any-shaped drift between --ref and your current file is
// covered, not just one inserted marker line.
//
// This mutates and rebuilds your OWN worktree in place; it is not safe to run concurrently with
// anything else touching the same --file paths (a `run_gate` in flight on this worktree, e.g. — see
// the /worker doctrine's "your worktree is an INPUT to that running gate" rule). Run it before you
// kick off any shared gate, never during one.
//
// RUN (from anywhere — this script resolves the repo root itself):
//   pnpm --filter @loom/daemon negative-control --file <repo/relative/path.ts> --test <repo/relative/test.mjs>
// Repeat --file / --test for more than one of either. --ref defaults to HEAD; --build defaults to
// `pnpm --filter @loom/daemon build`.
//
// Exit 0 iff: the RED phase failed as expected, the GREEN phase passed as expected, AND every
// reverted file restored byte-identical to its original snapshot. Non-zero and a named reason
// otherwise — printed in full, this script's own output is never the thing worth compressing.
// ─────────────────────────────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const daemonRoot = path.resolve(here, "..");
// --repo-root (test seam only, same posture as e.g. LOOM_MARKITDOWN_BIN elsewhere in this codebase):
// every real invocation lets this resolve to the actual repo root; a test can point it at a throwaway
// synthetic git fixture instead of exercising this script against its own real, shared source tree.
const DEFAULT_REPO_ROOT = path.resolve(daemonRoot, "..", "..");

const DEFAULT_BUILD_COMMAND = "pnpm --filter @loom/daemon build";
const DEFAULT_REF = "HEAD";

const HELP = `negative-control — one-call RED→GREEN→clean-tree proof (card 616e5ec2)

Usage:
  pnpm --filter @loom/daemon negative-control \\
    --file <repo/relative/path> [--file <repo/relative/path> ...] \\
    --test <repo/relative/test.mjs> [--test <repo/relative/test.mjs> ...] \\
    [--ref <git-ref>] [--build "<command>"]

  --file    Repo-relative path to a source file your uncommitted (or --ref-relative) fix touches.
            Repeatable. Its CURRENT on-disk bytes are snapshotted, temporarily replaced with the
            content at --ref, and restored byte-for-byte afterwards no matter what happens.
  --test    Repo-relative path to a test .mjs to run in both phases. Repeatable.
  --ref     Git ref whose version of each --file is the "broken" state to prove RED against.
            Default: HEAD (the usual case — your fix is an uncommitted working-tree edit on top of
            HEAD). If your fix is already committed, pass e.g. --ref HEAD~1 or --ref HEAD^.
  --build   Build command to run before each test phase. Default: "${DEFAULT_BUILD_COMMAND}".
  --repo-root  Override the repo root everything above is relative to. Default: this script's own
            real repo. TEST SEAM ONLY — point a test at a throwaway synthetic git fixture instead of
            exercising this script against its own real, shared source tree.
  --help    Print this and exit 0.
`;

function parseArgs(argv) {
  const args = { file: [], test: [], ref: DEFAULT_REF, build: DEFAULT_BUILD_COMMAND, repoRoot: DEFAULT_REPO_ROOT, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { args.help = true; continue; }
    if (a === "--file") { args.file.push(argv[++i]); continue; }
    if (a === "--test") { args.test.push(argv[++i]); continue; }
    if (a === "--ref") { args.ref = argv[++i]; continue; }
    if (a === "--build") { args.build = argv[++i]; continue; }
    if (a === "--repo-root") { args.repoRoot = argv[++i]; continue; }
    console.error(`[negative-control] unrecognized argument: ${a}`);
    process.exit(2);
  }
  return args;
}

function toAbsPath(repoRoot, repoRelPath) {
  // Accept either separator on input (a worker may paste a Windows-flavored path); normalize to the
  // repo-relative POSIX form git expects, and join natively for fs access.
  const posixRel = repoRelPath.replaceAll("\\", "/");
  return { posixRel, absPath: path.join(repoRoot, ...posixRel.split("/")) };
}

function readRefContent(repoRoot, ref, posixRel) {
  try {
    return execFileSync("git", ["show", `${ref}:${posixRel}`], { cwd: repoRoot });
  } catch (err) {
    throw new Error(`\`git show ${ref}:${posixRel}\` failed — does ${posixRel} exist at ref "${ref}"? (${err.message})`);
  }
}

function runPhase(repoRoot, label, { buildCommand, testPaths }) {
  console.log(`\n[negative-control] ── ${label}: build (${buildCommand}) ──`);
  const buildResult = spawnSync(buildCommand, { cwd: repoRoot, shell: true, stdio: "inherit" });
  const buildOk = buildResult.status === 0;
  if (!buildOk) {
    console.error(`[negative-control] ${label}: build exited ${buildResult.status} — tests below still run so you can see whether the test itself also caught the break, but a build failure alone already counts as this phase NOT passing.`);
  }
  const testResults = [];
  for (const t of testPaths) {
    console.log(`[negative-control] ── ${label}: running ${t} ──`);
    const r = spawnSync(process.execPath, [t], { cwd: repoRoot, stdio: "inherit" });
    testResults.push({ test: t, status: r.status });
  }
  const allTestsOk = testResults.every((r) => r.status === 0);
  const pass = buildOk && allTestsOk;
  console.log(`[negative-control] ── ${label}: ${pass ? "PASSED" : "DID NOT PASS"} (build ${buildOk ? "ok" : "FAILED"}; tests ${testResults.map((r) => `${r.test}=${r.status === 0 ? "ok" : `exit ${r.status}`}`).join(", ")}) ──`);
  return { label, buildOk, testResults, pass };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }
  if (args.file.length === 0 || args.test.length === 0) {
    console.error("[negative-control] at least one --file and one --test are required.\n");
    console.error(HELP);
    process.exit(2);
  }

  const repoRoot = args.repoRoot;
  const files = args.file.map((f) => toAbsPath(repoRoot, f));

  // Fail fast, before mutating anything: every --file must exist on disk now, and every --file must
  // resolve at --ref. Collecting both snapshots up front means a bad argument never leaves a file
  // half-reverted.
  const snapshots = [];
  for (const { posixRel, absPath } of files) {
    let original;
    try {
      original = fs.readFileSync(absPath);
    } catch (err) {
      console.error(`[negative-control] --file ${posixRel} could not be read (${err.message}) — it must exist in your worktree now.`);
      process.exit(2);
    }
    const refContent = readRefContent(repoRoot, args.ref, posixRel);
    snapshots.push({ posixRel, absPath, original, refContent });
  }

  console.log(`[negative-control] reverting ${snapshots.length} file(s) to ${args.ref}, proving RED, restoring, proving GREEN:`);
  for (const s of snapshots) console.log(`  - ${s.posixRel}`);

  let phase1;
  let restoreErrors = [];
  try {
    for (const s of snapshots) fs.writeFileSync(s.absPath, s.refContent);
    phase1 = runPhase(repoRoot, `RED phase (reverted to ${args.ref})`, { buildCommand: args.build, testPaths: args.test });
  } finally {
    for (const s of snapshots) {
      try {
        fs.writeFileSync(s.absPath, s.original);
      } catch (err) {
        restoreErrors.push(`${s.posixRel}: ${err.message}`);
      }
    }
  }

  if (restoreErrors.length > 0) {
    // A restore failure is the single worst outcome this tool can produce — it means a worker's real,
    // uncommitted fix may now be gone. Stop immediately rather than proceeding to a GREEN phase that
    // would just build/test whatever half-restored state is left.
    console.error(`[negative-control] ⛔ RESTORE FAILED for ${restoreErrors.length} file(s) — STOP and recover manually before trusting anything else in this worktree:`);
    for (const e of restoreErrors) console.error(`  - ${e}`);
    process.exit(1);
  }

  const phase2 = runPhase(repoRoot, "GREEN phase (restored)", { buildCommand: args.build, testPaths: args.test });

  // Byte-for-byte restore-integrity check — the generalized replacement for the hand-run procedure's
  // marker grep. Re-reads from disk rather than trusting the write above returned without throwing.
  const integrityFailures = [];
  for (const s of snapshots) {
    const now = fs.readFileSync(s.absPath);
    if (!now.equals(s.original)) {
      integrityFailures.push(s.posixRel);
    }
  }

  const redOk = phase1.pass === false;
  const greenOk = phase2.pass === true;
  const cleanOk = integrityFailures.length === 0;

  console.log("\n[negative-control] ── SUMMARY ──");
  console.log(`  RED   (reverted to ${args.ref}): ${phase1.pass ? "PASSED — ⚠️ expected this to FAIL" : "failed, as expected"} ⇒ ${redOk ? "OK" : "❌ FAIL"}`);
  console.log(`  GREEN (restored):                ${phase2.pass ? "passed, as expected" : "FAILED — ⚠️ expected this to PASS"} ⇒ ${greenOk ? "OK" : "❌ FAIL"}`);
  console.log(`  CLEAN (byte-identical restore):  ${cleanOk ? "confirmed for all file(s)" : `MISMATCH: ${integrityFailures.join(", ")}`} ⇒ ${cleanOk ? "OK" : "❌ FAIL"}`);

  if (!redOk) {
    console.error(`\n[negative-control] ❌ the RED phase did not fail — reverting to ${args.ref} did not make ${args.test.join(", ")} fail. Either the test doesn't actually cover this change, or --ref doesn't name the pre-fix state.`);
  }
  if (!greenOk) {
    console.error(`\n[negative-control] ❌ the GREEN phase did not pass — the restored (current) state still fails ${args.test.join(", ")}. Your fix is not actually green.`);
  }
  if (!cleanOk) {
    console.error(`\n[negative-control] ❌ restore did not reproduce the original bytes for: ${integrityFailures.join(", ")}. Do not trust your worktree — diff these files against your last known-good state before doing anything else.`);
  }

  const ok = redOk && greenOk && cleanOk;
  console.log(ok ? "\n✅ negative control proven: RED before the fix, GREEN after, tree restored clean." : "\n❌ negative control NOT proven — see failures above.");
  process.exit(ok ? 0 : 1);
}

main();
