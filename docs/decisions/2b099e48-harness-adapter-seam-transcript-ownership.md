# 2b099e48 — HarnessAdapter seam: `pty/claude-transcript.ts` owns the transcript path/wire-format

## Narrative

Card `2b099e48`, Phase 0 of the multi-harness epic `df1f94b0`: `pty/claude-transcript.ts` is the claude adapter's ownership of the engine transcript's on-disk location + JSONL wire format. Every literal `~/.claude/projects/...` path construction and every assumption about the shape of a Claude Code transcript line (`type: "user"|"assistant"`, `message.content` blocks, `tool_use`/`tool_result`) lives here and nowhere else — moved out of `sessions/transcript.ts` (formerly the sole owner) so that file can hold only the harness-AGNOSTIC half (pagination, spill, Loom's own archive store), which operates on the generic `TranscriptTurn` shape regardless of which harness produced it.

`sessions/transcript.ts` re-exports every name from this file unchanged for its 13 existing consumers (see its own header comment) — this move is a pure relocation with zero call-site churn and zero behavior change (verified: see the pty test suite, in particular `transcript-encode.mjs` and `real-homedir-transcript-leak-isolation.mjs`).

`TranscriptTurn` itself is defined in `pty/adapter.ts` (Code Review MAJOR-2, card `2b099e48`) — it is the harness-AGNOSTIC contract type every future adapter's `readTranscript` returns, so it belongs with the interface, not inside adapter #1's own implementation. Re-exported from `claude-transcript.ts` so nothing downstream needs to change its import path.

## Do not

- Do not construct a `~/.claude/projects/...` literal path, or encode an assumption about the Claude Code JSONL wire shape, anywhere outside this file.
- Do not move `TranscriptTurn`'s definition back into this file — it is a harness-agnostic contract type that belongs in `pty/adapter.ts`, not inside one adapter's own implementation.

## Source

Header doc comment in `packages/daemon/src/pty/claude-transcript.ts` (lines 6-23 pre-extraction), introduced by commit `f6e652be` (`refactor(pty): extract a HarnessAdapter seam from the claude driver`).
