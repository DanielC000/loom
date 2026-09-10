# be79aea2 — `opts.shutdownMarker` distinguishes a clean stop from a real crash in the recovery nudge

## Narrative

Card be79aea2 (commit `fa314a1793`) fixed a planned/supervised daemon restart resuming sessions with "[loom:crash-recovered] The daemon crashed" — no clean-shutdown vs crash distinction, forcing a manager to escalate just to confirm nothing had actually broken.

The caller reads+consumes `last-shutdown.json` ONCE per boot, unconditionally, and passes the result as `opts.shutdownMarker`. When it's a fresh clean-stop record (an OS signal or an intentional `loom stop`), the preceding stop was NOT a crash — this boot only reached the crash-recovery branch (`recoverCrashOrphanedWorkers`, not `resumeFleetOnBoot`) because a signal/service-manager stop raced ahead of a graceful session snapshot, not because anything actually broke. Every `[loom:crash-recovered]` nudge is swapped for a `[loom:daemon-restarted]` clean-stop nudge in that case; `shutdownMarker` null (no marker, or the caller determined this boot really is unclassified) leaves the original crash phrasing untouched.

## Do not

- Do not send `[loom:crash-recovered]` phrasing when a fresh clean-stop marker is present — a signal/service-manager stop racing ahead of a graceful snapshot is not a crash, and telling a manager otherwise forces a needless escalation to confirm intent.
- Do not treat a missing/null `shutdownMarker` as proof of a crash — it means unclassified, and the original crash phrasing is the correct default for that case.

## Source

JSDoc comment in `packages/daemon/src/sessions/service.ts`, above `recoverCrashOrphanedWorkers`: lines 4860-4866 as of this tranche's HEAD (tranche 14). Introduced by commit `fa314a1793`.
