#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────────────────────
// negative-control.mjs — one-call RED→GREEN→clean-tree proof (card 616e5ec2, half 1).
//
// @decision 616e5ec2 — the hand-run cycle this replaces is six manual steps plus a live correctness
// hazard (a temporary marker surviving into a real commit); measured at FIVE reruns, 18 builds, ~50
// turns, ~25M cache-read tokens in one archived session, for a procedure identical every time.
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
// @decision 616e5ec2 — a ref-keyed FS snapshot, not the `--revert-to <sha|patch>` shape the filing
// card sketched (explicitly "a described outcome, NOT a checked API"): a `git apply`/`git checkout`
// restore can leave the git INDEX out of sync mid-run; an in-memory Buffer write is index-free.
//
// Reading `--ref`'s content once via `git show <ref>:<path>` and doing every mutation/restore as a
// raw in-memory Buffer write is restore-exact by construction — a byte-for-byte comparison, not a
// text/whitespace-fuzzy one. It also generalizes past a single hunk: any-shaped drift between --ref
// and your current file is covered, not just one inserted marker line.
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
// Exit 0 iff: the RED phase failed as expected AND that failure is BEHAVIOURAL (or --allow-structural
// was passed), the GREEN phase passed as expected, AND every reverted file restored byte-identical to
// its original snapshot. Non-zero and a named reason otherwise — printed in full, this script's own
// output is never the thing worth compressing.
//
// RED-PHASE CLASSIFICATION (card 95f2a466): a RED that is merely a compile/import failure proves the
// symbol is missing, not that the logic is wrong, so the RED phase is classified and only BEHAVIOURAL
// counts as proof. Rules, in order:
//   BUILD-ONLY    the build exited non-zero. Tests then ran against stale/partial output, so even a test
//                 failure in the same phase proves nothing.
//   BEHAVIOURAL   build ok and at least one failing test printed a recognised assertion-failure line
//                 (`FAIL ...`, `not ok`, ✗, ❌ at line start, or an AssertionError). Takes precedence over
//                 every structural signature.
//   STRUCTURAL    a failing test with no assertion line whose STDERR holds a crash signature (missing
//                 export, cannot find module, "is not a function", TS23xx, or a ReferenceError /
//                 SyntaxError / "Cannot read properties" WITH a stack frame).
//   UNCLASSIFIED  a failing test with neither (e.g. exit 1 and nothing printed, an unlisted crash).
//                 Fail-closed: never assumed behavioural.
// Signatures are matched against stderr only, so a behavioural message that merely contains one of those
// strings (printed on stdout via a FAIL line) can't trigger them. The phase is BEHAVIOURAL if ANY failing
// test is BEHAVIOURAL; otherwise it is refused (exit 3) unless --allow-structural, which accepts
// STRUCTURAL, BUILD-ONLY and UNCLASSIFIED alike.
// KNOWN GAP: a test that try/catches a missing API call and prints its own `FAIL` line is classified
// BEHAVIOURAL — the classifier reads output, it can't tell why an assertion failed.
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
// `execFileSync`'s default maxBuffer is 1 MiB — too small for `git show <ref>:<path>` against a real
// source file (packages/daemon/src/sessions/service.ts alone is already 1.44 MB; see card 7c979d92).
// 100 MiB matches the same one-shot-allocation convention vault/versioner.ts's VAULT_FLUSH_MAX_BUFFER_BYTES
// already uses for its own occasional git calls — cheap insurance, not a resource concern on this path.
const GIT_SHOW_MAX_BUFFER_BYTES = 100 * 1024 * 1024;

