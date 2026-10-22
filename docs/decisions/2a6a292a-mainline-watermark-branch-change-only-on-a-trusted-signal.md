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

## Round 4 (card `4fabafd1`) — manager-checkout: a FOURTH exit for "the configured mainline branch"

The owner asked for a manager to be able to switch its own project's canonical checkout branch by itself
("build X on its own branch and compare before switching over"), without needing a human to clear the
`branchDiverted` refusal that would otherwise follow (`project_checkout_branch`, `mcp/orchestration.ts`,
backed by `SessionService.checkoutProjectBranch`). Phase-1 investigation (same card) found the obvious
design — just call `GitWriter.checkout()` and leave the watermark alone — insufficient: it would leave
every subsequent landing refused until a HUMAN reset the watermark, defeating the entire point of the
request (the owner explicitly wants this to NOT need a human).

**This is still consistent with this record's own rule ("the watermark's branch changes only on a
TRUSTED signal, never an observed checkout") — it adds a fourth trusted signal, not a fifth way to
silently absorb an observed divert:**
1. A real Loom landing (`advanceMainlineWatermark{,ForBatch}`).
2. A human rebind (`Db.resetMainlineBaselinesForRepoChange`).
3. A human-only reset (`POST /api/projects/:id/mainline-watermark/reset` → `resetMainlineWatermark`).
4. **NEW: a manager-initiated `project_checkout_branch` success** (`Db.repointMainlineWatermark`) — a
   DELIBERATE, server-authenticated act by the project's own manager, auditable (every call appends a
   `mainline_moved_outside_loom` event, `source:"manager-checkout"`, naming the old/new `{branch,sha}` and
   the calling session), through the same shared purge helper (`purgeMainlineWatermarkState`) #3 uses —
   so there remains exactly one place that clears the related alert/episode/streak keys. Unlike #3 (which
   only ever DELETES W, relying on a later trusted landing/boot to lazily reseed it), this STAMPS W
   directly to the post-checkout `{branch, sha}` — immediate, not lazy, because the whole point is that
   the NEXT `worker_merge_confirm`/`merge_batch` must land against the new branch without any intervening
   step.

### Round 5 (Code Review round 2, same card) — two blockers in the round-4 design, both reproduced on real git

Round 4 (above) shipped two real defects, both caught before merge:

