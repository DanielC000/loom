# a7f23a2f — inside the Atlas frame, the frame owns the node's identity

Card `a7f23a2f` (Atlas restructure 4 of 11, epic `9fe8cd4e`), on cards `41eab0eb` and `25c08fba`. Closes item 4 of the gap audit (`$LOOM_PROJECT_WORK_DIR/atlas-gap-audit/REPORT.md`), whose clearest pair is `built/13-memory-1440.png` against `mockup/memory-1440.png`: the mockup starts a node tab's content directly under the tab row, with no page title and no description above it.

A page mounted inside the frame is named three times before it renders anything — the crumb trail, the node head's `<h1>`, and its own tab in the node's tab row. A page that then renders its own title + description states one identity twice.

## One hook, not a shared header component — because there is no shared header component

The card asked for one shared mechanism over per-page edits "if the pages share one". They do not: every page in `packages/web/src/pages` hand-rolls its own header inline, in its own markup and at its own type scale. Extracting a `<PageHeader>` across them would be a structural reorganisation of thirteen files to serve a change that removes markup from four — scope the card does not carry and churn a later card would have to re-do when the KPI strip (card 5) and the node head's pills (card 6) move more of this chrome into the frame.

So the shared mechanism is the predicate, not the markup: `useFrameOwnsNodeIdentity()` in `src/lib/atlasNodeHead.ts`, reading the node-head slot context the frame already provides. Four call sites, one declaration, and the next page to adopt it writes one line.

It reads the SLOT, never the Atlas switch (`useAtlasUi`). The switch answers "which shell is this browser rendering"; the slot answers "is THIS mount inside the frame's content region", which is the condition that actually governs and the only one that stays correct for a surface with mounts under both shells. `null` is what every consumer already reads under the classic shell, which renders no node head at all — so the classic path is untouched by construction rather than by a second branch.

The slot is a ref callback's state, so it is `null` on the frame's very first render and the element from the next one on. That costs one extra render at Atlas mount, never a visible flash (React commits the ref and flushes that state before the browser paints) and never a mid-session change, since the extras div outlives every route change inside the frame.

## The audit's "every one of the 13" was an over-count: it is four

Measured off the running app at 1440 before any change (`$LOOM_PROJECT_WORK_DIR/atlas-restructure/card4/before-*.png`), and confirmed against the source — `<h1>` exists in exactly four files in `packages/web/src` (`AtlasShell`, `SetupWizard`, `Gates`, `Memory`):

| Atlas address | its own identity block | `<h1>` count before |
|---|---|---|
| `/memory` | `<h1>◈ Memory</h1>` + description | 2 |
| `/home?tab=gates` | `PageHead`'s `<h1>Gates</h1>` + subtitle | 2 |
| `/home?tab=inbox` | an uppercase `Inbox` label leading its own tab row | 1 |
| `/projects` | `SectionLabel`"Projects" + description | 1 |

Every other mounted classic page — Board, Repository, Runs, Archive, Terminals/Sessions, Automation, Actors, Usage, Settings, Mission Control — renders **no** identity header at all: each opens on a `Segmented`, a filter row or its content. The audit's `h1` fingerprint column reported a title for pages that have none (`CLASSIC-12-repository` → `"Repository"`, where the classic document contains zero `<h1>`), so that column is not a DOM reading and the "~110px on every one of the 13" figure rests on it. The duplication is real; its breadth was not.

## What stays

A suppressed block is the page's **identity**, never its live state or its controls:

- Gates keeps its two occupancy lamps (`0/1 lane busy · 0 queued`). They are live readings of the GateSemaphore that nothing above the page carries — they are what card 6 moves into the node head, not what this card deletes. With the title gone, `margin-left: auto` leaves them at the content column's right edge, where the mockup puts a node's pills.
- Memory keeps its search field, and the entry count its dropped description carried is still read off the page's own foot strip.
- Inbox and Projects keep their tab row and their rail respectively; only the name above them goes.

Projects' description is dropped rather than kept because it points at "Terminals and Overview" — two destinations the Atlas tree no longer has. Under the classic shell, where both still exist, it is unchanged.

## Measured, not reasoned

Three negative controls, each rebuilt and run, every touched file md5-verified back afterwards:

- **The hook forced to `false`** (the minimal revert that leaves the test ids in place): the ON leg goes red naming all six offenders across the four pages — `/memory` and `/home?tab=gates` on the `<h1>` count, all four on the surviving block — and the switch-OFF leg stays **green**. The polarity pair the card's two halves need.
- **The frame's `<h1>` moved out of `.loom-atlas-nodehead`** (its class renamed): every address still reads exactly one `<h1>`, and the ON leg goes red anyway on `0 in the node head`. A build that suppressed the FRAME's heading instead of the page's cannot pass as a fix.
- **One block removed under both shells** (`{false && ownIdentity && …}` in `RequestsPage`): the OFF leg goes red at `/inbox renders no identity header under the CLASSIC shell` while the ON leg stays green — the inverse polarity, proving the switch-OFF leg is not vacuous.

## Do not

- **Do not re-express the predicate as a read of the Atlas switch.** It answers which shell is mounted, not whether this mount is inside the frame, and it is wrong for any surface rendered on both sides.
- **Do not suppress a page's live state or controls along with its identity.** The Gates lamps, the Memory search and every filter row are not identity; the frame does not carry them and nothing else would.
- **Do not assert "exactly one `<h1>`" without also asserting it is the FRAME's.** The count alone passes for a build that dropped the wrong one.
