# da723d41 — additionalContext-only emission, and the per-record cap raised 4000→6000

Both decisions below landed together in one commit, `784caba82538db45e69821cc83cfb56ff378cbe5` ("fix(assets): emit each decision record once and raise the per-record cap"), against `packages/daemon/assets/decision-records.mjs`, both dated 2026-09-09, both under this same card. They are related (same fix, same PR) rather than coincidentally sharing an id, so they are recorded here as two sections of one narrative rather than as unrelated decisions.

## Decision A: emit via `hookSpecificOutput.additionalContext` only, never `systemMessage`

A prior version of the script emitted the injected decision record via BOTH `hookSpecificOutput.additionalContext` and `systemMessage`, "whichever the running Claude honors" — pure hedging, never actually checked.

It was checked here, empirically: a real `claude` process, wired via a scratch `.claude/settings.json` PostToolUse hook to a synthetic script emitting distinct marker strings in each field, was asked to read a file and report verbatim any hook text it saw in its own context.

Three trials were run: (1) both fields set, (2) the two field values SWAPPED, to rule out a labeling/ordering artifact, and (3) `systemMessage` set ALONE, with no `additionalContext` at all (an isolation trial).

Across all three trials, the model's context carried the `additionalContext` value every time and NEVER the `systemMessage` value — including the isolation trial, where `systemMessage` alone produced zero injected text.

`systemMessage` is a UI-only field (a warning surfaced to the human at the terminal); it never reaches the model. Emitting both cost 100% overhead on every injection for a field the model never sees. Fixed to emit via `additionalContext` only.

## Decision B: `PER_RECORD_MAX_BYTES` raised 4000 → 6000

At the time of this change, the three largest records in this repo's `docs/adr` were 4,515 / 4,475 / 4,017 bytes — all three exceeded the then-current 4000-byte cap and were silently truncating on every injection. Raising the cap to 6000 cleared the whole then-current set, with headroom.

## Do not

- Do not reintroduce a `systemMessage` copy of the record (Decision A) — the source is `hookSpecificOutput.additionalContext` only; `systemMessage` is UI-only and never reaches the model.

## Source

Condensed, not verbatim. `packages/daemon/assets/decision-records.mjs`: the `FIELD DETERMINATION` comment (Decision A) and the `PER_RECORD_MAX_BYTES` cap comment (Decision B). See also `docs/decisions/d0d0401b-oversized-record-corpus-accepted-not-split.md`, which cites this same cap raise from the lint's own over-cap census.
