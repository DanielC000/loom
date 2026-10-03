# 2a6a292a — the mainline watermark's BRANCH changes only on a trusted signal, never on an observed checkout

Follow-up to `4fa36502` (the mainline-move tripwire) and `b801bad0` (the batch branch pin). `checkMainlineMove`'s
"first sight of a branch" rule used to read `!w || w.branch !== head.branch` as ONE condition: both "no
watermark exists yet" and "a watermark exists but a different branch is checked out right now" fell through
to the same silent `store()`. The second case is not first sight at all — it is `checkMainlineMove` observing
whatever branch happens to be checked out (a human REST `GitWriter` checkout, a batch's own mid-gate divert,
`GitWriter.createBranch()`) and absorbing it as the new trusted baseline. That undid the tripwire on exactly
the divert it exists to catch: after `b801bad0`, a batch's branch pin preferring the stored watermark would
then also point at the stray branch, so both checks could pass while landing off mainline.

## Design

- **TRUE first sight** = no watermark has EVER been stamped for this `(project, repoKey)` (`!w`). Nothing
  exists yet to compare the live checkout against, so it is still initialised silently, unchanged.
- **A branch change under an EXISTING watermark** (`w.branch !== head.branch`) is never absorbed. It files a
  `mainline_moved_outside_loom` alert (`severity:"high"`, `evidence:["branch-diverted"]`, `suspectShas:[head.tip]`,
  plus `expectedBranch`/`observedBranch`) and leaves the watermark (both `branch` AND `sha`) completely untouched.
  The check never blocks or refuses — it is still a tripwire, not a sandbox (`4fa36502`).
- **Dedupe is DIFFERENT from every other evidence kind, because W never advances here.** A sha-level alert
  self-dedupes for free: `store()` runs unconditionally after it, so the SAME move can never classify as "alert"
  twice (the only accepted repeat is one event at boot + one more at the next landing, per `4fa36502`'s own
  dedupe rule). A branch-diverted alert has no such anchor — nothing ever advances past it — so it reuses the
  SAME `mainline-boot-alerted:<projectId>:<repoKey>` marker (`MainlineBootAlert`) for BOTH the boot path AND the
  landing path, keyed on `(from, to, evidence)` — NOT `(from, to)` alone, since a sha-level alert (e.g.
  reflog-raw-write) can coincidentally share a divert's `(from, to)` (a same-commit checkout never moves the
  tip): the first observation of a given triple files the event and sets the marker (`nudgedAt:null`); a repeat
  of the identical move neither re-files nor re-nudges once already delivered. This is deliberately looser
  than, and reuses rather than duplicates, the existing boot-only dedupe machinery — see the "Do not" list.
  **ROUND 3:** an UNRELATED undelivered marker already occupying the slot (`keepPriorMarker`) means a divert's
  OWN event can be filed with nowhere to record that fact in the marker — a repeated check of the SAME still-
  blocked divert would otherwise re-file and re-nudge forever. The fallback is the durable event log itself,
  scoped to `blockedBy` (the SAME occupant currently blocking the slot, not bare `(from, to)` — see the
  correction below for why bare `(from, to)` is unsafe here). See `mainline-watch-boot-reader.mjs`'s (R8).
- **ROUND 3 — delivering a PENDING marker must use ITS OWN `source`/`expectedBranch`, never the delivery
  site's defaults.** `deliverPendingBootAlerts` (the shared helper that later delivers a marker nobody was
  live to receive at filing time) used to call `mainlineMovedNudgeText` with `atBoot:true` unconditionally and
  no `expectedBranch` — correct for a genuine boot-sourced marker, wrong for a LANDING-sourced divert whose own
  inline nudge attempt simply failed (no manager at the time): it was delivered later with boot wording
  ("found when the daemon started") and an unresolvable `"(unknown — …)"` branch name. Fixed by reading both
  fields off the marker itself (`alert.source`, `alert.expectedBranch`), which `MainlineBootAlert` already
  carries for exactly this reason. See `mainline-watch-boot-reader.mjs`'s (R7)/(R7b).
