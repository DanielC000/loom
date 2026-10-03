# 77b8319b — fail closed on a present-but-unreadable mainline watermark, on every path that reads one

## Narrative

Found by `ba663984`'s worker (session `3168d07d`, 2026-10-03), refuting a lead claim that the solo path
already mirrored the batch pin's fail-closed behavior. `parseMainlineWatermark` (`git/mainline-watch.ts`)
returns `null` uniformly for a MISSING row, a JSON-parse failure, and a wrong-shaped value — so every
caller that wrote `parseMainlineWatermark(raw)?.branch` and fell back to a live read on `undefined` could
not tell "no watermark yet" (safe to initialise) from "a corrupt/tampered record" (must refuse) apart.
`ba663984` built the absent-vs-unreadable distinction fresh, inline, for the batch fast-forward pin only.
This card generalizes it into one shared helper and applies it to every other site that read a watermark
the same unsafe way.

**Scope widened mid-card** (gen 390, from Code Review `1f8652d6` of `ba663984`, confirmed at source):
`checkMainlineMove`'s own `if (!w) { store(); return head.tip; }` does not merely treat a corrupt row as
absent — it OVERWRITES (heals) it via its compare-and-set `store()`, on every landing AND at boot
(`checkMainlineMovesOnBoot`). This can silently repair a corrupt row onto whatever branch happens to be
checked out, bypassing the fail-closed refusal on a LATER call that would otherwise still see — and refuse
on — the same corrupt record. **Scope widened again** (manager review before this card's production edits):
`confirmWorkerMergeTracked`'s own catch path (card `479f449f`) also read the bare `parseMainlineWatermark`
form to pick a scan ref, and that path FINALIZES on a hit (worktree removed, branch deleted, task marked
merged) — a corrupt row there must not fall back to scanning bare `HEAD` either.

## Design

- **One shared, pure helper** (`git/mainline-watch.ts`):
  ```ts
  export type MainlineWatermarkReadState =
    | { state: "absent" }
    | { state: "ok"; watermark: MainlineWatermark }
    | { state: "unreadable" };

  export function readMainlineWatermarkStrict(raw: string | undefined): MainlineWatermarkReadState {
    if (raw === undefined) return { state: "absent" };
    const w = parseMainlineWatermark(raw);
    return w ? { state: "ok", watermark: w } : { state: "unreadable" };
  }
  ```
  Deliberately pure — it classifies an already-fetched raw value, never a `getMeta` callback. A caller
  whose own read can itself throw (a `getMeta` call made outside a blanket fail-open wrapper) wraps that
  read in its own try/catch and folds a throw into `{state:"unreadable"}` itself before calling this, the
  same shape `ba663984`'s batch code already used. `checkMainlineMove`'s own `getMeta` call stays
  unwrapped — its single outer try/catch already fail-opens a throw correctly, unchanged by this card.

- **Solo pin read** (`confirmWorkerMerge`, `sessions/service.ts`, replacing the old bare
  `parseMainlineWatermark(this.db.getMeta(...))?.branch` one-liner): on `"unreadable"` (whether from a
  `getMeta` throw or an unparseable value), REFUSES OUTRIGHT — `{merged:false, reason, notified:false,
  opId:thisOpId, branchDiverted:true, watermarkUnreadable:true}` — before `finishSoloAlreadyLanded`, the
  owed-range resolution, or the gate ever run. Mirrors `ba663984`'s batch refusal: reused `branchDiverted`
  typing (no new result field beyond `watermarkUnreadable`, mirrored onto `ConfirmMergeResult` from the
  pre-existing `MergeBatchResult.watermarkUnreadable`), identical reason wording (names whether it was a
  DB-read throw or a parse failure, the live observed branch, and the
  `POST /api/projects/:id/mainline-watermark/reset` remedy). No manual event/notify call is needed:
  `branchDiverted` is already in `NEVER_CACHED_OUTCOMES` (so a retry after a reset always re-checks live),
  and `notified:false` lets `confirmWorkerMergeTracked`'s existing generic `[loom:merge-failed]` echo carry
  the `reason` to the manager automatically — same shape the pre-existing `isLoomHomeOrAncestor` early
  refusals a few lines above already use. `gate_status(opId)` resolves it via the existing, generic
  `deriveMergeGateVerdict` (`kind:"fail"`) — unlike batch, solo's `onSettle` already handles any early
  `merged:false` return generically, so no bespoke "never a bare row" verdict synthesis was needed here.

- **Batch pin read** (`mergeBatchTracked`, `sessions/service.ts`): behavior UNCHANGED (already fail-closed
  since `ba663984`) — only the *classification* now routes through the shared helper instead of a second
  inline `parseMainlineWatermark` check, so "absent" vs "present-but-unparseable" is classified identically
  on every path. Reason wording, the `batch_merge_branch_diverted` event, and the dedicated settle-nudge
  branch are untouched.

- **`checkMainlineMove`**: on `"absent"`, unchanged (`store(); return head.tip`). On `"unreadable"`,
  **skips** (fail-open, consistent with this function's whole design as a non-blocking tripwire, `4fa36502`:
  "never a refusal") — does NOT call `store()`, returns `null`, and logs a `console.warn`. It deliberately
  does not refuse or file a `mainline_moved_outside_loom` alert for this case: the blocking signal is the
  pin-read refusals above, which run first on every real landing attempt; this fix exists solely to stop
  `checkMainlineMove` from silently healing a corrupt row onto whatever branch happens to be checked out —
  the exact mechanism that let a corrupted watermark "repair" itself before a *later* pin-read could ever
  see it. Since this one function is shared by both the landing call and `checkMainlineMovesOnBoot` (which
  has no pin-read equivalent at all), fixing it here closes the boot-time gap too.

- **`confirmWorkerMergeTracked`'s own catch path** (`sessions/service.ts`, card `479f449f`): its own
  independent watermark read (used to pick which ref `findLandedSquashCommit` scans, after a throw inside
  `confirmWorkerMerge`) now goes through the same try/catch-wrapped strict read. On `"unreadable"`, the
  already-landed finalize is SKIPPED OUTRIGHT (never falls back to scanning bare `"HEAD"`, which could
  wrongly treat a stray/unrelated trailer commit sitting on HEAD as "already landed" and finalize against
  an unverifiable record) — the original error propagates instead, so the generic
  `[loom:merge-failed]`/`[loom:merge-unknown]` echo still reports it. This site is reachable with the
  pin-read's own early refusal in place only via a TOCTOU window — the row genuinely becoming unreadable
  *between* the pin-read (which saw it good, at confirm start) and this later, independent read (e.g. an
  external hand-edit mid-confirm) — see the test file's own (K) scenario for how this is simulated.

- **`advanceMainlineWatermark`/`advanceMainlineWatermarkForBatch`** (`sessions/service.ts`): on
  `"unreadable"`, return without `setMeta` — the row is left exactly as it was, visible to the next
  pin-read refusal, instead of being silently overwritten with a fresh `{branch, sha}` derived from
  whatever is currently checked out. The pre-existing branch-mismatch guard (2a6a292a round 2) is
  unaffected: it still only fires on `"ok"` with a disagreeing branch.

## `advanceMainlineWatermark{,ForBatch}` — the TOCTOU residual, now closed

Both helpers (`sessions/service.ts`) used to guard with `if (w && w.branch !== head.branch) return;` where
`w = parseMainlineWatermark(this.db.getMeta(key))` — that guard exists for an entirely different purpose
(2a6a292a round 2: never change W's branch away from an existing, *validly parsed* baseline) and did
**not** independently distinguish absent from corrupt: a corrupt row parsed to `w === null`, identical to
an absent one, so the guard did not fire and `setMeta` would overwrite it, exactly like the bug this card
closes elsewhere. In isolation these two functions were **not** immune — reachable only via a narrow TOCTOU
window (the row becoming corrupt between `checkMainlineMove`'s own read, moments earlier in the same
request, and each helper's own independent re-read), but a real gap, not merely a theoretical one.

**Closed** (same card, second pass, manager direction reversed from the original "leave them" after the gap
was reported honestly rather than asserted safe): both helpers now read through
`readMainlineWatermarkStrict` and return without `setMeta` on `"unreadable"`, exactly like every other site
above. All four watermark-write paths (solo pin, batch pin, `checkMainlineMove`, both advance helpers) now
read the one shared strict classifier.

## Do not

- Do not read a watermark row's raw value straight into `parseMainlineWatermark(raw)?.branch` (or any
  equivalent single expression) on any NEW call site — that collapses "absent" and "present-but-corrupt"
  into the same `undefined`/`null` and silently falls back to a live read (or a bare `"HEAD"` scan, or a
  `store()` heal) for both. Use `readMainlineWatermarkStrict` instead.
- Do not treat a `getMeta` throw as equivalent to "no watermark" on the solo pin, the batch pin, or the
  `confirmWorkerMergeTracked` catch path — wrap the read and classify a throw as `"unreadable"`, exactly
  like a present-but-unparseable value.
- Do not let `checkMainlineMove` call `store()` on an `"unreadable"` read — that is the exact silent-heal
  mechanism this card closes. It must skip (return `null`), never refuse, never alert.
- Do not let the `confirmWorkerMergeTracked` catch path fall back to scanning bare `"HEAD"` when its own
  watermark read is unreadable — skip the already-landed finalize outright and let the original error
  propagate.
- Do not let `advanceMainlineWatermark`/`advanceMainlineWatermarkForBatch` overwrite an `"unreadable"` row
  either — both now return before `setMeta` on that state, closing the TOCTOU window described above.
- Do not invent a new `ConfirmMergeResult` field for the solo pin-read refusal — reuse `branchDiverted:true`
  (same no-fallback/no-cache/classify semantics an ordinary divert already gets) with `watermarkUnreadable:
  true` alongside it, mirroring `MergeBatchResult`'s identical fields byte-for-byte.

## Tests

`packages/daemon/test/solo-merge-watermark-branch-pin.mjs` — new scenarios (I) (unparseable row, canonical
genuinely on mainline, refuses outright), (J) (a `getMeta` throw, same refusal shape), (K)
(manager-requested: `confirmWorkerMergeTracked`'s catch path must not fall back to bare `HEAD` either,
simulated via the watermark becoming corrupt between the pin-read and the catch path's own later read, with
a trailer commit sitting on the CURRENT mainline HEAD — the exact shape the old fallback would have wrongly
finalized). All three verified RED (reverting just the two production files to `HEAD`, rebuilding, re-running)
before being fixed.

`packages/daemon/test/mainline-watch.mjs` — new scenarios (S10) (a present-but-unreadable row is never
healed by `checkMainlineMove`, proven by asserting the raw stored value is byte-identical after the call,
not just that the return value is `null`) and (S7e) (`advanceMainlineWatermark` refuses to overwrite a
present-but-unreadable row even with a fully valid `checkedTip`, mirroring (S7d)'s own direct-call shape for
the branch-mismatch guard). Both verified RED the same way.

`packages/daemon/test/mainline-watch-batch.mjs` — new scenario (B5), the batch twin of (S7e): a
present-but-unreadable row is left byte-identical by `advanceMainlineWatermarkForBatch` even with a fully
valid `(checkedTip, isAncestor)` pair. Verified RED the same way (reverting just the `advanceMainlineWatermark{,
ForBatch}` hunk in `sessions/service.ts` to `HEAD`, rebuilding, re-running).

Full hermetic sweep (15 files referencing `parseMainlineWatermark`/`mainlineWatermarkKey`, none
`NOT_HERMETIC`): all green, 0 failures across every file. `pnpm --filter @loom/daemon guards`: 25/25.
