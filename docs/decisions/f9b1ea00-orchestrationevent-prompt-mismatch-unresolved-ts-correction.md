# f9b1ea00 — `prompt_mismatch_unresolved`'s fields, and the `ts`-is-give-up-not-write correction

## Narrative

Card f9b1ea00: `PtyHostEvents.onPromptMismatchUnresolved` fired — a "recognized replay" `[loom:prompt-mismatch]` detection (`packages/daemon/src/pty/host.ts`, the `UserPromptSubmit` mismatch detector's `replayedEntry !== undefined` branch) never resolved within `PROMPT_MISMATCH_RESOLVE_WINDOW_MS` — no later generation's own submission fused that gen's content back in whole. Distinct from `paste_length_loss`: that one fires when Loom never wrote the lost text at all (the human/raw-paste gap); this one fires when Loom DID write it and the engine's own echo mismatched it, and the follow-up window to prove it recovered has now elapsed.

`detail` carries `{ gen, writtenHash, reportedHash, intendedLen, recognizedGen, matchedLen, leadingRemainderLen, trailingRemainderLen }`, plus an OPTIONAL `messageExcerpt` (card a419a7e6) — present only when the host has set `LOOM_LOG_MESSAGE_CONTENT=1` (default OFF; see `isLogMessageContentEnabled`'s own doc), OMITTED entirely otherwise, never an empty placeholder. This is the durable audit trail for a mismatch whose own notice promised a follow-up either way but, until this card, only ever delivered on the SUCCESS half of that promise.

Card 280309d9 (the `ts` correction): this row's own `ts` (`OrchestrationEvent.ts`) IS THE GIVE-UP INSTANT, NOT THE WRITE INSTANT — `SessionService.handlePromptMismatchUnresolved` stamps `ts` at fire time, which is `PROMPT_MISMATCH_RESOLVE_WINDOW_MS` (a hard 600s) AFTER the mismatch was actually detected/written. Two independent parties both read `ts` as the write time and got every time-correlation they built on it wrong by exactly ten minutes, in the same direction, before this was documented anywhere. `detail` now ALSO carries `writtenAt: string | null` — the real Enter-write wall-clock instant for `gen` (ISO, or `null` if that generation's write was never recorded) — added so a reader can recover the true write time BY CONSTRUCTION instead of a manual, hash-keyed join against the daemon log's own `[prompt-echo]` line. `ts` itself is UNCHANGED and keeps meaning give-up time, exactly as before — `writtenAt` is an ADDED field, never a re-meaning of an existing one.

## Do not

- Do not read this event row's `ts` as the write instant — it is stamped 600s (`PROMPT_MISMATCH_RESOLVE_WINDOW_MS`) after the mismatch was actually detected/written. Use `writtenAt` for the real write time.
- Do not re-derive the write time via a manual hash-keyed join against the daemon log's `[prompt-echo]` line — `writtenAt` recovers it by construction.

## Source

Inline comment in `packages/shared/src/types.ts` (`OrchestrationEventKind`'s `prompt_mismatch_unresolved` case doc). Relocated by card 35d90c4e (tranche 1 on `packages/shared/src/types.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `//` comment markers stripped.
