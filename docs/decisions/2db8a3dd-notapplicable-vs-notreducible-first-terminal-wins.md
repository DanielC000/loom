# 2db8a3dd — `notApplicable` vs. a real `notReducible` verdict, and the FIRST-TERMINAL-WINS ordering trap

## Narrative

`EmitCompareGateResult.notApplicable` (CORRECTED by card `4def0708`) distinguishes two different reasons `eligible` can be `false`. The operational-failure sites below were originally documented — wrongly — as informative `false`; that was the exact bug `4def0708` fixed. Produced by one of two explicitly-named constructors, never a defaulted boolean param.

`false` (via `notReducible`) on `eligible:true` (trivially — a proven-eligible diff was, by definition, evaluated against a repo this predicate applies to) and on every `eligible:false` reason that is a REAL, REPRODUCIBLE verdict about THIS diff's own content on a repo the predicate DOES cover (a non-modify status on a compiled file, an excluded-dir/underscore/shell-unsafe test path, "no eligible changed path left to prove inert", an unverified soundness precondition, or a transpile mismatch) — those are real, informative "ran, not reduced" verdicts.

`true` (via `notApplicableHere`) on every reason that is NOT a verdict about reducibility.

## CARD `4e6e1882`: read the catch-all as FIRST-TERMINAL-WINS, never as "any out-of-scope path ⇒ notApplicable"

The classification loop scans changed paths in git's own emitted order and returns on the FIRST path that produces a terminal outcome. A DIFFERENT terminal can fire first and win: `if (status !== "M") return notReducible(...)` on a compiled `.ts` path yields a real, informative `false` the moment an EARLIER changed path is a non-modify status on a compiled file, even when a LATER path in the very same diff is out of scope.

Two real merges make the two outcomes concrete: `fdf1291f` (daemon `src`+`test` paths alongside `shared/`/`web/`, whose only non-daemon path was an ADDED `.mjs` test — nothing to trip that terminal) read `null`; `2d8d2e42` (same mixed shape, but its added file was a `.ts` under `daemon/src`, tripping the non-modify-status terminal first) read `false`.

The catch-all — "path outside emit-compare scope" — is reached by TWO distinct diff shapes: (1) a repo whose sources aren't under `packages/daemon/src|test/` at all, hitting it on its FIRST path always; and (2) a Loom-shaped diff that ALSO touches a path outside this predicate's domain (e.g. `packages/shared/**`) — equally `notApplicable`, but only if nothing EARLIER already tripped a different terminal. An out-of-scope path that is ALSO inert (e.g. under `docs/`) never reaches this catch-all: `isInertMergePath`'s skip removes it via `continue`, not a terminal return.

## OPERATIONAL NOTE (card `4e6e1882` DoD-5, updated by card `82662e98`): this decline is ORDINARY, not an edge case

`INERT_MERGE_PATH_PREFIXES`/`INERT_MERGE_EXACT_PATHS` name only `docs/` and five root filenames as inert — those are SKIPPED before ever reaching this catch-all. Every OTHER root-level path — most notably `CLAUDE.md` (deliberately excluded), plus `package.json`, `bin/**`, … — still sorts before `packages/` and, being non-inert, still reaches the catch-all on the SAME diff where daemon source is also touched, before any daemon-src terminal fires. Editing `CLAUDE.md` alongside daemon source (routine here) still declines to `null` regardless of the daemon change.

⚠️ FRAGILE: inside `packages/`, an in-scope daemon path is only visited before `packages/shared/**`/`packages/web/**` because the string `daemon` happens to sort first — an alphabetical accident, not a design property. Adding a `packages/api/`, `packages/cli/`, or `packages/core/` directory would silently flip today's `false` (`2d8d2e42` above) to `null` on the same diff shape, with no code change and nothing to notice it.

## The other `notApplicableHere` reasons

A failed load of `scripts/test-daemon.mjs`'s name sets (doesn't exist outside Loom's layout), an unresolvable `typescript` module (absent on a shipped end-user install), AND — corrected by card `4def0708` — any OPERATIONAL/mechanism failure (a git error, an empty diff, an unparseable line): a git error proves nothing about reducibility, so it must never be stamped a decided "not reduced".

⭐ THE SIGNAL COMES FROM THE PREDICATE, NOT RE-DERIVED BY A CALLER: `computeEmitCompareGate` already knows which reason it returned; the caller must never re-sniff repo layout to guess this, and must treat `notApplicable:true` like "the predicate never ran" — never report a fabricated `false`.

## Do not

- Do not treat any out-of-scope path as automatically producing `notApplicable` — the loop is first-terminal-wins; an earlier real verdict wins over a later out-of-scope path in the SAME diff.
- Do not stamp an operational/mechanism failure as an informative `notReducible` `false` — that was the exact bug card `4def0708` fixed; it must be `notApplicable:true`.
- Do not treat `CLAUDE.md`-plus-daemon-source as an edge case — it's the ordinary shape here, and always declines to `null`.
- Do not assume a Loom-shaped diff mixing `packages/daemon/**` with `packages/shared/**`/`packages/web/**` reads consistently — the sort accident means a new top-level `packages/` directory can silently flip an existing diff's verdict.
- Do not have a caller re-derive this field's information from repo layout — the predicate already knows.

## Consequences

A caller can distinguish "doesn't apply here" from "applies, found nothing to reduce" — closing a real bug (`4def0708`) — at the cost of a first-terminal-wins ordering fragile to the alphabetical accident above.

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, `EmitCompareGateResult.notApplicable`'s own doc comment (~line 2892), as of this worktree's HEAD before this extraction. Wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed.
