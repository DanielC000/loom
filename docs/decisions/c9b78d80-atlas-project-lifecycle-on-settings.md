# c9b78d80 — project lifecycle controls on the Atlas project node's Settings tab

Atlas restructure (epic `9fe8cd4e`), unblocking card `5afd71bd` (retire Mission Control and Projects as Atlas destinations). Atlas card 11's investigation found five surfaces living ONLY on the classic `/projects` page, so retiring that destination under Atlas would have lost them outright. This record is where they went and why that shape.

## Do not

- **Do not fork these controls per shell.** `components/projectLifecycle.tsx` is the one implementation of all five (rename, vaultPath, reference repos, repo registry, archive, permanent delete) and of the four writes behind them. `pages/Projects.tsx` and `pages/Settings.tsx` are two FRAMES over it, exactly as `components/agentEditor.tsx` is for the agent editor (card `318b5a21`). A second copy of a permanent-delete confirm drifts from the first inside one card.
- **Do not relax the delete confirm in a new frame.** It is a reveal, then a type-the-exact-project-name gate, over an irreversible cascade. The frame it renders in has no bearing on that, and `atlas-project-lifecycle.spec.ts` asserts a WRONG name still leaves it disabled — not merely that a confirm box exists.
- **Do not give a Settings section its own read of `useAtlasUi()`.** `atlasOnly` is a declarative field on the row; the switch is still read exactly ONCE, at `Settings()`'s own entry. This does not loosen card `595e2a47`'s own prohibition — it is the mechanism that keeps obeying it while letting one row differ per shell.
- **Do not put this section on the classic Settings page.** The classic shell already reaches these controls at `/projects`. Rendering them on its Settings page too would stand up a second, parallel PERMANENT-DELETE site in front of a reader who already has one.
- **Do not move `atlasOnly` away from immediately after `scope` in the declaration.** `e2e/atlas-settings-scope.spec.ts` parses the real `SETTINGS_SECTIONS` block out of the source and only sees the flag in that position; a row that grows it elsewhere parses as `false` and is then DEMANDED on the classic page by that spec's switch-OFF leg.

## Why a new section rather than a new tab

The project node already has eleven tabs (cards `25c08fba`, `d4350286` — enough that the row folds into a "More ⋯" menu at 1440). These controls configure the project itself, which is what the Settings tab already is: `RepoPathEditor` (the repoPath rebind) and `ConfigEditor` sit there, and that rebind is the closest neighbour of the vaultPath edit this card re-homes. A twelfth tab would split one question — where is this project bound, and should it still exist — across two addresses.

Placement inside the section list follows card `595e2a47`'s rule unchanged: a section's scope is the API call its own component MAKES. Every control here calls `updateProject` / `archiveProject` / `deleteProjectPermanent` against the ACTIVE project's id, so the row is `project`-scoped.

## `atlasOnly` — the one row that is not both shells

`SETTINGS_SECTIONS` carries both shells' section lists and has since card `595e2a47`, which filters it by `scope` at the page entry. This card adds a second, orthogonal filter: a row the CLASSIC shell must not render at all.

It is a field on the row rather than a switch read inside the section for the reason `595e2a47` gives — a section that reads the switch grows a second, per-shell idea of where it belongs, and the two can then disagree. The page entry stays the only reader; `atlasOnly` just subtracts from what the classic branch is handed. The Atlas branch does not need to consult it: it filters on `scope === "project"`, and the flag only ever means "not classic".

This is deliberately NOT a general escape hatch. It exists because the classic shell has a FIRST-CLASS home for these controls that Atlas is retiring — not because a section is "more Atlas-ish". A row that cannot name an existing classic home for its own controls does not qualify.

## The frame prop, and why the draft state sits above it

`ProjectManage` takes one prop the two frames differ by: `collapsible`, defaulting to the classic page's shape (a bordered "▸ Manage project" disclosure, closed on mount), so that call site is untouched. The Settings tab passes `false` — the section there already has a `SectionLabel` heading inside a `Panel`, so a second disclosure would be a header under a header, and a collapse would be somewhere for unfinished input to disappear to.

The draft state (`name`, `vaultPath`, the confirm text, whether the delete reveal is open) is declared ABOVE that split and is identical in both shapes. That is load-bearing for the classic page, not incidental: it is what keeps a half-typed rename alive across a collapse. Moving it into the collapsed branch would have been an invisible regression of exactly the "a click is not consent to discard unfinished input" directive the node tabs are built around (card `25c08fba`), and the switch-OFF leg of `atlas-project-lifecycle.spec.ts` pins it.

## What the frame owes the controls

Two things, and only two:

1. **The live-session count** their archive/delete guards disable on. The Settings frame reads it off the SAME `["allSessions"]` key every other surface already polls, so the section issues no request of its own and cannot disagree with the figure the tree and header show.
2. **Somewhere for the active selection to go** when the project it points at stops existing. Dropping the stored id is enough — `ActiveProjectProvider`'s resolver then falls back to the most-recently-active project rather than leaving the app scoped to a row that no longer resolves.

## Not in scope

Restoring an archived project is card `baca1835`. `useProjectLifecycleWrites` already exposes `restore` (the classic page's archived-projects footer uses it), so that card has one place to wire it from rather than a second copy to write.
