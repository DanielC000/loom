# d1521fca — MCP-silence watchdog: fixing false positives replayed against the real 2026-10-18 incident

The MCP-silence watchdog (`orchestration/idle-watcher.ts`'s `tickMcpSilence`) was Code Reviewed by
replaying its classifier against the real 2026-10-18 daemon log that motivated it. The FIRST `tick()`
after the host-wide stall cleared saw every router silent for 11-16 minutes — before clients' own
catch-up MCP traffic arrived (that tick ran only ~7 seconds before the first post-stall `[mcp]` log
line) — and flagged 9 of 13 live sessions, filing 5 Platform tasks. It even flagged the real incident's
own `b5668822` worker for the WRONG router, because the cadence estimate at the time was the single
last inter-arrival gap: a client request BURST (`initialize` immediately followed by `tools/list`)
produces a near-zero last gap that collapses the observed cadence toward zero and drags the stale
threshold down to its floor — making the watchdog MORE trigger-happy on a burst, not less.

The daemon's own `tick()` had itself LAGGED by roughly that same 11-16 minutes during the stall — a
real, measured symptom of the SAME host-wide CPU starvation that caused the underlying git-subprocess
stall (see the card's own investigation phase), not a separate bug. Two independent fixes, both
required:

1. **Robust cadence estimate.** `PtyHost.getMcpRouterCadenceMs` now returns the MAX of the last
   `MCP_ROUTER_CADENCE_WINDOW` (5) inter-arrival gaps per (session, router), not the single last gap —
   a burst's near-zero gap no longer corrupts the estimate as long as at least one real keepalive gap
   is still inside the window. `Live.mcpRouterSeenAt`/`CodexLive.mcpRouterSeenAt` store `{ lastAt,
   gaps[] }` accordingly (`pty/host.ts`).
2. **Tick-lag detection + re-baseline, plus two-evaluation confirmation.** `IdleWatcher.tick()` compares
   `now` against its own last recorded tick time; a gap past `MCP_SILENCE_LAG_MULTIPLIER × intervalMs`
   (3x) means the watcher itself was starved, not just the sessions it watches, so every router's
   apparent staleness that tick is unreliable. The MCP-silence sweep is skipped entirely for that tick
   and for `MCP_SILENCE_STALE_FLOOR_MS` (10 minutes, treated as "at least one keepalive period")
   afterward. Independent of whether a lag was detected at all, a session's FIRST-seen-stale tick never
   notifies by itself — `IdleWatcher.mcpSilencePending` requires a LATER evaluation, at least one
   keepalive period after the first, to still find it stale before promoting to a notified episode.
   **Round-3 correction:** the two-evaluation confirmation ladder ALONE already absorbs a worsening that
   only becomes visible several ticks after the stall ends (the router's own per-router threshold
   hadn't been crossed yet at stall-end) — lag detection adds nothing in that case. Lag detection is
   load-bearing only for the narrower case where the worsening is ALREADY visible on the very first tick
   resumed after the stall (the stall itself outlasted the router's own staleness threshold): there, an
   unprotected ladder's clock starts immediately at that first tick and confirms one keepalive period
   later, while lag detection delays the clock's start until grace ends (a further keepalive period),
   buying a full extra window for slow catch-up traffic to land. See test (5) in
   `idle-watcher-mcp-silence.mjs`, rewritten in round 3 around exactly this shape after the original
   version was shown (by deleting the lag-detection block) to never actually exercise it.
3. **Never immediately re-notify an already-confirmed episode on a shape change (round-3 fix).** The
   original design skipped the confirmation ladder entirely for a shape change on an already-confirmed
   episode, reasoning that a second real wedge is independently newsworthy — but a stall can make a
   confirmed episode's one remaining FRESH router look stale too, purely as a stall artifact, and that
   got announced as a brand-new episode with no chance for a blip to resolve first (the real
   `10feb23f` specimen). Every worsening beyond the confirmed baseline — fresh or already-confirmed —
   now goes through the SAME pending/confirm ladder. And a stale-router set that's a SUBSET of (or
   equal to) the confirmed baseline (things got better or stayed the same) is never notified at all,
   not even through the ladder — a partial recovery (e.g. all-silent → asymmetric) is reconciled into
   the confirmed bookkeeping quietly, never announced as new silence.

Both real incidents still fire comfortably inside these windows: `a7c072c4`'s ~7.5h outage and
`b5668822`'s ~40min one both vastly exceed one stale-threshold crossing plus one confirmation gap.

A stall-shaped timeline (every router silent long enough to cross its own threshold on tick 1, then
catching up slowly) is replayed in `packages/daemon/test/idle-watcher-mcp-silence.mjs` test (5) as the
lag-detection-load-bearing case; tests (8) and (9) cover the shape-change-on-a-confirmed-episode ladder
and the partial-recovery subset rule respectively.

## Do not

- Do not go back to a single last inter-arrival gap for cadence — see the burst-collapse failure mode
  above; always take the max over the bounded recent window (`PtyHost.getMcpRouterCadenceMs`).
- Do not let a brand-new, never-before-stale session notify on its very FIRST stale observation — it
  must sit in `mcpSilencePending` until a second, keepalive-period-later evaluation confirms it. This
  applies uniformly to a worsening of an ALREADY-confirmed episode too — never skip the ladder just
  because a confirmed episode already exists (see point 3 above).
- Do not notify when the current stale-router set is a SUBSET of (or equal to) an already-confirmed
  episode's set — that is a partial recovery or steady state, never new silence.
- Do not clear `IdleWatcher.mcpSilenceEpisodes` (already-confirmed, ongoing episodes) on a detected tick
  lag — only `mcpSilencePending` (unconfirmed candidates) needs clearing; an already-notified episode
  re-notifying once more after a lag is the same accepted in-memory-state tradeoff this file already
  makes elsewhere (see `mcp_silence_detected`'s own doc, `packages/shared/src/types.ts`).
- Do not derive the lag threshold or the confirmation gap from a hardcoded wall-clock constant
  disconnected from `intervalMs`/`MCP_SILENCE_STALE_FLOOR_MS` — a project or test that configures a
  different tick cadence must scale both automatically.
- Do not drop the codex exclusion on the ALL-SILENT shape (`classifyMcpSilence`'s `isCodex` check) —
  there is no evidence codex's MCP client sends the periodic keepalive this watchdog's cadence baseline
  assumes, so "every router went stale together" for a codex session may just mean it's deep in one
  long turn polling nothing, not a connection wedge. The ASYMMETRIC shape is unaffected (a fresh sibling
  router is real evidence regardless of harness) and stays enabled for codex.
