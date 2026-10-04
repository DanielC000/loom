# 29f22d83 — marker-scoped, boot-time removal of the stale codex `/AGENTS.md` exclude line

Follow-up to card `9bf0db97` (delta Code Review `459e7372`, Minor 2). Before `9bf0db97`,
`hideCodexDoctrineFromGit` unconditionally appended `/AGENTS.md` to `resolveGitDirsSync(cwd).commonDir`'s
`info/exclude`, even for a LINKED worktree — where `commonDir` is the repo's SHARED `.git` dir, also read
for the MAIN checkout. `9bf0db97` stopped writing that line for a linked worktree, but never removed a
line already written by round 1's behavior — so on an upgraded host, a repo whose codex worker once ran in
a linked worktree before the fix can still carry the line in its main checkout's `info/exclude`, silently
hiding a human's own later root `AGENTS.md` from `git status`/`git add -A`, with nothing left to ever
write (or remove) that line again.

## Why marker-scoped, not "remove any `/AGENTS.md` line"

`skills/inject.ts#hideFromGit` writes its own skill/manifest/settings entries under the EXACT SAME header
(`LOOM_EXCLUDE_HEADER`, byte-identical in both files) — confirmed by reading both call sites before writing
this fix. A blind "delete every `/AGENTS.md` line in the file" would also risk deleting a user's own
hand-written `/AGENTS.md` exclude entry sitting anywhere else in the file, which this fix must never touch.
So removal is scoped to a line that is itself the header, and within that header's run, ONLY the line in
the FIRST position right after the header is ever a removal candidate (round 2 — see below); a line further
into the same run is still recognized for scan-continuation purposes but is never removed just for matching
`/AGENTS.md`'s text.

## Round 2 (CR `ce9c4156` on `29228734`) — the run-continuation scan was still too wide

Round 1 scoped removal to "a recognized entry directly following the header or another recognized entry,
with no gap" — but every `isKnownLoomExcludeEntry` match in that run was treated as equally removable
wherever it sat. `skills/inject.ts#hideFromGit` runs on EVERY claude worker spawn and can append its own
header + skills-entries run at any time; a human's `echo /AGENTS.md >> .git/info/exclude` lands at the END
of the file, directly after whichever Loom run was written last (typically that skills run), with no header
of its own in between — making it LOOK like part of that run even though it's genuinely user-authored. The
real historical Loom write never produced that shape: every write (`c4f875f3` through `29228734`) appended
`HEADER\n/AGENTS.md\n` as its OWN one-entry block, nothing else in the same run. So removal is now gated on
POSITION, not just recognition: only the line immediately after the header (position 0 of its run) is ever
a removal candidate.

Round 2 also closed three more gaps, found in the same review:

- **Byte preservation.** The original read as `utf8` and rejoined with a single `\n`-separated
  `.join("\n")` — on a CRLF `info/exclude` (the common case on a Windows host with `core.autocrlf`, or any
  repo a Windows git client touched) this would have silently rewritten every surviving line's terminator
  to bare LF, and a non-UTF-8 byte sequence elsewhere in the file (a user's own comment in another encoding)
  could have been corrupted on read before ever reaching the write. Fixed by reading/writing via `latin1`
  (a reversible 1-byte-to-1-code-unit mapping) and tracking each line's OWN terminator
  (`splitExcludeLinesPreservingEol`) rather than normalizing to one style.
- **Atomic write + mode preservation.** The original wrote `excludePath` directly — a crash mid-write could
  leave git reading a truncated exclude file. Now temp-file + rename (mirroring
  `skills/inject.ts`'s own manifest write), with the original file's mode read via `stat` before the write
  and re-applied to the temp file before the rename, so a `chmod`'d `info/exclude` doesn't silently pick up
  the temp file's umask-derived mode instead.
- **The "bounded" claim on the boot sweep was false.** The original comment in `index.ts` claimed this sweep
  was "bounded the same way `resolveGitDirsSync` itself already is" — but `resolveGitDirsSync` is plain
  synchronous `fs.statSync`/`readFileSync` with no timeout of its own; nothing about it is actually bounded
  against a hung filesystem. The per-repo git-dir resolution stays synchronous (same cost class already paid
  for these repos elsewhere at boot — changing it is a much larger, unrelated refactor, out of this card's
  scope), but the exclude-file read/write/rename this card owns is now genuinely bounded: `fs.promises`
  (off the main event loop) plus a per-step timeout, so an unreachable repo path can't hang this sweep or
  tie up a threadpool slot indefinitely.

## Why boot-time, per registered repo (not only at the next codex worktree-write)

Piggybacking on `hideCodexDoctrineFromGit`'s existing linked-worktree no-op branch would only clean a repo
the next time a codex worker spawns into one of its linked worktrees — which may never happen again (the
user could have stopped using codex workers entirely, or switched every profile back to claude). The bug
this record fixes (a human's own `AGENTS.md` silently hidden) can surface at any time, independent of codex
activity, so cleanup is run once per DISTINCT registered repo on EVERY boot instead — reusing the same
`canonicalRepoPaths` set `index.ts` already builds for the quarantine-reentry/merge-residue boot scans.
Kicked via `setImmediate` after the gateway starts listening, mirroring the other best-effort boot scans
(`scanCanonicalReposForMergeResidue`, `reconcileOrchestrationOnBoot`) — never on the synchronous pre-listen
path, so a slow/wedged filesystem on one repo can't delay accepting requests. "On every boot" describes
when this is CALLED, not how much work it does each time — see round 3 below for why repeated calls are
cheap and, after the first completed scan, do nothing at all.

## Two-path asymmetry: why a live-session guard instead of deleting the dead write branch

`hideCodexDoctrineFromGit`'s own `appendToSharedExclude` write only fires when `privateDir === commonDir`
(a plain, non-worktree repo) — but `injectCodexDoctrine` (its only caller) returns immediately for any role
other than `worker`, and every real worker spawn's `cwd` IS its linked worktree (`privateDir !== commonDir`
always holds there). So today that write branch is genuinely unreachable from any real spawn. Two ways to
resolve that asymmetry were considered: (a) delete the dead branch outright, making "stale" structurally
unconditional-safe-to-remove; (b) keep the branch and instead add a live-codex-session re-check to the
prune, mirroring `removeStaleCodexDoctrineArtifact`'s own discipline. **(b) was chosen**: the hermetic test
suite (`codex-doctrine-injection.mjs`) exercises `appendToSharedExclude` directly, through
`injectCodexDoctrine(cwd, "worker")` against a non-worktree fixture repo, as a unit test of the underlying
git-hygiene helper independent of the real worker-is-always-worktree invariant; deleting the branch would
also require rewriting that coverage for no safety gain today. The guard costs one extra parameter and one
re-check immediately before the destructive write — it defends a currently-dead-but-still-tested path
against a hypothetical future caller (e.g. if `HARNESS_FLEET_ROLES`, card `4c4eb9af`, ever widens codex
execution to a non-worktree `cwd`), never a live production race that exists today.

## Round 3 (delta CR `cb4dae72` on `54db23dc`) — removal and re-boot could conspire to lose a user's line

Round 2's position rule (only the line directly after a header is a removal candidate) was correct for a
SINGLE pass, but boot-to-boot composition broke it. Input `HEADER\n/AGENTS.md\n/AGENTS.md\n` — Loom's stale
entry immediately followed by a user's own identically-texted line, under the SAME header: boot 1 correctly
removed only the first (position-0) entry, but then re-emitted the header followed by the SURVIVING second
line — `HEADER\n/AGENTS.md\n` — which is now, textually and positionally, indistinguishable from the exact
shape this function treats as removable. Boot 2 deleted the user's own line, having done nothing wrong by
its own single-pass rule; the bug was in what boot 1 chose to leave behind.

Two independent fixes were shipped, deliberately BOTH (neither alone is sufficient):

- **(a) Never leave a recognized `/AGENTS.md`-shaped line first under a surviving header.** When the kept
  remainder's first entry is itself `/${CODEX_DOCTRINE_FILE}`-shaped, the header is dropped instead of
  re-emitted ahead of it. The line survives; it just isn't captured as "right after a header" any more, so
  no later pass can mistake it for round 1's write. This alone fixes the two-boot repro, and it is still the
  design today — round 4 did not touch it.
- **(b) A permanent, marker-based done state per `commonDir`.** (a) only protects the SHAPE this one pass
  produces; it says nothing about a header-then-`/AGENTS.md` shape arriving some OTHER way later. Round 3's
  OWN implementation of (b) — `PRUNE_DONE_MARKER_TEXT`, an in-file comment line appended to `info/exclude`
  itself — is GONE as of round 4; see that section below for why and what replaced it. The PRINCIPLE (b)
  survives unchanged: some durable per-commonDir "already handled" state is required in addition to (a).

**Item 2 (round 3's own fix, since REPLACED — see round 4) — a lost-update race, introduced by round 2's
own async conversion.** `hideFromGit`/`appendToSharedExclude` both write with plain SYNC `fs` calls and can
land in the `await` gap between this function's initial read and its eventual temp-file write. Round 3's
fix re-read the file immediately before the temp-file WRITE and compared it byte-for-byte against what was
read at entry — but that left the write/chmod/rename `await` chain AFTER the re-read completely unguarded,
which round 4's own delta CR reproduced directly. See round 4 below for the actual fix.

**Item 3 — the commonDir-dedupe test was non-discriminating.** `removed.length === 1` after feeding two
repoPaths sharing one commonDir stays true even with the `seenCommonDirs` Set deleted entirely, because a
second real call onto an already-pruned file is ALSO a no-op, for a completely different reason (the
function's own idempotency, not the sweep's dedupe). The fix: a live-session callback that unconditionally
reports a live session (so the file is never actually written, and stays "removable" across repeated
hypothetical visits) turns callback-invocation COUNT into a true measure of how many times the per-commonDir
dedupe let a call through — deleting `seenCommonDirs` now flips that count from 1 to 2. Unchanged by round 4.

**Item 4 — stated residual, unchanged by round 4.** A user who hand-places their OWN `/AGENTS.md` line
directly first after a Loom header (the one position this function must treat as a removal candidate) is
indistinguishable from round 1's write and is removed exactly once. The done-marker then permanently
protects against a repeat, but it cannot protect that one first placement — nothing distinguishes it from
the actual bug this function exists to fix. `pruneDoneMetaKeyForCommonDir`'s normalization (round 5 note,
delta CR on `60528c1f`) is CASE-normalized (win32 only) but NOT realpath-normalized — a repo path re-spelled
via a filesystem junction or an 8.3 short alias resolves to a DIFFERENT key for the SAME real `commonDir`,
so that repo's prune rescans once under the new spelling even though it was already marked done under the
old one; this residual then composes with the one above — a rescan under a new spelling is a second chance
for a genuinely header-first user `/AGENTS.md` line to be removed again.

## Round 4 (delta CR on `f3ef144c`) — the lost-update fix still had a gap, and the marker design was wrong

**Item 1 (BLOCKING) — round 3's lost-update fix re-read too early.** Its re-read ran BEFORE three more
`await`s (the tmp-file write, the chmod, the rename) — the reviewer reproduced a concurrent in-process write
landing in exactly that window against round 3's own build (`f3ef144c`), clobbering it silently (outcome
`"removed"`, concurrent line gone). Fixed by reordering: write + chmod the TMP file first (nothing in the
REAL file has changed yet, so this part can stay async), then perform the final re-read, byte-compare, and
rename as ONE synchronous block (`fs.readFileSync`/`fs.renameSync`, no `await` or yield anywhere inside it)
— nothing else can run on this process's single JS thread between the compare and the commit, closing the
in-process race entirely. Residual, stated plainly: an EXTERNAL, out-of-process writer (a human's text
editor, another `git` client) racing the exact OS-level moment between the sync read and the sync rename is
not closed by this fix and structurally can't be from inside one Node process — accepted as a
lower-probability window than the in-process one this round fixes.

**Item 2 (BLOCKING) — the in-file marker design was wrong, not just incomplete.** `PRUNE_DONE_MARKER_TEXT`
(round 3) never stamped the `"none"` branch at all — contradicting its own doc, which claimed it did. Lead
decision: rather than patch that omission, the in-file marker is GONE. Replaced with
`PruneDoneMarkerStore` — a minimal `{getMeta, setMeta}` shape (structurally satisfied by `Db`, passed by
duck typing) keyed per normalized `commonDir` (`pruneDoneMetaKeyForCommonDir`), stamped on BOTH `"removed"`
AND `"none"` (never on `skip-live-codex`/`lost-update`/`no-file`/`error`). This is a strictly better design,
not merely a bugfix for the omission: NOTHING is ever written into a clean user repo's `info/exclude` just
to record Loom's own bookkeeping — a "none" repo (nothing stale, maybe never even Loom-touched) now stays
byte-identical forever, where round 3's design would eventually have stamped a marker into every registered
repo's exclude file (once the omission was merely patched rather than replaced).

**Item 3 — `hasLiveCodexSessionAtCommonDir`'s own doc was wrong, and the guard was over-broad.** The doc
claimed the guard was inert in production (reasoning from the boot sweep's own `setImmediate` timing
alone) — false: companion revive and boot-resume both run interleaved with the same boot sequence and can
bring a session back to `alive` before the sweep fires. Worse, the guard didn't just fail to be inert — it
matched ANY live codex session sharing the target `commonDir`, including an ordinary WORKER in a LINKED
worktree (`privateDir !== commonDir`), which has no relationship to the entry this prune removes at all
(`hideCodexDoctrineFromGit` never writes it for that shape). An active project can have a live worker on
effectively every boot, so the unnarrowed guard meant this prune would never actually run against a repo
anyone was using. Fixed by narrowing the match to `privateDir === commonDir` — the one shape the entry was
ever written for.

**Item 4 — nit.** Sibling worktree directory names in the test suite now derive from their own `main`
fixture's mkdtemp-random suffix (`` `${main}-wt` ``) rather than a fixed literal, which could collide across
concurrent test runs sharing the same temp root.

## Do not

- Do not remove a `/AGENTS.md`-shaped line that isn't in the FIRST position directly after
  `LOOM_EXCLUDE_HEADER` in its own run — a later line in the same run that happens to read `/AGENTS.md`
  (e.g. a human's `echo /AGENTS.md >> .git/info/exclude` landing right after a skills run) must survive,
  exactly like a user-authored `/AGENTS.md` line sitting outside any run.
- Do not re-emit a header immediately followed by a surviving `/AGENTS.md`-shaped line (round 3) — drop the
  header in that case instead, or the next boot's scan will mistake the survivor for round 1's write.
- Do not rely on the position-based fix (a) alone as "the" fix for the two-boot bug — pair it with the
  `PruneDoneMarkerStore` done-marker (b); (a) only protects this one pass's own output shape, not a
  header-then-`/AGENTS.md` shape arriving some other way later.
- Do not stamp the store's done-marker on `skip-live-codex`, `lost-update`, `no-file`, or `error` — only a
  terminal `removed`/`none` outcome may be treated as permanently settled. (Round 4: this now applies to
  BOTH terminal outcomes, not `removed` alone — round 3's own marker never stamped `none`, which was itself
  a bug.)
- Do not write the done-marker INTO the exclude file (round 3's `PRUNE_DONE_MARKER_TEXT`, removed in round
  4) — that writes into every clean user repo's `info/exclude` just to record Loom's own bookkeeping. Use
  `PruneDoneMarkerStore` (an app_meta-shaped key/value store) instead.
- Do not re-read-and-compare before the tmp-file write/chmod/rename `await` chain (round 3's own shape) —
  anything after that re-read is still an unguarded window. The final re-read, compare, and rename must be
  ONE synchronous block with no `await`/yield inside it, running AFTER the tmp file is already fully
  written.
- Do not let `hasLiveCodexSessionAtCommonDir` match a live codex session whose OWN `cwd` resolves to a
  LINKED worktree (`privateDir !== commonDir`) — narrow to `privateDir === commonDir`, the only shape the
  entry this prune removes was ever written for. An unnarrowed guard blocks pruning an active project's
  commonDir on effectively every boot.
- Do not assume this guard is inert in production because the boot sweep fires early via `setImmediate` —
  companion revive and boot-resume can bring a session back to `alive` before the sweep runs.
- Do not trust `removed.length` alone to prove the commonDir-dedupe is doing real work — once a per-commonDir
  prune is idempotent on its own, a second real call onto an already-clean file is a no-op for either
  reason, with or without the dedupe. Count actual per-commonDir invocations (e.g. via an always-live
  session callback) to make the dedupe test discriminating.
- Do not remove `hideFromGit`'s own skill/manifest/settings entries sharing the same header — only the
  codex `/AGENTS.md` entry is stale; the skills entries are still live and written on every claude spawn.
- Do not run this on the synchronous pre-`app.listen()` boot path — it has no security-gate urgency (unlike
  quarantine re-entry) and must never be able to delay accepting requests on a slow filesystem.
- Do not shell out to `git` for this — plain `fs` only, matching `hideCodexDoctrineFromGit`/
  `appendToSharedExclude`'s own existing discipline for managing this same file.
- Do not drop the orphaned-header cleanup (a header whose entire recognized run was the stale entry) as
  "good enough to just remove the entry" — leaving a bare header with nothing under it is avoidable noise
  this same pass already has everything it needs to clean up.
- Do not read/write `info/exclude` as `utf8` or rejoin lines with a single chosen separator — that silently
  normalizes every surviving line's terminator and can corrupt a non-UTF-8 byte sequence elsewhere in the
  file. Use `latin1` and each line's own tracked terminator.
- Do not write `info/exclude` directly (no temp file + rename) — a crash mid-write must never leave git
  reading a truncated exclude file, and the write must preserve the original file's mode.
- Do not delete `appendToSharedExclude`'s non-worktree write branch to "fix" the two-path asymmetry above —
  it is covered by hermetic tests exercising it directly; add the live-session re-check instead (see above).
- Do not claim the boot sweep is "bounded" without saying what, specifically, is bounded — `resolveGitDirsSync`
  itself is still plain synchronous fs calls with no timeout; only the exclude-file I/O this card owns is
  genuinely bounded (async + per-step timeout).