**Blocker 1 — watermark laundering.** The round-4 design re-pointed W to whatever the target branch's
live tip happened to be, with no check that the move since W was last trusted is actually clean. Calling
the tool on the branch ALREADY checked out (or switching away and back) therefore silently accepted ANY
raw, non-Loom commit as the new trusted baseline — exactly the bug this whole record exists to close, now
reachable through the one new trusted-signal act round 4 added. It also discarded an unread mainline
alert as a side effect of the purge, at `severity:"low"` (the purge never distinguished "nothing to
report" from "an owner alarm nobody has seen yet").

**Blocker 2 — old-base landings import the other branch's history.** A worker cut from branch A, landed
AFTER a manager switch to branch B, squashes A's own commits into B — the squash target is whatever is
checked out AT CONFIRM TIME, not what the worktree was cut from. Round 4's own docs claimed the opposite
("their own worktrees are untouched… their NEXT union-merge… will pull in the NEW branch instead") — true
of the WORKTREE, false of what a solo/batch landing actually does with it.

**Fixes, both now load-bearing parts of the design (not merely refusal conditions — see below for the
full refusal list this round produced):**
- (a) Before ANY purge/re-point, `SessionService.refuseIfWatermarkLaundered` classifies the CURRENT
  watermark's own branch against its OWN live tip using the EXACT SAME primitives `checkMainlineMove`
  itself uses (`classifyMainlineMove`/`readMainlineFacts` from `git/mainline-watch.ts` — never a second,
  hand-rolled classifier). Unlike `checkMainlineMove` (a non-blocking tripwire that alerts AND still
  advances W), this REFUSES on anything other than "unchanged"/"explained" — advancing W here would be
  the laundering itself. A bad verdict files the SAME event shape the tripwire files (`kind:
  "mainline_moved_outside_loom"`, `severity:"high"`, `source:"manager-checkout-precheck"`) and leaves an
  UNDELIVERED marker (`nudgedAt:null`) via the SAME `mainlineBootAlertKey` the tripwire uses.
- (b) `SessionService.hasUnresolvedMainlineAlert` hard-refuses the WHOLE call while ANY mainline alert
  marker for (project, repoKey) still exists — delivered or not. A manager must never be able to clear the
  owner's alarm as a side effect of this tool's own purge; the marker's mere EXISTENCE is the gate, not
  its delivery state.
- (c) Calling the tool on the branch ALREADY checked out is a NO-OP (`{ok:true, noop:true, branch, sha,
  repoKey, previousBranch}`) — no checkout, no re-point — but ONLY once (a) and (b) above have already
  passed. This is deliberate, not a shortcut: a same-branch call is precisely the laundering shape (a)
  exists to catch, so it is never skipped just because nothing would otherwise move. **ROUND 6 NOTE:**
  this round's (a)/(b) classified only W's CURRENT branch, never a call's actual TARGET — see Round 6
  below for why that left a genuine away-and-back case (B1) uncaught, and what closes it.
- Blocker 2: `SessionService.listUnmergedWorkerBranches` hard-refuses while ANY worker branch in the
  PROJECT (live or exited — `processState` is irrelevant; only "does the branch still exist, and is it
  proven merged" matters) is not yet proven merged (`getTaskMergedInfo`; a branch already deleted
  post-merge is skipped, nothing left to import). The refusal names each one
  (`{workerSessionId, taskId, branch}`) and says to land, recycle-and-discard, or stop it first. A
  merge-time backstop (refusing a landing whose fork point isn't an ancestor of the current target) is a
  SEPARATE card, filed but not in this branch — this check is the interim, coarser guard.
- `liveWorkersOnOldBase` is DELETED from the success result — there is never a live-on-old-base worker to
  report on a success now, since an unmerged one is a hard refusal instead of a notice.

**Refusal scope is per-PROJECT, not narrowed to this one `repoKey`** (NIT, same round): `liveGateOpsForRepoPath`
already matched this way (documented there), and `listUnmergedWorkerBranches` matches it deliberately too
— over-refusal (a worker on a sibling repoKey of the same project blocks a switch on this one) is an
accepted, documented tradeoff, not a bug to narrow later.

### Refusals — the full list, hard, no acknowledge override (round 5 supersedes round 4's shorter list)

In `SessionService.checkoutProjectBranchPrecondition` order (cheapest-first), plus the unresolved-alert
gate ahead of all of them: (0) an unresolved mainline alert exists for (project, repoKey) — §(b) above.
(1) any live/queued gate of ANY `gateType` on this PROJECT's repo(s) (merge/batch, deploy, OR a worker's
own `run_gate` self-check) — `SessionService.liveGateOpsForRepoPath`, a NEW, separate query from
`pendingMergeOpsForRepoPath` (what `git_commit`'s PENDING-MERGE GUARD reuses, and which deliberately
stays merge-only — see that method's own doc for why a worker's self-check matters here: its union-merge
reads live canonical HEAD, un-lock-protected, so a switch mid-gate wastes the run). (2) a worktree cut
currently in flight (`cuttingWorktreeRepoPaths`, a small in-memory refcount bracketing both
`createWorktree` call sites). (3) an unmerged worker branch — Blocker 2 above. (4) a tracked change in
the canonical tree (next section). (5) watermark laundering — Blocker 1(a) above. An unknown branch or
Loom's own reserved/operational home are refused by the underlying `GitWriter.checkout()` itself.

**The TOCTOU fix (Code Review should-fix 3): all five of (1)-(5) now run TWICE** — once as a courtesy
pre-check (fast, outside the lock, for a clean early error) and once again as a NEW `precondition` hook on
`GitWriter.checkout()` itself, run INSIDE `withCanonicalIndexLock`, immediately before the real `git
checkout` spawns. This closes the window round 4 could only narrow: the SAME check that decided it was
safe to switch is what the mutation is admitted under, atomically. `branch`/`sha` on success are ALSO now
read inside that same lock (an extra `git rev-parse HEAD` at the exact point `checkout()` already reads
the checked-out branch name) — the one piece that stays outside it is the watermark REPOINT itself
(`Db.repointMainlineWatermark`), because `GitWriter` deliberately carries no `Db` dependency; that write
runs synchronously, immediately after `checkout()` resolves, with no intervening `await` OF ITS OWN.
**ROUND 6 CORRECTION:** "nothing else in this process can interleave" overstated this — a synchronous
continuation after an awaited promise still resumes as a microtask, so another already-queued microtask
(never a second call into this same method, which the lock still serializes) could in principle run first;
the guarantee this sentence actually gives is narrower and is the one that matters: no OTHER `await` point
of this method's OWN sits between the lock releasing and the repoint write, so nothing THIS call does can
race itself here.

### A tracked change in the canonical tree (Code Review should-fix 5)

A dirty tree used to be refused only when `git checkout` itself refused — which it does NOT do for a
non-conflicting tracked change; git silently carries it across onto the new branch. `project_checkout_branch`
now runs its own `git status --porcelain` (via the SAME bounded git helper every other read-only check in
this file uses) and refuses on ANY tracked change (staged or unstaged). **Decision: untracked files do
NOT block** — `git checkout` never touches them regardless of which branch ends up checked out, so they
carry none of the "silently carried across branches" risk this closes; that risk is specifically about a
TRACKED modification surviving the switch unmodified.

### Live workers whose worktrees were cut from the OLD branch — SUPERSEDED, see Blocker 2 above

Round 4 claimed a live worker on the old base was safe to leave running through a switch, reporting it as
`liveWorkersOnOldBase` on success. **This was wrong** (Blocker 2): the worker's WORKTREE is indeed
untouched, but ITS EVENTUAL LANDING is not — a solo/batch confirm squashes onto whatever is checked out AT
CONFIRM TIME, so an old-base worker landed after a switch imports its history into the new branch. The
field is deleted; an unmerged worker (live OR exited) is now `listUnmergedWorkerBranches`'s hard refusal.

### Scope: manager-only, own-project-only; the Platform Lead's `git_checkout` is UNCHANGED

`project_checkout_branch` is registered ONLY on the manager's own orchestration MCP surface
(`mcp/orchestration.ts`), server-derived project (no `projectId` argument), never the worker surface —
always-on (no profile opt-in; the owner asked for this directly for the manager role as such). It does
NOT create a branch (refuses on an unknown one — a worker creates one on its own worktree branch via an
ordinary commit/push-free workflow, or a future card could add a create-and-switch variant). The Platform
Lead's own `git_checkout` (`mcp/platform.ts`) is a SEPARATE, pre-existing tool and is **deliberately left
unchanged by this card** — it does NOT re-point the mainline watermark, so a Lead-driven checkout still
behaves exactly as it did before this card (an observed-checkout branch mismatch after a Lead `git_checkout`
still files the ordinary `branch-diverted` alert and still needs a human reset, same as always). The two
tools share the underlying `GitWriter.checkout()` call but diverge in what happens AFTER it succeeds.

### Self-hosting hazard (generic caution, not Loom-specific)

A project whose own daemon/service is built FROM its own canonical checkout (Loom's own self-hosting setup
is the one real example) will, on its next restart/deploy, build whatever branch is CURRENTLY checked
out — switching the checkout changes what that next build actually ships. This is not new to this card
(a human REST checkout or a Platform Lead `git_checkout` already had this property); `project_checkout_branch`
only widens WHO can trigger it. Documented generically in the shipped `/orchestrate` doctrine (this
project's own CLAUDE.md doesn't need the Loom-specific restatement — the self-hosting section already
covers `daemon_restart`'s own build semantics).

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
`project-checkout-branch.mjs` covers the manager-checkout exit (§4 above) as it stands after round 5's
Code Review corrections, REAL git throughout, no real canonical repo: SUCCESS — a real landing establishes
W on `main` FIRST, the switch then re-points W to the new branch IMMEDIATELY, and a worker spawned AFTER
the switch lands cleanly on it (removing the re-point turns this red). NOOP — the branch already checked
out, no checkout, no re-point. Every hard refusal, EACH with its own negative control proving the call
succeeds once the condition clears: Loom's own reserved home; an unknown branch (`GitWriter.checkout()`
itself); a live/queued gate op of ANY kind — both the `pending_gate_ops` arm (round 4) AND the live
`GateSemaphore` snapshot arm itself (a RUNNING and a QUEUED entry, across merge/batch/deploy); a worktree
cut in flight, including that the refcount releases even when the real `createWorktree` call fails
(a quarantined repo, exercised through the real `spawnWorker` path); a tracked change in the canonical
tree (an untracked file does NOT block); an unmerged worker branch, live OR exited; and watermark
laundering — a raw `update-ref` bypass (never an ordinary commit, which the shared classifier treats as
benign) on the CURRENTLY-checked-out watermark branch, refused whether the call targets that SAME branch
or an unrelated clean one. **ROUND 6 CORRECTION:** this scenario (round 5's LNDR-2) was mislabeled
"away-and-back" in this file and in the test's own comments — it is AWAY-ONLY: the call to the unrelated
branch is the only switch attempted (the same-branch LNDR-1 attempt just before it was refused, so no
switch ever actually completed before LNDR-2 ran). The genuine away-and-back case — switch away
successfully, tamper the now-unwatched departed branch, switch back to it — is `round-6`'s B1; see below
for why round 5's check could not see it and what closes it. Both leave a HIGH `mainline_moved_outside_loom`
event filed and W untouched. A separate scenario proves ANY existing alert marker (even an unrelated,
already-delivered one) blocks the switch outright. The worker router never sees the tool (manager does); a
Platform Lead `git_checkout` on the same repo does NOT re-point W. **See Round 6 below for the current test
file** — `project-checkout-branch.mjs` was substantially rewritten for the per-branch trust design and no
longer matches every claim in this paragraph verbatim (e.g. the OK scenario's `atlas` branch is now created
via `create:true`, not a bare `git branch`).

## Round 6 (Code Review round 3, same card) — per-branch trust, closing the target-branch laundering gap

Round 5's `refuseIfWatermarkLaundered` classified only W's CURRENT branch before any switch. A Code Review
reproduced a real bypass this left open: **B1 (target-branch laundering)** — with W={master}, switch to
`feat` (succeeds, W repoints to feat), raw-tamper `master` (it is NOT currently checked out, so NOTHING
watches it), switch back to `master` → the OLD check only ever asked "is W's current branch (feat) still
clean", never "is the branch I'm about to adopt (master) still clean" — so the tampered master tip was
adopted unvetted. This is a genuinely different shape from round 5's own LNDR-2 (away-ONLY, see the
correction above) — B1 needs a real, successful switch away BEFORE the tamper, which round 5 never
exercised.

### Design: a PER-BRANCH trust record, independent of W

A new store, `Db.getMainlineBranchTrust`/`setMainlineBranchTrust` (`mainlineBranchTrustKey`,
`git/mainline-watch.ts` — same `app_meta` key/value pattern W itself uses, one key per `(project, repoKey,
branch)` rather than W's single `(project, repoKey)` key), holds the last W-OBSERVED tip for ONE branch —
not "last-known-good" as such: `store()` also runs after a landing-path alert/unverifiable verdict, per
`4fa36502`'s STORE/RETAIN rule. It is refreshed, never invented, at every site that already sets W to
`{branch, sha}`: `checkMainlineMove`'s
`store()`, `advanceMainlineWatermark`/`advanceMainlineWatermarkForBatch` (the solo/batch landing advance),
and `Db.repointMainlineWatermark` (this tool's own success path) — each of those sites had ALREADY just
independently verified that sha as clean for that branch, so writing the trust record is a pure byproduct,
never a new verification.

`SessionService.refuseIfTargetBranchUntrusted` (replacing `refuseIfWatermarkLaundered`) classifies the
SWITCH TARGET (`args.branch`) against ITS OWN trust record, using the identical
`classifyMainlineMove`/`readMainlineFacts` primitives — never W's current branch, and never a second
hand-rolled classifier:
- The target doesn't exist in git at all ⇒ `{ok:true}` — defer to `GitWriter.checkout()`'s own "unknown
  branch" refusal; never intercept it with a different message (this is what keeps the (UNK) test's
  `refused !== true` contract intact).
- The target exists but has NO trust record ⇒ hard refusal naming the two honest remedies: create a NEW
  branch instead (`create:true`, below), or have the owner adopt it via the human-only reset route
  followed by a checkout + a real landing (which is what first-sight-seeds a fresh trust record for it).
- The target's live tip equals its trust record, or classifies `"unchanged"`/`"explained"` against it ⇒
  `{ok:true}`.
- Anything else (`"alert"`/`"unverifiable"`) ⇒ hard refusal, filing the SAME HIGH-severity
  `mainline_moved_outside_loom` event shape round 5's check filed, with `source:"manager-checkout-precheck"`
  and an undelivered marker — identical shape, just keyed on the TARGET branch instead of W's branch.

This single change subsumes round 5's OLD source-only check rather than sitting alongside it: a same-
branch call (LNDR-1) has `target === W.branch`, so classifying the target IS classifying W's branch; an
away-only call to a clean branch (LNDR-2) still passes because the clean target's own trust record is
fine; and B1's away-and-back now fails because `master`'s own trust record (stamped when it was last
trusted) is compared against its live tip at SWITCH TIME, regardless of what's currently checked out in
between.

### `create:true` (design point 3) — the other half of closing B1

Closing B1 by REQUIRING a trust record on every switch target would strand the owner's actual request
("build it on its own branch, compare, switch back") on day one of a brand-new branch, which by definition
has no trust record yet. `project_checkout_branch` gains `create:true`
(`SessionService.createProjectBranch`): it creates the named branch at the CURRENT mainline watermark's
OWN sha — never current HEAD (which may have drifted past W via an unverified-but-benign commit no
landing has advanced W past yet) and never a caller-supplied start point — switches to it, and stamps its
trust record to that same sha via the ordinary `Db.repointMainlineWatermark` path. Refuses: a name that
already exists (checked via `git rev-parse --verify`, deferring to `GitWriter.createBranch()`'s own error
on a read failure rather than a second message), an invalid git ref name (`git check-ref-format --branch`),
a name starting with Loom's own reserved `loom/` worker-branch prefix, or no established W yet to branch
from. Shares the SAME live-gate/worktree-cut/unmerged-worker/dirty-tree precondition an ordinary switch
runs (no branch-trust check — there is nothing to classify for a brand-new name), run once as a courtesy
pre-check and once again inside a NEW `precondition` hook on `GitWriter.createBranch()` itself (mirroring
`checkout()`'s own TOCTOU fix — `createBranch` gained the same `opts.precondition` plus an optional
`opts.startPoint` this round).

### S1 — the unmerged-worker refusal scoped + de-N'd

Two fixes to `SessionService.listUnmergedWorkerBranches`, from the same Code Review:
- **Scope.** Candidates used to be every worker session EVER (`listAllSessions`, no scope at all) — a
  rejected/abandoned/stopped-and-cleaned-up/taskless worker's branch blocked this tool FOREVER, since
  nothing ever re-examines a dead lineage's branch. Candidates are now scoped to a worker that is still
  `processState==="live"` OR whose `worktreePath` still exists on disk — the two situations where its
  branch could still plausibly gain more commits.
- **One spawn, not N.** Branch existence for every candidate used to cost one `branchExistsInRepo` spawn
  each (`git branch --list <branch>`). It is now read with ONE `git for-each-ref --format=%(refname:short)
  refs/heads/` call into a `Set`, membership-tested per candidate — fail-closed (a read failure treats
  every candidate as still existing) exactly like the helper it replaces.
- **Honest remedy text.** The refusal used to say "land, recycle-and-discard, or stop them first" —
  `worker_stop`'s own tool description says plainly "The worktree is retained", and no manager-reachable
  tool deletes a worktree, so "recycle-and-discard" named a mechanism that does not exist. The refusal now
  says "land them (worker_merge_confirm), or ask the owner to remove the worktree/branch by hand" — the one
  real manager path, plus the honest human fallback.

### S2 — the TOCTOU race actually has a test

Round 5 claimed the in-lock `precondition` hook closes a TOCTOU window but shipped no test that actually
exercises the race — disabling the hook left the suite 65/65 green. `project-checkout-branch.mjs` (TOCTOU
section) now holds `withCanonicalIndexLock` open in a parallel op, inserts an unmerged worker branch while
the switch's own courtesy pre-check has already passed, releases the lock, and asserts the switch is still
refused — RED when the `precondition` hook is removed from the `GitWriter.checkout()` call, GREEN with it
in place.

### S3 — `hasUnresolvedMainlineAlert` no longer blocks on its own informational marker

`recordFirstSightDeclined` stamps its marker's `nudgedAt` IMMEDIATELY (it is purely informational — "never
meant to be delivered as a nudge", see that method's own doc in `sessions/service.ts`) specifically so it
stays invisible to `deliverPendingBootAlerts`'s sweep and to `checkMainlineMove`'s own `keepPriorMarker`
protection. `hasUnresolvedMainlineAlert` nonetheless gated on the marker's MERE EXISTENCE, so a project
whose only "alert" was a first-sight decline — exactly the situation a manager might want to resolve BY
calling `project_checkout_branch` — refused the tool outright. It now parses the marker and excludes
`evidence:["first-sight-declined"]` specifically; every other evidence kind (including the REAL,
addressed `first-sight-seeded-stray`/`first-sight-resolve-deferred`/`branch-diverted` notices) still blocks
exactly as before.

### N1 — `GitWriter.checkout()`'s post-checkout sha read degrades instead of failing the whole call

`checkout()`'s in-lock `git rev-parse HEAD` (added round 5, right after the real `git checkout` spawns) can
itself time out or error AFTER the checkout has already happened — every pre-existing caller (human REST,
the Platform Lead's `git_checkout`) used to get `{ok:false, error}` for a mutation that actually succeeded.
`checkout()`'s result type widens to `{branch: string; sha: string | null}`; a failed rev-parse now
returns `{ok:true, branch, sha:null}` instead of propagating the exception. Every existing caller already
treated `sha` as informational and is unaffected by the widening; `checkoutProjectBranch` is the one
caller that needs a real sha to repoint W with, so it explicitly refuses (naming that the checkout itself
DID succeed) rather than repointing onto `null`.

## Do not (round 6 additions)

- Do not revert `refuseIfTargetBranchUntrusted` to classifying W's current branch again — that is
  precisely the B1 regression this round closes; the target is the branch about to be ADOPTED, not
  whatever happens to be checked out right now.
- Do not purge a branch's trust record merely because a SWITCH or a CREATE moves W to a DIFFERENT branch.
  Trust records are independent of W and must survive the owner switching away and back repeatedly — only
  a repo REBIND (`resetMainlineBaselinesForRepoChange`) wipes the whole per-(project,repoKey) trust set,
  mirroring W's own full wipe there.
- Do not let `create:true` branch off current HEAD or a caller-supplied start point — only W's own sha,
  so a brand-new branch can never inherit an unverified commit no landing has advanced the watermark past.
- Do not widen `hasUnresolvedMainlineAlert`'s exclusion beyond `first-sight-declined` without checking
  whether the marker in question is a REAL addressed notice (one that calls `enqueueDurableMessage` and can
  leave `nudgedAt:null` on a failed attempt) — only a marker that stamps `nudgedAt` unconditionally at
  write time is safe to exclude from this gate.

### Tests (round 6)

`project-checkout-branch.mjs` (rewritten): B1's exact repro (switch away to a second branch, raw
`update-ref` on the DEPARTED branch, switch back → refused, HIGH event filed, W unchanged); switching to
an existing branch with no trust record → refused, naming the create/adopt remedy; `create:true` branches
only at W's own sha (never HEAD if they've diverged), refuses an already-existing name, refuses an invalid
name and a `loom/`-prefixed name, and a real landing on the created branch afterward advances its own
trust record; the owner's full flow — `create:true` a branch, land on it, switch back to the original
(clean) branch → ok; a raw `update-ref` on the created branch while parked on the original, then switching
to it → refused; S1's live-vs-worktree-removed scoping; S2's TOCTOU race; S3's `first-sight-declined`
exclusion; N1's `sha:null` degrade on an existing `GitWriter.checkout()` caller (a fake `gitFactory` makes
`revparse(["HEAD"])` throw while `checkout`/`branchLocal` still succeed).

## Round 7 (FOURTH Code Review, same card) — the reflog-wipe bypass, human-reset dead end, in-lock alert check, dedupe, and two stamp-time defenses

Five defects + three test gaps, all found by code reading against round 6's own shipped code:

