# eda70da6 — Gate-base re-verification inside the lock, and the preLanded exemption regression

## Narrative: why the squash must re-verify against a frozen gate-base sha

`mergeBranchLocked`'s squash re-derives its result FRESH against whatever canonical HEAD is at the moment it runs (`git merge --squash <branch>` diffs against `merge-base(HEAD, branch)` and applies to CURRENT HEAD) — it does NOT reuse the worktree's own already-unioned tree. So the squash is only provably the SAME thing the gate validated if canonical main hasn't moved between "the sha the gate's tree was built from" and this lock. `requireCanonicalHead`, when passed, IS that sha — either the tip `mergeMainIntoWorktree` unioned before the gate ran, or the tip a REUSED green self-check was proven to already contain (see [[e50600d2-lastworkergatecheck-stamp-equivalence-and-restart-loss]]). Main is process-wide shared, and another writer can land any time before this lock is granted — including a whole unbounded semaphore QUEUE WAIT, not just the gate's own run time.

Do NOT "fix" this by holding the lock across the gate run (serializes every merge behind each ~8-14min gate) or by re-running the gate once locked (doubles cost, reopens the same window one level down) — this in-lock re-read is the intended shape. Re-read HERE, FIRST after acquiring the lock, BEFORE touching anything, so an invalidated premise is caught with ZERO side effects and the caller gets a distinct `gateBaseInvalidated:true` — a benign race, not a real merge failure. Absent whenever no gate ran at all.

## The already-landed case (card `b0ab78d6`)

When the branch's squash has ALREADY landed on main, `confirmWorkerMerge` SKIPS the union-merge entirely (`preLanded`) — a skip that predates this fix and protects `ALREADY_MERGED` re-confirm classification, not an opt-out of gating, so a REAL gate still runs. This used to leave `requireCanonicalHead` unset for the whole gate duration, making the re-check vacuous — NOT hypothetical: a redirected/still-active worker keeps committing before being told to stand down (its pty isn't stopped until AFTER `confirmWorkerMerge` returns), and the eventual squash then stages that new commit, un-verified against whatever main did meanwhile. `confirmWorkerMerge` now threads `requireCanonicalHead` through this path too. What it does NOT prove here: the gate validated the branch's own tree in isolation, never unioned with main, so a genuinely new commit's *integration* is unverified either way — this closes the "main moved" race, not the narrower "never union-tested" gap, which stays open BY DESIGN (closing it would mean union-merging here, corrupting `ALREADY_MERGED` classification).

## Regression found and closed before merge (same card, second review round)

Enforcing `requireCanonicalHead` UNCONDITIONALLY on the preLanded path over-refuses. The COMMON case there is a pure re-confirm with genuinely NOTHING new to squash — IDEMPOTENT by design, since main moving elsewhere during its gate is routine and harmless. Refusing every time main so much as twitches turned that routine idempotent success into a routine refusal — reproduced: same scenario, `{merged:true, emptyKind:"ALREADY_MERGED"}` before this fix, `{merged:false, gateBaseInvalidated:true}` after, main's movement the only variable.

`gateBaseBranchHead`, when supplied, is the fix: the branch's OWN tip sha, captured by the `preLanded` producer at the same moment as `requireCanonicalHead`. Re-read fresh inside the lock — if the branch's CURRENT tip still matches it, `requireCanonicalHead` enforcement is SKIPPED entirely; only a moved branch falls through. Provable, not assumed: `preLanded` already established (via `branchContentLandedInCommit`) that this branch's content matched what's landed AT the capture moment; a sha is content-addressed, so an UNCHANGED tip proves that match still holds. The eventual squash can then only land as a true no-op or hit a genuine conflict on already-landed paths (handled separately) — never silently land unverified new content. An alternative rejected: deferring the check until the staged set is known — correct in spirit but would move it out of its "first thing after the lock, zero side effects" position.

FAIL-CLOSED: `gateBaseBranchHead` is `undefined` for the union and reuse producers — skipped for them, byte-identical to before. On the preLanded producer, a failed fresh read is treated as "no stability proof", NOT "assume unchanged" — falls through to ordinary enforcement.

A companion fix (card `7efc2bff`) resolves the branch's squash target to a frozen sha rather than re-resolving the branch NAME at squash time, closing a related TOCTOU in the ~175 lines between this check and the actual squash — see [[7efc2bff-squash-target-resolved-to-a-frozen-sha-closing-a-toctou]].

## Do not

- Do not hold the lock across the gate run, or re-run the gate once the lock is held — both were considered and rejected; the in-lock re-read is the intended shape.
- Do not enforce `requireCanonicalHead` unconditionally on the preLanded path — reproduced regression: it turns a routine idempotent success into a routine refusal whenever main moves during an 8-14min gate.
- Do not treat a failed fresh read of the branch's tip as "assume unchanged" — it must fall through to ordinary enforcement, same as a provably-moved branch.

## Consequences

A merge can no longer land content the gate never validated against main's current state, and a routine preLanded re-confirm no longer spuriously refuses because main moved during its own gate.

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, `mergeBranchLocked`'s gate-base re-verification block, as of this worktree's HEAD before this extraction. Wrapped source lines joined into a flowing paragraph, `//` comment markers stripped, no wording changed.
