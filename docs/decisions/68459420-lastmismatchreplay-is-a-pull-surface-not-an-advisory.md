# 68459420 — `lastMismatchReplay` is a manager-facing PULL surface, not an advisory notice

## Narrative

Card `68459420` (sender-directed arm for `[loom:prompt-mismatch]`): `Live.lastMismatchReplay` is set the instant a mismatch is identified as a REPLAY of a prior generation — `reported` matched an entry in `recentWrittenTurns` byte-for-byte. A recipient can never verify this half itself (it only ever sees what arrived, not what was intended for it) — this is a PULL surface (`getLastMismatchReplay`) for the party who CAN act, read at the point it already looks (`worker_list`/`worker_status`), rather than a longer session-facing notice: a precondition at the point of use beats an advisory in the attention path (see pinned memory `shipping-a-detector-is-not-someone-reading-it`).

Deliberately never cleared once set — a manager that hasn't yet looked should still see it on a LATER read; this is a discovery aid, not a live/transient flag, and overwritten (not accumulated) on a subsequent occurrence.

This field is one of the FOUR sibling candidates (alongside `lastMismatchFusion`/`lastMismatchUnmatched`/`lastPasteTripwireGiveUp`) `sessions/service.ts`'s `composerIntegrityWarning` reads and surfaces together at `worker_merge_confirm` time — see card `e1ac691b`'s own record for that surfacing's full design.

## Do not

- Do not clear this field once set, or add a TTL/expiry to it — a manager who hasn't yet looked must still be able to see it on a later read.
- Do not replace this pull surface with a session-facing notice alone — a precondition at the point of use is the design, not the advisory.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the `Live.lastMismatchReplay` field doc), as of `main` `d8b3076b`. Extracted by card `b19e70d3` (tranche 10 on `pty/host.ts`); wording unchanged beyond joining wrapped lines and stripping `//` markers.
