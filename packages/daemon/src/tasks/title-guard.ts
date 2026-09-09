// Card 267fd215 / f324e8fa — the SHARED HTML-entity-in-title predicate. Deliberately a LEAF module (no
// internal imports) so it can be reused from BOTH sides of a would-be import cycle: `mcp/tasks.ts` (the
// WRITE boundary — createProjectTaskChecked/updateProjectTask) already imports from `git/worktrees.ts`
// (getTaskMergedInfo), so `git/worktrees.ts` (the MERGE boundary's actual subject-construction site,
// card f324e8fa) cannot import this predicate back FROM `mcp/tasks.ts` without a cycle. Living here lets
// every caller — the write boundary, `sessions/service.ts`'s pre-gate merge check, and
// `git/worktrees.ts`'s squash-subject check — share the ONE pattern instead of each re-deriving it.

/**
 * Card 267fd215 — a SOLO `worker_merge_confirm` uses a card's title VERBATIM as the squash commit
 * subject, and that lands in mainline history under this repo's do-not-rewrite-published-history rule.
 * A title carrying an HTML entity (`&lt;id&gt;` typed where the author meant the literal `<id>`) has
 * already shipped this way once (commit `fe2c1c6b`, unrewritable). Two independent origination events
 * ~7 weeks apart with no shared upstream escaping surface found (see the card's own sweep) mean an
 * author-side fix can't be scoped — so this guard rejects the SHAPE at the write boundary regardless of
 * origin, matching MIN_SUBSTANTIAL_BODY_CHARS-style guards elsewhere: whole-call reject, explicit override.
 *
 * Deliberately checks ONLY named XML/HTML entities that could plausibly be an ACCIDENTAL escape of plain
 * text (`<`, `>`, `&`, `"`) plus numeric entities — decimal (`&#60;`) or hex (`&#x3C;`), a real serializer
 * output — never a broader "any `&...;`-shaped substring", so an ordinary title using `&` as a bare
 * conjunction (never itself an entity) is untouched.
 *
 * ⚠️ FALSE POSITIVE, BY DESIGN, NOT A BUG: a title genuinely ABOUT escaped HTML — e.g. this board's own
 * `Release list shows literal &quot;Sub: &amp;mdash;&quot; when subs missing` — really does contain these
 * entities on purpose, and decoding them would destroy the exact point of the title (it's reporting that
 * literal entity text is rendering instead of the intended character). There is no cheap way to tell that
 * case apart from an accidental artifact by pattern alone, so this guard does NOT try to guess intent —
 * it rejects both by default and requires the caller to say which one it is via `allowHtmlEntities`. A
 * caller who means it types the flag once; a caller who typed the entity by accident (the actual damage
 * class here) gets the decoded suggestion instead of a permanent mainline artifact.
 *
 * ⚠️ `allow` is a PER-CALL parameter, never a persisted flag — nothing about a title's "I meant it"
 * assertion is stored on the task (verified: no such column/field exists anywhere in `Task` or the
 * `tasks` table). Card f324e8fa's merge-boundary callers (`sessions/service.ts`'s pre-gate check,
 * `git/worktrees.ts`'s squash-subject check) always pass `allow:false` for exactly that reason: there is
 * no create-time override to honor OR ignore at merge time, only ever a fresh per-call `allow` a caller
 * would have to supply — and the merge path has no caller-supplied flag to thread through. See those
 * call sites' own docs for why one must not be ADDED there.
 */
