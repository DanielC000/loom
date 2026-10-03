# 787dd2a7 — ONE first-sight seeding rule: never mint W from a branch that disagrees with a resolvable default

Follow-up to `4fa36502`/`2a6a292a`/`ba663984`/`77b8319b`. `checkMainlineMove`'s "absent" branch used to
`store()` unconditionally on every call, including a LANDING-path call that runs before every squash/ff
attempt regardless of whether that attempt then actually lands (a branch mismatch, a conflict, a stale
branch tip can all fail it afterward). A mid-gate divert — batch's own gate-closure divert, or a solo
checkout changed before its pre-squash tripwire — could therefore seed W with a branch nothing ever
actually landed on. Every later landing then hard-refused against that stray baseline, and the refusal
text's "reset the watermark" remedy wrongly implied the reset itself re-initializes W from the current
checkout (it doesn't — `resetMainlineWatermark` only deletes the row; see below).

A BOOT first sight has no "verified landing" to lean on at all — it's just whatever happens to be checked
out at boot, which may be an ad hoc branch a human left checked out.

## The fix

Seeding on a LANDING path (solo via `confirmWorkerMerge`, batch via `mergeBatchTracked`) is deferred
entirely to `advanceMainlineWatermark`/`advanceMainlineWatermarkForBatch`, which already only write W
after independently re-verifying the squash/ff actually landed on the checked tip (first-parent /
ancestor-of-landed-tip). `checkMainlineMove`'s own "absent" branch no longer stores for a landing source;
it just returns the observed tip for `advanceMainlineWatermark{,ForBatch}` to later validate.

Both a BOOT first sight and a LANDING's own now-sole seed point (`advanceMainlineWatermark{,ForBatch}`'s
no-prior-watermark case) consult the SAME resolver, via the one shared `firstSightSeedAllowed` helper:
resolve the repo's default mainline branch (`refs/remotes/origin/HEAD` — see `resolveMainlineBranchState`'s
own doc). A `"no-default"` result means there's nothing trustworthy to compare against, so the branch
being seeded (whatever it is) is accepted unconditionally on BOTH paths — preserving the existing,
already-tested silent-seed behavior for the common no-remote case (every `git init`-only test fixture, and
every real `project_init`-created project with no remote). **As of round 2 (below), the two paths diverge
only on what a RESOLVED-but-disagreeing default does:** boot still withholds the seed (one deduped
low-severity `evidence:["first-sight-declined"]` event, via `recordFirstSightDeclined`); a landing now
seeds anyway and files an addressed notice instead (`evidence:["first-sight-seeded-stray"]`, via
`recordFirstSightSeededStray`) — see "Round 2" below for why, and the dedupe shape both share.

## Do not

- Do not let `checkMainlineMove`'s "absent" branch `store()` for a LANDING source (`a.source` unset/
  `"landing"`) ever again — that is the exact bug this card closes. Seeding on a landing path belongs
  exclusively to `advanceMainlineWatermark{,ForBatch}`'s own no-prior-watermark case.
- Do not apply `firstSightSeedAllowed`'s RESOLUTION check only at boot — `advanceMainlineWatermark` and
  `advanceMainlineWatermarkForBatch` must apply the identical resolver call at their own
  `watermarkRead.state === "absent"` branch. **Round 2 correction:** the CONSEQUENCE of a "decline" outcome
  now differs by path — boot still withholds the seed, a landing seeds anyway (see "Round 2" below) — but
  the resolver call itself, and the "allow" outcome's behavior, stay identical on both paths.
- Do not treat `resolveMainlineBranch`/`resolveMainlineBranchState` returning a non-resolved state as one
  undifferentiated case. A genuine `"no-default"` (a local-only repo, no remote) means there's nothing
  trustworthy to compare against, so the branch being seeded is accepted unconditionally — preserving the
  existing silent-seed behavior for the common no-remote case (every `git init`-only test fixture, and
  every real `project_init`-created project with no remote). **Round 2:** a TRANSIENT `"failed"` state (a
  timeout, a spawn error) is NEITHER "no-default" NOR "disagrees" — it DEFERS (no seed, no event, no
  notice at all), retried at the next first sight, never conflated with either settled outcome.
