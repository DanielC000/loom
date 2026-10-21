# The fleet controls are one renderer behind two mounts, kept in step by cache keys rather than by shared code

Card `7b893d54` — Atlas build plan P2-3 (`docs/plans/atlas-ui/03-decomposition.md`), against the owner-approved round-4 V2 design (`Mockups/2026-10-19 UI Overhaul Round 4` §2). Four decisions, all made while giving `clearUsageHold` / `pauseOrchestration` / `resumeOrchestration` / `killOrchestration` a home in Atlas.

Round 2 dissolved Mission Control into the Workspace root and these four controls did not follow; round 4's action-level inventory is what caught that they had no home at all.

## 1 · Two mounts, because "where" and "when you need to know" are different questions

They are daemon-global, so by Atlas's own "scope is depth" rule they belong at the Workspace root. But a *paused* fleet is not something a reader should have to navigate to the root to discover — it changes the meaning of every other node's emptiness. So `components/fleetControls.tsx` holds one `FleetControls` cluster behind two mounts:

- `FleetControlsBar` — a full-width bar directly under the Workspace root's KPI deck (filling the named `atlas-slot-fleet-controls` slot P2-1 laid out for it).
- `OrchestrationChip` — a `● running` / `● paused` chip in the Atlas crumb bar on **every** node, opening a pop-over that holds the same cluster over the plan-usage gauges.

The chip is also the peripheral marker: paused turns it red and gives `.loom-atlas-topbar` a 2px red inset, so the state reads without being looked for.

### Do not

- **Do not give either mount paused-state of its own.** Both read `orchStatusQuery()`'s `["orchStatus"]` entry — the same one the classic rail pill and Mission Control's badge read, kept live by `FleetSocketProvider`'s `/ws/fleet` `status` deltas. One cache entry is *why* the two mounts and the classic UI cannot disagree; a local mirror would reintroduce exactly the drift the two-mount design is otherwise free of.
- **Do not subscribe the chip to plan usage shell-wide.** `["usageLimits"]` is read with `enabled: open`. The two entries the chip reads unconditionally (`["orchStatus"]`, `["allSessions"]`) are already shell-wide in *both* shells — the classic rail reads both on every page — so the chip costs no request the classic UI does not already make. A third, ungated subscription would be a poll neither shell makes today.

## 2 · Mission Control keeps its own inline mutations — the obvious refactor is red

The tempting cleanup is to delete Mission Control's pause/resume/kill mutations and mount `FleetControls` there instead. `packages/web/test/orchestration-page-removed.mjs` pins the literal string `"Kill all"` and the three `api.*` names **inside `pages/MissionControl.tsx`'s source text**, so that refactor is behaviourally perfect and still fails the gate.

`ClearUsageHoldButton` *did* move here (it is not named by that test), so the classic page and both Atlas mounts render one implementation of it, four-second confirmation window included.

### Do not

- **Do not lift Mission Control's pause/resume/kill cluster into this module** without first reading `orchestration-page-removed.mjs`. The duplication is three one-line `useMutation` wrappers over shared `api.*` members; the thing that actually has to stay in step is the cache keys, and it does.
- **Do not add a call-site `onError` to any mutation here.** `main.tsx`'s `MutationCache` handler is app-wide and a second handler shows a second modal for one failure.

## 3 · The kill confirm counts live WORKERS, because that is what the server stops

`SessionService.killAllWorkers` (`packages/daemon/src/sessions/service.ts`) filters `role === "worker" && processState === "live"`, hard-stops and retires exactly those, and then calls `control.pause("global")`. A manager, the Platform Lead and a Companion all survive it.

The round-4 mockup explicitly flagged this as a real-daemon question it could not answer and counted "orchestration sessions" as a placeholder. The answer is above, so the armed confirm reads `Kill all N live workers?` and the pop-over note states the scope and the pause side-effect.

### Do not

- **Do not widen the confirm's wording back to "every session" or "all orchestration sessions".** A destructive confirm that overstates its reach is exactly as misleading as one that understates it, and this one is now checkable against the daemon method named above.
- **Do not drop the `+ pauses orchestration` half from the note.** It is the half a reader cannot infer from the button's name, and it is why `Kill all` is disabled — rather than silently equivalent to `Pause` — when nothing is live.

## 4 · Kill all arms in place; Pause and Resume are one swapping control

The confirm expands inline (`Kill all N live workers? [Confirm] [Cancel]`), mirroring `pages/Board.tsx`'s card delete down to the button pair. Escape, an outside click, or `Cancel` disarms; the armed flag is local to each mount, so arming the bar does not arm the chip.

Pause and Resume are one button that swaps on the live state rather than two permanently-lit ones. Both actions stay reachable, each exactly when it means something, and the cluster stays narrow enough for the crumb-bar pop-over as well as the full-width bar.

### Do not

- **Do not promote the confirm to a modal.** Loom confirms destructively in place everywhere it matters, and the chip's pop-over is already a layer — a modal over it would be a dialog stacked on a pop-over for a two-word question.
- **Do not share the armed flag between the two mounts.** Arming a destructive control somewhere the reader cannot see is how a misclick becomes a fleet-wide stop.
