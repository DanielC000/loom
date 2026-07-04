import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Supervisor-change detection for `daemon_restart` (card 10864591 / auditor finding 76e76afa). The
// deploy-restart path re-execs the DAEMON but never the outer supervisor (scripts/daemon-supervisor.mjs)
// that spawned it, so a diff touching that script (or its launch env, set INSIDE the script) is
// silently inert until a manual `pnpm daemon:stable` — this proves the advisory-warning detection:
//
//   - a git-log hit for scripts/daemon-supervisor.mjs since boot ⇒ changed:true
//   - no hit ⇒ changed:false
//   - a git failure (thrown / rejected) degrades to changed:false, NEVER throws — the check is
//     advisory only and must never block the restart itself.
//   - the query is scoped to the RIGHT file, with a `--since=<bootTime ISO>` bound.
//
// HERMETIC: NO real spawn, NO claude — drives the restart module's injectable git seam directly with a
// FAKE `gitLogSince`, so it asserts the detection logic without touching a real repo.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/supervisor-change-detect.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-scd-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { supervisorScriptChangedSince, SUPERVISOR_SCRIPT_REL_PATH, SUPERVISOR_CHANGED_WARNING } =
  await import("../dist/orchestration/restart.js");

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
} finally {
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — daemon_restart's supervisor-change detection flags a diff touching scripts/daemon-supervisor.mjs, degrades safely on a git failure, and never blocks the restart itself."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
