# 11737292 — discard a bare `FAIL <token>` line whose token isn't a real file, to close a mocked-verdict leak

## Narrative

Card 11737292 — a LIVE specimen (op `321a5e6b`'s `[loom:merge-rejected]` nudge) reported `failing: FAIL some_test.mjs` for a file that does not exist. Root cause: `gate-status.mjs`'s own tests inject a MOCK gate verdict (`outputTail: "FAIL  some_test.mjs"`) to exercise `sessions/service.ts`'s real `[gate opId=…] … passed=false …` diagnostic `console.log` — which dumps that mock's `outputTail` VERBATIM, unindented, as its own line. When `gate-status.mjs` itself later failed for an unrelated reason (an `exit timeout` in the specimen), `test-daemon.mjs`'s own `FAILURES:` epilogue re-echoed that captured line into the OUTER gate run's stream, where `createFailingTestTracker`'s `FAIL`/`not ok` tier matched it exactly like a real per-file marker.

A genuine per-file harness wrapper line always carries a trailing `(exit ` suffix (`HARNESS_FAIL_WRAPPER_RE`) and a `check()`-printed assertion line is always a multi-word prose label (see that helper's own convention, `gate-status.mjs`'s own `check` definition) — neither shape is a BARE single token. `FAIL  some_test.mjs` is: nothing follows the token, so this is the one shape that can never legitimately be either of those two real conventions. Cross-checking that token against the real filesystem (mirroring `identifyRetriableTestFile`'s own `fs.existsSync` gate, same fail-closed posture: a project without this daemon's own `packages/daemon/test/` layout skips the check entirely, same as that function's own no-op-elsewhere behavior) catches the exact specimen — `some_test.mjs` is a placeholder name that has never existed on disk — while leaving every genuine bare-name match (a real file, e.g. from a project that DOES use this convention) untouched.

## Do not

- Do not record a match against the FAIL/not-ok tier for a bare `FAIL <token>` line (nothing else on the line) whose token doesn't correspond to a real file under `packages/daemon/test/` — discard it silently, letting a genuine failure elsewhere still win.
- Do not extend this check beyond the exact bare-token shape — a line with any prose/extra content past the token is never this shape and must not be second-guessed.

## Source

JSDoc comment in `packages/daemon/src/orchestration/gate-runner.ts`, above `isUnverifiableBareFailToken`: originally lines 93-112, as of this tranche's HEAD. Relocated by card `b80a2d76` (tranche 1); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
