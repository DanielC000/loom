# 59e53710 — move the no-legitimate-use branch-name shape checks into `GitWriter` itself

Follow-up to `4fabafd1`/`2a6a292a` (round 10 of that card's own decision record introduced
`unsafeBranchNameReason`, see `docs/decisions/2a6a292a-mainline-watermark-branch-change-only-on-a-trusted-signal.md`).
A Code Review of commit `4fabafd1` found that function was opt-in PER CALLER rather than enforced at the
shared `GitWriter` chokepoint every write surface actually goes through: only `project_checkout_branch`
(`sessions/service.ts`, the manager's `project_checkout_branch` tool) called it, before ever constructing
a `GitWriter` and handing it a branch name. Three other real callers of `GitWriter.checkout()`/
`createBranch()` never ran it at all and handed a raw, attacker-controlled name straight to git:

- the operator's `git_checkout`/`git_create_branch` (`mcp/operator.ts`, the codex-parity surface),
- the Platform Lead's own `git_checkout`/`git_create_branch` (`mcp/platform.ts`),
- the human REST route (`gateway/server.ts`'s `/api/projects/:id/git/{checkout,branch}`).

So the exact MAJOR #2 shape round 10 closed for the manager surface — `"-"` / `"@{-1}"` (git's own
"previous branch" revision shorthand) / `"-bsneaky"` (parsed as the `-b` option) — stayed open on those
three, even though `GitWriter.checkout()` itself already spawns `git checkout --no-guess <name>` and round
10 verified directly that neither `--no-guess` nor a trailing `--` stops any of these once they reach git.
Round 11 of the `2a6a292a` record named this gap explicitly and tracked it as this card rather than fixing
it inline, since it's a distinct, cross-cutting shared-unit-divergence problem rather than another layer on
`project_checkout_branch`'s own trust gate.

## Fix (round 1)

`unsafeBranchNameShapeReason(name)` (`git/writer.ts`) is a NEW, narrower function carrying only the
checks with literally no legitimate branch-name use ever — a leading `"-"` and `"@{"` (round 1) — and
`GitWriter.checkout()`/`createBranch()` now call it themselves, immediately after their own existing
`branch?.trim()` emptiness check, before `refuseIfOperationalHome()` or any git call. Because every one of
the four write surfaces above constructs a `GitWriter` and calls through to one of these two methods, this
is enforced structurally for all of them — not duplicated per caller, and not possible to forget on a
future fifth caller.

`unsafeBranchNameReason` (the original, wider function) is UNCHANGED in behavior: it now delegates its own
leading-`"-"`/`"@{"` checks to `unsafeBranchNameShapeReason` (one implementation, not two copies that could
drift) and keeps its remaining checks — `".."` and the conservative `SAFE_BRANCH_NAME_RE` charset — exactly
where they were: caller-side-only, run only by `project_checkout_branch`. `project_checkout_branch`
therefore sees byte-identical refusals before and after this card; the widening is additive-only for the
other three surfaces.

## Why only `".."`/the charset stay caller-side (round 2 correction)

Round 1's draft of this section ALSO claimed a `"refs/"` prefix was "not a `GitWriter`-level gap at all"
because "git's own ref validation already rejects it" — a Code Review of commit `c37bd715` measured that
claim FALSE and it is retracted here; see "Round 2" below for the fix. Only `".."` and the charset stay
caller-side, for the reasons that were already true of them:

- **`".."` is not a `GitWriter`-level gap at all.** It is syntactically illegal as a real git branch name —
  measured directly: `GitWriter.createBranch("a..b")` fails with git's own `'a..b' is not a valid branch
  name`, and `GitWriter.checkout("a..b")` fails as an ordinary (harmless) pathspec miss, since no file
  named `"a..b"` exists to be wrongly restored. Moving it into `GitWriter` would add a second
  implementation of a refusal git itself already guarantees, for no additional safety.
- **The conservative charset (`SAFE_BRANCH_NAME_RE`) is deliberately MORE restrictive than "is this
  dangerous to git."** It also rejects plenty of names git would happily accept as an ordinary branch. That
  posture is right for `project_checkout_branch` specifically — the one tool that silently REPOINTS a
  per-branch trust record on success (round 6 of `2a6a292a`) — but would be a gratuitous new refusal for
  the other three surfaces this card widens, none of which carries that same trust-repointing consequence.
  Widening the charset check to all four would change real, currently-accepted behavior on the operator/
  Platform Lead/REST surfaces for no matching security gain.

## Round 2 (Code Review of `c37bd715`) — the doc correction, a pathspec-fallback data-loss path, and a
## weaker-than-claimed test

Three findings, folded into this same card rather than filed separately (the card's title was updated by
the manager to cover the second one):

1. **DOC ERROR (blocking).** This record's "Why only this subset moves" originally claimed git's own
   validation rejects a `"refs/"` prefix the same way it rejects `".."`. Measured FALSE, real git:
   `GitWriter.createBranch("refs/heads/other")` returned `{ok:true}` and created a REAL, nested
   `refs/heads/refs/heads/other` ref; `GitWriter.checkout("refs/heads/<name>")`, where a plain branch
   `<name>` already exists, DETACHES HEAD at that commit instead of switching to the branch (git resolves
   the full ref-path argument as a revision, not as "the same branch"). **Fix: `"refs/"` prefix moved INTO
   `unsafeBranchNameShapeReason`** (alongside leading `"-"`/`"@{"`) — it has no legitimate branch-name use
   either (a real branch name is never itself prefixed with its own storage path), so it belongs in the
   same no-legitimate-use bucket, enforced for every caller the same way.
2. **A pre-existing pathspec-fallback data-loss path (folded in, not new to this card).**
   `GitWriter.checkout()` spawns `git checkout --no-guess <target>` with NO trailing `--`. When `target`
   resolves as neither a valid option/revision-shorthand (round 1's shapes) NOR an existing ref, git's
   `checkout` falls back to treating it as a PATHSPEC — restoring matching working-tree files from HEAD.
   Measured, real git, reachable via operator/Platform Lead/REST `git_checkout` (every tool description
   promises "an EXISTING local branch"):
   - `checkout(".")` with a dirty tracked file returns `{ok:true}` and SILENTLY DISCARDS every unstaged
     edit in the canonical tree (git restores every tracked file from HEAD);
   - `checkout("a.txt")` (a real tracked filename) does the same for just that one file;
   - `checkout("main^{}")` (a valid revision expression) returns `{ok:true}` with HEAD DETACHED.
   **Fix, inside `GitWriter.checkout()` only** (`createBranch` has no pathspec-fallback mode to close):
   (a) verify `target` is an EXISTING local branch, via `branchLocal().all.includes(target)` — **not**
   `raw(["show-ref", "--verify", "--quiet", ...])`: measured directly that simple-git's `.raw()` does NOT
   reject on that command's non-zero/no-stderr exit, so a `show-ref`-based existence check silently never
   refuses anything; `branchLocal()` (already used elsewhere in this same method) reads real branch names
   from a response simple-git parses structurally, not from an exit code; and (b) a trailing `--` on the
   real spawn (`git checkout --no-guess <target> --`) so that if `target` somehow isn't a real ref despite
   the exists-check (a check/use race), git hard-fails `invalid reference` instead of falling back to
   pathspec mode — measured: a dirty tracked file identically named to `target` is left byte-unchanged on
   that failure. Both checks run INSIDE `withCanonicalIndexLock`, after `opts?.precondition`, same as every
   other refusal this method already makes. **ROUND 3 CORRECTION:** this did NOT make the existence check
   "atomic with the real mutation", as originally claimed here — `withCanonicalIndexLock` serializes the
   canonical INDEX among its own callers, it does not serialize ref creation/deletion generally, so an
   external `git branch -D <target>` (or any other ref mutation outside this lock) can still land in the
   window between the existence check and the mutating spawn. That check/use race is exactly WHY the
   trailing `--` exists: it is the backstop for the race this lock does not close, not redundant with it.
   - **This is NOT the same "Do not reintroduce a trailing `--`" rule round 10 of `2a6a292a` already
     established — read both before assuming they conflict.** Round 10 measured that a trailing `--`
     does NOTHING against `"-"`/`"@{-1}"`/`"-bsneaky"` (option/revision-shorthand parsing happens before
     `--` would matter) and is right not to rely on it for THAT hazard. This round's trailing `--` targets
     a DIFFERENT hazard — the pathspec-fallback mode a non-ref, non-option argument triggers — where `--`
     genuinely does change the outcome (measured above). Neither finding contradicts the other; they are
     about different argument shapes.
3. **Test strength (minor).** The round-1 per-surface tests were weaker than their own PASS output implied:
   `"-"`/`"@{-1}"` failed pre-fix only because the test fixture had no reflog "previous branch" to resolve
   to (an accidental RED, not one caused by this fix), and the `"-bsneaky"` checkout case was asserted via
   `rev-parse HEAD` (a sha) — a branch created at the SAME sha (branching off current HEAD, as `-b` always
   does) passes a sha-only comparison even when the SYMBOLIC branch actually changed. **Fix:** every test
   now establishes a REAL previous branch first (`checkout -b second; checkout <base>`) so `"-"`/`"@{-1}"`
   genuinely have something dangerous to resolve to, asserts via `git symbolic-ref HEAD` (never a sha),
   and resets to a known baseline between every case (discard dirty state, return to the base branch,
   delete any stray branch a vulnerable case may have created).

## Do not

- Do not fold `".."`/the conservative charset into `unsafeBranchNameShapeReason`. See "Why only ... stay
  caller-side" above — re-litigating this needs a fresh case, not a drive-by widening. (`"refs/"` is
  EXCLUDED from this bullet as of round 2 — it now lives in the shared function; see round 2 above.)
- Do not re-inline the leading-`"-"`/`"@{"`/`"refs/"`-prefix checks directly inside `unsafeBranchNameReason`
  again — call `unsafeBranchNameShapeReason` from there, so there is exactly one implementation.
- Do not add the shape check only to `GitWriter.checkout()` and skip `createBranch()` (or vice versa) — a
  bypass through whichever method skipped it defeats the whole point of moving this into the shared class.
- Do not read this card as a second, independent validation layer "for defense in depth" on top of
  `project_checkout_branch`'s own `unsafeBranchNameReason` call — for that one caller it is genuinely a
  no-op (the wider check already caught these shapes first); its value is exclusively in reaching the
  other three callers that had no check at all.
- Do not use `raw(["show-ref", ...])` (or any other exit-code-dependent `.raw()` call) as a branch-
  existence check through this codebase's `boundedSimpleGit`/simple-git wrapper — measured directly that
  it does not reject on that command's failure shape. **ROUND 3 CORRECTION:** this bullet originally said
  to use `branchLocal().all` instead — FALSE on a detached canonical HEAD, where simple-git's own parsed
  pseudo-entry for the `"(HEAD detached at X)"` line puts the bare commit-ish into `.all` too, wrongly
  passing it as "an existing local branch." Use `for-each-ref --format=%(refname) refs/heads/` (exact
  `refs/heads/<target>` match) instead — see round 3 above.
- Do not re-introduce a `branchLocal().all`-based existence check in `GitWriter.checkout()` — it is the
  exact detached-HEAD pseudo-entry bug round 3 above fixed. Any new existence check on a local branch name
  belongs on `for-each-ref`'s own structured `refs/heads/` listing, matched by exact refname.
- Do not assert "-"/"@{-1}" are refused WITHOUT first establishing a real reflog "previous branch" in the
  test fixture — without one, they fail on their own (no previous branch exists to resolve to) regardless
  of whether this fix is present, which is a RED that proves nothing.
- Do not assert "HEAD unchanged" via a bare sha/`rev-parse` comparison for a case that could create a NEW
  branch at the SAME commit (e.g. `-bsneaky`'s `-b` always branches off current HEAD) — use
  `git symbolic-ref HEAD` instead, which distinguishes "still on the same branch" from "now on a new one
  pointing at the same commit."

## Round 3 (narrow re-review `3ea0c7f2`) — the detached-HEAD pseudo-entry and a lost test guard

Two more findings from the narrow re-review that pronounced round 2 MERGEABLE, folded into this card
rather than filed separately:

1. **DETACHED-HEAD PSEUDO-ENTRY (bug).** Round 2's existence check read `branchLocal().all.includes(target)`.
   When the canonical repo's HEAD is detached, simple-git parses git's own `"(HEAD detached at X)"` branch-
   list line into a pseudo-entry and puts the bare commit-ish `X` into `.all` — measured directly on a real
   detached HEAD: `branchLocal().all` came back `["c5e1468", "a.txt", "main", "side"]` for a repo detached at
   `c5e1468`. So `GitWriter.checkout("c5e1468")` wrongly passed the "is this an existing local branch" check
   and proceeded to the mutating spawn, even though `c5e1468` is not a branch at all.
   **Fix:** the existence check now reads real branch names from `git for-each-ref --format=%(refname)
   refs/heads/` (through the same bounded/canonical git, inside the same lock) and matches the exact
   `refs/heads/<target>` refname — `refs/heads/` listing never includes a detached-HEAD line, so there is no
   pseudo-entry to collide with. Still never `raw(["show-ref", ...])` for the same reason round 2 already
   established: this codebase's `boundedSimpleGit`/simple-git wrapper does not reject on that command's
   non-zero/no-stderr exit, so parse `for-each-ref`'s own stdout instead (same posture as the existing
   `for-each-ref` reads in `sessions/service.ts`).
2. **LOST TEST GUARD (card `40a264d3`'s own hang-bound coverage).** `git-writer-branchlocal-hang-bound.mjs`
   was written to prove `checkout()`'s POST-checkout `branchLocal()` call (now ~:518, read after the mutating
   spawn) is bounded. Round 2 of this card added an EARLIER `branchLocal()` call — the pre-spawn existence
   check that round 1 above has since replaced with `for-each-ref` — and the test's single fake hung
   `branchLocal()` unconditionally, so the hang always fired at the (then-)earlier existence-check call; the
   post-checkout call the test exists to police was never actually reached, and a loose `git branch.*exceeded`
   regex matched either call's label, so the gap was invisible. Mutation-proven: removing `withTimeout` from
   the post-checkout call in `dist` still passed every assertion. **Fix:** the fake now hangs a specific,
   1-indexed `branchLocal()` call (`hang.branchLocalCall`) instead of every call, with a separate case per
   call site and an exact-label assertion per case (anchored with `^`, so neither case's regex can match the
   other's label). Re-proven: the same mutation (strip `withTimeout` from the post-checkout call in `dist`)
   now goes RED on exactly that case; `dist` was then restored via a full rebuild (the project's own
   `tsconfig.tsbuildinfo` had to be deleted first — `tsc`'s incremental build trusts its input-signature
   cache and does not re-emit a file whose SOURCE didn't change, even when the compiled OUTPUT was hand-
   mutated, so a bare `pnpm build` after the mutation silently left the tampered `dist` file in place).

## Tests

Per-surface integration coverage, each now covering BOTH round 1's option/revision-shorthand shapes
(`"-"`, `"@{-1}"`, `"-bsneaky"`, PLUS round 2's `"refs/heads/<existing-branch>"`) and round 2's pathspec-
fallback shapes (`"."`, a real tracked filename, `"<branch>^{}"`), proven RED on pre-fix `c37bd715`
`GitWriter.checkout`/`createBranch` (reverting just the `writer.ts` change, rebuilding, re-running, then
restored and re-verified GREEN):
`operator-branch-name-shape-refusal.mjs` (operator `git_checkout`/`git_create_branch`),
`platform-branch-name-shape-refusal.mjs` (Platform Lead `git_checkout`/`git_create_branch`),
`gateway-branch-name-shape-refusal.mjs` (REST `/git/checkout`/`/git/branch`). Each establishes a real
reflog "previous branch" first, asserts via `git symbolic-ref HEAD` (never a sha) for the checkout cases
and the exact branch-name SET for the createBranch cases, resets to a known baseline between every case,
and carries a negative control (an ordinary branch name still succeeds) so every refusal is proven to
discriminate, not just fire. Direct unit coverage of `unsafeBranchNameShapeReason`/`GitWriter.checkout`/
`createBranch` themselves lives in `git-writer.mjs`, same shapes. The pre-existing manager-surface
coverage for the round-1 names (`project-checkout-branch.mjs`'s `(NAMES)` scenarios, from round 10 of
`2a6a292a`) is unchanged and stays green — this card does not touch `project_checkout_branch`'s own
behavior.
