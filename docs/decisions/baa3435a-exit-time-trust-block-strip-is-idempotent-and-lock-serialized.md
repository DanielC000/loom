# baa3435a — codex's final trust-block strip retries at exit, idempotently, against the shared config.toml lock

## Narrative

Card `baa3435a` (DoD-2): `spawnCodexProcess`'s `pty.onExit` handler in `packages/daemon/src/pty/host.ts` makes one last best-effort trust-block strip attempt, in case codex's `config.toml` persist landed AFTER the bounded poll (`pollConfigDiffAfterSpawn`) had already given up — or the poll simply hadn't reached a fresh check yet when the pty happened to exit. The poll's own promise chain keeps running independently of the pty's lifetime, so this exit-time attempt is a genuine belt-and-suspenders catch, not the only chance.

It runs on EVERY exit, not just an intended stop: a crash leaves the trust block behind just as surely as a graceful stop does, and the session isn't coming back to retry later. Guarded on `trustDialogAnswered` — if the dialog never appeared, this spawn never touched `config.toml`, so there's nothing to diff.

It re-diffs against the SAME `configHashBefore` this spawn captured before any write, so it's idempotent by construction: once the block is already stripped, the file's current bytes hash back to that same pre-spawn value and `diffConfigAfterSpawn` reports `changed:false` — this can run any number of times, including racing the poll's own in-flight final iteration, without ever double-stripping.

It is routed through the SAME `codexTrustDialogLock` every other `config.toml` read/write in this file uses — the real file is shared across every codex session on this host, so this must serialize against a DIFFERENT session's own trust-answer cycle too, not just this session's own (already-finished-or-not) one. Fire-and-forget (`onExit` itself isn't async); best-effort (never throws — matches every other cleanup step in this handler).

## Do not

- Do not skip the exit-time strip attempt on the theory that the bounded poll already covers it — the poll's own promise chain runs independently of the pty's lifetime and can still be mid-flight, or already given up, when the pty exits.
- Do not guard this attempt on anything but `trustDialogAnswered` — if the dialog never appeared, the spawn never touched `config.toml`, so there is nothing to diff.
- Do not diff against anything but the spawn's own `configHashBefore` — that is what makes repeat runs (including a race with the poll's own final iteration) idempotent.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`spawnCodexProcess`'s `pty.onExit` handler, the final trust-block strip attempt), as of commit `7c501c6d4fda5741aad8adf95198159aadd6a5b6` ("fix(pty): poll for codex's trust-block write before stripping it"). Extracted by card `85b87619` (tranche 56 on `pty/host.ts`).
