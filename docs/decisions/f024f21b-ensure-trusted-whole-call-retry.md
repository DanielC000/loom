# f024f21b — one bounded whole-call retry of `ensureTrusted`, never a wider inner budget

## Narrative

Specimen 2026-10-05: a worker spawn failed outright with `EPERM: operation not permitted, rename
'...claude.json.<pid>.<uuid>.loom.tmp' -> '...claude.json'` while two spawns overlapped and five other
`claude` sessions were already live. `pty/claude-config.ts`'s `writeJsonAtomic` (the rename) and
`withTrustLock` (the lock-acquire) already retry transient Windows EPERM/EACCES/EBUSY bounded by
`transientFsRetryLimit()` (default 12 attempts, ~363ms worst case) — landed on main 2026-07-08/07-12, so
the daemon build that hit this (2026-10-04) already had both retries. The failure was the budget
genuinely exhausting under real contention, not a stale build.

This is the SAME exhaustion shape card `53e64114` (2026-10-03) already diagnosed, where the lead
explicitly decided NOT to raise `transientFsRetryLimit()`'s default: *"a rare, self-evident spawn error
that a plain re-call fixes doesn't justify a longer synchronous stall on the spawn path."* A second
specimen at LOWER concurrency (2 overlapping spawns + 5 live sessions, vs. the originally-measured
~1-in-64-at-12-concurrent-writers repro) weakened that ruling's "rare" premise enough to revisit, but the
lead kept the per-rename/lock-acquire constant itself as-is — see 53e64114's own retracted-premise note
for the full reasoning on that budget.

The fix landed here is narrower: `ensureTrustedResilient` (`pty/claude-config.ts`) wraps `ensureTrusted`
and, ONLY on a transient-FS-classified error (reusing `isTransientFsError`, never re-listing codes),
retries the WHOLE `ensureTrusted` call exactly once after a short jittered delay (150-400ms). A non-transient
error is never retried. A second exhausted attempt is not swallowed — it rethrows, so a genuinely-persistent
failure still fails the spawn exactly as before. `host.ts`'s `createPty` calls this wrapper instead of
`ensureTrusted` directly; this is the only call site (`PtyHost.createPty`, ~line 6770).

**Who the delay is actually bought against — corrected from an earlier draft of this record.** `createPty`'s
own adjacent comment already establishes that `spawn()→createPty()→ensureTrustedResilient()→ensureTrusted()`
is fully synchronous (no `await`) and JS is single-threaded, so two IN-PROCESS spawns on this daemon can
NEVER interleave — the lock/rename retries below this wrapper are structurally unreachable from a sibling
spawn on the SAME daemon. So the EPERM this retry buys a second chance against can only come from something
EXTERNAL to this process: most plausibly one of the live `claude` CLI sessions themselves (5 were running in
the specimen) reading/writing its own `~/.claude.json`, or an AV/indexer mid-scan. The jitter's actual
purpose is to desynchronize ACROSS processes (several Loom daemons sharing a home, or several unattended
spawns each independently exhausting their own budget around the same moment) — it does nothing for, and is
not needed for, a single spawn "racing itself."

The sleep (`sleepSync`) is **synchronous** and blocks the event loop for up to `ENSURE_TRUSTED_RETRY_MAX_MS`
(400ms) — the same posture `writeJsonAtomic`'s own rename backoff already has. It is reachable ONLY on the
already-rare failure path (the inner budget already exhausted), never on an ordinary uncontended spawn, so
it does not change the common-path cost.

A separate DoD question — "a failed write must not fail the whole spawn if the file already has the
needed entries" — was investigated and found not to apply as literally stated: `ensureTrusted` already
re-checks `isFullyDecided` both lock-free and again after a fresh re-read inside the lock, so a write is
only ever attempted when the entries genuinely are NOT yet present; there is no "already decided but we
tried to write anyway" case to swallow. Catching and discarding a persistent failure outright (mirroring
`injectSkills`'s best-effort pattern) was considered and rejected: unlike the MCP-server-enable prompt
(which has a documented Esc fallback), there is no fallback for the workspace-trust dialog itself, so
swallowing the error would trade today's clean, immediately-visible spawn failure for a silent hang on an
undismissed trust dialog instead.

## Do not

- Do not raise `transientFsRetryLimit()`'s default, or widen the per-rename/lock-acquire backoff inside
  `writeJsonAtomic`/`withTrustLock`, to address a repeat of this failure — that was decided against on
  card `53e64114` and again here; the fix is the outer whole-call retry, not a wider inner budget.
- Do not add a second (or looping) whole-call retry to `ensureTrustedResilient` — it is a ONE-shot
  courtesy attempt, deliberately bounded; a persistent transient failure must still surface and fail the
  spawn, matching the lead's "a plain re-call fixes it" stance.
- Do not swallow `ensureTrustedResilient`'s final failure (make the spawn proceed anyway) — see the
  trust-dialog-has-no-fallback reasoning above; a silently-untrusted spawn risks an unattended hang, which
  is strictly worse than today's clean, re-dispatchable spawn failure.
- Do not re-list EPERM/EACCES/EBUSY at the `ensureTrustedResilient` call site or elsewhere — reuse the
  exported `isTransientFsError` classifier so the three call sites (rename retry, lock-acquire retry, this
  outer retry) can never drift apart on what counts as transient.
- Do not remove the jitter (fixed delay instead) — it desynchronizes retries ACROSS processes (several
  Loom daemons, or several independently-exhausted spawns), not two in-process spawns (those can't
  interleave in the first place — see "Who the delay is actually bought against" above); a fixed delay
  would re-synchronize those cross-process retries instead.
- Do not describe this retry's contender as "another overlapping spawn" — `createPty`'s own comment proves
  two in-process spawns can't interleave, so the delay is always bought against something EXTERNAL (a live
  `claude` CLI session, AV/indexer), never a sibling spawn on this daemon.

## Source

`packages/daemon/src/pty/claude-config.ts` (`ensureTrustedResilient`, `isTransientFsError` exported),
`packages/daemon/src/pty/host.ts` (`PtyHost.createPty` call site) — card `f024f21b`, decided by the lead
on top of card `53e64114`'s retracted-premise note.
