# eb516fba — tree rows that tell sessions apart, and terminal tiles that stay readable

Atlas audit fixes (epic `898a64ef`): B-22, B-23, B-25, I-04 and I-07 from report B, A-20 from report A. Fixes and polish only.

## What changed

- **Tree session rows (B-22).** Two live sessions of one agent both read "Dev". `lib/sessions.ts` › `sessionRowSuffixes` gives ONLY a repeated name a muted suffix: the card title (commit-type lead dropped), else the branch tail, else the 8-character short id that the tile and the session node head also show. Card titles come from the shared `["tasks", projectId]` cache entry and are fetched only for an open branch that has such a pair.
- **Project row name vs counts (B-22).** `AtlasTree.tsx` › `useNameWinsWidth`: when the counts would clip a project's name, the row goes `is-compact`. The live count keeps only its dot and the "needs you" badge becomes an attention dot. Both numbers stay in the row's screen-reader text and in each mark's `title`.
- **Readable `auto` tiles (B-23).** A pane publishes the daemon's pinned column count (`lib/pinnedGeometry.ts`). `lib/terminalLayout.ts` › `autoGridTemplate` raises `auto`'s tile floor to the width that keeps a `MIN_READABLE_FONT_PX` (10px) font. A row too narrow for two such tiles draws one. At the default 80 columns the template is unchanged. Explicit column counts are the reader's own choice and are not touched.
- **Head branch pill (B-25).** While the git reads are loading, a `pending` placeholder pill holds the space so the row does not shift.
- **Sessions tab locked (I-04).** Inside a project node the bar names the project as plain text. Only the god-eye mounts keep the picker.
- **Retire pair (I-07).** Archive and Delete are now a compact pair aligned right beside the heading. Delete uses `ghost` + `loom-btn-quietdanger`: muted at rest, and the danger colours on hover and keyboard focus. The reveal-then-type-the-name gate is unchanged.
- **Tile header (A-20).** A tile's header row now has an 8px gap, so the short id no longer touches Fork. A manager row header stays on one line: the identity truncates with an ellipsis, and the pill and the "(N workers)" count never shrink.

## Do not

- **Do not derive `auto`'s floor from a pane's CURRENT font.** It is a function of the pinned column count only. A font-based rule would grow the font when the grid drops to one column, which would satisfy the rule again and restore two columns: an oscillation.
- **Do not put a project picker back on the project node's Sessions tab.** It could point the grid away from the node it sits under. The god-eye mounts keep theirs.
- **Do not let `useNameWinsWidth` re-measure from compact mode.** It measures only in full mode, and it re-measures only when the name, the counts or the button's width change. The button's width does not depend on the mode, which is what keeps the decision from feeding back into itself.
- **Do not suffix every session row.** Only a repeated agent name gets one. A branch of distinct agents stays exactly as it was.
- **Do not make Delete loud again, or hover-only.** It is a quiet but visible button, and it takes the danger colours on keyboard focus as well as on hover.
