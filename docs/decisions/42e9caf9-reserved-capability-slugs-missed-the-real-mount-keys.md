# 42e9caf9 — `RESERVED_CAPABILITY_SLUGS` must reserve the real `mcpServers` map keys, not just the grant slugs

## Narrative

Card 42e9caf9 (Code Review lane 4 finding 4): `RESERVED_CAPABILITY_SLUGS` (`capabilities/registry.ts`)
reserved `"browser-testing"`/`"document-conversion"` — the legacy *grant* slugs (`CapabilityGrant.slug`,
the bridged boolean-flag names) — plus every Loom first-party MCP server id. But `buildMcpServers`
(`pty/host.ts`) does not mount those grants under their own slug names: it special-cases them to
`mcpServers["playwright"]` and `mcpServers["markitdown"]` (a stated stability invariant in that function's
own doc comment), and separately mounts Codescape as `mcpServers["codescape"]`. None of those three
literal map keys were reserved.

Since an owner-added catalog row's slug only had to avoid `SLUG_RE` violations and the (wrong) reserved
list, a row slugged `playwright`, `markitdown`, or `codescape` passed `validateCapabilityDefInput`
cleanly. The owner-catalog loop in `buildMcpServers` assigns `mcpServers[def.slug] = server` exactly the
same way a first-party id would — so for a session that also had `browserTesting`/`documentConversion`/
Codescape enabled, whichever assignment ran last in the loop (or Codescape's own later, unconditional
mount) silently won, with no error surfaced either way. An owner could end up with an arbitrary
owner-typed `command`-kind capability silently answering under the exact server id an agent's
`--allowedTools` grant for `browser-testing`/`documentConversion`/Codescape expects to be the vetted,
already-hardened resolver — or the reverse, their own capability silently shadowed and never mounted.

This is a configuration footgun, not a privilege escalation (the capability catalog is owner-only CRUD,
the same trust tier as `gateCommand` — the owner already fully trusts themselves to type a `command`), but
it defeats the entire point `RESERVED_CAPABILITY_SLUGS` exists for: "an owner can never shadow/rename over
them" is only true if the reserved list actually names the strings that get collided on.

Fix: add `"playwright"`, `"markitdown"`, `"codescape"` to `RESERVED_CAPABILITY_SLUGS` directly, alongside
the existing legacy grant slugs and first-party server ids — reserved at both `validateCapabilityDefInput`
(creation time) and the mount-time defense-in-depth re-check in `buildMcpServers`, the same two
chokepoints the first-party ids already go through.

## Do not

- Do not assume a slug is safe to leave unreserved just because it doesn't appear in
  `LEGACY_CAPABILITY_SLUGS`/`LOOM_FIRST_PARTY_SERVER_IDS` — check what `buildMcpServers` actually uses as
  the `mcpServers` object KEY for that capability's mount, which can differ from the grant slug that
  enables it (as `"browser-testing"` → `"playwright"` and `"document-conversion"` → `"markitdown"` do).
- Do not re-derive this list from a `readdirSync`/grep heuristic over `host.ts` — the mount keys are bare
  string-literal object assignments (`mcpServers["playwright"] = pw`), not a pattern a generic scan can
  reliably enumerate; read `buildMcpServers` directly when adding a new builtin mount and reserve its key
  here in the same change.
- Do not fold `"codescape"` into the capability-grant special-casing (the `grant.slug === "..."` branches)
  — Codescape is not a capability grant at all (it's a separate per-project `codescape.enabled` toggle,
  mounted unconditionally after the capability loop); it only needs the reservation, not a special-case
  branch in that loop.

## Source

Extracted from `capabilities/registry.ts`'s `RESERVED_CAPABILITY_SLUGS` doc comment (card 42e9caf9).
