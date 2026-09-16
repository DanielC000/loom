import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 83718377: `isSupervised()` (orchestration/restart.ts) only proves a process was SPAWNED under the
// restart supervisor once — the env var it reads is inherited at spawn and never re-checked, so it stays
// true forever even after the supervisor has since died. Card 3fba0cd2 makes the daemon survive a broken
// stdout pipe, which means it can now genuinely outlive its supervisor as an orphan — a later
// `daemon_restart` on that orphan would exit 75 into nothing, taking every project on the host down
// silently. `isSupervisorProcessAlive`/`walkSupervisorAncestry` close that gap by re-deriving, from the
// LIVE OS process table, whether a genuine `daemon-supervisor.mjs` process is still an ancestor.
//
// PLATFORM COVERAGE (read this before trusting a "PASS" from CI): this file is written to run
// IDENTICALLY on win32 and POSIX — `defaultSupervisorProcessRows()` branches internally on
// `process.platform`, so every test below (including the real-spawn chain in PART C) exercises whichever
// branch this host actually has. What is MEASURED on which platform:
//   - PART A (pure `walkSupervisorAncestry` + the identity regex) is platform-INDEPENDENT: it feeds a
//     synthetic `Map` and never touches an OS enumerator at all. Passes identically everywhere.
//   - PART B (`isSupervisorProcessAlive`'s own enumeration-failure handling) injects a fake `rows()` that
//     throws/times out — also platform-independent.
//   - PART C (the real-spawn chain) exercises the REAL Windows (`Get-CimInstance`) or REAL POSIX (`ps`)
//     enumerator, whichever this host has. This session authored + ran this file on win32 only — the
//     POSIX branch's PARSING regex was validated by hand against `ps -eo pid=,ppid=,etimes=,command=`'s
//     documented output shape, but its first REAL execution is whatever CI host runs this file next.
// Run: 1) build daemon, 2) node test/supervisor-liveness.mjs
import { spawn } from "node:child_process";
import path from "node:path";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

const restart = await import("../dist/orchestration/restart.js");
const {
  walkSupervisorAncestry, isSupervisorProcessAlive, SUPERVISOR_INVOCATION_RE, parseEtimeToSeconds,
  SUPERVISOR_MAX_ANCESTOR_HOPS, SUPERVISOR_CREATION_SLOP_MS,
} = restart;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// ===================== PART A — pure walkSupervisorAncestry + the identity regex =====================

const row = (ppid, commandLine, createdAtMs) => ({ ppid, commandLine, createdAtMs });

{
  // (A1) direct match at hop 0 — the POSIX `sh -c` exec-optimization shape, where the daemon's own ppid
  // IS the supervisor with no intermediate wrapper.
  const rows = new Map([[10, row(1, "node scripts/daemon-supervisor.mjs", 1000)]]);
  const r = walkSupervisorAncestry(10, 5000, rows);
  check("(A1) match at hop 0 (POSIX exec-optimized shape) -> alive:true", r.alive === true);
}

