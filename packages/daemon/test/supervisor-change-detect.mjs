import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Supervisor-change detection for `daemon_restart` (card 10864591 / auditor finding 76e76afa). The
// deploy-restart path re-execs the DAEMON but never the outer supervisor (scripts/daemon-supervisor.mjs)
// that spawned it, so a diff touching that script (or its launch env, set INSIDE the script) is
// silently inert until a manual `pnpm daemon:stable` — this proves the advisory-warning detection:
//
//   - a git-log hit for scripts/daemon-supervisor.mjs since boot ⇒ changed:true
//   - no hit ⇒ changed:false
//   - a git failure (thrown / rejected) degrades to changed:false, NEVER throws — the check is
//     advisory only and must never block the restart itself — but IS NOW LOGGED (card 469b5e67), so a
//     failed check is distinguishable from a genuine "checked, unchanged" (both used to be a silent,
//     indistinguishable `false` with no trace of which happened).
//   - the query is scoped to the RIGHT file, with a `--since=<bootTime ISO>` bound.
//
// HERMETIC: NO real spawn, NO claude — drives the restart module's injectable git seam directly with a
// FAKE `gitLogSince`, so it asserts the detection logic without touching a real repo.
//
// Card 469b5e67 (Code Reviewer c24c08b4): the PRODUCTION `defaultGitLogSince` used to build its git via
// `boundedSimpleGit(root, ms, { ...process.env, GIT_TERMINAL_PROMPT: "0" })` — a shape that THROWS
// (`GitPluginError`) the instant an ambient GIT_EDITOR/GIT_PAGER/PAGER/EDITOR/GIT_SEQUENCE_EDITOR/
// GIT_EXTERNAL_DIFF is set, and whose throw `supervisorScriptChangedSince` swallowed into a silent
// `false` — the supervisor-changed warning never fires, indistinguishable from a genuine "unchanged".
// The two RED-PROOF sections below exercise the REAL (uninjected) `defaultGitLogSince` against THIS
// repo's own real, permanent commit history for scripts/daemon-supervisor.mjs — the fake-gitLogSince
// tests above never touched the buggy `.env()` call at all, so they could not have caught this.
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/supervisor-change-detect.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-scd-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { supervisorScriptChangedSince, SUPERVISOR_SCRIPT_REL_PATH, SUPERVISOR_CHANGED_WARNING } =
  await import("../dist/orchestration/restart.js");
const { boundedSimpleGit } = await import("../dist/git/bounded.js");

// packages/daemon/test/supervisor-change-detect.mjs → repo root is 3 levels up (mirrors restart.ts's
// own repoRoot(), which resolves from its dist location the same way).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

