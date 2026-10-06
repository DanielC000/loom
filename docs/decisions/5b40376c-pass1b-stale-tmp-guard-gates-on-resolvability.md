# 5b40376c — PASS 1b's stale-tmp-residue short-circuit also gates on `matchedRepo` being resolvable

From the 883e29bc worker's own "separate, adjacent finding" (`docs/decisions/883e29bc-pass1-degraded-arm-never-unions-a-verified-sibling.md`, "A separate, adjacent finding" section) — PRE-EXISTING, fail-OPEN data loss in `reenterMergeQuarantinesAtBoot` PASS 1b (`packages/daemon/src/git/merge-quarantine.ts`).

## The bug

PASS 1b's tmp-residue loop opens with an early short-circuit (~line 1486 at commit `1415de6a`):

```js
if (matchedRepo && cleanlyParsedKeys.has(canonicalRepoLockKey(matchedRepo))) {
  try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
  continue;
}
```

`cleanlyParsedKeys` is built during PASS 1 (keyed by each cleanly-parsed, non-placeholder `.json` final's
own `canonicalRepoLockKey(entry.repoPath)`), and the guard's stated intent is "a proper final for THIS
repo already loaded cleanly — this tmp really is stale residue, delete it immediately."

That intent only holds when `canonicalRepoLockKey(matchedRepo)` actually returns `matchedRepo`'s OWN true
key. When `matchedRepo` (`X`) is itself currently unresolvable, `canonicalRepoLockKey` degrades and walks
up to the nearest resolvable ancestor — landing on an ENCLOSING repo `R`'s own real key, not `X`'s own.
If any wholly unrelated, genuinely separate repo `T` (e.g. a plain subdir of `R`, collapsing onto `R`'s
own key the ordinary way) happened to parse cleanly at that same key during PASS 1, the guard's lookup
returns true purely by coincidence — and `X`'s own tmp is unlinked outright, before its own JSON is ever
parsed, before its own recorded `resolvedKey` is ever consulted, and before the dual-arm/degraded-divert
logic just below (883e29bc's own fix) ever gets a chance to run.

This is not merely a fail-closed wrong-attribution (the class 883e29bc's own fix guards against) — it is
fail-OPEN DATA LOSS: `X`'s only durable copy is deleted, with no diverted pending entry ever created to
recover it, not even across a restart (the tmp file is simply gone).

Reproduced hermetically (own process, own `LOOM_HOME`): `X = R/nested` (own `.git`, own real key `Kx`),
unresolvable at boot, with its only latch a `.json.tmp-<pid>-<hex>` torn-write residue recording
`resolvedKey: Kx`. `T = R/teamA` (plain subdir of `R`, no `.git` of its own) has a genuine, separate,
resolvable `.json` final. Calling `reenterMergeQuarantinesAtBoot([repo, nested, subdir])` with `nested`
(`X`) INCLUDED in `registeredRepoPaths` — the exact shape the existing `pass1b` scenario in
`test/merge-quarantine-pass1-degraded-union-guard.mjs` deliberately omits to dodge this bug — deletes `X`'s
tmp outright. Confirmed durable via a restart-sim (fresh, cache-busted module re-import, same process,
`X` still parked): `X`'s evidence stays permanently gone.

## The fix

Gate the early-unlink short-circuit on `matchedRepo` being CURRENTLY resolvable too, mirroring every other
gate in this function (`isRepoPathCurrentlyResolvable` already gates the no-resolvedKey branch, the
degraded-divert branch, and the tmp-promotion write pass):

```js
if (matchedRepo && isRepoPathCurrentlyResolvable(matchedRepo) && cleanlyParsedKeys.has(canonicalRepoLockKey(matchedRepo))) {
```

When `matchedRepo` is resolvable, `canonicalRepoLockKey(matchedRepo)` returns its own true key, so
checking `cleanlyParsedKeys` genuinely answers the guard's own intent, exactly as before (no behavior
change for the ordinary case — verified by a dedicated negative-control scenario, below). When
unresolvable, the short-circuit's premise doesn't hold at all (the key stands in for some ancestor, never
for `X`'s own identity) — skip it and let the tmp fall through to the ordinary parse-and-arm path, which
already correctly diverts it via its own `resolvedKey` into `pendingUnresolvedQuarantines` (883e29bc's own
fix, reached one block down). No other change was needed.

## Interaction with `4480b077`

None, structurally. This short-circuit is a pre-existing, IMMEDIATE (non-deferred) check that runs per-tmp-
file at the top of PASS 1b's loop, entirely before `4480b077`'s write-pass collection
(`migratedSourcesByKey`/`degradedOccupiedKeys`/`writeTargetsThisPass`) is ever consulted for that file.
`cleanlyParsedKeys` is fully built by PASS 1 and untouched by `4480b077`'s restructuring of the WRITE
passes. The fix only adds a resolvability check on `matchedRepo` (static per-file information) — it
doesn't change when or whether any write happens, doesn't touch `degradedOccupiedKeys`, and doesn't
reorder anything relative to `4480b077`'s deferred write/delete passes (which all run later, after both
read loops finish).

## Verification

`test/merge-quarantine-pass1-degraded-union-guard.mjs`, three new scenarios (each its own child process,
own fresh `LOOM_HOME`):

- `pass1b-included` — the core repro/fix, with `nested` (`X`) INCLUDED in `registeredRepoPaths`: asserts
  `X`'s tmp residue is never unlinked, `X` is never promoted/written to its own final (stays pending-only),
  `T`'s quarantine is correctly reported with no cross-contamination, and — across a restart-sim —
  `T`'s own final file is BYTE-IDENTICAL to its first-boot content (proving the fix doesn't feed a write
  into `T`'s own key, the open `97cff6db` class).
- `pass1b-included-convergence` — after two boots with `X` parked, `X` is remounted (genuinely resolvable)
  before a third boot: `X`'s tmp residue is cleaned up (promoted to a proper final under its own true key,
  then unlinked) rather than accumulating, `R`'s own key reads only via `T` once `X` resolves to its own
  key, and `T`'s final file stays byte-identical throughout.
