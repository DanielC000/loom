# d099087f — a branch tip that moves T1→T2→T1 inside a gate is detected by the reflog delta, not a head compare

Extends 975c774b / c59165b8 (pinned gated tip, outcome `gate-tip-moved`, in `NEVER_CACHED_OUTCOMES`). A worker that commits T2 mid-gate and resets back to T1 before settle leaves the settle head equal to the pre-spawn head AND the live tip equal to the pinned tip, so a PASS earned on mixed T1/T2 content squashed T1.

## Do not

- Do not "fix" this by comparing `post.head !== gatePreStamp.head` in the `runGateSeq` wrapper (the card's own suggestion): in the ABA case the two are EQUAL, so that check is inert here. It would only re-flag a plain move that the pinned-tip check already refuses.
- Do not reset `gateHeadLeftDuringRun` between gate links: it is sticky across attempt 1 / single-file / resumed links, like `pinnedGateTip`, or a later clean link launders an ABA on an earlier one.
- Do not treat every reflog growth as a move: `branchLeftHeadBetween` flags only new entries whose sha differs from the pre-spawn head (a `reset --hard HEAD` no-op must not refuse). An unreadable or shrunken reflog fails closed.
- Do not add a new outcome: the refusal is `gateTipMoved` with `movedAndBack:true`, so classification stays `gate-tip-moved` and stays never-cached.

Known limit: a repo with `core.logAllRefUpdates=false` records no reflog, so the ABA round trip is invisible there (the snapshots compare equal).
