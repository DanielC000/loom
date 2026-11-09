# 1ae4f88c — the card-drawer's context section: placement and the no-placeholder choice

The UI half of the owner-directed board-hierarchy phase 1 (data/REST half is card `3df86c87`). The card
drawer's context section (children, plus the relation kinds the card cannot write about itself) answers
"what is this card connected to".

**Placement, superseded by card `92259dac` (Atlas audit I-01):** it first sat directly under the dossier
header, above the edit body. Once the parent and the four writable relation kinds moved into the
Relations editor (cards `03d9db6e`, `6ed6d8b2`), that left an epic's Children list ABOVE its Title. It now
sits inside the edit column straight after the Relations editor, so the dialog reads Title, Priority,
then the card graph (parent, relations, children, and the "+ Add child card" control).

## Do not

- Do not reserve space for this section with a loading placeholder. It renders nothing at all when the
  card has no links — the common case — so a placeholder would flash an empty panel on every single
  drawer open, which is worse than the block simply appearing once it lands. (A done card waits on that
  same read anyway via `TaskDrawerLoading`, so its links are already there when the drawer draws.)
