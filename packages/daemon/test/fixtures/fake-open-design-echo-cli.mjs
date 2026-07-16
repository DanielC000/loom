#!/usr/bin/env node
// Fixture stand-in for OD's real desktop-app entry, used ONLY by open-design-spawn.mjs's full-spec
// (card e8eee68c) real-cross-process-spawn coverage. Unlike fake-open-design-cli.mjs (which just exits
// 0), this one ECHOES its own argv + a curated set of env vars as JSON on stdout, so a test can assert
// the exact {command, args, env} a caller configured actually reached the child process — proving
// openDesignMcpServer's verbatim injection isn't just object-shape-asserted but genuinely round-trips
// through a real spawn (mocking the exec impl would never catch an argv/env-plumbing bug like this).
process.stdout.write(JSON.stringify({
  argv: process.argv.slice(2),
  env: {
    OD_DATA_DIR: process.env.OD_DATA_DIR ?? null,
    OD_SIDECAR_IPC_PATH: process.env.OD_SIDECAR_IPC_PATH ?? null,
    ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE ?? null,
  },
}));
process.exit(0);
