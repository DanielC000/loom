# 308259e5 — `question_resolve` lets a conversational owner reply answer a pending Request, without losing the reasoning to scrollback

## Narrative

Origin finding 308259e5 — closes the file-then-cancel gap: when the owner answers a pending `question_ask` CONVERSATIONALLY in this manager's own chat instead of the web Requests UI, this lets the manager mark it 'answered' with the owner's own words captured as the note, rather than filing a durable `question_ask` and tearing it down one turn later with `question_cancel` (which lands it 'cancelled'/moot — losing the owner's reasoning to chat scrollback). Shares `resolveQuestionForAgent` (`mcp/questionTool.ts`) verbatim with the Lead surface (`mcp/platform.ts`) — see its doc for the anti-fabrication invariant (the note is ALWAYS server-captured owner text, never agent-authored) and why this skips the Companion's propose/confirm friction ladder.

## Do not

- Do not resolve a pending request this way with agent-authored text — the note is always server-captured owner text (see `resolveQuestionForAgent`'s own anti-fabrication invariant in `mcp/questionTool.ts`).
- Do not cancel-and-refile a conversationally-answered question_ask — that loses the owner's actual reasoning to chat scrollback; use `question_resolve` instead.

## Source

Inline comment in `packages/daemon/src/mcp/orchestration.ts` (above the `question_resolve` tool registration): lines 3828-3836 (pre-tranche-2 numbering), as of commit `f81f9c1108773e559efe78b7166cbf78b6201480`. Relocated by card `a2278b09` (tranche 2).
