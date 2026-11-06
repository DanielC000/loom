# a9a7140c — the session's Loom MCP activity strip reads the transcript, and shows only what the transcript carries

Card `a9a7140c`. Owner picked direction **B · Ledger** (request `4d8faae3`). Mockups: vault `Projects/Loom/Mockups/2026-11-05 Session MCP Activity Panel/`.

## What was built

A strip under the composer on the Atlas session node (`components/McpActivity.tsx`, mounted from `TerminalCard.tsx`'s below-terminal strip). Compact, it states the latest Loom MCP call as a sentence ("Moved card a9a7140c to Review"). Expanded, it shows every call grouped by agent turn, a facet rail (where it went, how it went, most called, router, free-text find), and an inline "Asked Loom / Loom answered" block per call. Card `825e38da` added the amber `!` refused outcome (see Do not).

## Where the data comes from

`GET /api/sessions/:id/transcript` serves every tool call (and, since card `0bcdd158`, each turn's engine `ts`, on this route only), flattened to text by `packages/daemon/src/pty/claude-transcript.ts` `extractText`:

- an assistant turn holds one line per call: `[tool] {<8-char tag>} mcp__loom-<router>__<tool>(<JSON.stringify(args)>)`;
- a `tool_result` turn holds one block per result: `-> tool result {<tag>} (error): <body>`, the body capped at `TOOL_RESULT_BODY_CAP` (2 KB).

`lib/mcpActivity.ts` parses that text back into calls, pairs each with its result by tag, and numbers agent turns by counting user-role turns. A line is a call only when its argument text parses as JSON, so prose that happens to start with `[tool]` is not mistaken for one. The strip reads the same `["transcript", id]` query the Transcript tab uses, so both share one poll.

The route has no tail or paging (no query params at all), so every poll is the WHOLE transcript: 370 KB for a 286-turn worker session measured on 2026-11-05, growing linearly with session length. `mcpPollInterval` therefore polls every 15s while the session is idle and the strip compact, every 5s while busy or expanded, and not at all while `document.hidden`. react-query already skips interval fetches on a hidden document by default, so the explicit `hidden` branch is a second layer. A bounded tail needs a daemon change to the route first; that is a follow-up, not part of this card.

The shared key does not double-fetch beside the Transcript tab: react-query re-arms every observer's interval after each fetch of a key (`QueryObserver.onQueryUpdate`), so all observers of one key fetch on one cadence, the shortest interval among them.

This couples the web parser to `extractText`'s marker format. `test/mcp-activity.mjs` pins the format the parser expects; a change to those markers in the daemon must update both.

## Do not

- Do not show a time or duration that does not come from the turns' engine `ts` (card `0bcdd158`, record `0bcdd158-transcript-turn-timestamp-is-rest-only.md`). The strip shows a call's clock time, an APPROXIMATE duration (result turn ts minus call turn ts, which includes hook and harness overhead, so every duration is marked `≈` and says so), per-row bars, and per turn the start time (titled with the full local date) and a SPAN. No call-line ts → no clock time. No duration and no bar when either ts is missing, the result hasn't arrived, or the result is stamped before its call; never a 0. The turn span is wall clock, from the first timed call's ts to the last timed result's ts (calls with both ts only), never a sum of durations: calls that run in parallel would be counted twice. A turn with no call carrying both ts shows no span. Do not relabel the duration as Loom's own latency. The only outcome FACTS are `ok`, `error` (the engine's `is_error`) and `pending` (no result yet).
- `refused` (card `825e38da`) is a HEURISTIC, not a fact, and the UI must keep saying so (the rail's legend line, the marker's tooltip, the detail's "Read as refused" note). `classifyResult` marks a successful result refused only when the WHOLE capped body parses as a JSON object with a non-null top-level `error`; an array, a string, plain text, a nested `error`, or a body cut at the 2 KB cap stays `ok` (a cut body is counted as "too long to check", `isUnclassified`). Do not fold refused into `error`: `isError` keeps its own red "failed" state and wins over any body. Do not loosen the parse to a prefix or regex match on a truncated body; a guessed refusal on a cut answer is worse than an honest ok.
- Do not render arguments or result bodies as HTML. They are agent- and tool-authored text; React text nodes only.
- Do not move argument text into the daemon log to feed this strip (`@decision 16c93a50`). The transcript route is human-only loopback REST, the same exposure the Transcript tab already has.
- Do not give the strip its own query key for the same transcript URL. Two keys mean two independent interval timers on one multi-hundred-KB response (measured: 4 fetches in 11s instead of 2). The route now serves a tail (`?offset=`, card 79057de9), but the strip keeps the shared key: its queryFn merges the tail into the cached full array, so the Transcript tab reading that key still sees the whole transcript.
- Do not poll every 5s unconditionally: the idle backoff stays. A poll is usually a small tail, but the first load and the rotation/shrink fallback are still the whole transcript.
- Do not count non-Loom tools (Read, Bash, other MCP servers). Only `mcp__loom-*` routers.

## Marker format pin

The daemon side of the marker contract is pinned by `packages/daemon/test/transcript-mcp-marker-format.mjs` (card `afea18a1`): it renders a real-shaped JSONL through `parseTranscriptFile` and asserts the exact `[tool] {tag} mcp__loom-…(…)` and `-> tool result {tag} (error): …` lines against copies of `CALL_LINE` / `RESULT_HEAD`.

## Codex sessions

A codex-harness transcript (`pty/codex-adapter.ts`) does not render calls with these markers, so it parses to zero calls. The strip says plainly that codex sessions don't show their Loom calls here yet, rather than claiming the session made none.
