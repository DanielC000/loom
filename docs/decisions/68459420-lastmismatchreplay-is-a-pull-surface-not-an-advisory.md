# 68459420 — `lastMismatchReplay` is a manager-facing PULL surface, not an advisory notice

## Narrative

Card `68459420` (sender-directed arm for `[loom:prompt-mismatch]`): `Live.lastMismatchReplay` is set the instant a mismatch is identified as a REPLAY of a prior generation — `reported` matched an entry in `recentWrittenTurns` byte-for-byte. A recipient can never verify this half itself (it only ever sees what arrived, not what was intended for it) — this is a PULL surface (`getLastMismatchReplay`) for the party who CAN act, read at the point it already looks (`worker_list`/`worker_status`), rather than a longer session-facing notice: a precondition at the point of use beats an advisory in the attention path (see pinned memory `shipping-a-detector-is-not-someone-reading-it`).

Deliberately never cleared once set — a manager that hasn't yet looked should still see it on a LATER read; this is a discovery aid, not a live/transient flag, and overwritten (not accumulated) on a subsequent occurrence.

This field is one of the FOUR sibling candidates (alongside `lastMismatchFusion`/`lastMismatchUnmatched`/`lastPasteTripwireGiveUp`) `sessions/service.ts`'s `composerIntegrityWarning` reads and surfaces together at `worker_merge_confirm` time — see card `e1ac691b`'s own record for that surfacing's full design.

### DoD-3 — a fourth, uncharacterized population

A Platform sweep (2026-08-05) found a FOURTH mismatch population outside the three characterized elsewhere in this file: `reported` LONGER than `intended` AND matching NO recent write of this session (first specimen: gen=12, wrote 2985 reported 3829). Characterize it ONLY — tag it (`[prompt-mismatch-unmatched-longer]`) so it can be swept and counted, exactly like the replay shape's own sweep tag. Do NOT fold it into the replay shape (it explicitly failed the replay match) and do NOT invent a suppression for it: this population is not yet understood, and card `cf2fef73`'s own precedent (refusing to guess at the form-feed specimen, card `2b57b5a9`) applies here too. Gated on `!accumulation?.confirmed && !divergedPriorAccumulation` (Code Reviewer MEDIUM / card `d005f55b`) — left unguarded, every confirmed fusion or diverged-prior fusion is, by construction, ALSO `reported.length > intended.length` with no `recentWrittenTurns` match, and would inflate this UNCHARACTERIZED count for a shape the `[composer-accumulation]`/`[composer-accumulation-diverged-prior]` sweep lines already have a full, hash-confirmed answer for — a Platform sweep grepping/counting the `[prompt-mismatch-unmatched-longer]` tag to gauge whether this population needs its own card would otherwise be counting events this file already fully answers.

## Do not

- Do not clear this field once set, or add a TTL/expiry to it — a manager who hasn't yet looked must still be able to see it on a later read.
- Do not replace this pull surface with a session-facing notice alone — a precondition at the point of use is the design, not the advisory.
- Do not fold the fourth, uncharacterized "reported longer, unmatched" population into the replay-of-immediately-preceding-generation shape, or invent a suppression for it — it is not yet understood.
- Do not count a confirmed fusion or diverged-prior fusion toward the uncharacterized-population tag — both are, by construction, also "reported longer, no ring match", and the sweep lines their own branches already log answer for them fully.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the `Live.lastMismatchReplay` field doc), as of `main` `d8b3076b`. Extracted by card `b19e70d3` (tranche 10 on `pty/host.ts`); wording unchanged beyond joining wrapped lines and stripping `//` markers.
