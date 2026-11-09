# dd83149f — the agent editor dialog never closes over an unsaved draft

Card `dd83149f`, from the Atlas audit (epic `898a64ef`), findings A-04 and A-12.

## What was wrong

- **A-04.** In the Atlas Agents node's editor dialog (`AgentEditDialog`, `components/atlasAgents.tsx`), Escape, a scrim click and × all called the host's `onClose` directly. A typed startup prompt was dropped without a word. That breaks the owner's standing rule: never destroy a user's unfinished input.
- **A-12.** The prompt field was an empty box with no placeholder. Three "saved" labels (agent prompt + grants, Skills, Project Settings → Rebind) rendered on `!dirty`, so an untouched field read "saved" before anything had been saved.

## What we chose, and why

The card offered two shapes: keep the dialog open with an inline bar, or keep the draft in hidden state across close and reopen. **We keep the dialog open.** Every exit goes through `requestClose`. A clean editor closes at once. A dirty one arms `UnsavedCloseBar` ("Unsaved prompt. Save it, or discard it and close?", with Save / Discard and close / Keep editing). This is the board card dialog's existing dirty-close two-step (`pages/Board.tsx` `requestClose` / `pendingNav`).

A draft parked across close is a slower way to lose it. It lives only until the next reload or navigation, and nothing on screen says it exists. A user who closed on purpose also gets back text they meant to throw away. The bar puts the choice in front of the reader at the moment they make it.

The bar's Save writes and dismisses the bar but does not close the dialog. Closing after the save would have to wait on a mutation result the editor does not own (prompt saves go through the global error handler). A close that fires before a refusal is known would throw away the draft the guard exists to keep.

"saved" is now a claim about a save made in this session. The agent editor and Skills record the value each Save wrote and show "saved" only once the persisted value equals it, so a refused write can never read as saved. Rebind uses the mutation's own `isSuccess`.

## Do not

- **Do not close `AgentEditDialog` over a dirty draft without an explicit Discard.** Escape, the scrim and × must all go through `requestClose`. A new exit path that calls `onClose` directly reopens A-04 on that path alone.
- **Do not replace the bar with a draft kept across close.** See above: the draft would vanish on reload, with no sign it was ever kept.
- **Do not make the bar's Save close the dialog** unless the close waits for a confirmed successful write.
- **Do not go back to rendering "saved" on `!dirty` alone** at the three sites this card fixed. An untouched field has not been saved.
- **Do not set the Skills "saved" marker from the "Save to trust" re-save.** It writes the value already served, so a refused re-save would read as saved.

## Not covered

Other `!dirty → "saved"` sites have the same pre-save shape and were out of this card's scope: `AgentPromptEditor.tsx`, `ColumnManager.tsx`, `Board.tsx` (task drawer), `Profiles.tsx`, and two more in `Settings.tsx` (the config editors). Projects' third pane (`pages/Projects.tsx`) hosts the same `AgentEditor` but has no close, so it passes none of the guard props. Selecting another agent there still remounts the editor and drops a draft. That host was not named by the audit.