const HELP = `negative-control — one-call RED→GREEN→clean-tree proof (card 616e5ec2)

Usage:
  pnpm --filter @loom/daemon negative-control \\
    --file <repo/relative/path> [--file <repo/relative/path> ...] \\
    --test <repo/relative/test.mjs> [--test <repo/relative/test.mjs> ...] \\
    [--ref <git-ref>] [--build "<command>"] [--allow-structural]
  or, instead of --file/--ref:  --mutant <patch.diff> --test <test.mjs> ...

  --file    Repo-relative path to a source file your uncommitted (or --ref-relative) fix touches.
            Repeatable. Its CURRENT on-disk bytes are snapshotted, temporarily replaced with the
            content at --ref, and restored byte-for-byte afterwards no matter what happens.
  --test    Repo-relative path to a test .mjs to run in both phases. Repeatable.
  --ref     Git ref whose version of each --file is the "broken" state to prove RED against.
            Default: HEAD (the usual case — your fix is an uncommitted working-tree edit on top of
            HEAD). If your fix is already committed, pass e.g. --ref HEAD~1 or --ref HEAD^.
  --build   Build command to run before each test phase. Default: "${DEFAULT_BUILD_COMMAND}".
  --mutant  Path to a unified diff (git format) that KEEPS the API and disables only the logic. Instead of
            reverting --file(s) to --ref, the patch is applied to the working tree (\`git apply\`, never
            --index: the git index stays untouched) to make the broken bytes, so a card that ADDS an API
            can still produce a BEHAVIOURAL RED. The files the patch touches are snapshotted automatically
            and restored byte-for-byte afterwards, same as --file. MUTUALLY EXCLUSIVE with --file/--ref
            (exit 2). Refused with exit 2, tree untouched, when: the patch does not apply cleanly
            (\`git apply --check\`), touches a path outside the repo root, ADDS, DELETES or RENAMES a file
            (not restorable byte-exactly here), is a binary patch, changes file modes, or names no file.
            Generate one with \`git diff\` against your fixed tree after hand-disabling the logic.
  --allow-structural  Accept a RED that is not BEHAVIOURAL (see below). Default: refuse, exit 3.
  RED CLASSES (the RED phase is only proof of a bug when it is BEHAVIOURAL):
    BUILD-ONLY    the build failed (tests ran against stale output) — proves nothing about logic.
    BEHAVIOURAL   build ok and a failing test printed an assertion-failure line: a line starting with
                  FAIL, "not ok", ✗ or ❌, or an AssertionError. Counted as failingAssertions.
    STRUCTURAL    no assertion line, and stderr shows a crash: "does not provide an export named",
                  "Cannot find module"/ERR_MODULE_NOT_FOUND, "is not a function"/"is not a constructor",
                  TS23xx/TS2304/TS2307/TS2339, or ReferenceError/SyntaxError/"Cannot read properties"
                  with a stack frame. The symbol is missing; the logic was never exercised.
    UNCLASSIFIED  non-zero exit with no recognised assertion line and no known signature (0 recognised
                  assertion lines). Fail-closed: treated like STRUCTURAL.
    A phase is BEHAVIOURAL if ANY failing test is. Signatures are matched on stderr only, and assertion
    lines win over signatures. Known gap: a test that try/catches a missing API and prints its own
    FAIL line reads as BEHAVIOURAL — keep the API and disable the logic instead (a mutant).
  Exit codes: 0 proven; 1 RED/GREEN/restore failure; 2 usage / --mutant patch refused (nothing was
  mutated); 3 RED class refused.
  The last stdout line is always: [negative-control] RESULT: red=<class> failingAssertions=<n>
    green=<pass|FAIL> restore=<verified|MISMATCH> => OK | REFUSED(<reason>)
  --repo-root  Override the repo root everything above is relative to. Default: this script's own
            real repo. TEST SEAM ONLY — point a test at a throwaway synthetic git fixture instead of
            exercising this script against its own real, shared source tree.
  --help    Print this and exit 0.
`;