- **M1 (reflog-wipe bypass — the headline blocker).** `refuseIfTargetBranchUntrusted` classified the
  switch target via the SAME `classifyMainlineMove`/`readMainlineFacts` primitives `checkMainlineMove`
  itself uses — but that classifier is deliberately FAIL-OPEN (4fa36502: a tripwire, never a sandbox),
  and this gate ADOPTS a new trust baseline, which must be stricter. `classifyMainlineMove`'s own
  raw-reflog-write signal only fires when the reflog window it reads actually CONTAINS the trusted sha
  (`f.reflog.findIndex(e => e.sha === watermarkSha)`); it treats "trusted sha not found in the window" and
  "no raw-write entries between the trusted sha and the tip" identically — both read as `raw.length ===
  0` → `evidence.length === 0` → verdict `"explained"`. Three real bypasses exploit this: (1)
  `git update-ref -d refs/heads/<x> && git update-ref refs/heads/<x> <foreign>` — deleting a ref deletes
  its reflog file, so the recreated ref's reflog can NEVER contain the old trusted sha again, regardless
  of how clean or dirty the actual history is; (2) `git branch -f <x> <foreign>` — no delete, so the
  reflog survives, but the move is onto a wholly unrelated tip, never a descendant of the trusted sha;
  (3) `git branch -D <x>` then recreate under the same name — same reflog-wipe as (1). All three leave
  `refuseIfTargetBranchUntrusted` seeing `verdict:"explained"` and silently adopting the foreign tip.
  **Fixed with two ADDITIONAL fail-closed checks, run on top of (never replacing) the shared classifier,
  and ONLY inside this gate — `classifyMainlineMove`/`checkMainlineMove` itself stays exactly as
  fail-open as 4fa36502 designed it, since widening the shared primitive would also make the boot/landing
  TRIPWIRE refuse-shaped where it must never refuse anything:**
  1. **Reflog reach.** `facts.reflog` must be non-null AND contain an entry whose sha equals the trusted
     sha. If not — the window exists but never reaches the baseline, or there is no window at all — the
     move is reclassified `"alert"` (`evidence:["reflog-unverifiable"]`) regardless of what the shared
     classifier said, closing repros (1) and (3).
  2. **Forward-only.** `facts.forward` (the trusted sha IS an ancestor of the live tip — already computed
     by `readMainlineFacts`, previously only consulted INSIDE the `raw.length > 0` branch the shared
     classifier never reaches when evidence is empty) must be `true`. If not, the move is reclassified
     `"alert"` (`evidence:["non-ancestor-move"]`), closing repro (2).
  Both checks run REGARDLESS of the shared verdict; an `"explained"`/`"unchanged"` verdict is honored
  only once BOTH independently pass. `MainlineEvidence` gains both new tags; `mainlineMovedNudgeText`'s
  existing generic fallback branch renders them sensibly (no dedicated branch needed — verified by
  reading its own wording against each new tag).
- **M2 (dead-end remedy).** `Db.resetMainlineWatermark`/`purgeMainlineWatermarkState` never touched the
  per-branch trust store — only `repointMainlineWatermark` (the manager-checkout success path) did. So
  the documented recovery flow for a (TRUST) or (B1)-shaped refusal ("ask the owner to adopt it via the
  human-only reset route … followed by a checkout and a real landing") was incomplete: the reset cleared
  W, but the just-adopted branch's OWN trust record stayed exactly as broken as before, so the manager's
  very next `project_checkout_branch` call on that branch re-refused with "no trusted baseline on
  record" — a SECOND, unrelated dead end the reset did nothing to clear. Fixed: `resetMainlineWatermark`
  gains an optional `adopt: {branch, sha}` param — the REST route's own live read of the canonical
  checkout's current head (the human is expected to have already checked it out) — and stamps that
  branch's trust record as a byproduct of the same human-adoption act, never a new, independent check.
- **m3 (alert check not in-lock).** `hasUnresolvedMainlineAlert` ran exactly ONCE, in `checkoutProjectBranch`
  itself, outside any lock — the only one of the six refusal checks that did NOT get the courtesy-pre-check-
  plus-in-lock-precondition TOCTOU closure every other check already had. Fixed by moving it INSIDE
  `checkoutProjectBranchPrecondition`/`createProjectBranch`'s `nonCreatePrecondition` (both already run
  twice), so it now gets the same closure for free.
- **m4 (repeated refusal events).** `refuseIfTargetBranchUntrusted` unconditionally filed a HIGH event +
  nudge on every call, even a retry that would (after m3's fix) usually be short-circuited earlier by
  `hasUnresolvedMainlineAlert` — but two GENUINELY CONCURRENT calls can both race past that marker check
  before either's event lands. Fixed: `Db.hasManagerCheckoutRefusalEvent` dedupes on the exact
  (branch, from, to, source:"manager-checkout-precheck") triple before filing.
- **n1 (no stamp-time defense on the switch path).** The classified-clean tip (read by
  `refuseIfTargetBranchUntrusted` inside the lock) and the sha actually landed on (read by
  `GitWriter.checkout()`, also inside the lock, moments later) were never compared — the code trusted the
  two reads implicitly agree because nothing else can interleave inside one lock. Fixed:
  `refuseIfTargetBranchUntrusted`'s success return now also carries `classifiedTip`; `checkoutProjectBranch`
  captures it from the IN-LOCK precondition call specifically and refuses the repoint on any mismatch
  against the landed `result.sha`.
- **n2 (no stamp-time defense on the create path).** `createProjectBranch` read W's sha ONCE, outside the
  lock, and used that stale value both as the actual `git checkout -b` start point and as what got
  repointed onto — a concurrent switch/create/reset between that read and lock admission would be
  silently ignored. Fixed: `GitWriter.createBranch`'s `precondition` hook may now also return a fresh
  `startPoint`, which overrides the outer one; `createProjectBranch`'s in-lock precondition re-reads W and
  supplies the freshest sha, used for both the real spawn and the eventual repoint.
- **M3 (test gaps — and (i) surfaced a REAL code defect once fixed, not just a test gap).** (i) The
  round-6 (S2) TOCTOU test's own race-insertion was ordered only by "runs synchronously, no `await` in
  between" — every step the race needs (a real `git branch`, a synchronous `db.insertSession`) is itself
  synchronous, so it could complete BEFORE the call's own async chain (MCP transport connect → tool
  dispatch) ever reached the OUTER courtesy pre-check at all, meaning a disabled in-lock hook could still
  read green for the WRONG reason — the OUTER path catching the race instead. Fixed with a call-counting
  hook on `checkoutProjectBranchPrecondition` that proves the ordering instead of assuming it (and the
  same technique now also backs the new (ALERT-LOCK) scenario for m3). **Forcing the race through the
  IN-LOCK path for the first time immediately surfaced a real, previously-invisible bug:** both
  `checkoutProjectBranch`'s and `createProjectBranch`'s in-lock `precondition` closures forwarded a
  refused `checkoutProjectBranchPrecondition`/`nonCreatePrecondition` result through `GitWriter.checkout`/
  `createBranch`'s own `{ok:false,error}`-only precondition type — silently dropping `refused`/
  `liveGateOps`/`unmergedWorkers` whenever the IN-LOCK check (not the outer courtesy one) was what
  actually refused. The OLD (S2) test could never have caught this: its own race-ordering bug meant the
  OUTER path (which preserves every field) was always what actually refused. Fixed: both call sites now
  capture the full structured refusal in an outer-scoped variable and return it directly, rather than
  reconstructing a bare `{ok:false,error}` from it. (ii) `create:true`'s own start point was never tested
  against a repo whose HEAD had drifted past W with no Loom landing — added (CREATE-DRIFT). (iii) Three
  trust-store writes (`checkMainlineMove`'s boot-path `store()`, a repo rebind's wipe, and
  `GitWriter.createBranch`'s in-lock hook) and `checkoutProjectBranch`'s own `sha:null` handling
  (previously reachable only via a fake `GitWriter`, never through the real method) had no test at all —
  added (C3), (C7), (N2) (which also covers the in-lock-hook site), and (N1-SERVICE) (a
  `GitWriter.prototype.checkout` patch that forwards to the real implementation, unlike the fake-git (N1)
  scenario). **`advanceMainlineWatermarkForBatch`'s own trust write (C5) remains untested** — reachable
  only through the full `merge_batch` flow, which this test file does not
  otherwise exercise; it is architecturally identical to the already-tested solo advance's trust write.

## Do not (round 7 additions)

- Do not widen `classifyMainlineMove`/`readMainlineFacts` themselves to add M1's hardening — those are the
  SHARED, deliberately fail-open tripwire primitives `checkMainlineMove` (boot + landing) also uses, and
  must stay exactly as permissive as 4fa36502 designed; the hardening belongs ONLY in
  `refuseIfTargetBranchUntrusted`, layered on top of the shared verdict. **This bullet still holds; the
  round-8 correction below only replaces WHAT the hardening checks, not WHERE it lives.**
- **ROUND 8 CORRECTION — this bullet's "Do not drop either of M1's two checks" is FALSE and no longer
  applies; see the round-8 section below.** The reflog-reach check it describes is REMOVED, not merely
  joined by a third check: the fourth Code Review proved `branch -f` (no delete — the ref's reflog
  survives intact) onto a DESCENDANT of the trusted sha passes reflog-reach AND forward both, while still
  being exactly the laundering this gate exists to stop, because the descendant's own new commits carry
  no Loom trailer. Reflog-reach was never actually load-bearing for repros (1)/(3) either — their foreign
  tip is ALSO a trustedSha-rooted descendant, so the untrailered-commits check alone already catches all
  three; it just happened to also be caught by reflog-reach first, which hid that reflog-reach itself
  never carried its own weight. Forward-only survives unchanged — it is still required, now paired with
  the untrailered check instead of the reflog one.
- Do not revert `hasUnresolvedMainlineAlert` to a single outer-only call in `checkoutProjectBranch` — it
  must stay inside the twice-run precondition functions, or m3's TOCTOU closure regresses.
- Do not drop the `classifiedTip`/mismatch check in `checkoutProjectBranch`, or the fresh-`startPoint`
  re-read in `createProjectBranch`'s in-lock precondition — both are deliberate stamp-time defenses
  (n1/n2), not redundant with the lock itself.
- Do not let `resetMainlineWatermark`'s `adopt` param become a SECOND way to classify a branch as trusted
  — it is a byproduct of the human's OWN live git read (done by the REST route, never derived inside
  `Db`), never an independent verification `Db` performs itself.
- Do not reconstruct a bare `{ok:false,error}` from a `checkoutProjectBranchPrecondition`/
  `nonCreatePrecondition` refusal when returning it from `checkoutProjectBranch`/`createProjectBranch` —
  capture and return the FULL structured result (`refused`/`liveGateOps`/`unmergedWorkers`); this was a
  real, shipped bug the (S2) test's own M3-i fix surfaced, invisible as long as the race always happened
  to be caught by the outer courtesy pre-check instead of the in-lock one.

### Tests (round 7)

**ROUND 8 CORRECTION — the claim below ("each in its own scope within one fixture") is FALSE; the fourth
Code Review found the three M1 repros actually shared ONE fixture, and all three "refused" results were
reading the sibling repros' own leftover project-wide alert marker, not their own trust classification —
see the round-8 section below for the real fix.** `project-checkout-branch.mjs`: (M1) all three repros —
delete-and-recreate, `branch -f`, `branch -D` +
recreate — refused, each in its own scope within one fixture; a negative control (an ordinary
fast-forward commit, intact reflog, true ancestor) in its OWN fresh fixture is still allowed — the
earlier repros' own filed alert markers would otherwise block it for an unrelated reason within the same
fixture (a real bug this test's own first draft hit, not a code defect). (RESET) `Db.resetMainlineWatermark(…, adopt)` stamps the adopted branch's
trust record, closing the dead end; (DEDUPE) two identical direct `refuseIfTargetBranchUntrusted` calls
file only one HIGH event; (ALERT-LOCK) a marker set between the outer pre-check and lock admission is
still caught by the in-lock check, ordering proven via the same call-counting hook (S2) now uses;
(CREATE-DRIFT) `create:true` branches at W's sha even past a drifted HEAD; (N2) a concurrent repoint
while a `create:true` call is parked on the lock is picked up fresh, not the stale outer read;
(N1-MISMATCH) a deliberately-wrong classified tip refuses the repoint; (N1-SERVICE) checkoutProjectBranch's
own `sha:null` handling through the real method; (C3)/(C7) the boot-path store() and a repo rebind both
touch the per-branch trust store, not just W.

## Round 8 (FIFTH Code Review, same card) — the untrailered-descendant bypass, a stale W after a partial
## failure, and three test-vacuity findings

Dispatched after the fourth Code Review found round 7's own M1 fix insufficient, plus three further gaps.

- **CRITICAL — `branch -f` (and two siblings) onto an untrailered DESCENDANT still laundered.** Round 7's
  own fix required (a) the branch's reflog to reach the trusted sha and (b) the trusted sha to be an
  ancestor of the live tip. Neither holds up against `git branch -f <parked> <descendant-of-trusted>`: no
  delete happens, so the reflog survives intact (reflog-reach passes), and the descendant IS forward of
  the trusted sha by construction (forward passes) — yet the descendant's own new commit(s) carry no Loom
  merge trailer at all, which is exactly what makes it a bypass. The SAME shape covers a forged
  `git update-ref -m "commit: …"` message onto an untrailered child (a porcelain-LOOKING reflog message
  that never happened through porcelain) and a genuine porcelain `git commit` made on the branch from a
  second `git worktree add` while it sits parked (unwatched) — neither deletes anything or produces a
  non-fast-forward move either. **Fixed:** `refuseIfTargetBranchUntrusted` now allows the move only when
  the live tip equals the trusted sha, OR `facts.forward` is true AND `facts.untrailered` (first-parent
  commits in `trusted..tip` with no Loom trailer) is EMPTY — the reflog-reach check is REMOVED outright,
  not joined by a third check: it was never actually load-bearing for repros (1)/(3) either, since their
  foreign tip is the SAME trustedSha-rooted-descendant shape the untrailered check alone already catches.
  `MainlineEvidence` gains `"untrailered-commits"`; `mainlineMovedNudgeText`'s existing generic fallback
  renders it sensibly, same as round 7's own new tags. **A legitimate move is now, deliberately, STRICTER
  than the shared boot/landing tripwire**: an ordinary human commit with no Loom trailer is no longer
  treated as "clean" just because it's a fast-forward with an intact reflog — only a real Loom landing (or
  the unchanged tip) adopts.