- `pass1b-resolvable-stale-tmp-still-deleted` — negative control: a genuinely resolvable repo with its own
  clean final AND a genuinely stale tmp residue (an ordinary interrupted-write leftover, no sibling
  collision involved) still has that tmp deleted immediately, unaffected by the new resolvability gate.

All three proven RED against the pre-fix code and GREEN after, via
`pnpm --filter @loom/daemon negative-control --file packages/daemon/src/git/merge-quarantine.ts --test
packages/daemon/test/merge-quarantine-pass1-degraded-union-guard.mjs` (tree restored byte-identical). The
pre-existing `pass1b` scenario's own header was updated to note the omission it describes is no longer
load-bearing for correctness (this card fixed the adjacent guard it dodges) but is kept anyway, to
continue isolating its own targeted shape from this one. Every other `merge-quarantine*.mjs` file (19
total) and `pnpm --filter @loom/daemon guards` (27/27) re-run clean — no regressions, in particular
`test/merge-quarantine-pass1b-clean-parse-gate.mjs`, the dedicated test for this same gate's pre-existing
behavior.

## Do not

- Do not recompute `canonicalRepoLockKey(matchedRepo)` and trust a `cleanlyParsedKeys` hit as "a clean
  final exists for THIS repo" without first confirming `matchedRepo` is currently resolvable — an
  unresolvable repo's degraded, walked-up key can coincidentally match a wholly unrelated sibling's own
  genuine key, and treating that coincidence as identity destroys the unresolvable repo's only durable
  evidence outright (not merely a wrong attribution — an unrecoverable delete, with no diverted pending
  entry left behind).
- Do not assume gating the dual-arm/degraded-divert branches (883e29bc) is sufficient on its own — this
  short-circuit runs BEFORE that logic is ever reached, on a different (and cheaper, less obviously
  related) condition; a fix to one does not reach the other.
- Do not read the existing `pass1b` scenario's `nested`-omission as still load-bearing for correctness
  after this card — it was ONLY ever a workaround for this exact bug. It stays in the suite deliberately,
  for isolating that scenario's own targeted shape from this one, not because including `nested` would
  fail again.

Tests: `test/merge-quarantine-pass1-degraded-union-guard.mjs` (scenarios `pass1b-included`,
`pass1b-included-convergence`, `pass1b-resolvable-stale-tmp-still-deleted`).
