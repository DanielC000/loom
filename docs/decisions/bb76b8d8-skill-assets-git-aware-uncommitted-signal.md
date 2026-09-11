# bb76b8d8 — a git-aware uncommitted-assets signal for `packages/daemon/assets/skills`

## Narrative

`skillStoreStaleness()` (store.ts) compares the STORE against the assets WORKING TREE
(`customizationState`'s `shipped = readFileOrNull(assetMd(name))`, a plain `fs.readFileSync`) and never
consults git. That makes a live, uncommitted `assets/skills/**` edit invisible: once the edit is also
reflected in the store (however that happened — a manual sync, a publish, hand-copying), `shipped ===
base === mine` and `skillStoreStaleness()` reports a clean bill — even though the edit exists in NO
commit, and a `git checkout -- .` / `git stash` / clean clone would silently destroy it.
`skillAssetsGitStatus()` (`skills/assets-git-status.ts`) is the missing git-aware half: does
`packages/daemon/assets/skills` differ from HEAD right now?

Mirrors `deploy-staleness.ts`'s discipline exactly (same reasoning, read it before touching this):
bounded `execFileSync` git calls (`GIT_TIMEOUT_MS`), NEVER throws, and degrades to an explicit
`available:false` for a non-git checkout (a packaged `loomctl` install has no `.git` at all — this must
never report a false "uncommitted" there) or any other git failure (a timeout, git missing, a corrupt
repo) — same two-way `reasonKind` split (`"not-applicable"` vs `"could-not-measure"`) as that module.

Surfaced on `served_status`, the same human-facing surface `skillStoreStaleness` already uses, rather
than a new standalone tool — a manager/human diagnosing "why is this skill stale" already reads that
one place.

## Do not

- Do not make this a blocking check or a boot refusal — it is DELIBERATELY a visibility signal only
  (card bb76b8d8 DoD #3). A stale/uncommitted skill is a thing to SEE, not a thing to fail a boot on.
- Do not report a false "uncommitted" for a non-git checkout or a packaged install — degrade to
  `available:false` instead.

## Source

Module doc comment in `packages/daemon/src/skills/assets-git-status.ts`, above the imports: lines 8-27,
as of this tranche's starting HEAD (main `6129350a`).
