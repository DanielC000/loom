import { useMemo, useState, type CSSProperties } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Schedule, CronBuilderState, CronFrequency } from "@loom/shared";
import { cronFromBuilder, describeCron, parseCronToBuilder, defaultBuilderState } from "@loom/shared";
import { api } from "../lib/api";
import { useActiveProject } from "../lib/activeProject";
import { Panel, Button, Input, Select, SectionLabel, Badge, Chip, StatusPill } from "../components/ui";
import { color, font, radius } from "../theme";

// A 5-field cron is the daemon's contract (Schedule.cron). Cheap client-side gate for the raw-cron
// escape hatch: exactly five whitespace-separated fields — enough to catch a fat-fingered expression
// before the round-trip. The daemon does the REAL parse (nextFireAt) and 400s anything it can't
// compute. Exported so the Platform page's Auditor-schedule control reuses the SAME gate.
export function looksLikeCron(s: string): boolean {
  const t = s.trim();
  return t.length > 0 && t.split(/\s+/).length === 5;
}

function fmt(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

// Inline code chip for env-var / config names in the scheduler-off notice — a hairline-bordered mono
// token so the copy reads as "set THIS", not free prose.
const codeStyle: CSSProperties = {
  fontFamily: font.mono, fontSize: 11, color: color.text, background: color.panel2,
  border: `1px solid ${color.border}`, borderRadius: radius.sm, padding: "1px 5px", whiteSpace: "nowrap",
};

// Flat list of every agent across all projects, with a "Project / Agent" label — for TABLE label
// resolution only (the table stays god-eye: it shows schedules targeting any project). The builder's
// agent picker does NOT use this — it is scoped to the active project (see ScheduleBuilder).
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

type ModalState = { mode: "create" } | { mode: "edit"; schedule: Schedule } | null;

// Loom's cron Schedules — the trigger layer (phase-2 Pillar B). On each due boundary the daemon
// Scheduler boots a manager session in the target agent (its startupPrompt is the kickoff). The
// scheduler BACKEND already runs; this page is the human CRUD over the REST surface. Edits take effect
// on the next tick (the daemon re-reads the table each minute). Direction B: a scannable table +
// a focused modal builder (friendly frequency controls that compose to a cron), every schedule named.
export default function Schedules() {
  const qc = useQueryClient();
  const { projectId } = useActiveProject();
  const [modal, setModal] = useState<ModalState>(null);

  const schedules = useQuery({ queryKey: ["schedules"], queryFn: api.schedules });
  // The boot-time cron-Scheduler gate. The daemon only starts the ticker when this is true, so a
  // schedule created while it's off is saved but never fires — surface that honestly (below). Gate the
  // warning on an explicit `=== false` so it doesn't flash while the status is still loading.
  const orch = useQuery({ queryKey: ["orchestrationStatus"], queryFn: api.orchestrationStatus });
  const schedulerOff = orch.data?.schedulerEnabled === false;
  const agents = useAllAgents();
  const agentLabel = (id: string) => agents.data?.find((a) => a.id === id)?.label ?? id;
  // The builder's agent dropdown is scoped to the ACTIVE project's agents (re-scopes on project switch).
  const projectAgents = useQuery({ queryKey: ["agents", projectId], queryFn: () => api.agents(projectId), enabled: !!projectId });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["schedules"] });
  const create = useMutation({
    mutationFn: (b: { name: string; agentId: string; cron: string; enabled: boolean; prompt?: string }) => api.createSchedule(b),
    onSuccess: () => { invalidate(); setModal(null); },
  });
  const save = useMutation({
    mutationFn: (v: { id: string; patch: { name?: string; cron?: string; prompt?: string | null } }) => api.updateSchedule(v.id, v.patch),
    onSuccess: () => { invalidate(); setModal(null); },
  });
  const toggle = useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) => api.updateSchedule(v.id, { enabled: v.enabled }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteSchedule(id),
    onSuccess: () => { invalidate(); setModal(null); },
  });

  const rows = schedules.data ?? [];

  return (
    <Panel style={{ alignSelf: "start" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <SectionLabel style={{ margin: 0 }}>Schedules</SectionLabel>
        {orch.data && (
          <StatusPill
            tone={orch.data.schedulerEnabled ? "phosphor" : "amber"}
            label={orch.data.schedulerEnabled ? "scheduler active" : "scheduler off"}
            glow={orch.data.schedulerEnabled}
          />
        )}
        <p style={{ color: color.textMuted, fontSize: 11, margin: 0, fontFamily: font.mono, lineHeight: 1.5, flex: 1, minWidth: 240 }}>
          Cron triggers. On each due boundary the daemon boots a manager session in the target agent —
          the agent's startup prompt is the kickoff, optionally followed by this schedule's own task
          prompt. Human-managed; changes apply on the next tick.
        </p>
        <Button variant="primary" onClick={() => setModal({ mode: "create" })}>+ New schedule</Button>
      </div>

      {/* State-driven honesty: when the daemon's Scheduler is off (the default), a created schedule is
          saved but never fires — say so plainly, with the two ways to turn it on. */}
      {schedulerOff && (
        <div role="status" style={{
          marginTop: 12, display: "flex", alignItems: "flex-start", gap: 10, flexWrap: "wrap",
          padding: "10px 12px", border: `1px solid ${color.amber}`, borderRadius: radius.base,
          background: "rgba(232,168,68,0.06)",
        }}>
          <Badge tone="amber">scheduler off</Badge>
          <p style={{ margin: 0, flex: 1, minWidth: 260, color: color.textDim, fontFamily: font.mono, fontSize: 12, lineHeight: 1.6 }}>
            The cron scheduler is disabled, so schedules you create here are saved but{" "}
            <strong style={{ color: color.amber, fontWeight: 700 }}>will not fire</strong>. To enable it, set{" "}
            <code style={codeStyle}>LOOM_SCHEDULER_ENABLED=1</code> in the daemon's environment (or turn on{" "}
            <code style={codeStyle}>orchestration.schedulerEnabled</code> in config), then restart the daemon.
          </p>
        </div>
      )}

      <div style={{ marginTop: 12, overflowX: "auto" }}>
        {rows.length === 0 ? (
          <p style={{ color: color.textMuted, fontSize: 13, fontFamily: font.mono, padding: "20px 4px" }}>
            No schedules yet. Create one to run an agent on a cron cadence.
          </p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: font.mono, fontSize: 12 }}>
            <thead>
              <tr>
                {["Name", "Agent", "Schedule", "Cron", "Next run", "Status", ""].map((h, i) => (
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
              {rows.map((s) => (
                <tr key={s.id} className="loom-sched-row"
                  onClick={() => setModal({ mode: "edit", schedule: s })}
                  style={{ cursor: "pointer", borderBottom: `1px solid ${color.border}` }}>
                  <td style={{ padding: "10px 12px", color: color.text, fontWeight: 600, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</td>
                  <td style={{ padding: "10px 12px", color: color.textDim, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{agentLabel(s.agentId)}</td>
                  <td style={{ padding: "10px 12px", color: color.text, whiteSpace: "nowrap" }}>{describeCron(s.cron)}</td>
                  <td style={{ padding: "10px 12px", whiteSpace: "nowrap" }}><span style={{ color: color.cyan }}>{s.cron}</span></td>
                  <td style={{ padding: "10px 12px", color: color.textDim, whiteSpace: "nowrap" }}>{fmt(s.nextFireAt)}</td>
                  <td style={{ padding: "10px 12px", textAlign: "right" }}>
                    {/* Inline enable/disable — the most common action; row-click (the cell stops propagation) opens the editor. */}
                    <button
                      onClick={(e) => { e.stopPropagation(); toggle.mutate({ id: s.id, enabled: !s.enabled }); }}
                      disabled={toggle.isPending}
                      title={s.enabled ? "Pause this schedule (stops firing)" : "Resume this schedule"}
                      aria-pressed={s.enabled}
                      style={{
                        cursor: "pointer", background: "transparent", border: `1px solid ${s.enabled ? color.phosphor : color.borderStrong}`,
                        color: s.enabled ? color.phosphor : color.textMuted, borderRadius: radius.sm,
                        fontFamily: font.mono, fontSize: 10, letterSpacing: "0.06em", padding: "2px 8px", textTransform: "uppercase",
                      }}>{s.enabled ? "On" : "Off"}</button>
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
        <ScheduleBuilderModal
          key={modal.mode === "edit" ? modal.schedule.id : "create"}
          mode={modal}
          agentLabel={modal.mode === "edit" ? agentLabel(modal.schedule.agentId) : ""}
          projectAgents={(projectAgents.data ?? []).map((a) => ({ id: a.id, label: a.name }))}
          agentsLoading={projectAgents.isLoading}
          onCreate={(b) => create.mutate(b)} creating={create.isPending} createError={create.error as Error | null}
          onSave={(id, patch) => save.mutate({ id, patch })} saving={save.isPending} saveError={save.error as Error | null}
          onDelete={(id) => remove.mutate(id)} deleting={remove.isPending}
          onClose={() => setModal(null)}
        />
      )}
    </Panel>
  );
}

// ── The builder modal ────────────────────────────────────────────────────────────────────────────

const FREQUENCIES: { value: CronFrequency; label: string }[] = [
  { value: "hourly", label: "Hourly" },
  { value: "everyNHours", label: "Every N hrs" },
  { value: "daily", label: "Daily" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "custom", label: "Custom" },
];

const DOW = [
  { v: 0, label: "Sun" }, { v: 1, label: "Mon" }, { v: 2, label: "Tue" }, { v: 3, label: "Wed" },
  { v: 4, label: "Thu" }, { v: 5, label: "Fri" }, { v: 6, label: "Sat" },
];

const hourLabel = (h: number): string => {
  const period = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:00 ${period}`;
};

// Minute options in 5-min increments — plus the current value if it isn't a multiple of 5 (so a legacy
// cron like `7 9 * * *` still shows its real minute rather than snapping blank).
const minuteOptions = (current: number): number[] => {
  const base = Array.from({ length: 12 }, (_, i) => i * 5);
  return base.includes(current) ? base : [...base, current].sort((a, b) => a - b);
};

const fieldLabel = { fontFamily: font.head as string, fontSize: 11, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.08em", color: color.textDim };

function ScheduleBuilderModal({
  mode, agentLabel, projectAgents, agentsLoading,
  onCreate, creating, createError,
  onSave, saving, saveError,
  onDelete, deleting, onClose,
}: {
  mode: NonNullable<ModalState>;
  agentLabel: string;
  projectAgents: { id: string; label: string }[];
  agentsLoading: boolean;
  onCreate: (b: { name: string; agentId: string; cron: string; enabled: boolean; prompt?: string }) => void;
  creating: boolean; createError: Error | null;
  onSave: (id: string, patch: { name?: string; cron?: string; prompt?: string | null }) => void;
  saving: boolean; saveError: Error | null;
  onDelete: (id: string) => void; deleting: boolean;
  onClose: () => void;
}) {
  const editing = mode.mode === "edit";
  const existing = editing ? mode.schedule : null;

  const [name, setName] = useState(existing?.name ?? "");
  const [agentId, setAgentId] = useState("");
  const [builder, setBuilder] = useState<CronBuilderState>(
    existing ? parseCronToBuilder(existing.cron) : defaultBuilderState(),
  );
  const [prompt, setPrompt] = useState(existing?.prompt ?? "");
  // The raw-cron escape hatch is auto-open when editing lands on a custom cron the builder couldn't model.
  const [advanced, setAdvanced] = useState(builder.frequency === "custom");
  const [confirmDel, setConfirmDel] = useState(false);

  const set = (patch: Partial<CronBuilderState>) => setBuilder((b) => ({ ...b, ...patch }));
  const cron = cronFromBuilder(builder);
  const summary = describeCron(cron);

  const noAgents = !agentsLoading && projectAgents.length === 0;
  const cronValid = looksLikeCron(cron);
  const weeklyNeedsDay = builder.frequency === "weekly" && builder.daysOfWeek.length === 0;
  const nameValid = name.trim().length > 0;
  const agentOk = editing || !!agentId;
  const valid = nameValid && agentOk && cronValid && !weeklyNeedsDay;

  // Live preview: the human summary is computed client-side (shared describeCron — instant); the REAL
  // next-runs come from the daemon, computed with the SAME matcher the Scheduler fires on, so the preview
  // can never drift from what actually runs. Keyed on the cron (react-query dedupes), gated on a
  // well-formed 5-field expression so we don't spam the endpoint on half-typed raw input.
  const preview = useQuery({
    queryKey: ["schedulePreview", cron],
    queryFn: () => api.previewSchedule(cron),
    enabled: cronValid && !weeklyNeedsDay,
    staleTime: 30_000,
  });

  const submit = () => {
    if (!valid) return;
    if (editing) {
      onSave(existing!.id, {
        ...(name.trim() !== existing!.name ? { name: name.trim() } : {}),
        ...(cron !== existing!.cron ? { cron } : {}),
        ...(prompt !== (existing!.prompt ?? "") ? { prompt: prompt.trim() || null } : {}),
      });
    } else {
      onCreate({ name: name.trim(), agentId, cron, enabled: true, prompt: prompt.trim() || undefined });
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
        role="dialog" aria-modal="true" aria-label={editing ? "Edit schedule" : "New schedule"}
        style={{ width: 620, maxWidth: "92vw", background: color.panel, border: `1px solid ${color.borderStrong}`, borderRadius: radius.base, display: "flex", flexDirection: "column", gap: 14, padding: 18 }}>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <strong style={{ fontFamily: font.head, textTransform: "uppercase", letterSpacing: "0.08em", color: color.text }}>
            {editing ? "Edit schedule" : "New schedule"}
          </strong>
          <span style={{ flex: 1 }} />
          <Button variant="ghost" onClick={onClose} aria-label="Close">✕</Button>
        </div>

        {/* Name — mandatory */}
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={fieldLabel}>Name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Nightly PR sweep" autoFocus spellCheck={false} />
          {!nameValid && <span style={{ color: color.amber, fontSize: 11, fontFamily: font.mono }}>A name is required.</span>}
        </label>

        {/* Target agent — chosen on create, fixed after */}
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={fieldLabel}>Target agent {editing && <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0, color: color.textMuted }}>· fixed after create</span>}</span>
          {editing ? (
            <Input value={agentLabel} disabled />
          ) : (
            <>
              <Select value={agentId} onChange={(e) => setAgentId(e.target.value)} disabled={agentsLoading || noAgents}>
                <option value="">{agentsLoading ? "Loading agents…" : noAgents ? "— no agents in this project —" : "— select an agent —"}</option>
                {projectAgents.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
              </Select>
              {noAgents && <span style={{ color: color.amber, fontSize: 11, fontFamily: font.mono }}>This project has no agents yet — create one on the Projects page first.</span>}
            </>
          )}
        </label>

        {/* Frequency segmented control */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={fieldLabel}>Frequency</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {FREQUENCIES.map((f) => {
              const active = builder.frequency === f.value;
              return (
                <Button key={f.value} variant={active ? "primary" : "default"}
                  aria-pressed={active}
                  onClick={() => { set({ frequency: f.value, ...(f.value === "custom" ? { raw: cron } : {}) }); if (f.value === "custom") setAdvanced(true); }}>
                  {f.label}
                </Button>
              );
            })}
          </div>
        </div>

        {/* Contextual controls per frequency */}
        <FrequencyControls builder={builder} set={set} />
        {weeklyNeedsDay && <span style={{ color: color.amber, fontSize: 11, fontFamily: font.mono }}>Pick at least one day.</span>}

        {/* Live preview: human summary + generated cron chip + real next-3 runs */}
        <div style={{ background: color.panel2, border: `1px solid ${color.border}`, borderRadius: radius.base, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ color: color.phosphor, fontFamily: font.mono, fontSize: 13 }}>{cronValid ? summary : "Incomplete cron"}</span>
            <Chip label="cron" value={cronValid ? cron : "—"} tone="cyan" />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <span style={{ ...fieldLabel, fontSize: 10 }}>Next runs</span>
            {!cronValid ? (
              <span style={{ color: color.textMuted, fontSize: 12, fontFamily: font.mono }}>—</span>
            ) : preview.data && !preview.data.valid ? (
              <span style={{ color: color.red, fontSize: 12, fontFamily: font.mono }}>Daemon could not parse this cron.</span>
            ) : preview.data?.next?.length ? (
              preview.data.next.map((iso, i) => (
                <span key={i} style={{ color: color.textDim, fontSize: 12, fontFamily: font.mono }}>{fmt(iso)}</span>
              ))
            ) : (
              <span style={{ color: color.textMuted, fontSize: 12, fontFamily: font.mono }}>{preview.isFetching ? "computing…" : "—"}</span>
            )}
          </div>
        </div>

        {/* Advanced: raw-cron escape hatch (editing raw flips frequency → custom) */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <button onClick={() => setAdvanced((a) => !a)}
            style={{ alignSelf: "flex-start", background: "transparent", border: "none", color: color.textDim, fontFamily: font.mono, fontSize: 11, cursor: "pointer", padding: 0, textTransform: "uppercase", letterSpacing: "0.06em" }}>
            {advanced ? "▾" : "▸"} Advanced · raw cron
          </button>
          {advanced && (
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ ...fieldLabel, fontWeight: 400, textTransform: "none", letterSpacing: 0, color: color.textMuted, fontSize: 11 }}>5 fields: min hour dom mon dow · editing this switches to Custom</span>
              <Input
                value={builder.frequency === "custom" ? builder.raw : cron}
                onChange={(e) => set({ frequency: "custom", raw: e.target.value })}
                placeholder="0 9 * * *" spellCheck={false} />
              {!cronValid && (builder.frequency === "custom" ? builder.raw : cron).trim().length > 0 &&
                <span style={{ color: color.amber, fontSize: 11, fontFamily: font.mono }}>Expected 5 whitespace-separated fields.</span>}
            </label>
          )}
        </div>

        {/* Task prompt — optional */}
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={fieldLabel}>Task prompt <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0, color: color.textMuted }}>· optional, appended after the agent's own startup prompt</span></span>
          <textarea
            style={{ minHeight: 72, width: "100%", boxSizing: "border-box", resize: "vertical", background: color.panel2, color: color.text, border: `1px solid ${color.borderStrong}`, borderRadius: radius.base, padding: 8, fontFamily: font.mono, fontSize: 13, lineHeight: 1.5 }}
            placeholder="e.g. Review the open PRs and merge anything green."
            value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </label>

        {mutError && <span style={{ color: color.red, fontSize: 12, fontFamily: font.mono }}>{mutError.message.includes("400") ? "Daemon rejected the request (check the cron and name)." : mutError.message}</span>}

        {/* Actions */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
          <Button variant="primary" disabled={!valid || busy} onClick={submit}>
            {busy ? (editing ? "Saving…" : "Creating…") : editing ? "Save changes" : "Create schedule"}
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

// The per-frequency contextual controls. Each frequency reads only the builder fields it needs.
function FrequencyControls({ builder, set }: { builder: CronBuilderState; set: (patch: Partial<CronBuilderState>) => void }) {
  const f = builder.frequency;
  if (f === "custom") return null;

  const timeOfDay = (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={fieldLabel}>At</span>
      <div style={{ display: "flex", gap: 6 }}>
        <Select value={builder.hour} onChange={(e) => set({ hour: Number(e.target.value) })} aria-label="Hour" style={{ flex: 1 }}>
          {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
        </Select>
        <Select value={builder.minute} onChange={(e) => set({ minute: Number(e.target.value) })} aria-label="Minute" style={{ width: 100 }}>
          {minuteOptions(builder.minute).map((m) => <option key={m} value={m}>:{String(m).padStart(2, "0")}</option>)}
        </Select>
      </div>
    </label>
  );

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
      {f === "hourly" && (
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={fieldLabel}>At minute</span>
          <Select value={builder.minute} onChange={(e) => set({ minute: Number(e.target.value) })} aria-label="At minute" style={{ width: 120 }}>
            {minuteOptions(builder.minute).map((m) => <option key={m} value={m}>:{String(m).padStart(2, "0")}</option>)}
          </Select>
        </label>
      )}

      {f === "everyNHours" && (
        <>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={fieldLabel}>Every</span>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Input type="number" min={2} max={23} value={builder.interval}
                onChange={(e) => set({ interval: Math.max(2, Math.min(23, Number(e.target.value) || 2)) })}
                style={{ width: 72 }} aria-label="Interval in hours" />
              <span style={{ color: color.textDim, fontFamily: font.mono, fontSize: 12 }}>hours</span>
            </div>
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={fieldLabel}>At minute</span>
            <Select value={builder.minute} onChange={(e) => set({ minute: Number(e.target.value) })} aria-label="At minute" style={{ width: 120 }}>
              {minuteOptions(builder.minute).map((m) => <option key={m} value={m}>:{String(m).padStart(2, "0")}</option>)}
            </Select>
          </label>
        </>
      )}

      {(f === "daily" || f === "weekdays") && timeOfDay}

      {f === "weekly" && (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={fieldLabel}>On days</span>
            <div style={{ display: "flex", gap: 4 }}>
              {DOW.map((d) => {
                const on = builder.daysOfWeek.includes(d.v);
                return (
                  <button key={d.v} type="button" aria-pressed={on}
                    onClick={() => set({ daysOfWeek: on ? builder.daysOfWeek.filter((x) => x !== d.v) : [...builder.daysOfWeek, d.v] })}
                    style={{
                      cursor: "pointer", background: on ? color.phosphorDim : "transparent",
                      border: `1px solid ${on ? color.phosphor : color.borderStrong}`, color: on ? color.phosphor : color.textDim,
                      borderRadius: radius.sm, fontFamily: font.mono, fontSize: 11, padding: "4px 8px", minWidth: 40,
                    }}>{d.label}</button>
                );
              })}
            </div>
          </div>
          {timeOfDay}
        </>
      )}

      {f === "monthly" && (
        <>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={fieldLabel}>Day of month</span>
            <Input type="number" min={1} max={31} value={builder.dayOfMonth}
              onChange={(e) => set({ dayOfMonth: Math.max(1, Math.min(31, Number(e.target.value) || 1)) })}
              style={{ width: 72 }} aria-label="Day of month" />
          </label>
          {timeOfDay}
        </>
      )}
    </div>
  );
}
