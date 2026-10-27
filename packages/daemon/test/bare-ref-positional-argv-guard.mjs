import "./_guard.mjs";
// Card 868e0135 — SOURCE-TEXT guard (no daemon, no build beyond tsc, no real git): no array LITERAL in
// `packages/daemon/src/git/**` naming `merge-base`, `ls-tree`, `log`, or `rev-parse` as its subcommand (the
// first plain-string element, optionally after a leading run of `"-c", "k=v"` global-config pairs) may
// carry an UNPROTECTED bare (non-string-literal) ref/base positional, except a named, allowlisted site.
// docs/decisions/868e0135-*.md has the full mechanism this guard backstops: `--end-of-options` (plus
// `--verify` for `rev-parse`, abbda4f5's own shape) immediately before the positional closes the class of
// bug where an option-shaped value (`--all`, `--independent`, …) is re-entered into the subcommand's own
// option parser instead of being treated as a literal ref.
//
// SCOPE: comment-stripped `packages/daemon/src/git/**/*.ts` text only (not the whole `src/`, per the card
// — these 4 subcommands' bare-ref-positional hazard is a git/** concern). `"grep"` is DELIBERATELY NOT
// monitored — MEASURED (868e0135's own investigation): `--end-of-options` is not honored by `git grep`'s
// revision parser and ACTIVELY BREAKS the well-formed case (`git grep -I -l -E <pat> --end-of-options
// <ref> -- <paths>` fails trying to resolve "--end-of-options" itself as a revision), and the position a
// `treeish` sits in that call (after the pattern, not before it) already fails loud for an option-shaped
// value as-is (`--cached` there → "unable to resolve revision: --cached", never reinterpreted as a flag).
// Adding `--end-of-options` there would be a REGRESSION, not a fix — see `repoTreeReferencesInertPrefix`'s
// own inner spawn (worktrees.ts) for that call site.
//
// @decision 868e0135 — do not restate this guard's round-by-round history inline; the matching rule and
// "what it does not see" below are the CURRENT contract and stay here, but the WHY (what each round got
// wrong, the specific incidents that proved it) lives in the decision record only.
//
// MATCHING RULE: find every ARRAY LITERAL in the file — any `[` not inside a string/template and not a
// subscript/index access (heuristically: not immediately preceded, modulo whitespace, by an identifier
// char/`)`/`]`/`` ` ``) — extract its body via a balanced-bracket/quote-aware scan (handles a MULTI-LINE
// array) and split it into top-level comma-separated elements. Skip a leading run of `"-c",
// "<key>=<value>"` pairs, then classify the array by its first remaining element:
//   - SKIPPED ENTIRELY (no flag, no allowlist entry — manager ruling, 868e0135) when the first element
//     after any `-c` skip is not a monitored-subcommand literal, OR when every element beyond it is a
//     PLAIN STRING LITERAL (`"…"`/`'…'`, no `${…}`) or the one known fixed config spread
//     `...CANONICAL_GIT_CONFIG_ARGS` — an all-literal array can never carry an injected ref.
//   - CLASSIFIED SAFE IN THE MATCHER ITSELF, never allowlisted (manager ruling): a template literal whose
//     raw text, read from the opening backtick up to its FIRST `${`, is a NON-EMPTY literal prefix that
//     does NOT start with `-` (e.g. `` `refs/heads/${branch}` ``) — a prefix git will always see BEFORE
//     any interpolated content can never itself be an option spelling, so the whole token can never be
//     consumed as one (56c10535's `refs/heads/` case is the common instance). A `^`/`..` suffix occurring
//     AFTER an interpolation, or a template with no literal prefix at all, is NOT exempted this way and
//     stays flagged — only the PREFIX shape is a stable, mechanically-derivable fact. The element must
//     also be EXACTLY one closed template with nothing chained after it, and its prefix must carry no
//     backslash — a cooked escape (`` `\-${v}` ``) can hide a leading `-` the raw text never shows.
//   - PROTECTED, no allowlist entry needed: the array also contains the literal element `--end-of-options`
//     (and, for `rev-parse` specifically, also `--verify`) anywhere in the array.
//   - Otherwise FLAGGED: must match a judgment-curated `[file, subcommand, exact count, reason]` ALLOWLIST
//     entry (occurrence-counted, same discipline as trailer-derived-value-git-argv-guard.mjs) — a new,
//     unlisted occurrence fails loud, and so does a stale count in EITHER direction.
//
// WHAT THIS GUARD DOES NOT SEE (stated, not implied): an argv array built by `.push`/spread assembly across
// several statements (not one literal), or a `[` inside a template literal's own `${…}` interpolation (the
// quote-tracker treats the whole template as opaque). It is a name-PRESENCE/text-shape check only — it
// does not verify `--end-of-options` sits in the CORRECT position (immediately before the risky
// positional, not swallowing a real flag, and immediately before a SPREAD when the risky element is one)
// — that correctness is what the behavioral tests (bare-ref-positional-argv-fixes.mjs) exist to prove,
// not this guard.
//
// FALSE POSITIVE (harmless, only adds noise): a subscript that happens to look like an array literal by
// this guard's own backward-char heuristic.
//
// FALSE NEGATIVE — the backward-char heuristic also under-covers the OTHER direction: a literal right
// after a keyword that can only be followed by an expression, never itself indexable, reads exactly like
// `<ident>[...]` subscript access (e.g. `return ["merge-base", a, "HEAD"]`). `return`/`yield`/`typeof`/
// `case`/`in`/`of`/`await`/`throw`/`else`/`do` are special-cased via a whole-token backtrack — a FIXED
// LIST, not an exhaustive keyword grammar. Still misread as a subscript (NOT covered): `new`/`void`/
// `delete`/`instanceof`, and `export default [`.
//
// SAME-LINE AND IN-ARRAY RESIDUAL: the per-newline `'`/`"` reset below (see `scanText`) only closes a
// corrupted quote state at a LINE boundary — it does nothing for a corruption on the SAME line as the
// call it would otherwise hide (e.g. `` /'/; raw([...]) `` on one line), and nothing for a comment
// embedded INSIDE an argv's own element list (e.g. `["merge-base", /* it's */ someVar, "HEAD"]`, or the
// same thing split across a multi-line argv containing `/* don't */`) — that corrupts the PER-CALL
// `findMatchingBracket`/`splitTopLevel` quote tracking, which has no newline reset at all. Separately, a
// LINE STARTING WITH `/* x */` is dropped WHOLE by `_strip-comments.mjs` (not this guard) — including any
// real code sharing that line after the comment closes, so a monitored call on such a line is invisible
// before this guard ever sees the text.
//
// A regex literal with an ODD backtick count (e.g. `` /`[^`]*`/g ``) opens a backtick-quote state that,
// unlike `'`/`"`, is never reset at a newline (a real template may legitimately span lines) — it stays
// open through EOF, hiding the rest of the file. The EOF-canary check in section (S) below catches this:
// not by seeing past the corruption, but by failing LOUD when the canary it appends goes missing, which
// is what makes it a backstop at all. See `docs/decisions/868e0135-*.md`'s Round 3 section.
// ⚠ MEASURED LIMIT of the EOF canary itself: it only catches a desync that persists UNINTERRUPTED to
// EOF. A LOCALIZED desync that a LATER matching quote char coincidentally re-closes before EOF is NOT
// caught by it — confirmed by disabling the `'`/`"` newline-reset fix above and re-running: every
// dedicated round-3 control went RED, but the EOF canary stayed GREEN for every real file, including
// `git/reader.ts`, because its own LATER `/ambiguous argument ['"]?HEAD['"]?/` regex happens to close the
// quote the line-84 comment left open, before EOF is ever reached. The EOF canary is a real backstop for
// a desync that reaches EOF; it is not a substitute for a position-targeted control (like the
// `git/reader.ts` canary test above) when a bug's own corruption window might close itself first.
//
// NOT SEEN AT ALL (no literal subcommand string anywhere in the array to key off): a simple-git TYPED
// method call (`git.revparse([...])`, `git.log({...})` — the subcommand is implied by the method name,
// never present as an array element), and an array leading with a global git option OTHER than `-c k=v`
// (`-C <path>`, `--no-pager`, …) — `bounded.ts`'s `GLOBAL_OPTS_WITH_VALUE` is the fuller, value-aware rule
// a future version of this guard's own `skipGlobalConfigPairs` should mirror.
//
// Three further shapes it cannot see at all, because each hides the thing it needs OUTSIDE the one array
// literal it inspects — all three would need tracking a VALUE across statements/calls, which this
// text-shape guard deliberately does not attempt:
//   - a monitored subcommand named only inside a SPREAD CONSTANT defined elsewhere
//     (`const LOG = ["log", ...]; git.raw([...LOG, sha])` — the array's own elements are just a spread
//     and a bare variable, neither a literal subcommand name);
//   - a subcommand held in a VARIABLE instead of a literal (`const MB = "merge-base"; git.raw([MB, a,
//     b])` — `MB` is a bare identifier, not a quoted string, so `classifyCall` never recognizes it);
//   - a risky positional arriving via a CHAINED CALL on an otherwise-fully-literal array
//     (`["merge-base", "HEAD"].concat([riskyVar])` — the literal array alone has nothing risky; the
//     guard never looks past its own closing `]` to see what gets appended to it).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./_strip-comments.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const GIT_SRC = path.join(here, "..", "src", "git");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

