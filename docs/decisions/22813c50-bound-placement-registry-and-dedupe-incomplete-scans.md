# 22813c50 — bound the placement registry, dedupe incomplete scans, and fix an empty-frontmatter regex gap

From card `015fdb23` CR round 3 (reviewer `c41d1a65`, 2026-11-02): six non-blocking follow-ups to that
card's cwd-skill permission scan, plus triage notes from the sibling `9d01b4c1` cards (folded into that
record's own "Round 3" — see there for the double-BOM-split asymmetry fix and the static-scan loader
finding this card's own investigation produced).

## M1 — `loomPlacedFingerprintsByCwd` (`skills/inject.ts`) is now bounded

`recordLoomPlacedFingerprint` used to `.add()` every fingerprint ever placed for a (cwd, name) pair into
a `Set` that never shrank — growing for the daemon's lifetime, one entry per content version ever placed.
Fixed two ways:

1. **REPLACE, never accumulate.** Each placement now does `byName.set(name, new Set([fingerprint]))` —
   by the time a scan ever reads this registry, the dir's on-disk content is always whatever the LATEST
   placement wrote, so an older fingerprint can never legitimately match again; keeping it was pure dead
   weight, never a safety margin.
2. **LRU cap on distinct cwds.** The outer map is capped at `LOOM_PLACED_FINGERPRINTS_MAX_CWDS` (300),
   same posture as this file's own `UNTRACKED_CACHE_MAX_ENTRIES`/`PENDING_RECLAIM_MAX_PER_CWD`. Every
   write moves that cwd to the back of the map (insertion order = recency in a JS `Map`); the entry
   evicted when over cap is always the least-recently-placed-into one.
3. **Keyed by `comparisonKey(cwd)`** (`projects/repos.ts`) at both the write (`recordLoomPlacedFingerprint`)
   and read (`injectSkills`'s own lookup) sides — consistent with `sessions/service.ts`'s push-dedupe key
   for the same cwd (case-folded on win32).

**Named residual, by manager decision (LRU over a worktree-removal hook):** a removed worktree's entry
lingers in the map until the LRU cap evicts it or the daemon restarts — nothing here is told when a
worktree is removed, and wiring that notification in would mean a new import from `git/worktrees.ts` into
`skills/inject.ts` for a purely in-memory bound. Accepted: the residual is harmless — it only ever makes
`scanCwdSkillsForPermissionFrontmatter` MORE conservative (a stale entry just means a claimed name keeps
being treated as unverifiable and gets scanned, never the reverse).

## M2 — an incomplete scan now dedupes on its OWN meta key

Before this card, `handleSkillPermissionFrontmatterWarning` (`sessions/service.ts`) never deduped
`incomplete:true` at all — a stable I/O condition (a persistently unreadable `SKILL.md`) re-pushed to the
Companion on every resume, exactly the noise "warn only" (card `015fdb23`'s own owner decision `f635bad6`)
was meant to avoid.

Fixed: `scanCwdSkillsForPermissionFrontmatter`'s result gained `incompleteEntries: {name, errno}[]` — WHICH
entry (or `name:null` for a whole-directory `readdir` failure) made `incomplete` true, plus its OS errno.
`handleSkillPermissionFrontmatterWarning` now keys a SEPARATE meta row, `skill-perm-incomplete-last:<cwd>`,
on the sorted `{name,errno}[]` shape — never the findings-baseline key (`skill-perm-warn-last:<cwd>`),
which an incomplete scan must never read, write, or clear (it didn't genuinely re-verify the repo, so it
can neither erase a real prior sighting nor become a new comparison baseline). The incomplete-key itself
IS cleared on the next scan that completes (clean or with real findings) — "clear it on the next complete
scan" — so a LATER recurrence of the identical I/O condition re-alerts rather than staying deduped forever
against today's sighting.

`incompleteEntries` is threaded through `PtyHostEvents.onSkillPermissionFrontmatterWarning` (minimal edit
— just the type + one call-site field, per manager direction to keep `pty/host.ts` changes small while
card `dfef375f` round 2 is concurrently touching that file) and persisted on the durable
`skill_permission_frontmatter_warning` event (mirroring how `truncated` is already conditionally
included) for diagnostic visibility, never used as a dedupe input on the event itself.

## N1 — `FRONTMATTER_RE` could never match a genuinely empty frontmatter block

`FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---/` cannot match `"---\n---\n..."` (opening and closing
fence on CONSECUTIVE lines, no blank line between) — of ANY size, not just the over-4KB case the CR body
named. The closing-fence sub-pattern `\r?\n---` demands a newline that isn't there: the only newline
between the two fence lines was already consumed by `FRONTMATTER_OPEN_RE`'s own trailing `\r?\n`.
`frontmatterReadIncomplete` then misreports this as "never closed" — observable, per the CR, as a spurious
`readBytes` truncation once the file exceeds `PERMISSION_SCAN_MAX_READ_BYTES` (`head.truncated` only then
being true).

**Fix**, verified with a 7-fixture side-by-side regex comparison (normal skill, empty-adjacent frontmatter
at both short and long-body sizes, blank-line-only frontmatter, inline `---` mid-body-line with a real
closer later, a closer with trailing space, CRLF variants) — zero regressions, bug fixed:

```
FRONTMATTER_RE = new RegExp(`${FRONTMATTER_OPEN_RE.source}(?:([\\s\\S]*?)\\r?\\n)?---`)
```

Wraps the body+newline as one OPTIONAL non-capturing group, so the closing `---` may also follow DIRECTLY
after the opening fence's own already-consumed newline. Checked downstream: `topLevelFrontmatterKeys`/
`flowMappingFrontmatterKeys`/`frontmatterUnrecognizedSyntax` all do `content.match(FRONTMATTER_RE)?.[1];
if (block == null) return ...` — with the fix, a genuinely-empty block now yields `match[1] === undefined`
(the optional group wasn't entered) instead of a failed match, but `block == null` is true either way, and
an empty block legitimately has no keys/unrecognized-syntax to report regardless — so all three functions'
observable behavior is unchanged. Only `frontmatterReadIncomplete` (which uses `.test()`, not the capture)
changes behavior, in exactly the direction the CR wanted.

`skill-permission-widening-guard.mjs`'s own lockstep text copy of `FRONTMATTER_RE` was widened the same
way (plus its own documented `\r?\n?` trailing-newline exception, unchanged) — the lockstep test
(`skill-permission-widening-lockstep.mjs`) compares the two `.source` strings dynamically, so it needed no
change of its own.

## Item 4 — `InjectSkillsResult.claimedFingerprints` doc compressed

Trimmed `skills/inject.ts`'s doc comment for `InjectSkillsResult`/`claimedFingerprints` to the actual
contract plus a pointer at `@decision 015fdb23` (whose own "Round 3"/"Round 4" sections already carry the
forged-sidecar/edited-after-placement history) — no behavior change.

## Item 5 (N2) — the BOM-loader static-scan finding and the double-split fix

See decision record `9d01b4c1`'s own "Round 3" section for the full finding (the real CLI loader honours
exactly one leading BOM, never two or more; UTF-16 BOM needs no special handling) and the four-location
double-split fix it produced (`permissionGuard.ts` ×2, `permission-scan.ts` ×1, and
`permissionWidening.ts`'s own `detectPermissionWidening` ×1 — the last one found during this card's
implementation, not named by any prior CR). Not restated here to avoid a second, driftable copy.

## Item 6 — dead-claim/sidecar trust for DELETE: no action

Re-read `skills/inject.ts`'s dead-claim reclaim block (the worktree-cwd unconditional-delete path and the
shared-cwd pending-reclaim path) specifically for whether the on-disk `.loom-skills-fingerprints.json`
sidecar's mere PRESENCE (as opposed to a content fingerprint independently verified against what's
actually on disk right now) ever drives a delete on its own. It does not: both paths require
`fingerprintSkillDir(target)` to match one of the sidecar's recorded fingerprints before deleting or
reclaiming anything. No privilege gain found; no change made, per the card's own "no action unless you
find a privilege gain" instruction.

