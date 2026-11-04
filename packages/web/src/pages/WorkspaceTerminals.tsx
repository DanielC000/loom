import Terminals from "./Terminals";

// THE WORKSPACE TERMINALS NODE — card b439c2dc gave it an address; card 17420720 decided what it
// draws, on the owner's own verdict of the first answer: "atlas terminals page sucks. it should be
// terminal cards in grid like in the old ui."
//
// ⭐ IT IS THE CLASSIC PAGE, MOUNTED — not a port of it, not a shared extraction, not a second
// implementation that resembles it. `pages/Terminals.tsx` was ALREADY a host-parameterised component
// (cards 25c08fba and f3b18f27 made it one so the Atlas PROJECT node could mount it as its Sessions
// tab), and its no-project mount is exactly this page's god-eye grid: every running session as a
// TerminalTile, manager-grouped rows, the project filter, maximize, and the Shells lane above them.
// So there was nothing left to extract — the reuse is the mount itself, which is why this file is
// four lines of render. Anything that should change for BOTH surfaces changes in that one component.
//
// WHY THIS ADDRESS AND NOT `/terminals`. Unchanged from card b439c2dc: under Atlas, `/terminals` was
// taken down to PROJECT depth by card 25c08fba — it is the project node's Sessions tab, routed at
// <ProjectHome/> — so a workspace-tier row pointing there would land on the project node, and
// mounting a second <Route> on one literal path is the precedence contest AtlasShell's own
// REHOMED_TAB_PATHS note forbids. This node is an ATLAS_HOMES row at an Atlas-only path, which the
// classic shell does not mount at all; that is what keeps the classic rail and page untouched.
//
// WHAT THIS MOUNT PASSES, AND WHAT IT DELIBERATELY DOES NOT:
//   • `layoutKey` — yes. The columns picker and the per-tile order write a reader preference, and
//     this is a standing page someone lays out once and comes back to, so it needs a slot of its own.
//   • `projectId`/`projectName` — no, and they must stay unpassed. A cross-project god-eye page has
//     no single project to pre-filter to or to start a session IN, so the quick-start correctly does
//     not render here; passing one would both narrow the page and offer a spawn into a project the
//     reader did not choose.
//
// @decision 17420720 — this page renders by MOUNTING pages/Terminals.tsx. Never fork, copy or
// re-implement its grid, its shells lane or its controls here, and never pass it a projectId.

/**
 * The layout slot this page's grid persists under (`loom.sessionsLayout.workspace`).
 *
 * A fixed literal, and safe as one BECAUSE every project-scoped mount keys on a project UUID — so no
 * real project can ever collide with it. It is deliberately NOT shared with any project's own key:
 * the column count that suits one project's two sessions is the wrong one for the whole fleet's
 * nine, which is the same reason the per-project keys are per-project.
 */
const WORKSPACE_LAYOUT_KEY = "workspace";

export default function WorkspaceTerminals() {
  // The wrapper carries the node's testid so a spec can scope to THIS page rather than to the
  // classic one rendering the identical component at `/terminals`. `loom-atlas-home` is the Atlas
  // content column's own flow class, the same one every other node body wears.
  return (
    <div className="loom-atlas-home" data-testid="atlas-terminals-node">
      <Terminals layoutKey={WORKSPACE_LAYOUT_KEY} />
    </div>
  );
}
