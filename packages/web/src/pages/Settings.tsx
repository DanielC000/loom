import { useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  resolveConfig,
  type Project,
  type ProjectConfigOverride,
  type OrchestrationConfig,
} from "@loom/shared";
import { api } from "../lib/api";
import { useActiveProject } from "../lib/activeProject";
import { Panel, Button, Input, Select, SectionLabel } from "../components/ui";
import { color, font } from "../theme";

// Project-scoped settings — edit the per-project config OVERRIDE (deep-partial of ResolvedConfig).
// Scoped to the header's active project; switching it re-scopes (the editor is keyed by project id).
// Every field edits the OVERRIDE while showing the EFFECTIVE resolved value as a hint; a blank/inherit
// field is omitted from the override and falls back to the platform default. Save REPLACES the whole
// override via PATCH /api/projects/:id/config (the human/REST path — gateCommand is editable here by
// design; only the agent MCP path rejects it). A strict-zod 400 surfaces verbatim.
export default function Settings() {
  const { projectId, projects } = useActiveProject();
  const project = projects.find((p) => p.id === projectId) ?? null;

  return (
    <div style={{ maxWidth: 820 }}>
      <SectionLabel>Project Settings</SectionLabel>
      {project ? (
        <ConfigEditor key={project.id} project={project} />
      ) : (
        <Panel>
          <p style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 13, margin: 0 }}>
            No active project. Pick one in the header to edit its config.
          </p>
        </Panel>
      )}
    </div>
  );
}

const fieldLabel = {
  fontFamily: font.head as string, fontSize: 11, fontWeight: 700 as const,
  textTransform: "uppercase" as const, letterSpacing: "0.08em", color: color.textDim,
};
const ta = {
  width: "100%", boxSizing: "border-box" as const, resize: "vertical" as const,
  fontFamily: font.mono, fontSize: 13, lineHeight: 1.5,
  background: color.panel2, color: color.text, border: `1px solid ${color.border}`, borderRadius: 6, padding: 8,
};

// One line per `key: Label`; a line without a colon uses the whole line as both. Empty → null (inherit).
function parseColumns(text: string): { key: string; label: string }[] | null {
  const cols = text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const i = l.indexOf(":");
    if (i < 0) return { key: l, label: l };
    return { key: l.slice(0, i).trim(), label: l.slice(i + 1).trim() };
  });
  return cols.length ? cols : null;
}
function parseLines(text: string): string[] {
  return text.split("\n").map((l) => l.trim()).filter(Boolean);
}