export const MONITORED_SUBCOMMANDS = ["merge-base", "ls-tree", "log", "rev-parse"];

const NON_SUBSCRIPT_KEYWORDS = new Set([
  "return", "yield", "typeof", "case", "in", "of", "await", "throw", "else", "do",
]);

/** A risky, unprotected call appended to the END of a file's own text (in memory only) to prove the
 *  lexer is still correctly synced at EOF — see "(S) EOF CANARY" below, and `isQualifiedTemplate`'s own
 *  RED-proving limitation control. */
const CANARY_SNIPPET = `raw(["merge-base", __canary, "HEAD"]);`;

/** True when the character immediately before `idx` (skipping whitespace/newlines) means `[` at `idx` is a
 *  SUBSCRIPT/index access (`foo[i]`, `arr[0][1]`, a template-tag result, …), never an array literal — an
 *  identifier char, `)`, `]`, or `` ` ``. Anything else (`(`, `,`, `=`, `:`, `[`, `return`, start-of-file, a
 *  binary/unary operator, …) is treated as an array-literal START — ANY array literal whatever the
 *  callee. EXCEPT: when the preceding char is identifier-like, backtrack the FULL identifier run ending
 *  there and still treat it as a literal start when the WHOLE token (never a mere suffix — `undo` must
 *  stay a subscript; only the exact word `do` qualifies) is one of {@link NON_SUBSCRIPT_KEYWORDS} — a
 *  FIXED LIST, not an exhaustive keyword grammar; see this file's own "WHAT THIS GUARD DOES NOT SEE"
 *  header note for what it still misses. */
