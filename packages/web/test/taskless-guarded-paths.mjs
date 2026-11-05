// Hermetic unit test for src/lib/tasklessGuardedPaths.ts (card 7e15ff89): the textarea → list shaping behind the
// Settings "Taskless guarded paths" editor. Pins that blank lines and surrounding whitespace are dropped, that the
// shared parser's errors come back pointing at the line the human typed, that the editor refuses nothing the daemon
// accepts, and that an empty list unsets the key instead of writing [].
//   node --experimental-strip-types packages/web/test/taskless-guarded-paths.mjs
import assert from "node:assert/strict";
import {
  TASKLESS_GUARDED_PATHS_KEY, TASKLESS_GUARDED_PATHS_LIMITS, draftLines, guardedPathsConfigWrite, guardedPathsFromText,
  guardedPathsSeed, guardedPathsSignature,
} from "../src/lib/tasklessGuardedPaths.ts";

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

check("trims each line, drops blank lines, keeps order and duplicates", () => {
  assert.deepEqual(guardedPathsFromText("  docs/**  \r\n\n\t\n*.lock\ndocs/**\n"), { ok: true, paths: ["docs/**", "*.lock", "docs/**"] });
});

check("an empty or whitespace-only textarea is a valid empty list", () => {
  assert.deepEqual(guardedPathsFromText(""), { ok: true, paths: [] });
  assert.deepEqual(guardedPathsFromText(" \n \n"), { ok: true, paths: [] });
});

check("an error names the TYPED line, counting the blank lines dropped above it", () => {
  const r = guardedPathsFromText("docs/**\n\n\n/abs/path\n");
  assert.equal(r.ok, false);
  assert.equal(r.error, 'Line 4: must be repo-relative (no leading "/")');
  assert.match(guardedPathsFromText("a\\b").error, /^Line 1: must use forward slashes$/);
  assert.match(guardedPathsFromText("x\n\nsrc/../y").error, /^Line 3: must not contain a "\.\." segment$/);
  assert.match(guardedPathsFromText("a".repeat(TASKLESS_GUARDED_PATHS_LIMITS.maxEntryLen + 1)).error, /^Line 1: is longer than/);
});

check("the entry cap is enforced and stated in the editor's own words", () => {
  const max = TASKLESS_GUARDED_PATHS_LIMITS.maxEntries;
  assert.equal(guardedPathsFromText(Array.from({ length: max }, (_, i) => `p${i}/**`).join("\n")).ok, true);
  const over = guardedPathsFromText(Array.from({ length: max + 1 }, (_, i) => `p${i}/**`).join("\n"));
  assert.deepEqual(over, { ok: false, error: `${max + 1} paths; the limit is ${max}` });
});

check("nothing the daemon accepts is refused here (dots in names, ?, mid-path **, case)", () => {
  for (const g of ["a..b/c", ".github/**", "src/?.ts", "packages/**/test/*.mjs", "DOCS/**", "./x"]) {
    assert.deepEqual(guardedPathsFromText(g), { ok: true, paths: [g] }, g);
  }
});

check("seed: stored list → one per line; absent → empty; corrupt → empty + the parser's reason", () => {
  assert.deepEqual(guardedPathsSeed(["a/**", "*.lock"]), { text: "a/**\n*.lock", error: null });
  assert.deepEqual(guardedPathsSeed(undefined), { text: "", error: null });
  const bad = guardedPathsSeed("docs/**");
  assert.equal(bad.text, "");
  assert.match(bad.error, /must be an array/);
});

check("dirty compares the normalized lines, so whitespace-only edits are not a change", () => {
  assert.equal(guardedPathsSignature(draftLines("a/**\n*.lock")), guardedPathsSignature(draftLines("  a/**\n\n*.lock  \n")));
  assert.notEqual(guardedPathsSignature(draftLines("a/**")), guardedPathsSignature(draftLines("A/**")));
});

check("config write: a list is written whole, an empty list unsets the key", () => {
  assert.deepEqual(guardedPathsConfigWrite(["a/**"]), { override: { orchestration: { tasklessGuardedPaths: ["a/**"] } }, unset: undefined });
  assert.deepEqual(guardedPathsConfigWrite([]), { override: {}, unset: [TASKLESS_GUARDED_PATHS_KEY] });
  assert.equal(TASKLESS_GUARDED_PATHS_KEY, "orchestration.tasklessGuardedPaths");
});

console.log(`\n${pass} checks passed`);
