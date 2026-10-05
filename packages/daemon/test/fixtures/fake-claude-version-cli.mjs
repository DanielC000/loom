// loom:not-a-test: this is a standalone stub CHILD PROCESS substituted for the real `claude` binary via a
// generated npm cmd-shim-shaped `.cmd` wrapper — it is DRIVEN BY test/usage-status-cmdshim-real-spawn.mjs,
// never run as a test itself, and has no PASS/FAIL/check() output of its own. It only trips the discovery
// heuristic by living under test/fixtures/ with a claude/cli-shaped name.
//
// Minimal real-process stand-in for the `claude` binary — mirrors fake-codex-cli.mjs's role (a genuine
// standalone Node process substituted via an env-var bin override routed through a real npm cmd-shim, not
// a mocked exec), scoped to exactly what orchestration/usage-status.ts's `prewarmClaudeVersionAsync` needs:
// `claude --version`.
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("claude-cli 1.2.3-fixture\n");
  process.exit(0);
}
process.stderr.write(`fake-claude-version-cli: unsupported args ${JSON.stringify(args)}\n`);
process.exit(1);
