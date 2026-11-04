# b439c2dc — the Atlas Terminals node (its ADDRESS; its body was replaced by card 17420720)

Owner intake, verbatim: *"add a terminals page with a terminals page like the one on the current ui.
In the left sidebar place it between home and Platform."*

> ## ⛔ SUPERSEDED IN PART — read this first
>
> This card shipped the node as a single-column, single-mount list and argued below for why it should
> NOT be the classic tile grid. **The owner overruled that**: *"atlas terminals page sucks. it should
> be terminal cards in grid like in the old ui."* Card `17420720` replaced the body — the node now
> renders by MOUNTING `pages/Terminals.tsx` itself.
>
> - **Still true, and still binding:** everything about the node's ADDRESS — why `/workspace-terminals`
>   and not `/terminals`, and why it is an `ATLAS_HOMES` row rather than a `NAV_PAGES` one.
> - **No longer true:** "Why it is NOT the classic grid", the one-terminal-at-a-time contract, the
>   `atRest` reserved seat, the `atlas-terminals-*` testids and the "not redundant with the Workspace
>   node's Sessions card" argument. Those sections are kept below as the record of a decision that was
>   made and then reversed; do not read them as current prohibitions.
>
> Current design, what single-mount means now, and what was deleted:
> `docs/decisions/17420720-atlas-terminals-is-the-classic-grid.md`.

## What shipped

An Atlas-only workspace-tier node at `/workspace-terminals`, labelled **Terminals**, rendered as a
tree row between the Workspace home and the reserved Platform node — the order the owner asked for.
Its body (`packages/web/src/pages/WorkspaceTerminals.tsx`) lists every running session across every
project, with a project filter, and mounts at most ONE of their live terminals.

## Why a new address rather than `/terminals`

The classic rail's Terminals destination is still `/terminals`, and it still renders
`pages/Terminals.tsx` under the classic shell, unchanged. But under Atlas that address was taken down
to PROJECT depth by card `25c08fba`: it is the project node's "Sessions" tab, and `AtlasShell` routes
it at `<ProjectHome/>`. A workspace-tier row pointing at `/terminals` would therefore have landed on
the project node, and mounting a second `<Route>` on one literal path is the unstated precedence
contest `AtlasShell`'s own `REHOMED_TAB_PATHS` note forbids.

So this node follows the precedent card `595e2a47` set for the workspace Settings node: an
`ATLAS_HOMES` row at an Atlas-only path, which the classic shell does not mount at all. That is also
what keeps the classic UI byte-identical — `ATLAS_HOMES` is not in `NAV_PAGES`, so no classic rail
entry, no classic route, no change to `pages/Terminals.tsx`.

## Why it is NOT the classic grid

`pages/Terminals.tsx` mounts one `TerminalTile` per shown session: N live `/ws/term` attaches and N
xterm instances on one page. `CLAUDE.md` names that cost directly — a heavy page that mounts
live-session terminals has frozen the cockpit's CDP renderer — so this node reuses
`components/sessionTerminals.tsx`'s `SessionTerminalList` instead (cards `9b6be377` / `0bcfa530`),
whose whole contract is: nothing mounted at rest, exactly one terminal when a reader asks for one,
and a click on another row MOVES the mount rather than adding a second.

Nothing about the attach itself is re-implemented. The socket, the xterm instance, the pinned pty
geometry, the reconnect ladder and the companion stdin guard are all `TerminalPane`'s, reached through
the one `TerminalCard` variant `SessionTerminalList` is allowed to mount. Detach is mount/unmount:
collapsing the row, filtering its project away, the session exiting, or navigating off the node all
take the single mount down.

## Why it is not redundant with the Workspace node's own Sessions card

Card `9b6be377` gave the Workspace node a Sessions card that mounts the same list, so the two
surfaces are deliberately the same POPULATION (`workspaceRunningSessions`) — they can never state
different counts for the same word. What differs is the room each has. That card is one band on a
deck: a ~272px row track and a 460px terminal. This node is the whole content column, and spends it
on a deeper track, a 620px terminal, and the project filter the deck card has no width for and the
classic god-eye page has always had.

## Do not

⛔ Three of these five no longer bind — each is marked at its own bullet rather than in a header, so
a reader skimming the list cannot pick up a dead rule. The live list is card `17420720`'s own record.

- ~~**Do not render the classic tile grid here**~~ — **OVERRULED by the owner** (card `17420720`).
  The node now IS the classic grid. What replaced this rule: no session's terminal may be mounted
  TWICE.
- **Do not re-point the Atlas tree's Terminals row at `/terminals`.** That address is the project
  node's Sessions tab under Atlas; a workspace-tier row pointing at it lands on the project node.
- **Do not add `/workspace-terminals` to `NAV_PAGES`.** It would put a second Terminals row in the
  classic rail for a user who never opted into Atlas, beside the one that already exists.
- ~~**Do not share this node's testids with the Workspace node's `atlas-session-*` set.**~~ — **MOOT**
  (card `17420720`): the node has no row testids of its own any more. It mounts the classic page, so
  a spec scopes through `atlas-terminals-node` and then reads that page's own `tile-identity` /
  `sessions-grid-*` names.
- ~~**Do not re-derive the running-session predicate here.**~~ — **MOOT** (card `17420720`): this node
  derives no population at all now. `pages/Terminals.tsx` owns the one it has always used, and the
  deck cards keep delegating to `lib/workspaceSessions.ts`'s `workspaceRunningSessions` as before.
