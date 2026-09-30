#!/usr/bin/env node
// Fake stand-in for the real `npm i -g <spec>` step in bin/loom.mjs's update() (card 0da5a3f7's
// LOOM_TEST_NPM_INSTALL_CMD test seam — see runNpmInstall's own comment). NEVER touches the real global
// npm registry: it just records that it was invoked (proof update() actually reached the reinstall step,
// not a real install) via a marker file named by FAKE_NPM_MARKER, then exits.
import fs from "node:fs";

const marker = process.env.FAKE_NPM_MARKER;
if (marker) {
  fs.writeFileSync(marker, JSON.stringify({ argv: process.argv.slice(2), at: new Date().toISOString() }, null, 2) + "\n");
}
process.exit(process.env.FAKE_NPM_EXIT_CODE ? Number(process.env.FAKE_NPM_EXIT_CODE) : 0);
