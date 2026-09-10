# 6f8742f8 — `strictShape()` hard-rejects unknown/mistyped MCP tool args instead of the SDK silently stripping them

## Narrative

A manager called `worker_transcript({ tailLines: "40" })` — `tailLines` isn't a real param (the real
one is `lastN`) — and the call silently defaulted to the offset-0 page as if no arg had been given at
all. The cause: the MCP SDK validates a call's raw arguments against the tool's declared zod
`inputSchema` before the handler ever runs, and a key the schema doesn't declare is silently STRIPPED
from `args`, never rejected (see `resolveAlias`'s own doc in the same file — alias coercion has to work
around this exact SDK behavior from the opposite direction). The manager got no error and no signal its
guessed param name had been dropped; the call just looked like an ordinary default page.

The fix, `strictShape()`: wrap a tool's raw arg shape in a STRICT zod object so an unknown/mistyped key
hard-rejects instead, naming both the bad key(s) and the tool's real params.

Reachability was empirically probed against the real installed SDK, not assumed: passing a full
pre-built Zod object as `inputSchema` (a supported `registerTool` overload, not an SDK-internals hack)
survives the SDK's `normalizeObjectSchema` unchanged, so the object's strictness is preserved all the
way into the SDK's own existing `safeParseAsync` validation step. No pre-validation hook or interception
of SDK internals is needed to get a hard-reject this way — unlike alias COERCION (`resolveAlias`'s own,
narrower problem: coercion needs the alias key actually DECLARED so its value survives the strip at
all, while rejection only needs unknown keys to fail validation instead of vanishing).

## Do not

- Do not add a separate pre-validation hook or attempt to intercept SDK internals to get a hard-reject
  — the plain `registerTool(..., z.object(shape).strict())` overload already reaches the SDK's own
  `safeParseAsync` unchanged; this was verified empirically, not assumed.
- Do not declare a key in a `strictShape()` shape unless a legitimate caller may actually send it —
  strict rejection happens BEFORE `resolveAlias` could ever run, so an undeclared alias key would
  hard-break the call, not just fail silently to coerce.

## Source

Inline comment in `packages/daemon/src/mcp/arg-alias.ts` (`strictShape`, lines 22-45 as of main
`b4721fd1`). Extraction-program tranche, card `c1aaf5d0`.
