// Hermetic unit test for the web-side review-gate diff analysis in src/lib/diff.ts — the pure,
// dependency-free derivation (parseDiff / analyzeDiff, with its risk + area roll-up) behind the
// review/merge gate centerpiece. No daemon, no claude, no fs/db: it imports the TS source directly and
// asserts on plain objects, so it exercises the REAL shipped parser and can't drift from a copy.
//
// Like sessions-order.mjs, the web package has no test runner, so this is a self-contained node script.
// It imports the TS source via Node's type stripping (so run it WITH the flag). Wired into @loom/web's
// `build` script (alongside terminal-chrome.mjs) so it runs on every rebuild — the deploy path — and in
// CI (which runs `pnpm build`). Run it standalone with:
//   node --experimental-strip-types packages/web/test/diff.mjs
import assert from "node:assert/strict";
import { parseDiff, analyzeDiff, hunkLineKind, rawPatchLineKind } from "../src/lib/diff.ts";

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

// A unified-diff patch is just lines; these builders keep the test cases readable.
const patch = (...lines) => lines.join("\n");
// A modified-file block with `n` purely-added lines (churn = n) — for the risk thresholds.
const addedLinesBlock = (path, n) =>
  patch(
    `diff --git a/${path} b/${path}`,
    "index 0000001..0000002 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,0 +1,${n} @@`,
    ...Array.from({ length: n }, (_, i) => `+line ${i}`),
  );
// A modified-file block with one removed + one added line (churn 2, no risk signal of its own).
const oneLineBlock = (path) =>
  patch(
    `diff --git a/${path} b/${path}`,
    "index 0000001..0000002 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1 @@",
    "-old",
    "+new",
  );

// 1) THE REGRESSION (Major #1). A deleted source line `-- drop the index` renders in the patch as
//    `--- drop the index`; an added source line `++ add the col` renders as `+++ add the col`. Before
//    the `!cur` fix BOTH were mis-read as ---/+++ file headers: dropped from cur.lines AND from the ±
//    counts. This case is RED on the pre-fix parser (deletions 0, lines missing the `--- ` line) and
//    GREEN after. It also covers the count guard: the in-hunk classifier must count a `--- `/`+++ `
//    content line, which the old `!startsWith("---"/"+++")` guards wrongly skipped.
check("in-hunk content lines starting with --- / +++ are kept AND counted (RED before !cur fix)", () => {
  const [f] = parseDiff(patch(
    "diff --git a/db/schema.sql b/db/schema.sql",
    "index 0000001..0000002 100644",
    "--- a/db/schema.sql",
    "+++ b/db/schema.sql",
    "@@ -1,3 +1,3 @@",
    " keep this line",
    "--- drop the index", // a deleted `-- drop the index`
    "+++ add the col",     // an added `++ add the col`
  ));
  assert.equal(f.path, "db/schema.sql");
  const hunkLines = f.hunks[0].lines;
  // present in the rendered hunk
  assert.ok(hunkLines.includes("--- drop the index"), "deleted `--- ` content line must be rendered");
  assert.ok(hunkLines.includes("+++ add the col"), "added `+++ ` content line must be rendered");
  assert.ok(hunkLines.includes(" keep this line"), "context line preserved");
  // counted in the ± totals (the bug also dropped these from insertions/deletions)
  assert.equal(f.deletions, 1, "the `--- ` line counts as one deletion");
  assert.equal(f.insertions, 1, "the `+++ ` line counts as one insertion");
});

// A normal deletion/addition still counts exactly once (no double counting after relaxing the guards).
check("a plain -/+ hunk counts deletions and insertions once each", () => {
  const [f] = parseDiff(oneLineBlock("src/util.ts"));
  assert.equal(f.deletions, 1);
  assert.equal(f.insertions, 1);
  assert.equal(f.status, "modified");
});

// 2) Rename — header `rename from`/`rename to` → status "renamed", oldPath set, path = new path.
check("a rename yields status renamed with old + new path", () => {
  const [f] = parseDiff(patch(
    "diff --git a/src/old.ts b/src/new.ts",
    "similarity index 96%",
    "rename from src/old.ts",
    "rename to src/new.ts",
  ));
  assert.equal(f.status, "renamed");
  assert.equal(f.path, "src/new.ts");
  assert.equal(f.oldPath, "src/old.ts");
  assert.ok(f.reasons.includes("file renamed / moved"));
  assert.equal(f.risk, "medium"); // rename bumps to medium
});

