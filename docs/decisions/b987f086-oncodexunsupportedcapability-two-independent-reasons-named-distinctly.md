# b987f086 — `onCodexUnsupportedCapability`: two independent unsupportable-capability reasons, named distinctly

## Narrative

Card `b987f086`: a codex spawn declared one or more capabilities that this harness structurally cannot mount, and the only signal before this card was a `console.warn` into a shared multi-tenant log — project memory `shipping-a-detector-is-not-someone-reading-it` measures that exact shape (passive notice, nobody polling) at 0-acted-on on this project, against 3/3 for a blocking precondition and 4/4 for an addressed directive.

Fired from `createCodexPty` (`pty/host.ts`) for two independent reasons, both real and both worth naming distinctly in `info.items[].reason` rather than one blended sentence:

- an MCP server this session resolved (`buildMcpServers`) is not `{type:"http"}` — codex has no stdio-MCP-server concept at all (`codex-host.ts#unsupportedCodexMcpServers`, the companion to `mcpServersToCodexArgs` that this call site also runs). `profiles/validate.ts` now rejects a NEW `harness:"codex"` profile that sets `browserTesting`/`documentConversion`/a non-empty `capabilities` array at SAVE time (`codexStdioCapabilityUnsupportedError`) — this event is defense-in-depth for a profile that predates that guard, or a slug added to the catalog after the profile was saved, not the primary enforcement point.
- `opts.codescapeEnabled` is true for this project — codescape is deliberately never even attempted for codex (no per-tool allow/disallow mechanism to pair with its write-tool restriction) and there is no profile-level save-time gate for this: `codescape.enabled` lives on the PROJECT, not the profile, so the mismatch can only ever be detected at spawn time.

Reuses `onCodexBootStuck`'s established two-recipient (session + manager) durable-event shape rather than inventing a new one. `PtyHost` itself cannot persist a durable event or notify a manager (no DB); the implementer (`sessions/service.ts`, via `index.ts`) decides how to record + notify.

## Do not

- Do not blend the two unsupported-capability reasons (stdio-only MCP server; codescape enabled for codex) into one sentence in `info.items[].reason` — name them distinctly, both are real and independently diagnosable.
- Do not rely on `profiles/validate.ts`'s save-time rejection as the sole enforcement — it can't catch a profile that predates the guard or a capability slug added after the profile was saved; this spawn-time event is the defense-in-depth for those.

## Consumption: why each recipient gets this notice (`sessions/service.ts`)

`handleCodexUnsupportedCapability` is the implementer's own doc. Before this card, the ONLY signal was
a `console.warn` into a shared multi-tenant log — project memory `shipping-a-detector-is-not-someone-
reading-it` measures that exact shape (passive notice, nobody polling) at 0-acted-on on this project.

- RECIPIENT (`sessionId` itself): so the session that lacks the capability knows NOT to rely on it —
  the `/worker` doctrine's own self-verify-with-Playwright step is exactly the kind of instruction a
  codex QA worker would otherwise follow into an improvised workaround with no tool to back it.
- SENDER (`parentSessionId`, if any): the one live party who can decide whether the missing capability
  actually matters for this task — re-profile to harness `claude`, or proceed knowing the gap.

Fired ONCE per spawn (fresh/resume/fork/recycle each re-evaluate and may fire again) — this is a
spawn-time report, not a retry ladder like `onCodexSubmitUnconfirmed`'s.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the `onCodexUnsupportedCapability` field doc on `PtyHostEvents`), as of `main` `8d9fe59d`. Extracted by card `a2a6b2ad` (tranche 11 on `pty/host.ts`); wording unchanged beyond joining wrapped lines and stripping `*` markers.

The "Consumption" section above is from a second inline comment, `handleCodexUnsupportedCapability`'s
own JSDoc in `packages/daemon/src/sessions/service.ts`, as of `main` `b4721fd1`. Extracted by card
`da28e0a5` (tranche 22 on `sessions/service.ts`).
