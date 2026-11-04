# 060b9cb7 — `detached:true` without `windowsHide:true` pops visible consoles on Windows

## Narrative

The owner reported that, ~20-30 minutes into a real merge gate on the Windows host, about a dozen
terminal windows opened one after another. Investigation (static source reading plus a tightly-scoped,
immediately-killed repro of the suspect shape — never the real gate) found the mechanism: a
`child_process.spawn()` options object that sets `detached: true` with no `windowsHide: true` alongside
it unconditionally pops a brand-new, VISIBLE console window for the child on Windows — regardless of
whether the calling process tree already has one. This is NOT the behavior of an ordinary `spawn()`/
`fork()` call with no `detached` option at all (those just inherit whatever console the process tree
already has — no new window); `detached:true` is the specific trigger.

This fact was already independently, empirically verified by Loom's own prior work: the "SUPERVISOR"
comment block in `packages/daemon/assets/skills/orchestrate/scripts/dev-server.mjs` (added when that
file's capture-the-child's-stdout bug was fixed) states, verbatim, "a process created with
`detached:true` (Windows gives it its own new console)... Verified against a real spawn, repeatedly."
That investigation fixed the stdout-capture side effect (by inserting a supervisor hop) but never added
`windowsHide:true`, so the window-popping side effect was left live.

Three production, shipped skill-script spawn sites carried this exact shape — unconditional
`detached:true`, no `windowsHide` — and all three are exercised for REAL (actual `spawnSync` child
processes, not mocked) by ordinary hermetic test files that run automatically in
`pnpm --filter @loom/daemon test:daemon` (the merge gate's own command): `test/dev-server.mjs` (~10 real
spawns across 11 `[HELPER, "start", ...]` call sites), `test/dev-server-stop-tree.mjs` (2 real spawns),
and `test/serve-static.mjs` (1 real spawn, after excluding its own `doubleStart` refusal-path case). That
totals ~12-13 real `detached:true` spawns — most firing in sequence within `test/dev-server.mjs`'s own
top-to-bottom run of ~10 start/stop scenarios — matching "about a dozen... one after another" closely.

All of the genuinely PRODUCTION, merge-path-adjacent spawns that also set `detached` (`gate-runner.ts`'s
`runGateStep`, `git/worktrees.ts`'s two worktree-provisioning spawns, `restart.ts`'s `runBuildStep`)
already spread a CONDITIONAL value — `process.platform !== "win32"` (a variable or inline expression),
never the bare literal `true` — so `detached` resolves to `false` on win32 for all four, deliberately, for
unrelated POSIX process-group reasons. None of them are implicated and none needed a fix.

