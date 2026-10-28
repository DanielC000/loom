# cc788ae4 — let a manager re-stamp a worker's cut base deliberately, after verifying a real rebase

## The gap

`docs/decisions/0eaaa693-fork-point-ancestry-check.md` refuses a landing whose worker branch's recorded
`cutBaseSha` is not an ancestor of the current mainline target (`forkPointDiverged`). Once refused, nothing
clears it for THAT worker: `recycleWorker` carries the same recorded `cutBaseSha` forward, a `>0`-ahead
respawn re-derives the SAME value via `priorCutBaseShaForWorktree`, and a rebase of the worker's own branch
never re-derives it either (deliberately — see `0eaaa693`'s "Do not" list: letting a rebase silently
launder the check would defeat the whole point of recording a FIXED, pre-existing fork point). The only
two remedies that worked before this card were switching the canonical checkout back, or re-dispatching the
work on a fresh worker cut from the current mainline.

This card adds a third, deliberate, audited manager action: `worker_restamp_cut_base` re-stamps a worker's
recorded `cutBaseSha` to the current mainline target tip, but ONLY after verifying the worker's branch was
genuinely rebased/cherry-picked onto that tip — never merged.

## The fix

**`checkCutBaseRestampEligibility`** (`git/worktrees.ts`, exported, pure) runs two checks given a
`branchTip` and a freshly-read `targetTip`:

- **Check A (ancestry):** `targetTip` must be an ancestor of `branchTip` — `git merge-base` OUTPUT compared
  to `targetTip` directly, never `merge-base --is-ancestor`'s exit status (the same `0eaaa693` "Do not":
  simple-git's `raw()` resolves that subcommand's non-zero "not an ancestor" exit as a SUCCESS with empty
  output).
