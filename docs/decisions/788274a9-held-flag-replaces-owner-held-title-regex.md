# 788274a9 — `held` is the SOLE owner brake, checked in ANY column; retires the title-regex false positive

## Narrative

Card 788274a9 (Board Hold Model redesign): before this card, the idle watchdog's "is this card actually
held" discount matched an `OWNER_HELD_TITLE_RE` pattern (`isOwnerHeldTaskTitle`) against the card's own
title — e.g. a leading uppercase `HOLD`/`CONFIRM`. This produced real false positives — a legitimately
titled card that happened to start with one of those words in uppercase was silently discounted as held,
even though no owner had actually held it.

The fix replaced the title-regex heuristic with `Task.held`, an explicit boolean flag checked in ANY
column (not just a dedicated "held" lane) — `held` is now the SOLE owner brake the idle watchdog (and
`worker_spawn`) recognize. A card is discounted from "actionable" only when this flag is explicitly set,
never inferred from its title text.

## Do not

- Do not infer a card's held state from its title text (`OWNER_HELD_TITLE_RE` or any successor pattern)
  — a legitimately-titled card starting with a hold-like word is a false positive; only the explicit
  `Task.held` flag means held.
- Do not scope the `held` check to a single dedicated column — it must be honored in ANY column, since an
  owner can hold a card wherever it currently sits.

## Source

Inline comment in `packages/daemon/src/orchestration/idle-watcher.ts` (the actionable-card filter's
`held` discount). As of commit `ead5b8684` ("fix(orchestration): idle-watchdog HELD discount keys off a
Task.held flag"). Relocated by card `b072e5d4` (tranche 1 on `idle-watcher.ts`).
