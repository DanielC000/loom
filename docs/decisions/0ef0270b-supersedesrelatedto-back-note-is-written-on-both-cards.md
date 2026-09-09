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