- **Check B (no departed-lineage contamination):** every commit `branchTip` carries beyond `targetTip`
  (`git rev-list branchTip --not targetTip` — a walk that already covers anything reachable only through a
  merge commit's own second parent, so no separate recursive check is needed) must have EXACTLY ONE parent.
  A merge commit anywhere in that set refuses outright — **including a legitimate union-forward merge of
  the current mainline** (e.g. from an earlier `mergeMainIntoWorktree` union step). This is the correct
  fail-closed direction, not an over-refusal to relax later: the ONLY mechanism by which the old, departed
  mainline lineage can ever have entered a worker branch is exactly such a merge commit
  (`mergeMainIntoWorktree` always produces one), so "zero merge commits beyond the target" is both
  necessary and sufficient to structurally prove no foreign lineage survives — inspecting what a merge
  commit brought in, instead of just refusing its presence, would reopen exactly the laundering risk this
  check exists to close (owner ruling, 2026-10-28).

Each commit's parent count is read via `git cat-file -p <sha>` and the header's `parent ` line count —
never `git rev-list --parents`, mirroring `verifyCommitParentAndTree`'s own choice. **Corrected (Code
Review):** this is mostly for consistency with that established convention, not because `rev-list
--parents` would still be graft-vulnerable here — `canonicalGit`'s own env-level `GIT_GRAFT_FILE`
sentinel (`git/bounded.ts`'s `prepareCanonicalEnv`, ~2128-2226) neutralizes `info/grafts` unconditionally
for EVERY subcommand it runs, `rev-list --parents` included, so the round-22/23 graft bypass
(`docs/decisions/95940402-*.md`) does not reach it through a `canonicalGit`-backed instance either.
`cat-file -p` is naturally immune to grafts on its own (a rev-walk-level reinterpretation a raw
single-object read never consults) but is NOT naturally immune to a planted `git replace` object — see
"Graft-based parent hiding" below for the real (replace-ref) reason `canonicalGit` is still required.
Bounded by `CUT_BASE_RESTAMP_MAX_SCAN` (2000, a named constant — real worker branches are small; a branch
this far ahead of the target refuses rather than scans unboundedly). Fail-closed throughout: any
git-read failure/throw is `probeFailed: true`, never a confirmed pass.

**`worker_restamp_cut_base`** (manager-only MCP tool, `mcp/orchestration.ts`) resolves the target session's
project/repo via `resolveRepoByKey(project, session.repoKey)` — the SESSION's own stamped repoKey, never a
fresh task read (the multi-repo invariant: every post-cut op resolves the session's stamped repoKey).
Preconditions, all fail-closed:

1. The session belongs to the caller's own project, carries a branch, and its task is not already proven
   merged.
2. **(Code Review fix round, manager ruling) No NEWER sibling session row exists at the same worktree
   path or branch** — a superseded row in a recycled/respawned lineage. A merge only ever reads the
   NEWEST row's recorded `cutBaseSha` (`priorCutBaseShaForWorktree`, `sessions/service.ts` ~9691), so
   restamping an older row would report `ok:true` and file a real audit event while changing nothing any
   actual landing ever consults — a silent no-op dressed as a success. Refused by name, pointing at the
   newer row's own session id.
3. No live/queued gate op of ANY kind on this project's repo(s) — hygiene, not safety: avoids a confusing
   race against an in-flight `confirmWorkerMerge`'s own pre-lock `session.cutBaseSha` read (owner ruling).
4. The branch's tip is read via `resolveBranchTip` (decision `56c10535` — exact `for-each-ref` match, never
   a DWIM-ambiguous bare `rev-parse refs/heads/<branch>`), and the canonical target tip is read fresh via a
   `canonicalGit`-backed instance (never `boundedGit`/`boundedSimpleGit` — `0eaaa693` round 5's empirical
   proof that a worker-plantable `git replace` object defeats a replace-honoring read).
5. `checkCutBaseRestampEligibility` must pass.
6. On success: `Db.setSessionCutBaseSha` writes `cut_base_sha` and appends the durable
   `worker_cut_base_restamped` audit event (old/new sha, branch, branchExtraCount, the acting manager) in
   one call — mirroring `repointMainlineWatermark`'s shape, never a bare column update.

`dryRun:true` runs checks 1-4 and reports the same shape plus `dryRun:true`, writing nothing and filing no
audit event — lets a manager probe before committing.

A no-op (the session's current `cutBaseSha` already equals the target tip) still re-runs checks 1-4 (cheap)
and reports `{ok:true, noop:true, ...}` with no DB write — mirrors `project_checkout_branch`'s own
same-branch no-op shape.

## Trust analysis

Threat model: anyone/anything with shared-`.git` write access (any worker) can rewrite the branch ref
`refs/heads/loom/<id>` freely — that is ordinary worker development, not an attack surface by itself. The
question is whether a forged or incomplete branch can still get itself restamped.

- **"Contains the target" forgery** (`0eaaa693` round 5's own finding): a worker plants a `git replace`
  object so a replace-honoring `merge-base` wrongly resolves "target is an ancestor" when it isn't.
  Defeated identically to the merge-time check: every read in this tool goes through a `canonicalGit`-backed
  instance, whose config disables `core.useReplaceRefs` — empirically proven in `0eaaa693` round 5 to
  resolve correctly against exactly this forgery.
- **Smuggling the departed lineage as a merge commit**: defeated structurally by Check B — the departed
  lineage can only have entered via a union-merge-shaped 2-parent commit, so banning all merge commits in
  `branchExtra` bans that mechanism outright, regardless of which specific commit it is or what it merged.
- **Graft-based parent hiding**: `cat-file -p` is naturally immune to a worker-planted `info/grafts` entry
  on its own (grafts are a rev-walk-level reinterpretation a raw single-object read never consults) — see
  `docs/decisions/95940402-*.md`'s round-22/23 finding, which is about `rev-list --parents` specifically.
- **Replace-ref parent hiding — the real reason `canonicalGit` is still required for this check, not
  cat-file's own nature (Code Review correction):** `cat-file -p` has NO inherent immunity to a planted
  `git replace` object — a plain, replace-honoring reader is fooled into reporting a genuine 2-parent
  merge commit as single-parent, reproduced directly (scenario 5b: a real merge commit with a
  single-parent `git replace` planted on it; a plain `simpleGit` control resolves `ok:true`, wrongly
  accepting it). Defeated the same way as Check A's own `merge-base` forgery: `canonicalGit`'s
  `core.useReplaceRefs=false` config, applied to every call this tool makes, not a property of `cat-file`
  or any other subcommand.
- **Check A and the merge-time backstop both key on the canonical repo's LIVE `HEAD`, never on Loom's own
  trust record** (unlike the mainline-watermark's `project_checkout_branch` path, which repoints a
  Loom-durable trust record — `2a6a292a` round 9+). This is not a laundering hole today: nothing short of
  Loom's own merge code (or a human) can move canonical `HEAD` to a sha that is NOT a real, present commit
  in this repo, and `mergeBranchLocked`'s own in-lock check (`0eaaa693`) re-reads that SAME live `HEAD`
  fresh, under the canonical lock, at squash time — so a restamp computed against a stale or raced `HEAD`
  reading is caught by that re-read rather than silently trusted. If the owner ever wants this tool (and
  the merge-time backstop) to key on a Loom-durable trust record instead of live `HEAD` — e.g. to also
  catch a HEAD that is live-and-present but not one Loom itself ever landed — that is a genuinely
  different, wider change (mirroring `2a6a292a`'s own watermark-trust design), not something this card's
  own scope covers.
- **Who writes the trust artifact**: unlike the mainline-watermark trust record (keyed on Loom's own
  durable store, never raw git content — `2a6a292a` round 9+), this tool's "trust artifact" is the session
  row's `cutBaseSha` itself, and the write only ever happens after an independent, freshly-computed
  structural verification against the CURRENT canonical ref state — there is no cached/forgeable
  intermediate signal being trusted blindly.

## Named residual (not closed)

Check B verifies STRUCTURE (no foreign lineage merged in wholesale), never CONTENT. A worker could
hand-author fresh single-parent commits that happen to reproduce the departed lineage's own diffs — this is
indistinguishable, under a parent-count check, from the worker legitimately redoing equivalent work after a
real rebase (which is in fact what a genuine rebase's replayed commits look like by construction).
Mitigation, not closure: (i) this is a manager-invoked, audited action — the manager is expected to have
reviewed the actual rebase before calling it, same trust tier as `project_checkout_branch`; (ii) this tool
only clears the ANCESTRY refusal — the ordinary merge gate and Code Review of the branch's real diff still
run before anything lands; it does not bypass content review.

**Check B is also POINT-IN-TIME, not continuously enforced.** It runs once, at the moment of the restamp
call, against the branch's state THEN. Nothing re-checks Check B at merge time — `checkCutBaseAncestry`
(the merge-time backstop, `0eaaa693`) only re-verifies ancestry (its own Check A equivalent) against the
FRESH canonical target, never re-scans the branch for a merge commit. So a worker that adds a genuine
merge commit to its branch AFTER a successful restamp, but before the eventual `worker_merge_confirm`,
is not caught by anything this card adds — the branch simply lands with that merge commit's content
through the ordinary squash, same as it would for a worker whose `cutBaseSha` was never restamped at all.
This is accepted, not a gap unique to this tool: `checkCutBaseAncestry` has never checked for merge
commits either, before or after this card.

A second, narrower residual: if a manager restamps WHILE a `worker_merge_confirm` call is already in flight
(past its own pre-lock `session.cutBaseSha` read, before the canonical lock), that in-flight attempt uses
the stale, pre-restamp value. Not a safety bug — the attempt is refused/succeeds on the old value and the
manager just retries `worker_merge_confirm` after the restamp lands; no corruption either way, since
`cutBaseSha` only gates an ancestry check, never squash content. The live-gate-op precondition (3 above)
narrows this window but does not eliminate the gap between a courtesy read and the real lock.

## Do not

- Do not restamp a session row without first checking for a newer sibling row at the same worktree
  path/branch — a merge reads only the newest row's `cutBaseSha`, so restamping a superseded row is a
  silent no-op dressed as a success (Code Review fix round, manager ruling).
- Do not re-derive the "contains the target" check via `merge-base --is-ancestor`'s exit status — simple-git
  resolves that subcommand's non-zero exit as success with empty output (same `0eaaa693` rule).
- Do not count a commit's parents via `git rev-list --parents` anywhere in
  `checkCutBaseRestampEligibility` — use `git cat-file -p <sha>` and parse the header block directly,
  mirroring `verifyCommitParentAndTree`'s own established convention. (Not because `rev-list --parents`
  would still be graft-vulnerable through `canonicalGit` — it would not, see "The fix" above — but
  `cat-file -p` is the one primitive this codebase has already proven immune to grafts independent of
  `canonicalGit`, and there's no reason to introduce a second, differently-reasoned primitive.)
- Do not read "`cat-file -p` is immune to grafts/replace-refs" as one claim — they are TWO different
  mechanisms with different reasons to trust this call: grafts, `cat-file -p` resists on its own; replace
  refs, only `canonicalGit`'s `core.useReplaceRefs=false` resists (see "Replace-ref parent hiding" above).
  Conflating them is exactly the wording this card's own Code Review corrected.
- Do not relax Check B to "inspect what a merge commit brought in and allow it if it looks benign" — refuse
  ANY merge commit in `branchExtra`, full stop (owner ruling, 2026-10-28); this is the simplest check that
  is both necessary and sufficient, and inspecting content reopens the exact laundering risk it closes.
- Do not read a worker branch's tip via a bare `rev-parse refs/heads/<branch>` — use `resolveBranchTip`
  (decision `56c10535`), which resolves via exact `for-each-ref` matching and is immune to a same-named
  tag/decoy DWIM resolution.
- Do not read the canonical target tip, or any ref in the shared `.git`, via `boundedGit`/
  `boundedSimpleGit` (`SessionService.boundedGit`, which wraps a plain, unhardened `simpleGit` instance) —
  always a `canonicalGit`-backed instance.
- Do not make `CUT_BASE_RESTAMP_MAX_SCAN` configurable — a fixed, named constant (owner ruling).
- Do not register `worker_restamp_cut_base` on any surface but the manager router, and do not call
  `Db.setSessionCutBaseSha` from anywhere but `SessionService.restampWorkerCutBase` — the automatic
  union-merge/gate paths (`mergeBranchLocked`, `landBranchCommitsIndividually`, `mergeMainIntoWorktree`, the
  advisory pre-gate checks) must only ever READ `session.cutBaseSha` as a parameter, never assign it.
- Do not skip appending the `worker_cut_base_restamped` audit event on a successful restamp, and do not
  file it for a `dryRun:true` call — a dry run writes nothing and must leave no audit trail implying it did.
