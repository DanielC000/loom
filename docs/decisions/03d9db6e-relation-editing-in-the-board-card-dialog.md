# Editing task relations from the board card dialog

Card `03d9db6e` (owner Atlas feedback round `16106aaf`, Projects › tab "Board"): *"UI Features in board card dialog for users to set and adjust Task relations."*

Before this, the dialog could read every relation (`components/taskLinks.tsx`'s `TaskLinksBlock`, card `1ae4f88c`) and write exactly one hierarchy field — the parent. The four relation kinds were deliberately read-only at the time ("no overkill", card `1ae4f88c`); the owner has since asked for them, so that scoping decision is superseded, not contradicted.

## What the REST surface actually accepts

Checked at the source before any UI was written, because the card said to and because inventing a route would have been the wrong answer: `POST /api/tasks/:id` (`gateway/server.ts`, the human/loopback route the drawer already saves through — a POST, not a PATCH) pulls `parentId`, `blockedBy`, `blocks`, `related` and `discoveredFrom` out of its body as a `TaskStructureInput` and runs them through `planTaskStructure`, the SAME validator the agent-facing MCP tools use. So **all five kinds the card names are writable, and none needed a new route.**

`discoveries` is the one relation the dialog shows that is NOT writable here, and that is correct rather than a gap: it is the inverse projection of some other card's `discoveredFrom`, so no field on *this* card's body can change it. It stays read-only in the links block and the editor never offers it.

## The parent left the links block too (card `6ed6d8b2`)

This card moved the four writable kinds out of `TaskLinksBlock` so no edge was drawn twice — and left the PARENT behind, out of scope, still stated in the block AND again in the editor's parent summary ~150px below. That was the one duplicate this card's own fix did not reach, and card `6ed6d8b2` closed it.

**The rule decided the answer, not a preference between the two sites.** The block's membership criterion is already written down: *what this card cannot write about itself* (`CONTEXT_RELATION_KINDS`'s doc comment — `discoveries` is another card's field, a child's parentage lives on the child). The parent fails that criterion outright: this very dialog writes it, through the same `POST /api/tasks/:id` body as the four. So the parent never belonged in the block once the editor existed; it survived only because `03d9db6e` was scoped to relation *kinds*. Keeping the block's copy and dropping the editor's was never the alternative — the editor's copy is the one attached to the control that performs the write, and separating a relation's display from its control is exactly what this card's "a second place for the same write to diverge" reasoning rules out.

**The click-through moved with it, and got strictly better.** Before, the block's row was the clickable one (a `TaskLinkRow`) and the summary was plain text — the parent was the ONE relation in this dialog whose editable statement you could not click through. The summary now renders the same `TaskLinkRow` the editor's chips do, so all five kinds read and behave alike, and `edit`/`clear` sit where a chip's `×` sits.

**The gate had to move with the row, for the second time.** Dropping the row without dropping `l.parent !== null` from `hasTaskContextLinks` would draw an empty bordered box for a card whose only edge is a parent — the identical failure this card's own doc comment already warns about for `blockedBy`. Measured: a parent-only card now renders no block at all (`board-hierarchy.spec.ts`).

### Do not

- **Do not re-add a bucket to `TaskLinksBlock` because it is also rendered read-only somewhere.** Membership is "this card's own write body cannot change it", not "it happens to be read-only today". Both times a kind left this block, the reason was that the dialog writes it.
- **Do not drop a row from the block without dropping its term from `hasTaskContextLinks` in the same change.** Twice now the gate has been the half that was almost forgotten, and the symptom — an empty bordered box — is silent in every assertion that only checks what the block contains.
- **Do not give the parent summary's link an unbounded shrink.** `TaskLinkRow` brings a `flexShrink: 0` lane badge that the plain text it replaced did not have; with that badge beside two word-buttons, a 420px panel ellipsised the parent's title to FOUR characters (measured). The row wraps `edit`/`clear` onto a second line instead, via a modest `minWidth` floor on the link — a wrap is decided on the hypothetical size, before shrinking, so the floor is what makes it fire. Keep the floor modest: a floor wider than a typical title reserves dead space at 1600 and recreates the "controls belonging to nothing" the chips were shaped to avoid.

### Still true, and not a duplicate

One card can legitimately be named twice in this dialog — the fixture in `board-hierarchy.spec.ts` has an epic that is both the subject's parent and its `discoveredFrom`. That is two EDGES, one occurrence each, and the spec asserts exactly that shape (two dialog-wide, one of them the parent row's). The defect was ever drawing the SAME edge twice.

## The parent row and the editor share one label column (card `e8e6d91e`)

Once card `6ed6d8b2` made the parent summary the dialog's ONE statement of the parent, and gave it the same `TaskLinkRow` the editor's chips use, the section read as five relation rows — and the parent's value started 63px left of the other four (measured, 1600px, classic and Atlas alike). The parent was a plain flex row, so its value sat at `width("PARENT") + 4`; the editor was a `minmax(74px, auto) 1fr` grid whose column auto-sized to "DISCOVERED FROM", putting its values at ~104 + 10. Nothing was wrong with either rule on its own; there were simply two of them in a block that reads as one list.

