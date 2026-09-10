# 184fd82e — Defer serializing fresh codex spawns per cwd; instrument the race window instead

## Status

accepted

## Context

Two fresh (non-`--resume`) codex spawns into the same `cwd`, close together, can race: `captureCodexEngineSessionId` (`pty/host.ts`) scans for a newly-created rollout file, and the scan has no identity information tying a codex process to its own file — a sibling's genuinely-owned file can be adopted by the wrong spawn (`test/codex-concurrent-same-cwd-exclusion.mjs` manufactures and asserts this end-to-end against the real capture path). `sessions/service.ts` fresh-spawns at least seven session kinds sharing `cwd: project.repoPath`, so the shape is reachable, not merely hypothetical.

Card `7a0b826e` tried an in-scan mitigation first — reject a candidate id already claimed by another live codex entry — and **abandoned it as a net regression inside that same card** (final merged state `6dc3b1a`; `liveCodexClaimedSessionIds` has zero occurrences repo-wide as of `7a20d971`). This card exists to establish *why* it was abandoned before choosing between the two options this decision was originally framed around: adopt a per-cwd spawn lock, or accept the residual as documented.

This card's own body, as filed, additionally overstated what `7a0b826e` had closed (it read the abandoned mitigation as still-shipped and "closing the double-claim outcome unconditionally"); that framing was corrected before dispatch. The residual is not a narrow order-dependent case on top of a working mitigation — no mitigation of that shape survives in the tree at all.

## Why the exclusion-set mitigation was abandoned (established before deciding, per this card's own DoD)

Read directly from the surviving doc comment in `codex-transcript.ts` (`snapshotExistingConversationIdsForSpawn`), left behind specifically so this reasoning would not be lost: rejecting a contested candidate systematically punishes whichever session is the **rightful** owner of the file — the thief has already captured and stopped scanning, so it is always the owner's own scan that keeps re-encountering "already claimed." Every variant tried either reproduced a two-way identity swap when the candidate set shifted mid-ladder, or left the rightful owner with no id at all — worse than the plain race, since `resumeId` is derived from `engineSessionId` and "no id" means unresumable, not merely misattributed. The scan has no identity information to resolve this with; nothing at that layer can close it by rejecting candidates.

This matters directly to the choice below: a **per-cwd spawn lock** (option 1) is not another variant of the same abandoned approach — it does not try to resolve identity post-hoc from an unordered candidate set at all. It removes the precondition (two unresolved scans open at once) instead of trying to arbitrate it. The revert does not argue against the lock; it only rules out further in-scan variants.

## Decision

**Do not adopt the per-cwd spawn lock now.** Instead, ship low-cost, always-on production instrumentation (`captureCodexEngineSessionId`, `pty/host.ts`) that logs a `CONCURRENT-RACE-WINDOW` diagnostic on every successful capture where another live codex entry shares the same `cwd` and is *itself* still unresolved at that instant — the actual race precondition, not a proxy for it — plus the capture's own elapsed time and attempt count. This does not change control flow or add latency; it only makes the previously-invisible exposure window observable going forward, on real traffic, at effectively zero cost.

This is Option 3 from the card ("measure first"), executed as instrumentation rather than a one-off synthetic benchmark: the quantity this decision actually needs — how often two *live, unresolved* codex scans overlap on one cwd on a real host, under real codex CLI timing — cannot be produced synthetically in one session without begging the question the lock's cost/benefit turns on.

## Do not

