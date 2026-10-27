# 05915fc7 — retry stale-generation attribution after a transient git failure, never after a refusal

## Narrative

From `c7dc99bf`'s round-6 Code Review (reviewer `3d645f0d`), lesson 253: `attributeStaleGenerationOwnLanding`'s
helpers — `stampedPathsPlausible` and `recordedTipContentLanded` (`git/worktrees.ts`) — treated a TRANSIENT
git failure (a timeout, a failed `ls-tree`, the content check's own catch) the same as a definitive "fail".

## Round 1 — the premise that turned out wrong, and why

Round 1 framed this as "a single transient failure escalates the row permanently and never retries." A
round-1 Code Review (fixture reproduced by the reviewer) found that premise FALSE, confirmed directly
against the current source:

```ts
// db.ts ~5180-5198 (recordStaleGenerationUnresolved) — called UNCONDITIONALLY every boot, bumping
// attempts/lastAttemptAt, keeping the original firstDetectedAt:
recordStaleGenerationUnresolved(
  sessionId: string, ctx: { branch: string | null; taskId: string | null; projectId: string }, reason: string,
): StaleGenerationUnresolvedEntry {
  const now = new Date().toISOString();
  const list = this.listStaleGenerationUnresolved();
  const existing = list.find((e) => e.sessionId === sessionId);
  const updated: StaleGenerationUnresolvedEntry = existing
    ? { ...existing, ...ctx, lastAttemptAt: now, attempts: existing.attempts + 1, reason }
    : { sessionId, ...ctx, firstDetectedAt: now, lastAttemptAt: now, attempts: 1, reason, escalated: false };
  this.setMeta(STALE_GENERATION_UNRESOLVED_KEY, JSON.stringify([...list.filter((e) => e.sessionId !== sessionId), updated]));
  return updated;
}
```

```ts
// service.ts ~27488-27508 (pre-round-1 resolveStaleGenerationOwnLanding) — the NUDGE alone was one-shot:
const entry = this.db.recordStaleGenerationUnresolved(s.id, { branch, taskId, projectId: project.id }, reason);
if (!entry.escalated) {
  // ...fire the [loom:merge-orphaned] nudge...
  this.db.markStaleGenerationEscalated(s.id);
}
return "escalated";
```

`resolveStaleGenerationOwnLanding` also recomputes `attributeStaleGenerationOwnLanding` FRESH every boot —
there is no short-circuit keyed on prior escalation. So the TRUE pre-card cost of a transient failure was
never "escalates once and never retries": it was ONE spurious `[loom:merge-orphaned]` alert that
SELF-HEALS the moment the transient condition clears on a later boot (attribution recomputes and, if the
underlying data genuinely attributes, succeeds — the alert was already filed, but the row resolves anyway).
Round 1's own fix removed that one false alarm — but it ALSO removed every TRUE alarm for a genuinely
deterministic, never-clearing mismatch, by folding both into the same unconditional "transient, retry
forever, never escalate" bucket. That is a worse trade: a human never learns about a real, permanent
problem at all. This card's actual, honest value is narrower than round 1 claimed: close the single
false-alarm case without opening a silent-forever-missed-true-alarm case in its place — see "Round 2" below
for how.

## Round 2 — Code Review (NOT-SHIP), two blocking findings fixed as new commits

### B1 (BLOCKING): round 1's "null ⇒ transient" covered content the repo permanently, deterministically carries

The reviewer reproduced, against a real repo, every one of these as "transient" under round 1's code —
each one is actually a DEFINITIVE, never-changing-on-retry fact:

- (a) a non-UTF-8 path anywhere in a candidate's FULL tree (not just the stamped path set — `fullTreeEntries`
  reads the whole tree) — the existing U+FFFD check already catches this; round 1 just misclassified the
  catch.
- (b) same mechanism, specific shape: a valid filename containing a literal U+FFFD byte sequence, which any
  worker can land in a real commit; `fullTreeEntries` poisons the WHOLE map for that one commit, so this
  silently blocks every future stale-generation row that ever needs to read that same commit, permanently.