function isArrayLiteralStart(text, idx) {
  let i = idx - 1;
  while (i >= 0 && /\s/.test(text[i])) i--;
  if (i < 0) return true;
  if (!/[A-Za-z0-9_$)\]`]/.test(text[i])) return true;
  if (/[A-Za-z0-9_$]/.test(text[i])) {
    let start = i;
    while (start >= 0 && /[A-Za-z0-9_$]/.test(text[start])) start--;
    if (NON_SUBSCRIPT_KEYWORDS.has(text.slice(start + 1, i + 1))) return true;
  }
  return false;
}

/** Scans forward from `openIdx` (the index of an opening `[`) and returns the index of its MATCHING `]`,
 *  tracking bracket depth and quote state (`'`/`"`/`` ` ``, backslash-escape aware) so a bracket inside a
 *  string/template literal is never mistaken for a real one. Returns -1 if unterminated (malformed/EOF). */
function findMatchingBracket(text, openIdx) {
  let depth = 0;
  let quote = null; // null | "'" | '"' | '`'
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") { i++; continue; } // skip the escaped char
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") { quote = c; continue; }
    if (c === "[" || c === "(" || c === "{") { depth++; continue; }
    if (c === "]" || c === ")" || c === "}") {
      depth--;
      if (depth === 0 && c === "]") return i;
      if (depth < 0) return -1; // closed something we didn't open — malformed relative to openIdx
    }
  }
  return -1;
}

/** Splits an array-literal BODY (text strictly between the `[` and its matching `]`) into top-level
 *  comma-separated elements, respecting nested brackets/parens/braces and quote state the same way
 *  {@link findMatchingBracket} does — so `EMIT_COMPARE_SRC_PREFIX.slice(0, -1)` is one element, not two. */
function splitTopLevel(body) {
  const elements = [];
  let depth = 0, quote = null, start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") { quote = c; continue; }
    if (c === "[" || c === "(" || c === "{") { depth++; continue; }
    if (c === "]" || c === ")" || c === "}") { depth--; continue; }
    if (c === "," && depth === 0) { elements.push(body.slice(start, i).trim()); start = i + 1; }
  }
  const last = body.slice(start).trim();
  if (last) elements.push(last);
  return elements.filter(Boolean);
}

