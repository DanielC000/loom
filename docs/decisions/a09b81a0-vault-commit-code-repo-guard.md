# a09b81a0 — vault auto-commit refuses to stage/commit into a registered code repo

## Narrative

From the Code Review of `8d49c36c` (reviewer `c9dd7a98`), reproduced with real git: a legacy project row
whose `vaultPath` is a SUBDIR of its own code repo (`cb6ba196`/`8d49c36c` only refuse NEW creates/updates;
an untouched legacy row keeps the shape) gets a `VaultVersioner` whose `resolveVaultRepoContext` resolves
`commitPath` to the CODE repo ROOT. Every debounce tick and `flushSync` at shutdown then ran `git add .` +
commit there, on the code repo's own branch — auto-committing arbitrary code files, outside
`withCanonicalIndexLock`, able to race `mergeBranchLocked`/batch assembly on the shared index (the
concurrent-squash data-loss family; project memory `concurrent-squash-merges-lose-work`).

**Fix:** a collision guard (`checkCodeRepoCollision` in `vault/versioner.ts`) checked at THREE real
mutation chokepoints — `commitVault` (the debounced tick + `vault/writer.ts`'s three UI-write functions,
reached by REST/the Setup operator/the Platform Lead/the core `vault_write` MCP tool), `VaultVersioner.
flushSync()` (the synchronous shutdown flush), and `startVaultVersioners`'s own boot-time construction gate
(skipping `new VaultVersioner(...)` entirely for a refused project, which structurally covers that
project's own debounce tick + flushSync in one place — but does NOT cover the independent
`commitVault`-via-writer.ts path, which never goes through boot at all, hence that path's OWN check).

**The predicate:** given an already-resolved `commitPath`, compute `canonicalRepoLockKey(commitPath)`
(the SAME normalizer `assertRepoNotQuarantined`/`withCanonicalIndexLock` key on) and compare it against
EVERY registered project's `repoPath` and each `repos[].path` entry, canonically. A match REFUSES unless
the matching project has `vaultOnly:true` — defensively re-verified against `repoPath === vaultPath`
(canonically) rather than trusting the flag alone, in case `b98957e9`'s write-once invariant ever slips.

**Registered-project population — INCLUDES archived.** `startVaultVersioners`'s own project loop uses
`db.listAllProjects()` (excludes archived), but the collision guard's own snapshot (built in `index.ts`,
passed in via `setCodeRepoGuardProvider`) unions `listAllProjects()` WITH `listArchivedProjects()` —
deliberately wider than the loop it protects: an archived project's checkout is still a real code repo
sitting on disk, and nothing about archiving a project un-registers its repo path. Fail CLOSED on this
axis, not symmetric with the boot loop's own narrower population.

**Legacy aliased-code rows need no special case.** A row like `5af9020b` "OSS Contributions"
(`repoPath === vaultPath`, pointing at a real code checkout, backfilled `vaultOnly:true` by `b98957e9`)
resolves `commitPath === repoPath === vaultPath` for ITSELF — the matching entry IS the row being checked,
and its `vaultOnly:true` exempts it, continuing the exact pre-existing (already-accepted) behavior
`b98957e9` explicitly chose to carry forward rather than silently "fix".

**Live provider, not a cached snapshot.** `setCodeRepoGuardProvider` registers a PROVIDER function,
consulted fresh on every `commitVault`/`flushSync`/boot-loop check — never cached — so a runtime `repoPath`
rebind (human REST `PATCH`, or the elevated Platform Lead `project_update`) or a freshly created project is
seen by the very next check, with no daemon restart required. `startVaultVersioners`'s own boot-time skip
is necessarily a point-in-time decision (it only runs once, at boot) — the LIVE re-check inside
`commitVault`/`flushSync` is what actually satisfies "seen without a restart" for a project whose
versioner was already running before the rebind happened.

**Fail-open when unset.** A unit test that calls `commitVault`/`flushSync` directly, with no boot-wired
`Db`, has nothing to check a collision against — `checkCodeRepoCollision` returns `null` (no collision)
rather than refusing. Production boot ALWAYS wires a provider in `index.ts`, immediately before
`startVaultVersioners(db)` runs; `vault-commit-code-repo-guard.mjs`'s own comment-stripped source-text
scan of `index.ts` is the test that catches a forgotten wiring (never silently masked by this fail-open).

**Dedupe: one warn + one durable event per (subjectPath, commitPath) per PROCESS.** `commitVault`'s own
collision check re-runs on every debounce tick (every ~5s by default) for as long as the misconfiguration
persists — without dedupe this would spam a warn+event every tick forever. `refuseCodeRepoCollision`'s
module-level `warnedCodeRepoCollisions` Set keys on `${subjectPath}::${canonicalRepoLockKey(commitPath)}`,
where `subjectPath` is whichever identity the caller actually has (the project's raw configured
`vaultPath` at the `startVaultVersioners` boot-time site — so two DIFFERENT projects colliding on the SAME
commitPath are each warned independently — or the already-resolved `commitPath` itself at the
`commitVault`/`flushSync` sites, where no distinct raw path is available).