- (c) a MISSING `reviewedTip` object — the natural end-of-lifecycle shape for a stale generation (the
  branch gets re-cut, eventually gc'd) — git itself cannot resolve it, and never will on retry.
- (d) a missing candidate object, or a BLOB sha handed in where a tree-ish (commit) was expected.
- (e) (the one genuinely transient case in the reviewer's own list) a deterministic timeout on a huge tree
  — this one legitimately CAN clear on a later boot (a lighter load, a raised `gitOpMs`) and must stay
  "transient".

**The fix: move the classification INSIDE `fullTreeEntries` (and `stampedPathsPlausible`'s own merge-base
path), via a new shared pre-check, `resolveObjectKind`:**

```ts
async function resolveObjectKind(
  repoPath: string, ref: string, deps: BoundedGitDeps,
): Promise<{ kind: "ok"; type: string } | { kind: "missing" } | { kind: "transient" }> {
  try {
    const { git, timeoutMs } = boundedGit(repoPath, deps);
    const out = await withTimeout(
      git.raw(["cat-file", "-t", "--end-of-options", ref]), timeoutMs, "git cat-file -t (object kind pre-check)",
    );
    return { kind: "ok", type: out.trim() };
  } catch (e) {
    if (e instanceof CanonicalGitRefusal) throw e;
    if (isWithTimeoutExpiry(e) || isSpawnLevelFailure(e)) return { kind: "transient" };
    return { kind: "missing" };
  }
}
```

`fullTreeEntries(repoPath, ref, deps)` now runs this pre-check FIRST. `{kind:"missing"}`, or `{kind:"ok"}`
with a `type` outside `{"tree","commit","tag"}` (i.e. a blob), returns `null` immediately — DEFINITIVE,
without ever running `ls-tree` at all. Only AFTER the pre-check confirms the object genuinely exists and is
tree-ish does `ls-tree -r` actually run; a failure THERE (or a `resolveObjectKind` pre-check that itself
came back `{kind:"transient"}`) throws a new `GitTransientReadFailure` (see "The signal mechanism" below) —
anomalous, since the object was just independently confirmed good. The malformed-content checks already
inside the `ls-tree` parse loop (a line with no tab, a U+FFFD-colliding/duplicate decoded key) are
UNCHANGED — they still return `null` — but `null` now means ONLY "definitive" at every caller, reversing
round 1's "null ⇒ transient" default. `stampedPathsPlausible` runs the SAME `resolveObjectKind` pre-check
on BOTH `recordedTip` and `otherSha` before its own `merge-base` call, for the identical reason.

**Round 1's own ruling 4 ("a malformed/duplicate-key/lossy-UTF-8 tree record is an accepted residual that
folds into transient, mirroring `e5458ccd`'s watermark posture") is WITHDRAWN.** That framing is exactly
what let (a)/(b) above slip through as "transient" — a malformed/poisoned tree record is EXACTLY as
definitive as a missing object; both are permanent, deterministic facts about the repo's own content, never
a host condition. There is no accepted residual here anymore: every one of (a)/(b)/(c)/(d) is now correctly
definitive, tested directly (see "Tests" below).

#### How `isSpawnLevelFailure` tells a host condition apart from git itself running — precisely, not a guess

Ruling 2 of the round-2 review: round 1's OWN classification rule inside `resolveObjectKind` read "any
non-timeout failure ⇒ missing" — too broad. A PROCESS-LEVEL spawn failure (`ENOENT` on the git binary,
`EACCES`, `EMFILE`, `EAGAIN` — no git exit code at all, because git never ran) is a HOST condition, not a
fact about the object, and must classify as transient, exactly like a timeout.

Detection is message-based but **locale-independent** — it does NOT match git's own (locale-dependent)
stderr text, only a string NODE itself authors. Verified directly against `simple-git@3.36.0` (this repo's
pinned version — re-verify this against a future major bump, never assume it still holds):

```
=== real git nonzero exit (git cat-file -t <missing-sha>) ===
name: GitError
message: fatal: git cat-file: could not get object info

=== spawn ENOENT (simpleGit(repo, { binary: "nonexistent-xyz" })) ===
name: GitError
message: Error: spawn nonexistent-xyz ENOENT
    at ChildProcess._handle.onexit (node:internal/child_process:285:19)
    ...
```

Both throw the SAME `GitError` class — simple-git's executor chain (`attemptTask`'s own `onFatalException`,
`git-executor-chain.js`) wraps ANY non-`GitError` exception as `new GitError(task, String(e))` when a task
fails before `handleTaskData`'s own plugin-based error-detection path ever runs (a process-level spawn
failure never reaches that path — no exit code to report at all), so the ORIGINAL Node `ChildProcess`
error's own stack text becomes the wrapper's `.message` verbatim — always starting with `"Error: spawn "`
(Node's own `child_process` error-formatting convention, authored in English unconditionally). A REAL
non-zero exit's `GitError.message` is git's own captured stdout+stderr instead (via the SAME executor's
`errorDetectionHandler`/`getErrorMessage`, which concatenates `stdOut`+`stdErr` into the message), with no
such prefix. `isSpawnLevelFailure(e) = e instanceof Error && /^Error: spawn /.test(e.message)` — verified to
discriminate correctly on both shapes above. `isWithTimeoutExpiry` is the sibling check for `withTimeout`'s
own synthetic timeout error (`/exceeded \d+ms \(hung git child\?\)/`), a string WE author in `git/bounded.ts`
— neither check ever touches git's own locale-dependent stderr text.

### The signal mechanism — why a THROWN marker here, after round 1 rejected the same shape elsewhere

Round 1 (ruling 3) rejected widening `stampedPathsPlausible`/`recordedTipContentLanded`'s own PUBLIC return
types to a thrown control-flow marker ("Design A"), in favor of widening their return-type unions ("Design
B") — reasoning that "a thrown control-flow marker fails open the day someone adds a caller and forgets the
catch." Round 2 accepts a thrown marker (`GitTransientReadFailure`, mirroring the existing
`CanonicalGitRefusal` precedent) for `fullTreeEntries` specifically, and the reasoning is NOT a reversal —
**the direction a missed catch fails in has flipped, because of what changed between the two call sites:**

- Round 1's concern was about `stampedPathsPlausible`/`recordedTipContentLanded`'s OWN return values, where
  round 1's own (wrong) default was "unrecognized/ambiguous ⇒ transient." A caller that forgot to handle a
  new return state there would silently fall toward the SAME unsafe default round 1 was already fixing away
  from — failing TOWARD silent-forever-retry, the unsafe direction for this card.
- `fullTreeEntries`, by contrast, now returns `null` for EVERY definitive case — a caller that simply checks
  `if (!x) return null`-equivalent-style and does nothing special for a thrown `GitTransientReadFailure`
  lets it propagate uncaught. It reaches `attributeStaleGenerationOwnLanding`'s own generic outer
  `catch { return { kind: "no-match", checked: false }; }`, which has NO type filter — ANY uncaught
  exception reaching it, `GitTransientReadFailure` included, becomes a definitive `"no-match"` and
  ESCALATES. A forgotten catch at this layer fails toward the ALARM, not toward silence — the safe
  direction for this card. Tested directly (`UNCAUGHT_ESCALATES`, see "Tests" below): an exception
  reaching that outer catch via a path NONE of this card's three wired call sites specifically handles
  (candidate DISCOVERY itself, `findAllLandedTrailerCommits` — a known, separately-tracked upstream gap,
  card `1e7d6956`, not fixed here) still escalates on the very first boot, never silently retrying forever.

`fullTreeEntries`'s external return contract (`Map<string, string> | null`) stays byte-identical — the ~2
existing direct `=== null` test assertions (the UTF-8-decode-safety scenarios) are unaffected; only the
caller's OWN classification of a caught exception (and of `null`) changes.

### S1 (SHOULD-FIX): bounded, not unbounded — mirroring the merge-reconcile wedge, with its own exact threshold

Retry-forever is unbounded and was visible only as a `console.warn` line. Mirrors
`escalateWedgedMergeReconcile`'s own attempts-then-escalate pattern:

```ts
// service.ts ~2970-2983 — the pattern being mirrored, cited exactly:
private readonly mergeReconcileEscalateAttempts: number;
private readonly mergeReconcileEscalateMs: number;
private static readonly DEFAULT_MERGE_RECONCILE_ESCALATE_ATTEMPTS = 3;
private static readonly DEFAULT_MERGE_RECONCILE_ESCALATE_MS = 24 * 60 * 60_000; // 1 day
```
```ts
// service.ts ~27933-27946 — the actual threshold check + fire, the shape this card's own transient
// branch now reuses:
const entry = this.db.recordMergeReconcileWedgeAttempt(s.id, {...}, e.message);
const ageMs = Date.now() - new Date(entry.firstWedgedAt).getTime();
if (!entry.escalated && (entry.attempts >= this.mergeReconcileEscalateAttempts || ageMs >= this.mergeReconcileEscalateMs)) {
  this.escalateWedgedMergeReconcile(s, project, entry);
}
```

A NEW, independently-tunable constant pair — `staleGenerationTransientEscalateAttempts`/`_Ms`, same
defaults (3 attempts / 1 day) — rather than literally sharing the merge-reconcile wedge's own fields: the
two conditions differ in KIND (a wedged repoKey can NEVER self-heal at all; a transient git/host read
failure on an object the repo hasn't yet proven doesn't exist genuinely CAN), even though they share the
SAME retry cadence (both are re-attempted only once per daemon BOOT, never on a tighter in-process sweep
timer, unlike the separate worktree-removal wedge's own 50-attempts/7-days, which retries on its own 45-min
sweep many times per boot and needs a much larger count to represent the same wall-clock patience). Past
the threshold, a `[loom:merge-orphaned]` nudge fires — exactly once, naming the candidate sha(s) and the
attempt count/age — then the row stays `escalated:true` forever (sticky), same one-shot-nudge idempotency
the definitive path already had.

`StaleGenerationUnresolvedEntry` gains a `kind: "definitive" | "transient"` field — the CURRENT boot's own
classification, not a history. `recordStaleGenerationUnresolved` now takes `kind` as a required 4th
parameter. The two escalation policies apply independently per the CURRENT boot's own `kind`:

- `kind:"definitive"` (unchanged): escalates on `!entry.escalated` alone, no attempts/age grace — a
  genuine mismatch or a `CanonicalGitRefusal` never heals, so there's nothing to wait out.
- `kind:"transient"`: gated on `entry.attempts >= staleGenerationTransientEscalateAttempts ||
  ageMs >= staleGenerationTransientEscalateMs` as well as `!entry.escalated`.

**Kind-flip semantics (round 2, ruling 3), both tested directly (`KINDFLIP`, see "Tests"):**
- `"transient"` → `"definitive"`: escalates on that FIRST definitive boot, REGARDLESS of how many (or few)
  prior transient attempts there were — the definitive branch never consults `attempts`/age at all, so a
  row that was transient for exactly one prior boot (well below the give-up threshold) still escalates
  immediately the moment it genuinely mismatches.
- `"definitive"` → `"transient"`: `escalated` is STICKY regardless of `kind` — an already-escalated row
  that starts reading transiently on a later boot (e.g. the same candidate's tree becomes unreadable after
  an earlier genuine mismatch already escalated it) stays `escalated:true` and reports `"escalated"` again;
  the nudge does NOT re-fire a second time.

The boot-summary result gains a `staleGenerationTransient` counter (rows below the give-up threshold this
boot); `staleGenerationUnresolvedEscalated` already covered "an alert is live this boot" and needs no
split — the alert's own text says which cause fired it.

### N1: honest wording — `attribution` now carries `checked`

The pre-existing escalation note claimed "Loom checked every landed commit on this branch... and found none
it could verify" UNCONDITIONALLY for every non-zero-delta `"no-match"` — false for a `CanonicalGitRefusal`,
or an unresolvable repo/stamp/reviewedTip: on all of those paths, NOTHING was ever checked; the scan never
even reached the candidate loop. `attributeStaleGenerationOwnLanding`'s `"no-match"` variant now carries
`checked: boolean` — `true` only for the one case that genuinely ran the loop to completion and compared
every candidate's content; `false` for every early-return (an unresolvable repo, an unreadable/truncated
stamp, zero eligible candidates, the hoisted reviewedTip read failing for any reason including a refusal,
or the generic outer catch-all). `resolveStaleGenerationOwnLanding`'s own `reason`/`checkedNote` text now
branches on `checked`, same shape as the existing `zeroDelta` branch. The `tryAttribute` helper's exhaustive
`switch` statements (a `never`-typed `default`) are unaffected — neither helper's own return-type shape
changed, so there is nothing new to switch over there.

