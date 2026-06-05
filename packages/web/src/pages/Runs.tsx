import { useMemo, useState, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { AgentRun, RunStatus } from "@loom/shared";
import { api } from "../lib/api";
import { useActiveProject } from "../lib/activeProject";
import { TranscriptPane } from "../components/TranscriptPane";
import { Panel, Button, SectionLabel, StatusPill, Chip } from "../components/ui";
import { color, font, tone, type Tone } from "../theme";

// Agent Runs R4b — the project-scoped Runs observability view. Reads R4a's HUMAN run REST
// (GET /api/projects/:id/runs[/:runId], POST .../cancel — unauthed loopback, full AgentRun rows
// across every key). List (left, newest-first, bounded scroll) → detail drawer (right: full
// input/result/usage/error + the retained transcript via the shared TranscriptPane) → Cancel for
// an in-flight run. READ-ONLY otherwise — issuing keys / flagging endpoints is NOT here (that admin
// surface is a deferred follow-up tied to the Platform-vs-project placement decision). Scoped to the
// header's active project, like Board / Git / Vault.

// In-flight (queued/starting/running) glows amber/phosphor; terminal states map to their outcome.
const IN_FLIGHT: ReadonlySet<RunStatus> = new Set<RunStatus>(["queued", "starting", "running"]);
const statusTone: Record<RunStatus, Tone> = {
  queued: "muted",
  starting: "amber",
  running: "amber",
  completed: "phosphor",
  failed: "red",
  timed_out: "red",
  cancelled: "muted",
};
const isInFlight = (s: RunStatus) => IN_FLIGHT.has(s);

const ts = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : "—");

// A short, single-line peek at the run's outcome for the list row: the error for a failed run, else
// a trimmed stringification of the result, else nothing.
function peek(run: AgentRun): string {
  if (run.error) return run.error;
  if (run.result != null) {
    const s = typeof run.result === "string" ? run.result : JSON.stringify(run.result);
    return s;
  }
  return "";
}

export default function Runs() {
  const qc = useQueryClient();
  const { projectId } = useActiveProject();
  const [runId, setRunId] = useState<string | null>(null);

  const runs = useQuery({
    queryKey: ["runs", projectId],
    queryFn: () => api.runs(projectId),
    enabled: !!projectId,
    refetchInterval: 4000, // keep in-flight rows + the open detail fresh
  });

  const rows = runs.data ?? [];
  // Resolve the selected run from the live list so the drawer tracks status changes (running → done).
  const selected = rows.find((r) => r.id === runId) ?? null;

  // Map agentId → name for readable rows (the run row only carries the id). Cheap, project-scoped.
  const agents = useQuery({ queryKey: ["agents", projectId], queryFn: () => api.agents(projectId), enabled: !!projectId });
  const agentName = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of agents.data ?? []) m.set(a.id, a.name);
    return (id: string) => m.get(id) ?? id.slice(0, 8);
  }, [agents.data]);

  const cancel = useMutation({
    mutationFn: (id: string) => api.cancelRun(projectId, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["runs", projectId] }),
    onError: (e) => window.alert((e as Error).message),
  });

  if (!projectId) return <p style={{ color: color.textMuted }}>No project selected.</p>;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 16 }}>
      {/* LEFT: the project's runs, newest-first */}
      <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <SectionLabel style={{ margin: 0 }}>Runs ({rows.length})</SectionLabel>
          <span style={{ flex: 1 }} />
        </div>
        <div style={{ maxHeight: "76vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, paddingRight: 4 }}>
          {rows.length === 0 && (
            <p style={{ color: color.textMuted, fontSize: 13 }}>
              No runs yet. An agent run is an ephemeral, structured invocation started over the keyed Run
              REST — they appear here newest-first as callers fire them.
            </p>
          )}
          {rows.map((r) => (
            <RunRow key={r.id} run={r} selected={r.id === runId} agentName={agentName(r.agentId)}
              onSelect={() => setRunId(r.id)}
              onCancel={() => cancel.mutate(r.id)} cancelling={cancel.isPending} />
          ))}
        </div>
      </div>

      {/* RIGHT: the selected run's full detail */}
      <div>
        <SectionLabel>{selected ? `Run · ${selected.id.slice(0, 8)}` : "Run detail"}</SectionLabel>
        <Panel style={{ height: "76vh", padding: 12, overflowY: "auto" }}>
          {!selected && <span style={{ color: color.textMuted, fontSize: 12 }}>Select a run to view its input, result, usage, and transcript.</span>}
          {selected && <RunDetail run={selected} agentName={agentName(selected.agentId)}
            onCancel={() => cancel.mutate(selected.id)} cancelling={cancel.isPending} />}
        </Panel>
      </div>
    </div>
  );
}

