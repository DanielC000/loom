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

## The recycle path (`carryPendingToSuccessor`) reaches the OPPOSITE conclusion, same card

Card f25bf3bf also governs `carryPendingToSuccessor` (`sessions/service.ts`) — the recycle path's redrive of a predecessor's held queue onto its successor — and there it lands on the OPPOSITE side of the same question: DELIVER a still-held `giveUpHeldUntil` entry immediately, never carry it forward. The axis is the same one this record turns on (does the successor's transcript already reflect what the predecessor's engine did?), just resolved the other way: a recycle spawns the successor FRESH, with NO `--resume` (deliberately, so the recycle isn't defeated by carrying old context forward) — so the successor's conversation never saw whatever the predecessor's engine may have already done with the held entry's text, unlike the `resume()`d companion-upgrade case above where there IS a shared transcript to confuse. The hold's purge could also never fire here regardless: the successor's own `giveUpConfirmQueue` starts empty (same as a post-restart session), so `purgeConfirmedGiveUpRequeue` would early-return on it forever — preserving the hold would only ever stall the successor's first real instruction for up to `GIVE_UP_HOLD_MS`, a pure cost with no offsetting benefit.

The SAME carry loop also omits two companion-only `QueuedMessage` fields, `proactive`/`senderId`, for a DIFFERENT reason than the hold: they CAN'T ever be non-default on this path at all. Both are stamped only by companion-exclusive senders (the three proactive watchers; the companion inbound submit path), which only ever target an assistant-role session — never a worker/manager/platform-lead, the only roles a recycle successor can be. Different reasons, same "nothing to fix" conclusion.

## Do not (2)

- Do not carry `giveUpHeldUntil` forward on the recycle path (`carryPendingToSuccessor`) — the successor is a fresh, non-resumed session, so the confusing-duplicate risk the hold exists to delay doesn't apply, and its purge can never fire there either.
- Do not add `proactive`/`senderId` handling to this carry loop as a "missing field" fix — they are structurally unreachable on a recycle-eligible role (worker/manager/platform-lead), not an oversight.

## Source (2)

Inline comment in `packages/daemon/src/sessions/service.ts` (`carryPendingToSuccessor`'s method doc), as of main `753e55a754afc0638516f9079ee6c24219d80db8`. Extracted by card `fa831c1c` (tranche 25).