**The constraint ruled out the obvious fix, and that was right.** The natural move is to make the parent another row OF the editor's grid — but this card's own "a second place for the same write to diverge" reasoning forbids a parent editor inside `TaskRelationsEditor`, and `TaskRelationsEditor` returns several top-level elements (the graph-error line, the rows grid, the picker / `＋ Add relation…`), so hoisting a shared grid container around it would push each of those into a grid cell too. Both roads end at a structural change to the component boundary for a layout defect.

**So the two grids share a WIDTH instead of a container:** `RELATION_LABEL_COL` (112px) plus `relationGrid` and `relationRowLabel`, declared once in `components/taskRelationsEditor.tsx` and imported by `pages/Board.tsx`. The parent summary becomes a two-cell row on that same geometry; nothing about the editor's internals, its props, or any testid changes. The label column stops being content-sized, which also means it no longer moves when a row appears or disappears, or when Space Grotesk finishes loading over the fallback face.

**The accepted costs, both measured rather than assumed.** A fixed column is as wide as the widest label whether or not that row is present, so a card showing only "RELATED" now indents ~56px further than before. And at 420px the parent's value gives up that same ~56px to the shared column, so its title ellipsises sooner than it did under `6ed6d8b2`'s floor — unavoidable for ANY shared column, since the column must clear "DISCOVERED FROM". The wrap behaviour itself is intact: `edit`/`clear` still drop to a second line, now under the name rather than under the label, because the wrap happens inside the grid's value cell.

**The number is only safe because something checks it.** A label is `nowrap`, so one that outgrows 112px overflows into the value beside it rather than wrapping — silent on screen until it collides. `board-relations-grid-align.spec.ts` asserts, at both widths and in both shells, that the five values start at one x AND that no label's `scrollWidth` exceeds its column.

### Do not

- **Do not put either grid's label column back on an `auto`/`max-content` track.** They are two separate grids in the same column; each would size from its own labels and the values would diverge again. Change `RELATION_LABEL_COL` if a label needs more room — never one side's template.
- **Do not add or rename a relation label without re-running `board-relations-grid-align.spec.ts`.** It is the only thing standing between a longer label and a silent collision with the value beside it.
- **Do not give the parent summary its own copy of the grid style.** It imports `relationGrid`/`relationRowLabel` from the editor precisely so there is one declaration; a look-alike literal is the same two-rules defect written more convincingly.

## Do not

- **Do not send a `released:true` item back in a `blockedBy`/`blocks` write.** It is auto-released deferral history: `declared:false`, not live (`buildRelationView`'s `releasedOnly`). The write replaces the DECLARED bit of a card's blocks edges, so including a released item promotes dead history to a live declared dependency. `relationBaseline` (`lib/taskRelationsEdit.ts`) drops them; `releasedHistory` returns them separately so the UI can still show them, muted and with no remove control.
- **Do not drop a merely `resolved` item.** The opposite case, and the symmetric trap: a resolved edge IS declared — its blocker simply landed. Excluding it from the baseline would delete a real edge as a side effect of the user adding an unrelated one.
- **Do not send a relation kind the user did not touch.** `relationPatch` emits only changed kinds. A whole-set write of an unchanged kind is a no-op at best; at worst it re-declares a released edge the baseline deliberately dropped, or clobbers an edge an agent wrote while the dialog sat open.
- **Do not seed the draft from `links` at mount.** The relation view rides on the single-task read, which resolves AFTER the dialog mounts — a mount-time initializer captures empty arrays and never catches up, so every kind would read as empty and compare as a pending CLEAR of everything. Same hazard, same remedy as the Parent field: `null` draft = untouched, display falls through to the live server value, and the draft is snapshotted off the baseline on the first edit.
- **Do not let the picker's Esc reach `window`.** The dialog's own Esc-to-close listener is a native `window` handler; React's synthetic `stopPropagation` does not stop it, because React's delegated listener sits on the root container and the native event keeps bubbling to `document`/`window` afterwards. Closing the picker without closing the whole dialog needs `e.nativeEvent.stopPropagation()` — the synthetic call alone is decorative here.

## Where a server validation error goes

The validator's messages are already written to be acted on ("drop one of the edges", "attach it to `<id>` (its own parent) instead"), and they name the field or the cycle path. `relationErrorTarget` reads that prefix (`blockedBy: …`, `parentId: …`, `blocks cycle (…)`) and decides WHERE to render it — at the offending row, at the section head for a graph-wide cycle, or `null` for anything unrecognised, which falls through to the generic line beside Save. It never rewords: the message renders verbatim wherever it lands, and an unrecognised message is never swallowed.

## The dialog is shared with the classic UI, by construction

There is ONE `<Board>`, mounted by all four Atlas board surfaces and by the classic `/board` page (card `a6d7a102`), so there is one dialog and this editor appears in both shells. That is unavoidable short of forking the component, which would be worse. Nothing shell-conditional was added: the classic dialog gains the same section and every other classic behaviour is untouched. The empty-state cost is one section label plus one ghost `＋ Add relation…` line — the links block above it still renders nothing at all for a card with no connections, which is what `board-hierarchy.spec.ts`'s no-hierarchy control asserts.
