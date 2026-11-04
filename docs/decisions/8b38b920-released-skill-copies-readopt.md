# 8b38b920 — surface injected skill copies Loom stopped managing, plus a human-only re-adopt

## The bug

`skills/inject.ts`'s overwrite/delete gate (`matchesRecordedFingerprint`, card `f4272888`) fails toward
KEEPING a copy whenever it can't prove the on-disk content is still Loom's own — correct for data safety,
but once that happens the name also drops out of the claiming session's manifest entry (`manifest.set
(sessionId, placed)` only ever records what THIS call actually (re)placed), so the copy is never touched
again. In a shared repo cwd (manager/platform/setup/auditor sessions, all on `project.repoPath`) this
silently freezes a skill — e.g. the `orchestrate` doctrine — for every later session there, with nothing
durable recording that it happened: every release site only ever `console.log`s.

Investigated and designed per the card's own investigate-first checkpoint (`worker_report blocked`,
approved by the manager with scope/mechanism decisions — see "What this card does" below).

## What this card does

1. **A durable `__released` record** (new reserved top-level key in the existing `FINGERPRINTS_FILE`
   sidecar, same posture as `__pendingReclaim`/`__lastPlaced`): `name -> {reason, firstSeenAt}`. Recorded
   at the two LIVE-session release sites (the `want`-loop re-copy skip, and the `myPrev` stale-prune skip
   — reason `"modified"`) and at the shared-cwd dead-claim give-up sites (`"unverifiable-legacy"` for a
   claim with no recorded fingerprint at all; `"modified"` for a dead claim whose content no longer matches
   any recorded fingerprint; `"abandoned"` for the 30-day age bound and the per-cwd pending-reclaim cap —
   content may be byte-identical to Loom's own placement there, so it must never read as "modified").
   Deliberately EXCLUDES the isolated-worktree dead-claim paths (manager-approved scope: worktrees are
   ephemeral and single-session, so a durable record there is noise).
2. **Clear + log, never silent** — `clearReleased` fires (a) inside the `want`-loop's placement-success
   branch, unconditionally, so ANY legitimate (re)placement clears a stale record (a human re-adopt, or the
   named residual: a hand-reverted copy whose content matches Loom's last placement again, silently
   resuming management with no prior visibility); (b) inside the `myPrev` prune loop's own successful-prune
   branch, for the symmetric case where a no-longer-wanted name's content matches again and is pruned
   instead of re-placed.
3. **A `__readopted` bridge** (a second new reserved key): the `want`-loop's early "unclaimed dir = the
   repo's own, never touch it" skip (`exists && !myPrev.includes(name) && !otherClaimed.has(name) &&
   !reclaimableNow.has(name)`) would otherwise permanently skip a freshly human-re-adopted name forever,
   since no live session's manifest claims it. `readopted.has(name)` is now ORed into that same skip
   condition (same treatment as `reclaimableNow`), so the very next live session whose `want` includes the
   name becomes its new manifest owner — at which point the placement-success branch above clears the
   `__readopted` entry too.
4. **Three human-only REST routes** (`gateway/server.ts`, never an MCP tool — same trust posture as every
   other skills-write route): `GET /api/projects/:id/skills/released` (list), `GET …/skills/:name/released-
   diff` (+ `?path=` for one file's two-way content — mirrors `store.ts`'s summary + content-on-demand
   shape for the global store's base/mine/shipped diff), `POST …/skills/:name/readopt`. The POST REQUIRES
   the caller to pass the `currentFingerprint` it was shown by the GET; `reAdoptReleasedSkill` refuses
   (`"fingerprint-mismatch"`) if the on-disk copy has changed since, so a concurrent hand edit between the
   diff and the click is never discarded unseen.

## Scope decisions (owner/manager-approved, not re-derivable from the code alone)

- Record ONLY the two live-session sites + the four shared-cwd dead-claim give-up sites. The isolated-
  worktree dead-claim sites are deliberately excluded — do not add them without a fresh ask.
- `"abandoned"` is a DISTINCT reason from `"modified"` — do not fold the age/cap give-ups into `"modified"`;
  they are not a claim that a human edited anything.
- Surface for THIS card is daemon + REST only (`GET …/skills/released`, `GET …/skills/:name/released-diff`,
  `POST …/skills/:name/readopt`). No MCP tool, no web panel — both are named follow-up cards.

## Do not

- Do not let any new release/clear site skip `recordReleased`/`clearReleased` just because the existing
  `console.log` already fires — the log is NOT durable; the whole point of this card is a record a human
  can read later, independent of whatever is in the daemon's rotating stdout.
- Do not refresh `firstSeenAt` on a repeat sighting of the same release — `recordReleased` returns early if
  an entry already exists, mirroring `PendingReclaimRecord.firstSeenAt`'s own "never refreshed" discipline.
- Do not add a NEW reason value without updating `sanitizeReleasedRecord`'s own literal union check — an
  unrecognized `reason` must be treated as a corrupt entry (dropped, never trusted), not silently accepted.
- Do not let `reAdoptReleasedSkill` write the fresh copy without re-verifying `expectedFingerprint` against
  the LIVE on-disk fingerprint first — never auto-overwrite, anywhere, under any caller.
- ⛔ **CORRECTED (fix round, 2026-11-04 — this bullet was WRONG and shipped a CRITICAL bug):** this used to
  say "do not add `readopted.has(name)` to the fingerprint-match `if` block... a freshly re-adopted name has
  nothing recorded yet to match against." That premise is FALSE: `reAdoptReleasedSkill` sets a fresh
  `lastPlaced` entry for `name` the moment it writes (see its own doc), so a re-adopted name has exactly as
  real a `lastPlaced` fact as a `myPrev`/`otherClaimed` name. Omitting `readopted.has(name)` from that gate
  let the next live session's `want`-loop fall through to `copySkillAtomic` UNCONDITIONALLY for a readopted
  name with no live claimant yet — silently overwriting ANY hand edit made after the re-adopt, in an
  unbounded window (`readopt(correct fp)` → edit again → `injectSkills(fresh session)` → the second edit is
  lost with no trace). **The correct rule is the opposite of what this bullet said: `readopted.has(name)`
  MUST be included in both the early "repo's own, skip" condition AND the fingerprint-match gate.** See
  `inject.ts`'s `want`-loop for the fix.
- Do not resolve `obsidianEnabled` for the REST readopt handler any way other than `resolveConfig(project
  .config).obsidian.autoStart` — that is the SAME source a live session's own spawn reads (via
  `sessionEnv.LOOM_OBSIDIAN_AUTOSTART`), and diverging would silently deliver a different fragment-append
  decision than a live session would have made for the identical project.
- Do not expose `reAdoptReleasedSkill`, or any other write in this mechanism, as an MCP tool — human-only
  REST, by explicit manager decision; an agent-facing surface for this is a separate, unstarted follow-up.
- Do not let `releasedSkillsAt`/`releasedSkillDiffSummary`/`releasedSkillDiffFile`/`reAdoptReleasedSkill`
  compute `claudeSkillsDir(cwd)` directly — all four, plus `injectSkills`, must resolve it through the ONE
  shared `resolveSkillsTargetDir` chokepoint (fix round, item 2), which runs the SAME escape check
  `injectSkills` has always run. Before this fix, the three REST-facing functions had no escape check at
  all — a `.claude`/`.claude/skills` junction could steer a human's released-diff read or readopt click into
  reading or writing outside the repo.
- Do not let `reAdoptReleasedSkill` clear the `__released` record when `fingerprintSkillDir` returns null
  after the copy (fix round, item 5 nit) — delete `released` and set `__readopted` together, or not at all;
  clearing one without the other leaves the name neither released (a human loses visibility) nor readopted
  (no live session's "repo's own" skip ever revisits it either).
- ⛔ **Never `await` anything between `reAdoptReleasedSkill`'s sidecar read (`readFingerprintsFile`) and its
  write (`writeJsonAtomic`)** (fix round 2, item 1, CRITICAL TOCTOU) — any await in that window lets a
  concurrent synchronous `injectSkills` call (or a human hand edit a caller already validated the
  fingerprint against) interleave with this function's own read-modify-write, and this function's own
  write-back then silently reverts or discards whatever changed during the window. Run every await this
  function needs (today: the git tracked-check) BEFORE the sidecar read, never after.
- Do not re-introduce a plain boolean for `tracked` anywhere in this mechanism (fix round 2, item 3) — it
  is `GitTrackedState` (`"tracked" | "untracked" | "unknown"`); a failed/unverifiable check reports
  `"unknown"`, never a bare `true` (that would be a false "confirmed tracked" claim) or `false` (that would
  silently clear the way for an overwrite the check never actually confirmed was safe).
- Do not add a new per-skill-dir escape check without threading it through `releasedSkillDiffSummary`,
  `releasedSkillDiffFile`, AND `reAdoptReleasedSkill` together (fix round 2, item 5) — `perSkillDirEscapes`
  exists precisely because `resolveSkillsTargetDir` does not cover the per-name dir; a fix to only one of
  the three leaves the other two still readable/writable through an escaping junction.

## Fix round (2026-11-04) — Code Review `202eb7be` findings, all addressed

1. **CRITICAL** — the re-adopt overwrite-gate bypass above (the corrected "Do not" bullet). Fixed by
   including `readopted.has(name)` in the `want`-loop's fingerprint-match gate; a post-readopt mismatch now
   also drops the stale `__readopted` marker so the name reads as genuinely unclaimed again. Regression
   test: `skills-released-readopt.mjs` section 9 (readopt → edit → live session ⇒ the edit survives and the
   name is released again).
2. **MAJOR** — `reAdoptReleasedSkill` and both diff helpers (`releasedSkillDiffSummary`,
   `releasedSkillDiffFile`) skipped `injectSkills`'s own `escapedAncestor` refusal entirely. Fixed by a
   single shared resolver, `resolveSkillsTargetDir`, that all four exported functions (plus `injectSkills`)
   now call. Regression test: a `.claude` junction on the REST path (`skills-released-rest.mjs`) is refused
   on all three routes.
3. **Minor** — REST-level `?path=../..` traversal on `released-diff`, and an invalid skill name on
   `POST .../readopt`, are now covered at the REST layer (`skills-released-rest.mjs`), not just at the
   direct-function layer.
4. **LEAD DECISION** — `reAdoptReleasedSkill` now REFUSES (`code: "tracked"`, REST 409) when any file under
   the released dir is git-tracked, via a new `isAnyFileGitTracked` helper (bounded `git ls-files`, fails
   CLOSED toward "tracked" on error). `tracked: boolean` is exposed on both `releasedSkillsAt`'s list
   entries and `releasedSkillDiffSummary`'s diff, so a human sees WHY a readopt will be refused before
   trying it. This makes `releasedSkillsAt`/`releasedSkillDiffSummary`/`reAdoptReleasedSkill` all `async`
   (the only production callers are the REST handlers above, already `async`). **SUPERSEDED in fix round 2
   item 3 below** — `tracked` is now a tri-state (`GitTrackedState`), not a plain boolean; `isAnyFileGitTracked`
   was renamed `gitTrackedState`.
5. **Nits** — reworded the "hand-reverted copy resumes management" claim (both here and in `inject.ts`'s
   own comments) to state it only holds while a live session (`myPrev`/`otherClaimed`/`readopted`) still
   claims the name; and fixed the `fingerprintSkillDir`-returns-null-after-copy ordering bug named above.

## Fix round 2 (2026-11-04) — Code Review `202eb7be`'s second pass, all addressed

1. **MAJOR (TOCTOU, blocking, reproduced)** — fix round 1 made `reAdoptReleasedSkill` `async`, but its
   read-modify-write of the sidecar straddled an `await` (the tracked-check git subprocess, up to
   `UNTRACKED_CHECK_TIMEOUT_MS`): it read the sidecar + checked the fingerprint, THEN awaited, THEN wrote
   back its now-STALE in-memory snapshot. A hand edit, or a concurrent synchronous `injectSkills` call on
   the same sidecar, made during that await window was silently lost — either overwritten (a hand edit that
   should have failed the fingerprint check, had it been re-checked after the await) or clobbered in the
   write-back (another name's sidecar entry, written by `injectSkills` during the window, reverted to the
   pre-await snapshot). Fixed by moving the ONLY await — the tracked-check — to the very top of the
   function, before the sidecar is read at all; everything from the sidecar read to the final
   `writeJsonAtomic` is now one uninterrupted synchronous block, so nothing else in the process can
   interleave. Regression test: `skills-released-readopt.mjs` section 9 still covers the live-session half
   of this; the TOCTOU fix itself is structural (there is no longer an await for anything to interleave
   with) rather than covered by a dedicated repro — see the "Do not" bullet below.
2. **MINOR (previously vacuous test)** — the REST junction test (`skills-released-rest.mjs`) escaped into
   an EMPTY directory, so every assertion passed identically whether or not the escape check ran at all —
   an unguarded resolver would ALSO find nothing to list/diff/readopt. Fixed by seeding the escaped target
   with a real `.loom-skills-fingerprints.json` (`__released.loom-x`) plus a real `loom-x` skill dir, so an
   unguarded resolver WOULD have something real to list/diff/readopt into.
   **Mutant-proved manually** (against `dist/skills/inject.js`, applied/tested/restored — not a permanent
   change) by forcing `resolveSkillsTargetDir`'s `escaped` to `null`: the LIST route flips (a non-empty
   list) — `releasedSkillsAt` has no second check. The DIFF and READOPT routes do NOT flip under that one
   mutation alone: item 5's separate `perSkillDirEscapes` check (below) ALSO catches this exact scenario —
   `.claude` being a junction makes the per-name dir "escape" through that same junction — so they're
   doubly protected. This is genuine defense in depth, not a gap in the test; the REST test's own readopt
   assertion accepts either escape-refusal wording for exactly this reason. See SECTION 12 of
   `skills-released-readopt.mjs` for the mutant that proves item 5's check load-bearing on its own, with a
   real junction at the per-name dir rather than at `.claude` itself.
3. **MINOR (tri-state)** — a failed/unverifiable tracked-check used to report `tracked:true` (fail-closed,
   but a FALSE claim: "has at least one git-tracked file" when the truth is "couldn't tell"). `tracked` is
   now `GitTrackedState = "tracked" | "untracked" | "unknown"`; `reAdoptReleasedSkill` refuses `"unknown"`
   too, with its own code (`"track-unknown"`) and message ("could not verify whether the copy is
   git-tracked"), mapped to the same 409 bucket as `"tracked"` at the REST layer. `isAnyFileGitTracked` is
   renamed `gitTrackedState`.
4. **NIT (batched)** — `releasedSkillsAt` used to run `Promise.all` over every released entry (up to
   `RELEASED_MAX_PER_CWD` = 200), i.e. up to 200 concurrent `git ls-files` per GET. Replaced with
   `batchGitTrackedStates`: ONE `git ls-files -- .claude/skills` per shared repo root, matched against
   every name in-process; a name whose own innermost repo root diverges from the shared one (its skill dir
   is itself a nested repo) still gets an individual `gitTrackedState` call, so the rare case isn't
   silently mis-answered just to avoid the second call.
5. **INVESTIGATE+FIX** — `resolveSkillsTargetDir` only guards the `.claude`/`.claude/skills` ANCESTORS; it
   never checked the PER-SKILL dir itself. A `.claude/skills/<released-name>` that is ITSELF a
   symlink/junction escaping `cwd` would have let `releasedSkillDiffSummary`/`releasedSkillDiffFile` read
   through it into a human's diff view, and let `reAdoptReleasedSkill` copy the store's content INTO it.
   Fixed with a second, separate check (`perSkillDirEscapes`) at each of those three call sites.
   **Deliberately does NOT touch `injectSkills`'s own per-name placement logic** — that function's
   handling of a per-name symlink/junction is unchanged by this card and remains a NAMED RESIDUAL: it was
   out of scope for this investigation (manager-approved), not verified safe.

## Fix round 3 (2026-11-04) — Code Review `202eb7be`'s third pass, three cheap items

1. **Minor** — the pre-await `resolveSkillsTargetDir`/`perSkillDirEscapes` checks in `reAdoptReleasedSkill`
   were never repeated after the up-to-`UNTRACKED_CHECK_TIMEOUT_MS` await (`gitTrackedState(dest)`), so
   something swapping `.claude`/`.claude/skills`/the per-name dir for a junction DURING that window — to a
   target whose content happens to match the fingerprint check — could steer the eventual copy outside
   `cwd`. Fixed by re-running both checks, synchronously, immediately after the await and before the
   sidecar is ever read, with the same refusal codes/messages as the pre-await checks. The `gitTrackedState`
   answer gathered during that same await is inherently a pre-await-window fact regardless — a concurrent
   `git add` happening in the window is never seen by it — and that gap is not fixed here; it is not
   fixable without a lock around the whole operation, which this card does not add.
2. **Minor** — `batchGitTrackedStates`'s `git ls-files` call let git's own default `core.quotePath=true`
   C-quote any non-ASCII filename in its output (e.g. a literal `é` comes back as `"\303\251.md"`), which
   then never matched the plain `rel` path string built in-process, so a released skill whose only tracked
   file had a non-ASCII name was silently misreported `"untracked"` — clearing the way for a readopt to
   overwrite real, repo-owned content. Fixed with `-z` (NUL-separated, never quoted), parsed by splitting
   on `"\u0000"` instead of `"\n"`.
3. **Nit** — `skills-released-rest.mjs` had no REST case for the `"track-unknown"` refusal (409); added one,
   and confirmed `server.ts`'s own `|| r.code === "track-unknown"` mapping is load-bearing (dropping it
   turns the response into an uncaught 500).

## Residuals (not closed by this card)

- `injectSkills`'s own per-name placement path does not run `perSkillDirEscapes` (or any equivalent
  check) — only the three released/readopt readers/writer do (fix round 2, item 5). Whether a
  `.claude/skills/<name>` symlink/junction is safe against `injectSkills`'s own copy-in logic has not been
  investigated by this card.
