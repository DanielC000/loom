# 0ee30648 — a runtime assert catches a test that imports `dist/` before setting LOOM_HOME/LOOM_PORT

## Narrative

`paths.ts` reads `LOOM_HOME` (`process.env.LOOM_HOME || ~/.loom`) and `PORT`
(`Number(process.env.LOOM_PORT || 4317)`) ONCE, as module-scope consts, at first import. Neither
`requireHermeticEnv({port:true})` (test/_guard.mjs) nor `useOwnLoomHome()` (test/_tmp-fixture.mjs) checked
the ORDERING relative to a prior `dist/paths.js` import — "set LOOM_HOME before importing dist" was only a
header-comment convention. A test that imports dist first and sets the env after silently ran against the
REAL `~/.loom` and port 4317, with every `LOOM_HOME`/`PORT`-derived const (`DB_PATH`, `WORKTREES_DIR`,
`SETTINGS_DIR`, the SessionStart hook command baked by `claude-settings.ts`, `pty/host.ts`'s
`buildMcpServers({port: PORT, …})`) frozen at the stale value for the rest of the process.

The fix: `paths.ts` stashes `globalThis.__LOOM_PATHS_IMPORT_SNAPSHOT__ = { loomHome: LOOM_HOME, port: PORT }`
at first load — zero-cost, inert in production (nothing outside a test file ever reads this key). The two
test-only hermeticity checks then compare the LIVE env against that snapshot.

The rule is deliberately narrower than "frozen equals current" or "current is an ancestor of frozen":
it FAILS only when the snapshot shows the REAL default (`~/.loom` / port `4317`) while the env has SINCE
been re-pointed to something else. A file whose env was already correctly preset before dist was ever
imported (the `scripts/test-daemon.mjs` harness convention) snapshots a non-default value and never trips,
regardless of what it does afterward. A `useOwnLoomHome(prefix, {fresh:true})` nested subdir (which nests a
fresh dir INSIDE an already-non-default ambient `LOOM_HOME`) is covered the same way — the snapshot was
never the real default to begin with. A file that performs NO env setup at all (silently defaulting to the
real home the whole run) is OUT OF SCOPE for this specific assert: there is no re-point for it to detect,
since "current" stays unset/default the entire time — that is a known, separate, harness-reliant population
(safe under the harness's own env-presetting spawn, exposed only on a bare `node test/x.mjs` run), not a
textual ordering violation this mechanism was built to catch.

## Do not

- Do not widen the comparison to strict equality or "current is an ancestor of frozen" — both false-positive
  on the harness-preset and `{fresh:true}` cases documented above; the comparison must stay keyed on
  "the frozen value IS the real, unoverridden default."
- Do not read `globalThis.__LOOM_PATHS_IMPORT_SNAPSHOT__` from any production code path — it exists solely
  for the two test-only checks named above.
- Do not expect this assert to catch a file with no env setup at all — that is a different, already-known
  population (harness-reliant, not a reorder bug); see the Narrative above.

## Source

Card `0ee30648` ("test(daemon): guard that tests set LOOM_HOME and LOOM_PORT before importing dist"),
discovered by `6ade208f`'s worker (2026-10-28). Design approved by the Loom lead (gen 454, 2026-10-28) as
the card's own "LEAD RULING" triage note. Implemented in `packages/daemon/src/paths.ts` (the snapshot
stash, immediately after the `PORT` const), `packages/daemon/test/_tmp-fixture.mjs` (the shared violation
predicates + `useOwnLoomHome`'s throw), and `packages/daemon/test/_guard.mjs` (`requireHermeticEnv`'s
`problems` entries).
