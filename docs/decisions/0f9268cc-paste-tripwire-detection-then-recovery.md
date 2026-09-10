# 0f9268cc — the paste tripwire: detection-only baseline, then one-shot recovery on top

## Narrative

Card eef4883c originally built the bare-pasted-text-placeholder tripwire as DETECTION ONLY. Card 8a39f544
investigated owner pastes arriving over the Companion as a bare `[Pasted text #N +M lines]` placeholder
(silent content loss) and traced it to a transient UPSTREAM `claude` CLI race pinned to v2.1.212 (fixed by
v2.1.215) — NOT a Loom `submit()`/`writeChunked()` write defect, so no production write-fix was warranted.
But the failure was SILENT — the owner lost paste content with no signal — so the tripwire exists to give
a recurrence of the same class a detectable signal instead of vanishing unnoticed.

Card 0f9268cc confirmed a DIFFERENT recurrence (claudeVersion 2.1.217, past the 2.1.215 "fix") and, having
ruled out PREVENTION (see `pty/host.ts`'s Stop-hook call site for why), added automatic one-shot RECOVERY:
re-inject the lost content as a corrective turn. This is also the card that widened
`isBarePastedTextPlaceholder`'s match from whole-string-only to an EMBEDDED anchor — a composer message
that mixes typed instructions with a paste (e.g. "Following up on: [Pasted text #5 +3 lines] — see above")
collapses exactly the same real content as a bare placeholder does, and a plain-textarea web composer
makes that mixed shape common; the old anchored regex missed it entirely.

Widening detection to embedded matches introduces a false-positive risk (a message that merely TYPES the
placeholder-shaped phrase, rather than one the CLI actually collapsed), so `detectBarePastePlaceholderTripwire`'s
condition (3) — the exact placeholder substring must be ABSENT from `submittedText` — was validated against
the real transcript corpus before shipping: **18140 real transcript user turns**, of which only **18**
embedded-match hits existed at all, and every one of those 18 was someone (a worker report, a manager
message, this very bug's own investigation) literally TYPING the phrase `"[Pasted text #N...]"` while
discussing this bug, never an actual CLI collapse. This is a discriminating FIELD (checked from data
already in hand — a placeholder token is CLI-GENERATED and can, by construction, never appear in text Loom
itself wrote to the pty), not a suppressing filter of unknown correctness: it only rules out the one shape
that's structurally impossible to be a real collapse, so over-suppressing (dropping ANY embedded match)
never re-hides the case the widening exists to catch.

## Do not

- Do not treat a paste-collapse recurrence past v2.1.215 as evidence the upstream fix regressed without
  re-checking the claudeVersion — 0f9268cc's own specimen was a genuinely different recurrence, not a
  re-opened v2.1.212 bug.
- Do not weaken or remove condition (3) (the submitted-text absence check) without re-running the
  18140-turn-scale validation this decision is based on — a naive embedded match alone produces false
  positives on ordinary discussion of this very bug.

## Source

Inline comment in `packages/daemon/src/orchestration/paste-tripwire.ts` (the module header doc, and
`detectBarePastePlaceholderTripwire`'s condition-(3) rationale). Relocated by card 26afc9eb (tranche 1 on
`orchestration/paste-tripwire.ts`); no wording changed beyond compressing wrapped source lines into flowing
paragraphs and stripping `/** */`/`*` comment markers.
