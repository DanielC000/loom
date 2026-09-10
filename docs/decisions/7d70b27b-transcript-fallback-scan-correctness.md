# 7d70b27b — transcript fallback scan: correctness

## Narrative

DoD-3 determination, card `7d70b27b` (the second reader to ask this) — two separate questions, only one settled by "engine ids are UUIDs".

CORRECTNESS — can `resolveTranscriptFile`'s fallback scan resolve to the WRONG file? The global fallback scan (scan `~/.claude/projects/*` for `<engineSessionId>.jsonl` when the computed path misses) is CORRECT-BY-DESIGN for production and is NOT changed by this card. Every real engine session id is a Claude-CLI-minted UUID, so an accidental collision between two DIFFERENT sessions is implausible — the scan's whole reason to exist (dir-encoding drift resilience; see `encodeProjectDir`'s own doc comment) depends on exactly that global-uniqueness property.

The production defect this card actually fixes lives entirely on the TEST side: `test/engine-session-rotation.mjs` used to write FIXED literal ids (`"engine-session-alpha/beta/gamma/delta"`) instead of real UUIDs, so a leftover from one run could collide with a later run's lookup for the exact same literal name — a hazard this function's own contract doesn't create and can't detect.

## Do not

- Any HERMETIC test that exercises this scan must mint globally-unique-shaped ids (e.g. suffixed with `${Date.now()}-${process.pid}`) for the same reason real engine ids already are unique — not because `resolveTranscriptFile` should scope its search.

## Source

`resolveTranscriptFile`'s doc comment in `packages/daemon/src/pty/claude-transcript.ts`, "CORRECTNESS" section (part of the combined lines 88-151 block pre-extraction). See also `f432cbb8-transcript-fallback-scan-cost-bound.md` (card `f432cbb8`) for the separate cost determination on the same function.
