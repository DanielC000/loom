# 306dd105 — fail closed in `commitVault` repo discovery instead of initialising a nested repo

## Narrative

Round-2 Code Review of `ffe98495` (MINOR-1, verified on Windows with git 2.47) found that
`commitVault`'s discovery step (`vault/versioner.ts`) blanket-caught every `checkIsRepo()` error and
defaulted to `isRepo = false`: `withTimeout(git.checkIsRepo(), ...).catch(() => false)`.

Repro: make a vault that is a subfolder of a bigger, externally-managed repo (normally `commitVault`
returns `false`, deferring to the external repo). Use `vault_write` to create three plain files at the
vault root — `HEAD` ("ref: refs/heads/main"), `objects/a.md`, `refs/a.md` — so the directory *looks like*
a bare repo. With `safe.bareRepository=explicit` (part of `VAULT_GIT_SAFETY_CONFIG`, applied to every
vault git call including discovery), git's own upward repo-discovery refuses to treat this directory as a
bare repo and exits fatally — a real error, but NOT the "not a git repository" message. The blanket
`.catch(() => false)` mapped that refusal to "no repo here", so `commitVault` proceeded to `git init` a
NESTED repo inside the externally-managed parent it was supposed to never touch.

Per `simple-git`'s own `checkIsRepoTask` (`check-is-repo.ts`), a genuine "not a git repository" result
(`exitCode === 128` + a message matching `/(Not a git repository|Kein Git-Repository)/i`) is *already*
resolved to a clean `false` — it never rejects. So any rejection from `checkIsRepo()` is, by construction,
some OTHER failure (a bare-repo safety refusal, dubious ownership, a timeout) — never the "no repo"
case — and treating it as "no repo" was always wrong.

## The fix

1. **Discovery (`isRepo` determination).** Only an affirmative `isNotAGitRepositoryError` match may
   resolve to `isRepo = false`. Any other thrown error skips the commit (`return false`, logged) instead
   of falling through toward `git init`.
2. **Before `git init` (belt-and-suspenders).** Even once `isRepo` is false, `commitVault` now also
   probes the ENCLOSING directory from OUTSIDE `vaultPath` (`git -C <dirname(vaultPath)> rev-parse
   --show-toplevel`, through the same safety-configured `boundedVaultGit`, unpinned) before calling
   `git init`. A resolved toplevel there means the vault's parent is itself inside a repo — refuse init
   and skip the commit. A probe error that isn't a genuine "not a git repository" also skips the commit,
   same fail-closed posture as item 1.
3. **Shared classifier, no cycle.** `isNotAGitRepositoryError` moved from `git/writer.ts` (where it was
   module-PRIVATE — no prior external import to preserve) into `git/bounded.ts`, a leaf module neither
   `git/writer.ts` nor `vault/versioner.ts` creates a cycle through (see `git/bounded.ts`'s own module
   doc). `bounded.ts` is the new home; `git/writer.ts` now re-exports it BY CHOICE, purely so
   `GitWriter.refuseIfOperationalHome` keeps referring to it by its bare name. `vault/versioner.ts` imports
   the same function from `git/bounded.ts` directly, so both modules share one implementation without
   recreating the `git/writer.ts` ↔ `vault/versioner.ts` import cycle `docs/decisions/509716cc-...md`
   already documents avoiding.

## Round 2 — locale pin on both message-classified probes

