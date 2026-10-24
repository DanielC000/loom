// Hermetic unit test for card 260fb29a — a deep-link query surviving a legacy redirect, and only a
// VISIBLE board consuming `?task=`.
//
// Two sections, because the two halves of the card are provable at two different levels:
//   (1) THE MERGE RULE is a pure function (`lib/redirectQuery.ts`), so it is imported and exercised
//       directly — every collision/multi-value/empty case, which an e2e can only reach one URL at a
//       time.
//   (2) THE WIRING is source text. A behaviourally perfect rewrite that drops one of these call sites
//       would leave the merge function correct and unreachable, and the e2e legs that WOULD catch it
//       cost a daemon + a browser. Same idiom (and same reason) as test/platform-edition.mjs.
//
// ⚠️ SCOPE, stated up front: section 2 proves a literal is PRESENT, never that it behaves. The
// behaviour is proved by packages/web/e2e/atlas-deep-links.spec.ts and
// packages/web/e2e/atlas-legacy-redirects.spec.ts — in particular the `deepLinks` gate's own
// discriminating leg, which needs a WARM board cache and so cannot be expressed here at all. Neither
// test substitutes for the other.
//
// The web package has no test runner, so this is a self-contained node script importing the pure
// module directly (only `import type` is stripped), mirroring test/profile-grant-reach.mjs. Run it:
//   node --experimental-strip-types packages/web/test/deep-link-query.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mergeRedirectQuery } from "../src/lib/redirectQuery.ts";

let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  console.log(`  ok  ${name}`);
}

// ── 1. The merge rule ───────────────────────────────────────────────────────────────────────────
console.log("§1 mergeRedirectQuery");

check("an incoming query rides through to a target that pins nothing", () => {
  assert.equal(
    mergeRedirectQuery("/actors", "?profile=p1&grant=c1"),
    "/actors?profile=p1&grant=c1",
  );
});

check("no incoming query leaves the target byte-identical", () => {
  // The pre-card behaviour for every link that carries nothing — which is most of them — so this is
  // the "changed nothing it should not have" case.
  assert.equal(mergeRedirectQuery("/platform", ""), "/platform");
  assert.equal(mergeRedirectQuery("/actors?tab=skills", ""), "/actors?tab=skills");
});

check("a target's own ?tab= survives alongside a carried query", () => {
  assert.equal(
    mergeRedirectQuery("/actors?tab=skills", "?profile=p1"),
    "/actors?profile=p1&tab=skills",
  );
});

check("ON A COLLISION THE TARGET WINS — an incoming tab= cannot re-point the redirect", () => {
  // The rule this card decided. `/skills` means "the Skills tab of /actors", so a stale incoming
  // `tab=` must never choose the tab the row lands on.
  const out = mergeRedirectQuery("/actors?tab=skills", "?tab=profiles&keep=1");
  assert.equal(out, "/actors?keep=1&tab=skills");
  assert.ok(!out.includes("profiles"), `the incoming tab survived: ${out}`);
});

check("the collision is resolved WHOLE — a repeated incoming key leaves no leftover value", () => {
  // `set` would have collapsed this to one value and could leave an incoming one standing beside the
  // target's; delete-then-append is what makes the target's value the ONLY one for that key.
  const out = mergeRedirectQuery("/actors?tab=skills", "?tab=profiles&tab=agents");
  assert.equal(out, "/actors?tab=skills");
});

check("a target declaring a key twice keeps BOTH of its values", () => {
  // The other direction of the same rule: the target's values are kept in full, not collapsed.
  assert.equal(
    mergeRedirectQuery("/actors?tab=skills&tab=extra", "?tab=incoming"),
    "/actors?tab=skills&tab=extra",
  );
});

check("a repeated incoming key the target does not declare is preserved in full", () => {
  assert.equal(mergeRedirectQuery("/actors", "?x=1&x=2"), "/actors?x=1&x=2");
});

check("values are re-encoded rather than concatenated raw", () => {
  // A task/profile id is URL-encoded by the caller; round-tripping it through URLSearchParams must not
  // corrupt a value containing a reserved character.
  const out = mergeRedirectQuery("/actors", "?q=a%20b%26c");
  assert.equal(new URL(out, "http://x").searchParams.get("q"), "a b&c");
});

check("a bare `?` on either side yields no stray question mark", () => {
  assert.equal(mergeRedirectQuery("/actors", "?"), "/actors");
  assert.equal(mergeRedirectQuery("/actors?", ""), "/actors");
});

// ── 2. The wiring ───────────────────────────────────────────────────────────────────────────────
console.log("§2 wiring (source text — presence only; see the scope note above)");

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const navSrc = read("../src/nav.tsx");
const shellSrc = read("../src/components/AtlasShell.tsx");
const boardSrc = read("../src/pages/Board.tsx");
const platformSrc = read("../src/pages/PlatformView.tsx");

