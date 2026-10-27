import "./_guard.mjs";
// Cards 868e0135/4b559feb — SOURCE-TEXT guard (no daemon, no build beyond tsc, no real git): no array
// LITERAL in `packages/daemon/src/git/**` naming `merge-base`, `ls-tree`, `log`, `rev-parse`, `rev-list`,
// or `diff` as its subcommand (the first plain-string element, optionally after a leading run of global
// options — see MATCHING RULE below) may carry an UNPROTECTED bare (non-string-literal) ref/base
// positional, except a named, allowlisted site. docs/decisions/868e0135-*.md and docs/decisions/
// 4b559feb-*.md have the full mechanism this guard backstops: `--end-of-options` (plus `--verify` for
// `rev-parse`, abbda4f5's own shape) immediately before the positional closes the class of bug where an
// option-shaped value (`--all`, `--independent`, …) is re-entered into the subcommand's own option parser
// instead of being treated as a literal ref. **`rev-list`/`diff` carve-out (card 4b559feb, read the
// decision record before trusting a shortened restatement):** a COMBINED two/three-dot range string
// (`` `${a}..${b}` ``) can never literally equal a flag spelling (it never starts with `-` unless its OWN
// head is itself option-shaped), so `--end-of-options` is MEASURED to change nothing about that shape's
// real safety — it is still added to those call sites for guard-satisfaction/defense-in-depth consistency,
// never because it closes a real gap there. The marker DOES close a real gap for a true SEPARATE bare
// positional (not a combined range) and for the one bare ref `rev-list ... --not <ref>` protects — `--not`
// must stay BEFORE the marker, which goes right after `--not`, never before the range.
//
// **POSITION, not mere presence (card 5c23ade1, read the decision record before trusting a shortened
// restatement):** `--end-of-options` ends ALL subsequent option/pseudo-opt recognition from where it sits,
// permanently, for the rest of argv — so a call is protected only when the marker sits BEFORE every risky
// positional it's meant to cover, never merely somewhere in the array. The ONE exception is `rev-list`'s
// own `--not <ref>`: a risky element directly after `--not` is protected by the marker placed RIGHT AFTER
// `--not` (between `--not` and that ref) — a risky element BEFORE `--not` (the range/base argument region)
// needs no position-based protection at all, per the carve-out above. Placing the marker BEFORE `--not`
// fails the WHOLE call outright, regardless of what it would otherwise protect — it swallows `--not`'s own
// sign-flip semantics (card 4b559feb measured a corrupted, wrong result, not merely a missed protection).
//
// **Module-level const-array spread resolution (card 5c23ade1):** a `const NAME = [<string literals>] (as
// const)?;` declared at the TOP LEVEL of the scanned file and later spread as `[...NAME, x]` is resolved
// inline for classification — its own literal elements (including a subcommand name hidden inside it) are
// read as if they appeared directly in the array, closing the blind spot where such a spread made the
// WHOLE call invisible to this guard (the subcommand skip never found a literal to match, since the
// subcommand name lived inside the spread, not as a direct array element — e.g. `NAME_ONLY_DIFF_FLAGS` in
// `worktrees.ts`). Only a spread whose target is itself a plain, ALL-literal array is resolved this way; an
// unresolvable spread (anything else, including the dedicated `CANONICAL_GIT_CONFIG_ARGS` safe-spread
// handled below) is left exactly as before.
//
// SCOPE: `packages/daemon/src/git/**/*.ts` text only (not the whole `src/`, per the card — these
// subcommands' bare-ref-positional hazard is a git/** concern). `"grep"` is DELIBERATELY NOT monitored —
// MEASURED (868e0135's own investigation): `--end-of-options` is not honored by `git grep`'s revision
// parser and ACTIVELY BREAKS the well-formed case (`git grep -I -l -E <pat> --end-of-options <ref> --
// <paths>` fails trying to resolve "--end-of-options" itself as a revision), and the position a `treeish`
// sits in that call (after the pattern, not before it) already fails loud for an option-shaped value as-is
// (`--cached` there → "unable to resolve revision: --cached", never reinterpreted as a flag). Adding
// `--end-of-options` there would be a REGRESSION, not a fix — see `repoTreeReferencesInertPrefix`'s own
// inner spawn (worktrees.ts) for that call site.
//
// @decision 868e0135 — do not restate this guard's round-by-round history inline; the matching rule and
// "what it does not see" below are the CURRENT contract and stay here, but the WHY (what each round got
// wrong, the specific incidents that proved it) lives in the decision record only.
//
// @decision a4145c7a — never reintroduce hand-rolled bracket/quote/comment tracking, or the backward-char
// array-literal-vs-subscript heuristic, in this guard: a real parser has no desync state to corrupt and
// distinguishes element access from an array literal structurally, with no known exception.
//
// @decision 5c23ade1 — never read `--end-of-options` as protecting a call merely by being present anywhere;
// it must sit before every risky positional it covers (the `--not`-adjacent exception above aside), and a
// marker before `--not` fails the whole call outright.
//
// MATCHING RULE: parse the file with `ts.createSourceFile` (parent nodes set) and walk every
// `ArrayLiteralExpression` node, whatever its position or callee — a nested array literal (inside another
// array's own element, inside a call argument, anywhere) is found too, since the walk recurses into every
// child regardless of what the current node already matched. For each one, skip a leading run of:
//   - any spread element (`...X`) — a spread can never itself be the literal subcommand name;
//   - a `"-c", "<key>=<value>"` string-literal pair;
//   - any OTHER global option in the SAME set `bounded.ts`'s own `GLOBAL_OPTS_WITH_VALUE` subcommand-
//     locator rule uses (`-C`, `--git-dir`, `--work-tree`, `--namespace`, `--config-env`, `--attr-source`),
//     consuming its following element as the option's value, never as the subcommand — this closes the gap
//     `62c4953a`'s own round 6 fixed in `bounded.ts` for the SAME reason: a `-C <path>` value that happens
//     to equal a monitored subcommand's name must never be misread as the subcommand itself;
//   - a bare flag (any other string literal starting with `-`, e.g. `--no-pager`) that takes no value.
// then classify the array by its first REMAINING element:
//   - SKIPPED ENTIRELY (no flag, no allowlist entry — manager ruling, 868e0135) when the first element
//     after that skip is not a literal naming a {@link MONITORED_SUBCOMMANDS} member, OR when every element
//     in the WHOLE array is a plain string literal (`"…"`/`'…'`) or the one known fixed config spread
//     `...CANONICAL_GIT_CONFIG_ARGS` — an all-literal array can never carry an injected ref.
//   - ALSO CLASSIFIED (no leading literal to skip to at all): a simple-git TYPED `.revparse([...])` method
//     call — the subcommand is implied by the method name (never present as a literal array element), so
//     its argument array's elements are classified directly, with `rev-parse` as the subcommand, no
//     leading-literal skip needed or attempted. `.raw`/`.run`/`.wtRaw`/a bare `raw(`/`run(`/`wtRaw(`
//     wrapper/a raw `spawn(...)` call all still carry their subcommand as a literal array element and need
//     no special case — only a TYPED method whose name itself encodes the subcommand does.
//   - CLASSIFIED SAFE IN THE MATCHER ITSELF, never allowlisted (manager ruling): a template literal WITH AT
//     LEAST ONE substitution (`ts.isTemplateExpression`, not a no-substitution template) whose raw head
//     text (the literal text from the opening backtick up to the first `${`, read via the parser's own
//     `rawText` — never the cooked `text`, which can hide an escape) is a NON-EMPTY literal prefix that
//     does NOT start with `-` and contains no `\` (a cooked escape can make the prefix evaluate to
//     something starting with `-` even though its raw spelling doesn't) — e.g. `` `refs/heads/${branch}` ``
//     (56c10535's own case). Because the array ELEMENT itself must be the `TemplateExpression` node
//     directly, anything chained after it (`` `x${v}`.slice(1) ``) is automatically NOT this shape — its
//     node kind is a `CallExpression`/`PropertyAccessExpression`, never a `TemplateExpression` — so there is
//     no separate "nothing chained after it" check left to write; the AST shape IS the check.
//   - PROTECTED, no allowlist entry needed: `--end-of-options` sits BEFORE every risky positional it must
//     cover (and, for `rev-parse`, `--verify` is ALSO present anywhere) — see card 5c23ade1's own position
//     rule stated above for the `rev-list`/`--not` exception and its failure mode.
//   - Otherwise FLAGGED: must match a judgment-curated `[file, subcommand, exact count, reason]` ALLOWLIST
//     entry (occurrence-counted, same discipline as trailer-derived-value-git-argv-guard.mjs) — a new,
//     unlisted occurrence fails loud, and so does a stale count in EITHER direction.
//
// WHAT THIS GUARD DOES NOT SEE (stated, not implied — all FOUR of these need tracking a VALUE across
// statements/calls, or recognizing a callee this guard was never told about; none is a parser limitation,
// each is a genuine decision not to attempt data-flow analysis):
//   - an argv array built by `.push`/spread assembly across SEVERAL statements, never one array literal;
//   - a monitored subcommand named only inside a spread constant declared OUTSIDE the scanned file (an
//     import, or a non-literal initializer such as `.flatMap(...)`) — only a plain, ALL-literal `const`
//     array declared at the TOP LEVEL of the SAME file is resolved (card 5c23ade1, see this file's own
//     header); a cross-file or computed one stays exactly as unseen as before that card;
//   - a subcommand held in a VARIABLE instead of a literal (`const MB = "merge-base"; git.raw([MB, a,
//     b])` — `MB` is an `Identifier` node, not a `StringLiteral`, so classification never recognizes it);
//   - a risky positional arriving via a CHAINED CALL on an otherwise-fully-literal array
//     (`["merge-base", "HEAD"].concat([riskyVar])` — the literal array alone has nothing risky; the guard
//     never looks past its own closing `]` to see what gets appended to it);
//   - a simple-git TYPED method OTHER than `.revparse` that might one day imply a monitored subcommand with
//     no literal token present (none exists in the real corpus today — see the decision record's own
//     survey — so none is special-cased; add one here, the same way `.revparse` was added, if that changes).
//
// It is also a name-PRESENCE/text-shape check only — it does not verify `--end-of-options` sits in the
// CORRECT position (immediately before the risky positional, not swallowing a real flag, and immediately
// before a SPREAD when the risky element is one) — that correctness is what the behavioral tests
// (bare-ref-positional-argv-fixes.mjs) exist to prove, not this guard.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const here = path.dirname(fileURLToPath(import.meta.url));
const GIT_SRC = path.join(here, "..", "src", "git");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

