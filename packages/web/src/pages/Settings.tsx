import { useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  resolveConfig,
  type Project,
  type ProjectConfigOverride,
  type OrchestrationConfig,
  type PlatformConfig,
  type PlatformConfigOverride,
  type PlatformConfigPatch,
  type RemoteAccessConfig,
  type ConnectionAuthScheme,
  type OAuthProviderSlug,
  type PollJob,
  type CapabilityProvisionKind,
  GOOGLE_ANALYTICS_SCOPE_PRESETS,
} from "@loom/shared";
import { api, type ProjectPatchError, type IntegrationStatus } from "../lib/api";
import { useActiveProject } from "../lib/activeProject";
import { useAllAgents } from "../lib/useAllAgents";
import { Panel, Button, Input, Select, SectionLabel, Badge, Chip } from "../components/ui";
import { ColumnManager } from "../components/ColumnManager";
import { color, font, tone, type Tone } from "../theme";

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

      {/* Pending bindings (credential auto-provisioning v1 binding UX, card 12dc7fc9 — "Direction B"):
          the queue of agent-requested profile→connection grants awaiting the owner's deliberate approval.
          A grant is committed only by an explicit Save on the profile's allowlist ("Review & grant" opens
          it pre-selected), never a side effect of answering — binding stays an owner-only trust decision. */}
      <div>
        <SectionLabel>Pending bindings</SectionLabel>
        <PendingBindingsPanel />
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

      {/* Owner-declared project links (board card 2349d90c) — the sole gate for the manager↔manager
          peer_message cross-project channel. Daemon-global, cross-project (not scoped to the active
          project above), HUMAN-only — like Connections/Capabilities, there is no agent MCP path. */}
      <div>
        <SectionLabel>Project Links</SectionLabel>
        <ProjectLinksPanel />
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
  const [docLint, setDocLint] = useState(triStr(ov.docLint));
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
    // schedulerEnabled moved to the daemon-global config (GlobalConfigForm below) — it's no longer
    // modeled per-project. Drop it unconditionally so a project whose STORED override still carries a
    // stale value (accepted before the move) doesn't get silently re-sent on the next save and 400 the
    // strict per-project validator, which now rejects the key outright.
    delete orch.schedulerEnabled;
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
    if (Object.keys(orch).length) o.orchestration = orch; else delete o.orchestration;

    if (docLint !== "inherit") o.docLint = docLint === "true"; else delete o.docLint;

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
          <NumField label="Max managers (no scheduler effect)" value={maxManagers} set={setMaxManagers} effective={resolved.orchestration.maxConcurrentManagers} def={defaults.orchestration.maxConcurrentManagers} note="The cron Scheduler is one fleet-wide service; its manager cap is set under Settings → Global → Scheduler, not per-project here." />
          <NumField label="Recycle @ ctx ratio" value={recycle} set={setRecycle} effective={resolved.orchestration.recycleAtContextRatio} def={defaults.orchestration.recycleAtContextRatio} />
          <NumField label="Idle nudge (min)" value={idleNudge} set={setIdleNudge} effective={resolved.orchestration.idleNudgeMinutes} def={defaults.orchestration.idleNudgeMinutes} />
          <NumField label="Worker stuck (min)" value={stuckWorker} set={setStuckWorker} effective={resolved.orchestration.stuckWorkerMinutes} def={defaults.orchestration.stuckWorkerMinutes} note="0 disables the stuck-worker watchdog" />
          <NumField label="Max unanswered nudges" value={maxUnanswered} set={setMaxUnanswered} effective={resolved.orchestration.maxUnansweredNudges} def={defaults.orchestration.maxUnansweredNudges} />
          <NumField label="Idle snooze (min)" value={idleSnooze} set={setIdleSnooze} effective={resolved.orchestration.idleDefaultSnoozeMinutes} def={defaults.orchestration.idleDefaultSnoozeMinutes} />
        </div>
        <div style={{ marginTop: 12 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, maxWidth: 420 }}>
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

/** Bind targets that open EVERY interface (IPv4 `0.0.0.0` / IPv6 `::`) — mirrors the daemon's own
 *  `gateway/trust-tier.ts` `isAllInterfacesBindHost`, kept as a tiny local check here since web doesn't
 *  depend on the daemon package. Used only to show the "reachable from your LAN" hint below. */
const isAllInterfacesBindHost = (host: string): boolean => host === "0.0.0.0" || host === "::";

