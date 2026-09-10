# a8f8a8f2 — `onKickoffGiveUpExhausted`: PtyHost has no DB/manager access, so the implementer decides park + notify

## Narrative

Card a8f8a8f2 (`pty/host.ts`, `PtyHostEvents.onKickoffGiveUpExhausted`): fires when `scheduleKickoffGuarantee`'s synthetic turn-1 origin (the direct `submit()` that delivers a fresh session's startup prompt) exhausts `GIVE_UP_REQUEUE_LIMIT` on that one message — the entire task dispatch (the session's brief/kickoff) is about to be dropped with nothing further `PtyHost` itself can do about it (no DB, no manager/task lookup — same layering boundary as `onGiveUpConfirmed`, card `417cea0a`).

OPTIONAL, same rationale as `onGiveUpConfirmed`/`onTurnCompleted`: every existing `PtyHostEvents` test double is unaffected until it opts in. The implementer (`sessions/service.ts`, via `index.ts`) decides how to park + notify — see `handleKickoffGiveUpExhausted`'s own doc.

## Do not

- Do not have `PtyHost` itself decide how to park or notify on a kickoff give-up-exhaustion — it has no DB or manager/task lookup; that decision belongs to the implementer (`sessions/service.ts`).

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the `onKickoffGiveUpExhausted` field doc on `PtyHostEvents`, first paragraph), as of `main` `8d9fe59d`. Extracted by card `a2a6b2ad` (tranche 11 on `pty/host.ts`); wording unchanged beyond joining wrapped lines and stripping `*` markers.