- **The "configured mainline branch"** is the watermark's OWN `branch` field, once first established — not a
  live git read, not a per-call guess. It changes ONLY on an explicit, trusted signal:
  1. A real Loom landing: `advanceMainlineWatermark` (solo) / `advanceMainlineWatermarkForBatch` (batch).
     **ROUND 2 CORRECTION:** round 1 claimed these two functions "already behaved correctly" and were not
     part of the bug. FALSE — a Code Review found a landing can itself land ONTO a stray branch: if the
     canonical checkout was already diverted *before* a batch (or solo) op even started, `checkMainlineMove`'s
     own branch-mismatch check (run just before the squash/fast-forward) observed the mismatch correctly but
     still returned the observed tip on the landing path, which both call sites treated as "safe to advance" —
     so the advance helper then re-stamped `W.branch` to the stray branch, one step after the very check that
     caught the divert. Fixed two ways: (a) `checkMainlineMove` now returns `null` — never a tip — on a branch
     mismatch for BOTH the boot and the landing path (previously only boot did); the solo/batch call sites
     already only invoke the advance helper when their `checkedTip` is truthy, so this alone stops the
     re-stamp. (b) Both advance helpers ALSO independently read the current watermark and refuse to write a
     `branch` that disagrees with an existing one (no watermark yet ⇒ still allowed) — a defense-in-depth
     guard against the same case reappearing via any future caller that doesn't route through (a).
  2. A human rebind: `Db.resetMainlineBaselinesForRepoChange` (a real `repoPath`/registry change) deletes the
     watermark entirely, so the next check performs a genuine first-sight re-initialisation on whatever is
     checked out at that point.
  3. A deliberate mainline RENAME that is never routed through (2) is a residual: this card does not add a
     THIRD, independent "is this rename legitimate" signal (e.g. `origin/HEAD`) — most of this project's own
     git fixtures have no remote, which would make that signal indistinguishable from "no remote" on exactly
     the repos this project tests against. **ROUND 2 CORRECTION:** round 1 said such a rename "reflected by a
     Loom landing" is absorbed via (1) same as a rebind via (2). FALSE after the round-2 fix above — a landing
     on a renamed branch always hits the branch-mismatch alert (it disagrees with the stored watermark) and
     (1)'s own guard now refuses to advance `W.branch` onto it, by construction.
     **ROUND 3 CORRECTION:** round 2 said a rebind (2) is the ONLY exit, with a renamed-but-never-rebound
     project alerting forever as "a known, accepted gap". That gap is now closed: `POST
     /api/projects/:id/mainline-watermark/reset` (human-only REST, loopback, never an MCP tool — same trust
     class as the git/vault writers) resets ONE `(project, repoKey)` watermark directly, without requiring an
     actual `repoPath`/`repos` change the way (2) does. **A reset (via this route) is now the exit for a
     deliberate in-place rename**; (2) (`Db.resetMainlineBaselinesForRepoChange`) remains the exit for an
     actual repo rebind/repath. A project that is neither reset nor rebound still alerts on every check
     forever — that residual is unchanged, just no longer unaddressable.

## Do not

- Do not read `!w || w.branch !== head.branch` as one condition again. `!w` (true first sight) and
  `w.branch !== head.branch` (an existing, trusted baseline disagreeing with the live checkout) are different
  signals with different handling — the first stores silently, the second never stores and always alerts.
