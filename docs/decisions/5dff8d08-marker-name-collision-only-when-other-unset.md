# 5dff8d08 — reject a reserved-home marker on NAME grounds only with BOTH signals present

## Context

Card a47dd144 (round 2) added a NAME-collision check to `resolveReservedHomeByMarker`'s marker
validation, alongside the existing id-collision check: a marked row was rejected, UNCONDITIONALLY, if its
`name` matched one of the OTHER home's own name candidates. That check was needed because the id check
alone is blind to a marker mis-stamped to the OTHER home's row while that other home's OWN marker has
never been stamped (there is no id to compare against yet) — e.g. setup's marker accidentally pointing at
the still-unmarked "Loom Platform" row.

Card 5dff8d08 (closing out the remaining name-based reserved-home lookups) went through three fix
iterations, each closing a real gap the previous one left open:

**Fix 1 — narrow a47dd144 round 2's ORIGINAL, unconditional check to fire only while `otherId` is
unset.** The original check fired any time the marked row's current name happened to match one of the
other home's name candidates, regardless of whether the OTHER marker was already stamped. This broke a
routine, fully-supported action: renaming the reserved "Loom Platform" home to "Platform" or "Getting
Started" (both real names of the OTHER, setup home) via `PATCH /api/projects/:id` rejected the platform
marker's own valid, non-id-colliding id, silently emptying every runtime call site built on it, including
`LOOM_HOME_INSTRUCTION_WRITE_DENY_REGISTRY`'s feed. Fix: gate the name check on `otherId == null`.

**Fix 2 — Fix 1 was itself incomplete: `otherId == null` is not a rare, transient window — it is the
PERMANENT, default state of the platform marker on every LOOM_DEV-off install** (every `loomctl` user).
Renaming the SETUP home to "Loom Platform" still tripped the (now-narrowed) check, breaking setup
resolution outright. Worse: `resolvePlatformHome`'s own name fallback then found the just-renamed SETUP
home and WRONGLY STAMPED `platform.homeProjectId` onto it — nothing in the fallback loop excluded a row
the OTHER marker already owned — corrupting both markers onto one id, minting a duplicate setup home on
the next boot, and permanently blocking the real platform home from ever seeding. Two fixes: (a) the
name-fallback loop never backfills a marker onto an id the OTHER marker already holds
(`byName.id !== otherId`); (b) [as first written] reject the marked row on name grounds only if a
DIFFERENT, archive-inclusive real row matching THIS home's own `nameCandidates` exists anywhere — dropping
the "marked row looks like the other's name" signal entirely, and dropping the now-unused
`otherNameCandidates` parameter.

**Fix 3 — Fix 2(b) was ALSO too broad, in a way a further delta review's probes (P5/P5b) demonstrated.**
Checking "does ANY row, archive included, match this home's own candidate names" — without ALSO requiring
the marked row to itself look like the OTHER home — fires on completely innocent install states:
- **P5:** a LIVE, unrelated stale duplicate/orphan row happening to carry one of THIS home's own candidate
  names (e.g. a leftover sitting on the legacy literal) made the resolver abandon a correctly-marked,
  merely-renamed home and flip resolution onto the orphan instead.
- **P5b:** the same failure via an ARCHIVED orphan — the home appears to "vanish," because resolution
  lands on the archived orphan, which a LIVE-only caller (`resolveLiveSetupHome`) then correctly reports
  as absent.

Fix: require BOTH signals together. Restore `otherNameCandidates` and the "marked row's own name looks
like the OTHER home's" check from Fix 1, AND require a distinct, LIVE (never archived) row matching THIS
home's PRIMARY (current, non-legacy) name specifically — checking the legacy candidate too reopens P5 (an
orphan can squat on the vacated legacy slot while the marked row's own primary name sits free).

## The by-design trusted case

A marker that genuinely points at the OTHER home's actual row (a real mis-stamp, not an innocent rename)
is TRUSTED — not rejected — whenever no distinct LIVE row exists under THIS home's own primary name. This
is INDISTINGUISHABLE, from inside `resolveReservedHomeByMarker`, from the legitimate case this whole card
protects (a home renamed to overlap the other's name): once the id doesn't collide and no competing live
candidate exists elsewhere, there is no remaining signal that could tell the two apart. This is an
accepted, deliberate gap, not an oversight — and Fix 2(a) makes it UNPRODUCIBLE through any code path
going forward (the name-fallback loop can no longer stamp a marker onto the id the OTHER marker owns), so
reaching it at all now requires direct external corruption of `app_meta`, not anything a seeder, a rename,
or any runtime call site can trigger on its own.

## Verified

`setup-home.mjs`'s (12a)/(12b) scenarios pass on commit `0937e3cc` too (Fix 1 alone, before Fix 2 or Fix 3
existed) — they are REGRESSION PINS for a47dd144 round 2's original collision defense, not evidence
specific to either later fix. The fix-specific evidence lives elsewhere:
`platform-home-paths-rename.mjs` §7/§8 are RED on `0937e3cc` and GREEN only once Fix 2 lands; §9 (P5) and
§10 (P5b) are RED on `e10122b5` (Fix 2 alone, before Fix 3) and GREEN only once Fix 3 lands.

## Do not

- Do not reject a marked, non-id-colliding, reserved row UNLESS BOTH hold: its own current name looks
  like the OTHER home's candidates, AND a distinct LIVE row matches THIS home's PRIMARY (current,
  non-legacy) name. Neither signal alone is safe — name-only rejects an innocent rename (Fix 1/2's bug);
  distinct-candidate-only, checked archive-inclusive across every candidate, rejects an untouched home
  because of an unrelated orphan (Fix 3's bug — P5/P5b).
- Do not widen the distinct-candidate check to also match the LEGACY name, or to count an ARCHIVED row —
  both reopen exactly the P5/P5b failures this record exists to prevent.
- Do not remove the `byName.id !== otherId` guard in the name-fallback loop (Fix 2(a)) — without it, an
  unmarked marker's fallback can again silently backfill onto a row the OTHER marker already owns.
- Do not assume `otherId == null` is a rare/transient state — it is the PERMANENT, default state for the
  platform marker on every LOOM_DEV-off install. Any fix here must be correct in that steady state, not
  just in a momentary window before both markers get stamped.
- Do not treat "a marker pointing at the OTHER home's own row is trusted when no live competing candidate
  exists" as a bug to close further — it is accepted by design (see above), and already unreachable
  through any code path now that Fix 2(a) is in place.
