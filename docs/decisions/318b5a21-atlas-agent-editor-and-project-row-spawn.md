# 318b5a21 — the Atlas parity gaps P2-2 could not carry

Card `318b5a21` (Atlas phase 2, epic `9fe8cd4e`), discovered from `c6160c7d` (P2-2). It closes three parity rows P2-2's own worker disclosed as uncarryable, and fixes one defect that card found but did not change.

## 1. The agent editor is MOVED, not copied

Parity rows 16/17/18 (createAgent / updateAgent / deleteAgent on the Agents node) were not built by P2-2 because the editor lived inside `pages/Projects.tsx` and building a second one would be a second editor to keep in step. That reasoning was right; the resolution is to stop it being page-local.

`AgentEditor`, `AgentForm` and `PLAIN_BIND_GROUP_LABEL` now live in `packages/web/src/components/agentEditor.tsx`, together with `useAgentWrites` — the three mutations and their react-query invalidations. `pages/Projects.tsx` imports all four and keeps only its FRAME (the three-pane master → list → detail and what happens after a write in its own pane). `components/atlasAgents.tsx`'s `AgentEditDialog` is the second host: the same editor, in the Agents node's own centred-dialog frame.

### Do not

- **Do not re-implement any part of the editor in a host.** A host picks the frame and supplies the callbacks. Two copies of the `useFormSync` bookkeeping, the two-axis profile-dropdown filter (`isDevLayerRole` visibility × `profileRoleBindsAsPlainSession` grouping) or the live-session delete guard drift apart within one card — which is exactly why P2-2 declined to build the second one.
- **Do not add `meta: { inlineError: true }` to `useAgentWrites`'s mutations without also rendering their `.isError`.** No host renders them today, so the global mutation-error handler (`src/main.tsx`) is what discloses a refused delete; opting out of it and rendering nothing would make a failed delete silent. `packages/web/test/loopback-credential.mjs` runs on every `pnpm build` and fails the other half of that pair.
- **Do not hand `AgentEditDialog` a captured `Agent` object.** It re-resolves the row from the `["agents", projectId]` cache on every render, because the bind `<select>` reads `agent.profileId` and a snapshot taken before an assign-profile write keeps showing the old rig until the dialog is reopened.
- **Do not give the dialog a roster or a spawn control.** Agent definition and agent lifecycle are different jobs; a Delete beside a Spawn is one mis-click from the wrong one.

### A worker rig is editable, and still not spawnable

`atlas-agents.spec.ts` asserted a worker-rig row carried **no buttons at all**. That assertion's real claim was "no LIFECYCLE control" — the node's own footer has always told the reader to *edit the rig here* — so it is narrowed to the spawn control and the danger button, and the rig row now carries an Edit. **Do not re-widen it to a bare `button` count**: that would forbid the affordance the footer promises. **Do not add a spawn or a stop there** — a hand-spawned worker gets a branch nobody is reviewing.

## 2. The project row's `＋` is a SIBLING of the selector button

Round 4's §1 affordance. P1-4 (`e47df20a`) made the project row a `<button>` that re-scopes without navigating, and a `<button>` inside a `<button>` is invalid HTML: the parser closes the outer element at the inner tag, so the row's own selection handler loses the markup under it and the inner control is unreachable by the keyboard. The row therefore gets a `div.loom-atlas-noderow` wrapper and the two controls sit beside each other — the shape `HomeNode`'s own `trailing` slot already used, the one difference being that a project row also has a child list, which stays OUTSIDE the flex row or it is laid out as a third column.

### Do not

- **Do not nest the `＋` inside the selector button.** Measured: with the `＋` nested, `atlas-project-selection.spec.ts` stays GREEN — its `button.loom-atlas-node.is-branch` + `hasText` locator still resolves one element — so P1-4's own spec does not catch this. The structural assertion in `atlas-agent-editor.spec.ts` is the only thing pinning it.
- **Do not give the project-row `＋` the Agents node's default testid.** Measured: it resolves 8 elements on a fixture workspace and `atlas-agents.spec.ts`'s quick-spawn test dies with a strict-mode violation. `AgentsQuickSpawn` takes a `testId` stem for this reason; the project rows pass `atlas-project-quickspawn-<projectId>`.
- **Do not let opening the `＋` re-scope the app.** It is `projectId`-addressed and acts on the row's own project, whichever project is active. The Roster exit INSIDE the dialog does re-scope, deliberately — it is an explicit navigation to a node that is scoped to the active project, so without it a reader would land on a different project's roster than the dialog just showed them.