function GlobalConfigForm({ override, resolved }: { override: PlatformConfigOverride; resolved: PlatformConfig & { remoteAccess: RemoteAccessConfig } }) {
  const qc = useQueryClient();
  // The platform DEFAULT group (resolveConfig with no override) — what blanking a field reverts to, shown
  // in the "inherit (…)" placeholder. Browser-pure (no daemon read), like the per-project `defaults`.
  const defaults = resolveConfig(undefined).platform;
  // schedulerEnabled lives on ResolvedConfig.orchestration, not the `platform` sub-group above, so its
  // default/effective values are resolved separately — same pure resolveConfig call the daemon itself
  // makes at boot (index.ts), so this hint can never drift from what a restart will actually pick up.
  const schedulerDefault = resolveConfig(undefined).orchestration.schedulerEnabled;
  const schedulerResolved = resolveConfig(undefined, override).orchestration.schedulerEnabled;
  // maxConcurrentGates is likewise a top-level PlatformConfigOverride key surfaced on
  // ResolvedConfig.orchestration (not the `platform` sub-group), so its default/effective values are
  // resolved separately via the same pure resolveConfig call — this hint can't drift from the cap the
  // gate semaphore actually reads (it re-reads `cap` on every gate run, so no restart is involved).
  const gatesDefault = resolveConfig(undefined).orchestration.maxConcurrentGates;
  const gatesResolved = resolveConfig(undefined, override).orchestration.maxConcurrentGates;
  // maxConcurrentManagers (card 52ab5d45) is likewise a top-level PlatformConfigOverride key surfaced on
  // ResolvedConfig.orchestration — same resolution shape as maxConcurrentGates above. UNLIKE
  // maxConcurrentGates (re-read live on every gate run), the cron Scheduler is constructed ONCE at boot
  // (index.ts), so a saved change here needs a daemon restart before it actually changes the Scheduler's
  // budget — this hint shows what WILL take effect on the next restart, not a live-reread value.
  const managersDefault = resolveConfig(undefined).orchestration.maxConcurrentManagers;
  const managersResolved = resolveConfig(undefined, override).orchestration.maxConcurrentManagers;

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
  // Bucket 2b "Elevated Operator" gate — same daemon-global tri-state pattern, own toggle (default OFF).
  const [operatorEnabled, setOperatorEnabled] = useState(triStr(override.operatorEnabled));
  // Pillar-B cron Scheduler gate (§19b) — daemon-global (one shared daemon), same tri-state pattern.
  // Boot-time-gated by design: a flip here needs a daemon restart to start/stop the ticker (see the
  // banner above and the Schedules page hint).
  const [schedulerEnabled, setSchedulerEnabled] = useState(triStr(override.schedulerEnabled));
  // Host-load gate cap (card 301d8c01, 13eda2eb) — daemon-global top-level int, its OWN control (not the
  // ms-keyed GLOBAL_FIELDS grid). Blank = inherit the default. A non-numeric entry sends NaN → the
  // strict-zod PATCH 400s with a readable reason (same demonstrable invalid path as the other fields).
  const [maxConcurrentGates, setMaxConcurrentGates] = useState(numStr(override.maxConcurrentGates));
  // Fleet-wide scheduler manager cap (card 52ab5d45) — same blank-to-inherit tri-state-adjacent pattern
  // as maxConcurrentGates above, its own control (not the ms-keyed GLOBAL_FIELDS grid).
  const [maxConcurrentManagers, setMaxConcurrentManagers] = useState(numStr(override.maxConcurrentManagers));
  // Host-tool integration paths (card 8dc5ebb9) — one text field per tool, seeded from the loaded
  // override. Blank = no DB override (the resolver falls back to its own LOOM_*_BIN env var).
  const [codescapePath, setCodescapePath] = useState(override.integrations?.codescape?.path ?? "");

  // Build the PATCH body from the form — every non-blank field converted to canonical ms (× the unit).
  // A blank field sends the explicit PER-FIELD `null` clear-to-inherit sentinel (card ba9ccd75) — NOT
  // omitted — so a set→blank→save round-trip actually reverts that field instead of leaving the
  // last-saved value stranded. The PATCH handler now DEEP-merges each group field by field, so sending
  // only the fields this grid renders is safe: a field this form doesn't present (e.g.
  // rateLimit.exhaustedThresholdPct — one of the 3 daemon-global fields with no GLOBAL_FIELDS control,
  // human-settable only via direct REST) is simply never mentioned in the submitted group, and "omitted
  // = leave alone" now holds at the field level too — no need to read back and re-carry the persisted
  // override's non-grid keys the way the old shallow-merge server contract required.
  //
  // Code-review catch (card ba9ccd75): widening the per-field schema to accept `null` removed a guard
  // this grid was leaning on WITHOUT its own backstop — a garbage entry (`Number("abc")` → NaN,
  // `Number("1e999")` → Infinity) JSON-serializes to `null`, which is now the SAME wire shape as the
  // legitimate clear sentinel above, so it would silently "succeed" as a clear instead of 400ing. Same
  // hazard, same fix as `maxConcurrentGates` below: route a non-finite result through as the ORIGINAL
  // STRING rather than the NaN/Infinity number, so it fails the `number|null` shape check server-side
  // and still 400s readably.
  function buildGlobalOverride(): PlatformConfigPatch {
    const o: PlatformConfigPatch = {};
    const msGroups = ["rateLimit", "watchers", "timeouts"] as const;
    for (const grp of msGroups) {
      const entries: Record<string, number | string | null> = {};
      for (const f of GLOBAL_FIELDS) {
        if (f.grp !== grp) continue;
        const s = vals[f.key] ?? "";
        if (s.trim() === "") { entries[f.key] = null; continue; }
        const n = Number(s) * UNIT_MS[f.unit];
        entries[f.key] = Number.isFinite(n) ? n : s;
      }
      (o as Record<string, unknown>)[grp] = entries;
    }
    o.coalesceAgentMessages = coalesceAgentMsgs === "inherit" ? null : coalesceAgentMsgs === "true";
    o.operatorEnabled = operatorEnabled === "inherit" ? null : operatorEnabled === "true";
    o.schedulerEnabled = schedulerEnabled === "inherit" ? null : schedulerEnabled === "true";
    // Number("") would be 0 (a deadlocking cap), so blank must send the clear sentinel, not 0. A
    // non-numeric entry is routed through as the ORIGINAL STRING rather than Number()'s NaN — NaN
    // JSON-serializes to `null`, which would collide with the clear sentinel and silently "succeed" as
    // an inherit instead of 400ing; a string fails the number|null shape check and still 400s readably,
    // same demonstrable-invalid path as before this card.
    const gatesTrim = maxConcurrentGates.trim();
    if (gatesTrim === "") {
      o.maxConcurrentGates = null;
    } else {
      const n = Number(gatesTrim);
      (o as Record<string, unknown>).maxConcurrentGates = Number.isFinite(n) ? n : gatesTrim;
    }
    // Same blank/non-finite handling as maxConcurrentGates above (card 52ab5d45).
    const managersTrim = maxConcurrentManagers.trim();
    if (managersTrim === "") {
      o.maxConcurrentManagers = null;
    } else {
      const n = Number(managersTrim);
      (o as Record<string, unknown>).maxConcurrentManagers = Number.isFinite(n) ? n : managersTrim;
    }
    // `integrations` is ALWAYS emitted (unlike the blank-omits-the-key GLOBAL_FIELDS above) — the PATCH
    // handler shallow-merges only at the TOP level, so a submitted `integrations` key REPLACES the
    // persisted one wholesale. Omitting it when blank (the old behavior) meant clearing the
    // last configured path left the stale path persisted forever — an exec-surface path a user removed
    // must actually clear. Always resending the tool's CURRENT state (blank ⇒ `{}`, no `path`) makes a
    // clear-to-blank take effect, while a save that never touched integrations at all just resends the
    // unchanged persisted value (idempotent, since codescapePath is seeded from — and stays in sync with
    // — the loaded override).
    o.integrations = {
      codescape: codescapePath.trim() ? { path: codescapePath.trim() } : {},
    };
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

      <Panel>
        <SectionLabel>Scheduler</SectionLabel>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, maxWidth: 420 }}>
          <span style={fieldLabel}>Cron Scheduler enabled (off by default)</span>
          <TriSelect value={schedulerEnabled} set={setSchedulerEnabled} def={schedulerDefault} />
          <Hint>{effHint(schedulerResolved)}</Hint>
          <Hint>
            When on, the daemon starts the cron Scheduler so due schedules auto-spawn a manager session.
            Daemon-wide (one shared daemon), not per-project. Boot-time-gated: a flip here takes effect on
            the next daemon restart, same as the watcher cadences above.
          </Hint>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, maxWidth: 420, marginTop: 12 }}>
          <span style={fieldLabel}>Max concurrent scheduler-spawned managers · restart required</span>
          <Input value={maxConcurrentManagers} onChange={(e) => setMaxConcurrentManagers(e.target.value)}
            inputMode="numeric" placeholder={`inherit (default ${managersDefault})`} />
          <Hint>{effHint(managersResolved)} (takes effect after a daemon restart)</Hint>
          <Hint>
            Caps how many managers the cron Scheduler itself may have live at once — only its OWN spawns
            count; a standing human/Lead-spawned fleet never competes for this budget, however large it
            grows. Fleet-wide, not per-project. Boot-time-gated: unlike the gate cap below (re-read on
            every gate run), the Scheduler reads this ONCE at construction, so a saved change here needs
            the next daemon restart to actually change its budget — same as the toggle above. Whole
            number, 1–100.
          </Hint>
        </label>
      </Panel>

      <Panel>
        <SectionLabel>Gate Concurrency</SectionLabel>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, maxWidth: 420 }}>
          <span style={fieldLabel}>Max concurrent merge/deploy gates</span>
          <Input value={maxConcurrentGates} onChange={(e) => setMaxConcurrentGates(e.target.value)}
            inputMode="numeric" placeholder={`inherit (default ${gatesDefault})`} />
          <Hint>{effHint(gatesResolved)}</Hint>
          <Hint>
            Caps how many heavy merge/deploy gate runs execute at once across the whole host. Default 1
            (fully serialized). Takes effect on the next gate run, no daemon restart. Whole number, 1–50.
          </Hint>
        </label>
      </Panel>

      <Panel>
        <SectionLabel>Elevated Operator</SectionLabel>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, maxWidth: 560 }}>
          <span style={fieldLabel}>Elevated Operator (off by default)</span>
          <TriSelect value={operatorEnabled} set={setOperatorEnabled} def={defaults.operatorEnabled} />
          <Hint>{effHint(resolved.operatorEnabled)}</Hint>
          <Hint>
            Turning this on lets you spawn an <em>operator</em> session that can act on its own
            project&apos;s working tree on your behalf: (a) switch/create local branches and commit
            changes, (b) write files into that project&apos;s vault, and (c) push its current branch to
            its own remote (never a force-push). It is confined to the one project it&apos;s started in
            and is spawned only by you. It can never: run host/deploy commands, send data to a webhook,
            edit Loom&apos;s bundled skills, reach or act on other projects, create schedules, or spawn/
            elevate other sessions. Leave this off unless you want an agent committing and pushing code
            for you.
          </Hint>
        </label>
      </Panel>

      <Panel>
        <SectionLabel>Remote Access</SectionLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={fieldLabel}>Bind host (read-only — set via remoteAccess.bindHost)</span>
          <span style={{ fontFamily: font.mono, fontSize: 12, color: color.text }}>
            {resolved.remoteAccess.enabled ? resolved.remoteAccess.bindHost : "disabled (loopback only)"}
          </span>
        </div>
        {resolved.remoteAccess.enabled && isAllInterfacesBindHost(resolved.remoteAccess.bindHost) && (
          <Hint>
            Bound to all interfaces (<code>{resolved.remoteAccess.bindHost}</code>) — reachable from any
            device on your local network, not just this machine. Still gated by the access token + TLS;
            this is a supported mode, just a broad one worth knowing about.
          </Hint>
        )}
      </Panel>

      <Panel>
        <SectionLabel>Integrations</SectionLabel>
        <Hint>
          Optional host-tool paths (a host EXEC surface, human-only — never an agent MCP write). A new
          session picks up a change here immediately, no daemon restart needed. Blank falls back to the
          matching env var (LOOM_CODESCAPE_BIN) for headless/CI setups.
        </Hint>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 8 }}>
          <IntegrationRow slug="codescape" label="Codescape" path={codescapePath} setPath={setCodescapePath}
            placeholder="inherit (PATH: codescape)" />
        </div>
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

