# 1837a542 — opt-in auto-recycle of an exhausted Companion

Owner decision (Request 86d140d5, 2026-11-06): "Yes, as a per-Companion opt-in (default off)". Builds on `79e030d9` (the human-initiated recycle).

## What it is

`companion_config.auto_recycle_on_exhaustion` (default 0, additive `ADD COLUMN` migration; no index or FK references it). When ON and `ContextWatcher` finds the Companion exhausted, it calls the SAME `CompanionController.recycle()` the human `POST /api/companion/:sessionId/recycle` route calls (wired as the `recycleCompanion` dep in `index.ts`) — never a second implementation.

## Trust posture

- Written only by `PUT /api/companion/:sessionId/auto-recycle` (human loopback REST, Tier 0 like the lead-mode writer, no GET: the value rides the masked config read) via `Db.setCompanionAutoRecycle`. No MCP tool, no agent-shape validator accepts it; `upsertCompanionConfig` neither writes nor clears it, so the ordinary config PUT cannot flip it.
- The sweep in `companion-auto-recycle.mjs` pins this: only `db.ts` and `gateway/server.ts` name the setter, no `src/mcp` source and no built orchestration tool mentions auto-recycle.

## Episode and ordering rules

- Episode identity is the inbox notice id 62279e05 already uses. The attempt is claimed in app_meta (`companion_auto_recycle_claim:<session>` = notice id) BEFORE the recycle runs: at most one attempt per episode, no retry on any outcome (resolved failure, rejection, or a synchronous throw). A new episode files a new notice id, so it recycles again.
- A successful recycle already dismisses the "has run out of context" notice, so the watcher files a fresh, unread "was automatically recycled" notice (its title deliberately does not end in the exhaustion suffix, or the recycle's own dismissal sweep would remove it).
- A failure leaves the original notice open and files a SECOND, unread "could not be recycled automatically" notice. The notice store has no re-surface-on-edit, so a new row is how a changed message is put back in front of the owner.
- The owner's ONE chat message per episode waits for the outcome: "auto-recycled" on success, the ordinary "exhausted, press Recycle" on failure. While the recycle is deferred there is no chat message; the inbox notice (which says auto-recycle is waiting) is the only signal.

## Unfinished draft

`pty.isComposerDirty(id)` (the owner's raw-terminal draft, `composerLen > 0` — the very gate the message drain defers on, `deferForHumanDraft`) DEFERS the recycle with no upper bound: no claim, no recycle, no message; the next tick re-checks. An ABANDONED draft therefore holds auto-recycle off indefinitely — the owner can still press Recycle by hand. Never destroy a draft.

The first cut read `getComposerDirtyLen` instead, which is a different thing: characters Loom's own `submit()` may have stranded in the composer. It is not the owner's draft, so it let a half-typed owner message be recycled away and, when stale and non-zero, held auto-recycle off forever. `ContextPty` now `Pick`s `isComposerDirty` from `PtyHost` so a rename fails to compile, and `companion-auto-recycle-draft.mjs` drives a REAL host's `composerLen` through `writeStdin`.

## Recovery rules

- A failed attempt re-reads `contextExhaustedAt`: if the owner already recovered the Companion by hand, the outcome is `superseded` (event only; no notice, no message).
- A recovery retires both the exhaustion notice and the "could not be recycled automatically" notice (`isRetirableAssistantExhaustionTitle`, shared by the manual-recycle dismissal and the recovery sweep), never the "was automatically recycled" success record.
- Ending an episode clears the auto-recycle claim first (like the chat claim), so a notice left open across a recovery cannot silence the next episode's attempt.

## Do not

- Do not make the flag agent-writable or expose it on any MCP surface.
- Do not write the flag from `upsertCompanionConfig` or let the config PUT carry it.
- Do not retry a failed auto-recycle. Do not move the claim to after the recycle has started, and do not take it while the recycle is deferred for a draft.
- Do not add a second episode key; reuse the notice id.
- Do not defer on `getComposerDirtyLen`; the owner's draft is `isComposerDirty`.
- Do not auto-recycle through anything but `CompanionController.recycle` (it serializes on the controller chain and closes the trust window at the point of no return).