try {
  const bootTime = new Date("2026-07-04T00:00:00.000Z");

  // --- a committed change to the supervisor script since boot ⇒ changed:true ---
  const calls1 = [];
  const changed = await supervisorScriptChangedSince(bootTime, {
    gitLogSince: async (root, sinceIso, file) => {
      calls1.push({ root, sinceIso, file });
      return "abc1234\n";
    },
  });
  check("(hit) a non-empty git-log result ⇒ changed:true", changed === true);
  check("(scope) the query is scoped to scripts/daemon-supervisor.mjs", calls1[0].file === SUPERVISOR_SCRIPT_REL_PATH);
  check("(scope) the query is bounded by the boot-time ISO string", calls1[0].sinceIso === bootTime.toISOString());

  // --- no commits touching the file since boot ⇒ changed:false ---
  const unchanged = await supervisorScriptChangedSince(bootTime, {
    gitLogSince: async () => "",
  });
  check("(miss) an empty git-log result ⇒ changed:false", unchanged === false);

  // --- whitespace-only output (git can print a trailing newline) still reads as no match ---
  const whitespaceOnly = await supervisorScriptChangedSince(bootTime, {
    gitLogSince: async () => "\n  \n",
  });
  check("(miss) whitespace-only output ⇒ changed:false", whitespaceOnly === false);

  // --- a git failure degrades to false, NEVER throws (advisory-only — must not block the restart) ---
  let threw = false;
  let degraded;
  try {
    degraded = await supervisorScriptChangedSince(bootTime, {
      gitLogSince: async () => { throw new Error("git not found"); },
    });
  } catch {
    threw = true;
  }
  check("(fail-safe) a git-log rejection is swallowed, never thrown", threw === false);
  check("(fail-safe) a git-log failure degrades to changed:false", degraded === false);

  // --- the surfaced warning names the supervisor script and the manual-restart remediation ---
  check("(message) the warning names the supervisor script path", SUPERVISOR_CHANGED_WARNING.includes(SUPERVISOR_SCRIPT_REL_PATH));
  check("(message) the warning names the manual remediation", /pnpm daemon:stable/.test(SUPERVISOR_CHANGED_WARNING));

  // --- DoD-2: a check FAILURE must be distinguishable from a genuine "checked, unchanged" ---
  // (card 469b5e67 — the old code folded BOTH into an identical silent `return false`, with nothing
  // anywhere logging which one happened. A control against a genuine miss is included right below so
  // "logs on failure" and "silent on success" are shown as a real contrast, not asserted in isolation.)
  {
    const capturedWarnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => capturedWarnings.push(args.join(" "));
    let failureResult;
    try {
      failureResult = await supervisorScriptChangedSince(bootTime, {
        gitLogSince: async () => { throw new Error('Use of "GIT_PAGER" is not permitted without enabling allowUnsafePager'); },
      });
    } finally {
      console.warn = originalWarn;
    }
    check("(DoD-2 failure) a check failure still degrades to false (advisory — must never block the restart)", failureResult === false);
    check("(DoD-2 failure) a check failure is NOW logged, not silently swallowed", capturedWarnings.length > 0);
    check("(DoD-2 failure) the log names it as a FAILED check, not a confirmed negative",
      capturedWarnings.some((w) => /could NOT check/i.test(w) && w.includes("GIT_PAGER")));
  }
  {
    const capturedWarnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => capturedWarnings.push(args.join(" "));
    let missResult;
    try {
      missResult = await supervisorScriptChangedSince(bootTime, { gitLogSince: async () => "" });
    } finally {
      console.warn = originalWarn;
    }
    check("(DoD-2 contrast) a genuine miss still returns false", missResult === false);
    check("(DoD-2 contrast) a genuine miss logs NOTHING — else the new log line would itself cry wolf", capturedWarnings.length === 0);
  }

  // --- RED-PROOF (DoD-1 + DoD-3): with an ambient GIT_PAGER set, the OLD `.env(process.env spread)`
  // shape must THROW, and the REAL (uninjected) production defaultGitLogSince — reached only by calling
  // supervisorScriptChangedSince with NO deps override — must NOT, and must correctly surface a real
  // hit. Uses this repo's own permanent commit history for scripts/daemon-supervisor.mjs (Conventional
  // Commits are enforced going-forward-only / never rewritten per this repo's own CLAUDE.md, so commits
  // already on main since 2000-01-01 stay reachable indefinitely — this is not fragile against future
  // history). Independently confirmed present at the time this test was written via a plain
  // `git log --since=2000-01-01 -- scripts/daemon-supervisor.mjs`.
  {
    const savedEnv = {};
    for (const k of ["GIT_EDITOR", "GIT_PAGER", "PAGER", "EDITOR", "GIT_SEQUENCE_EDITOR", "GIT_EXTERNAL_DIFF"]) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    process.env.GIT_PAGER = "cat";
    const FAR_PAST_ISO = "2000-01-01T00:00:00.000Z";
    try {
      // Mechanism: literally reconstruct the OLD buggy shape (the exact change reverted by this card)
      // against a real repo and prove it throws under the ambient var this test just set.
      const oldStyleGit = boundedSimpleGit(REPO_ROOT, 10_000, { ...process.env, GIT_TERMINAL_PROMPT: "0" });
      let oldThrew = false, oldMessage = "";
      try {
        await oldStyleGit.raw(["log", `--since=${FAR_PAST_ISO}`, "--format=%H", "--", SUPERVISOR_SCRIPT_REL_PATH]);
      } catch (e) {
        oldThrew = true;
        oldMessage = e instanceof Error ? e.message : String(e);
      }
      check("(RED-PROOF mechanism) the OLD `.env(process.env spread)` shape THROWS under ambient GIT_PAGER", oldThrew === true);
      check("(RED-PROOF mechanism) the throw is simple-git's unsafe-operations guard on GIT_PAGER specifically",
        /GIT_PAGER/.test(oldMessage) && /unsafe/i.test(oldMessage));

      // Behavior: the REAL production path (no deps override — this is defaultGitLogSince, not a fake)
      // must NOT throw under the same ambient var, and must correctly report the real hit as `true`.
      const capturedWarnings = [];
      const originalWarn = console.warn;
      console.warn = (...args) => capturedWarnings.push(args.join(" "));
      let fixedResult;
      try {
        fixedResult = await supervisorScriptChangedSince(new Date(FAR_PAST_ISO));
      } finally {
        console.warn = originalWarn;
      }
      check("(RED-PROOF fixed) the REAL uninjected defaultGitLogSince does NOT throw/degrade under the same ambient GIT_PAGER", fixedResult === true);
      check("(RED-PROOF fixed) no 'could not check' warning fired — this was a genuine successful check, not a masked failure", capturedWarnings.length === 0);
    } finally {
      for (const k of Object.keys(savedEnv)) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
    }
  }
} finally {
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — daemon_restart's supervisor-change detection flags a diff touching scripts/daemon-supervisor.mjs, degrades safely on a git failure, and never blocks the restart itself."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
