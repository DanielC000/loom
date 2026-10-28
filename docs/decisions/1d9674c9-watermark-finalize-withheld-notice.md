# 1d9674c9 — surface boot-reconcile Pass A's project-wide finalize-withholding durably

## Narrative

Reviewer-confirmed gap (from card `eb58b8bd`'s own decision record, "A pre-existing, unrelated effect
this card's tests surfaced"): while a project's stored mainline watermark is unreadable or names an
unresolvable ref, `reconcileOrchestrationOnBoot`'s Pass A (`sessions/service.ts`) silently withholds
landed-lookup/finalize for EVERY already-landed worker in that (project, repoKey), every boot. The only
output was two aggregated `console.warn` lines (`unreadableWatermarkSkipCount`/
`unresolvableWatermarkRefSkipCount`) — no event, no nudge, nothing in the boot summary returned to
`index.ts`. This is distinct from card `1fae1b98`'s own per-SESSION nudge for the stale-generation
sub-path (`resolveStaleGenerationOwnLanding`) — that fix already closed the gap for ONE worker's own
blocked `merge_request`; this card closes it for Pass A's ordinary per-worker finalize-by-scan skip,
which can affect a variable, unbounded set of workers sharing a (project, repoKey) each boot.

## Design

- **One-shot per (project, repoKey)**, not per session or per worker — the skip is a project+repoKey-wide
  precondition, not a fact about any one worker's row. A new app_meta marker,
  `WATERMARK_FINALIZE_SKIP_PREFIX` (`db.ts`), one JSON row per pair: `{cause, branch?, detectedAt,
  nudgedAt}`. `Db.recordWatermarkFinalizeSkip` never resets `detectedAt`/`nudgedAt` on an existing marker
  (only `cause`/`branch`, which may legitimately flip between `"unreadable"` and `"ref-unresolvable"`
  across boots without re-arming the one-shot nudge); `isNew` is true only the first time a marker is
  created since the last clear, so the caller appends the durable `watermark_finalize_withheld` event
  exactly once per episode, never once per boot.
- **Hook point: the per-(project, repoKey) cache-MISS branches**, not the per-worker `continue` sites.
  `mainlineRefCache`/`mainlineRefResolvesCache` already resolve each pair exactly once per pass; the
  record/clear calls sit inside those same cache-miss branches, so the DB read/write/event/nudge-attempt
  happens once per pass regardless of how many workers share that pair this boot — mirroring how
  `unresolvableWatermarkRefLabels` (a `Set`) already dedupes the *log text* today.
- **Delivery: a deliberately PARALLEL mechanism**, never `MAINLINE_BOOT_ALERT_PREFIX`/
  `mainlineMovedNudgeText` — those describe an unrelated cause (a mainline-move tripwire), and reusing
  them would misdescribe this one. `SessionService.deliverPendingWatermarkFinalizeSkipNotices` is a new,
  parallel method with the SAME structural shape as `deliverPendingBootAlerts`: `db.listLiveManagersInProject`
  + an atomic compare-and-set claim on `nudgedAt` (null -> now) so the nudge fires exactly once even with
  no live manager at detection time. Called from the same two hook points `deliverPendingBootAlerts` is
  called from: immediately after filing (Pass A, in case a manager is already live) and from
  `onOrchestrationMcpFirstSeen` (the one chokepoint every manager spawn/resume/fork/first-MCP-seen path
  crosses). The nudge text (`watermarkFinalizeWithheldNudgeText`) names the human remedy: check out the
  correct mainline branch in the canonical repo FIRST, then `POST /api/projects/:id/mainline-watermark/reset`
  (loopback, human-only) — the reset adopts whatever is currently checked out, so the order is stated
  explicitly, matching `CLAUDE.md`'s own manager-checkout-ordering note for this same route.
- **Re-arm, two routes.** (1) Pass A clears the marker (`Db.clearWatermarkFinalizeSkip`) the moment a
  later pass resolves the SAME (project, repoKey) OK again — at the same cache-miss hook points, mirroring
  `clearMergeReconcileWedge`'s "resolved again (e.g. a human fixed the registry) — stop tracking" posture.
  (2) Every mainline-watermark purge path also clears it: `purgeMainlineWatermarkState` (shared by the
  human reset route and `repointMainlineWatermark`), `resetMainlineBaselinesForRepoChange` (a repo
  rebind/repath), and `deleteProject`'s sweep — mirroring card `c013e8a5`'s own rule ("do not forget to
  purge a new per-(project,repoKey) mainline-watch meta-key, or it becomes an unbounded orphan class"),
  even though this key lives outside `git/mainline-watch.ts`.
- **Boot summary.** `reconcileOrchestrationOnBoot`'s return type gains `watermarkSkipAffectedPairs: number`
  — a count of DISTINCT (project, repoKey) PAIRS skipped this pass, never the same number as the existing
  per-SESSION `unreadableWatermarkSkipCount`/`unresolvableWatermarkRefSkipCount` (which stay
  `console.warn`-only; a manager-facing summary cares about "how many projects are stuck," not "how many
  workers"). `index.ts` surfaces it as its own non-zero-gated line, matching the `worktreesReviewForkReclaimed`
  convention (readability, not a test constraint — see the `fdf93d3a`/`8e5a7a5e` anchors on the combined
  line).
- **Event kind: `watermark_finalize_withheld`** (`packages/shared/src/types.ts`'s `OrchestrationEventKind`
  union). `detail`: `{projectId, repoKey, cause: "unreadable" | "ref-unresolvable", branch?}`. Filed under
  `managerSessionId: ""` (no single owning session — a project-wide condition, same sentinel as
  `mainline_moved_outside_loom`). Deliberately NOT added to `EVENT_TRIGGER_EVENT_KINDS`/
  `GATE_HISTORY_KINDS`/`ORCH_ACTIVITY_KINDS`/`REPORT_RESOLVED_EVENT_KINDS` — same audit/notice posture as
  `mainline_moved_outside_loom`'s own siblings (`commondir_trust_pinned`, `landing_trailer_displaced`,
  `engine_session_rotated`).

## Ruling: no cross-mechanism dedupe with card `1fae1b98`

Different scope, same root condition (`resolveMainlineWatermarkRef`/`readBaseSha` failing for the same
(project, repoKey)). `1fae1b98`'s nudge is per-SESSION (one stale-generation worker's own blocked
`merge_request`), delivered to a single targeted recipient via `resolveSettleNudgeTarget`. This card's
signal is per-(project, repoKey), delivered to every live manager of the project. On one boot with a
broken watermark, BOTH can legitimately fire for the same underlying cause: a stale-generation worker in
that project gets `1fae1b98`'s nudge, AND every ordinary worker Pass A skips (including other workers in
the same project) triggers this one. **Confirmed: do NOT dedupe across the two mechanisms** — they are
different, independently-one-shot signals describing different symptoms (one worker's blocked
`merge_request` vs. an entire project's finalize pass withheld), carrying forward `1fae1b98`'s own stated
trade-off verbatim: "two independent one-shot nudges CAN fire for one session... each stays honestly
scoped to the cause it actually observed."

## Round 2 (Code Review, follow-up card `1d9674c9` round 2)

- **MAJOR, fixed.** The first cache-miss hook (resolving `mainlineRefResolution`) used to clear the
  marker on EVERY non-`"unreadable"` state, including `state:"ok"` with a `branch` set — but a
  well-formed watermark naming a DEAD branch also reads `state:"ok"` (the row parses fine; only the later
  `readBaseSha` ref-resolvability check, a few lines down, can tell the branch doesn't exist). Clearing
  here raced that later check: it wiped the marker, then the ref-resolvability branch found the ref
  didn't resolve and re-filed a BRAND NEW marker (`isNew:true`) — re-firing the durable event + nudge
  every single boot instead of staying one-shot. Fixed by narrowing the clear to only
  `!mainlineRefResolution.ref` (no watermark ever stamped for this pair — truly nothing left to check);
  anything that still names a branch defers its clear to the `refResolves === true` branch below, which
  was already correct. Confirmed RED at `628dad89` via `negative-control --ref 628dad89` (4 failures: a
  5th and 6th boot each added a further event + nudge instead of staying at the 2 filed by boot 4), GREEN
  after. New test case `REF_UNRESOLVABLE_PERSISTS_ACROSS_BOOTS_NO_REFIRE` (boots 5+6 on the SAME
  ref-unresolvable episode `FRESH_BREAK_AFTER_REARM` left behind) mirrors
  `PERSISTS_ACROSS_BOOTS_NO_REFIRE`, which only ever exercised the `"unreadable"` cause — that cause never
  hit this race because `resolveMainlineWatermarkRef` itself already returns `state:"unreadable"` for it.
- **MINOR, fixed.** `watermarkFinalizeWithheldNudgeText` now quotes the marker's own `detectedAt`
  ("...as of `<detectedAt>`...") and states plainly that the observation may be stale, since delivery can
  land on a LATER boot than detection (`onOrchestrationMcpFirstSeen`, once a parked manager resumes) — no
  re-check added at delivery time; this is a residual, not closed (see below).
- **MINOR, fixed.** `deliverPendingWatermarkFinalizeSkipNotices`'s catch-and-hand-back-the-claim branch
  was missing `deliverPendingBootAlerts`'s own "At-least-once: a manager enqueued before the throw may be
  told again" note — restored verbatim.
- **QUESTION, answered: left OUT of `DURABLE_AUDIT_EVENT_KINDS` deliberately.** That set exists so
  `deleteAgent`'s cascade (`DELETE FROM orchestration_events WHERE (manager_session_id = ? OR
  worker_session_id = ?) AND kind NOT IN (...)`) doesn't delete a durable row when the SESSION it's keyed
  to is deleted. `mainline_moved_outside_loom` is in the set because several of its OWN call sites file it
  with a real `managerSessionId`/`workerSessionId` (e.g. `checkMainlineMove`'s landing-path callers,
  `sessions/service.ts:6694`/`24189`/`24218`/`24499`/`24520`) — those rows ARE reachable by that cascade
  query and would otherwise be lost. `watermark_finalize_withheld` has exactly ONE call site
  (`fileWatermarkFinalizeSkip`) and it ALWAYS files with `managerSessionId: ""` (never a real session id,
  and no `workerSessionId` at all) — the cascade's `WHERE (manager_session_id = ? OR worker_session_id =
  ?)` can never match `""` against a real agent's session id, so this kind can never be cascaded away by
  `deleteAgent` regardless of set membership. Leaving it out matches `9f7f2b50`'s own rule (only add a kind
  that is genuinely reachable by the cascade); `deleteProject`'s separate full-project purge still removes
  it via the app_meta prefix sweep either way, unaffected by this set.

## Named residual (stated, not fixed)

The marker only re-arms via route (1) above (a later PASS actually resolves that pair, i.e. some worker
needs finalize there and the resolution succeeds) or route (2) (a purge path). A (project, repoKey) pair
that has NO eligible worker at all this boot (none matches `s.role === "worker" && s.branch && s.taskId`
reaching Pass A's watermark check) never gets its cache entry re-resolved, so a marker can sit un-cleared
even after the underlying watermark condition has genuinely resolved, until some worker's own landed-
lookup needs that pair again. This is the same lag shape the sibling mainline-watch mechanisms already
accept (see `2a6a292a`'s "fail-open advance-skip lag" note) — not a new defect, and not fixed here.

**Round 2 addition:** the nudge's own `detectedAt` can be stale by the time a manager reads it — detection
(Pass A) and delivery (`deliverPendingWatermarkFinalizeSkipNotices`, called from both the filing site and
`onOrchestrationMcpFirstSeen`) are not the same instant, and a manager that was offline at detection only
reads the notice once it resumes, by which point the underlying condition may already have cleared (or
worsened). The nudge text now states this explicitly rather than implying "this boot"; no re-check was
added at delivery time — see the MINOR item above.

## Purge discipline (card `c013e8a5`'s rule)

Added `WATERMARK_FINALIZE_SKIP_PREFIX` to all three required purge sites, each with its own test:
`purgeMainlineWatermarkState`, `resetMainlineBaselinesForRepoChange`, `deleteProject`.

## Do not

- Do not reuse `MAINLINE_BOOT_ALERT_PREFIX`'s marker shape or `mainlineMovedNudgeText` for this cause —
  it is a deliberately parallel mechanism for an unrelated cause (finalize-withholding, not a mainline
  move).
- Do not record/clear the marker at the per-WORKER `continue` sites — always at the per-(project,repoKey)
  cache-miss branches, or the DB read/write/event/nudge-attempt re-runs once per worker instead of once
  per pass.
- Do not dedupe this signal against card `1fae1b98`'s own per-session nudge — see the ruling above.
- Do not add `watermark_finalize_withheld` to `EVENT_TRIGGER_EVENT_KINDS`/`GATE_HISTORY_KINDS`/
  `ORCH_ACTIVITY_KINDS`/`REPORT_RESOLVED_EVENT_KINDS` without a fresh case — audit/notice posture only.
- Do not forget to purge `WATERMARK_FINALIZE_SKIP_PREFIX` alongside W at any FUTURE mainline-watermark
  purge site — it is not itself a mainline-watch key (lives in `db.ts`, not `git/mainline-watch.ts`), so a
  future reader sweeping `git/mainline-watch.ts`'s own prefixes by import alone will miss it.

## Tests

`packages/daemon/test/watermark-finalize-withheld.mjs` (new): a broken watermark (both `"unreadable"` and
`"ref-unresolvable"` shapes) held across 2 boots with >=2 workers sharing one (project, repoKey) ⇒ exactly
ONE event + ONE nudge for the pair, never per-worker-per-boot; resolve ⇒ marker clears (re-armed), a
SUBSEQUENT break fires a fresh notice; a legacy/absent-marker boot (daemon upgraded onto a pre-existing
break) notifies once, same as a fresh break; purge coverage for all three sites above. RED via
`negative-control --ref <the mainline sha the branch was cut from>` against pre-card code (no event, no
nudge, no `watermarkSkipAffectedPairs` field at all), GREEN after.

**Round 2 addition:** `REF_UNRESOLVABLE_PERSISTS_ACROSS_BOOTS_NO_REFIRE` — the SAME `"ref-unresolvable"`
episode held across 2 FURTHER boots (5 and 6) ⇒ still exactly the 2 events/nudges boot 4 left behind, no
re-fire. RED via `negative-control --ref 628dad89` against the round-1 commit (4 failures: boots 5 and 6
each add a further event + nudge), GREEN after.
