# 6f27469b — garbage-collecting stored inbox attachments

Card `6f27469b`, child 3 of epic `7d1d66ab`. Bounds the disk cost of child `432765ab`'s copy-at-send
store (`<LOOM_HOME>/attachments/<questionId>/…`) by deleting a request's stored attachments once the
request is TERMINAL plus a retention window.

## Cadence: boot-only, not a periodic watcher

The sweep runs once, fire-and-forget, from `SessionService.reconcileRunsOnBoot()` (`sessions/service.ts`)
— the same call site that already fires `runBootScratchGcSweep` (card `9775559c`) and
`sweepOrphanedSettingsDirSecrets`. No new `setInterval` watcher was added.

**Consequence a reader must know:** on the self-hosting `daemon:stable` path, the supervisor only
restarts the daemon process on an explicit `daemon_restart` or a crash — it can run for days or weeks
between restarts. An attachment that becomes GC-eligible mid-uptime is NOT collected until the daemon's
NEXT boot, not when it first becomes eligible. This is accepted, matching the existing posture of every
other GC-style directory sweep in this codebase (scratch-gc, mcp-config-gc) — none of them run on an
interval either.

## Terminal-state timestamp mapping

`questions.state` is `'pending' | 'answered' | 'consumed' | 'cancelled' | 'notice'` (db.ts). The terminal
timestamp `Db.listAttachmentGcCandidateIds` keys eligibility on:

- `state = 'consumed'` → `consumed_at`
- `state = 'cancelled'` → `cancelled_at` — covers BOTH `question_cancel` and dismiss; there is no separate
  `'dismissed'` state, only `cancelled_by: 'agent' | 'human'` distinguishing them.
- `state = 'notice'` → `read_at`, **only once non-null**.
- `state = 'pending'` / `'answered'` → never eligible (no terminal timestamp exists for them at all).

### Why an unread notice has no age-based fallback

The kickoff's original design asked for "a notice after its own lifetime," with a fallback of
`COALESCE(read_at, created_at + <the Inbox's own notice visibility window>)` if such a window exists.

It was verified at source that **no such window exists in the current codebase.** `NOTICE_INBOX_WINDOW_MS`
— a 7-day age-based stopgap used by an earlier round of card `59fa6403` — was **deleted outright**, not
merely superseded, once card `54007ab7` (Phase 2 of `59fa6403`) shipped read/unread tracking:
`docs/decisions/59fa6403-requests-to-inbox.md` states explicitly "the `NOTICE_INBOX_WINDOW_MS` constant
itself is DELETED (not deprecated) — it has no remaining caller." Every live notice-visibility check in
`db.ts` today (`listOpenQuestions`, `listQuestionsForAudit`) gates purely on `read_at IS NULL`, with an
explicit comment that "age no longer matters here at all."

So an unread notice is, by the *current, intentional* design of the Requests inbox, meant to stay visible
indefinitely until a human reads it. Attachment GC mirrors that: an unread notice is never eligible,
exactly like a `'pending'`/`'answered'` request — there is no age fallback to borrow, and inventing one
would silently diverge from what the rest of the inbox already does.

## Containment — one check that actually fires, one defense-in-depth layer, and a third hazard that needs no special-case

`sweepExpiredAttachments` (`mcp/attachment-gc.ts`) runs two checks before any removal is attempted, in
this fixed order — **but they are NOT two independently-reachable checks against the same realistic
fixture, and the design must not be described that way.**

1. **`lstat` the question dir itself, the raw path, never canonicalized first.** Refuses outright if the
   entry at `attachments/<questionId>` is itself a symlink/junction, or exists but isn't a directory at
   all. This must come BEFORE any canonicalize-then-compare step — canonicalizing first would resolve
   *through* a planted link before this function ever gets a chance to refuse it. **This is the check
   that fires for every realistic planted-link fixture** — proven in `attachment-gc.mjs` with two
   separate, real-UUID fixtures (one per refusal branch): a question dir planted as a symlink/junction,
   and a question dir whose path exists as a plain FILE instead of a directory. Each asserts the specific
   refusal REASON string, not just "refused."
2. **Canonicalize the (now-confirmed-real-directory) path and check `isProperlyUnder` against a
   containment root** — the real, canonicalized `ATTACHMENTS_DIR` in production.

