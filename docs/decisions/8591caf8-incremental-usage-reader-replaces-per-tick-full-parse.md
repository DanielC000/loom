# sha:8591caf8 — the incremental usage reader replaces a per-tick full-transcript re-parse at fleet scale

## Narrative

`readRunUsageFromFile` reads + parses the WHOLE transcript file on every call; originally the only reader,
used by both the sampler tick and the boot backfill / Agent-Runs cost readout. At fleet scale, calling it
synchronously every tick for every live session stalled the event loop. `IncrementalRunUsageReader`
replaces the SAMPLER's own use with a reader that parses only bytes appended since the last tick, off the
event loop (`fs.promises`) — `readRunUsageFromFile` itself is untouched and still serves the other two
callers, which don't run per-tick.

**Byte-identical guarantee:** the incremental reader's cumulative is byte-identical to a full parse by
construction, because both share the SAME `accumulateUsageLine` fold (the one place the dedup-by-
`message.id` + per-field summing logic lives) — so the sampler's delta layer (`recordDelta`), including
the restart-double-count fix ([[c9924bcd-usage-sampler-restart-double-count-fix]]), is preserved unchanged.

**Per-tick mechanics:** `fs.promises.stat` the transcript; unreadable ⇒ skip, cache untouched; no new
bytes ⇒ no IO/parse; size shrink ⇒ truncation of this file ⇒ reset the cache and re-read from 0;
`engineSessionId` changed vs the cache ⇒ fork/recycle rotated to a new transcript ⇒ reset and read the
new file; otherwise read only `[lastReadEnd, size)`, prepend the cached partial line, split on `\n`, parse
only the complete lines (advancing offset by their bytes), and buffer the trailing no-newline remainder.

**Dedup persistence:** the `message.id` dedup `seen` set lives IN the per-session cache and is cleared
ONLY on rotation/reset — so a duplicate message-id line-group straddling a tick's read-offset boundary is
counted exactly once, never re-counted. This is the load-bearing over-count trap the design exists to
avoid.

**UTF-8 safety:** offset only ever advances to a `\n` boundary (0x0A never appears inside a multibyte UTF-8
continuation byte), and the unterminated remainder is buffered as raw BYTES rather than decoded — so a
multibyte character split across a read chunk is never corrupted mid-decode.

**Restart safety:** the cache is purely in-memory, per `UsageSampler` instance. A daemon restart
constructs a fresh reader with an empty cache, so the first tick after a restart full-parses (the same
cumulative as before the restart) and the DB-aware first-sight path
([[c9924bcd-usage-sampler-restart-double-count-fix]]) runs identically to a cold start.

## Do not

- Do not let the incremental reader's cumulative diverge from a full parse — both routes must share
  `accumulateUsageLine`'s fold; a duplicated/independent implementation risks silent drift between them.
- Do not clear the dedup `seen` set on anything but a rotation/reset — clearing it on an ordinary tick
  would double-count a `message.id` line-group straddling that tick's read boundary.
- Do not decode a read chunk's trailing partial line before its terminating `\n` arrives — buffer it as
  raw bytes, or a multibyte UTF-8 character split across chunks corrupts.

## Source

JSDoc comments in `packages/daemon/src/sessions/context.ts`: `readRunUsageFromFile`'s "SYNCHRONOUS +
whole-file" paragraph (lines 240-243 pre-extraction) and `IncrementalRunUsageReader`'s class doc (lines
280-305 pre-extraction), both introduced by commit `8591caf8c21feda591720fccec741d6a290d80d4`
("perf(daemon): bound the usage sampler's per-tick transcript reads at fleet scale"). No board card id
found in either block, nor in `git blame`'s introducing commit — keyed by commit sha per
`docs/extraction-program.md`'s `sha:` grammar.
