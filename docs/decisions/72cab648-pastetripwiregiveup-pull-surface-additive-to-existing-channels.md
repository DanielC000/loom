# 72cab648 — `lastPasteTripwireGiveUp` is a PULL surface, additive to the console.warn/nudge channels

## Narrative

Card `72cab648`: `Live.lastPasteTripwireGiveUp` is the SENDER pull-surface for the bare-paste-placeholder tripwire's own GIVE-UP — its one-shot auto-recovery re-injection (`isPasteRecoveryAttempt`) ALSO collapsed, and Loom will not retry a third time.

Before this field, the give-up's only channels were a bare `console.warn` (card `eef4883c`) and, since card `47c11741`, an attention-path `enqueueSystemNudge` to the session and its sender — pinned memory `shipping-a-detector-is-not-someone-reading-it` measured an advisory in that attention path at ZERO acted-on across every instance tracked, versus a precondition/pull-surface read at the point of use, which is what actually gets checked. This is that pull-surface — read at the SAME `worker_list`/`worker_status` point a manager already reads `lastMismatchReplay`/`lastMismatchFusion` — purely additive on top of both existing channels (the `console.warn` and the nudge are untouched).

Same PULL-surface mechanics as its siblings: `null` = no give-up has fired yet since this session went live, `undefined` (the getter) = session not live in this process, never cleared once set, overwritten (not accumulated) by a later occurrence — always reflects the LATEST give-up only.

## Do not

- Do not remove or replace the existing `console.warn`/attention-path-nudge channels when adding a pull surface — this field is additive on top of both, not a replacement.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the `Live.lastPasteTripwireGiveUp` field doc), as of `main` `d8b3076b`. Extracted by card `b19e70d3` (tranche 10 on `pty/host.ts`); wording unchanged beyond joining wrapped lines and stripping `*` comment markers.