// POSITIVE CONTROLS on the four reads, before any claim rests on them. A `readFileSync` that resolved
// the wrong file, or a file that had been renamed out from under this test, returns a string in which
// every `includes` below is simply false — which reads exactly like a real regression.
check("positive control: all four sources were really read", () => {
  assert.ok(navSrc.includes("export const LEGACY_REDIRECTS"), "nav.tsx is not the file that was read");
  assert.ok(shellSrc.includes("ATLAS_RETIREMENTS") || shellSrc.includes("atlasRetirementFor"),
    "AtlasShell.tsx is not the file that was read");
  assert.ok(boardSrc.includes("export default function Board"), "Board.tsx is not the file that was read");
  assert.ok(platformSrc.includes("AtlasPlatformLayout"), "PlatformView.tsx is not the file that was read");
});

check("every LEGACY_REDIRECTS row goes through QueryPreservingRedirect, and none through a bare Navigate", () => {
  // `redirect()` is the ONE factory every row uses, so pinning its body covers all of them without
  // this test holding a copy of the row list (which would go stale the day a ninth is declared).
  assert.match(navSrc, /function redirect\([^)]*\)[^{]*\{\s*return \{ from, to, element: <QueryPreservingRedirect to=\{to\} \/> \};/,
    "redirect() no longer builds a QueryPreservingRedirect");
  assert.ok(!/element: <Navigate to=\{to\} replace \/>/.test(navSrc),
    "nav.tsx is back to a bare <Navigate> for a redirect row, which drops the incoming query");
  assert.ok(navSrc.includes("mergeRedirectQuery(to, search)"),
    "QueryPreservingRedirect no longer merges the incoming search through the shared rule");
});

check("the Atlas retirement hop preserves the query too", () => {
  // One declared row chains THROUGH a retirement (/workspace → /projects → /home), so a bare
  // <Navigate> here would make that row preserve under the classic shell and drop under Atlas.
  assert.ok(shellSrc.includes("<QueryPreservingRedirect to={retired.to} />"),
    "the retirement hop no longer preserves the incoming query");
  assert.ok(!/<Navigate to=\{retired\.to\} replace \/>/.test(shellSrc),
    "the retirement hop is back to a bare <Navigate>, which drops the query the first hop carried");
});

check("Board's deep-link effect is gated on deepLinks, and deepLinks is in its dep array", () => {
  // Both halves matter: a gate with the flag missing from the deps would latch whichever value the
  // effect first saw, so a panel becoming visible would never start consuming.
  assert.match(boardSrc, /if \(!deepLinks \|\| !taskParam \|\| !board\.data\) return;/,
    "Board's ?task= effect is no longer gated on deepLinks — a hidden panel can eat the deep link again");
  assert.match(boardSrc, /\}, \[deepLinks, taskParam, board\.data, setSearchParams\]\);/,
    "deepLinks is missing from the deep-link effect's dependency array");
  assert.match(boardSrc, /deepLinks = true/,
    "deepLinks no longer defaults to true, so every other Board mount silently stops consuming ?task=");
});

check("the Atlas Platform board panel passes deepLinks, and only while it is the visible tab", () => {
  assert.ok(platformSrc.includes('deepLinks={tab === "board"}'),
    "the Platform node's board panel no longer gates its deep-link consumption on being visible");
  // The CLASSIC layout's own mount must NOT pass it: there every section is visible at once, and a
  // `false` there would kill a deep link that has always worked.
  const classicMount = platformSrc.match(/<PlatformBoardSection edition=\{edition\} project=\{project\} \/>/g) ?? [];
  assert.equal(classicMount.length, 1,
    `expected exactly one ungated (classic-layout) PlatformBoardSection mount, found ${classicMount.length}`);
});

check("the Platform node normalizes the ADDRESS onto tab=board, rather than deriving the tab", () => {
  // A derived tab re-hides the dialog the moment Board clears the param it consumed, so the rewrite
  // is the load-bearing half. Pinned as: the normalized target is built with tab=board, and it is
  // handed to a real <Navigate replace>.
  assert.match(platformSrc, /new URLSearchParams\(\[\["tab", "board"\]\]\)/,
    "the ?task= normalization no longer pins tab=board");
  assert.match(platformSrc, /normalized = `\/platform\?\$\{next\.toString\(\)\}`/,
    "the normalization no longer rewrites the /platform address");
  assert.match(platformSrc, /\{normalized && <Navigate to=\{normalized\} replace \/>\}/,
    "the normalization is no longer applied through a <Navigate replace>");
  // It must sit BESIDE the panels, never instead of them: returning it alone unmounts all five and
  // destroys whatever unfinished input they hold.
  const navigateAt = platformSrc.indexOf("{normalized && <Navigate");
  const panelsAt = platformSrc.indexOf("<Panels tab={tab}>");
  assert.ok(navigateAt > 0 && panelsAt > navigateAt,
    "the normalization <Navigate> no longer renders beside (and before) the still-mounted panels");
});

check("the normalization fires only when a ?task= needs a tab it is not already on", () => {
  assert.match(platformSrc, /if \(taskParam && tab !== "board"\)/,
    "the normalization condition changed — it must not fire on the Board tab (a loop) or without a ?task=");
});

console.log(`\nAll ${checks} check(s) passed`);