// One row per host-tool integration (card 8dc5ebb9): a path Input (this row's slice of the shared
// GlobalConfigForm save/dirty state above — no per-row save) + a live "detected/not-found"
// badge read from GET /api/integrations, polled while the Settings page is mounted (existsSync is
// cheap, so a light interval is fine — mirrors MarkitdownProvisioning's poll in Profiles.tsx, though
// that one narrows to `installing` only since a venv build is a one-time event).
const INTEGRATION_TONE: Record<IntegrationStatus["state"], Tone> = { detected: "phosphor", "not-found": "muted" };
const INTEGRATION_LABEL: Record<IntegrationStatus["state"], string> = { detected: "detected", "not-found": "not found" };
function IntegrationRow({ slug, label, path, setPath, placeholder }:
  { slug: IntegrationStatus["slug"]; label: string; path: string; setPath: (v: string) => void; placeholder: string }) {
  const q = useQuery({
    queryKey: ["integrations"],
    queryFn: api.integrations,
    refetchInterval: 15000,
  });
  const status = q.data?.integrations.find((s) => s.slug === slug);
  // A "not-found" badge reads as neutral (not an error) when nothing is configured at all (source
  // "none") — that's the common case for most users (Codescape simply isn't installed).
  const t = status ? (status.state === "not-found" && status.source === "none" ? "muted" : INTEGRATION_TONE[status.state]) : "muted";
  const accent = tone[t];
  // The label span is a DIRECT child of this <label> (like every other field on this page) so the e2e
  // spec's `label:has(> span:text-is(...))` locator convention finds this field precisely.
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={fieldLabel}>{label}</span>
      {status && (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: font.mono, fontSize: 11,
          color: accent, textTransform: "uppercase", letterSpacing: "0.06em" }}>
          <span aria-hidden style={{ width: 7, height: 7, borderRadius: 7, background: accent, display: "inline-block" }} />
          {INTEGRATION_LABEL[status.state]}
        </span>
      )}
      <Input value={path} onChange={(e) => setPath(e.target.value)} spellCheck={false} placeholder={placeholder} />
      {status?.detail && (
        <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted, lineHeight: 1.5 }}>{status.detail}</span>
      )}
    </label>
  );
}