### N2: the `parseNameStatusZ` nit, named

Round 1 also tidied `parseNameStatusZ` (git/worktrees.ts): `if (!status) return {truncated:true}` and
`if (!p) return {truncated:true}` were unreachable dead code — `tokens` is pre-filtered to non-empty
strings (`out.split("\0").filter((t) => t.length > 0)`), so neither index can ever be falsy. Replaced with
the file's own established `tokens[i]!` + inline comment idiom (`noUncheckedIndexedAccess` is on, so the
non-null assertion needs a comment justifying it, matching e.g. `git/worktrees.ts`'s existing
`const c = glob[i]!; // i < glob.length ⇒ defined` pattern elsewhere in this same file). No behavior change;
kept as-is for round 2.

## Round 3 — Code Review (NOT-SHIP), one reproduced BLOCKING finding fixed, four SHOULD-FIX findings addressed

### B1 (BLOCKING, reproduced): `listStaleGenerationUnresolved`'s round-2 type guard dropped every pre-card row

`StaleGenerationUnresolvedEntry` lives in ONE `app_meta` JSON blob (`stale_generation_merge_unresolved`),
with no migration. Round 2's type guard required `kind ∈ {"definitive","transient"}` — a field that did
not exist before this card — so every row written by pre-card `main` (no `kind` at all) was filtered out
as corrupt the moment `listStaleGenerationUnresolved()` ran on it. The reviewer reproduced this directly:
seeding two main-shaped escalated rows, then calling the method, returned `[]`; a subsequent
`recordStaleGenerationUnresolved` call for one of those sessions then found no `existing` row (its own
`list.find(...)` search ran against the now-empty list) and created a FRESH one (`attempts:1,
escalated:false`), and the blob-rewrite this upsert performs (`[...list.filter(...), updated]`, built
from that same empty `list`) permanently dropped the OTHER row — it was never touched again by anything,
since boot-reconcile iterates live `sessions` rows, never this blob directly. **Net effect on the first
boot after an upgrade: every already-escalated worker gets a DUPLICATE `[loom:merge-orphaned]` nudge (its
`escalated:true` was silently reset to `false`), and every other row's bookkeeping (attempts, age) is
erased outright.**