function ConfigEditor({ project }: { project: Project }) {
  const qc = useQueryClient();
  const ov = project.config; // the stored override
  const resolved = resolveConfig(ov); // effective values, shown as hints
  // The true PLATFORM default (resolveConfig with NO override) — what blanking/inheriting a field
  // reverts to. Inherit/default hints must show THIS, not the current override-effective value, or
  // they'd misrepresent the revert target. (CLAUDE.md: defaults come only from resolveConfig.)
  const defaults = resolveConfig(undefined);

  // Override-backed form state. "" / "inherit" means NOT overridden (omitted on save → inherits default).
  const [columnsText, setColumnsText] = useState(
    ov.kanbanColumns ? ov.kanbanColumns.map((c) => `${c.key}: ${c.label}`).join("\n") : "",
  );
  const [allowText, setAllowText] = useState(ov.permission?.allow ? ov.permission.allow.join("\n") : "");
  const [gateCommand, setGateCommand] = useState(ov.orchestration?.gateCommand ?? "");
  const [maxWorkers, setMaxWorkers] = useState(numStr(ov.orchestration?.maxConcurrentWorkers));
  const [maxManagers, setMaxManagers] = useState(numStr(ov.orchestration?.maxConcurrentManagers));
  const [recycle, setRecycle] = useState(numStr(ov.orchestration?.recycleAtContextRatio));
  const [idleNudge, setIdleNudge] = useState(numStr(ov.orchestration?.idleNudgeMinutes));
  const [maxUnanswered, setMaxUnanswered] = useState(numStr(ov.orchestration?.maxUnansweredNudges));
  const [idleSnooze, setIdleSnooze] = useState(numStr(ov.orchestration?.idleDefaultSnoozeMinutes));
  const [scheduler, setScheduler] = useState(triStr(ov.orchestration?.schedulerEnabled));
  const [docLint, setDocLint] = useState(triStr(ov.docLint));

  // Build the OVERRIDE from the current form. CRITICAL: the PATCH REPLACES the whole override, so we
  // start from a clone of the stored one and apply only the fields this UI models — preserving keys it
  // does NOT model (pty, sessionEnv, permission.mode/deny/startupModeCycles) instead of silently wiping
  // them. A modeled field set to blank/inherit is DELETED so it falls back to the platform default.
  // Numbers parse with Number() so a non-numeric entry sends NaN→null and the strict-zod PATCH 400s
  // with a readable "Expected number" — the demonstrable error path.
  function buildOverride(): ProjectConfigOverride {
    const o: ProjectConfigOverride = structuredClone(ov);

    const cols = parseColumns(columnsText);
    if (cols) o.kanbanColumns = cols; else delete o.kanbanColumns;

    const allow = parseLines(allowText);
    if (allow.length) {
      o.permission = { ...o.permission, allow };
    } else if (o.permission) {
      const { allow: _drop, ...rest } = o.permission;
      if (Object.keys(rest).length) o.permission = rest; else delete o.permission;
    }

    const orch: Partial<OrchestrationConfig> = { ...o.orchestration };
    if (gateCommand.trim()) orch.gateCommand = gateCommand.trim(); else delete orch.gateCommand;
    applyNum(orch, "maxConcurrentWorkers", maxWorkers);
    applyNum(orch, "maxConcurrentManagers", maxManagers);
    applyNum(orch, "recycleAtContextRatio", recycle);
    applyNum(orch, "idleNudgeMinutes", idleNudge);
    applyNum(orch, "maxUnansweredNudges", maxUnanswered);
    applyNum(orch, "idleDefaultSnoozeMinutes", idleSnooze);
    if (scheduler !== "inherit") orch.schedulerEnabled = scheduler === "true"; else delete orch.schedulerEnabled;
    if (Object.keys(orch).length) o.orchestration = orch; else delete o.orchestration;

    if (docLint !== "inherit") o.docLint = docLint === "true"; else delete o.docLint;
    return o;
  }

  // Snapshot the NORMALIZED baseline override (buildOverride() on mount round-trips the stored config
  // into this UI's canonical key order, so `dirty` is false until a field actually changes — not merely
  // because the stored key order differs). The baseline is a MUTABLE ref: a successful save re-points it
  // at the just-saved value so the form drops "unsaved changes" without waiting for a remount. Keyed by
  // project id → a project switch remounts + re-snapshots.
  const built = buildOverride();
  const builtJson = JSON.stringify(built);
  const baseline = useRef(builtJson);
  const dirty = builtJson !== baseline.current;

  const save = useMutation({
    mutationFn: () => api.updateProjectConfig(project.id, built),
    // Surface this mutation's failures INLINE (see the Save row below); tell the global mutation-error
    // handler to skip its blocking window.alert for this one.
    meta: { inlineError: true },
    onSuccess: (updated) => {
      // The just-saved override is now the clean baseline — clearing the dirty flag immediately.
      baseline.current = builtJson;
      // Patch the cached projects list so the header + this editor re-read the persisted override
      // immediately (a re-read shows it). Remount via the key happens on the next project switch.
      qc.setQueryData<Project[]>(["projects"], (prev) =>
        prev ? prev.map((p) => (p.id === updated.id ? updated : p)) : prev,
      );
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["board", project.id] });
    },
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Panel>
        <p style={{ color: color.textMuted, fontSize: 11, margin: "0 0 4px", fontFamily: font.mono, lineHeight: 1.5 }}>
          Editing <span style={{ color: color.text }}>{project.name}</span>. Each field overrides the
          platform default; leave it blank / <em>inherit</em> to fall back. The hint shows the current
          effective value.
        </p>
      </Panel>

      <Panel>
        <SectionLabel>Kanban Columns</SectionLabel>
        <Field hint={`effective: ${resolved.kanbanColumns.map((c) => c.key).join(", ")}`}>
          <textarea value={columnsText} onChange={(e) => setColumnsText(e.target.value)} spellCheck={false}
            style={{ ...ta, minHeight: 120 }} placeholder={"backlog: Backlog\ntodo: To Do\nin_progress: In Progress\ndone: Done"} />
          <Hint>one <code>key: Label</code> per line · blank inherits the default board</Hint>
        </Field>
      </Panel>

      <Panel>
        <SectionLabel>Permission Allowlist</SectionLabel>
        <Field hint={`effective: ${resolved.permission.allow.length} glob(s)`}>
          <textarea value={allowText} onChange={(e) => setAllowText(e.target.value)} spellCheck={false}
            style={{ ...ta, minHeight: 110 }} placeholder={"mcp__loom-tasks\nBash(git status:*)\nBash(pnpm *)"} />
          <Hint>one permission glob per line · overriding REPLACES the default allowlist · blank inherits it</Hint>
          <Hint>inherited default: <span style={{ color: color.textDim }}>{defaults.permission.allow.join(", ") || "—"}</span></Hint>
        </Field>
      </Panel>

      <Panel>
        <SectionLabel>Orchestration Caps</SectionLabel>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          <NumField label="Max workers / manager" value={maxWorkers} set={setMaxWorkers} effective={resolved.orchestration.maxConcurrentWorkers} def={defaults.orchestration.maxConcurrentWorkers} />
          <NumField label="Max managers" value={maxManagers} set={setMaxManagers} effective={resolved.orchestration.maxConcurrentManagers} def={defaults.orchestration.maxConcurrentManagers} />
          <NumField label="Recycle @ ctx ratio" value={recycle} set={setRecycle} effective={resolved.orchestration.recycleAtContextRatio} def={defaults.orchestration.recycleAtContextRatio} />
          <NumField label="Idle nudge (min)" value={idleNudge} set={setIdleNudge} effective={resolved.orchestration.idleNudgeMinutes} def={defaults.orchestration.idleNudgeMinutes} />
          <NumField label="Max unanswered nudges" value={maxUnanswered} set={setMaxUnanswered} effective={resolved.orchestration.maxUnansweredNudges} def={defaults.orchestration.maxUnansweredNudges} />
          <NumField label="Idle snooze (min)" value={idleSnooze} set={setIdleSnooze} effective={resolved.orchestration.idleDefaultSnoozeMinutes} def={defaults.orchestration.idleDefaultSnoozeMinutes} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={fieldLabel}>Scheduler enabled</span>
            <TriSelect value={scheduler} set={setScheduler} def={defaults.orchestration.schedulerEnabled} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={fieldLabel}>Gate command</span>
            <Input value={gateCommand} onChange={(e) => setGateCommand(e.target.value)} placeholder="e.g. pnpm build (blank = no gate)" />
            <Hint>build/test command run in a worker's worktree before merge · {effHint(resolved.orchestration.gateCommand || "none")}</Hint>
          </label>
        </div>
      </Panel>

      <Panel>
        <SectionLabel>Doc Lint</SectionLabel>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, maxWidth: 280 }}>
          <span style={fieldLabel}>Vault-lint hook on .md writes</span>
          <TriSelect value={docLint} set={setDocLint} def={defaults.docLint} />
        </label>
      </Panel>

      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Button variant="primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
        {dirty
          ? <span style={{ color: color.amber, fontSize: 12, fontFamily: font.mono }}>unsaved changes</span>
          : <span style={{ color: color.phosphor, fontSize: 12, fontFamily: font.mono }}>saved</span>}
        <span style={{ flex: 1 }} />
        {save.isError && (
          <span style={{ color: color.red, fontSize: 12, fontFamily: font.mono, textAlign: "right" }}>
            {(save.error as Error).message}
          </span>
        )}
      </div>
    </div>
  );
}

