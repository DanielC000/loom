# d240fceb — a cleared `finishRefused` batch replays its own history instead of re-assembling

From `e8e98d43`'s CR2 (session `69b60050`). Pre-existing, not a regression of `e8e98d43`.

A batch lands; candidate x goes to `finishRefused` (transient `heldRangeUnverifiable`, or a genuine,
later-cleared hold); sibling y finalizes normally. A re-fire with the SAME candidates while the cause
still persists was already a correct, cheap cache hit — `isBranchHeld`'s own pre-assembly check shares
the same git read the fault affects (or still sees the real retain event), so it fails closed into
`retainedOutstanding`, making `batchAlreadyFinished` (and so `identityOptional`) true from the start.

The gap: once the cause genuinely clears — the transient git fault stops firing, with nobody having
called `worker_merge_confirm` on x yet — `isBranchHeld`'s own release-scan has ALWAYS seen x as released
(for the transient cause, the real release marker was on main before the batch even ran the first time;
`finishAlreadyMerged`'s own, separate, LATER `heldAtFinish` check is a different git read with no
corresponding release-arm in `isBranchHeld`'s model). So `candidateFinished(x)` is false (worktree
present, task not terminal) and `retainedOutstanding.has(x)` is false — `batchAlreadyFinished` is false,
and a re-fire runs FRESH.

## Re-measured behavior before this fix (card `1f395ce9` already landed)

The fresh run re-assembles: x's cherry-pick onto a tree built off the now-current main (which already
contains x's content from the first run's own fast-forward) produces an EMPTY commit, so x is dropped
from assembly and routed to the per-candidate solo fallback (`confirmWorkerMergeTracked`). y (branch
already deleted by the first run's finalize) likewise fails branch-tip resolution during assembly and is
also dropped to the fallback.

Measured directly (real `isBranchHeld` path, no stub): neither candidate produces a duplicate
`merge_done` — `1f395ce9`'s ALREADY_MERGED dedup suppresses it for both, and x genuinely gets finalized
cleanly via its own fallback confirm (`gateSkipped:"already-landed"`). The symptom `d240fceb` was
originally carded for (a duplicate `merge_done` for y) is therefore already fixed by `1f395ce9` — but the
re-fire's own synchronous return value is still wrong: `{ok:false, landed:[], reason:"nothing landed
cleanly into the batch — every candidate was dropped"}`, even though by the time this value is returned
BOTH candidates have in fact been correctly finalized via the fallback.

That misleading value then gets CACHED under the plain `"rejected"` classification (none of the
special-case flags apply, and `"rejected"` is not in `NEVER_CACHED_OUTCOMES`) with `identity: undefined`
(y's branch-tip resolution fails at mint too) and `identityOptional: false`. A THIRD re-fire with the
same ids is then a cache hit — by then both candidates satisfy `candidateFinished` (x's worktree is gone,
task terminal, from the second run's own fallback work), so `batchAlreadyFinished`/`identityOptional`
becomes true — and it replays the misleading "nothing landed cleanly" verdict FOREVER (process lifetime,
same batch key) even though both candidates are long done. This is card `3a460d4a`'s own cited T2
scenario, confirmed live by direct repro, not merely theoretical.

## The fix

`mergeBatchTracked`'s `batchAlreadyFinished` (`sessions/service.ts`) ALSO treats a candidate as finished
when this exact `batchKey`'s own last cached verdict (read via the new, identity-ungated
`PendingOpRegistry.peekUntilSupersededVerdictValue`) already named it in `finishRefused`. This closes the
gap by trusting the batch's own history directly, rather than trying to teach `isBranchHeld` a new
release-arm for a cause it never modeled as a hold in the first place.

## CR correction (session `f16ef8c1`) — the first version of this fix hid a late commit

The first version of this fix treated ANY candidate named in the cached verdict's `finishRefused` as
unconditionally finished for `batchAlreadyFinished` purposes — no live check at all. Measured directly
(the CR's own repro): once the fault clears, if x then commits a NEW, genuinely unlanded change (e.g. a
late `late.txt`) before anyone re-fires `merge_batch`, that unconditional version serves the OLD cached
verdict forever — `late.txt` never lands, x's task never leaves `in_progress`, and nothing signals an
error. The PRE-fix behavior (a genuine re-assembly) actually landed it correctly via the per-candidate
solo fallback, because that fallback runs an ordinary `confirmWorkerMergeTracked` against x's CURRENT
branch tip, not the stale one. So the first fix traded one bug (a misleading permanently-cached verdict
for an unchanged batch) for a worse one (silently losing real, unlanded work for a changed one).

**The fix:** a cached `finishRefused` candidate counts as finished ONLY when its branch tip, resolved
LIVE via `resolveBranchTip`, still equals the `sha` recorded in that cached entry, AND it is not also in
`reviewMoved` (the pre-assembly `reviewedTipVerdict` check already flags a moved tip independently — this
widening must never suppress that candidate's own re-review message by claiming it as "finished"
instead). Any resolution failure (a transient git error) ALSO fails toward a fresh run, never toward a
replay — per decision `1555e361`'s own rule, this widening is only safe when divergence is PROVABLY
impossible, never merely unconfirmed.

## Do not

- Do not widen `peekUntilSupersededVerdictValue` into a general-purpose cache read, and never consult
  identity inside it — it answers "what did this batch's own history already establish", never "is it
  safe to serve this as the current call's verdict"; that decision stays at `attach()`'s own
  identity-gated comparison (decision `1555e361`).
- Do not treat a cached `finishRefused` entry as finished WITHOUT the live-tip check above (see "CR
  correction") — an unconditional version silently hides a late commit forever, with no error.
- Do not read this as touching `confirmWorkerMergeTracked`'s own recovery path — it has its own,
  independently-keyed cache and re-evaluates fresh on every call, unaffected by anything here. Recovery
  for a `finishRefused` candidate stays `worker_merge_confirm` directly, never a `merge_batch` re-fire —
  same established semantics as decision `42daa283`/`e8e98d43` (a replay naming a candidate that is still
  retained, or whose retain has since cleared, is not wrong — it is a replay of a true fact about that run).
  This is unaffected by the live-tip check above: even once a candidate's tip genuinely moves (falling
  through to a fresh run instead of a replay), that fresh run's own per-candidate fallback is what lands
  it, not `worker_merge_confirm` called by the manager — the manager still never needs to call it directly
  for THIS shape; direct `worker_merge_confirm` is the remedy for the UNCHANGED-tip replay case instead,
  where a re-fire would otherwise keep replaying the old verdict forever.
- Do not treat this fix as closing card `3a460d4a` — that card hardens the `priorVerdict.identity ===
  opts?.verdictIdentity` comparison itself (two genuinely-undefined identities dedupe-hitting); this fix
  only closes the one path that fell through to it in this specific scenario. Both should land.
- Do not touch the pre-assembly `heldReason` text's own "re-run merge_batch" remedy (service.ts, the
  pre-assembly held-candidate path, distinct from `finishRefused`): a re-fire genuinely re-runs
  `isBranchHeld` LIVE at that point (pre-assembly, before this card's own cache check is even reached),
  so "re-run merge_batch" is already the correct, live-re-checking remedy there — unlike a POST-assembly
  `finishRefused` candidate, whose cached verdict is what this card's own fix is about.
