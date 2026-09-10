# a419a7e6 — `messageExcerpt` is a bounded head slice, and durability is decided per mismatch shape

## Narrative

Card `a419a7e6` decided the open content-in-a-durable-row question card `16c93a50` left open, owning it explicitly rather than leaving it to rot as an orphaned doc comment: `detail.messageExcerpt` (`handlePromptMismatchUnresolved`, `sessions/service.ts`) is gated behind the SAME `isLogMessageContentEnabled()` flag as every other raw-text diagnostic in this file — OMITTED from `detail` entirely when the flag is OFF (the shipped default), so an unopted-in host's durable row is BYTE-IDENTICAL to before this card, and no new decision was needed for that population. With the flag ON, the operator has already accepted raw message content in a host-wide, cross-tenant ROTATING log; a project-scoped durable row is a NARROWER surface than the one already permitted, not a wider one.

`info.messageExcerpt` (`pty/host.ts`) is always a bounded HEAD slice of the ORIGINAL `intended` text for the generation that never resolved — genuinely the best available evidence of what was lost, not a "remainder": an earlier deferred item's own "bounded remainder excerpts" phrasing does not match what this branch can ever actually produce (`leadingRemainderLen`/`trailingRemainderLen` are always `0` here — see `PtyHostEvents.onPromptMismatchUnresolved`'s own doc — because the reachable branch is always a WHOLE-string replay match, never a partial one), so there is no remainder to excerpt, only the intended text itself.

DoD-3's OWN ask ("decide the durability boundary deliberately … not a request to durably log all 685[+ console notices] — a request to say which shapes are worth surviving rotation, and why") is answered here: only a mismatch that reaches `handlePromptMismatchUnresolved` — i.e. one that never resolved within `PROMPT_MISMATCH_RESOLVE_WINDOW_MS` and is therefore treated as an established loss — earns a durable row. Every other classified shape logged in `pty/host.ts` (composer-accumulation, wrapper-deficit, ANSI-strip-deficit, wrapper-aware-fusion, and an unresolved-but-still-pending unmatched-remainder) is either confirmed benign or still within its resolve window, and stays console-only by design: those are debugging breadcrumbs for a human reading the live log, not accountability records for an outcome that already happened. Durability is reserved for the one shape that needs to survive log rotation — a loss nobody can any longer verify by re-reading the log — not for every classification this file makes along the way.

## Do not

- Do not surface `messageExcerpt` as an "omitted key" placeholder when the content flag is off — it must be absent from `detail` entirely, byte-identical to before this card, not a redacted stand-in.
- Do not describe `messageExcerpt` as a "remainder" — the reachable branch is always a whole-string replay match, so `leadingRemainderLen`/`trailingRemainderLen` are always `0` and there is nothing to excerpt but the intended text itself.
- Do not durably log every classified mismatch shape `pty/host.ts` produces — only the one that reaches `handlePromptMismatchUnresolved` (an established loss past the resolve window) earns a durable row; the rest stay console-only by design.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`handlePromptMismatchUnresolved`'s method doc), as of `main` `59b443f3`.
