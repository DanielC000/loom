import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 62c4953a round 2 (Code Review 6ed0d5da, M6) — `logCanonicalGitAbnormalOutcome` (git/bounded.ts)
// must log ONLY for an abnormal (killed/timed-out) outcome, with the args summary redacted, and stay
// fully silent for a normal call. Proves it against a REAL killed git child via `killableCanonicalRaw`
// (`spawnCanonicalGitTree`'s own raw() closure) — the exact chokepoint `logCanonicalGitAbnormalOutcome`
// wraps.
//
// Round 5 (Code Review `bc965645`): `summarizeGitArgsForLog` itself was rewritten to stop parsing flags
// entirely after three straight rounds of per-flag parser gaps — see docs/decisions/62c4953a-*.md "Round
// 5". The real-killed-call assertions below now expect its new collapsed shape (`commit <N args
// redacted>`), and the unit-coverage block further down covers every hostile shape from both prior
// reviews plus the allowlisted-subcommand full-args cases.
//
// FIXTURE: a pre-commit hook that just sleeps (no tick-based idle-timer defense needed here, unlike
// bounded-git-kill-on-timeout.mjs — `spawnCanonicalGitTree` is a raw spawn with no competing simple-git
// `block` idle timer in this path at all; the only timer in play is `withTimeoutKillingChild`'s own
// AbortController-based kill, so a single sleep is sufficient to guarantee the kill fires before the hook
// would ever finish naturally).
//
// Run: 1) build daemon (pnpm build), 2) node test/bounded-git-index-lock-log.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

