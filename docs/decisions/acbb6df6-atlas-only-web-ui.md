# acbb6df6 — Atlas is the only web UI; where the classic-only surfaces went

Card `acbb6df6`. Owner directive in chat, 2026-11-11 (request `76db10b1`): "before the push I want to remove the old UI." That directive is the sign-off both plan rows P3-switch-over and P3-retire required (`docs/plans/archive/atlas-ui/03-decomposition.md`), and it folds them into one card with no default-flip and no safety-net release.

## What was removed

The classic shell (`LegacyShell` in `App.tsx`, the rail `components/Sidebar.tsx` and its CSS), the switch (`lib/atlasUi.ts`, `AtlasSwitchNotice`, the Settings "Which UI" control, the frame's "Switch to the classic UI" button, the "preview" badge), and every switch-conditional branch: the classic Companion and Platform layouts, the standalone review page header, the session page header, the Command Palette's classic rows, `SETTINGS_SECTIONS`' `atlasOnly` flag. Three pages went with the shell: Mission Control (`/`), Projects (`/projects`) and the classic project Overview (`/overview`).

A browser that still stores `loom.atlasUi` is unaffected: nothing reads the key, in any value (`e2e/atlas-only-shell.spec.ts` exercises each shape the old reader accepted).

## The legacy addresses

Every removed address is a plain `LEGACY_REDIRECTS` row (`src/nav.tsx`), query preserved: `/`, `/projects` and `/workspace` → `/home`; `/overview` → `/project`. `ATLAS_RETIREMENTS` and `atlasRetirementFor` are gone — with one shell there is nothing for an "Atlas-only" redirect to be the opposite of. `/workspace` used to chain through `/projects`; it now goes straight to `/home`, and `test/deep-link-query.mjs` fails on any row that chains through another.

## How completeness was checked

Two scans, because the first was not enough.

1. **Per module.** An import graph from `main.tsx` with the classic-only edges cut left exactly four classic-only modules (Sidebar, MissionControl, Projects, Overview). Every `api` write member called in them also had a caller in an Atlas-reachable module. Positive control: the same scan found `api.updateTask` in `pages/Board.tsx`.
2. **Per JSX mount.** Scan 1 cannot see a component that lives in a SHARED module but was MOUNTED only by a classic page: `components/mergeGate.tsx` was Atlas-reachable (Settings imports its cadence panel), so `MergeGateStrip`'s write looked covered when nothing in Atlas rendered it. The second scan lists every component the deleted files rendered and checks something still renders it. That is what found the merge gate (below).

The board needed one explicit check of its own, because the owner's primary board was the one embedded in the classic Overview. The Atlas project node carries the same `<Board>` component as its Board tab (the Home-tab embed was removed by card `269f46ef` on the owner's own "Remove Board."). Measured: an identical board testid inventory on both mounts, and the drag, reorder, multi-select, lane, keyboard and card-dialog specs green on `/board` under Atlas. **What changes is co-location:** the classic Overview showed Terminals, Board and Fleet on one page; the project node splits them across its Home, Sessions and Board tabs.

## The merge gate's new homes

`MergeGateStrip` and `MergeGateAttention` were mounted only by the classic Overview. Both are re-homed UNCHANGED, with the props Overview passed, and split by what each is for:

- **`MergeGateAttention` → the project node's Home tab**, inside the "Needs you" card, and counted in its figure. It is the alert that a periodic gate failed (the default branch is unverified and every merge stays gated). It renders nothing while the gate is healthy, so a healthy Home tab is visually unchanged.
- **`MergeGateStrip` → the project Settings tab**, directly above `MergeGateCadencePanel`. It carries the live status counts, the gate-log link, its own inline cadence editor, and "Gate the next merge" — the only caller of `api.gateNextMerge`. The inline editor overlaps the panel beside it; that is kept deliberately in this card, which re-homes and does not redesign.

### Why the alert is NOT on Settings

The alert never enters the shared attention feed (`useAttention`), so the Inbox, the request pill and the browser notifications never carry it. Wherever it is mounted is the ONLY place a human can learn the gate failed. Settings is a page a reader opens to change something, not one they watch; an alert there would be seen only by someone already looking for it. The Home tab's "Needs you" card is where everything else that needs a decision about this project is listed, which is the classic Overview's own placement (its "Attention" section) carried to its Atlas equivalent.

## The e2e suite

The rule: a test whose SUBJECT no longer exists is deleted; a test whose capability survives is PORTED to its Atlas home. Deleted legs, each because its subject went with the classic shell:

- `commit-message-switches`: "the same note renders on the Atlas Overview board embed". The `<Board projectId>` embed on `/overview` was deleted with `Overview.tsx`, and card `269f46ef` forbids re-embedding the board on the project node, so there is no embed left to port it to. The ship-state note stays covered by the spec's `/board` leg.
- `atlas-shell-chrome`: "toggling the switch REMOUNTS the chrome" (the switch is gone).
- `atlas-tree-drawer`: the leave-to-classic button's width and wording asserts (the button is gone).
- `atlas-tree-rows-and-tiles`: the classic leg of the 390px overflow loop.
- `segmented-focus-ring`: the classic companion `ModeToggle` leg (the Atlas node's modes are its link tab row, not a segmented track). Its Interface-switch leg was ported to the theme switch, the same `Segmented` control.

Two traps the ports hit, for whoever ports the next one:

- **A section name reads twice on the Workspace Settings tab.** Its section index (`settings-index-*`) repeats every section's name, and the entity tree and breadcrumb repeat session and request names. Scope to `settings-section-*` or `#atlas-content`.
- **The session node renders its terminal `height="auto"`.** A spec measuring HUG-mode geometry (the pane height the font solver writes) reads a meaningless clip there; measure a grid tile instead (`terminal-resize-at-rest`).

## Deliberate, owner-visible losses

- **Mission Control's wave-consumption roll-up** (`WaveConsumption`: "consumption Nk ctx · peak NN%" per project in the expanded fleet panel) is gone. It was read-only. Atlas shows context per session (the roster, the session node head, the worst-context reading on the project node), not this per-project sum.
- **The Projects page's one-shot create form** (blank project + board preset + optional template-agent seed). Project creation is the Platform node's guided setup wizard, whose "Start with an empty project" path creates a blank project without a template; board columns are set afterwards on the project Settings tab. Verified by driving both.

## Do not

- **Do not mount `MergeGateAttention` only on the Settings tab.** It is the sole surface of a failed-gate alert; see above.
- **Do not bring a page back at `/`, `/projects`, `/workspace` or `/overview`.** Each is a redirect to the node that carries its surfaces.
- **Do not reintroduce a per-browser UI switch or read `loom.atlasUi`.** A stored value must stay inert.
- **Do not trust a per-module write scan alone for a removal like this.** A shared module can be reachable while one of its components is mounted nowhere; check mounts as well.