A separate, lower-confidence candidate (node-pty@1.1.0's `lib/windowsPtyAgent.js`, the non-DLL ConPTY
`kill()` branch's `_getConsoleProcessList()`, which calls `child_process.fork('conpty_console_list_agent',
[pid])` with zero options — no `windowsHide`) was considered and deliberately left UNVERIFIED and OUT OF
SCOPE: it is third-party code (`node_modules`, not Loom's own source, so no direct Loom fix applies
without a wrapper/monkeypatch), and since it's a plain `fork()` with no `detached` at all, the same
inheritance rule that lets ordinary spawns avoid popping windows plausibly applies to it too — consistent
with no prior owner reports of windows popping on ordinary interactive session stops. Live verification
(diffing `conhost.exe`/`OpenConsole.exe` process lists around a real kill) was attempted but blocked by
the host's own safety classifier before it could confirm either way.

## Fix

- `packages/daemon/assets/skills/orchestrate/scripts/dev-server.mjs` (line ~397): added `windowsHide:
  true` beside the existing `detached: true` in the supervisor spawn's options object.
- `packages/daemon/assets/skills/orchestrate/scripts/serve-static.mjs` (line ~201) and its byte-identical
  twin `packages/daemon/assets/skills/web-design/scripts/serve-static.mjs` (enforced equal by
  `test/serve-static-parity-guard.mjs`): same one-line addition, kept identical across both copies.
- `windowsHide:true` changes nothing else about these spawns — not the command, args, cwd, stdio, or
  process-group membership — and is a documented no-op on POSIX. Purely additive.
- Regression guard: `packages/daemon/test/windows-detached-console-guard.mjs` — scans
  `packages/daemon/assets/**/*.mjs` and `packages/daemon/src/**/*.ts` for a literal `detached: true` with
  no `windowsHide: true` in the SAME brace-balanced options object. Two reasoned exceptions (see its own
  `ALLOWLIST`, whole-file):
  - `assets/scripts/ensure-obsidian.mjs` — launches Obsidian, a real GUI app, detached so it outlives the
    short preflight; `windowsHide:true` risks hiding Obsidian's OWN window too, not just a console, so it
    is not safe-by-default here.
  - `src/index.ts` — the packaged-only `loom update` self-update spawn (`beginSelfUpdate`), gated behind
    `isPackagedInstall()`; never reached by a from-source dev daemon, so never reached by this merge gate.

## Do not

- Do not add `windowsHide:true` to `assets/scripts/ensure-obsidian.mjs`'s detached spawn or to
  `src/index.ts`'s self-update spawn without re-deriving the reasoning above first — the first risks
  silently hiding a real GUI app's own window; the second is simply out of this card's scope (not reached
  by the gate), not a safety concern, but was deliberately left alone rather than opportunistically fixed.
- Do not assume this guard also covers `packages/daemon/test/**` — it deliberately does not. Three
  test-fixture sites share this exact shape (`test/fixtures/_late-close-parent.mjs`,
  `test/fixtures/_child-ebusy-exhausted.mjs`, `test/dev-server-teardown.mjs`'s own `ROOT_SCRIPT` string)
  and were explicitly out of scope for this card (production/shipped code only) — they are UNFIXED and
  UNGUARDED; a future card widening scope to test fixtures should say so explicitly rather than assuming
  this guard already reaches them.
- Do not treat the node-pty `conpty_console_list_agent` fork candidate as confirmed OR ruled out — it is
  genuinely unverified. Re-derive before acting on it either way; see the Residuals note below.
- Do not re-derive "which spawn sites are implicated" via a bare `grep -l detached` sweep without also
  checking whether the matched `detached` value is a literal `true` or a conditional expression — the
  distinction is exactly what separates the three fixed/allowlisted sites from the four untouched,
  deliberately-POSIX-only production sites.

## Residuals (accepted)

- The node-pty `conpty_console_list_agent.js` fork (third-party, `node_modules/node-pty`) is a real,
  unverified candidate for the SAME bug class, reachable on every claude/codex session `kill()` on win32
  (not just during the gate) under Loom's own production default (`LOOM_PTY_USE_CONPTY_DLL` off). Left
  unfixed because (a) it could not be live-verified safely in this investigation, and (b) any fix would
  require a Loom-side wrapper/monkeypatch of vendored library internals, not a direct edit — a larger,
  separate decision than this card's scope.
- The three test-fixture `detached:true` sites named above are a real, smaller, confirmed-by-source
  contributor to the same symptom, left unfixed because the approving manager scoped this card to
  production/shipped code only.
- The guard's own population sanity check (`assetFiles.length > 50 && srcFiles.length > 50`) is a coarse
  "did the walk even run" floor, not a precise expected count — it will not catch a walk that silently
  skips one subtree while still finding plenty of files elsewhere.

## Source

Card `060b9cb7` ("fix(daemon): stop the merge gate popping visible console windows"). Test:
`packages/daemon/test/windows-detached-console-guard.mjs`. Verified-against: `test/dev-server.mjs`,
`test/dev-server-stop-tree.mjs`, `test/serve-static.mjs`, `test/serve-static-parity-guard.mjs`.
