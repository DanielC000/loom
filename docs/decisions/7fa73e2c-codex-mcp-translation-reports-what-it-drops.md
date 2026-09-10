# 7fa73e2c — codex's MCP translation reports what it cannot mount, never silently

## Narrative

`mcpServersToCodexArgs` translates an already-built `mcpServers` map (the SAME shape `pty/host.ts#buildMcpServers` returns for claude's `--mcp-config`) into codex's per-invocation `-c mcp_servers.<id>.url=<url>` argv pairs — measured TRANSIENT (never touches `config.toml`), per the parity matrix's "MCP wiring" section's real-pty-driven evidence this shape is reachable.

Card `353f6dc4` (the original epic card this function was built under): it deliberately takes the ALREADY-RESOLVED map rather than re-deriving role→server routing itself, so there is exactly ONE place (`buildMcpServers`) that decides which servers a given role mounts — this can never drift from claude's own routing table. Only `{type:"http", url}` entries are translated (codex has no stdio-server concept here); `id` is codex-config-key-safe as long as the caller's server ids are (`LOOM_TASKS_SERVER_ID`/`LOOM_ORCHESTRATION_SERVER_ID`/etc. are all plain `[a-z-]+` literals).

Card `7fa73e2c` (this card): any shape other than `{type:"http", url}` is skipped — and that skip is REPORTED (a `console.warn`), never silent, since a silent skip here is otherwise indistinguishable from a working mount: a profile whose UI reads e.g. `browserTesting:true` would silently spawn with no Playwright MCP at all (Playwright/markitdown both resolve to `{type:"stdio"}`). Before this card the skip had no signal at all.

Card `b987f086` (a later, related fix): the `console.warn` this card added is itself only a shared-log-only signal — project memory `shipping-a-detector-is-not-someone-reading-it` measures passive notice at 0-acted-on. `unsupportedCodexMcpServers` is the companion pure function `createCodexPty` calls on this SAME input to turn a real drop into a durable, manager-visible report instead of leaving the console line as the only signal — a separate function rather than changing `mcpServersToCodexArgs`'s own return shape, so every existing call site/test asserting on its plain `string[]` return stays byte-identical; the companion is called ALONGSIDE it, never instead of it, on the exact same input map.

## Validation-time counterpart (`profiles/validate.ts`)

Card `7fa73e2c` (a sibling of card `0770d916`'s `restrictedTools` fix above, same remedy shape: "no-mechanism-reject-or-warn"): `browserTesting`/`documentConversion` both resolve to a `{type:"stdio"}` MCP entry (Playwright/markitdown — see `pty/host.ts`'s `playwrightMcpServer`/`markitdownMcpServer`), and codex's `mcpServersToCodexArgs` (codex-host.ts) can only translate `{type:"http"}` entries — codex has no stdio-MCP-server concept at all. Silently accepting `harness:"codex"` + either flag `true` would leave a profile that reads the capability ON in the UI while a codex session mounts nothing for it (FAIL-OPEN for what a human reads as an enabled feature). Reject the combination here, where the human editing the profile sees it, rather than a codex session discovering it missing only via a spawn-time log line. (`codexStdioCapabilityUnsupportedError`.)

Card `b987f086`: `capabilities` (the P4 registry-grant array) gets the SAME rejection, for the SAME reason, and it is NOT a narrower case of the two booleans above — it's a WIDER one. Every capability the registry can ever produce is `transport:"stdio"` STRUCTURALLY, not just today's two builtins: `validateCapabilityDefInput` (capabilities/registry.ts) rejects any transport other than `"stdio"` at catalog-CREATION time ("the 'http' transport is not yet supported"), and `resolveCapabilityServer`'s own return type (`CapabilityMcpServer`) hardcodes `type: "stdio"` — there is no code path, today or by any currently-declared shape, that could ever produce an `{type:"http"}` registry capability. So a non-empty `capabilities` array is unconditionally incompatible with `harness:"codex"`, for every present and future catalog entry alike — not something that needs re-checking per-slug. Before this fix, `field-consumers.ts` wrongly declared this field fully "consumed" on codex (a `proofs` entry pointing at `createCodexPty` THREADING `opts.capabilities` into `buildMcpServers` — the exact "threading is not mounting" trap `createCodexPty`'s own doc names as the lesson from the `browserTesting`/`documentConversion` fix); that entry is corrected alongside this one.

## Do not

- Do not silently drop an unsupported `mcpServers` entry — a skip must always be reported (warn + the companion `unsupportedCodexMcpServers` report), never left indistinguishable from a working mount.
- Do not re-derive role→server routing inside this function — always take the already-resolved map from `buildMcpServers`, so codex's mounted servers can never drift from claude's routing table for the same role.
- Do not change `mcpServersToCodexArgs`'s `string[]` return shape to carry the drop report — use the separate `unsupportedCodexMcpServers` companion instead, so existing callers/tests stay byte-identical.
- Do not accept `harness:"codex"` combined with `browserTesting`/`documentConversion`/`capabilities` in profile validation — reject before spawn (see above), don't rely on the translate-time warn.

## Source

Inline comment in `packages/daemon/src/pty/codex-host.ts` (the JSDoc above `mcpServersToCodexArgs`), as of commit 41336cdba9e3c80849be6c64c84a8d52c3c06dce. Relocated by card e5ee79bb (tranche 1 on `pty/codex-host.ts`); no wording changed beyond joining wrapped source lines into flowing paragraphs and stripping `*` comment markers.

A second site: inline comment in `packages/daemon/src/profiles/validate.ts` (JSDoc above `codexStdioCapabilityUnsupportedError`), as of commit 45acc7e9763ba9f3388379f145d9e9ecfa1f0235. Relocated by card e762eef0 (`profiles/validate.ts`, tranche 1); wording unchanged beyond joining wrapped lines and stripping `*` markers.
