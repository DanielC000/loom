# 5ba4412d — refuse a `vaultPath` governed by (or that governs) a code repo, on every create AND update path

## Narrative

Card `6a48b759` added `checkVaultPathUpdate` (`projects/vault-path.ts`): an EQUALITY-only alias check
run on every `project_update`-shaped UPDATE surface (REST PATCH, manager, setup, platform), refusing a
vaultPath that literally equaled `repoPath` or a registered `repos` entry. A follow-up code review on
that commit found the real hazard — the vault auto-committer's `git add .` (over a whole code repo it
walked up to via `git rev-parse --show-toplevel`) or the versioner git-initing a vault that embeds a
code repo as a gitlink — was still reachable two ways equality-only could never catch:
1. **Subdir/containment**: `vaultPath = <repoPath>/docs` (existing or not). `resolveVaultRepoContext`
   (`vault/versioner.ts`) resolves a vault subfolder UP to its governing root, so a mere subdir of a
   code repo is just as dangerous as an exact alias. The reverse — a repo INSIDE the vault — makes the
   versioner embed it as a gitlink.
2. **Create-path asymmetry**: REST `POST /api/projects`, platform `project_create`, and setup
   `project_create` never ran ANY alias/containment check at all — only the four UPDATE surfaces did.

Commit `7074e9f7` closed both: `checkVaultPathRepoContainment(candidate, repoPaths)`, a PATH-CONTAINMENT
check (never git-invoked, so it also works against a candidate that does not exist on disk yet),
wired into every create AND update surface.

### Round 2 — four more bypasses, all reproduced on Windows (commit `cf738124`)

1. **Spelling bypasses of the not-yet-existing-candidate path.** `canonicalizeExistingPath` (`repos.ts`)
   assumes existence and falls back to a non-canonicalizing `path.resolve` otherwise — exactly the
   fallback a NOT-YET-EXISTING `vaultPath` candidate hits (e.g. `<repoPath>\docs`, before
   `ensureVaultRoot` creates it). A directory JUNCTION into the repo, an 8.3 SHORT NAME of the repo, and
   the `\\?\` extended-length prefix, each with that same missing tail, all slipped straight past
   containment as a bare STRING comparison, after which `ensureVaultRoot` went on to create the vault
   INSIDE the repo.
2. **A `repos`-only PATCH.** `checkVaultPathUpdate` only ran its containment check when `vaultPath`
   itself was part of the patch (`raw !== undefined`) — a `repos`-only edit (repoPath/vaultPath both
   omitted) that added a registry entry CONTAINING the project's existing, UNCHANGED vaultPath was never
   re-checked at all.
3. **A `repoPath`-only rebind.** Same root cause, the other field: rebinding `repoPath` alone left the
   project's existing, unchanged `vaultPath` un-re-checked against the NEW repoPath, even though the
   rebind could strand it inside (or around) the new repo.
4. **A vault-only CREATE with `repos`.** The create-path fix only ran its containment check inside the
   CODE-project branch (`if (repoPath) { … }`); the VAULT-ONLY branch (no repoPath given) never checked
   its own `repos` registry against its own vaultPath, so a vault-only project could be CREATED already
   in the forbidden state.

Fix shape (commit `cf738124`): ONE shared helper, `checkVaultRepoTripleContainment(triple, opts)`,
validating containment across the FULL effective `{repoPath, vaultPath, repos}` triple whenever ANY of
the three is touched by a write — not just vaultPath. Every create and update surface now calls it.
`checkVaultPathUpdate` was reduced to the vaultPath-FIELD-only concerns (trim/expand/absolute/unbind);
containment is no longer its job. The legacy-pairing exemption (originally keyed purely on the PRE-PATCH
`project.repoPath === project.vaultPath`) was also narrowed to a `pairingIsIntentional` option the
caller states explicitly, required to ALSO hold canonically POST-patch — closing a fifth bug the same
review named: a legacy paired project could otherwise move its vault into or around its own still-real
repo by leaving `repoPath` untouched in the same call (the pre-patch-only exemption had nothing to
re-check against).

### Round 3 — three more bypasses + two correctness bugs, all reproduced on Windows

1. **CRITICAL — `\\?\UNC\…` slipped through the round-2 UNC refusal.** The round-2 `isUncNetworkPath`
   predicate exempted EVERY `\\?\…`-prefixed path as "the safe extended-length local form" — but
   `\\?\UNC\host\share\…` is the extended-length spelling of a UNC NETWORK path, not a local drive, and
   `realpathSync.native` does not collapse it to its drive-letter equivalent any more than the plain
   `\\host\share\…` form does. `\\?\UNC\localhost\C$\<repo>\docsC` reached `ensureVaultRoot`, which then
   created `docsC` INSIDE the real code repo. The exemption must be narrowed to EXACTLY the local drive
   form, `\\?\<drive>:\…` (and its forward-slash spelling `//?/<drive>:/…`) — everything else starting
   with two leading separators (a plain UNC share, `\\?\UNC\…`, or a DOS device namespace path like
   `\\.\PhysicalDrive0`) is refused, and so is the NT native namespace prefix (`\??\C:\…`).
