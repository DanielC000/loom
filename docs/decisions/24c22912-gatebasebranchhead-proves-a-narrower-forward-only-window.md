# 24c22912 — `gateBaseBranchHead`'s stability proof is narrower than "matched at capture": three sequential awaits, never one atomic read

## Narrative

A correction to how far `gateBaseBranchHead`'s own stability proof (card `b0ab78d6`, see [[eda70da6-gate-base-re-verification-and-the-toctou-closed-squash-target]]) actually reaches. `preLanded` proves — via `branchContentLandedInCommit` — that the branch's content matched what's landed AS OF `findLandedSquashCommit`'s OWN read, BEFORE `gateBaseBranchHead` is captured, not AT the capture itself: three sequential `await`s run across this window, never one atomic read — `findLandedSquashCommit`'s own read, then `resolveGitRef(repoPath, "HEAD", ...)` for the companion `gateBaseMainHead`, then `resolveGitRef(repoPath, branch, ...)` for `gateBaseBranchHead` itself.

What this capture actually proves is narrower and forward-only: an UNCHANGED branch tip FROM THE CAPTURE ON shows the match still holds, regardless of anything main did meanwhile. A commit landing in the window BETWEEN `findLandedSquashCommit` returning and this capture resolving would be captured here as the new "stable" tip, with `preLanded` never having proved anything about that particular commit's content. This residual gap is closed structurally, not by widening the proof: given the above, the eventual squash can only land as a true no-op (safe) or hit a genuine line-level conflict on the branch's own already-landed paths (handled elsewhere, fails loud, zero side effects) — it can never silently land unverified new content. Only when the branch itself has moved since capture (new commits landed during the gate) does the stability signal no longer apply, and `mergeBranch` falls through to the ordinary `requireCanonicalHead` check — protecting exactly the content this mechanism exists to protect.

## Do not

- Do not describe `gateBaseBranchHead`'s proof as "the branch matched main's landed content at the moment of capture" — it proves the match held as of an EARLIER read (`findLandedSquashCommit`'s own), with two more awaited git calls still to run before capture.
- Do not treat the residual gap (a commit landing between that earlier read and this capture) as unsafe — it is closed structurally: the eventual squash can only no-op or hit a genuine, loud conflict, never silently land unverified content.

## Consequences

A reader of `gateBaseBranchHead`'s own doc gets the precise window the stability proof covers, rather than a claim broad enough to imply an atomic check that was never actually made.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`gateBaseBranchHead`'s declaration doc, the "This is sound, but only as far as it's actually proven" paragraph), as of this tranche's HEAD before this extraction. Wrapped source lines joined into a flowing paragraph, `//` comment markers stripped, no wording changed. Companion record: [[eda70da6-gate-base-re-verification-and-the-toctou-closed-squash-target]] (the broader `gateBaseMainHead`/`gateBaseBranchHead` mechanism, card `b0ab78d6`) — this record narrows one specific claim within that mechanism, cited under its own distinct card id.
