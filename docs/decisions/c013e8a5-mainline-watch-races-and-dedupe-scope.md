# c013e8a5 — close three mainline-watch races, scope the divert dedupe to the live episode, and alert on a persistent first-sight resolver failure

Round-3 delta Code Review of `2a6a292a`, plus a carried-in follow-up from `787dd2a7` round 2's own Code Review (`ab4ce11c`). All four items were found by code reading; none were reproduced in production.

## 1. `checkMainlineMove` vs a reset/rebind mid-await (Race 1)

`checkMainlineMove` reads the raw watermark row (`rawW`) BEFORE awaiting the head read. A reset
(`Db.resetMainlineWatermark`, the human-only route) or a rebind (`Db.resetMainlineBaselinesForRepoChange`)
that lands DURING that await deletes the row; the check then resumed with the stale `rawW`-derived `w`
and could file a `branch-diverted` alert whose `expectedBranch` is the PRE-reset branch — after a
deliberate rename+reset, that literally tells the manager to undo the very action that just fixed things.

Fixed with a CAS, immediately after deriving `w` from `watermarkRead` and before any divert-filing or
sha-classify logic: `if (this.db.getMeta(key) !== rawW) return null;` — the same compare-and-set shape
`store()` already uses. The losing side skips SILENTLY (no event, no store, no nudge), matching the
existing `if (!head) return null;` fail-open line immediately above it.

## 2. `advanceMainlineWatermark{,ForBatch}` vs a concurrent seed mid-await (Race 2)

On the `watermarkRead.state === "absent"` branch, `await firstSightSeedAllowed(...)` awaits a git read
BEFORE the unconditional final `setMeta`. A concurrent writer (boot's own first-sight CAS seed via
`store()`, or a sibling landing) can seed W during that await; the unconditional write then clobbered it
with THIS call's own (possibly stray) branch.

Fixed: capture `const rawW = this.db.getMeta(key);` once at the top (feeding `readMainlineWatermarkStrict`),
then immediately before the final `setMeta`: `if (this.db.getMeta(key) !== rawW) return;`. Applied
UNCONDITIONALLY (not just inside the "absent" branch) so the code stays uniform — cheap (one extra
`getMeta`), and it also backstops Race 3 below for the common "something was already stored" case.

## 3. `advanceMainlineWatermark{,ForBatch}` vs a repoPath rebind mid-await (Race 3)

`repoPath`/`checkedTip` are captured by the CALLER before this async method starts. If `Db.updateProject`
rebinds the project's `repoPath` for this `repoKey` WHILE this method is still mid-await, it finishes
computing `head`/`checkedTip` from the OLD repo and seeds the OLD repo's branch/tip under a key that now
names the NEW repo.

Race 2's CAS alone does not catch the TRUE-first-sight case: a rebind's own
`resetMainlineBaselinesForRepoChange` is a no-op when nothing was stored yet (`if (this.getMeta(wKey) ===
undefined && rawMarker === undefined) continue;`), so `rawW` stays `undefined` on both sides of the await
and the CAS passes. Fixed with a SEPARATE guard, right after Race 2's CAS and before the same final
`setMeta`: re-resolve the project's CURRENT repo for `repoKey` (`resolveRepoByKey`, already imported) and
compare its `path` to the `repoPath` parameter; skip if they disagree. A thrown `UnknownRepoKeyError` (the
registry entry was removed, not just repathed) propagates into the method's own existing fail-open catch —
same visibility class as every other fail-open path there.

## 4. Reset-audit `previousWatermark` (`Db.resetMainlineWatermark`)

The human-reset event didn't record the W it erased — the only trace a reset adopted a stray branch.
Added `previousWatermark: {branch, sha}` (via `parseMainlineWatermark(rawW)`, new value import from
`git/mainline-watch.js`), mirroring the rebind event's `fromPath`/`toPath`. Omitted when the row was
already absent or unparseable — nothing valid to report.

## 5. Divert dedupe scope (`hasMainlineDivertEvent` / `checkMainlineMove`)

Two independent gaps:

