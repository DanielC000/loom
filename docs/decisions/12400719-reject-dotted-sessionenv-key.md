# 12400719 — reject a dot-bearing `sessionEnv` key name at the config write validator

## Narrative

`4ad33446`'s DoD-0 measured the live `~/.loom/loom.db` (43 projects, 5 with non-empty `sessionEnv`, all
plain keys, zero dotted) and left the server-side half open: nothing stops a future write from storing a
`sessionEnv` key containing a literal `.`. Re-measured for this card (2026-09-18, same method): identical
result — 43 projects, 5 non-empty, 0 dotted. Positive-controlled: the scan surfaced the same 5 real
entries by name/key, so the zero is a real absence, not a broken query.

The reason a dotted key matters: `sessionEnv` is the only record-shaped `projectConfigOverrideSchema`
field addressed element-wise by the config PATCH's `unset` grammar — a flat dot-path
(`unsetConfigPath`/`findConfigPatchUnsetCollisions`, `mcp/platform.ts`), e.g. `sessionEnv.<key>`, using
"." exclusively as the path separator. A key that itself contains "." can never be spelled as a single
path segment in that grammar, so once stored it can never be individually removed by any consumer (human
REST, the platform `project_configure` tool, or setup) — a permanent dead end, matching the same class of
defect `32b23f0f` fixed on the client side (a name `unset` cannot address).

Checked the premise from the card's own DoD-1 before picking a fix: does a dot-bearing env var name even
reach the spawned child process, or is storing one already inert? Traced the merge path
(`buildSpawnEnv`/`Object.assign(env, sessionEnv)` in `pty/host.ts`) and confirmed empirically with a real
`child_process.spawn` on Windows — a key named `"FOO.BAR"` in the `env` object passed to `CreateProcess`
DOES survive and is readable as `process.env["FOO.BAR"]` in the child. So this is NOT a moot, cost-free
rejection of an already-broken capability; it forecloses something that technically works. The mitigating
fact: POSIX environment-variable naming excludes ".", and POSIX shells cannot reference such a name via
ordinary `$NAME` syntax — so a dotted OS env var name has no realistic legitimate consumer even though the
OS/spawn layer itself is permissive about it.

## Fix

Chose **(a)**, reject at the validator, over **(b)**, make `unset` able to address a dotted key (e.g. via
an escape or an array-of-key-segments form): (b) touches the config PATCH's dot-path grammar and overlaps
card `b5faa194`'s open territory — the card explicitly says not to race it. (a) is the narrow, currently
zero-migration-cost option (see the re-measured 0/43 above) and is reversible: nothing is lost today, and
(b) can still land later under `b5faa194` to relax this if a genuine need for a dotted name ever surfaces.

Added a dedicated `rejectDottedKey` preprocess (`mcp/platform.ts`), layered around `sessionEnv`'s existing
`strictRecord(z.string())` rather than folded into `strictRecord`/`rejectDunderProtoKey` themselves —
those exist for any future record-shaped field, where a dot in a key may be perfectly legitimate; this
check is specific to `sessionEnv`'s own unset-addressability contract. The rejection message names the
offending key and states the reason (`sessionEnv key "<k>" contains "." — a dotted name can never be
removed via the config unset dot-path syntax; rename it without a "." (e.g. use "_")`) rather than
surfacing a bare zod path/type error.

## Do not

- Do not fold the dot check into `strictRecord`/`rejectDunderProtoKey` — that helper is reused (per
  `@decision c9a2f1e0`) for any future record-shaped config/credential field, where "." may be legitimate;
  only `sessionEnv` has the unset dot-path addressability constraint that makes "." specifically unsafe.
- Do not treat "a dotted env var name can't survive to the child process anyway" as true — it does,
  verified directly against this project's real spawn path on Windows. The rejection is a deliberate
  capability foreclosure justified by zero real usage + zero legitimate downstream consumer, not a
  no-op/fail-fast simplification.
- Do not re-derive "0 dotted keys" from memory at a later date — re-run the scan; DoD-0 explicitly frames
  this as a snapshot that can go stale the moment any project stores one.

## Source

Card `12400719`, opened by lead `gen 346` off card `4ad33446`'s DoD-0 answer, 2026-09-18.
