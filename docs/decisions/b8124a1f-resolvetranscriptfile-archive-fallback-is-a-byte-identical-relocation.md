# b8124a1f — `resolveTranscriptFile`'s archive-root fallback: a byte-identical relocation, never a transform

## Narrative

`resolveTranscriptFile` (`packages/daemon/src/pty/codex-transcript.ts`) falls back to `codexRolloutArchiveRoot` when a conversation's rollout file isn't found in the live `sessions/` tree. An archived rollout (`codex-rollout-archive.ts`) is a byte-identical relocation, never a transform, so this fallback keeps every caller — `worker_transcript`, exit-time `snapshotTranscript`, `sessions/scratch-gc.ts`'s resumability check, and `sessions/liveness.ts`'s watcher re-check — working unchanged for an archived session. See `codex-rollout-archive.ts`'s own header doc for why the archive sweep never needs to prove a rollout is safe against a live-or-resumable session before moving it.

## Do not

- Do not special-case an archived rollout anywhere that calls `resolveTranscriptFile` — the fallback exists precisely so every caller stays unchanged whether a conversation's file is live or archived.

## Source

Inline comment in `packages/daemon/src/pty/codex-transcript.ts` (`resolveTranscriptFile`'s own doc), as of this tranche's HEAD. Relocated by card `32d90bb2` (tranche 2 on `pty/codex-transcript.ts`); source lines joined into a flowing paragraph and `*` comment markers stripped, with no change to the facts or the argument's structure.

## Lineage (owner decision + the investigation behind the threshold), and the new measurement

Card `b8124a1f` — owner decision, request `15bd0464`: "Archive-not-delete: Loom compresses/moves old rollouts out of `sessions/`, never deletes." Card `3795232e` found NO vendor retention knob for the corpus. (The full archive-sweep mechanism, the threshold's own two-reason safety argument, and the design rule that this constant is NOT tuned to either of `3795232e`'s measured rates all stay inline at the call site, verbatim — see `pty/codex-rollout-archive.ts`'s own module-level doc comment.)

MEASURED on this host 2026-09-09 (re-measured per the card's own instruction — the corpus has grown since card `3795232e`'s original measurement): 312 files, 18.6MB, spanning 2026-09-06 through 2026-09-09 (the corpus's full lifetime on this host, ~2.5 days).

### Source (this section only)

Inline comment in `packages/daemon/src/pty/codex-rollout-archive.ts` (the module-level doc comment above `CODEX_ROLLOUT_ARCHIVE_AGE_MS`), as of this tranche's HEAD. Extracted by this card's tranche 1 on `pty/codex-rollout-archive.ts`; no wording changed beyond joining wrapped source lines into flowing paragraphs and stripping `*` comment markers.
