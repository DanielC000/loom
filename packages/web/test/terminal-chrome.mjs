// Regression guard: <TerminalCard> is the SINGLE owner of the per-session terminal "chrome".
//
// WHY THIS EXISTS: we've twice silently dropped a terminal sub-feature when a shared surface was
// refactored — the Composer wasn't under all terminals, and the queued-message display (SessionQueue)
// AND the scheduled-wakes strip (SessionWakes) vanished from the Overview grid because they rode a
// per-page `footer` prop while only the Terminals page passed it. Root cause: per-page customization of
// the shared tile lets pages drift. The fix consolidated all three into the shared terminal card so
// EVERY surface that renders one shows the identical chrome and can't drift. As of the terminal-
// unification epic that shared owner is <TerminalCard> (TerminalTile and the other variants are thin
// bindings over it), so this guard now watches TerminalCard. It fails the build if any of the three is
// removed from the base's body.
//
// It's a lightweight STRUCTURAL check (no React render, no DOM, no deps): it reads the TerminalCard
// source and asserts each component is both imported AND rendered inside the TerminalCard component.
// That's enough to catch the exact regression (a deleted <Composer/> / <SessionQueue/> / <SessionWakes/>),
// and it's cheap+reliable enough to gate every web build (wired into @loom/web's `build` script, so it
// runs on every rebuild — the deploy path — and in CI, which runs `pnpm build`).
//
// Run standalone:  node packages/web/test/terminal-chrome.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const cardSrc = readFileSync(new URL("../src/components/TerminalCard.tsx", import.meta.url), "utf8");

// The chrome that MUST live inside TerminalCard. Each entry asserts both the import and a JSX render.
const CHROME = [
  { name: "Composer", importFrom: "./Composer" },
  { name: "SessionQueue", importFrom: "./SessionQueue" },
  { name: "SessionWakes", importFrom: "./SessionWakes" },
];

// Scope the render assertion to the TerminalCard component (from its declaration to EOF — it's the last
// function in the file), not the whole file, so the guard still catches a refactor that keeps an import
// but moves the render out of the base. The body renders live in TerminalCard's `sessionBody` helper,
// which sits inside the component, so this scope captures them.
const fnIdx = cardSrc.indexOf("export function TerminalCard");
assert.notEqual(fnIdx, -1, "TerminalCard component not found in TerminalCard.tsx — did it get renamed?");
const cardJsx = cardSrc.slice(fnIdx);

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

for (const { name, importFrom } of CHROME) {
  // 1) Imported into the file.
  check(`TerminalCard imports ${name}`, () => {
    const importRe = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*["']${importFrom.replace(/[.]/g, "\\$&")}["']`);
    assert.ok(importRe.test(cardSrc), `${name} is not imported from "${importFrom}" in TerminalCard.tsx`);
  });
  // 2) Rendered as a JSX element inside the base (the `<Name ...>` open tag — the bare word in a
  //    comment won't match, so this only trips on a real render).
  check(`TerminalCard renders <${name}> inside the base`, () => {
    const renderRe = new RegExp(`<${name}[\\s/>]`);
    assert.ok(renderRe.test(cardJsx),
      `<${name}> is not rendered inside TerminalCard — terminal chrome regression: every terminal ` +
      `card must render ${name}. Re-add it to TerminalCard (do NOT push it back onto a per-page prop).`);
  });
}

console.log(`\n${pass} passed — TerminalCard owns Composer + SessionQueue + SessionWakes`);
