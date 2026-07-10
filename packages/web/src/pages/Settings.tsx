import { useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  resolveConfig,
  type Project,
  type ProjectConfigOverride,
  type OrchestrationConfig,
  type PlatformConfig,
  type PlatformConfigOverride,
  type ConnectionAuthScheme,
  type PollJob,
  type CapabilityProvisionKind,
} from "@loom/shared";
import { api, type ProjectPatchError } from "../lib/api";
import { useActiveProject } from "../lib/activeProject";
import { Panel, Button, Input, Select, SectionLabel, Badge, Chip } from "../components/ui";
import { ColumnManager } from "../components/ColumnManager";
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
    <div style={{ maxWidth: 820, display: "flex", flexDirection: "column", gap: 28 }}>
      <div>
        <SectionLabel>Project Settings</SectionLabel>
        {project ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {/* Repository binding — its OWN structural-PATCH save (the repoPath rebind guard),
                independent of the project-config Save inside ConfigEditor below. */}
            <RepoPathEditor key={`repo-${project.id}`} project={project} />
            <ConfigEditor key={project.id} project={project} />
          </div>
        ) : (
          <Panel>
            <p style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 13, margin: 0 }}>
              No active project. Pick one in the header to edit its config.
            </p>
          </Panel>
        )}
      </div>

      {/* Daemon-global tuning — NOT keyed to the active project (one shared daemon). */}
      <div>
        <SectionLabel>Global / Daemon</SectionLabel>
        <GlobalConfigEditor />
      </div>

      {/* Owner-controlled encrypted credential store (agent-tooling epic, P1) — daemon-global, like the
          tuning above. HUMAN-only; there is no agent-facing surface in this phase. */}
      <div>
        <SectionLabel>Connections</SectionLabel>
        <ConnectionsPanel />
      </div>

      {/* Poll-job triggers (agent-tooling epic P3) — daemon-global scheduled polls that wake or spawn a
          session on a new item. HUMAN-only, like Connections above (which each job binds). */}
      <div>
        <SectionLabel>Poll Jobs</SectionLabel>
        <PollJobsPanel />
      </div>

      {/* Capability registry catalog (agent-tooling epic P4 + follow-on): the two BUILTIN capabilities
          PLUS owner-added rows, in ONE unified list. HUMAN-only, like Connections/Poll Jobs above — a
          capability grant can launch a host process, the same trust posture as gateCommand. */}
      <div>
        <SectionLabel>Capabilities</SectionLabel>
        <CapabilitiesPanel />
      </div>
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

function parseLines(text: string): string[] {
  return text.split("\n").map((l) => l.trim()).filter(Boolean);
}