// 3) Binary file — flagged, no line counts.
check("a binary file is flagged with zero line counts", () => {
  const [f] = parseDiff(patch(
    "diff --git a/logo.png b/logo.png",
    "index aaaaaaa..bbbbbbb 100644",
    "Binary files a/logo.png and b/logo.png differ",
  ));
  assert.equal(f.binary, true);
  assert.equal(f.insertions, 0);
  assert.equal(f.deletions, 0);
});

// 4) /dev/null add and delete — the add counts insertions; the delete counts deletions and is high risk.
check("a /dev/null add is status added; a /dev/null delete is status deleted + high risk", () => {
  const [add] = parseDiff(patch(
    "diff --git a/src/new.ts b/src/new.ts",
    "new file mode 100644",
    "index 0000000..abcdef0",
    "--- /dev/null",
    "+++ b/src/new.ts",
    "@@ -0,0 +1,2 @@",
    "+line one",
    "+line two",
  ));
  assert.equal(add.status, "added");
  assert.equal(add.path, "src/new.ts");
  assert.equal(add.insertions, 2);
  assert.equal(add.deletions, 0);

  const [del] = parseDiff(patch(
    "diff --git a/src/gone.ts b/src/gone.ts",
    "deleted file mode 100644",
    "index abcdef0..0000000",
    "--- a/src/gone.ts",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-line one",
    "-line two",
  ));
  assert.equal(del.status, "deleted");
  assert.equal(del.path, "src/gone.ts");
  assert.equal(del.deletions, 2);
  assert.equal(del.risk, "high"); // a delete is always high
  assert.ok(del.reasons.includes("file deleted"));
});

// 5) Churn → risk thresholds: ≥80 medium, ≥200 high (on a path with no other risk signal).
check("churn thresholds: 79 low, 80 medium, 200 high", () => {
  assert.equal(parseDiff(addedLinesBlock("src/plain.ts", 79))[0].risk, "low");
  const med = parseDiff(addedLinesBlock("src/plain.ts", 80))[0];
  assert.equal(med.risk, "medium");
  assert.ok(med.reasons.includes("sizeable change (80 lines)"));
  const hi = parseDiff(addedLinesBlock("src/plain.ts", 200))[0];
  assert.equal(hi.risk, "high");
  assert.ok(hi.reasons.includes("large change (200 lines)"));
});

// 6) Load-bearing-path SIGNALS → high (independent of churn).
check("load-bearing paths (pty/host, gateway/server, lockfile, migration) are high risk", () => {
  const high = (path, reasonFragment) => {
    const [f] = parseDiff(oneLineBlock(path));
    assert.equal(f.risk, "high", `${path} should be high risk`);
    if (reasonFragment) assert.ok(f.reasons.some((r) => r.includes(reasonFragment)), `${path} reason`);
  };
  high("packages/daemon/src/pty/host.ts", "load-bearing");
  high("packages/daemon/src/gateway/server.ts", "load-bearing");
  high("pnpm-lock.yaml", "dependency lockfile");
  high("packages/daemon/src/db/migrations/0001_init.sql", "schema / migration");
  high("packages/daemon/src/mcp/platform.ts", "MCP trust-boundary");
});

// 7) areaOf roll-up (via analyzeDiff.areas): packages/daemon/src/<sub>/… → daemon/<sub>; a file directly
//    under daemon/src → daemon; packages/<pkg>/… → <pkg>; a repo-root file → (root).
check("areaOf rolls daemon subsystems up to daemon/<sub> and packages up to <pkg>", () => {
  const a = analyzeDiff(patch(
    oneLineBlock("packages/daemon/src/pty/host.ts"),
    oneLineBlock("packages/daemon/src/db.ts"),
    oneLineBlock("packages/web/src/lib/diff.ts"),
    oneLineBlock("README.md"),
  ));
  const areas = new Set(a.areas.map((x) => x.area));
  assert.ok(areas.has("daemon/pty"), "daemon/src/pty/host.ts → daemon/pty");
  assert.ok(areas.has("daemon"), "daemon/src/db.ts (directly under src) → daemon");
  assert.ok(areas.has("web"), "packages/web/... → web");
  assert.ok(areas.has("(root)"), "README.md → (root)");
  assert.equal(a.files.length, 4);
});