export const MONITORED_SUBCOMMANDS = ["merge-base", "ls-tree", "log", "rev-parse", "rev-list", "diff"];

/** A risky, unprotected call appended to the END of a file's own text (in memory only) — a whole-file
 *  parse-and-scan smoke test: confirms this guard still finds a real hit at EOF in a real file, rather
 *  than (for instance) silently returning zero hits because the file failed to parse at all. Card
 *  a4145c7a's own DoD asked to keep this as a cheap whole-corpus sanity check, even though there is no
 *  quote/comment/regex-desync class left (under a real parser) for it to backstop. */
const CANARY_SNIPPET = `raw(["merge-base", __canary, "HEAD"]);`;

/** Mirror of `bounded.ts`'s own `GLOBAL_OPTS_WITH_VALUE` (card 62c4953a, round 6) — global git options that
 *  take their value as a SEPARATE array element when written without `=`. A COPY, not an import: this test
 *  file must not import from `packages/daemon/src` (card a4145c7a's own kickoff), and the two lists are
 *  small enough that a judgment-curated mirror is the right call, same posture as the ALLOWLIST below.
 *  Keep in sync with `bounded.ts` by hand if that set ever changes. */
const GLOBAL_OPTS_WITH_VALUE = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--config-env", "--attr-source"]);

const KNOWN_SAFE_SPREAD = "CANONICAL_GIT_CONFIG_ARGS";

