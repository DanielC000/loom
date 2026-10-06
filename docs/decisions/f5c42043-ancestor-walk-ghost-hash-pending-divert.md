# f5c42043 — a corrupt latch's stale ancestor-walk hash is a THIRD, lowest-precedence matching tier, never proof of ownership

From the 882d6cff round-3 Code Review (reviewer `5339b48f`, 2026-10-06), measured by the reviewer against
`a1facd04` (882d6cff's own round-3 tip) with a scratch repro built against each commit's own
`merge-quarantine.ts`. Confirmed still live on main (`12161f41`) by this card's own worker, with a
behavioural positive control (two of 882d6cff's own documented-RED-on-parent scenarios reproduced for
real against a scratch worktree at the parent commit `4173b48b`, proving the repro harness itself was
sound) before any fix was written.

## The bug

`reenterMergeQuarantinesAtBoot` (`packages/daemon/src/git/merge-quarantine.ts`) matches a corrupt/
unparsable latch's filename hash against exactly TWO tiers, built once per boot call from the live
filesystem state of every REGISTERED path `p`:

1. `hashToRepo` — `p`'s own fresh hash, but ONLY when `isRepoPathCurrentlyResolvable(p)` is true right
   now, plus `p`'s own legacy (direct-identity, never-walked) hash unconditionally.
2. `unresolvedClaimantsByHash` — `p`'s own degraded (ancestor-walked) hash, but ONLY when `p` is
   CURRENTLY unresolvable.

Both tiers are keyed on `p`'s CURRENT classification (resolvable vs. not) at the moment they are built.
Neither has any memory of the hash a path (or an intermediate ancestor between it and the walk's old
landing spot) would have produced via a degraded walk BEFORE it (or that ancestor) gained its own `.git`.

**Setup:** `Y` a real git repo, deliberately never itself registered. `W1 = Y/a`, absent at boot 1 — its
degraded walk (nearest existing ancestor `Y`, which has its own `.git`) lands on `Ky =
canonicalRepoLockKey(Y)`. A corrupt latch is filed at `sha(Ky).json`. `Z` is unrelated, registered,
resolvable.

**Boot 1** (`W1` absent): `unresolvedClaimantsByHash` correctly indexes `Ky -> [W1]` (882d6cff's own
fix), the corrupt latch diverts to `pendingUnresolvedQuarantines` under `W1`'s identity, and `Z` is
correctly left alone. So far, matches 882d6cff's own documented behavior exactly.

**Then `W1` remounts as ITS OWN git repo** (`git init` inside what used to be a plain absent subdir — the
realistic "a removable drive/repo came back" case) — but is NEVER QUERIED before a restart.

**At the restart's boot** (a fresh `reenterMergeQuarantinesAtBoot` call, i.e. a real process restart — a
true daemon restart resets ALL in-memory state, `pendingUnresolvedQuarantines` included, so nothing from
boot 1 survives except the physical files under `MERGE_QUARANTINE_DIR`): `W1` is NOW resolvable, with its
OWN TRUE toplevel key `Kw1 = canonicalRepoLockKey(W1) != Ky` (its own `.git` is found immediately,
inclusive-start, never walking up to `Y` at all anymore). Tier 1's fresh-hash check now computes `Kw1` for
`W1`, not `Ky` — a miss. Tier 2 no longer applies at all (`W1` is resolvable now) — also a miss. The
corrupt latch's hash (`Ky`, now a STALE, orphaned record of a resolution `W1` no longer produces) matches
NEITHER tier, falls to `orphanFilenames`, and PASS 2's every-registered-repo fail-closed sweep fires,
quarantining `Z` — an unrelated repo that was never anywhere near `Y` — violating `@decision 7673d096`
("one repo's unmatched latch must never fall to the every-repo sweep").

