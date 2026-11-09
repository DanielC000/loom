# 006ed11f — the project Overview speaks one status vocabulary, and its empty and board-summary states lead somewhere

Card `006ed11f` (Atlas audit epic `898a64ef`, child of audit B, findings B-10, B-11, B-20, G-04, G-07, I-06). Fixes and polish only; no surface was added, removed or summarised.

## What changed

- **B-10, one vocabulary.** "Work in flight" read each session through `sessionStatus` (`components/fleet.tsx`: rate-limited / exited / starting / waiting on you / working / idle). The "Sessions" card one card down read the same session through `goLiveSessionPill` (`starting` / `working` / `live`) and never consulted pending Requests, so one orchestrator read "waiting on you" in the first card and "working" in the second, and an idle worker read "idle" then "live". `SessionTerminalList` now calls `sessionStatus` with the same `usePendingDecisionsBySession` read. Because that list is shared, the Workspace node's Sessions card speaks the same words too.
  - The reason the row used `goLiveSessionPill` (card `318b5a21`, recorded on `9b6be377`) was to avoid `TileTitle`'s "idle over a `starting` row". `sessionStatus` checks `processState` before `busy`, so a starting row still reads "starting" (muted, not the settled green).
  - The row's state cluster `min-width` grew from 168px to 204px so the new widest pair, "waiting on you" + "◆ Manager", keeps every row's name on one x at desktop width.
- **B-11.** Below 560px a session row is two lines: identity first, the state and role pills under it. Nothing is dropped.
- **B-20.** `.loom-ovcard-foot` is sans at `fs-sm`, `text-3`, with the text (not the box, so the rule still spans the card) held to 72ch.
- **G-04.** An empty "Work in flight" says why it is empty and offers the step: "＋ New agent" (the Agents node's own `AgentEditDialog`, no second editor) and, once an agent exists, "Spawn" (the node head's own `AgentsQuickSpawn`, so the go-live guard is inherited).
- **G-07.** Each lane-legend chip is a link to `/board?lane=<key>`. `pages/Board.tsx` consumes `?lane=` under the same `deepLinks` gate as `?task=`, scrolls the lane into view, rings it for 1.6s, and clears the param.
- **I-06.** Already fixed before this card by `104a31a4` (the ask has its own two-line clamped line). Verified at 390, no change made.

## Do not

- **Do not give `SessionTerminalList`'s row a status function of its own.** One session, one word on one page. If a state needs a new label, add it to `sessionStatus` so every reader gets it.
- **Do not drop the role badge at narrow width to make room.** Stack instead; the audit offered both and the stacked form keeps every fact.
- **Do not let a hidden Board mount consume `?lane=`,** and do not remove the lane ring in an effect cleanup: clearing the param re-runs the effect at once and would wipe the ring before it paints.
- **Do not turn the lane legend into a board.** It is access only; the summary shape is the owner's ruling on `269f46ef`.
