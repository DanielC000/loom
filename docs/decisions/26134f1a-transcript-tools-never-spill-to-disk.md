# 26134f1a — transcript-bearing MCP tools never spill to disk, not even Loom's own scratch dir

## Narrative

Card `26134f1a` started as a narrower fix (exempt the engine's tool-results spill dir from the
transcript-root deny) but the trust-boundary checkpoint on that approach found it unconstructible: the
engine session id isn't known at settings-write time, and a per-project exemption would reopen a
sibling-session leak. The Loom Lead redirected to fixing the tool layer instead — routing oversized MCP
responses through Loom's own `spillTextIfLarge`/`spillRowsIfLarge` primitive so they never reach the
engine's own native tool-result truncation (which spills into `~/.claude/projects/**/tool-results/**`, a
tree denied to manager/platform/setup/assistant/auditor/workspace-auditor).

That fix is correct for ordinary tool responses (`decisions_list`, `memory_list`, `skill_list`,
`board_list`, `board_get`, a companion's self-authored `skill_read`, …) because Loom's own scratch dir
(`<LOOM_HOME>/tmp/scratch/<sessionId>/…`) carries no read restriction for the CALLING session's own
files — the recipient reading its own spill file is exactly the access it already has.

It is NOT correct for `transcript_read` (both implementations — the shared `mcp/transcript-read.ts` one
and the companion's own in `companion/capabilities.ts`), `worker_transcript`, and `session_transcript`.
These four tools exist specifically to read ANOTHER session's transcript, gated by real checks
(owner-authored-turn, DM-only, project-scope for the companion variant; role/lineage checks for the
others) that a plain filesystem `Read` does not know about. `<LOOM_HOME>/tmp/scratch/**` has no deny rule
at all, so if one of these four tools spilled an oversized turn there, any OTHER session that knows or
can guess a sibling session's id could `Read` that spilled file directly — bypassing every one of those
gates. That is the exact shape of leak the transcript-root deny (card `ac90ca8e`) exists to close, one
directory over. Card `26134f1a`'s own trust-boundary checkpoint had already surfaced this risk (point (c):
"whether a tool-results file can itself contain another session's transcript content").

The fix: `sessions/transcript.ts`'s `spillableTurnsResponse` no longer calls `spillTextIfLarge` at all.
Instead it truncates the offending turn(s) INLINE — per-turn, since `pageTranscript`/`lastNTurns` only
ever let a SINGLE turn push a page over budget (every other turn is already excluded by their own budget
check before being added) — keeping the turn's head and a short tail when there's room, with an explicit
`[TRUNCATED: showing N of M chars of this turn]` marker. This changes the response shape of three already
-shipped production tools (`transcript_read`, `worker_transcript`, `session_transcript`): a turn that used
to come back as `{turnsFile, turnsChars, note}` now comes back as a normal `turns` array with one entry's
`text` field truncated in place. The companion's own separate `transcript_read` (which had NO spill
protection at all before this card) was converged onto the same shared `spillableTurnsResponse` path
rather than growing a fifth ad hoc pattern.

## Do not

- Do not reintroduce a file-spill (Loom scratch or otherwise) fallback inside `spillableTurnsResponse` or
  any transcript-turn-bearing response path. Any filesystem write reachable by another session reopens
  the cross-session transcript leak this decision closes — bound the response INLINE instead, even if
  that means a lossier (truncated) result.
- Do not give the companion's own `transcript_read` (or any future transcript-reading tool) its own
  independent bounding logic. Route it through `spillableTurnsResponse` — a second ad hoc pattern is
  exactly the "two-path asymmetry this repo keeps shipping" the Lead flagged when approving this fix.
- Do not confuse this with the ORDINARY `spillable*`/`spillTextIfLarge`/`spillRowsIfLarge` helpers used
  elsewhere (`decisions_list`, `memory_list`, `skill_list`, `board_list`, `board_get`, companion
  `skill_read`, `tasks_list`, …) — those spill to the CALLING session's own scratch dir, which is fine
  because the recipient already has access to its own files. The distinction is whether the content
  being bounded belongs to the CALLING session (fine to spill) or was read ON BEHALF of a gate the
  filesystem itself doesn't enforce (transcript content — never spill).

## Source

`packages/daemon/src/sessions/transcript.ts`, `spillableTurnsResponse` + `truncateWithMarker` (card
`26134f1a`). Call sites: `mcp/transcript-read.ts` (`transcript_read`, manager/auditor/workspace-auditor),
`mcp/orchestration.ts` (`worker_transcript`), `mcp/platform.ts` (`session_transcript`),
`companion/capabilities.ts` (the companion's own `transcript_read`, converged onto this same path by this
card).
