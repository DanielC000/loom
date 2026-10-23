# 5968d7e0 — the Atlas node head's pills and actions

Card `5968d7e0` (Atlas restructure 6 of 11, epic `9fe8cd4e`), on card `0d0c6cee`. Closes item 6 of the Atlas gap audit (`$LOOM_PROJECT_WORK_DIR/atlas-gap-audit/REPORT.md`).

The frame's node head has carried an `<h1>` and a `preview` badge since card `525c8ad9`, and an extras slot that only a SESSION node ever filled. The round-4 V2 mockup puts a node's live state beside that heading as pills, and its primary action at the row's right edge. This card fills that slot for the two home nodes, adds the one session pill that was missing, and removes an occupancy readout that card `7874e8c2` had just made redundant.

## What shipped

| Node | pills | actions |
|---|---|---|
| project (`ProjectHome`, every tab) | `<N> working` · `<branch> <sha8>` | `Spawn +` |
| workspace (`WorkspaceHome`, every tab) | `<N> working` | — |
| session (`SessionNode`, both states) | the existing busy/harness/context cluster **plus** `gen <N> · <M> turns` | unchanged (Fork / Stop / maximize) |

`AtlasNodeHead` (`components/atlasHome.tsx`) is the one portal into the slot; it renders nothing when the slot is `null`, which is what every consumer reads under the classic shell, so the classic path is untouched by construction rather than by a second branch — the same contract `useFrameOwnsNodeIdentity` reads (card `a7f23a2f`).

## A head pill is a state reading, never a KPI

