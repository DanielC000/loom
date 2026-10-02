# 2403d1bc — `gate-timing-margin-report.mjs` is a manual report, never a gating check

## Narrative

Card 2403d1bc's own sweep (14 `TEST_TIMEOUT_OVERRIDES` entries added by hand, plus one existing
entry raised) suggested a cheap follow-up: a check that flags any test file whose recorded max
duration in the gate-timing NDJSON exceeds 0.75x its effective per-file ceiling, so the next
near-ceiling drift doesn't need a full manual re-sweep to notice.

`gate-timing-margin-report.mjs` implements that check, but deliberately as a standalone script a
human/manager runs by hand — never wired into `pnpm --filter @loom/daemon guards`
(`STATIC_GUARD_REPO_PATHS`) or `CHANGED_SCRIPT_TEXT_SCANNER_REPO_PATHS`. Both of those run
unconditionally on every reduced/full gate, on whatever host runs it. The data this report reads —
`~/.loom/gate-timing/daemon-per-file-timing.ndjson` (LOOM_HOME-relative) — is host-local: a clean
CI runner, a fresh LOOM_HOME, or a different self-hosting machine has none of it. Wiring this report
into either gating list would make gate outcome depend on which machine happened to run it rather
than on the diff under review — the opposite of hermetic, and exactly the kind of non-hermetic gate
dependency this project's `CLAUDE.md` warns a worker-authored test must never introduce.

It resolves each file's effective ceiling via `test-daemon.mjs`'s own exported
`resolveEffectiveTimeoutMs` (never a second, hand-maintained copy of `TEST_TIMEOUT_OVERRIDES`), and
skips every `CODEX_REAL_SPAWN_SET` member — that family's ceiling is derived from the live gate cap,
not this static map, so a flag against it would compare the wrong baseline.

## Do not

- Do not add `gate-timing-margin-report.mjs` to `STATIC_GUARD_REPO_PATHS` or
  `CHANGED_SCRIPT_TEXT_SCANNER_REPO_PATHS` — the gate-timing NDJSON it reads is host-local data, and
  a gating check whose verdict depends on which machine ran it is non-hermetic by construction.
- Do not have it re-derive `TEST_TIMEOUT_OVERRIDES` or the gate-timing NDJSON path independently —
  it imports both via `test-daemon.mjs`'s own exports (`resolveEffectiveTimeoutMs`,
  `GATE_TIMING_NDJSON`), so the two can never silently drift apart.
- Do not flag a `CODEX_REAL_SPAWN_SET` member against this static-ceiling framing — that family's
  effective ceiling scales with the live gate cap, not a fixed number.

## Source

`packages/daemon/scripts/gate-timing-margin-report.mjs` (header comment), introduced by card
`2403d1bc`.
