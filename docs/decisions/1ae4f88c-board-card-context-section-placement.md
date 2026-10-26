# 1ae4f88c — the card-drawer's context section: placement and the no-placeholder choice

The UI half of the owner-directed board-hierarchy phase 1 (data/REST half is card `3df86c87`). The card
drawer's parent/children/relations section sits directly under the dossier header and above the
two-column edit body — it answers "what is this card connected to" in the same register as the header's
own id/priority/lane chips, not as another editable field.

## Do not

- Do not reserve space for this section with a loading placeholder. It renders nothing at all when the
  card has no links — the common case — so a placeholder would flash an empty panel on every single
  drawer open, which is worse than the block simply appearing once it lands. (A done card waits on that
  same read anyway via `TaskDrawerLoading`, so its links are already there when the drawer draws.)