- Do not resurrect an in-scan/exclusion-set mitigation (rejecting or preferring a candidate based on what's already claimed) as a fix for this race — established above as a net regression, not merely incomplete; it trades a detectable, symmetric collision for an undetectable identity swap or an unresumable rightful owner.
- Do not quote `CODEX_ENGINE_ID_MAX_ATTEMPTS × CODEX_ENGINE_ID_RETRY_MS` (~120s at default config) as a measured collision cost or a measured capture time — it is the retry ladder's configured worst-case ceiling, env-overridable, and says nothing about the common case.
- Do not read this decision as "the race is fixed" — it is unchanged and still open; only its visibility changed. `test/codex-concurrent-same-cwd-exclusion.mjs` continues to assert the residual itself, not just the new diagnostic.
- Do not implement the per-cwd lock off this decision alone if it's revisited later — re-open a card that cites the accumulated `CONCURRENT-RACE-WINDOW` occurrence data (or its continued absence) once real traffic has had time to produce some; do not re-derive the cost/benefit call from the same unmeasured ceiling this card started from.

## Consequences

- Easier: any future revisit of this decision has real data to reason from — occurrence rate and, on the success path generally, real capture-duration data — instead of only a configured ceiling.
- Easier: the diagnostic is genuinely free when the race never fires (a single boolean scan over an already-tiny map, `this.liveCodex`, only on the already-rare successful-capture path) and additive-only (new log lines; no field, event, or control-flow change), so it carries none of the lock's own risk (`git diff` for this card: `codex-transcript.ts` untouched, only `pty/host.ts`'s success branch and the test file changed).
- Harder / accepted: the race itself remains open. A real misattribution (`test/codex-concurrent-same-cwd-exclusion.mjs`'s own scenario) is still possible on a real host today, exactly as before this card. If it turns out to fire often in practice, this decision defers, not forecloses, the lock.
- Accepted: no distribution exists yet at the moment this decision is recorded — the instrumentation is what will produce one; see Evidence for what is and is not established today.

## Evidence

- READ-IN-SOURCE: the surviving doc comment in `packages/daemon/src/pty/codex-transcript.ts` (`snapshotExistingConversationIdsForSpawn`) states the abandoned mitigation's specific failure modes (identity swap / rightful-owner starvation) verbatim; this is the source for the "why reverted" section above.
- OBSERVED: `git diff <7a0b826e-pre-mitigation>..6dc3b1a -- packages/daemon/src/pty/host.ts` = 0 lines (positive control: the same diff range against the card's own test file = 183 lines) — re-confirmed this session; matches project memory `liveCodex-no-delete-is-parity-not-asymmetry` (v2), which recorded the same check independently on 2026-09-09.
- OBSERVED: `liveCodexClaimedSessionIds` — zero occurrences repo-wide, `packages/daemon/src` — checked this session with `liveCodex` itself (3 file-hits) as the positive control confirming the grep shape works.
- OBSERVED, this session: `node packages/daemon/test/codex-concurrent-same-cwd-exclusion.mjs` (extended by this card) — the new `CONCURRENT-RACE-WINDOW` diagnostic fires on session A's manufactured mis-capture (the real race precondition: sibling B still live, same cwd, unresolved) and does **not** fire on B's own later, correct capture (A had already resolved by then) — 9/9 checks pass, exit 0. This is a positive AND a negative control on the diagnostic itself, not on the underlying race (which remains open by design).
- OBSERVED, this session: `pnpm --filter @loom/daemon build` clean; `node packages/daemon/test/codex-engine-session-id-capture.mjs` (13 checks) and `node packages/daemon/test/codex-recycle-conversation-id-exclusion.mjs` (13 checks) both still pass, exit 0 — the new instrumentation on the success path does not regress ordinary (non-concurrent) capture.
- READ-IN-SOURCE, prior session (card `60c0f54d`, `7a20d971`): codex accounts for 1 of 1691 resumable sessions on this host (0.06%), and the codex rollout archive has never been written to. A frequency signal only, bounding how often ANY codex capture happens at all — not specific to the same-cwd-concurrent-window shape this card is about, and not a substitute for the new diagnostic's own data.
- NOT ESTABLISHED: any real-world `CONCURRENT-RACE-WINDOW` occurrence count. The instrumentation ships with this card; it has not yet observed live traffic. This is stated explicitly, per the card's own DoD for option (3), rather than reporting a fabricated "zero collisions observed" — nothing was watching before now, so an honest report is "no distribution exists yet," not "none occurred."
