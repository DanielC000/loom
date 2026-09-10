# b122c7d4 — test discovery becomes an explicit allowlist; a non-test file must refuse loudly, never pass silently

## Narrative

Filed at a merge gate, then substantially corrected the same hour: the original proposal was to "invert the guard — skip only if positively identified as an import, run otherwise, so the worst case is a redundant run: loud, obvious, cheap." That claim — that running something unexpected is LOUD — is FALSE, measured directly against `node:test`:

```
$ npx tsx --test test/helpers/rmSyncBestEffort.ts        # a plain non-test helper module
ok 1 - test\helpers\rmSyncBestEffort.ts                  ← counted as a PASSING TEST
1..1   # tests 1   # pass 1   # fail 0   --- exit code: 0 ---
```

A file containing ZERO tests reports `# tests 1, # pass 1` — it inflates the count with a green entry indistinguishable from a real test. Inverting the default trades a false NEGATIVE (silent skip) for a false POSITIVE (silent pass inflation), and the false positive is better camouflaged, because it moves the number in the direction that looks healthier. `scripts/test-daemon.mjs` isn't `node:test` — it spawns each file as its own process and grades on exit code — but the mechanism differs while the conclusion is identical: a non-test `.mjs` that imports cleanly and exits 0 is recorded as a PASS. The trap transfers.

The surviving principle, with its missing clause: "fail toward duplicate, never toward loss" is still right — the error was in the *instantiation*, assuming "running something unexpected" is inherently observable. Companion clause: "…and verify that the direction you fail toward is actually OBSERVABLE." A fail-safe direction that produces a GREEN is not a fail-safe.

Before this card, discovery was inclusive-by-default: everything `.mjs` under `test/` that wasn't underscore-prefixed and wasn't denylisted got run and counted — a naming convention with no enforcement. The count itself was also not a trustworthy denominator once a non-test file counts as 1 pass: `executed > 0` is satisfiable by junk, `executed >= <committed minimum>` is satisfiable by junk (adding non-test files RAISES the number), and "every file we ran reported >= 1 test" also fails, since a non-test file satisfies it by being counted as 1. There is no count-based rescue — an earlier draft of this card proposed an absolute floor and that idea is retracted.

**The fix:** compare PATH SETS, never counts — a recursive walk collects every test-shaped file, then every discovered path must be in the executed set, by path, with any gap named. Membership is an EXPLICIT ALLOWLIST, not "everything not positively excluded" — the recursive/complete half of the original discovery idea survives; the inclusive-by-default membership half does not. The underscore convention is kept but now ENFORCED rather than trusted: a discovered file that looks like a helper (no assertion marker, no test registration) is a LOUD refusal, naming the file, never a silent pass.

**Defense 3 (the `isMain` main-module guard):** two defenses against a broken guard had already landed under a precursor card (`d39db2db`) — comparing `fs.realpathSync.native` resolved paths (never raw URL strings, since drive-letter case/8.3 short names/symlinks can all silently diverge on Windows) and a loud non-zero exit on a same-basename-but-different-path mismatch. This card adds a third: before it, if `realpathSync.native` THREW on either side, both `selfPath`/`argvPath` could end up `null`, `isMain` was false, and the mismatch branch — which needs both non-null — could never fire either, a silent skip with no output at all. Track whether each side THREW, separately from resolving to `null` for an ordinary reason (e.g. no `argv[1]`), and fail loudly on a real throw instead of folding it into "not main."

## Do not

- Do not revert discovery to an implicit "everything not positively excluded" — a non-test file that merely imports cleanly and exits 0 is graded a silent PASS by this harness's exit-code grading, and nothing else catches it.
- Do not rely on a count (`executed > 0`, a committed minimum, "every file reported >= 1 test") as evidence discovery is complete or correct — a junk file satisfies every one of these by being counted as 1.
- Do not fold a THROWN `realpathSync.native` resolution into "not main" — that silently suppresses the loud same-basename mismatch branch too, on either side of the `isMain` check.

## Source

Inline comments in `packages/daemon/scripts/test-daemon.mjs`: the discovery-allowlist paragraph (module header, originally lines 10-25) and the `isMain` guard's defense-3 paragraph (originally lines 1664-1668), as of this tranche's HEAD. Card `d39db2db` landed the two earlier `isMain` defenses this one sits beneath; see `packages/daemon/test/test-daemon-discovery.mjs` for the acceptance test.