const { killableCanonicalRaw, summarizeGitArgsForLog } = await import("../dist/git/bounded.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=bgill@loom -c user.name=bgill";
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const repo = path.join(os.tmpdir(), `loom-bgill-repo-${sfx}`);
const tmpDirs = [repo];

fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# bgill\n");
execSync(`git init -q && git config user.email bgill@loom && git config user.name bgill`, { cwd: repo });
execSync(`git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });

// A single, non-ticking sleep is enough — see the file-header note above for why this fixture doesn't
// need bounded-git-kill-on-timeout.mjs's own tick-based idle-timer defense.
const hookPath = path.join(repo, ".git", "hooks", "pre-commit");
fs.writeFileSync(hookPath, `#!/bin/sh\nnode -e 'setTimeout(()=>{},5000)'\n`);
fs.chmodSync(hookPath, 0o755);

// Measured directly on this host (no win-job-launcher.exe built — the taskkill-based fallback path): a
// 300ms kill-trigger + 300ms give-up grace reliably hits GIVE-UP (path 2, ~636ms), not a genuine CONFIRMED
// kill — the real taskkill-based confirm round-trip here needs more than 600ms. 1500ms/1500ms reliably
// produces a genuine confirmed kill (measured ~1.8-2s total) well before the hook's own 5000ms natural
// completion, so the outer `await` only resolves AFTER `logCanonicalGitAbnormalOutcome` has already run.
const KILL_TIMEOUT_MS = 1500;

const SECRET_MESSAGE = "super secret commit body text that must never reach the log";

function captureConsole() {
  const logLines = [];
  const warnLines = [];
  const realLog = console.log;
  const realWarn = console.warn;
  console.log = (...args) => { logLines.push(args.join(" ")); };
  console.warn = (...args) => { warnLines.push(args.join(" ")); };
  return {
    logLines, warnLines,
    restore() { console.log = realLog; console.warn = realWarn; },
  };
}

try {
  // ── a REAL killed call on an index-touching subcommand ("commit") ──────────────────────────────────
  fs.writeFileSync(path.join(repo, "edit.txt"), "change\n");
  execSync(`git add .`, { cwd: repo });
  const cap1 = captureConsole();
  let threw = null;
  const startedAt = Date.now();
  try {
    await killableCanonicalRaw(repo, ["commit", "-m", SECRET_MESSAGE], KILL_TIMEOUT_MS, "git commit (test, index-lock-log)");
  } catch (e) {
    threw = e;
  }
  cap1.restore();
  const elapsedMs = Date.now() - startedAt;
  check("(killed) the call actually rejected (the kill fired)", threw !== null);
  check("(killed) settled well under the hook's own 5000ms natural duration (genuinely killed, not a natural finish)", elapsedMs < 4500);
  check("(killed) settled well past the 1500ms kill-trigger (a confirmed kill, not an instant unrelated failure)", elapsedMs >= KILL_TIMEOUT_MS);

  const logHit = cap1.logLines.find((l) => /\[git\] canonical git call (confirmed-killed|kill-unconfirmed) after \d+ms/.test(l));
  check("(killed) a start/end diagnostic line was logged, naming the outcome and a duration", !!logHit);
  check("(killed) the diagnostic line names the commit subcommand with its WHOLE tail collapsed to a count, never the real message", !!logHit && /git commit <2 args redacted>/.test(logHit) && !logHit.includes(SECRET_MESSAGE));

  const warnHit = cap1.warnLines.find((l) => /\[git\] canonical git call "git commit".*may have been left behind/.test(l));
  check("(killed) a WARN was logged naming index.lock risk (commit is an index-writing subcommand)", !!warnHit);
  check("(killed) neither the log nor the warn line ever contains the real secret message text", !cap1.logLines.some((l) => l.includes(SECRET_MESSAGE)) && !cap1.warnLines.some((l) => l.includes(SECRET_MESSAGE)));

  // The kill may have left the commit genuinely uncommitted/half-staged; clean up before the next step so
  // a stray leftover lock/stage from this scenario can't contaminate the next one.
  try { execSync(`git reset --hard HEAD`, { cwd: repo }); } catch { /* best-effort cleanup */ }
  try { fs.rmSync(path.join(repo, ".git", "index.lock")); } catch { /* may not exist */ }

  // ── a REAL killed call through the SAME chokepoint, but with a `-C <repo>` GLOBAL-OPTION PREFIX before
  //    the subcommand (round 4, Code Review 1260fb58 BLOCKER) — behavioral, end-to-end proof: this is the
  //    exact shape that made round 3's own subcommand detection read the prefix's VALUE ("/repo") as the
  //    subcommand, miss "commit" entirely, and log the real message UNREDACTED. ─────────────────────────
  fs.writeFileSync(path.join(repo, "edit2.txt"), "change2\n");
  execSync(`git add .`, { cwd: repo });
  const SECRET_MESSAGE_2 = "super secret commit body text #2 that must never reach the log via a -C prefix";
  const cap1b = captureConsole();
  let threw1b = null;
  const startedAt1b = Date.now();
  try {
    await killableCanonicalRaw(repo, ["-C", repo, "commit", "-m", SECRET_MESSAGE_2], KILL_TIMEOUT_MS, "git commit (test, -C prefix)");
  } catch (e) {
    threw1b = e;
  }
  cap1b.restore();
  const elapsedMs1b = Date.now() - startedAt1b;
  check("(-C prefix, killed) the call actually rejected (the kill fired)", threw1b !== null);
  check("(-C prefix, killed) settled well under the hook's own 5000ms natural duration", elapsedMs1b < 4500);
  check("(-C prefix, killed) settled well past the 1500ms kill-trigger", elapsedMs1b >= KILL_TIMEOUT_MS);
  check(
    "(-C prefix, killed) neither the log nor the warn line ever contains the real secret message text — PROVES the -C prefix did not defeat redaction",
    !cap1b.logLines.some((l) => l.includes(SECRET_MESSAGE_2)) && !cap1b.warnLines.some((l) => l.includes(SECRET_MESSAGE_2)),
  );
  const logHit1b = cap1b.logLines.find((l) => /\[git\] canonical git call (confirmed-killed|kill-unconfirmed) after \d+ms/.test(l));
  check("(-C prefix, killed) the diagnostic line names commit's WHOLE tail collapsed to a count despite the -C prefix", !!logHit1b && /-C .* commit <2 args redacted>/.test(logHit1b));

  try { execSync(`git reset --hard HEAD`, { cwd: repo }); } catch { /* best-effort cleanup */ }
  try { fs.rmSync(path.join(repo, ".git", "index.lock")); } catch { /* may not exist */ }

  // ── a NORMAL (fast, successful) call on the SAME chokepoint — logs NOTHING ──────────────────────────
  const cap2 = captureConsole();
  const out = await killableCanonicalRaw(repo, ["rev-parse", "HEAD"], 5000, "git rev-parse HEAD (test, index-lock-log)");
  cap2.restore();
  check("(normal) the ordinary call actually succeeded", typeof out === "string" && out.trim().length > 0);
  check("(normal) a successful call logs NOTHING on console.log", cap2.logLines.length === 0);
  check("(normal) a successful call logs NOTHING on console.warn", cap2.warnLines.length === 0);
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// summarizeGitArgsForLog — direct unit coverage (round 5, Code Review bc965645 — three straight rounds
// of flag-parser gaps; round 5 stops parsing flags entirely and fails closed at the SUBCOMMAND level).
// Deliberately placed AFTER the real-killed-child scenarios above (not before): those already give a
// genuine BEHAVIORAL RED/GREEN proof (a real secret visible or not in a real captured log line) that does
// not depend on this function being exported at all. These unit cases cover every hostile shape named
// across BOTH prior Code Reviews — the new design makes every one of them trivially closed (there is no
// flag inspection left to have a gap in), plus the allowlisted-subcommand full-args cases.
//
// Every "fully redacted" assertion checks the EXACT expected string, not a loose substring match — the
// new design is simple enough to predict precisely, and an exact match is what actually proves nothing
// of the secret (not even a fragment, not even its own flag name) survives into the log.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
{
  // ── every hostile shape from round 3 (Code Review 6ed0d5da) and round 4 (Code Review 1260fb58) ──────

  // -C prefix (round 4 BLOCKER) — the whole commit tail collapses, prefix untouched.
  check(
    "(-C prefix) commit's whole tail collapses to a count; -C /repo is untouched",
    summarizeGitArgsForLog(["-C", "/repo", "commit", "-m", "SECRET"]) === "-C /repo commit <2 args redacted>",
  );
  // --git-dir prefix — same shape, different global option.
  check(
    "(--git-dir prefix) commit's whole tail collapses to a count",
    summarizeGitArgsForLog(["--git-dir", "/some/path/.git", "commit", "-m", "SECRET"]) === "--git-dir /some/path/.git commit <2 args redacted>",
  );
  // -mConfirm (round 4's OWN leak, B1): the greedy attached/clustered regex it shipped turned this into
  // "-mConfirm <redacted>" — logging the message in clear. There is no flag regex left to do that.
  check(
    "(-mConfirm, round-4 B1 leak) fully collapsed, 'Confirm' never present",
    summarizeGitArgsForLog(["commit", "-mConfirm"]) === "commit <1 arg redacted>",
  );
  // -amPassForm (round 4's OWN leak, B1 sibling) — same shape, a clustered attached form.
  check(
    "(-amPassForm, round-4 B1 leak) fully collapsed, 'PassForm' never present",
    summarizeGitArgsForLog(["commit", "-amPassForm"]) === "commit <1 arg redacted>",
  );
  // --mess X (round 4's OWN leak, B2): a SEPARATE-value abbreviation — round 4 only ever matched the
  // `=`-joined form, never a space-separated one.
  check(
    "(--mess X, round-4 B2 leak) fully collapsed, 'SECRET' never present",
    summarizeGitArgsForLog(["commit", "--mess", "SECRET"]) === "commit <2 args redacted>",
  );
  // --fil secretfile (round 4's OWN leak, B2 sibling) — same shape for --file's abbreviation.
  check(
    "(--fil secretfile, round-4 B2 leak) fully collapsed, 'secretfile' never present",
    summarizeGitArgsForLog(["commit", "--fil", "secretfile"]) === "commit <2 args redacted>",
  );
  // --auth=X (round 4's OWN leak, B3): round 4's own "Do not extend abbreviation matching to --author"
  // ruling forbade fixing this — round 5 deletes abbreviation matching entirely instead.
  check(
    "(--auth=X, round-4 B3 leak) fully collapsed, 'SECRET' never present",
    summarizeGitArgsForLog(["commit", "--auth=SECRET"]) === "commit <1 arg redacted>",
  );
  // --autho X (round 4's OWN leak, B3 sibling) — the separate-value form of the same abbreviation.
  check(
    "(--autho X, round-4 B3 leak) fully collapsed, 'SECRET' never present",
    summarizeGitArgsForLog(["commit", "--autho", "SECRET"]) === "commit <2 args redacted>",
  );
  // --trailer "Signed-off-by: N <e>" — a flag neither round ever named at all; proves the new design
  // needs no per-flag enumeration to stay closed against a shape nobody has thought of yet.
  check(
    "(--trailer) fully collapsed, the trailer text never present",
    summarizeGitArgsForLog(["commit", "--trailer", "Signed-off-by: N <e@example.com>"]) === "commit <2 args redacted>",
  );
  // -C p commit -m X — a global prefix COMBINED with an attached/clustered-shaped tail.
  check(
    "(-C p commit -m X) fully collapsed, prefix untouched",
    summarizeGitArgsForLog(["-C", "p", "commit", "-m", "SECRET"]) === "-C p commit <2 args redacted>",
  );
  // An UNKNOWN subcommand — deny by default: never seen before still collapses, never logs in full.
  check(
    "(unknown subcommand) fully collapsed, 'SECRET' never present",
    summarizeGitArgsForLog(["frobnicate", "-m", "SECRET"]) === "frobnicate <2 args redacted>",
  );
  // -c user.name=X — the KEY is visible (a config path name, not a secret); the VALUE is redacted.
  check(
    "(-c user.name=X) the key is visible, the value is redacted, and commit's own tail still collapses",
    summarizeGitArgsForLog(["-c", "user.name=SECRET", "commit", "-m", "SECRET2"]) === "-c user.name=<redacted> commit <2 args redacted>",
  );
  // worktree lock --reason <string> (round 6, Code Review b0e10423): `worktree` was REMOVED from the
  // allowlist — this flag takes free text, so the prior "verified safe" claim was false.
  check(
    "(worktree lock --reason LEAK3, round-6 leak) fully collapsed, 'LEAK3' never present",
    summarizeGitArgsForLog(["worktree", "lock", "--reason", "LEAK3", "/wt"]) === "worktree <4 args redacted>",
  );
  // -C -c -c user.password=LEAK1 status (round 6, Code Review b0e10423, item 2): the OLD prefix-redaction
  // loop re-scanned an already-sliced prefix ARRAY by CONTENT, so -C's own VALUE ("-c") was mistaken for
  // a real -c flag, mis-pairing the REAL second -c's value as that fake flag's value and leaking it
  // unredacted. The new shared walker pairs each value-taking global option by POSITION in the ORIGINAL
  // args, closing this for -C...
  check(
    "(-C -c -c user.password=LEAK1 status, round-6 leak) the REAL password is redacted; -C's own coincidental '-c' value is untouched",
    summarizeGitArgsForLog(["-C", "-c", "-c", "user.password=LEAK1", "status"]) === "-C -c -c user.password=<redacted> status",
  );
  // ...and for --git-dir, the same shape with a different value-taking global option.
  check(
    "(--git-dir -c -c user.password=LEAK2 status, round-6 leak) the REAL password is redacted",
    summarizeGitArgsForLog(["--git-dir", "-c", "-c", "user.password=LEAK2", "status"]) === "--git-dir -c -c user.password=<redacted> status",
  );

  // ── allowlisted subcommands still log their args IN FULL — the new design must not over-redact ──────
  check("(allowlisted: merge-base) logs every arg in full", summarizeGitArgsForLog(["merge-base", "A", "B"]) === "merge-base A B");
  check("(allowlisted: reset --hard) logs every arg in full", summarizeGitArgsForLog(["reset", "--hard", "abc123"]) === "reset --hard abc123");
  check(
    "(allowlisted: log -F --grep x) logs every arg in full — --grep and its pattern are NOT consumed",
    summarizeGitArgsForLog(["log", "-F", "--grep", "x"]) === "log -F --grep x",
  );
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a killed canonical git call (index-touching subcommand) logs a start/end diagnostic " +
    "plus a WARN naming index.lock risk, with -m message content redacted; an ordinary successful call " +
    "logs nothing at all."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