- **(a) `detail.branch` was not part of the match.** `hasMainlineDivertEvent` matched only
  `(from, to, blockedBy.from, blockedBy.to, evidence)`. A same-commit divert never moves the tip, so two
  DIFFERENT stray branches share the same `(from, to)` and collided: divert→return-to-main→divert-to-
  stray-B under the same undelivered occupant filed nothing for stray-B. Fixed by adding `branch` to both
  the function's params and its SQL match, threaded from `head.branch` at the call site.
- **(b) nothing ended the "episode" while one occupant stands.** Even with (a), a resolve-then-re-divert-
  to-the-SAME-branch under the same occupant would still match the prior, already-resolved episode's
  event. Fixed with a new per-(project, repoKey) meta key (`mainlineDivertEpisodeKey`): seeded (read-or-
  set-now) the FIRST time the `keepPriorMarker` fallback path is used for a divert, BEFORE the event below
  is filed (so `ts >= episodeSince` can never exclude the very event that opens the episode); deleted the
  instant `checkMainlineMove` observes the branch agree with W again (every path through the
  branch-mismatch block returns, so reaching past it means reunification — gated on that LIVE state, never
  on "a marker exists", which is a recurring bug class in this file). `hasMainlineDivertEvent` gained an
  optional trailing `sinceTs` bound (`AND ts >= ?`, defaulted to `""` so an omitted bound matches every
  real ISO timestamp).

## 6. Repeated first-sight resolver failure (carried in from `787dd2a7` round 2's Code Review)

A `"failed"` (transient) `resolveMainlineBranchState` read previously only logged a `console.warn` once
per attempt (`worktrees.ts`) — no durable trace no matter how long it persisted.

Fixed inside `firstSightSeedAllowed` (now takes one object param, threading `projectId`/`repoKey`/
`source`/the session triple from all three call sites — `checkMainlineMove`'s boot-absent branch, and both
`advanceMainlineWatermark{,ForBatch}`): a new per-(project, repoKey) streak counter
(`mainlineDeferStreakKey`) increments on every `"failed"` read and resets on any SETTLED read
(`"resolved"`/`"no-default"`). At `MAINLINE_FIRST_SIGHT_DEFER_ALERT_THRESHOLD` (3) consecutive failures,
`recordFirstSightResolveDeferred` fires.

