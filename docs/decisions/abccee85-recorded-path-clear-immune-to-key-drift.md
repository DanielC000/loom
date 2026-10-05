# abccee85 — `/clear-by-path`'s `{repoPath}` form clears by matching the entry's STORED repoPath, never a fresh key recompute

## Context

Delta Code Review `c574056b` of decision `c0be9bf9` round 3 (commit `2ab2f695`) found the SAME class of
key-drift bug round 3 had already fixed for the `{id}` form — still present in `/clear-by-path`'s
`{repoPath}` form.

`GET /internal/merge-quarantine/list` hands out an entry's STORED `repoPath` verbatim, so a human
naturally copies that exact string into a later `POST /internal/merge-quarantine/clear-by-path
{repoPath: ...}` call. The old code (`clearMergeQuarantineReporting(repoPath)`) recomputes
`canonicalRepoLockKey(repoPath)` FRESH at clear time. Under key drift — a nested `.git` removed between
the `/list` call and the `/clear-by-path` call — that fresh recompute can walk UP past the now-gitless
inner directory to an ENCLOSING outer repo's key, so the clear lifts the OUTER entry instead, reports
`ok:true`/`wasQuarantined:true`, and leaves the entry actually named by the given repoPath (inner) fully
armed. On the next boot, inner's own still-durable latch migrates onto the drifted (outer) key and
re-quarantines it — the human believes they cleared it; they didn't.

## Fix