2. **CRITICAL — a trailing `.` (or trailing space) aliases the repo.** `vaultPath = <repoPath>.` (a
   literal trailing dot) does not exist on disk, so the deepest-existing-ancestor walk finds the REPO
   itself as the ancestor and rejoins the dotted tail segment VERBATIM — producing a canonical form that
   does NOT string-match the real repo, so containment missed it. But Win32's own CreateFile-family APIs
   silently STRIP a trailing `.`/` ` from a path segment when resolving it — so while Node's
   `fs.mkdirSync` creates a literal, distinct `repo.` directory, a child process (the vault
   auto-committer's own `git`, spawned with `cwd: vaultPath`) has its cwd argument resolved by Win32 with
   that stripping applied, landing it INSIDE the real `repo` directory instead — `git rev-parse
   --show-toplevel` from there returns the CODE repo's root, and the committer `git add .`s it. This is
   agent-reachable via the manager's own `project_update` (vaultPath is the one field that surface can
   edit). `fs.realpathSync.native` does not replicate this stripping, so it cannot be relied on to catch
   it — the fix refuses outright (on win32 only; POSIX has no such stripping and a trailing `.`/` ` there
   is an ordinary, meaningful filename character) any path with ANY segment ending in `.` or ` `, rather
   than trying to replicate Win32's own normalization rules.
3. **MAJOR — `POST /api/setup/project-init` never ran the triple check.** This REST route (the human
   wizard "Create new" path, distinct from the agent-facing `project_init` MCP tools) accepts a `repos`
   registry and validated it with `validateRepoRegistry` alone (exact alias only, no containment) — it
   never called `checkVaultRepoTripleContainment` at all. Reproduced: with `LOOM_HOME` nested inside a
   git repo `G`, bootstrapping a `kind:"vault"` project with `repos:[G]` (where the bootstrapped dir ends
   up nested under `G`) returned 201.
4. **Correctness (not a security hole, but a real bug): the PRE-patch pairing comparison was a raw
   `===`.** Every UPDATE caller computed `pairingIsIntentional` from `project.repoPath ===
   project.vaultPath` directly — a legacy pairing stored with different drive-letter CASE, or a trailing
   path separator, is the SAME real directory but a DIFFERENT string, so the exemption silently failed
   to apply and an otherwise-harmless edit on a long-standing legacy project would start failing.

## Do not

- Do not treat `\\?\<anything>` as uniformly safe to canonicalize via `realpathSync.native` — only the
  LOCAL drive form (`\\?\<drive>:\…` / `//?/<drive>:/…`) canonicalizes correctly (verified directly);
  `\\?\UNC\…`, a plain UNC share, a DOS device namespace path (`\\.\…`), and the NT native namespace
  prefix (`\??\…`) must all be refused outright, never string-compared as if they were local paths.
- Do not trust `fs.realpathSync.native` (or `path.resolve`) to normalize a Windows path segment ending in
  `.` or ` ` the way Win32's own CreateFile-family APIs do when resolving a child process's cwd or a file
  handle — refuse any such segment on win32 rather than attempting to replicate that stripping.
- Do not add a new project CREATE or UPDATE write surface (REST, MCP, or otherwise) that accepts
  `repoPath`, `vaultPath`, or `repos` without routing the EFFECTIVE post-write triple through
  `checkVaultRepoTripleContainment` — this is the THIRD time a surface or a field combination was missed
  by a narrower, per-field or per-surface check; the fix is always to extend the ONE shared helper's call
  sites, never to hand-rewrite a parallel check.
- Do not compute the legacy-pairing `pairingIsIntentional` input from a raw `===` on stored
  `repoPath`/`vaultPath` strings — use a canonical comparison (`canonicallyPaired`, same primitive the
  containment check itself uses) so a case/trailing-separator difference doesn't silently strip a
  legitimate legacy project of its exemption.
- Do not re-derive "which surfaces call this" by re-reading old commits — `git grep
  checkVaultRepoTripleContainment` in `packages/daemon/src` is the live, authoritative call-site list.

## Source

`packages/daemon/src/projects/vault-path.ts` — `canonicalizeForContainment`, `isUnsafeToCanonicalize`,
`hasWin32UnsafeTrailingSegment`, `checkVaultPathRepoContainment`, `checkVaultRepoTripleContainment`,
`checkVaultPathUpdate`, `canonicallyPaired`. Call sites: `gateway/server.ts` (`POST /api/projects`,
`PATCH /api/projects/:id`, `POST /api/setup/project-init`), `mcp/platform.ts` (`project_create`,
`project_update`), `mcp/setup.ts` (`project_create`, `project_update`), `sessions/service.ts`
(`updateProjectStructural`). Introduced across commits `7074e9f7`, `cf738124`, and the commit that
added this record.