Code Review of `201c7a6f` (round 1 of this card) found a MAJOR gap: both new discovery probes above are
MESSAGE-CLASSIFIED (their catch branch inspects a thrown error's text via `isNotAGitRepositoryError`), but
`boundedVaultGit` passes no `env`, so each probe's git child inherits the HOST locale. `isNotAGitRepositoryError`'s
pattern (`/not a git repository/i`) only recognizes English. On a French/Spanish/German-locale host, a
genuinely-not-a-repo vault's `checkIsRepo()` throws a LOCALIZED message the pattern never matches, so round
1's own fail-closed fix (item 1 above) would treat it as "some other error" and skip the commit forever — a
brand-new standalone vault would NEVER `git init`, on every single auto-commit tick, indefinitely.

Fix: both probes now build their git instance with `messageClassifiedProbeEnv()` —
`localReadGitEnv(process.env, { LC_ALL: "C", LANGUAGE: "C" })` — matching the SAME locale-pin convention
`git/writer.ts`'s `NONINTERACTIVE_ENV`, `git/mainline-watch.ts`'s own probe (`@decision 4fa36502`), and
`git/reader.ts` already use. Locale ONLY: `GIT_DIR`/`GIT_WORK_TREE` are never pinned here — both probes
stay deliberately un-repo-pinned discovery (item 1's own `@decision ffe98495` note still holds).

## Round 3 — strip ambient repo-location env on both probes

The full-suite batch gate (op `eb366e87`) found a real regression from round 1/2: `vault-git-segment-guard.mjs`'s
section (7) failed — `commitVault` refused to init the vault's own repo ("the enclosing directory … is
itself inside a git repository") under an ambient `GIT_DIR`/`GIT_WORK_TREE` pointing at an unrelated decoy
repo.

Cause: round 2's locale pin (`messageClassifiedProbeEnv`) builds its env via `localReadGitEnv(process.env,
{ LC_ALL: "C", LANGUAGE: "C" })`, which only touches the locale keys and the transport family — it leaves
`GIT_DIR`/`GIT_WORK_TREE` (and siblings) exactly as inherited. Both message-classified probes (discovery
`checkIsRepo`, the outside-vault `revparse`) are deliberately UNPINNED (see "Round 2" / item 1's
`@decision ffe98495`) — but "unpinned" was read as "whatever the ambient env says", so an ambient `GIT_DIR`
silently redirected each probe's cwd-based discovery at the decoy repo the ambient var named, while the
probe kept reporting success. That is a *worse* failure than an honest error: `checkIsRepo` resolved
`true` against the decoy, and the toplevel comparison then saw a path mismatch and refused `git init`
entirely, so the vault's own commit never happened.

Fix: both probes now also STRIP the repo-location env — `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`,
`GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_NAMESPACE`
(`git/bounded.ts`'s new `GIT_ENV_REPO_LOCATION_KEYS` / `stripRepoLocationEnv`, applied inside
`messageClassifiedProbeEnv` via the existing `deleteEnvKeys` mechanism — no second scrub list).
Deliberately excludes `GIT_CEILING_DIRECTORIES`: it bounds how far upward a search may walk rather than
pointing at a specific repo, and a test may legitimately set it to bound discovery to its own temp root
(round 2 DoD item 4) without that being "ambient interference" to defeat.

STRIP is not PIN: this round does not touch item 1's `@decision ffe98495` prohibition on pinning `GIT_DIR`
for discovery. Stripping removes the ambient pointer so git falls back to genuine cwd-based upward
discovery; pinning would instead force a *specific* root, which is exactly what discovery must not do
before a root is confirmed.

## Do not

- Do not revert to a blanket `.catch(() => false)` on `commitVault`'s discovery `checkIsRepo()` call —
  only an affirmative `isNotAGitRepositoryError` may count as "not a repo"; every other error must skip
  the commit instead.
- Do not import `isNotAGitRepositoryError` from `git/writer.ts` directly into `vault/versioner.ts` — that
  recreates the `git/writer.ts` ↔ `vault/versioner.ts` import cycle `git/bounded.ts`'s own doc (and
  `509716cc`'s decision record) already documents avoiding. Import it from `git/bounded.ts` instead.
- Do not write a second copy of this regex — `git/bounded.ts`'s `isNotAGitRepositoryError` is the one
  implementation; `git/writer.ts` re-exports it rather than defining its own.
- Do not skip the new outside-vault probe before `git init` — it is deliberately independent of the
  discovery step above, so a future discovery-step regression doesn't reopen the nested-repo risk alone.
- Do not leave either message-classified probe (discovery `checkIsRepo`, the outside-vault `revparse`)
  without the `messageClassifiedProbeEnv()` locale pin — a host locale other than English silently defeats
  `isNotAGitRepositoryError` and fails the commit closed forever, not just once.
- Do not PIN `GIT_DIR`/`GIT_WORK_TREE` inside `messageClassifiedProbeEnv()` or at either of its call sites
  — both probes must stay un-repo-pinned discovery (see item 1's `@decision ffe98495`).
- Do not leave either message-classified probe without the round-3 repo-location STRIP
  (`stripRepoLocationEnv`) — an ambient `GIT_DIR`/`GIT_WORK_TREE`/etc. otherwise silently redirects
  cwd-based discovery at a different repo while still reporting success. Strip ≠ pin; see "Round 3" above.
- Do not write a second ad hoc env-key removal loop for this — reuse `git/bounded.ts`'s `deleteEnvKeys` /
  `GIT_ENV_REPO_LOCATION_KEYS` / `stripRepoLocationEnv`, the same mechanism the rest of this module's
  env-scrubbing already goes through.
- Do not add `GIT_CEILING_DIRECTORIES` to the repo-location strip list — it bounds search depth, not repo
  identity, and a test may need it set deliberately.
