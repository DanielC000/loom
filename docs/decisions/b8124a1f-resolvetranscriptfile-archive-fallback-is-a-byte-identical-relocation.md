# b8124a1f — `resolveTranscriptFile`'s archive-root fallback: a byte-identical relocation, never a transform

## Narrative

`resolveTranscriptFile` (`packages/daemon/src/pty/codex-transcript.ts`) falls back to `codexRolloutArchiveRoot` when a conversation's rollout file isn't found in the live `sessions/` tree. An archived rollout (`codex-rollout-archive.ts`) is a byte-identical relocation, never a transform, so this fallback keeps every caller — `worker_transcript`, exit-time `snapshotTranscript`, `sessions/scratch-gc.ts`'s resumability check, and `sessions/liveness.ts`'s watcher re-check — working unchanged for an archived session. See `codex-rollout-archive.ts`'s own header doc for why the archive sweep never needs to prove a rollout is safe against a live-or-resumable session before moving it.

## Do not

- Do not special-case an archived rollout anywhere that calls `resolveTranscriptFile` — the fallback exists precisely so every caller stays unchanged whether a conversation's file is live or archived.

## Source

Inline comment in `packages/daemon/src/pty/codex-transcript.ts` (`resolveTranscriptFile`'s own doc), as of this tranche's HEAD. Relocated by card `32d90bb2` (tranche 2 on `pty/codex-transcript.ts`); source lines joined into a flowing paragraph and `*` comment markers stripped, with no change to the facts or the argument's structure.
