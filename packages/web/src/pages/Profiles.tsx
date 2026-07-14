import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Profile, ProfileSummary, ProfileMergeResult, ProfileFieldMerge, SessionRole, CapabilityGrant } from "@loom/shared";
import { api, type ProfileFieldResolution, type PythonProvisioning, type PythonProvisioningReason } from "../lib/api";
import { Panel, Button, Input, Select, SectionLabel, Badge } from "../components/ui";
import { color, font, radius, tone, type Tone } from "../theme";
import { agentProfiles } from "../lib/profileRoles";
import { RolePicker } from "../components/RolePicker";
import { RoleBadge, roleDisplay, roleColor } from "../lib/roleDisplay";

// Loom's Profiles — the reusable, platform-level rig (role + model + permission deltas + icon) an
// agent runs under via its profileId. The injected prompt comes from the AGENT; a profile's
// `description` is a UI-only blurb. HUMAN-managed only (profiles confer role + privilege), so there
// is no agent MCP surface — just this page + REST. Edits apply on the next spawn.
//
// Bundled profiles carry a precise customization state computed server-side from three versions —
// `base` (the shipped def at last sync), `mine` (the user's row, what sessions use) and the current
// `shipped` bundled def (see `Profile Customization.md`). Unlike skills (line-based text), the merge is
// FIELD-level: `customized` = mine ≠ base, `updateAvailable` = base ≠ shipped. "Adopt update" applies
// Loom's field changes onto the user's edits, resolving any all-three-differ conflict per field.
export default function Profiles() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [reloadNonce, setReloadNonce] = useState(0); // bumped on revert/adopt to remount the editor onto fresh fields

  const profiles = useQuery({ queryKey: ["profiles"], queryFn: api.profiles });
  const current = useQuery({ queryKey: ["profile", selected], queryFn: () => api.profile(selected!), enabled: !!selected });

  const create = useMutation({
    mutationFn: (name: string) =>
      api.createProfile({ name, role: null, description: "", allowDelta: [], skills: null, model: null, icon: null }),
    onSuccess: (p) => { qc.invalidateQueries({ queryKey: ["profiles"] }); setSelected(p.id); setNewName(""); },
  });
  const save = useMutation({
    mutationFn: (v: { id: string; patch: Partial<Omit<Profile, "id">> }) => api.updateProfile(v.id, v.patch),
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: ["profiles"] });
      qc.invalidateQueries({ queryKey: ["profile", p.id] }); // refetch the SUMMARY (PUT returns the bare row, no computed state)
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteProfile(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["profiles"] }); setSelected(null); },
  });
  const revert = useMutation({
    mutationFn: (id: string) => api.resetProfile(id),
    onSuccess: (p) => {
      qc.setQueryData(["profile", p.id], p); // sync editor to bundled fields (the reset response carries computed state)
      qc.invalidateQueries({ queryKey: ["profiles"] });
      setReloadNonce((n) => n + 1); // remount the editor onto the restored fields
    },
  });
  // Adopt the shipped update: empty resolutions one-clicks a clean auto-merge; a per-conflict-field map
  // lands a conflict resolution. Mirrors `revert` — refresh the editor onto the merged fields and remount
  // it, which also closes the resolver (the editor's local state resets on the key change).
  const adopt = useMutation({
    mutationFn: (resolutions?: Record<string, ProfileFieldResolution>) => api.adoptProfile(selected!, resolutions),
    onSuccess: (p) => {
      qc.setQueryData(["profile", p.id], p);
      qc.invalidateQueries({ queryKey: ["profiles"] });
      qc.invalidateQueries({ queryKey: ["profile", p.id, "update-diff"] });
      setReloadNonce((n) => n + 1);
    },
  });

  const validNew = newName.trim().length > 0 && !profiles.data?.some((p) => p.name === newName.trim());

  return (
    <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 16 }}>
      <Panel style={{ alignSelf: "start" }}>
        <SectionLabel>Profiles</SectionLabel>
        <p style={{ color: color.textMuted, fontSize: 11, margin: "0 0 10px", fontFamily: font.mono, lineHeight: 1.5 }}>
          Reusable, cross-project rig — role, model, permission deltas, skill subset, icon, plus a
          description blurb. An agent runs under one to drive how its sessions spawn; the injected
          prompt comes from the agent. Human-managed only; edits apply on the next spawn.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {/* The companion's assistant-role rig is HIDDEN here — companion config lives entirely under
              Companion → Manage now, so it never shows among the agent rigs. */}
          {agentProfiles(profiles.data ?? []).map((p) => (
            <Button key={p.id} variant={p.id === selected ? "primary" : "default"} style={{ textAlign: "left", display: "flex", alignItems: "center", gap: 8 }}
              onClick={() => setSelected(p.id)} title={p.description || p.name}>
              {p.icon && <span>{p.icon}</span>}
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
              <StatusDots customized={!!p.customized} updateAvailable={!!p.updateAvailable} />
              <span style={{ fontSize: 10, color: roleColor(p.role), fontFamily: font.mono }}>{roleDisplay(p.role).short}</span>
            </Button>
          ))}
          {agentProfiles(profiles.data ?? []).length === 0 && <span style={{ color: color.textMuted, fontSize: 12 }}>No profiles yet.</span>}
        </div>
        <div style={{ marginTop: 12, display: "flex", gap: 6 }}>
          <Input placeholder="new profile name" value={newName} onChange={(e) => setNewName(e.target.value)} style={{ flex: 1 }} />
          <Button variant="primary" disabled={!validNew || create.isPending} onClick={() => create.mutate(newName.trim())}>+ New</Button>
        </div>
      </Panel>

      <Panel style={{ minHeight: "72vh", padding: 12 }}>
        {selected && current.data ? (
          <ProfileEditor key={`${selected}:${reloadNonce}`} profile={current.data}
            onSave={(patch) => save.mutate({ id: selected, patch })} saving={save.isPending}
            onDelete={() => remove.mutate(selected)} deleting={remove.isPending}
            onRevert={() => revert.mutate(selected)} reverting={revert.isPending}
            onAdopt={(resolutions) => adopt.mutate(resolutions)} adopting={adopt.isPending} adoptError={adopt.error as Error | null} />
        ) : <p style={{ color: color.textMuted, padding: 12 }}>Select a profile to edit it, or create a new one.</p>}
      </Panel>
    </div>
  );
}

