# 96d5f76b — Every `activeMergeRepos` mutation is logged with a monotonic timestamp taken AT the mutation, never reconstructed later

## Narrative

Card 96d5f76b: forensics for `activeMergeRepos`'s add/delete lifecycle — this Map's membership AND identity together are the ENTIRE per-repo merge-admission guard (card `b9e07a4a` widened this from membership alone, once a plain Set was shown unable to tell "free" apart from "held by someone else" — see that card's own record for the cascade). The incident this card investigates — a holder's guard vanishing ~10 minutes into its own still-running gate, with no known caller responsible — went unexplained for as long as it did because no mutation of this Map was ever logged with a timestamp taken AT the mutation itself: every timing argument had to be reconstructed after the fact from a LATER stamp (an op's own `settledAt`), which is measurably not the same instant — confirmed during that investigation: a sibling op's `settledAt` postdates its own `endSquash` call (the actual mutation) by an unmeasured margin. `performance.now()` (monotonic, immune to wall-clock adjustment, the same clock `gate-runner.ts`'s own liveness tracking already uses) is the ordering-authoritative value logged; the ISO `Date.now()` string rides alongside it purely so a reader can correlate this line against `pending_gate_ops`/`orchestration_events`, which are wall-clock only. `opId` is `undefined` for a call site that has none to offer (none exist today) rather than a fabricated placeholder.

## Do not

- Do not reconstruct a repo-guard mutation's timing from a LATER stamp (e.g. an op's own `settledAt`) — it measurably postdates the real mutation by an unmeasured margin; log the mutation itself, at the instant it happens, via `performance.now()`.
- Do not use `Date.now()`/an ISO string as the ordering-authoritative clock for this forensics log — it rides alongside `performance.now()` purely for correlation against wall-clock-only tables, never as the timing source of truth.

## Source

Inline comment in `packages/daemon/src/orchestration/gate-semaphore.ts` (`logRepoGuardMutation`): lines 560-575, as of commit `5f6d9fd981336bfafd530fada633b229677aa081`. Relocated by card `9641742e`; no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
