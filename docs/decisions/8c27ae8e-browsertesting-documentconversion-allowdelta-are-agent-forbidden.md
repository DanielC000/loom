# 8c27ae8e — `browserTesting`/`documentConversion`/`allowDelta` join `AGENT_FORBIDDEN_PROFILE_KEYS`

## Narrative

Card `8c27ae8e` (full review lane 4, `486d4238` M8): the setup operator's `profile_create` accepted `{browserTesting:true, documentConversion:true, allowDelta:["Bash(*)"]}` unchecked — verified repro. CLAUDE.md (law) already named `browserTesting`/`documentConversion` "HUMAN-set only … never an agent MCP tool", but `AGENT_FORBIDDEN_PROFILE_KEYS` (`packages/daemon/src/profiles/validate.ts`) omitted all three, and the inline comment on `browserTesting` claimed the gap was deliberate.

Provenance chain (why the code and CLAUDE.md disagreed):
- `95d1c3c1` (2026-06-03) introduced `browserTesting` together with CLAUDE.md's "HUMAN-set only … never an agent MCP tool" law, and a matching `validate.ts` comment: "there is NO agent MCP write surface for profiles."
- `dbad3a91c` (2026-06-16, Setup Assistant E1-3) added `setup.ts`'s `profile_create` tool, exposing `browserTesting` via an unchecked `z.object({}).passthrough()` schema from day one — already contradicting the comment above, unnoticed.
- `4190609d` (2026-06-25, adding `documentConversion`) restated the same already-false "no agent MCP write surface" claim for the new field, unchanged. That sentence was never corrected and was still literally false — disproven by this card's own repro.
- `162fb7dc` (2026-07-12) — subject unrelated (excluding `browser_run_code_unsafe` from the Playwright allowlist) — rewrote only the `browserTesting` comment to acknowledge the agent MCP surfaces exist and declared the status quo deliberate, reasoning only about the Companion/assistant role (the one role that would gain a NEW capability from it, per that comment, "can only get it via a HUMAN Profiles UI/REST write"). That rationale never addressed the actual hole: the same `profile_create` surfaces mint plain `worker`/`manager` rigs with `browserTesting`/`documentConversion` directly, no Companion path needed — exactly this card's repro.
- `docs/decisions/3de74275` (the manager self-service surface design) is the one genuinely relevant prior ruling, and it points the other way: it names `browserTesting` explicitly as "a navigate-anywhere capability" and keeps profile CREATE/edit human-only on that surface specifically because an agent able to mint profiles could escalate capability.

So the "deliberately agent-writable" framing was a post-hoc rationalization of a pre-existing, never-reviewed gap, not a decision — confirmed by `grep -ri browserTesting docs/` (12 hits, none recording such a decision) and empty hits on `docs/adr`/`docs/investigations`.

`allowDelta` had no validator at all (`z.array(z.string()).optional()`, no content check anywhere) — unlike the analogous project-level `denyGlobs` field, which has a dedicated `validateDenyGlobs` and is explicitly human-only even on the elevated Platform Lead surface. `createPty` layers `allowDelta` straight onto the spawn's permission allowlist, so an unreviewed entry (e.g. `Bash(*)`) on a setup/platform-minted rig is an unrestricted-shell grant with no human review — the same trust class as `gateCommand`.

Lead ruling (2026-10-01): align the code to CLAUDE.md. Add all three to `AGENT_FORBIDDEN_PROFILE_KEYS`, matching the `denyGlobs` precedent for `allowDelta` rather than inventing a pattern-safety allow/deny classifier (a new classifier is itself a thing that has to be kept correct forever; least-privilege roles are the security spine here). The human Profiles UI / REST keeps all three.

Scope note: `restrictedTools` and `noCommit` deliberately stay OUT of `AGENT_FORBIDDEN_PROFILE_KEYS` and remain settable via the Setup Assistant's/Platform Lead's own profile-writing tools. Neither fits this ruling's actual concern — a profile-minting agent escalating what a rig can DO. `restrictedTools` only RESTRICTS a rig's own tool surface (subtractive, never a new capability), and `noCommit` only declares a lifecycle contract (no spawn-time host capability at all); an elevated profile writer setting either narrows or redeclares a rig, it never widens one.

## Do not

- Do not let `browserTesting`, `documentConversion`, or `allowDelta` be settable via any agent-facing profile-writing MCP tool (Setup Assistant, Platform Lead included) — all three are REJECTED there, per `AGENT_FORBIDDEN_PROFILE_KEYS`.
- Do not re-introduce a pattern-safety classifier for `allowDelta` (e.g. a `Bash(*)`-shaped denylist) as a substitute for this — a new allow/deny classifier is a maintenance burden with its own drift risk; human-only is the chosen posture.
- Do not read any inline comment on `browserTesting`/`documentConversion` predating this record as evidence either field was ever deliberately agent-writable — it wasn't; see the provenance chain above.
- Do not add `restrictedTools` or `noCommit` to `AGENT_FORBIDDEN_PROFILE_KEYS` on the premise that they should be "human-gated like `browserTesting`" — they shouldn't: both only restrict or declare a rig, never grant it a new capability, so they stay agent-writable per the scope note above.

## Source

`AGENT_FORBIDDEN_PROFILE_KEYS` + `agentProfileKeyError` / `AGENT_FORBIDDEN_PROFILE_KEY_REASONS` in `packages/daemon/src/profiles/validate.ts`. Tool descriptions in `packages/daemon/src/mcp/setup.ts` (`profile_create`/`profile_update`) and `packages/daemon/src/mcp/platform.ts` (`profile_create`/`profile_update`).
