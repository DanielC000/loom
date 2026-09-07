// loom:not-a-test: this is a standalone stub CHILD PROCESS substituted for the real `codex` binary via a
// generated `.cmd` wrapper pointed at FIXTURE_PATH — it is DRIVEN BY test/codex-version-real-spawn.mjs,
// never run as a test itself, and has no PASS/FAIL/check() output of its own. It only trips the discovery
// heuristic by living under test/fixtures/ with a codex/cli-shaped name.
//
// Minimal real-process stand-in for the `codex` binary — mirrors fake-claude-cli.mjs's role (a genuine
// standalone Node process substituted via an env-var bin override, never a mocked exec) but scoped, for
// now, to exactly what pty/codex-doctrine.ts's version-cache path needs: `codex --version`. This is the
// ONE piece of the stateful Codex runtime this card's first pass actually ships (the trust-dialog/
// busy-idle TUI automation is pending an architecture decision — see the parity matrix); this fixture is
// deliberately NOT a full Codex TUI emulator and should not be extended into one without first re-reading
// this file's own scope note.
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("codex-cli 9.9.9-fixture\n");
  process.exit(0);
}
process.stderr.write(`fake-codex-cli: unsupported args ${JSON.stringify(args)}\n`);
process.exit(1);