// --- Connections (owner-controlled encrypted credential store, agent-tooling epic P1; oauth2 added P5a) -
// HUMAN-only loopback REST — there is intentionally NO agent-facing surface (agents only ever reach a
// connection THROUGH the authenticated_request tool, never this panel's data). List/add/revoke for
// api-key/bearer: the secret is write-only (accepted on create, never returned by any read, never
// re-editable in place — revoke + recreate). oauth2 is a two-step flow instead: register the provider app
// (client id/secret + auth/token URLs + scopes — still write-only), then "Connect" opens the provider's
// consent page in a new tab; the daemon's own fixed loopback callback completes the token exchange
// out-of-band, so this panel just reflects the resulting status (connected / token expiry / needs-reauth)
// once the browser tab returns focus here (react-query's default refetch-on-window-focus picks it up).
// The New-connection form leads with a turnkey "Google Analytics" preset (provider google, endpoints
// pre-filled by the daemon template, per-product read scopes as checkboxes) over that same oauth2 surface;
// "Custom" is the full free-text form. Daemon-global, like the tuning panel above (one shared store).

const AUTH_SCHEMES: ConnectionAuthScheme[] = ["api-key", "bearer", "oauth2"];
const OAUTH_PROVIDERS: { value: OAuthProviderSlug; label: string }[] = [
  { value: "google", label: "Google" },
  { value: "github", label: "GitHub" },
  { value: "custom", label: "Custom" },
];

// Short human label for a stored scope URL — a known GA preset scope maps to its product name; anything
// else falls back to its last path segment (e.g. ".../auth/drive.readonly" → "drive.readonly").
function scopeLabel(scope: string): string {
  const known = GOOGLE_ANALYTICS_SCOPE_PRESETS.find((p) => p.scope === scope);
  return known ? known.label : (scope.split("/").pop() || scope);
}

function oauthStatus(c: { connected?: boolean; needsReauth?: boolean; tokenExpiresAt?: string | null }): { tone: "phosphor" | "red" | "cyan"; label: string } {
  if (c.needsReauth) return { tone: "red", label: "Needs re-auth" };
  if (c.connected) return { tone: "phosphor", label: c.tokenExpiresAt ? `Connected · expires ${new Date(c.tokenExpiresAt).toLocaleString()}` : "Connected" };
  return { tone: "cyan", label: "Not connected" };
}