// Compact sidebar status: a cyan dot for "customized", an amber dot for "update available". Restrained —
// the full-text badges live in the editor header; here it's a glanceable signal with a hover title.
// Mirrors Skills.tsx StatusDots.
function StatusDots({ customized, updateAvailable }: { customized: boolean; updateAvailable: boolean }) {
  if (!customized && !updateAvailable) return null;
  return (
    <span style={{ display: "inline-flex", gap: 4, flexShrink: 0 }}>
      {customized && <Dot tone="cyan" title="Customized — you edited this profile" />}
      {updateAvailable && <Dot tone="amber" title="Update available — Loom shipped a newer version" />}
    </span>
  );
}
function Dot({ tone: t, title }: { tone: Tone; title: string }) {
  const c = { cyan: color.cyan, amber: color.amber } as Record<string, string>;
  return <span title={title} style={{ width: 7, height: 7, borderRadius: 7, background: c[t] ?? color.textMuted, display: "inline-block" }} />;
}

// Reason → human one-liner for a FAILED provisioning attempt. The daemon classifies the cause; we phrase
// it for a human and, for the one self-service case (no base Python), point at the Settings field below.
const PROVISION_REASON: Record<PythonProvisioningReason, string> = {
  "no-base-python": "no base Python ≥3.10 found — set its path in Settings → Python interpreter",
  "venv-create-failed": "couldn't create the shared venv",
  "pip-failed": "pip install of markitdown failed",
  timeout: "install timed out",
  disabled: "provisioning disabled on this daemon (LOOM_PYTHON_NO_PROVISION)",
};

// One-line human summary per provisioning state — its signal tone + label.
const PROVISION_META: Record<PythonProvisioning["state"], { tone: Tone; label: string }> = {
  idle: { tone: "muted", label: "not provisioned yet" },
  installing: { tone: "amber", label: "installing…" },
  ready: { tone: "phosphor", label: "ready" },
  failed: { tone: "red", label: "install failed" },
};

// GLOBAL document-conversion provisioning status. ONE Loom-managed venv backs EVERY documentConversion
// rig, so this reads the capability-wide state — not a per-profile one. Today a session can silently lack
// the markitdown MCP when the venv is still installing or failed to provision; this makes that visible and
// self-service. Polls only while `installing` (terminal states don't change on their own). `failed` shows
// the classified reason + an expandable errorTail (the captured pip/venv output) and a human Retry that
// re-kicks provisioning. Restrained: a hairline row tinted by state, mirroring the UpdateBanner above.
function MarkitdownProvisioning() {
  const qc = useQueryClient();
  const [showTail, setShowTail] = useState(false);
  const q = useQuery({
    queryKey: ["pythonProvisioning"],
    queryFn: api.pythonProvisioning,
    refetchInterval: (query) => (query.state.data?.state === "installing" ? 2000 : false),
  });
  const retry = useMutation({
    mutationFn: () => api.retryPythonProvisioning(),
    onSuccess: (s) => { qc.setQueryData(["pythonProvisioning"], s); qc.invalidateQueries({ queryKey: ["pythonProvisioning"] }); },
  });

  const s = q.data;
  const state = s?.state;
  const meta = state ? PROVISION_META[state] : null;
  const accent = meta ? tone[meta.tone] : color.border;
  // The hairline tints toward the state ONLY when it wants attention (installing / failed); ready + idle
  // stay neutral so the row reads as ambient status, not an alert.
  const borderColor = state === "failed" || state === "installing" ? accent : color.border;
  const reasonText = s?.reason ? PROVISION_REASON[s.reason] : null;
  const labelStyle = { fontFamily: font.mono, fontSize: 11, color: color.textMuted, lineHeight: 1.5 };

  return (
    <div data-testid="markitdown-provisioning" style={{ border: `1px solid ${borderColor}`, borderRadius: radius.base,
      padding: "8px 10px", background: color.panel2, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontFamily: font.head, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: color.textDim }}>
          Document-conversion venv
        </span>
        {q.isLoading && !s ? (
          <span style={labelStyle}>checking…</span>
        ) : q.isError && !s ? (
          <span style={{ ...labelStyle, color: color.red }}>couldn't read status</span>
        ) : meta ? (
          <span data-testid="provisioning-state" style={{ display: "inline-flex", alignItems: "center", gap: 6,
            fontFamily: font.mono, fontSize: 11, color: accent, textTransform: "uppercase", letterSpacing: "0.06em" }}>
            <span aria-hidden style={{ width: 8, height: 8, borderRadius: 8, background: accent, display: "inline-block",
              ...(state === "installing" ? { boxShadow: `0 0 6px ${accent}` } : null) }} />
            {meta.label}
            {state === "failed" && reasonText && (
              <span style={{ textTransform: "none", letterSpacing: 0, color: color.textMuted }}>— {reasonText}</span>
            )}
          </span>
        ) : null}
        <span style={{ flex: 1 }} />
        {s?.errorTail && (
          <Button onClick={() => setShowTail((v) => !v)}>{showTail ? "Hide details" : "Show details"}</Button>
        )}
        {state === "failed" && (
          <Button variant="primary" disabled={retry.isPending} onClick={() => retry.mutate()}
            title="Re-run the venv create + markitdown install">
            {retry.isPending ? "Retrying…" : "Retry install"}
          </Button>
        )}
      </div>

      {/* Ready: name the resolved binary so the user can confirm WHICH interpreter/venv is live. */}
      {state === "ready" && s?.binary && (
        <span style={{ ...labelStyle, wordBreak: "break-all" }}>{s.binary}</span>
      )}
      {/* Idle: explain it provisions lazily — no action needed. */}
      {state === "idle" && (
        <span style={labelStyle}>Loom installs the shared venv on the first document-conversion session, or you can pre-warm it by saving a profile with this on.</span>
      )}
      {retry.isError && <span style={{ ...labelStyle, color: color.red }}>retry failed: {(retry.error as Error).message}</span>}

      {/* The captured pip/venv output tail — the real proxy / SSL / resolver cause, shown on demand. */}
      {showTail && s?.errorTail && (
        <pre style={{ margin: 0, maxHeight: 220, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word",
          fontFamily: font.mono, fontSize: 11, lineHeight: 1.5, color: color.textMuted,
          background: color.panel, border: `1px solid ${color.border}`, borderRadius: radius.sm, padding: 8 }}>
          {s.errorTail}
        </pre>
      )}
    </div>
  );
}

