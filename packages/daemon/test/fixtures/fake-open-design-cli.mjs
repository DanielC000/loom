#!/usr/bin/env node
// Fixture stand-in for the real `od` (open-design, github.com/nexu-io/open-design) CLI, used ONLY by
// open-design-spawn.mjs's resolver coverage. The
// real spawn path (`openDesignMcpServer` in pty/host.ts) launches this file DIRECTLY as the command (not
// wrapped in `process.execPath`) — so it needs the shebang above to be executable
// on its own. On any invocation it just exits 0 immediately; no real MCP handshake is exercised here,
// only that `fs.existsSync` + the resolved {command, args} shape are correct.
process.exit(0);