Added `directPathIdentity(repoPath)` (realpath + lowercase-on-win32, NO git-toplevel walk) — factored out
of the existing `legacyQuarantineHashFor` (a pure refactor; that function's own "frozen, never change"
behavior is unaffected, just de-duplicated — asserted byte-identical in
`merge-quarantine-key-migration.mjs`'s existing legacy-hash coverage and a new explicit regression check).

Added `clearMergeQuarantineByRecordedPath(repoPath)`: iterates the in-memory active quarantines directly
and compares each entry's own stored `repoPath` via `directPathIdentity` — never recomputing the walking
key from the GIVEN string — then clears via that entry's own already-known key
(`clearMergeQuarantineByKey`). Falls back to the pre-existing recompute-based
`clearMergeQuarantineReporting` only when no active AND no pending entry's stored repoPath matches at all
(a repo that was never quarantined — see "round 5" below for why a pending match is NOT safe to leave to
the recompute, contrary to what this paragraph originally claimed).

Wired into `gateway/server.ts`'s `/clear-by-path` `{repoPath}` branch ONLY. `/clear` (project-resolved)
is left untouched — its `repoPath` comes from the project registry via `resolveRepoByKey`, not a
potentially-drifted stored latch value, so there is no matching drift window to close there.

Test: `merge-quarantine-clear-by-path.mjs` section (M) — the same nested-git drift fixture shape as
section (L) (round 3's `{id}`-form fix), but driving `clearMergeQuarantineByRecordedPath` directly and,
separately, the real `/clear-by-path` HTTP route with `{repoPath: innerPath}`. Asserts the inner entry is
actually cleared and the outer entry is untouched in the drifted case, with a fixture-sanity pair (no
drift) alongside it.

### Also round 4 (compressed — see `c0be9bf9`'s own record for the full prose)

`quarantineLatchFileIdsFor`'s doc over-claim fixed (`ids[0]` names a real file whenever any armed key has
one, not unconditionally). `merge-quarantine-clear-by-path.mjs`'s "(L negative control, no drift)" labels
renamed to "(L fixture sanity, no drift)" — that check doesn't discriminate the round-3 bug.

### Round 5 (Code Review of `2362064b`): three more occurrences of the same drift class

**Finding 1 — the pending-entry fallback was ALSO drift-prone** (the claim above that it wasn't was
WRONG). The no-active-match fallback recomputed via `clearMergeQuarantineReporting`; a pending entry's
`repoPath` usually can't resolve, so the recompute walks UP to an ENCLOSING repo's key and lifts its
unrelated ACTIVE quarantine instead. Fixed: match `pendingUnresolvedQuarantines` via `directPathIdentity`
BEFORE falling back to the recompute. Test: section (Q), child-process boot, mirrors the reviewer's repro.

**Finding 3 — only the FIRST matching active entry was cleared.** Two raises of the same `repoPath` under
two different keys (an enclosing `.git` appears between them) never merge into one entry. Fixed:
`clearMergeQuarantineByRecordedPath` now collects and clears EVERY matching active entry (de-duped by
identity, since `armedKeys` can put one entry under >1 key). Test: section (R).

**Finding 4 — the reverse of finding 1, with ZERO drift in the caller's own address.**
`clearMergeQuarantineByKey`'s pending-sweep matched via a fresh recompute, so clearing OUTER by its own
exact, never-drifted `repoPath` still swept an unrelated pending INNER entry (INNER's unresolvable path
recomputes to OUTER's key). Fixed: `clearMergeQuarantineByKey` now takes an explicit `identityRepoPath`
and matches pending entries via `directPathIdentity`; all call sites pass it through. Test: section (S).

**Found in round 5, left unfixed as out-of-scope there, FIXED in round 6 below:**
`activeMergeQuarantineFor`'s own lazy pending-resolve shared this shape.

### Round 6 (delta Code Review of `810e485b`) — THE GOVERNING RULE

> A PENDING quarantine entry concerns ITS OWN repo, whose path doesn't resolve right now. It must NEVER
> match a different repo through a freshly re-walked `canonicalRepoLockKey`, at ANY site. A
> never-resolvable nested INNER does not block OUTER. **Pending entries match ONLY by stored identity
> (`directPathIdentity`), everywhere.**

**Finding 1 (BLOCKING) — clear and query had diverged.** `activeMergeQuarantineFor`'s lazy pending-resolve
still matched by a fresh recompute, so `/clear(outer)` reported `ok:true` while a query for outer right
after STILL returned the unrelated pending inner entry (walking to outer's key) — outer stayed blocked
FOREVER, even though its own latch was genuinely gone. Fixed: match via `directPathIdentity` there too.
Test: section (S), rewritten to assert the USER-VISIBLE outcome (`assertRepoNotQuarantined(outer).ok`),
not the latch file — that's what caught this in the first place.

**Finding 2 (MAJOR, pre-existing) — a fresh raise could adopt an unrelated pending entry's identity.**
`enterMergeQuarantine`'s own pending-merge check (decision 54054c01) matched by fresh recompute too, and
`unionQuarantineEntries` keeps the OLDER identity — so raising OUTER while an older, unrelated, pending
INNER latch recomputed to the same key silently rewrote the live raise's `repoPath` to INNER's, and a
later `/clear-by-path {repoPath: INNER}` lifted OUTER's real unconfirmed-kill quarantine. Fixed: match via
`directPathIdentity`; never merge entries across identities. Test: section (T).

**Item 3 — `assertRepoNotQuarantined`'s reason now names the BLOCKING entry's own `repoPath` and latch id
(`quarantineLatchFileIdsFor(q)[0]`), and points at `/clear-by-path`** (never bare `/clear`, which
structurally cannot address a repo that isn't itself a registered project). The blocking entry's own
`repoPath` can differ from the one asked about — not just via the (now-fixed) pending drift, but by
design: querying a SUBDIRECTORY of a quarantined repo returns the ROOT's entry (decision 7673d096). Test:
section (V), both the ordinary case and the differs-from-query case.

**Item 4 — `clearMergeQuarantineByRecordedPath`'s pending branch now drops EVERY identity-matching pending
entry**, consistent with `clearMergeQuarantineByKey`'s own filter (more than one pending latch can share
one identity). Test: section (U).

**Additional finding (grep audit, not in the original 4) — `partitionQuarantinesByRegistration`.** A
pending entry was classified `registered:true` whenever its unresolvable path happened to recompute to a
REGISTERED repo's key — the same drift class, for display/boot-summary purposes rather than clearing.
Fixed: a pending entry (checked by reference against `pendingUnresolvedQuarantines`) is matched against
`registeredRepoPaths` via `directPathIdentity`; an active entry keeps the existing `canonicalRepoLockKey`
match (needed for the tested spelling-variant case, section K). Test: section (W).

**Grep audit verdict (every remaining `canonicalRepoLockKey` use in the file):** every other call computes
a key for an entry's OWN identity (writing/deleting its own latch, arming itself into `activeQuarantines`,
hashing a REGISTERED repo for boot matching) — none of them compare against a DIFFERENT, already-existing
pending entry's identity, so none share this bug class. One adjacent, NOT fixed, NOT this class: PASS 1b
(tmp-residue recovery) arms a recovered tmp unconditionally, never deferring to `pendingUnresolvedQuarantines`
even when its own path is unresolvable (PASS 1 proper does defer) — a pre-existing asymmetry, not a
cross-entity identity match, left to a follow-up card if it matters.

### Round 7 — the governing rule's own fail-open residual, plus the last-resort fallback's own drift

**Finding 1 — identity-only matching (round 6's governing rule) itself fails OPEN for one legitimate
shape.** A pending latch raised on a NESTED path (e.g. `R/sub`) that has SINCE become resolvable again,
queried LATER via a DIFFERENT path denoting the SAME physical repo (e.g. `R` itself) — neither
`directPathIdentity` nor identity-only matching ever treats two different physical path STRINGS as equal,
so a query that never happens to repeat the pending entry's own exact stored path finds nothing, forever,
even once the repo is fully back on disk. `activeMergeQuarantineFor` now adds two further fallback passes,
tried in order, only once plain identity matching has already missed:

1. **`ancestorAwarePathIdentity`** (new, `merge-quarantine.ts`) — realpaths the nearest EXISTING ancestor
   (via `repo-lock.ts`'s now-exported `findExistingAncestorRealpath`, never `canonicalRepoLockKey`'s own
   toplevel walk) and reattaches whatever trailing segments don't exist yet, literally. This normalizes a
   junction/8.3-short-name-spelled EXISTING ancestor segment without ever treating an unrelated enclosing
   repo as a match: the non-existent tail is carried verbatim, so two paths only compare equal here when
   they denote the EXACT same (possibly not-yet-existing) location.
2. **A walked-key (`canonicalRepoLockKey`) match, gated STRICTLY on
   `isRepoPathCurrentlyResolvable(p.entry.repoPath)`** — the module's own graduation test. Only once the
   pending entry's OWN path genuinely resolves is a git-toplevel walk of it trustworthy (a real walk, not
   `resolveGitToplevelSync`'s own existing-ancestor FALLBACK, which only fires for an unresolvable path and
   is exactly what makes a coincidental collision possible) — this is what lets a query for `R` find a
   pending entry raised on `R/sub` once `R/sub` resolves again. Never applied to a still-unresolvable
   entry — that is precisely the (S)/(T)/(W) repro shape (inner paths that never resolve), which must stay
   matched by identity alone, per the round-6 governing rule.

Both passes are SAFE additions to the governing rule, not exceptions to it: neither can ever match a
pending entry to an unrelated enclosing/sibling repo the way a bare recompute-on-an-unresolvable-path
could — pass 1 only matches the exact same location (spelling aside), and pass 2 only trusts a REAL
(resolvable) walk, never a coincidental fallback one. Test: `merge-quarantine-unresolvable-path.mjs`'s new
R/sub-then-query-R case (RED on `2ad0c7ac`, GREEN after); `merge-quarantine-clear-by-path.mjs`'s (S)/(T)/(W)
sections re-run unchanged and stay green, confirming neither fallback reopens that hazard.

**Finding 2 — `clearMergeQuarantineByRecordedPath`'s OWN last-resort fallback recomputed from the
human-supplied string.** Once neither an active entry's nor a pending entry's stored `repoPath` matches at
all, the old code fell through to `clearMergeQuarantineReporting(repoPath)` — which recomputes
`canonicalRepoLockKey(repoPath)` fresh. A typo'd or stale `{repoPath: "<outer>/typo"}` (a path that was
NEVER itself quarantined, active or pending) walks UP past the non-existent leaf to `<outer>`'s own real
`.git` and, if `<outer>` is itself genuinely quarantined, LIFTS that unrelated, real quarantine while
reporting `wasQuarantined:true` — the opposite of what round 5/6 already fixed for the pending-entry case,
reached through the "nothing matches at all" door instead. The comment above this fallback claiming the
recompute "is not drift-prone" was itself wrong: it IS, whenever the given string resolves to nothing but
shares a real ancestor with something that does.

Fixed: the fallback no longer recomputes anything. It reports `{ wasQuarantined: false, reason: "..." }`
naming `GET /internal/merge-quarantine/list` as where to find the exact recorded `repoPath`/id to clear
by — a plain not-found, never a collateral lift. `/clear-by-path`'s `{repoPath}` HTTP route threads the
`reason` through. Test: `merge-quarantine-clear-by-path.mjs` section (X).

### Traced, not fixed: pending entries' `orphanLatchFiles` sweep gap

A PASS-2 fail-closed entry persists no `resolvedKey`; if its path later becomes unresolvable it reloads as
PENDING, still carrying old `orphanLatchFiles` that neither pending-removal branch ever looks at — only the
entry's own `sourceFile` is deleted. Repro: section (P), informational (never fails the suite). A follow-up
card (`discoveredFrom: abccee85`) owns the fix.

## Do not

- Do not recompute `canonicalRepoLockKey` from a human-supplied `repoPath` string to decide WHICH entry to
  clear in `/clear-by-path`'s `{repoPath}` form — match by each entry's own STORED `repoPath` via
  `directPathIdentity` first (never the walking key), and clear via that entry's own already-known key.
  Recomputing can drift onto a different (e.g. enclosing outer) repo's key the instant the given
  directory's own `.git` disappears between match and act.
- Do not apply this same fix to `/clear` (project-resolved) without first checking whether its `repoPath`
  can ever be a drifted/stale value too — today it always comes fresh from the project registry, so the
  drift window this fix closes does not exist there.
- Do not "fix" `legacyQuarantineHashFor`'s behavior while extracting `directPathIdentity` from it — the
  extraction must be byte-identical; that function's own doc already states why it must never change.
- Do not let `clearMergeQuarantineByRecordedPath`'s no-match fallback skip straight to the recompute (round
  5, finding 1) — check `pendingUnresolvedQuarantines` via `directPathIdentity` first.
