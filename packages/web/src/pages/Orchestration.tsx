import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { SessionListItem, OrchestrationEvent } from "@loom/shared";
import { api } from "../lib/api";
import { card, btn, input } from "../ui";

// Orchestration viewport (#18b): SEE the spine that the MCP manager drives. Read-first — a live
// fleet view of a manager's workers, its orchestration_events timeline, and a per-worker branch
// diff — plus the already-REST pause/kill/stop controls. Human-driven merge/recycle is #18c.
export default function Orchestration() {
  const qc = useQueryClient();
  const [managerId, setManagerId] = useState("");
  const [workerId, setWorkerId] = useState(""); // selected worker → diff panel

  // Poll so the fleet updates live (processState/busy/ctx) without a manual refresh.
  const sessions = useQuery({ queryKey: ["allSessions"], queryFn: api.allSessions, refetchInterval: 2000 });
  const status = useQuery({ queryKey: ["orchStatus"], queryFn: api.orchestrationStatus, refetchInterval: 2000 });
  const events = useQuery({ queryKey: ["orchEvents", managerId], queryFn: () => api.orchestrationEvents(managerId), enabled: !!managerId, refetchInterval: 2000 });
  const diff = useQuery({ queryKey: ["workerDiff", workerId], queryFn: () => api.workerDiff(workerId), enabled: !!workerId });

  const all = sessions.data ?? [];
  const managers = all.filter((s) => s.role === "manager");
  const workers = all.filter((s) => s.parentSessionId === managerId);
  const paused = status.data?.pausedScopes ?? [];
  const globalPaused = paused.includes("global");

  const refreshStatus = () => qc.invalidateQueries({ queryKey: ["orchStatus"] });
  const refreshSessions = () => qc.invalidateQueries({ queryKey: ["allSessions"] });
  const pause = useMutation({ mutationFn: () => api.pauseOrchestration(), onSuccess: refreshStatus });
  const resume = useMutation({ mutationFn: () => api.resumeOrchestration(), onSuccess: refreshStatus });
  const kill = useMutation({ mutationFn: () => api.killOrchestration(), onSuccess: () => { refreshStatus(); refreshSessions(); } });
  const stop = useMutation({ mutationFn: (id: string) => api.stopSession(id, "hard"), onSuccess: refreshSessions });

  return (
    <div>
      {/* Global controls + live pause status */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <span>Manager:{" "}
          <select style={input} value={managerId} onChange={(e) => { setManagerId(e.target.value); setWorkerId(""); }}>
            <option value="">— select —</option>
            {managers.map((m) => (
              <option key={m.id} value={m.id}>{m.projectName} · {m.topicName} · {m.id.slice(0, 8)} ({m.processState})</option>
            ))}
          </select>
        </span>
        <span style={{ flex: 1 }} />
        <Badge ok={!globalPaused} text={globalPaused ? "PAUSED (global)" : "running"} />
        {paused.filter((s) => s !== "global").length > 0 &&
          <span style={{ fontSize: 12, color: "#caa" }}>scoped: {paused.filter((s) => s !== "global").map((s) => s.slice(0, 8)).join(", ")}</span>}
        <button style={btn} disabled={pause.isPending} onClick={() => pause.mutate()}>Pause</button>
        <button style={btn} disabled={resume.isPending} onClick={() => resume.mutate()}>Resume</button>
        <button style={{ ...btn, borderColor: "#a44", color: "#f99" }} disabled={kill.isPending} onClick={() => kill.mutate()}>Kill all</button>
      </div>

      {!managerId && <p style={{ color: "#777" }}>Select a manager to view its workers, timeline, and diffs.</p>}

      {managerId && (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 12 }}>
          {/* LEFT: live workers + timeline */}
          <div>
            <SectionLabel text={`Workers (${workers.length})`} />
            {workers.length === 0 && <p style={{ color: "#777" }}>No workers spawned by this manager.</p>}
            {workers.map((w) => (
              <WorkerCard key={w.id} w={w} selected={w.id === workerId}
                onSelect={() => setWorkerId(w.id)} onStop={() => stop.mutate(w.id)} stopping={stop.isPending} />
            ))}

            <SectionLabel text="Timeline" />
            <div style={{ ...card, maxHeight: "40vh", overflow: "auto" }}>
              {(events.data ?? []).length === 0 && <p style={{ color: "#777", margin: 0 }}>No events yet.</p>}
              {(events.data ?? []).map((e) => <EventRow key={e.id} e={e} />)}
            </div>
          </div>

          {/* RIGHT: selected worker's branch diff */}
          <div>
            <SectionLabel text={workerId ? `Diff · ${workerId.slice(0, 8)}` : "Diff"} />
            <div style={{ ...card, height: "76vh", overflow: "auto" }}>
              {!workerId && <p style={{ color: "#777" }}>Click a worker to see its branch diff.</p>}
              {workerId && diff.isError && <p style={{ color: "#c77" }}>No diff (worker has no branch, or it was merged/removed).</p>}
              {workerId && diff.data && (
                <>
                  <div style={{ fontSize: 12, color: "#9ad", marginBottom: 8 }}>
                    {diff.data.filesChanged} file(s) · +{diff.data.insertions} −{diff.data.deletions}
                  </div>
                  <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontFamily: "ui-monospace, Consolas, monospace", fontSize: 12, color: "#ddd" }}>
                    {diff.data.patch || "(no changes vs HEAD)"}
                  </pre>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function WorkerCard({ w, selected, onSelect, onStop, stopping }:
  { w: SessionListItem; selected: boolean; onSelect: () => void; onStop: () => void; stopping: boolean }) {
  const live = w.processState === "live";
  // §19c: parked on the Claude usage cap until rateLimitedUntil — show it instead of the busy/idle dot.
  const rateLimited = !!w.rateLimitedUntil && new Date(w.rateLimitedUntil).getTime() > Date.now();
  return (
    <div onClick={onSelect} style={{ ...card, cursor: "pointer", borderColor: selected ? "#9ad" : "#2a2a2e", background: selected ? "#16161c" : undefined }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 12, color: "#9ad" }}>
          {w.taskId ? `task ${w.taskId.slice(0, 8)}` : "(no task)"}{w.gen ? ` · gen ${w.gen}` : ""}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {rateLimited
            ? <span title={`usage limit — resumes ${w.rateLimitedUntil}`} style={{ fontSize: 11, color: "#e9a" }}>
                ⏳ rate-limited (resumes {new Date(w.rateLimitedUntil!).toLocaleTimeString()})
              </span>
            : <>
                <Dot color={live ? (w.busy ? "#ec4" : "#6c6") : "#777"} title={live ? (w.busy ? "busy" : "idle") : w.processState} />
                <span style={{ fontSize: 11, color: "#aaa" }}>{live ? (w.busy ? "busy" : "idle") : w.processState}</span>
              </>}
          <button style={{ ...btn, padding: "2px 8px" }} disabled={!live || stopping}
            onClick={(ev) => { ev.stopPropagation(); onStop(); }}>Stop</button>
        </div>
      </div>
      <div style={{ fontSize: 11, color: "#888", marginTop: 6, display: "flex", gap: 14, flexWrap: "wrap" }}>
        <span>branch: <span style={{ color: "#bbb" }}>{w.branch ?? "—"}</span></span>
        <span>ctx: <span style={{ color: "#bbb" }}>{w.ctxInputTokens != null ? w.ctxInputTokens.toLocaleString() : "—"}</span></span>
        <span>active: <span style={{ color: "#bbb" }}>{new Date(w.lastActivity).toLocaleTimeString()}</span></span>
      </div>
    </div>
  );
}

function EventRow({ e }: { e: OrchestrationEvent }) {
  const detail = e.detail && Object.keys(e.detail).length ? JSON.stringify(e.detail) : "";
  return (
    <div style={{ fontSize: 12, padding: "3px 0", borderBottom: "1px solid #1e1e22", display: "flex", gap: 8 }}>
      <span style={{ color: "#778", whiteSpace: "nowrap" }}>{new Date(e.ts).toLocaleTimeString()}</span>
      <span style={{ color: "#9ad", whiteSpace: "nowrap" }}>{e.kind}</span>
      <span style={{ color: "#aaa", overflow: "hidden", textOverflow: "ellipsis" }}>
        {e.workerSessionId ? `w:${e.workerSessionId.slice(0, 8)} ` : ""}{e.taskId ? `t:${e.taskId.slice(0, 8)} ` : ""}
        {detail && <span style={{ color: "#777" }}>{detail}</span>}
      </span>
    </div>
  );
}

function SectionLabel({ text }: { text: string }) {
  return <div style={{ fontSize: 12, color: "#9ad", margin: "4px 0 8px" }}>{text}</div>;
}
function Badge({ ok, text }: { ok: boolean; text: string }) {
  return <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 10, border: `1px solid ${ok ? "#3a5" : "#a44"}`, color: ok ? "#8d8" : "#f99" }}>{text}</span>;
}
function Dot({ color, title }: { color: string; title: string }) {
  return <span title={title} style={{ width: 8, height: 8, borderRadius: 8, background: color, display: "inline-block" }} />;
}