// Repository binding — the one place a project's `repoPath` changes after creation. Distinct from the
// machine config (ConfigEditor below): it PATCHes the human STRUCTURAL path (api.updateProject), fronted
// by the daemon's shared rebind guard — isGitRepo validation (a non-repo 400s) + a refusal while any live
// worktree session exists (returns the named liveSessions[]). Rebinding repoints ALL of the project's git
// operations, so the field carries a loud warning and both rejection paths surface INLINE (no alert): a
// non-repo shows the reason, the live-worktree refusal shows the reason + lists the sessions to stop —
// neither ever looks saved. Keyed by project id so a project switch re-seeds the field.
function RepoPathEditor({ project }: { project: Project }) {
  const qc = useQueryClient();
  const [repoPath, setRepoPath] = useState(project.repoPath);
  const trimmed = repoPath.trim();
  // Dirty only when the (non-empty) entry differs from the bound path — an empty field can't save.
  const dirty = trimmed !== "" && trimmed !== project.repoPath;

  const save = useMutation({
    mutationFn: () => api.updateProject(project.id, { repoPath: trimmed }),
    // Surface the git-repo rejection + live-worktree refusal INLINE (below) — skip the global alert.
    meta: { inlineError: true },
    onSuccess: (updated) => {
      // Patch the cached projects list so the header + this field re-read the persisted repoPath; the
      // re-read makes `dirty` false (entry === bound path) → the row flips to "saved".
      qc.setQueryData<Project[]>(["projects"], (prev) =>
        prev ? prev.map((p) => (p.id === updated.id ? updated : p)) : prev,
      );
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  // The live-worktree refusal carries the named sessions to stop (attached by api.patchProject).
  const liveSessions = (save.error as ProjectPatchError | null)?.liveSessions;

  return (
    <Panel>
      <SectionLabel>Repository Binding</SectionLabel>
      <p style={{ color: color.amber, fontSize: 12, margin: "0 0 12px", fontFamily: font.mono, lineHeight: 1.5 }}>
        ⚠ Rebinding repoints <strong>ALL</strong> of this project's git operations — worktrees, diffs,
        merges, branches, log — to the new repository. Change it only when you mean to move the project to
        a different checkout.
      </p>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={fieldLabel}>Repository path</span>
        <Input value={repoPath} onChange={(e) => setRepoPath(e.target.value)} spellCheck={false}
          placeholder="/path/to/the/git/checkout" />
        <Hint>must be an existing git repository · currently bound to <span style={{ color: color.textDim }}>{project.repoPath}</span></Hint>
      </label>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
        <Button variant="primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Rebind"}
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

      {/* Live-worktree refusal: list the sessions the user must stop first (the write did NOT land). */}
      {liveSessions && liveSessions.length > 0 && (
        <div style={{ marginTop: 10, padding: 10, background: color.panel2, border: `1px solid ${color.red}`, borderRadius: 6 }}>
          <Hint>stop these live worktree session(s) first, then retry:</Hint>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18, color: color.text, fontFamily: font.mono, fontSize: 12, lineHeight: 1.6 }}>
            {liveSessions.map((s) => (
              <li key={s.sessionId}>
                <span style={{ color: color.text }}>{s.sessionId}</span>
                {s.branch && <span style={{ color: color.textMuted }}> · {s.branch}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}

function ConfigEditor({ project }: { project: Project }) {
  const qc = useQueryClient();
  const ov = project.config; // the stored override
  const resolved = resolveConfig(ov); // effective values, shown as hints
  // Deja is a PRIVATE product (Loom is public on npm) — the Deja Capture panel is hidden unless this is a
  // LOOM_DEV build. Same isDev signal Platform.tsx/Skills.tsx derive from the reserved "Loom Platform"
  // home's existence (GET /api/platform/home only 200s under LOOM_DEV=1). A project that already has an
  // explicit dejaCapture override just loses its visible control here — the daemon-side hook is ALSO
  // gated (writeSessionSettings), so it never wires regardless.
  const platformHome = useQuery({ queryKey: ["platformHome"], queryFn: api.platformHome, retry: false });
  const isDev = platformHome.isSuccess && !!platformHome.data?.project;
  // The true PLATFORM default (resolveConfig with NO override) — what blanking/inheriting a field
  // reverts to. Inherit/default hints must show THIS, not the current override-effective value, or
  // they'd misrepresent the revert target. (CLAUDE.md: defaults come only from resolveConfig.)
  const defaults = resolveConfig(undefined);

  // Override-backed form state. "" / "inherit" means NOT overridden (omitted on save → inherits default).
  // NOTE: kanbanColumns is NOT modeled here — it has its own atomic editor (ColumnManager → the columns
  // endpoint). buildOverride clones the stored override, so a column layout saved there is preserved by
  // this PATCH untouched (the two surfaces never fight over the same field).
  const [allowText, setAllowText] = useState(ov.permission?.allow ? ov.permission.allow.join("\n") : "");
  const [gateCommand, setGateCommand] = useState(ov.orchestration?.gateCommand ?? "");
  const [maxWorkers, setMaxWorkers] = useState(numStr(ov.orchestration?.maxConcurrentWorkers));
  const [maxManagers, setMaxManagers] = useState(numStr(ov.orchestration?.maxConcurrentManagers));
  const [recycle, setRecycle] = useState(numStr(ov.orchestration?.recycleAtContextRatio));
  const [idleNudge, setIdleNudge] = useState(numStr(ov.orchestration?.idleNudgeMinutes));
  const [stuckWorker, setStuckWorker] = useState(numStr(ov.orchestration?.stuckWorkerMinutes));
  const [maxUnanswered, setMaxUnanswered] = useState(numStr(ov.orchestration?.maxUnansweredNudges));
  const [idleSnooze, setIdleSnooze] = useState(numStr(ov.orchestration?.idleDefaultSnoozeMinutes));
  const [scheduler, setScheduler] = useState(triStr(ov.orchestration?.schedulerEnabled));
  const [docLint, setDocLint] = useState(triStr(ov.docLint));
  // Opt-in Deja capture hook (card b3bd4841) — a per-project HUMAN-ONLY toggle (dropped from the agent
  // config schema, like sessionEnv), so it round-trips ONLY through this REST PATCH (the full validator),
  // never an agent write. Sibling of docLint: another PostToolUse(Write|Edit) hook, off by default.
  const [dejaCapture, setDejaCapture] = useState(triStr(ov.dejaCapture));
  // Human-only base-Python override for the shared venv (document conversion). Like gateCommand it points
  // at a host executable, so the AGENT config validator rejects it — only this REST path accepts it. Blank
  // inherits PATH discovery (python3 → python → py -3).
  const [pythonInterpreter, setPythonInterpreter] = useState(ov.python?.interpreterPath ?? "");
  // Human-only timeouts (paired with gateCommand / alertWebhook). Stored canonical ms; the form shows
  // SECONDS (÷1000 display, ×1000 store) — blank inherits the platform default.
  const [gateTimeout, setGateTimeout] = useState(msStr(ov.orchestration?.gateCommandTimeoutMs, "s"));
  const [webhookTimeout, setWebhookTimeout] = useState(msStr(ov.orchestration?.alertWebhookTimeoutMs, "s"));

  // Build the OVERRIDE from the current form. CRITICAL: the PATCH REPLACES the whole override, so we
  // start from a clone of the stored one and apply only the fields this UI models — preserving keys it
  // does NOT model (pty, sessionEnv, permission.mode/deny/startupModeCycles) instead of silently wiping
  // them. A modeled field set to blank/inherit is DELETED so it falls back to the platform default.
  // Numbers parse with Number() so a non-numeric entry sends NaN→null and the strict-zod PATCH 400s
  // with a readable "Expected number" — the demonstrable error path.
  function buildOverride(): ProjectConfigOverride {
    const o: ProjectConfigOverride = structuredClone(ov);

    // kanbanColumns is intentionally left as-cloned — owned by the dedicated atomic columns endpoint, not
    // this PATCH (see the state note above). Touching it here would race the column editor.

    const allow = parseLines(allowText);
    if (allow.length) {
      o.permission = { ...o.permission, allow };
    } else if (o.permission) {
      const { allow: _drop, ...rest } = o.permission;
      if (Object.keys(rest).length) o.permission = rest; else delete o.permission;
    }

    const orch: Partial<OrchestrationConfig> = { ...o.orchestration };
    if (gateCommand.trim()) orch.gateCommand = gateCommand.trim(); else delete orch.gateCommand;
    applyMs(orch, "gateCommandTimeoutMs", gateTimeout, "s");
    applyMs(orch, "alertWebhookTimeoutMs", webhookTimeout, "s");
    applyNum(orch, "maxConcurrentWorkers", maxWorkers);
    applyNum(orch, "maxConcurrentManagers", maxManagers);
    applyNum(orch, "recycleAtContextRatio", recycle);
    applyNum(orch, "idleNudgeMinutes", idleNudge);
    applyNum(orch, "stuckWorkerMinutes", stuckWorker);
    applyNum(orch, "maxUnansweredNudges", maxUnanswered);
    applyNum(orch, "idleDefaultSnoozeMinutes", idleSnooze);
    if (scheduler !== "inherit") orch.schedulerEnabled = scheduler === "true"; else delete orch.schedulerEnabled;
    if (Object.keys(orch).length) o.orchestration = orch; else delete o.orchestration;

    if (docLint !== "inherit") o.docLint = docLint === "true"; else delete o.docLint;
    if (dejaCapture !== "inherit") o.dejaCapture = dejaCapture === "true"; else delete o.dejaCapture;

    // python.interpreterPath: set when non-blank, else drop the key (and the now-empty python block) so a
    // blank field inherits PATH discovery rather than persisting an empty override.
    const py = pythonInterpreter.trim();
    if (py) o.python = { ...o.python, interpreterPath: py };
    else if (o.python) { const { interpreterPath: _drop, ...rest } = o.python; if (Object.keys(rest).length) o.python = rest; else delete o.python; }

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
        <SectionLabel>Board Columns</SectionLabel>
        {/* Its OWN atomic save (the columns endpoint) — independent of the project-config Save below. */}
        <ColumnManager project={project} />
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
          <NumField label="Worker stuck (min)" value={stuckWorker} set={setStuckWorker} effective={resolved.orchestration.stuckWorkerMinutes} def={defaults.orchestration.stuckWorkerMinutes} note="0 disables the stuck-worker watchdog" />
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
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
          <MsField label="Gate command timeout (s)" value={gateTimeout} set={setGateTimeout} effectiveMs={resolved.orchestration.gateCommandTimeoutMs} defMs={defaults.orchestration.gateCommandTimeoutMs} unit="s" />
          <MsField label="Alert webhook timeout (s)" value={webhookTimeout} set={setWebhookTimeout} effectiveMs={resolved.orchestration.alertWebhookTimeoutMs} defMs={defaults.orchestration.alertWebhookTimeoutMs} unit="s" />
        </div>
      </Panel>

      <Panel>
        <SectionLabel>Doc Lint</SectionLabel>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, maxWidth: 280 }}>
          <span style={fieldLabel}>Vault-lint hook on .md writes</span>
          <TriSelect value={docLint} set={setDocLint} def={defaults.docLint} />
        </label>
      </Panel>

      {isDev && (
        <Panel>
          <SectionLabel>Deja Capture</SectionLabel>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, maxWidth: 280 }}>
            <span style={fieldLabel}>Ingest agent-written mockups into Deja</span>
            <TriSelect value={dejaCapture} set={setDejaCapture} def={defaults.dejaCapture} />
            <Hint>opt-in: a PostToolUse hook auto-ingests an agent-authored .html mockup into Deja with the driving prompt as origin_prompt · off by default</Hint>
            {resolved.dejaCapture && <DejaCaptureStatusLine />}
          </label>
        </Panel>
      )}

      <Panel>
        <SectionLabel>Python</SectionLabel>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={fieldLabel}>Python interpreter</span>
          <Input value={pythonInterpreter} onChange={(e) => setPythonInterpreter(e.target.value)} spellCheck={false}
            placeholder={`inherit (PATH: ${defaults.python.interpreterPath ?? "python3 → python → py -3"})`} />
          <Hint>host path to a base Python ≥3.10 (e.g. C:\Python312\python.exe) · Loom builds its own shared venv from it for document conversion · blank inherits PATH discovery</Hint>
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

// --- Global / Daemon config (NOT project-scoped) ------------------------------------------------

// The Tier-1 platform tuning fields, grouped into the three sub-panels. Each maps a canonical-ms key
// to a human display unit. Keys are unique ACROSS groups, so the form holds one flat string dict. Units
// follow the epic: rate-limit backoff/deadlines/windows in h/m, buffers + cadences + timeouts in s.
type Grp = "rateLimit" | "watchers" | "timeouts";
interface GlobalFieldDesc { grp: Grp; key: string; label: string; unit: Unit; }
const GLOBAL_FIELDS: GlobalFieldDesc[] = [
  // Rate Limits
  { grp: "rateLimit", key: "defaultBackoffMs", label: "Default backoff (h)", unit: "h" },
  { grp: "rateLimit", key: "deadlineAfterResetMs", label: "Deadline after reset (m)", unit: "m" },
  { grp: "rateLimit", key: "deadlineNoResetMs", label: "Deadline, no reset (h)", unit: "h" },
  { grp: "rateLimit", key: "recencyWindowMs", label: "Recency window (h)", unit: "h" },
  { grp: "rateLimit", key: "resetBufferMs", label: "Reset buffer (s)", unit: "s" },
  // Watcher Cadences
  { grp: "watchers", key: "contextWatchMs", label: "Context watch (s)", unit: "s" },
  { grp: "watchers", key: "idleWatchMs", label: "Idle watch (s)", unit: "s" },
  { grp: "watchers", key: "rateLimitWatchMs", label: "Rate-limit watch (s)", unit: "s" },
  { grp: "watchers", key: "usagePollMs", label: "Usage poll (s)", unit: "s" },
  { grp: "watchers", key: "wakeMs", label: "Wake tick (s)", unit: "s" },
  { grp: "watchers", key: "schedulerMs", label: "Scheduler tick (s)", unit: "s" },
  { grp: "watchers", key: "reconcileMs", label: "Reconcile (s)", unit: "s" },
  { grp: "watchers", key: "snapshotMs", label: "Transcript snapshot (s)", unit: "s" },
  // Timeouts
  { grp: "timeouts", key: "gitOpMs", label: "Git remote op (s)", unit: "s" },
  { grp: "timeouts", key: "gitLocalMs", label: "Git local op (s)", unit: "s" },
  { grp: "timeouts", key: "gitPushMs", label: "Git push (s)", unit: "s" },
  { grp: "timeouts", key: "provisionMs", label: "Worktree provision (s)", unit: "s" },
  { grp: "timeouts", key: "busyStaleMs", label: "PTY busy-stale (s)", unit: "s" },
];

// Loads /api/platform/config then mounts the form (state seeded from the loaded override). Keeping the
// form behind the load means its state seeds once from real data — no init-from-async dance.
function GlobalConfigEditor() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["platformConfig"],
    queryFn: () => api.getPlatformConfig(),
  });
  if (isLoading) {
    return <Panel><Hint>loading daemon config…</Hint></Panel>;
  }
  if (isError || !data) {
    return <Panel><span style={{ color: color.red, fontSize: 12, fontFamily: font.mono }}>{(error as Error)?.message ?? "failed to load /api/platform/config"}</span></Panel>;
  }
  return <GlobalConfigForm override={data.override} resolved={data.resolved} />;
}

function GlobalConfigForm({ override, resolved }: { override: PlatformConfigOverride; resolved: PlatformConfig }) {
  const qc = useQueryClient();
  // The platform DEFAULT group (resolveConfig with no override) — what blanking a field reverts to, shown
  // in the "inherit (…)" placeholder. Browser-pure (no daemon read), like the per-project `defaults`.
  const defaults = resolveConfig(undefined).platform;

  // One flat string dict keyed by field key (unique across groups). "" = inherit. Seeded from the loaded
  // override, each value displayed in its human unit (canonical ms ÷ the unit).
  const seed: Record<string, string> = {};
  for (const f of GLOBAL_FIELDS) {
    const ovVal = (override[f.grp] as Record<string, number> | undefined)?.[f.key];
    seed[f.key] = msStr(ovVal, f.unit);
  }
  const [vals, setVals] = useState(seed);
  // Message-delivery behavior toggle (owner-directed 2026-07-03): a top-level boolean, not part of the
  // ms-keyed GLOBAL_FIELDS grid, so it gets its own tri-state seeded straight from the loaded override.
  const [coalesceAgentMsgs, setCoalesceAgentMsgs] = useState(triStr(override.coalesceAgentMessages));

  // Build the override from the form — every non-blank field converted to canonical ms (× the unit).
  // A blank field is omitted (inherits). A non-numeric entry sends NaN (→ null) so the strict-zod PATCH
  // 400s with a readable reason — the demonstrable invalid path.
  function buildGlobalOverride(): PlatformConfigOverride {
    const o: PlatformConfigOverride = {};
    for (const f of GLOBAL_FIELDS) {
      const s = vals[f.key] ?? "";
      if (s.trim() === "") continue;
      const grp = ((o as Record<string, Record<string, number>>)[f.grp] ??= {});
      grp[f.key] = Number(s) * UNIT_MS[f.unit];
    }
    if (coalesceAgentMsgs !== "inherit") o.coalesceAgentMessages = coalesceAgentMsgs === "true";
    return o;
  }

  const built = buildGlobalOverride();
  const builtJson = JSON.stringify(built);
  const baseline = useRef(builtJson);
  const dirty = builtJson !== baseline.current;

  const save = useMutation({
    mutationFn: () => api.updatePlatformConfig(built),
    meta: { inlineError: true },
    onSuccess: () => {
      baseline.current = builtJson;
      qc.invalidateQueries({ queryKey: ["platformConfig"] });
    },
  });

  const group = (grp: Grp) => GLOBAL_FIELDS.filter((f) => f.grp === grp);
  // resolved/defaults sub-groups are typed structs (no index signature); the field key is known to
  // exist, so read it through an `unknown`-cast Record. ?? 0 satisfies noUncheckedIndexedAccess.
  const msOf = (g: PlatformConfig[Grp], key: string): number => (g as unknown as Record<string, number>)[key] ?? 0;
  const renderField = (f: GlobalFieldDesc) => (
    <MsField key={f.key} label={f.label} value={vals[f.key] ?? ""}
      set={(v) => setVals((s) => ({ ...s, [f.key]: v }))}
      effectiveMs={msOf(resolved[f.grp], f.key)}
      defMs={msOf(defaults[f.grp], f.key)} unit={f.unit} />
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Panel>
        <p style={{ color: color.amber, fontSize: 12, margin: 0, fontFamily: font.mono, lineHeight: 1.5 }}>
          Watcher cadences and git/provision timeouts take effect after a daemon restart. Rate-limit and
          webhook values apply immediately.
        </p>
        <p style={{ color: color.textMuted, fontSize: 11, margin: "6px 0 0", fontFamily: font.mono, lineHeight: 1.5 }}>
          Daemon-wide (not per-project). Each field overrides the platform default; leave it blank /
          <em> inherit</em> to fall back. The hint shows the current effective value.
        </p>
      </Panel>

      <Panel>
        <SectionLabel>Rate Limits</SectionLabel>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          {group("rateLimit").map(renderField)}
        </div>
      </Panel>

      <Panel>
        <SectionLabel>Watcher Cadences</SectionLabel>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          {group("watchers").map(renderField)}
        </div>
      </Panel>

      <Panel>
        <SectionLabel>Timeouts</SectionLabel>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          {group("timeouts").map(renderField)}
        </div>
      </Panel>

      <Panel>
        <SectionLabel>Message Delivery</SectionLabel>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, maxWidth: 360 }}>
          <span style={fieldLabel}>Group agent & worker messages into a single turn (legacy)</span>
          <TriSelect value={coalesceAgentMsgs} set={setCoalesceAgentMsgs} def={defaults.coalesceAgentMessages} />
          <Hint>{effHint(resolved.coalesceAgentMessages)}</Hint>
          <Hint>
            Off (default): each agent/worker message — a manager&apos;s direction, a worker&apos;s report, a
            human composer turn — is delivered as its own turn. On: multiple queued messages are concatenated
            into one turn (the pre-2026-07 behavior). Loom&apos;s own routine nudges (idle/context/rate-limit
            watchdogs, etc.) still coalesce regardless of this setting; action-required nudges (a merge
            rejection, an already-merged notice) stay on their own turn either way.
          </Hint>
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

// --- Connections (owner-controlled encrypted credential store, agent-tooling epic P1) -----------------
// HUMAN-only loopback REST — there is intentionally NO agent-facing surface this phase. List/add/revoke
// only: the secret is write-only (accepted on create, never returned by any read, never re-editable in
// place — revoke + recreate). Daemon-global, like the tuning panel above (one shared credential store).

const AUTH_SCHEMES: ConnectionAuthScheme[] = ["api-key", "bearer"];

function ConnectionsPanel() {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["connections"],
    queryFn: () => api.connections(),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["connections"] });
  const create = useMutation({
    mutationFn: (b: { name: string; host: string; authScheme: ConnectionAuthScheme; secret: string }) => api.createConnection(b),
    onSuccess: () => { setAdding(false); invalidate(); },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteConnection(id),
    onSuccess: () => invalidate(),
    onError: (e) => window.alert((e as Error).message),
  });

  const rows = data ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Panel>
        <p style={{ color: color.textMuted, fontSize: 12, margin: 0, fontFamily: font.mono, lineHeight: 1.5 }}>
          Owner-only credentials for connecting Loom to external services. Secrets are encrypted at rest
          and never shown again after creation — there is no agent-facing tool that can read, list, or use
          them yet (this is the foundation phase only).
        </p>
      </Panel>

      <Panel>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <SectionLabel style={{ margin: 0 }}>Connections ({rows.length})</SectionLabel>
          <span style={{ flex: 1 }} />
          {!adding && <Button variant="primary" onClick={() => { setAdding(true); create.reset(); }}>New connection</Button>}
        </div>

        {isLoading && <Hint>loading connections…</Hint>}
        {isError && <span style={{ color: color.red, fontSize: 12, fontFamily: font.mono }}>{(error as Error)?.message ?? "failed to load /api/connections"}</span>}

        {adding && (
          <div style={{ marginBottom: 10, padding: 12, background: color.panel2, border: `1px solid ${color.border}`, borderRadius: 6 }}>
            <ConnectionForm pending={create.isPending} error={create.error ? (create.error as Error).message : null}
              onSubmit={(v) => create.mutate(v)} onCancel={() => { setAdding(false); create.reset(); }} />
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {rows.length === 0 && !adding && !isLoading && (
            <span style={{ color: color.textMuted, fontSize: 13, fontFamily: font.mono }}>No connections yet.</span>
          )}
          {rows.map((c) => (
            <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", background: color.panel2, border: `1px solid ${color.border}`, borderRadius: 6 }}>
              <span style={{ fontFamily: font.mono, fontSize: 13, color: color.text }}>{c.name}</span>
              <span style={{ fontFamily: font.mono, fontSize: 12, color: color.textMuted }}>{c.host}</span>
              <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textDim, textTransform: "uppercase", letterSpacing: "0.06em" }}>{c.authScheme}</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>{new Date(c.createdAt).toLocaleString()}</span>
              <Button variant="danger" disabled={remove.isPending}
                onClick={() => { if (window.confirm(`Revoke "${c.name}"? This cannot be undone — you'll need to re-create it with the secret to restore it.`)) remove.mutate(c.id); }}>
                Revoke
              </Button>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

function ConnectionForm({ pending, error, onSubmit, onCancel }: {
  pending: boolean; error: string | null;
  onSubmit: (v: { name: string; host: string; authScheme: ConnectionAuthScheme; secret: string }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [authScheme, setAuthScheme] = useState<ConnectionAuthScheme>("api-key");
  const [secret, setSecret] = useState("");
  const [localErr, setLocalErr] = useState<string | null>(null);

  const submit = () => {
    setLocalErr(null);
    if (!name.trim() || !host.trim() || !secret.trim()) {
      setLocalErr("Name, host, and secret are all required.");
      return;
    }
    onSubmit({ name: name.trim(), host: host.trim(), authScheme, secret: secret.trim() });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={fieldLabel}>Name</span>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. GitHub personal token" />
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={fieldLabel}>Host</span>
        <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="e.g. api.github.com" spellCheck={false} />
        <Hint>the target host this connection's secret is scoped to (metadata only — not yet enforced)</Hint>
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={fieldLabel}>Auth scheme</span>
        <Select value={authScheme} onChange={(e) => setAuthScheme(e.target.value as ConnectionAuthScheme)}>
          {AUTH_SCHEMES.map((s) => <option key={s} value={s}>{s}</option>)}
        </Select>
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={fieldLabel}>Secret</span>
        <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} spellCheck={false} autoComplete="off" />
        <Hint>encrypted at rest immediately · never shown again after this form is submitted</Hint>
      </label>

      {(localErr || error) && <div style={{ fontSize: 12, color: color.red, fontFamily: font.mono }}>{localErr ?? error}</div>}

      <div style={{ display: "flex", gap: 8 }}>
        <Button variant="primary" onClick={submit} disabled={pending}>{pending ? "Saving…" : "Create connection"}</Button>
        <Button variant="ghost" onClick={onCancel} disabled={pending}>Cancel</Button>
      </div>
    </div>
  );
}

// --- Poll jobs (agent-tooling epic P3) ----------------------------------------------------------
// The 60s cadence floor — MIRRORS the daemon's exported MIN_POLL_INTERVAL_MS (orchestration/poll.ts).
// Web can't import from @loom/daemon, so this is a cheap client-side gate (same idiom as Schedules'
// `looksLikeCron`); the daemon does the REAL enforcement and 400s anything below it.
const MIN_POLL_INTERVAL_MS = 60_000;
const POLL_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

function fmtWhen(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "never";
}

// Flat cross-project agent list ("Project / Agent" labels) for a spawn-mode target picker — mirrors
// Schedules' useAllAgents. Poll jobs are daemon-global, so the target can be any project's agent.
function usePollAgents() {
  return useQuery({
    queryKey: ["allAgentsFlat"],
    queryFn: async () => {
      const projects = await api.projects();
      const lists = await Promise.all(
        projects.map((p) => api.agents(p.id).then((ags) => ags.map((a) => ({ id: a.id, label: `${p.name} / ${a.name}` })))),
      );
      return lists.flat();
    },
  });
}

function PollJobsPanel() {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const jobs = useQuery({ queryKey: ["pollJobs"], queryFn: () => api.pollJobs() });
  const connections = useQuery({ queryKey: ["connections"], queryFn: () => api.connections() });
  const sessions = useQuery({ queryKey: ["allSessions"], queryFn: () => api.allSessions() });
  const agents = usePollAgents();

  const invalidate = () => qc.invalidateQueries({ queryKey: ["pollJobs"] });
  const create = useMutation({
    mutationFn: (b: Parameters<typeof api.createPollJob>[0]) => api.createPollJob(b),
    onSuccess: () => { setAdding(false); invalidate(); },
  });
  const update = useMutation({
    mutationFn: (v: { id: string; patch: Parameters<typeof api.updatePollJob>[1] }) => api.updatePollJob(v.id, v.patch),
    onSuccess: () => { setEditingId(null); invalidate(); },
  });
  // Inline enable/disable + delete are quick actions (no inline error slot) — surface a rare 400 (a
  // now-missing target) as an alert so it isn't swallowed.
  const toggle = useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) => api.updatePollJob(v.id, { enabled: v.enabled }),
    onSuccess: () => invalidate(),
    onError: (e) => window.alert((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deletePollJob(id),
    onSuccess: () => invalidate(),
    onError: (e) => window.alert((e as Error).message),
  });

  const rows = jobs.data ?? [];
  const conns = (connections.data ?? []).map((c) => ({ id: c.id, name: c.name, host: c.host }));
  const sessionOpts = (sessions.data ?? []).map((s) => ({
    id: s.id, label: `${s.projectName} / ${s.agentName}${s.title ? ` · ${s.title}` : ""}`,
  }));
  const agentOpts = agents.data ?? [];
  const connName = (id: string) => conns.find((c) => c.id === id)?.name ?? id;
  const targetLabel = (job: PollJob): string =>
    job.mode === "wake"
      ? sessionOpts.find((s) => s.id === job.sessionId)?.label ?? job.sessionId ?? "—"
      : agentOpts.find((a) => a.id === job.agentId)?.label ?? job.agentId ?? "—";
  const noConns = !connections.isLoading && conns.length === 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Panel>
        <p style={{ color: color.textMuted, fontSize: 12, margin: 0, fontFamily: font.mono, lineHeight: 1.5 }}>
          Scheduled local polls. On each due tick Loom fetches a connection's endpoint and, on an item it
          hasn't seen since the previous poll, wakes an existing session or spawns a fresh one with the new
          item(s) as its kickoff. Owner-managed only — there is no agent-facing tool that can read or edit
          these. Changes apply on the next tick.
        </p>
      </Panel>

      <Panel>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <SectionLabel style={{ margin: 0 }}>Poll jobs ({rows.length})</SectionLabel>
          <span style={{ flex: 1 }} />
          {!adding && (
            <Button variant="primary" disabled={noConns}
              title={noConns ? "Add a connection above first — a poll job fetches through one." : undefined}
              onClick={() => { setAdding(true); setEditingId(null); create.reset(); }}>
              New poll job
            </Button>
          )}
        </div>

        {jobs.isLoading && <Hint>loading poll jobs…</Hint>}
        {jobs.isError && <span style={{ color: color.red, fontSize: 12, fontFamily: font.mono }}>{(jobs.error as Error)?.message ?? "failed to load /api/poll-jobs"}</span>}
        {noConns && <Hint>no connections yet — add one in the Connections section above before creating a poll job.</Hint>}

        {adding && (
          <div style={{ marginBottom: 10, padding: 12, background: color.panel2, border: `1px solid ${color.border}`, borderRadius: 6 }}>
            <PollJobForm connections={conns} sessions={sessionOpts} agents={agentOpts}
              agentsLoading={agents.isLoading} sessionsLoading={sessions.isLoading}
              pending={create.isPending} error={create.error ? (create.error as Error).message : null}
              onSubmit={(v) => create.mutate(v)} onCancel={() => { setAdding(false); create.reset(); }} />
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {rows.length === 0 && !adding && !jobs.isLoading && (
            <span style={{ color: color.textMuted, fontSize: 13, fontFamily: font.mono }}>No poll jobs yet.</span>
          )}
          {rows.map((job) => (
            editingId === job.id ? (
              <div key={job.id} style={{ padding: 12, background: color.panel2, border: `1px solid ${color.phosphor}`, borderRadius: 6 }}>
                <PollJobForm initial={job} connections={conns} sessions={sessionOpts} agents={agentOpts}
                  agentsLoading={agents.isLoading} sessionsLoading={sessions.isLoading}
                  connName={connName(job.connectionId)}
                  pending={update.isPending} error={update.error ? (update.error as Error).message : null}
                  onSubmit={(v) => update.mutate({ id: job.id, patch: v })} onCancel={() => { setEditingId(null); update.reset(); }} />
              </div>
            ) : (
              <PollJobRow key={job.id} job={job} connName={connName(job.connectionId)} target={targetLabel(job)}
                toggling={toggle.isPending} deleting={remove.isPending}
                onEdit={() => { setEditingId(job.id); setAdding(false); update.reset(); }}
                onToggle={() => toggle.mutate({ id: job.id, enabled: !job.enabled })}
                onDelete={() => remove.mutate(job.id)} />
            )
          ))}
        </div>
      </Panel>
    </div>
  );
}

function PollJobRow({ job, connName, target, toggling, deleting, onEdit, onToggle, onDelete }: {
  job: PollJob; connName: string; target: string; toggling: boolean; deleting: boolean;
  onEdit: () => void; onToggle: () => void; onDelete: () => void;
}) {
  const [confirmDel, setConfirmDel] = useState(false);
  const failing = job.consecutiveFailures > 0;
  return (
    <div style={{ padding: "10px 12px", background: color.panel2, border: `1px solid ${failing ? color.amber : color.border}`, borderRadius: 6, display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontFamily: font.mono, fontSize: 13, color: color.text }}>{connName}</span>
        <Chip label={job.method} value={job.path} />
        <span style={{ flex: 1 }} />
        <Badge tone={job.enabled ? "phosphor" : "muted"}>{job.enabled ? "enabled" : "disabled"}</Badge>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>
        <span>every {job.intervalMs / 1000}s</span>
        <span>{job.mode} → <span style={{ color: color.textDim }}>{target}</span></span>
        <span>items: {job.itemsPath || "(root)"} · id: {job.idPath || "(none)"}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", fontFamily: font.mono, fontSize: 11 }}>
        <span style={{ color: color.textDim }}>last polled · <span style={{ color: color.text }}>{fmtWhen(job.lastPolledAt)}</span></span>
        {failing && (
          <span style={{ color: color.amber }}>{job.consecutiveFailures} consecutive failure{job.consecutiveFailures === 1 ? "" : "s"}</span>
        )}
        {job.lastError && (
          <span style={{ color: color.red, maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={job.lastError}>
            error: {job.lastError}
          </span>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Button onClick={onEdit}>Edit</Button>
        <Button onClick={onToggle} disabled={toggling} title={job.enabled ? "Pause this poll job (stops polling)" : "Resume this poll job"}>
          {job.enabled ? "Disable" : "Enable"}
        </Button>
        <span style={{ flex: 1 }} />
        {confirmDel ? (
          <>
            <span style={{ color: color.red, fontSize: 12, fontFamily: font.mono }}>delete this poll job?</span>
            <Button variant="danger" disabled={deleting} onClick={onDelete}>Confirm</Button>
            <Button onClick={() => setConfirmDel(false)}>Cancel</Button>
          </>
        ) : <Button variant="danger" onClick={() => setConfirmDel(true)}>Delete</Button>}
      </div>
    </div>
  );
}

// Shared create/edit form. `initial` prefills for edit; `connectionId` is IMMUTABLE after create (the
// PATCH handler doesn't accept it — mirrors a schedule's fixed agentId), so edit shows the connection
// read-only via `connName`. The interval is edited in SECONDS (stored ms); the 60s floor is gated here
// and re-enforced by the daemon.
function PollJobForm({ initial, connections, sessions, agents, agentsLoading, sessionsLoading, connName, pending, error, onSubmit, onCancel }: {
  initial?: PollJob;
  connections: { id: string; name: string; host: string }[];
  sessions: { id: string; label: string }[];
  agents: { id: string; label: string }[];
  agentsLoading: boolean; sessionsLoading: boolean;
  connName?: string;
  pending: boolean; error: string | null;
  onSubmit: (v: {
    connectionId: string; path: string; method: string; intervalMs: number; itemsPath: string; idPath: string;
    mode: PollJob["mode"]; sessionId?: string; agentId?: string; enabled: boolean;
  }) => void;
  onCancel: () => void;
}) {
  const editing = !!initial;
  const [connectionId, setConnectionId] = useState(initial?.connectionId ?? "");
  const [path, setPath] = useState(initial?.path ?? "");
  const [method, setMethod] = useState<string>(initial?.method ?? "GET");
  const [intervalSec, setIntervalSec] = useState(String((initial?.intervalMs ?? MIN_POLL_INTERVAL_MS) / 1000));
  const [itemsPath, setItemsPath] = useState(initial?.itemsPath ?? "");
  const [idPath, setIdPath] = useState(initial?.idPath ?? "id");
  const [mode, setMode] = useState<PollJob["mode"]>(initial?.mode ?? "spawn");
  const [sessionId, setSessionId] = useState(initial?.sessionId ?? "");
  const [agentId, setAgentId] = useState(initial?.agentId ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [localErr, setLocalErr] = useState<string | null>(null);

  const minSec = MIN_POLL_INTERVAL_MS / 1000;
  const sec = Number(intervalSec);
  const intervalValid = Number.isFinite(sec) && sec >= minSec;
  const pathValid = path.trim().startsWith("/");
  const targetValid = mode === "wake" ? !!sessionId : !!agentId;
  const connValid = editing || !!connectionId;
  const valid = connValid && pathValid && intervalValid && targetValid;

  const submit = () => {
    setLocalErr(null);
    if (!valid) {
      setLocalErr(`Need a connection, a path starting with "/", an interval ≥ ${minSec}s, and a ${mode === "wake" ? "session" : "agent"} target.`);
      return;
    }
    onSubmit({
      connectionId, path: path.trim(), method, intervalMs: Math.round(sec * 1000),
      itemsPath: itemsPath.trim(), idPath: idPath.trim(), mode,
      sessionId: mode === "wake" ? sessionId : undefined,
      agentId: mode === "spawn" ? agentId : undefined,
      enabled,
    });
  };

  const noAgents = !agentsLoading && agents.length === 0;
  const noSessions = !sessionsLoading && sessions.length === 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <strong style={{ fontFamily: font.head, textTransform: "uppercase", letterSpacing: "0.08em", color: color.text, fontSize: 13 }}>
        {editing ? "Edit poll job" : "New poll job"}
      </strong>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={fieldLabel}>Connection {editing && <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0, color: color.textMuted }}>· fixed after create</span>}</span>
        {editing
          ? <Input value={connName ?? connectionId} disabled />
          : (
            <Select value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
              <option value="">— select a connection —</option>
              {connections.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.host})</option>)}
            </Select>
          )}
      </label>

      <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 10 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={fieldLabel}>Method</span>
          <Select value={method} onChange={(e) => setMethod(e.target.value)}>
            {POLL_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
          </Select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={fieldLabel}>Path</span>
          <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/notifications" spellCheck={false} />
          {path.trim().length > 0 && !pathValid && <span style={{ color: color.amber, fontSize: 11, fontFamily: font.mono }}>Path must start with "/".</span>}
        </label>
      </div>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={fieldLabel}>Poll interval (seconds)</span>
        <Input value={intervalSec} onChange={(e) => setIntervalSec(e.target.value)} inputMode="numeric" min={minSec} type="number" placeholder={String(minSec)} />
        {intervalSec.trim().length > 0 && !intervalValid && <span style={{ color: color.amber, fontSize: 11, fontFamily: font.mono }}>Minimum {minSec}s (the poll cadence floor).</span>}
      </label>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={fieldLabel}>Items path</span>
          <Input value={itemsPath} onChange={(e) => setItemsPath(e.target.value)} placeholder="(root array)" spellCheck={false} />
          <Hint>dot-path to the items array in the response · blank = the root</Hint>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={fieldLabel}>Id path</span>
          <Input value={idPath} onChange={(e) => setIdPath(e.target.value)} placeholder="id" spellCheck={false} />
          <Hint>dot-path to each item's stable id (the diff key)</Hint>
        </label>
      </div>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={fieldLabel}>On a new item</span>
        <Select value={mode} onChange={(e) => setMode(e.target.value as PollJob["mode"])}>
          <option value="spawn">Spawn a fresh session (pick an agent)</option>
          <option value="wake">Wake an existing session</option>
        </Select>
      </label>

      {mode === "spawn" ? (
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={fieldLabel}>Target agent</span>
          <Select value={agentId} onChange={(e) => setAgentId(e.target.value)} disabled={agentsLoading || noAgents}>
            <option value="">{agentsLoading ? "Loading agents…" : noAgents ? "— no agents —" : "— select an agent —"}</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </Select>
          {noAgents && <span style={{ color: color.amber, fontSize: 11, fontFamily: font.mono }}>No agents exist yet — create one on the Projects page first.</span>}
        </label>
      ) : (
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={fieldLabel}>Target session</span>
          <Select value={sessionId} onChange={(e) => setSessionId(e.target.value)} disabled={sessionsLoading || noSessions}>
            <option value="">{sessionsLoading ? "Loading sessions…" : noSessions ? "— no sessions —" : "— select a session —"}</option>
            {sessions.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </Select>
          {noSessions && <span style={{ color: color.amber, fontSize: 11, fontFamily: font.mono }}>No sessions exist yet — start one before targeting a wake.</span>}
        </label>
      )}

      <label style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: font.mono, fontSize: 13, color: color.text }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Enabled
      </label>

      {(localErr || error) && <div style={{ fontSize: 12, color: color.red, fontFamily: font.mono }}>{localErr ?? error}</div>}

      <div style={{ display: "flex", gap: 8 }}>
        <Button variant="primary" onClick={submit} disabled={pending || !valid}>
          {pending ? "Saving…" : editing ? "Save changes" : "Create poll job"}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={pending}>Cancel</Button>
      </div>
    </div>
  );
}

// --- Capabilities catalog (agent-tooling epic P4 + follow-on) -----------------------------------
// Mirrors ConnectionsPanel/PollJobsPanel above: list + create-form + delete. Unlike those, ONE catalog
// spans FOUR provision kinds with mutually-exclusive fields, so the create-form renders a field set
// CONDITIONAL on the chosen kind rather than one fixed shape. The two builtins (browser-testing /
// document-conversion) are read-only rows — no delete button — since they aren't `capability_defs` rows
// at all (see capabilities/registry.ts's BUILTIN_CAPABILITY_SUMMARIES).
const CAPABILITY_KINDS: CapabilityProvisionKind[] = ["node-package", "python-venv", "bundled", "command"];

function CapabilitiesPanel() {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["capabilities"],
    queryFn: () => api.capabilities(),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["capabilities"] });
  const create = useMutation({
    mutationFn: (b: Parameters<typeof api.createCapability>[0]) => api.createCapability(b),
    onSuccess: () => { setAdding(false); invalidate(); },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteCapability(id),
    onSuccess: () => invalidate(),
    onError: (e) => window.alert((e as Error).message),
  });

  const rows = data ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Panel>
        <p style={{ color: color.textMuted, fontSize: 12, margin: 0, fontFamily: font.mono, lineHeight: 1.5 }}>
          The catalog of MCP capabilities a Profile can grant a session — the two Loom-shipped builtins plus
          any you add here. Owner-only: there is no agent-facing tool that can create, edit, or delete a
          capability.
        </p>
      </Panel>

      <Panel>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <SectionLabel style={{ margin: 0 }}>Catalog ({rows.length})</SectionLabel>
          <span style={{ flex: 1 }} />
          {!adding && <Button variant="primary" onClick={() => { setAdding(true); create.reset(); }}>New capability</Button>}
        </div>

        {isLoading && <Hint>loading capabilities…</Hint>}
        {isError && <span style={{ color: color.red, fontSize: 12, fontFamily: font.mono }}>{(error as Error)?.message ?? "failed to load /api/capabilities"}</span>}

        {adding && (
          <div style={{ marginBottom: 10, padding: 12, background: color.panel2, border: `1px solid ${color.border}`, borderRadius: 6 }}>
            <CapabilityForm pending={create.isPending} error={create.error ? (create.error as Error).message : null}
              onSubmit={(v) => create.mutate(v)} onCancel={() => { setAdding(false); create.reset(); }} />
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {rows.length === 0 && !adding && !isLoading && (
            <span style={{ color: color.textMuted, fontSize: 13, fontFamily: font.mono }}>No capabilities yet.</span>
          )}
          {rows.map((c) => (
            <div key={c.slug} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", background: color.panel2, border: `1px solid ${color.border}`, borderRadius: 6 }}>
              <span style={{ fontFamily: font.mono, fontSize: 13, color: color.text }}>{c.name}</span>
              <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textDim, textTransform: "uppercase", letterSpacing: "0.06em" }}>{c.kind}</span>
              {c.builtin && <Badge tone="muted">builtin</Badge>}
              {c.requiresConnection && <Badge tone="cyan">needs connection</Badge>}
              <span style={{ flex: 1, color: color.textMuted, fontSize: 12, fontFamily: font.mono, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.description}</span>
              {!c.builtin && c.id && (
                <Button variant="danger" disabled={remove.isPending}
                  onClick={() => { if (window.confirm(`Delete capability "${c.name}"? Any Profile granting it will simply skip mounting it.`)) remove.mutate(c.id!); }}>
                  Delete
                </Button>
              )}
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

function CapabilityForm({ pending, error, onSubmit, onCancel }: {
  pending: boolean; error: string | null;
  onSubmit: (v: Parameters<typeof api.createCapability>[0]) => void;
  onCancel: () => void;
}) {
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<CapabilityProvisionKind>("bundled");
  const [toolAllowlistText, setToolAllowlistText] = useState("");
  const [wantsScratchDir, setWantsScratchDir] = useState(false);
  const [requiresConnection, setRequiresConnection] = useState(false);
  const [secretEnvVar, setSecretEnvVar] = useState("");
  const [localErr, setLocalErr] = useState<string | null>(null);

  // node-package fields
  const [pkg, setPkg] = useState("");
  const [binRelativeToPackageJson, setBinRelativeToPackageJson] = useState("");
  // python-venv fields
  const [packagesText, setPackagesText] = useState("");
  const [venvBinary, setVenvBinary] = useState("");
  const [probeImport, setProbeImport] = useState("");
  // bundled / command fields (same shape)
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");

  const splitLines = (s: string) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);

  const submit = () => {
    setLocalErr(null);
    if (!slug.trim() || !name.trim()) { setLocalErr("Slug and name are required."); return; }
    let provision: unknown;
    if (kind === "node-package") {
      if (!pkg.trim() || !binRelativeToPackageJson.trim()) { setLocalErr("Package and bin path are required for node-package."); return; }
      provision = { package: pkg.trim(), binRelativeToPackageJson: binRelativeToPackageJson.trim() };
    } else if (kind === "python-venv") {
      const packages = splitLines(packagesText);
      if (packages.length === 0 || !venvBinary.trim()) { setLocalErr("At least one package and a binary name are required for python-venv."); return; }
      provision = { packages, binary: venvBinary.trim(), probeImport: probeImport.trim() || undefined };
    } else {
      if (!command.trim()) { setLocalErr("Command is required."); return; }
      provision = { command: command.trim(), args: argsText.trim() ? splitLines(argsText) : undefined };
    }
    if (requiresConnection && !secretEnvVar.trim()) { setLocalErr("Secret env var is required when 'requires connection' is checked."); return; }
    onSubmit({
      slug: slug.trim(), name: name.trim(), description: description.trim(), transport: "stdio", kind,
      provision, toolAllowlist: splitLines(toolAllowlistText), wantsScratchDir, requiresConnection,
      secretEnvVar: requiresConnection ? secretEnvVar.trim() : undefined,
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={fieldLabel}>Slug</span>
        <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="e.g. gh-mcp" spellCheck={false} />
        <Hint>lowercase kebab-case — the id a Profile's capability grant references</Hint>
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={fieldLabel}>Name</span>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. GitHub MCP" />
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={fieldLabel}>Description</span>
        <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="shown in the Profile editor's capability picker" />
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={fieldLabel}>Provision kind</span>
        <Select value={kind} onChange={(e) => setKind(e.target.value as CapabilityProvisionKind)}>
          {CAPABILITY_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </Select>
      </label>

      {kind === "node-package" && (
        <>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={fieldLabel}>Package</span>
            <Input value={pkg} onChange={(e) => setPkg(e.target.value)} placeholder="e.g. @playwright/mcp" spellCheck={false} />
            <Hint>an already-installed daemon dependency, resolved via require.resolve</Hint>
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={fieldLabel}>Bin path (relative to package.json)</span>
            <Input value={binRelativeToPackageJson} onChange={(e) => setBinRelativeToPackageJson(e.target.value)} placeholder="e.g. cli.js" spellCheck={false} />
          </label>
        </>
      )}

      {kind === "python-venv" && (
        <>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={fieldLabel}>PyPI packages</span>
            <Input value={packagesText} onChange={(e) => setPackagesText(e.target.value)} placeholder="comma-separated, e.g. markitdown[all]" spellCheck={false} />
            <Hint>installed into Loom's shared managed venv on first use</Hint>
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={fieldLabel}>Binary</span>
            <Input value={venvBinary} onChange={(e) => setVenvBinary(e.target.value)} placeholder="the venv console-script name" spellCheck={false} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={fieldLabel}>Probe import <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0, color: color.textMuted }}>(optional)</span></span>
            <Input value={probeImport} onChange={(e) => setProbeImport(e.target.value)} spellCheck={false} />
          </label>
        </>
      )}

      {(kind === "bundled" || kind === "command") && (
        <>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={fieldLabel}>Command</span>
            <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder={kind === "command" ? "e.g. my-mcp-server, or an absolute path" : "an absolute path Loom ships"} spellCheck={false} />
            {kind === "command" && <Hint>resolved to an absolute path on save (searches PATH for a bare name) — the save fails if it can't be resolved</Hint>}
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={fieldLabel}>Args <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0, color: color.textMuted }}>(optional, comma-separated)</span></span>
            <Input value={argsText} onChange={(e) => setArgsText(e.target.value)} spellCheck={false} />
          </label>
          {kind === "command" && (
            <div style={{ padding: 10, background: color.panel, border: `1px solid ${color.amber}`, borderRadius: 6, display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ ...fieldLabel, color: color.amber }}>This launches a host process you control</span>
              <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0, color: color.textMuted, fontSize: 11, fontFamily: font.mono, lineHeight: 1.5 }}>
                A session granted this capability spawns the command above directly (no shell — args are
                passed as an argv array, never a shell string). Loom trusts it because you typed it: the same
                model as the project Gate Command. Only add a command you'd run yourself.
              </span>
            </div>
          )}
        </>
      )}

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={fieldLabel}>Tool allowlist <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0, color: color.textMuted }}>(comma-separated MCP tool names)</span></span>
        <Input value={toolAllowlistText} onChange={(e) => setToolAllowlistText(e.target.value)} placeholder="e.g. mcp__gh-mcp__list_issues" spellCheck={false} />
      </label>

      <label style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: font.mono, fontSize: 13, color: color.text }}>
        <input type="checkbox" checked={wantsScratchDir} onChange={(e) => setWantsScratchDir(e.target.checked)} />
        Wants a scratch dir (passed --output-dir at spawn time)
      </label>

      <label style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: font.mono, fontSize: 13, color: color.text }}>
        <input type="checkbox" checked={requiresConnection} onChange={(e) => setRequiresConnection(e.target.checked)} />
        Requires a bound connection (credential injected into the server's env)
      </label>
      {requiresConnection && (
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={fieldLabel}>Secret env var</span>
          <Input value={secretEnvVar} onChange={(e) => setSecretEnvVar(e.target.value)} placeholder="e.g. GITHUB_TOKEN" spellCheck={false} />
        </label>
      )}

      {(localErr || error) && <div style={{ fontSize: 12, color: color.red, fontFamily: font.mono }}>{localErr ?? error}</div>}

      <div style={{ display: "flex", gap: 8 }}>
        <Button variant="primary" onClick={submit} disabled={pending}>{pending ? "Saving…" : "Create capability"}</Button>
        <Button variant="ghost" onClick={onCancel} disabled={pending}>Cancel</Button>
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

// Deja capture status line (card 1c0c1a2c) — turns a silently-empty dejaCapture toggle into a
// self-explaining state: an empty-state line at 0 captures, a heartbeat count once there's at
// least one. Rendered only while the effective toggle is ON (see the Deja Capture panel above).
// Polls gently (10s) so a capture landing mid-session shows up without a manual page reload.
function DejaCaptureStatusLine() {
  const q = useQuery({
    queryKey: ["dejaCaptureStatus"],
    queryFn: api.dejaCaptureStatus,
    retry: false,
    refetchInterval: 10_000,
  });
  if (!q.data) return null;
  const { count } = q.data;
  return (
    <span style={{ color: count > 0 ? color.text : color.textMuted, fontSize: 11, fontFamily: font.mono }}>
      {count > 0
        ? `${count} mockup${count === 1 ? "" : "s"} captured`
        : "Capture on, 0 mockups seen yet — mockups appear once a generating agent writes one."}
    </span>
  );
}

// `effective` = the current resolved value (shown as the "effective:" hint); `def` = the platform
// default (shown in the "inherit (…)" placeholder, i.e. what blanking the field reverts to).
function NumField({ label, value, set, effective, def, note }:
  { label: string; value: string; set: (v: string) => void; effective: number; def: number; note?: string }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={fieldLabel}>{label}</span>
      <Input value={value} onChange={(e) => set(e.target.value)} inputMode="decimal" placeholder={`inherit (${def})`} />
      <Hint>{effHint(effective)}</Hint>
      {note && <Hint>{note}</Hint>}
    </label>
  );
}

// Unit-aware sibling of NumField for a CANONICAL-MS value. The form shows a human unit (s/m/h); the
// stored value is always ms. `effectiveMs`/`defMs` are ms and rendered in `unit` (÷ the unit's ms).
// Blank → inherit (the field is omitted from the override → falls back to the platform default).
function MsField({ label, value, set, effectiveMs, defMs, unit }:
  { label: string; value: string; set: (v: string) => void; effectiveMs: number; defMs: number; unit: Unit }) {
  const div = UNIT_MS[unit];
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={fieldLabel}>{label}</span>
      <Input value={value} onChange={(e) => set(e.target.value)} inputMode="decimal" placeholder={`inherit (${defMs / div}${unit})`} />
      <Hint>{effHint(`${effectiveMs / div}${unit}`)}</Hint>
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

// --- ms <-> human-unit helpers (display s/m/h, store canonical ms) -------------------------------

type Unit = "s" | "m" | "h";
const UNIT_MS: Record<Unit, number> = { s: 1000, m: 60000, h: 3600000 };

// Canonical ms → display string in `unit` (÷). undefined → "" (inherit/blank).
function msStr(v: number | undefined, unit: Unit): string {
  return v === undefined ? "" : String(v / UNIT_MS[unit]);
}
// Set/clear a canonical-ms orchestration key from a form string in `unit`. Blank → delete (inherit the
// default). A non-numeric entry passes through as NaN (→ null over JSON) so the strict-zod PATCH rejects
// it with a readable error — the demonstrable invalid-value path (mirrors applyNum).
function applyMs(orch: Partial<OrchestrationConfig>, key: keyof OrchestrationConfig, s: string, unit: Unit): void {
  if (s.trim() === "") delete (orch as Record<string, unknown>)[key];
  else (orch as Record<string, unknown>)[key] = Number(s) * UNIT_MS[unit];
}
