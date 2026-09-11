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

## Merge-gate rejection root cause (gate `39331d61`) — a top-level static import breaks dynamic-import-based loaders

A TOP-LEVEL static import of `CODEX_REAL_SPAWN_BASENAMES`/`CODEX_REAL_SPAWN_SET` from
`../test/_codex-real-spawn-lock.mjs` broke `loadExcludedTestDirNames`/`loadNotHermeticNames`
(`git/worktrees.ts`) — both dynamically `import()` this WHOLE FILE from an arbitrary/synthetic fixture
repo just to read `EXCLUDED_DIR_NAMES`/`NOT_HERMETIC`. A static import is resolved before the module can
even start evaluating, so a fixture repo lacking `_codex-real-spawn-lock.mjs` threw
`ERR_MODULE_NOT_FOUND` — caught by their own try/catch, silently returned `null`, and FAILED THE DIFF
CLOSED to the full gate instead of the reduced one. Confirmed via a two-arm control: same fixture repo,
only that one file present vs. absent.

**Fix:** the same pattern `compactGateTimingLogIfNeeded`'s own import already uses (see
`_emit-compare-fixtures.mjs`'s comment on that precedent) — a LAZY, call-site `await import()`, placed
inside `isMain`, at the earliest point it's actually needed, never at module top. Safe by construction,
not merely lucky for today's fixtures: `isMain` is true only when `process.argv[1]` resolves to THIS
file's own path, i.e. this script IS the process entry point — an external dynamic-import consumer (the
two loaders above) is by definition some OTHER process (the daemon) importing this file as a module, so
`isMain` is false for them unconditionally and this line can never be reached in that scenario, regardless
of whether the importing repo carries `_codex-real-spawn-lock.mjs`.

**Rejected:** moving the array into a new shared leaf module — needless, when this exact file already has
a proven lazy-import pattern for this exact hazard class.

**Also serves `ce02e7e5`:** the import's call site sits here (rather than at the phase-split use further
below) so `resolveSelectionForCliMode` can resolve `--codex-real-spawn`/`--no-codex-real-spawn` from this
SAME array — the single source of truth `ce02e7e5` establishes elsewhere in this file (its own inline
comments at ~lines 585-699, unresolved by this tranche) — instead of a second, hardcoded copy of the
basename list.

## Do not

- This override must stay numerically ABOVE `codex-doctrine-real-spawn.mjs`'s own largest internal
  `waitUntil` timeout, whatever that becomes — if that file's own wait ever grows again, this must
  grow with it.
- Do not move the `_codex-real-spawn-lock.mjs` import back to module top-level — it re-breaks
  `git/worktrees.ts`'s two dynamic-import-based loaders against a fixture repo lacking this file.

## Source

Inline comment in `packages/daemon/scripts/test-daemon.mjs`, immediately preceding the
`"codex-doctrine-real-spawn"` entry in `TEST_TIMEOUT_OVERRIDES` (originally ~lines 864-879). Card
`3791b14e`. Related: `887e10b8` (the sibling card whose own 90s→150s widening this override must
stay above — recurs at pty/host.ts, no record created here, see Narrative above).

Extended (tranche 6) with the merge-gate rejection root cause above: inline comment originally at lines
1492-1514, immediately preceding the lazy `_codex-real-spawn-lock.mjs` import in `isMain`. No separate
record for gate `39331d61` (the rejection this section documents) or card `ce02e7e5` (mentioned only in
prose above; its own fuller decision remains unresolved elsewhere in this file, out of this tranche's
scope).
