# 4f2b2da7 — Project/Agent/Profile MCP reads go through named-field projections, never a raw row spread

## Narrative

`packages/daemon/src/mcp/entityRowFields.ts` provides shared MCP-layer row projections for the platform + setup routers' Project/Agent/Profile single-record reads/writes and cross-project lists — same class as `f8d53712`'s `projectSessionRowFields` for Session. A handler that returns `db.getProject()` / `db.getAgent()` / `db.getProfile()` (spread or bare) ships every column on those tables to the calling agent automatically — an OPT-OUT shape where the next column added there reaches the wire with no code change and no review step.

## Do not

- Do not spread a raw `Project`/`Agent`/`Profile` row (`db.getProject()`/`getAgent()`/`getProfile()`, spread or bare) into an MCP tool response — use the `xFields()` helpers this file exports, which name every field explicitly, so a future column addition can't reach an agent without a deliberate, reviewed addition to the matching sentinel.

## Source

Inline comment in `packages/daemon/src/mcp/entityRowFields.ts` (file header), as of commit `24f7f64fb468a77258c85d2fc97961ca98abd5e2`. Relocated by card `13455de9` (tranche 1).

Related: `f8d53712` (the same decision, for Session's `projectSessionRowFields`).
