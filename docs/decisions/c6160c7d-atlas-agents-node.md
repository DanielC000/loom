# The Atlas Agents surfaces (card `c6160c7d`, Atlas P2-2)

Round 4 of the UI overhaul exists because the owner asked one question of round 3's mockups: *"how are the spawnable agents spawned for projects? I dont see a UI element for that?"* (card `939922ee`). The diagnosis was that round 2's inventory enumerated **destinations** and never enumerated **actions** — every page had a home, the controls on those pages did not. This card builds the answer: a roster on the page you land on, a node that holds the whole thing at full size, and a quick-spawn that needs no navigation at all.

What follows is the handful of decisions that are not obvious from the code, and the things a later card must not undo.

## Where the node lives, and why it is not a `NAV_PAGES` entry

The Agents node is a third row in `ATLAS_HOMES` (`packages/web/src/nav.tsx`), not an eighteenth `NAV_PAGES` destination.

`NAV_PAGES` is mounted by **both** shells, and the classic rail renders one link per entry. An Agents entry there would put a new destination in the classic Instrument Rail for every user who never opted into Atlas — which is precisely what "behind the switch" forbids (`docs/plans/atlas-ui/03-decomposition.md`, the preamble: with the switch at its default, a phase-2 card's diff is observable nowhere in the running app). `ATLAS_HOMES` is the one declaration in that file `LegacyShell` deliberately does not map, so it is the only correct home for an Atlas-only address.

That list was named for its first two members, which are tier heads. It now carries a node that is not one, so `AtlasHome` gained `tierHead`:

- `tierHead: true` — the node **is** its tier, so the crumb trail stops at the tier and the heading is the tier's own name ("Workspace", or the active project's). Appending the row's "Home" label would name a node that is already the crumb before it.
- `tierHead: false` — an ordinary node **within** the tier, whose own `label` is the deepest crumb and the heading, exactly as a `NAV_PAGES` destination at that depth behaves. That is what a reader sees, so it is what the frame says.

### Do not

- **Do not add any `ATLAS_HOMES` row to `LegacyShell`'s route table**, and do not re-point `/` or `/overview` at one. (`@decision fd99b2d7` already states this; the Agents row inherits it unchanged.)
- **Do not move the Agents node into `NAV_PAGES`** before phase 3's switch-over. It would appear in the classic rail the same day.
- **Do not let the tree's extra-node check go unfed.** `e2e/atlas-tree.spec.ts` asserts that every tree node with no classic-rail equivalent is declared in `ATLAS_HOMES`, parsed out of the real source. A node added anywhere else fails there, loudly, which is the point.

## The go-live guard is reused, not redesigned

`lib/atlasAgents.ts`'s `managerLive` keys on `session.processState === "live"`, carried verbatim from `pages/Overview.tsx`'s own `liveSessionFor`, **not** on `lib/atlasHome.ts`'s `isLiveSession` (which also counts `starting`).

The two predicates genuinely differ, and a `starting` manager is a real window in which the Atlas roster would offer a second spawn where the classic Overview would not — or the reverse, if this were widened. The guard is a behavioural contract this card is *reusing*; phase 2 rebuilds placement, never behaviour. Narrowing or widening it is a change to what a human may do, and belongs on its own card against both surfaces at once.

### Do not

- **Do not "unify" this on `isLiveSession` in passing.** It changes when a manager may be double-spawned, and it changes it in Atlas only, which is a divergence no test in phase 2 is set up to catch.

## The quick-spawn is a centred dialog, not a tree pop-over

Round 4 drew the quick-spawn as a floating panel. The Atlas tree cannot host one: `.loom-atlas-treebody` is `overflow-y: auto`, and CSS computes a `visible` overflow on one axis to `auto` when the other is not `visible` — so an absolutely-positioned panel anchored to a tree row is clipped on **both** axes, not just vertically. The mockup's own panel hangs off a `Spawn +` button in the node head, which is shell chrome the Atlas frame does not have and which this card has no business adding.

A centred dialog is the grammar this app already uses for exactly this shape (`role="dialog" aria-modal` over a scrim, Escape and outside-click to close — `pages/Board.tsx`, `components/requests.tsx`, `components/SetupWizard.tsx`), it cannot be clipped, and it keeps the actual promise: spawn without first navigating anywhere.

The `＋` itself is **always visible, dim at rest**, rather than revealed on hover as the mockup drew it. It is the one control that answers the question this whole card exists to answer; an affordance that only exists under a pointer answers it for nobody on a touch screen and is the last thing a reader finds on a desktop.

The dialog reads the roster; the trigger does not. The tree is mounted on every Atlas route, so a roster read in the trigger would be two requests on every page the classic shell does not make.

### Do not

- **Do not re-anchor this to the tree row** without first giving `.loom-atlas-treebody` a non-clipping overflow — which would cost the tree its own scroll.

## What this card deliberately does not build

**Agent CRUD.** Round 4 homes `createAgent` / `updateAgent` / `deleteAgent` to "the Agents node → agent editor". This card does not build that editor. P2-2's own DoD is the spawn surface, the editor is a substantial one that already exists on `pages/Projects.tsx` (a tree node away under phase 1), and a second one is a second thing to keep in step — the exact duplication the plan's one hard rule exists to prevent. The node's head carries a direct exit to it instead, and the parity rows stay open for a card of their own.

**A second go-live control for the standing operators.** The Workspace root's `Operators` panel is a **readout** with an exit to the surface that owns each operator, not a spawn surface. A Platform Lead's spawn is gated by the install's edition and a singleton rule that live on the Platform node (`pages/platformEdition.ts`'s `operatorSpawnDisabled` / `resolveOperatorSpawnRole`, rendered by `pages/PlatformView.tsx`); a Companion is provisioned by a wizard, not a split button. Re-implementing either here would be a thinner copy of a trust-boundary gate, placed where nothing tests it against the original.

This also matches the stance `pages/ProjectHome.tsx`'s own fleet panel already takes: a band panel is a status read, never a second place to act on a session.

**A `＋` on the project tree row.** The project row is a `<button>` (card `e47df20a` — selecting a project re-scopes without navigating), and a button nested inside a button is invalid HTML and unreachable by keyboard. Giving it one means restructuring that row into a flex pair, which is a change to the selection control this card does not own.

### Do not

- **Do not put a spawn or stop control on the Operators panel.** If the owner wants one there, it belongs on a card that moves the real gating into a shared component first.
