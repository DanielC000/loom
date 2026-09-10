# 340b9dbe — `firedMismatchUnresolvedGens` closes the gap where a suppressed notice still armed a second timer

## Narrative

Card `340b9dbe`: `Live.firedMismatchUnresolvedGens` is a PER-GEN DEDUP for `checkPromptMismatchUnresolved`'s own fired event, orthogonal to `pendingMismatchUnresolvedTimers` (that Set tracks live TIMER HANDLES so they can be cancelled on exit/resume; this one tracks which GENS have already produced a durable `onPromptMismatchUnresolved` event, so a second one for the SAME gen is a silent no-op instead of a duplicate alarm).

**The gap this closes:** the `UserPromptSubmit` detector's own arming site (`isRecognizedReplayAwaitingResolution`) sits BEFORE the exact-repeat suppression guard (`isExactRepeatNotice`, same case, further down) and arms independently of it — so a detector re-entry for an already-notified `(gen, writtenHash, reportedHash)` triple gets its NOTICE correctly suppressed but still arms a SECOND `setTimeout` for the same gen. `checkPromptMismatchUnresolved` used to consult only `mismatchResolvedGens` (a real fusion resolving the gen), which has no way to stop a second timer that fires for a gen that was never resolved, only already reported — this field is that missing per-gen "already fired" memory, checked/set at the single call site inside `checkPromptMismatchUnresolved` itself, so it protects against ANY arming path that can produce two timers for one gen, not just the one currently reachable.

Same never-shrinks posture as `mismatchResolvedGens` (reset only at spawn/resume/fork, alongside it) — no `onExit` clear needed the way `pendingMismatchUnresolvedTimers` gets one, since a stale entry here can only ever suppress a duplicate, never fire a false one.

## Do not

- Do not consult only `mismatchResolvedGens` to guard against a duplicate `onPromptMismatchUnresolved` event — that only catches a genuinely resolved gen, not a gen that was merely already reported once with its notice suppressed.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the `Live.firedMismatchUnresolvedGens` field doc), as of `main` `d8b3076b`. Extracted by card `b19e70d3` (tranche 10 on `pty/host.ts`); wording unchanged beyond joining wrapped lines and stripping `//` markers.