- Do not let a branch-diverted alert ever call `store()`. Unlike the sha-level "alert" verdict (which still
  advances W to the newly-observed tip after filing, see `4fa36502`'s STORE/RETAIN rule), a branch mismatch
  must leave BOTH `branch` and `sha` exactly as they were — advancing the sha alone while the branch is wrong
  would itself be a quieter form of the same bug.
- Do not invent a new event kind for this. It reuses `mainline_moved_outside_loom` with
  `evidence:["branch-diverted"]`, through the SAME boot-dedupe marker and the SAME `mainlineMovedNudgeText`
  helper every other evidence kind already uses — a second kind would duplicate the dedupe/delivery machinery
  for no behavioural gain. **ROUND 3 CORRECTION:** "the SAME … landing-nudge text" previously read as "byte-
  identical text". FALSE — `mainlineMovedNudgeText` carries a DIVERT-SPECIFIC branch inside itself
  (`evidence.includes("branch-diverted")`), with its own wording (checkout/reset-route remedy, no `git log
  A..B`). "Reuses the same helper" is the claim; the TEXT it renders for a divert is deliberately different
  from every other evidence kind's text.
- **ROUND 2 CORRECTION — this bullet's premise was FALSE, see "The configured mainline branch" §1 above.**
  `advanceMainlineWatermark`/`advanceMainlineWatermarkForBatch` ARE part of this bug: round 2 added a guard to
  each that refuses to change `W.branch` away from an existing baseline. Do not remove that guard, and do not
  read `batch-merge-watermark-branch-pin.mjs`'s own (W1) case ("a corrupted/stale watermark self-corrects via a
  real landing") as still true for a BRANCH mismatch specifically — it still holds for a sha-only drift.
- Do not reintroduce `b801bad0`'s watermark-preferred branch pin in `git/batch-merge.ts` as part of this card.
  That pin was deliberately reverted because of exactly this bug; reintroducing it (and flipping
  `batch-merge-watermark-branch-pin.mjs`'s (P1) case back) is separate follow-up work, owned by whoever next
  touches `batch-merge.ts`, once this fix has landed.

**CORRECTION — that follow-up has landed as card `ba663984`:** the pin IS now reintroduced (`sessions/service.ts`'s
`mergeBatchTracked`), exactly as this bullet anticipated, plus a fail-closed refusal for a present-but-corrupt
watermark row that a straight reintroduction would have missed — see
`docs/decisions/ba663984-reintroduce-watermark-preferred-batch-branch-pin.md`. That same record also notes a
related, UNFIXED latent gap: `checkMainlineMove`'s own "TRUE first sight = `!w`" test (this file's own design
section above) does not distinguish an absent watermark from a present-but-unparseable one either — flagged
there for a follow-up card, not fixed by `ba663984` (out of scope: that card owns the batch fast-forward pin
only).

## Tests

`packages/daemon/test/mainline-watch-branch-divert.mjs` — real git: a transient same-commit divert (`git
checkout -b`) after an established watermark leaves the watermark's branch AND sha unchanged, files exactly
one `mainline_moved_outside_loom` event with `evidence:["branch-diverted"]`, dedupes a second check of the
same still-diverted state, and self-corrects once a real landing happens back on the true mainline branch.
Exercised through both the landing path (`confirmWorkerMergeTracked`/`mergeBatchTracked`) and the boot path
(`checkMainlineMovesOnBoot`). **ROUND 3 CORRECTION:** this previously said the file's self-correction case
proves `advanceMainlineWatermark{,ForBatch}` "were never part of the bug" — FALSE, see the round-2 correction
under "The configured mainline branch" §1 above; those two helpers ARE part of the bug and now carry their
own guard. `mainline-watch.mjs`'s (S7d) and `mainline-watch-batch.mjs`'s (B4) exercise that guard directly,
in each helper, independent of `checkMainlineMove` ever having refused anything.
`mainline-watch-boot-reader.mjs`'s (R7)/(R7b) cover `deliverPendingBootAlerts` rendering a pending divert
marker with its own `source`/`expectedBranch`, and (R8) covers the `blockedBy`-scoped dedupe fallback.
`mainline-watermark-reset-route.mjs` covers the human-only reset route (§3 above).