/** True for the one spread element exempt from the subcommand-skip AND the risky-element classification:
 *  `...CANONICAL_GIT_CONFIG_ARGS` exactly — any OTHER spread is still skippable as a leading element (see
 *  {@link skipGlobalConfigPairs}) but is NOT exempt from being flagged risky if it ends up classified. */
function isKnownSafeSpread(el) {
  return ts.isSpreadElement(el) && ts.isIdentifier(el.expression) && el.expression.text === KNOWN_SAFE_SPREAD;
}

/** True for a template literal WITH at least one substitution whose raw head text (backtick to the first
 *  `${`, via the parser's own `rawText` — never the cooked `text`) is a non-empty, non-`-`-leading,
 *  backslash-free literal prefix. See this file's own header MATCHING RULE for why "nothing chained after
 *  it" needs no separate check: `el` must BE the `TemplateExpression` node, which a chained call/property
 *  access on it never is (its own node kind is `CallExpression`/`PropertyAccessExpression` instead). */
function isQualifiedTemplate(el) {
  if (!ts.isTemplateExpression(el)) return false;
  const prefix = el.head.rawText ?? "";
  if (prefix.length === 0 || prefix.startsWith("-") || prefix.includes("\\")) return false;
  return true;
}

/** Card 5c23ade1 — resolves every TOP-LEVEL `const NAME = [<string literals>] (as const)?;` declared
 *  directly in `sourceFile.statements` (never nested in a function/block — "module-level" per this card's
 *  own DoD) into a `Map<name, string[]>`. Deliberately conservative: a declaration whose array contains ANY
 *  non-string-literal element (a computed value, a nested spread, a variable) is NOT added at all — this
 *  guard must never guess at a value it can't see in the text. `expr as const` is unwrapped via
 *  `ts.isAsExpression` before checking for the array literal underneath. */
function resolveModuleConstStringArrays(sourceFile) {
  const map = new Map();
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    if (!(stmt.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
      let init = decl.initializer;
      if (ts.isAsExpression(init)) init = init.expression;
      if (!ts.isArrayLiteralExpression(init)) continue;
      const texts = [];
      let allLiteral = true;
      for (const el of init.elements) {
        if (ts.isStringLiteral(el)) texts.push(el.text);
        else { allLiteral = false; break; }
      }
      if (allLiteral) map.set(decl.name.text, texts);
    }
  }
  return map;
}

/** Card 5c23ade1 — converts one array literal's raw `ts.Expression[]` elements into a uniform
 *  `{ text?: string, node?: ts.Expression }[]` so classification can see THROUGH a resolved module-level
 *  const-array spread (see {@link resolveModuleConstStringArrays}) exactly as if its own literal elements
 *  had appeared inline. A real string literal carries BOTH `text` and `node`; an expanded spread element
 *  carries ONLY `text` (no original node to point at); anything else (an Identifier, a template, an
 *  unresolved/unknown spread, the dedicated known-safe spread) carries only `node`, unchanged from before
 *  this card. The known-safe spread is checked FIRST and kept as a single opaque item either way — it must
 *  never be expanded even if it happened to also be resolvable. */
function toItems(elements, constArrays) {
  const items = [];
  for (const el of elements) {
    if (ts.isSpreadElement(el)) {
      if (isKnownSafeSpread(el)) { items.push({ node: el }); continue; }
      if (ts.isIdentifier(el.expression)) {
        const resolved = constArrays.get(el.expression.text);
        if (resolved) { for (const text of resolved) items.push({ text }); continue; }
      }
      items.push({ node: el });
      continue;
    }
    if (ts.isStringLiteral(el)) { items.push({ text: el.text, node: el }); continue; }
    items.push({ node: el });
  }
  return items;
}

/** Index of the first item after skipping a leading run of: any unresolved spread, a `"-c", "<k>=<v>"`
 *  pair, any OTHER {@link GLOBAL_OPTS_WITH_VALUE} option (consuming its value), or a bare `-`-leading flag
 *  with no value — mirrors `bounded.ts`'s `walkGitGlobalPrefix` (see this file's header for the full rule).
 *  Operates on {@link toItems}' uniform item shape, not raw AST nodes, so a resolved const-array spread's
 *  own expanded literal elements participate exactly like a real literal would. A `-c` not followed by a
 *  valid `"<k>=<v>"` literal pair halts the skip entirely (does not fall through to the generic
 *  value-option/bare-flag branches) — same as the pre-a4145c7a behavior, so a malformed `-c` is never
 *  silently reinterpreted as something else. */
function skipGlobalConfigPairs(items) {
  let i = 0;
  while (i < items.length) {
    const item = items[i];
    if (item.text === undefined) {
      if (item.node && ts.isSpreadElement(item.node)) { i += 1; continue; }
      break;
    }
    const text = item.text;
    if (text === "-c") {
      const kv = items[i + 1];
      if (kv && kv.text !== undefined && kv.text.includes("=")) { i += 2; continue; }
      break;
    }
    if (GLOBAL_OPTS_WITH_VALUE.has(text)) {
      if (i + 1 < items.length) { i += 2; continue; }
      break; // a value-taking option with nothing after it — malformed; stop rather than guess
    }
    if (text.startsWith("-")) { i += 1; continue; } // a bare flag with no value (e.g. --no-pager)
    break; // reached a non-flag literal — the subcommand (or a non-monitored literal)
  }
  return i;
}

/** Card 5c23ade1 — true for a TemplateExpression whose raw literal HEAD (not cooked) starts with `-`
 *  (e.g. `` `--max-count=${n}` ``): this element is UNCONDITIONALLY read by git as the option it's written
 *  to look like, regardless of where `--end-of-options` sits — there is no "re-interpretation" risk for an
 *  element that was always, by its own hardcoded spelling, meant and read as a flag. Distinct from (and
 *  narrower than) {@link isQualifiedTemplate}'s exemption, which covers the OPPOSITE prefix shape (a
 *  literal non-`-` prefix proving the element is a REF, never a flag) — a `-`-leading prefix deliberately
 *  stays OUT of that exemption (so a call with no `--end-of-options` ANYWHERE still flags it, matching this
 *  file's own existing tests), but it needs no marker-POSITION protection once some marker exists
 *  somewhere in the call (see {@link isProtectedPosition}). */
