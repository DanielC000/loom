# 340b9dbe — `firedMismatchUnresolvedGens` closes the gap where a suppressed notice still armed a second timer

## Narrative

Card `340b9dbe`: `Live.firedMismatchUnresolvedGens` is a PER-GEN DEDUP for `checkPromptMismatchUnresolved`'s own fired event, orthogonal to `pendingMismatchUnresolvedTimers` (that Set tracks live TIMER HANDLES so they can be cancelled on exit/resume; this one tracks which GENS have already produced a durable `onPromptMismatchUnresolved` event, so a second one for the SAME gen is a silent no-op instead of a duplicate alarm).

**The gap this closes:** the `UserPromptSubmit` detector's own arming site (`isRecognizedReplayAwaitingResolution`) sits BEFORE the exact-repeat suppression guard (`isExactRepeatNotice`, same case, further down) and arms independently of it — so a detector re-entry for an already-notified `(gen, writtenHash, reportedHash)` triple gets its NOTICE correctly suppressed but still arms a SECOND `setTimeout` for the same gen. `checkPromptMismatchUnresolved` used to consult only `mismatchResolvedGens` (a real fusion resolving the gen), which has no way to stop a second timer that fires for a gen that was never resolved, only already reported — this field is that missing per-gen "already fired" memory, checked/set at the single call site inside `checkPromptMismatchUnresolved` itself, so it protects against ANY arming path that can produce two timers for one gen, not just the one currently reachable.

Same never-shrinks posture as `mismatchResolvedGens` (reset only at spawn/resume/fork, alongside it) — no `onExit` clear needed the way `pendingMismatchUnresolvedTimers` gets one, since a stale entry here can only ever suppress a duplicate, never fire a false one.

## `checkPromptMismatchUnresolved`'s own guarantee, and a doc-history correction

`checkPromptMismatchUnresolved`'s own doc states the resulting guarantee directly: it fires `PtyHostEvents.onPromptMismatchUnresolved` AT MOST ONCE PER GEN, via this field. That doc's own history is itself a specimen of the gap this field closes: an earlier version of it claimed the event "fires exactly once (this method is only ever scheduled once per detection)" — true as a parenthetical, but the guarantee it implied was not, since "once per detection" is not "once per gen." The re-entry case described above (the `UserPromptSubmit` detector arming a second timer for an already-notified gen) is exactly the case that parenthetical missed.

## Do not

- Do not consult only `mismatchResolvedGens` to guard against a duplicate `onPromptMismatchUnresolved` event — that only catches a genuinely resolved gen, not a gen that was merely already reported once with its notice suppressed.
- Do not read "this method is only ever scheduled once per detection" as a per-gen guarantee — a detector re-entry for an already-notified triple can still arm a second timer for the same gen.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the `Live.firedMismatchUnresolvedGens` field doc), as of `main` `d8b3076b`. Extracted by card `b19e70d3` (tranche 10 on `pty/host.ts`); wording unchanged beyond joining wrapped lines and stripping `//` markers.

The guarantee/correction section above is from a second site citing the same card: `checkPromptMismatchUnresolved`'s own method doc (`packages/daemon/src/pty/host.ts`), as of commit `7ccbbbaa8ddad24dbd6146ba02e3e93a771ce535`. Extracted by `pty/host.ts` tranche 59 (card `73ad08f2`) — only the 340b9dbe-tied "fires at most once per gen" consequence; the surrounding sentences at that site are tied to card `f9b1ea00` and stay inline there.