/** Finds the index, within `text` (expected to start with the opening backtick of a template literal, as
 *  a single top-level array element from {@link splitTopLevel}), of the backtick that closes THAT SAME
 *  template — tracking `${…}` substitution nesting (braces balance inside a substitution; a quote or a
 *  nested template inside one is skipped rather than mistaken for the outer close) and backslash escapes.
 *  Returns -1 when `text` doesn't start with a backtick, or is malformed/unterminated — either of which
 *  this guard treats as NOT a clean, standalone template literal (fail-closed: when in doubt, the element
 *  is NOT exempted, never silently exempted). */
function findTemplateClose(text) {
  if (text[0] !== "`") return -1;
  let i = 1;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "`") return i;
    if (c === "$" && text[i + 1] === "{") {
      i += 2;
      let depth = 1;
      while (i < text.length && depth > 0) {
        const cc = text[i];
        if (cc === "\\") { i += 2; continue; }
        if (cc === "{") { depth++; i++; continue; }
        if (cc === "}") { depth--; i++; continue; }
        if (cc === "'" || cc === '"') {
          const q = cc; i++;
          while (i < text.length && text[i] !== q) { i += text[i] === "\\" ? 2 : 1; }
          i++; continue;
        }
        if (cc === "`") {
          const nested = findTemplateClose(text.slice(i));
          if (nested < 0) return -1;
          i += nested + 1; continue;
        }
        i++;
      }
      if (depth !== 0) return -1; // unterminated substitution
      continue;
    }
    i++;
  }
  return -1;
}

