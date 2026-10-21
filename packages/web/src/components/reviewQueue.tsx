import { useNavigate } from "react-router-dom";
import { useQueries, useQuery, useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type { SessionListItem } from "@loom/shared";
import { api, workerDiffQuery } from "../lib/api";
import { analyzeDiff, riskTone, type DiffAnalysis } from "../lib/diff";
import { Panel, Button, Chip, Dot, SectionLabel } from "./ui";
import { color, font, radius, tone } from "../theme";

// MISSION CONTROL CENTERPIECE — the review/merge gate as a fast-triage surface. Each worker branch
// awaiting a human merge becomes a rich card: an auto-summary line, diff stats, a risk badge, and the
// top risk files inline, plus one-step "Review →" (the full diff pane) and "Approve & merge" (the
// EXISTING fail-closed daemon merge gate). The bottleneck is verification, so this puts the diffs that
// need a human decision at the top of the page, ranked by risk. Pure presentation over existing
// endpoints (/api/sessions/:id/diff + /merge); no new backend, no merge-logic change.
//
// Partition seam: this is the diff/merge review pane's home in Mission Control. The sibling
// fleet-observability / audit-replay card owns the Fleet + Activity regions below — keep them apart.

// showLabel (default true) — Mission Control keeps the "Review queue (N)" SectionLabel; the project
// Overview reuses this SAME component to restyle its Attention merge cards but suppresses the label,
// so the cards nest directly under Overview's own "Attention" heading without stacking two headers.
export function ReviewQueue({ workerIds, showLabel = true }: { workerIds: string[]; showLabel?: boolean }) {
  const navigate = useNavigate();
  const sessions = useQuery({ queryKey: ["allSessions"], queryFn: api.allSessions });
  const all = sessions.data ?? [];

  // One diff fetch per pending review. Pending reviews are few (the parallel ceiling is ~3-8), so this
  // is a handful of small requests; react-query keys + caches them and the panel shares the cache with
  // the full ReviewPanel, so opening one is instant. The card's own body IS the diff analysis (headline,
  // ±, top-risk files), so this fan-out is content, not speculative prefetch — it can't be deferred to an
  // expand without gutting the card. The 8s refetchInterval is what keeps these cards live; the shared
  // staleTime (workerDiffQuery, 10s — up from a local 4000) only governs MOUNT/focus refetches, so this
  // component's live cadence is unchanged while a remount inside the window now serves the cache.
  const diffs = useQueries({
    queries: workerIds.map((id) => ({
      ...workerDiffQuery(id),
      refetchInterval: 8000,
    })),
  });

  // Rank cards: the riskiest, largest changes first (where a human should look hardest).
  const cards = workerIds.map((id, i) => {
    const q = diffs[i];
    const worker = all.find((s) => s.id === id);
    const data = q?.data;
    const analysis = data ? analyzeDiff(data.patch) : null;
    return { id, worker, analysis, loading: q?.isLoading ?? false, error: q?.isError ?? false };
  }).sort((a, b) => {
    const ar = a.analysis, br = b.analysis;
    return (br?.highRisk ?? 0) - (ar?.highRisk ?? 0)
      || (br?.mediumRisk ?? 0) - (ar?.mediumRisk ?? 0)
      || ((br?.totalInsertions ?? 0) + (br?.totalDeletions ?? 0)) - ((ar?.totalInsertions ?? 0) + (ar?.totalDeletions ?? 0));
  });

  return (
    <div>
      {showLabel && <SectionLabel>Review queue ({workerIds.length})</SectionLabel>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: 12, alignItems: "start" }}>
        {cards.map((c) => (
          <ReviewCard key={c.id} workerId={c.id} worker={c.worker} analysis={c.analysis} loading={c.loading} error={c.error}
            onReview={() => navigate(`/review/${c.id}`)} />
        ))}
      </div>
    </div>
  );
}

// ── The merge write path, shared by both renderings of it ──────────────────────────────────────
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
 * @decision c2182f9d — keep the success line in THIS shared reader, and keep it bare (`merged`: no
 * subject, no reason). A per-rendering confirmation drifts from the gate's real semantics, and
 * `api.mergeWorker`'s declared response carries no subject while the green path sets no `reason`.
 */
