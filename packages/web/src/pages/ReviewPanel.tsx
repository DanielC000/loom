import { useParams } from "react-router-dom";
import { useAtlasUi } from "../lib/atlasUi";
import { useLatchedSession } from "../lib/useLatchedSession";
import { ReviewSurface } from "../components/ReviewSurface";
import { SessionNode } from "../components/SessionNode";

// `/review/:workerId` — the human-in-the-loop review & merge gate. The surface itself lives in
// components/ReviewSurface.tsx; this file only decides which SHELL's shape it takes.
//
// CLASSIC: the standalone page it has always been, header row and all.
//
// ATLAS: `nav.tsx`'s PARAM_PAGES declares this URL to BE the worker node's Diff tab, so the address
// renders the whole session node with Diff selected — the terminal's tab row above it, the bound task,
// wakes, queue and composer inline below. Rendering the review surface alone here would leave the Diff
// tab and this URL as two different pages wearing the same crumb trail (card 525c8ad9).
//
// @decision 525c8ad9 — never branch this page's render on whether the worker's row resolved: a
// successful merge is exactly what makes it stop resolving, and the branch flip remounts the review
// surface, discarding the result banner it had just produced and any note typed beside it.
//
// WHICH RULE THIS ADDRESS USES FOR A NON-LIVE ROW, stated because it deliberately differs from
// `/session/:id`'s: THIS address renders the node whatever the row's processState, because a review
// outcome has to stay readable after the merge that ended the session. `/session/:id` keeps its
// live-or-starting gate (SessionView), because a node whose terminal cannot attach is an ended-session
// record, not a session node. The two agree at the seam: the node's Terminal tab links to
// `/session/:id`, where that gate is the thing that answers.
export default function ReviewPanel() {
  const { workerId = "" } = useParams();
  const [atlasOn] = useAtlasUi();
  const worker = useLatchedSession(atlasOn ? workerId : "");

  if (!atlasOn) return <ReviewSurface key={workerId} workerId={workerId} />;

  return (
    <SessionNode
      key={workerId}
      // Before anything has resolved there is still a node to draw, and the ROUTE itself is the
      // authority for the two fields that shape it: this id, and that it names a worker. Nothing else
      // is invented — the state cluster renders as "unknown" rather than guessing (see SessionNode).
      session={worker ?? { id: workerId, role: "worker" }}
      tab="diff"
    />
  );
}
