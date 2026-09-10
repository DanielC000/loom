import { z } from "zod";

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

/**
 * Wrap a raw MCP tool arg shape in a STRICT zod object, so an unknown/mistyped arg key (a typo, a
 * guessed param name) HARD-REJECTS naming the bad key(s) + this tool's real params, instead of being
 * silently stripped by the SDK's default object-schema STRIP mode (see resolveAlias's doc above for
 * why undeclared keys vanish before the handler runs).
 *
 * @decision 6f8742f8 — an unrecognized key MUST hard-reject, never silently strip: a stripped key is
 * indistinguishable from no arg being given at all, and was mistaken for exactly that in production.
 *
 * `.strict()` on a raw `z.object(shape)` alone only produces zod's generic "Unrecognized key: X"
 * message; the `{ error }` callback additionally lists this tool's actual param names, since the
 * caller can't discover them from the stripped-silently error text.
 *
 * ONLY declare a key in `shape` if a legitimate caller may send it — strict rejection happens BEFORE
 * resolveAlias could ever run, so an undeclared alias would break, not just fail to coerce.
 */
export function strictShape<S extends z.ZodRawShape>(shape: S) {
  return z.object(shape, {
    error: (issue) =>
      issue.code === "unrecognized_keys"
        ? `Unrecognized param(s): ${issue.keys.join(", ")}. Valid params: ${Object.keys(shape).join(", ")}`
        : undefined,
  }).strict();
}
