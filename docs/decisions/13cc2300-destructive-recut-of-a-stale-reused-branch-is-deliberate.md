# 13cc2300 — Re-cutting a stale reused branch onto main is deliberately destructive, and what it discards is reported, not prevented

## Narrative

`recutStaleReusedBranch` exists to fix the stale-base bug (2026-06-04): for a REUSED branch (either reuse path of `createWorktree`), a task whose worktree/branch survives from a prior attempt was re-attached at its OLD base commit, so a "fresh" re-spawn silently inherited a stale tree (wrong toolchain/gate, phantom pre-existing failures, a big merge-conflict reconcile). The fix re-cuts an EMPTY/STALE branch (0 commits ahead of current main) onto main's current SHA before handing the worktree to the worker; a RECOVERY branch (>0 commits ahead of its own old base, carrying real unmerged work) is left exactly as-is — the recovery flow relies on branch reuse, so a branch with unmerged work must never be reset. The "commits ahead" check is delegated to the fail-safe `mayRecutOntoMain`, which treats a malformed/unparseable count (NaN) the same as a positive count (never re-cut) rather than the old `parseInt(...) || 0`, which collapsed NaN to 0 and reset anyway — a single malformed count could otherwise destroy a recovery branch's work.

That re-cut IS destructive, and this is deliberate, not a bug (board card `13cc2300`): for the worktree-dir-present reuse path, a 0-ahead branch's `reset --hard` discards any tracked edits still in that worktree (e.g. a worker hard-stopped mid-edit, before its first commit) — untracked leftovers survive, tracked ones do not. This trade is intentionally kept, not something `createWorktree` (or its caller) is meant to opt out of on its own judgement. What the code DOES do about it: `recutStaleReusedBranch` snapshots whatever it's about to discard immediately before the reset — the only moment it's still there to read — and returns it as `WorktreeInfo.discardedOnRecut`, so the loss is at least reportable even though the files themselves are gone. This is distinct from `WorktreeInfo.reusedDirtyWorktree`, which reports what SURVIVED (read after the recut, on whatever a >0-ahead recovery branch or a daemon-noise-filtered leftover left behind) — a caller must be able to tell "destroyed" and "survived and still dirty" apart, never conflate them.

## The worker-facing side: why the composed prompt names it at all

`composeWorkerStartupPrompt`'s `discardedOnRecut` param surfaces this same fact TO THE WORKER whose worktree it happened to. It is deliberately the LAST parameter (appended rather than inserted earlier) so every existing positional call site — including every test that composes this prompt without it — stays byte-identical. `undefined` omits the block entirely (a fresh worktree, a reattached-branch-only worktree, a reused worktree that was already clean, or a >0-ahead recovery branch that was never recut never sets it).

When present, a block DISTINCT from the `reusedDirtyWorktree` block fires: that one means "this survived and needs reconciling before you build on it" (see card `2250836c`'s own record); this one means the OPPOSITE — prior tracked edits on this reused worktree were already destroyed by the pre-spawn re-cut, so there is nothing left in the tree to reconcile. The block exists purely so a worker whose task looks under-progressed knows WHY, instead of silently assuming no prior attempt happened.

## Do not

- Do not reset/re-cut a branch carrying unmerged (>0-ahead) work — the recovery flow relies on branch reuse being preserved; this is load-bearing.
- Do not let a malformed/unparseable "commits ahead" count fall through to the reset — treat it identically to a positive count (never re-cut), never as 0.
- Do not read `discardedOnRecut` and `reusedDirtyWorktree` as interchangeable — one means destroyed by the reset, the other means survived it; a caller needs both facts kept distinct.
- Do not make this re-cut non-destructive as a "fix" without first updating the recovery contract it's deliberately traded against.
- Do not leave a worker guessing why its task looks under-progressed after a recut — the composed prompt must say so explicitly, not just log it server-side.

## Source

Inline comments in `packages/daemon/src/git/worktrees.ts`: `recutStaleReusedBranch`'s own doc comment (~line 709) and `createWorktree`'s own doc comment (~line 936), as of commit `f8d18a2cbc315a3020b962ac7e85cf2194ca09ba`. Relocated by card `5b001dde`; wrapped source lines joined into flowing paragraphs, `*` comment markers stripped, no wording changed. Two source anchors point here (one per site).

The "worker-facing side" section above: JSDoc comment above `composeWorkerStartupPrompt` in `packages/daemon/src/sessions/worker-prompt.ts`, originally lines 123-133, as of card `36641df4`'s HEAD. Introduced by commit `55cedf15b4fba93539ae5f1bbe5cc98bc7ecf078` (`fix(git): capture the reused worktree's dirty state before the recut discards it, so a manager can be told what was destroyed`). Relocated by card `36641df4` ("sessions prompt-composer files, tranche 1"); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
