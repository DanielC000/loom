# 94721f95 — the paste-tripwire race is a RECURRING upstream CLI issue across engine versions, not a closed incident

## Narrative

`orchestration/resume-nudge.ts`'s `DRAFT_LOSS_NOTE` JSDoc used to claim a submitted companion paste collapsing to a bare placeholder with no recoverable text "does not reproduce on current tooling" — based on a real production incident (3 pastes on session `5db71873`, all pinned to claude 2.1.212, with zero recurrence across 8 later versions of continued use on that same session) that had been traced to a transient upstream CLI race around Stop-hook timing, not a Loom defect.

Card `94721f95` measured that claim FALSE: 53 `[paste-tripwire]` warnings recurred at claudeVersion 2.1.220 across the daemon's own rotated logs (population: 6 log files, positive control stated before the check — if the earlier "fixed at 2.1.215, zero recurrences" record had held, the expected count was zero). The comment was corrected in place: if pastes-losing-content resurfaces, an agent should suspect this same recurring upstream CLI race, not assume a NEW Loom write-path regression.

The parent card (`94721f95` itself) is a much larger investigation into the paste-tripwire's auto-re-injection behavior, redelivery paths, and whether a trip actually means content was lost — none of that broader scope is restated here; this record covers only the specific claim the resume-nudge disclaimer made and retracted.

## Do not

- Do not restate "the upstream paste race does not reproduce on current tooling" in the resume nudge, or assume it is closed at any specific engine version without a fresh measurement — a version-pinned diagnosis nobody re-measures after the version moves is exactly what went wrong here.
- Do not attribute a resurfaced paste-loses-content report to a NEW Loom write-path regression before ruling out this same recurring upstream race.

## Source

JSDoc comment above `DRAFT_LOSS_NOTE` in `packages/daemon/src/orchestration/resume-nudge.ts`, lines 92-99 as of this tranche's HEAD (tranche 1). Card merged as commit `94f5100`. Card body (much broader investigation) not reproduced here — see the card for the fuller paste-tripwire redelivery-path analysis.
