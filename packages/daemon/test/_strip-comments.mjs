// Shared comment-stripper for raw dist/src TEXT scanners (card 36afbbdd). tsconfig never sets
// removeComments, so a compiled `dist/**/*.js` (and every real `src/**/*.ts` reader) carries comments
// VERBATIM — a scanner that pattern-matches that text unstripped can be flipped by a comment-only diff
// that happens to mention the very code shape the scanner is checking FOR or AGAINST (card fab07aba /
// abaaf16e's own incident history). This is the SAME per-line discipline already established
// independently in codescape-supervisor-shutdown-wiring.mjs and exit-code-verdict-guard.mjs (both
// pre-dating this shared extraction) — centralized here so a THIRD/FOURTH copy isn't needed for every
// scanner this card hardens. Those two pre-existing local copies are left as-is (not worth the churn of
// migrating already-working, already-tested files) — see card 36afbbdd's own report for why.
//
// A line inside a `/* ... */` block, or whose trimmed text starts with `//`/`*`, is excluded from the
// output entirely; a trailing `//` comment on an otherwise-real code line is cut, with a `(?<!:)`-shaped
// guard so a URL's `://` is never mistaken for a comment opener.
//
// Card 36afbbdd, manager review round 2 — MEASURED against the real corpus every stripped scanner reads
// (207 src/**/*.ts + 29 dist files, verified via a per-source-line old-vs-new diff, not just synthetic
// fixtures or a per-hit spot check). One real over-strip defect was found AND fixed here:
//   A `//` sitting inside a SAME-LINE `"`/`'` string literal (e.g. `path.startsWith("//")`,
//   `"//" + rest.slice(1)`) was treated as a comment opener, truncating real code after it. Fixed by
//   tracking `"`/`'` quote state character-by-character (with backslash-escape handling) before ever
//   looking for a trailing `//` — a `//` while a quote is open is never a cut point. See (control) below
//   for the negative/positive proof, and CR-preservation note below `stripTrailingLineComment` for a
//   second, narrower fix this same pass needed (a naive `slice` dropped a trailing CRLF `\r`).
//
// ⚠ TWO KNOWN, DELIBERATELY DEFERRED GAPS — both MEASURED, both confirmed NOT to blind any of this card's
// 20 stripped scanners (their specific checked tokens never land on an affected line, in the corpus as
// scanned for card 36afbbdd — see its report for the full per-file count):
//   (a) A `//` formed by a REGEX LITERAL's own delimiters — e.g. `.replace(/\//g, "_")`, where the
//       escaped slash `\/` is immediately followed by the closing `/` — is not distinguished from a real
//       comment opener, because that needs knowing whether a bare `/` is a regex-literal delimiter or a
//       division operator, which needs real lexer/parser context (the same class of problem
//       `computeEmitCompareGate`'s own doc names for its `ts.createScanner` false-start — see
//       docs/decisions/2154b6ad). Found once: `src/connections/oauth.ts`'s `base64url()`.
//   (b) A line inside a MULTI-LINE template literal (e.g. an embedded agent-prompt constant) whose
//       trimmed text starts with `*` (ordinary markdown bold, "**like this**") is dropped whole, exactly
//       like a real `*`-led JSDoc continuation line would be — found twice, in `src/platform/seed.ts` and
//       `src/setup/seed.ts`'s own prompt text. A cross-line backtick-parity tracker was BUILT AND TESTED
//       to fix this, then REVERTED after the SAME diff-based verification that would have missed it on a
//       narrower check caught a regression it introduced: a `` ` `` appearing as an ORDINARY REGEX-LITERAL
//       CHARACTER (not a template-literal delimiter) — e.g. `` src/companion/tts.ts``'s
//       `` /`([^`]+)`/g `` inline-code-span pattern, three literal backticks with no relation to any
//       template literal — throws off simple parity counting exactly like case (a) throws off simple
//       slash counting, and falsely opened a "still inside a template literal" state that then swallowed
//       several real, unrelated trailing `//` comments later in that same file. That failure mode (a real
//       comment silently SURVIVING the strip) is the exact risk category this whole card exists to close,
//       so shipping a fix that trades one narrow, non-blinding gap for a broader, worse-classed one is not
//       a net improvement — reverted rather than kept. Would need the same real lexer/parser distinguishing
//       regex-literal delimiters from string/template delimiters that gap (a) already needs; not attempted
//       here for the same reason.
// NOT a general-purpose JS/TS comment stripper; sufficient for this codebase's own `//`/`/** ` comment
// convention plus same-line strings, which is the population MEASURED to actually matter for the 20
// scanners this card hardens.
export function stripComments(source) {
  const state = { inBlock: false };
  const kept = [];
  for (const raw of source.split("\n")) {
    const trimmed = raw.trim();
    if (state.inBlock) {
      if (trimmed.includes("*/")) state.inBlock = false;
      continue;
    }
    if (trimmed.startsWith("//")) continue;
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) state.inBlock = true;
      continue;
    }
    if (trimmed.startsWith("*")) continue; // JSDoc/block-comment continuation
    kept.push(stripTrailingLineComment(raw));
  }
  return kept.join("\n");
}

/** Scans `raw` character-by-character tracking `"`/`'` quote state (with backslash-escape handling), and
 *  cuts the line at the first `//` that is NOT inside an open quote and NOT preceded by `:` (the URL
 *  guard, e.g. `https://`). Deliberately does NOT track `` ` `` as a quote char — see this file's own
 *  "deliberately deferred gap (b)" doc above for why a backtick can't be treated as a reliable quote
 *  delimiter without a real tokenizer (it collides with backtick used as ordinary regex-literal content). */
function stripTrailingLineComment(raw) {
  let quote = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "/" && raw[i + 1] === "/" && raw[i - 1] !== ":") {
      // Preserve a trailing CR exactly like the OLD `String#replace(/(?<!:)\/\/.*/, "")` implementation
      // did: `.` never matches `\r`/`\n`, so that regex's own match never consumed a trailing `\r` on a
      // CRLF-terminated line — a naive `raw.slice(0, i)` here would silently normalize CRLF -> LF on
      // every line carrying a trailing comment. MEASURED (card 36afbbdd manager review round 2): this
      // exact divergence hit 40+ real src/**/*.ts files before this fix.
      const tail = raw.endsWith("\r") ? "\r" : "";
      return raw.slice(0, i) + tail;
    }
  }
  return raw;
}