{
  // (A2) match at hop 2 — the MEASURED Windows shape: daemon -> cmd.exe shell wrapper -> real supervisor.
  const rows = new Map([
    [10, row(20, 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c "node --report-on-fatalerror dist/index.js"', 2000)],
    [20, row(1, "node  scripts/daemon-supervisor.mjs", 1000)],
  ]);
  const r = walkSupervisorAncestry(10, 3000, rows);
  check("(A2) match at hop 2 (Windows shell-wrap shape, MEASURED against this host's own real chain) -> alive:true", r.alive === true);
}

{
  // (A3) supervisor genuinely dead — its pid is simply absent from the live snapshot.
  const rows = new Map([[10, row(999, "cmd.exe /c node dist/index.js", 2000)]]);
  const r = walkSupervisorAncestry(10, 3000, rows);
  check("(A3) supervisor pid absent from the live snapshot -> alive:false", r.alive === false);
  check("(A3) reason names the missing pid", /999/.test(r.reason ?? ""));
}

{
  // (A4) card 83718377 amendment 2 — "match an invocation, not a mention": a cmd.exe WRAPPER whose own
  // /c argument textually contains "daemon-supervisor.mjs" must NOT count — the executable running is
  // cmd.exe, not node, and the real node supervisor process is absent from this table entirely.
  const rows = new Map([
    [10, row(20, 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c "node scripts/daemon-supervisor.mjs"', 2000)],
  ]);
  const r = walkSupervisorAncestry(10, 3000, rows);
  check("(A4) wrapper-only chain (substring present, real node invocation absent) -> alive:false", r.alive === false);
}

{
  // (A5) a decoy node process at the position a supervisor would occupy, running an unrelated file.
  const rows = new Map([[10, row(1, "\"C:\\Program Files\\nodejs\\node.exe\" fake-decoy.mjs", 2000)]]);
  const r = walkSupervisorAncestry(10, 3000, rows);
  check("(A5) decoy node process (unrelated file) -> alive:false", r.alive === false);
}

{
  // (A6) card 83718377 amendment 1 — a pid RECYCLED at an intermediate hop onto an unrelated process,
  // whose OWN (real, legitimate) ancestry happens to contain a coincidentally-matching command line
  // further up. Without the creation-time monotonicity check the walk would climb straight through the
  // recycled pid and wrongly report alive:true. The recycled pid's row is stamped with a creation time
  // AFTER its claimed child (violating "a parent must not be younger than its child") — this must be
  // caught and refused BEFORE the walk ever reaches (or even looks at) the coincidental match above it.
  const rows = new Map([
    [10, row(20, "cmd.exe /c node dist/index.js", 1_000_000)], // the daemon's real wrapper, created at t=1,000,000
    // pid 20 was reused: the NEW occupant started at t=5,000,000 — well AFTER its claimed child (pid 10,
    // t=1,000,000) — so it cannot genuinely be pid 10's parent.
    [20, row(30, "some-unrelated-long-running-process.exe --serve", 5_000_000)],
    // pid 20's own (real) parent DOES happen to be a genuine daemon-supervisor.mjs invocation — proving
    // the refusal comes from the monotonicity check, not from this hop being otherwise unreachable.
    [30, row(1, "node scripts/daemon-supervisor.mjs", 100)],
  ]);
  const r = walkSupervisorAncestry(10, 1_000_500, rows);
  check("(A6) recycled intermediate pid whose ancestry CONTAINS a matching command line -> still refuses", r.alive === false);
  check("(A6) reason cites the broken-chain / pid-reuse rationale", /reused|broken/i.test(r.reason ?? ""));
}

{
  // (A7) cycle guard — a malformed table pointing back to itself must never hang the walk.
  const rows = new Map([
    [10, row(20, "cmd.exe", 2000)],
    [20, row(10, "weird.exe", 2000)],
  ]);
  const r = walkSupervisorAncestry(10, 3000, rows);
  check("(A7) cyclic ancestry -> refuses without hanging", r.alive === false);
}

{
  // (A8) hop cap — a genuinely deep chain with no match anywhere must not climb "to the root".
  const rows = new Map();
  for (let i = 0; i < SUPERVISOR_MAX_ANCESTOR_HOPS + 5; i++) rows.set(10 + i, row(10 + i + 1, `unrelated-process-${i}.exe`, 1000 + i));
  const r = walkSupervisorAncestry(10, 900, rows);
  check(`(A8) no match within ${SUPERVISOR_MAX_ANCESTOR_HOPS} hops of a genuinely deep chain -> refuses rather than climbing further`, r.alive === false);
}

{
  // (A9) unknown creation time (enumerator couldn't report one) is treated as a verification failure,
  // not silently skipped — the invariant is unverifiable, so pid reuse can't be ruled out for that hop.
  const rows = new Map([[10, row(1, "node scripts/daemon-supervisor.mjs", null)]]);
  const r = walkSupervisorAncestry(10, 3000, rows);
  check("(A9) unknown creation time on an otherwise-matching row -> still refuses", r.alive === false);
}

{
  // (A10) the creation-time check has slack (SUPERVISOR_CREATION_SLOP_MS) for coarse POSIX etimes
  // rounding — a parent whose reported start is a few seconds "after" its child, within slop, must not
  // be wrongly refused.
  const rows = new Map([[10, row(1, "node scripts/daemon-supervisor.mjs", 10_000 + SUPERVISOR_CREATION_SLOP_MS - 500)]]);
  const r = walkSupervisorAncestry(10, 10_000, rows);
  check("(A10) parent creation time within slop of its child -> still alive:true (rounding tolerance)", r.alive === true);
}

// --- the identity regex, exercised directly (card 83718377 amendment 2's own test table) ---
{
  const cases = [
    ["real supervisor (MEASURED against this host's own live daemon)", "node  scripts/daemon-supervisor.mjs", true],
    ["real supervisor, absolute quoted path", String.raw`"C:\Program Files\nodejs\node.exe" scripts/daemon-supervisor.mjs`, true],
    ["POSIX absolute path", "/usr/bin/node /repo/scripts/daemon-supervisor.mjs", true],
    ["cmd.exe wrapper naming an unrelated script", String.raw`C:\WINDOWS\system32\cmd.exe /d /s /c "node \"C:\Users\danie\ancestry.mjs\""`, false],
    ["cmd.exe wrapper whose /c argument IS the real supervisor invocation text", String.raw`C:\WINDOWS\system32\cmd.exe /d /s /c "node scripts/daemon-supervisor.mjs"`, false],
    ["decoy node process, unrelated file", String.raw`"C:\Program Files\nodejs\node.exe" fake-decoy-not-supervisor.mjs`, false],
    ["a shim mentioning the script as a stray mid-line argument, not the entry point", String.raw`"C:\Program Files\nodejs\node.exe" pnpm-shim.js scripts/daemon-supervisor.mjs --dry-run extra`, false],
    ["node running a different script with the string only in a flag value", "node worker.js --note=daemon-supervisor.mjs-is-not-me", false],
    ["notepad editing a file named like it", "notepad.exe daemon-supervisor.mjs.txt", false],
    ["the real daemon's own dist/index.js invocation (must never self-match)", String.raw`node  --report-on-fatalerror --report-uncaught-exception --report-directory="C:\Users\danie\.loom\reports" dist/index.js`, false],
    // card 83718377 Code Review finding #4: parentheses in a real Windows install path (e.g. the 32-bit
    // Program Files folder) must not be rejected — the executable-prefix char class used to exclude "()".
    ["absolute node path containing parens (32-bit Program Files)", String.raw`"C:\Program Files (x86)\nodejs\node.exe" scripts/daemon-supervisor.mjs`, true],
    // the real `--detach` launch shape: absolute node + absolute script path, no shell wrapper at all
    // (daemon-supervisor.mjs's own --detach block spawns itself this way — see that file's header).
    ["real --detach shape: absolute node + absolute script, unquoted", String.raw`C:\Program Files\nodejs\node.exe C:\loom\scripts\daemon-supervisor.mjs`, true],
    ["real --detach shape: absolute node + absolute script, both quoted", String.raw`"C:\Program Files\nodejs\node.exe" "C:\loom\scripts\daemon-supervisor.mjs"`, true],
    ["POSIX script path containing a space", "/usr/bin/node /opt/my project/scripts/daemon-supervisor.mjs", true],
    // negative control for the "both quoted" case above: a QUOTED final token that is NOT actually the
    // supervisor script must still be rejected — proves the leading-quote allowance on the final segment
    // didn't loosen the identity check itself into accepting any quoted node argument.
    ["decoy node process, QUOTED unrelated file (must still reject)", String.raw`"C:\Program Files\nodejs\node.exe" "fake-decoy-not-supervisor.mjs"`, false],
  ];
  for (const [label, line, expect] of cases) {
    check(`(A-regex) ${label}`, SUPERVISOR_INVOCATION_RE.test(line) === expect);
  }
}

// ===================== PART B — isSupervisorProcessAlive: fail-closed enumeration handling =====================

{
  // (B1) enumeration times out — checkFailed:true, distinct from a confirmed-dead supervisor.
  const timeoutErr = new Error("powershell.exe ETIMEDOUT");
  timeoutErr.killed = true;
  const r = await isSupervisorProcessAlive({ rows: async () => { throw timeoutErr; } });
  check("(B1) enumeration timeout -> alive:false", r.alive === false);
  check("(B1) enumeration timeout -> checkFailed:true", r.checkFailed === true);
  check("(B1) reason mentions the timeout", /timed out/i.test(r.reason ?? ""));
}

{
  // (B2) enumeration exits non-zero / a plain spawn error — also checkFailed:true, worded differently
  // from the timeout case (distinguishable causes, same fail-closed outcome).
  const execErr = new Error("Command failed: powershell.exe\nAccess is denied.");
  const r = await isSupervisorProcessAlive({ rows: async () => { throw execErr; } });
  check("(B2) enumeration error (non-timeout) -> alive:false", r.alive === false);
  check("(B2) enumeration error (non-timeout) -> checkFailed:true", r.checkFailed === true);
  check("(B2) reason does not falsely claim a timeout", !/timed out/i.test(r.reason ?? ""));
}

{
  // (B3) enumeration "succeeds" but returns nothing parseable — treated the same as a failure, never as
  // "confirmed nobody is running" (a real host always has hundreds of processes).
  const r = await isSupervisorProcessAlive({ rows: async () => new Map() });
  check("(B3) empty enumeration result -> alive:false", r.alive === false);
  check("(B3) empty enumeration result -> checkFailed:true", r.checkFailed === true);
}

{
  // (B4) a fully injected, matching snapshot -> alive:true, proving the deps seam wires end to end
  // (self.ppid/self.createdAtMs + rows all threaded through to walkSupervisorAncestry correctly).
  const rows = new Map([[10, row(1, "node scripts/daemon-supervisor.mjs", 500)]]);
  const r = await isSupervisorProcessAlive({ rows: async () => rows, self: { ppid: 10, createdAtMs: 2000 } });
  check("(B4) injected matching snapshot -> alive:true", r.alive === true);
  check("(B4) a confirmed-alive result carries no checkFailed flag", !r.checkFailed);
}

{
  // (B5) card 83718377 Code Review finding #1: with NO `self` override supplied, OUR OWN creation time
  // must be sourced from the SAME enumeration/clock as every ancestor row — never from Node's
  // Date.now()-process.uptime() arithmetic, a DIFFERENT clock source that can disagree with the OS
  // enumerator's own timestamps (a backward wall-clock step after boot, or a DST-fold-back-ambiguous
  // local-time conversion) and spuriously trip the parent-younger-than-child check, causing a refusal
  // that would recur for this daemon's whole remaining lifetime.
  //
  // Construction: this process's OWN real pid is stamped with a createdAtMs far in the FUTURE relative
  // to actual wall-clock now (something the real Date.now()-uptime arithmetic could never itself
  // produce). This process's OWN real ppid (a genuine ancestor, whatever it happens to be) is stamped as
  // the real supervisor, at a time well AFTER real wall-clock now but safely BEFORE the injected
  // far-future self. If the fix is in place (self sourced from this same `rows` map), the walk sees a
  // parent that started before its (far-future) child and finds the match: alive:true. If the OLD bug
  // were still present (self derived from Date.now()-uptime, i.e. approximately REAL now), the same
  // ancestor row would appear to have started hours AFTER that real-now self — comfortably past
  // SUPERVISOR_CREATION_SLOP_MS — and the walk would wrongly refuse.
  const nowMs = Date.now();
  const farFutureSelf = nowMs + 10 * 60 * 60 * 1000; // +10h — only reachable via the rows-sourced fix
  const ancestorCreatedAt = nowMs + 5 * 60 * 60 * 1000; // +5h — before the injected self, but WAY after a real Date.now()-based self
  const rows = new Map([
    [process.pid, row(999_999_001, "irrelevant to this check — only createdAtMs is read for self", farFutureSelf)],
    [process.ppid, row(1, "node scripts/daemon-supervisor.mjs", ancestorCreatedAt)],
  ]);
  const r = await isSupervisorProcessAlive({ rows: async () => rows }); // deliberately NO `self` override
  check(
    "(B5) self creation time is sourced from the SAME enumeration as ancestors, not Date.now()-uptime — " +
    "alive:true here is only reachable via the fix (a Date.now()-based self would have falsely refused)",
    r.alive === true,
  );
}

{
  // (B6) our own pid is missing from the enumeration entirely -> checkFailed (a real host always finds
  // itself in its own process table; this is a failed CHECK, never evidence the supervisor is dead).
  const rows = new Map([[999_999_002, row(1, "node scripts/daemon-supervisor.mjs", 1000)]]); // deliberately excludes process.pid
  const r = await isSupervisorProcessAlive({ rows: async () => rows });
  check("(B6) our own pid absent from the enumeration -> alive:false", r.alive === false);
  check("(B6) our own pid absent from the enumeration -> checkFailed:true", r.checkFailed === true);
}

// --- card 83718377 Code Review finding #2: parseEtimeToSeconds, exercised directly so the POSIX `ps -o
// etime` parse path (otherwise only ever exercised on a POSIX CI runner) is proven from ANY host,
// including this one. `etime` (POSIX-standard) replaces the earlier `etimes` (a GNU procps-ng extension
// absent on macOS/BSD `ps` and a minimal/busybox `ps` — which would have made EVERY POSIX self-host
// restart permanently checkFailed). ---
{
  const cases = [
    ["mm:ss", "05:30", 5 * 60 + 30],
    ["mm:ss, single-digit minute (real ps output shape, no leading zero)", "5:09", 5 * 60 + 9],
    ["hh:mm:ss", "01:02:03", 3600 + 2 * 60 + 3],
    ["dd-hh:mm:ss", "2-01:02:03", 2 * 86_400 + 3600 + 2 * 60 + 3],
    ["zero elapsed", "00:00", 0],
    ["leading/trailing whitespace (ps right-justifies columns)", "  05:30  ", 5 * 60 + 30],
    ["garbage input", "not-a-time", null],
    ["empty string", "", null],
  ];
  for (const [label, input, expected] of cases) {
    check(`(etime) ${label}`, parseEtimeToSeconds(input) === expected);
  }
}

// ===================== PART C — REAL spawn chain, exercising the REAL OS enumerator end-to-end =====================
// Mirrors production's actual shape (daemon-supervisor.mjs's runDaemon spawning the daemon via
// spawn(cmd,{shell:true})): a real supervisor node process, spawned in its OWN scratch dir under the
// EXACT filename "daemon-supervisor.mjs" — the real basename SUPERVISOR_INVOCATION_RE requires, not
// merely a string that contains it as a loose suffix (card 83718377 Code Review finding: a prior draft
// used "fake-daemon-supervisor.mjs", which would have passed on the substring alone even if the identity
// regex were accidentally loosened to a bare .includes()-style check) — spawns a shell-wrapped "daemon"
// child that calls the REAL (non-injected) isSupervisorProcessAlive and reports its result back over
// stdout. No LOOM_HOME/daemon/DB involved — this only proves the OS ancestry-walk mechanism itself,
// independent of anything Loom-specific.
{
  const scratchDir = mkdtempManaged("loom-supervisor-liveness-realspawn-");
  const supervisorScript = path.join(scratchDir, "daemon-supervisor.mjs"); // EXACT real basename, not a loose suffix match
  const daemonScript = path.join(scratchDir, "fake-daemon-child.mjs");
  // Windows requires a file:// URL for an absolute dynamic import() path (a bare drive-letter path throws
  // ERR_UNSUPPORTED_ESM_URL_SCHEME) — resolve it HERE, in this already-running process, and embed the
  // finished href as a plain string literal so the generated child script never has to re-derive it.
  const restartDistHref = new URL(path.join("..", "dist", "orchestration", "restart.js"), import.meta.url).href;

  const fs = await import("node:fs");
  fs.writeFileSync(daemonScript, [
    `const restart = await import(${JSON.stringify(restartDistHref)});`,
    `const result = await restart.isSupervisorProcessAlive();`,
    `process.stdout.write(JSON.stringify(result));`,
  ].join("\n"));
  fs.writeFileSync(supervisorScript, [
    `import { spawn } from "node:child_process";`,
    `const cmd = \`node ${JSON.stringify(daemonScript)}\`;`,
    `const child = spawn(cmd, { cwd: ${JSON.stringify(scratchDir)}, shell: true, stdio: ["ignore", "pipe", "pipe"] });`,
    `let out = "";`,
    `child.stdout.on("data", (d) => { out += d.toString(); });`,
    `child.stderr.on("data", (d) => { out += d.toString(); });`,
    `child.on("close", () => { process.stdout.write(out); });`,
  ].join("\n"));

  const output = await new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [supervisorScript], { cwd: scratchDir, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    proc.stdout.on("data", (d) => { out += d.toString(); });
    proc.stderr.on("data", (d) => { out += d.toString(); });
    const timer = setTimeout(() => { proc.kill(); reject(new Error(`real-spawn chain timed out; captured so far: ${out}`)); }, 20_000);
    proc.on("close", () => { clearTimeout(timer); resolve(out); });
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
  });

  let parsed = null;
  try { parsed = JSON.parse(output.trim().split("\n").pop()); } catch { /* left null; the check below fails with the raw output for debugging */ }
  check(`(C) real spawn chain (daemon-supervisor.mjs -> shell:true -> daemon) is found alive via the REAL ${process.platform === "win32" ? "Windows Get-CimInstance" : "POSIX ps"} enumerator — raw output: ${output.trim().slice(0, 300)}`, parsed?.alive === true);
}

console.log(
  failures === 0
    ? "\n✅ ALL PASS — isSupervisorProcessAlive/walkSupervisorAncestry correctly identify a live daemon-supervisor.mjs " +
      "ancestor (direct match, shell-wrapped match — MEASURED against this host's real daemon+supervisor pair) and " +
      "refuse — distinguishing a confirmed-dead/mismatched supervisor from a failed CHECK — on a dead supervisor, a " +
      "pid recycled onto an unrelated process (even one whose own real ancestry coincidentally contains a matching " +
      "command line), a wrapper that merely MENTIONS the script without invoking it, a cyclic table, a too-deep " +
      "chain, an unverifiable creation time, and an enumeration timeout/error/empty-result."
    : `\n🔴 ${failures} FAILURE(S) — see PASS/FAIL lines above.`,
);
await finishAndExit(failures === 0 ? 0 : 1);