export function MergeOutcome({ merge }: { merge: WorkerMerge }) {
  if (merge.data?.pending) {
    return <span style={{ fontFamily: font.mono, fontSize: 11, color: color.cyan }}>still running — {merge.data.reason}</span>;
  }
  if (merge.data && !merge.data.pending && merge.data.merged === false) {
    return <span style={{ fontFamily: font.mono, fontSize: 11, color: color.red }}>rejected — {merge.data.reason}</span>;
  }
  if (merge.data && !merge.data.pending && merge.data.merged === true) {
    return <span style={{ fontFamily: font.mono, fontSize: 11, color: color.phosphor }}>merged</span>;
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

function ReviewCard({ workerId, worker, analysis, loading, error, onReview }: {
  workerId: string;
  worker?: SessionListItem;
  analysis: DiffAnalysis | null;
  loading: boolean;
  error: boolean;
  onReview: () => void;
}) {
  const merge = useWorkerMerge(workerId);

  const accent = analysis?.highRisk ? color.red : analysis?.mediumRisk ? color.amber : color.phosphor;
  const topRisk = (analysis?.files ?? []).filter((f) => f.risk !== "low").slice(0, 3);

  return (
    <Panel style={{ display: "flex", flexDirection: "column", gap: 8, borderLeft: `3px solid ${accent}` }}>
      {/* identity */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontFamily: font.mono, fontSize: 12, color: color.text }}>w:{workerId.slice(0, 8)}</span>
        {worker?.taskId && <Chip label="task" value={worker.taskId.slice(0, 8)} />}
        <span style={{ flex: 1 }} />
        {worker?.projectName && <span style={{ fontFamily: font.head, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: color.textMuted }}>{worker.projectName}</span>}
      </div>
      {worker?.branch && <span style={{ fontFamily: font.mono, fontSize: 11, color: color.cyan, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{worker.branch} → main</span>}

      {/* auto-summary + stats */}
      {loading && <span style={{ fontFamily: font.mono, fontSize: 12, color: color.textMuted }}>loading diff…</span>}
      {error && <span style={{ fontFamily: font.mono, fontSize: 12, color: color.red }}>diff unavailable (no branch / merged)</span>}
      {analysis && (
        <>
          <div style={{ fontFamily: font.mono, fontSize: 12, color: color.textDim, lineHeight: 1.45 }}>{analysis.headline}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontFamily: font.mono, fontSize: 12 }}>
            <span style={{ color: color.text }}>{analysis.files.length} file{analysis.files.length === 1 ? "" : "s"}</span>
            {analysis.totalInsertions > 0 && <span style={{ color: color.phosphor }}>+{analysis.totalInsertions}</span>}
            {analysis.totalDeletions > 0 && <span style={{ color: color.red }}>−{analysis.totalDeletions}</span>}
            <span style={{ flex: 1 }} />
            {analysis.highRisk > 0 && <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: color.red }}><Dot tone="red" glow />{analysis.highRisk} high-risk</span>}
            {analysis.highRisk === 0 && analysis.mediumRisk > 0 && <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: color.amber }}><Dot tone="amber" />{analysis.mediumRisk} to watch</span>}
            {analysis.highRisk === 0 && analysis.mediumRisk === 0 && <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: color.phosphor }}><Dot tone="phosphor" />low risk</span>}
          </div>

          {/* top risk files inline */}
          {topRisk.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 2, borderTop: `1px solid ${color.border}`, paddingTop: 6 }}>
              {topRisk.map((f) => (
                <div key={f.path} style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: font.mono, fontSize: 11 }}>
                  <Dot tone={riskTone(f.risk)} glow={f.risk === "high"} />
                  <span style={{ color: color.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }} title={`${f.path} — ${f.reasons.join(", ")}`}>{f.path}</span>
                  <span style={{ color: tone[riskTone(f.risk)], fontSize: 9, textTransform: "uppercase", letterSpacing: "0.06em" }}>{f.risk}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* actions */}
      <div style={{ display: "flex", gap: 8, marginTop: "auto", paddingTop: 4 }}>
        <Button variant="primary" onClick={onReview} style={{ flex: 1 }}>Review →</Button>
        <Button variant="default" disabled={merge.isPending} title={MERGE_TITLE}
          onClick={() => merge.mutate()}>
          {merge.isPending ? "Merging…" : "Approve & merge"}
        </Button>
      </div>
      <MergeOutcome merge={merge} />
    </Panel>
  );
}