// Remounted per profile (key=id:nonce) so the fields reset on switch / revert / adopt; after Save the
// query updates and `dirty` clears against the new values. Mirrors the Skills / agent-preset editors.
function ProfileEditor({ profile, onSave, saving, onDelete, deleting, onRevert, reverting, onAdopt, adopting, adoptError }:
  { profile: ProfileSummary; onSave: (patch: Partial<Omit<Profile, "id">>) => void; saving: boolean;
    onDelete: () => void; deleting: boolean; onRevert: () => void; reverting: boolean;
    onAdopt: (resolutions?: Record<string, ProfileFieldResolution>) => void; adopting: boolean; adoptError: Error | null }) {
  const bundled = profile.bundled;
  const customized = !!profile.customized;
  const updateAvailable = !!profile.updateAvailable;

  const [name, setName] = useState(profile.name);
  const [role, setRole] = useState<SessionRole | "">(profile.role ?? "");
  const [description, setDescription] = useState(profile.description);
  const [allowText, setAllowText] = useState(profile.allowDelta.join("\n"));
  const [icon, setIcon] = useState(profile.icon ?? "");
  const [model, setModel] = useState(profile.model ?? "");
  const [browserTesting, setBrowserTesting] = useState(profile.browserTesting ?? false);
  const [documentConversion, setDocumentConversion] = useState(profile.documentConversion ?? false);
  const [dejaCorpus, setDejaCorpus] = useState(profile.dejaCorpus ?? false);
  const [openDesign, setOpenDesign] = useState(profile.openDesign ?? false);
  const [restrictedTools, setRestrictedTools] = useState(profile.restrictedTools ?? false);
  const [noCommit, setNoCommit] = useState(profile.noCommit ?? false);
  // Skill subset (empty = deliver ALL, the default — null and [] are equivalent, matching the daemon).
  const [skills, setSkills] = useState<string[]>(profile.skills ?? []);
  // Authenticated-egress connection-id allowlist (empty = NO access, the secure default — UNLIKE skills,
  // empty here never means "all"). Human-set only, here or via REST — never an agent MCP tool.
  const [connections, setConnections] = useState<string[]>(profile.connections ?? []);
  // Registry-capability grants BEYOND browserTesting/documentConversion above (agent-tooling P4) — raw,
  // never pre-bridged with the two legacy booleans (mirrors the daemon's resolveProfileCapabilities split).
  const [capabilities, setCapabilities] = useState<CapabilityGrant[]>(profile.capabilities ?? []);
  const [confirmDel, setConfirmDel] = useState(false);
  const [confirmRevert, setConfirmRevert] = useState(false);
  const [resolver, setResolver] = useState<ProfileMergeResult | null>(null); // open ⇔ a conflicting adopt

  // Adopt step 1 — dry-run the field-level merge. Clean → one-click adopt (no resolutions). Conflict → resolver.
  const preview = useMutation({
    mutationFn: () => api.profileMergePreview(profile.id),
    onSuccess: (p) => { if (p.clean) onAdopt(undefined); else setResolver(p); },
  });
  const adoptBusy = preview.isPending || adopting;

  // The store's skill names — the menu of what a subset can pick from (same list the Skills page edits).
  const skillList = useQuery({ queryKey: ["skills"], queryFn: api.skills });
  const available = (skillList.data ?? []).map((s) => s.name);
  const toggleSkill = (n: string) => setSkills((cur) => (cur.includes(n) ? cur.filter((s) => s !== n) : [...cur, n]));
  const sortedJson = (xs: string[]) => JSON.stringify([...xs].sort());

  // The P1 credential store's connections — the menu of what this rig's egress allowlist can grant.
  const connectionList = useQuery({ queryKey: ["connections"], queryFn: api.connections });
  const availableConnections = connectionList.data ?? [];
  const toggleConnection = (id: string) => setConnections((cur) => (cur.includes(id) ? cur.filter((c) => c !== id) : [...cur, id]));

  // The capability registry catalog (agent-tooling P4): builtins + owner-added, ONE unified list — the
  // Profile editor's picker renders every entry as a checkbox, transparently backed by browserTesting/
  // documentConversion/dejaCorpus/openDesign for the four reserved slugs and by the `capabilities` array
  // for everything else.
  const capabilityList = useQuery({ queryKey: ["capabilities"], queryFn: api.capabilities });
  // Deja is a PRIVATE product (Loom is public on npm) — its capability entry is hidden from the picker
  // unless this is a LOOM_DEV build. Same isDev signal Platform.tsx/Skills.tsx derive from the reserved
  // "Loom Platform" home's existence (GET /api/platform/home only 200s under LOOM_DEV=1). A profile that
  // already has dejaCorpus:true stored just loses its visible toggle here — the daemon-side grant is
  // ALSO gated (buildMcpServers), so it never wires regardless.
  const platformHome = useQuery({ queryKey: ["platformHome"], queryFn: api.platformHome, retry: false });
  const isDev = platformHome.isSuccess && !!platformHome.data?.project;
  const availableCapabilities = (capabilityList.data ?? []).filter((c) => isDev || c.slug !== "deja-corpus");
  const isCapabilityChecked = (slug: string) =>
    slug === "browser-testing" ? browserTesting
    : slug === "document-conversion" ? documentConversion
    : slug === "deja-corpus" ? dejaCorpus
    : slug === "open-design" ? openDesign
    : capabilities.some((g) => g.slug === slug);
  const toggleCapability = (slug: string) => {
    if (slug === "browser-testing") return setBrowserTesting((v) => !v);
    if (slug === "document-conversion") return setDocumentConversion((v) => !v);
    if (slug === "deja-corpus") return setDejaCorpus((v) => !v);
    if (slug === "open-design") return setOpenDesign((v) => !v);
    setCapabilities((cur) => (cur.some((g) => g.slug === slug) ? cur.filter((g) => g.slug !== slug) : [...cur, { slug }]));
  };
  const capabilityConnectionId = (slug: string) => capabilities.find((g) => g.slug === slug)?.connectionId ?? "";
  const setCapabilityConnectionId = (slug: string, connectionId: string) =>
    setCapabilities((cur) => cur.map((g) => (g.slug === slug ? { ...g, connectionId: connectionId || undefined } : g)));
  // Canonical per-grant JSON (key-sorted) so {slug,connectionId} order never spuriously trips dirty/save —
  // mirrors the daemon's customization.ts fieldEqual for the same field.
  const capsJson = (xs: CapabilityGrant[]) => JSON.stringify(xs.map((g) => JSON.stringify(g, Object.keys(g).sort())).sort());

  const allowDelta = allowText.split("\n").map((s) => s.trim()).filter(Boolean);
  const dirty =
    name !== profile.name ||
    (role || null) !== profile.role ||
    description !== profile.description ||
    JSON.stringify(allowDelta) !== JSON.stringify(profile.allowDelta) ||
    (icon || null) !== profile.icon ||
    (model.trim() || null) !== profile.model ||
    browserTesting !== (profile.browserTesting ?? false) ||
    documentConversion !== (profile.documentConversion ?? false) ||
    dejaCorpus !== (profile.dejaCorpus ?? false) ||
    openDesign !== (profile.openDesign ?? false) ||
    restrictedTools !== (profile.restrictedTools ?? false) ||
    noCommit !== (profile.noCommit ?? false) ||
    sortedJson(skills) !== sortedJson(profile.skills ?? []) ||
    sortedJson(connections) !== sortedJson(profile.connections ?? []) ||
    capsJson(capabilities) !== capsJson(profile.capabilities ?? []);

  const fieldLabel = { fontFamily: font.head as string, fontSize: 11, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.08em", color: color.textDim };
  const ta = {
    width: "100%", boxSizing: "border-box" as const, resize: "vertical" as const, fontFamily: font.mono, fontSize: 13, lineHeight: 1.5,
    background: color.panel2, color: color.text, border: `1px solid ${color.border}`, borderRadius: 6, padding: 8,
  };

  const reset = () => { setName(profile.name); setRole(profile.role ?? ""); setDescription(profile.description); setAllowText(profile.allowDelta.join("\n")); setIcon(profile.icon ?? ""); setModel(profile.model ?? ""); setBrowserTesting(profile.browserTesting ?? false); setDocumentConversion(profile.documentConversion ?? false); setDejaCorpus(profile.dejaCorpus ?? false); setOpenDesign(profile.openDesign ?? false); setRestrictedTools(profile.restrictedTools ?? false); setNoCommit(profile.noCommit ?? false); setSkills(profile.skills ?? []); setConnections(profile.connections ?? []); setCapabilities(profile.capabilities ?? []); };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <strong style={{ fontFamily: font.head, textTransform: "uppercase", letterSpacing: "0.08em", color: color.text }}>{profile.name}</strong>
        <RoleBadge role={role || null} />
        {bundled && <Badge tone="muted">bundled</Badge>}
        {customized && <Badge tone="cyan">customized</Badge>}
        {updateAvailable && <Badge tone="amber">update available</Badge>}
        <span style={{ flex: 1 }} />
        {confirmDel ? (
          <>
            <span style={{ color: color.red, fontSize: 12, fontFamily: font.mono }}>delete {profile.name}?</span>
            <Button variant="danger" disabled={deleting} onClick={onDelete}>Confirm</Button>
            <Button onClick={() => setConfirmDel(false)}>Cancel</Button>
          </>
        ) : <Button variant="danger" onClick={() => setConfirmDel(true)}>Delete</Button>}
      </div>

      {/* Update banner — only when Loom has shipped newer bundled fields. Groups the adopt affordance with
          a "what shipped changed" expander (a field-by-field old→new table) so the user previews the
          incoming change before adopting. */}
      {updateAvailable && (
        <UpdateBanner id={profile.id} onAdopt={() => preview.mutate()} adoptBusy={adoptBusy}
          error={(preview.error as Error | null) ?? adoptError} />
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 90px", gap: 10 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={fieldLabel}>Name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={fieldLabel}>Icon</span>
          <Input value={icon} onChange={(e) => setIcon(e.target.value)} placeholder="emoji" />
        </label>
      </div>

      {/* Role — the capability "class" picker (card 04fec5be). Each conferrable role is a card whose
          powers are read from the ONE role display map (lib/roleDisplay) + verified against the real
          daemon gates; dev-layer roles show LOCKED. Display-only: the enum passed up is unchanged. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={fieldLabel}>Role · capability class</span>
        <RolePicker value={role} onChange={setRole} />
      </div>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={fieldLabel}>Description</span>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} spellCheck={false}
          style={{ ...ta, minHeight: 140 }} placeholder="A human-facing blurb shown here in the Profiles UI — what this rig is for. NEVER injected into a session (the startup prompt comes from the agent)." />
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={fieldLabel}>Allow delta <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0, color: color.textMuted }}>· one permission glob per line, layered onto the resolved allowlist</span></span>
        <textarea value={allowText} onChange={(e) => setAllowText(e.target.value)} spellCheck={false}
          style={{ ...ta, minHeight: 80 }} placeholder={"Bash(pnpm *)\nRead(*)"} />
      </label>

      {/* Agent-tooling P4 capability registry: ONE unified picker over the catalog (the two builtins +
          any owner-added rows), replacing the old separate browser-testing/document-conversion checkboxes.
          Each entry launches a host process / MCP server — human-set here only, never via an agent tool.
          A `requiresConnection` entry reveals an inline P1-connection binding when checked. */}
      <label style={fieldLabel}>Capabilities</label>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {availableCapabilities.map((c) => {
          const checked = isCapabilityChecked(c.slug);
          const isLegacy = c.slug === "browser-testing" || c.slug === "document-conversion" || c.slug === "deja-corpus";
          return (
            <label key={c.slug} style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
              <input type="checkbox" checked={checked} onChange={() => toggleCapability(c.slug)} style={{ marginTop: 2 }} />
              <span style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1 }}>
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ ...fieldLabel, textTransform: "none", letterSpacing: 0, fontSize: 13 }}>{c.name}</span>
                  {c.builtin && <Badge tone="muted">builtin</Badge>}
                  {c.requiresConnection && <Badge tone="cyan">needs connection</Badge>}
                </span>
                <span style={{ fontWeight: 400, color: color.textMuted, fontSize: 11, fontFamily: font.mono, lineHeight: 1.5 }}>
                  {c.description}
                </span>
                {checked && c.requiresConnection && !isLegacy && (
                  <>
                    <Select
                      value={capabilityConnectionId(c.slug)}
                      onChange={(e) => setCapabilityConnectionId(c.slug, e.target.value)}
                      style={{ marginTop: 4, maxWidth: 260 }}
                    >
                      <option value="">— pick a connection —</option>
                      {/* oauth2 connections are excluded here (and rejected server-side if forced via a raw
                          PUT): a requiresConnection grant statically injects a secret at spawn, which oauth2
                          doesn't support — it refreshes on use via the authenticated_request tool instead. */}
                      {availableConnections.filter((conn) => conn.authScheme !== "oauth2").map((conn) => (
                        <option key={conn.id} value={conn.id}>{conn.name}</option>
                      ))}
                    </Select>
                    {availableConnections.some((conn) => conn.authScheme === "oauth2") && (
                      <span style={{ fontSize: 11, color: color.textMuted, fontFamily: font.mono }}>
                        oauth2 connections aren't listed — they can't be statically injected here. Use the authenticated_request tool for oauth2 access instead.
                      </span>
                    )}
                  </>
                )}
              </span>
            </label>
          );
        })}
        {availableCapabilities.length === 0 && (
          <span style={{ color: color.textMuted, fontSize: 12, fontFamily: font.mono }}>Loading capability catalog…</span>
        )}
      </div>

      {/* Shared-venv provisioning status — surfaced only when this rig opts into documentConversion. ONE
          Loom-managed venv backs the capability, so this is a GLOBAL status (not per-profile): a session
          can silently lack the markitdown MCP only because the venv is still installing or failed to. */}
      {documentConversion && <MarkitdownProvisioning />}

      {/* Opt-in restricted tools: a session under this rig spawns with the dangerous NATIVE tools (raw
          shell + host-writes) removed from the model's tool list. Blast-radius control for a chat-reachable
          Companion driven by untrusted input — human-set here only, never via an agent tool. */}
      <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
        <input type="checkbox" checked={restrictedTools} onChange={(e) => setRestrictedTools(e.target.checked)} style={{ marginTop: 2 }} />
        <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={fieldLabel}>Restricted tools</span>
          <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0, color: color.textMuted, fontSize: 11, fontFamily: font.mono, lineHeight: 1.5 }}>
            Lock down blast radius: remove the dangerous native tools (Bash / Edit / Write / NotebookEdit /
            MultiEdit, subagent delegation Task / Agent, and network egress WebFetch / WebSearch) from this
            rig's tool list — so it can't run a shell, write host files, spawn a subagent that re-acquires
            them, or reach the network. Read / Glob / Grep and the Loom MCP tools stay. Turn ON for a companion
            reachable from untrusted chat; turning it OFF widens the rig deliberately.
          </span>
        </span>
      </label>

      {/* Declared no-commit role: a read-only worker (e.g. a code reviewer) whose correct contract is to
          produce NO commit. Lifecycle-only — confers no spawn capability; human-set here only. */}
      <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
        <input type="checkbox" checked={noCommit} onChange={(e) => setNoCommit(e.target.checked)} style={{ marginTop: 2 }} />
        <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={fieldLabel}>No-commit role</span>
          <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0, color: color.textMuted, fontSize: 11, fontFamily: font.mono, lineHeight: 1.5 }}>
            Mark this rig a READ-ONLY / no-commit worker (e.g. a code reviewer) whose correct contract is 0
            files changed. A worker under it that reports done with no commit is auto-retired — its
            concurrency slot freed with no manual stop — and the "forgot to commit" warning is suppressed.
            Leave off for any rig that produces commits (a normal 0-commit done still warns).
          </span>
        </span>
      </label>

      {/* Model emits `--model <id>` at spawn (blank = engine default). Skills is a SUBSET filter: pick the
          skills a session under this rig may see; pick NONE to deliver ALL (the default). Pinned on the
          session row at spawn so resume/fork/recycle honor the same subset. */}
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={fieldLabel}>Model</span>
        <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="engine default (e.g. claude-opus-4-8)" />
      </label>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={fieldLabel}>Skills <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0, color: color.textMuted }}>· {skills.length === 0 ? "none selected → ALL skills delivered (default)" : `${skills.length} selected → only these delivered`}</span></span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {available.map((n) => {
            const on = skills.includes(n);
            return (
              <button key={n} type="button" onClick={() => toggleSkill(n)}
                style={{ cursor: "pointer", fontFamily: font.mono, fontSize: 12, padding: "3px 9px", borderRadius: 12,
                  border: `1px solid ${on ? color.phosphor : color.border}`, background: on ? color.panel2 : "transparent",
                  color: on ? color.phosphor : color.textMuted }}>
                {on ? "✓ " : ""}{n}
              </button>
            );
          })}
          {available.length === 0 && <span style={{ color: color.textMuted, fontSize: 12, fontFamily: font.mono }}>No skills in the store yet.</span>}
        </div>
        {skills.length > 0 && <button type="button" onClick={() => setSkills([])} style={{ alignSelf: "flex-start", cursor: "pointer", fontFamily: font.mono, fontSize: 11, padding: "2px 8px", borderRadius: 10, border: `1px solid ${color.border}`, background: "transparent", color: color.textMuted }}>clear → deliver all</button>}
        {/* A subset name no longer in the store (e.g. a deleted skill) — surfaced so it can be cleared. */}
        {skills.filter((n) => !available.includes(n)).length > 0 && (
          <span style={{ color: color.amber, fontSize: 11, fontFamily: font.mono }}>
            not in store (will be ignored at spawn): {skills.filter((n) => !available.includes(n)).join(", ")}
          </span>
        )}
      </div>
      <span style={{ color: color.textMuted, fontSize: 11, fontFamily: font.mono, marginTop: -6 }}>Model + skills apply on the next spawn. Skills delivery is per-session — sessions sharing a repo see the union of their subsets, never each other stripped.</span>

      {/* Authenticated-egress connection grant (agent-tooling epic P2): which P1 credential-store
          connections a session under this rig may call the authenticated_request tool with. Human-set
          HERE ONLY — stricter than every other flag on this page: not even the Setup Assistant / Platform
          Lead's own profile-writing tools may touch this field (it grants access to real external secrets). */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={fieldLabel}>Connections <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0, color: color.textMuted }}>· {connections.length === 0 ? "none selected → NO authenticated_request access (default)" : `${connections.length} selected → authenticated_request may use only these`}</span></span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {availableConnections.map((c) => {
            const on = connections.includes(c.id);
            return (
              <button key={c.id} type="button" onClick={() => toggleConnection(c.id)}
                style={{ cursor: "pointer", fontFamily: font.mono, fontSize: 12, padding: "3px 9px", borderRadius: 12,
                  border: `1px solid ${on ? color.phosphor : color.border}`, background: on ? color.panel2 : "transparent",
                  color: on ? color.phosphor : color.textMuted }}>
                {on ? "✓ " : ""}{c.name} <span style={{ opacity: 0.7 }}>({c.host})</span>
              </button>
            );
          })}
          {availableConnections.length === 0 && <span style={{ color: color.textMuted, fontSize: 12, fontFamily: font.mono }}>No connections in the credential store yet — add one in Settings.</span>}
        </div>
        {connections.filter((id) => !availableConnections.some((c) => c.id === id)).length > 0 && (
          <span style={{ color: color.amber, fontSize: 11, fontFamily: font.mono }}>
            not in the credential store (will be ignored at spawn): {connections.filter((id) => !availableConnections.some((c) => c.id === id)).join(", ")}
          </span>
        )}
      </div>

      <span style={{ flex: 1 }} />
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Button variant="primary" disabled={!dirty || !name.trim() || saving}
          onClick={() => onSave({ name: name.trim(), role: role || null, description, allowDelta, icon: icon.trim() || null, model: model.trim() || null, browserTesting, documentConversion, dejaCorpus, openDesign, restrictedTools, noCommit, skills: skills.length ? skills : null, connections, capabilities })}>
          {saving ? "Saving…" : "Save"}
        </Button>
        {dirty
          ? <Button onClick={reset}>Reset</Button>
          : <span style={{ color: color.phosphor, fontSize: 12, fontFamily: font.mono }}>saved</span>}
        <span style={{ flex: 1 }} />
        {bundled && (confirmRevert ? (
          <>
            <span style={{ color: color.amber, fontSize: 12, fontFamily: font.mono }}>discard edits & restore shipped?</span>
            <Button variant="danger" disabled={reverting} onClick={onRevert}>Revert</Button>
            <Button onClick={() => setConfirmRevert(false)}>Cancel</Button>
          </>
        ) : <Button onClick={() => setConfirmRevert(true)} title="Discard edits and restore this profile to its shipped (bundled) fields">Revert to bundled</Button>)}
      </div>

      {resolver && !resolver.clean && (
        <ConflictResolver name={profile.name} conflicts={resolver.conflicts} applying={adopting} error={adoptError}
          onApply={(resolutions) => onAdopt(resolutions)} onCancel={() => setResolver(null)} />
      )}
    </div>
  );
}

