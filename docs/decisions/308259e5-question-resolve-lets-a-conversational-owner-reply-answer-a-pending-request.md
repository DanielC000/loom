# 308259e5 — `question_resolve` lets a conversational owner reply answer a pending Request, without losing the reasoning to scrollback

## Narrative

Origin finding 308259e5 — closes the file-then-cancel gap: when the owner answers a pending `question_ask` CONVERSATIONALLY in this manager's own chat instead of the web Requests UI, this lets the manager mark it 'answered' with the owner's own words captured as the note, rather than filing a durable `question_ask` and tearing it down one turn later with `question_cancel` (which lands it 'cancelled'/moot — losing the owner's reasoning to chat scrollback). Shares `resolveQuestionForAgent` (`mcp/questionTool.ts`) verbatim with the Lead surface (`mcp/platform.ts`) — its doc carries the load-bearing anti-fabrication invariant (the note is ALWAYS server-captured owner text, never agent-authored; see [[ca341979-question-resolve-falls-back-to-the-most-recent-owner-authored-turn]] for the fallback mechanism itself).

**Why this may skip the Companion's propose/confirm friction ladder** (`decision_resolve`, `companion/capabilities.ts`): that ladder exists because the Companion relays an EXTERNAL, injection-exposed chat channel — the text reaching it was never itself authenticated as the owner's own bytes until Primitive A/B/C says so. A manager/Lead session's `ownerText` comes from the SAME loopback-only, human-authenticated REST composer (`POST /api/sessions/:id/input`) that answers a question directly — there is no relay hop and nothing to attest beyond "this turn (or a recent one) was actually formed from that route", which `getActiveTurnOwnerText`/`getRecentOwnerTurns` already guarantee.

## Do not

- Do not resolve a pending request this way with agent-authored text — the note is always server-captured owner text (see `resolveQuestionForAgent`'s own anti-fabrication invariant in `mcp/questionTool.ts`).
- Do not cancel-and-refile a conversationally-answered question_ask — that loses the owner's actual reasoning to chat scrollback; use `question_resolve` instead.
- Do not "harden" `question_resolve` into a second confirm round-trip to match the Companion's propose/confirm ladder — that ladder defends against an injection-exposed relay channel `question_resolve`'s loopback-only composer path was never exposed to.

## Source

Inline comment in `packages/daemon/src/mcp/orchestration.ts` (above the `question_resolve` tool registration): lines 3828-3836 (pre-tranche-2 numbering), as of commit `f81f9c1108773e559efe78b7166cbf78b6201480`. Relocated by card `a2278b09` (tranche 2). The "Why this may skip the Companion's propose/confirm friction ladder" section above relocated from `packages/daemon/src/mcp/questionTool.ts`'s `resolveQuestionForAgent` doc (lines 473-481, pre-this-tranche numbering) by card `ecd33a9e` (tranche 2 on that file).
