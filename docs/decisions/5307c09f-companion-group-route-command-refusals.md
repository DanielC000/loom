# 5307c09f — /new, /reset, /lock and /refresh refuse on a GROUP route; no group-scoped variant exists

## Narrative

Card `5307c09f` (found by the `5f9b0580` worker's sweep) found that `/new`/`/reset` (`commands.ts`'s
`startFreshConversation`, calling `chat-gateway.ts`'s `resetConversation`) and `/lock` (`closeTrustWindow`
→ `closeCompanionTrustWindow`) had no per-command scope gate: `auth.ts`'s `createDbCompanionAuth`
authorizes ANY allowlisted sender on a `group`-scope binding, not the owner exclusively, so any group
member could trigger either command — `/new`/`/reset` is a griefing/DoS vector against the owner's entire
cross-channel companion memory; `/lock` is lower severity (fail-safe direction — forces an earlier
re-confirm).

The fix mirrors card `5f9b0580`'s own `/export` refusal: `route.senderId !== null` ⇒ refuse with neutral
text, no DM-retry invitation (a non-owner group member's own DM to the companion isn't an authorized route
either — `auth.ts` — so inviting one would promise something that can never happen for them).

**Decision: DM-only refusal for `/new`, `/reset`, `/lock`, and (round 2 lead ruling) `/refresh` — no
group-scoped variant exists for any of them.** Checked each underlying primitive directly before deciding:
- `/new`/`/reset` → `resetConversation` (`chat-gateway.ts`): (a) injects `/clear` into the ONE underlying
  `claude` process via `submitTurn(sessionId, resetCmd)` with no route — the agent's context isn't
  per-channel, there's nothing to scope; (b) `CompanionHistoryReset.clear(sessionId)` (`types.ts`) takes a
  sessionId only, no channel/chatId parameter; (c) `closeTrustWindow` → `closeCompanionTrustWindow`
  (`mcp/orchestration.ts`) revokes the trust window, grants, and pending proposals "across every
  route/sender" — session-wide.
- `/lock` → the SAME `closeCompanionTrustWindow` primitive as (c) above — identical session-wide scope,
  no scoping lever.
- `/refresh` → `refreshPersona` re-enqueues a live persona/memory prompt into the ONE shared agent process
  (same no-per-channel-dimension shape as `/new`'s context-reset half); a group member could otherwise burn
  the owner's companion turns/tokens on demand. Added in round 2 by lead ruling (same idiom, same file).

None of the four primitives has a channel/chatId dimension to scope a "do this just for this group" variant
against — it would need new per-channel history/trust-window/turn plumbing, and closing the context-reset
half isn't even meaningful per-channel (one process, one context). `/lock`'s fail-safe direction means
refusing it on groups costs nothing even though a group-scoped variant was never really necessary there
either.

Because `/new` and `/reset` are a literal alias — `commandHandler("new") === commandHandler("reset")`, by
design so the two can never drift apart — the shared handler cannot tell which alias was typed. The
refusal wording for that pair therefore names the ACTION ("Starting a fresh conversation"), never either
literal command name, rather than threading the invoked command name through `CommandHandler`'s fixed
`(args, route, prefs, deps)` signature just for this.

A shared `GROUP_ROUTE_REFUSAL_SUFFIX` constant (`commands.ts`) holds the common refusal tail so `/export`'s
(card `5f9b0580`), `/new`'s/`/reset`'s, `/lock`'s, and `/refresh`'s wording can't drift apart from each
other — `/export`'s existing refusal was refactored onto it too (byte-identical resulting text, verified by
its own existing test still passing unchanged).

`/help` and the Telegram `COMMAND_MENU` (both derived from the same `COMMANDS` map, `commands.ts`) flag all
five DM-only commands' descriptions with "(DM only)" (round 2 Minor: `/export`'s own description was
originally left unfixed as out-of-scope-for-round-1; round 2 fixed it, alongside `/refresh`'s) so a group
member sees the restriction before even trying the command, rather than only discovering it from a refusal
after typing it.

### Round 2 MAJOR: a group refusal was still recorded as the conversation-boundary marker

Code Review (`cc44ef2d` on commit `d8faac04`) found that `chat-gateway.ts`'s dispatch decided whether to
persist a command's ack as the "/new"/"/reset" conversation-boundary marker by matching the PARSED COMMAND
NAME (`parsed.name === "new" || "reset"`) — which is true for a GROUP REFUSAL too, since the refusal returns
under the same command name without ever calling `resetConversation`. So a non-owner group member's refused
"/new" was still recorded into the owner's cross-channel history as a fake boundary row AND pushed live to
an attached viewer — the exact same history-spam griefing class the refusal itself exists to stop, just
moved one layer down from "wipes the conversation" to "spams fake boundary markers into it."

**Fix: the handler owns the outcome.** `CommandResult` gained an optional `boundary?: boolean` field, set
`true` ONLY by `startFreshConversation`'s SUCCESS branch (never its group-route refusal branch, and never by
any other handler). `chat-gateway.ts`'s dispatch now reads `result.boundary === true` instead of inferring
from `parsed.name` — so a refusal (whatever command name produced it) can never be mistaken for the real
boundary event, by construction, regardless of what text or command name it carries.

Proven via a REAL `ChatGateway.handleInbound` call on a GROUP binding with a real db-backed recorder
(`packages/daemon/test/companion-tier2-commands.mjs` section 9g) — not a unit-level `commandHandler` call,
since the bug lived in the GATEWAY's dispatch, not the handler: a group `/new`/`/reset` now records ZERO
history rows and triggers ZERO live pushes, while re-binding the same session to a DM route and repeating
the same command still records + pushes exactly one real boundary row, unaffected.

## Do not

- Do not give `/new`/`/reset`/`/lock`/`/refresh` a group-scoped variant without first adding real
  per-channel scoping to the underlying primitives (`CompanionHistoryReset`, `closeCompanionTrustWindow`,
  the agent's own turn/context) — a "looks scoped" shortcut (e.g. only suppressing the ack while the
  trust window/context/turn still act session-wide) would silently misrepresent what the command did.
- Do not let `/new`'s and `/reset`'s refusal wording name either literal command — they share one handler
  object by design and the handler can't tell which alias was invoked; name the ACTION instead.
- Do not duplicate `GROUP_ROUTE_REFUSAL_SUFFIX`'s text inline at a new refusal call site — add a new
  DM-only command's refusal via the shared constant, so wording can't drift a fifth way.
- Do not infer `isConversationBoundary` (or any future per-command dispatch behavior) from the PARSED
  COMMAND NAME at the gateway's dispatch site — a refusal shares the same name as its command's success
  path. Let the HANDLER's own `CommandResult` fields carry the outcome; the gateway reads them, never
  re-derives them from `parsed.name`.
- Do not set `boundary: true` anywhere except `startFreshConversation`'s own success branch — any other
  handler returning it would get its ack recorded as a fake conversation-boundary row.

## Source

`packages/daemon/src/companion/commands.ts`: `GROUP_ROUTE_REFUSAL_SUFFIX` (shared refusal-text constant),
`CommandResult.boundary`, `startFreshConversation`'s group-route check + success-branch `boundary: true`
(`/new`/`/reset`), and the `lock`/`refresh` handlers' group-route checks.
`packages/daemon/src/companion/chat-gateway.ts`: the dispatch site reading `result.boundary` (was
`parsed.name`).
Tests: `packages/daemon/test/companion-tier2-commands.mjs` sections 9c–9g.
