import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Schedule } from "@loom/shared";
import { api } from "../lib/api";
import { Panel, Button, Input, Select, SectionLabel, Badge } from "../components/ui";
import { color, font } from "../theme";

// A 5-field cron is the daemon's contract (Schedule.cron). Cheap client-side gate: exactly five
// whitespace-separated fields — enough to catch a fat-fingered expression before the round-trip. The
// daemon does the REAL parse (nextFireAt) and 400s anything it can't compute, surfaced here as the
// mutation error.
function looksLikeCron(s: string): boolean {
  const t = s.trim();
  return t.length > 0 && t.split(/\s+/).length === 5;
}

function fmt(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

// Flat list of every agent across all projects, with a "Project / Agent" label — schedules target an
// agentId (project derived from it server-side), so the picker spans projects.
function useAllAgents() {
  return useQuery({
    queryKey: ["allAgents"],
    queryFn: async () => {
      const projects = await api.projects();
      const lists = await Promise.all(
        projects.map((p) => api.agents(p.id).then((ags) => ags.map((a) => ({ id: a.id, label: `${p.name} / ${a.name}` })))),
      );
      return lists.flat();
    },
  });
}

// Loom's cron Schedules — the trigger layer (phase-2 Pillar B). On each due boundary the daemon
// Scheduler boots a manager session in the target agent (its startupPrompt is the kickoff). The
// scheduler BACKEND already runs; this page is the human CRUD over the REST surface. Edits take
// effect on the next tick (the daemon re-reads the table each minute).
export default function Schedules() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const schedules = useQuery({ queryKey: ["schedules"], queryFn: api.schedules });
  const agents = useAllAgents();
  const agentLabel = (id: string) => agents.data?.find((a) => a.id === id)?.label ?? id;

  const create = useMutation({
    mutationFn: (b: { agentId: string; cron: string; enabled: boolean }) => api.createSchedule(b),
    onSuccess: (s) => { qc.invalidateQueries({ queryKey: ["schedules"] }); setSelected(s.id); setCreating(false); },
  });
  const save = useMutation({
    mutationFn: (v: { id: string; patch: { cron?: string; enabled?: boolean } }) => api.updateSchedule(v.id, v.patch),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["schedules"] }); },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteSchedule(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["schedules"] }); setSelected(null); },
  });

  const current = schedules.data?.find((s) => s.id === selected) ?? null;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 16 }}>
      <Panel style={{ alignSelf: "start" }}>
        <SectionLabel>Schedules</SectionLabel>
        <p style={{ color: color.textMuted, fontSize: 11, margin: "0 0 10px", fontFamily: font.mono, lineHeight: 1.5 }}>
          Cron triggers. On each due boundary the daemon boots a manager session in the target agent —
          the agent's startup prompt is the kickoff. Human-managed; changes apply on the next tick.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {schedules.data?.map((s) => (
            <Button key={s.id} variant={s.id === selected ? "primary" : "default"}
              style={{ textAlign: "left", display: "flex", alignItems: "center", gap: 8 }}
              onClick={() => { setSelected(s.id); setCreating(false); }} title={`${agentLabel(s.agentId)} · ${s.cron}`}>
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{agentLabel(s.agentId)}</span>
              <span style={{ fontFamily: font.mono, fontSize: 11, color: color.cyan }}>{s.cron}</span>
              <span style={{ fontSize: 9, color: s.enabled ? color.phosphor : color.textMuted, fontFamily: font.mono }}>{s.enabled ? "ON" : "OFF"}</span>
            </Button>
          ))}
          {schedules.data?.length === 0 && <span style={{ color: color.textMuted, fontSize: 12 }}>No schedules yet.</span>}
        </div>
        <div style={{ marginTop: 12 }}>
          <Button variant="primary" style={{ width: "100%" }} onClick={() => { setCreating(true); setSelected(null); }}>+ New schedule</Button>
        </div>
      </Panel>

      <Panel style={{ minHeight: "72vh", padding: 12 }}>
        {creating ? (
          <ScheduleCreate agents={agents.data ?? []}
            onCreate={(b) => create.mutate(b)} creating={create.isPending} error={create.error as Error | null}
            onCancel={() => setCreating(false)} />
        ) : current ? (
          <ScheduleEditor key={current.id} schedule={current} agentLabel={agentLabel(current.agentId)}
            onSave={(patch) => save.mutate({ id: current.id, patch })} saving={save.isPending} saveError={save.error as Error | null}
            onDelete={() => remove.mutate(current.id)} deleting={remove.isPending} />
        ) : <p style={{ color: color.textMuted, padding: 12 }}>Select a schedule to edit it, or create a new one.</p>}
      </Panel>
    </div>
  );
}

