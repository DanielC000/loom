# 404bfc75 — the ancestor-path behavioural check, its cap, and its measured cost

## Narrative

`builtContentMatchesHead` used to run ONLY when `processBuiltSha` was NOT an ancestor of
`mainlineHeadSha`. The doc claimed the ordinary ANCESTOR case never needed a content check — false for a
comment-only commit: `commitsBehind` is a path-scoped BYTE/DATE heuristic, so it counts a comment-only
commit exactly like a behavioural one. Real specimen: main `ce34994b` ("anchor five orphan decision
records") is three hunks, all comment-only (`@decision` anchors added to doc comments), and reported
`stale:true` forever until a restart. The extraction program that produced it adds such anchors as its
whole output shape — a self-renewing false alarm, not a one-off.

Fix: sub-case (b) of `builtContentMatchesHead` — `processBuiltSha` IS an ancestor AND `stale` already
`true` — runs `computeAncestorBehaviouralMatch`, diffing the two shas over `RESTART_RELEVANT_PATHSPECS`
then proving every changed `.ts` file transpile-identical (comments/whitespace stripped), the same
technique `computeEmitCompareGate` (`git/worktrees.ts`) uses for the merge gate. ⚠️ SUPERSEDED (card
`bafc68e7`): this originally duplicated (not imported) that technique's predicate/walker/transpile-helper
locally, on an async-vs-sync justification re-examined and found not decisive — see
`docs/decisions/bafc68e7-emit-compare-soundness-shared-scope.md` for why and what replaced it (one shared
`emit-compare-soundness.ts` module, parameterized by scope; this module's own scope — daemon+shared —
unchanged). `builtContentMatchesHead:true` overrides `stale` to `false` from EITHER sub-case, since (a)'s
diff scope (`CONTENT_CHECK_PATHSPECS`) is a strict superset of (b)'s (`RESTART_RELEVANT_PATHSPECS`) — an
empty superset diff already proves an empty subset diff. Anything else leaves `stale` untouched — only
ever more lenient, never less, and only on a PROVEN-inert diff.

## Verified against the REAL specimen

`computeDeployStaleness()` against a local clone checked out exactly at `ce34994b`, dist mtime between
`ba45b807` (its parent) and `ce34994b`'s own date, `processBuiltSha: ba45b807...`: `commitsBehind:1`,
`stale:false` (was `true`), `builtContentMatchesHead:true`. Fixture coverage
(`test/deploy-staleness.mjs`, 23e-23n): a real behavioural commit still reports `stale:true` (23f); a
commit mixing a comment-only file AND a real change still reports `stale:true` (23g); the already-clean
ancestor case is unperturbed (23h); the soundness precondition fails closed on absence (23i) AND on two
REAL hazards — `emitDecoratorMetadata` on the package tsconfig (23k), a live `const enum` elsewhere in the
tree (23l); sub-case (a) also overrides `stale` (23j); the file-count cap is exercised at/beyond boundary
(23m/23n).

## Cap and cost — CORRECTED (Code Review item 8)

Cost scales with N (changed `.ts` files: 1 `diff` + 2 `git show` each), unlike this module's other
fixed-multiple-of-`GIT_TIMEOUT_MS` costs. `MAX_ANCESTOR_BEHAVIOURAL_CHECK_FILES` (25) caps it; beyond it,
fails closed to `null` (stale:true).

⚠️ An earlier version compared a MEASURED average against the module's documented WORST-CASE ceiling —
different quantities. Corrected, like-for-like (2026-09-12, real local clones, `performance.now`):

- **Avg vs avg**: baseline `computeDeployStaleness()` (unchanged by this card) ~322ms/call. With the real
  3-file `ce34994b` diff firing sub-case (b): ~997ms/call (+~675ms: ~130ms soundness file-walk + ~160ms
  for 6 `git show` calls + the remainder in `typescript` load/`transpileModule`).
- **Worst-typical vs worst-typical**: AT the 25-file cap, all comment-only (a real fixture): ~1.6-2.0s/call
  measured — under this module's pre-existing `6×GIT_TIMEOUT_MS`=6000ms hung-call ceiling (`5e30c4bd`).
- **Worst-pathological vs worst-pathological**: if EVERY one of the up-to-51 git calls at the cap (1 diff +
  2×25 `show`) independently hung its full `GIT_TIMEOUT_MS`, this check alone could reach `51×GIT_TIMEOUT_MS`
  ≈ 51s — ON TOP of the module's existing 6s ceiling. Real and larger than the pre-existing bound, named
  plainly rather than minimized; needs git hanging on nearly every spawn, not a partial failure, and each
  call is independently timeout-bounded so it cannot exceed this stated ceiling.

Only fires when `stale` would otherwise already be `true` (23h unaffected). No caching: DoD #4 forbids
persisting staleness-adjacent state, and the soundness check (~130ms) is too small a share of ~675ms to
matter. Recurs every manager spawn/resume/recycle until a human restarts — real, repeated cost during
exactly the "self-renewing false alarm" window. Future cheaper option: scope the soundness check to only
the diff's own changed files, not the whole src tree.

## Do not

- Do not restore the claim that the ancestor case never needs a content check.
- Do not remove or unbound `MAX_ANCESTOR_BEHAVIOURAL_CHECK_FILES` — per-file cost is real (measured above).
- Do not cache `computeAncestorBehaviouralMatch`'s verdict or the soundness check across calls —
  `5e30c4bd`'s DoD #4 is "derive fresh, never persist"; fix perf via a cheaper INPUT, never a cached OUTPUT.
- Do not let the shared `walkTsFiles` (`emit-compare-soundness.ts`, since `bafc68e7` — was this module's own
  `walkTsFilesForSoundnessCheck`) swallow a `readdirSync` failure and return a partial list — a partial scan
  can miss a real `const enum` and let the check read `true` off incomplete evidence (Code Review B1); it
  must propagate.

## Source

Inline `@decision 404bfc75` anchors in `packages/daemon/src/deploy-staleness.ts` (module doc, and above
`MAX_ANCESTOR_BEHAVIOURAL_CHECK_FILES`), alongside `computeAncestorBehaviouralMatch`, its helpers, and the
corrected `builtContentMatchesHead`/`stale` field docs.
