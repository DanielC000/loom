# 3b015fc7 — `end_me` is a self-scoped terminal exit, gated by unconsumed inbound direction and live workers

## Narrative

`end_me` is registered on every agent-facing MCP router (`mcp/orchestration.ts` for
manager/worker, `mcp/platform.ts` for the Platform Lead, `mcp/audit.ts`, `mcp/user-audit.ts`, and
`mcp/setup.ts` for the setup surface) as the no-successor sibling of `recycle_me`: a terminal exit
with NO target argument. Every registered surface binds the call to the URL-path/caller session
id, so a session can end ONLY itself — that binding is the whole least-privilege safety story, not
an incidental detail. The canonical implementation is `SessionService.endMe`
(`sessions/service.ts`); every router's own registration is a thin, ≤3-line pointer to it, never a
re-implementation.

`endMe` runs two gates, in order, either of which REFUSES (returns a structured `{stopped:false,
reason, ...}` result — never throws, so the calling agent can act on it):

1. **Inbound queue.** `pty.pendingAgentCount(sessionId)` (`pty/host.ts`) counts currently-queued
   `kind:"agent"` messages — unconsumed direction (manager redirect/message, a human composer
   turn, companion inbound) — as opposed to `kind:"warning"` operational nudges (idle/context/
   usage watchdogs, memory-recall), which coalesce and are NOT direction and so never block. This
   generalizes the intent of the `worker_report(done)` pending-direction guard from
   manager-origin-only to every agent-kind sender.
2. **Live workers.** A caller whose `session.role` is `"manager"` or `"platform"` with ≥1 LIVE
   worker/child session is refused, so a self-end can't strand a live fleet under a dead parent.
   Non-manager/non-platform roles skip this gate entirely. A Platform Lead's own spawned sessions
   are never parented to it (see `recyclePlatformLead`'s own doc), so this gate is naturally a
   structural no-op for that role — the same check still runs, it just never trips.

On pass: the caller's own pty is stopped via the same path as `stopSession(id, "graceful")`
(Ctrl-C×2, clean, resumable — the row lands on Archive), deferred via `setTimeout` so this tool
call's own MCP response flushes before the pty dies (mirrors `recycleManager`'s close-after-delay).

One caller relies on `end_me`'s own gate rather than re-implementing it: the web UI's one-click
graceful wrap-up route (card `f55bd338`, `gateway/server.ts`) enqueues a turn telling the session
to run the session-end skill and then call `end_me` itself — that route only ENQUEUES the turn; if
`end_me` refuses, the session simply stays live and the agent surfaces the reason.

## Do not

- Do not give `end_me` a target argument, on any router. Binding the call to the caller's own
  session id (never an argument) is the entire least-privilege guarantee this tool exists for.
- Do not let a manager/platform-lead caller bypass the live-workers gate — a self-end must never
  strand a live fleet under a dead parent.
- Do not treat `kind:"warning"` operational nudges as blocking inbound direction for this gate —
  only `kind:"agent"` messages (real, unconsumed direction) count toward the queued-inbound
  refusal; see `pty/host.ts`'s `QueuedMessageKind`.
- Do not re-implement the two gates at a call site — every router's `end_me` registration should
  stay a thin pointer to `SessionService.endMe`, not a parallel copy that can drift from it.

## Source

Canonical implementation: `SessionService.endMe`, `packages/daemon/src/sessions/service.ts`,
lines 11599-11656 (JSDoc + body), as of this tranche's HEAD. Pointer citations (each ≤3 lines,
unchanged by this tranche): `packages/daemon/src/gateway/server.ts` (~line 5030, the wrap-up
route), `packages/daemon/src/mcp/audit.ts` (~line 206), `packages/daemon/src/mcp/orchestration.ts`
(~line 4753), `packages/daemon/src/mcp/platform.ts` (~line 1751),
`packages/daemon/src/mcp/setup.ts` (line 80 and ~line 755), `packages/daemon/src/mcp/user-audit.ts`
(~line 252), `packages/daemon/src/pty/host.ts` (`pendingAgentCount`, ~line 8019).