function ConnectionsPanel() {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["connections"],
    queryFn: () => api.connections(),
  });
  // Project scope (card f2abce7e): loaded once here for BOTH the create form's scope selector and the
  // list row's scope badge (project id -> name), same pattern as ProjectLinksPanel below.
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: () => api.projects() });
  const projectName = (id: string) => projects?.find((p) => p.id === id)?.name ?? id;
  // Bound/unbound state (card 12dc7fc9): a connection is "bound" once at least one profile allowlists it.
  // Derived client-side from the profile store (each ProfileSummary carries its `connections` allowlist) —
  // no dedicated backend surface needed. An auto-provisioned connection reads `unbound` until granted.
  const { data: profileRows } = useQuery({ queryKey: ["profiles"], queryFn: () => api.profiles() });
  const boundConnectionIds = new Set((profileRows ?? []).flatMap((p) => p.connections ?? []));

  const invalidate = () => qc.invalidateQueries({ queryKey: ["connections"] });
  const create = useMutation({
    mutationFn: (b: { name: string; host: string; authScheme: ConnectionAuthScheme; secret: string; projectId: string | null }) => api.createConnection(b),
    onSuccess: () => { setAdding(false); invalidate(); },
  });
  const createOAuth = useMutation({
    mutationFn: (b: { name: string; host: string; provider: OAuthProviderSlug; clientId: string; clientSecret: string; authUrl?: string; tokenUrl?: string; scopes?: string[]; projectId: string | null }) =>
      api.createOAuthConnection(b),
    onSuccess: () => { setAdding(false); invalidate(); },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteConnection(id),
    onSuccess: () => invalidate(),
    onError: (e) => window.alert((e as Error).message),
  });
  const consent = useMutation({
    mutationFn: (id: string) => api.initiateOAuthConsent(id),
    onSuccess: (r) => { window.open(r.authUrl, "_blank", "noopener,noreferrer"); },
    onError: (e) => window.alert((e as Error).message),
  });

  const rows = data ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Panel>
        <p style={{ color: color.textMuted, fontSize: 12, margin: 0, fontFamily: font.mono, lineHeight: 1.5 }}>
          Owner-only credentials for connecting Loom to external services. Secrets are encrypted at rest
          and never shown again after creation. There is no agent-facing tool that can read, list, or use
          them directly — an allowlisted session can only reach one THROUGH the authenticated_request tool.
        </p>
      </Panel>

      <Panel>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <SectionLabel style={{ margin: 0 }}>Connections ({rows.length})</SectionLabel>
          <span style={{ flex: 1 }} />
          {!adding && <Button variant="primary" onClick={() => { setAdding(true); create.reset(); createOAuth.reset(); }}>New connection</Button>}
        </div>

        {isLoading && <Hint>loading connections…</Hint>}
        {isError && <span style={{ color: color.red, fontSize: 12, fontFamily: font.mono }}>{(error as Error)?.message ?? "failed to load /api/connections"}</span>}

        {adding && (
          <div style={{ marginBottom: 10, padding: 12, background: color.panel2, border: `1px solid ${color.border}`, borderRadius: 6 }}>
            <ConnectionForm
              pending={create.isPending || createOAuth.isPending}
              error={(create.error ? (create.error as Error).message : null) ?? (createOAuth.error ? (createOAuth.error as Error).message : null)}
              projects={projects ?? []}
              onSubmit={(v) => create.mutate(v)}
              onSubmitOAuth={(v) => createOAuth.mutate(v)}
              onCancel={() => { setAdding(false); create.reset(); createOAuth.reset(); }}
            />
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {rows.length === 0 && !adding && !isLoading && (
            <span style={{ color: color.textMuted, fontSize: 13, fontFamily: font.mono }}>No connections yet.</span>
          )}
          {rows.map((c) => {
            const status = c.authScheme === "oauth2" ? oauthStatus(c) : null;
            return (
              <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", background: color.panel2, border: `1px solid ${color.border}`, borderRadius: 6, flexWrap: "wrap" }}>
                <span style={{ fontFamily: font.mono, fontSize: 13, color: color.text }}>{c.name}</span>
                <span style={{ fontFamily: font.mono, fontSize: 12, color: color.textMuted }}>{c.host}</span>
                <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textDim, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  {c.authScheme}{c.provider ? ` · ${c.provider}` : ""}
                </span>
                <Badge tone={c.projectId ? "cyan" : "phosphor"}>{c.projectId ? projectName(c.projectId) : "Global"}</Badge>
                {c.autoProvisioned && <Badge tone="cyan">Auto-provisioned</Badge>}
                {/* Bound/unbound (api-key/bearer): an oauth2 row's status is its own connectedness, so the
                    allowlist-binding badge only reads for the secret-injection schemes. */}
                {c.authScheme !== "oauth2" && (
                  boundConnectionIds.has(c.id)
                    ? <Badge tone="phosphor">Bound</Badge>
                    : <Badge tone="amber">Unbound</Badge>
                )}
                {status && <Badge tone={status.tone}>{status.label}</Badge>}
                {c.authScheme === "oauth2" && c.scopes && c.scopes.length > 0 && (
                  <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {c.scopes.map((s) => (
                      <span key={s} title={s} style={{ fontFamily: font.mono, fontSize: 10, color: color.textMuted, background: color.panel2, border: `1px solid ${color.border}`, borderRadius: 4, padding: "1px 5px" }}>
                        {scopeLabel(s)}
                      </span>
                    ))}
                  </span>
                )}
                <span style={{ flex: 1 }} />
                <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>{new Date(c.createdAt).toLocaleString()}</span>
                {c.authScheme === "oauth2" && (
                  <Button variant="ghost" disabled={consent.isPending} onClick={() => consent.mutate(c.id)}>
                    {c.connected && !c.needsReauth ? "Reconnect" : "Connect"}
                  </Button>
                )}
                <Button variant="danger" disabled={remove.isPending}
                  onClick={() => { if (window.confirm(`Revoke "${c.name}"? This cannot be undone — you'll need to re-create it with the secret to restore it.`)) remove.mutate(c.id); }}>
                  Revoke
                </Button>
              </div>
            );
          })}
        </div>
      </Panel>
    </div>
  );
}

