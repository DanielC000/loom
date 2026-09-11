# 3791b14e — `codex-doctrine-real-spawn.mjs`'s override must stay above its own inner wait

## Narrative

`codex-doctrine-real-spawn.mjs:225`'s own internal "turn completes" `waitUntil` is `150_000`ms —
widened from 90s by card `887e10b8`'s own development ("150s, not the sibling file's 90s ... this
host's real `~/.codex` carries several bundled plugin skills that inflate the system prompt"). This
file was never added to `TEST_TIMEOUT_OVERRIDES`, so it ran under the blanket
`TEST_TIMEOUT_MS=120_000` — an outer per-file kill ceiling SMALLER than its own inner wait.

An outer ceiling below an inner wait can NEVER let that inner wait mature: the harness's own
`child.kill()` fires at 120s regardless of whether the real codex turn was about to land at, say,
130s. This needs no trial count to justify — it was found by reading the two constants against each
other, not by observing a flake — and is independent of `_codex-real-spawn-lock.mjs`'s own
budget/scheduling fix alongside it in this same card: a perfect lock fix cannot rescue a wait that
the outer harness kills before it can complete.

`300_000` clears the `150_000` inner wait with 2x margin (consistent with this file's own siblings
in the override map), leaving headroom for the earlier ready-placeholder(20s)/busy-settle(60s)/
kickoff-retry(30s)/engine-id(30s) steps plus a hard-stop(8s) to ALSO run long under real host load,
without the outer ceiling ever again undercutting a legitimate inner wait.

**On card `887e10b8`:** its own 90s→150s widening decision (and the plugin-skills rationale behind
it) lives at its own site in `packages/daemon/src/pty/host.ts` (~line 4558) — not re-derived here.
That file is outside this program's file-fence for this tranche, so no record was created or
extended for `887e10b8` from this side; this narrative only quotes its outcome as context for why
this file's own override must be sized the way it is.

## Do not

- This override must stay numerically ABOVE `codex-doctrine-real-spawn.mjs`'s own largest internal
  `waitUntil` timeout, whatever that becomes — if that file's own wait ever grows again, this must
  grow with it.

## Source

Inline comment in `packages/daemon/scripts/test-daemon.mjs`, immediately preceding the
`"codex-doctrine-real-spawn"` entry in `TEST_TIMEOUT_OVERRIDES` (originally ~lines 864-879). Card
`3791b14e`. Related: `887e10b8` (the sibling card whose own 90s→150s widening this override must
stay above — recurs at pty/host.ts, no record created here, see Narrative above).