**Why level 2 is defense-in-depth, not an independently-reachable check:** `questionAttachmentDir(id)`
always computes `path.join(ATTACHMENTS_DIR, id)` — a flat, one-level child. Once level 1 confirms a REAL
directory sits there (not a symlink), canonicalizing that path is structurally *guaranteed* to land under
the canonicalized `ATTACHMENTS_DIR` — there is no fixture shape (short of actually swapping
`ATTACHMENTS_DIR` itself, or one of ITS ancestors, for a symlink between module load and sweep time — a
TOCTOU on the root, not on any one question dir) that makes level 2 refuse something level 1 didn't
already refuse. An earlier draft of this record and of `attachment-gc.mjs`'s own test suite claimed
"two independent containment checks, each tested" — that was **not true**: the original §3 fixture used a
non-UUID id, so it was actually refused by the id-shape guard before `lstat` ever ran, and no fixture
exercised level 2 at all. Caught in Code Review.

The fix: `sweepExpiredAttachments`'s `deps.containmentRootOverride` (test-only) substitutes the root
level 2 compares a candidate's canonical path against, while `questionAttachmentDir(id)` (and so level
1's own target) stays rooted at the real `ATTACHMENTS_DIR`. This lets a test drive the ACTUAL
`isProperlyUnder` call with a deliberately mismatched root and prove it refuses when its two inputs
genuinely diverge, and allows when they match — without fabricating a TOCTOU on the real filesystem. It
is still accurately a test of logic that, in production (no override ever passed), cannot itself
discriminate anything level 1 didn't already catch for any realistic input.

**A third hazard — a symlink/junction planted *inside* an otherwise-legitimate question dir, pointing
outside the store — needs no special-case in this module.** The actual OS-level removal command
`killableRemoveDir` shells out to (`rmdir /s /q` on win32, `rm -rf` on posix) removes the link ENTRY
without recursing into its target's contents. This was verified two ways:

- **Existing precedent, re-run on this host:** `worktree-removal-never-reaches-repo.mjs`'s case (E) plants
  a junction inside a worktree pointing at a protected repo, then runs the real `removeWorktree` (which
  defaults to `killableRemoveDir`) against that worktree. The repo behind the junction survives intact
  (`.git`, tracked files, same HEAD) while the worktree itself — junction included — IS removed. This is
  the exact removal primitive and exact hazard shape attachment GC uses.
- **New, dir-shape-specific test:** `attachment-gc.mjs` plants a real junction inside a GC-eligible
  question's attachment dir, pointing at a separate directory holding a sentinel file, then runs
  `sweepExpiredAttachments` for real. The sentinel file survives and the question dir (junction included)
  is removed. Skips gracefully (does not fail) on a host where creating a junction/symlink is denied.
  Code Review independently re-verified this with its own real-junction probe: `rmdir /s /q` never
  follows a link at any depth.

## Observability: the boot sweep's outcome is recorded and every refusal is logged

The first version of this card fired the sweep as a bare `void …catch(...)` and discarded the result —
a refusal (a planted junction, a corrupt id, or every row refusing because `LOOM_HOME` resolves through a
UNC path) left no trace anywhere. `runBootAttachmentGcSweep` now:

- logs each `refused` entry individually (`[attachment-gc] refused <id>: <reason>`) plus one summary line
  per sweep naming `scanned`/`reaped`/`refused`/`wedged`/`alreadyGone`;
- records a four-state outcome (`not-started` / `in-progress` / `completed` / `failed`), mirroring
  `sessions/scratch-gc.ts`'s `ScratchGcSweepOutcome`, readable via `getBootAttachmentGcSweepOutcome()`.

Exposing this on `served_status` is deliberately NOT done here — that's optional future work (it would
need its own response-key-set test coverage per CLAUDE.md's FIELD-bullet rule) and isn't needed to close
the observability gap the log line + in-process outcome record already close.

## The days→ms conversion is its own tested helper