## Do not

- Do not let `loomPlacedFingerprintsByCwd` accumulate more than one fingerprint per (cwd, name) again —
  only the LATEST placement's fingerprint can ever legitimately match current on-disk content.
- Do not raise `LOOM_PLACED_FINGERPRINTS_MAX_CWDS` casually — it bounds unconditional daemon-lifetime
  growth across every worktree this process has ever injected into, the same posture this file's sibling
  caps already take.
- Do not key `loomPlacedFingerprintsByCwd` by a raw `cwd` string again — use `comparisonKey(cwd)`, matching
  the push-dedupe key `sessions/service.ts` already uses for the same cwd, so a win32 case-variant can't
  silently split one cwd's bookkeeping into two map entries.
- Do not compute or compare the `skill-perm-incomplete-last:*` dedupe key anywhere other than
  `handleSkillPermissionFrontmatterWarning` — same single-writer posture `015fdb23`'s own "Do not" already
  gives the findings-baseline key.
- Do not let an incomplete scan read, write, or clear `skill-perm-warn-last:*` (the findings baseline), and
  do not let a scan that completes (clean OR with real findings) skip clearing `skill-perm-incomplete-last:*`
  — the two keys track two different questions and must stay independently maintained.
- Do not widen `FRONTMATTER_RE`'s closing fence to accept anything beyond the optional-body-group shape
  above without re-running the 7-fixture regression set this card's fix was verified against (normal,
  empty-adjacent ×2 sizes, blank-line-only, inline-dash-with-real-closer, trailing-space, CRLF).
- Do not restate the BOM-loader finding or the double-split fix's four locations here — they live in
  `9d01b4c1`'s own "Round 3" section; point at it, don't copy it (this file's own "point at a source of
  truth" rule).
