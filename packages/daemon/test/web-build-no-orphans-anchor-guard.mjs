import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no Db/daemon used below, pure fs read
// REGRESSION GUARD (card db36d7a4) — web-build-no-orphans.mjs is NOT_HERMETIC (see test-daemon.mjs's
// denylist): it mutates the REAL packages/web/src/main.tsx and runs 2-3 real builds, so it is never run
// by the normal gate. That left its anchor regex free to silently go stale for over a week (commit
// 53b81688, 2026-09-24 refactored the line it matched) with nothing to notice — the first anyone found
// out was a worker manually running it by hand.
//
// THIS file is the cheap, hermetic, always-gated proxy: it duplicates ONLY the anchor regex (deliberately
// never imports web-build-no-orphans.mjs itself — importing an ESM module executes its top-level code,
// which for that file means its real git-status check and build side effects) and asserts the anchor
// still matches the real main.tsx on disk. A future refactor that breaks the anchor is now caught on the
// very next merge gate instead of rotting invisibly until someone remembers to run the manual test.
//
// Keep this regex identical to web-build-no-orphans.mjs's own ANCHOR_LINE — if you change one, change
// both (and the matching marker comment in packages/web/src/main.tsx).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAIN_TSX = path.join(__dirname, "..", "..", "web", "src", "main.tsx");
const ANCHOR_LINE = /__loomBuildVerify = "[^"]*"/;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const source = fs.readFileSync(MAIN_TSX, "utf8");
check("web-build-no-orphans.mjs's anchor is present in the real main.tsx", ANCHOR_LINE.test(source));

// Negative control — proves the check above isn't vacuously true because the regex matches everything.
check("the same anchor regex correctly does NOT match content lacking it", !ANCHOR_LINE.test("export const unrelated = 1;\n"));

console.log(failures === 0
  ? "\n✅ ALL PASS — web-build-no-orphans.mjs's anchor still matches the real main.tsx."
  : `\n❌ ${failures} FAILURE(S) — web-build-no-orphans.mjs's anchor has gone stale; update it and its twin here.`);
process.exit(failures === 0 ? 0 : 1);
