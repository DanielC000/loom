# d099087f — a branch tip that moves T1→T2→T1 inside a gate is detected by the reflog delta, not a head compare

Extends 975c774b / c59165b8 (pinned gated tip, outcome `gate-tip-moved`, in `NEVER_CACHED_OUTCOMES`). A worker that commits T2 mid-gate and resets back to T1 before settle leaves the settle head equal to the pre-spawn head AND the live tip equal to the pinned tip, so a PASS earned on mixed T1/T2 content squashed T1.

## Do not

- Do not "fix" this by comparing `post.head !== gatePreStamp.head` in the `runGateSeq` wrapper (the card's own suggestion): in the ABA case the two are EQUAL, so that check is inert here. It would only re-flag a plain move that the pinned-tip check already refuses.
- Do not read only `refs/heads/<branch>`'s reflog: the gate reads the WORKTREE's HEAD, and a HEAD-only round trip (detach → commit → checkout back, another branch and back, an aborted rebase) writes no branch entry. Snapshot BOTH the branch reflog and the worktree's own HEAD reflog (`snapshotGateReflogs`), and take the snapshot FIRST in `captureGatedTip`.
- Do not reset `gateHeadLeftDuringRun` between gate links: it is sticky across attempt 1 / single-file / resumed links, like `pinnedGateTip`, or a later clean link launders an ABA on an earlier one. Owner-side ruling: it stays sticky across the transient whole-gate re-run too. That fails closed and only costs one re-gate in a rare case.
- Do not treat every reflog growth as a move: `gateReflogLeftHead` flags only new entries whose sha differs from the pre-spawn head (a `reset --hard HEAD` no-op must not refuse). The delta is anchored on the before-snapshot's newest entry by position AND sha, not on length alone, so an expiry or rewrite during the gate cannot hide a round trip; an unreadable, shrunken or unanchored reflog fails closed.
- Do not leave the `run_gate` self-check out: its stamps (start/admit/settle) all show the same head after an ABA, so a reused green would skip the merge gate. `describeGateHeadCurrency` takes a `roundTrip` flag (reflog snapshot at admission vs settle) and yields `headCurrent:false`, which makes the result non-reusable.
- Do not add a new outcome: the refusal is `gateTipMoved` with `movedAndBack:true`, so classification stays `gate-tip-moved` and stays never-cached.

- Do not let `roundTrip` run ahead of `describeGateHeadCurrency`'s other checks: it decides ONLY where the stamps cannot see a move (settle head === admit head, including the queue-wait-relabel case). The null-stamp UNKNOWN and the RACY shape stay first, so a plain mid-run commit that never returns keeps 39196378's RACY wording (`run-gate-head-currency.mjs` pins that).
- Do not label a HEAD-only move that never returns (worktree left detached at T2, branch ref still T1) `movedAndBack`: only a move whose settle worktree HEAD is back at the pre-spawn head is; the other is refused as an ordinary `gateTipMoved` naming the worktree HEAD it was left on.

Known false refusal: a reflog expiry (e.g. `gc --auto` on an old worktree) that shrinks the reflog or breaks the position anchor during a gate reads as "moved". Rare, fails closed, costs one re-gate.

Known limit: a repo with `core.logAllRefUpdates=false` records no reflog, so the ABA round trip is invisible there (the snapshots compare equal).
