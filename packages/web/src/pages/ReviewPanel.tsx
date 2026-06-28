import { useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { contextWindowForModel, CONTEXT_WARN_RATIO } from "@loom/shared";
import { api } from "../lib/api";
import { Panel, Button, SectionLabel, Chip, Meter, Dot, Badge } from "../components/ui";
import { FileDiffBlock, FileOverviewRow } from "../components/Diff";
import { analyzeDiff, riskOrder, riskTone } from "../lib/diff";
import { color, font, tone } from "../theme";

// The human-in-the-loop REVIEW & MERGE gate — the product's fast-triage centerpiece. A worker's
// branch diff is parsed CLIENT-SIDE (lib/diff) into an auto-summary, a risk-ranked file overview, and
// per-file collapsible hunks, with one-step Approve & merge / Request-changes wired to the EXISTING
// daemon merge gate (fail-closed build gate → squash-merge) and the sendInput turn surface. Reached
// from Mission Control's review queue. The merge logic itself is unchanged — this only surfaces it.
export default function ReviewPanel() {
  const { workerId = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const [result, setResult] = useState<string | null>(null);

  const sessions = useQuery({ queryKey: ["allSessions"], queryFn: api.allSessions, refetchInterval: 3000 });
  const worker = (sessions.data ?? []).find((s) => s.id === workerId);
  const diff = useQuery({ queryKey: ["workerDiff", workerId], queryFn: () => api.workerDiff(workerId), enabled: !!workerId });

  const merge = useMutation({
    mutationFn: () => api.mergeWorker(workerId),
    onSuccess: (r) => { setResult(r.merged ? "✓ merged to main" : `rejected — ${r.reason}`); qc.invalidateQueries({ queryKey: ["allSessions"] }); },
    onError: (e) => setResult(`error — ${(e as Error).message}`),
  });
  const requestChanges = useMutation({
    mutationFn: () => api.sendInput(workerId, `[loom:review] Changes requested before merge:\n${note}`),
    onSuccess: (r) => { setResult(r.delivered ? "changes requested (sent to worker)" : "worker not live — couldn't send"); setNote(""); },
  });

  const ctx = worker?.ctxInputTokens ?? 0;
  const window = contextWindowForModel(worker?.model);

  // Parse + risk-rank once per diff payload. Files for the OVERVIEW are sorted risk-desc then by churn
  // so the load-bearing changes sit at the top; the DIFF blocks below keep git's original file order
  // (so a reviewer reading top-to-bottom sees a coherent change), but high/medium files open by
  // default and low-risk ones fold away.
  const analysis = useMemo(() => (diff.data ? analyzeDiff(diff.data.patch) : null), [diff.data]);
  const overview = useMemo(() => {
    if (!analysis) return [];
    return [...analysis.files].sort((a, b) =>
      riskOrder(b.risk) - riskOrder(a.risk) || (b.insertions + b.deletions) - (a.insertions + a.deletions));
  }, [analysis]);

  // Which file blocks are expanded — keyed by path. Seeded (on first analysis) to high+medium risk.
  const [openFiles, setOpenFiles] = useState<Set<string> | null>(null);
  const open = openFiles ?? new Set(analysis ? analysis.files.filter((f) => f.risk !== "low").map((f) => f.path) : []);
  const toggleFile = (path: string) => setOpenFiles(() => {
    const next = new Set(open);
    next.has(path) ? next.delete(path) : next.add(path);
    return next;
  });
  const jumpTo = (path: string) => {
    setOpenFiles(() => { const next = new Set(open); next.add(path); return next; });
    requestAnimationFrame(() => document.getElementById(`file-${path}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  const merged = diff.data?.merged;
  const uncommitted = diff.data?.uncommitted;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <Button onClick={() => navigate(-1)}>← back</Button>
        <span style={{ fontFamily: font.head, fontSize: 14, textTransform: "uppercase", letterSpacing: "0.08em", color: color.text }}>Merge request</span>
        <span style={{ fontFamily: font.mono, fontSize: 12, color: color.textDim }}>
          worker w:{workerId.slice(0, 8)}{worker?.taskId ? ` · task ${worker.taskId.slice(0, 8)}` : ""}
        </span>
        <span style={{ flex: 1 }} />
        {worker?.branch && <Chip label="branch" value={`${worker.branch} → main`} tone="cyan" />}
        {diff.data && <Chip value={`${diff.data.filesChanged} files · +${diff.data.insertions} −${diff.data.deletions}`} tone="cyan" />}
        {ctx > 0 && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Meter value={ctx} max={window} tone={ctx > window * CONTEXT_WARN_RATIO ? "amber" : "phosphor"} width={60} />
            <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>{(ctx / 1000).toFixed(1)}k ctx</span>
          </span>
        )}
      </div>

      {!workerId && <Panel><span style={{ color: color.textMuted }}>No worker.</span></Panel>}
      {workerId && diff.isError && <Panel><span style={{ color: color.red, fontSize: 12 }}>No diff (worker has no branch, or it was merged/removed).</span></Panel>}

      {/* Auto-summary + risk surface — read this BEFORE the raw diff. */}
      {analysis && (
        <Panel style={{ display: "flex", flexDirection: "column", gap: 10, borderTop: `2px solid ${analysis.highRisk ? color.red : analysis.mediumRisk ? color.amber : color.phosphor}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <SectionLabel style={{ margin: 0 }}>Summary</SectionLabel>
            <span style={{ fontFamily: font.mono, fontSize: 10, color: color.textMuted }}>auto-derived</span>
            <span style={{ flex: 1 }} />
            {merged && <Badge tone="phosphor">already merged</Badge>}
            {uncommitted && <Badge tone="amber">uncommitted</Badge>}
            <Badge tone={analysis.highRisk ? "red" : analysis.mediumRisk ? "amber" : "phosphor"}>
              {analysis.highRisk ? `${analysis.highRisk} high-risk` : analysis.mediumRisk ? `${analysis.mediumRisk} to watch` : "low risk"}
            </Badge>
          </div>

          <div style={{ fontFamily: font.mono, fontSize: 13, color: color.text, lineHeight: 1.5 }}>{analysis.headline}</div>

          {/* Touched-area roll-up */}
          {analysis.areas.length > 0 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {analysis.areas.map((a) => <Chip key={a.area} label={a.area} value={a.count} />)}
            </div>
          )}

          {/* Risk callout: the high/medium files + why, so attention lands here first. */}
          {(analysis.highRisk > 0 || analysis.mediumRisk > 0) && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4, borderTop: `1px solid ${color.border}`, paddingTop: 8 }}>
              {analysis.files.filter((f) => f.risk !== "low")
                .sort((a, b) => riskOrder(b.risk) - riskOrder(a.risk))
                .map((f) => (
                  <div key={f.path} style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: font.mono, fontSize: 12 }}>
                    <Dot tone={riskTone(f.risk)} glow={f.risk === "high"} />
                    <button onClick={() => jumpTo(f.path)} className="loom-btn"
                      style={{ background: "transparent", border: "none", color: color.textDim, cursor: "pointer", padding: 0, fontFamily: font.mono, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 360, textAlign: "left" }}
                      title={`jump to ${f.path}`}>{f.path}</button>
                    <span style={{ color: tone[riskTone(f.risk)], fontSize: 11 }}>{f.reasons.join(", ")}</span>
                  </div>
                ))}
            </div>
          )}
        </Panel>
      )}

      {/* Decision — placed high so triage is one decision, not a scroll-to-the-bottom hunt. */}
      {diff.data && (
        <Panel>
          <div style={{ display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
            <Button variant="primary" disabled={merge.isPending || merged} onClick={() => { setResult(null); merge.mutate(); }}>
              {merge.isPending ? "Running build gate…" : merged ? "Merged" : "Approve & merge"}
            </Button>
            <span style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="changes to request (sent to the worker as a turn)…"
                style={{ width: 320, resize: "vertical", boxSizing: "border-box", background: color.panel2, color: color.text, border: `1px solid ${color.borderStrong}`, borderRadius: 4, padding: "6px 8px", fontFamily: font.mono, fontSize: 12 }} />
              <Button variant="danger" disabled={!note.trim() || requestChanges.isPending} onClick={() => requestChanges.mutate()}>Request changes</Button>
            </span>
            <span style={{ flex: 1 }} />
          </div>
          <p style={{ color: color.textMuted, fontSize: 11, marginTop: 8 }}>
            Approve runs the project's build/DoD gate in the worktree (fail-closed) before squash-merging; on green the worktree is removed and the task closed. Request changes sends your note to the worker as a turn.
          </p>
          {result && <div style={{ marginTop: 8, fontFamily: font.mono, fontSize: 13, color: result.startsWith("✓") ? color.phosphor : result.startsWith("error") || result.startsWith("rejected") ? color.red : color.amber }}>{result}</div>}
        </Panel>
      )}

      {/* File overview (risk-ranked) + the per-file diff. */}
      {analysis && analysis.files.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(220px, 300px) minmax(0, 1fr)", gap: 12, alignItems: "start" }}>
          <div style={{ position: "sticky", top: 12 }}>
            <SectionLabel>Files ({analysis.files.length})</SectionLabel>
            <Panel style={{ maxHeight: "60vh", overflow: "auto", padding: 6 }}>
              {overview.map((f) => <FileOverviewRow key={f.path} file={f} onJump={() => jumpTo(f.path)} />)}
            </Panel>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <SectionLabel>Diff</SectionLabel>
            {analysis.files.map((f) => (
              <FileDiffBlock key={f.path} file={f} anchorId={`file-${f.path}`} open={open.has(f.path)} onToggle={() => toggleFile(f.path)} />
            ))}
          </div>
        </div>
      )}

      {analysis && analysis.files.length === 0 && diff.data && (
        <Panel><span style={{ color: color.textMuted }}>{diff.data.patch ? "Could not parse the diff." : "No changes vs main."}</span></Panel>
      )}
    </div>
  );
}