- **MAJOR — a post-checkout refusal left the canonical repo switched with W stuck on the OLD branch, and a
  retry could never fix it.** Three distinct refusals (`sha:null`, the in-lock classified-tip mismatch,
  `GitWriter.checkout()` reporting a different branch than requested) all happen AFTER the real `git
  checkout` already mutated the canonical repo for real — their own remedy text says "retry", but a retry
  lands right back on the already-switched branch and used to take the plain no-op path, which silently
  reported success WITHOUT ever re-pointing W. **Fixed:** `checkoutProjectBranch`'s "already checked out"
  branch now splits in two. When W already agrees with what's checked out, it stays a genuine no-op (W
  untouched, no event — unchanged from round 7). When W DISAGREES, it re-runs the FULL precondition
  (target-branch trust included) INSIDE the canonical lock, re-reads the live head fresh, refuses on any
  mismatch against the just-classified tip exactly like an ordinary switch would, and only then repoints W
  — reporting `noop:false` (a real state change happened, even though no new `git checkout` ran). (N1-
  SERVICE) and (N1-MISMATCH)'s own negative controls now assert W actually moved on the retry, not merely
  `ok:true` — the stronger assertion that would have caught round 7 shipping with this gap.
- **m4 (dedupe under-alerts after a human reset).** `hasManagerCheckoutRefusalEvent`'s dedupe matched on
  (branch, from, to, source) with NO time bound — so a retry on a tampered branch the owner has ALREADY
  reset, whose tip hasn't moved since, matched the STALE pre-reset event forever: no new event, no new
  marker, while the returned error text unconditionally claimed "a mainline_moved_outside_loom event was
  filed". **Fixed:** a new `Db.lastHumanResetTs(projectId, repoKey)` reads the last `source:"human-reset"`
  event's own `ts`; `hasManagerCheckoutRefusalEvent` takes an optional `sinceTs` and only matches events at
  or after it. `refuseIfTargetBranchUntrusted`'s error text also no longer unconditionally claims a FRESH
  file — it distinguishes "was just filed" from "already exists for this episode".
- **Test-vacuity findings (fourth Code Review), all in `project-checkout-branch.mjs`:**
  1. **(M1) shared one fixture.** All three repros filed into the SAME project-wide alert marker, so every
     "refused" assertion after the first repro was reading `hasUnresolvedMainlineAlert`'s own block, never
     that repro's own target-branch classification. **Fixed:** each repro now gets its OWN fresh fixture,
     and each asserts the SPECIFIC filed event's `evidence` tag (never just `refused === true`), so a
     wrong-reason refusal reads red, not green.
  2. **Forward-only had no effective test.** The old repro 2 (`branch -f`) built its foreign tip as a
     direct CHILD of the trusted sha (`commit-tree -p trustedSha`) — forward-true by construction, so the
     forward check was never actually exercised by it; it happened to pass for the (then-untested)
     untrailered reason instead. **Fixed:** a new, separate repro forces the branch onto a tip that is
     genuinely NOT a descendant of the trusted sha (a `branch -f` onto an unrelated/earlier commit),
     asserting `evidence` includes `"non-ancestor-move"`.
  3. **The negative control's own premise changed.** Round 7's negative control was an ordinary,
     non-trailered `git commit` — under round 8's stricter rule that is no longer a legitimate move.
     **Fixed:** the negative control is now a REAL Loom landing (via `confirmWorkerMergeTracked`, which
     carries the Loom trailer), and a SEPARATE assertion confirms an ordinary non-trailered commit is now
     correctly refused too — documenting the policy change explicitly rather than silently narrowing what
     "clean" means.

### Do not (round 8 additions)

- Do not reintroduce a reflog-reach check alongside the untrailered-commits one "for extra safety" — it
  was proven NOT independently load-bearing (every repro it was meant to catch is a trustedSha-rooted
  descendant the untrailered check already catches), and reintroducing it only risks resurrecting the
  exact `branch -f`-survives-the-reflog gap this round closes.
  **ROUND 9 CORRECTION — "proven NOT independently load-bearing" is overstated; see the round-9 section
  below.** The fifth Code Review's own probe found a shape where reflog-reach WOULD have mattered
  independently: a delete-and-recreate (which DOES wipe the reflog) onto a commit carrying a FORGED
  `Loom-Worker-Branch:` trailer would be caught by reflog-reach alone, while round 8's own untrailered-
  commits check alone would MISS it (the forged trailer makes the commit look trailered). So reflog-reach
  and untrailered-commits are not uniformly redundant across every bypass shape, contrary to this bullet's
  original reasoning. **This correction does not argue for restoring it** — `branch -f` (no delete) still
  survives reflog-reach regardless of this finding, so a reflog-reach-plus-forged-trailer combination
  remains exploitable via that one shape either way; round 9 closes every shape at once by removing
  git-derived classification from this gate entirely, which is the only fix proven complete.
- Do not give an M1 repro's negative control (or any repro) a shared fixture with another repro in this
  file again — the fourth Code Review's whole finding was that a shared fixture's leftover alert marker
  makes a wrong-reason refusal indistinguishable from the right one. One fixture per repro, always.
- Do not read the noop-path W-repoint fix (MAJOR #2) as a second, independent way to adopt a branch's trust
  — it reuses `checkoutProjectBranchPrecondition` verbatim, inside the SAME canonical lock, so it is bound
  by exactly the same six checks (including the target-branch trust classification) as an ordinary switch.
- Do not let `hasManagerCheckoutRefusalEvent`'s `sinceTs` scope to anything OTHER than the last
  `source:"human-reset"` event — a rebind event is a different kind of reset (it also wipes the watermark
  itself, not just the alert marker) and scoping to it instead would under-cover a tamper that recurs
  between two human resets with a rebind in between.

### Tests (round 8)

`project-checkout-branch.mjs`: (M1) six repros, each in its own fresh fixture, each asserting the specific
filed event's `evidence` tag — delete-and-recreate, `branch -f`, `branch -D`+recreate (all onto an
untrailered descendant, evidence `untrailered-commits`), a forged `update-ref -m "commit: …"` message onto
an untrailered descendant (same evidence), a genuine porcelain commit via a second `git worktree add` on
the parked branch (same evidence), and a `branch -f` onto a genuinely non-ancestor tip (evidence
`non-ancestor-move`); the negative control is now a real Loom landing, plus a separate assertion that an
ordinary non-trailered commit is now ALSO refused. (N1-MISMATCH)/(N1-SERVICE) negative controls now assert
W actually moved on the retry (MAJOR #2), not merely `ok:true`. (N2) the race insertion is now sequenced
via a `db.getMeta` call-counting hook (the SAME technique (S2) uses), closing the "could the insertion have
landed before the outer read ran at all" ambiguity a bare synchronous-ordering assumption left open.
`mainline-watermark-reset-route.mjs`: a new route-level test exercises the REST route's OWN live-HEAD
`adopt` derivation (a real git repo, not the stub path) — proven RED by temporarily dropping the `adopt`
pass-through. `batch-merge-watermark-branch-pin.mjs`: the existing seed landing now also asserts the
batch's own trust write (C5) lands alongside W, reusing an already-passing fixture rather than building a
new one.

## Round 9 (FIFTH Code Review, reviewing round 8's own commit) — a forged Loom trailer survives every
## git-derived layer; delete them all, adopt on an EXACT trust-record match only

Round 8's own "forward + every intervening commit carries a Loom trailer" fix (replacing round 7's
reflog-reach) was itself a bypass: `parseLoomTrailerBlock` is pure, unauthenticated text matching over a
commit's own message — a commit ANYONE with `.git` write access can author. Three repros, each its own
fixture, all landed `ok:true` under round 8's code with W/trust laundered onto a commit no real Loom
landing ever produced:

- **P1** — `git branch -f <parked> <forged>`, where `<forged>` is a commit built with
  `git commit-tree <trustedSha's unmodified tree> -p <trustedSha> -m "feat(x): innocuous" -m
  "Loom-Worker-Branch: loom/deadbeef0000"` — a descendant whose own message plants the EXACT trailer text a
  genuine landing writes. Forward: true. Untrailered: empty (the planted trailer parses as real). Round 8's
  gate: `{ok:true}`.
- **P2** — the SAME forged commit, reached via `git update-ref -m "commit: x" refs/heads/<parked> <forged>`
  instead of `branch -f` — a forged, porcelain-looking reflog message stacked on top of the forged trailer.
  Same result.
- **P3** — the SAME forged commit, reached via the "already checked out, W disagrees" fixup path (round
  8's MAJOR #2): the canonical repo is checked out directly onto the forged branch out of band, while W
  still points elsewhere; `checkoutProjectBranch`'s fixup branch re-runs the FULL precondition in-lock (the
  SAME `refuseIfTargetBranchUntrusted` call) and would repoint W onto the forged tip — the fixup path
  shares the identical unsound check, not a second one.

No existing round-7/8 test caught any of these: every prior repro used a commit with NO trailer at all (an
untrailered descendant), so the "require every commit to carry a trailer" rule was never adversarially
tested against a commit that FAKES one.

### Design: delete all git-derived classification; adopt ONLY on an exact trust-record match

**Lesson 209 (the responding worker's own framing, not a narrower "add a fourth layer" reading of the
Code Review): a trust decision in a refusal gate must key on Loom's OWN durable record, never on repo
content anyone with `.git` write access can forge.** Rounds 7 and 8 both hardened a GIT-DERIVED
classification (`classifyMainlineMove`/`readMainlineFacts`) layer by layer — reflog-reach, then
forward-only, then untrailered-commits — and each layer was eventually defeated by a bypass that satisfied
every earlier layer while still not being a real Loom landing. Round 9 breaks that cycle by removing the
classifier from THIS GATE entirely, rather than adding a fourth layer:

- The SWITCH TARGET's live tip is compared, byte-for-byte, against its own trust record
  (`Db.getMainlineBranchTrust`) — the ONLY git read this gate performs beyond the branch-existence check.
- An EXACT match (`liveTip === trustedSha`) ⇒ adopt.
- ANY other tip — a trailered or untrailered descendant (forged or genuine), an ancestor/rewind, a
  non-ancestor move — is refused, filing the SAME `mainline_moved_outside_loom` event shape every earlier
  round used, now with a single evidence tag this gate ever files: `"untrusted-tip-mismatch"`. No second
  git-derived fact is substituted in the classifier's place.
- `classifyMainlineMove`/`readMainlineFacts` themselves are UNCHANGED and still used elsewhere
  (`checkMainlineMove`, the shared boot/landing tripwire) — this round only removes their use FROM THIS ONE
  GATE, per round 7's own "Do not widen the shared primitives" rule (still in force, see below).

### Accepted cost: a trust record that legitimately lags behind a real landing now also refuses

