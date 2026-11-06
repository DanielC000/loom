# 79e030d9 — recycle a Companion onto a fresh engine session under the SAME Loom session id

An exhausted Companion cannot be cured by `upgradeCompanionCapabilities` (it resumes the same transcript) and `/new`'s `/clear` is held by the exhaustion hold for every non-composer sender (`exhaustionHoldAppliesTo`, `pty/host.ts`). `SessionService.recycleCompanion` boots a fresh (non-resume) engine session instead.

## Why the same id

Bindings, home, voice prefs, reminders, durable capability grants, memory and chat history are all keyed by the Loom session id, and `deleteCompanionConfig` deliberately cascades grants so "a recycled session id never inherits a stale grant". A successor row would need a transactional re-key of all of it plus a gateway/heartbeat rebuild; the same-id design needs none of it.

## Mechanics

- Runs as a controller-chain op (`CompanionController.recycle`, like `upgrade()`), so the exit event of the stopped pty cannot tear the wiring down (`onSessionExit` stale-exit guard).
- Queued messages are drained/held/requeued like `upgradeCompanionCapabilities`' post-resume loop (`mintedAtGen` omitted, `ownerTextSeq` nulled) EXCEPT `giveUpHeldUntil`, which is NOT carried: the successor is a fresh, non-resumed session and must deliver immediately (f25bf3bf "Do not (2)"). Durable (`onDeliver`) entries are skipped and re-driven once by `redriveUndeliveredMessagesForRecipient`.
- Refused unless the companion is context-exhausted (`contextExhaustedAt` set): this is the exhausted-recovery feature, and it makes a double-POST harmless (the first recycle clears the mark).
- The capability repin runs AFTER the confirmed stop, so a stop-timeout refusal ("nothing was changed") is honest. The spawn uses the just-repinned row's values (547d5fc4).
- A failed spawn restores the prior engine id, resumability and archive state; the exhaustion mark is kept.
- Everything after a successful spawn is best-effort (2fd55955), and the exhaustion mark is cleared first.
- Recycling an already-dead companion: after the respawn the controller re-arms its wiring via `applyDesired` (it was torn down by `onSessionExit`), on the same chain, no `reconcile()` re-entry (134368ac).
- The engine session id is NULLED before the spawn and the exhaustion mark cleared, so the context watcher (which no-ops without an engine id) cannot re-read the abandoned transcript and re-flag exhaustion before the new SessionStart lands.
- In-memory trust (Trust Window, confirm proposals, inline authored-content grant) is closed via `closeCompanionTrustWindow` at the POINT OF NO RETURN (old pty confirmed dead, before the spawn; fails closed), as `/new` and a restart do. Durable capability grants are kept.
- Handoff is a fixed preamble + the normal persona/memory re-injection; no transcript summary, no last-N turns.
- The exhaustion inbox notice is dismissed.
- Refused for a codex-harness companion.
- Human/REST only: `POST /api/companion/:sessionId/recycle`. Never an MCP tool.
- Archive state: the old pty's exit runs `archiveOnExit` (assistant ⇒ archived) synchronously inside the stop loop, so the top-of-method `session` snapshot is stale. After the confirmed stop the row is RE-READ; a running fresh engine is always un-archived (`restoreSession`). A failed spawn restores the PRE-RECYCLE `archivedAt` verbatim (null for a previously-live row, the original timestamp for an already-archived one — `archiveSession(id, at)`), never a restamp.
- Controller re-arm of a dead companion passes an explicit `skipAutoUpgrade` to `applyDesired`/`startOne`, so the dbba993f auto-upgrade never kills the just-spawned engine (no reliance on "no await since spawn").
- Carried non-durable alerts on a spawn throw: re-queued only if a live pty exists to receive them. A throwing `pty.spawn` leaves none (`reconcileFailedSpawn` marks it exited), so in practice they are DROPPED; durable (`onDeliver`) entries are re-driven from the DB on the next resume.

## Do not

- Do not mint a successor session row for a Companion recycle.
- Do not leave the old `engine_session_id` on the row across the fresh spawn.
- Do not route the recycle through `reconcile()`/`teardownOne`; it must run on the controller chain and re-arm nothing.
- Do not carry the in-memory trust window over the recycle.
- Do not expose this as an MCP tool or auto-fire it on exhaustion without an owner opt-in.