function parseArgs(argv) {
  const args = { file: [], test: [], ref: DEFAULT_REF, build: DEFAULT_BUILD_COMMAND, repoRoot: DEFAULT_REPO_ROOT, help: false, allowStructural: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { args.help = true; continue; }
    if (a === "--file") { args.file.push(argv[++i]); continue; }
    if (a === "--test") { args.test.push(argv[++i]); continue; }
    if (a === "--ref") { args.ref = argv[++i]; args.refGiven = true; continue; }
    if (a === "--mutant") { args.mutant = argv[++i]; continue; }
    if (a === "--build") { args.build = argv[++i]; continue; }
    if (a === "--allow-structural") { args.allowStructural = true; continue; }
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

/**
 * Parse the repo-relative paths a unified diff touches. Returns { paths } or { refusal }.
 * Refuses (rather than guesses) anything we could not restore byte-exactly from a per-file snapshot:
 * add/delete/rename, binary patches, mode changes, quoted (escaped) paths, and out-of-root paths.
 */
function parsePatchPaths(patchBuf) {
  const text = patchBuf.toString("latin1");
  const paths = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (/^(new file mode|deleted file mode|rename (from|to)|copy (from|to)|similarity index) /.test(line)) {
      return { refusal: `patch adds, deletes, renames or copies a file ("${line}") — not restorable byte-exactly; only in-place edits of existing files are supported` };
    }
    if (/^(old mode|new mode) /.test(line)) return { refusal: `patch changes a file mode ("${line}") — not restored by this tool` };
    if (/^GIT binary patch|^Binary files /.test(line)) return { refusal: "binary patch — not supported" };
    const m = /^(?:---|\+\+\+) (.*?)(?:\t.*)?$/.exec(line);
    if (!m) continue;
    const raw = m[1];
    if (raw === "/dev/null") return { refusal: "patch adds or deletes a file (/dev/null side) — not restorable byte-exactly" };
    if (raw.startsWith('"')) return { refusal: `quoted path ${raw} — not supported` };
    const rel = raw.replace(/^[ab]\//, "");
    const norm = path.posix.normalize(rel.replaceAll("\\", "/"));
    if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || norm === ".." || norm.startsWith("../") || norm.startsWith("/")) {
      return { refusal: `patch path "${rel}" is outside the repo root` };
    }
    paths.add(norm);
  }
  if (paths.size === 0) return { refusal: "patch names no file (not a unified diff?)" };
  return { paths: [...paths] };
}

function readRefContent(repoRoot, ref, posixRel) {
  try {
    return execFileSync("git", ["show", `${ref}:${posixRel}`], { cwd: repoRoot, maxBuffer: GIT_SHOW_MAX_BUFFER_BYTES });
  } catch (err) {
    throw new Error(`\`git show ${ref}:${posixRel}\` failed — does ${posixRel} exist at ref "${ref}"? (${err.message})`);
  }
}

const CAPTURE_MAX_BUFFER_BYTES = 256 * 1024 * 1024;
// A line that is a test's own assertion-failure report (repo `check()` prints `FAIL  label`).
const ASSERTION_LINE_RE = /^\s*(?:FAIL|not ok|✗|❌)\b/;
const ASSERTION_ERROR_RE = /\bAssertionError\b/;
const STACK_FRAME_RE = /\n\s+at /;
// Crash signatures, matched against a failing test's STDERR only (never stdout).
const STRUCTURAL_SIGNATURES = [
  /does not provide an export named/,
  /ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)/,
  /\bis not a (?:function|constructor)\b/,
  /\bTS23\d\d\b|\bTS2304\b|\bTS2307\b|\bTS2339\b/,
];
// These need a stack frame to count — bare prose containing the words is not a crash.
const STRUCTURAL_WITH_STACK_SIGNATURES = [/\bReferenceError\b/, /\bSyntaxError\b/, /Cannot read propert(?:y|ies) of/];

function echo(r) {
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
}

/** Classify ONE failing test from its captured output. Assertion lines win; then stderr signatures; else UNCLASSIFIED. */
function classifyFailingTest(stdout, stderr) {
  const lines = `${stdout}\n${stderr}`.split(/\r?\n/);
  let assertions = lines.filter((l) => ASSERTION_LINE_RE.test(l)).length;
  if (assertions === 0 && ASSERTION_ERROR_RE.test(stderr)) assertions = 1;
  if (assertions > 0) return { cls: "BEHAVIOURAL", assertions };
  const structural =
    STRUCTURAL_SIGNATURES.some((re) => re.test(stderr)) ||
    (STACK_FRAME_RE.test(stderr) && STRUCTURAL_WITH_STACK_SIGNATURES.some((re) => re.test(stderr)));
  return { cls: structural ? "STRUCTURAL" : "UNCLASSIFIED", assertions: 0 };
}

/** Classify a whole RED phase. "NONE" = the phase did not fail at all. */
function classifyPhase({ buildOk, testResults }) {
  const failing = testResults.filter((r) => r.status !== 0);
  if (buildOk && failing.length === 0) return { cls: "NONE", assertions: 0 };
  if (!buildOk) return { cls: "BUILD-ONLY", assertions: 0 };
  const per = failing.map((r) => classifyFailingTest(r.stdout ?? "", r.stderr ?? ""));
  const assertions = per.reduce((n, p) => n + p.assertions, 0);
  if (per.some((p) => p.cls === "BEHAVIOURAL")) return { cls: "BEHAVIOURAL", assertions };
  return { cls: per.some((p) => p.cls === "STRUCTURAL") ? "STRUCTURAL" : "UNCLASSIFIED", assertions };
}

