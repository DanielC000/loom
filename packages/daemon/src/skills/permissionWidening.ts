import type { SkillPermissionVector } from "@loom/shared";

/**
 * THE ONE detector for permission-widening constructs in a SKILL.md. Pure text in, vector ids out —
 * no fs, no paths, no LOOM_HOME — so a bare `node test/*.mjs` scan can import it like the daemon does.
 * What each vector DOES is documented on `SkillPermissionVector` in `@loom/shared`; the measurements
 * behind it are card 28b2ca6f's probe report.
 *
 * @decision 87a51903 — disclose, never strip: nothing here may reject or rewrite a skill, and no
 * second copy of these patterns may exist. A human-written skill legitimately carries these; a
 * divergent hand-copied regex set would silently disagree about which skills are flagged.
 */

/**
 * The frontmatter block: only the FIRST `---`-delimited block, anchored at the very start of the file
 * — the same bound `skills/store.ts`'s own `descriptionOf()` uses, so "frontmatter" means exactly the
 * same bytes to both. A later `---` in the body (an ordinary markdown horizontal rule) is never
 * mistaken for a second frontmatter block.
 */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

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
    const key = line.match(/^([A-Za-z0-9_-]+):/)?.[1];
    if (key != null) keys.push(key.toLowerCase());
  }
  return keys;
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
 */
const INLINE_SHELL_RE = /(?<!`)!`[^`\n]+`/;

/** A fenced code block whose info string is a bare `!` (up to 3 leading spaces, per CommonMark). */
const FENCED_SHELL_RE = /^[ \t]{0,3}```!/m;

/**
 * Every permission-widening vector `content` carries, in a stable order (frontmatter keys first, then
 * body forms) so a caller can render or compare them without sorting. An empty array means the skill
 * is clean — the scan ran and found nothing.
 */
export function detectPermissionWidening(content: string): SkillPermissionVector[] {
  const found: SkillPermissionVector[] = [];
  const keys = topLevelFrontmatterKeys(content);
  if (keys.includes("allowed-tools")) found.push("allowed-tools");
  if (keys.includes("hooks")) found.push("hooks");
  if (INLINE_SHELL_RE.test(content)) found.push("shell-inline");
  if (FENCED_SHELL_RE.test(content)) found.push("shell-fenced");
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