This is the load-bearing rule, and it is what keeps the head off ground the row below already holds. Card `7874e8c2` put the six-figure `KpiStrip` on every node tab but Overview, and Overview carries the full `KpiDeck` about 50px under the tab row. So a pill restating one of those six figures is the same number twice on one screen — the shape round 3 shipped as "readouts as pills on the tab row" and the owner rejected (card `939922ee`, recorded in `KpiDeck`'s own "SIZE IS THE FEATURE" note).

`<N> working` is therefore a **busy** count, not a live one. The `mgr · workers` tile beside it is a live count split by role; a live agent parked on its manager counts there and not here. Measured on the shipped build against a seeded 2-busy-of-3-live fleet: the pill reads `2 working`, the tile reads `1/2`, and the node has 3 live sessions — three different numbers, which is what makes the claim checkable rather than asserted. `<branch> <sha8>` appears nowhere else on the node at all.

The two rows are also drawn as different kinds of object: `.loom-atlas-headpill` is round (999px) with a tinted ground and no `text-transform`; `.loom-kpipill` is square with an upper-cased leading label. Looking at `/memory` at 1440 (`$LOOM_PROJECT_WORK_DIR/atlas-restructure/card6/after-project-memory-1440.png`) the two read as a state row over a figure row, not as one readout repeated.

### Where this departs from the mockup, deliberately

The mockup's own `VIEWS` declaration (`Mockups/2026-10-19 UI Overhaul Round 4/atlas.js`) gives **every** view its own `sub` string, and several of them are exactly the duplication above:

- `board` → `16 open · 7 lanes`, beside a strip pill reading `16 OPEN CARDS`;
- `inbox` → `4 waiting on you`, beside `4 NEEDS YOU`;
- `gates` → `cap 2` + `1 running`, beside `1·2 GATE RUN·QUEUED`;
- `root-overview` → `7 live` + `5 projects`, which are two of that node's own six KPI **tiles**;
- `memory`/`runs`/`archive`/`agents` → `84 notes`, `12 runs`, `101 archived`, `3 spawnable`, each restating the count already printed on that tab in the tab row.

The mockup can afford this because its tab row **clips** rather than wraps (`mockup/memory-1440.png` cuts off at "Memory 8" and loses Runs, Archive and Settings entirely), so its pills are partly standing in for tabs the reader cannot see. The built row wraps instead (card `7874e8c2`'s own note), so nothing is hidden and the restatement buys nothing.

So the node head carries NODE-level readings, constant across that node's tabs, and no per-tab pill ships.

## `More ⋯` did not ship

The card names the `Spawn + / More ⋯` cluster. `Spawn +` shipped; `More ⋯` did not, and this is the reason rather than an omission.

Every row the mockup's `More ⋯` draws (`index.html` `#pop-more`) is a navigation target: Repository, Memory, Runs, Archive, Automation, Project settings, Usage. In the built Atlas all seven are already visible as tabs on the same node, one row below the button — cards `41eab0eb` and `25c08fba` re-homed them there — so the menu would be a second copy of the tab row. It exists in the mockup for the same reason the duplicated pills do: that tab row clips.

There is a variant that WOULD earn the button — an overflow that moves the least-used tabs into it so the row can return to one line, recovering the 39px card `7874e8c2` measured as the cost of wrapping beside a six-pill strip. That changes the tab model and wants an owner call; it is not this card.

## The Gates occupancy lamps: removed inside the frame, not moved into the head

Card `a7f23a2f`'s record hands these to this card ("they are what card 6 moves into the node head, not what this card deletes"), on the premise that "nothing above the page carries them". **That premise expired when card `7874e8c2` landed in between.** `/gates` is a workspace node TAB, so the strip now rides its tab row and already reads `<running>·<queued> GATE RUN·QUEUED` off the same GateSemaphore.

Measured at 1440 on `/home?tab=gates` before this change, the occupancy was stated three times in one column:

1. the strip pill — `0·0 GATE RUN·QUEUED`;
2. the page header's two lamps — `0 / 1 LANE BUSY` and `0 QUEUED`;
3. the body's Semaphore line — `0 of 1 lane busy · 0 queued · maxConcurrentGates 1`.

Moving (2) into the node head would have closed the gap to (1) from ~40px to ~60px rather than removed the repeat. (3) is a strict superset of (2) — it names the cap as well — and is unconditional, so dropping the lamps inside the frame loses nothing. `PageHead` now returns `null` whenever the frame owns the node's identity; under the classic shell, where no strip exists, the whole head including both lamps is byte-unchanged.

## `Spawn +` reuses the dialog and the guard; it does not re-express either

`AgentsQuickSpawn` gained one prop, `trigger: "plus" | "button"`, defaulted so both tree mounts are byte-identical. The node head's trigger opens the SAME `QuickSpawnDialog`, whose rows are the SAME `AgentActions`, so the go-live guard is inherited rather than restated — the single-declaration rule `components/atlasAgents.tsx` opens with, written after round 3 shipped a second copy with no guard at all.

It carries its own testid stem (`atlas-nodehead-spawn`) because the tree mounts a quick-spawn too and one shared id resolves both.

The **workspace** node gets no spawn cluster. Its spawnable things are the standing operators, which card `c6160c7d`'s record keeps as a readout on this node rather than a second place to start or stop one, and the node has no project to spawn into.

## Two reads this card adds, and why they are the only ones

`<branch> <sha8>` needs `["git-branches", id]` and `["git-log", id]` — the same keys and fetchers `pages/Git.tsx` already uses, so the Repository tab's Git pane shares the cache rather than re-fetching. They are the only reads on `ProjectHome` not already made for something else: `staleTime: 30_000` (a repo head moves on a merge, not on a tab click) and `retry: false`, because the expected failure — no repo bound, or a repo with no commit yet — is permanent and the pill's answer to it is to render nothing.

The branch is **read**, never assumed to be `main`. The mockup's `main 57143a90` is that repo's own name for it; `git init` takes the first branch name from the host's `init.defaultBranch`, so this card's own e2e fixture is `master` on the machine it was built on and would be `main` on another.

## Measured, not reasoned

Four negative controls, each rebuilt (`pnpm build` exit code checked every time — a tsc failure deletes `dist` and makes the whole spec fail for the wrong reason, which happened twice here before the controls compiled) and every touched file md5-verified back afterwards:

- **A — `AtlasNodeHead` fed no pills and no actions**: legs 1, 2, 3 and 7 RED; the session-pill leg, the Gates leg and the switch-OFF leg GREEN. A split, which is what proves the OFF leg is not vacuous.
- **B — the working pill wired to the `mgr · workers` figure**: leg 1 alone RED, at the pill's own text. The pill is checked against a value the spec chose, not against "something rendered".
- **C — the Gates lamps restored inside the frame**: the Gates leg RED on two lane-occupancy statements where one is required; the switch-OFF leg stayed GREEN, so the change is scoped to the frame rather than a blanket deletion.
- **D — `genReadout` dropped from the live-session branch**: the session leg alone RED.

## Do not

- **Do not put a figure from a node's own `kpis` array into its head pills.** The strip carries all six on every tab but Overview and the deck carries them on Overview, so it would be the same number twice within ~50px — the exact shape card `939922ee` was filed against.
- **Do not add a per-tab pill because the mockup has one.** Most of the mockup's per-view `sub` strings restate that tab's own count or a strip figure; its tab row clips where the built one wraps.
- **Do not re-add the Gates lamps inside the Atlas frame, and do not move them into the node head.** The node's KPI strip carries running·queued on that very tab row, and the body's Semaphore line carries all three figures including the cap.
- **Do not give `AgentsQuickSpawn` a second dialog or a second guard for the button trigger.** The `trigger` prop chooses a trigger shape; everything behind it stays one declaration.
- **Do not hardcode `main` in the head pill.** The branch is read from the repo, and the fixture that proves it reads its own branch back off git for the same reason.
