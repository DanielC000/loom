# e2a3c613 — cover managers and parentless sessions in the boot-dialog-stuck detector

## Round 4 (scope cut)

Delta Code Review `86a9db10` (reviewing round 3) found another BOOT STUCK lifecycle gap one level up from
round 3's own fix: the resolve (both round 2's and round 3's) fires ONLY on a `SessionStart` hook, but the
hold (`isBlockedOnUnresolvedBootDialog`) and the stuck timer itself treat ANY hook — not just
`SessionStart` — as proof the session is past boot (`isPastBoot` reads `sessionStartObserved ||
anyHookObserved`). A session that reaches `READY_FALLBACK` or any non-`SessionStart` hook after the alarm
fired is genuinely released and working, but the resolve never files for it — BOOT STUCK stays red on the
web attention list for a healthy session, indefinitely.

Per the round-3 scope-cut rule ("if this round's review finds another BOOT STUCK lifecycle gap, the lead
CUTS the web item and keeps only attention-push + the Lead notice"), rounds 2 and 3's web item and the
`claude_boot_dialog_resolved` resolve machinery are **removed** from this card and **moved to card
`b1da256d`**, which carries every reviewer finding from rounds 2-3 (including this one) as design input
and starts with a design-first checkpoint. **This card (e2a3c613) now lands the daemon side only:**

- The detector + kickoff hold covering managers, the Platform Lead, and parentless sessions
  (`BOOT_DIALOG_DETECTOR_ROLES`, `isBlockedOnUnresolvedBootDialog`) — round 1, unchanged.
- The owner attention-push `"escalation"` classification (gated on `detail.parentNudged === false`) and
  its dedup scoped to `e.kind === "platform_escalate"` — round 2 item 4 / round 3 item 2, unchanged.
- `notifyLeadOfStuckManager`, with `.findLast()` + reuse-only-while-open — round 2 item 5 / round 3 item 3
  (M6), unchanged.
- The `BOOT_DIALOG_DETECTOR_ROLES` role-scope negative control (a role outside it is not held) — unchanged.

**`claude_boot_dialog_resolved` does not exist in this card's shipped code**: the event kind, the
`onClaudeBootDialogResolved` pty-host hook/call, `SessionService.handleClaudeBootDialogResolved`, and
their tests (this file's former (R1)-(R4)) are all removed, not merely unused. `packages/web/src/lib/
attention.ts` is reverted to main's version — **BOOT STUCK does not appear anywhere in the web UI** under
this card; every claim below that it does, or that a resolved event clears it, describes rounds 2-3's
WORK-IN-PROGRESS, now cut — read it as history of what was tried, not as what shipped. `b1da256d` restarts
that work from the lesson above (resolve on `anyHookObserved` flipping, not `SessionStart` alone).

## Round 3 (delta Code Review 921605e4)

Round 2's resolved-pairing lived entirely in in-memory `Live` state (`live.dialogStuckFired`), which never
survives a resume or a daemon restart — a session that got stuck, then came back healthy on its NEXT
incarnation (a fresh `Live` object, flag false, on-time `SessionStart`), left its old `claude_boot_dialog_stuck`
unpaired forever: BOOT STUCK stayed on the web attention list for a session that had long since recovered.

1. Fixed by driving the resolved pairing from DURABLE state instead. `pty/host.ts`'s `SessionStart` case now
   calls `onClaudeBootDialogResolved` on EVERY SessionStart (fresh, resumed, or a same-process rotation
   re-fire alike) — unconditionally, never gated on an in-memory flag. `SessionService.handleClaudeBootDialogResolved`
   does the actual decision: it reads this session id's own event trail (`listEventsForWorker`) and files
   `claude_boot_dialog_resolved` only when the LATEST of `{claude_boot_dialog_stuck, claude_boot_dialog_resolved}`
   is a stuck with nothing newer pairing it — a no-op when nothing was ever stuck, and naturally idempotent
   against a rotation re-firing the same case twice for one alarm. `live.dialogStuckFired` is removed
   entirely; nothing else consumed it.
2. `web/src/lib/attention.ts`'s BOOT STUCK item also now drops once the stuck session (`sid`) itself is no
   longer live — covers the "stuck child filed under a pre-boot parent" sub-case where the child exits
   (worker_stop'd, crashes) without ever reaching a late `SessionStart` to file the daemon-side resolved
   event above.
3. `companion/attention-push.ts`'s escalation re-delivery dedup (`escalationSurfaced`) was keyed on
   `cls === "escalation"`, which round 2 made true for BOTH `platform_escalate` AND `claude_boot_dialog_stuck`.
   `escalationSignature` reads `detail.title`/`detail.severity`, fields `claude_boot_dialog_stuck` never
   carries, so its signature was always the constant string `"|"` — a worker's first boot-stuck episode
   stamped `taskId → "|"` and silently suppressed every later episode for that same task forever. Fixed:
   scoped the dedup check AND `stampEscalation` to `e.kind === "platform_escalate"` specifically — the only
   kind this title+severity fingerprint was ever designed for. `tick()`'s `taskIdResolvable` computation had
   the identical `cls === "escalation"` mix-up (it resolves a taskId against the Platform HOME project,
   which is wrong for a `claude_boot_dialog_stuck` event's own-project taskId) and was fixed the same way.
4. `notifyLeadOfStuckManager`'s prior-task lookup used `.find()` over `listEventsForWorker`'s ts-ASC order,
   which returns the OLDEST `leadBoardTaskId`-carrying event — across 3+ stuck episodes on a resumed
   session, every dedup check re-derived the FIRST episode's task rather than the most recent. Fixed with
   `.findLast()`.

See the "Do not" section for what each of these closes off from recurring.

## Round 2 (Code Review e5290bc2)

The daemon side above (round 1) was sound; the web attention list had two bugs and one classification
needed revisiting:

1. `web/src/lib/attention.ts` was merging `bootStuckEventQueries` into `allEvents`, so every
   `bootStuckCandidate`'s FULL event stream (the Platform Lead, setup, assistant, top-level runs) also fed
   `latestIdle`/`latestContext`/`latestQuiet`/`latestMerge` — surfacing MANAGER ASLEEP / CONTEXT OVERFLOW /
   QUIET BOARD / MERGE REQUEST items for sessions that were never meant to be in those sets, and
   double-counting a live manager's own events (it's in both `managers` and `bootStuckCandidates`). Fixed:
   `allEvents` stays scoped to `eventQueries` (the `managers` set) alone; `bootStuckEventQueries` feeds
   only `latestBootStuck`, from its own separately flattened/sorted list.
2. BOOT STUCK never cleared while the stuck session stayed live (the owner dismisses the dialog after the
   alarm fired, or SessionStart simply arrives late) — there was no "resolved" event to pair against, so
   the item persisted until the session exited. Fixed: `handleClaudeBootDialogStuck`'s pty-side timer
   (`live.dialogStuckFired`, pty/host.ts) now distinguishes "the alarm genuinely fired" from "the timer
   was cleared before firing," so a LATE `SessionStart` can emit `claude_boot_dialog_resolved` — same
   `managerSessionId`/`workerSessionId` as the paired stuck event — and the web/companion sides pair
   stuck/resolved exactly like `merge_request`/`merge_done` (latest wins).
3. The BOOT STUCK item was keyed/linked/labeled by `e.managerSessionId`. That field is the PARENT's id,
   not the stuck session's, in the "parent itself pre-boot" sub-case of `parentNudged===false` (850eb55c's
   hazard: a worker's live parent is itself stuck pre-boot on the same dialog, so ITS nudge is suppressed
   too) — `parentNudged:false` covers BOTH "no parent exists" (manager/Lead/parentless case) AND "a parent
   exists but can't be nudged because it's in the identical hazard." Fixed: key/link/label by
   `e.workerSessionId` instead, which always names the actual stuck session regardless of which sub-case
   produced `parentNudged:false`.
4. `classify()` (companion/attention-push.ts) mapped this event to `"worker-crashed"` — a `FLEET_OPS_ALERT_CLASSES`
   member, excluded from Companion lead-mode's `"*"` wildcard push subscription. This event is BY
   DEFINITION the no-manager-addressed case: the owner is the one party left to tell, so excluding it from
   the lead-mode wildcard contradicted "always routed to the owner" below (point 3's bullet). Fixed:
   reclassified to `"escalation"` (not a FLEET_OPS class) — same "nothing automated is left to resolve
   this" shape as `platform_escalate`, which already owns that class.
5. `notifyLeadOfStuckManager` reused the prior `leadBoardTaskId` unconditionally, even once the Lead had
   already closed/resolved it — a NEW stuck episode landed silently onto an already-closed card instead of
   filing fresh. Fixed: reuse only while `columnEscalationStatus(home.id, task.columnKey) !== "resolved"`
   (the same still-open check `platformEscalate` uses for its own dedup); a closed or deleted prior task
   files a new one.

See "Do not" below for what NOT to re-break; the sections above (Background / role-set split / kickoff
hold / notification routing) are round 1 and still accurate except where flagged.

## Background

Card 01160ae3 armed the boot-dialog-stuck detector (`pty/host.ts`'s `dialogStuckTimer`) and its kickoff
hold (`isBlockedOnUnresolvedBootDialog`) only for `LOOM_DRIVEN_ROLES` (worker, setup, auditor,
workspace-auditor, run, assistant), and `handleClaudeBootDialogStuck` (sessions/service.ts) notifies only
the parent session. Two gaps, found at Code Review `2c44891b`:

1. Managers (and the LOOM_DEV Platform Lead) were not covered, even though they boot unattended too
   (overnight, after a `daemon_restart` resume, a recycle successor) and project memory
   `external-import-dialog-hangs-unattended-spawn` names them as exposed to the same dialog families.
2. A parentless `LOOM_DRIVEN_ROLES` session (a top-level `setup`, a top-level `run`, the companion
   `assistant`) got only a durable event — nobody was ever addressed to read it.

## The role-set split

`LOOM_DRIVEN_ROLES` is also `disallowedToolsForRole`'s human-prompt-tool gate (decision 8dd1dd1c), which
explicitly forbids adding manager/platform there — they legitimately surface decisions to the human and
must keep `AskUserQuestion`/`ExitPlanMode`/`EnterPlanMode`. So covering manager/platform for the detector
could NOT be done by widening `LOOM_DRIVEN_ROLES` itself. A new, separate constant,
`BOOT_DIALOG_DETECTOR_ROLES = [...LOOM_DRIVEN_ROLES, "manager", "platform"]`, is used ONLY by the
spawn-time arm check and `isBlockedOnUnresolvedBootDialog` — `disallowedToolsForRole` is untouched.

## The kickoff hold now covers manager/platform too, unconditionally

`isBlockedOnUnresolvedBootDialog` now also holds a manager/platform kickoff (and the queued-drain path)
behind an unresolved boot dialog. No "owner is watching live" carve-out: there is no reliable
live-attention signal (a connected viewer is not the same as attention — "Sessions outlive viewers",
closing a ws never kills the pty), and even a genuinely-watching owner can dismiss the dialog themselves,
which flips `SessionStart`/`isPastBoot` and releases the hold through the ordinary path. The hold's
benefit (never auto-confirm an unreviewed dialog default) is role-independent; its cost is NOT uniformly
"bounded latency" though (round 2 correction) — that's only true when `SessionStart` arrives on its own
shortly after dismissal. If `SessionStart` is MISSED after a real dismissal, the hold lasts until a human
notices and acts — bounded only in the sense that the 150s alarm (`CLAUDE_BOOT_DIALOG_STUCK_TIMEOUT_MS`)
still fires and pages someone; it is not a fixed, small latency ceiling on its own.
A resumed/recycled manager reaches `isPastBoot` the same way any other role does — `createPty` resets
`sessionStartObserved`/`anyHookObserved` to false on every spawn call (fresh/resume/fork/recycle alike),
and the resumed CLI process fires a fresh `SessionStart` hook, which flips it back to true and releases
the hold via the normal `markReady`/`drainPending` path — no special-casing needed.

## Notification routing, per case

Never a nudge typed into the stuck session itself (01160ae3's rule is unconditional across every case
below).

1. A `LOOM_DRIVEN_ROLES` session with a live, past-boot manager parent — unchanged: notify the parent only.
1b. A `LOOM_DRIVEN_ROLES` session whose parent EXISTS but is itself live-and-pre-boot on the same dialog
    family (850eb55c's hazard) — `parentNudged` is false here too, same as case 2 below, even though a
    parent id is present: typing a nudge into a parent that's sitting on the same dialog right now would
    land on, and could confirm, the PARENT's own dialog. `detail.parentNudged === false` is the ONE
    structural condition both this sub-case and case 2 share, and both route into the owner's
    attention-alert surfaces identically — a reader deriving "parentNudged:false" from "no parent exists"
    alone would miss this sub-case.
2. A parentless `LOOM_DRIVEN_ROLES` session (no manager parent at all) — no parent exists to nudge. The
   durable `claude_boot_dialog_stuck` event (already always filed) is additionally classified into the
   owner's attention-alert surfaces (`companion/attention-push.ts`'s `classify()`), gated on the event's
   own `detail.parentNudged === false` — so this only fires when nobody else was addressed, not on every
   ordinary covered case. (Round 4: a web attention-list item for this case was built at rounds 2-3 and
   cut to card `b1da256d` — see the Round 4 section above. This card's own owner-facing surface is
   `attention-push.ts` alone.)
3. A manager — no manager row ever carries a `parentSessionId` under any current spawn path (verified:
   `startManager`, including the platform-lead cross-project spawn `spawnSessionAsPlatform`), so the
   existing parent-nudge logic can never reach anything for a manager. Both of the following happen,
   unconditionally (not an either/or):
   - If `LOOM_DEV` is on: best-effort live-nudge a live Platform Lead (mirroring `platformEscalate`'s
     lookup, suppressed if the Lead is itself live-and-pre-boot on the same dialog family — the identical
     hazard 850eb55c already guards for a manager parent), AND file a durable task onto the reserved
     Platform-home board (mirrors `platformEscalate`'s durable-first design) so an offline Lead still sees
     it later. The board-task filing is deduped per session id (never re-filed for a second stuck episode
     of the SAME session row/generation; a recycle mints a new session id and may file its own).
   - Always, regardless of `LOOM_DEV`: the durable event is also routed to the owner's attention-alert
     path (same mechanism as case 2) — most installs have no Platform Lead at all, and even when one
     exists it may not be live/attentive, while a stuck project manager blocks that whole project.
4. The Platform Lead itself, stuck pre-SessionStart — structurally a parentless case (nothing above a
   Lead) — same as case 2, owner-alert only.

## Do not

- Do not add "manager"/"platform" to `LOOM_DRIVEN_ROLES` — reuse `BOOT_DIALOG_DETECTOR_ROLES` instead, or
  `disallowedToolsForRole` silently stops disallowing the human-prompt tools for a Loom-driven role (none
  are affected today, but a future caller of `LOOM_DRIVEN_ROLES` could be).
- Do not add a "human is watching live" carve-out to `isBlockedOnUnresolvedBootDialog` for manager/
  platform — there is no reliable signal for it, and the hold never takes a WRONG action; its cost is
  bounded latency only in the ordinary case (see the correction above — a missed-SessionStart-after-
  dismissal case lasts until a human acts, not a fixed small window).
- Do not reclassify `claude_boot_dialog_stuck` back to `"worker-crashed"` in `attention-push.ts`'s
  `classify()` — that's a `FLEET_OPS_ALERT_CLASSES` member, excluded from Companion lead-mode's `"*"`
  wildcard push, which would silently defeat "always routed to the owner" (case 3's bullet above) for
  exactly the surface most likely to BE the owner's attention channel. Use `"escalation"` instead.
- Do not re-add the web BOOT STUCK attention item, or the `claude_boot_dialog_resolved` event kind/hook/
  handler, to THIS card — they were cut at round 4 to card `b1da256d`, which starts from a design-first
  checkpoint carrying every lesson rounds 2-3 found (including the one that triggered the cut: the resolve
  must fire on `anyHookObserved` flipping, not `SessionStart` alone). Land that work there, not here.
- Do not gate the manager's Platform-board-task dedup on the timer fire or the detection event — key it on
  the session id (one board task per session row/generation), so a second stuck episode of the SAME
  resumed session never files a duplicate task, but a recycle successor (a new session id) still can.
- Do not classify `claude_boot_dialog_stuck` into the owner attention surfaces unconditionally — gate on
  `detail.parentNudged === false`, or a worker/setup case with a live manager parent (already handled)
  would also page the owner, which is noise beyond what 01160ae3 intended.
- Do not key the `companion/attention-push.ts` escalation re-delivery dedup (`escalationSurfaced`) or its
  `stampEscalation`/`taskIdResolvable` companions on `cls === "escalation"` — that class now also covers
  `claude_boot_dialog_stuck`, whose detail carries no title/severity, so its signature collapses to a
  constant `"|"` and permanently suppresses every later episode for the same taskId. Scope all three to
  `e.kind === "platform_escalate"` specifically.
- Do not use a plain `.find()` over `Db.listEventsForWorker` to find the LATEST matching event — that
  method returns ts-ASC order, so `.find()` returns the OLDEST match. Use `.findLast()`.
