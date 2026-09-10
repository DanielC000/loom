# 9e27f4d2 — Give-up hold deadline rides RestartIntent's separate additive `holds` map, never on the entry

## Narrative

Card 9e27f4d2: an entry still within its post-give-up hold window carries a `giveUpHeldUntil` deadline, returned in the snapshot's SEPARATE, additive `holds` half (see "Why `pending` must stay a bare `string[]`" below) rather than on the entry. `holds` is keyed by each entry's INDEX into `texts` — the filter/truncate below has to keep `rawHolds`' indices lined up against `rawTexts` before re-deriving them against the FINAL (filtered + truncated) array, since a dropped-for-length or truncated-away entry must not leave a stale index pointing at the wrong (or a nonexistent) surviving entry.

## Why `pending` must stay a bare `string[]` (on-disk compat)

`RestartIntent` is un-versioned JSON on disk (`readRestartIntent` is a bare `JSON.parse(...) as RestartIntent`, no schema/version check) that an OLDER daemon binary can read — this project's own documented pattern of running a second stable daemon from a separate checkout sharing `~/.loom`, or a rollback landing in the gap between this daemon's exit-75 and the supervisor's relaunch. An older daemon's replay expects `pending[id][i]` to always be a plain string; handed an object instead, `enqueueStdin`'s `kind:"agent"` path short-circuits BOTH pre-fix shape guards (`sanitizeLoneSurrogates`/`isUntaggedSystemNudge`) before either inspects the value, and the eventual `.map(m=>m.text).join()` silently string-coerces it to `"[object Object]"` — the real message TEXT is gone, with no throw and no log. That is exactly the LOSS class this card's own constraint forbids ("fail toward a duplicate, never a loss"), reintroduced by the FIX meant to prevent a duplicate.

Keeping `pending` a bare `string[]` and carrying the hold as this wholly separate, additive field means an older daemon reading a newer intent sees only strings it already knows how to handle — an unheld duplicate (the ALREADY-ACCEPTED pre-this-card behavior), never a garbled loss. Code review on this same card measured the alternative — widening `pending`'s own element type to `{text, giveUpHeldUntil}[]` — and rejected it for exactly this reason; that measurement is the source of the "Do not" bullet above forbidding a `giveUpHeldUntil` directly on a pending entry.

### Source (this section only)

Inline field-level JSDoc on `RestartIntent.pendingHolds` in `packages/daemon/src/orchestration/restart.ts`, lines 109-130, as of commit `779f3ce7`. Relocated by card `0a525ae1` ("restart.ts, tranche 1"); no wording changed, `*`-prefixed JSDoc lines joined into flowing paragraphs.

## Replay side (resumeFleetOnBoot)

The write side above snapshots the hold; `resumeFleetOnBoot`'s `replayPending` is the read side that
restores it. `intent.pendingHolds[id]` carries, by INDEX into `intent.pending[id]`, the `giveUpHeldUntil`
deadline of any entry that was still within its give-up hold window at capture time. Restoring it via
`enqueueStdin`'s `giveUpHeldUntil` param keeps `isGiveUpHeld` honoring the hold until it naturally expires
post-boot, instead of the entry landing as an ordinary, unheld, immediately-drainable message. Every
restored hold is logged distinguishably: since no confirming hook can ever reach a dead process's
generation, this entry's eventual delivery is a CERTAIN duplicate once the hold expires, not a maybe —
the log is what makes that duplicate identifiable to an operator instead of mysterious.

## Do not

- Do not put a `giveUpHeldUntil` hold deadline directly on a pending entry in `RestartIntent` — `pending` must stay a bare `string[]`; carry holds in the snapshot's separate, additive `holds` map keyed by index into `texts`.
- Do not re-derive `holds`' indices against the raw (pre-filter) `texts` array — re-derive them against the FINAL filtered/truncated array, or a dropped or truncated entry leaves a stale index pointing at the wrong surviving entry.
- Do not restore a replayed hold silently — log it distinguishably, since its eventual delivery is a certain duplicate, not a maybe, and the log is what makes that duplicate identifiable rather than mysterious.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`requestDaemonRestart`): lines 4306-4312, as of commit `6faf27824c7f550d57bfdeb9e4724c7070b82315`. Relocated by card `5b8d2b0c`; no wording changed, wrapped source lines joined into a flowing paragraph and the `//` comment markers stripped. "The snapshot" this paragraph continues is `docs/decisions/2ca18433-restart-pending-snapshot-excludes-durable-messages.md` (the immediately preceding paragraph at this same site). The replay-side section above sources a second, related site: `resumeFleetOnBoot`'s `replayPending`, lines 4427-4436, as of this tranche's HEAD (tranche 12).

## `enqueueStdin`'s own `giveUpHeldUntil` param enforces the hold itself, never trusts caller ordering

`resumeFleetOnBoot`'s restart replay and (card `f25bf3bf`) the companion capability re-pin respawn both pass a restored `giveUpHeldUntil` into `enqueueStdin`; `carryPendingToSuccessor` (same card) deliberately does not — see that record for why.

Code review found safety here depended only on `replayPending` running before readiness (true then, but unenforced) — so `enqueueStdin` itself now checks `stillGiveUpHeld` and forces the held-push path for any still-future deadline, even when the session is already idle-ready, so the invariant can't evaporate on a future caller/reorder.

## Do not (2)

- Do not rely on caller ordering to keep a restored `giveUpHeldUntil` honored — `enqueueStdin` enforces it itself via `stillGiveUpHeld`.

## Source (2)

Inline comment in `packages/daemon/src/pty/host.ts` (`enqueueStdin`'s `giveUpHeldUntil` paragraph), as of `main` `7c501c6d`. Extracted by card `17eee9f0` (tranche 25).
