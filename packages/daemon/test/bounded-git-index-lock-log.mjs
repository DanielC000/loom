import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 62c4953a round 2 (Code Review 6ed0d5da, M6) — `logCanonicalGitAbnormalOutcome` (git/bounded.ts)
// must log ONLY for an abnormal (killed/timed-out) outcome, with the args summary redacted (a `-m`
// message value scrubbed), and stay fully silent for a normal call. Proves it against a REAL killed git
// child via `killableCanonicalRaw` (`spawnCanonicalGitTree`'s own raw() closure) — the exact chokepoint
// `logCanonicalGitAbnormalOutcome` wraps.
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

const { killableCanonicalRaw } = await import("../dist/git/bounded.js");

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
  check("(killed) the diagnostic line names the commit subcommand with its -m value REDACTED, never the real message", !!logHit && /git commit -m <redacted>/.test(logHit) && !logHit.includes(SECRET_MESSAGE));

  const warnHit = cap1.warnLines.find((l) => /\[git\] canonical git call "git commit".*may have been left behind/.test(l));
  check("(killed) a WARN was logged naming index.lock risk (commit is an index-writing subcommand)", !!warnHit);
  check("(killed) neither the log nor the warn line ever contains the real secret message text", !cap1.logLines.some((l) => l.includes(SECRET_MESSAGE)) && !cap1.warnLines.some((l) => l.includes(SECRET_MESSAGE)));

  // The kill may have left the commit genuinely uncommitted/half-staged; clean up before the next step so
  // a stray leftover lock/stage from this scenario can't contaminate the "normal call" assertion below.
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

console.log(failures === 0
  ? "\n✅ ALL PASS — a killed canonical git call (index-touching subcommand) logs a start/end diagnostic " +
    "plus a WARN naming index.lock risk, with -m message content redacted; an ordinary successful call " +
    "logs nothing at all."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
