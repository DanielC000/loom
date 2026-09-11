# 50c1e0d0 — `validatedHead` lets a caller tell, after the fact, which commit a gate result is about

## Narrative

`validatedHead` (card 50c1e0d0 — the result-consumption fix) is the worktree `HEAD` this run actually gated against, stamped at the moment the run started (`null` only if the worktree was unreadable at that moment) — set on EVERY `ran:true` outcome (pass or fail) so a caller can tell, after the fact, exactly which commit a `[loom:gate-done]`/`[loom:gate-failed]` result is about.

Card 50c1e0d0 is the umbrella "result-consumption fix" for THREE footguns, of which `validatedHead` above is footgun (3): every `ran:true` outcome carries it regardless of which fix path a caller lands on.

## Mechanism: footguns (1) and (2)

(1) SETTLE-GRACE RE-CALL: `retainMs: GATE_OP_RETAIN_MS` on `attach()`'s opts means a re-call landing within that window AFTER the op settles is served the SAME settled result (keyed by the SAME `opId`) straight out of `PendingOpRegistry`'s retention cache — `run()` is NOT invoked again — instead of silently starting a brand-new ~gate-timeout-long run. ORIGIN INCIDENT: a re-call meant to "fetch the passed result" instead ran a whole fresh gate that then failed on unrelated flakes. "Served" here means served WHEN USABLE, gated by `isRetainedResultUsable` (card `79b0ee52`) — a cancelled, never-ran, or tree-contaminated cache hit falls through to a genuinely fresh run instead, same as a real cache miss.

(2) MID-FLIGHT STALENESS: `attachedToInFlight` (computed via a `peek()` BEFORE this call's own `attach()`, so it reflects whether SOME EARLIER call — not this one — already has an op running under this key) tells a re-caller it attached to an already-running op rather than starting one. `staleAgainstWorktree` (via `gateStampsDiffer` against the worktree gate stamp `run()` recorded at the moment IT started) tells the caller whether the worktree has moved on since — a new commit, or an uncommitted edit — since that in-flight op is validating whatever was on disk when IT started, not necessarily what's on disk now. Both fields are computed independently of each other and are meaningful even for the ORIGINATING call itself: a slow gate degrading past `SYNC_ATTACH_BUDGET_MS` on its own first call reports `attachedToInFlight:false` but can still report `staleAgainstWorktree:true` if the worktree was edited during that same wait.

## RESIDUAL BOUNDARY

RESIDUAL BOUNDARY (Code Review, card 50c1e0d0 hardening — narrowed by card `79b0ee52`, narrowed again by card `ec994992`): a USABLE cached path (`ran:true`, a real `passed` verdict, `headCurrent` exactly `true`) is still served straight out of `PendingOpRegistry` without re-deriving — it reuses what was computed ONCE at the original settle (`validatedHead`, plus `headCurrent`/`headWarning`, card `39196378`), not a fresh dirty-state comparison taken NOW. A caller who makes an UNCOMMITTED edit AFTER the cached run already settled CLEAN (`headCurrent:true`) and re-calls within the grace window still sees that cached `{passed, validatedHead:<unchanged>, headCurrent:true}` with NO fresh staleness signal for the NEW edit — footgun #2 stays closed for the MID-FLIGHT branch above, and (as of `79b0ee52`) for a run that settled already-contaminated, but NOT for an edit made entirely AFTER an already-clean settle. In practice this only matters for a fast (<`SYNC_ATTACH_BUDGET_MS`) `gateCommand`: a multi-minute gate always degrades to the covered in-flight path first.

Deliberately not fixed by ALSO stamping+comparing on EVERY cache hit: that adds a git round-trip to the fast path this retention window exists to keep fast, for a case (a fast-gate project + an edit inside a 5s window, striking AFTER an already-clean settle) the origin incidents never actually hit. `isRetainedResultUsable` already closes the higher-value cases — a settled result that KNOWS it's contaminated, or never reached a real verdict (cancelled) — for free, since `ran`/`passed`/`headCurrent` are all computed once at settle regardless of re-calls; the free half of this tradeoff, not a substitute for the rest.

## Do not

- Do not omit `validatedHead` on a failing `ran:true` outcome — it's set on BOTH pass and fail so a caller can always tell which commit the result is about, not just on a pass.
- Do not silently start a brand-new gate run on a settle-grace re-call — serve the retained result from `PendingOpRegistry` when `isRetainedResultUsable` says it's usable; the origin incident was a re-call that meant to fetch a passed result instead running a whole fresh gate that failed on unrelated flakes.
- Do not treat `attachedToInFlight`/`staleAgainstWorktree` as only meaningful for a re-caller — both are computed independently and can both matter for the ORIGINATING call too.
- Do not stamp+compare on every cache hit to close the residual boundary above — that adds a git round-trip to the fast path this retention window keeps fast, for an edit-after-clean-settle case the origin incidents never hit; IF it becomes a real footgun in practice, fix by comparing a fresh dirty stamp on every cache-hit path — not today's fix.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`WorkerGateResult.validatedHead`): lines 664-695, as of commit `f9caa77e30d5c1a6dd994b6203261968c0dbf94f`. Relocated by card `8f4c8a8f`; no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.

The three-footgun umbrella, SETTLE-GRACE RE-CALL, MID-FLIGHT STALENESS, and RESIDUAL BOUNDARY sections above are from a second site citing the same card: `runWorkerGate`'s own JSDoc in `packages/daemon/src/sessions/service.ts` (tranche 61, ~lines 15506-15521 as of this tranche's HEAD) — genuinely new nuance not previously captured by this record; anchored there, not duplicated as a second file, per the one-record-per-id rule.
