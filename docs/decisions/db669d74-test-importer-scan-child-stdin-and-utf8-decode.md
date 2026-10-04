# db669d74 — the test-importer scan's child process reads `roots` over stdin, and decodes stdout with `setEncoding("utf8")`

## Narrative

From the `72769424` round-4 delta review: two independent mechanism-level defects in
`scanTestImporterClosureInChildProcess` (`git/worktrees.ts`), fixed together since both touch the same
child-process plumbing.

**Chunk-split UTF-8 corruption.** Both `scanTestImporterClosureInChildProcess` and `loadHarnessSetExport`
collected a child's stdout with `child.stdout?.on("data", (d) => { if (out.length < N) out += d; })` — `d`
is a `Buffer`, and `out += d` implicitly calls `d.toString("utf8")` on EACH chunk independently. A
multi-byte UTF-8 character whose bytes straddle a chunk boundary (the OS pipe chunks by byte count, never
by character) decodes as two incomplete fragments, each independently replaced with U+FFFD — silently
corrupting a discovered-importer path (or a harness-exported name) rather than failing loudly. The fix,
`collectUtf8Stdout` (exported from `git/worktrees.ts`), calls `stdout.setEncoding("utf8")` before
attaching the `"data"` listener: Node's `Readable` then decodes through its own `StringDecoder`, which
buffers a trailing incomplete multi-byte sequence until the next chunk completes it, so a chunk boundary
can never land mid-character. Both call sites now share this one helper instead of each carrying its own
copy of the buggy shape.

**Windows argv-length overflow.** `scanTestImporterClosureInChildProcess` passed `roots` (every directly
changed/deleted test-shaped path in the diff) as `JSON.stringify(roots)`, a single argv element. A diff
touching several hundred test files serializes to a string that, combined with the rest of the command
line (the probe source, the module URL, the worktree path), can exceed the Windows ~32767-character
combined command-line limit (the same `WINDOWS_COMMAND_LINE_LIMIT` class of hazard `CLAUDE.md`'s own
"startup/kickoff prompt" section names for PTY spawns). `spawn` then fails — a synchronous throw or an
async `"error"` event, both already handled — and the scan resolves `{ok:false,
kind:"harness-config-unavailable"}`, which fails the whole diff closed: SAFE (the full gate still runs)
but loses the reduction for exactly the large diffs where it matters most. The fix moves `roots` onto the
child's stdin (`stdio: ["pipe", "pipe", "ignore"]`, `child.stdin.end(JSON.stringify(roots))`), which has no
comparable ceiling; the probe source (`TEST_IMPORTER_SCAN_PROBE_SOURCE`) now reads and buffers stdin
(`setEncoding("utf8")` there too, for the same chunk-split reason) before calling `scanTestImporterClosure`.

Scoped to this one child-process call site only: `loadHarnessSetExport`'s own spawn passes a short, fixed
export name (`"EXCLUDED_DIR_NAMES"`/`"NOT_HERMETIC"`) via argv, never variable-length diff data, so it
carries no comparable overflow risk and its argv shape is untouched.

**A third review item — moving `sessions/service.ts`'s admission-time emit-compare reclassify out of the
held gate slot/per-repo admission guard — was considered and REJECTED as unsound, not implemented.** The
reclassify's whole purpose is to catch a branch/main commit landing during the semaphore's CAP-queue wait
(`@decision 7183540f`/`66b3112a`), which routinely runs minutes at `maxConcurrentGates > 1` — so it must
observe the TRUE post-wait head, which only exists once genuinely admitted; computing it any earlier just
reproduces the stale-base race those cards exist to close. Separately, the per-repo admission guard must
stay held continuously from admission through squash (`@decision c24dd48a`, closing the same-repo-
sibling-squash race) — dropping it mid-scan and re-acquiring afterward would reopen exactly that race.
Decision: leave the reclassify exactly where it is, and instead extend `sessions/service.ts`'s own
TIMING-PROFILE NOTE (the same one `@decision b798e706` already uses for the union re-merge's own ~195s
worst case) to also name this scan's worst case, by pointing at `TEST_IMPORTER_SCAN_TIMEOUT_MS`
(`git/worktrees.ts`) rather than restating its value — so a `gate_queue`/`idleMs` reader sees a long
admission window here as the known, bounded cost it is, never a stall. Pure documentation; no behavior
change. A higher-risk alternative (speculative background recompute overlapping the queue wait, with a
synchronous in-slot fallback identical to today's code) was deferred to its own card rather than built
here.

## Do not

- Do not revert to `out += d` (or any other per-chunk `Buffer#toString()`) for a child's stdout — it
  decodes each chunk independently and corrupts a multi-byte character split across a chunk boundary.
- Do not pass `roots` (or any other diff-sized, unbounded-length payload) to this child via argv — stdin
  is the fix specifically because argv has a hard, low (on Windows) ceiling this payload can exceed.
- Do not widen this stdin change to `loadHarnessSetExport`'s own spawn — its argv payload is a short,
  fixed name with no overflow risk; only the UTF-8 decode fix (`collectUtf8Stdout`) applies there too.
- Do not move the emit-compare reclassify (`sessions/service.ts`'s `reunionAtAdmission`) out of the held
  gate slot/per-repo admission guard to shrink this timing cost — it must observe the TRUE post-wait head
  (`@decision 7183540f`/`66b3112a`) and the guard must stay held through squash (`@decision c24dd48a`);
  see the narrative above for why both races reopen. Extend the documentation, not the mechanism.

## Source

New code in `packages/daemon/src/git/worktrees.ts` (card `db669d74`, a delta-review finding on card
`72769424`), not an extraction from prior inline narrative. The timing-profile addendum is an extension
of the existing inline comment in `packages/daemon/src/sessions/service.ts` (the `reunionAtAdmission`
TIMING-PROFILE NOTE, card `b798e706`).
