# b439c2dc — the Atlas Terminals node is a single-mount list, not the classic tile grid

Owner intake, verbatim: *"add a terminals page with a terminals page like the one on the current ui.
In the left sidebar place it between home and Platform."*

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

- **Do not render the classic tile grid here, and do not mount a second terminal beside
  `SessionTerminalList`'s.** One attach at a time is this page's whole performance contract; a "show
  all terminals" affordance would put the cockpit freeze one click away.
- **Do not re-point the Atlas tree's Terminals row at `/terminals`.** That address is the project
  node's Sessions tab under Atlas; a workspace-tier row pointing at it lands on the project node.
- **Do not add `/workspace-terminals` to `NAV_PAGES`.** It would put a second Terminals row in the
  classic rail for a user who never opted into Atlas, beside the one that already exists.
- **Do not share this node's testids with the Workspace node's `atlas-session-*` set.** The two
  surfaces render the same population, so a shared stem makes a passing spec prove nothing about
  which page it was looking at.
- **Do not re-derive the running-session predicate here.** Delegate to
  `lib/workspaceSessions.ts`'s `workspaceRunningSessions`, or this node and the deck card drift into
  listing different things under one word.
