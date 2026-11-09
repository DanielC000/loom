// The card dialog's Worker row (card fa4234ab, Atlas audit B finding G-01): who is on this card, and the
// two hops out of it — the worker's session and, while a merge request is pending, its review diff.
import type { MouseEvent as ReactMouseEvent } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { SessionListItem } from "@loom/shared";
import { api } from "../lib/api";
import { hasPendingMergeRequest, workerReviewPath, workerSessionPath } from "../lib/cardWorker";
import { StatusPill } from "./ui";
import { color, font, fs, radius, type Tone } from "../theme";

const linkStyle = {
  borderRadius: radius.base, padding: "4px 12px", fontFamily: font.ui, fontSize: fs.body, fontWeight: 500,
  textDecoration: "none", whiteSpace: "nowrap", flex: "none",
} as const;

export function CardWorkerRow({ worker, status, onNavigate }: {
  worker: SessionListItem;
  /** The same pill the board card shows for this worker, so the two never disagree. */
  status: { tone: Tone; label: string; glow?: boolean; solid?: boolean };
  /** Called on a link's click before navigation; the dialog uses it to hold a dirty card for its discard
   *  confirm (it calls `preventDefault` when it does). */
  onNavigate: (path: string, e: ReactMouseEvent) => void;
}) {
  // The worker's MANAGER's event stream, under the exact key and fetcher the attention queue uses — so it
  // is one shared cache entry (pushed over /ws/fleet), never a second poll. A worker with no parent has no
  // manager to have filed a merge request, so there is nothing to read.
  const managerId = worker.parentSessionId ?? null;
  const events = useQuery({
    queryKey: ["orchEvents", managerId],
    queryFn: ({ signal }) => api.orchestrationEvents(managerId!, signal),
    enabled: !!managerId,
  });
  const reviewPending = hasPendingMergeRequest(events.data, worker);
  const sessionPath = workerSessionPath(worker.id);
  const reviewPath = workerReviewPath(worker.id);

  return (
    <div data-testid="card-worker-row"
      style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "6px 8px",
        border: `1px solid ${color.line}`, borderRadius: radius.base }}>
      <span style={{ fontFamily: font.ui, fontSize: fs.xs, color: color.text2 }}>Worker</span>
      <StatusPill tone={status.tone} label={status.label} glow={status.glow} solid={status.solid} />
      <strong style={{ fontFamily: font.ui, fontSize: fs.sm, fontWeight: 600, color: color.text, whiteSpace: "nowrap" }}>
        {worker.agentName}
      </strong>
      {worker.branch && (
        <span title={worker.branch}
          style={{ flex: "0 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            fontFamily: font.mono, fontSize: fs.mono, color: color.text3 }}>
          {worker.branch}
        </span>
      )}
      <span style={{ flex: 1 }} />
      {/* Review first: while a merge request waits it is the thing to do next, so it takes the accent. */}
      {reviewPending && (
        <Link to={reviewPath} className="loom-btn loom-btn-primary" style={linkStyle} data-testid="card-worker-review"
          title="Open this branch's diff to review the merge request" onClick={(e) => onNavigate(reviewPath, e)}>
          Review diff <span aria-hidden>↗</span>
        </Link>
      )}
      <Link to={sessionPath} className="loom-btn loom-btn-default" style={linkStyle} data-testid="card-worker-session"
        title={`Open ${worker.agentName}'s session`} onClick={(e) => onNavigate(sessionPath, e)}>
        Open session <span aria-hidden>↗</span>
      </Link>
    </div>
  );
}