const PLAIN_LITERAL_RE = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')$/;
// THE ONLY matcher-level exemption: a template literal whose text from the opening backtick to its FIRST
// `${` is a non-empty literal prefix that does NOT start with `-` and carries no `\` (a cooked escape can
// hide a leading `-` the raw text never shows), AND which is EXACTLY one closed template with nothing
// chained after it (`findTemplateClose` — a trailing `.slice(1)` etc. can change what reaches git
// regardless of the prefix). Captures `` `refs/heads/${…}` `` (56c10535) and any other literal-prefixed
// template; does NOT match a template with no prefix at all (`` `${x}^{tree}` ``) or one whose prefix
// itself looks like a flag (`` `--format=${x}` ``) — both stay flagged. See docs/decisions/868e0135-*.md
// for why this is narrower than it once was.
const QUALIFIED_LITERAL_PREFIX_RE = /^`([^$`]+)\$\{/;
const KNOWN_SAFE_SPREAD = "...CANONICAL_GIT_CONFIG_ARGS";

function isQualifiedTemplate(e) {
  const m = QUALIFIED_LITERAL_PREFIX_RE.exec(e);
  if (m === null || m[1].startsWith("-") || m[1].includes("\\")) return false;
  return findTemplateClose(e) === e.length - 1;
}

/** Index of the first PLAIN-LITERAL element after skipping a leading run of `"-c", "<key>=<value>"` pairs
 *  AND any leading spread (`...CANONICAL_GIT_CONFIG_ARGS`, or any other — a spread can never itself be the
 *  literal subcommand name, so skipping past it costs nothing; it is still re-examined as an ordinary
 *  element when `classifyCall` computes `risky` below). Manager ruling named only the `-c k=v` case; the
 *  spread case is required for the real corpus (`repoTreeHasJsTsSourceFile`'s spawn call leads with
 *  `...CANONICAL_GIT_CONFIG_ARGS` before its subcommand literal). */
function skipGlobalConfigPairs(elements) {
  let i = 0;
  while (i < elements.length) {
    if (/^\.\.\./.test(elements[i])) { i += 1; continue; }
    if (i + 1 < elements.length && PLAIN_LITERAL_RE.test(elements[i]) && elements[i].slice(1, -1) === "-c"
      && PLAIN_LITERAL_RE.test(elements[i + 1]) && elements[i + 1].slice(1, -1).includes("=")) {
      i += 2; continue;
    }
    break;
  }
  return i;
}

/** Classifies one array literal's elements. Returns `null` when it doesn't name a monitored subcommand (as
 *  its first element after any `-c k=v` skip) or has no risky element at all (skip entirely — no flag, no
 *  allowlist noise). Otherwise `{ subcommand, protected, risky }` — `protected` is true when
 *  `--end-of-options` (and, for rev-parse, `--verify`) is present; `risky` lists the elements that are
 *  neither a plain literal, the known-safe spread, nor a qualified literal-prefixed template. */
function classifyCall(elements) {
  const firstIdx = skipGlobalConfigPairs(elements);
  const first = elements[firstIdx];
  if (!first || !PLAIN_LITERAL_RE.test(first)) return null;
  const subcommand = MONITORED_SUBCOMMANDS.find((s) => first.slice(1, -1) === s);
  if (!subcommand) return null;
  const literalNames = new Set(elements.filter((e) => PLAIN_LITERAL_RE.test(e)).map((e) => e.slice(1, -1)));
  const risky = elements.filter((e) => {
    if (PLAIN_LITERAL_RE.test(e)) return false;
    if (e === KNOWN_SAFE_SPREAD) return false;
    if (isQualifiedTemplate(e)) return false;
    return true;
  });
  if (risky.length === 0) return null; // every non-literal element is exempt — nothing to flag
  const hasEndOfOptions = literalNames.has("--end-of-options");
  const hasVerify = literalNames.has("--verify");
  const protectedCall = subcommand === "rev-parse" ? (hasEndOfOptions && hasVerify) : hasEndOfOptions;
  return { subcommand, protectedCall, risky };
}

/** Every real OCCURRENCE (by [file, subcommand, exact count, reason]) of a FLAGGED (risky, unprotected)
 *  call — a stale count (in EITHER direction) fails exactly like a genuinely new, unlisted site.
 *
 *  EMPTY, DELIBERATELY (card 868e0135): the investigation that built this guard found every merge-base/
 *  ls-tree/log/rev-parse call in `packages/daemon/src/git/**` carrying a risky (non-literal, non-exempt)
 *  positional — not just the originally-named sites — and closed the WHOLE set with `--end-of-options`
 *  (`--verify` too, for rev-parse) rather than leaving some for a later card, mirroring `56c10535`'s own
 *  precedent of sweeping every call site in one pass instead of piecemeal. A future PR that adds a NEW
 *  unprotected call fails this guard immediately (the `(S) NO unlisted...` check below) rather than
 *  silently joining a list nobody re-reads; add an entry here ONLY for a genuinely new site this guard's
 *  own text-shape exemption (a qualified literal-prefix template, e.g. `` `refs/heads/${…}` ``) cannot
 *  express, with a reason, same discipline as `trailer-derived-value-git-argv-guard.mjs`. */
const ALLOWLIST = [];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** Scans one file's comment-stripped text for EVERY array literal, whatever the callee, bracket/quote-
 *  aware across the WHOLE text (one shared quote-state traversal, so a `[` inside an earlier string/
 *  template is never mistaken for a real one); returns `[{ subcommand, protectedCall, risky, snippet }]`
 *  for every FLAGGED (names a monitored subcommand, risky, unprotected) array found. `'`/`"` quote state
 *  RESETS at every newline (a backtick does not — a template literal may legitimately span lines, but
 *  neither `'` nor `"` can in valid source without a line-continuation this codebase doesn't use) — see
 *  this file's own "WHAT THIS GUARD DOES NOT SEE" header note for what still corrupts this tracker
 *  (a same-line or in-array residual, and an odd-backtick-count regex). */
export function scanText(text) {
  const stripped = stripComments(text);
  const hits = [];
  let quote = null;
  for (let i = 0; i < stripped.length; i++) {
    const c = stripped[i];
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) { quote = null; continue; }
      if (c === "\n" && quote !== "`") { quote = null; continue; }
      continue;
    }
    if (c === "'" || c === '"' || c === "`") { quote = c; continue; }
    if (c !== "[" || !isArrayLiteralStart(stripped, i)) continue;
    const closeIdx = findMatchingBracket(stripped, i);
    if (closeIdx < 0) continue; // malformed/unterminated — not this guard's concern to diagnose
    const body = stripped.slice(i + 1, closeIdx);
    const elements = splitTopLevel(body);
    const verdict = classifyCall(elements);
    if (verdict && !verdict.protectedCall) {
      hits.push({ ...verdict, snippet: stripped.slice(i, Math.min(closeIdx + 1, i + 160)) });
    }
    // Do NOT skip past closeIdx: a nested array literal (rare, but possible inside an element) must still
    // be found by continuing the scan from i+1 — only the quote-state traversal itself must stay linear.
  }
  return hits;
}