// "Update available" banner: the adopt button + a collapsible base→shipped FIELD diff so the user previews
// the incoming change before adopting. Amber hairline, not a filled block — restrained signal of state.
function UpdateBanner({ id, onAdopt, adoptBusy, error }: { id: string; onAdopt: () => void; adoptBusy: boolean; error: Error | null }) {
  const [showDiff, setShowDiff] = useState(false);
  const diff = useQuery({
    queryKey: ["profile", id, "update-diff"],
    queryFn: () => api.profileUpdateDiff(id),
    enabled: showDiff,
  });
  return (
    <div style={{ border: `1px solid ${color.amber}`, borderRadius: radius.base, padding: "8px 10px",
      background: color.panel2, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ color: color.amber, fontFamily: font.mono, fontSize: 12 }}>
          Loom shipped an update to this profile.
        </span>
        <span style={{ flex: 1 }} />
        <Button onClick={() => setShowDiff((v) => !v)}>{showDiff ? "Hide changes" : "What changed"}</Button>
        <Button variant="primary" disabled={adoptBusy} onClick={onAdopt} title="Merge the shipped update onto your edits">
          {adoptBusy ? "Adopting…" : "Adopt update"}
        </Button>
      </div>
      {error && <span style={{ color: color.red, fontFamily: font.mono, fontSize: 11 }}>{error.message}</span>}
      {showDiff && (
        diff.isLoading ? <span style={{ color: color.textMuted, fontSize: 12 }}>Loading diff…</span>
        : diff.data ? <FieldDiff changed={diff.data.changed} />
        : <span style={{ color: color.red, fontSize: 12 }}>Couldn't load the diff.</span>
      )}
    </div>
  );
}

