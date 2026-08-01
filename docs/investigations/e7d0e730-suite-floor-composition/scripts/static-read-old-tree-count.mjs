#!/usr/bin/env node
// Zero-execution baseline-count check for card e7d0e730's "is 607 right" question.
//
// `node scripts/test-daemon.mjs --count` cannot be run against the old commit: that flag did not
// exist at 0387f95a (confirmed by `grep -n "count" scripts/test-daemon.mjs` in that tree returning
// zero matches), and the pre-`--count` script silently ran the FULL SUITE on an unrecognized flag
// (fixed later by commit 14dbc93a) -- running it is how this investigation nearly triggered a real
// full-suite execution on the old tree. Do NOT run the old tree's test-daemon.mjs with any flag.
//
// Instead: import (never execute as CLI -- this is the same safe pattern test/census/* already uses
// to read NOT_HERMETIC without triggering a run) CURRENT's `discoverHermeticTests` and apply it to
// the OLD tree's actual on-disk test/ directory. This answers "how many of the old tree's files
// would be hermetic BY TODAY'S RULES" -- not what the old script itself counted, which is a
// different quantity (today's discovery algorithm changed mid-window: commits 9c4d797d, e09e460d,
// 0e630c15 between 0387f95a and HEAD are not cosmetic, they change what counts as hermetic).
//
// Usage: node static-read-old-tree-count.mjs <path-to-current-test-daemon.mjs> <old-tree-test-dir> <new-tree-test-dir>
import { pathToFileURL } from "node:url";

const [, , currentScriptPath, oldTestDir, newTestDir] = process.argv;
const { discoverHermeticTests } = await import(pathToFileURL(currentScriptPath).href);

const oldResult = discoverHermeticTests(oldTestDir);
const newResult = discoverHermeticTests(newTestDir);

console.log("OLD TREE hermetic count, TODAY'S discovery rules applied retroactively:", oldResult.hermetic.length, "violations:", oldResult.violations.length);
console.log("NEW TREE (HEAD) hermetic count, same rules:", newResult.hermetic.length, "violations:", newResult.violations.length);
