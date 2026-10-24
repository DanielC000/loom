# ff6123de — Wave replay and the inactive-projects tier as the Workspace node's own `replay` tab

Atlas epic `9fe8cd4e`. Unblocks card `5afd71bd` (retire Mission Control and `/projects` as Atlas destinations). Builds on `41eab0eb` (the cross-project surfaces as Workspace node tabs), `d4350286` (the More ⋯ overflow), `c9b78d80` / `baca1835` (the two sibling re-homes that preceded this one).

## What moved

Card `5afd71bd` could not retire `/` while anything lived only there. Two surfaces did:

- **Wave replay** — `AuditReplayPanel` (`components/auditReplay.tsx`), the forensic wave/session audit-timeline scrubber plus run-vs-run diff. Its only mount was a collapsed section at the foot of `MissionControl.tsx`.
- **The inactive-projects tier** — `InactiveFleet`, the muted-FleetCard strip for projects whose whole wave has exited, derived from `GET /api/archived-sessions`, whose only consumer was `MissionControl.tsx`.

Both now render on the Workspace node's own trailing **`replay`** tab (`components/workspaceReplay.tsx`). Neither component was forked: `AuditReplayPanel` is mounted verbatim, and `InactiveFleet` moved out of `MissionControl.tsx` into `components/fleet.tsx` — beside `FleetCard`, which is what it composes — with Mission Control's own mount rendering identically.

## Why a tab, and why the node's OWN tab rather than a re-homed one

`@decision 41eab0eb` requires a `WORKSPACE_NODE_TABS` row's `from` to be a live `NAV_PAGES`/`ATLAS_HOMES` address. Wave replay has no standalone address, so a re-homed row would mean minting a route + an `ATLAS_HOMES` node purely to satisfy that field — the same cost card `baca1835` declined when it put the archived tier on Settings instead.

It does not need one. `HOME_TABS` in `pages/WorkspaceHome.tsx` already declares tabs the node owns outright: no route, no `ATLAS_HOMES` row, no tree node, no widening of the `AtlasHome["key"]` union, and nothing the classic shell can see (it never mounts `WorkspaceHome` at all). `replay` is declared the same way. Overview is the node read operationally, Deck is the same node read board-first, and Replay is the same node read **backwards** — a third reading of one node, which is exactly what `homeTabs()` means in the approved round-4 mockup.

A section of Overview was rejected on three counts, in order of weight:

1. **The default landing would pay for it.** The Replay body is the only thing on this node that reads the archive — two bounded 300-row pages plus the two reserved-home probes. As a tab it is mounted on first visit, so `/home` fetches none of them. As an Overview section it would either fetch them on every landing or need its own open-state gate, which is the machinery the tab replaces.
2. **Vertical room.** Overview already carries the KPI deck, the fleet-controls bar, five band panels and the project grid. A timeline scrubber with a 40vh event stream and a run-diff below it wants the page.
3. **Discoverability.** On Mission Control this was a collapsed disclosure at the foot of a long operational page — maximally hidden. A tab is a declared destination with a label, even when the row folds it into More ⋯.

### It trails the re-homed seven rather than sitting with Overview/Deck

Two reasons, both load-bearing. A forensic tool is the rarest surface on this node, and the More ⋯ overflow folds from the END of the row — so last is precisely the slot that should yield first when the row runs out of width. And `HOME_TABS`' own position is itself a contract: the mockup's `homeTabs().concat(ROOT_TABS)` puts the node's readings FIRST, so inserting a third there would push Inbox and Gates right for a surface nobody opens daily. Hence a separate `REPLAY_TAB` declaration rather than a third `HOME_TABS` entry.

### The two sections are related, which Mission Control never showed

Every inactive project is a finished wave, and every finished wave's manager is a replay subject in the panel above it. On Mission Control these sat at opposite ends of a long page. Putting them on one tab makes the second section literally the first's input set, and the section copy says so.

## The activity cap: MATCHED, at one shared constant

The Workspace node's Pulse band sliced to 40 events; Mission Control's Activity column sliced to 100. Both read the SAME population — the union of every live manager's event stream, cross-project. They now read one constant, `GLOBAL_ACTIVITY_CAP` (`lib/fleet.ts`), at **100**.

Matched rather than justified-apart because Mission Control is the surface card `5afd71bd` retires, and the Pulse band's own exit (`action: { to: "/" }`) points at it. After that card lands, a 40-row band would be 60 rows that became **unreachable**, not merely summarised — which is the loss this card exists to prevent. The band owns a fixed 320px scroll by design, so a deeper list changes scroll depth, not layout (asserted: the band's box stays under 420px with 45 rows of one project's events in it).

**⛔ Not the project-scoped pulse.** `pages/ProjectHome.tsx` keeps its own, narrower cap: a different population (one project), and its `Runs` exit survives card `5afd71bd`. Don't fold the two onto one number.