`attachmentRetentionMsFromDays(days)` (`mcp/attachment-gc.ts`) is a one-line, exported, directly-tested
function — `service.ts`'s boot wiring calls it rather than inlining `days * 24 * 60 * 60 * 1000`. A silent
unit slip in an inlined conversion (e.g. hours instead of days, an 24x error) would have reaped 30-day-old
attachments after ~12h with every OTHER test in this card still green, since nothing else exercises the
actual numeric conversion. `attachment-gc-retention-boot.mjs` drives the REAL `reconcileRunsOnBoot()` with
a configured `attachmentRetentionDays` and two fixtures (just inside / just outside the resulting window),
and was shown to fail under a deliberately-reintroduced hours-not-days bug before passing against the fix.

## Do not

- Do not add a `setInterval` watcher for this sweep, or assume it runs more often than once per daemon
  boot — see the cadence section above. If a future card wants faster collection, that is a new,
  explicitly-scoped change, not an assumption to make silently here.
- Do not give an unread `type:"notice"` row any age-based terminal timestamp (a revived
  `NOTICE_INBOX_WINDOW_MS`-shaped constant, or any other fixed window). The real, current Requests inbox
  design keeps an unread notice visible indefinitely; GC must match that, not invent a separate rule.
- Do not canonicalize the question attachment dir's path before `lstat`-checking the raw path for a
  symlink/junction at that exact location. The raw `lstat` check must run first, or a planted link is
  silently followed before this module gets a chance to refuse it.
- Do not special-case a symlink/junction planted *inside* a question dir by writing a recursive walk-and-
  refuse here — `killableRemoveDir`'s OS-level bulk remove already does not follow it, proven by both
  `worktree-removal-never-reaches-repo.mjs` (E) and `attachment-gc.mjs`'s own junction case. Adding a
  walk here would be redundant defense for a hazard the removal primitive itself does not have.
- Do not retry a killed/wedged removal in-process, and do not loop until it settles. A wedged removal is
  left on disk for the next boot's sweep (`killableRemoveDir` + `raceRemoval`, mirroring
  `sessions/scratch-gc.ts`'s own posture) — see memory `worktree-gc-threadpool-leak` for why a retry loop
  over a hung `fs.rm` leaked libuv threadpool threads and stuck the daemon (card `bd9fc808`/`26c661cd`).
- Do not mutate the `questions` row on collection (no `attachments_json` null-out, no new "gc'd" column).
  The read surface's `available` flag (`toQuestionAttachments`, db.ts) already computes live off disk via
  `fs.existsSync` — once the store dir is gone, `available:false` falls out automatically. A row whose
  attachments were already collected is simply re-returned as "eligible" by `listAttachmentGcCandidateIds`
  on every later sweep; the per-row cost of that is one `lstat` → `ENOENT`, cheap enough not to need a
  durable marker.
- Do not let `PlatformConfig.attachmentRetentionDays` accept `0` as a "disable GC entirely" sentinel.
  The validator requires an integer ≥ 1 (bounded at 3650 — a generous ceiling against a fat-fingered
  value); `0` or a negative value is a rejected config, not a disable switch. Disabling GC entirely is not
  a feature this card adds.
- Do not have `listAttachmentGcCandidateIds` (or any future variant) `SELECT *` and map through
  `toQuestion`. `toQuestionAttachments` runs one `fs.existsSync` per stored attachment on every row it
  touches; since a collected row is re-returned by this query forever (see the "do not mutate" rule
  above), that cost would grow without bound on every boot. The sweep only ever needs the bare id.
- Do not describe levels 1 and 2 of the containment check as "two independent checks, each tested by its
  own realistic fixture" — level 2 cannot independently fire against any planted-link fixture once level
  1 has run; see the Containment section above for what it actually guards and how it's tested
  (`deps.containmentRootOverride`, test-only).
- Do not inline the days→ms retention conversion at the call site again. Use the exported, tested
  `attachmentRetentionMsFromDays` — a silent unit error there is invisible to every other test in this
  card (see the "days→ms conversion" section above for the specific incident this closes, caught in
  Code Review before it ever shipped).
- Do not go back to discarding `runBootAttachmentGcSweep`'s result. At minimum, every refusal must be
  logged with its reason — the per-refusal `console.warn` plus the summary line (see the Observability
  section above) are what make a misconfigured `LOOM_HOME`, a corrupt id, or a planted hazard visible
  instead of indistinguishable from "nothing was eligible."
