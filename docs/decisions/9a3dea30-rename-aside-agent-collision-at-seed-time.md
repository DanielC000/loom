# 9a3dea30 — rename an agent-collision aside at SEED time, gated purely on the provenance stamp

## Narrative

Split out of card `509176c8` (round 3 scope cut, reviewer `0c5a7646`). The hole: an agent writes a plain
user skill named X (`writeSkill(X, content, "agent")`, stamped `"agent"`, correctly withheld from locked
roles under card 509176c8's `isBundledSkill(n) || skillProvenance(n) === "human"` filter). Later, Loom
ships a bundled asset also named X. `isBundledSkill(X)` is pure name-membership against the live asset
dir (`bundledNames()`), so it flips `true` the instant that asset ships — regardless of what is actually
sitting in the store. `seedGlobalSkills()` is seed-if-absent (decisions `93c5f26c`/`7f73979f`): it never
overwrites an existing `SKILL.md`, so X's agent content survives byte-identical. `seedBaseSnapshots()`
still backfills `base := shipped` for the now-bundled name, so the unchanged agent content also reads
`customized:true` — a signal that looks exactly like a real human customization but isn't one. The
locked-role filter's `isBundledSkill(X)` branch now admits the unreviewed agent content as trusted
"bundled" doctrine.

Round 2 of `509176c8` tried `isTrustedBundledContent(name)` — bundled AND (content matches the shipped
asset verbatim OR stamped `"human"`) — as the locked-role trust check itself. It regressed two real,
non-malicious cases and was reverted in round 3:
- A legitimately CUSTOMIZED bundled skill (content diverges from shipped by design) with no `"human"`
  stamp to fall back on — e.g. a customization made before provenance tracking existed at all.
- The window where a bundled asset has advanced (a merged doctrine fix) ahead of the store's own copy,
  before the next boot's `autoFastForwardPristineSkills()` reseeds it — a 100% legitimate pristine skill
  that simply hasn't been reseeded yet, wrongly read as untrusted because `mine != shipped`.

Direction (a), approved and implemented here: instead of widening the READ-side trust check (which is what
kept reintroducing content-equality brittleness), close the hole at the one place the collision can
actually arise — `seedGlobalSkills()` itself. `renameAsideAgentCollision(name)` (`skills/store.ts`) runs
for every bundled asset name, every boot, BEFORE the existing seed-if-absent check: if the store already
holds an AGENT-stamped dir under that name, the whole dir is renamed aside to a fresh, non-colliding
user-skill name (content preserved verbatim), the provenance stamp follows it, and the normal fresh-seed
path then runs against a clean slate.

**Round 2 correction (code review of commit `2b89bbd3`): the claim that followed here — that `inject.ts`'s
locked-role filter could stay UNCHANGED because no state could fool it — was WRONG.** See "## Round 2"
below for why and what closed it.

## Why direction (a) avoids both round-2 regressions

The gate is `skillProvenance(name) === "agent"` ONLY — never content-equality, never `customized`:
- A legitimately customized bundled skill is stamped `"human"` (any write through the Skills UI /
  `PUT /api/skills/:name` stamps `"human"` unconditionally, bundled or not) or unstamped (a customization
  predating provenance tracking) — never `"agent"`. The gate never fires for it, regardless of how far
  `mine` diverges from `base`/`shipped`.
- A pristine bundled skill lagging behind a freshly-merged asset (not yet reseeded) was never
  agent-stamped either. The gate never fires for it, regardless of how far `mine` lags `shipped`.

Direction (b) (widen the trust check to `mine==shipped OR mine==base OR stamped human`, plus a one-time
boot stamp for legacy customizations) was considered and rejected: it is still a content-comparison gate
at the READ side, so it reintroduces exactly the brittleness class round 2 was reverted for — it would
just patch more cases onto the same shape instead of removing the possibility of the collision ever
reaching the read side at all.

## The legacy-unstamped residual (explicitly NOT fixed here)

An agent-written user skill created BEFORE provenance tracking existed (card `509176c8`) has no provenance
entry at all — `skillProvenance()` reads `null`, not `"agent"`. If Loom later ships a bundled asset under
that same name, `renameAsideAgentCollision`'s gate (`=== "agent"`) does not fire, and the collision still
slips through exactly as before this fix: `isBundledSkill` flips true, the agent content is admitted to
locked roles.

Checked: no boot migration anywhere in the codebase back-stamps legacy/unstamped skill entries (grepped
`skillProvenance`/`SKILL_PROVENANCE_FILE` across `packages/daemon/src` — the only references are
`skills/store.ts`, `skills/inject.ts`, and the `paths.ts` constant declaration; no seed/migration file
touches it). None is added here, deliberately: there is nothing on disk that can tell a legacy
agent-written skill apart from a genuine, long-standing user skill a human wrote by hand before the
provenance map existed — stamping either as `"agent"` risks wrongly withholding a human's own skill from
their own locked-role Companion, which is the exact harm card `509176c8`'s own ruling was written to
avoid. This residual is accepted as the documented cost of (a)'s scope ("closes the hole at the one place
the collision can arise" — a NEW agent-stamped collision, not every historical one).

## Crash-safety ordering

`renameAsideAgentCollision` writes in this order: (1) stamp the NEW name `"agent"` in the provenance map
(atomic tmp+rename write, via the existing `writeProvenanceMap`); (2) move the directory via a single
atomic `fs.renameSync` (never a copy+delete — a copy could crash mid-copy and leave a half-written dir at
the destination); (3) clear the OLD name's stamp. A crash between any two steps leaves the content fully
intact under exactly one of {old, new}, and the function is idempotent on retry at the next boot:
- Crash before (1), or between (1) and (2): the OLD dir's `SKILL.md` is still present, so the function
  re-enters its normal path on the next boot, re-picks the same deterministic candidate name (or, if that
  exact synthetic name was somehow taken in the interim, the next numbered variant), re-writes the (now
  idempotent) stamp, and completes the move.
- Crash between (2) and (3): the OLD dir's `SKILL.md` is now absent (already moved to NEW), so the
  function's early-return branch fires on the next boot: it detects the dangling `"agent"` stamp with no
  SKILL.md to protect, clears it, and returns — BEFORE that same boot's normal fresh-seed path runs for
  `name`. This ordering matters: without it, a later boot could seed fresh bundled content under `name`
  while the stale `"agent"` stamp still lingered, and a FUTURE unrelated boot of this same function would
  then wrongly re-fire against the (by-then legitimate) bundled content, mistaking it for the original
  agent content and renaming it away.

Fault-injected directly (not via literally killing the process mid-syscall, which a hermetic unit test
cannot do): the test constructs the exact on-disk + provenance-map state that would exist immediately
after each interruption point above, then calls `seedGlobalSkills()` ("reboot") from that state and
asserts convergence to the correct final state with no data loss and no incorrect exposure. See
`packages/daemon/test/skills-bundled-name-collision-repro.mjs`.

## Warning surface

No durable, DB-backed event surface fits this: `seedGlobalSkills()` runs at daemon boot BEFORE the DB
opens (`index.ts`: `seedGlobalSkills()` precedes `new Db(...)`), and the one durable event table that
exists for orchestration occurrences, `orchestration_events`, requires a `manager_session_id` — there is
no session of any kind at this point in boot. Widening `seedGlobalSkills()`'s own return shape (today a
bare `string[]` of seeded names, consumed by a `console.log` in `index.ts`) to also carry rename events was
considered and rejected: at least six existing test files destructure its return value directly as an
array (`seeded.includes(...)`), and changing the shape for a documented low-likelihood event is not worth
that blast radius.

