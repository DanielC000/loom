# 509176c8 — a locked role's deliver-all default withholds AGENT-written user-store skills

## Narrative

Code review of card `4d70cc06` (reviewer `fa981283`) flagged a sibling prompt-injection path: setup's
`skill_write` (and the Platform Lead's) writes into the SAME unified store (`~/.loom/skills`,
`SKILLS_DIR`) that `injectSkills` mirrors into every session's ambient `<cwd>/.claude/skills`. Every
bundled Profile seeds `skills: null` (deliver-all) — including the LOCKED roles (`LOCKED_PROFILE_ROLES`,
`profiles/validate.ts`): Companion (untrusted-chat-driven), Setup Assistant (the authoring surface
itself), Elevated Operator (can commit/push), Workspace Auditor (reads user transcripts), and the dev-only
Platform Lead/Audit. So a setup-written skill whose description says "always load this at the start of
every session" would reach a locked role's ambient context with no human ever having scoped THAT skill to
THAT session — gated only by the `confirm:true` attestation (which attests the human saw the skill, not
that the human approved shipping it to every `skills:null` session on the box).

Confirmed by a hermetic probe (temp `LOOM_HOME`, no live daemon touched): a `skillWriteData`-written user
skill landed byte-identical in a simulated Companion session's injected `.claude/skills`, with no role
check anywhere in `injectSkills`.

The owner's ruling refined the naive fix (bundled-only for locked roles): a human who writes their OWN
skill via the Skills UI and relies on the deliver-all default to reach their Companion would otherwise
silently lose it too. The hole is AGENT-written skills, not human-written ones — so provenance was added:
`SKILL_PROVENANCE_FILE` (`paths.ts`) is a flat `{name: "agent"|"human"}` map, OUTSIDE `SKILLS_DIR` (same
reason `SKILL_BASE_DIR` is — `injectSkills` mirrors the whole skill directory, so a sidecar file living
inside a skill's own dir would get copied into every session's ambient skills too). `writeSkill`'s new
optional `provenance` param stamps `"agent"` from the MCP surfaces (`skillWriteData`, shared by
`loom-setup` and `loom-platform`, since `skill_edit` hands off to it too) and `"human"` from the Skills UI
REST routes (`gateway/server.ts`, the only non-agent write path — agents have no REST access, only MCP).

## Do not

- Do not let `injectSkills`'s deliver-all (null/empty subset) branch hand a LOCKED role
  (`LOCKED_PROFILE_ROLES`) a user-store skill whose `skillProvenance()` is `"agent"` or unstamped — an
  unstamped name (predates this tracking, or a future write path that forgets to pass `provenance`) MUST
  read as agent-written. Fail closed, never permissive-by-omission.
- Do not narrow an EXPLICIT non-empty `subset` this way, for any role. `subset` is human-only to set
  (Profiles UI/REST); a human naming a specific user skill by name there is already a deliberate,
  attributable grant — the same trust tier as `vaultWrite`/`capabilities`/`connections` — not the silent
  ambient default this record is about.
- Do not add a NEW `writeSkill` call site that skips the `provenance` argument when the caller knows which
  side of the agent/human boundary it's on. The two existing production call sites (`skillWriteData`'s
  user-skill branch, `gateway/server.ts`'s `POST`/`PUT /api/skills`) are the only places a genuinely new
  user-store skill is created. A bundled-asset write (`skillWriteData`'s `allowBundledAsset` branch,
  `adoptSkillUpdate`) never needs it — bare `isBundledSkill` is what locked-role trust checks today (round
  2 tried a content-equality gate on top of it; round 3 reverted that — see both below).
- Do not store the provenance map inside a skill's own directory under `SKILLS_DIR` — `injectSkills`
  recursively copies that whole directory into every session's ambient `.claude/skills`; a sidecar there
  would leak into agent-visible context, defeating its own purpose as internal bookkeeping.

## Round 2 (fix round, same card, reviewed tip `522148e4`)

The Code Reviewer reproduced a Critical fail-open in the round-1 implementation and three related gaps:

1. **Ordering fail-open.** `writeSkill` wrote SKILL.md content FIRST and the provenance stamp SECOND, and
   `writeProvenanceMap` swallowed its own write failure. Repro: stamp a skill `"human"`, force the stamp
   write to fail (a directory at `skill-provenance.json.tmp`, EISDIR), then write it again as `"agent"` —
   the content landed, `writeSkill` returned `true`, and the stamp still read `"human"`, so a locked role
   would be delivered agent content under a trusted stamp. Fixed: for an `"agent"` write, the stamp is
   downgraded to `"agent"` FIRST and the whole write ABORTS (returns `false`, no content touched) if that
   downgrade fails; `writeProvenanceMap` now returns `boolean` instead of swallowing the error.
2. **Corrupt-map data loss.** `readProvenanceMap` read a corrupt file as `{}` without persisting anything,
   but the NEXT `writeProvenanceMap` call would then overwrite the still-present corrupt file with a
   near-empty reconstructed map, destroying every real stamp it held with no way back. Fixed: on parse
   failure (or a parsed value that isn't an object), the corrupt file is renamed aside to a timestamped
   `<file>.corrupt-<ms>` sibling BEFORE returning an empty map, so a later write creates a fresh file
   instead of overwriting evidence, and the original bytes stay recoverable.
3. **Bundled-name collision.** The locked-role filter trusted `isBundledSkill(name)` alone. An agent can
   author a plain user skill under a name that is NOT YET bundled (stamped `"agent"`); if Loom later ships
   a bundled asset reusing that exact name, `isBundledSkill` flips `true` over the unchanged agent content
   (seed-if-absent never overwrites an existing store dir), and the old filter would admit it as trusted
   "bundled" doctrine. Fixed: added `isTrustedBundledContent(name)` — bundled AND (content matches the
   shipped asset verbatim OR `skillProvenance(name) === "human"`) — and the locked-role filter now calls it
   instead of the bare `isBundledSkill` check. Content-equality (rather than clearing a stale stamp on
   reseed) was chosen because it also correctly covers a Platform Lead `publishSkillToBundled` (store now
   equals the just-published asset, whatever stale stamp sits underneath) and a plain pristine seed (never
   stamped at all) with no extra bookkeeping on either path.
4. **Prototype-pollution-shaped read bug.** `skillProvenance("constructor")` (a syntactically valid skill
   name per `NAME_RE`) returned the inherited `Object.prototype.constructor` function instead of `null`,
   because the map was a plain `{}` and the read was a bracket access + `??`. Fixed: the map is built via
   `Object.create(null)` and `skillProvenance`/`deleteSkill` use an explicit `Object.hasOwn` check instead
   of relying on `in` / `??` against a prototype-bearing object.

## Do not (round 2)

- **Superseded by round 3 below — kept for history, do not follow this bullet as written.** This round
  added `isTrustedBundledContent(name)` (content-equality with the shipped asset, or an explicit `"human"`
  stamp) on top of `isBundledSkill` for locked-role delivery, to close a same-named-future-bundled-asset
  collision. It was reverted in round 3 for regressing legitimate bundled customizations; see there.
- Do not let the `"agent"` branch of `writeSkill` write SKILL.md content before the provenance stamp lands.
  Downgrade the stamp first and abort the whole write on failure — never swallow a stamp-write failure on
  this path.
- Do not let a corrupt provenance map be silently read as `{}` and then overwritten by the next write —
  move the corrupt file aside first so a later write can't erase it.
- Do not read or write the provenance map as a plain `{}` object — use `Object.create(null)` plus an
  explicit `Object.hasOwn` check, since skill names sharing a name with an `Object.prototype` member
  (`"constructor"`, etc.) are valid per `NAME_RE`.

## Round 3 (scope cut, follow-up filed as card `9a3dea30`)

Review of this card's own implementation (reviewer `0c5a7646`) found that round 2's `isTrustedBundledContent`
rule — trust a bundled name only when the store content equals the shipped asset or carries an explicit
`"human"` stamp — regresses two real, non-malicious cases: a legitimately CUSTOMIZED bundled skill (content
diverges from the shipped asset by design, with no `"human"` stamp to fall back on) and the window where a
Platform Lead publishes an advanced asset before the next reseed lands it. Neither is an agent-authored
collision, but both fail the same content-equality check and would be silently withheld from a locked role.

The obvious patch — treat `customized:true` as equivalent to a `"human"` stamp — does not close the gap:
`customized` is derived as `mine !== base`, and `seedBaseSnapshots` backfills `base := shipped` for a name
that collides, so the agent's own colliding content ALSO reads `customized:true`. That signal alone can't
tell "a human customized this" apart from "an agent's user skill happens to not match a later-shipped
asset."

Scope was cut from this card rather than iterated further here: `isTrustedBundledContent` was REMOVED
(store.ts and its one call site in inject.ts), and locked-role trust reverted to round 1's bare
`isBundledSkill(n) || skillProvenance(n) === "human"` — the two regressions above are gone, and so is the
collision defense round 2 added. Closing the collision properly — without regressing legitimate
customization — is tracked as a design-first follow-up, card `9a3dea30`. Two directions are on the table
there: (a) have seeding itself refuse/flag a new bundled name whose store dir already carries an `"agent"`
stamp (rename aside + warn) — closes the hole at the one place a collision can actually arise; or (b) widen
the trust check to `mine==shipped OR mine==base OR stamped human`, plus a one-time boot stamp for legacy
customizations. `9a3dea30` is blocked on this card merging first, and reports a `blocked` checkpoint with
the chosen design before building.

A corrupt-map nitpick was also closed in this round: `writeProvenanceMap` now independently re-checks the
file on disk for corruption and refuses to write if it's still corrupt — closing the gap where
`readProvenanceMap`'s rename-aside call could itself fail (e.g. EPERM) and leave the corrupt file in place
for the next write to silently overwrite.

## Do not (round 3)

- Do not re-add a content-equality (or any other) gate on top of `isBundledSkill` for locked-role trust
  without reading card `9a3dea30` first — the obvious shape (`isTrustedBundledContent`, round 2) was tried
  and reverted here for regressing legitimate customized bundled skills and the advanced-asset-before-reseed
  window. Locked-role trust for a bundled name is bare `isBundledSkill(n) || skillProvenance(n) === "human"`
  again; the bundled-name collision it can't catch is tracked separately, not patched back in here.
- Do not use `customized:true` as a stand-in for a `"human"` stamp to patch this — `seedBaseSnapshots`
  backfills `base := shipped` on a colliding name, so an agent's own colliding content reads `customized:true`
  too. That signal can't discriminate the two cases.
- Do not let `writeProvenanceMap` write over a provenance file that is CURRENTLY corrupt on disk, even when
  the caller already tried and failed to rename it aside — re-check the on-disk file for corruption in
  `writeProvenanceMap` itself before writing, independent of whether the rename-aside succeeded.

## Source

`packages/daemon/src/skills/inject.ts` (`injectSkills`'s `want` computation, back to bare `isBundledSkill`),
`packages/daemon/src/skills/store.ts` (`writeSkill`, `skillProvenance`, `readProvenanceMap`/
`writeProvenanceMap`, `parseProvenanceMap`, `deleteSkill` — `isTrustedBundledContent` removed in round 3),
`packages/daemon/src/paths.ts` (`SKILL_PROVENANCE_FILE`), `packages/daemon/src/mcp/skillTools.ts`
(`skillWriteData`'s user-skill branch), `packages/daemon/src/gateway/server.ts` (`POST`/`PUT /api/skills`),
`packages/shared/src/types.ts` (`SkillSummary.provenance`), `packages/web/src/pages/Skills.tsx` (the
unstamped/agent-authored user-skill badge + re-save-to-trust affordance).
`LOCKED_PROFILE_ROLES` (`packages/daemon/src/profiles/validate.ts`) is the shared locked-role set, also
used by `mcp/setup.ts`'s `SETUP_LOCKED_ROLES` (card `4d70cc06`). The round-3 redesign of the bundled-name
collision case is tracked separately on card `9a3dea30`, not here.