## Findings measured while building this

- **Mission Control's inactive entry navigates NOWHERE.** The card's DoD asked that the Atlas entry "navigate where Mission Control's did"; measured, a muted `FleetCard` holds no link and its only control is an inert Expand (`onExpand` is a no-op for a project with no live sessions to expand into). The spec therefore asserts an equality of the whole interactive surface — links AND controls — on both surfaces, rather than a guessed destination.
- **Mission Control's whole `<main>` carries ZERO anchors.** Every affordance on it is a button or a programmatic `navigate()`. A `main`-scoped positive control for an href collector is vacuous there; the spec scopes that control to `body` on Mission Control and to `main` on the Atlas side, where the content column genuinely does carry links.
- **`ReplayEvent`'s row clips its trailing timestamp at 420px.** Pre-existing in the shared component and measured on BOTH surfaces at that width (screenshots `replay-tab-420.png` and `control-mission-control-replay-420.png`), so it is not introduced here; Mission Control is in fact worse at that width, overflowing the page horizontally where the Replay tab does not. Left alone deliberately: a row-layout fix would change Mission Control too, and this card re-homes the component rather than forking it.
- **The Pulse band's `Mission ↗` exit is a dangling link for card `5afd71bd`.** It still points at `/`. Re-pointing it is that card's job, not this one's — the Replay tab is not an activity feed and would be the wrong target.

## Do not

- **Do not hoist the Replay body's queries into `WorkspaceHome`'s own query list.** The two archived pages and the two reserved-home probes are exactly what the operational `/home` landing must not pay for; the lazy mount is the whole mechanism.
- **Do not render only the active Replay panel, and do not mount it before it is first visited.** It holds real unfinished work the moment a reader touches it — a chosen subject, a scrub position, an open run-diff — and a tab click is not consent to discard it. Both halves are the same rule `@decision 41eab0eb` states for the re-homed panels.
- **Do not put an inline `display` on the panel wrapper.** It out-specifies the UA's `[hidden]` rule, and the attribute is what keeps the panel out of the accessibility tree and the tab order.
- **Do not give `InactiveFleet`'s `defaultOpen` a default of `true`.** Mission Control mounts the strip UNDER its live fleet grid, and an expanded strip there pushes the active fleet off the fold. Only a host with nothing above it to protect may pass it.
- **Do not re-add a count to the Inactive projects section head.** `InactiveFleet`'s own affordance reads "N inactive project(s)" ~60px below and is BOTH the figure and the control for it; a head count is the same number drawn twice on one screen. The Wave replay head keeps its count because nothing inside that panel states how many waves exist — its `events`/`actors` chips describe the one SELECTED wave.
- **Do not let the two cross-project activity feeds carry a literal cap again.** `test/mission-control-archived.mjs` asserts that both `MissionControl.tsx` and `WorkspaceHome.tsx` reference `GLOBAL_ACTIVITY_CAP` and that neither re-hardcodes 40/100 — with a positive control on `ProjectHome.tsx`, which keeps its literal by design, so the two absence checks are not vacuous.
- **Do not reach a node tab with `getByTestId("atlas-tab-replay")` alone.** `replay` is the last tab in the row and carries the KPI strip, so it folds into the More ⋯ menu (card `d4350286`); measured at 1440, only 5 of the 10 tabs sit in the row when Replay is selected. Use `e2e/helpers/nodeTabs.ts`.

## Shared derivations

Three rules moved into `lib/fleet.ts` so the two surfaces cannot disagree about the same fleet, each covered by `test/mission-control-archived.mjs`:

- `fleetProjectNames(sessions)` — the LIVE population the inactive tier is the complement of. Manager/worker rows only: a project whose sole live row is a companion or setup session has no wave running, so it reads as inactive, which is Mission Control's long-standing behaviour.
- `replayRoots(liveManagers, archivedManagers)` — the picker's subject order (live-then-recency, then the archived feed's own order), de-duplicated by id with the LIVE row winning. Inlines the `lastActivity` DESC key rather than importing `lib/sessions`' `mostRecentActivity`, because `lib/fleet.ts` deliberately carries no relative runtime imports (its hermetic node test loads it standalone).
- `GLOBAL_ACTIVITY_CAP` — above.

## Verification

- `pnpm build` exit 0 (including the 44 web source-text tests).
- **196/196** across all 35 `atlas-*` specs plus `mission-control-wave-replay.spec.ts`, one lane (`--workers=1`), run as two sequential single-lane halves (100 + 96) — never two concurrent lanes.
- `test/mission-control-archived.mjs` 11/11.
- Eyeballed at 1440 and 420; screenshots and the measured layout figures in `$LOOM_PROJECT_WORK_DIR/atlas-restructure/wave-replay/`.