// "What shipped changed": a field-by-field old→new table (base → shipped). Each row names a field and
// shows the shipped def's old value (dim) → the new value (phosphor). Profiles are small + structured, so
// a compact grid reads better than a line diff.
function FieldDiff({ changed }: { changed: ProfileFieldMerge[] }) {
  if (changed.length === 0) {
    return <span style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 12 }}>No field changed.</span>;
  }
  return (
    <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto 1fr", gap: "6px 10px", alignItems: "start",
      background: color.panel, border: `1px solid ${color.border}`, borderRadius: radius.sm, padding: 8,
      fontFamily: font.mono, fontSize: 12, lineHeight: 1.5 }}>
      {changed.map((c) => (
        <div key={c.field} style={{ display: "contents" }}>
          <span style={{ color: color.textDim, textTransform: "uppercase", letterSpacing: "0.06em", fontSize: 11 }}>{fieldDisplayName(c.field)}</span>
          <span style={{ color: color.textMuted, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{formatFieldValue(c.field, c.base)}</span>
          <span style={{ color: color.textMuted }}>→</span>
          <span style={{ color: color.phosphor, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{formatFieldValue(c.field, c.shipped)}</span>
        </div>
      ))}
    </div>
  );
}

// Conflict resolver: a focused overlay. The field-level 3-way merge couldn't auto-apply because the user
// AND Loom both changed the same field away from base — so per conflict field they keep theirs or take the
// shipped value, wholesale. We POST the per-field resolutions map. (Much simpler than the skills per-hunk
// text resolver — a short list of fields, each a mine-vs-shipped pick.)
function ConflictResolver({
  name, conflicts, onApply, onCancel, applying, error,
}: { name: string; conflicts: ProfileFieldMerge[]; onApply: (resolutions: Record<string, ProfileFieldResolution>) => void; onCancel: () => void; applying: boolean; error: Error | null }) {
  // Default every field to "mine" — preserve the user's edits unless they explicitly take the shipped side.
  const [choices, setChoices] = useState<Record<string, ProfileFieldResolution>>(
    () => Object.fromEntries(conflicts.map((c) => [c.field, "mine" as ProfileFieldResolution])),
  );
  const n = conflicts.length;

  return (
    <div role="dialog" aria-label={`Resolve update conflicts for ${name}`}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "flex-start",
        justifyContent: "center", paddingTop: "8vh", zIndex: 1000 }}
      onClick={onCancel}>
      <Panel style={{ width: "min(920px, 92vw)", maxHeight: "84vh", display: "flex", flexDirection: "column", padding: 0 }}>
        <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 14px", borderBottom: `1px solid ${color.border}` }}>
            <strong style={{ fontFamily: font.head, textTransform: "uppercase", letterSpacing: "0.08em", color: color.text }}>Resolve update</strong>
            <Badge tone="cyan">{name}</Badge>
            <span style={{ color: color.textMuted, fontSize: 12 }}>
              {n} conflicting {n === 1 ? "field" : "fields"} — keep yours or take shipped
            </span>
            <span style={{ flex: 1 }} />
            <Button onClick={onCancel}>Cancel</Button>
          </div>

          <div style={{ overflow: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 14, minHeight: 0 }}>
            {conflicts.map((c) => {
              const choice = choices[c.field] ?? "mine";
              return (
                <div key={c.field} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textDim, textTransform: "uppercase", letterSpacing: "0.06em" }}>{fieldDisplayName(c.field)}</span>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <FieldSide label="Your version" tone="cyan" active={choice === "mine"} value={formatFieldValue(c.field, c.mine)}
                      onPick={() => setChoices((m) => ({ ...m, [c.field]: "mine" }))} />
                    <FieldSide label="Shipped version" tone="amber" active={choice === "shipped"} value={formatFieldValue(c.field, c.shipped)}
                      onPick={() => setChoices((m) => ({ ...m, [c.field]: "shipped" }))} />
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ borderTop: `1px solid ${color.border}`, padding: "10px 14px", display: "flex", alignItems: "center", gap: 8 }}>
            {error && <span style={{ color: color.red, fontFamily: font.mono, fontSize: 11 }}>{error.message}</span>}
            <span style={{ flex: 1 }} />
            <Button variant="primary" disabled={applying} onClick={() => onApply(choices)}>
              {applying ? "Adopting…" : "Adopt resolved"}
            </Button>
          </div>
        </div>
      </Panel>
    </div>
  );
}