**Confirmed NOT a mischaracterization of 882d6cff's own bug class.** Running two of 882d6cff's own
documented-RED-on-parent scenarios for real, against a scratch worktree built at the parent commit
`4173b48b`, reproduced the EXACT predicted failures (wrong attribution / a losing claimant unprotected) —
but in BOTH of those genuinely-broken runs, the sibling assertion "Z is NOT quarantined" still PASSED.
882d6cff's own bug class was always about misattribution or a losing claimant's own enforcement, never
about the PASS 2 every-repo sweep hitting an unrelated `Z`. This card's repro is a GENUINELY DIFFERENT
mechanism from anything 882d6cff's sixteen scenarios exercise — none of them ever remounts a claimant as
its own, differently-keyed git toplevel; they all stay plain subdirs (or nested-but-still-absent paths)
whose degraded walk keeps landing on the same ancestor throughout.

Three repro variants were built and run against FOUR reference points (`4173b48b` parent, `58f82c90`
round 2, `a1facd04` round 3, and main `12161f41`) before the real mechanism was found: a single-claimant
"plain subdir remount" (never changes its own degraded key — stays `Ky` even once resolvable, so tier 1
re-catches it for free), a "W1 graduates via a live query, W2 remounts but isn't queried" multi-claimant
variant, and a tmp-residue twin — ALL TWELVE runs were green, because none of them changed the
REMOUNTED path's own KEY. The actual bug needs the remount to change the claimant's key (its own git
toplevel, not a plain subdir) — only then does the stale hash stop being reproducible by anything live.

## The fix

A THIRD, LOWEST-precedence matching tier, `ancestorHashToRepo()` (`merge-quarantine.ts`), for EVERY
registered path, regardless of that path's OWN current resolvability:

```ts
function ancestorToplevelHashes(p: string): string[] {
  const hashes = new Set<string>();
  let dir = path.dirname(path.resolve(p));
  for (;;) {
    if (fs.existsSync(dir)) hashes.add(quarantineHashForKey(canonicalRepoLockKey(dir)));
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return [...hashes];
}
```

**Built LAZILY, on the first corrupt-latch miss in tiers 1+2, memoized for the rest of that boot —
Code Review `2dd4401e`, round 1, item 1.** The first shipped version built the whole `Map` unconditionally,
up front, for every boot regardless of whether any corrupt latch existed to match at all. Walking every
ancestor of every registered path costs real `fs.existsSync`/`canonicalRepoLockKey` (itself a further
upward `fs.existsSync` walk) calls per path; for a registered path on an unreachable UNC/SMB share, each
of those calls can block for the SHARE's OWN timeout (seconds to tens of seconds on a real Windows
network stall), multiplied across every ancestor level — paid on EVERY boot, even the overwhelmingly
common case of zero corrupt latches. Fixed by wrapping the build in a closure
(`ancestorHashToRepoCache`, a plain module-call-scoped `let`, never module-level — each
`reenterMergeQuarantinesAtBoot` call gets its own fresh cache) that builds once, on first call, and
returns the cached `Map` on every subsequent lookup within the SAME boot call. Behavior once built is
byte-identical to the original unconditional version — this is purely a WHEN-paid change, not a
WHAT-is-computed change.

**Every STRICT ancestor directory of `p`, not just `dirname(p)`** — Lead ruling (Call 2), closing a gap a
narrower `dirname(p)`-only version would have left open: for `W1 = Y/a/b` where `Y/a` (W1's own PARENT,
not W1 itself) is the one that remounts as its own git toplevel, the ORIGINAL degraded walk (when the
whole `Y/a/b` chain was absent) landed on `Y` — TWO levels above `W1`, not one. `dirname(W1)` alone is
`Y/a`, whose own fresh key is NOT `Ky`; only walking EVERY ancestor up to the filesystem root (verified
by the `two-levels-up-ancestor-match` test scenario) reaches `Y` and recovers the match. Gated on
`fs.existsSync(dir)` purely as a redundant-walk SKIP, never a correctness requirement —
`canonicalRepoLockKey` already tolerates a non-existent node internally (`@decision 7673d096`) and would
just re-derive the same value a higher existing ancestor's own walk already produces; skipping a
non-existent ancestor only avoids that redundant work.

