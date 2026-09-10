# 7fa73e2c — codex's MCP translation reports what it cannot mount, never silently

## Narrative

`mcpServersToCodexArgs` translates an already-built `mcpServers` map (the SAME shape `pty/host.ts#buildMcpServers` returns for claude's `--mcp-config`) into codex's per-invocation `-c mcp_servers.<id>.url=<url>` argv pairs — measured TRANSIENT (never touches `config.toml`), per the parity matrix's "MCP wiring" section's real-pty-driven evidence this shape is reachable.

Card `353f6dc4` (the original epic card this function was built under): it deliberately takes the ALREADY-RESOLVED map rather than re-deriving role→server routing itself, so there is exactly ONE place (`buildMcpServers`) that decides which servers a given role mounts — this can never drift from claude's own routing table. Only `{type:"http", url}` entries are translated (codex has no stdio-server concept here); `id` is codex-config-key-safe as long as the caller's server ids are (`LOOM_TASKS_SERVER_ID`/`LOOM_ORCHESTRATION_SERVER_ID`/etc. are all plain `[a-z-]+` literals).

Card `7fa73e2c` (this card): any shape other than `{type:"http", url}` is skipped — and that skip is REPORTED (a `console.warn`), never silent, since a silent skip here is otherwise indistinguishable from a working mount: a profile whose UI reads e.g. `browserTesting:true` would silently spawn with no Playwright MCP at all (Playwright/markitdown both resolve to `{type:"stdio"}`). Before this card the skip had no signal at all.

Card `b987f086` (a later, related fix): the `console.warn` this card added is itself only a shared-log-only signal — project memory `shipping-a-detector-is-not-someone-reading-it` measures passive notice at 0-acted-on. `unsupportedCodexMcpServers` is the companion pure function `createCodexPty` calls on this SAME input to turn a real drop into a durable, manager-visible report instead of leaving the console line as the only signal — a separate function rather than changing `mcpServersToCodexArgs`'s own return shape, so every existing call site/test asserting on its plain `string[]` return stays byte-identical; the companion is called ALONGSIDE it, never instead of it, on the exact same input map.

## Do not

- Do not silently drop an unsupported `mcpServers` entry — a skip must always be reported (warn + the companion `unsupportedCodexMcpServers` report), never left indistinguishable from a working mount.
- Do not re-derive role→server routing inside this function — always take the already-resolved map from `buildMcpServers`, so codex's mounted servers can never drift from claude's routing table for the same role.
- Do not change `mcpServersToCodexArgs`'s `string[]` return shape to carry the drop report — use the separate `unsupportedCodexMcpServers` companion instead, so existing callers/tests stay byte-identical.

## Source

Inline comment in `packages/daemon/src/pty/codex-host.ts` (the JSDoc above `mcpServersToCodexArgs`), as of commit 41336cdba9e3c80849be6c64c84a8d52c3c06dce. Relocated by card e5ee79bb (tranche 1 on `pty/codex-host.ts`); no wording changed beyond joining wrapped source lines into flowing paragraphs and stripping `*` comment markers.