// --- Pending bindings (credential auto-provisioning v1 binding UX, card 12dc7fc9 — "Direction B") -------
// The owner-approval queue: each row is an agent-requested profile→connection grant recorded when a
// credential Request was answered (the secret was stored + a Connection auto-provisioned, but the binding
// was DELIBERATELY never applied). "Review & grant" deep-links to the profile's connection allowlist with
// the connection pre-selected (via ?profile=&grant= query on /actors) — the grant is committed there by an
// explicit Save, never here. HUMAN-only read (GET /api/pending-bindings); the grant reuses the human-only
// profile-edit REST. Binding stays the deliberate owner-only trust decision — the whole point of Direction B.
function PendingBindingsPanel() {
  const navigate = useNavigate();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["pendingBindings"],
    queryFn: () => api.pendingBindings(),
  });
  const rows = data ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Panel>
        <p style={{ color: color.textMuted, fontSize: 12, margin: 0, fontFamily: font.mono, lineHeight: 1.5 }}>
          When you answer a credential an agent asked for, Loom stores the secret and creates a Connection —
          but it never grants that Connection to a profile on its own. Each grant an agent requested waits
          here for your explicit approval. "Review &amp; grant" opens the profile's connection allowlist with
          the connection pre-selected; nothing is granted until you Save there.
        </p>
      </Panel>

      <Panel>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <SectionLabel style={{ margin: 0 }}>Pending bindings ({rows.length})</SectionLabel>
        </div>

        {isLoading && <Hint>loading pending bindings…</Hint>}
        {isError && <span style={{ color: color.red, fontSize: 12, fontFamily: font.mono }}>{(error as Error)?.message ?? "failed to load /api/pending-bindings"}</span>}

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {rows.length === 0 && !isLoading && !isError && (
            <span style={{ color: color.textMuted, fontSize: 13, fontFamily: font.mono }}>No pending bindings — nothing waiting for your approval.</span>
          )}
          {rows.map((b) => (
            <div key={b.questionId} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", background: color.panel2, border: `1px solid ${color.border}`, borderRadius: 6, flexWrap: "wrap" }}>
              <span style={{ fontFamily: font.mono, fontSize: 13, color: color.text }}>{b.connectionName}</span>
              {b.connectionHost && <span style={{ fontFamily: font.mono, fontSize: 12, color: color.textMuted }}>{b.connectionHost}</span>}
              <span style={{ fontFamily: font.mono, fontSize: 12, color: color.textDim }}>→</span>
              <span style={{ fontFamily: font.mono, fontSize: 13, color: color.cyan }}>{b.profileName}</span>
              <Badge tone="muted">by {b.agentName}</Badge>
              <Badge tone="cyan">{b.projectName}</Badge>
              {b.alreadyGranted && <Badge tone="phosphor">Granted</Badge>}
              <span style={{ flex: 1 }} />
              <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>{new Date(b.requestedAt).toLocaleString()}</span>
              <Button variant={b.alreadyGranted ? "ghost" : "primary"}
                onClick={() => navigate(`/actors?tab=profiles&profile=${encodeURIComponent(b.profileId)}&grant=${encodeURIComponent(b.connectionId)}`)}>
                {b.alreadyGranted ? "View profile" : "Review & grant"}
              </Button>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

// The New-connection form leads with a CONNECTOR picker: a turnkey "Google Analytics" preset (the
// first-class oauth2 path — provider google, endpoints pre-filled by the daemon template, read scopes
// ticked as checkboxes) vs. "Custom" (the full api-key/bearer/oauth2 form with free-text URLs). The
// preset is UX-only: it POSTs the SAME /api/connections/oauth surface, just with the fields pre-shaped.
// v1 uses USER-supplied client id/secret (the user registers their own Google Cloud OAuth app) — a
// shared Loom-owned OAuth app is a separate owner-liability decision, not built here.
type ConnectorMode = "google-analytics" | "custom";
// GA products span several googleapis.com hosts (analyticsdata / searchconsole / adsense); host is
// metadata-only + unenforced today, so the preset pins the headline GA4 Data API host and hides the field.
const GA_PRESET_HOST = "analyticsdata.googleapis.com";

function ConnectionForm({ pending, error, projects, onSubmit, onSubmitOAuth, onCancel }: {
  pending: boolean; error: string | null;
  projects: { id: string; name: string }[];
  onSubmit: (v: { name: string; host: string; authScheme: ConnectionAuthScheme; secret: string; projectId: string | null }) => void;
  onSubmitOAuth: (v: { name: string; host: string; provider: OAuthProviderSlug; clientId: string; clientSecret: string; authUrl?: string; tokenUrl?: string; scopes?: string[]; projectId: string | null }) => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<ConnectorMode>("google-analytics");
  const [name, setName] = useState("Google Analytics");
  const [host, setHost] = useState("");
  const [authScheme, setAuthScheme] = useState<ConnectionAuthScheme>("api-key");
  // Project scope (card f2abce7e): "" = Global (every profile that allowlists it), else one project's id —
  // usable ONLY by that project's own sessions. Applies to BOTH the api-key/bearer and oauth2 branches.
  const [scopeProjectId, setScopeProjectId] = useState("");
  const [secret, setSecret] = useState("");
  const [provider, setProvider] = useState<OAuthProviderSlug>("google");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [authUrl, setAuthUrl] = useState("");
  const [tokenUrl, setTokenUrl] = useState("");
  const [scopesText, setScopesText] = useState("");
  // Which GA product read-scopes are ticked (Analytics Data API on by default — the headline use).
  const [gaScopes, setGaScopes] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(GOOGLE_ANALYTICS_SCOPE_PRESETS.map((p) => [p.key, p.key === "analytics"])),
  );
  const [localErr, setLocalErr] = useState<string | null>(null);

  const submit = () => {
    setLocalErr(null);
    if (mode === "google-analytics") {
      if (!name.trim()) {
        setLocalErr("A name is required.");
        return;
      }
      if (!clientId.trim() || !clientSecret.trim()) {
        setLocalErr("Client ID and client secret are required.");
        return;
      }
      const scopes = GOOGLE_ANALYTICS_SCOPE_PRESETS.filter((p) => gaScopes[p.key]).map((p) => p.scope);
      if (scopes.length === 0) {
        setLocalErr("Tick at least one product to read.");
        return;
      }
      // provider "google" ⇒ the daemon fills authUrl/tokenUrl from its template; we send only the scopes.
      onSubmitOAuth({
        name: name.trim(), host: GA_PRESET_HOST, provider: "google",
        clientId: clientId.trim(), clientSecret: clientSecret.trim(), scopes,
        projectId: scopeProjectId || null,
      });
      return;
    }
    if (!name.trim() || !host.trim()) {
      setLocalErr("Name and host are required.");
      return;
    }
    if (authScheme === "oauth2") {
      if (!clientId.trim() || !clientSecret.trim()) {
        setLocalErr("Client id and client secret are required.");
        return;
      }
      if (provider === "custom" && (!authUrl.trim() || !tokenUrl.trim())) {
        setLocalErr("A custom provider needs both an authorization URL and a token URL.");
        return;
      }
      const scopes = scopesText.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
      onSubmitOAuth({
        name: name.trim(), host: host.trim(), provider, clientId: clientId.trim(), clientSecret: clientSecret.trim(),
        authUrl: authUrl.trim() || undefined, tokenUrl: tokenUrl.trim() || undefined, scopes: scopes.length > 0 ? scopes : undefined,
        projectId: scopeProjectId || null,
      });
      return;
    }
    if (!secret.trim()) {
      setLocalErr("Secret is required.");
      return;
    }
    onSubmit({ name: name.trim(), host: host.trim(), authScheme, secret: secret.trim(), projectId: scopeProjectId || null });
  };

  const modeBtn = (m: ConnectorMode, label: string) => (
    <Button variant={mode === m ? "primary" : "ghost"} onClick={() => { setMode(m); setLocalErr(null); }}>{label}</Button>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={fieldLabel}>Connector</span>
        <div style={{ display: "flex", gap: 6 }} role="group" aria-label="Connector type">
          {modeBtn("google-analytics", "Google Analytics")}
          {modeBtn("custom", "Custom")}
        </div>
      </div>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={fieldLabel}>Scope</span>
        <Select value={scopeProjectId} onChange={(e) => setScopeProjectId(e.target.value)}>
          <option value="">Global — any profile that allowlists it</option>
          {projects.map((p) => <option key={p.id} value={p.id}>This project: {p.name}</option>)}
        </Select>
        <Hint>Global is reachable daemon-wide, exactly like today. Scoping to a project bounds the credential to that project's own sessions only.</Hint>
      </label>

      {mode === "google-analytics" ? (
        <>
          <Hint>Read GA4, Search Console &amp; AdSense numbers through one connection. Register your own Google Cloud OAuth app, then paste its client ID/secret below — Loom fills the rest and walks you through one consent.</Hint>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={fieldLabel}>Name</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Google Analytics" />
          </label>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={fieldLabel}>Read scopes</span>
            {GOOGLE_ANALYTICS_SCOPE_PRESETS.map((p) => (
              <label key={p.key} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "7px 9px", background: color.panel2, border: `1px solid ${color.border}`, borderRadius: 6, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={!!gaScopes[p.key]}
                  onChange={(e) => setGaScopes((s) => ({ ...s, [p.key]: e.target.checked }))}
                  style={{ accentColor: color.phosphor, width: 15, height: 15, marginTop: 1, flexShrink: 0 }}
                />
                <span style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                  <span style={{ fontFamily: font.mono, fontSize: 13, color: color.text }}>{p.label}</span>
                  <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>{p.description}</span>
                </span>
              </label>
            ))}
            <Hint>Only the products you tick are requested — every scope is read-only.</Hint>
          </div>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={fieldLabel}>Client ID</span>
            <Input value={clientId} onChange={(e) => setClientId(e.target.value)} spellCheck={false} autoComplete="off" />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={fieldLabel}>Client secret</span>
            <Input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} spellCheck={false} autoComplete="off" />
            <Hint>encrypted at rest immediately · never shown again after this form is submitted</Hint>
          </label>
        </>
      ) : (
        <>
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

          {authScheme === "oauth2" ? (
            <>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={fieldLabel}>Provider</span>
                <Select value={provider} onChange={(e) => setProvider(e.target.value as OAuthProviderSlug)}>
                  {OAUTH_PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </Select>
                <Hint>Google/GitHub prefill the standard auth+token endpoints — register a matching OAuth app there first.</Hint>
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={fieldLabel}>Client ID</span>
                <Input value={clientId} onChange={(e) => setClientId(e.target.value)} spellCheck={false} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={fieldLabel}>Client secret</span>
                <Input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} spellCheck={false} autoComplete="off" />
                <Hint>encrypted at rest immediately · never shown again after this form is submitted</Hint>
              </label>
              {provider === "custom" && (
                <>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={fieldLabel}>Authorization URL</span>
                    <Input value={authUrl} onChange={(e) => setAuthUrl(e.target.value)} placeholder="https://…/authorize" spellCheck={false} />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={fieldLabel}>Token URL</span>
                    <Input value={tokenUrl} onChange={(e) => setTokenUrl(e.target.value)} placeholder="https://…/token" spellCheck={false} />
                  </label>
                </>
              )}
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={fieldLabel}>Scopes <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0, color: color.textMuted }}>(space or comma separated — optional, uses the provider default)</span></span>
                <Input value={scopesText} onChange={(e) => setScopesText(e.target.value)} placeholder="e.g. repo read:user" spellCheck={false} />
              </label>
            </>
          ) : (
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={fieldLabel}>Secret</span>
              <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} spellCheck={false} autoComplete="off" />
              <Hint>encrypted at rest immediately · never shown again after this form is submitted</Hint>
            </label>
          )}
        </>
      )}

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

// Owner-declared symmetric project links (board card 2349d90c) — the sole gate for the manager↔manager
// `peer_message` cross-project channel. Daemon-global (like Connections/Capabilities), HUMAN-only REST —
// there is intentionally no agent MCP path that can create or remove a link. A minimal list + two-project
// picker; project names are resolved from the already-loaded active-project list (api.projects()).
function ProjectLinksPanel() {
  const qc = useQueryClient();
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: () => api.projects() });
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["projectLinks"],
    queryFn: () => api.projectLinks(),
  });

  const nameFor = (id: string) => projects?.find((p) => p.id === id)?.name ?? id;

  const invalidate = () => qc.invalidateQueries({ queryKey: ["projectLinks"] });
  const [projectA, setProjectA] = useState("");
  const [projectB, setProjectB] = useState("");
  const create = useMutation({
    mutationFn: () => api.createProjectLink({ projectA, projectB }),
    onSuccess: () => { setProjectA(""); setProjectB(""); invalidate(); },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteProjectLink(id),
    onSuccess: () => invalidate(),
    onError: (e) => window.alert((e as Error).message),
  });

  const rows = data ?? [];
  const options = projects ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Panel>
        <p style={{ color: color.textMuted, fontSize: 12, margin: 0, fontFamily: font.mono, lineHeight: 1.5 }}>
          Link two projects to let their managers message each other directly (the <code>peer_message</code> tool) —
          e.g. to answer contract questions without hand-relaying them through the Platform Lead. A manager can
          reach ONLY a project linked here; there is no agent-facing way to create a link.
        </p>
      </Panel>

      <Panel>
        <SectionLabel style={{ margin: "0 0 8px" }}>Links ({rows.length})</SectionLabel>

        {isLoading && <Hint>loading project links…</Hint>}
        {isError && <span style={{ color: color.red, fontSize: 12, fontFamily: font.mono }}>{(error as Error)?.message ?? "failed to load /api/project-links"}</span>}

        <div style={{ display: "flex", alignItems: "flex-end", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={fieldLabel}>Project A</span>
            <Select value={projectA} onChange={(e) => setProjectA(e.target.value)}>
              <option value="">select…</option>
              {options.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={fieldLabel}>Project B</span>
            <Select value={projectB} onChange={(e) => setProjectB(e.target.value)}>
              <option value="">select…</option>
              {options.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </label>
          <Button variant="primary" disabled={!projectA || !projectB || create.isPending} onClick={() => create.mutate()}>
            Link
          </Button>
        </div>
        {create.error && <span style={{ color: color.red, fontSize: 12, fontFamily: font.mono, display: "block", marginBottom: 8 }}>{(create.error as Error).message}</span>}

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {rows.length === 0 && !isLoading && (
            <span style={{ color: color.textMuted, fontSize: 13, fontFamily: font.mono }}>No project links yet.</span>
          )}
          {rows.map((l) => (
            <div key={l.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", background: color.panel2, border: `1px solid ${color.border}`, borderRadius: 6, flexWrap: "wrap" }}>
              <span style={{ fontFamily: font.mono, fontSize: 13, color: color.text }}>{nameFor(l.projectAId)}</span>
              <span style={{ color: color.textDim }}>↔</span>
              <span style={{ fontFamily: font.mono, fontSize: 13, color: color.text }}>{nameFor(l.projectBId)}</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>{new Date(l.createdAt).toLocaleString()}</span>
              <Button variant="danger" disabled={remove.isPending}
                onClick={() => { if (window.confirm(`Unlink "${nameFor(l.projectAId)}" and "${nameFor(l.projectBId)}"? Their managers will no longer be able to peer_message each other.`)) remove.mutate(l.id); }}>
                Unlink
              </Button>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

function PollJobsPanel() {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const jobs = useQuery({ queryKey: ["pollJobs"], queryFn: () => api.pollJobs() });
  const connections = useQuery({ queryKey: ["connections"], queryFn: () => api.connections() });
  const sessions = useQuery({ queryKey: ["allSessions"], queryFn: () => api.allSessions() });
  // Flat cross-project "Project / Agent" labels for the spawn-mode target picker. Poll jobs are
  // daemon-global, so the target can be any project's agent.
  const agents = useAllAgents();

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