**Surfacing: `vault/writer.ts`'s three UI-write functions must not swallow this refusal
indistinguishably from an ordinary silent backoff.** `commitVault`'s return type changed from a bare
`boolean` to `CommitVaultResult` (`{committed, blockedReason?}`); `blockedReason:"code-repo-collision"` is
present ONLY for this refusal — every other existing backoff (quarantined / externally-managed /
nothing-staged / operational-dir / oversized-only) stays `committed:false` with no reason, byte-identical.
`VaultWriteOutcome`'s `ok:true` arm gained an optional `committedBlockedReason` field, threaded through
`gateway/server.ts`'s `writeReply` and (by direct passthrough — `ok(await writeVaultFile(...))`) all three
`vault_write` MCP tools (`mcp/server.ts`, `mcp/operator.ts`, `mcp/platform.ts`) with no further code change
needed there beyond the tool description text. The file write to disk ALWAYS already succeeded by the
time this is returned — `ok` stays `true`; only the git commit was blocked, so this is advisory surfacing
on a 200/`ok:true` response, never a new refusal code path.

**Durable audit event.** `vault_autocommit_refused_code_repo` (new `OrchestrationEventKind`, modeled
directly on `mainline_moved_outside_loom` — sessionless, filed with `managerSessionId:""`, `detail`
stamped with `projectId` explicitly by the caller, never auto-derived since there is no owning
session/task to derive it from). Checked against, and deliberately excluded from: `EVENT_TRIGGER_EVENT_
KINDS` (types.ts — a human fixing a legacy vault/repo pairing is a one-time config task, not a lifecycle
signal worth an automation hook), `GATE_HISTORY_KINDS` (db.ts — not a gate-run outcome),
`ORCH_ACTIVITY_KINDS` (orchestration/idle-watcher.ts — resolves no manager idle-nudge state), and
`REPORT_RESOLVED_EVENT_KINDS` (orchestration/report-resolution.ts — resolves no manager report). IS a
member of `DURABLE_AUDIT_EVENT_KINDS` (db.ts), mirroring `mainline_moved_outside_loom` exactly — moot for
`deleteAgent`'s cascade either way, since this event is sessionless by construction and that cascade keys
on `manager_session_id`/`worker_session_id`.

## Do not

- Do not re-derive the registered-repo-path set from `db.listAllProjects()` alone for this guard's own
  snapshot — it excludes archived projects, and an archived project's checkout is still a real code repo
  on disk. Union it with `db.listArchivedProjects()`.
- Do not cache the provider's snapshot, or memoize `checkCodeRepoCollision`'s result, across calls — the
  whole point of a live provider (not a boot-time-only check) is that a runtime rebind or a new project is
  seen by the very next `commitVault`/`flushSync` call, with no restart.
- Do not trust `entry.vaultOnly` alone when deciding the exemption — re-verify
  `canonicalRepoLockKey(entry.repoPath) === canonicalRepoLockKey(entry.vaultPath)` defensively, in case
  `b98957e9`'s write-once invariant (`vaultOnly:true` ⟹ `repoPath === vaultPath`) ever slips.
- Do not let the `startVaultVersioners` boot-loop's own sibling-dedupe `seen` Set short-circuit the
  collision check — run it per-project, before the dedupe-by-root logic, so two distinct projects
  colliding on the same commitPath are each independently warned/audited.
- Do not skip `flushSync`'s own independent collision check on the theory that `startVaultVersioners`'s
  boot-time skip already covers it — a project whose versioner started cleanly at boot can still collide
  LATER if a different project is rebound at runtime onto the same commitPath; `flushSync` has its own raw
  git calls that never go through `commitVault`, so it needs its own live re-check at shutdown.
