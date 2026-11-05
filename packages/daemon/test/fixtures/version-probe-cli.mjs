// loom:not-a-test: standalone stub CHILD PROCESS substituted for the `codex` binary (via LOOM_CODEX_BIN + an npm
// cmd-shim from test/_codex-npm-shim.mjs) — DRIVEN BY codex-version-prewarm-launch.mjs (card d1614667), never
// run as a test itself. Copied into the shim dir, so it imports only node: builtins.
//
// On `--version`: dumps {argv, env, pid, ppid} to FIXTURE_PROBE_OUT, prints a version line and exits. With
// FIXTURE_PROBE_HANG=1 it writes ONLY its pid to FIXTURE_PROBE_PID_FILE and then never exits (the timeout
// case: the test proves the prewarm's timeout killed THIS real process, not just a wrapper).
import fs from "node:fs";

if (process.env.FIXTURE_PROBE_HANG === "1") {
  fs.writeFileSync(process.env.FIXTURE_PROBE_PID_FILE, String(process.pid));
  setInterval(() => {}, 1000);
  // Self-exit so a RED run (or a crashed test) can never leave this orphaned on the host.
  setTimeout(() => process.exit(0), 30_000);
} else if (process.env.FIXTURE_PROBE_EXIT) {
  // Non-zero-exit case: a REAL failure (not ENOENT) with noisy stderr the prewarm log must bound.
  process.stderr.write("fixture-stderr-line-1\nfixture-stderr-SECRET-LINE-2\n");
  process.exit(Number(process.env.FIXTURE_PROBE_EXIT));
} else {
  fs.writeFileSync(
    process.env.FIXTURE_PROBE_OUT,
    JSON.stringify({ argv: process.argv.slice(2), env: process.env, pid: process.pid, ppid: process.ppid }),
  );
  process.stdout.write("codex-cli 7.7.7\n");
}
