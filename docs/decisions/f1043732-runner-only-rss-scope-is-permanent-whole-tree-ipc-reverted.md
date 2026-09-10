# f1043732 — runner-only RSS scope is permanent; whole-tree via IPC was implemented then reverted

## Narrative

`e6e55f7a`'s RSS tracker scopes to the coordinating runner process only, not its spawned test
children, and the printed line says so explicitly rather than claiming "process tree" for what is
really one process. This scope started as a speculative comment ("no cheap, reliable cross-platform
way to sum a spawned test child's RSS without an added subprocess") but is now a checked, evidenced,
permanent decision, replacing that speculation.

**The speculative claim was wrong, and this was proven, not argued.** A `--import`-injected preload
plus an `'ipc'` stdio channel *can* reach a spawned test child's own `process.memoryUsage().rss`
without any `/proc` read or `tasklist`/`ps` shell-out (no added subprocess — the project's hard
fence against per-sample subprocess spawns held). It was implemented, merge-gated locally, and
re-verified against the real harness: runner-only reported `69.72 MB` against whole-tree's
`247.56 MB` — the old line was materially understating suite memory pressure, which was the whole
motivation for asking the question.

**It was then reverted** after it was found to reproduce a real, structurally daemon-fatal upstream
bug: node-pty issue #952 (`WindowsPtyAgent`'s ConPTY `kill()` races an uncaught
`_getConsoleProcessList().then(...)` against a synchronous `_ptyNative.kill(...)`). This was
confirmed via a controlled A/B/C/D/E experiment: merely attaching an IPC channel and sending *any*
`process.send()` — even a single one, at load, with no periodic timer and no exit handler — is
sufficient to crash `test/kickoff-real-spawn.mjs` deterministically (5/5+ across bundled and solo
runs), while the same channel attached with zero sends stayed clean (0/9). Two other PTY-spawning
files (`boot-mode-settings-argv-coupling`, `spawn-command-line-preflight`) were *not* similarly
sensitive once a periodic timer was removed, ruling out "IPC channel presence alone" as the trigger
for those two — but not for `kickoff-real-spawn`, which is uniquely and reliably sensitive to that
file's own PTY-teardown timing (not explained by `createPty` call count — it calls fewer than either
of the other two).

The full reproduction recipe (exact crash signature, exact configs tried, exact counts) is preserved
in this project's shared memory as `nodepty-952-conpty-kill-race-reproducer` — read that before
attempting whole-tree RSS again, and before assuming any future node-pty upgrade has fixed the
underlying race; it names the minimal config to re-test against.

Throughout, the printed line's property of being unmisquotable held: a reader can never take the
runner-only number for a whole-tree peak, because the line states its own scope.

## Do not

- Do not re-attempt whole-tree RSS via IPC by excluding `kickoff-real-spawn` (or any other
  PTY-spawning file) by name — a name-list would pass today and silently regress the instant a new
  PTY-spawning test is added, with nothing left to catch it.
- Do not assume a future node-pty upgrade has fixed the ConPTY kill race without re-testing against
  the minimal config recorded in project memory `nodepty-952-conpty-kill-race-reproducer`.
- Do not report an RSS number without stating its scope (runner-only vs. whole-tree) in the line
  itself — the whole point of this decision is that the two numbers differ materially and a reader
  must never be able to conflate them.

## Source

Inline comment in `packages/daemon/scripts/test-daemon.mjs`, at the `createRssTracker` definition's
scope note (originally ~lines 718-743). Card `f1043732`, filed 2026-08-01, merged as commit
`bd7b5b2`.