// --- small presentational helpers ---------------------------------------------------------------

function Field({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {children}
      {hint && <Hint>{hint}</Hint>}
    </div>
  );
}
function Hint({ children }: { children: ReactNode }) {
  return <span style={{ color: color.textMuted, fontSize: 11, fontFamily: font.mono }}>{children}</span>;
}
function effHint(v: unknown): string {
  return `effective: ${String(v)}`;
}

// `effective` = the current resolved value (shown as the "effective:" hint); `def` = the platform
// default (shown in the "inherit (…)" placeholder, i.e. what blanking the field reverts to).
function NumField({ label, value, set, effective, def }:
  { label: string; value: string; set: (v: string) => void; effective: number; def: number }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={fieldLabel}>{label}</span>
      <Input value={value} onChange={(e) => set(e.target.value)} inputMode="decimal" placeholder={`inherit (${def})`} />
      <Hint>{effHint(effective)}</Hint>
    </label>
  );
}

// `def` = the platform default shown in the "— inherit (…)" option (the revert target), NOT the
// current override-effective value.
function TriSelect({ value, set, def }:
  { value: TriState; set: (v: TriState) => void; def: boolean }) {
  return (
    <Select value={value} onChange={(e) => set(e.target.value as TriState)}>
      <option value="inherit">— inherit ({String(def)})</option>
      <option value="true">true</option>
      <option value="false">false</option>
    </Select>
  );
}

// --- override <-> form-state helpers ------------------------------------------------------------

type TriState = "inherit" | "true" | "false";
function triStr(v: boolean | undefined): TriState {
  return v === undefined ? "inherit" : v ? "true" : "false";
}
function numStr(v: number | undefined): string {
  return v === undefined ? "" : String(v);
}
// Set/clear a numeric orchestration key from a form string. Blank → delete (not overridden, inherits the
// default). A non-numeric entry is passed through as NaN (→ null over JSON) so the strict-zod PATCH
// rejects it with a readable error — the demonstrable invalid-value path.
function applyNum(orch: Partial<OrchestrationConfig>, key: keyof OrchestrationConfig, s: string): void {
  if (s.trim() === "") delete (orch as Record<string, unknown>)[key];
  else (orch as Record<string, unknown>)[key] = Number(s);
}
