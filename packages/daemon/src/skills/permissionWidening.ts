import type { SkillPermissionVector } from "@loom/shared";

/**
 * THE ONE detector for permission-widening constructs in a SKILL.md. Pure text in, vector ids out —
 * no fs, no paths, no LOOM_HOME — so a bare `node test/*.mjs` scan can import it like the daemon does.
 * What each vector DOES is documented on `SkillPermissionVector` in `@loom/shared`; the measurements
 * behind it are card 28b2ca6f's probe report.
 *
 * @decision 87a51903 — disclose, never strip: nothing HERE may reject or rewrite a skill, and no
 * second copy of these patterns may exist. `skills/permissionGuard.ts` (card 51a2462a) does the
 * agent-skill refuse/strip, importing the patterns exported below — this module still only detects.
 */

/**
 * Just the OPENING fence half of the frontmatter block: `---`, optional trailing whitespace (the
 * confirmed-accepted widening — see `FRONTMATTER_RE`'s own doc), then the line ending. Authored here as
 * its own regex (card 712148f1 round 2, NIT 6) rather than derived by slicing `FRONTMATTER_RE.source` up
 * to its first `(` — that slice was fragile (any future reordering of `FRONTMATTER_RE`'s own source text
 * would silently break it) and backwards: `FRONTMATTER_RE` below is now built FROM this constant instead.
 *
 * Exported so `frontmatterReadIncomplete` can test "did a frontmatter block open at all" independently
 * of whether it closed, without a second hand-rolled fence literal.
 */
export const FRONTMATTER_OPEN_RE = /^---[ \t]*\r?\n/;

/**
 * The frontmatter block: only the FIRST `---`-delimited block, anchored at the very start of the file
 * — the same bound `skills/store.ts`'s own `descriptionOf()` uses, so "frontmatter" means exactly the
 * same bytes to both. A later `---` in the body (an ordinary markdown horizontal rule) is never
 * mistaken for a second frontmatter block.
 *
 * @decision 712148f1 — the opening fence's `[ \t]*` tolerance is a confirmed-accepted widening, the
 * closing fence is deliberately NOT given the same `...`-as-closer tolerance (confirmed NOT accepted).
 *
 * Exported (card 51a2462a) so `skills/permissionGuard.ts` can locate the SAME block to strip a key out
 * of it, without a second hand-rolled fence pattern.
 *
 * The body+newline is wrapped as one OPTIONAL group (card 22813c50, N1): the opening fence's own `\r?\n`
 * already consumes the one newline separating adjacent `---`/`---` lines, so an EMPTY frontmatter block
 * (open and close on consecutive lines, no blank line between) has no second newline left for a
 * mandatory `\r?\n---` to match — without this, `FRONTMATTER_RE` could never match a genuinely empty
 * block, of any size, and `frontmatterReadIncomplete` would misreport it as never having closed.
 */
export const FRONTMATTER_RE = new RegExp(`${FRONTMATTER_OPEN_RE.source}(?:([\\s\\S]*?)\\r?\\n)?---`);

/** A single frontmatter line naming its top-level (column-0, unindented) YAML mapping key — see
 *  `topLevelFrontmatterKeys`'s own doc for why no leading whitespace is required.
 *
 *  @decision 712148f1 — the optional wrapping quote and optional whitespace before the colon are a
 *  fail-closed widening (unconfirmed acceptance), not a confirmed one; the two quote marks need not match.
 *
 *  Exported (card 51a2462a) so `skills/permissionGuard.ts` can walk the SAME block to find where a
 *  flagged key's lines start and end, using the identical key boundary this module's own detector uses. */
