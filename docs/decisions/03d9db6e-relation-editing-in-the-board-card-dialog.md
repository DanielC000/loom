# Editing task relations from the board card dialog

Card `03d9db6e` (owner Atlas feedback round `16106aaf`, Projects › tab "Board"): *"UI Features in board card dialog for users to set and adjust Task relations."*

Before this, the dialog could read every relation (`components/taskLinks.tsx`'s `TaskLinksBlock`, card `1ae4f88c`) and write exactly one hierarchy field — the parent. The four relation kinds were deliberately read-only at the time ("no overkill", card `1ae4f88c`); the owner has since asked for them, so that scoping decision is superseded, not contradicted.

## What the REST surface actually accepts

Checked at the source before any UI was written, because the card said to and because inventing a route would have been the wrong answer: `POST /api/tasks/:id` (`gateway/server.ts`, the human/loopback route the drawer already saves through — a POST, not a PATCH) pulls `parentId`, `blockedBy`, `blocks`, `related` and `discoveredFrom` out of its body as a `TaskStructureInput` and runs them through `planTaskStructure`, the SAME validator the agent-facing MCP tools use. So **all five kinds the card names are writable, and none needed a new route.**

`discoveries` is the one relation the dialog shows that is NOT writable here, and that is correct rather than a gap: it is the inverse projection of some other card's `discoveredFrom`, so no field on *this* card's body can change it. It stays read-only in the links block and the editor never offers it.

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