// ===================== (C) positive + negative controls — the scanner discriminates =====================
{
  check("(C) SKIPPED (no flag): an all-literal merge-base array carries no risky element at all",
    scanText(`git.raw(["merge-base", "HEAD", "main"]);`).length === 0);
  check("(C) FLAGGED: a bare-variable merge-base array with no --end-of-options is risky",
    scanText(`git.raw(["merge-base", someVar, "HEAD"]);`).some((h) => h.subcommand === "merge-base" && !h.protectedCall));
  check("(C) PROTECTED (no allowlist needed): the SAME call with --end-of-options present is not flagged",
    scanText(`git.raw(["merge-base", "--end-of-options", someVar, "HEAD"]);`).length === 0);
  check("(C) rev-parse needs BOTH --verify AND --end-of-options — --end-of-options alone is still flagged",
    scanText(`git.raw(["rev-parse", "--end-of-options", someVar]);`).some((h) => h.subcommand === "rev-parse" && !h.protectedCall));
  check("(C) rev-parse with both --verify and --end-of-options is protected",
    scanText(`git.raw(["rev-parse", "--verify", "--end-of-options", someVar]);`).length === 0);
  check("(C) a qualified `refs/heads/${…}` template is classified safe IN THE MATCHER: a call with ONLY " +
    "that element and literals has nothing left risky, so it is never flagged",
    scanText("git.raw([\"merge-base\", \"HEAD\", `refs/heads/${branch}`]);").length === 0);
  check("(C) ...but a DIFFERENT bare variable in the SAME call is still correctly flagged — the exemption " +
    "is per-element, not per-call",
    scanText("git.raw([\"merge-base\", someVar, `refs/heads/${branch}`]);").some((h) => h.subcommand === "merge-base" && !h.protectedCall));
  check("(C) RETRACTED round-1 exemption: a template with NO literal prefix (`${sha}^{tree}`) is NOT " +
    "exempt — it has nothing before the first `${` at all, so it stays FLAGGED",
    scanText("git.raw([\"rev-parse\", \"--verify\", `${sha}^{tree}`]);").some((h) => h.subcommand === "rev-parse" && !h.protectedCall));
  check("(C) RETRACTED round-1 exemption: a range template with no literal prefix (`${mergeBase}..${branchTip}`) stays FLAGGED",
    scanText("git.raw([\"log\", `${mergeBase}..${branchTip}`, \"--format=%aI\"]);").some((h) => h.subcommand === "log" && !h.protectedCall));
  check("(C) UNSOUNDNESS PROOF this round closes: a template whose literal PREFIX itself looks like a flag " +
    "(`--output=${x}`) is NOT exempted by the prefix rule (prefix starts with \"-\") — stays flagged",
    scanText("git.raw([\"log\", `--output=${x}`]);").some((h) => h.subcommand === "log" && !h.protectedCall));
  check("(C) a literal-prefixed template that is NOT refs/heads/ (e.g. `foo-${x}`) is ALSO exempt — the " +
    "rule is general (\"starts with a non-`-` literal prefix\"), not special-cased to refs/heads/",
    scanText("git.raw([\"merge-base\", \"HEAD\", `foo-${x}`]);").length === 0);
  check("(C) ...but a bare variable with NEITHER a refs/heads/ prefix NOR a compound suffix is still flagged",
    scanText(`git.raw(["rev-parse", sha]);`).some((h) => h.subcommand === "rev-parse" && !h.protectedCall));
  check("(C) the known-safe `...CANONICAL_GIT_CONFIG_ARGS` spread is exempt, never flagged on its own",
    scanText(`spawn(resolveGitBinaryForSpawn(), [...CANONICAL_GIT_CONFIG_ARGS, "ls-tree", "-r", "--name-only", "HEAD"]);`).length === 0);
  check("(C) the spawn-shaped call IS covered (not just .raw)",
    scanText(`spawn(resolveGitBinaryForSpawn(), [...CANONICAL_GIT_CONFIG_ARGS, "ls-tree", "-r", "--name-only", treeish]);`)
      .some((h) => h.subcommand === "ls-tree" && !h.protectedCall));
  check("(C) a MULTI-LINE array is still caught (the single-line-grep gap this card's own kickoff named)",
    scanText(`git.raw(["ls-tree", "-d", "--name-only", ref, "--",\n  SRC_PREFIX, TEST_PREFIX]);`)
      .some((h) => h.subcommand === "ls-tree" && !h.protectedCall));
  check("(C) a bare `raw([` wrapper call (no `.raw(`/`spawn(` prefix at all) is now covered",
    scanText(`raw(["log", "-1", "--format=%s", sha]);`).some((h) => h.subcommand === "log" && !h.protectedCall));
  check("(C) a `run([` wrapper call is now covered",
    scanText(`run(["merge-base", ancestor, descendant]);`).some((h) => h.subcommand === "merge-base" && !h.protectedCall));
  check("(C) a `wtRaw([` wrapper call is now covered",
    scanText(`wtRaw(["merge-base", tip, mainSha]);`).some((h) => h.subcommand === "merge-base" && !h.protectedCall));
  check("(C) an argv array merely ASSIGNED to a local (never passed inline to any `.raw(`/`spawn(` call in " +
    "this snippet at all) is still covered — the matcher looks at every array literal, not the callee",
    scanText(`const args = ["merge-base", ancestor, descendant];`).some((h) => h.subcommand === "merge-base" && !h.protectedCall));
  check("(C) a `${x}..HEAD` range injection (no literal prefix at all) is flagged regardless of wrapper shape",
    scanText(`run(["log", "--fixed-strings", "--grep=x", "--format=%B", \`\${afterSha}..HEAD\`]);`)
      .some((h) => h.subcommand === "log" && !h.protectedCall));
  check("(C) `grep` is NOT monitored at all — an unguarded bare-variable grep call is never flagged",
    scanText(`spawn(resolveGitBinaryForSpawn(), [...CANONICAL_GIT_CONFIG_ARGS, "grep", "-I", "-l", "-E", pattern, treeish, "--", "*.ts"]);`).length === 0);
  check("(C) NEGATIVE CONTROL: a bogus/innocuous line returns 0 hits", scanText(`const x = compute(req.method, "GET");`).length === 0);
  check("(C) NEGATIVE CONTROL: a mention only in a COMMENT returns 0 hits (comment-stripped)",
    scanText(`// git.raw(["merge-base", someVar, "HEAD"]);\nconst y = 1;`).length === 0);
  check("(C) NEGATIVE CONTROL: an unrelated subcommand (e.g. \"diff-tree\") with a bare variable is never flagged",
    scanText(`git.raw(["diff-tree", "--cc", "--no-commit-id", "-p", "-r", mergeSha]);`).length === 0);
  check("(C) OCCURRENCE COUNTING: two risky calls on consecutive lines both count",
    scanText(`git.raw(["merge-base", a, "HEAD"]);\ngit.raw(["merge-base", b, "HEAD"]);`).filter((h) => h.subcommand === "merge-base").length === 2);

  check("(C) ROUND 3: an apostrophe inside an INLINE (same-line, not whole-line) comment no longer hides " +
    "a bare-ref call on a LATER line",
    scanText(`function foo() { /* it's fine */ }\ngit.raw(["merge-base", someVar, "HEAD"]);`)
      .some((h) => h.subcommand === "merge-base" && !h.protectedCall));
  check("(C) ROUND 3: a quote-only character-class regex literal (`/['\"]/`) above a bare call no longer " +
    "corrupts the quote tracker for the rest of the file",
    scanText(`const RE = /['"]/;\ngit.raw(["merge-base", someVar, "HEAD"]);`)
      .some((h) => h.subcommand === "merge-base" && !h.protectedCall));
  check("(C) ROUND 3: a REAL latent instance, in situ — a canary placed after git/reader.ts's own " +
    "apostrophe-bearing inline comment (line 84) is correctly detected",
    (() => {
      const real = fs.readFileSync(path.join(GIT_SRC, "reader.ts"), "utf8");
      const lines = real.split("\n");
      lines.splice(96, 0, 'git.raw(["merge-base", canaryVar, "HEAD"]);');
      return scanText(lines.join("\n")).some((h) => h.subcommand === "merge-base" && !h.protectedCall);
    })());
  // CR3 finding 1b — KNOWN LIMITATION of the EOF-canary backstop added in section (S) below (documented,
  // not fixed here; see this file's own header and docs/decisions/868e0135-*.md's Round 3 section): a
  // regex literal with an ODD backtick count opens a backtick-quote state that, unlike `'`/`"`, is NEVER
  // reset at a newline — it stays open through EOF and swallows even an EOF-appended canary. This check
  // asserts that KNOWN-LIMITED behavior (the canary going MISSING), not that the canary is found — the
  // backstop still fails LOUD when this happens, which is what makes it a backstop at all.
  check("(C) KNOWN LIMITATION: an odd-backtick-count regex (`` /`[^`]*`/g ``) swallows even an " +
    "EOF-appended canary — the backstop fails LOUD (canary missing) rather than silently",
    !scanText("const RE = /`[^`]*`/g;\n" + CANARY_SNIPPET).some((h) => h.subcommand === "merge-base" && !h.protectedCall));

  check("(C) ROUND 3: `return [...]` is no longer misread as a subscript",
    scanText(`function f() { return ["merge-base", a, "HEAD"]; }`)
      .some((h) => h.subcommand === "merge-base" && !h.protectedCall));
  check("(C) ROUND 3: same for yield/typeof/case/in/of/await/throw/else/do",
    ["yield", "typeof", "case", "in", "of", "await", "throw", "else", "do"].every((kw) =>
      scanText(`${kw} ["merge-base", a, "HEAD"];`).some((h) => h.subcommand === "merge-base" && !h.protectedCall)));
  check("(C) NEGATIVE CONTROL: a REAL subscript (`myArr[i]`) still reads as a subscript, not an array literal",
    scanText(`myArr[i]("merge-base", someVar, "HEAD");`).length === 0);
  check("(C) NEGATIVE CONTROL: an identifier merely ENDING in a keyword's spelling (`undo`, not the whole " +
    "word `do`) still reads as a subscript — whole-token match, not substring",
    scanText(`undo["merge-base", a, "HEAD"];`).length === 0);

  check("(C) ROUND 3: a backslash-escaped prefix that COOKS to a dash (`` `\\-${v}` `` evaluates to a " +
    "leading `-`) is no longer exempted — any backslash in the prefix is rejected outright",
    scanText("git.raw([\"merge-base\", \"HEAD\", `\\-${v}`]);").some((h) => h.subcommand === "merge-base" && !h.protectedCall));
  check("(C) ROUND 3: same for a hex escape (`` `\\x2d${v}` ``, which also cooks to `-`)",
    scanText("git.raw([\"merge-base\", \"HEAD\", `\\x2d${v}`]);").some((h) => h.subcommand === "merge-base" && !h.protectedCall));
  check("(C) ROUND 3: a template with something chained AFTER its own closing backtick " +
    "(`` `x${v}`.slice(1) ``) is no longer exempted by its literal prefix alone",
    scanText("git.raw([\"merge-base\", \"HEAD\", `x${v}`.slice(1)]);").some((h) => h.subcommand === "merge-base" && !h.protectedCall));
  check("(C) NO REGRESSION: an unqualified, unchained literal-prefix template is still exempt",
    scanText("git.raw([\"merge-base\", \"HEAD\", `refs/heads/${branch}`]);").length === 0);
}