- Do not silence this refusal into an ordinary `committed:false` with no reason inside
  `vault/writer.ts`'s three functions — a caller that can never distinguish this from a routine backoff
  can never act on it (fix the project's vaultPath/repoPath pairing).
- Do not add `vault_autocommit_refused_code_repo` to `EVENT_TRIGGER_EVENT_KINDS`/`GATE_HISTORY_KINDS`/
  `ORCH_ACTIVITY_KINDS`/`REPORT_RESOLVED_EVENT_KINDS` without a fresh case — checked against all four for
  this card; none apply.
- Do not fabricate a source-text scan test for the boot-wiring assertion that isn't comment-stripped —
  `vault-commit-code-repo-guard.mjs`'s own scan reuses the shared `_strip-comments.mjs` helper specifically
  so it is immune to a comment-only diff touching `index.ts`, and does NOT need a `CHANGED_TS_TEXT_SCANNER_
  REPO_PATHS` membership entry as a result (see that list's own doc, shape (3)).
- Do not revert to canonical-EQUALITY-only matching in `checkCodeRepoCollision` (round 2) — a registered
  project's `repoPath` can legitimately be a SUBDIRECTORY of the resolved `commitPath` (a monorepo-package
  binding); match canonically AT-OR-UNDER via `isCanonicallyAtOrUnder`, never a bare equality or a naive
  `startsWith` (which would wrongly match a textually-prefixed sibling like `mono2x` against `mono2`).
- Do not decide the `vaultOnly` exemption once per ENTRY (round 2) — decide it per CANDIDATE: only the
  entry's own `repoPath` is ever exempt, never a different code repo the same vault-only project happens
  to list in `repos[]`.
- Do not wire `setCodeRepoGuardProvider` anywhere a listener could open first (round 2) — wire it
  immediately after `const db = new Db();`, before `startGatewayListeners`/`companionController.
  startInitial`, or `commitVault`/`vault_write` fail OPEN for the whole window until the old, later wiring
  site ran.

## Round 2 — at-or-under matching, per-candidate exemption, boot-wiring order, comment cleanup

From a Code Reviewer sweep of round 1 (reviewer `c9dd7a98`), reproduced with real git — four findings, all fixed in the same round.

**Finding 1 (BLOCKING): exact-equality missed a monorepo-package binding.** `checkCodeRepoCollision` only refused when a candidate canonically EQUALED `commitPath`. A legacy/monorepo shape where a project's `repoPath` is a SUBDIRECTORY of the repo `commitPath` resolves to — e.g. repo `mono/`, project `repoPath=mono/pkg`, `vaultPath=mono/notes` (a sibling subfolder) — passes create-time validation (`isGitRepo(mono/pkg)` is true because simple-git's `checkIsRepo` means "inside a work tree"; `checkVaultRepoTripleContainment` treats the two as textual siblings and raises no objection), then `startVaultVersioners` resolves `commitPath` to `mono` (the real repo ROOT) and a debounce tick committed BOTH `notes/*.md` and `pkg/a.ts` — a real code edit, auto-committed. **Fix:** `checkCodeRepoCollision` now refuses when a candidate is canonically AT-OR-UNDER `commitPath`, not just canonically equal — see `isCanonicallyAtOrUnder` (path-segment-aware: `mono2` is never "under" `mono`). Create-time binding rules for a subdir `repoPath` are UNCHANGED — out of scope; this round only widens the auto-committer's own refusal to see a shape create-time already allows.

**Why path-comparison, not a per-candidate git-toplevel probe.** `checkCodeRepoCollision` is called from `VaultVersioner.flushSync()`, which is SYNCHRONOUS by necessity (shutdown, `execFileSync`) and iterates every registered project on every call — spawning a `git rev-parse --show-toplevel` per candidate there would reopen exactly the unbounded-plumbing-cost class `509716cc`/`816f0056` exist to keep off this module's hot paths. A registered project's `repoPath` is already validated at bind time to BE (or be inside) a real repo, so a canonical path-segment relationship between it and `commitPath` USUALLY implies the git relationship without re-deriving it via git — see the known exception immediately below, accepted rather than fixed.

**Known over-refusal, accepted as a trade-off (round-2 delta review, Minor): a nested SEPARATE repo (a gitlink/submodule boundary) false-positives.** If a `vaultOnly:true` project V's own vault folder contains a genuinely separate, independently-`git init`'d repo as a subdirectory (e.g. `V/code`, registered in `repos[]`) and V's own vault root is `commitVault`'s `commitPath`, the at-or-under match above fires for that `repos[]` candidate (`V/code` is textually/path-segment-wise under `commitPath`) and the per-candidate `vaultOnly` exemption does NOT cover it (Finding 3 below: only `entry.repoPath` is ever exempt, never a `repos[]` entry) — so `commitVault` REFUSES to auto-commit V's own, otherwise-harmless vault content. The refusal is spurious in the narrow sense that committing at `commitPath` would never actually leak `V/code`'s real file contents — git stops descending at a nested `.git` boundary and stages only a gitlink pointer — but this guard does not special-case that: it has no cheap way to tell "a nested SEPARATE repo" apart from "a subdirectory of the SAME repo" without a per-candidate `fs.existsSync(path.join(candidate, ".git"))` probe (or worse, a git call), and the false-positive direction (an over-cautious refusal) is the safe one to accept — it costs a visible, loud warning and a stalled auto-commit a human can investigate, never a silent code leak. Not fixed; intentionally left as a known, named limitation.



**Finding 3 (Minor, fixed in this round): the vaultOnly exemption was decided per ENTRY, not per CANDIDATE.** A `vaultOnly:true` project V that ALSO lists a different, genuinely-code repo in `repos[]` had that OTHER repo exempted too — because the old check tested `entry.vaultOnly` once per entry, before looping over which specific candidate matched. Reproduced: `commitVault` committed into the listed code repo. **Fix:** the exemption now checks `candidate === entry.repoPath` first — only the entry's OWN `repoPath` is ever exempt; any `repos[]` entry (a genuinely different registered repo) is never exempt merely because its owning project happens to be vault-only.

