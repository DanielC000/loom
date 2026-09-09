# 0e4a859a — codescape graph-context resolution: cached project-id resolver, uncached freshness stamp

## Narrative

`resolveCodescapeGraphContext` resolves whether THIS host is actually serving a codescape graph for a project. `resolveProjectId` is this supervisor instance's own cached resolver (registration cache first, manifest fallback) — the SAME one `pty/host.ts` uses for the real mount, so this check can never diverge from what actually gets mounted. The freshness stamp (`resolveCodescapeLastIngested`) is a SEPARATE, uncached manifest read (cheap) that only runs once an id has already resolved, so a transient stamp-read hiccup degrades to an unstamped block rather than hiding the whole thing.

Card `badba5a8` changed this to a DISCRIMINATED result (`ok:true|false` instead of `{...}|undefined`) — same four conditions, same order, gate behavior unchanged — so `resolveCodescapeInjectionStatus` (and, via it, `resolveCodescapeBlockText`) can record WHICH condition failed rather than a bare miss. See `docs/decisions/badba5a8-codescape-injection-status-is-pure-and-unit-testable-without-the-real-asset.md` for the composition this result feeds.

## Do not

- Do not let this check diverge from the gate `codescapeHttpMcpServer` uses to decide whether to mount the MCP itself — it must stay presence-gated on purpose (codescape is a private product); see the guard left inline at the source for the full four-condition list.
- Do not make the freshness-stamp read block or fail the whole gate on a transient hiccup — it degrades to an unstamped block, never a hidden feature.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`resolveCodescapeGraphContext`'s doc): originally lines 2242-2258, as of this tranche's HEAD. Relocated by card `9f4f8e5a` (tranche 7); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped. The privacy/presence-gate guard sentence stays inline at the source (class-A, compressed) — only the caching/freshness rationale and the badba5a8 cross-reference moved here.
