# 267fd215 — Reject the HTML-entity title SHAPE at the write boundary, not the author

## Narrative

A title carrying an HTML entity (`&lt;id&gt;` typed where the author meant the literal `<id>`) has already shipped as a PERMANENT, unrewritable mainline commit subject once: commit `fe2c1c6b` ("feat(orchestration): add an explicit supersedes:&lt;id&gt; param to question_ask that auto-cancels the named prior pending ask") — a SOLO `worker_merge_confirm` uses a card's title VERBATIM as the squash commit subject, and that lands under this repo's do-not-rewrite-published-history rule.

Two independent origination events roughly 7 weeks apart, with no shared upstream escaping surface found (per the card's own sweep), mean an author-side fix can't be scoped to any one root cause. So this guard rejects the SHAPE at the write boundary regardless of origin, matching `MIN_SUBSTANTIAL_BODY_CHARS`-style guards elsewhere in this codebase: whole-call reject, explicit override.

`checkTitleHtmlEntities` deliberately checks ONLY named XML/HTML entities that could plausibly be an ACCIDENTAL escape of plain text (`<`, `>`, `&`, `"`) plus numeric entities — decimal (`&#60;`) or hex (`&#x3C;`), a real serializer output — never a broader "any `&...;`-shaped substring", so an ordinary title using `&` as a bare conjunction (never itself an entity) is untouched.

### False positive, by design, not a bug

A title genuinely ABOUT escaped HTML — e.g. this board's own `Release list shows literal &quot;Sub: &amp;mdash;&quot; when subs missing` — really does contain these entities on purpose, and decoding them would destroy the exact point of the title (it's reporting that literal entity text is rendering instead of the intended character). There is no cheap way to tell that case apart from an accidental artifact by pattern alone, so this guard does NOT try to guess intent — it rejects both by default and requires the caller to say which one it is via `allowHtmlEntities`. A caller who means it types the flag once; a caller who typed the entity by accident (the actual damage class here) gets the decoded suggestion instead of a permanent mainline artifact.

### `allow` is per-call, never persisted

`allow` is a PER-CALL parameter, never a persisted flag — nothing about a title's "I meant it" assertion is stored on the task (verified: no such column/field exists anywhere in `Task` or the `tasks` table). Card `f324e8fa`'s merge-boundary callers (`sessions/service.ts`'s pre-gate check, `git/worktrees.ts`'s squash-subject check) always pass `allow:false` for exactly that reason: there is no create-time override to honor OR ignore at merge time, only ever a fresh per-call `allow` a caller would have to supply — and the merge path has no caller-supplied flag to thread through.

## Do not

- Do not widen `TITLE_HTML_ENTITY_PATTERN` to match any `&...;`-shaped substring — it must stay scoped to entities that could plausibly be an accidental escape, so an ordinary `&` conjunction in a title is untouched.
- Do not try to distinguish an accidental entity from a title genuinely ABOUT escaped HTML by pattern alone — there is no cheap way to do this; the false positive is accepted by design and resolved via `allowHtmlEntities`.
- Do not persist an `allow`/"I meant it" flag on the task — `allow` stays per-call, and the merge-boundary callers have no caller-supplied flag to thread through even if one existed.

## Consequences

An HTML entity accidentally typed into a title can no longer ship as a permanent, unrewritable mainline commit subject — the guard rejects the shape at the write boundary regardless of how or why the entity got there, closing both known origination events without needing to trace either to a root cause.

## Source

Inline JSDoc in `packages/daemon/src/tasks/title-guard.ts`, above `TITLE_HTML_ENTITY_PATTERN`/`NAMED_HTML_ENTITY_DECODE` (lines 9-39 as of this tranche's HEAD, prior to compression). Wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed.