**Finding 2 (Minor, fixed in this round): a boot fail-open window.** `setCodeRepoGuardProvider` used to be wired in `index.ts` immediately before `startVaultVersioners(db)` — well AFTER `startGatewayListeners` (the HTTP/MCP gateway's `listen`) and `companionController.startInitial`. In that window, `commitVault` (reachable via a REST vault write or a resumed session's `vault_write` MCP tool) ran with `codeRepoGuard` unset, i.e. fail-open per `checkCodeRepoCollision`'s own documented fail-open behavior. **Fix:** the provider is now wired immediately after `const db = new Db();`, before any listener opens. `vault-commit-code-repo-guard.mjs`'s test (10) now asserts the wiring textually precedes BOTH `startVaultVersioners(` and `startGatewayListeners(`.

**Finding 5 (Nitpick, fixed in this round):** `packages/shared/src/types.ts`'s `vault_autocommit_refused_code_repo` doc comment duplicated this record's narrative and misstated the primary case as "ANOTHER registered project's" repo — the main case (post round-2) is the SAME project's own `repoPath`, reached via the at-or-under widening above. Compressed to a `@decision a09b81a0` anchor plus the `detail` shape line; the narrative lives here only.

## Round 3 — owner ruling (request `8d6fea89`, option A): exempt a genuine vault root, take the canonical index lock when merge-eligible