The warning is a `console.log` line from `renameAsideAgentCollision` itself (naming both the old and new
name and the reason) — the SAME visibility tier every other seed-time decision in this file already gets
(`retireOrphanedBundledSkillDirs`, `autoFastForwardPristineSkills`, the backfill branches of
`seedGlobalSkills`), landing in the daemon's own output log. The renamed skill is also self-documenting:
once renamed, it shows up as an ordinary new user skill (provenance `"agent"`, name
`<original>-agent-renamed`) in `listSkills()` / the Skills UI with no further plumbing — a human reviewing
Skills will see an unexpected new entry whose name itself states what happened.

## Round 2 — the self-host live-asset window (code review of commit `2b89bbd3`)

`seedGlobalSkills()` only runs at daemon BOOT. On self-host, `ASSET_SKILLS` is read LIVE off the main checkout (`bundledNames()`, `isBundledSkill()`) — so the moment a bundled asset merges onto main, `isBundledSkill(X)` flips `true` immediately, long before the next boot ever runs `renameAsideAgentCollision`. Round 1's own claim that the locked-role filter could stay bare `isBundledSkill(n) || skillProvenance(n) === "human"` was wrong: between that merge and the next restart, an existing agent-stamped collision at `X` is admitted to a locked role as trusted "bundled" doctrine — exactly the original hole, just narrowed to this window instead of closed outright.

Four fixes landed together:

1. **A second, provenance-only guard in `inject.ts`'s locked-role filter**: `(isBundledSkill(n) && skillProvenance(n) !== "agent") || skillProvenance(n) === "human"`. Still gated purely on the stamp, never content-equality — the SAME discipline as `renameAsideAgentCollision` itself, so none of round 2 of `509176c8`'s regressions (a legitimately customized bundled skill, a pristine skill lagging behind a freshly-merged asset) return: neither case is ever stamped `"agent"`.
2. **Every write path that lands genuinely-bundled content under a name must clear a stale `"agent"` stamp**, or guard 1 above would wrongly withhold a now-legitimately-bundled skill from every locked role forever after. `clearSkillProvenance(name)` (store.ts) is called from `resetSkillToBundled`, `adoptSkillUpdate`, and the loom-platform bundled-asset `skill_write` path (`skillWriteData` with `allowBundledAsset:true`) — the three places bundled content can land outside `renameAsideAgentCollision` itself (which already clears its own old stamp).
3. **The crash-safety step-3 stamp clear's failure is no longer ignored.** `renameAsideAgentCollision` now returns `{newName, stampCleared}`; `seedGlobalSkills()` skips fresh-seeding that name THIS boot when `stampCleared:false` (the content already moved, but the old name's "agent" stamp still dangles) — seeding fresh bundled content under the old name while that stamp dangles is exactly the state that makes a LATER boot mistake the by-then-legitimate bundled copy for the original agent content and rename it away again. The clear is retried on a later boot via the function's own crash-recovery branch.
4. **The renamed-aside skill's own frontmatter `name:` is rewritten** to its new directory name. Left declaring the OLD (now bundled) name, it would hand an unlocked session two skills both claiming the same harness name — the genuinely bundled one and this renamed-aside copy.

Tested end to end, including fault injection on item 3's stamp clear and a positive control proving each new assertion goes RED against the pre-round-2 code: `packages/daemon/test/skills-bundled-name-collision-repro.mjs`.

## Do not

- Do not gate `renameAsideAgentCollision` on content-equality or `customized` — only on
  `skillProvenance(name) === "agent"`. Either of the other two reintroduces the exact round-2 regressions
  (a legitimately customized bundled skill, or a pristine skill lagging behind a freshly-merged asset).
- Do not reorder the three writes (stamp new, move dir, clear old) — the crash-safety section above is
  what makes a crash at any point self-heal on the next boot instead of either losing content or silently
  re-admitting it as bundled.
- Do not add a boot migration that back-stamps unstamped legacy skills as `"agent"` to close the residual
  above — there is no way to distinguish a legacy agent-written skill from a human's own long-standing
  user skill, and guessing wrong silently withholds a human's own skill from their own Companion.
- Do not widen `seedGlobalSkills()`'s return shape to surface a rename event without first checking every
  existing call site that destructures it as a bare array (`skills-store-durability.mjs`,
  `skills-seed-asset-override.mjs`, `skills-seed-asset-override-default.mjs`, and others) — this is why a
  `console.log` was chosen instead for this card.
- Do not re-add `isTrustedBundledContent` (round 2 of card `509176c8`'s content-equality trust check) to `inject.ts`'s locked-role filter — see that card's own record for why it was reverted. This is a different thing from the round-2 PROVENANCE-ONLY guard added here (item 1 above) — that guard fires on the stamp alone, never on how far `mine` diverges from `shipped`, so it does not reintroduce those regressions.
- Do not let a write path that lands bundled content under a name skip `clearSkillProvenance` — any future such path needs the same call, or a stale `"agent"` stamp silently withholds it from every locked role (round 2, item 2).
- Do not let `renameAsideAgentCollision`'s final stamp-clear failure be silently ignored by its caller — `seedGlobalSkills()` must skip fresh-seeding that name THIS boot (round 2, item 3), never seed over a dangling stamp.

## Source

`packages/daemon/src/skills/store.ts` (`renameAsideAgentCollision`, `pickRenameAsideName`, `renameFrontmatterName`, `clearSkillProvenance`, `resetSkillToBundled`, `adoptSkillUpdate`), `packages/daemon/src/skills/seed.ts` (`seedGlobalSkills`'s per-entry loop — calls `renameAsideAgentCollision` before the existing seed-if-absent check, and skips the seed on `stampCleared:false`), `packages/daemon/src/skills/inject.ts` (the locked-role filter's provenance-only guard), `packages/daemon/src/mcp/skillTools.ts` (`skillWriteData`'s bundled-asset path), `packages/daemon/test/skills-bundled-name-collision-repro.mjs`.
