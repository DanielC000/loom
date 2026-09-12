import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — pure fs below, no daemon/Db used
// EMIT-COMPARE SOUNDNESS EMPTY-SCOPE GUARD (card bafc68e7, Code Review F2). `emitCompareSoundnessOk`
// (packages/daemon/src/emit-compare-soundness.ts) is a fail-closed-on-error function EVERYWHERE ELSE —
// every read/parse failure returns `false`. But `EmitCompareSoundnessScope`'s two fields are plain
// `string[]`, and TypeScript's type system does not distinguish "a real list of paths" from "an empty
// list" — an empty `tsconfigRelPaths`/`srcDirRelPaths` scans NOTHING and, before this card's fix, returned
// `true` ("sound") purely because an empty `for` loop and an empty `.filter()`-equivalent walk both
// trivially "found no violation." That is a fail-OPEN on the one input shape the type system cannot rule
// out — the exact class of defect this whole module exists to close (see `@decision 2154b6ad`'s own
// module doc). This is an INTEGRATION test against the REAL, BUILT `emitCompareSoundnessOk` (via
// `dist/emit-compare-soundness.js`), not a structural re-derivation — the property under test is the
// production function's OWN input-validation behavior, not its regex/walk logic (which
// `emit-compare-soundness-guard.mjs` already re-derives independently).
//
// Run: pnpm --filter @loom/daemon build && node packages/daemon/test/emit-compare-soundness-empty-scope-guard.mjs
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const daemonDist = path.join(__dirname, "..", "dist", "emit-compare-soundness.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { emitCompareSoundnessOk } = await import(pathToFileURL(daemonDist).href);

const REAL_TSCONFIGS = ["tsconfig.base.json", path.join("packages", "daemon", "tsconfig.json")];
const REAL_SRC_DIRS = [path.join("packages", "daemon", "src")];

// ── sanity: the real scope, with BOTH arrays populated, still reads sound today (control isn't vacuous —
//    if this were false, every check below would be uninterpretable) ───────────────────────────────────
check(
  "(sanity) the real daemon-only scope, fully populated, reads SOUND today",
  emitCompareSoundnessOk(repoRoot, { tsconfigRelPaths: REAL_TSCONFIGS, srcDirRelPaths: REAL_SRC_DIRS }) === true,
);

// ── THE FIX — each of the three "something is empty" shapes must fail CLOSED, not read as vacuously sound
check(
  "(A) BOTH arrays empty fails CLOSED (false), not vacuously sound",
  emitCompareSoundnessOk(repoRoot, { tsconfigRelPaths: [], srcDirRelPaths: [] }) === false,
);
check(
  "(B) tsconfigRelPaths empty (srcDirRelPaths real) fails CLOSED — an empty tsconfig list skips the emitDecoratorMetadata check entirely",
  emitCompareSoundnessOk(repoRoot, { tsconfigRelPaths: [], srcDirRelPaths: REAL_SRC_DIRS }) === false,
);
check(
  "(C) srcDirRelPaths empty (tsconfigRelPaths real) fails CLOSED — an empty src-dir list skips the const-enum walk entirely",
  emitCompareSoundnessOk(repoRoot, { tsconfigRelPaths: REAL_TSCONFIGS, srcDirRelPaths: [] }) === false,
);

console.log(failures === 0
  ? "\n✅ ALL PASS — emitCompareSoundnessOk reads SOUND on a real, fully-populated scope, and fails CLOSED (never vacuously sound) on every shape of an empty scope array — the one input the type system alone cannot rule out."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
