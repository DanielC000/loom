# dd4349ff — A reduced gate's changed test files run THROUGH THE HARNESS, never as bare `node <path>`

## Narrative

`buildReducedGateCommand` builds the `&&`-chained reduced gate command for a diff `computeEmitCompareGate` proved eligible — `pnpm build` (unconditional, real typecheck+emit) + the static guards (unconditional, source-text scanners, run as bare `node <path>` — with NO env scrub, so they inherit this process's own ambient `LOOM_HOME`/`LOOM_PORT`, same as `scripts/run-static-guards.mjs`'s own bare spawns; card `49c50b80` corrects a prior version of this comment that claimed these guards "never touch `LOOM_HOME`/a port" — false: `test/_guard.mjs`'s `exit` hook reads `LOOM_HOME` in every one of them; safety against that now lives IN `_guard.mjs` itself, see `isTestCreatedHome` there, not in how these are invoked) + — only when a test file actually changed — ONE `pnpm --filter @loom/daemon test:daemon --only=<names>` step naming every changed file, so each runs THROUGH THE HARNESS (its own fresh temp `LOOM_HOME` + non-4317 `LOOM_PORT`, per `scripts/test-daemon.mjs`'s own header contract) instead of as a bare `node <path>` with neither.

Card `dd4349ff`: the prior bare invocation left any changed file that needed that env unable to even START (`test/_guard.mjs`'s `requireHermeticEnv` refuses at exit 99, 0s, no assertion ever run) — rejecting a release-critical merge for a defect in the INVOCATION, not the code under test.

Each `--only=` name is the harness's own bare test-daemon name for a changed file — its repo-relative path minus the `packages/daemon/test/` prefix and `.mjs` suffix, the exact shape `discoverHermeticTests` (`scripts/test-daemon.mjs`) keys `NOT_HERMETIC`/`TEST_TIMEOUT_OVERRIDES` on and returns as `hermetic`. `resolveSelection`'s own `--only=` validation REFUSES a name outside that discovered set rather than silently selecting nothing — so a path this function is handed that the harness doesn't actually discover as hermetic (excluded-dir, an underscore helper, a `looksLikeTest` violation) fails this reduced gate LOUDLY instead of quietly running zero tests. Never runs the ~668-test suite UNFILTERED — that omission is the entire saving this mechanism exists for; `--only=` is what lets a changed file's OWN behavior be exercised (not merely proven absent from `src/`) without paying for the rest of the suite.

## `NOT_HERMETIC` names must never reach `--only=` (card `17cd1f30`)

`changedTestFiles` here is expected to ALREADY exclude any `NOT_HERMETIC` name — `computeEmitCompareGate` does that filtering (see its `notHermeticExcluded` field) before this function ever sees the list, exactly so a `NOT_HERMETIC` name can never reach `--only=` and trip `resolveSelection`'s refusal above (the merge op `5113c720` specimen: 4 `NOT_HERMETIC` names landed in `--only=` unfiltered and the gate failed identically on every re-fire). This function does not re-filter — it trusts its caller, same as it always has for excluded-dir/underscore/shell-safety, which are also enforced by the caller before a path ever reaches `changedTestFiles`. The caller is responsible for declaring any excluded name by name in the merge result (`emitCompareWarning` in `sessions/service.ts`) — a silent drop would gate a branch while quietly verifying nothing for those files.

## Asset paths fold into the SAME `--only=` list (card `3fbd95e0`)

`changedAssetPaths`, when non-empty, folds every name in `ASSET_READING_TEST_REPO_PATHS` into the SAME `--only=` list (de-duplicated against `changedTestFiles`, same harness invocation, no second `test:daemon` step) — unconditionally, regardless of which specific asset path(s) changed, same "run the fixed certified set" posture the static guards already have. Defaults to `[]` so every pre-existing call site (none of which know about assets yet) stays byte-identical.

## Do not

- Do not invoke a changed test file as a bare `node <path>` — a file needing hermetic env (`test/_guard.mjs`'s `requireHermeticEnv`) refuses at exit 99, 0s, no assertion run, rejecting a release-critical merge for an invocation defect, not a real failure.
- Do not re-filter `NOT_HERMETIC` names inside this function — the caller (`computeEmitCompareGate`) must have already excluded them; this function trusts that filtering and does not duplicate it.
- Do not claim the static guards "never touch `LOOM_HOME`/a port" — `test/_guard.mjs`'s `exit` hook reads `LOOM_HOME` in every one of them; safety lives in `_guard.mjs`'s own `isTestCreatedHome`, not in the invocation shape.

## Consequences

A changed test file that needs the harness's fresh temp `LOOM_HOME`/non-default port now actually runs and is exercised, instead of refusing to even start — closing a real release-blocking defect where the reduced gate's own invocation shape, not the code under test, caused a rejection.

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, `buildReducedGateCommand`'s own doc comment (~line 3330), as of this worktree's HEAD before this extraction. Wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed.
