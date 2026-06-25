import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Profile, ProfileSummary, ProfileMergeResult, ProfileFieldMerge, SessionRole } from "@loom/shared";
import { api, type ProfileFieldResolution } from "../lib/api";
import { Panel, Button, Input, Select, SectionLabel, Badge } from "../components/ui";
import { color, font, radius, tone, type Tone } from "../theme";

// A profile's role, as a coloured pill. null = a plain (non-orchestration) session — today's default.
const roleTone: Record<NonNullable<SessionRole>, Tone> = { manager: "phosphor", worker: "cyan", platform: "amber", auditor: "muted", setup: "cyan", "workspace-auditor": "muted", run: "muted" };
function RoleBadge({ role }: { role: SessionRole | null }) {
  return <Badge tone={role ? roleTone[role] : "muted"}>{role ?? "plain"}</Badge>;
}

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
          {profiles.data?.map((p) => (
            <Button key={p.id} variant={p.id === selected ? "primary" : "default"} style={{ textAlign: "left", display: "flex", alignItems: "center", gap: 8 }}
              onClick={() => setSelected(p.id)} title={p.description || p.name}>
              {p.icon && <span>{p.icon}</span>}
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
              <StatusDots customized={!!p.customized} updateAvailable={!!p.updateAvailable} />
              <span style={{ fontSize: 10, color: p.role ? tone[roleTone[p.role]] : color.textMuted, fontFamily: font.mono }}>{p.role ?? "plain"}</span>
            </Button>
          ))}
          {profiles.data?.length === 0 && <span style={{ color: color.textMuted, fontSize: 12 }}>No profiles yet.</span>}
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
  // Skill subset (empty = deliver ALL, the default — null and [] are equivalent, matching the daemon).
  const [skills, setSkills] = useState<string[]>(profile.skills ?? []);
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
    sortedJson(skills) !== sortedJson(profile.skills ?? []);

  const fieldLabel = { fontFamily: font.head as string, fontSize: 11, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.08em", color: color.textDim };
  const ta = {
    width: "100%", boxSizing: "border-box" as const, resize: "vertical" as const, fontFamily: font.mono, fontSize: 13, lineHeight: 1.5,
    background: color.panel2, color: color.text, border: `1px solid ${color.border}`, borderRadius: 6, padding: 8,
  };

  const reset = () => { setName(profile.name); setRole(profile.role ?? ""); setDescription(profile.description); setAllowText(profile.allowDelta.join("\n")); setIcon(profile.icon ?? ""); setModel(profile.model ?? ""); setBrowserTesting(profile.browserTesting ?? false); setDocumentConversion(profile.documentConversion ?? false); setSkills(profile.skills ?? []); };

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

      <div style={{ display: "grid", gridTemplateColumns: "1fr 160px 90px", gap: 10 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={fieldLabel}>Name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={fieldLabel}>Role</span>
          <Select value={role} onChange={(e) => setRole(e.target.value as SessionRole | "")}>
            <option value="">— (plain)</option>
            <option value="manager">manager</option>
            <option value="worker">worker</option>
            <option value="platform">platform</option>
          </Select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={fieldLabel}>Icon</span>
          <Input value={icon} onChange={(e) => setIcon(e.target.value)} placeholder="emoji" />
        </label>
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

      {/* Opt-in browser-automation: a session under this rig spawns with its own per-session headless
          Playwright MCP. A navigate-anywhere capability — human-set here only, never via an agent tool. */}
      <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
        <input type="checkbox" checked={browserTesting} onChange={(e) => setBrowserTesting(e.target.checked)} style={{ marginTop: 2 }} />
        <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={fieldLabel}>Browser testing</span>
          <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0, color: color.textMuted, fontSize: 11, fontFamily: font.mono, lineHeight: 1.5 }}>
            Inject a per-session Playwright MCP so this rig can drive its own isolated headless browser
            (navigate / click / fill / assert). Gated — adds ~20-30 tools per turn and a navigate-anywhere
            capability, so leave off unless this rig does end-to-end UI testing.
          </span>
        </span>
      </label>

      {/* Opt-in document-conversion: a session under this rig spawns with its own per-session markitdown
          MCP. Launches a host process — human-set here only, never via an agent tool. */}
      <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
        <input type="checkbox" checked={documentConversion} onChange={(e) => setDocumentConversion(e.target.checked)} style={{ marginTop: 2 }} />
        <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={fieldLabel}>Document conversion</span>
          <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0, color: color.textMuted, fontSize: 11, fontFamily: font.mono, lineHeight: 1.5 }}>
            Inject a per-session markitdown MCP so this rig can convert files (PDF / Office / images / HTML)
            to Markdown to save tokens. Gated — needs a base Python (≥3.10) on the host; Loom provisions its
            own venv on first use. Audio conversion needs ffmpeg on PATH; document formats (PDF / Office /
            images / HTML) don't. Leave off unless this rig works with documents.
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

      <span style={{ flex: 1 }} />
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Button variant="primary" disabled={!dirty || !name.trim() || saving}
          onClick={() => onSave({ name: name.trim(), role: role || null, description, allowDelta, icon: icon.trim() || null, model: model.trim() || null, browserTesting, documentConversion, skills: skills.length ? skills : null })}>
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
