# 572dd777 — `opts.bootedAt` + `opts.supervisorIteration` add correlatable boot diagnostics to the crash nudge

## Narrative

Card 572dd777 (commit `966e90be0`, "fix(daemon): add boot timestamp and supervisor iteration to the crash nudge") added two optional diagnostics `recoverCrashOrphanedWorkers` appends to every nudge it sends.

**DoD-3, `opts.bootedAt`:** this boot's own start time, appended so a recipient can correlate against `daemon-output.log` without guessing which boot's lines they're reading. Omitted (defaults to `now`) rather than made mandatory, so an existing test caller that only ever passed `now` still gets a real (if slightly later-captured) timestamp instead of `undefined`.

**DoD-4, `opts.supervisorIteration`:** which pass of the restart supervisor's loop this boot ran under (see `supervisorIterationAtBoot`'s own doc, `orchestration/restart.ts`, for what iteration 1 vs >1 means). `null`/omitted means not running under the supervisor at all (or the caller genuinely doesn't know) — the clause is silently skipped rather than fabricating a number. Surfaced ONLY on the crash-shaped branch (`cleanStop` false): a clean stop already fully explains itself, and the supervisor's own restart policy means iteration>1 should never actually co-occur with a missing shutdown marker — surfacing it there anyway would invite a reader to draw a conclusion from a combination that should be structurally impossible, rather than trusting what's actually true. (This is recorded as a directly observed fact per the card's own "Defect 2" writeup, not left as an inference chain the reader has to trust.)

## Do not

- Do not omit the boot-diagnostics clause (`bootedAt` + the conditional `iterationClause`) from any crash-recovered/daemon-restarted nudge variant `recoverCrashOrphanedWorkers` sends — all of them append it identically.
- Do not surface `supervisorIteration` on the clean-stop branch — it is scoped to the crash-shaped branch only, where the combination it could otherwise imply (iteration>1 with no shutdown marker) is structurally impossible and would mislead a reader.

## Source

JSDoc comment in `packages/daemon/src/sessions/service.ts`, above `recoverCrashOrphanedWorkers`: lines 4876-4890 as of this tranche's HEAD (tranche 14). Introduced by commit `966e90be0`.
