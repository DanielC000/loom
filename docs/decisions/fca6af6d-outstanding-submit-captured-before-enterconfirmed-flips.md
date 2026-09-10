# fca6af6d — `submitWasOutstanding` is captured BEFORE `enterConfirmed` flips true, a REVERSE-order race fix, follow-up to `b4b9b707`

## Narrative

Card `fca6af6d`: the `UserPromptSubmit` hook handler captures `submitWasOutstanding = !live.enterConfirmed` **before** the very next line flips `live.enterConfirmed = true`. That ordering is deliberate — it is the discriminator for what a non-null `live.pendingRawOwnerSubmit` means at this same hook:

- `submitWasOutstanding` false (no submit() was in flight when the hook fired) ⇒ this hook confirms a genuine raw-terminal-originated turn — `writeStdin`'s own Enter IS what started it — so any pending raw text should be attributed to it.
- `submitWasOutstanding` true (a submit()'s own Enter is what this hook is confirming) ⇒ any `pendingRawOwnerSubmit` seen here can only have raced in during the async gap between that submit() clearing the field and this hook actually firing (`submit()` is the sole writer that clears the field, and it clears it before writing a single byte — see `Live.pendingRawOwnerSubmit`'s own doc). It is a raced-in HUMAN line, but not this turn's own attestation — attributing it here would credit the agent-originated submit's turn with words the human typed for some other, possibly never-realized, turn.

The capture must happen strictly before the flip: reading `live.enterConfirmed` after the flip would always read `true`, destroying the very distinction the discriminator exists to make — a REVERSE-order bug this card fixed. `submitWasOutstanding` is then consulted again, later in the same hook, at the `b4b9b707` attribution check (`fresh && !submitWasOutstanding`) — freshness against `RAW_OWNER_SUBMIT_TTL_MS` alone is not sufficient; a fresh raced-in line still must not be credited to a submit-originated turn.

## Do not

- Do not move the `submitWasOutstanding` capture after the `enterConfirmed = true` assignment — it would always read `true` and destroy the discrimination between a genuine raw-terminal turn and a raced-in human line.
- Do not attribute `pendingRawOwnerSubmit` on freshness alone (see `b4b9b707`) — a fresh line raced in during a submit()'s own outstanding-Enter window must still be discarded, not attributed.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the `UserPromptSubmit` case in `deliverHook`), as of `main` `0cac46b89a9d2ad236117c355fb93d43f4f0f03f` (this tranche's starting HEAD). Extracted by card `7f448888` (tranche 19 on `pty/host.ts`). `fca6af6d` is re-cited later in the same hook at the `b4b9b707` attribution check; see that record for the consuming side.