**Fix:** `listStaleGenerationUnresolved`'s type guard now accepts `kind === undefined` as well as the two
known values, and the reader defaults an absent `kind` to `"definitive"` (the only kind that ever existed
before this card) rather than treating its absence as disqualifying. A row whose `kind` IS present but
neither known value is still rejected as genuinely malformed — this only widens what counts as a legacy
row, never what counts as a corrupt one.

**Test** (`UPGRADE_LEGACY_BLOB`, see "Tests" below): a real, deterministic definitive-miss worker (the
same forged-landed-tip shape `FORGED` already uses) with a hand-seeded, MAIN-shaped (no `kind` field)
`escalated:true` row already in the blob BEFORE its first post-upgrade boot, alongside a second,
unrelated legacy row for a session that no longer exists in the DB at all (an orphaned bookkeeping entry
with no live session to ever touch it again). Proven RED against `549e5c26` (round 2, before this fix):
both rows read `[]` pre-boot, the tracked worker's own row re-creates with `escalated:false` and the nudge
fires a SECOND time, and the orphaned row is gone entirely post-boot. GREEN after the fix: both rows
survive, the tracked worker's `attempts` increments from its pre-upgrade value rather than resetting to
1, `escalated:true` stays true, and the nudge does not re-fire.

### S1: `UNCAUGHT_ESCALATES` was vacuous — renamed to what it actually proves