// One side of a conflict field — clickable to select. The active side gets a phosphor border; the other
// reads dim, so the chosen resolution is obvious at a glance. Mirrors Skills.tsx HunkSide (value, not lines).
function FieldSide({ label, tone: t, active, value, onPick }: { label: string; tone: Tone; active: boolean; value: string; onPick: () => void }) {
  const accent = t === "cyan" ? color.cyan : color.amber;
  return (
    <button onClick={onPick} title={`Keep this version (${label})`}
      style={{ textAlign: "left", cursor: "pointer", borderRadius: radius.sm, padding: 8,
        background: active ? color.panel : color.panel2,
        border: `1px solid ${active ? color.phosphor : color.border}`,
        boxShadow: active ? `inset 0 0 0 1px ${color.phosphorDim}` : undefined }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <span style={{ width: 7, height: 7, borderRadius: 7, background: accent, display: "inline-block" }} />
        <span style={{ fontFamily: font.mono, fontSize: 11, color: active ? color.phosphor : color.textDim, textTransform: "uppercase", letterSpacing: "0.06em" }}>
          {label}{active ? " ✓" : ""}
        </span>
      </div>
      <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: font.mono, fontSize: 12,
        lineHeight: 1.5, color: active ? color.text : color.textMuted }}>
        {value}
      </pre>
    </button>
  );
}

