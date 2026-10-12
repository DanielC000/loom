# 500e307a — a runtime-created merge-quarantine entry stamps provenanceTracked on its own in-memory object, at creation

From re-CR `887b8c5f` on `db0a9db0` (follow-up, out of that card's own scope): `db0a9db0`'s precision
guard (a legacy union file is marked `provenanceUnknown` only when it LACKS `provenanceTracked`) was
stamped ONLY by `writeMergeQuarantineLatch`'s own write (unconditional). A brand-new runtime
entry's own in-memory object never carried the field — only its serialized bytes did. Precision therefore
depended on an unenforced invariant: no runtime path ever persists a fresh `resolvedKey`-bearing entry
through a non-stamping writer (`writeSafetyTmpResidueAtHash`, `writePendingDivertFile`) before that entry
is ever written via `writeMergeQuarantineLatch`. True today by code reading, but not enforced.

## The fix

Stamp `provenanceTracked: true` on the in-memory entry at the two TRUE runtime origin points — the only
two places a `resolvedKey`-bearing `MergeQuarantineEntry` object is minted fresh at runtime:

- `enterMergeQuarantine`'s own brand-new/verified branch (the `{ repoPath, branch, reason, opId,
  enteredAt, tokens: [token], resolvedKey: key, armedKeys: [key] }` literal).
- `consumeMatchedPendingsIntoArmedEntry`'s own `armed` result — shared by `enterMergeQuarantine`'s own
  pending-merge/sibling-absorb branches AND `activeMergeQuarantineFor`'s lazy-graduation tail (both the
  `extra`-present and `extra`-absent call shapes).

Every writer — stamping (`writeMergeQuarantineLatch`) or not (`writeSafetyTmpResidueAtHash`,
`writePendingDivertFile`) — then carries the field forward naturally via the existing spread/union
machinery (`unionQuarantineEntries` already ORs it; every plain spread site already carries it; see
`db0a9db0`'s own record for that carry-forward's own history).

## Do not

- Do not stamp `provenanceTracked: true` on `enterMergeQuarantine`'s own existing/sibling-absorb branch
  (the `{ ...existing, tokens: [...existing.tokens, token], contributorRepoPaths }` literal) — `existing`
  can be a boot-marked LEGACY (`provenanceUnknown`) entry, and this branch is about to be durably
  rewritten anyway. Manager correction (2026-10-12): even though `detectUnknownProvenance`'s own check
  order (`provenanceUnknown` checked BEFORE `provenanceTracked`) means forcing the field here would not
  actually launder anything — see "The precedence finding" below, proven, not just argued — leave the
  spread to inherit here rather than force it. This branch is never the place a fresh, nothing-to-launder
  entry originates (it always absorbs INTO something that already exists), so there is no upside to
  forcing it, only a smaller blast radius for a future reader who changes this branch's own shape without
  re-deriving the precedence argument first.
- Do not assume `writeSafetyTmpResidueAtHash`/`writeSafetyTmpResidue` need a runtime-driven test here —
  grepped: ZERO runtime callers today (both call sites live inside `reenterMergeQuarantinesAtBootImpl`,
  the functions are unexported). Its own `provenanceTracked` carry-forward is already pinned, boot-seam
  only, by `merge-quarantine-unknown-provenance.mjs`'s scenario (h) pins (7)/(8) — do not duplicate that
  coverage here.
- Do not assume `protectDegradedOccupantBeforeDelete`'s own protect-copy needed a fix either — it reads
  `provenanceTracked` from the FINAL file's own on-disk bytes (never from an in-memory entry this card
  touches), and those bytes are always already correctly stamped by `writeMergeQuarantineLatch`'s own
  unconditional stamp. Already pinned by the same sibling file's scenario (h) pins (3)/(10).

## The precedence finding (manager-mandated verification, not merely argued)

`writeMergeQuarantineLatch`'s own unconditional stamp means a runtime write of an ALREADY
`provenanceUnknown`-marked legacy entry (e.g. via `enterMergeQuarantine`'s existing/sibling-absorb branch,
left unchanged above) produces bytes carrying BOTH `provenanceUnknown: true` AND `provenanceTracked:
true` simultaneously — measured directly, not assumed (see Verification below). This does NOT reopen
`db0a9db0`'s own fail-closed guarantee, because `detectUnknownProvenance`'s own check order is
`if (entry.provenanceUnknown) return true;` BEFORE `if (entry.provenanceTracked) return false;` — at the
next boot's parse, an entry whose `provenanceUnknown` is already `true` is re-marked `true` regardless of
what `provenanceTracked` says. Every pending entry a union can ever draw into
`consumeMatchedPendingsIntoArmedEntry` has ALREADY had this field's own fate finally resolved (by boot
parse for a boot-diverted entry, or trivially — never legacy — for a fresh runtime-created one) by the
time it is matched there, so the new `provenanceTracked: true` stamp at this card's own two origin points
can never suppress a detection that hasn't happened yet.

## Verification

`packages/daemon/test/merge-quarantine-runtime-provenance-stamp.mjs` — 5 scenarios, each in its own child
process with its own fresh `LOOM_HOME`:

- `fresh-raise-stamps-provenance-tracked-in-memory` — `enterMergeQuarantine`'s brand-new branch; asserts
  the IN-MEMORY entry (no reboot, no re-write) carries `provenanceTracked: true` immediately.
- `pending-merge-graduation-stamps-provenance-tracked` / `lazy-graduation-query-stamps-provenance-tracked`
  — `consumeMatchedPendingsIntoArmedEntry`'s two call shapes (with and without `extra`), same assertion.
- `write-pending-divert-file-passes-through-never-forces` — via the `reenterMergeQuarantinesAtBootTestOnly`
  injection seam (two pending-only, `resolvedKey`-bearing fixtures, one WITH `provenanceTracked: true` and
  one WITHOUT, mirroring the pre-/post-fix shape of this card's own two origin points), a real
  `clearMergeQuarantineByToken` partial clear drives `clearPendingEntryByToken`'s own
  `writePendingDivertFile` write (with no active counterpart, so `writeMergeQuarantineLatch` is never
  reached for this entry) — proves the writer faithfully preserves the field when given it, and does NOT
  force it onto an entry that lacks it (confirming it is genuinely non-stamping, the premise this card's
  own fix depends on).
- `sibling-absorb-into-legacy-unknown-entry-stays-unknown-after-reboot` — the precedence scenario: the
  exact pre-`48aeb324` stray-union fixture from `merge-quarantine-unknown-provenance.mjs`'s own scenario
  (a), then a GENUINE runtime sibling raise (`enterMergeQuarantine`, existing/sibling-absorb branch,
  capturing the real returned token, never a manufactured one) absorbs into it, then a reboot. Confirms
  both fields coexist `true` on disk after the runtime write, AND that `provenanceUnknown` survives the
  reboot, AND that clear-by-id still refuses — all three directly measured, not assumed.

RED/GREEN proven via a captured-diff revert/rebuild/retest/restore cycle against
`packages/daemon/src/git/merge-quarantine.ts` (2026-10-12): reverting this card's own two-site fix turns
the three creation-site scenarios RED (each failing its own single intended assertion, nothing else) while
`write-pending-divert-file-passes-through-never-forces` and the precedence scenario stay GREEN unchanged —
confirming those two test a pre-existing invariant this card's diff never touches, not a false "all green"
masking a vacuous check. Restored and re-verified clean (byte-identical diff). Full `pnpm build` clean.
`merge-quarantine-unknown-provenance.mjs` (db0a9db0's own 9-scenario suite) re-run clean after the fix —
no regression.