The round-2 `UNCAUGHT_ESCALATES` fixture set a global `gitOpMs:1` to force a timeout during candidate
DISCOVERY (`findAllLandedTrailerCommits`'s own `git log --grep` call) and asserted the worker escalated —
but `findAllLandedTrailerCommits` has its OWN `try { ... } catch { return []; }`, swallowing that timeout
into an empty candidate list, long before anything could reach `attributeStaleGenerationOwnLanding`'s
outer catch-all. The observed escalation instead comes from the EARLIER, already-covered
`if (candidates.length === 0) return { kind: "no-match", checked: false };` return — a real and correct
behavior, but not what the fixture's own name and comment claimed to prove.

Audited every call inside the outer `try` block for whether an exception from it can actually reach the
outer `catch`: `findAllLandedTrailerCommits` swallows to `[]`; the inline `fullTreeEntries(reviewedTip)`
read is caught explicitly one level up (returns directly, never falls through to the outer catch);
`verifyReviewedTipChain`, `recordedTipContentLanded`, and `stampedPathsPlausible` each have their own
`try/catch` and never throw outward. The only remaining code inside the try block that CAN throw is the
two `default: { const _exhaustive: never = …; throw … }` exhaustive-switch arms — unreachable except by a
genuine type-system violation at runtime, not something a black-box git-only test can trigger. **There is
no live seam, through real git, to exercise the outer catch-all at all** — its correctness (the safe,
fail-toward-the-alarm default for an exception none of this card's specific handling covers) is proven by
reading the code, not by any test in this file.

Renamed to `DISCOVERY_TIMEOUT_ESCALATES`; its comment and the one `check()` label now state the TRUE
mechanism (the early `candidates.length === 0` return, not the outer catch-all) and point at card
`1e7d6956` — the tracked, separate gap where a candidate-discovery-level timeout arguably SHOULD classify
as `"transient"` rather than this definitive `"no-match"`, not fixed here.

### S2: the nudge wording asserted causes it could not know — fixed as WORDING ONLY

Two cases where the escalation nudge's own text overclaimed what was actually checked:

(a) A discovery timeout or spawn failure collapses to `[]` → `candidates.length === 0` →
`{kind:"no-match", checked:false}`. The `checked:false` branch's wording said "a refusal or an
unresolvable repo/stamp, NOT a transient read failure" — false exactly here: a transient read failure
during discovery is precisely what produced this `checked:false` outcome, and the wording denied the one
cause that actually applies.

(b) `verifyReviewedTipChain` turns ANY git error into `{ok:false, reason}` (never throws), so a candidate
behind a `landedTip` trailer that hits a git error during the chain walk is silently skipped (`result`
stays `null`) rather than counted as a transient miss — the loop can reach `sawTransient:false` and
`checked:true` ("Loom checked every landed commit…") while a chain read genuinely failed and nothing of
that candidate's own content was ever examined.

Neither is reclassified as transient here — that is card `1e7d6956`'s own scope (discovery- and
chain-level read failures becoming `"transient"` rather than folding into a definitive `checked` claim),
deliberately not done in this card. The fix is WORDING ONLY: the `checked:false` nudge text no longer
names a specific cause it cannot verify — it now reads "no candidate could be attributed; Loom could not
confirm whether this was a definitive miss or a read failure during discovery or verification" — honest
about the ambiguity rather than asserting the wrong one of two possible causes.

### S3: the transient give-up THRESHOLD itself was untested — now driven through real boots

Round 2 added `staleGenerationTransientEscalateAttempts`/`_Ms` but no test ever drove enough real boots to
observe the threshold actually being crossed, held, and not re-fired. Two new fixtures
(`BOUND_ATTEMPTS`/`BOUND_AGE`, see "Tests" below), each on its own isolated `Db`/`SessionService` pair so
the override never affects any other scenario's own attempt counting:

- `BOUND_ATTEMPTS` sets `staleGenerationTransientEscalateAttempts:2` and drives 3 real boots against a
  PERSISTENT (never-restored) move-aside corruption — boot 1: tracked, `kind:"transient"`, not escalated;
  boot 2 (attempts reaches 2): escalates, the one-shot nudge fires exactly once; boot 3: stays escalated
  (sticky), the nudge does NOT re-fire. The boot-summary `staleGenerationTransient`/
  `staleGenerationUnresolvedEscalated` counters are checked at each boot too.
- `BOUND_AGE` isolates the OTHER leg of the `||` — `staleGenerationTransientEscalateAttempts:1000`
  (deliberately unreachable in 2 boots) with `staleGenerationTransientEscalateMs` set small, and a real
  `sleepPast`-proven wait between boot 1 and boot 2 longer than that threshold — boot 2 escalates via age
  alone, with `attempts` still far below its own (unreachable) threshold.

### S4: the record wrongly claimed EMFILE/ENFILE are covered by `isSpawnLevelFailure` — CORRECTED, not widened

`isSpawnLevelFailure`'s own doc comment and this record (the "process-level spawn failure" list) both
named `EMFILE`/`ENFILE` as examples of what it detects. Empirically (`fs.openSync` exhaustion against a
real repo on this host, 8189 handles before `EMFILE`, then a real `simple-git` call against that same
process) a file-descriptor-level resource exhaustion did NOT reproduce the `/^Error: spawn /`-prefixed
shape `isSpawnLevelFailure` matches — that shape is specific to Node's own deferred, async `'error'` event
on a `ChildProcess` whose OS-level launch failed (the verified ENOENT case from round 2); a failure during
the PARENT's own stdio-pipe-handle setup (which is where `EMFILE`/`ENFILE` would actually originate) is an
earlier, different failure point with no verified message shape here. **This record no longer claims
`EMFILE`/`ENFILE` land as `"transient"` under this function.** Left unresolved (and NOT fixed by widening
`isSpawnLevelFailure` — a false DEFINITIVE classification on a genuine resource-exhaustion condition is
the safe direction: a human gets an alert instead of a silent forever-retry), this means an `EMFILE`/
`ENFILE` hit here most likely lands `"missing"` (a false-alarm escalation), not `"transient"`. The
underlying EMFILE daemon crash this reasoning traces back to is a separate, pre-existing issue, tracked on
its own card, not this one.

### NITs addressed

- **False-alarm-direction cases, named (not fixed):** a Windows sharing violation or AV lock producing a
  non-zero git exit (rather than a process-level spawn failure) classifies as `"missing"` (DEFINITIVE) via
  `resolveObjectKind`'s own fallback — a false alarm, but in the safe direction (escalates for a human to
  see, never silently retries forever). Likewise the two `_exhaustive: never` construct-throws inside
  `attributeStaleGenerationOwnLanding` (S1 above) would, if ever actually reached by a genuine type-system
  violation, land on the outer `catch` and escalate — also the safe direction.