function RunRow({ run, selected, agentName, onSelect, onCancel, cancelling }:
  { run: AgentRun; selected: boolean; agentName: string; onSelect: () => void; onCancel: () => void; cancelling: boolean }) {
  const inFlight = isInFlight(run.status);
  const p = peek(run);
  return (
    <Panel selected={selected} onClick={onSelect} style={{ padding: "8px 10px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <StatusPill tone={statusTone[run.status]} label={run.status} glow={inFlight} />
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>{run.id.slice(0, 8)}</span>
      </div>
      <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <Chip label="agent" value={agentName} tone="cyan" />
        <Chip label="key" value={run.keyId ? run.keyId.slice(0, 8) : "internal"} />
        <Chip label="created" value={ts(run.createdAt)} />
        {run.endedAt && <Chip label="ended" value={ts(run.endedAt)} />}
      </div>
      {p && (
        <div style={{ marginTop: 8, fontFamily: font.mono, fontSize: 11, color: run.error ? color.red : color.textDim,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={p}>
          {run.error ? "✗ " : "↳ "}{p}
        </div>
      )}
      {inFlight && (
        <div style={{ marginTop: 8 }}>
          <Button variant="danger" disabled={cancelling} title="Cancel this in-flight run"
            onClick={(ev) => { ev.stopPropagation(); onCancel(); }}>Cancel</Button>
        </div>
      )}
    </Panel>
  );
}

function RunDetail({ run, agentName, onCancel, cancelling }:
  { run: AgentRun; agentName: string; onCancel: () => void; cancelling: boolean }) {
  const inFlight = isInFlight(run.status);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <StatusPill tone={statusTone[run.status]} label={run.status} glow={inFlight} />
        <span style={{ flex: 1 }} />
        {inFlight && (
          <Button variant="danger" disabled={cancelling} title="Cancel this in-flight run" onClick={onCancel}>Cancel</Button>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <Chip label="run" value={run.id} />
        <Chip label="agent" value={agentName} tone="cyan" />
        <Chip label="key" value={run.keyId ? run.keyId : "internal"} />
        {run.sessionId && <Chip label="session" value={run.sessionId.slice(0, 8)} />}
        {run.idempotencyKey && <Chip label="idem" value={run.idempotencyKey} />}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <Chip label="created" value={ts(run.createdAt)} />
        <Chip label="started" value={ts(run.startedAt)} />
        <Chip label="ended" value={ts(run.endedAt)} />
      </div>

      <Field label="Input"><Json value={run.input} /></Field>
      {run.schema != null && <Field label="Schema"><Json value={run.schema} /></Field>}
      {run.result != null && <Field label="Result"><Json value={run.result} /></Field>}
      {run.usage != null && <Field label="Usage"><Json value={run.usage} /></Field>}
      {run.error && (
        <Field label="Error">
          <pre style={{ ...preStyle, color: color.red }}>{run.error}</pre>
        </Field>
      )}
      {run.webhookUrl && <Field label="Webhook"><span style={{ fontFamily: font.mono, fontSize: 12, color: color.textDim, wordBreak: "break-all" }}>{run.webhookUrl}</span></Field>}

      {/* Transcript: the run's retained conversation, served by the shared session-transcript viewer
          keyed on the run's ephemeral session id. transcriptRef (set at teardown) signals a snapshot
          was retained; while in-flight the viewer shows the live transcript. */}
      <Field label={`Transcript${run.transcriptRef ? " · retained" : ""}`}>
        {run.sessionId
          ? (
            <div style={{ height: "40vh", border: `1px solid ${color.border}`, borderRadius: 4 }}>
              <TranscriptPane sessionId={run.sessionId} />
            </div>
          )
          : <span style={{ color: color.textMuted, fontSize: 12 }}>No session — the run failed before one was minted.</span>}
      </Field>
    </div>
  );
}

const preStyle = { whiteSpace: "pre-wrap" as const, wordBreak: "break-word" as const, margin: 0, fontFamily: font.mono, fontSize: 12, color: color.text };

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <SectionLabel style={{ margin: "0 0 4px" }}>{label}</SectionLabel>
      {children}
    </div>
  );
}

// Render a value (run input/result/usage/schema — typed `unknown`) as pretty JSON, or verbatim if a string.
function Json({ value }: { value: unknown }) {
  const text = typeof value === "string" ? value : safeStringify(value);
  return (
    <Panel style={{ padding: 8, background: color.panel2, maxHeight: "30vh", overflow: "auto" }}>
      <pre style={preStyle}>{text}</pre>
    </Panel>
  );
}

function safeStringify(value: unknown): string {
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}
