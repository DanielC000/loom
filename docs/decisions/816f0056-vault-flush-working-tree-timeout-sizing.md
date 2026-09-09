# 816f0056 — `VAULT_FLUSH_WORKING_TREE_TIMEOUT_MS` sizing (`VaultVersioner.flushSync()`)

## Narrative

`VAULT_FLUSH_WORKING_TREE_TIMEOUT_MS` (5 minutes) is the ceiling for `VaultVersioner.flushSync()`'s two WORKING-TREE-SCALE `execSync` calls (`git add -A`, which hashes every new/changed blob across the whole vault, and `git commit`, which runs the user's own hooks — the actual named hang vector in this card — plus writes tree objects). Deliberately much larger than `VAULT_GIT_OP_TIMEOUT_MS`: the goal on this path is "no INFINITE hang", not "fail fast" — `flushSync`'s timeout throwing lands in its own best-effort `catch` and SILENTLY DROPS the commit (now at least logged — see `flushSync`'s own doc), so a bound tight enough to fail a real, still-progressing flush on a large or network-backed vault would trade a rare hang risk for a routine, guaranteed data-loss failure. See `flushSync`'s own doc for why the THIRD call (`git status --porcelain`, a cheap stat-based comparison) is bound by `VAULT_GIT_OP_TIMEOUT_MS` instead.

**Sizing (review round 2 — corrects an earlier, wrong appeal to convention): this is NOT sized to match `git checkout`.** This repo's own `GIT_LOCAL_TIMEOUT_MS` (`git/writer.ts`) bounds `checkout` at the SAME 15s as `VAULT_GIT_OP_TIMEOUT_MS` — citing it as precedent for "5 min is generous" was backwards. The real basis: a cold `git add -A` over a 20k-file vault measured ~11.6s on local NVMe ALONE — comfortably eating a 15s bound with zero margin left for a slower disk or a bigger vault — so this needs to be in the same league as this codebase's OTHER genuinely-large working-tree op, `git/worktrees.ts`'s `PROVISION_TIMEOUT_MS` (3 min, for a full dependency install into a fresh worktree). 5 minutes sits comfortably above both.

## Do not

- Do not tighten this ceiling by appeal to `git checkout`'s 15s bound — that comparison was already tried and is wrong; the real basis is the measured `git add -A` cost on a large vault, not `checkout`'s cost.
- Do not make this ceiling as tight as `VAULT_GIT_OP_TIMEOUT_MS` — the goal here is "never hang forever," and a tight bound on this path converts a slow-but-working flush into a guaranteed, silent commit-drop.