- **No "clear" on success, pre-existing and harmless:** `StaleGenerationUnresolvedEntry` rows are never
  deleted once attribution later succeeds (`RETRY_SUCCEEDS`'s own comment already notes this) — the blob
  only grows. Unrelated to this card; not fixed here.
- **Redundant `cat-file` spawns, fine to leave:** `resolveObjectKind` runs its own pre-check even when a
  later call would itself reveal the same "missing/non-tree-ish" fact — an extra spawn per candidate, not
  a correctness issue, left as-is.

## Tests

`stale-generation-landedtip-content-check.mjs`:
- `PIPELINE_HOISTED_READ_FAILS` (pre-existing, `1cf79e64` round 2) is REPURPOSED BACK to its original
  assertion — a missing `reviewedTip` now escalates (DEFINITIVE), not "never escalates" (round 1's own,
  now-withdrawn, repurposing).
- A new "(B1 a/b/c/d1/d2/e)" direct-proof block, adapted from the reviewer's own fixture (a non-UTF-8-named
  file planted via `update-index --index-info`, a missing reviewedTip, a missing candidate, a blob sha as
  candidate, and a genuine-timeout control against a real tree-ish object) — proves each of (a)-(d) is now
  `"no-match"`/`false` (DEFINITIVE), never `"transient"`, while (e) still reads `"transient"`.
