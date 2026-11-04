# 9b6be377 — the Atlas Workspace node's Sessions card mounts ONE terminal, and nothing at rest

Card `9b6be377`, from the owner's 2026-11-03 Atlas feedback round (parent `16106aaf`). His item, verbatim:

> `"Workspace": Add "Sessions" card with all running session terminals.`

## What was missing

Under Atlas, `/terminals` is the **project** node's Sessions tab (card `25c08fba`) — the classic rail's god-eye Terminals page changed tier when it re-homed, and it rescopes through the project filter that tab pre-selects. So the workspace tier, the shallowest node and the default Atlas landing, had no cross-project terminal surface at all: reaching a running agent's terminal from `/home` cost a project switch first, even though `/home` is exactly where a reader asks "what is running anywhere".

The card is that surface: every running session across every project, as one dense identity row each, row-expandable into its own live terminal.

## Do not

- **Do not render a second `TerminalCard` on this node, and do not pre-expand a row.** `CLAUDE.md` records that a page mounting live terminals is heavy and that the cockpit's CDP renderer has frozen on one. Each mount is a real `/ws/term` attach plus an xterm instance, so the card's cost is linear in mounted terminals and its whole performance contract is that the number is **0 at rest and at most 1 ever**. `toggleExpandedSession` (`packages/web/src/lib/workspaceSessions.ts`) holds that rule: a re-click closes, a different click *moves* the mount.
- **Do not pass `resizable` for a claude session here.** Terminal geometry is pinned daemon-side (no pty resize); `TerminalCard` scales the rendered grid to its pane instead. `resizable` is for plain shells only.
- **Do not widen the card's population past the `live sessions` KPI tile's own.** `workspaceRunningSessions` filters `!isCompanionSession` then `isLiveSession`, which is exactly how `WorkspaceHome` derives that tile and how the Atlas tree derives its live marker. A card stating one count ~200px below a tile stating another, for the same word, is the defect — not the rows it would have added. Excluding companions is also the companion guard (card `5c87f4b6`): a companion is driven only through its chat surface, never a raw pty + stdin Composer, which is why `pages/Terminals.tsx` filters them at the same source. The card's footer names that omission rather than leaving it silent.
- **Do not give the row a `TileTitle`.** `TileTitle`'s status pill reads `busy` alone, so it prints "idle" over a `starting` row. `goLiveSessionPill` (`lib/sessions.ts`, card `318b5a21`) exists to stop exactly that misreport, and the row uses it.
- **Do not put a Fork or Stop control on the mounted card.** This node is a readout of the fleet, the same posture card `c6160c7d`'s record gives the Operators panel; the row's `Open ↗` reaches the session node's full-feature tile, which owns lifecycle. The **Composer stays** — a terminal you cannot steer is not worth the mount.
- **Do not un-bound the row list.** It owns a `max-height` scroll for the reason the band's panels do: N running sessions change scroll depth, never the page's layout.

## Why the mount is re-derived rather than stored

`WorkspaceSessions` keeps `wanted` (what the reader last asked for) in state but resolves the actual mount through `liveExpandedSession(wanted, rows)` on every render. A session the reader expanded can exit, be stopped, or be archived while its terminal is on screen; `["allSessions"]` then stops listing it and its row disappears from under the mount. Stored rather than derived, the card would keep an xterm attached to a dead pty with no row left to collapse it from — a leak the reader has no control over, which is the inverse of the single-mount contract above.

`canMountTerminal` is kept **separate** from that resolver on purpose. A `starting` session is listed (it must be — the KPI tile counts it) but has no pty: the `/ws/term` attach is a documented no-op over a non-existent entry, so the pane would draw blank and read as a broken terminal. The expanded region shows a one-line note in that case. Folding the check into `liveExpandedSession` instead would make such a row collapse itself before it could ever state why it has nothing to draw — and a disabled twist was rejected for the same reason, since its explanation would only be reachable by hover.

## Placement

Between the dashboard `BandDisclosure` and the `Projects` section. Not inside the band: `.loom-bandpanel` pins a 320px height to keep the five tracks one line (card `b4442d27` budgets those tracks), and a sixth track would both break that budget and be far too short for a terminal. Above the grid because the card is **live state** while the grid is navigation, and at rest the card is only its head plus one line per session.

## Verified

- `pnpm build` (46 web unit files + tsc + tsc e2e + vite build).
- `packages/web/test/workspace-sessions.mjs` — hermetic unit coverage of all six derivations.
- `packages/web/e2e/atlas-workspace-sessions.spec.ts` — against the isolated fixture daemon, with seeded sessions.