Consulted ONLY when `hashToRepo` and `unresolvedClaimantsByHash` BOTH miss, at both PASS 1's (`.json`
final, the main read-loop catch branch) and PASS 1b's (`.json.tmp-<pid>` residue, Site C's own twin)
corrupt-latch lookup sites — never stripped of hashes those tiers already claim, since the lookup ORDER
at each site already gives them precedence. Multi-claimant, never a single winner (mirroring 882d6cff
round 3's own lesson for the exact same reason): two registered paths can share one ancestor, and a
genuine corrupt-latch match there must divert to EVERY one of them, not just whichever happens to be
iterated or matched first.

**A match is ALWAYS a pure pending-divert — Lead ruling (Call 1).** The only evidence an ancestor-walk
match carries is "a degraded walk from THIS path would have produced this hash" — never proof that the
path itself currently OWNS the corrupt latch (that's what `hashToRepo`'s own verified tiers are for). So
neither PASS 1's nor PASS 1b's own resolution loop for this tier ever self-heals, migrates, writes, or
arms anywhere — it diverts straight to `pendingUnresolvedQuarantines` (via two NEW, dedicated deferred
collections, `deferredAncestorCorruptJsons`/`deferredAncestorCorruptTmps`, kept SEPARATE from the existing
`deferredCorruptJsons`/`deferredCorruptTmps` precisely so a resolvable ancestor-tier match is never
silently routed through those arrays' own RESOLVABLE self-heal/migrate branch) and leaves the corrupt file
exactly AS WRITTEN, same posture as every other unverifiable-path branch in this function.

### The tier's BREADTH — a deliberate residual, not an oversight (Code Review `2dd4401e`, round 1, item 2)

`ancestorToplevelHashes(p)` calls `canonicalRepoLockKey(dir)` on EVERY strict ancestor directory of `p`
that currently exists — including an ancestor that is NOT, and never was, anyone's git repo at all. For
such a non-repo ancestor, `resolveGitToplevelSync` (the walk `canonicalRepoLockKey` delegates to) finds
no `.git` anywhere above it either, and falls back to the dir ITSELF (its own existence-independent
realpath, unchanged — see `7673d096`'s own "nothing found anywhere" fallback). So the tier ALSO holds
`hash(C:\)`, `hash(C:\Users)`, `hash(C:\Users\<home>)`, … — every plain, non-repo directory on the path
from `p` up to the filesystem root — for EVERY registered path `p`, not just the ones whose ancestor
chain genuinely passes through a real repo.

**This is a NARROWING of the orphan sweep's blast radius, not a widening, and it is SAFE in the
overwhelmingly common direction — but it has one real, named fail-open residual.** Before this tier
existed, a corrupt latch whose hash happened to equal, say, `hash(C:\Users\daniel)` would have matched
NOTHING in `hashToRepo`/`unresolvedClaimantsByHash` (neither is a walking hash of a bare directory) and
fallen to PASS 2's every-repo sweep — fail-CLOSED, quarantining every registered repo. After this tier,
that SAME latch now matches `ancestorHashToRepo().get(hash(C:\Users\daniel))`, which is every registered
path whose ancestor chain passes through `C:\Users\daniel` — likely MOST OR ALL registered repos on a
single-user machine, but not necessarily literally all of them, and NEVER one newly registered at a
sibling location after the latch was filed. **The fail-open case:** if the corrupt latch's TRUE owner was
actually a registered path that has since been REBOUND or MOVED such that it no longer derives
`hash(C:\Users\daniel)` as any of its own ancestor hashes (e.g. a project rebind to a different drive or
a deeply nested relocation), that path is no longer among the ancestor-tier's claimants for this hash —
and if NO other registered path's ancestor chain happens to pass through `C:\Users\daniel` either, the
latch is now UNMATCHED and correctly falls to the orphan sweep (unchanged, correct). But if SOME OTHER,
unrelated registered path's ancestor chain also happens to pass through `C:\Users\daniel` (virtually
guaranteed on a single-user machine with everything under one home directory), the latch now diverts
quietly to THAT unrelated path's pending list instead of ever reaching the orphan sweep — a human
reviewing `listActiveMergeQuarantines()` sees a plausible-looking pending entry for the WRONG repo and
has no signal that the TRUE former owner's own quarantine was ever lost. This is NARROWER in blast radius
than the pre-existing "sweep everything" fail-closed fallback it replaces for this hash, but it trades a
provably-safe-but-noisy signal for a quieter, mis-attributed one in this one specific residual shape.

**This is accepted, not fixed, for THIS card — the non-repo fallback is load-bearing for shape (ii)**
(`regression-shape-ii-enclosing-git-removed`): `Y`'s own `.git` being removed entirely is EXACTLY the
"ancestor exists but has no `.git`" case this breadth note describes, and that scenario's own convergence
depends on `canonicalRepoLockKey(Y)` still returning a value (the same "nothing found, fall back to the
dir itself" value) rather than some narrower, repo-only walk that would return nothing for a non-repo
ancestor. Narrowing `ancestorToplevelHashes` to only repo-rooted ancestors would close part of this
breadth concern but reopen shape (ii).

### The lifecycle this produces (verified, not assumed)

**(a) Blocked at every boot until queried or cleared; `Z` stays open throughout.** While never queried,
the diverted pending entry is stable across any number of restarts — no accumulation, no file churn,
`Z` never touched. `listActiveMergeQuarantines()` (non-mutating) shows it; `activeMergeQuarantineFor` also
shows it, but see (b) — calling THAT to "check if blocked" is itself the next event.

**(b) The FIRST genuine query graduates it to its own verified key, durably.** `activeMergeQuarantineFor`
is BOTH the enforcement check AND the lazy-graduation trigger, by EXISTING, UNCHANGED design
(`consumeMatchedPendingsIntoArmedEntry`) — the moment anything queries a now-resolvable claimant (a real
git-write caller via `withCanonicalIndexLock`, or a test proving enforcement), it writes a fresh union at
the claimant's OWN current key (`Kw1`, never the stale `Ky`) and deletes the stale source file via the
EXISTING `deleteSourceLatchIfSuperseded`'s own sibling-awareness (a no-op skip if ANOTHER still-pending
claimant shares that exact file). No new code was needed for this half — it was already correct;
the gap was entirely in getting the ancestor-tier match to produce a pending entry for this machinery to
later find at all.

**(c) A human clear (by path, or by the latch's own 24-hex id) while still pending lifts it; no
resurrection on a later restart; `Z` stays open.** Verified for both clear routes, single-claimant.

**Multi-claimant clear is round 4's EXISTING, documented pattern — not reinvented here.** Clearing ONE of
two still-pending claimants sharing an ancestor-tier latch must report `latchKept`/`referencingRepoPaths`
(never a bare unqualified success) and leave the shared file in place for the survivor; on a later
restart, BOTH re-divert (multi-claimant tombstoning — recording that one was already cleared so it alone
doesn't come back — is a separate, deferred card: `0dcba62c`, not this one's job).

**Multi-claimant GRADUATION (not clear) — the PINNED, measured restart outcome (Code Review `2dd4401e`,
round 1, item 3).** `W1` and `W2` both divert on `Ky`. Querying ONLY `W1` graduates it (writes `Kw1`,
leaves `Ky` in place since `W2`'s own pending entry still references it — (b)'s own mechanism, unchanged).
`W2` stays pending throughout, confirmed via the non-mutating `listActiveMergeQuarantines()` (querying
`W2` directly to "check" it would itself graduate `W2` too — the exact same trap (b)'s own note names,
and the reason this record's own verification scripts route every "is X still pending" check through the
listing, never `activeMergeQuarantineFor`, until the point where graduating IS the thing being tested).

**On a RESTART (fresh boot, `Ky`'s file still on disk since `W2` still needs it): `W1` RE-DIVERTS from
`Ky` too, measured, not assumed.** `ancestorToplevelHashes` indexes a path's ancestors regardless of that
path's OWN current resolvability (by design — the tier exists precisely because resolvability can change
without the registered path itself changing identity), so `W1` — now resolvable, with its own separate,
valid `Kw1.json` final already on disk — is STILL counted as an ancestor-tier claimant of `Ky` for as
long as `Y` remains one of its ancestors and `Ky`'s file survives. The measured result:
`listActiveMergeQuarantines()` returns `W1` TWICE after the restart — once as its own real, correctly-
keyed active entry (`resolvedKey: Kw1`, read straight off the clean `Kw1.json` parse), and once as a
FRESH, duplicate, ancestor-tier pending entry (no `resolvedKey`) re-created from `Ky.json`'s own PASS 1
catch-branch processing. This is HARMLESS for enforcement: `activeMergeQuarantineFor(W1)` resolves `direct
= activeQuarantines.get(Kw1)` first and returns immediately once `isKeyVerifiedFor` passes, never looking
at the pending list for `W1`'s own identity at all — querying `W1` again post-restart is a no-op on top of
this duplication, and `Ky` still survives (W2's own reference is untouched by any of this). It IS a real,
measured diagnostic-listing duplication — `listActiveMergeQuarantines()` is explicitly a DIAGNOSTIC
snapshot, never itself a correctness query (see that function's own doc comment) — so this is consistent
with its existing contract, but a human or tool reading that listing sees `W1` appear twice with
different shapes and must not read that as "two real quarantines" or "never both" without checking
`resolvedKey` on each. Pinned as its own test scenario
(`multi-claimant-graduation-one-leaves-other-pending`) asserting the EXACT count (2) and that exactly one
of the two carries `W1`'s own `resolvedKey` and exactly one carries none — never a looser "at least one"
assertion that could silently stop discriminating if this shape ever changed.

### A separate, smaller gap found while verifying (c) — `clearMergeQuarantineByKey`'s discarded sweep result

Verifying the multi-claimant clear found that `clearMergeQuarantineByKey` (the function
`clearMergeQuarantine`'s RESOLVABLE branch delegates to) already calls `sweepOwnLatchFileUnlessOwnedElsewhere`
for each removed pending entry's own source file — the SAME helper `clearMergeQuarantineByRecordedPath`'s
UNRESOLVABLE branch already uses to produce its own `latchKept`/`referencingRepoPaths` signal — but
DISCARDED that call's return value outright. So clearing a now-resolvable claimant of a shared-but-still-
pending latch (reachable the moment EITHER claimant in a multi-claimant ancestor-tier divert becomes
resolvable, independent of whether the OTHER one ever does) silently reported a bare success while the
file actually survived underneath it, with no signal to the caller that anything was kept.

**Fixed by capturing and surfacing it** — `clearMergeQuarantineByKey`'s return type widened from `void` to
`{ wasQuarantined: true; latchKept: true; referencingRepoPaths: string[] } | void`, and
`clearMergeQuarantine`'s resolvable branch now `return`s it instead of discarding it (previously a bare
statement call). This is PURELY ADDITIVE — every existing caller (several in-repo test files call
`clearMergeQuarantine`/`clearMergeQuarantineByKey` as a bare statement, ignoring any return value) is
unaffected; the TypeScript return-type widening required adding `wasQuarantined: true` to the new return
object (not merely `latchKept`/`referencingRepoPaths`) to satisfy `clearMergeQuarantine`'s own existing
declared return shape — never inventing a new field beyond what round 4 already established.

**`clearMergeQuarantineReporting` (the REST-route-facing wrapper) never actually surfaces this for a
NOW-RESOLVABLE claimant — and that is correct, not a residual bug.** Its OWN `before =
resolveQuarantineFor(repoPath)` snapshot, taken BEFORE `clearMergeQuarantine` is even called, itself calls
`activeMergeQuarantineFor` when `repoPath` is resolvable — which graduates the claimant RIGHT THERE,
consuming its pending entry (writing it to its own real key, correctly preserving the shared file via the
EXISTING sibling-check in `deleteSourceLatchIfSuperseded`) before the "clear" logic this card touches ever
runs. By the time `clearMergeQuarantineByKey` looks, there is nothing pending left FOR W1 to find — its
OWN quarantine clears completely and cleanly, and the shared file's survival is none of W1's own clear's
business; it is solely because the OTHER claimant's own separate, still-pending claim keeps it alive,
correctly handled by graduation, not by this clear. The fix is reachable (and verified) via a DIRECT call
to `clearMergeQuarantine` — the shape numerous existing test files already use, and a legitimate shape
for any future caller that does not route through the eager `before`-snapshot wrapper — not through
`clearMergeQuarantineReporting` for this specific pre-resolved-claimant shape.

## Regression scenarios checked (manager's shapes ii/iii)

**(ii) `Y`'s own `.git` is removed entirely, and `W1` remounts as a plain subdir (no own `.git`
either).** Still converges, covered by the SAME ancestor tier, for a structural reason worth stating
explicitly rather than assuming: `resolveGitToplevelSync`'s own "nothing found anywhere up to the
filesystem root" fallback returns the NEAREST EXISTING ancestor's own realpath UNCHANGED — regardless of
whether a `.git` was ever found there. `Ky` was ORIGINALLY computed via that exact fallback, triggered by
`W1`'s own absence (nearest existing ancestor = `Y`). Once `Y`'s `.git` is also removed, calling
`canonicalRepoLockKey(Y)` directly (as the ancestor tier now does, treating `Y` as one of `W1`'s strict
ancestors) hits the SAME "nothing found" fallback, returning `Y`'s own realpath AGAIN — the identical
value. This is not guaranteed to hold for every possible shape of "something above a claimant loses its
`.git`" (e.g. if a DIFFERENT, nearer ancestor gains one in the process), but holds for the literal
scenario described and is verified as `regression-shape-ii-enclosing-git-removed`.

**(iii) A corrupt latch's hash equals `W1`'s OWN legacy (direct-identity, never-walked) hash, while its
fresh key differs due to a remount.** A CONTROL, not a new fix — `hashToRepo`'s legacy loop
(`legacyQuarantineHashFor`) runs UNCONDITIONALLY for every registered path regardless of resolvability, so
this was ALREADY correctly matched by the existing tier 1 before this card, both before and after `W1`
remounts (and, for a path at its own git toplevel, the legacy hash equals the fresh hash anyway — `Kw1`'s
own legacy and fresh values coincide the moment it becomes its own repo). Verified, not committed as a
named test scenario (a true control needs no regression coverage of its own).

## Do not

- Do not compute `ancestorToplevelHashes` from `dirname(p)` alone — a remount can be TWO OR MORE levels
  above the registered path itself (the `two-levels-up-ancestor-match` repro); walk EVERY strict ancestor
  up to the filesystem root.
- Do not self-heal, migrate, write, or arm anywhere on an ancestor-tier match, for either PASS 1's or
  PASS 1b's own resolution loop, even when the matched path IS currently resolvable — route it through
  its OWN dedicated deferred collection (`deferredAncestorCorruptJsons`/`deferredAncestorCorruptTmps`),
  never the EXISTING `deferredCorruptJsons`/`deferredCorruptTmps`, whose own resolution loop takes the
  RESOLVABLE self-heal/migrate branch for ANY resolvable `matchedRepo` regardless of which tier found it.
- Do not pick a single winner for the ancestor tier either — two registered paths can share one ancestor
  (and thus one degraded hash) at once; divert every claimant.
- Do not gate `ancestorToplevelHashes`'s per-ancestor `fs.existsSync` check as a correctness requirement —
  it is a redundant-walk skip only; dropping it would still be correct, just slower.
- Do not assume a bare `check("latchKept", ...)` against `clearMergeQuarantineReporting`'s own result
  proves this fix — that wrapper's own eager `before`-snapshot graduates a resolvable claimant first,
  which means it NEVER sees the pending-sweep path this record describes. Call `clearMergeQuarantine`
  directly (or add a NEW resolvable-and-genuinely-still-pending repro) to exercise it.
- Do not extend `clearMergeQuarantineByKey`'s new return value into inventing a distinct notion of
  "partial clear" beyond `latchKept`/`referencingRepoPaths` — that is round 4's own existing vocabulary;
  this fix only makes an existing, already-computed signal reach the caller, nothing more.
- Do not trust the (ii) regression's convergence as a GENERAL property of "removing an ancestor's `.git`
  is always safe" — it holds here because the ORIGINAL degraded walk and the POST-removal ancestor-tier
  walk both hit the SAME "nothing found anywhere" fallback value; a shape where some OTHER ancestor
  gains or loses a `.git` in the process is not covered by this record and was not tested.
- Do not build `ancestorHashToRepo` unconditionally, up front, for every boot — build it LAZILY, on the
  first corrupt-latch miss in tiers 1+2, memoized for the rest of that one boot call. An unreachable
  UNC/SMB registered path's own ancestor walk can otherwise stall EVERY boot for the share's timeout,
  even the overwhelmingly common boot with no corrupt latch to match at all.
- Do not drop `ancestorToplevelHashes`'s non-repo-ancestor fallback (the plain `hash(C:\)`,
  `hash(C:\Users)`, … values a non-repo directory still contributes) without first re-reading "The
  tier's BREADTH" section above AND `regression-shape-ii-enclosing-git-removed` — that fallback is what
  makes shape (ii) (an ancestor's `.git` removed entirely) converge; narrowing it to repo-rooted
  ancestors only would reopen that regression even though it would also shrink the documented residual.
- Do not read a `listActiveMergeQuarantines()` entry count for a graduated claimant as "the number of
  real quarantines" without checking each entry's own `resolvedKey` — a claimant that graduated while a
  SIBLING still shares its old degraded hash's file correctly appears TWICE (one real, one ancestor-tier
  re-divert); see "Multi-claimant GRADUATION" above. Collapsing this to "never both" or "always one" is
  exactly the kind of unverified count this record's own test scenario exists to keep honest.

## Verification

`test/merge-quarantine-ancestor-tier-pending-divert.mjs`, ELEVEN scenarios (each its own child process,
own fresh `LOOM_HOME`): `own-repo-remount-json` (the core repro), `own-repo-remount-tmp` (Site C's twin),
`two-levels-up-ancestor-match` (Call 2's own repro), `multi-claimant-both-remount`,
`multi-claimant-graduation-one-leaves-other-pending` (Code Review `2dd4401e` item 3 — the pinned restart
behavior), `graduation-writes-own-key-and-deletes-stale` (lifecycle a+b),
`clear-by-path-while-pending-no-resurrect` and `clear-by-latch-id-while-pending-no-resurrect` (lifecycle
c, single-claimant), `multi-claimant-clear-one-reports-latch-kept` (lifecycle c, multi-claimant, round 4
pattern), `negative-genuinely-unmatched-still-sweeps` (the required negative control),
`regression-shape-ii-enclosing-git-removed`. 79 individual checks, all passing on main post-fix
(re-derive this count from the test file's own output rather than trusting it restated elsewhere — it
has already changed once, from 65 to 79, when this round's new scenario was added).

**RED/GREEN, measured per-scenario via `pnpm --filter @loom/daemon negative-control`** (reverting
`packages/daemon/src/git/merge-quarantine.ts` to its pre-fix content at the true parent commit, rebuilding,
re-running this test file, then restoring): see the worker report for the exact command and per-scenario
output — never hand-derived.

Also run clean: every other `merge-quarantine*.mjs` file, and `pnpm --filter @loom/daemon guards`.