// ===================== (S) the real corpus ================================================================
{
  const files = walk(GIT_SRC);
  check(`(S) corpus sanity: scanned a real tree (${files.length} git/**/*.ts files, expect > 5)`, files.length > 5);
  let total = 0;
  const offenders = [];
  const seen = new Map(); // key: `${rel}\u0000${subcommand}` -> count
  const canaryMisses = [];
  for (const f of files) {
    const rel = "git/" + path.relative(GIT_SRC, f).split(path.sep).join("/");
    const text = fs.readFileSync(f, "utf8");
    const hits = scanText(text);
    total += hits.length;
    for (const h of hits) {
      const entry = ALLOWLIST.find(([file, name]) => file === rel && name === h.subcommand);
      if (!entry) { offenders.push(`${rel} [${h.subcommand}] ${h.snippet}`); continue; }
      const key = `${rel}\u0000${h.subcommand}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    // EOF CANARY (CR3, structural backstop): append a risky canary to THIS file's own text (in memory
    // only) and confirm it's still detected — a whole-file lexer-soundness smoke test that catches a
    // quote-tracker desync from ANY cause, not just the ones this round already fixed. See this file's
    // own "WHAT THIS GUARD DOES NOT SEE" header note for the one shape that defeats even this (an
    // odd-backtick-count regex) — proven as a limitation control in section (C) above.
    const canaryHits = scanText(text + "\n" + CANARY_SNIPPET);
    if (!canaryHits.some((h) => h.subcommand === "merge-base" && !h.protectedCall)) canaryMisses.push(rel);
  }
  check(`(S) EOF CANARY: every scanned file's own lexer state is still synced at EOF (a risky call ` +
    `appended there is detected)${canaryMisses.length ? `\n      MISSED IN: ${canaryMisses.join(", ")}` : ""}`,
    canaryMisses.length === 0);
  check(`(S) the real corpus is FULLY protected (${total} risky hit(s) — 0 expected; card 868e0135 closed every real occurrence, see the ALLOWLIST's own doc comment)`, total === 0);
  check(`(S) NO unlisted bare-ref-positional site reaches a monitored subcommand unprotected${offenders.length ? `\n      ${offenders.join("\n      ")}` : ""}`, offenders.length === 0);
  for (const [file, name, count, reason] of ALLOWLIST) {
    const key = `${file}\u0000${name}`;
    check(`(S) allowlist entry ${file} [${name}] matches EXACTLY ${count} occurrence(s) (stale entries fail either direction): ${reason.slice(0, 70)}…`, (seen.get(key) ?? 0) === count);
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — no unlisted bare-ref-positional site reaches merge-base/ls-tree/log/rev-parse unprotected"
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
