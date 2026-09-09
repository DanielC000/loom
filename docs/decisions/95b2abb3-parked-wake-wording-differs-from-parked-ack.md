# 95b2abb3 — `parked-wake` wording must not claim the manager owes a reply

## Narrative

`parked-wake` — SAME reported-and-unacked shape as `parked-ack`, but the worker ALSO has a PENDING self-scheduled wake (card 95b2abb3, follow-up to the WAKE GUARD below): it reported `progress`/`done`/`blocked` and then parked itself on its OWN `wake_me`, not on the manager. The manager owes it NO reply — it resumes itself when the wake fires — so this is reported with distinct wording rather than folded into `parked-ack`'s "awaiting your reply" phrasing, which would be false here.

## Do not

- Do not word a `parked-wake` classification (a reported-and-unacked worker that ALSO holds a pending self-scheduled `wake_me`, card 95b2abb3) the same as `parked-ack`'s "awaiting your reply" — the manager owes it no reply, since it resumes itself when the wake fires.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`classifyIdleWorker`): lines 12767-12771, as of commit `a07c5092c871d47f25aeb2ec160958306294a043`. Relocated by card `3f40210c`; no wording changed, wrapped source lines joined into a flowing paragraph (including one mid-token wrap, `` `progress`/ `` continuing as `` `done`/`blocked` `` — joined with no inserted space), the leading list-bullet marker and `*` comment markers stripped.
