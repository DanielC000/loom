# baca1835 — the archived-projects tier gets a Workspace-tier home in Atlas

Atlas restructure (epic `9fe8cd4e`), unblocking card `5afd71bd` (retire Mission Control and Projects as Atlas destinations). Card `c9b78d80` re-homed five of the six surfaces that lived only on the classic `/projects` page; this is the sixth, and the one whose loss would have been worst. `api.archivedProjects` had exactly one consumer in the whole web source (`pages/Projects.tsx`), so under Atlas a soft-archived project would have become invisible AND unrestorable — which silently converts a reversible archive into a permanent delete.

## Do not

- **Do not put this section on the classic Settings page.** The classic shell already reaches these controls from the `/projects` rail's own "Archived · N" footer. Rendering them on its Settings page too would stand up a second, parallel PERMANENT-DELETE site in front of a reader who already has one. The row is `atlasOnly` for exactly this reason, and `atlas-settings-scope.spec.ts`'s switch-OFF leg asserts its absence rather than skipping it.
- **Do not give the archived list its own confirm in a new frame.** The type-the-exact-name prompt now lives INSIDE `ArchivedProjects` (`components/projectLifecycle.tsx`), not in either host. Before this card the classic page built the `window.prompt` + compare + alert at its own call site; a second host would have meant a second copy of a permanent-delete confirm, which is the drift card `c9b78d80` forbids. `atlas-archived-projects.spec.ts` asserts a WRONG name leaves the project archived, not merely that a prompt appeared.
- **Do not change the confirm's MECHANISM to match `ProjectManage`'s inline reveal.** The two are deliberately different shapes of the same gate: a panel can render an inline reveal with a disabled button, an archived row cannot. Because there is now ONE implementation shared by both frames, "upgrading" the prompt would change the classic page too — which this card's own DoD forbids.
- **Do not move `atlasOnly` away from immediately after `scope` in the declaration.** `e2e/atlas-settings-scope.spec.ts` parses the real `SETTINGS_SECTIONS` block out of the source and only sees the flag in that position; a row that grows it elsewhere parses as `false` and is then DEMANDED on the classic page by that spec's switch-OFF leg. (Inherited verbatim from card `c9b78d80` — this is the second row to carry the flag.)
- **Do not give `ArchivedProjectsPanel` an inner `SectionLabel` repeating the section's own label.** `SettingsColumn` already draws it. A second copy is a header under a header, and it breaks `atlas-settings-scope.spec.ts`, whose sweep asserts a section's label appears exactly ONCE inside its own wrapper.

## Why a Workspace Settings section rather than a Workspace node tab

The card offered both. A `WORKSPACE_NODE_TABS` row needs a live `NAV_PAGES`/`ATLAS_HOMES` address to re-home FROM (`@decision 41eab0eb`), so an "Archived" tab would have meant minting a whole new Atlas-only node, route and page component to host a list whose every row is a name and two buttons — and it would have pushed the Workspace node's nine-tab row deeper into the "More ⋯" overflow (card `d4350286`), hiding a rarely-visited surface behind a menu for no gain.

A section costs one row in an array that already exists, and the surface it joins is the right one on its own merits: Disk Reclaim is already a daemon-global housekeeping panel on that page whose primary control irreversibly destroys something on this host. The archived tier is the same kind of thing — a list you visit when you want to undo or finish a retirement — and it reads as such beside it.

## Scope: `workspace`, and this one is not a judgement call

Card `595e2a47`'s rule is that a section's scope is the API call its own component MAKES, never what its title suggests. Three of that card's nine rows needed an argument rather than a lookup. This row needs neither:

- the read is `GET /api/projects/archived`, daemon-global, taking no project id;
- both writes (`restoreProject`, `deleteProjectPermanent`) name a row OF that list, not the active project.

It would in fact be *wrong* on the project node, for a reason stronger than scope bookkeeping: a project you are currently scoped to is by construction not archived, so the project tier can never be the place you go to restore one.

## Placement within the section list

Immediately above Disk Reclaim. That puts the two panels capable of irreversibly destroying something together, below every routine editor — and above rather than below it, because Disk Reclaim's own stated reason for being last still holds: it is the only panel whose PRIMARY control deletes. This panel's primary control is Restore; the delete is the secondary action behind a typed-name gate.

## What moved, and what deliberately did not

`ArchivedProjects` moved verbatim out of `pages/Projects.tsx` into `components/projectLifecycle.tsx`, beside the `ProjectManage` panel and the four writes it shares. It takes the same one frame prop `ProjectManage` does — `collapsible`, defaulting to `true` — so the classic rail's call site renders exactly as before: a bordered "▸ Archived · N" disclosure, closed on mount. The Workspace Settings section passes `false`.

Two changes to the component beyond the move, both deliberate:

1. **The confirm came with it.** It was host code; it is now the component's, so both frames ask the same question over the same cascade from one place (see Do-not above). `deletePrompt` stays exported so a spec can assert the copy rather than re-typing it; its doc comment was corrected at the same time — it claimed `ProjectManage` shared it, which was never true (`ProjectManage` states the cascade in its own inline reveal).
2. **An empty line.** `No archived projects.` is reachable only in the un-collapsed frame: the classic rail mounts this component at all only while the list is non-empty, whereas a Settings section is a fixed address that has to say nothing is there. Classic therefore renders identically in every state it can reach.

What did NOT change: the rows carry no live-session guard and no per-row pending state. The classic list had neither, an archived project cannot have a live session (archiving requires stopping its fleet first), and adding either would have changed the classic page's rendering to no end.

`ArchivedProjectsPanel` passes no `onArchived`/`onDeleted` hook, unlike the project-lifecycle section beside it. That section needs one because it acts on the ACTIVE project and has to drop a selection that just stopped existing. Nothing in this list can be the active project, so there is no selection to clear.
