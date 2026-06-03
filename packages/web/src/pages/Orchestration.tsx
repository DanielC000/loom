import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import type { SessionListItem, OrchestrationEvent } from "@loom/shared";
import { contextWindowForModel, CONTEXT_WARN_RATIO } from "@loom/shared";
import { api } from "../lib/api";
import { useActiveProject } from "../lib/activeProject";
import { bySessionActivity } from "../lib/sessions";
import { Panel, Button, Select, SectionLabel, Badge, StatusPill, Chip, Meter } from "../components/ui";
import { DiffView } from "../components/Diff";
import { color, font } from "../theme";

// Orchestration viewport (#18b): SEE the spine that the MCP manager drives. A live fleet view of
// ONE manager's workers, its orchestration_events timeline, and a per-worker branch diff — plus
// the REST pause/kill/stop controls. (The all-managers god-eye view is Mission Control.)

export default function Orchestration() {
  const qc = useQueryClient();
  const { projectId } = useActiveProject();
  const [managerId, setManagerId] = useState("");
  const [workerId, setWorkerId] = useState(""); // selected worker → diff panel
  // The manager picker is scoped to the active project — clear the selection when the project changes.
  useEffect(() => { setManagerId(""); setWorkerId(""); }, [projectId]);

  // Poll so the fleet updates live (processState/busy/ctx) without a manual refresh.
  const sessions = useQuery({ queryKey: ["allSessions"], queryFn: api.allSessions, refetchInterval: 2000 });
  const status = useQuery({ queryKey: ["orchStatus"], queryFn: api.orchestrationStatus, refetchInterval: 2000 });
  const events = useQuery({ queryKey: ["orchEvents", managerId], queryFn: () => api.orchestrationEvents(managerId), enabled: !!managerId, refetchInterval: 2000, placeholderData: keepPreviousData });
  const diff = useQuery({ queryKey: ["workerDiff", workerId], queryFn: () => api.workerDiff(workerId), enabled: !!workerId, placeholderData: keepPreviousData });

  const all = sessions.data ?? [];
  // Managers are scoped to the active project, then ordered by the shared activity comparator
  // (live-first → most-recent → spawn-order), consistent with every other session list.
  const managers = all.filter((s) => s.role === "manager" && s.projectId === projectId).sort(bySessionActivity);
  const workers = all.filter((s) => s.parentSessionId === managerId).sort(bySessionActivity);
  const selectedWorker = workers.find((w) => w.id === workerId);
  const paused = status.data?.pausedScopes ?? [];
  const globalPaused = paused.includes("global");
  const scoped = paused.filter((s) => s !== "global");

  const refreshStatus = () => qc.invalidateQueries({ queryKey: ["orchStatus"] });
  const refreshSessions = () => qc.invalidateQueries({ queryKey: ["allSessions"] });
  const pause = useMutation({ mutationFn: () => api.pauseOrchestration(), onSuccess: refreshStatus });
  const resume = useMutation({ mutationFn: () => api.resumeOrchestration(), onSuccess: refreshStatus });
  const kill = useMutation({ mutationFn: () => api.killOrchestration(), onSuccess: () => { refreshStatus(); refreshSessions(); } });
  const stop = useMutation({ mutationFn: (id: string) => api.stopSession(id, "hard"), onSuccess: refreshSessions });

  return (
    <div>
      {/* Global controls + live pause status */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <span style={{ fontFamily: font.head, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", color: color.textDim }}>Manager</span>
        <Select value={managerId} onChange={(e) => { setManagerId(e.target.value); setWorkerId(""); }}>
          <option value="">— select —</option>
          {managers.map((m) => (
            <option key={m.id} value={m.id}>{m.agentName} · {m.id.slice(0, 8)} ({m.processState})</option>
          ))}
        </Select>
        <span style={{ flex: 1 }} />
        <Badge tone={globalPaused ? "red" : "phosphor"}>{globalPaused ? "paused (global)" : "running"}</Badge>
        {scoped.length > 0 && <span style={{ fontFamily: font.mono, fontSize: 11, color: color.amber }}>scoped: {scoped.map((s) => s.slice(0, 8)).join(", ")}</span>}
        <Button disabled={pause.isPending} onClick={() => pause.mutate()}>Pause</Button>
        <Button disabled={resume.isPending} onClick={() => resume.mutate()}>Resume</Button>
        <Button variant="danger" disabled={kill.isPending} onClick={() => kill.mutate()}>Kill all</Button>
      </div>

      {!managerId && <p style={{ color: color.textMuted }}>Select a manager to view its workers, timeline, and diffs.</p>}

      {managerId && (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 16 }}>
          {/* LEFT: live workers + timeline */}
          <div>
            <SectionLabel>Workers ({workers.length})</SectionLabel>
            {workers.length === 0 && <p style={{ color: color.textMuted }}>No workers spawned by this manager.</p>}
            {workers.map((w) => (
              <WorkerCard key={w.id} w={w} selected={w.id === workerId}
                onSelect={() => setWorkerId(w.id)} onStop={() => stop.mutate(w.id)} stopping={stop.isPending} />
            ))}

            <SectionLabel>Timeline</SectionLabel>
            <Panel grid style={{ maxHeight: "40vh", overflow: "auto" }}>
              {(events.data ?? []).length === 0 && <span style={{ color: color.textMuted, fontSize: 12 }}>No events yet.</span>}
              {(events.data ?? []).map((e) => <EventRow key={e.id} e={e} />)}
            </Panel>
          </div>

          {/* RIGHT: selected worker's branch diff */}
          <div>
            {/* Header keys off the TASK short-id (matching the worker card) so it never reads like a
                different worker's diff; the worker session short-id trails it for disambiguation. */}
            <SectionLabel>{workerId
              ? `Diff · ${selectedWorker?.taskId ? `task ${selectedWorker.taskId.slice(0, 8)}` : "(no task)"} · w:${workerId.slice(0, 8)}`
              : "Diff"}</SectionLabel>
            <Panel style={{ height: "76vh", overflow: "auto" }}>
              {!workerId && <span style={{ color: color.textMuted, fontSize: 12 }}>Click a worker to see its branch diff.</span>}
              {workerId && diff.isError && <span style={{ color: color.red, fontSize: 12 }}>No diff (worker has no branch, or it was merged/removed).</span>}
              {workerId && diff.data && (
                <>
                  <div style={{ fontFamily: font.mono, fontSize: 12, color: color.cyan, marginBottom: 8, display: "flex", gap: 8, alignItems: "center" }}>
                    <span>{diff.data.filesChanged} file(s) · +{diff.data.insertions} −{diff.data.deletions}</span>
                    {diff.data.uncommitted && <Badge tone="amber">live · incl. uncommitted</Badge>}
                    {diff.data.merged && <Badge tone="phosphor">merged → landed diff</Badge>}
                  </div>
                  <DiffView patch={diff.data.patch || "(no changes vs HEAD)"} />
                </>
              )}
            </Panel>
          </div>
        </div>
      )}
    </div>
  );
}

function WorkerCard({ w, selected, onSelect, onStop, stopping }:
  { w: SessionListItem; selected: boolean; onSelect: () => void; onStop: () => void; stopping: boolean }) {
  const live = w.processState === "live";
  // §19c: parked on the Claude usage cap until rateLimitedUntil — show it instead of the busy/idle pill.
  const rateLimited = !!w.rateLimitedUntil && new Date(w.rateLimitedUntil).getTime() > Date.now();
  const ctx = w.ctxInputTokens ?? 0;
  const window = contextWindowForModel(w.model);
  return (
    <Panel selected={selected} onClick={onSelect} style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <span style={{ fontFamily: font.mono, fontSize: 12, color: color.cyan }}>
          {w.taskId ? `task ${w.taskId.slice(0, 8)}` : "(no task)"}{w.gen ? ` · gen ${w.gen}` : ""}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {rateLimited
            ? <StatusPill tone="red" label={`rate-limited · ${new Date(w.rateLimitedUntil!).toLocaleTimeString()}`} />
            : <StatusPill tone={live ? (w.busy ? "amber" : "phosphor") : "muted"} glow={live && w.busy}
                label={live ? (w.busy ? "busy" : "idle") : w.processState} />}
          <Button disabled={!live || stopping} style={{ padding: "2px 8px" }}
            onClick={(ev) => { ev.stopPropagation(); onStop(); }}>Stop</Button>
        </div>
      </div>
      <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <Chip label="branch" value={w.branch ?? "—"} tone="cyan" />
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <Chip label="ctx" value={ctx ? ctx.toLocaleString() : "—"} />
          {ctx > 0 && <Meter value={ctx} max={window} tone={ctx > window * CONTEXT_WARN_RATIO ? "amber" : "phosphor"} width={50} />}
        </span>
        <Chip label="active" value={new Date(w.lastActivity).toLocaleTimeString()} />
      </div>
    </Panel>
  );
}

function EventRow({ e }: { e: OrchestrationEvent }) {
  const detail = e.detail && Object.keys(e.detail).length ? JSON.stringify(e.detail) : "";
  return (
    <div style={{ fontFamily: font.mono, fontSize: 12, padding: "3px 0", borderBottom: `1px solid ${color.border}`, display: "flex", gap: 8 }}>
      <span style={{ color: color.textMuted, whiteSpace: "nowrap" }}>{new Date(e.ts).toLocaleTimeString()}</span>
      <span style={{ color: color.cyan, whiteSpace: "nowrap" }}>{e.kind}</span>
      <span style={{ color: color.textDim, overflow: "hidden", textOverflow: "ellipsis" }}>
        {e.workerSessionId ? `w:${e.workerSessionId.slice(0, 8)} ` : ""}{e.taskId ? `t:${e.taskId.slice(0, 8)} ` : ""}
        {detail && <span style={{ color: color.textMuted }}>{detail}</span>}
      </span>
    </div>
  );
}
