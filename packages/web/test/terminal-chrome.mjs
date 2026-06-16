// Regression guard: TerminalTile is the SINGLE owner of the per-session terminal "chrome".
//
// WHY THIS EXISTS: we've twice silently dropped a terminal sub-feature when a shared surface was
// refactored — the Composer wasn't under all terminals, and the queued-message display (SessionQueue)
// AND the scheduled-wakes strip (SessionWakes) vanished from the Overview grid because they rode a
// per-page `footer` prop while only the Terminals page passed it. Root cause: per-page customization
// of the shared TerminalTile lets pages drift. The fix consolidated all three INTO TerminalTile so
// EVERY surface that renders a tile (the Overview grid AND the Terminals grid) shows the identical
// chrome and can't drift. This guard fails the build if any of the three is removed from the tile.
//
// It's a lightweight STRUCTURAL check (no React render, no DOM, no deps): it reads the TerminalTile
// source and asserts each component is both imported AND rendered inside the TerminalTile JSX. That's
// enough to catch the exact regression (a deleted <Composer/> / <SessionQueue/> / <SessionWakes/>),
// and it's cheap+reliable enough to gate every web build (wired into @loom/web's `build` script, so it
// runs on every rebuild — the deploy path — and in CI, which runs `pnpm build`).
//
// Run standalone:  node packages/web/test/terminal-chrome.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const tileSrc = readFileSync(new URL("../src/components/TerminalTile.tsx", import.meta.url), "utf8");

// The chrome that MUST live inside TerminalTile. Each entry asserts both the import and a JSX render.
const CHROME = [
  { name: "Composer", importFrom: "./Composer" },
  { name: "SessionQueue", importFrom: "./SessionQueue" },
  { name: "SessionWakes", importFrom: "./SessionWakes" },
];

// Scope the render assertion to TerminalTile's JSX (its `return (...)`), not the whole file, so the
// guard still catches a refactor that keeps an import but moves the render out of the tile.
const fnIdx = tileSrc.indexOf("export function TerminalTile");
assert.notEqual(fnIdx, -1, "TerminalTile component not found in TerminalTile.tsx — did it get renamed?");
const returnIdx = tileSrc.indexOf("return (", fnIdx);
assert.notEqual(returnIdx, -1, "TerminalTile has no `return (` JSX block — guard can't verify its chrome.");
const tileJsx = tileSrc.slice(returnIdx);

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

for (const { name, importFrom } of CHROME) {
  // 1) Imported into the file.
  check(`TerminalTile imports ${name}`, () => {
    const importRe = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*["']${importFrom.replace(/[.]/g, "\\$&")}["']`);
    assert.ok(importRe.test(tileSrc), `${name} is not imported from "${importFrom}" in TerminalTile.tsx`);
  });
  // 2) Rendered as a JSX element inside the tile (the `<Name ...>` open tag — the bare word in a
  //    comment won't match, so this only trips on a real render).
  check(`TerminalTile renders <${name}> inside the tile`, () => {
    const renderRe = new RegExp(`<${name}[\\s/>]`);
    assert.ok(renderRe.test(tileJsx),
      `<${name}> is not rendered inside TerminalTile — terminal chrome regression: every terminal ` +
      `tile must render ${name}. Re-add it to TerminalTile (do NOT push it back onto a per-page prop).`);
  });
}

console.log(`\n${pass} passed — TerminalTile owns Composer + SessionQueue + SessionWakes`);
