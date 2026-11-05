# d5946e05 — a stale board-column Save is refused when the board's key set drifted

Settings › Board Columns seeds its rows once and Save PUTs the WHOLE array to `PUT /api/projects/:id/columns`. `planColumnLayout` reads every current key absent from the request as REMOVED and re-homes its cards to the default landing. So a column an agent created (`board_column_create`) while Settings was open was silently deleted by the human's next Save, and its cards moved. Reproduced daemon-side before the fix (`column-stale-save.mjs`, section A pins the legacy behaviour).

## Decision

- `PUT /columns` takes an OPTIONAL `baseKeys: string[]` — the keys the staged layout was based on. When present, `SessionService.updateBoardColumns` compares it (as a SET, order-insensitive) with the board's current keys **inside the same synchronous read-check-write as the plan**, and on any difference writes nothing and the route answers `409 {error, code:"columns_drifted", columns, added, removed}` (`columns` = the board as it stands now).
- **Absent `baseKeys` = today's blind replace** (back-compat: `Projects.tsx` preset apply is a deliberate wholesale replace; external REST callers; the only "old client" is a stale browser tab, which a reload fixes). An explicit `[]` counts as PRESENT and drifts against any real board.
- **Key-set only.** The data loss is key removal / re-homing. A same-key edit by an agent (label, role, WIP, accent) is NOT detected and stays last-write-wins, exactly as before. Also not detected: an agent moving cards into a lane the human is deleting (the key set is unchanged); the editor's live card count (4 s poll) is the only warning there.
- The MCP column tools call `updateBoardColumns` directly with no `baseKeys`, so they are unchanged.
- Web (`ColumnManager.tsx`, pure merge in `lib/columnDrift.ts`): on a 409 nothing is dropped and nothing is re-created. Server columns the editor never saw are appended as ordinary rows (before the terminal lane); a staged row whose column was removed elsewhere is KEPT, flagged on the row ("Removed elsewhere — Save will re-create this lane"), with its server identity cleared. The human reviews and presses Save again — that second Save is the only write.
- The editor's pure reorder stays a staged edit saved through the same PUT; it is NOT rerouted through `PUT /columns/order` (redundant once `baseKeys` exists).

## Do not

- Do not make `baseKeys` mandatory on the route: it breaks preset apply and every external caller, and needs a UX decision of its own.
- Do not move the drift check out of `updateBoardColumns` into the route (or before the service call): it must stay atomic with the write.
- Do not have the web auto-retry the Save after a 409, nor re-create a removed-elsewhere lane without the flagged row the human can ✕.
- Do not reseed the editor from the 409 body (that drops the staged edits); merge via `mergeDriftedColumns`.
