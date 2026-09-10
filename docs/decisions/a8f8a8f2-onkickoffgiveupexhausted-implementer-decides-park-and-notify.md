# a8f8a8f2 — `onKickoffGiveUpExhausted`: PtyHost has no DB/manager access, so the implementer decides park + notify

## Narrative

Card a8f8a8f2 (`pty/host.ts`, `PtyHostEvents.onKickoffGiveUpExhausted`): fires when `scheduleKickoffGuarantee`'s synthetic turn-1 origin (the direct `submit()` that delivers a fresh session's startup prompt) exhausts `GIVE_UP_REQUEUE_LIMIT` on that one message — the entire task dispatch (the session's brief/kickoff) is about to be dropped with nothing further `PtyHost` itself can do about it (no DB, no manager/task lookup — same layering boundary as `onGiveUpConfirmed`, card `417cea0a`).

OPTIONAL, same rationale as `onGiveUpConfirmed`/`onTurnCompleted`: every existing `PtyHostEvents` test double is unaffected until it opts in. The implementer (`sessions/service.ts`, via `index.ts`) decides how to park + notify — see `handleKickoffGiveUpExhausted`'s own doc.

## Do not

- Do not have `PtyHost` itself decide how to park or notify on a kickoff give-up-exhaustion — it has no DB or manager/task lookup; that decision belongs to the implementer (`sessions/service.ts`).

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the `onKickoffGiveUpExhausted` field doc on `PtyHostEvents`, first paragraph), as of `main` `8d9fe59d`. Extracted by card `a2a6b2ad` (tranche 11 on `pty/host.ts`); wording unchanged beyond joining wrapped lines and stripping `*` markers.

## Implementer side: notify mechanism + message content (`sessions/service.ts`, `handleKickoffGiveUpExhausted`)

The terminal (park+notify) branch is routed through `enqueueSystemNudge` — the SAME durable dispatch every settle-nudge (merge-done, gate-failed, etc.) already uses — rather than a bare `pty.enqueueStdin`: a fire-and-forget push is lost outright if the manager isn't live at this exact instant, and that is EXACTLY the "item lost" failure mode this card exists to close; a bare drop one layer up is not a fix. The durable path persists a `session_message_queued` row (redriven on the manager's next resume/boot) and gets its OWN `onGiveUpExhausted` wiring recursively (re-mint, then park to nobody — sender is the `"system"` sentinel) if IT also can't get through.

The notice's text names the non-destructive verification step FIRST (`worker_transcript`), then the ONE recovery known to work if that verification confirms nothing ever started (`worker_stop` + fresh `worker_spawn`), and explicitly rules out — until verified — the two actions that look plausible but are wrong before then: `worker_message` (returns a false `delivered:true` against a session running no turn) and `worker_merge` (would review an empty branch).

## Do not (2)

- Do not send this notice for a top-level session (a manager/platform-lead spawned with no parent) — there is no single natural recipient; leave it to the generic idle-watchdog + `console.error`, unchanged.
- Do not dispatch the terminal notice via a bare `pty.enqueueStdin` — use `enqueueSystemNudge` so a manager that isn't live at this exact instant still gets it via the durable redrive path.
- Do not let the notice suggest `worker_message` or `worker_merge` before the non-destructive verification step (`worker_transcript`) has actually been checked.

## Source (2)

Inline comment in `packages/daemon/src/sessions/service.ts` (`handleKickoffGiveUpExhausted`'s JSDoc: opening scoping paragraph lines 7347-7350, "terminal branch routed through `enqueueSystemNudge`" paragraph lines 7390-7396, and "Names the non-destructive verification step" paragraph lines 7398-7402), as of main `afce859a`. Extracted by card `3f99687d` (tranche 21); wording unchanged beyond joining wrapped lines and stripping `*` markers.