function isSelfEvidentFlagTemplate(node) {
  return !!node && ts.isTemplateExpression(node) && (node.head.rawText ?? "").startsWith("-");
}

/** Card 5c23ade1 — per-subcommand flags, beyond the leading-global-option {@link GLOBAL_OPTS_WITH_VALUE}
 *  set, known to unconditionally consume the NEXT array element as their own value — git's CLI parser
 *  binds that next token to the flag directly and never re-examines it as an independent option or ref, so
 *  a risky element immediately following one of these needs no marker-position protection either (same
 *  underlying mechanism as {@link isSelfEvidentFlagTemplate}, just triggered by the PRECEDING literal
 *  instead of the element's own shape). Judgment-curated and deliberately keyed BY SUBCOMMAND, same posture
 *  as GLOBAL_OPTS_WITH_VALUE/ALLOWLIST — `log`'s own `-n <count>` is the one real corpus need as of this
 *  card (`worktrees.ts`'s `listMergedCommitsLookup`-family call); add the next one here, by hand, when it
 *  arises, scoped to the subcommand it actually belongs to. */
const KNOWN_VALUE_FLAGS_BY_SUBCOMMAND = new Map([["log", new Set(["-n"])]]);

/** Card 5c23ade1 — true when the item immediately BEFORE `idx` is a KNOWN value-consuming flag: either a
 *  LEADING {@link GLOBAL_OPTS_WITH_VALUE} member (e.g. `--git-dir <path>`, consumed the same way during
 *  {@link skipGlobalConfigPairs}'s own subcommand search) or a {@link KNOWN_VALUE_FLAGS_BY_SUBCOMMAND}
 *  member for THIS `subcommand`. Same underlying mechanism as {@link isSelfEvidentFlagTemplate}: the value
 *  is bound to the flag directly by git's own parser and never independently re-examined, so its position
 *  relative to any `--end-of-options` marker is immaterial. */
function isKnownFlagValue(idx, items, subcommand) {
  if (idx === 0) return false;
  const prevText = items[idx - 1].text;
  if (prevText === undefined) return false;
  if (GLOBAL_OPTS_WITH_VALUE.has(prevText)) return true;
  const set = KNOWN_VALUE_FLAGS_BY_SUBCOMMAND.get(subcommand);
  return !!set && set.has(prevText);
}

/** Card 5c23ade1 — true when the risky item at `idx` is protected. Two SHAPE-level exemptions are checked
 *  FIRST — {@link isSelfEvidentFlagTemplate} and {@link isKnownFlagValue} — each gated on `markerIdx !==
 *  -1` (SOME `--end-of-options` must exist somewhere in the call; a call with NONE at all stays
 *  conservatively flagged regardless of shape, matching this file's own existing tests), since neither
 *  exemption depends on the marker's actual POSITION — both describe an element that was always going to
 *  be read as a flag (or a flag's own value), never re-examined as an independent ref, however far the
 *  marker sits from it. Otherwise the general POSITION rule: `--end-of-options` ends ALL subsequent
 *  option/pseudo-opt parsing from where it sits, so protection requires the marker to be a real position
 *  strictly BEFORE `idx` — except `rev-list`'s own `--not <ref>` carve-out (`notIdx !== -1`): a risky item
 *  BEFORE `--not` needs no marker at all (card 4b559feb measured that region immune regardless of
 *  placement), while one AFTER `--not` is protected only when the marker sits in the one exact slot right
 *  after it (`markerIdx === notIdx + 1`). The caller has ALREADY failed the whole call, before this
 *  function ever runs, when the marker sits before `--not` itself (it swallows `--not`'s own sign-flip
 *  semantics). */
function isProtectedPosition(idx, items, subcommand, markerIdx, notIdx) {
  if (markerIdx !== -1 && (isSelfEvidentFlagTemplate(items[idx].node) || isKnownFlagValue(idx, items, subcommand))) {
    return true;
  }
  if (notIdx !== -1) {
    if (idx < notIdx) return true;
    return markerIdx === notIdx + 1;
  }
  return markerIdx !== -1 && markerIdx < idx;
}

/** Classifies one array literal's already-expanded `items` (see {@link toItems}, which is what resolves a
 *  module-level const-array spread before this function ever runs). `impliedSubcommand` (set only for a
 *  `.revparse([...])` call — see this file's header) bypasses the leading-literal skip and subcommand
 *  lookup entirely, since such a call's array carries no literal subcommand token at all. Returns `null`
 *  when the array doesn't name a monitored subcommand, or has no risky element at all (skip entirely — no
 *  flag, no allowlist noise). Otherwise `{ subcommand, protectedCall, risky }` — `risky` lists the elements
 *  that are neither a plain string literal (real or resolved-via-spread), the known-safe spread, nor a
 *  qualified literal-prefixed template. `protectedCall` is computed by POSITION, not mere presence (card
 *  5c23ade1, see this file's header and {@link isProtectedPosition}): for `rev-parse`, `--verify` must be
 *  present anywhere AND `--end-of-options` must sit before every risky item; for `rev-list` with a `--not`
 *  present, a marker found BEFORE `--not` fails the whole call outright (it breaks `--not`'s own sign-flip
 *  semantics) and otherwise every risky item must satisfy {@link isProtectedPosition}'s `--not`-aware rule;
 *  every other subcommand (including `rev-list` with no `--not`) uses the plain "marker before every risky
 *  item" rule. */
