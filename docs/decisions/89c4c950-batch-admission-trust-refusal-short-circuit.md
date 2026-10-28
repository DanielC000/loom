# 89c4c950 — a `merge_batch` short-circuits at GATE ADMISSION on a canonical-git trust refusal, not only at the end

From `57f9cdd9`'s round-2 Code Review: that card made `fastForwardCanonicalMain`'s pre-ff `readHeadShaAndBranch`
call (via its `onRawError` hook) return `canonicalTrustRefusal:true` for a structural canonical-git trust
refusal (a commondir redirect or pin mismatch, thrown BEFORE any git process runs). That flag already
reached `mergeBatchTracked`'s admission-time check (card `627b38c7`'s `fastForwardCanonicalMain(repoPath,
gateBaseMainSha, gateBaseMainSha, ...)` probe), but the admission check only acted on `admissionFf.forfeited`
— a trust refusal there fell through to a non-fatal `console.warn` and the real gate command still ran to
completion (minutes) before the END-of-gate `fastForwardCanonicalMain` call re-detected the SAME refusal and
settled the batch via the existing no-fallback `canonicalTrustRefusal` arm. This card closes that gap: a
trust refusal detected AT ADMISSION now settles immediately, mirroring `627b38c7`'s own forfeit short-circuit.

## The fix

A new typed error, `BatchAdmissionTrustRefusalError` (`sessions/service.ts`, same shape and propagation as
`BatchAdmissionForfeitError`), is thrown from the admission `fn` closure when `admissionFf.canonicalTrustRefusal`
is set. The outer catch records a `pending_gate_ops` verdict of `kind:"skipped"` with its own
`skipReason:"canonical-trust-refusal-at-admission"` (mirroring `"forfeited-at-admission"`'s shape —
`batchBranchCount` is the real assembled `landedCount`, never falsified to 0; `batchLanded:false`) and
returns a `BatchGateResult` carrying `detail.canonicalTrustRefusalAtAdmission:true` (never `forfeitedAtAdmission`,
and never `gateFailed`/`isMergeGateRed` — the gate command genuinely never ran, so this is not a test/build
failure, same false-red hazard `627b38c7`'s own record describes).

`runBatchedMerge` (`git/batch-merge.ts`) checks `gate.detail?.canonicalTrustRefusalAtAdmission === true`
(right after the existing `forfeitedAtAdmission` check) and maps it to the SAME
`RunBatchedMergeResult.canonicalTrustRefusal:true` shape the end-of-gate `fastForwardCanonicalMain` refusal
already produces — so every downstream consumer (the no-fallback `runFallback` posture in
`mergeBatchTracked`'s own `result.canonicalTrustRefusal` branch, the never-cached `classifyOutcome` string
`"canonical-trust-refusal"`, the `[loom:merge-batch-trust-refusal]` nudge) is reused as-is, with NO new
branch needed in `mergeBatchTracked` itself.

## Why NO per-candidate fallback (unlike a forfeit)

A forfeit means "main moved, but we don't know if any candidate's content conflicts with the new tip" — a
per-candidate solo re-gate genuinely answers that. A trust refusal means the canonical checkout itself
cannot be trusted right now (a commondir redirect, a pin mismatch) — a per-candidate fallback would just
re-hit the IDENTICAL refusal at each candidate's own solo union-merge/squash check, burning K gate slots on
a foregone conclusion. Same reasoning `57f9cdd9` already applied to the end-of-gate and admission-time
re-union sites.

## Do not

- Do not widen the admission check to act on a branch-divert or a bare read failure — `627b38c7`'s own scope
  ruling stands unchanged; only `forfeited` and (as of this card) `canonicalTrustRefusal` are short-circuited
  at admission. Everything else still falls through to the real gate, logged non-fatally.
- Do not fabricate a `{passed:false}` return from the admission check for this case instead of throwing —
  same false-red hazard `627b38c7`'s own record describes: a normal return reaches the existing
  `onSettle`/`isMergeGateRed` hook and would be misclassified as a genuine gate red.
- Do not give `BatchAdmissionTrustRefusalError` a `currentMainSha` field — unlike a forfeit, a trust refusal
  fires at the HEAD read itself, before any sha is ever determined; there is nothing to carry.
- Do not add a NEW outcome string or a new `evtBatch` event for this case — reuse the existing
  `canonicalTrustRefusal`/`"canonical-trust-refusal"` classification (card `08c36dae`/`57f9cdd9`); the
  end-of-gate arm it mirrors has no `evtBatch` call of its own either, by design.
- Do not conflate this card's `skipReason:"canonical-trust-refusal-at-admission"` with the forfeit's
  `"forfeited-at-admission"` — they are DISTINCT, so a reader can tell which short-circuit fired from the
  durable row alone, without needing the `canonicalTrustRefusal`/`forfeited` result field.
- Do not forget the EOL repair on a freshly `Write`-created test file: `git rm --cached` + `git checkout HEAD
  --` (commit first if uncommitted) before `working-tree-eol-guard.mjs` runs.

## Verification

New test `packages/daemon/test/batch-merge-admission-trust-refusal.mjs`: (A) a real commondir-trust-pin
mismatch at the admission-time read ⇒ the real gate command is NEVER invoked (0 calls, counted via the
constructor's own `runGate` test seam — not merely stubbed-but-uncounted), no per-candidate fallback starts,
the durable row's verdict is `"skipped"` with the new `skipReason`, and the result carries
`canonicalTrustRefusal:true` (never `forfeited`) with no `batch_merge_forfeited` event filed. (B) regression
control — an ordinary admission-time forfeit (main moved, no trust condition) still behaves exactly as
`627b38c7` left it: the batch's own gate is still never invoked, but BOTH candidates' own solo fallback is
started (`started:true`), the verdict's `skipReason` stays `"forfeited-at-admission"`, and a
`batch_merge_forfeited` event IS filed. RED-proofed: reverted `sessions/service.ts`/`git/batch-merge.ts` to
their pre-fix committed state (`git checkout HEAD --`, then rebuilt) and confirmed scenario (A)'s three
discriminating assertions (gate-call count, verdict kind, skipReason) go RED while scenario (B) stays green
either way — then restored the fix from a captured patch and rebuilt, confirming both scenarios green again.
Also re-ran the two pre-existing, closely-adjacent suites unchanged: `batch-merge-admission-forfeit.mjs` and
`merge-confirm-verdict-cache-union-merge-refusal.mjs` (whose own (B1)/(B2) scenarios exercise the SAME
`canonicalTrustRefusal` flag, now reached via the admission short-circuit instead of the end-of-gate check
for a scenario shaped like (B1) — their assertions are relative/shape-based and pass unchanged either way).
