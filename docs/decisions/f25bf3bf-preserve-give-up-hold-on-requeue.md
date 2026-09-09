# f25bf3bf — Preserve a give-up hold when requeuing a drained message back onto the companion

## Narrative

The pty is STILL alive — push everything we drained OUT of its FIFO back onto it before aborting (nothing else will redeliver them; resume() below never runs on this path). The capability re-pin above already landed durably — a later manual restart/resume picks it up.

PRESERVE the hold (card f25bf3bf): this is the SAME session/process, never stopped — any still-held give-up requeue (`msg.giveUpHeldUntil`) is exactly as ambiguous as it was the instant we drained it, so putting it back with the hold intact just restores the status quo.

Redeliver anything captured above onto the FRESH process, in order — the old process is gone and its FIFO was wiped, so without this the captured entries would simply vanish despite being "queued". A durable entry (onDeliver set) is SKIPPED — resume()'s own redrive (just above) already re-delivers it; redelivering it here too would double it.

PRESERVE the hold (card f25bf3bf, deciding what 9e27f4d2 left open for this path): `resume()` above reconnects to the SAME engine session via --resume (this is a re-pin respawn, not a fresh successor — the recipient session id is unchanged), so the resumed conversation's transcript already reflects whatever the predecessor's engine actually did before it was stopped. If the original give-up was a false negative (the turn had already run), replaying the same text into that SAME continuing conversation immediately is precisely the confusing-duplicate shape the hold exists to delay — the restart path's own reasoning (9e27f4d2), not the recycle path's (`carryPendingToSuccessor` above DELIVERS instead — see its doc for why a fresh, non-resumed successor differs). The purge can never actually fire here either (this respawn's own `giveUpConfirmQueue` starts empty, same as a restart), so this only ever delays delivery — but a delayed, possibly-superseded duplicate beats an immediate, certain one landing the instant the resumed process is back up.

## Do not

- Do not drop a `msg.giveUpHeldUntil` hold when requeuing a drained message back onto the SAME still-alive pty (abort path) or onto a freshly `resume()`d one (resume path) — preserve it in both cases.
- Do not replay a preserved hold's text immediately into a `resume()`d companion's continuing transcript — the resumed transcript may already reflect what the predecessor's engine did, and an immediate replay is exactly the confusing-duplicate shape the hold exists to delay.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`upgradeCompanionCapabilities`): lines 4129-4135 (abort path) and 4157-4172 (post-resume path), as of commit `7a20d971f1c5d3d098b36030b5cc5feebd8be930`. Relocated by card `6065685c`; no wording changed, wrapped source lines joined into a flowing paragraph and the `//` comment markers stripped. See also `docs/decisions/9e27f4d2-giveupheldsuntil-rides-restart-intents-holds-map.md` (the restart-path reasoning this decision extends to the companion-upgrade resume path).
