# sha:d8395f4e — `reapProcessesRootedInWorktree`'s over-match + subtree-kill: an ACCEPTED RISK, both fail-safe

## Narrative

Two accepted risks in `reapProcessesRootedInWorktree` (`pty/host.ts`), both reviewed and deliberately kept because both fail SAFE (under-kill, never over-kill) rather than dangerous:

(1) The command-line arm of `processRootedInWorktree` intentionally over-matches a process that merely NAMES the doomed worktree path in its argv without being rooted there. This is load-bearing, not a bug: on win32, vite's global `node.exe` carries the worktree path ONLY in its `CommandLine` (CIM exposes no per-process cwd), so narrowing the match would miss the exact survivor this function exists to catch.

(2) `killProcessById`'s win32 path (`taskkill /pid <pid> /T /F`) kills the matched pid's whole subtree, which widens the blast radius past the one matched process — theoretically reaching an ancestor-of-the-daemon if one were ever wrongly rooted in a worktree, though not realistic for a checkout-launched daemon (the daemon's own pid is separately excluded regardless, see `8e5a7a5e`'s SELF-EXCLUSION section).

## Do not

- Do not narrow the command-line match to try to eliminate the argv-naming over-match — on win32 that is the ONLY field carrying the worktree path for some survivors (e.g. vite's global `node.exe`), so narrowing it would reintroduce the exact miss this function exists to prevent.
- Do not treat the win32 subtree-kill's widened blast radius as something to "fix" here — it is an accepted, reviewed risk, mitigated by the daemon's own unconditional self-exclusion, not by narrowing the kill.

## Source

Inline doc comment above `reapProcessesRootedInWorktree` in `packages/daemon/src/pty/host.ts` (the "ACCEPTED RISK" paragraph), introduced by commit `d8395f4edf2443953fbe0387295ff95122daf5ba` ("test(pty): harden reapProcessesRootedInWorktree — win32 stdout setEncoding + a cwd-arm real-process test"), as of this tranche's HEAD (main `9421720c`). No card id anywhere in the block, the file, or this commit's own message — sourced via the `sha:` grammar.