function classifyCall(items, impliedSubcommand) {
  let subcommand;
  if (impliedSubcommand) {
    subcommand = impliedSubcommand;
  } else {
    const firstIdx = skipGlobalConfigPairs(items);
    const first = items[firstIdx];
    if (!first || first.text === undefined) return null;
    const match = MONITORED_SUBCOMMANDS.find((s) => first.text === s);
    if (!match) return null;
    subcommand = match;
  }
  const literalNames = new Set(items.filter((it) => it.text !== undefined).map((it) => it.text));
  const riskyIdxs = [];
  const risky = [];
  items.forEach((it, idx) => {
    if (it.text !== undefined) return; // a real literal, or a resolved-via-spread one — never risky
    if (it.node && isKnownSafeSpread(it.node)) return;
    if (it.node && isQualifiedTemplate(it.node)) return;
    riskyIdxs.push(idx);
    risky.push(it.node ?? it);
  });
  if (riskyIdxs.length === 0) return null; // every non-literal element is exempt — nothing to flag
  const markerIdx = items.findIndex((it) => it.text === "--end-of-options");
  const hasVerify = literalNames.has("--verify");
  let protectedCall;
  if (subcommand === "rev-parse") {
    protectedCall = hasVerify && riskyIdxs.every((idx) => isProtectedPosition(idx, items, subcommand, markerIdx, -1));
  } else {
    const notIdx = subcommand === "rev-list" ? items.findIndex((it) => it.text === "--not") : -1;
    if (notIdx !== -1 && markerIdx !== -1 && markerIdx < notIdx) {
      protectedCall = false; // marker placed before --not swallows it outright — never partially protected
    } else {
      protectedCall = riskyIdxs.every((idx) => isProtectedPosition(idx, items, subcommand, markerIdx, notIdx));
    }
  }
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

/** True when `node` (an `ArrayLiteralExpression`) is itself an argument of a `.revparse(...)` call —
 *  simple-git's own typed rev-parse method, whose argv array carries no literal `"rev-parse"` token (the
 *  subcommand is implied by the method name) — see this file's header MATCHING RULE. Deliberately checks
 *  only the property name, not the receiver's identity/type — the guard scans every array literal
 *  "whatever the callee" already (raw/run/wtRaw get no receiver check either); a non-git `.revparse(...)`
 *  call is not a real shape this corpus has, and failing toward "still scanned" costs nothing. */
function isRevparseArgArray(node) {
  const parent = node.parent;
  if (!parent || !ts.isCallExpression(parent)) return false;
  if (!parent.arguments.some((a) => a === node)) return false;
  const callee = parent.expression;
  return ts.isPropertyAccessExpression(callee) && callee.name.text === "revparse";
}

/** Scans one file's (or in-memory snippet's) text for EVERY array literal, whatever its position or
 *  callee, via a real TypeScript parse (`ts.createSourceFile`, parent nodes set so {@link
 *  isRevparseArgArray} can inspect each array literal's enclosing call). Returns
 *  `[{ subcommand, protectedCall, risky, snippet }]` for every FLAGGED (names a monitored subcommand,
 *  risky, unprotected) array found — see this file's header MATCHING RULE for the full classification. */
export function scanText(text, fileName = "scan.ts") {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, /* setParentNodes */ true);
  const constArrays = resolveModuleConstStringArrays(sourceFile);
  const hits = [];
  const visit = (node) => {
    if (ts.isArrayLiteralExpression(node)) {
      const impliedSubcommand = isRevparseArgArray(node) ? "rev-parse" : undefined;
      const items = toItems(Array.from(node.elements), constArrays);
      const verdict = classifyCall(items, impliedSubcommand);
      if (verdict && !verdict.protectedCall) {
        const raw = node.getText(sourceFile);
        hits.push({ ...verdict, snippet: raw.replace(/\s+/g, " ").slice(0, 160) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
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
  check("(C) a template with NO literal prefix (`${sha}^{tree}`) is NOT exempt — it has nothing before " +
    "the first `${` at all, so it stays FLAGGED",
    scanText("git.raw([\"rev-parse\", \"--verify\", `${sha}^{tree}`]);").some((h) => h.subcommand === "rev-parse" && !h.protectedCall));
  check("(C) a range template with no literal prefix (`${mergeBase}..${branchTip}`) stays FLAGGED",
    scanText("git.raw([\"log\", `${mergeBase}..${branchTip}`, \"--format=%aI\"]);").some((h) => h.subcommand === "log" && !h.protectedCall));
  check("(C) a template whose literal PREFIX itself looks like a flag (`--output=${x}`) is NOT exempted " +
    "by the prefix rule (prefix starts with \"-\") — stays flagged",
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
  check("(C) a MULTI-LINE array is still caught",
    scanText(`git.raw(["ls-tree", "-d", "--name-only", ref, "--",\n  SRC_PREFIX, TEST_PREFIX]);`)
      .some((h) => h.subcommand === "ls-tree" && !h.protectedCall));
  check("(C) a bare `raw([` wrapper call (no `.raw(`/`spawn(` prefix at all) is covered",
    scanText(`raw(["log", "-1", "--format=%s", sha]);`).some((h) => h.subcommand === "log" && !h.protectedCall));
  check("(C) a `run([` wrapper call is covered",
    scanText(`run(["merge-base", ancestor, descendant]);`).some((h) => h.subcommand === "merge-base" && !h.protectedCall));
  check("(C) a `wtRaw([` wrapper call is covered",
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
  check("(C) NEGATIVE CONTROL: a mention only in a COMMENT returns 0 hits (comments carry no AST node)",
    scanText(`// git.raw(["merge-base", someVar, "HEAD"]);\nconst y = 1;`).length === 0);
  check("(C) NEGATIVE CONTROL: an unrelated subcommand (e.g. \"diff-tree\") with a bare variable is never flagged",
    scanText(`git.raw(["diff-tree", "--cc", "--no-commit-id", "-p", "-r", mergeSha]);`).length === 0);
  check("(C) OCCURRENCE COUNTING: two risky calls on consecutive lines both count",
    scanText(`git.raw(["merge-base", a, "HEAD"]);\ngit.raw(["merge-base", b, "HEAD"]);`).filter((h) => h.subcommand === "merge-base").length === 2);

  check("(C) an apostrophe inside an INLINE comment no longer hides a bare-ref call on a LATER line " +
    "(the real parser treats a comment as trivia, never quote state)",
    scanText(`function foo() { /* it's fine */ }\ngit.raw(["merge-base", someVar, "HEAD"]);`)
      .some((h) => h.subcommand === "merge-base" && !h.protectedCall));
  check("(C) a quote-only character-class regex literal (`/['\"]/`) above a bare call no longer corrupts " +
    "anything downstream — the real parser tokenizes the regex literal correctly",
    scanText(`const RE = /['"]/;\ngit.raw(["merge-base", someVar, "HEAD"]);`)
      .some((h) => h.subcommand === "merge-base" && !h.protectedCall));
  check("(C) a REAL latent instance, in situ — a canary placed after git/reader.ts's own apostrophe-bearing " +
    "inline comment (line 84) is correctly detected",
    (() => {
      const real = fs.readFileSync(path.join(GIT_SRC, "reader.ts"), "utf8");
      const lines = real.split("\n");
      lines.splice(96, 0, 'git.raw(["merge-base", canaryVar, "HEAD"]);');
      return scanText(lines.join("\n"), "reader.ts").some((h) => h.subcommand === "merge-base" && !h.protectedCall);
    })());
  // @decision a4145c7a — RETRACTED, not merely updated: a real parser tokenizes a regex literal as one
  // token regardless of its backtick count, so the old quote-desync-to-EOF limitation this check used to
  // document no longer exists; assert the now-FIXED behavior instead, never the retracted limitation.
  check("(C) FIXED: an odd-backtick-count regex (`` /`[^`]*`/g ``) no longer swallows anything after it — " +
    "a canary placed right after it is still found",
    scanText("const RE = /`[^`]*`/g;\n" + CANARY_SNIPPET).some((h) => h.subcommand === "merge-base" && !h.protectedCall));

  check("(C) `return [...]` is correctly read as an array literal, not a subscript",
    scanText(`function f() { return ["merge-base", a, "HEAD"]; }`)
      .some((h) => h.subcommand === "merge-base" && !h.protectedCall));
  check("(C) same for yield/typeof/case/in/of/await/throw/else/do, each wrapped in the syntax it actually " +
    "needs to be VALID (the real parser only ever reads an array literal in a position where one is " +
    "syntactically legal — there is no keyword list left to maintain for this)",
    [
      ["yield", `function* g() { yield ["merge-base", a, "HEAD"]; }`],
      ["typeof", `typeof ["merge-base", a, "HEAD"];`],
      ["case", `switch (x) { case ["merge-base", a, "HEAD"]: break; }`],
      ["in", `"x" in ["merge-base", a, "HEAD"];`],
      ["of", `for (const x of ["merge-base", a, "HEAD"]) {}`],
      ["await", `async function f() { await ["merge-base", a, "HEAD"]; }`],
      ["throw", `throw ["merge-base", a, "HEAD"];`],
      ["else", `if (cond) {} else ["merge-base", a, "HEAD"];`],
      ["do", `do ["merge-base", a, "HEAD"]; while (cond);`],
    ].every(([, snippet]) => scanText(snippet).some((h) => h.subcommand === "merge-base" && !h.protectedCall)));
  check("(C) NEGATIVE CONTROL: a REAL subscript (`myArr[i]`) is still read as element access, not an array " +
    "literal — there is no array literal node here at all",
    scanText(`myArr[i]("merge-base", someVar, "HEAD");`).length === 0);
  check("(C) NEGATIVE CONTROL: an identifier merely ENDING in a keyword's spelling (`undo`, not the whole " +
    "word `do`) is likewise just element access with a comma-sequence index — no array literal node",
    scanText(`undo["merge-base", a, "HEAD"];`).length === 0);

  check("(C) a backslash-escaped prefix that COOKS to a dash (`` `\\-${v}` `` evaluates to a leading `-`) " +
    "is not exempted — the raw prefix text carries a backslash, which is rejected outright",
    scanText("git.raw([\"merge-base\", \"HEAD\", `\\-${v}`]);").some((h) => h.subcommand === "merge-base" && !h.protectedCall));
  check("(C) same for a hex escape (`` `\\x2d${v}` ``, which also cooks to `-`)",
    scanText("git.raw([\"merge-base\", \"HEAD\", `\\x2d${v}`]);").some((h) => h.subcommand === "merge-base" && !h.protectedCall));
  check("(C) a template with something chained AFTER its own closing backtick " +
    "(`` `x${v}`.slice(1) ``) is not exempted — the array ELEMENT is a CallExpression, not a " +
    "TemplateExpression, so the qualified-template shape never matches it at all",
    scanText("git.raw([\"merge-base\", \"HEAD\", `x${v}`.slice(1)]);").some((h) => h.subcommand === "merge-base" && !h.protectedCall));
  check("(C) NO REGRESSION: an unqualified, unchained literal-prefix template is still exempt",
    scanText("git.raw([\"merge-base\", \"HEAD\", `refs/heads/${branch}`]);").length === 0);

  // @decision a4145c7a — new coverage this round added: GLOBAL_OPTS_WITH_VALUE (mirrored from bounded.ts)
  // and the simple-git typed `.revparse(...)` method.
  check("(C) NEW: a `-C <path>` leading global option is skipped, and the real subcommand after it is " +
    "still detected",
    scanText(`git.raw(["-C", somePath, "merge-base", someVar, "HEAD"]);`).some((h) => h.subcommand === "merge-base" && !h.protectedCall));
  check("(C) NEW: a bare leading flag with no value (`--no-pager`) is skipped too",
    scanText(`git.raw(["--no-pager", "log", someVar]);`).some((h) => h.subcommand === "log" && !h.protectedCall));
  check("(C) NEW: a `-C`/`--git-dir` VALUE that happens to equal a monitored subcommand's own name is " +
    "never misread as the subcommand — the SAME positional-collision bug bounded.ts's own round 6 " +
    "(card 62c4953a) fixed for its log redaction, now proven for THIS matcher too",
    (() => {
      const hits = scanText(`git.raw(["-C", "merge-base", "merge-base", someVar, "HEAD"]);`);
      return hits.length === 1 && hits[0].subcommand === "merge-base" && !hits[0].protectedCall;
    })());
  check("(C) NEW: a `--git-dir <path>` prefix doesn't eat the real --verify/--end-of-options markers that " +
    "follow the real subcommand — the call is still correctly PROTECTED",
    scanText(`git.raw(["--git-dir", gitDir, "rev-parse", "--verify", "--end-of-options", sha]);`).length === 0);
  check("(C) NEW: a `.revparse([...])` typed call with a bare positional and no markers is flagged for " +
    "rev-parse, even though the array itself never spells out the subcommand",
    scanText(`this.git.revparse(["--quiet", "--verify", sha]);`).some((h) => h.subcommand === "rev-parse" && !h.protectedCall));
  check("(C) NEW: the SAME `.revparse([...])` shape, fully protected (--verify AND --end-of-options), is " +
    "not flagged",
    scanText(`this.git.revparse(["--verify", "--end-of-options", sha]);`).length === 0);
  check("(C) NEW: an all-literal `.revparse([...])` call (the real corpus's own shape today) has nothing " +
    "risky and is never flagged",
    scanText(`this.git.revparse(["--quiet", "--verify", "HEAD"]);`).length === 0);
  check("(C) NEW NEGATIVE CONTROL: a `-c` option with no valid \"k=v\" pair after it halts the skip " +
    "entirely rather than guessing — \"-c\" itself is then checked as the (non-monitored) subcommand, so " +
    "nothing is flagged",
    scanText(`git.raw(["-c", someVar, "merge-base", riskyVar]);`).length === 0);

  // @decision 4b559feb — rev-list/diff joined MONITORED_SUBCOMMANDS; the same shapes above now apply to
  // both, plus the rev-list `--not` placement rule (see this file's own header).
  check("(C) 4b559feb: a bare-variable rev-list array with no --end-of-options is risky",
    scanText(`git.raw(["rev-list", "--count", someVar]);`).some((h) => h.subcommand === "rev-list" && !h.protectedCall));
  check("(C) 4b559feb: the SAME rev-list call with --end-of-options present is not flagged",
    scanText(`git.raw(["rev-list", "--count", "--end-of-options", someVar]);`).length === 0);
  check("(C) 4b559feb: a bare-variable diff array with no --end-of-options is risky",
    scanText(`git.raw(["diff", "--name-only", someVar, otherVar]);`).some((h) => h.subcommand === "diff" && !h.protectedCall));
  check("(C) 4b559feb: the SAME diff call with --end-of-options present is not flagged",
    scanText(`git.raw(["diff", "--name-only", "--end-of-options", someVar, otherVar]);`).length === 0);
  check("(C) 4b559feb: a combined range template with no literal prefix stays FLAGGED for rev-list too " +
    "(the matcher doesn't know the range shape is independently safe — see this file's header)",
    scanText("git.raw([\"rev-list\", \"--count\", `${a}..${b}`]);").some((h) => h.subcommand === "rev-list" && !h.protectedCall));
  check("(C) 4b559feb: rev-list `--not <ref>` with the marker placed right AFTER `--not` is PROTECTED " +
    "(this is the real, measured-correct placement — see computeOwedLanding's own call sites)",
    scanText(`git.raw(["rev-list", "--merges", \`\${base}..\${tip}\`, "--not", "--end-of-options", main]);`).length === 0);
  check("(C) 4b559feb: rev-list `--not <ref>` with NO marker at all is still flagged (the bare `main` " +
    "positional after --not is the real risk)",
    scanText(`git.raw(["rev-list", "--merges", \`\${base}..\${tip}\`, "--not", main]);`).some((h) => h.subcommand === "rev-list" && !h.protectedCall));
  check("(C) 4b559feb NEGATIVE CONTROL: an unrelated subcommand sharing rev-list's own prefix " +
    "(\"rev-list-foo\") is never flagged",
    scanText(`git.raw(["rev-list-foo", someVar]);`).length === 0);

  // @decision 5c23ade1 — POSITION, not mere presence: the four controls this card's own DoD names.
  check("(C) 5c23ade1 RED: the marker placed AFTER the risky positional no longer protects it (the old " +
    "presence-anywhere check used to pass this)",
    scanText(`git.raw(["rev-list", "--count", someVar, "--end-of-options"]);`).some((h) => h.subcommand === "rev-list" && !h.protectedCall));
  check("(C) 5c23ade1 RED: the SAME shape for a non-rev-list subcommand (merge-base) is also caught",
    scanText(`git.raw(["merge-base", someVar, "HEAD", "--end-of-options"]);`).some((h) => h.subcommand === "merge-base" && !h.protectedCall));
  check("(C) 5c23ade1 GREEN: the correct plain form — marker BEFORE the risky positional — still protects",
    scanText(`git.raw(["merge-base", "--end-of-options", someVar, "HEAD"]);`).length === 0);
  check("(C) 5c23ade1 RED: the marker placed BEFORE `--not` fails the whole call outright — it swallows " +
    "--not's own sign-flip semantics (card 4b559feb measured a corrupted result, not merely a missed " +
    "protection) — even though it technically precedes the earlier range positional too",
    scanText(`git.raw(["rev-list", "--merges", \`\${base}..\${tip}\`, "--end-of-options", "--not", main]);`).some((h) => h.subcommand === "rev-list" && !h.protectedCall));
  check("(C) 5c23ade1 GREEN: the correct --not form — marker right AFTER --not — stays protected " +
    "(restated from the 4b559feb controls above, naming this card's own DoD item explicitly)",
    scanText(`git.raw(["rev-list", "--merges", \`\${base}..\${tip}\`, "--not", "--end-of-options", main]);`).length === 0);
  check("(C) 5c23ade1: a risky element with NO --not at all is unaffected by the --not-aware branch " +
    "(no --not present, so the plain position rule alone decides) — marker after it stays flagged",
    scanText(`git.raw(["rev-list", "--count", someVar, "--end-of-options", "HEAD"]);`).some((h) => h.subcommand === "rev-list" && !h.protectedCall));

  // @decision 5c23ade1 — module-level const-array spread resolution.
  check("(C) 5c23ade1 RED: a subcommand named only inside a module-level const spread, with a risky " +
    "positional and no marker, is now VISIBLE and flagged (previously invisible: the scanner never found " +
    "a literal subcommand to classify against at all)",
    scanText(`const TEST_DIFF_FLAGS = ["diff", "--name-only"] as const;\ngit.raw([...TEST_DIFF_FLAGS, someVar]);`)
      .some((h) => h.subcommand === "diff" && !h.protectedCall));
  check("(C) 5c23ade1 GREEN: the SAME spread, with the marker correctly placed before the risky " +
    "positional, is protected",
    scanText(`const TEST_DIFF_FLAGS = ["diff", "--name-only"] as const;\ngit.raw([...TEST_DIFF_FLAGS, "--end-of-options", someVar]);`).length === 0);
  check("(C) 5c23ade1 GREEN: a spread carrying a leading global-option pair (mirrors the real " +
    "NAME_ONLY_DIFF_FLAGS corpus shape) still resolves the subcommand and protects correctly",
    scanText(`const TEST_FLAGS = ["-c", "core.quotePath=false", "diff", "--name-only", "--no-renames"] as const;\n` +
      `git.raw([...TEST_FLAGS, "--end-of-options", \`\${base}..\${ref}\`]);`).length === 0);
  check("(C) 5c23ade1 RED: the SAME leading-global-option spread shape with NO marker is flagged",
    scanText(`const TEST_FLAGS = ["-c", "core.quotePath=false", "diff", "--name-only", "--no-renames"] as const;\n` +
      `git.raw([...TEST_FLAGS, \`\${base}..\${ref}\`]);`).some((h) => h.subcommand === "diff" && !h.protectedCall));
  check("(C) 5c23ade1: a spread whose target array has ALL-literal elements and no risky positional at " +
    "all is still correctly never flagged (nothing risky to protect)",
    scanText(`const TEST_FLAGS = ["-c", "core.quotePath=false", "diff", "--name-only", "--no-renames"] as const;\n` +
      `git.raw([...TEST_FLAGS, "--cached", "HEAD"]);`).length === 0);
  check("(C) 5c23ade1 NEGATIVE CONTROL: a spread of an UNRESOLVABLE identifier (no module-level const " +
    "array declared for it in this text) is left exactly as before — unclassified, never flagged, since " +
    "the scanner still can't find a literal subcommand",
    scanText(`git.raw([...NOT_DECLARED_ANYWHERE, someVar]);`).length === 0);
  check("(C) 5c23ade1 NEGATIVE CONTROL: a module-level const array containing a NON-literal element is " +
    "NOT resolved (conservative — never guesses at a value it can't see in the text), so a spread of it " +
    "stays exactly as unclassified as an unresolvable spread (the declaration's own literal is deliberately " +
    "NOT a monitored subcommand, so it isn't independently flagged as its own, unrelated array-literal hit)",
    scanText(`const MIXED = ["not-a-subcommand", someOtherVar];\ngit.raw([...MIXED, someVar]);`).length === 0);
  check("(C) 5c23ade1: the dedicated known-safe `...CANONICAL_GIT_CONFIG_ARGS` spread is still handled by " +
    "its own exemption, never by the new const-array resolution, even when (hypothetically) a same-named " +
    "const WOULD otherwise resolve — it is never expanded",
    scanText(`const CANONICAL_GIT_CONFIG_ARGS = ["-c", "core.useReplaceRefs=false"];\n` +
      `spawn(resolveGitBinaryForSpawn(), [...CANONICAL_GIT_CONFIG_ARGS, "ls-tree", "-r", "--name-only", treeish]);`)
      .some((h) => h.subcommand === "ls-tree" && !h.protectedCall));

  // @decision 5c23ade1 — the two shape exemptions that keep the position rule from false-flagging a
  // legitimate, already-safe flag (or a flag's own consumed value) sitting before the marker.
  check("(C) 5c23ade1: a self-evident flag-shaped template (`--max-count=${n}`) before the marker needs " +
    "no position protection of its own, as long as SOME marker exists in the call",
    scanText("git.raw([\"log\", `--max-count=${n}`, \"--end-of-options\", `${a}..${b}`]);").length === 0);
  check("(C) 5c23ade1: ...but with NO marker anywhere, the SAME self-evident flag template stays flagged " +
    "(conservative: a call with zero protective infrastructure is never read as safe)",
    scanText("git.raw([\"log\", `--output=${x}`]);").some((h) => h.subcommand === "log" && !h.protectedCall));
  check("(C) 5c23ade1: a known value-consuming flag's own value (`log -n <count>`, the real " +
    "MERGED_LOOKUP_SCAN_LIMIT corpus shape) needs no position protection either, once some marker exists",
    scanText("git.raw([\"log\", `--format=${format}`, \"-n\", String(LIMIT), \"--end-of-options\", base]);").length === 0);
  check("(C) 5c23ade1 NEGATIVE CONTROL: the SAME `-n`-value shape for a DIFFERENT subcommand (merge-base, " +
    "which has no such flag) is NOT exempted — the exemption is deliberately keyed by subcommand",
    scanText(`git.raw(["merge-base", "-n", someVar, "--end-of-options", "HEAD"]);`).some((h) => h.subcommand === "merge-base" && !h.protectedCall));
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
    const hits = scanText(text, f);
    total += hits.length;
    for (const h of hits) {
      const entry = ALLOWLIST.find(([file, name]) => file === rel && name === h.subcommand);
      if (!entry) { offenders.push(`${rel} [${h.subcommand}] ${h.snippet}`); continue; }
      const key = `${rel}\u0000${h.subcommand}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    // EOF CANARY (kept per card a4145c7a's own DoD — see CANARY_SNIPPET's doc comment: now a whole-file
    // parse-and-scan sanity smoke, not a desync backstop; there is no known failure mode left for it to
    // catch, but it is cheap and still proves every real file parses and scans to its own end).
    const canaryHits = scanText(text + "\n" + CANARY_SNIPPET, f);
    if (!canaryHits.some((h) => h.subcommand === "merge-base" && !h.protectedCall)) canaryMisses.push(rel);
  }
  check(`(S) EOF CANARY: every scanned file's own parse+scan still reaches its own end (a risky call ` +
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
  ? "\n✅ ALL PASS — no unlisted bare-ref-positional site reaches merge-base/ls-tree/log/rev-parse/rev-list/diff unprotected"
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