- A new "(spawn-failure)" direct-proof block: a REAL spawn-level failure (via `deps.gitFactory` pointed at
  a nonexistent git binary, a real `simpleGit()` instance, not a crafted message) reads `"transient"`,
  never a definitive value — proves ruling 2's fix, not just its stated intent.
- A new `KINDFLIP` fixture pair, through the real pipeline: `KF_T2D` (transient boot 1, then the object is
  restored but the real content genuinely mismatches — definitive boot 2) escalates on that first
  definitive boot; `KF_D2T` (a genuine mismatch escalates boot 1, THEN the same candidate is corrupted —
  transient boot 2) stays escalated, with the nudge confirmed NOT to re-fire a second time.
- `DISCOVERY_TIMEOUT_ESCALATES` (round 3, renamed from round 2's `UNCAUGHT_ESCALATES` — see S1 above), in
  its OWN isolated fresh `Db`/`SessionService` pair (never the shared one — a global `gitOpMs=1` would
  otherwise also hit every other already-tracked row in the shared DB): a timeout during candidate
  DISCOVERY itself (upstream of this card's three wired sites, the `findAllLandedTrailerCommits` gap card
  `1e7d6956` tracks) escalates on the first boot via the early `candidates.length === 0` return — never a
  silent retry, and never claimed to exercise the outer catch-all (round 2's own claim, withdrawn).
- `UPGRADE_LEGACY_BLOB` (round 3, B1) — see "Round 3" above for the full RED/GREEN shape.
- `BOUND_ATTEMPTS`/`BOUND_AGE` (round 3, S3) — see "Round 3" above.
- Every pre-existing definitive-mismatch scenario (FORGED/OVERLAP/FB_LANDEDTIP/etc.) is unchanged and
  re-run green.

## Do not

- Do not treat a `CanonicalGitRefusal` as transient anywhere in this scan — not in `fullTreeEntries`, not in
  either content-check helper, not in `resolveObjectKind`, not in `attributeStaleGenerationOwnLanding`'s own
  direct read. A refusal is a definitive, never-retryable fail.
- Do not let a `CanonicalGitRefusal` escape `fullTreeEntries`/`resolveObjectKind` uncaught at any call site
  — each one must catch it explicitly and convert it to a definitive miss for its own return type.
- Do not read `sawTransient` as "abort the scan on the first transient miss" — later candidates must still
  be checked, and a later clean attribution must still win over an earlier transient miss.
- Do not treat a `null` from `fullTreeEntries` as transient anywhere — it is ALWAYS definitive now (a
  missing/non-tree-ish object, or untrusted content). A genuine transient failure throws
  `GitTransientReadFailure` instead; there is no longer a `null` case that means "retry this."
- Do not classify ANY non-timeout `resolveObjectKind` failure as `"missing"` without first ruling out a
  process-level spawn failure via `isSpawnLevelFailure` — a spawn failure proves nothing about the object.
- Do not match git's own (locale-dependent) stderr text to distinguish a spawn failure from a real exit —
  `isSpawnLevelFailure`/`isWithTimeoutExpiry` both match only strings NODE/`withTimeout` itself authors.
- Do not let the `"transient"` no-op path in `resolveStaleGenerationOwnLanding` go silent — the log line
  must name the worker row, the candidate sha(s), and the current attempt count/threshold state.
- Do not gate a `kind:"definitive"` escalation on `attempts`/age — it still escalates on first detection,
  unconditionally, regardless of any prior transient history on that same row.
- Do not let an already-`escalated:true` row un-escalate, or re-fire its nudge, on a later boot that reads
  `kind:"transient"` — `escalated` is sticky regardless of the current boot's own classification.
- Do not restate this card's `STALE_GENERATION_UNRESOLVED_KEY`/`StaleGenerationUnresolvedEntry`-level "no
  grace period, escalate on first detection" claim as a universal fact anywhere new — it is scoped to
  `kind:"definitive"` only; `kind:"transient"` has its own bounded give-up.
- Do not drop (or require) a `kind` field on `listStaleGenerationUnresolved`'s own read — an absent `kind`
  is a legacy pre-card row (defaults to `"definitive"`), never a corruption signal on its own (round 3,
  B1). Only a PRESENT `kind` that is neither known value is genuinely malformed.
- Do not claim `UNCAUGHT_ESCALATES`/`DISCOVERY_TIMEOUT_ESCALATES` (or any future fixture) exercises
  `attributeStaleGenerationOwnLanding`'s outer catch-all without first tracing every call inside that try
  block for its OWN internal catch — as of round 3, none of them lets an exception escape to it (round 3,
  S1); do not reintroduce that claim without re-auditing this first.
- Do not claim `isSpawnLevelFailure` covers `EMFILE`/`ENFILE` (round 3, S4, correcting round 2's own
  listing) — and do not "fix" that by widening its regex; a false DEFINITIVE classification on a real
  resource-exhaustion condition is the safe direction here, not a defect to close.