- Do not let a BOOT-path declined-first-sight marker (`recordFirstSightDeclined`, `evidence:
  ["first-sight-declined"]`) ever get picked up by `deliverPendingBootAlerts` or protected by
  `checkMainlineMove`'s own `keepPriorMarker` divert-alert logic as if it were an undelivered real alert —
  it stamps `nudgedAt` immediately (purely informational, never meant to be delivered as a nudge)
  specifically so it is transparent to both of those mechanisms. **Round 2:** this does NOT apply to the
  NEW landing-path marker (`recordFirstSightSeededStray`, `evidence: ["first-sight-seeded-stray"]`) — that
  one is a REAL addressed notice attempt (`enqueueDurableMessage`) and deliberately leaves `nudgedAt:null`
  on a failed attempt so `deliverPendingBootAlerts`/`onOrchestrationMcpFirstSeen` picks it up later, the
  same fallback every other real alert marker already relies on. Both marker kinds additionally skip their
  OWN write (never clobbering) when an unrelated marker already occupies the slot with `nudgedAt:null`.
- Do not re-word the two reset-route refusal strings (solo, batch) back to implying `resetMainlineWatermark`
  "re-initializes the watermark from the current checkout" — it only DELETES the stored row;
  re-seeding happens lazily, later, at the next verified landing or a matching boot check, under this
  same first-sight rule.

## Round 2 (card 787dd2a7 round 2, Code Review `ab4ce11c`)

Round 1's "decline ⇒ leave W unseeded" was itself a fresh bug on the LANDING path specifically: a stale or
never-refreshed `origin/HEAD` (set at clone, never updated across a `master`→`main` rename, or any fork)
makes `firstSightSeedAllowed` decline at EVERY first-sight attempt for that repo, so W never seeds and the
`4fa36502` tripwire + the solo/batch branch pin stay off for that repo indefinitely — behind one
low-severity event that may never reach a live manager.

Fixed, LANDING path only (`advanceMainlineWatermark`/`advanceMainlineWatermarkForBatch`): a "decline"
outcome now SEEDS from the verified landing's own branch anyway, then files an ADDRESSED notice
(`recordFirstSightSeededStray`) to the landing's manager — reusing the exact alert-marker slot, event
kind, `enqueueDurableMessage` call, and `deliverPendingBootAlerts` fallback every other mainline-watch
alert already uses, naming both branches and the real remedies (`git remote set-head origin -a` for a
stale `origin/HEAD`; the human reset route for a genuinely-wrong landing branch). Deduped per
(repoKey, branch, defaultBranch) fact, same shape as `recordFirstSightDeclined`'s own dedupe. The BOOT
path is unchanged in behavior (still declines, never seeds) — only `recordFirstSightDeclined`'s reason
text now names the real `git remote set-head origin -a` lever instead of the vague "(or the default is
reconfigured)".

Also fixed: `resolveMainlineBranch`'s single `null` return (used to mean BOTH "no resolvable default" AND
"a transient read failure" — see the `f96b9d7c` card this collapsing already partly addressed for OTHER
callers) is now split into a tri-state `resolveMainlineBranchState` (`"resolved"` / `"no-default"` /
`"failed"`, classified by git's own English not-a-symbolic-ref message under a locale-pinned probe, never
by exit code). `resolveMainlineBranch` itself stays byte-identical in contract — both non-resolved states
still collapse to `null` — so its other two callers (boot-reconcile's branch-ref sweep, and the direct
unit assertions in `worktree-branch-gc.mjs`) are unaffected. `firstSightSeedAllowed` alone consumes the
tri-state directly, mapping `"failed"` to a THIRD outcome, `"defer"` — distinct from both `"allow"` and
`"decline"` — on every one of its three call sites (`checkMainlineMove`'s boot-absent branch, both
`advanceMainlineWatermark{,ForBatch}`).

## Residual (named, not fixed by this card)

**Round 2 restates this precisely, superseding round 1's version:** with W absent, a SOLO (or batch)
landing has NO branch pin at all, regardless of the default — the pin only exists once W holds a value;
the default affects only whether THIS first-sight SEED is silent (`"allow"`/no resolvable default) or
accompanied by an addressed notice (`"decline"`, a resolvable default that disagrees). Either way, the
seed itself always happens now (round 2's fix) — so a first-ever landing that lands on a stray branch
mid-divert, whatever the default situation, seeds that stray branch and becomes the new trusted baseline;
the addressed notice (when a resolvable default disagreed) is the signal that something may be wrong, not
a refusal. See `4fa36502`'s own "What it cannot detect" for the adjacent, already-accepted boundary this
sits next to. A TRANSIENT resolver failure (`"defer"`) is the one case that still leaves W unseeded — by
design, since it is retried at the next first sight rather than treated as a settled fact either way.
