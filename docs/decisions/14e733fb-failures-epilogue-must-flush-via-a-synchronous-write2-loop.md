# 14e733fb — the `FAILURES:` epilogue must flush via a synchronous write(2) retry loop, never a console.log loop

## Narrative

Node documents `process.stdout`/`process.stderr` writes to a PIPE as SYNCHRONOUS on Windows but
ASYNCHRONOUS on POSIX ("process.stdout"/"process.stderr" — Synchronous vs asynchronous writes). This is
established empirically, not just quoted from docs, by a separate investigation (card `776750ba`, a Linux
CI investigation) against `test/test-daemon-stderr-capture-race.mjs` + its fixture
`test/fixtures/_stderr-sentinel-exit.mjs`: a hard, zero-loss gate on Windows (synchronous by construction),
an informational (non-failing) measurement on POSIX, where Node's own documented semantics make occasional
loss expected. No record created for `776750ba` in this tranche — its full narrative lives in that other
test file, outside this program's file fence for `scripts/test-daemon.mjs`.

`isMain`'s own `FAILURES:` epilogue — the ONLY surviving surface for a multi-line failure detail (card
`63664129`, its own record) — used to print via a `console.log` loop immediately followed by
`process.exit(1)`: on a POSIX gate host, `process.exit()` can
tear the process down before those async writes ever reach the OS pipe, silently losing exactly the
diagnostic this block exists to preserve.

**The fix, `writeFullySync(fd, text)`:** builds the whole block into one buffer and writes it via a real
synchronous write(2) loop that keeps writing until every byte is CONFIRMED out, never assuming one
`fs.writeSync` call drained the buffer. Two real gotchas a naive single call would miss: `fs.writeSync` can
itself return fewer bytes than requested against a pipe, and can throw `EAGAIN` if the fd isn't ready — a
fix that doesn't loop is cosmetic. The caller hands it `epilogueLines.join("\n") + "\n"` — byte-identical
to the OLD per-call `console.log` sequence it replaces (each old call wrote its argument plus one
trailing `"\n"`, so join-plus-final-`"\n"` reproduces exactly that).

**Bounded, deliberately (`WRITE_FULLY_SYNC_DEADLINE_MS = 5_000`):** the EAGAIN/zero-byte retry is bounded
on ELAPSED TIME, not iteration count — each spin is sub-microsecond, so a count bound is meaningless, but
an UNBOUNDED spin against a non-blocking fd whose reader never drains would hang the gate's own FAILURE
path forever, in a shared gate lane. This project already paid once for exactly this "rare but unbounded
wait" shape in this file's neighbourhood (commit `53175055`, not a board card — verified via `git cat-file
-t 53175055` → `commit`). A spawned child's fd 1 is normally a BLOCKING
pipe (`fs.writeSync` blocks rather than returning `EAGAIN`/0) — precisely why the bound needs to exist
rather than the branch being removed: rare enough nobody would hit it in testing, unbounded enough to wedge
a gate if it ever does. On deadline, give up and keep whatever's already written — partial output is the
PRE-EXISTING failure mode this function replaces (a lost tail), strictly better than a hang; a throw here
would lose the WHOLE block instead of just the unwritten remainder.

**`TEST_FORCE_WRITE_CHUNK_BYTES`** is a test-only determinism knob (undefined/no-op in every real run) —
this host's own pipe writes are synchronous by construction (win32) or complete inside typical epilogue
sizes (posix), so nothing here can organically FORCE a real multi-call partial write in a hermetic test.
Clamping the per-call length to this many bytes makes the loop's own multi-iteration path exercised and
verifiable regardless of platform or payload size, without touching the code path a production run takes.
Verified BREAK → RED → revert → GREEN while authoring this fix, via
`test/test-daemon-failures-epilogue-flush.mjs` (temporarily replacing the loop with one non-looping
`fs.writeSync` call reproduced a truncated capture; reverting restored the full capture).

**Output ordering (manager review):** writing directly to fd 1 here BYPASSES `process.stdout`'s own
pending async queue on POSIX, so this epilogue can land BEFORE — or interleaved with — earlier
`console.log` output from this same run that's still buffered. Accepted as a net win: that earlier output
was already loss-prone (the exact defect this card fixes), and `gate-runner.ts`'s `failureBlockTracker` is
FRONT-ANCHORED on the `FAILURES:` marker, so it captures forward correctly regardless of what preceded it
in the stream — but it IS a real, deliberate behavioural change, not something a future reader should have
to discover by puzzling over scrambled CI output.

## Do not

- Do not replace the write(2) retry loop with a single `fs.writeSync` call — reintroduces the exact
  async-pipe loss this fix exists to close (see `test-daemon-failures-epilogue-flush.mjs`'s own BREAK/RED
  proof).
- Do not remove or lower `WRITE_FULLY_SYNC_DEADLINE_MS`, or switch it to an iteration-count bound, without
  re-accounting for commit `53175055`'s "rare but unbounded wait" hazard in this file's neighbourhood.
- Do not treat `TEST_FORCE_WRITE_CHUNK_BYTES` as exercising a real production code path — it is a
  test-only determinism knob, a no-op whenever the env var is unset.

## Source

Inline comment in `packages/daemon/scripts/test-daemon.mjs`, immediately preceding
`TEST_FORCE_WRITE_CHUNK_BYTES`/`writeFullySync` (originally lines 1045-1071), plus the immediately
following EAGAIN/deadline paragraph (originally lines 1075-1082), as of this tranche's HEAD. Card
`14e733fb`. Related: `776750ba` (the POSIX/Windows pipe-semantics investigation this fix relies on, no
record created here — see that card's own test file), `63664129` (why the epilogue is the only surviving
surface for multi-line detail — see its own record), `53175055` (the prior "rare but unbounded wait"
incident that motivates the elapsed-time bound).
