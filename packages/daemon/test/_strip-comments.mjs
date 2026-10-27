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
//   (c) Card 2c215ede: a `/*` formed the SAME way gap (a)'s `//` is — a regex literal's own content, e.g.
//       an escaped slash immediately followed by a `*` quantifier (`/\/*$/`, `/a\/*b/`) — used to be
//       misread as an unclosed mid-line comment opener, catastrophically dropping the REST OF THE FILE
//       (no specimen in the corpus, but reproduced directly). That SHAPE is now mitigated (a `/*` whose
//       `/` is immediately preceded by `\` is never treated as a comment opener), but a `/*` arising from
//       an UNESCAPED `/` adjacent to `*` inside a character class (e.g. `/[/*]/`, valid JS — no escaping
//       needed inside `[...]`) is still not distinguished from a real comment opener, and remains the
//       same catastrophic-swallow risk — no current specimen in the corpus either (checked by hand,
//       card 2c215ede). Would need the same real lexer/parser context gap (a) already needs; not
//       attempted, for the same reason — see (8)/(9) below for the pinned proof of both the mitigated and
//       the still-open shape.
// NOT a general-purpose JS/TS comment stripper; sufficient for this codebase's own `//`/`/** ` comment
// convention plus same-line strings, which is the population MEASURED to actually matter for the 20
// scanners this card hardens.
//
// @decision 2c215ede — never revert `stripLineComments`'s per-line (never cross-line) `inTemplate`
// backtick toggle without re-running the full before/after real-corpus diff: it closes a real
// catastrophic-swallow regression (a `/**` glob inside a backtick template read as an unclosed comment).
export function stripComments(source) {
  const state = { inBlock: false, midlineBlock: false };
  const kept = [];
  for (const raw of source.split("\n")) {
    const trimmed = raw.trim();
    if (state.inBlock) {
      if (trimmed.includes("*/")) state.inBlock = false;
      continue;
    }
    if (state.midlineBlock) {
      // Continuing a mid-line block comment that didn't close on the line it opened on.
      const closeIdx = raw.indexOf("*/");
      if (closeIdx === -1) continue; // still inside the comment; drop the whole line
      state.midlineBlock = false;
      kept.push(stripLineComments(raw.slice(closeIdx + 2), state));
      continue;
    }
    if (trimmed.startsWith("//")) continue;
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) state.inBlock = true;
      continue;
    }
    if (trimmed.startsWith("*")) continue; // JSDoc/block-comment continuation
    kept.push(stripLineComments(raw, state));
  }
  return kept.join("\n");
}

/** Scans `raw` character-by-character tracking `"`/`'` quote state (with backslash-escape handling),
 *  removing every mid-line `/* ... *\/` span that is NOT inside an open quote AND NOT inside a backtick
 *  template literal (see this file's own card 2c215ede doc above for why a `/**` glob inside a template,
 *  e.g. `` `Edit(${glob}/**)` ``, must never be read as an unclosed comment opener), then cuts the
 *  remainder at the first `//` that is NOT inside an open `"`/`'` quote and NOT preceded by `:` (the URL
 *  guard, e.g. `https://`) — that trailing-`//` check is UNCHANGED from before this card and does NOT
 *  consider backtick at all, exactly like the pre-existing "deliberately deferred gap (b)" this file's own
 *  header names. `inTemplate` is a PER-LINE backtick-parity toggle, reset to `false` at the start of every
 *  call (one call per physical line) — it can only ever misjudge content on the SAME line it occurs on,
 *  never a later one, which is what makes it safe where gap (b)'s own CROSS-LINE backtick tracker was not
 *  (see this file's header doc for that history). `state.midlineBlock` is set (and `raw` truncated at the
 *  opener) when a mid-line `/*`, found OUTSIDE a template, has no closing `*\/` before EOL — the caller's
 *  outer loop carries that into the next line(s). */
function stripLineComments(raw, state) {
  let quote = null;
  let inTemplate = false;
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (quote) {
      if (c === "\\") { out += raw.slice(i, i + 2); i += 2; continue; }
      if (c === quote) quote = null;
      out += c; i++; continue;
    }
    if (inTemplate) {
      if (c === "\\") { out += raw.slice(i, i + 2); i += 2; continue; }
      if (c === "`") inTemplate = false;
      out += c; i++; continue;
    }
    if (c === "`") { inTemplate = true; out += c; i++; continue; }
    if (c === '"' || c === "'") { quote = c; out += c; i++; continue; }
    if (c === "/" && raw[i + 1] === "*" && raw[i - 1] !== "\\") {
      const closeIdx = raw.indexOf("*/", i + 2);
      if (closeIdx === -1) { state.midlineBlock = true; return out; }
      i = closeIdx + 2; // drop the whole mid-line comment span; keep scanning after it
      continue;
    }
    if (c === "/" && raw[i + 1] === "/" && raw[i - 1] !== ":") {
      // Preserve a trailing CR exactly like the OLD `String#replace(/(?<!:)\/\/.*/, "")` implementation
      // did: `.` never matches `\r`/`\n`, so that regex's own match never consumed a trailing `\r` on a
      // CRLF-terminated line — a naive cut here would silently normalize CRLF -> LF on every line carrying
      // a trailing comment. MEASURED (card 36afbbdd manager review round 2): this exact divergence hit
      // 40+ real src/**/*.ts files before that fix.
      const tail = raw.endsWith("\r") ? "\r" : "";
      return out + tail;
    }
    out += c; i++;
  }
  return out;
}