// --- field formatting helpers (pure) ------------------------------------------------------------

// Human label for a mergeable profile field (keys mirror the daemon's MERGEABLE_PROFILE_FIELDS).
const FIELD_DISPLAY: Record<string, string> = {
  role: "Role", description: "Description", allowDelta: "Allow delta", skills: "Skills",
  model: "Model", icon: "Icon", browserTesting: "Browser testing", documentConversion: "Document conversion",
  dejaCorpus: "Deja mockup corpus", openDesign: "Open Design",
  restrictedTools: "Restricted tools", noCommit: "No-commit role", connections: "Connections",
  capabilities: "Capabilities",
};
function fieldDisplayName(field: string): string {
  return FIELD_DISPLAY[field] ?? field;
}

// Render a field's value (typed `unknown` over the wire) as readable text — empties/nulls become the same
// human phrasing the editor uses (e.g. skills null = all, model null = engine default).
function formatFieldValue(field: string, value: unknown): string {
  if (value === null || value === undefined) {
    if (field === "skills") return "(all skills)";
    if (field === "role") return "plain";
    if (field === "model") return "engine default";
    return "(none)";
  }
  if (Array.isArray(value)) return value.length ? value.join("\n") : (field === "skills" ? "(none → all skills)" : "(empty)");
  if (typeof value === "boolean") return value ? "on" : "off";
  if (value === "") return "(empty)";
  return String(value);
}
