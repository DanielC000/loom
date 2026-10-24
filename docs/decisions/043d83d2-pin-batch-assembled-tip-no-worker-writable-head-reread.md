# 043d83d2 — pin the batch merge's fast-forward target from assembly's own results; never re-read the worker-writable batch HEAD

## The hole

`runBatchedMerge` (`git/batch-merge.ts`) used to read `batchHeadSha` via a plain `git rev-parse HEAD` in
the batch worktree **after** `gate.passed`, then fast-forward canonical main to that sha. The batch
worktree's own HEAD file (`<main>/.git/worktrees/<batch>/HEAD`) lives inside the shared, worker-writable
`.git` — the same trust boundary `docs/decisions/356538ef-canonical-git-isolation.md` already documents
as not hardened against a deliberately adversarial worker. A worker that moved that ref during the
gate/queue window got an ungated descendant commit landed on main, because nothing compared the post-gate
read against anything the gate had actually validated.

`sessions/service.ts`'s batch `runGate` closure separately called `computeEmitCompareGate(worktreePath,
gateBaseMainSha, "HEAD", ...)` to decide whether the batch's one gate run could be reduced — resolving the
literal string `"HEAD"` fresh, at call time, from the same worker-writable ref. This is the exact
anti-pattern decision `56c10535` already closed on the SOLO merge path (`confirmWorkerMergeTracked`
resolves the branch tip via `resolveBranchTip` and passes the ALREADY-RESOLVED sha into
`computeEmitCompareGate`, specifically because "a planted same-named tag/decoy would otherwise pick the
REDUCED-gate classification while the eventual squash lands the real branch's differently-shaped content")
— reintroduced on the batch path by the `fe848bfc`/`d422e279` refactor that made this call resolve
`"HEAD"` from the batch worktree instead of canonical.

## Reproduced

Confirmed end-to-end on throwaway repos via the real `runBatchedMerge` path (worker investigation, not
committed as a scratch script): a `runGate` callback that swaps the batch worktree's private HEAD file to
an attacker's own commit — cut from the same base, never a batch candidate, never gated — right after
`{passed:true}` resolves. `runBatchedMerge` reported `ok:true` with `batchHeadSha` equal to the attacker's
sha, and canonical main's post-call HEAD was the attacker's commit. The gate itself ran against the real
(legit) tip; only the POST-gate read was steerable.

## Why the solo squash path was NOT vulnerable to the landing-target shape

`mergeBranchLocked` (`git/worktrees.ts`) resolves the branch tip via `resolveBranchTip` and explicitly
compares it against `expectedBranchTip` — the tip pinned/reviewed before the gate ran — refusing
(`branchTipMoved`) if they differ. The batch path had no equivalent check at all for its own assembled
tip; this card gives it one, modeled directly on that existing, working pattern.

## The fix

1. **Pin from assembly's own results, never an independent re-read at pin time.** `assembleBatchBranches`
   tracks `assembledTipSha` across its own landing loop — starts at `initialHead` (seeded from the
   caller's trusted `baseMainSha` when supplied, see step 7 below), advances to a real (non-noop)
   candidate's own `sha` as it lands, stays unchanged across a `noop` (nothing new committed). The loop
   never issues a SEPARATE `rev-parse HEAD` call of its own just to resolve this pin — an UNREADABLE
   initial read refuses outright with "could not read" wording rather than silently proceeding with
   `undefined` (see step 7's own "could not read"/seeding behavior, which supersedes the single-sentence
   version of this claim from this card's first round). The loop's OWN bookkeeping is a different matter
   — see the OPEN RESIDUAL immediately below.

   **OPEN RESIDUAL (third Code Review; not closed by this card or either prior round — card `95940402`):**
   `landBranchCommitsIndividually`'s own `landedSha`/`currentHead` bookkeeping (what `assembledTipSha` is
   ultimately built from, per-candidate) IS itself captured via a LATE `git rev-parse HEAD` immediately
   after each candidate's own `commit`/`commit --amend` (`batch-merge.ts` ~:661 and ~:743) — two separate
   spawned processes, however immediately sequential. A racer who swaps the batch worktree's ref to a
   forged same-tree commit X (same tree, different parent/author/trailers) in that narrow window gets X
   read back as `newHead`/`landedSha` — X becomes `assembledTipSha`, the pin every downstream check (the
   pre-gate stamp, the post-gate stamp, the fast-forward target, the ledger/trust stamp) treats as
   legitimate, because none of those checks re-verify the COMMIT's own identity, only that the WORKTREE
   REF didn't move again afterward. Concretely: X also carries whatever `Loom-Worker-Branch:` trailer (and
   PathSet/Base stamp) the forger planted, so downstream code that trusts that trailer — a hold-release
   check, or `findLandedSquashCommit`'s own ALREADY_MERGED detection on a later re-confirm — would read X
   as a genuine, already-landed commit for whichever branch the forged trailer names, not merely a stray
   tip the ledger/trust stamp happens to point at. This is the batch twin of the solo path's own
   `2a6a292a` round-21 `verifyLandedAsOwnCommit` fix — the batch path has no equivalent. An earlier draft
   of this record claimed the cross-checks below make this path "fail closed on a tamper regardless of
   where in the pipeline it lands"; that claim is FALSE for this specific shape and has been removed.

2. **Cross-check the pin immediately, before the gate even runs.** `runBatchedMerge` calls
   `computeWorktreeGateStamp` right after assembly and refuses (new `batchHeadMoved` outcome) if its
   `head` doesn't exactly equal `assembledTipSha` — catches a tamper in the residual window above, and
   means the gate's own reduction check gets an already-verified value.

3. **Thread the pin into `computeEmitCompareGate`, never `"HEAD"`.** `runGate`'s callback signature gained
   a fifth argument, `assembledTipSha: string` (appended, not inserted, so an existing test closure
   declaring fewer params is unaffected). `sessions/service.ts`'s batch `runGate` closure now passes this
   sha to `computeEmitCompareGate` instead of the literal string `"HEAD"` — mirrors `56c10535` exactly.

4. **Re-stamp after the gate, compare against the SAME pin.** A second `computeWorktreeGateStamp` read,
   taken right after `gate.passed`, is compared (via the existing `gateStampsDiffer` helper, reused rather
   than reinvented) against a stamp pinned to `{head: assembledTipSha, dirty/dirtyHash from the pre-gate
   stamp}`. This catches BOTH a HEAD swap during the gate AND an uncommitted edit to a tracked file with
   HEAD left untouched (the card `975c774b` dirty-worktree shape) — a mismatch refuses with the same
   `batchHeadMoved` outcome, BEFORE `onBeforeFastForward`/the fast-forward are ever reached.

5. **Fast-forward to the pin, explicitly.** `fastForwardCanonicalMain` is now called with `assembledTipSha`
   directly — never a value re-read from the worktree at that point — and the existing post-ff
   `verifyLanded` re-read (gated on `expectedBaseBranch`) is unchanged and still runs on top of this.

## Round 2/3 hardening (second and third Code Review)

6. **Cut the batch worktree FROM `baseMainSha` explicitly (S1).** `sessions/service.ts` passes
   `forkFrom: baseMainSha` to `createWorktree` — never the repo's current HEAD at cut time. Without this,
   an ORDINARY commit landing on canonical between `baseMainSha` being resolved and the worktree actually
   being cut (a race, not tampering) made the cut-point check below misreport it as `batchHeadMoved`.

7. **Cross-check the cut point BEFORE assembly even starts, and chain it through every candidate (S1/S2).**
   `assembleBatchBranches` now takes an optional `baseMainSha`. When supplied (always, on the production
   `runBatchedMerge` path) and non-empty (`hasBase`): the very first `rev-parse HEAD` read is compared
   against it — an UNREADABLE read refuses with "could not read" wording (distinct from "tampered", a
   stronger claim this case does not support); a MISMATCH refuses with the usual tampered wording.
   `assembledTipSha`/the sort's own `initialHead` then seed from `baseMainSha` itself, never the fresh
   read alone, so a read failure no longer silently skips the chain check below. Each SUBSEQUENT
   candidate's own `landBranchCommitsIndividually` call receives the loop's current `assembledTipSha` as
   `expectedHeadBefore` and re-reads `batchHeadBefore` fresh at its own top, refusing (`headMoved`) if it
   no longer matches — this is what catches a `reset --hard`/ref move BETWEEN two candidates, a shape the
   pre-/post-gate stamp checks (steps 2/4 above) cannot see since neither runs mid-assembly.

8. **Refuse a dirty worktree before the gate too (S2).** The pre-gate stamp check (step 2) now ALSO
   refuses when `preGateStamp.dirty` — an uncommitted edit with HEAD left untouched is the same
   worker-writable-ref hazard, mirroring the solo path's own `captureGatedTip` pre-gate dirty refusal.

9. **Order the no-gate-ran verdict synthesis correctly (B1).** `sessions/service.ts`'s `onSettle` used to
   check `batchAllDropped` (any no-gate-ran result with `landed.length === 0`) BEFORE `batchHeadMoved` —
   every one of steps 7/8's own refusals also has `landed.length === 0`, so `batchAllDropped` won first
   and settled `gate_status` with `skipReason:"all-candidates-dropped"`, sending a manager hunting for
   per-candidate fallback ops that were never started. `batchHeadMoved` is now checked first, mirroring
   `0d372516`'s own `rollback-unverified`-before-`batchAllDropped` precedent exactly.

10. **A mid-assembly `headMoved` candidate is never reported as a per-candidate drop.** `assembleBatchBranches`
    checks `r.headMoved` BEFORE pushing to its own `dropped` array — a worker-writable-ref fact about the
    WORKTREE is not a fact about that candidate's own content, and reporting it as "dropped" would make
    `sessions/service.ts` file a `batch_merge_dropped` event (and log line) for a candidate that was never
    handed to a solo `worker_merge_confirm`, same reasoning as the no-fallback rule below.

`batchHeadMoved` is wired exactly like `branchDiverted`/`quarantined`: no per-candidate fallback (a retry
would just re-attempt candidates that were never the problem), a durable `batch_merge_head_moved` event,
classified `"batch-head-moved"` in `NEVER_CACHED_OUTCOMES` (a re-fire must genuinely re-assemble, never
replay a stale refusal), added to `DURABLE_AUDIT_EVENT_KINDS` (`docs/decisions/9f7f2b50-*.md`'s
classification list updated alongside), and a dedicated `[loom:merge-batch-head-moved]` nudge naming the
worker-writable ref explicitly rather than generic "landed nothing" wording.

## Named residual not closed by this card

Card `975c774b`'s full solo-path hardening also includes a reflog-based ABA round-trip detector
(`docs/decisions/d099087f-aba-tip-round-trip-inside-a-gate-is-detected-by-reflog-delta.md`) for a tip that
moves T1→T2→T1 during a gate — a head+dirty-hash stamp compare (what this card ports to the batch path)
structurally cannot see that shape, since the settle head equals the pre-spawn head. Porting the full
reflog-snapshot/sticky-flag machinery to the batch path is a separate, non-trivial piece of work, not
attempted here — flagged as a follow-up rather than silently left unmentioned.

## Cross-references

- `docs/decisions/356538ef-canonical-git-isolation.md` — the accepted threat model (shared `.git` is
  worker-writable); this card closes one specific TOCTOU within that accepted model, not the model itself.
- `docs/decisions/56c10535-*.md` and the solo path's own `expectedBranchTip`/`branchTipMoved` check
  (`git/worktrees.ts`'s `mergeBranchLocked`) — the pattern this card mirrors onto the batch path.
- `docs/decisions/975c774b-merge-gate-verdict-must-describe-a-commit-not-a-dirty-worktree.md` — the
  dirty-worktree stamp mechanism (`computeWorktreeGateStamp`/`gateStampsDiffer`) reused here, and the
  reflog-ABA layer named above as a residual.
- `docs/decisions/9f7f2b50-durable-audit-event-kinds-survive-agent-delete.md` — classification entry for
  the new `batch_merge_head_moved` event kind.
- `docs/decisions/2a6a292a-mainline-watermark-branch-change-only-on-a-trusted-signal.md`'s round-21
  `verifyLandedAsOwnCommit` — the solo path's own fix for the identical "forged same-tree commit read
  back as the landed sha" shape, named as this card's OPEN RESIDUAL (step 1) — the batch path has no
  equivalent yet.
- `docs/decisions/0d372516-rollback-unverified-is-distinct-from-quarantined.md` — the
  `rollback-unverified`-before-`batchAllDropped` ordering precedent `batchHeadMoved` now mirrors in
  `onSettle` (step 9, the B1 fix).

## Do not

- Do not re-read `batchHeadSha`/`assembledTipSha` from the batch worktree's HEAD at fast-forward time —
  fast-forward to the PINNED sha only; a late read is exactly the hole this card closes.
- Do not pass `"HEAD"` (or any other bare ref/branch name resolved at call time) into
  `computeEmitCompareGate` on the batch path — always the already-pinned `assembledTipSha`.
- Do not route a `batchHeadMoved` refusal through the ordinary per-candidate fallback — it is a fact about
  the worker-writable worktree ref, not about the resolved candidates; mirror `quarantined`/
  `branchDiverted`'s no-fallback treatment exactly.
- Do not cache or replay a `batchHeadMoved`/`"batch-head-moved"` outcome — a re-fire must genuinely
  re-assemble and re-check, never serve a stale refusal. The batch worktree is NOT retained for
  inspection on this outcome (removed like any other refusal, unlike a quarantine) — its own reflog is
  gone too; only the durable `batch_merge_head_moved` event survives, which is what a human/manager
  actually has to go on (third Code Review — an earlier draft of this bullet wrongly implied retention).
- Do not attempt to port `d099087f`'s full reflog-ABA detector to the batch path as part of "finishing"
  this card without a fresh, explicit decision to do so — it is a named, deliberate residual, not an
  oversight.
- Do not check `batchAllDropped` before `batchHeadMoved` in `onSettle`'s verdict synthesis (B1, second
  Code Review) — every `batchHeadMoved` refusal (pre-gate, mid-assembly, or the cut-point check) also
  satisfies `batchAllDropped`'s own `landed.length === 0` condition, so checking order alone decides
  which `skipReason` wins; `batchHeadMoved` must win, mirroring `0d372516`'s own
  `rollback-unverified`-before-`batchAllDropped` precedent exactly.
- Do not treat the "OPEN RESIDUAL" named in step 1 above as closed by anything in this card, including
  the round-2/3 hardening in steps 6-10 — none of those checks re-verify a landed commit's own identity
  (parent/tree/trailers), only that the worktree ref didn't move again afterward; see the solo path's
  `2a6a292a` round-21 `verifyLandedAsOwnCommit` for the shape a real fix would need to port.