const fieldLabel = { fontFamily: font.head as string, fontSize: 11, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.08em", color: color.textDim };

// Create form: agentId is immutable after create (the update endpoint only patches cron/enabled), so
// the agent picker lives ONLY here.
function ScheduleCreate({ agents, onCreate, creating, error, onCancel }:
  { agents: { id: string; label: string }[]; onCreate: (b: { agentId: string; cron: string; enabled: boolean }) => void; creating: boolean; error: Error | null; onCancel: () => void }) {
  const [agentId, setAgentId] = useState("");
  const [cron, setCron] = useState("0 * * * *");
  const [enabled, setEnabled] = useState(true);

  const cronValid = looksLikeCron(cron);
  const valid = !!agentId && cronValid;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <strong style={{ fontFamily: font.head, textTransform: "uppercase", letterSpacing: "0.08em", color: color.text }}>New schedule</strong>
      </div>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={fieldLabel}>Target agent</span>
        <Select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          <option value="">— select an agent —</option>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
        </Select>
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={fieldLabel}>Cron expression <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0, color: color.textMuted }}>· 5 fields: min hour dom mon dow</span></span>
        <Input value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 * * * *" spellCheck={false} />
        {!cronValid && cron.trim().length > 0 && <span style={{ color: color.amber, fontSize: 11, fontFamily: font.mono }}>Expected 5 whitespace-separated fields.</span>}
      </label>

      <label style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: font.mono, fontSize: 13, color: color.text }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Enabled
      </label>

      {error && <span style={{ color: color.red, fontSize: 12, fontFamily: font.mono }}>{error.message.includes("400") ? "Daemon rejected the cron expression." : error.message}</span>}

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
        <Button variant="primary" disabled={!valid || creating} onClick={() => onCreate({ agentId, cron: cron.trim(), enabled })}>{creating ? "Creating…" : "Create"}</Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

// Remounted per schedule (key=id) so fields reset on switch. The update endpoint patches cron/enabled
// only (agentId is fixed), so the target agent is shown read-only; the enable toggle saves instantly.
function ScheduleEditor({ schedule, agentLabel, onSave, saving, saveError, onDelete, deleting }:
  { schedule: Schedule; agentLabel: string; onSave: (patch: { cron?: string; enabled?: boolean }) => void; saving: boolean; saveError: Error | null; onDelete: () => void; deleting: boolean }) {
  const [cron, setCron] = useState(schedule.cron);
  const [confirmDel, setConfirmDel] = useState(false);

  const cronValid = looksLikeCron(cron);
  const dirty = cron.trim() !== schedule.cron;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <strong style={{ fontFamily: font.head, textTransform: "uppercase", letterSpacing: "0.08em", color: color.text }}>{agentLabel}</strong>
        <Badge tone={schedule.enabled ? "phosphor" : "muted"}>{schedule.enabled ? "enabled" : "disabled"}</Badge>
        <span style={{ flex: 1 }} />
        {confirmDel ? (
          <>
            <span style={{ color: color.red, fontSize: 12, fontFamily: font.mono }}>delete this schedule?</span>
            <Button variant="danger" disabled={deleting} onClick={onDelete}>Confirm</Button>
            <Button onClick={() => setConfirmDel(false)}>Cancel</Button>
          </>
        ) : <Button variant="danger" onClick={() => setConfirmDel(true)}>Delete</Button>}
      </div>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={fieldLabel}>Target agent <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0, color: color.textMuted }}>· fixed after create</span></span>
        <Input value={agentLabel} disabled />
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={fieldLabel}>Cron expression <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0, color: color.textMuted }}>· 5 fields: min hour dom mon dow</span></span>
        <Input value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 * * * *" spellCheck={false} />
        {!cronValid && cron.trim().length > 0 && <span style={{ color: color.amber, fontSize: 11, fontFamily: font.mono }}>Expected 5 whitespace-separated fields.</span>}
      </label>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, fontFamily: font.mono, fontSize: 12, color: color.textDim }}>
        <span>Next fire · <span style={{ color: color.text }}>{fmt(schedule.nextFireAt)}</span></span>
        <span>Last fired · <span style={{ color: color.text }}>{fmt(schedule.lastFiredAt)}</span></span>
      </div>

      {saveError && <span style={{ color: color.red, fontSize: 12, fontFamily: font.mono }}>{saveError.message.includes("400") ? "Daemon rejected the cron expression." : saveError.message}</span>}

      <span style={{ flex: 1 }} />
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Button variant="primary" disabled={!dirty || !cronValid || saving} onClick={() => onSave({ cron: cron.trim() })}>{saving ? "Saving…" : "Save"}</Button>
        {dirty
          ? <Button onClick={() => setCron(schedule.cron)}>Reset</Button>
          : <span style={{ color: color.phosphor, fontSize: 12, fontFamily: font.mono }}>saved</span>}
        <span style={{ flex: 1 }} />
        <Button disabled={saving} onClick={() => onSave({ enabled: !schedule.enabled })}
          title={schedule.enabled ? "Pause this schedule (stops firing)" : "Resume this schedule"}>
          {schedule.enabled ? "Disable" : "Enable"}
        </Button>
      </div>
    </div>
  );
}