- Do not return from `clearMergeQuarantineByRecordedPath`'s active-entry loop on the first match (round 5,
  finding 3) — collect and clear every matching active entry.
- Do not match a pending entry inside `clearMergeQuarantineByKey` via a fresh recompute (round 5, finding
  4) — compare via `directPathIdentity` against the caller's own `identityRepoPath`.
- **THE GOVERNING RULE (round 6): a pending entry matches ONLY by stored `directPathIdentity`, at ANY
  site, full stop** — never a freshly re-walked `canonicalRepoLockKey`, whether matching for a CLEAR, a
  QUERY (`activeMergeQuarantineFor`), a RAISE's own pending-merge (`enterMergeQuarantine`), or a
  REGISTRATION classification (`partitionQuarantinesByRegistration`). A never-resolvable nested repo must
  never block, adopt the identity of, or be misclassified as an unrelated enclosing one.
- Do not let `clearMergeQuarantineByRecordedPath`'s pending branch drop only the first identity-matching
  entry (round 6, item 4) — drop every one, consistent with `clearMergeQuarantineByKey`.
- Do not let `assertRepoNotQuarantined`'s reason point only at bare `/clear` or omit the blocking entry's
  own `repoPath`/latch id (round 6, item 3) — the blocking entry can differ from the one asked about, and
  `/clear` alone can be a dead end for it.
- Do not treat the pending-entry `orphanLatchFiles` sweep gap (traced above) as fixed by this card.
- Do not add `activeMergeQuarantineFor`'s round-7 walked-key fallback without gating it on
  `isRepoPathCurrentlyResolvable(p.entry.repoPath)` — an ungated walk reopens exactly the (S)/(T)/(W)
  coincidental-ancestor-collision hazard the round-6 governing rule exists to close.
- Do not fold `ancestorAwarePathIdentity` into `directPathIdentity` itself, and do not have it walk via
  `canonicalRepoLockKey`/`resolveGitToplevelSync` — it must stay a pure existing-ancestor realpath with a
  LITERAL non-existent tail, or it stops being safe against the same hazard.
- Do not let `clearMergeQuarantineByRecordedPath`'s final fallback recompute `canonicalRepoLockKey` from
  the given string when nothing active or pending matches (round 7, finding 2) — report
  `{wasQuarantined:false, reason}` naming `GET /internal/merge-quarantine/list` instead.
