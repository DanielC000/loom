# Transcript turn timestamps ride the human REST route only (card 0bcdd158)

## Decision

Both engine transcript parsers (`pty/claude-transcript.ts`, `pty/codex-transcript.ts`) can carry each line's own `timestamp` as an optional `TranscriptTurn.ts`, but only when the caller passes `{ withTs: true }`. The default parse is unchanged: every turn is exactly `{role, text}`.

The only caller that opts in is the human REST route `GET /api/sessions/:id/transcript` (bare array and paged envelope alike). The web session MCP strip uses it to show each call's time and an approximate duration (result turn ts minus call turn ts).

Both engines stamp every JSONL line with a top-level ISO `timestamp` (claude: on each `user`/`assistant` record; codex: on every rollout record, verified structurally against a real `codex-cli` rollout on 2026-11-06). A line with no parseable timestamp yields a turn with no `ts` key at all, never a fabricated value. For codex's `task_complete` fallback turn, `ts` is the `task_complete` line's own time.

## Known slack: REST pages run slightly over the page budget

`pageTranscript`'s `turnCharSize` (sessions/transcript.ts) sizes a turn from `text` and `role` only, so it does not count `ts`. A REST `?offset=` page therefore runs about 32 chars per turn over `TRANSCRIPT_PAGE_CHAR_BUDGET` (`,"ts":"…24-char ISO…"`). This is harmless: that budget exists for the MCP tool-result cap, and the human REST route has no such cap. The MCP paths never carry `ts`, so their sizing is unaffected. No code change was made for this.

## Why opt-in rather than strip-at-the-edge

`readTranscript`/`readArchivedTranscript` feed many agent-facing MCP tools (`transcript_read`, `worker_transcript`, the Lead's `session_transcript`, companion reads, plus internal non-empty checks). A `ts` on every turn costs tokens on every agent read and changes response key sets that tests pin. Making it opt-in at the parse means no agent-facing projection can grow the field by forgetting to strip it.

## Do not

- Do not pass `withTs` from any MCP tool handler or any other agent-facing read. Add it to a human REST route only, and say so in this record.
- Do not default `withTs` to true and strip at the MCP edge instead; a new MCP consumer would leak the field silently.
- Do not synthesize a `ts` (e.g. 0, the file mtime, or the previous turn's) for a line that has none. The web strip relies on absence meaning "unknown".
