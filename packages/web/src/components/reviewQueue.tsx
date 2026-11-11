import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Button } from "./ui";
import { color, fs } from "../theme";

// The review/merge gate's one-click merge action, as the Atlas Needs-you band renders it: "Review →"
// (the full diff pane) and "Approve & merge" (the EXISTING fail-closed daemon merge gate) over existing
// endpoints (/api/sessions/:id/diff + /merge); no new backend, no merge-logic change.

// ── The merge write path, shared by its two renderings ──────────────────────────────────────
// Card c2968651 (Atlas P2-1 parity gap a): the Atlas Needs-you band renders a pending review as a
// compact row rather than as the card below (a band column is ~300px; the card grid is
// minmax(340px,1fr)), and that row needs the SAME one-click merge. So the mutation, the button's
// own wording, and the way its three outcomes are read are declared ONCE here and consumed by both
// — the full card and the compact action — rather than copied into the band.
//
// @decision c2968651 — never give the compact band action its own `api.mergeWorker` call, its own
// outcome branches, or its own button title. One write path, one outcome reader, two renderings:
// a second copy is one that drifts from the fail-closed gate's real semantics.

/** `POST /api/sessions/:id/merge` — the existing fail-closed daemon merge gate. Invalidates the
 *  session feed on success, which is what retires the attention row (its worker stops being live). */
export function useWorkerMerge(workerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.mergeWorker(workerId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["allSessions"] }),
  });
}

export type WorkerMerge = UseMutationResult<Awaited<ReturnType<typeof api.mergeWorker>>, Error, void, unknown>;

/** The button's hover text. One constant because the compact action must not be able to promise
 *  something different from the card about what the click actually does. */
const MERGE_TITLE =
  "Run the build gate and squash-merge without opening the full diff (the same fail-closed gate)";

/**
 * The merge result, read the one correct way.
 *
 * `pending` (merged:null, card 361520a0 Half Four) is a still-RUNNING gate, NOT a rejection — which
 * is why it is checked BEFORE the `!merged` branch, that one being a genuine refusal only.
 *
 * @decision c2182f9d — keep the success line in THIS shared reader; card 3059ce95 widened it to
 * name `commitSubject` when present, never assuming it accompanies every `merged:true`.
 */
export function MergeOutcome({ merge }: { merge: WorkerMerge }) {
  if (merge.data?.pending) {
    return <span style={{ fontSize: fs.sm, color: color.workText }}>still running — {merge.data.reason}</span>;
  }
  if (merge.data && !merge.data.pending && merge.data.merged === false) {
    return <span style={{ fontSize: fs.sm, color: color.danger }}>rejected — {merge.data.reason}</span>;
  }
  if (merge.data && !merge.data.pending && merge.data.merged === true) {
    return <span style={{ fontSize: fs.sm, color: color.liveFg }}>
      {merge.data.commitSubject ? `merged — ${merge.data.commitSubject}` : "merged"}
    </span>;
  }
  return null;
}

/**
 * THE COMPACT VARIANT — the band's second line under a MERGE REQUEST attention row.
 *
 * ⛔ Fetch-free, deliberately. The card below reads the branch diff because its whole body IS the
 * diff analysis; this row shows no diff, so it must not pull one. The Atlas home nodes are composed
 * only from reads another page already makes (ProjectHome/WorkspaceHome's own notes), and a
 * per-pending-review diff fetch would be exactly the N-request fan-out those nodes exist without.
 * `Review →` is still the primary action, so the verification path stays the default and the
 * one-click merge is the deliberate shortcut — not the thing the eye lands on first.
 *
 * @decision c2968651 — do not add a diff read to this row. It would put an N-wide fan-out on a
 * home node for a summary the row does not render.
 */
export function CompactMergeAction({ workerId, onReview }: { workerId: string; onReview: () => void }) {
  const merge = useWorkerMerge(workerId);
  return (
    <div data-testid={`atlas-band-merge-${workerId}`}
      style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
      <Button variant="primary" onClick={onReview}
        title="Open the full branch diff before deciding">Review →</Button>
      <Button variant="default" disabled={merge.isPending} title={MERGE_TITLE}
        data-testid={`atlas-band-merge-go-${workerId}`}
        onClick={() => merge.mutate()}>
        {merge.isPending ? "Merging…" : "Approve & merge"}
      </Button>
      <MergeOutcome merge={merge} />
    </div>
  );
}