The per-branch trust record is refreshed as a byproduct of every site that already sets W to
`{branch, sha}` (a real landing's `advanceMainlineWatermark{,ForBatch}`, this tool's own `checkout`/
`create` success, `checkMainlineMove`'s own `store()`). In the ORDINARY case this keeps the trust record
current with every real landing, so an exact match is the normal outcome. But the pre-existing fail-open
"advance-skip" gap (a landing-path tripwire check that hit a cap/deadline and left W — and now the trust
record — unstamped) used to still pass under round 7/8's forward+trailered rule: a genuine multi-commit
trailered chain was accepted even with trust a landing behind the live tip (round 8's own negative
control, now REMOVED and inverted — see Tests below). **Round 9 accepts that this case now also refuses.**
There is no narrower fix that keeps this case passing without reopening a forgeable classification layer;
the remedy is the same human-only reset route every other refusal in this gate already names.

### Do not (round 9 additions)

- Do not add a fourth git-derived classification layer to `refuseIfTargetBranchUntrusted` (a stricter
  trailer check, an authenticated-trailer scheme, a reflog-plus-trailer combination, or any other signal
  read from repo content) "to close the forged-trailer gap" — that is exactly the pattern that produced
  rounds 7, 8, and this round. The gate reads ONE fact (the live tip) and compares it to ONE record Loom
  itself wrote; it does not, and must not, interpret commit content as evidence of anything.
- Do not reintroduce the round 7 reflog-reach check, alone or alongside anything else — see the ROUND 9
  CORRECTION attached to round 8's own "Do not" bullet above: reflog-reach is not uniformly redundant with
  the untrailered check across every bypass shape, but `branch -f` (no delete) still survives it regardless
  of that finding, so reflog-reach-plus-forged-trailer remains exploitable via that one shape either way.
  The only fix that closes every shape at once is this round's: no git-derived classification at all.
- Do not read a `Loom-Worker-Branch:` trailer (or any other trailer `parseLoomTrailerBlock` recognizes) as
  authentication anywhere a TRUST decision is made from it. It remains a legitimate, correct signal for
  what it was designed for — identifying which branch a LANDED commit on `main`'s own history belongs to,
  read AFTER a landing already happened through the trusted merge/squash code path — but it is not evidence
  that a commit came from that path in the first place.
- Do not treat round 8's M1 negative control's old assertion ("a real multi-commit Loom-trailered chain,
  trust one landing behind the live tip, is still allowed") as a target to restore. It is now deliberately
  the opposite assertion (refused) — see the updated test.

### Tests (round 9)

`project-checkout-branch.mjs`: **(FORGED)** P1 (`branch -f` onto a commit carrying a forged
`Loom-Worker-Branch:` trailer) and P2 (the same forged commit reached via a forged
`update-ref -m "commit: …"`) — both refused, evidence `untrusted-tip-mismatch`, W and the branch's own
trust record untouched (round 8 would have returned `ok:true` for both). **(FORGED-FIXUP)** P3 — the same
forged tip reached via the "already checked out, W disagrees" fixup path (canonical switched to the forged
branch out-of-band, W still elsewhere) — refused there too; P4 (control) — an ORDINARY untrailered commit
on the same fixup path is refused for the same reason, proving the fixup path's own precondition re-run
isn't a weaker check. **(REWIND)** a parked branch with two REAL (trailered) landings, trust rolled to the
second, forced backward via `branch -f` onto the first (a genuinely real but STALE tip) — refused, same
evidence tag; no special-case rewind logic exists, this just proves the exact-match rule isn't accidentally
direction-dependent. **(FIXUP-TOCTOU)** a hook-sequenced tamper (the same call-counting technique
(S2)/(N2) use — a raw `update-ref`, since `branch -f` refuses on a branch checked out in the primary
worktree) inserted between the "already checked out, W disagrees" fixup path's OWN outer courtesy pre-check
and its separate in-lock precondition re-run, proving that re-run — not the stale outer read — is what
actually decides the outcome (previously untested; MINOR finding, fifth Code Review). **(M1)** all six
repros' evidence assertions updated from `untrailered-commits`/`non-ancestor-move` to the single
`untrusted-tip-mismatch` tag now filed for every one of them; the M1 negative control is INVERTED (a real
trailered chain with trust one landing behind the tip is now refused, not allowed, clearing the resulting
project-wide alert marker before a POSITIVE control proves the SAME call succeeds once trust is rolled
forward to an exact match).

## Round 10 (SIXTH Code Review, reviewing round 9's own commits) — the DWIM-remote-tracking launder, a
## name-shape bypass, dead evidence members, and remedy-text ordering

Found by reading round 9's own shipped code (`c2c26bcb`), not by a new attack on the exact-match rule
itself — both findings are about what happens BEFORE `refuseIfTargetBranchUntrusted` ever gets to compare
a tip, not about the comparison itself.

- **CRITICAL #1 — the DWIM-remote-tracking launder.** `refuseIfTargetBranchUntrusted` returned
  `{ok:true, classifiedTip:null}` when `refs/heads/<branch>` didn't resolve, deferring entirely to
  `GitWriter.checkout()`'s own "unknown branch" handling. But `GitWriter.checkout()` ran a PLAIN
  `git checkout <name>` — and git's own DWIM silently creates a LOCAL branch tracking a same-named
  REMOTE-TRACKING ref (`refs/remotes/<remote>/<name>`) when no local one exists. A worker can write
  `refs/remotes/origin/evil` directly through the shared `.git` (same write surface every other repro in
  this record already exploits). Repro (real git, a clone with a configured `origin`, verified directly):
  `git update-ref refs/remotes/origin/evil <forged>` (no local `evil`), then
  `project_checkout_branch({branch:"evil"})` ⇒ `ok:true`, canonical switched to `evil`, W + trust(evil)
  re-pointed to the forged sha — and because `classifiedTip` was `null`, the in-lock mismatch guard
  (`checkoutProjectBranch`'s `classifiedTipAtAdmission !== null && ... !== result.sha` check) never even
  ran, since `null` short-circuits it.
- **MAJOR #2 — a name-shape bypass with no git-argument-level mitigation.** `"-"` and `"@{-1}"` are git
  revision shorthand for "the previous branch" — `git checkout -` / `git checkout '@{-1}'` switches
  canonical to whatever was checked out before, bypassing every trust check (the TARGET was never a named
  branch at all). `"-bsneaky"` is parsed as the `-b` option with value `sneaky`, CREATING and switching to
  a new branch. `git check-ref-format --branch` is NOT a safe gate for any of this: it actively EXPANDS
  `@{-N}`/`@{upstream}` shorthand (reading the branch-switch reflog) and ACCEPTS it, printing the expanded
  name, rather than rejecting it.

### Design: validate the name before any git call; `--no-guess` at the spawn site; refuse a non-existent
### branch directly, with a remote-tracking-shadow alert

- **`unsafeBranchNameReason(name)`** (`git/writer.ts`) — a pure, pre-git check rejecting a leading `-`,
  `"@{"`, `".."`, a `"refs/"` prefix, or any character outside a conservative allowlist charset. Called at
  `checkoutProjectBranch`'s single shared entry point (both `create` and non-`create`), before any repo
  resolution or git read. **Deliberately does NOT reject `"<remote>/<name>"`-shaped names** (e.g.
  `"origin/evil"`) — that shape is a syntactically legal LOCAL branch name too; the "must already exist as
  a real `refs/heads/<name>`" requirement below closes that case instead, without a false-positive risk on
  a legitimately-named local branch.
  - **Verified empirically there is no git-argument-level mitigation for MAJOR #2** (this is the finding
    that overturns the Code Review's OWN prescribed fix — see the correction below): neither `--no-guess`
    nor a trailing `--` stops `"-"`, `"@{-1}"`, or `"-bsneaky"` from being specially interpreted or parsed
    as an option when they occupy the branch-name argument position. Placing `--` BEFORE the name instead
    (the only placement that actually stops option/revision parsing) changes `git checkout`'s own meaning
    to "restore this PATHSPEC from the index", not "switch to this branch" — breaking the ordinary,
    legitimate case entirely. `unsafeBranchNameReason` is therefore the ONLY thing that closes MAJOR #2,
    not a defense-in-depth backstop alongside a git-spawn-level one.
- **`GitWriter.checkout()` now spawns `git checkout --no-guess <name>`** (no trailing `--` — see above for
  why one was tried and dropped). Verified directly, real git, a clone with a configured `origin`: a plain
  `checkout evil` DWIMs (creates+switches, tracking `origin/evil`); `--no-guess evil` cleanly fails
  ("pathspec … did not match"), canonical untouched; `--no-guess <ordinary-existing-branch>` is unaffected.
  Safe and additive for EVERY caller (human REST, Platform Lead, manager, and — found only at round 11,
  see below — the operator's `git_checkout`, `mcp/operator.ts`) — none of them rely on the
  DWIM-from-remote behavior, so this is not scoped to manager-checkout alone.
  - **CORRECTION (card `59e53710`, round 2):** "no trailing `--`" is no longer current — `GitWriter.checkout()`
    now spawns with a trailing `--`. That does NOT contradict this bullet's own finding: this bullet's `--`
    was tried against OPTION INJECTION/revision-shorthand (`"-"`/`"@{-1}"`/`"-bsneaky"`) and measured to do
    nothing against that hazard, which is still true. `59e53710` round 2's trailing `--` targets a DIFFERENT
    hazard — git's PATHSPEC-RESTORE fallback for an argument that is neither a recognized option nor an
    existing ref — where a trailing `--` genuinely does change the outcome (measured there). See that
    record's round 2 for the repro; it is a second, narrower fix layered on top of this one, not a
    reintroduction of what this bullet ruled out.
- **`refuseIfTargetBranchUntrusted` no longer returns `{ok:true, classifiedTip:null}` for anything.** A
  non-existent local branch is now refused directly, here, before any git mutation — never deferred to
  `GitWriter.checkout()`. On success, `classifiedTip` is always a real sha (the type narrows from
  `string | null` to `string`).
  - If a same-named `refs/remotes/*/<branch>` ref exists (checked via one `git for-each-ref` call), that
    is itself alert-worthy — refused with a NEW evidence tag, `"remote-tracking-shadow"`, and a HIGH
    `mainline_moved_outside_loom` event (reusing round 8's own m4 dedupe helper, now factored out as
    `fileManagerCheckoutRefusalEvent` so the two refusal shapes share one dedupe/append/nudge
    implementation). `from` is a documented null-sha sentinel (`"0".repeat(40)`) — there is no real trust
    record for a branch that was never local; a dedupe/history reader must not mistake it for one.
  - If no such shadow exists, this is just an ordinary unknown name — refused with a plain message, no
    event (matching the existing no-event precedent for "branch exists but untrusted").

### Three dead `MainlineEvidence` members dropped (NIT #8)

`"reflog-unverifiable"` (round 7's reflog-reach), `"non-ancestor-move"` and `"untrailered-commits"` (round
8) were each filed ONLY by `refuseIfTargetBranchUntrusted`'s own classify-and-reclassify block, which round
9 deleted entirely. All three were dead on arrival at round 9 and are now removed rather than left to rot;
`classifyMainlineMove` (the shared tripwire) never emitted any of them, so removal is safe for its own
output. `"remote-tracking-shadow"` is the one new member this round adds.

### Remedy-text ordering fixed (MINOR #6)

Both refusal messages that name the human-only reset route used to say "adopt it via the reset route
FOLLOWED BY a checkout" — backwards. The route's own `adopt` mechanism reads whatever is CURRENTLY checked
out in the canonical repo (the human is expected to have ALREADY checked it out — see round 7's M2
section) — calling it before the checkout adopts the WRONG branch's tip. Both messages now say the correct
order explicitly: check out the target branch first, THEN call the reset route.

### Do not (round 10 additions)

- Do not add a FOURTH git-derived classification layer to `refuseIfTargetBranchUntrusted` to close a future
  bypass "for extra safety" — see round 9's own "Do not" above; this round's two findings are about what
  happens BEFORE that gate runs (name validation, DWIM), not about adding another signal INSIDE it.
- Do not read a `Loom-Worker-Branch:` trailer — or ANY trailer `parseLoomTrailerBlock` recognizes — as
  authentication anywhere a TRUST decision is made from it, including indirectly via the shared tripwire's
  own `store()` writes to the per-branch trust record (which this round's tool-description/CLAUDE.md
  updates now explicitly disclose as a forgeable writer, card `f683a5ad`, tracked separately — NOT fixed
  by this round).
- Do not reintroduce a trailing `--` after the branch name in `GitWriter.checkout()`'s spawn "for extra
  safety against option injection" — verified directly that it does nothing for that purpose (see above);
  it would be a no-op dressed as a fix, and a reader who trusts it would stop looking for the real gate
  (`unsafeBranchNameReason`).
  - **CORRECTION (card `59e53710`, round 2):** this prohibition is scoped to OPTION INJECTION specifically
    — the hazard this round measured `--` as useless against. `GitWriter.checkout()` now DOES spawn with a
    trailing `--`, added by `59e53710` round 2 to close a DIFFERENT, pathspec-fallback hazard where a
    trailing `--` genuinely is effective (measured there). Do not "fix" that `--` away by citing this
    bullet — read `59e53710`'s own record before touching it.
- Do not widen `unsafeBranchNameReason` to reject a `"<remote>/<name>"`-shaped name — that shape is a
  legal local branch name too; the existing-local-ref requirement in `refuseIfTargetBranchUntrusted`
  already closes the exploitable case without this false-positive risk.
- Do not claim, anywhere user-facing (tool description, CLAUDE.md), that the per-branch trust record is an
  unconditionally-safe or Loom-only record — name its real writers (a landing, this tool, the reset
  route's `adopt`, and the shared tripwire's own forgeable `store()`) wherever it's described.

### Out of scope (recorded, not fixed by this round)

- The shared mainline tripwire's own `store()` writes to the per-branch trust record are themselves
  git-derived (reflog/trailer-based) and forgeable by the same class of attacker this round defends
  against — tracked separately as card `f683a5ad`.
- Git hooks, a smudge/clean filter, or `fsmonitor` executing arbitrary content DURING a checkout spawned by
  this tool is a known, accepted residual risk of running real git against a worker-writable `.git` at
  all — see `docs/decisions/356538ef-canonical-git-isolation.md`'s own "§Residual" section and the owner's
  own decision, card `b0fb1e26`; not reopened or re-scoped by this round.
- The human-only REST writers (`vault/writer.ts`, `git/writer.ts`) this tool reuses are loopback-gated like
  every other human-authenticated write surface in this project — unchanged by this round, restated here
  only because the Code Review asked that this record not imply otherwise by silence.

### Tests (round 10)

`project-checkout-branch.mjs`: **(DWIM)** the exact CRITICAL #1 repro (a real local repo with a configured
`origin` remote — `git remote add` alone is enough, verified directly, no clone/fetch needed —
`refs/remotes/origin/evil` written directly, no local `evil`) — refused, canonical untouched, W and
`evil`'s own trust record untouched, a HIGH event filed naming `remote-tracking-shadow`; a negative control
confirms an ORDINARY unknown name (no remote-tracking shadow) is still refused but files no event, and a
SECOND negative control confirms an ordinary, trusted LOCAL branch switch is unaffected. **(NAMES)**
`"-"`, `"@{-1}"`, `"-bsneaky"`, `"refs/heads/x"` each refused BEFORE canonical moves (HEAD asserted
unchanged), via BOTH an ordinary switch and `create:true` (a real watermark established first, so the
create-path refusal is provably about the name, not "no watermark yet"); `"origin/x"` — a syntactically
legal local-branch shape `unsafeBranchNameReason` deliberately does NOT reject — tested SEPARATELY, switch
path only (refused via the mandatory local-ref-existence requirement, not a name-shape rejection; `create:
true` with `"origin/x"` would genuinely succeed, so it is not asserted as a refusal anywhere). Direct unit
coverage of `unsafeBranchNameReason` itself: every dangerous shape above rejected, PLUS two negative
controls (`"origin/x"`, `"feature/x"`) proving it does not over-reject an ordinary name. **(UNK)** updated:
a branch that doesn't exist in git is now `refused:true` from this tool's OWN precondition, never a bare
`{error}` deferred from `GitWriter.checkout()` — the prior assertion (`refused !== true`) is inverted, and
a new assertion confirms NO event is filed for this ordinary (non-shadowed) case.

**Per-site negative controls — actually run, RED then GREEN, not assumed — and the results correct this
record's own first draft of what each one closes:**
- **(a) `unsafeBranchNameReason` reverted to a no-op (`return null` unconditionally):** 7 failures — the 6
  direct unit assertions of the function itself, PLUS `(NAMES create "refs/heads/x")` (the one integration
  case this function is independently necessary for: `check-ref-format` accepts `"refs/heads/x"` outright,
  so nothing else in `createProjectBranch` would have caught it). **Every SWITCH-path (NAMES) assertion
  stayed GREEN** — `refuseIfTargetBranchUntrusted`'s own mandatory local-ref-existence requirement (fix b)
  independently refuses `"-"`/`"@{-1}"`/`"-bsneaky"`/`"refs/heads/x"` there too, since none of them is a
  real pre-existing local branch name in any realistic fixture. `create:true` with `"-"`/`"-bsneaky"` is
  independently caught by the pre-existing `check-ref-format` call; `"@{-1}"` is independently rejected by
  git's own ref-validation inside the real `checkout -b` spawn. **Correction to this record's own earlier
  draft:** "no git-argument-level mitigation exists for MAJOR #2" remains true, but `unsafeBranchNameReason`
  is NOT independently load-bearing for every repro in this suite — only for create+`"refs/heads/x"` and
  the direct unit tests. It remains the right fix regardless (the ONLY one that gives an early, uniform,
  reason-legible refusal instead of relying on three different incidental backstops to agree by accident).
- **(b) the `classifiedTip: null` early-return restored (bypassing the hard-refuse-on-nonexistent-branch
  fix entirely):** 4 failures — `(UNK)`'s structured-refusal assertion, `(DWIM)`'s structured-refusal AND
  HIGH-event assertions, and `(NAMES switch "origin/x")`. **`(DWIM)`'s "canonical was NEVER switched to
  evil" and "W was never established" assertions STAYED GREEN even with this fix disabled** — `--no-guess`
  (fix c) independently prevented the actual git mutation; the CALL still returned `ok:false` (a bare,
  unstructured git failure — "pathspec did not match" — not this gate's own HIGH-alerting refusal). This is
  genuine, verified defense-in-depth between (b) and (c): (b) gives the STRUCTURED, alerting refusal; (c)
  is the backstop that would still have stopped the actual mutation had (b) alone regressed.
- **(c) `--no-guess` dropped from the spawn (with (b) left ACTIVE):** **ALL PASS — zero failures.**
  **Correction to this record's own earlier draft, which claimed this would turn the DWIM repro red: it
  does not, verified directly.** With (b) active, `refuseIfTargetBranchUntrusted` refuses the DWIM shape at
  the precondition level and `GitWriter.checkout()` is never reached with the adversarial name at all, so
  removing `--no-guess` alone changes nothing CURRENTLY observable. Its real, verified value is exactly
  what the (b)-disabled run above demonstrates: a second, independent layer that stops the actual mutation
  if (b) itself is ever the thing that regresses — the correct way to read "redundant with (b) today" is
  "exactly the redundancy defense-in-depth is supposed to provide," not "safe to remove."

## Round 11 (SEVENTH Code Review, reviewing round 10's own commits) — a Windows case-aliasing launder,
## a ref-race event gap, a mis-described allowlist entry, a glob that doesn't cross "/", a create-only
## remote-name shadow, and four documentation gaps

Six items, all decided by the lead, none of them reopening round 9's exact-match rule itself:

1. **MAJOR (blocking — the owner runs Windows). `create:true` with a different-CASE name silently moved
   an EXISTING PACKED branch.** Packed-ref lookups are case-sensitive; loose-ref WRITES land on a
   case-insensitive filesystem (Windows/NTFS). So `rev-parse --verify refs/heads/FEAT` returned `''` when
   a packed `feat` existed (the exact-name check `createProjectBranch` used to run), `checkout -b FEAT
   <sha>` wrote a LOOSE `FEAT` ref, and `refs/heads/feat` now resolved to the NEW tip — the owner's branch
   silently re-pointed, the two names aliased forever. **Fixed:** `findCaseInsensitiveBranchMatch`
   (`sessions/service.ts`) — ONE case-folded `for-each-ref` call — replaces the exact-name rev-parse on
   BOTH the create path (`createProjectBranch`'s `checkExistingNameCollision`, refusing on ANY match,
   same case or not) and the switch path (`refuseIfTargetBranchUntrusted`, refusing on a case-DIFFERING
   match before falling through to the existing shadow/unknown-branch handling) — trust is never keyed
   under two spellings of the same branch.
2. **MINOR. A ref race between the in-lock trust classification and the real checkout spawn
   (`checkoutProjectBranch`'s post-checkout `classifiedTipAtAdmission !== result.sha` comparison) returned
   a plain, un-filed error.** It is direct evidence of a concurrent ref write inside the SAME lock window
   this gate exists to close, so it now files the same HIGH `mainline_moved_outside_loom` event every
   other refusal in this gate files (`fileManagerCheckoutRefusalEvent`, evidence `untrusted-tip-mismatch`).
   `checkoutProjectBranchPrecondition`'s success type tightens from `classifiedTip: string | null` to
   `classifiedTip: string` — `refuseIfTargetBranchUntrusted` never returned `null` on success to begin
   with, so the old `!== null &&` guards at both this site and the "already checked out, W disagrees"
   fixup path were unreachable dead code; both are DELETED (not merely left unreachable) so a future
   `null` can never silently disable either comparison again. This was CR6's CRITICAL shape, now closed
   at the type level instead of by convention.
3. **MINOR. `canonical-git-helper-guard.mjs`'s allowlist reason for `sessions/service.ts` — "worktree
   GC/size probes via boundedGit(); no merge or content judgement" — had gone FALSE**: this card's own
   `refuseIfTargetBranchUntrusted`/`canonicalTreeHasTrackedChanges`/`listUnmergedWorkerBranches`/
   `createProjectBranch` all make real checkout TRUST decisions via `boundedGit()`. **Fixed by routing,
   not by rewording:** a new `canonicalReadGit()` wraps `canonicalGit()` (`git/bounded.ts` —
   `core.useReplaceRefs=false` + merge-driver guarding) for every one of those trust reads; the file's
   OTHER `boundedGit()` call sites (the retained-worktree dirty/ahead-count probes, the operational-home
   `rev-parse --show-toplevel` check) are genuinely unchanged non-trust probes, so the EXISTING allowlist
   text is true again rather than needing a rewrite.
4. **NIT. The remote-tracking shadow check's own `for-each-ref` PATTERN, `refs/remotes/*/${branch}`,
   doesn't cross `/`** — a remote whose own name contains a slash (a manually configured
   `remote.a/b.url`) was missed. **Fixed:** list the whole `refs/remotes/` namespace and filter by a
   `/${branch}` SUFFIX in JS instead, which matches regardless of how many slashes the remote's own name
   has.
5. **MINOR (lead decision: fix the CREATE path only). `create:true "origin/main"` creates a local
   `refs/heads/origin/main` that shadows the remote-tracking ref `refs/remotes/origin/main` for the
   owner's own `git log origin/main`/`git rebase origin/main`.** **Fixed, create path only:**
   `refuseIfCreateNameShadowsRemote` refuses a `create:true` name whose FIRST path segment exactly
   matches a configured remote's name (`git remote`); a bare name with no `/` is untouched (nothing it
   could shadow). **Switching to an EXISTING such branch stays allowed**, consistent with this record's
   own round-10 "Do not" (`unsafeBranchNameReason` deliberately does not reject a `"<remote>/<name>"`
   shape either) — the create path differs because CREATING the shadow is the controllable moment; a
   branch of this shape that already exists is governed by its own trust record like any other.
6. **DOCS.** `GitWriter.checkout()`'s `--no-guess` has a FOURTH caller this record and `writer.ts`'s own
   doc comment both omitted: the operator's `git_checkout` (`mcp/operator.ts`, the codex-parity surface)
   — fixed in both places (see this round's own "Safe and additive for EVERY caller" correction above, and
   `writer.ts`'s own caller-list comment). The `project_checkout_branch` tool description named only the
   four pre-git name-SHAPE rules (leading `-`, `@{`, `..`, `refs/` prefix) and never the conservative
   CHARSET rule (`unsafeBranchNameReason`'s own `SAFE_BRANCH_NAME_RE`) — fixed to state it, plus the two
   new refusal shapes items 1 and 5 above add. **Out of scope, named rather than silently left:** the
   operator's `git_checkout`/`git_create_branch` and the Platform Lead's `git_checkout`/`git_create_branch`
   do NOT run `unsafeBranchNameReason` at all — only `project_checkout_branch`'s own single entry point
   does — so the option-like/revision-shorthand name-shape bypasses round 10 closed for the MANAGER
   surface remain open on those two surfaces; tracked separately as card `59e53710`.
   **CORRECTION (round 14, card `59e53710`): this gap is CLOSED, not merely tracked** — see this
   record's own round-14 section below. `unsafeBranchNameReason` itself is still opt-in per caller, but
   its no-legitimate-use subset (leading `-`, `@{`) now ALSO runs inside `GitWriter.checkout()`/
   `createBranch()` themselves, so every one of the four callers refuses that subset structurally.

### Do not (round 11 additions)

- Do not key a case/name collision check off `rev-parse --verify refs/heads/<exact-case>` alone again —
  that is precisely what missed the packed-vs-loose case-aliasing MAJOR above; use a case-folded
  `for-each-ref` scan instead (round 12 widens this into `findCaseFoldPrefixCollision` — see its own
  section below; this round's narrower `findCaseInsensitiveBranchMatch` no longer exists).
- Do not restore the `classifiedTip: string | null` / `classifiedTipAtAdmission !== null &&` shape
  "for safety" — it was unreachable dead code that happened to also be a silent kill-switch; the tightened
  type is what keeps a future `null` from reintroducing CR6's CRITICAL shape.
- Do not widen `refuseIfCreateNameShadowsRemote` to the SWITCH path — switching to an existing
  `"<remote>/<name>"`-shaped branch is deliberately unaffected (see item 5 above); this is a create-only
  footgun guard, not a name-shape rule.
- Do not route the file's OTHER (non-trust) `boundedGit()` probes through `canonicalReadGit()` "for
  consistency" — `canonicalTreeHasTrackedChanges`/`listUnmergedWorkerBranches`/`refuseIfTargetBranchUntrusted`/
  `createProjectBranch`'s trust reads are the ONLY calls this round moves; the retained-worktree dirty/
  ahead-count probes and the operational-home toplevel check are genuinely off this gate's trust path and
  stay on plain `boundedGit()` — moving them would just make the allowlist reason false in the other
  direction.

### Tests (round 11) — CORRECTION (round 12, eighth Code Review, MAJOR 1): this section as originally
### written claimed six tests existed. Only the (N1-MISMATCH) negative-control update (closing item 2's
### own regression) was actually written. The other five were a description of INTENDED coverage that
### never made it into `project-checkout-branch.mjs` — a real gap, not a rounding error. See "Tests (round
### 12)" below for where that coverage actually landed (CASEFOLD A/B/C/D1/D2, NEVER-TWO-SPELLINGS,
### SHADOW-EXACT, REMOTE-PREFIX-CI, CREATE-REMOTE-SHADOW), proven RED on the pre-round-12 commit by revert.

`project-checkout-branch.mjs`: the (N1-MISMATCH) negative control now clears the alert the mismatch itself
files (item 2) before asserting the retry succeeds — see "Tests (round 12)" for the rest.

## Round 12 (EIGHTH Code Review, reviewing round 11's own commits) — case-fold widened to PATH PREFIXES,
## the remote-tracking shadow match made EXACT, a widened remote-prefix check, and the missing round-11
## tests actually written

The eighth Code Review confirmed round 11's case-fold core works (RED→GREEN on round 11's own CR7 repro)
and that `canonicalReadGit` is real, but found two further gaps plus the round-11 test-coverage gap this
record's own correction above names.

1. **MAJOR 1 — round 11's case check was full-name-only; a PATH-PREFIX collision laundered too.**
   `findCaseInsensitiveBranchMatch` compared only the WHOLE requested name against the WHOLE existing
   name. `create:true "FEAT/X"` over a packed `feat/x` — or, the reverse shape, `create:true "FEAT/x"`
   over a loose `feat/y` (the candidate's own leaf segment colliding with an existing branch's DIRECTORY
   segment, never its full name) — passed clean under round 11's check: neither candidate's full name
   ("FEAT/X"/"FEAT/x") case-folded to either existing branch's full name ("feat/x"/"feat/y"); the
   collision lives at the PATH-PREFIX level ("FEAT" vs "feat"), one level below what the check ever
   looked at. **Fixed:** `findCaseFoldPrefixCollision` (`sessions/service.ts`, replacing
   `findCaseInsensitiveBranchMatch` entirely) compares every path-prefix of the requested name (including
   its own full name) against every path-prefix of every existing branch's name (including ITS full
   name), case-folded; a match that differs in exact case is a collision regardless of which side is the
   shorter/directory segment. Used by BOTH `createProjectBranch`'s existing-name check and
   `refuseIfTargetBranchUntrusted`'s "doesn't exist under the exact case" branch.
2. **MAJOR 2 (a round-11 regression) — the remote-tracking shadow match over-matched by SUFFIX.**
   Round 11's fix for round 10's CRITICAL #1 (the DWIM-remote-tracking launder) listed the whole
   `refs/remotes/` namespace and filtered by `r.ref.endsWith(`/${a.branch}`)` to fix the "doesn't cross
   `/`" bug in the OLD glob pattern — but a bare SUFFIX match over-corrects: `refs/remotes/origin/hotfix/
   zzz` ends with `/zzz` and is a WHOLLY DIFFERENT branch (`hotfix/zzz`, not `zzz`), yet the suffix test
   treated it as a shadow of a switch to `"zzz"`, filing a FALSE HIGH `mainline_moved_outside_loom` alert
   that then blocked EVERY subsequent `project_checkout_branch`/`create:true` call on the whole project
   (`hasUnresolvedMainlineAlert`) until a human noticed and reset it — git's own checkout DWIM was never
   actually reachable through that shape in the first place, so the alert was pure noise with a real
   blast radius. **Fixed:** matched EXACTLY per configured remote instead — list `git remote`, then for
   each remote `R` check whether `refs/remotes/<R>/<branch>` literally exists (one `for-each-ref` over
   `refs/remotes/` built into a `Map`, looked up by the EXACT constructed ref string, never a suffix
   test). Only that shape is what git's own DWIM could ever have created.
3. **MINOR 3 — the create-path remote-prefix check matched only the remote's FIRST segment, case-sensitively.**
   Round 11's `refuseIfCreateNameShadowsRemote` split the branch on `/` and checked whether the FIRST
   segment alone equaled a configured remote's name, exactly. Two gaps: `"Origin/main"` against a
   lowercase `origin` remote never matched (case-sensitive compare), and a MULTI-SEGMENT remote name
   (e.g. `"a/b"`, configured via `git config remote.a/b.url` — git does not reject the shape) was never
   checked at all, since `branch.split("/")[0]` only ever sees `"a"`, which is not itself a configured
   remote. **Fixed:** for every remote `R`, check `branch.toLowerCase().startsWith(R.toLowerCase() +
   "/")` — covers an arbitrary-length, case-insensitive remote-name prefix in one pass, no split needed.
4. **MINOR 4 — the switch path's OWN case-aliasing gap (CR8 "(C)"), closed by removing `rev-parse`
   entirely, not by adding a third check.** Round 11's switch-path fix still resolved the target via
   `rev-parse --verify --quiet refs/heads/<name>` FIRST, only falling back to the case-fold check when
   that resolution FAILED. But a case-insensitive filesystem can make that resolution SUCCEED for the
   wrong reason: asking for `refs/heads/FEAT` when only a LOOSE `feat` exists can open the same file via
   NTFS's own case-insensitive path lookup, returning `feat`'s real sha as if `FEAT` were its own ref.
   The old code then proceeded straight to the trust check under the literal string `"FEAT"` — which had
   no trust record of its own — producing a MISLEADING "no trusted baseline on record" refusal (whose own
   remedy text suggests `create:true`, the exact shape MAJOR 1 above closes) instead of correctly naming
   the real collision with `feat`. **Fixed, structurally rather than by adding a third special-cased
   check:** `refuseIfTargetBranchUntrusted` no longer calls `rev-parse` AT ALL. It lists `refs/heads/`
   via `for-each-ref` ONCE and looks up the requested name by EXACT, case-sensitive string equality
   (`===`) against that listing — the same listing this round's own `findCaseFoldPrefixCollision` check
   already needs, so the fix doubles as a de-duplication of git reads, not an added one. A result that
   isn't an exact match falls straight into the SAME case-fold/shadow handling the "doesn't exist" branch
   already runs, closing CASE (C) and D1/D2 (MAJOR 1) through the identical code path — there is no
   special "resolved-but-wrong" branch left to maintain separately.
5. **MINOR 5 — the in-lock ref-race mismatch's own remedy text still said "retry" after round 11 taught it
   to file an alert first.** Round 11's item 2 fix (filing a HIGH event on the post-checkout
   `classifiedTipAtAdmission` mismatch) left the SAME error's remedy text unchanged: "check the repo by
   hand and re-run project_checkout_branch to retry" — but the alert JUST FILED by that same call now
   blocks exactly that retry via `hasUnresolvedMainlineAlert`, making the suggested remedy a dead end.
   **Fixed:** the remedy now names the human-only reset route as the actual next step, matching every
   other alert-filing refusal in this gate.

### Do not (round 12 additions)

- Do not reintroduce a `rev-parse`-based existence check anywhere in `refuseIfTargetBranchUntrusted` "for
  a quick early exit" — that is precisely MINOR 4's regression; the `for-each-ref` listing this function
  already fetches is the only correct source for "does this exact name exist."
- Do not narrow `findCaseFoldPrefixCollision` back to a full-name-only comparison "for simplicity" — that
  is exactly MAJOR 1's gap; the function's whole point is comparing every path-prefix on both sides.
- Do not match the remote-tracking shadow check by any SUFFIX or substring shape again, even one that
  "looks" more precise than round 11's — only an EXACT `refs/remotes/<remote>/<branch>` construction per
  configured remote is sound; see MAJOR 2's own repro for why a suffix test cannot be patched to work.
- Do not restrict `refuseIfCreateNameShadowsRemote`'s remote-prefix check back to the FIRST path segment,
  or make it case-sensitive again — both are exactly MINOR 3's gaps, found on real remote-name shapes
  (`"a/b"`, `"Origin"`) that are not hypothetical.
- Do not claim a test exists in this record without having actually written it into
  `project-checkout-branch.mjs` and run it RED-then-GREEN by revert — see this record's own "Tests (round
  11)" correction above for the cost of getting this wrong once already.

### Tests (round 12) — CORRECTION (round 13, NINTH Code Review, item 2): this section originally claimed
### every scenario was "proven RED on the pre-round-12 commit (`b1eab515`)". `b1eab515` is PRE-ROUND-11
### (round 11 is `3d2abebc` + `4fb9b88c`), not pre-round-12 — citing it as the pre-round-12 base is simply
### the wrong commit. Separately, the real pre-round-12 tip is `4fb9b88c`, and the full test file CRASHES
### against `sessions/service.ts` reverted to it (an unrelated, pre-existing crash elsewhere in the file —
### not in any scenario this round touches — so RED is only reproducible by running the relevant scenarios
### in isolation, not the whole file). And not every scenario below is actually RED there: round 11 already
### covered several of them. Re-verified directly (round 13; an isolated script running ONLY the scenarios
### below, service.ts reverted to the real pre-round-12 tip `4fb9b88c`, dist rebuilt, re-run): **RED at
### `4fb9b88c`** — (CASEFOLD C)'s own "the refusal names `feat`, not a misdiagnosis" assertion (the "is
### refused" and negative-control assertions already passed at `4fb9b88c`); both (CASEFOLD D2) assertions;
### both (SHADOW-EXACT) negative-control assertions ("an ordinary refusal, not a shadow match" and "no HIGH
### event filed" — the SHADOW-EXACT positive control already passed at `4fb9b88c`); both (REMOTE-PREFIX-CI)
### assertions. **GREEN (already covered) at `4fb9b88c`** — (CASEFOLD A), (CASEFOLD B), (CASEFOLD D1),
### (NEVER-TWO-SPELLINGS), and (CREATE-REMOTE-SHADOW), all of which round 11 already made pass. Every
### scenario below is GREEN at round 12's own tip (`997f9591`), which is what actually matters for the
### suite as committed; what changes in this correction is only WHICH scenarios round 12 itself fixed vs.
### which round 11 had already fixed, and the base commit identified for "pre-round-12."

`project-checkout-branch.mjs`: **(CASEFOLD A)** `create:true "FEAT"` over a `git pack-refs --all`-packed,
trusted `feat` — refused, naming `feat`; `feat`'s own sha and trust record untouched; no local `FEAT` ref
is ever created. **(CASEFOLD B)** the same packed `feat`, switching to `"FEAT"` instead of creating it —
refused, naming `feat`. **(CASEFOLD C)** a LOOSE (never packed) `feat`, switching to `"FEAT"` — refused,
naming `feat` rather than the old "no trusted baseline" misdiagnosis (CR8's own "(C)" case); a negative
control confirms the exact existing name `"feat"` still switches cleanly. **(CASEFOLD D1)** `create:true
"FEAT/X"` over a packed, trusted `feat/x` — refused, naming `feat/x`. **(CASEFOLD D2)** the reverse shape:
`create:true "FEAT/x"` over a loose, trusted `feat/y` — refused, naming the colliding directory component
via `feat/y`; a negative control confirms a non-colliding sibling `feat/z` (same exact-case directory)
still creates cleanly. **(NEVER-TWO-SPELLINGS)** after both (A)-shaped refusals, no trust record is ever
stamped under the colliding case `"FEAT"`, and `feat`'s own trust record is untouched — the record's own
claim, checked directly rather than assumed. **(SHADOW-EXACT)** a negative control proves
`refs/remotes/origin/hotfix/zzz` is NOT treated as a shadow of a switch to `"zzz"` (an ordinary refusal, no
event filed); a positive control on the SAME fixture shape proves `refs/remotes/origin/zzz` still IS
caught, with a HIGH event naming `remote-tracking-shadow`. **(REMOTE-PREFIX-CI)** `create:true
"Origin/main"` is refused case-insensitively against a lowercase `origin` remote; `create:true "a/b/c"` is
refused against a multi-segment remote literally named `"a/b"` (configured via `git config
remote.a/b.url`, the same technique this record's round-10 section already named for that shape).
**(CREATE-REMOTE-SHADOW)** `create:true "origin/main"` against a configured `origin` remote is refused
(round 11's own promised-but-missing test, now actually written); switching to an ALREADY-EXISTING
`"origin/main"` LOCAL branch, once trusted, stays allowed — confirming this record's "switching to such a
branch if it already exists is unaffected" claim holds in practice, not just in prose.

## Round 13 (NINTH Code Review, reviewing round 12's own commit `997f9591`) — `%(refname:short)`'s own
## ambiguous shortening, and a corrected test-base citation

The ninth Code Review (CR9) reproduced one blocking MAJOR on top of round 12 and one inaccuracy in this
record's own "Tests (round 12)" section (corrected above, in place).

1. **MAJOR — both `refs/heads/` listings in `sessions/service.ts` used `%(objectname) %(refname:short)` /
   `%(refname:short)` (`refuseIfTargetBranchUntrusted` at what was then ~:6273, and `createProjectBranch`'s
   `checkExistingNameCollision` at ~:6515).** Git's own `%(refname:short)` shortens a ref to the shortest
   name that resolves UNAMBIGUOUSLY under its DWIM rev-parse rules — and those rules include, alongside
   `refs/tags/%.*s`, `refs/remotes/%.*s/HEAD` (verified directly: both a same-named TAG and a bare
   `refs/remotes/<name>/HEAD` ref — no `git remote add` needed, just the ref existing — make git shorten
   `refs/heads/feat` to `heads/feat` instead of `feat`). Both listings then compared the caller's literal
   branch string (`"feat"`) against that shortened, ambiguity-dependent name, which breaks in TWO
   directions at once:
   - **CREATE false-negative (launders a case-aliasing sibling):** a packed, trusted `feat` branch
     coexisting with a same-named tag `feat` made `create:true "FEAT"` return `ok:true` and plant a real
     `refs/heads/FEAT` beside `refs/heads/feat` — the exact NTFS case-aliasing CASEFOLD A was built to
     prevent, reopened by an unrelated ref (a tag) the gate never otherwise reasons about.
   - **SWITCH false-refusal:** the SAME ambiguity made switching to the EXACT existing name `"feat"`
     refuse with "no local branch \"feat\" exists" — a real, trusted, currently-switchable branch refused
     outright, a round-12 regression (round 11's own `rev-parse`-based check, since removed by round 12's
     MINOR 4, happened not to trip on this particular ambiguity).
   **Fixed:** both sites now read `%(refname:lstrip=2)` instead of `%(refname:short)` (plus
   `%(objectname)` unchanged at the first site) — `lstrip=2` strips the leading `refs/heads/` path
   components UNCONDITIONALLY, with no ambiguity-dependent shortening, so the compared name is always the
   ref's real short name regardless of what tags, remotes, or other refs exist elsewhere in the repo.
   `listUnmergedWorkerBranches`'s own, pre-existing `%(refname:short)` use (~:6425 at the time) is NOT
   touched by this round — carded separately (card `1bc9602b`) — see "Do not" below.
2. **Docs correction (CR9 item 2)** — this record's own "Tests (round 12)" section is corrected in place
   above: `b1eab515` is pre-round-11, not pre-round-12; the real pre-round-12 tip is `4fb9b88c`; the full
   test file crashes reverted that far back (an unrelated, pre-existing crash, not in any round-12
   scenario), so RED is only reproducible per-scenario; and not every round-12 scenario was actually RED
   at `4fb9b88c` (several were already fixed by round 11).

### Do not (round 13 additions)

- Do not touch `listUnmergedWorkerBranches`'s own `%(refname:short)` use as part of this card — it has the
  identical fail-open shape (CR9 item 3 / card `1bc9602b`), but is explicitly OUT OF SCOPE here; fix it
  under its own card, not as a drive-by here.
- Do not reach for `%(refname)` plus a hand-rolled `.replace(/^refs\/heads\//, "")` in JS "for clarity" —
  `%(refname:lstrip=2)` does the identical, unconditional strip server-side in one format atom; the two are
  equivalent for anything actually listed under `refs/heads/` (the only pattern either call site ever
  passes to `for-each-ref`), so there is no behavioral reason to prefer the JS version.
- Do not assert a scenario's current branch via `fx.canonBranch()` (`git symbolic-ref --short HEAD`) in a
  test that deliberately manufactures a same-named-tag ambiguity — that helper is ITSELF ambiguity-prone
  the identical way (verified directly: it also shortens to `heads/feat` when tag `feat` coexists), so
  using it to assert "really switched to feat" in exactly this scenario tests the wrong thing and can read
  GREEN for the wrong reason, or FAIL on a sound fix. Use the unshortened `git symbolic-ref HEAD` (always
  `refs/heads/<name>`, never ambiguity-shortened) instead, scoped to the scenario(s) that manufacture the
  tag collision; every other scenario in this suite keeps using `fx.canonBranch()`, which is fine there.

### Tests (round 13)

`project-checkout-branch.mjs`, every new assertion proven RED against the real round-12 tip (`997f9591`,
the service.ts before this round's own two-site fix) by reverting just `sessions/service.ts` to it,
rebuilding, and re-running an isolated script with only these scenarios, then restored and re-verified
GREEN: **(R13-TAG-CREATE)** a packed, trusted `feat` plus a same-named TAG `feat` — `create:true "FEAT"`
is refused, naming `feat`; `feat`'s own sha is unchanged; no local `FEAT` ref is ever created (RED at
`997f9591`: "is refused", "names feat", and "no FEAT ref created" all failed — the tag ambiguity let
create:true silently succeed). **(R13-TAG-SWITCH)** the same tag-ambiguous `feat`, switching to the EXACT
existing name `"feat"` succeeds (checked via the unshortened `git symbolic-ref HEAD`, per the "Do not"
above — `fx.canonBranch()` itself proved ambiguity-prone in exactly this scenario, a real near-miss caught
before landing: an earlier draft of this test used it and failed GREEN-proof for the wrong reason, which
is why that helper is now avoided here specifically). RED at `997f9591` ("no local branch exists").
**(R13-REMOTEHEAD-SWITCH / -CREATE)** a `refs/remotes/feat/HEAD` ref (no `git remote add` — the bare ref
alone reproduces the ambiguity) is a second, independent trigger for the identical bug: switching to
`"feat"` succeeds (RED at `997f9591`), and `create:true "FEAT"` is refused, naming `feat` (RED at
`997f9591` on the "names feat" assertion specifically — the bare "is refused" assertion happened to pass
at `997f9591` too, for an unrelated reason, since the create path's exact-name check also failed to find
`feat` and fell through to a different refusal; the naming assertion is what actually isolates this bug).
Setup controls in every scenario assert git's own ambiguous shortening is genuinely present
(`for-each-ref --format=%(refname:short)` on the manufactured fixture returns something other than
`"feat"`) before trusting the scenario's own RED/GREEN result — without it, a scenario that happened not
to reproduce git's own ambiguity on a given git version/config would pass GREEN vacuously either way.

## Round 14 (card `59e53710`) — the name-shape bypass round 11 tracked for the non-manager surfaces is closed

Round 11's item 6 named, rather than fixed, a shared-unit-divergence gap: `unsafeBranchNameReason` was
opt-in per caller, and only `project_checkout_branch` (this card's own manager surface) called it, so the
operator's `git_checkout`/`git_create_branch` (`mcp/operator.ts`), the Platform Lead's own pair
(`mcp/platform.ts`), and the human REST route (`gateway/server.ts`) all handed a raw, unvalidated branch
name straight to `GitWriter` — reopening MAJOR #2's `"-"`/`"@{-1}"`/`"-bsneaky"` bypass (round 10) on all
three. A Code Review of this card's own commit `4fabafd1` found the gap and filed card `59e53710` to close
it.

**Fix (full detail: `docs/decisions/59e53710-branch-name-shape-check-into-gitwriter.md`):**
`unsafeBranchNameShapeReason(name)`, a new, narrower function carrying only the two checks with no
legitimate branch-name use at all (a leading `"-"`, and `"@{"`), is now called by
`GitWriter.checkout()`/`createBranch()` THEMSELVES, before any git call — so every caller that constructs
a `GitWriter` gets this subset enforced structurally, not just whichever caller happens to run the wider
`unsafeBranchNameReason` first. `unsafeBranchNameReason` is unchanged in behavior: it delegates its own
leading-`"-"`/`"@{"` checks to the new function and keeps its remaining three checks (`".."`, a `"refs/"`
prefix, the conservative `SAFE_BRANCH_NAME_RE` charset) exactly where they were — caller-side-only, run
only by `project_checkout_branch`. `project_checkout_branch`'s own behavior is therefore byte-identical
before and after this round; the widening is additive-only for the other three surfaces.
**CORRECTION (round 15): the `"refs/"` prefix claim above is WRONG** — git's own validation does NOT
reject it (measured), and it has since MOVED into the shared function too. See round 15 below.

### Do not (round 14 additions)

- Do not fold `".."`/the `"refs/"` prefix/the charset check into `unsafeBranchNameShapeReason` too — see
  `59e53710`'s own record for why those three stay caller-side-only (they are either already redundant
  with git's own ref validation, or deliberately more restrictive than `GitWriter`'s other three callers
  should be).
- Do not read this round as reopening round 9/10's own exact-match trust gate — it fixes a DIFFERENT,
  shared-unit-divergence problem (a check some callers of `GitWriter` never ran at all), not another layer
  on `refuseIfTargetBranchUntrusted`.

### Tests (round 14)

New per-surface integration coverage, each proven RED on pre-fix `GitWriter.checkout`/`createBranch` (the
writer-only change reverted via `git checkout HEAD --`, rebuilt, re-run, then restored and re-verified
GREEN): `operator-branch-name-shape-refusal.mjs`, `platform-branch-name-shape-refusal.mjs`,
`gateway-branch-name-shape-refusal.mjs` — each tries `"-"`/`"@{-1}"`/`"-bsneaky"` against both
`checkout`/`createBranch`, asserts the structured refusal, asserts canonical HEAD/branch-list is
unchanged, and carries a negative control that an ordinary name still succeeds. Direct unit coverage of
`unsafeBranchNameShapeReason` and the two `GitWriter` methods themselves was added to `git-writer.mjs`.
The pre-existing manager-surface `(NAMES)` coverage in `project-checkout-branch.mjs` (round 10) is
unchanged and confirmed still green — this round does not touch `project_checkout_branch`'s own behavior.

## Round 15 (Code Review of round 14's commit `c37bd715`, card `59e53710`) — a doc error, a pathspec-
## fallback data-loss path, and a weaker-than-claimed test

Full detail: `docs/decisions/59e53710-branch-name-shape-check-into-gitwriter.md`'s own "Round 2" section
(that record's round numbering is independent of this one — don't conflate the two). Three findings:

1. **DOC ERROR.** Round 14's claim above that a `"refs/"` prefix is "redundant with git's own ref
   validation" is FALSE, measured directly: `createBranch("refs/heads/other")` creates a real nested
   `refs/heads/refs/heads/other` ref, and `checkout("refs/heads/<existing-branch>")` DETACHES HEAD rather
   than switching to that branch. **Fixed by moving `"refs/"` into `unsafeBranchNameShapeReason` itself**
   (alongside leading `"-"`/`"@{"`) — enforced for every `GitWriter` caller, not caller-side-only.
2. **A pre-existing pathspec-fallback data-loss path**, reachable via the SAME three non-manager
   surfaces round 14 widened: `GitWriter.checkout()`'s `git checkout --no-guess <name>` spawn (no trailing
   `--`) falls back to PATHSPEC mode for a name that resolves as neither an option/revision shorthand nor
   an existing ref — `checkout(".")` or `checkout(<a tracked filename>)` silently discards a dirty tracked
   file; `checkout("<branch>^{}")` detaches HEAD. **Fixed:** `checkout()` now verifies `target` is an
   EXISTING local branch (`branchLocal().all`, NOT a `raw(["show-ref",...])` exit-code check — simple-git's
   `.raw()` does not reject on that command's failure shape, verified directly) before the mutating spawn,
   plus a trailing `--` as a second, independent layer against a check/use race.
3. **Test strength.** Round 14's own per-surface `"-"`/`"@{-1}"` cases passed pre-fix for the wrong reason
   (no real reflog "previous branch" in the fixture to resolve to) and the `"-bsneaky"` checkout case
   compared a bare sha (a same-sha new branch passes). Fixed: every test now establishes a real previous
   branch first and asserts via `git symbolic-ref HEAD`, never a sha.

### Do not (round 15 additions)

- Do not trust round 14's own claim that `"refs/"` stays caller-side-only — it does not, as of this round.
  Read `59e53710`'s own record (not this file) for the current, authoritative split of which checks live
  in `unsafeBranchNameShapeReason` vs. `unsafeBranchNameReason`.
- Do not add a `show-ref`/`raw()`-based existence check anywhere git-writer-adjacent in this repo without
  first checking whether the exact command's failure shape actually rejects through this codebase's
  simple-git wrapper — it does not for every command, and the silent-pass failure mode is exactly what
  round 15's finding 2 was.

### Tests (round 15)

Each of the three per-surface files from round 14, plus `git-writer.mjs`'s own direct unit coverage, now
ALSO covers: the `"refs/heads/<existing-branch>"` shape (checkout detach + createBranch nested-ref), and
the pathspec-fallback shapes `"."`/a real tracked filename/`"<branch>^{}"` (dirty-file byte-unchanged +
HEAD-never-detached assertions). All new assertions proven RED against the real round-14 tip (`c37bd715`,
reverting just `writer.ts` to that commit, rebuilding, re-running, then restored and re-verified GREEN).
