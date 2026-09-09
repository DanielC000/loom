# 85f62475 — /new's NO-OP guard stops empty-conversation spam from evicting real history

## Narrative

Card 85f62475: `startNewCompanionConversation` replaced the old delete-everything `clearAllCompanionMessages` with an archive-and-rotate model — closing the currently-open conversation and opening a fresh one, retaining every prior conversation's messages up to the retention cap, rather than deleting them.

The NO-OP GUARD (return early, without closing/opening anything, when the currently-open conversation has zero messages) exists because without it, a burst of "/new" with nothing sent between each invocation would mint a run of empty conversations. Those empty conversations are never surfaced in the history list (`listCompanionConversations` excludes them), but they would still each consume a retention slot — so "/new"-spam could silently evict real, browsable history to make room for conversations nobody will ever see. Reusing an already-empty open conversation instead of abandoning it closes that hole.

## Do not

- Do not remove the NO-OP GUARD to "simplify" the rotation — an empty conversation must be reused, not abandoned, or repeated "/new" invocations with nothing sent will silently evict real history to make room for conversations that are permanently invisible anyway.

## Source

Inline comment in `packages/daemon/src/db.ts` (`startNewCompanionConversation`'s doc comment). Relocated by card 4044e834 (tranche 2 on `db.ts`); no wording changed beyond joining wrapped lines.