function runPhase(repoRoot, label, { buildCommand, testPaths }) {
  console.log(`\n[negative-control] ── ${label}: build (${buildCommand}) ──`);
  const buildResult = spawnSync(buildCommand, { cwd: repoRoot, shell: true, encoding: "utf8", maxBuffer: CAPTURE_MAX_BUFFER_BYTES });
  echo(buildResult);
  const buildOk = buildResult.status === 0;
  if (!buildOk) {
    console.error(`[negative-control] ${label}: build exited ${buildResult.status} — tests below still run so you can see whether the test itself also caught the break, but a build failure alone already counts as this phase NOT passing (and classifies a RED as BUILD-ONLY).`);
  }
  const testResults = [];
  for (const t of testPaths) {
    console.log(`[negative-control] ── ${label}: running ${t} ──`);
    const r = spawnSync(process.execPath, [t], { cwd: repoRoot, encoding: "utf8", maxBuffer: CAPTURE_MAX_BUFFER_BYTES });
    echo(r);
    testResults.push({ test: t, status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" });
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
  const mutantMode = args.mutant !== undefined;
  if (mutantMode && (args.file.length > 0 || args.refGiven)) {
    console.error("[negative-control] --mutant is mutually exclusive with --file/--ref (two different ways to get the broken bytes).");
    process.exit(2);
  }
  if ((!mutantMode && args.file.length === 0) || args.test.length === 0) {
    console.error("[negative-control] at least one --test and either --file (one or more) or --mutant are required.\n");
    console.error(HELP);
    process.exit(2);
  }

  const repoRoot = args.repoRoot;
  let patchAbs = null;
  let files;
  if (mutantMode) {
    patchAbs = path.resolve(process.cwd(), args.mutant);
    let patchBuf;
    try {
      patchBuf = fs.readFileSync(patchAbs);
    } catch (err) {
      console.error(`[negative-control] --mutant ${args.mutant} could not be read (${err.message}).`);
      process.exit(2);
    }
    const parsed = parsePatchPaths(patchBuf);
    if (parsed.refusal) {
      console.error(`[negative-control] ⛔ --mutant patch refused: ${parsed.refusal}. Nothing was changed.`);
      process.exit(2);
    }
    files = parsed.paths.map((f) => toAbsPath(repoRoot, f));
  } else {
    files = args.file.map((f) => toAbsPath(repoRoot, f));
  }

  // Fail fast, before mutating anything: every file must exist on disk now, and (--file mode) every
  // file must resolve at --ref. Collecting snapshots up front means a bad argument never leaves a file
  // half-reverted.
  const snapshots = [];
  for (const { posixRel, absPath } of files) {
    let original;
    try {
      original = fs.readFileSync(absPath);
    } catch (err) {
      console.error(`[negative-control] ${mutantMode ? "patched file" : "--file"} ${posixRel} could not be read (${err.message}) — it must exist in your worktree now.`);
      process.exit(2);
    }
    const refContent = mutantMode ? null : readRefContent(repoRoot, args.ref, posixRel);
    snapshots.push({ posixRel, absPath, original, refContent });
  }

  const brokenLabel = mutantMode ? `mutant ${path.basename(patchAbs)}` : args.ref;
  if (mutantMode) {
    // `git apply` WITHOUT --index: the index is never touched. --check first so a non-applying patch is
    // a clean refusal; git apply is all-or-nothing without --reject, and we re-verify the bytes anyway.
    const chk = spawnSync("git", ["apply", "--check", patchAbs], { cwd: repoRoot, encoding: "utf8" });
    if (chk.status !== 0) {
      console.error(`[negative-control] ⛔ --mutant patch does not apply to the current tree (git apply --check exited ${chk.status}): ${(chk.stderr ?? "").trim()}\nNothing was changed.`);
      process.exit(2);
    }
  }

  console.log(`[negative-control] ${mutantMode ? `applying ${brokenLabel} to` : `reverting`} ${snapshots.length} file(s)${mutantMode ? "" : ` to ${args.ref}`}, proving RED, restoring, proving GREEN:`);
  for (const s of snapshots) console.log(`  - ${s.posixRel}`);

  let phase1;
  let restoreErrors = [];
  try {
    if (mutantMode) {
      const ap = spawnSync("git", ["apply", patchAbs], { cwd: repoRoot, encoding: "utf8" });
      if (ap.status !== 0) throw new Error(`git apply failed after --check passed: ${(ap.stderr ?? "").trim()}`);
    } else {
      for (const s of snapshots) fs.writeFileSync(s.absPath, s.refContent);
    }
    phase1 = runPhase(repoRoot, `RED phase (${mutantMode ? "mutant applied" : `reverted to ${args.ref}`})`, { buildCommand: args.build, testPaths: args.test });
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
  const redClass = classifyPhase(phase1);
  const classOk = redClass.cls === "BEHAVIOURAL" || args.allowStructural;

  console.log("\n[negative-control] ── SUMMARY ──");
  console.log(`  RED   (${mutantMode ? "mutant applied" : `reverted to ${args.ref}`}): ${phase1.pass ? "PASSED — ⚠️ expected this to FAIL" : "failed, as expected"} ⇒ ${redOk ? "OK" : "❌ FAIL"}`);
  console.log(`  CLASS (RED failure kind):        ${redClass.cls}, ${redClass.assertions} recognised assertion line(s)${redClass.cls === "BEHAVIOURAL" ? "" : args.allowStructural ? " — allowed by --allow-structural" : " — not behavioural ⇒ ❌ REFUSED"}`);
  console.log(`  GREEN (restored):                ${phase2.pass ? "passed, as expected" : "FAILED — ⚠️ expected this to PASS"} ⇒ ${greenOk ? "OK" : "❌ FAIL"}`);
  console.log(`  CLEAN (byte-identical restore):  ${cleanOk ? "confirmed for all file(s)" : `MISMATCH: ${integrityFailures.join(", ")}`} ⇒ ${cleanOk ? "OK" : "❌ FAIL"}`);

  if (!redOk) {
    console.error(`\n[negative-control] ❌ the RED phase did not fail — ${mutantMode ? "applying the mutant" : `reverting to ${args.ref}`} did not make ${args.test.join(", ")} fail. Either the test doesn't actually cover this change, or ${mutantMode ? "the mutant doesn't disable the logic under test" : "--ref doesn't name the pre-fix state"}.`);
  }
  if (!greenOk) {
    console.error(`\n[negative-control] ❌ the GREEN phase did not pass — the restored (current) state still fails ${args.test.join(", ")}. Your fix is not actually green.`);
  }
  if (!cleanOk) {
    console.error(`\n[negative-control] ❌ restore did not reproduce the original bytes for: ${integrityFailures.join(", ")}. Do not trust your worktree — diff these files against your last known-good state before doing anything else.`);
  }

  const classRefused = redOk && !classOk;
  if (classRefused) {
    console.error(`\n[negative-control] ❌ the RED phase failed, but as ${redClass.cls} (${redClass.assertions} recognised assertion lines), not BEHAVIOURAL — that proves a symbol/import/build is missing or the cause is unrecognised, not that the logic is wrong. Keep the API and disable only the logic (a mutant), give the test a FAIL line, or pass --allow-structural if a structural RED is genuinely what you mean to prove.`);
  }
  const ok = redOk && greenOk && cleanOk && classOk;
  console.log(ok ? "\n✅ negative control proven: RED before the fix, GREEN after, tree restored clean." : "\n❌ negative control NOT proven — see failures above.");
  const reasons = [];
  if (!redOk) reasons.push("red-did-not-fail");
  if (classRefused) reasons.push(`red-class-${redClass.cls}`);
  if (!greenOk) reasons.push("green-failed");
  if (!cleanOk) reasons.push("restore-mismatch");
  console.log(`[negative-control] RESULT: red=${redClass.cls}${redOk && args.allowStructural && redClass.cls !== "BEHAVIOURAL" ? "(allowed)" : ""} failingAssertions=${redClass.assertions} green=${greenOk ? "pass" : "FAIL"} restore=${cleanOk ? "verified" : "MISMATCH"} => ${ok ? "OK" : `REFUSED(${reasons.join(",")})`}`);
  // 3 = ONLY the RED class was refused (everything else held); any other failure is 1.
  process.exit(ok ? 0 : classRefused && greenOk && cleanOk ? 3 : 1);
}

main();
