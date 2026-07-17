/**
 * Resolve a canonical MCP tool arg from its own value or a declared alias's value — the ONE shared
 * normalization point every "wrong-but-obvious first call" alias across the loom MCP surface goes
 * through (card fix(mcp): accept arg-name aliases), so the `canonical ?? alias` coercion can't drift
 * apart per tool the way it started to (worker_recycle/recycle_me's handoffSummary/continuationPrompt
 * swap hand-rolled this inline before this helper existed).
 *
 * Load-bearing constraint this exists to satisfy: the MCP SDK validates a call's raw arguments
 * against the tool's declared zod `inputSchema` BEFORE the handler ever runs (McpServer.
 * validateToolInput), and a key the schema doesn't declare is silently STRIPPED from `args` (not
 * rejected) — so an alias value only ever reaches the handler if the schema declares it too (as an
 * optional field alongside the now-optional canonical field). This helper is what the handler then
 * uses to fold that surviving alias value back onto the canonical name the rest of its logic expects.
 * Canonical wins if BOTH are somehow given.
 */
export function resolveAlias<T>(canonical: T | undefined, alias: T | undefined): T | undefined {
  return canonical !== undefined ? canonical : alias;
}