const TITLE_HTML_ENTITY_PATTERN = /&(lt|gt|amp|quot|#(?:\d+|[xX][0-9a-fA-F]+));/;
const NAMED_HTML_ENTITY_DECODE: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"' };
/** The highest valid Unicode code point — {@link decodeKnownHtmlEntities}'s bound against a numeric
 *  entity whose value `String.fromCodePoint` would throw on (card 267fd215 code review: `Number.isFinite`
 *  alone let `&#999999999;` through and threw a RangeError instead of falling back to `match`, turning a
 *  guard whose entire job is a clean `{error}` into an unhandled exception). */
const MAX_UNICODE_CODE_POINT = 0x10ffff;

/** Best-effort decode of the entities {@link TITLE_HTML_ENTITY_PATTERN} recognizes, for the "did you mean"
 *  suggestion in {@link checkTitleHtmlEntities}'s error — never used to silently rewrite a stored title. */
function decodeKnownHtmlEntities(s: string): string {
  return s.replace(new RegExp(TITLE_HTML_ENTITY_PATTERN.source, "g"), (match, name: string) => {
    if (name.startsWith("#")) {
      const numeric = name.slice(1);
      const isHex = numeric[0] === "x" || numeric[0] === "X";
      const code = isHex ? parseInt(numeric.slice(1), 16) : Number(numeric);
      return Number.isInteger(code) && code >= 0 && code <= MAX_UNICODE_CODE_POINT ? String.fromCodePoint(code) : match;
    }
    return NAMED_HTML_ENTITY_DECODE[name] ?? match;
  });
}

/**
 * Rejects (returns `{error, match, decoded}`) a title/subject carrying an HTML entity unless `allow` is
 * explicitly true. See the doc above this pattern for why a false positive on a title genuinely ABOUT
 * escaping is accepted rather than guessed around, and why `allow` exists. Returns `null` (no rejection)
 * when the string is clean OR `allow` was passed.
 *
 * `match`/`decoded` (card f324e8fa Code Review follow-up) are the STRUCTURED pieces behind `error`'s
 * write-boundary-specific prose (which names `allowHtmlEntities` — a real param at the write boundary,
 * but NOT one `worker_merge_confirm` accepts). A caller whose own remedy differs from "pass
 * allowHtmlEntities:true" — the merge boundary's remedy is "retitle the card," full stop — composes its
 * OWN message from these fields instead of embedding `error` verbatim, so it never tells an operator to
 * retry with a flag that call never threads through.
 */
export function checkTitleHtmlEntities(title: string, allow: boolean | undefined): { error: string; match: string; decoded: string } | null {
  if (allow) return null;
  const match = title.match(TITLE_HTML_ENTITY_PATTERN);
  if (!match) return null;
  const decoded = decodeKnownHtmlEntities(title);
  return {
    match: match[0],
    decoded,
    error: `title contains an HTML entity ("${match[0]}") — a SOLO merge uses the card title VERBATIM as ` +
      `the squash commit subject, so this would become a PERMANENT, unrewritable mainline artifact ` +
      `(this has already happened once: commit fe2c1c6b). Did you mean: "${decoded}"? If this title is ` +
      `genuinely ABOUT escaped HTML — not an accidental artifact — retry with allowHtmlEntities:true.`,
  };
}

/**
 * Card 3a833d94 — the SINGLE source of truth for the Conventional Commits types Loom recognizes. Was a
 * hand-copied local const in `git/worktrees.ts` (the ONLY prior code-level copy, used to build its own
 * `toConventionalSubject` coercion regex); moved here and re-exported so `git/worktrees.ts` reads it
 * back rather than the two ever drifting into independent lists. `CLAUDE.md`'s Conventional Commits
 * section documents the SAME list in prose — this array is the code mirror of that prose, not a second
 * independent policy, and there is deliberately no third copy anywhere (this file's own scope check below
 * reuses it too).
 */
export const CONVENTIONAL_TYPES = [
  "feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore", "revert",
] as const;

/**
 * Shape of a title that READS as a Conventional Commits subject — a leading lowercase-and-hyphens word,
 * optional `(scope)`, optional `!`, then `: ` and some content — WITHOUT regard to whether that leading
 * word is actually one of {@link CONVENTIONAL_TYPES}. Deliberately narrower than "any word before a
 * colon": requiring an all-lowercase (hyphens allowed) leading token is what lets `design(pty): …` (the
 * card 3a833d94 specimen) match while ordinary prose beginning with a capitalized word and a colon (e.g.
 * "Note: this still needs…") does NOT — that's the "no prefix at all" case {@link checkTitleConventionalType}
 * must never touch (the bare-prose → `chore:` coercion net at merge time already handles it correctly, and
 * two legitimate non-work cards on this board rely on that).
 */
const TYPE_PREFIXED_TITLE_RE = /^([a-z][a-z-]*)(?:\([^)]*\))?!?: .+/;

/**
 * Card 3a833d94 — rejects (returns `{error, type, allowed}`) a title carrying a `type(scope):`-shaped
 * prefix whose `type` is NOT one of {@link CONVENTIONAL_TYPES}, unless `allow` is explicitly true. Mirrors
 * {@link checkTitleHtmlEntities}'s shape exactly (same escape-hatch convention, same "never silently
 * rewrite" posture) — this is the SAME argument (card 267fd215) applied to a second way a SOLO merge's
 * verbatim-title-as-squash-subject turns an authoring slip into permanent mainline history: a title typed
 * as `design(pty): …` is not bare prose to the merge-time coercion net (`toConventionalSubject`,
 * `git/worktrees.ts`) — it already LOOKS conventional, so the net leaves it untouched-but-invalid rather
 * than fixing it, and a caller who never inspects the merge review's `coerced`/`commitSubject` fields (as
 * this card's own filer very nearly didn't) ships it as-is.
 *
 * Returns `null` (no rejection) when the title has NO type-shaped prefix at all (a different, already-
 * handled case — see the doc above {@link TYPE_PREFIXED_TITLE_RE}), when the prefix's type IS allowed, or
 * when `allow` was passed.
 */
export function checkTitleConventionalType(
  title: string, allow: boolean | undefined,
): { error: string; type: string; allowed: readonly string[] } | null {
  if (allow) return null;
  const match = TYPE_PREFIXED_TITLE_RE.exec(title.trim());
  if (!match) return null;
  const type = match[1]!;
  if ((CONVENTIONAL_TYPES as readonly string[]).includes(type)) return null;
  return {
    type,
    allowed: CONVENTIONAL_TYPES,
    error: `title's leading "${type}:" is not a recognized Conventional Commits type — a SOLO merge uses ` +
      `the card title VERBATIM as the squash commit subject, and an unrecognized type is invisible to the ` +
      `merge-time coercion net (it only fixes BARE prose, not an already type-shaped-but-invalid prefix), ` +
      `so this would ship as a permanent mainline artifact with a bogus type. Allowed types: ` +
      `${CONVENTIONAL_TYPES.join(", ")}. Pick one of those, drop the "type:" prefix entirely, or retry ` +
      `with allowNonConventionalType:true if this is deliberate.`,
  };
}
