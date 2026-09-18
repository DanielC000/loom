# 5d6e0ace — `project_configure`'s response never echoes a value-shaped `sessionEnv`

## Narrative

The Platform Lead reproduced, first-hand, that `project_configure` (platform.ts, and its setup.ts
sibling) echoed a project's FULL stored config override — `sessionEnv` plaintext included — on a
response to a one-key patch of an unrelated field. The first fix (this same card) masked `sessionEnv`
values with `maskSessionEnvRecord` (same-length bullet filler, the one canonical masking primitive,
reused from the REST routes' `redactSessionEnvForRead`).

A Code Reviewer pass on that fix found a CRITICAL regression it introduced: `maskSessionEnvRecord`'s
output is itself a valid `sessionEnv` write payload — a `Record<string, string>` of bullet characters,
which `projectConfigOverrideSchema` accepts without complaint. Feeding a `project_configure` response's
`config` straight back into the same tool (a plausible action given `replace:true`'s "clear keys by
omission" framing, or a plain deep-merge patch) OVERWRITES the real stored secret with the bullet mask.
This is worse than an ordinary footgun for three reasons: (1) INVISIBLE — `maskSessionEnvRecord` is
idempotent, so the response after the destructive write is byte-identical to the one before; nothing
signals the loss. (2) UNRECOVERABLE — `Db.recordProjectConfigChange` also masks both `prior` and `next`
(card `b2f9ce3a`), so config history cannot hand the real value back; only a DB backup recovers it.
(3) IT IS A REGRESSION THIS FIX INTRODUCED — pre-fix the echo was the real value, so a resubmit was a
harmless no-op; post-fix, the identical caller behaviour destroys the credential.

The remedy is to make the round-trip fail LOUDLY instead of merely not-echo the secret: `sessionEnvKeys`
(names + VALUE LENGTHS, e.g. `{ GSC_SERVICE_ACCOUNT_JSON: 38 }`) replaces `sessionEnv` in the response's
`config` object. `sessionEnvKeys` is not a key either `projectConfigOverrideSchema` (platform.ts, full
validator) or `agentProjectConfigOverrideSchema` (setup.ts, agent validator) recognizes — both are
`.strict()` — so resubmitting the returned `config` verbatim as a `project_configure` write payload is
REJECTED outright ("invalid config: unrecognized key `sessionEnvKeys`"), before any merge/replace logic
runs, regardless of merge or `replace:true` mode. This preserves the length-confirmation the tool's
description already advertised (a truncated-paste signal), without ever returning anything shaped like a
value a validator would accept back.

`setup.ts` carries the identical shape for consistency (the two `project_configure` tools share a name
and callers reasonably expect the same response contract), even though its own agent validator already
rejects `sessionEnv` as an unrecognized key outright — so the destructive round-trip was never reachable
there in the first place.

## Do not

- Do not return `sessionEnv` (masked or real) as a `Record<string, string>` from `project_configure`'s
  response — any string-valued record shaped like a real `sessionEnv` write is itself an accepted write
  payload; the schema cannot distinguish a mask from a real secret.
- Do not "fix" this by making `maskSessionEnvRecord`'s bullet filler non-idempotent, or by making the
  write validator reject an all-bullet-character `sessionEnv` value — that's a different, complementary
  fix (fail-closed rejection at the write chokepoint) carded separately, because it also protects the six
  other project-config-returning MCP sites this card's sibling sweep found still echoing `sessionEnv`
  (`project_get`, `project_update`, `list_all_projects`, on both routers) — a bigger scope than this
  branch carries. Building it here would be solving the six-site problem inside a two-site fix.
- Do not build a shared `redactSessionEnvInConfig` unit spanning this file and the six held sites for
  this specific reshaping — the Code Reviewer suggested one; it is intentionally folded into the six-site
  follow-up card instead of built here, so a two-site fix doesn't carry infrastructure only the larger
  scope needs.

## Source

Inline comment in `packages/daemon/src/mcp/platform.ts`, above the `project_configure` handler's final
response construction. Mirrored (same shape, no anchor duplication needed — see this file) in
`packages/daemon/src/mcp/setup.ts`'s own `project_configure` handler.
