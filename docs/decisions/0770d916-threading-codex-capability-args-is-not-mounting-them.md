# 0770d916 — threading a capability arg into codex's MCP call is not the same as it mounting

## Narrative

`createCodexPty`'s `buildMcpServers()` call now threads `opts.browserTesting`/`opts.documentConversion`/`opts.capabilities` through — the same three fields the claude spawn path already passes. `buildMcpServers()` already accepts all three generically (it resolves them for claude today), so this call site was simply the one omitting them; resolving them here can never drift from claude's own capability-resolution logic, since both paths now call through the exact same function.

Threading the argument is deliberately NOT treated as equivalent to the capability actually mounting for codex. `browserTesting`/`documentConversion` both resolve to a `{type:"stdio", ...}` MCP entry (Playwright/markitdown respectively), and `mcpServersToCodexArgs` (`codex-host.ts`) can only translate `{type:"http"}` entries into codex's per-invocation `-c mcp_servers.<id>.url=<url>` argv form — codex has no stdio-MCP-server concept. A stdio entry hitting this translator is now REPORTED (a loud `console.warn`, card `7fa73e2c`'s fix) and skipped, never silently dropped.

This is a sibling fix to card `7fa73e2c`'s own remedy on the same shape ("no-mechanism-reject-or-warn"): `profiles/validate.ts` rejects a NEW `harness:"codex"` profile that sets `browserTesting`/`documentConversion:true` (or a non-empty `capabilities` array) at save time (`codexStdioCapabilityUnsupportedError`) — see card `7fa73e2c`'s own record for that validation-time counterpart in full. The threading this card adds is defense-in-depth for a profile that predates that save-time guard, not the primary enforcement point.

## Do not

- Do not treat threading `browserTesting`/`documentConversion`/`capabilities` into `buildMcpServers()` as having made the capability available on codex — none of the three can ever resolve to a `{type:"http"}` entry, so none can ever actually mount for this harness.
- Do not re-derive capability resolution for codex separately from claude's — always route through the same `buildMcpServers()` call so the two harnesses' capability resolution cannot drift apart.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the JSDoc above `createCodexPty`), as of this tranche's HEAD. Relocated by card `8dcf8521` (tranche 15 on `pty/host.ts`); wording unchanged beyond joining wrapped source lines into flowing paragraphs and stripping `*` comment markers.
