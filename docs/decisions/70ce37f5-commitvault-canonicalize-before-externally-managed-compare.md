# 70ce37f5 — compare CANONICALIZED paths in `commitVault`'s externally-managed check, never raw strings

Card `70ce37f5`, found by `35dff468`'s worker while building that card's own regression check.
`commitVault` (`vault/versioner.ts`) decided "externally managed" (silently skip the commit, no reason
surfaced) by comparing git's discovered toplevel against the caller's raw `vaultPath` with only a
backslash-to-forward-slash normalization: `root.replace(/\\/g,"/") !== vaultPath.replace(/\\/g,"/")`.

`git rev-parse --show-toplevel` always returns its OWN canonical spelling of the repo root — real
on-disk case, no `\\?\` prefix, resolved through a junction — regardless of how the directory was
addressed to reach it. Any time `vaultPath` (the project's raw, stored, never-revalidated field — see
`vault/writer.ts`'s three writers, the only callers that pass commitVault this raw, unresolved value)
was spelled in a way git's own discovery normalizes away, the raw-string compare mismatched even though
`vaultPath` canonically WAS the confirmed repo root, and the commit was silently dropped.

Verified (real git, real `commitVault`, same physical repo, four trials): an ordinary spelling committed
fine; the `\\?\<drive>:\...` extended-length form (the card's originally-reported shape) did not; the
SAME repo addressed via a different case did not; the SAME repo addressed via a directory junction did
not. A genuine subfolder of a bigger repo still correctly backed off in every case — the raw-string bug
was a false positive on cosmetically-different spellings of the SAME real directory, not a loss of the
subfolder detection itself.

## Decision

Canonicalize BOTH sides with `canonicalizeForContainment` (`projects/vault-path.ts`) — the SAME
canonicalization `validateVaultPath`/`checkVaultRepoTripleContainment` already trust for the one exempt
device form — and compare with `comparisonKey` (`projects/repos.ts`), the same case-folding equality the
containment checks use. This closes the device-form, case, junction, and (by the same mechanism, though
not separately reproduced on the development host) 8.3-short-name cases in one change, because none of
them change the real directory identity `canonicalizeForContainment` resolves to. A genuine subfolder of
a bigger repo still canonicalizes to a DIFFERENT real directory than `root`, so the legitimate
externally-managed backoff is unaffected.

By the time this comparison runs, `commitVault` has already refused every non-exempt unsafe-to-
canonicalize form (`isUnsafeToCanonicalize`, checked earlier in the same function) — so
`canonicalizeForContainment` can still return `ok:false` here only for the separate
`hasWin32UnsafeTrailingSegment` case (a trailing dot/space path segment), or if `root` itself somehow
fails to canonicalize. Both warn-and-skip `{ committed: false }`, each with its own named log line,
exactly like this function's sibling refusals.

## Do not

- Do not compare `root`/`vaultPath` as raw strings anywhere in this check again, even with an added
  prefix-strip or case-fold bolted on ad hoc — canonicalize through `canonicalizeForContainment` (or a
  function that itself does) on BOTH sides, then compare with `comparisonKey`.
- Do not fall back to the raw-string compare when `canonicalizeForContainment` returns `ok:false` for
  either side — warn-and-skip `{ committed: false }` instead, same as this function's other refusals;
  falling back would reopen the exact false-positive/false-negative risk this record exists to close.
- Do not treat an empty `root` (the pre-existing `revparse` failure case, unrelated to this card) as a
  canonicalization failure — that case is handled upstream of this check and is unchanged by this fix.
- Do not assume this closes 8.3 short-name spellings with the SAME empirical confidence as the device-
  form/case/junction cases — that specific variant was not independently reproduced on the development
  host (short-name generation looked disabled on the probe volume), though the mechanism is identical in
  kind.

## Round 2 — identity-unify every check that follows, not just the externally-managed comparison

Code Review of round 1 found the LATER checks `commitVault` runs after the externally-managed
comparison — `checkCodeRepoCollision`, `assertRepoNotQuarantined` (both call sites), `isCommitPathMergeEligible`,
the `withCanonicalIndexLock` key, and `isVaultAutoCommitPaused` — still took the RAW `vaultPath` argument,
not `confirmedRoot`. Each of these re-derives its own canonical identity fresh on every call (via
`canonicalRepoLockKey`/`resolveGitToplevelSync`, which themselves walk/realpath the input), so for a
STABLE spelling this was never actually wrong — confirmed empirically: reverting to round-1-only code and
re-running this card's own new pinning tests (see below) still passes every one of them, exactly matching
what the Code Review itself already found ("junction, case-variant and `\\?\` spellings of a REGISTERED
code repo are still refused, by the later `checkCodeRepoCollision`"). The exposure is narrower and purely
structural: a vaultPath spelled through a re-resolvable alias (a directory junction is the realistic case
on Windows; a symlink or a remounted network share are the general shape) can have that alias repointed
at a benign directory IN THE WINDOW between `confirmedRoot`'s one-time computation and one of these
checks' own fresh re-walk of the RAW argument — the check then evaluates the new (benign) target while the
pinned add/commit, already bound to the frozen `confirmedRoot`, still lands in the original target. Round
2 closes this by passing `confirmedRoot` into all five, plus `enterMergeQuarantine`/
`clearMergeQuarantineByToken` (not named by the review, but part of the SAME quarantine-identity family as
`assertRepoNotQuarantined` — leaving them on raw `vaultPath` while the check moved to `confirmedRoot` would
have reopened an analogous gap between establishing a quarantine and checking for one), `maybeAlertStaleVaultLock`
(diagnostic-only, included for consistency), and the `path.dirname(...)` outside-vault-enclosing-repo probe
(dirname of `confirmedRoot`, matching where `git init` actually runs, not dirname of the raw argument).

None of these six needed to stay on the raw spelling — every one of them is itself an IDENTITY
canonicalizer (`canonicalRepoLockKey`/`resolveGitToplevelSync`) or a plain filesystem join, so handing them
the ALREADY-canonical `confirmedRoot` instead of a value they'd re-canonicalize themselves changes nothing
for a legitimate, stable caller and removes the re-walk that an alias repoint could exploit.
`confirmedRoot` is fully dereferenced (no symlink/junction/device-prefix component remains in the string),
so there is nothing left for a later repoint to change once it has been computed.

**Lock-key agreement, checked:** `withCanonicalIndexLock`/`canonicalRepoLockKey` are called elsewhere by a
real merge's own `GitWriter` write path and by the boot loop — both key off a PROJECT'S OWN stored
`repoPath`, never a vault's raw `vaultPath`, so switching `commitVault`'s own argument from raw `vaultPath`
to `confirmedRoot` cannot make it compute a DIFFERENT key than those other callers would for the SAME
physical repo: for a stable spelling both resolve, via `canonicalRepoLockKey`'s own realpath walk, to the
identical key either way.

**Tests** (`vault-commit-code-repo-guard.mjs`, section (17)): pin that `commitVault` AND `writeVaultFile`
still refuse (`blockedReason`/`committedBlockedReason: "code-repo-collision"`, commit count unchanged) for
a junction to a registered code root, a junction to a subdirectory of one, `C.toUpperCase()`, and `\\?\C`.
Confirmed (by temporarily reverting just the round-2 diff and re-running) that these pass under
round-1-only code too — they are regression/pinning tests for a fact the Code Review had already verified,
not a round-2-specific RED/GREEN demonstration; round 2's own value (closing the alias-repoint window) is
verified by code reasoning above, not by a literal mid-call-repoint race test (deliberately out of scope —
a real race test would need its own injected seam and risks being flaky/unfalsifiable under a fixed-wait
simulation, the exact trap this project's own fixed-wait doctrine warns against).

## Do not (round 2)

- Do not pass raw `vaultPath` to `checkCodeRepoCollision`, `assertRepoNotQuarantined`, `isCommitPathMergeEligible`,
  `withCanonicalIndexLock`, `isVaultAutoCommitPaused`, `enterMergeQuarantine`, or `clearMergeQuarantineByToken`
  from inside `commitVault` again — always `confirmedRoot`, even though each of these re-canonicalizes
  internally; the point is to remove the re-walk of a possibly-repointed alias, not to change the key a
  stable caller computes.
- Do not read "these tests pass under round-1-only code too" as evidence round 2 was unnecessary — it
  confirms the OPPOSITE: the gap round 2 closes is a structural alias-repoint window these non-racing tests
  cannot exercise, not a currently-observable misbehavior for a stable spelling.
- Do not add a literal mid-call junction-repoint race test for this without first deciding how to inject a
  deterministic hook (never a sleep-based race) — see the reasoning above for why one wasn't added here.
