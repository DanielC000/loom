// loom:not-a-test: standalone stub CHILD PROCESS substituted for a real harness binary (via LOOM_CODEX_BIN
// / LOOM_CLAUDE_BIN + a generated `.cmd` wrapper) — it is DRIVEN BY pty-codex-spawn-env.mjs, never run as a
// test itself, and has no PASS/FAIL/check() output of its own. It only trips the discovery heuristic by
// living under test/fixtures/ with a cli-shaped name.
//
// Test fixture ONLY (not a shipped asset). Mirrors fake-claude-cli.mjs's own "real, standalone Node
// process substituted for the real CLI via a *_BIN env var" technique, but does the ONE thing that
// harness's own env-reaching claim needs proved: dumps its OWN real `process.env` (as seen by the actual
// OS child process node-pty spawned) to FIXTURE_ENV_OUTPUT_FILE as JSON, prints a short sentinel line, then
// stays alive briefly so the harness has a live pty to hold/kill (mirrors fake-claude-cli.mjs's "never
// exits on its own; the harness kills it" contract, bounded here since nothing drives further interaction).
import fs from "node:fs";

const outputFile = process.env.FIXTURE_ENV_OUTPUT_FILE;
if (!outputFile) {
  process.stdout.write("FIXTURE_FAIL FIXTURE_ENV_OUTPUT_FILE env var is required but was not set\n");
  process.exit(1);
}

fs.writeFileSync(outputFile, JSON.stringify(process.env));
process.stdout.write("FIXTURE_ENV_DUMPED\n");

setTimeout(() => process.exit(0), 5000);
