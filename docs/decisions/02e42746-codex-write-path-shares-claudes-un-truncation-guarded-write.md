# 02e42746 — codex's write path shares claude's un-truncation-guarded `pty.write()`; chunk it identically

## Narrative

Card 02e42746: `text` used to reach the pty via ONE `live.pty.write(...)` call for codex — unlike the claude path (`writeChunked`), which exists because a single large `pty.write` is TRUNCATED by Windows ConPTY's input buffer.

That truncation sits BELOW the harness: `createPty` (claude) and `createCodexPty` both spawn through the identical `node-pty` `IPty`, whose `.write()` is a bare `net.Socket.write` onto ConPTY's input pipe regardless of which process is on the other end — verified by reading node-pty@1.1.0's own `terminal.js`/`windowsTerminal.js`: `write()` -> `_write()` -> `this._agent.inSocket.write(data)`, with no per-harness branching anywhere in that path. So nothing about codex's own TUI shields it — the reviewer's asymmetry claim was real, not merely apparent, and this is a MEASURED conclusion about the write path's structure, not an inference from the claude-side comment alone (that comment is evidence the hazard exists at all; the shared node-pty code path is what establishes it also reaches codex).

No independent codex-side truncation repro was attempted (per the card's own instruction not to manufacture one), and no numeric threshold is known for either harness. Fix: `writeChunkedCodex` reuses the SAME `PTY_WRITE_CHUNK_UNITS`/`PTY_WRITE_CHUNK_DELAY_MS`/`surrogateSafeChunkEnd` machinery `writeChunked` already uses, rather than inventing a second, untested threshold. It mirrors `writeChunked` against `CodexLive`'s fields instead of `Live`'s, with three deliberate simplifications: no `ptyWrite` diagnostic wrapper (that wrapper, and the `writeSeq`/log-record convention it feeds, is typed to `Live` only, so a bare per-chunk `.pty.write` is the whole of it here); it re-fetches the live entry from `liveCodex` on every step (not the closed-over `live` reference) for the same reason `writeChunked` does — a multi-chunk write can span many `setTimeout` ticks, wide enough for a resume/recycle to replace this session's `CodexLive` entry mid-write; and it deliberately does NOT check `busyStaleGen` per chunk (a stop/redirect landing mid-write can still let a later chunk of already-superseded text reach the pty) — `writeChunked` accepts the identical risk for claude, so this mirrors it rather than inventing a stronger guarantee only one harness would have.

The delayed Enter write (and the staleness timer it arms) now starts counting from the LAST chunk landing, not from `submitCodex`'s own synchronous call instant — preserving the "write, then wait `CODEX_SUBMIT_ENTER_DELAY_MS`, then Enter" shape the probe observed, just measured from the write's true completion rather than its start. This also widened `submitCodex`'s write-then-wait window from "near-instant" to however long the chunked write itself takes (see card `7c2a6dc0`'s own record for why that widened window matters to its own generation-capture fix).

## Do not

- Do not skip chunking codex's writes on the theory that its TUI might be shielded from ConPTY's input-buffer truncation the way `writeChunked` guards claude against — the shared `node-pty` write path is unconditional and un-branched; nothing about codex's own TUI shields it.
- Do not invent a second, codex-specific truncation threshold — reuse `writeChunked`'s own constants; no independent codex-side repro was attempted and none is known.

## Source

Inline comments in `packages/daemon/src/pty/host.ts`: `submitCodex`'s own doc and `writeChunkedCodex`'s own doc, both as of this tranche's HEAD. Extracted by card `677c79cd` (tranche 17 on `pty/host.ts`).