## 3. The Operators slot stays read-only

Decided, not built. The Workspace node's Operators panel remains a readout with exits to the surfaces that own each operator's lifecycle (`@decision c6160c7d`). Go-live controls there would need the Platform Lead's edition + singleton gating (`pages/platformEdition.ts`, `pages/PlatformView.tsx`) moved into a shared component first — a larger decision with its own blast radius, recorded as a note on the P3 parity checklist (card `f3cabed2`) rather than taken here.

## 4. The go-live guard's `starting` hole — confirmed, and fixed on both surfaces

P2-2 suspected it; this card reproduced it. Both spawn surfaces asked `processState === "live"`, so for the whole of a spawn's own startup — the row sitting at `starting` — the guard read "nothing is running", left the spawn split-button enabled, and a second click minted a SECOND manager session. `SessionService.startNew` has no guard of its own (it inserts a fresh `starting` row for any agent, however many are already up), so the client-side predicate was the only thing between a double-click and two orchestrators on one project.

The predicate is now `holdsGoLiveSlot` in `packages/web/src/lib/sessions.ts`, called by `pages/Overview.tsx`'s `liveSessionFor` and by `lib/atlasAgents.ts`'s `rosterAgent`. Two presentation helpers travel with it — `goLiveHeldControl` (the held button says "Starting…", not "Live") and `goLiveSessionPill` (the pill says "starting", amber, not a settled phosphor "live").

### Do not

- **Do not re-spell this test inline in a surface.** A surface that goes back to a bare `=== "live"` reopens the double-spawn, and only on that surface — which is the divergence P2-2 carried the narrow form verbatim to avoid. The fix for that concern is the same rule applied to the correct form, not to the broken one.
- **Do not widen the editor's DELETE guard to this predicate.** `AgentEditDialog` counts `processState === "live"` for `liveCount` because that mirrors what the DAEMON refuses a delete for; widening it client-side disables a button the server would have allowed. The two guards answer different questions.
- **Do not take the held button's `atlas-agent-live-<id>` testid as a claim about the label.** It addresses THE HELD CONTROL; a `starting` manager is held for the same reason a live one is.

## Verification

`pnpm build` exit 0. `pnpm --filter @loom/web test:e2e atlas platform setup settings smoke board companion` green serially. Five negative controls, each with the build exit code checked so vite genuinely re-emitted, each restored md5-identical:

| Control | Reverted | Outcome |
|---|---|---|
| A | `holdsGoLiveSlot` → `=== "live"` (+ its unit block) | build exit 1 at `sessions.mjs`; with the unit block removed, build exit 0 and **1 of 5** e2e RED at the CLASSIC shell's held button |
| B | the `＋` nested inside the selector button | **1 of 5** RED at the no-nested-button assertion; `atlas-project-selection.spec.ts` stayed GREEN |
| C | the roster card's `onEdit` dropped | **1 of 5** RED (the editor test); the worker-rig Edit test stayed GREEN — a split, so the two Edits are separate measurements |
| D | the project-row `＋` on the shared default testid | **2** RED: this card's own test, and `atlas-agents.spec.ts`'s quick-spawn on a strict-mode violation resolving 8 elements |
| E | `useAgentWrites`'s `update` loses its `["agents"]` invalidation | **1 of 5** RED at the roster's rig line, which is what proves the re-profile assertion reads a real write |

Two defects were found by EYEBALLING, not by any assertion: the Atlas roster's meta line printed a literal `"live"` under a pill reading `starting` (empty vitals fell back to a hardcoded string), and the editor dialog's prompt textarea collapsed to one line (a `flex:1` child of a content-sized panel resolves to its content, so the body needed a real `minHeight`).
