# 0ef0270b — a supersedes/relatedTo relationship is back-noted on the loser card too (m7)

## Narrative

A `supersedes`/`relatedTo` relationship, recorded by `createProjectTaskChecked`, is written on BOTH
cards, not just the new one — the superseded/related (loser) card's body is back-noted with a pointer to
the new card ("Superseded by: <id>" / "Related to: <id>") once the create actually succeeds. Without
this, only the new card names the relationship; a reader who lands on the loser card directly (the exact
failure mode card `5b221bf2` was filed about) has no way to discover it's been superseded.

The back-note write happens strictly AFTER the new card is created — if the create itself failed, no
back-note is written for a card that doesn't exist. A race with the target being deleted between
resolution and insert isn't possible: this function is synchronous end-to-end — no `await` between
`resolveProjectTaskId` and `createProjectTask`, and better-sqlite3 is sync — so nothing can interleave
between them; this stops being true the day this function gains an `await` in that span.

The back-note `db.updateTask` call's result is NOT inspected — a failed update here degrades to a
one-directional link (visible on read: the new card's body still names the target, just not vice versa)
rather than silently losing the relation entirely, but it is not itself checked or retried.

## Do not

- Do not add an `await` between `resolveProjectTaskId` and `createProjectTask` in this function without
  re-checking this race-freedom argument — it currently holds only because the span is synchronous
  end-to-end.
- Do not skip the back-note write, and do not treat its failure as fatal to the create — it degrades to a
  one-directional link, which is acceptable; losing the relation entirely is not.

## Source

Inline JSDoc in `packages/daemon/src/mcp/tasks.ts` (`createProjectTaskChecked`'s own doc, lines 934-946
as of this tranche's HEAD).

## Decision B (unrelated decision, same card id, `mcp/duplicateDetection.ts`) — HISTORICAL: coincidental code-landmark/convention false-positive class, CLOSED by card `b6eab182`

### Narrative

A second, distinct false-positive class in the cross-channel duplicate-card detector (card `5b221bf2`), measured against the real ~1687-card board: two cards about SUBSTANTIVELY UNRELATED work could share a code LANDMARK (a `file.ts:line` each cited for its own unrelated reason) or an established, codebase-wide CONVENTION name (a shared pattern/field name used correctly by two unrelated features) — neither card citing the other's id, a coincidental-landmark collision rather than a citation. Two real specimen pairs illustrated it: `166e3536` (a Platform Lead singleton bug) flagged against `f3917f96` (an unrelated graphify A/B spike) on a shared symbol + shared `service.ts:490`; `fae919b3` (a PresetForm `meta.inlineError` bug) flagged against `378d250b` (an unrelated companion-create-flow code review) on shared `inlineError`/`MutationCache` vocabulary.

Two rounds of measurement (this card, `0ef0270b`: 8.5% raw-flag rate, 5×40-card draws, n=200 pooled; card `abdaecda`'s re-measure: 10.0%, same methodology) each found this class deliberately NOT tuned around — reported as an intended `allowDuplicate`/`relatedTo`-correctable edge case rather than narrowed, because a false negative was judged worse than a false positive at the time.

Card `b6eab182` revisited that judgment call: those measurements were synthetic sampled draws (n=200, 2.5%–15% per-draw range); 5 REAL spurious create-blocks in live usage — this exact class, e.g. matching on a bare `workerlabel` field name + `sessions/service.ts:3341` — was a different order of evidence. Requiring a STRONG identifier for every match (see the `b6eab182` record) makes this whole class of match STRUCTURALLY IMPOSSIBLE now, not merely de-prioritized — there is no longer a "weak-only match" shape for a coincidental landmark/convention to produce.

### Source (this section only)

Inline JSDoc in `packages/daemon/src/mcp/duplicateDetection.ts` (`findSuspectedDuplicate`'s own doc, "SECOND DISCLOSED LIMITATION" section, lines 195-213 as of this tranche's HEAD, prior to compression).