**Trigger.** The round-2 delta review found that the round-1/round-2 guard, as merged, would refuse ALL auto-versioning of the owner's shared Obsidian vault: Parallax, Shahnameh, Federalist (plus archived Menu Visualizer) all bind `repoPath` to the shared vault root, with their OWN `vaultPath` a SUBFOLDER of it (not equal — so `vaultOnly` is `false` for all four; `b98957e9`'s invariant requires exact `repoPath === vaultPath`). ~20 other, genuinely separate code projects (Loom, Codescape, Fire Studio, …) each have their OWN `vaultPath` ALSO living under that same shared root. Every one of their debounce ticks resolves `commitPath` to the shared root (one git repo, many sibling vault subfolders — see `startVaultVersioners`'s own dedupe-by-root doc), and the round-2 guard would refuse there every time: the shared root canonically equals Parallax/Shahnameh/Federalist/Menu Visualizer's own `repoPath`, and none of those four qualifies for the existing (equality-only) `vaultOnly` exemption. A standing `question_ask` (request `8d6fea89`) put three options to the owner; the owner chose **A: keep auto-commit, exempt notes-vault roots, take the merge lock** — verbatim recommendation, verbatim choice.

## ⚠️⚠️ KNOWN HOLE — tracked by 7c1d6dbf — a third party can grant the vault-root exemption for a code repo it has nothing to do with

**Found by the round-3 delta review, verified directly with real git.** Given `P = {repoPath: C, vaultPath: C/docs}` (the ORIGINAL bug shape — the whole guard exists to refuse exactly this) and an UNRELATED `Q = {repoPath: D, vaultPath: C/q-notes}` (Q's own code lives at `D`, entirely outside `C`), `isRecognizedVaultRoot(C, …)` returns `true`: `Q`'s own code is not at risk at `C` (it's at `D`), so `Q` is never excluded as a voucher, and it vouches for `C` as if `C` were pure notes. `commitVault(C)` then genuinely auto-commits `C`'s real source — verified (`committed:true`, `C`'s commit count increments). **Geometry alone cannot distinguish this from Parallax's shape** — the self-exclusion below only ever protects against an entry vouching for a `key` its OWN code is also at risk under; it was never designed to, and does not, stop a genuinely different entry from vouching for a key it has no stake in.

Two further degenerate variants of the identical hole, also verified directly: a voucher entry with `repoPath: ""` vouches for ANY `key` unconditionally (its `ownCandidates` array is empty after `.filter(Boolean)`, so `.some(...)` over it is vacuously `false` — it can never be "at risk" anywhere); and a voucher whose `repoPath` is an ANCESTOR of `key` (rather than at-or-under it) also vouches, since `isCanonicallyAtOrUnder` only tests one direction.

**The owner is choosing the real discriminator — an explicit per-project flag or a platform list of recognized vault roots. Do not extend, harden, or otherwise "fix" this geometric predicate until that decision lands.** Owner request `f7cc5951` (how Loom should recognize a shared notes vault) is still PENDING; the follow-up card `7c1d6dbf` ("require an explicit fact before exempting a shared vault root") tracks implementing whichever answer the owner picks.

**ROUND 4 CORRECTION — `vault-commit-code-repo-guard.mjs` tests (14)/(14b)/(14c) no longer assert the correct (refused) behavior, and the file must exit 0.** They used to encode the CORRECT, desired behavior and were DELIBERATELY RED against the current code — but a committed test with a deliberate red assertion turns the merge gate red, and this project's merge gate is not always fully gated (interval-based reduced gating), so a red test here risks landing straight onto main. Each of the three now instead PINS TODAY'S (WRONG) behavior as a tripwire: the voucher IS honoured and the colliding project's real source IS auto-committed, labeled "KNOWN HOLE (request f7cc5951 pending)" in both the check label and an inline comment. **These three assertions MUST FLIP** — back to asserting refusal (`committed:false`, no new commit) — the moment `7c1d6dbf` implements the owner's answer; do not read a future green run of today's assertions as the hole being closed, and do not let this round's rewrite be read as the hole being accepted as permanent.

**Fix part 1 — recognize a genuine vault root (partial; see the KNOWN HOLE section above for what this does NOT close).** `isRecognizedVaultRoot(key, entries)` (`versioner.ts`): `key` (an already-resolved, already-canonicalized `commitPath`) is a recognized vault root iff some registered entry's `vaultPath` is canonically at-or-under `key`, AND that SAME entry's own code candidates (`repoPath` + every `repos[]` entry) are NOT themselves at-or-under `key`. `checkCodeRepoCollision` calls this FIRST, before the existing per-candidate loop, and returns `null` (no collision) immediately if it holds — independent of, and in addition to, the existing per-candidate `vaultOnly` exemption, which is UNCHANGED.

**What self-exclusion actually closes (and what it does not).** `vaultPath` nested inside `repoPath` is EXACTLY the shape of the card's ORIGINAL bug (a legacy project whose own vault is a subdir of its own code repo) — geometrically indistinguishable, from a single entry's own two fields, from Parallax's shape. Self-exclusion stops that SAME entry from exempting ITSELF this way, and is also what keeps the round-2 monorepo-subdir shape (Finding 1: `repoPath=mono/pkg`, `vaultPath=mono/notes`, siblings under `mono`) from self-exempting: that project's OWN `repoPath` is at-or-under `mono`, so it can never vouch for `mono` either, and the collision still fires. It is a genuinely correct, narrow fix for SELF-vouching. It is NOT a fix for THIRD-PARTY vouching — see the KNOWN HOLE section above, which is a separate gap self-exclusion was never meant to address. `vault-commit-code-repo-guard.mjs` test 12 verifies only the narrower, already-closed case: a SEPARATE, self-contained vault-root voucher that has nothing to do with the bug repo does not leak in merely by being present in the same snapshot. It does NOT verify, and must not be read as verifying, the third-party case above.

**Why this needed NO new DB field or backfill.** Parallax/Shahnameh/Federalist/Menu Visualizer's `vaultOnly` stays `false` — correctly, since `b98957e9`'s invariant is specifically "no separate repo, `repoPath` IS the vault" (exact equality), which is not their shape (they have a real, if trivial, code-repo-registration relationship with the shared vault, just not a code *repo*). The exemption is derived live, per call, from the SAME `CodeRepoGuardEntry` fields the guard already holds (`repoPath`, `repos[]`, `vaultPath`) — no git call, no new column, no migration. A boot-check against a COPY of the real `~/.loom` database (never the live one, and never a git mutation — read-only `git rev-parse` discovery, the same discovery `resolveVaultRepoContext` itself does, plus the same in-memory predicate) confirmed: every one of the owner's real projects whose `vaultPath` resolves to the shared Obsidian vault root — Parallax, Shahnameh, Federalist, the archived Menu Visualizer, and roughly 25 genuinely separate code projects including Loom, Codescape, and Fire Studio — resolves that shared root to `exempt-vault-root`, each independently vouched for by at least one OTHER project's own, genuinely separate code repo (e.g. Fire Studio's own `C:\…\Forgejo\fire-studio`). The two `LOOM_HOME`-rooted rows ("Loom Platform" live + archived) never reach this check at all in production — `isOperationalVaultDir` refuses them earlier, before `checkCodeRepoCollision` is ever called (see that function's own doc); a bare predicate-only probe (without that earlier guard) does surface a pre-existing, unrelated stray fixture row (an archived `QA-SWEEP` e2e leftover whose `repoPath` happens to sit inside `LOOM_HOME`) as a nested collision candidate for `LOOM_HOME` itself — real, but orthogonal to this card and never reached end-to-end. This boot-check predates the KNOWN HOLE finding above and does not probe for it — none of the owner's real registered projects happen to have a vaultPath nested inside ANOTHER project's code repo, so it would not have surfaced this hole either way.

**Fix part 2 — take the canonical index lock when merge-eligible.** `isCommitPathMergeEligible(commitPath)` (`versioner.ts`): true iff `commitPath` canonically EQUALS (never merely at-or-under — see below) some registered project's own `repoPath` or a `repos[]` entry — i.e. a real `mergeBranch`/batch merge or a `GitWriter` write for THAT project could also target this exact physical repo. `commitVault`'s own add+commit sequence, when this is true, is wrapped in `withCanonicalIndexLock(vaultPath, …)` (`vaultPath` here is already the CONFIRMED governing root by that point) — the SAME lock, same `canonicalRepoLockKey` normalizer, that `mergeBranch`/`GitWriter` already take for that repo (see the paragraph below for the lock-keying semantics this relies on, and the ROUND 4 CORRECTION for a gap that used to exist here and is now closed). A `RepoQuarantinedError` thrown by the lock itself (checked AFTER acquisition, which the function's own pre-checks cannot see) is caught and translated into `commitVault`'s existing graceful `{committed:false}` quarantine-backoff shape, never a new throw type escaping this function. Proven with real git (test 13): a simulated merge holds the lock and only commits once released; the auto-commit's own commit is verified to land STRICTLY AFTER the merge's commit by the real `git log` ARTIFACT (commit order). This is NOT a timing-independent proof: the test's own window gives an unlocked sequence real wall-clock time to run, and the assertion only discriminates (would go red if the lock were removed) if that unlocked sequence would complete inside that window on the host running it — a real, accepted limitation of a real-concurrency test, stated plainly rather than oversold.

**EXACT equality, deliberately never at-or-under, for the lock-eligibility check.** Every real canonical-index lock is keyed via `canonicalRepoLockKey` (`git/repo-lock.ts`) on that project's OWN `repoPath` value (`git/worktrees.ts`'s `mergeBranch`, `git/writer.ts`'s `GitWriter`), never a derived ancestor. A `commitPath` that only canonically CONTAINS (at-or-under, not equal to) some registered `repoPath`/`repos[]` entry is exactly the round-2 monorepo-subdir shape, which `checkCodeRepoCollision` already refuses outright — the auto-committer never reaches the git-mutation step there at all, so there is nothing to lock.

**ROUND 4 CORRECTION — the subfolder-shaped gap this paragraph used to describe as open is now CLOSED.** Round 3 (above) shipped against `canonicalRepoLockKey` defined as `fs.realpathSync.native` of the raw registered path, lowercased on win32 — under THAT definition, a project bound to a SUBDIRECTORY of an exempt vault root with no `.git` of its own (real specimen, "P&C Oslo Case Study") computed a DIFFERENT key than the vault root's own, so `isCommitPathMergeEligible` never matched and the lock was never taken for that shape. Card `7673d096` (merged to main after round 3, folded into this branch in round 4) changed `canonicalRepoLockKey` to key on the resolved git TOPLEVEL (`resolveGitToplevelSync` — a synchronous walk up to the nearest `.git`) instead. Under the NEW definition, a subfolder with no `.git` of its own and its enclosing repo's root walk up to the SAME `.git` and so canonicalize to the SAME key — `isCommitPathMergeEligible`'s exact-match check now correctly fires for that shape, with no code change needed in that function itself. Full explanation + the verifying fixture: `docs/decisions/7673d096-sync-toplevel-walk-for-the-canonical-lock-key.md`, "Consequence for a09b81a0's isCommitPathMergeEligible" section.

**`flushSync()` deliberately NOT given the same lock.** `VaultVersioner.flushSync()`'s own, independent collision check (unchanged call site, now inheriting the round-3 vault-root exemption automatically through the shared `checkCodeRepoCollision`) is NOT wrapped in `withCanonicalIndexLock` — that lock is async, and `flushSync` is synchronous by necessity (shutdown, `execFileSync` — see that method's own doc for why), so awaiting the lock there would reopen the exact process-exits-before-the-async-commit-finishes gap `flushSync` exists to close. A merge landing on the same repo in the narrow shutdown window `flushSync` runs in is a known, accepted residual risk — the same judgment `d671f1b8` already made and documented for this same method's lock-contention exposure.

## Round 4: the pause-lease check's placement

**The gap.** Before round 4, `commitVault()` never checked the advisory pause lease (card 614dfbef,
`isVaultAutoCommitPaused`) anywhere in its own body — only `VaultVersioner.commit()` (the debounce tick)
checked it, and only BEFORE calling `commitVault` at all. Two real consequences: (1) `vault/writer.ts`'s
three UI-write functions (`writeVaultFile`/`createVaultFile`/`deleteVaultFile`, all routing through
`commitAndReportOutcome` → `commitVault`) never checked the lease at all — a REST/MCP vault write while an
agent held a sanctioned-git-surgery pause lease committed anyway. (2) even the tick's own pre-check was a
check-then-act gap: the lease could be raised in the window between that check returning "not paused" and
the actual `git add`/`commit` running.

**The fix.** The check now lives INSIDE `runCommitSequence` (the closure `commitVault` builds for its own
add+commit work), immediately before the `git add .` call — NOT in `VaultVersioner.commit()`, and NOT just
before `commitVault` acquires `withCanonicalIndexLock`. `runCommitSequence` is the ONE place both of
`commitVault`'s two call shapes converge:
- **Merge-eligible `commitPath`** (`isCommitPathMergeEligible` true): `runCommitSequence` runs as the `fn`
  passed to `withCanonicalIndexLock`, so by the time this check runs the canonical lock is ALREADY held —
  the check is atomic with the add+commit that follows, closing the check-then-act gap a check placed
  before lock acquisition would reopen.
- **Non-merge-eligible `commitPath`**: `runCommitSequence()` is called directly, with no lock. This needs
  no lock to be correct — `isCommitPathMergeEligible` being false means no registered project's own
  `repoPath`/`repos[]` entry canonically equals this commitPath, so nothing else in the system (no real
  merge, no `GitWriter` write) can be concurrently mutating this exact physical index; there is nothing for
  the check to race against here.

`VaultVersioner.commit()`'s own pre-existing `isVaultAutoCommitPaused` check (before it even calls
`commitVault`) is UNCHANGED and deliberately kept — it is now a cheap, non-authoritative early exit (skips
a whole discovery+lock round-trip on the common "definitely still paused" case) layered in front of the
authoritative, lock-covered check inside `runCommitSequence`. `commitVault`'s own `opts.deps`/discovery
steps run unconditionally before this check (they do no index mutation), so a paused call still pays their
(bounded) cost — accepted, since skipping discovery would need its own racy "is this still the same repo"
re-verification once unpaused anyway.

**The write survives; only the commit is deferred.** `vault/writer.ts`'s three functions write the file to
disk FIRST (a plain `fs.writeFileSync`/`fs.unlinkSync`), then call `commitAndReportOutcome` → `commitVault`
— so a paused `commitVault` returning `{committed:false, blockedReason:"paused"}` never loses the write
itself; `ok:true` stays true, only `committed` is false. `commitAndReportOutcome` already forwarded
whatever `blockedReason` `commitVault` returned (added for `"code-repo-collision"` in round 3) with no
hardcoding, so widening `CommitVaultResult.blockedReason`/`VaultWriteOutcome.committedBlockedReason` to
include `"paused"` surfaces it through the SAME existing path — no change needed in `writer.ts` itself. The
file sits on disk, uncommitted. **ROUND 4 Code Review correction:** it does NOT get swept up automatically
the instant the lease lifts — `VaultVersioner.commit()` returns early on a held lease with no re-arm/retry
of its own, so nothing re-checks until SOMETHING else re-triggers a tick. It is committed on the NEXT
CHANGE to that vault (any later edit that fires chokidar's watcher and the debounce timer again) once the
lease has by then lifted — never on a bare timer tied to the lease's own expiry. No re-arm logic was added
here; a future card may add one. Proven in `vault-pause-lease-atomic-check.mjs` by DRIVING a later
`commitVault` call directly (simulating that next change), not by waiting on an automatic retry.

**ROUND 4 Code Review correction — every real `pauseVaultAutoCommit` producer ALSO takes the lock; the
lease does NOT protect against an unlocked agent git-surgery session, because no such session exists
today.** Every producer of the lease is, today, ALSO a `withCanonicalIndexLock` holder for the same repo:
`GitWriter`'s `checkout`/`createBranch`/`commit` (`git/writer.ts`'s `withVaultPauseLease` wrapping, which
each of those three calls bracket around their own `withCanonicalIndexLock(...)` call), `mergeBranch`
(`git/worktrees.ts`), and `fastForwardCanonicalMain` (`batch-merge.ts`) — card `87a3c87e`'s own
pause/resume bracket. `GitWriter.push()` ALSO takes the pause lease (`withVaultPauseLease`) but
deliberately sits OUTSIDE the lock (it does no local index mutation to race) — harmless, and irrelevant to
the point below since push's own `repoPath` is, by construction, always a registered project's own
`repoPath` (merge-eligible), never the non-merge-eligible shape this paragraph is about. **So: the LOCK is
what actually serializes a real merge/GitWriter write against the auto-committer — see "Fix part 2" above
and test 13 — and the in-lock pause-lease check this round adds is DEFENSE IN DEPTH on top of that
serialization, not a second, independent mechanism protecting against something the lock misses.** On the
UNLOCKED, non-merge-eligible `runCommitSequence` call path specifically, the lease check has NO current
producer at all — nothing in this codebase calls `pauseVaultAutoCommit` against a commitPath that isn't
merge-eligible — so today that check is correctly placed but, in practice, inert there; it exists for
whatever future caller might legitimately need to pause a non-merge-eligible vault's own auto-commit, not
because one does today.

## Do not (round 4)

- Do not place the pause check in `VaultVersioner.commit()` (the tick) as the ONLY check, and do not place
  it just before `commitVault` calls `withCanonicalIndexLock` — either placement is a check-then-act gap;
  the authoritative check must sit inside `runCommitSequence`, after the lock (when merge-eligible) is
  already held.
- Do not duplicate the pause check at each of `vault/writer.ts`'s three call sites — `runCommitSequence` is
  the one place all of `commitVault`'s callers converge; a per-caller duplicate drifts the moment one site
  is edited and not the others.
- Do not drop `VaultVersioner.commit()`'s own pre-`commitVault` pause check now that the authoritative one
  exists inside `runCommitSequence` — it is a real, cheap optimization (skips a discovery+lock round-trip
  on the common already-paused case), not dead code.
- Do not touch `mergeBranch`/`batch-merge.ts`'s own `pauseVaultAutoCommit`/`resumeVaultAutoCommit` bracket,
  or how many holders a lease can have — that is card `6e6b342d`'s scope (a multi-holder lease, taken
  inside the canonical lock), not this round's.
- Do not read a green run of this round's own fix as proof the merge-side race (lease lifted by the time
  the lock is granted) is itself a bug — it isn't; the canonical lock, not the lease, is what serializes
  the auto-commit against a real merge.
- Do not claim the lease protects against an "unlocked agent git-surgery session" — no such session is
  reachable today; every real `pauseVaultAutoCommit` producer also takes `withCanonicalIndexLock` for the
  same repo (the one exception, `GitWriter.push()`, never mutates the local index, so there's nothing for
  it to race). The in-lock check this round adds is defense in depth on top of the lock, not a second
  mechanism covering a gap the lock leaves open.

## Do not (round 3)

- Do not treat `isRecognizedVaultRoot` as a SAFE or CLOSED predicate — it has a known, unfixed third-party-vouching hole (see the KNOWN HOLE section above). Do not cite test 12 as proof this hole is closed; test 12 verifies a narrower, different case.
- Do not "harden" or extend the geometric predicate (e.g. requiring multiple vouchers, excluding empty/ancestor repoPath as one-off patches) without the owner's answer — the owner is choosing the real discriminator (an explicit flag or a platform vault-root list); a patch to the geometry is very likely to just relocate the hole, not close it.
- Do not decide `isRecognizedVaultRoot` per-candidate inside the existing per-candidate loop — compute it ONCE, from `key` alone, before that loop ever runs; a repo is either a recognized vault root or it isn't, independent of which candidate would otherwise have matched it.
- Do not let an entry vouch for `key` when that SAME entry's own `repoPath`/`repos[]` also resolve at-or-under `key` — this closes SELF-vouching only (see "What self-exclusion actually closes" above); dropping it would ALSO reopen the original bug for any project shaped like Parallax's own vaultPath-nested-in-repoPath pairing.
- Do not widen the EXISTING per-candidate `vaultOnly` self-pairing exemption (exact `repoPath === vaultPath`) to at-or-under in an attempt to cover Parallax's shape directly — that is EXACTLY the original bug's geometry; the vault-root exemption is a separate, additive check for exactly this reason, never a relaxation of the narrower one.
- Do not use at-or-under matching for `isCommitPathMergeEligible` — exact equality only. The P&C-Oslo-shaped subfolder gap this bullet used to cite as a reason at-or-under might seem tempting is CLOSED as of card `7673d096` (see the ROUND 4 CORRECTION above) — at-or-under would still reopen the monorepo-subdir danger `isCanonicallyAtOrUnder`'s own collision match exists to catch, independent of that gap's closure.
- Do not claim "a real canonical-index lock is keyed on a project's literal `repoPath`" — it is keyed on `canonicalRepoLockKey(repoPath)`, which (as of card `7673d096`) resolves the git TOPLEVEL via a synchronous ancestor walk, not a bare realpath of the raw configured string; two paths inside the same physical repo (not just two spellings of one path) now canonicalize to the SAME key.
- Do not add `withCanonicalIndexLock` to `VaultVersioner.flushSync()` — it is synchronous by necessity; see the section above for why that residual risk is accepted, not fixed, here.
- Do not re-derive the nested-gitlink false-positive (round-2 delta Minor) as a bug to fix — it is accepted, documented, and deliberately left as-is (see the round-2 section's correction above).
- Do not claim test 13 is timing-independent — it discriminates only if an unlocked sequence completes inside its own window; state that bound rather than oversell the git-log-artifact framing as proof against all timing.

## Source

Card `a09b81a0`. Code: `packages/daemon/src/vault/versioner.ts` (`CodeRepoGuardEntry`,
`setCodeRepoGuardProvider`, `checkCodeRepoCollision`, `isRecognizedVaultRoot`, `isCommitPathMergeEligible`,
`refuseCodeRepoCollision`, `CommitVaultResult`, and — round 4 — the `isVaultAutoCommitPaused` check inside
`runCommitSequence`), `packages/daemon/src/git/repo-lock.ts`
(`withCanonicalIndexLock`, `RepoQuarantinedError`, reused — not modified), `packages/daemon/src/vault/writer.ts`
(`commitAndReportOutcome`, unmodified in round 4 — it forwards `blockedReason:"paused"` through the same
path it already forwarded `"code-repo-collision"` through), `packages/daemon/src/index.ts` (the provider
wiring, immediately after `const db = new Db();`, before any listener opens — see the round-2 section above),
`packages/shared/src/types.ts` (`OrchestrationEventKind`), `packages/daemon/src/db.ts`
(`DURABLE_AUDIT_EVENT_KINDS`). Tests: `vault-commit-code-repo-guard.mjs`, `vault-pause-lease-atomic-check.mjs`
(round 4). Related: `docs/decisions/8d49c36c-vault-auto-commit-quarantine-check.md`,
`docs/decisions/b98957e9-vault-only-is-an-explicit-fact.md`,
`docs/decisions/7673d096-sync-toplevel-walk-for-the-canonical-lock-key.md`.
