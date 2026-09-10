# d67725c1 — the discovered-test count is self-reporting; a test-shaped file in an excluded dir needs a declared marker

## Narrative

Incident: a manager hand-derived the discovered daemon test count via `git ls-tree … | grep -c
'^packages/daemon/test/.*\.mjs$'`, getting 668. That count includes `test/fixtures/` and
`test/census/`, which `scripts/test-daemon.mjs`'s discovery walk (`EXCLUDED_DIR_NAMES`) never even
descends into — corrected to 646. That correction was *also* wrong: the walk additionally excludes
any path segment with a leading `_` (card `e7bcb0df`) — 18 more files — landing the best
hand-derivation at ~628, and even that wasn't certifiable, since a `looksLikeTest` marker-presence
filter also applies on top. The bite: card `f106f28e` added a file under the excluded `census/`
dir, and the naive count moved 667→668 while the discovered suite did not change at all — a phantom
new measurement cell for an identical suite, invented purely by an instrument artifact, silently
destroying the sample `n` a gate-sampling rule depended on. It reproduced consistently across seats
for days before being caught by an unrelated question about discovery, never by doubting the number.

**Fix, part 1 — self-reporting, not re-derivable.** `HERMETIC.length` (the discovered set built by
`discoverHermeticTests`) is the one authoritative number; it is already what the real run prints
("N/M hermetic daemon test files passed"), and the script also supports a discovery-only `--count`
flag so a manager can read it without running the full suite. Hand-deriving this number from
`git ls-tree`/`grep -c`, or any other tracked-file count, is unsupported and will drift — both
exclusion layers above are structurally invisible to a naive tracked-file count.

**Fix, part 2 — a test-shaped file placed inside an `EXCLUDED_DIR_NAMES` subtree is, by
construction, invisible to `walkMjsFiles`/`discoverHermeticTests`/the discovery-vs-git-ls-files
cross-check: it runs never, and silently — nothing tells its author so.** This is false coverage,
worse than a miscount. It is not hypothetical: `test/census/lib-guards.test.mjs` (card `f106f28e`)
is a real, deliberately-manual, out-of-band test that lives inside the excluded `census/` dir on
purpose — a blanket "refuse any test-shaped file outside the flat discovery convention" would
refuse every run. The chosen fix is a declared, checked opt-out rather than either a silent
tolerance or a blanket refusal: a marker comment inside the file itself, matched against
`/loom:(gate-exempt|not-a-test):[ \t]*(.*)/`, with **two markers that are never conflated** because
they mean different things to a reader of the discovery echo:

- `loom:gate-exempt: <reason>` — a real test, deliberately run manually / out of band (e.g.
  `lib-guards.test.mjs`).
- `loom:not-a-test: <reason>` — not a test at all; it only trips the `looksLikeTest` heuristic (a
  shared lib that throws for input validation, a CLI stub, a child-process fixture that calls
  `process.exit(1)` to simulate an outcome). Folding this into `gate-exempt` would misrepresent it
  in the echoed count as a manual test that exists, when no such test exists at all.

A bare "this is deliberate" marker with no reason is treated as **absent** (still a violation),
never silently accepted — the same posture this project takes toward any unchecked safety claim.

## Do not

- Do not hand-derive the discovered/hermetic test count from `git ls-tree`, `grep -c`, or any other
  tracked-file count — read `HERMETIC.length` (or run with `--count`) instead.
- Do not fold `loom:not-a-test` and `loom:gate-exempt` into a single marker — they report different
  facts (a real manual test exists vs. no test exists at all) to a reader of the discovery echo.
- Do not accept an empty or missing reason on either marker as a valid declaration.

## Source

Inline comments in `packages/daemon/scripts/test-daemon.mjs` (originally ~lines 390-401 and
~486-502, pre-existing lines mistakenly cited card `fa52f555` — verified via `git blame` +
`tasks_get` to actually belong to this card; `fa52f555`'s real, unrelated subject is the per-lane
port safety-scope comment elsewhere in the same file). Card `d67725c1`, filed 2026-07-31, merged as
commit `e09e460`.
