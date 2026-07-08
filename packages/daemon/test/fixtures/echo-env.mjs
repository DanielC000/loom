// Test fixture ONLY (not a shipped asset) — a throwaway "echo-env MCP" stand-in used by
// test/github-capability.mjs to prove, via a REAL child_process spawn (not a mocked exec call), that a
// capability's injected secret arrives through the OS process env and NEVER through argv. Dumps its own
// argv + env as one JSON line to stdout, then exits.
process.stdout.write(JSON.stringify({ argv: process.argv, env: process.env }));