// 8) Empty / malformed patches → [] (the parser is defensive, never throws).
check("empty and non-diff patches yield no files", () => {
  assert.deepEqual(parseDiff(""), []);
  assert.deepEqual(parseDiff("   \n  "), []);
  assert.deepEqual(parseDiff("not a diff at all"), []);
  assert.equal(analyzeDiff("").headline, "No file changes vs main.");
});

// 9) THE RENDER REGRESSION (Major #2 — the render twin of #1). The merge-gate per-file diff (FileHunks)
//    colors each hunk CONTENT line via hunkLineKind (→ Diff.tsx KIND_COLOR: del=red, add=green, meta=
//    muted gray). parseDiff strips the real `+++ b/`/`--- a/` file headers, so a deleted line whose
//    CONTENT starts with `---`/`--`/`+++` (a markdown thematic break, a YAML front-matter delimiter, a
//    SQL/CLI `-- comment`) arrives as a content line like `----`/`--- x`/`+++x`. The OLD shared lineColor
//    classified those as the muted "meta" file-header gray → a deletion read as unchanged context, so a
//    human approver could overlook a removed line. hunkLineKind keys on the FIRST CHAR ONLY and has NO
//    meta case, so they classify as del/add (→ red/green). This asserts the kind a human's color follows.
check("hunkLineKind: deleted ---/-- and added +++ content lines are del/add, never the muted meta header", () => {
  // The exact hunk content lines a parsed merge-gate diff would feed FileHunks (no real file headers).
  const [f] = parseDiff(patch(
    "diff --git a/notes.md b/notes.md",
    "index 0000001..0000002 100644",
    "--- a/notes.md",
    "+++ b/notes.md",
    "@@ -1,4 +1,2 @@",
    " intro paragraph",
    "----",                     // a deleted markdown thematic break `---`
    "--- a YAML/CLI delimiter", // a deleted `-- a YAML/CLI delimiter`
    "+++added section",         // an added `++added section`
  ));
  const byContent = Object.fromEntries(f.hunks[0].lines.map((ln) => [ln, hunkLineKind(ln)]));
  assert.equal(byContent["----"], "del", "deleted `---` (rendered ----) is a deletion → RED");
  assert.equal(byContent["--- a YAML/CLI delimiter"], "del", "deleted `-- …` (rendered --- …) is a deletion → RED");
  assert.equal(byContent["+++added section"], "add", "added `++…` (rendered +++…) is an addition → GREEN");
  assert.equal(byContent[" intro paragraph"], "context", "context line stays dim");
  // critically, NONE of the changed lines is classified as the muted meta header (the bug)
  for (const ln of ["----", "--- a YAML/CLI delimiter", "+++added section"]) {
    assert.notEqual(byContent[ln], "meta", `${JSON.stringify(ln)} must not be muted header gray`);
  }
});

// hunkLineKind classifies a plain hunk by first char: + add, - del, @@ hunk, context.
check("hunkLineKind classifies a plain hunk by first char (no meta case)", () => {
  assert.equal(hunkLineKind("+new"), "add");
  assert.equal(hunkLineKind("-old"), "del");
  assert.equal(hunkLineKind("@@ -1 +1 @@"), "hunk");
  assert.equal(hunkLineKind(" context"), "context");
});

// 10) DiffView's raw whole-patch classifier (rawPatchLineKind) STILL marks a real `+++ b/`/`--- a/` (and
//     `diff `/`index `) file header as "meta" (→ dimmed) — the header-dimming variant kept ONLY for the
//     raw render. This is the opposite need to hunkLineKind and must not regress in the split.
check("rawPatchLineKind marks real file headers as meta in the raw whole-patch render", () => {
  assert.equal(rawPatchLineKind("+++ b/src/file.ts"), "meta", "+++ b/ header is meta");
  assert.equal(rawPatchLineKind("--- a/src/file.ts"), "meta", "--- a/ header is meta");
  assert.equal(rawPatchLineKind("diff --git a/x b/x"), "meta", "diff --git header is meta");
  assert.equal(rawPatchLineKind("index 0000001..0000002 100644"), "meta", "index header is meta");
  // but real +/- content and the hunk header still classify normally
  assert.equal(rawPatchLineKind("@@ -1 +1 @@"), "hunk");
  assert.equal(rawPatchLineKind("+added"), "add");
  assert.equal(rawPatchLineKind("-removed"), "del");
});

console.log(`\n${pass} passed`);
