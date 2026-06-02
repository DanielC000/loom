import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { contextWindowForModel, CONTEXT_WARN_RATIO } from "@loom/shared";
import { api } from "../lib/api";
import { Panel, Button, SectionLabel, Chip, Meter } from "../components/ui";
import { DiffView } from "../components/Diff";
import { color, font } from "../theme";

// The human-in-the-loop REVIEW & MERGE surface (promotes deferred #18c): a worker's branch diff +
// the build gate (run on Approve) + Approve&Merge / Request-changes. Reached from Mission Control's
// pending-merge attention row. The merge itself is daemon-executed and fail-closed.
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
    mutationFn: () => api.sendInput(workerId, note),
    onSuccess: (r) => { setResult(r.delivered ? "changes requested (sent to worker)" : "worker not live — couldn't send"); setNote(""); },
  });

  const ctx = worker?.ctxInputTokens ?? 0;
  const window = contextWindowForModel(worker?.model);

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

      {/* Diff */}
      <SectionLabel>Diff</SectionLabel>
      <Panel style={{ maxHeight: "52vh", overflow: "auto" }}>
        {!workerId && <span style={{ color: color.textMuted }}>No worker.</span>}
        {workerId && diff.isError && <span style={{ color: color.red, fontSize: 12 }}>No diff (worker has no branch, or it was merged/removed).</span>}
        {diff.data && <DiffView patch={diff.data.patch || "(no changes vs HEAD)"} />}
      </Panel>

      {/* Actions */}
      <Panel>
        <SectionLabel>Decision</SectionLabel>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
          <Button variant="primary" disabled={merge.isPending || !diff.data} onClick={() => { setResult(null); merge.mutate(); }}>
            {merge.isPending ? "Running build gate…" : "Approve & merge"}
          </Button>
          <span style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="changes to request (sent to the worker as a turn)…"
              style={{ width: 320, resize: "vertical", boxSizing: "border-box", background: color.panel2, color: color.text, border: `1px solid ${color.borderStrong}`, borderRadius: 4, padding: "6px 8px", fontFamily: font.mono, fontSize: 12 }} />
            <Button disabled={!note.trim() || requestChanges.isPending} onClick={() => requestChanges.mutate()}>Request changes</Button>
          </span>
        </div>
        <p style={{ color: color.textMuted, fontSize: 11, marginTop: 8 }}>
          Approve runs the project's build/DoD gate in the worktree (fail-closed) before merging --no-ff; on green the worktree is removed and the task closed.
        </p>
        {result && <div style={{ marginTop: 8, fontFamily: font.mono, fontSize: 13, color: result.startsWith("✓") ? color.phosphor : result.startsWith("error") || result.startsWith("rejected") ? color.red : color.amber }}>{result}</div>}
      </Panel>
    </div>
  );
}
