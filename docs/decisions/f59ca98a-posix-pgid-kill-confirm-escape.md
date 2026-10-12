# f59ca98a — a POSIX "escaped descendant" kill-confirm hook must `setsid`; the PPID-walk escape win32 gets for free doesn't carry over

## Narrative

`git-writer-kill-confirm.mjs` sections [2]-[4], `merge-commit-kill-confirm.mjs` scenario 5, and
`union-merge-kill-confirm.mjs` green-2 each install a "double-forked" pre-commit/pre-merge-commit hook
(`( (sleep X; ...) & )`) meant to simulate a descendant that escapes a tree-kill, so the test can drive
the UNCONFIRMED-kill / quarantine path. On win32, `killGateProcessTree` kills via `taskkill /pid <pid> /T
/F` — a PPID-walk — and the nested-subshell trick breaks the PPID chain (the intermediate subshell exits
immediately, orphaning the inner one to init) before the walk ever happens, so the escaped descendant
survives and the kill comes back genuinely unconfirmed. This was the originally-measured, real escape
(see `24c0bdba`'s decision record, round 3, Code Review B-2).

On POSIX, `killGateProcessTree` instead does `process.kill(-pid, "SIGKILL")` — a PROCESS-GROUP kill, a
completely different identity axis. `fork()`/reparenting-to-init never changes a process's pgid, so the
"escaped" descendant — despite being orphaned from the PPID tree exactly as designed — never leaves the
SAME process group as git's own hook child, and dies right along with it. REPRODUCED directly on real WSL
Ubuntu-22.04: with the bare (pre-fix) hook, the escaped descendant's own marker file (proof it ran) never
appeared, and the repo was never quarantined — the kill came back CONFIRMED every time, not unconfirmed.

`merge-commit-kill-confirm.mjs` carried a comment, from the file's ORIGINAL authoring commit (`484e68f1`),
that already named this exact mechanism and concluded "an accepted, documented residual difference...
not a bug in this test." That conclusion was wrong — there was no actual platform-specific accommodation
anywhere in the test; the gap was simply never exercised on Linux CI until this epic (`d27941e8`) started
running the suite there.

## Fix

In each hook's shell script (`git-writer-kill-confirm.mjs`'s inline hook, and
`installDoubleForkedPreCommitHook`/`installDoubleForkedPreMergeCommitHook` in
`merge-commit-kill-confirm.mjs`/`union-merge-kill-confirm.mjs`), wrap the escaping descendant with
`setsid` when available (`command -v setsid >/dev/null 2>&1`): `setsid` gives it a brand-new
session — and therefore a brand-new pgid — so a process-group `SIGKILL` of the original hook's group no
longer reaches it, reproducing on POSIX the same escape-from-the-kill property the PPID-walk already
gives it for free on win32. When `setsid` is unavailable (Git for Windows' MSYS `sh` has none), the hook
falls back to the original, byte-identical shape — the already-validated win32 path is untouched.

Verified green bare (`node test/<file>.mjs`) AND via the harness (`test:daemon --only=<file>`) on both
real WSL Ubuntu-22.04 and native Windows.

## Do not

- Do not assume a kill-escape trick that defeats one OS identity axis (PPID tree) automatically defeats a
  different one (process group, or a Windows Job Object) on another platform — check which axis the real
  kill mechanism actually uses on each platform before trusting a fixture's escape to reproduce there too.
- Do not read a "not a bug in this test" comment as settled fact just because it names the right
  mechanism — this file's own prior comment did, and was wrong; the mechanism being correctly described
  is not the same as its conclusion being correct.
- Do not add a platform branch to `killGateProcessTree`'s own POSIX kill (e.g. special-casing this test's
  own escaping-descendant shape) to "fix" this from the product side — the process-group kill reaching
  every ordinary (non-`setsid`'d) descendant is CORRECT, real containment behavior; the gap was in the
  test's own escape fixture, not in the kill.

## Source

Card `f59ca98a` (child of epic `d27941e8`, ubuntu CI green for the 0.31.0 release). Commit `231692d9`.
