# 4458dd9e — Same-sender coalescing needs a real, threaded `senderId`; `HUMAN_COMPOSER_SENDER_ID` is the composer's fixed one

## Narrative

Card `eac3464d` introduced same-sender coalescing for `kind:"agent"` messages: a run of consecutive queued entries from the SAME sender (same route + `senderId`) drains as one turn instead of one-per-turn. The coalescing key is `senderId` — but the web UI's human composer route (`POST /api/sessions/:id/input`, `gateway/server.ts`) had no per-request session/user id to thread: Loom is single-user and the route is loopback-trusted wholesale, so nothing distinguished one composer entry's sender from another's. Without a threaded identity, consecutive composer entries queued while the recipient is busy silently fell back to the cross-sender one-per-turn path — the exact gap `CLAUDE.md`'s "Message drain is kind-classified" paragraph had already asserted was fixed.

Card `4458dd9e` closes it: `HUMAN_COMPOSER_SENDER_ID` (`"loom-human-composer"`, declared in `pty/host.ts`) is a fixed, non-`"system"` sentinel standing in for "the owner, via the composer." Threading it into `enqueueStdin` from the composer route lets consecutive composer entries coalesce into one turn exactly like any other real sender. It is deliberately distinct from the literal string `"system"` so `coalesceSenderIdentity` never null-maps it back out of the coalescing path.

## Safety w.r.t. the Companion Trust Window

`Live.activeTurnSenderId`/`getActiveTurnSenderId` gate the Companion Trust Window on sender identity. `HUMAN_COMPOSER_SENDER_ID` can never land on a Companion session's turn: the composer route refuses any `role:"assistant"` session before ever reaching `enqueueStdin` (card `018ce1db`). It also can never be mistaken for a group-route companion sender by the DM-only capability gates in `companion/capabilities.ts`.

## Do not

- Do not thread an unmapped, per-request identity into a route where none exists — reuse a fixed sentinel instead of inventing a per-call synthetic id.
- Do not let the composer route's sentinel reach a Companion session's turn — the `role:"assistant"` refusal (card `018ce1db`) must run before `enqueueStdin` for this to stay safe.

## Source

Inline comment declaring `HUMAN_COMPOSER_SENDER_ID` in `packages/daemon/src/pty/host.ts` (lines 686-699 as of commit `99e41fc2`; not touched by this tranche) and the composer call site in `packages/daemon/src/gateway/server.ts` (`POST /api/sessions/:id/input`, relocated by card `dc4cb278`).
