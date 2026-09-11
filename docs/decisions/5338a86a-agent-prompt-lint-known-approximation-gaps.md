# 5338a86a — agent-prompt-lint's known approximation gaps all err toward NOT warning

## Narrative

Card 5338a86a added a warn-only (never block) check at agent create/update time: does a
`startupPrompt` name a tool that is NOT on the resolved role's actual tool surface — e.g. a kickoff
saying "use vault_write" when its role never mounts that tool, which otherwise burns failed lookups on
every cold run before anyone notices.

The check has four deliberate approximation gaps, all accepted because each one only ever suppresses a
warning (false-negative) and never manufactures a spurious one (false-positive):

- **Companion-only tools** (`chat_reply`, `skill_author`/`list`/`read`/`remove`,
  `board_create`/`board_update` on `loom-orchestration`) are gated on a LIVE `companionSessionIds`
  binding, not resolvable from a role alone, and reachable from manager OR worker OR assistant — see
  `COMPANION_APPROX_ALLOW`.
- **Manager tools further gated on live DB/project state** (peer links, `deployCommand` configured) are
  treated as always-on-surface for `"manager"` here (the manager static list already includes them) —
  an approximation that never causes a spurious "did you mean" for a live-gated tool.
- **The `operator` role's `platform.operatorEnabled` live gate is not modeled** — a profile with
  `role:"operator"` is checked against the full operator tool list regardless of whether the flag is
  currently on.
- **External/dynamic MCP servers** (playwright's full tool set, any owner-added capability-catalog
  server) are NOT enumerated — their tool names aren't statically known in this codebase, so a prompt
  naming one of those tools is never flagged.

## Do not

- Do not "fix" one of these gaps by modeling it tightly (e.g. wiring a live DB/companion-binding check
  into this lint) without re-deriving why it was left approximate — every gap here is a deliberate,
  accepted trade that only ever suppresses a warning, never manufactures one.

## Source

Inline comment in `packages/daemon/src/agents/promptLint.ts`, above the module's per-role surface
tables: lines 4-35, as of this tranche's HEAD.
