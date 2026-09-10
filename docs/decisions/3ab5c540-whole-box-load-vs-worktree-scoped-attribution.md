# 3ab5c540 — whole-box CPU load vs. worktree-scoped process attribution are two different, each incompletely blind, instruments

## §1 — `readWholeBoxLoadPercent`: the quietness test, deliberately independent of `gate_queue`

### Narrative

A whole-box CPU load reading, deliberately INDEPENDENT of `gate_queue`/`GateSemaphore` — the Codescape peer (mgr #34) TRACED a sibling worktree hand-running `tsx --test`, 6+ node children, actually consuming the box WHILE `gate_queue` read `activeCount:0` — that alone proves the instrument is blind, no comparison needed, since that load never touched the semaphore at all. (A companion sample pair they also took — 49.3s with `activeCount:0` before/after vs. 34.3s with a merge gate confirmed running — is illustrative only, NOT load-bearing: two points, and it would collapse if the 34.3s sample also carried hidden load nobody traced. Blindness is proven; that it BIT this particular pairing is not, and is not claimed here.) Their own follow-up went further: the single BIGGEST layer of load they measured (~88% sustained) was non-agent entirely (a game client, browsers, media) — invisible to `gate_queue` AND to any worktree-scoped process check.

This function answers "is the BOX idle", never "is the gate idle" or "is Loom's own work idle" — see §2 below (`attributeProcessesToWorktree`) for the separate, narrower ATTRIBUTION question ("which agent work is running"). The two are NOT substitutes for each other: this one sees non-agent load and misses nothing running on the box, but says nothing about WHOSE load it is; that one attributes to a specific worktree but is blind to anything not rooted there (including this whole non-agent layer).

win32: `Get-CimInstance Win32_Processor` returns one row per logical CPU package, each already carrying an OS-computed `LoadPercentage` (a rolling ~1s average) — averaged across rows here since a multi-package host would otherwise report only one package's figure. POSIX: `os.loadavg()[0]` (the 1-MINUTE load average, a DIFFERENT time base than win32's ~1s figure — do not compare the two platforms' readings against each other) divided by `os.cpus().length`, expressed as a percentage — the closest POSIX equivalent available without shelling out to `top`/`vm_stat`. `windowNote` on the return value names which time base a given reading came from, so a reader never has to assume it.

Read-only: no kill, no worktree/process match of any kind, no mutation of any state. Rejects (never resolves a fake reading) on a genuine measurement failure — a wedged CIM query, a non-numeric result — so a caller can tell "the box is quiet" apart from "the instrument didn't answer" instead of the two looking identical.

## §2 — `attributeProcessesToWorktree`: the attribution helper, and its measured coverage gap

### Narrative

A READ-ONLY sibling of `reapProcessesRootedInWorktree` — reuses the SAME enumeration + the SAME `processRootedInWorktree` path/cwd/commandLine match (the safety-critical predicate documented on that function), but NEVER kills anything and returns the full matched set for a reader, not a kill count. Answers "which OS processes can I attribute to worktree X", never "is the box quiet" — see §1 above for that separate question.

KNOWN COVERAGE GAP, measured directly (card 3ab5c540 §THE FIX WAS WRONG): of 17 live `node.exe` processes on a real host, 8 named a worktree segment in their own path/cwd/commandLine (what this function matches) — the other 9 (53%) did NOT, and were NOT descendants of any matched process either: the Loom daemon itself, its `codescape serve` child, `daemon-supervisor.mjs`, `test-daemon.mjs`, and other repo-root-rooted processes. `ParentProcessId` chaining from a matched root would find NONE of those 9 — it was tested and refuted as a fix, not merely unimplemented. So `matched: []` here is evidence only that "no process NAMES this worktree" — it is NOT evidence this project, or the box, is otherwise idle. Pair with §1 for that broader question, and read `totalProcessesScanned` alongside `matched.length` so the coverage ratio is visible at the call site.

Matches at the FULL worktree-path boundary (never a bare project-id or worktree-id segment alone) — the same path-segment-boundary discipline `processRootedInWorktree` already enforces, which is what keeps this safe from the exact collision DoD-5 of card 3ab5c540 forbids: the project-id segment is shared by every worktree the project has ever created, so matching on it alone would attribute a SIBLING worktree's processes to this one.

### Do not

- Do not read `matched: []` from `attributeProcessesToWorktree` as evidence the box (or even this project) is idle — MEASURED: 9 of 17 real node processes on a host named no worktree segment at all, and `ParentProcessId` chaining was tested and refuted as a fix for this gap. Pair with `readWholeBoxLoadPercent` (§1).
- Do not compare a `readWholeBoxLoadPercent` reading across platforms — win32's `LoadPercentage` is a ~1s rolling average; POSIX's `os.loadavg()[0]` is a 1-minute average. Different time bases.
- Do not match a worktree by a bare project-id or worktree-id segment alone in `attributeProcessesToWorktree` — that segment is shared by every worktree the project has ever created and would attribute a sibling worktree's processes to this one.

### Source

Inline comment in `packages/daemon/src/pty/host.ts` (`readWholeBoxLoadPercent`'s and `attributeProcessesToWorktree`'s top-of-function doc). Relocated by card `d212c7d9` (tranche 14).
