import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { EventTrigger, EventTriggerEventKind } from "@loom/shared";
import { EVENT_TRIGGER_EVENT_KINDS } from "@loom/shared";
import { api } from "../lib/api";
import { Panel, Button, Select, SectionLabel, Badge, Chip, StatusPill } from "../components/ui";
import { color, font, radius } from "../theme";

function fmt(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

// The event-kind allowlist is snake_case bus vocabulary (merge_rejected, worker_stuck, …). Humanize it
// for the picker + table so a human reads "Merge rejected", not a raw identifier — the raw kind stays the
// stored value. Sentence-case: first word capitalized, underscores → spaces.
function humanizeKind(kind: string): string {
  const spaced = kind.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// Flat list of every agent across all projects, "Project / Agent" labelled — for BOTH the spawn-mode
// picker and the table's target resolution. A trigger's scope (which project's events it reacts to) is
// independent of where its target lives, so the target may be any project's agent — this stays god-eye.
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

type ModalState = { mode: "create" } | { mode: "edit"; trigger: EventTrigger } | null;

// Loom's Event Triggers — the internal-event counterpart to cron Schedules. When an orchestration event
// of the chosen kind lands on the durable bus (optionally scoped to one project, else every project), the
// trigger WAKES an existing session or SPAWNS a fresh agent. The dispatcher backend is ALWAYS ON, so a
// created trigger fires on its next matching event; this page is the human CRUD over the REST surface.
// Structure mirrors Schedules: a scannable table + a focused create/edit modal + an inline on/off toggle.
export default function EventTriggers() {
  const qc = useQueryClient();
  const [modal, setModal] = useState<ModalState>(null);

  const triggers = useQuery({ queryKey: ["eventTriggers"], queryFn: api.eventTriggers });
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const sessions = useQuery({ queryKey: ["allSessions"], queryFn: api.allSessions });
  const agents = useAllAgents();

  const projectName = (id: string | null) =>
    id == null ? "All projects" : projects.data?.find((p) => p.id === id)?.name ?? id;
  const agentLabel = (id: string) => agents.data?.find((a) => a.id === id)?.label ?? id;
  const sessionLabel = (id: string) => {
    const s = sessions.data?.find((x) => x.id === id);
    if (!s) return id;
    const title = s.title ?? s.role ?? "session";
    return `${s.projectName} / ${s.agentName} · ${title}`;
  };
  const targetLabel = (t: EventTrigger) =>
    t.mode === "wake"
      ? (t.targetSessionId ? sessionLabel(t.targetSessionId) : "—")
      : (t.agentId ? agentLabel(t.agentId) : "—");

  const invalidate = () => qc.invalidateQueries({ queryKey: ["eventTriggers"] });
  const create = useMutation({
    mutationFn: api.createEventTrigger,
    onSuccess: () => { invalidate(); setModal(null); },
  });
  const save = useMutation({
    mutationFn: (v: { id: string; patch: Parameters<typeof api.updateEventTrigger>[1] }) => api.updateEventTrigger(v.id, v.patch),
    onSuccess: () => { invalidate(); setModal(null); },
  });
  const toggle = useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) => api.updateEventTrigger(v.id, { enabled: v.enabled }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteEventTrigger(id),
    onSuccess: () => { invalidate(); setModal(null); },
  });

  const rows = triggers.data ?? [];

  return (
    <Panel style={{ alignSelf: "start" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <SectionLabel style={{ margin: 0 }}>Event Triggers</SectionLabel>
        <StatusPill tone="phosphor" label="dispatcher active" glow />
        <p style={{ color: color.textMuted, fontSize: 11, margin: 0, fontFamily: font.mono, lineHeight: 1.5, flex: 1, minWidth: 240 }}>
          React to internal orchestration events. When an event of the chosen kind fires — optionally
          scoped to one project — the trigger wakes an existing session or spawns a fresh agent. The
          dispatcher is always on; changes apply on the next matching event.
        </p>
        <Button variant="primary" onClick={() => setModal({ mode: "create" })}>+ New trigger</Button>
      </div>

      <div style={{ marginTop: 12, overflowX: "auto" }}>
        {rows.length === 0 ? (
          <p style={{ color: color.textMuted, fontSize: 13, fontFamily: font.mono, padding: "20px 4px" }}>
            No event triggers yet. Create one to wake or spawn an agent when an orchestration event fires.
          </p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: font.mono, fontSize: 12 }}>
            <thead>
              <tr>
                {["Event kind", "Scope", "Mode", "Target", "Last fired", "Status", ""].map((h, i) => (
                  <th key={h || "actions"} style={{
                    textAlign: i === 5 || i === 6 ? "right" : "left",
                    color: color.textDim, fontFamily: font.head, fontSize: 10, fontWeight: 700,
                    textTransform: "uppercase", letterSpacing: "0.08em",
                    padding: "0 12px 8px", borderBottom: `1px solid ${color.border}`, whiteSpace: "nowrap",
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} className="loom-sched-row"
                  onClick={() => setModal({ mode: "edit", trigger: t })}
                  style={{ cursor: "pointer", borderBottom: `1px solid ${color.border}` }}>
                  <td style={{ padding: "10px 12px", color: color.text, fontWeight: 600, whiteSpace: "nowrap" }}>
                    {humanizeKind(t.eventKind)}
                    <span style={{ display: "block", color: color.cyan, fontWeight: 400, fontSize: 11 }}>{t.eventKind}</span>
                  </td>
                  <td style={{ padding: "10px 12px", color: t.projectId ? color.textDim : color.textMuted, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{projectName(t.projectId)}</td>
                  <td style={{ padding: "10px 12px" }}>
                    <Badge tone={t.mode === "wake" ? "cyan" : "phosphor"}>{t.mode}</Badge>
                  </td>
                  <td style={{ padding: "10px 12px", color: color.textDim, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{targetLabel(t)}</td>
                  <td style={{ padding: "10px 12px", color: color.textDim, whiteSpace: "nowrap" }}>{fmt(t.lastFiredAt)}</td>
                  <td style={{ padding: "10px 12px", textAlign: "right" }}>
                    {/* Inline enable/disable — the most common action; row-click opens the editor (this cell stops propagation). */}
                    <button
                      onClick={(e) => { e.stopPropagation(); toggle.mutate({ id: t.id, enabled: !t.enabled }); }}
                      disabled={toggle.isPending}
                      title={t.enabled ? "Pause this trigger (stops firing)" : "Resume this trigger"}
                      aria-pressed={t.enabled}
                      style={{
                        cursor: "pointer", background: "transparent", border: `1px solid ${t.enabled ? color.phosphor : color.borderStrong}`,
                        color: t.enabled ? color.phosphor : color.textMuted, borderRadius: radius.sm,
                        fontFamily: font.mono, fontSize: 10, letterSpacing: "0.06em", padding: "2px 8px", textTransform: "uppercase",
                      }}>{t.enabled ? "On" : "Off"}</button>
                  </td>
                  <td style={{ padding: "10px 12px", textAlign: "right", whiteSpace: "nowrap" }}>
                    <span style={{ color: color.textMuted }}>Edit ›</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {modal && (
        <EventTriggerModal
          key={modal.mode === "edit" ? modal.trigger.id : "create"}
          mode={modal}
          projects={(projects.data ?? []).map((p) => ({ id: p.id, name: p.name }))}
          agents={agents.data ?? []}
          agentsLoading={agents.isLoading}
          sessions={(sessions.data ?? []).map((s) => ({ id: s.id, label: sessionLabel(s.id) }))}
          sessionsLoading={sessions.isLoading}
          onCreate={(b) => create.mutate(b)} creating={create.isPending} createError={create.error as Error | null}
          onSave={(id, patch) => save.mutate({ id, patch })} saving={save.isPending} saveError={save.error as Error | null}
          onDelete={(id) => remove.mutate(id)} deleting={remove.isPending}
          onClose={() => setModal(null)}
        />
      )}
    </Panel>
  );
}

// ── The create/edit modal ─────────────────────────────────────────────────────────────────────────

const fieldLabel = { fontFamily: font.head as string, fontSize: 11, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.08em", color: color.textDim };

function EventTriggerModal({
  mode, projects, agents, agentsLoading, sessions, sessionsLoading,
  onCreate, creating, createError,
  onSave, saving, saveError,
  onDelete, deleting, onClose,
}: {
  mode: NonNullable<ModalState>;
  projects: { id: string; name: string }[];
  agents: { id: string; label: string }[];
  agentsLoading: boolean;
  sessions: { id: string; label: string }[];
  sessionsLoading: boolean;
  onCreate: (b: { eventKind: EventTriggerEventKind; projectId: string | null; mode: EventTrigger["mode"]; targetSessionId?: string | null; agentId?: string | null; enabled?: boolean }) => void;
  creating: boolean; createError: Error | null;
  onSave: (id: string, patch: { eventKind?: EventTriggerEventKind; projectId?: string | null; mode?: EventTrigger["mode"]; targetSessionId?: string | null; agentId?: string | null; enabled?: boolean }) => void;
  saving: boolean; saveError: Error | null;
  onDelete: (id: string) => void; deleting: boolean;
  onClose: () => void;
}) {
  const editing = mode.mode === "edit";
  const existing = editing ? mode.trigger : null;

  const [eventKind, setEventKind] = useState<EventTriggerEventKind>(existing?.eventKind ?? EVENT_TRIGGER_EVENT_KINDS[0]);
  // "" sentinel = All projects (null). Kept as a string for the <select>; mapped back to null on submit.
  const [projectId, setProjectId] = useState<string>(existing?.projectId ?? "");
  const [triggerMode, setTriggerMode] = useState<EventTrigger["mode"]>(existing?.mode ?? "wake");
  const [targetSessionId, setTargetSessionId] = useState<string>(existing?.targetSessionId ?? "");
  const [agentId, setAgentId] = useState<string>(existing?.agentId ?? "");
  const [enabled, setEnabled] = useState<boolean>(existing?.enabled ?? true);
  const [confirmDel, setConfirmDel] = useState(false);

  // Client-side mode↔target coherence — mirrors the REST validator so the user gets an inline block, not a
  // 404: wake requires a session, spawn requires an agent.
  const targetOk = triggerMode === "wake" ? !!targetSessionId : !!agentId;
  const noAgents = !agentsLoading && agents.length === 0;
  const noSessions = !sessionsLoading && sessions.length === 0;
  const valid = targetOk;

  const submit = () => {
    if (!valid) return;
    const proj = projectId === "" ? null : projectId;
    if (editing) {
      onSave(existing!.id, {
        eventKind, projectId: proj, mode: triggerMode,
        // Send only the active target; the server clears the other side on re-validate.
        targetSessionId: triggerMode === "wake" ? targetSessionId : null,
        agentId: triggerMode === "spawn" ? agentId : null,
        enabled,
      });
    } else {
      onCreate({
        eventKind, projectId: proj, mode: triggerMode,
        targetSessionId: triggerMode === "wake" ? targetSessionId : undefined,
        agentId: triggerMode === "spawn" ? agentId : undefined,
        enabled,
      });
    }
  };

  const mutError = editing ? saveError : createError;
  const busy = creating || saving;

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "8vh", paddingBottom: "4vh", zIndex: 1000, overflowY: "auto" }}>
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
        role="dialog" aria-modal="true" aria-label={editing ? "Edit event trigger" : "New event trigger"}
        style={{ width: 620, maxWidth: "92vw", background: color.panel, border: `1px solid ${color.borderStrong}`, borderRadius: radius.base, display: "flex", flexDirection: "column", gap: 14, padding: 18 }}>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <strong style={{ fontFamily: font.head, textTransform: "uppercase", letterSpacing: "0.08em", color: color.text }}>
            {editing ? "Edit event trigger" : "New event trigger"}
          </strong>
          <span style={{ flex: 1 }} />
          <Button variant="ghost" onClick={onClose} aria-label="Close">✕</Button>
        </div>

        {/* Event kind — sourced from the shared allowlist */}
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={fieldLabel}>Event kind</span>
          <Select value={eventKind} onChange={(e) => setEventKind(e.target.value as EventTriggerEventKind)}>
            {EVENT_TRIGGER_EVENT_KINDS.map((k) => <option key={k} value={k}>{humanizeKind(k)} · {k}</option>)}
          </Select>
        </label>

        {/* Project scope — explicit "All projects" (null) */}
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={fieldLabel}>Scope <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0, color: color.textMuted }}>· which project's events fire this</span></span>
          <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">All projects</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </label>

        {/* Mode segmented control — swaps the target picker below */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={fieldLabel}>When it fires</span>
          <div style={{ display: "flex", gap: 6 }}>
            {(["wake", "spawn"] as const).map((m) => {
              const active = triggerMode === m;
              return (
                <Button key={m} variant={active ? "primary" : "default"} aria-pressed={active}
                  onClick={() => setTriggerMode(m)}>
                  {m === "wake" ? "Wake a session" : "Spawn an agent"}
                </Button>
              );
            })}
          </div>
        </div>

        {/* Target — a session (wake) or an agent (spawn) */}
        {triggerMode === "wake" ? (
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={fieldLabel}>Target session</span>
            <Select value={targetSessionId} onChange={(e) => setTargetSessionId(e.target.value)} disabled={sessionsLoading || noSessions}>
              <option value="">{sessionsLoading ? "Loading sessions…" : noSessions ? "— no sessions available —" : "— select a session —"}</option>
              {sessions.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </Select>
            {noSessions && <span style={{ color: color.amber, fontSize: 11, fontFamily: font.mono }}>No sessions exist yet — start one first, or use Spawn instead.</span>}
            {!targetSessionId && !noSessions && !sessionsLoading && <span style={{ color: color.amber, fontSize: 11, fontFamily: font.mono }}>Wake mode requires a target session.</span>}
          </label>
        ) : (
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={fieldLabel}>Target agent <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0, color: color.textMuted }}>· a fresh session spawns in it</span></span>
            <Select value={agentId} onChange={(e) => setAgentId(e.target.value)} disabled={agentsLoading || noAgents}>
              <option value="">{agentsLoading ? "Loading agents…" : noAgents ? "— no agents available —" : "— select an agent —"}</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </Select>
            {noAgents && <span style={{ color: color.amber, fontSize: 11, fontFamily: font.mono }}>No agents exist yet — create one on the Projects page first.</span>}
            {!agentId && !noAgents && !agentsLoading && <span style={{ color: color.amber, fontSize: 11, fontFamily: font.mono }}>Spawn mode requires a target agent.</span>}
          </label>
        )}

        {/* Enabled */}
        <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} style={{ accentColor: "var(--loom-phosphor)", width: 16, height: 16 }} />
          <span style={{ ...fieldLabel, textTransform: "none", letterSpacing: 0, fontFamily: font.mono, fontWeight: 400, fontSize: 12, color: color.textDim }}>
            Enabled {enabled ? <Chip value="on" tone="phosphor" /> : <Chip value="off" tone="muted" />}
          </span>
        </label>

        {mutError && <span style={{ color: color.red, fontSize: 12, fontFamily: font.mono }}>{mutError.message}</span>}

        {/* Actions */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
          <Button variant="primary" disabled={!valid || busy} onClick={submit}>
            {busy ? (editing ? "Saving…" : "Creating…") : editing ? "Save changes" : "Create trigger"}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
          <span style={{ flex: 1 }} />
          {editing && (confirmDel ? (
            <>
              <span style={{ color: color.red, fontSize: 12, fontFamily: font.mono }}>delete?</span>
              <Button variant="danger" disabled={deleting} onClick={() => onDelete(existing!.id)}>Confirm</Button>
              <Button onClick={() => setConfirmDel(false)}>Keep</Button>
            </>
          ) : <Button variant="danger" onClick={() => setConfirmDel(true)}>Delete</Button>)}
        </div>
      </div>
    </div>
  );
}
