#!/usr/bin/env node
// Card e7d6e43b, Code Review Minor: this script exists ONLY to prove `--ignore-scripts` actually
// suppresses it. It must NEVER run when the fixture is installed with --ignore-scripts (the production
// npm-pinned path); the real-spawn test's positive control installs the SAME tarball WITHOUT
// --ignore-scripts and asserts this sentinel IS written there, proving the script is genuinely capable
// of writing it (so a clean "no sentinel" result under --ignore-scripts is meaningful, not vacuous).
const fs = require("fs");
const path = require("path");
fs.writeFileSync(path.join(__dirname, "..", "POSTINSTALL_SENTINEL.txt"), "postinstall ran\n");