export const FRONTMATTER_KEY_LINE_RE = /^["']?([A-Za-z0-9_-]+)["']?[ \t]*:/;

/**
 * A key named inside a flow-mapping context — immediately preceded by `{` or `,` (optional whitespace),
 * optionally quoted, with optional whitespace before the colon — e.g. the `allowed-tools` in
 * `{name: x, allowed-tools: Bash}`. Deliberately NOT anchored to column 0 (a flow mapping packs several
 * keys onto one line); captures a key name generically rather than hardcoding the two known vector
 * names, so a future vector needs no change here.
 *
 * @decision 712148f1 — fail-closed widening for an unconfirmed acceptance, same posture as
 * FRONTMATTER_KEY_LINE_RE above. Exported for the same reuse reason as the other patterns here.
 */
export const FLOW_MAPPING_KEY_RE = /[{,][ \t]*["']?([A-Za-z0-9_-]+)["']?[ \t]*:/;

/**
 * Top-level (column-0, unindented) YAML mapping keys of a frontmatter block, lowercased. A bounded
 * line scan rather than a full YAML parse (no YAML parser is a dependency of this package), and
 * deliberately NOT a whole-file `/allowed-tools:/`-style match: scoping it to the real frontmatter
 * block is what keeps a skill whose BODY merely discusses these fields in prose from being flagged.
 * Requiring no leading whitespace is what keeps a nested key (`capabilities:\n  hooks: x`) — a
 * different field that merely shares a name — from counting as the top-level one.
 *
 * Lowercased deliberately, which is the one place this over-reports: YAML keys are case-sensitive, so
 * `Allowed-Tools:` is inert to Claude Code, yet it is reported here. That direction is the right one
 * for both readers — a disclosure that names an inert lookalike costs a sentence, while a miss costs
 * the whole point — and the sibling bundled-asset lint wants a lookalike surfaced for review anyway.
 */
function topLevelFrontmatterKeys(content: string): string[] {
  const block = content.match(FRONTMATTER_RE)?.[1];
  if (block == null) return [];
  const keys: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    const key = line.match(FRONTMATTER_KEY_LINE_RE)?.[1];
    if (key != null) keys.push(key.toLowerCase());
  }
  return keys;
}

/** Every `FLOW_MAPPING_KEY_RE` match inside the frontmatter block, lowercased — see that pattern's own
 *  doc. A separate scan from `topLevelFrontmatterKeys` above: a flow-mapping key is not anchored to
 *  column 0, so it needs its own (non-anchored, global) pass over the block rather than a per-line test.
 *
 *  Gated on the block containing a literal `{` at all: `FLOW_MAPPING_KEY_RE`'s own `,`-led branch (for
 *  every key AFTER the first in a mapping) has no way to require that comma sit inside braces without a
 *  stateful scan — so without this gate, an ORDINARY line whose plain scalar value merely contains a
 *  comma (`name: x, hooks: not a key`) would false-positive with no flow mapping present anywhere. A
 *  real flow mapping always opens with `{`, so requiring one bounds this to "the block at least LOOKS
 *  like it contains a flow mapping somewhere" — it does not prove the specific comma matched is inside
 *  one (card 712148f1's own residual: a flow mapping whose quoted STRING VALUE itself contains a
 *  `, hooks:`-shaped substring still over-matches) — over-inclusion once a `{` is present is accepted,
 *  per 87a51903's "a lookalike costs a sentence" posture; a block with NO `{` anywhere gets none of it. */
function flowMappingFrontmatterKeys(content: string): string[] {
  const block = content.match(FRONTMATTER_RE)?.[1];
  if (block == null || !block.includes("{")) return [];
  const re = new RegExp(FLOW_MAPPING_KEY_RE.source, "g");
  const keys: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) {
    const key = m[1];
    if (key != null) keys.push(key.toLowerCase());
  }
  return keys;
}

/**
 * A plain, column-0 top-level YAML mapping line: a BARE (never quoted) key, optional whitespace, a
 * colon, and whatever follows. The strict, allowlist counterpart to `FRONTMATTER_KEY_LINE_RE` above —
 * that pattern stays quote-tolerant for per-key LABELING (so a quoted `allowed-tools`/`hooks` key is
 * still named in a disclosure/refusal), while THIS one decides whether a line's own SHAPE is one the
 * allowlist below recognizes at all. A quoted key fails this on purpose (card 712148f1 round 2 — see
 * `frontmatterUnrecognizedSyntax`'s own doc).
 *
 * @decision 712148f1 (round 2) — exported so `skill-permission-widening-guard.mjs`'s own lockstep test
 * can assert its text copy never drifts from this one.
 */
export const PLAIN_TOP_LEVEL_KEY_LINE_RE = /^([A-Za-z0-9_-]+)[ \t]*:(.*)$/;

/** A column-0 YAML block-sequence item (`- foo`, or a bare `-` with nothing after it) — allowlist form
 *  (iii): valid only directly after a top-level key whose own value was empty (e.g. `tags:` followed by
 *  `- a`/`- b` at column 0, rather than indented under it). See `frontmatterUnrecognizedSyntax`. */
export const SEQUENCE_ITEM_RE = /^-(?:[ \t]|$)/;

/** A plain top-level line's VALUE starting with a YAML anchor (`&`), alias (`*`), or tag (`!`) indicator
 *  — one of the explicit "anything else" rejects named by card 712148f1 round 2's allowlist decision,
 *  checked only once a line has already matched `PLAIN_TOP_LEVEL_KEY_LINE_RE`'s own key/colon shape. */
export const FRONTMATTER_VALUE_START_FORBIDDEN_RE = /^[&*!]/;

/** A leading UTF-8 BOM (U+FEFF). */
export const BOM = "﻿";

/**
 * Splits off a leading UTF-8 BOM (U+FEFF), if present. Every pattern in this module is anchored at the
 * literal start of the string (`FRONTMATTER_OPEN_RE`'s `^---`), so a BOM ahead of a real `---` block
 * would otherwise hide it from every detector here. A SINGLE BOM is confirmed honoured by the real CLI
 * loader too (card 22813c50's static scan, card 9d01b4c1's decision record) — a SECOND (or further)
 * leading BOM is NOT honoured by that same real path, so this function deliberately strips only one.
 *
 * `detectPermissionWidening`, `frontmatterReadIncomplete`, and `frontmatterUnrecognizedSyntax` each call
 * this INTERNALLY before scanning (card 9d01b4c1 round 2) — the invariant lives in the shared detector
 * itself, so no call site (present or future) can forget to split first and silently read a BOM-prefixed
 * file as clean. Splitting twice is harmless: a body with no BOM round-trips unchanged. Still exported
 * for a caller that needs the body AND whether a BOM was present, to do something with that fact —
 * `permissionGuard.ts`'s strip path strips from the body, then re-prepends the BOM onto the result.
 *
 * @decision 9d01b4c1 — THE one shared BOM-split helper; do not hand-roll a second copy at a call site.
 */
export function splitLeadingBom(content: string): { body: string; hasBom: boolean } {
  const hasBom = content.startsWith(BOM);
  return { body: hasBom ? content.slice(BOM.length) : content, hasBom };
}

/**
 * True when `content`'s frontmatter block contains a line whose YAML syntax this module's own allowlist
 * does not recognize — i.e. anything other than: (i) a plain top-level `key: value` line (bare key,
 * `PLAIN_TOP_LEVEL_KEY_LINE_RE`, value not starting with `&`/`*`/`!`); (ii) a line with leading
 * whitespace, continuing whatever top-level key preceded it; or (iii) a column-0 `SEQUENCE_ITEM_RE` line
 * directly continuing a key whose own value was empty. A blank line or a column-0 `#` comment is always
 * neutral (neither opens nor continues anything). False when there is no frontmatter block at all.
 *
 * @decision 712148f1 (round 2) — a fail-closed ALLOWLIST, never widen this back into a denylist of named
 * YAML key shapes (quoted/explicit/tagged/merge key, …) — that enumeration cannot converge.
 *
 * Boring shapes a real doctrine skill's frontmatter actually uses pass; anything else is fail-closed,
 * regardless of whether it happens to also NAME `allowed-tools`/`hooks`. `detectPermissionWidening`
 * folds this in as the `frontmatter-unrecognized` vector; `stripPermissionWidening` withholds the whole
 * file rather than attempt to strip just the one non-allowlisted line (see that function's own doc).
 */
export function frontmatterUnrecognizedSyntax(content: string): boolean {
  const { body } = splitLeadingBom(content);
  const block = body.match(FRONTMATTER_RE)?.[1];
  if (block == null) return false;
  let prevTopLevelKeyEmpty = false;
  let seenTopLevelKey = false;
  for (const line of block.split(/\r?\n/)) {
    if (line.trim() === "" || line.startsWith("#")) continue; // always neutral: blank, column-0 comment
    if (/^[ \t]/.test(line)) {
      // (ii) — but ONLY a genuine continuation of a top-level key already seen. In YAML the root block
      // may itself be indented (card 712148f1 round 3, MAJOR 1), so an indented line with NO preceding
      // top-level key is not continuing anything — it is "anything else", same as a quoted/flow/explicit/
      // tagged/merge-key line below, never a blanket "any indentation is neutral" exemption.
      if (seenTopLevelKey) continue;
      return true;
    }
    if (SEQUENCE_ITEM_RE.test(line)) {
      if (prevTopLevelKeyEmpty) continue; // (iii)
      return true;
    }
    const m = line.match(PLAIN_TOP_LEVEL_KEY_LINE_RE);
    if (!m) return true; // anything else: quoted key, flow mapping (`{`/`[` in key position), explicit
    // key (`?`), tagged key (`!!str`), merge key (`<<`), a stray `...`/`---`, etc.
    seenTopLevelKey = true;
    const value = (m[2] ?? "").trim();
    prevTopLevelKeyEmpty = value === "";
    if (value !== "" && FRONTMATTER_VALUE_START_FORBIDDEN_RE.test(value)) return true; // anchor/alias/tag value
  }
  return false;
}

/**
 * True when `content` OPENS a frontmatter block (`---` at the very start, after a leading BOM is split
 * off — see `splitLeadingBom`, called internally, card 9d01b4c1 round 2) but its own CLOSING fence is
 * not found anywhere in `content` — i.e. a reader that only has `content` (e.g. a byte-capped read)
 * cannot be sure it saw the whole block. False for a file with no frontmatter at all (nothing to miss)
 * AND for a file whose frontmatter closes well within `content` even if the file continues on with an
 * arbitrarily large, unrelated body afterward — only the block's OWN completeness matters here, not the
 * file's total size.
 *
 * Reuses this module's own `FRONTMATTER_RE` — never a second hand-rolled fence pattern (card 87a51903).
 *
 * @decision 015fdb23 — never report a byte-capped read as truncated merely because the FILE is larger
 * than the cap; only a frontmatter block that itself didn't close within what was read carries risk.
 */
export function frontmatterReadIncomplete(content: string): boolean {
  const { body } = splitLeadingBom(content);
  return FRONTMATTER_OPEN_RE.test(body) && !FRONTMATTER_RE.test(body);
}

/**
 * An inline `` !`cmd` `` shell injection in the body.
 *
 * The `(?<!`)` lookbehind is load-bearing, not cosmetic: without it, ordinary prose that merely
 * DISCUSSES the backtick character — e.g. "the `!` character, like `ls`" — false-positives, because
 * that text contains the literal two-character substring "!`" (the closing backtick of the FIRST code
 * span sits directly after the "!"), and the following non-backtick run then a backtick from the
 * SECOND, unrelated code span satisfies the rest of a naive pattern. Requiring the "!" itself NOT be
 * preceded by a backtick rules this out: in genuine `` !`cmd` `` syntax the "!" sits OUTSIDE any code
 * span, immediately before the one it opens — never immediately after one that just closed.
 *
 * Exported (card 51a2462a) so `skills/permissionGuard.ts` can strip the SAME construct it detects,
 * without a second hand-rolled pattern.
 */
export const INLINE_SHELL_RE = /(?<!`)!`[^`\n]+`/;

/** A fenced code block whose info string is a bare `!`.
 *
 *  @decision 712148f1 — NOT anchored to a line start: the installed CLI's own trigger regex has no such
 *  anchor, so an indented/blockquoted/mid-line ` ```! ` is confirmed live there and must be detected here.
 *
 *  Exported (card 51a2462a) — see `INLINE_SHELL_RE`'s own export note just above. */
export const FENCED_SHELL_RE = /```!/;

/**
 * Every permission-widening vector `content` carries, in a stable order (frontmatter keys first, then
 * body forms) so a caller can render or compare them without sorting. An empty array means the skill
 * is clean — the scan ran and found nothing.
 */
export function detectPermissionWidening(content: string): SkillPermissionVector[] {
  const { body } = splitLeadingBom(content);
  const found: SkillPermissionVector[] = [];
  const keys = [...topLevelFrontmatterKeys(body), ...flowMappingFrontmatterKeys(body)];
  if (keys.includes("allowed-tools")) found.push("allowed-tools");
  if (keys.includes("hooks")) found.push("hooks");
  // card 9d01b4c1 round 2 / card 22813c50 — pass the ORIGINAL `content`, not the already-split `body`:
  // frontmatterUnrecognizedSyntax self-splits internally too, so feeding it `body` here double-strips a
  // double-BOM input, disagreeing with the `topLevelFrontmatterKeys`/`flowMappingFrontmatterKeys` checks
  // just above (which never self-split and so only ever see the ONE strip done here).
  if (frontmatterUnrecognizedSyntax(content)) found.push("frontmatter-unrecognized");
  if (INLINE_SHELL_RE.test(body)) found.push("shell-inline");
  if (FENCED_SHELL_RE.test(body)) found.push("shell-fenced");
  return found;
}

/**
 * The response FIELD for a skill's detection result, as an object to spread.
 *
 * Shared by `listSkills()` and the gateway's single-skill read so the two can never disagree about
 * the key name or about the omit-when-clean convention: the key is ABSENT for a clean skill rather
 * than present-and-empty, matching how `SkillSummary` already omits `provenance`/`customized` where
 * they don't apply, and keeping a clean skill's response byte-identical to what it was before this
 * field existed.
 */
export function permissionWideningField(content: string): { permissionWidening?: SkillPermissionVector[] } {
  const found = detectPermissionWidening(content);
  return found.length ? { permissionWidening: found } : {};
}