**Code Review ruling on delivery (this card's own review):** a bare, unaddressed durable event is a
passive notice that gets read past. `recordFirstSightResolveDeferred` mirrors `recordFirstSightSeededStray`'s
REAL addressed-notice shape — not `recordFirstSightDeclined`'s passive, immediately-`nudgedAt`-stamped
marker: it reuses the SAME `mainline_moved_outside_loom` kind, the SAME alert-marker slot +
`deliverPendingBootAlerts`/`onOrchestrationMcpFirstSeen` delivery path, and the SAME "an unrelated
undelivered marker in the slot ⇒ still append the event, skip only the marker" rule every other real alert
already follows — so a project's manager actually receives it when one is addressable.

**Confirmed at source before choosing this shape:** reusing `mainline_moved_outside_loom` with a new
evidence tag risked being misread as "mainline moved without a landing" by `mainlineMovedNudgeText`'s
GENERIC fallback branch (the "...WITHOUT a Loom landing... bypass of the merge gate" text) — which is
exactly what would have rendered for an unrecognized evidence tag. Fixed by giving
`"first-sight-resolve-deferred"` its OWN wording branch in `mainlineMovedNudgeText`, same pattern as the
existing `"first-sight-seeded-stray"`/`"branch-diverted"` branches. Checked the other two real consumers
of this event kind: `companion/attention-push.ts`'s `classify()` has no `case` for `mainline_moved_outside_loom`
(falls to `default: null` — never pushed to companion attention at all), and `packages/web` has zero
references to this event kind. So `mainlineMovedNudgeText` was the only rendering surface that needed a
dedicated branch.

**Why N=3:** each count is a genuinely separate real attempt (one per boot pass, one per landing), never a
tight retry loop, and the read itself is a purely LOCAL `git symbolic-ref` (no network) — so a single or
even double miss is unremarkable boot-time-load flakiness (see `f96b9d7c`'s own comment on this same
read). Three independent misses in a row is a meaningfully low bar for "this repo's git health is
structurally stuck" without being trigger-happy on ordinary jitter.

## 7. Test-fixture fix (`batch-merge-watermark-branch-pin.mjs`, the (W1) cleanup)

The (W1) scenario's cleanup used a raw `db.setMeta(KEY, ...)` to simulate "a human reset", with a comment
implying `resetMainlineWatermark` re-seeds. It only DELETES the row (`787dd2a7`'s own correction). Fixed:
exit via the REAL route (`db.resetMainlineWatermark`), then re-seed via a GENUINE landing (one more
ordinary `addWorker`+`batch`), never a second raw `setMeta`.

## 8. Nitpick (`gateway/server.ts`, the reset route's own comment)

The comment claimed the route's MCP-absence was "checked by the surface-drift tests this card's own test
file runs" — there is no MCP registration for a REST route to begin with, so no surface-drift test checks
its absence. Reworded to state that plainly: absent from every MCP router by construction, nothing for a
drift test to check.

## Round 2 (gen 392, from Code Review `2af61378` — APPROVE-with-minors, folded before merge)

1. **Boot delivery gap.** A boot-sourced persistent-defer notice (§6 above) records a `nudgedAt:null`
   marker, but `checkMainlineMove`'s boot-absent branch never called `deliverPendingBootAlerts` the way
   every other boot alert path does — delivery waited on a manager's own next `onOrchestrationMcpFirstSeen`,
   which may already have fired before the streak crossed its threshold. Fixed: call
   `this.deliverPendingBootAlerts(a.projectId)` at the end of that branch (after the decline/defer handling,
   never on the "allow" path, which has nothing pending to deliver).
2. **Notice before the CAS.** `advanceMainlineWatermark{,ForBatch}`'s `recordFirstSightSeededStray` call
   fired BEFORE the Race-2/Race-3 guards (§2/§3 above), so a race that skipped the store left the manager
   told a seed happened that didn't. Fixed: the call is deferred into a closure (`seedStray`) and invoked
   only after both guards pass, immediately before the final `setMeta` — everything after the awaits is
   synchronous, so there is no new race window between the notice and the store.
3. **Unbounded re-append.** The defer-streak notice (§6) fired on `streak >= THRESHOLD`, deduped only via
   its own marker. When the marker slot was held by an UNRELATED undelivered alert (`keepPriorMarker`),
   `recordFirstSightResolveDeferred` never got to write its own dedupe marker — so every later attempt
   past the threshold appended another event, unbounded. Fixed: `streak === THRESHOLD`, firing exactly
   once per streak run regardless of marker occupancy.
4. **Same race class, sha-level path.** `checkMainlineMove`'s CAS (item 1 above) covers only the head-read
   await; the sha-level path makes a SECOND await (`mainlineFactsReader`) before any file/marker write, and
   a reset/rebind landing in THAT window was still invisible. Fixed: repeat `getMeta(key) !== rawW`
   immediately after the facts await resolves, before computing or acting on the verdict.
5. **Boot first-sight rebind hole.** `checkMainlineMove`'s boot first-sight "allow" branch called `store()`
   with no repoPath reconfirmation — the one guard `advanceMainlineWatermark{,ForBatch}` already have. A
   rebind during `firstSightSeedAllowed`'s own resolver await could seed the key (now naming a NEW repo)
   with the OLD repo's head data. Fixed: the same `resolveRepoByKey(project, repoKey).path === repoPath`
   check guards the `store()` call.
6. **Doctrine drift (`orchestrate/SKILL.md`).** The shipped skill glossed `[loom:mainline-moved]` as only
   "the mainline moved WITHOUT a landing" — true of the original sha-level alert, but the notice now also
   covers `first-sight-seeded-stray`, `branch-diverted`, and `first-sight-resolve-deferred`, none of which
   is a move. Reworded generically: read the evidence tag; only a genuine move warrants asking the owner.
7. **Corrupt-row reset trace.** `Db.resetMainlineWatermark` omits `previousWatermark` for a
   present-but-unparseable row (nothing valid to report) — but that left NO trace of the corrupt content at
   all. Fixed: carries `previousWatermarkRaw` (the raw string, truncated to 200 chars) whenever the row was
   present but failed to parse.
8. **Dead term.** `recordFirstSightResolveDeferred`'s `keepPriorMarker` computation carried a trailing
   `&& !(prev.evidence.includes(...) && prev.branch === a.branch)` term that is always true by the time
   it's evaluated — the function's own early return just above already guarantees it. Dropped.

**Accepted residual (item 8's own note, no code change):** the divert-episode dedupe (§5 above) compares
wall-clock ISO timestamps (`ts >= episodeSince`), so a backward clock step DURING an open episode could let
a stale event re-match. Low impact — a backward step large enough to matter is itself an anomaly a host
would show elsewhere, and the worst case is one extra duplicate-looking event, never a missed alert.

## Do not

- Do not remove the CAS in `checkMainlineMove` (item 1) — it is the ONLY guard against a reset/rebind
  landing during the head-read await; removing it reopens the "divert alert describes the pre-reset
  branch" bug.
- Do not remove either the CAS or the repoPath reconfirmation in `advanceMainlineWatermark{,ForBatch}`
  (items 2/3) on the theory that one subsumes the other — they catch genuinely different race shapes (see
  item 3's own explanation of why Race 2's CAS alone misses the true-first-sight rebind case).
- Do not revert `hasMainlineDivertEvent`'s dedupe to match on `(from, to, blockedBy)` alone, and do not key
  its episode scoping to "a marker exists" rather than the LIVE branch-vs-watermark state — both are the
  exact bugs item 5 closes.
- Do not seed the divert-episode key AFTER filing the event it gates — the ordering (seed first) is what
  guarantees `ts >= episodeSince` can never exclude the event that opens the episode.
- Do not route a future repeated-transient-failure-class notice through `recordFirstSightDeclined`'s
  passive marker shape; use `recordFirstSightSeededStray`'s real-addressed-notice shape instead, per this
  card's own Code Review ruling.
- Do not add a new evidence tag to `mainline_moved_outside_loom` without checking whether
  `mainlineMovedNudgeText`'s generic fallback branch would misrender it — give it its own branch if so.
- Do not forget `deleteProject`/`resetMainlineWatermark`/`resetMainlineBaselinesForRepoChange` when adding
  a new per-(project, repoKey) mainline-watch meta-key prefix — all three must purge it alongside W, or it
  becomes an unbounded orphan class.
- Do not re-widen the defer-streak notice's trigger back to `streak >= THRESHOLD` (round 2 item 3) — it is
  unbounded exactly when the marker slot is held by an unrelated undelivered alert, since that path never
  gets to write its own dedupe marker.
- Do not call `recordFirstSightSeededStray`/`seedStray` before the CAS + repoPath reconfirmation pass in
  `advanceMainlineWatermark{,ForBatch}` (round 2 item 2) — the notice must describe a seed that actually
  happened.

## Tests

`packages/daemon/test/mainline-watch-race-guards.mjs` — new file, each race proven RED-first (temporarily
reverted the three guards in `service.ts` and the `branch`/`sinceTs` match in `db.ts` during development,
confirmed the corresponding assertions fail, then restored and confirmed green): R1 (checkMainlineMove CAS),
R2/R2-batch (advance CAS), R3/R3-batch (repoPath reconfirmation), the defer-streak threshold + reset
behavior, delivery to an addressable manager, and the nudge text's own wording. Round 2 adds, same file,
same RED-first discipline: R4 (the second CAS after the facts-read await), R5 (the boot first-sight
repoPath reconfirmation), notice-reorder-R2/R3 (the seeded-stray notice only after its own guards pass),
defer-unbounded (the streak fires exactly once past the threshold even with the marker slot held by an
unrelated alert), and defer-deliver (a boot-sourced notice reaches a LIVE manager via
`deliverPendingBootAlerts` immediately, not on a later `onOrchestrationMcpFirstSeen`).
`packages/daemon/test/mainline-watermark-reset-route.mjs` (F)/(G) — round 2: `previousWatermarkRaw` for a
present-but-unparseable row, and its 200-char truncation bound.
`packages/daemon/test/mainline-watch-branch-divert.mjs` (D8)/(D9) — dedupe-scope item 5(a)/(b), also
RED-first (reverted `hasMainlineDivertEvent`'s `branch`/`sinceTs` match, confirmed both go red — D8's
first assertion also caught a stronger cross-section collision against an unrelated earlier test's
leftover event, confirming the fix's necessity). `mainline-watermark-reset-route.mjs` (A)/(E1)/(F) —
`previousWatermark` presence and omission. `batch-merge-watermark-branch-pin.mjs` — the real-route fixture
fix.
