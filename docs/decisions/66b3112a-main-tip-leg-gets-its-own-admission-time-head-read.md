# 66b3112a — the main-tip leg gets its own admission-time HEAD read too, closing the leg asymmetry 7183540f left

## Narrative

Card 7183540f's admission-time re-derivation (`EMIT-COMPARE RE-DERIVATION AT ADMISSION`) has two legs: whether the BRANCH tip moved since pre-wait classification, and whether MAIN moved. The branch-tip leg always re-read its own fresh value at admission time via `resolveGitRef`. The main-tip leg, before this card, instead piggybacked on `gateBaseMainHead`'s in-place advance — but that advance only ever happens inside the `!preLanded` guard elsewhere in this method (the union-producer's own admission-time re-union, card b798e706), which made the main-tip leg structurally INERT on the preLanded producer: on that path nothing ever re-derived `gateBaseMainHead`, so the "did main move" check for that leg had no fresh value to compare against. Its safety on the preLanded path relied entirely on a THREE-STEP invariant living in `git/worktrees.ts`'s `gateBaseBranchHead`/`branchStableSinceGateBase` handling — not on anything visible from this file, and not something a reader of this method could verify locally.

This card gives the main-tip leg its own dedicated, bounded `resolveGitRef(repoPath, "HEAD", ...)` read (`emitCompareAdmissionMainHead`), taken unconditionally on BOTH producers — never branched on `preLanded` — so there is exactly one code path for "did main move since pre-wait classification," not two paths that differ in where they source their answer. On the `!preLanded` producer this is, in the overwhelming case, the exact same value `gateBaseMainHead` was just advanced to moments earlier by the union re-merge — and strictly MORE correct on the residual race where main moves again in the brief window between that advance and this read. Both legs — branch-tip and main-tip — are now local to this function on both producers, closing the asymmetry the "exactly as" reachability claim (see 7183540f's own record) depended on holding.

The fail-closed discipline card 7183540f established for the branch-tip leg (a failed resolve counts as "moved," and the null check must precede the inequality) is extended verbatim to this new main-tip leg: `!emitCompareAdmissionMainHead || emitCompareAdmissionMainHead !== emitComparePreWaitMainHead`, ORed into the same `moved` boolean. The whole-call re-derivation that follows is based against `emitCompareAdmissionMainHead` — the value just freshly read — not `gateBaseMainHead`, since the freshly re-read value is what main's tip actually IS right now, on both producers, uniformly; using `gateBaseMainHead` here would reintroduce the exact producer asymmetry this card closes.

When the whole-call re-derivation finds the diff no longer eligible (or itself ambiguous), the pre-wait snapshot values it's replacing must also be cleared, not merely the boolean: `emitCompareTestFiles`/`emitCompareAssetPaths`/`emitCompareTsPaths`/`emitCompareScriptFiles`/`emitCompareIdenticalCount` are all reset alongside `emitCompareSkip = false`. Every real consumer already gates on `emitCompareSkip` first, so leaving these at their stale pre-wait values was harmless to any consumer reachable today — but it left a reduction that never actually happened exactly one ungated read away from surfacing. Two lines, no behavior change for any current reader.

## Do not

- Do not re-derive the main-tip leg's admission-time value from `gateBaseMainHead` — its in-place advance only happens inside the `!preLanded` guard, making it structurally inert on the preLanded producer.
- Do not branch the main-tip HEAD read on `preLanded` — read it unconditionally on both producers so there is one code path, not two.
- Do not base the whole-call re-derivation on `gateBaseMainHead` instead of the freshly-read `emitCompareAdmissionMainHead` — that would reintroduce the producer asymmetry this card closes.
- Do not leave the stale pre-wait `emitCompare*` values in place when the boolean flips to ineligible — clear them too, even though no consumer reachable today reads them ungated.

## Consequences

The "did main move" check for the emit-compare re-derivation is now symmetric across both merge producers, with no reliance on an invariant that lives outside this file.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`confirmWorkerMerge`: the "EMIT-COMPARE RE-DERIVATION AT ADMISSION" block's leg-symmetry paragraph, "OWN ADMISSION-TIME HEAD READ FOR THE MAIN LEG", the main-leg extension inside "FAIL CLOSED ON ANY DOUBT", the main-leg basis note inside "RE-RUN THE WHOLE CALL, NOT JUST THE ELIGIBILITY CHECK", and "CLEAR THE STALE PRE-WAIT VALUES TOO"), as of this tranche's HEAD before extraction. Condensed and reworded, not verbatim: wrapped source lines joined, `//` markers stripped, wording condensed. See also [[7183540f-capture-and-rederive-the-branch-tip-for-emit-compare-too]] — the sibling decision whose branch-tip-leg discipline this one extends to the main tip.
