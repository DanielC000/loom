# b966962b — the Windows/MSYS-hook residual is the COMMON case, not a rare double-forked escape, and the quarantine reason should say so

## Narrative

`24c0bdba`'s own Residuals section claimed "SIGKILL/`taskkill /T /F` make true [confirmed tree death] for
essentially every real hook" and described the only Windows gap as a deliberately double-forked hook tail
that detaches from its process tree. Card `755afc26` (worker `5a65dcab`) first found this false by direct
OS-level probing: a PLAIN, un-engineered `#!/bin/sh\nsleep N` pre-commit hook — no pipe, no backgrounding,
no double-fork — is ALSO reproducibly unconfirmable on Windows. `taskkill /T /F` reports success and names
the PIDs it killed, but the real `sleep.exe` descendant is never among them and survives until it exits
naturally.

This card verified the mechanism one level deeper, by direct probing on a real Windows host: a throwaway
repo with a `#!/bin/sh\nsleep N` pre-commit hook, a `git commit` run in the background, and — while the
hook was still sleeping — both `ps -lW` (Git for Windows' own bundled `usr/bin/ps.exe`, MSYS-native, `-W`
also shows Windows processes) and `Get-CimInstance Win32_Process` (the real OS-level view) read against
the exact same PIDs.

- `ps -lW` showed the hook's own `sh` reporting PPID `1`, not git's PID — MSYS's *own* internal fork/parent
  bookkeeping is already wrong for this hook invocation, before Windows is even involved.
- Cross-checking the real Windows PIDs `ps` reported: git→sh's `ParentProcessId` DID correctly name git's
  real PID. But sh→sleep's `ParentProcessId` named a THIRD, unrelated PID — not sh's PID at all (almost
  certainly an already-exited helper process from Cygwin/MSYS's fork-emulation `CreateProcess` dance, per
  the way Cygwin/MSYS implement `fork()` on top of Windows' process model, which has no native fork).

So the broken edge is NOT at the outer git→sh boundary (which both MSYS's own accounting and Windows'
own `ParentProcessId` get right) — it is one level deeper, at sh→sleep, and at THAT edge even Windows'
own kernel-level process metadata does not name the real parent. This rules out every enumeration-based
fix that depends on walking a parent-id chain, Windows' or MSYS's:

- **Enumerate descendants by parent pid + creation time, walking upward**: not viable. This isn't a
  pid-reuse hazard a careful upward walk could dodge — the real `ParentProcessId` data such a walk would
  need to follow simply doesn't name the right process at the sh→sleep edge. No algorithm walking
  Windows' own PPID chain (ours or `taskkill`'s) can discover this descendant; the data isn't there to
  walk.
- **Check via MSYS's own `/proc` emulation (`ps -W`)**: not viable either, and for the same underlying
  reason — MSYS's own internal bookkeeping (which `ps` reads) is ALSO wrong here (PPID `1` for `sh`), not
  an independent source of truth that could cross-check or substitute for Windows' view.
- **Handle/lock-release checking**: doesn't generalize — a hook descendant isn't guaranteed to hold any
  specific observable lock/handle; the actual threat (a stray later write) isn't gated behind one.

The one approach that would actually close this — a Windows Job Object, whose membership is enforced by
the kernel at process-creation time independent of the (broken) PPID chain — needs either a native addon
or an inline P/Invoke-via-PowerShell helper spawned per canonical git call: real new machinery, already
filed as its own backlog card (`1718416d`, "contain canonical merge hook processes in a Windows job
object") and already named in `24c0bdba`'s own Residuals section as "a Job Object (native dependency, out
of scope here)". This card does not attempt that.

## Fix

1. `24c0bdba`'s Narrative/Residuals corrected: the ordinary (non-double-forked) sh-hook case is the common
   one for Windows users with sh-based hooks (husky/lefthook/pre-commit), not a rare edge case; the
   double-forked tail is a SEPARATE, additional residual, not the whole story.
2. `git/merge-quarantine.ts`'s `unconfirmedKillReason()` — the ONE shared helper every `enterMergeQuarantine`
   call site raised from a `treeDeathUnconfirmed` branch routes its `reason` through — appends a standing
   guidance clause naming the Windows/MSYS-hook cause and a concrete pre-clear check (`ps -W`, or Task
   Manager filtered by the hook's own tool), then the existing `POST /internal/merge-quarantine/clear`
   route. Deliberately does NOT say the repo is "probably fine" — a fail-closed quarantine exists because
   this process cannot tell, and that wording would invite a blind clear.
3. `project_memory` note `windows-msys-hook-taskkill-unconfirmed` updated with the verified PPID findings
   above.

## Do not

- Do not hand-build a quarantine `reason` string for an unconfirmed-kill raise (`treeDeathUnconfirmed`) in
  `git/worktrees.ts`/`git/batch-merge.ts`/`git/writer.ts` — route it through
  `unconfirmedKillReason()` (`git/merge-quarantine.ts`) so the Windows/MSYS guidance can never drift
  between call sites or be silently omitted at a new one.
- Do not route the boot-time corrupt-latch fail-closed path (`quarantineAllRegisteredFailClosed`) through
  `unconfirmedKillReason()` — that cause has nothing to do with an unconfirmed kill or MSYS hooks, and the
  guidance would be actively misleading there.
- Do not word this guidance as "the repo is probably/very likely fine" — name a concrete check instead
  (a still-running git/sh/hook process check), since the entire reason the repo is quarantined is that
  this process could not positively confirm either way.
- Do not re-attempt a PID/creation-time or MSYS-`ps`-based confirmation mechanism for this residual without
  first re-reading this record — both were verified non-viable on this host because the underlying
  parent-id data they would need to walk is itself wrong at the sh→sleep edge, not merely hard to walk
  correctly.

## Source

Card `b966962b`, following on `755afc26`'s initial finding (a plain sh+sleep hook, not a double-forked
escape, is unconfirmable). Verified by direct `ps -lW` + `Get-CimInstance Win32_Process` probing on the
owner's Windows host.
