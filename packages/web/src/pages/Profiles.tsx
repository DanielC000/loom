import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Profile, SessionRole } from "@loom/shared";
import { api } from "../lib/api";
import { Panel, Button, Input, Select, SectionLabel, Badge } from "../components/ui";
import { color, font, tone, type Tone } from "../theme";

// Mirror of the daemon's BUNDLED_PROFILES names (profiles/seed.ts). The list endpoint returns full
// Profile rows with no `bundled` flag, so the UI keys "Revert to bundled" off the shipped names —
// the reset endpoint also matches by name server-side (a renamed bundled profile is no longer
// matchable, the documented limitation shared with the skill reset).
const BUNDLED_PROFILE_NAMES = new Set([
  "Orchestrator", "Planning & Triage", "Dev", "Bugfix", "QA Tester", "Web Designer", "Content Strategy", "Setup Assistant", "Platform-lead",
]);

// A profile's role, as a coloured pill. null = a plain (non-orchestration) session — today's default.
const roleTone: Record<NonNullable<SessionRole>, Tone> = { manager: "phosphor", worker: "cyan", platform: "amber", auditor: "muted", setup: "cyan", run: "muted" };
function RoleBadge({ role }: { role: SessionRole | null }) {
  return <Badge tone={role ? roleTone[role] : "muted"}>{role ?? "plain"}</Badge>;
}

// Loom's Profiles — the reusable, platform-level rig (role + model + permission deltas + icon) an
// agent runs under via its profileId. The injected prompt comes from the AGENT; a profile's
// `description` is a UI-only blurb. HUMAN-managed only (profiles confer role + privilege), so there
// is no agent MCP surface — just this page + REST. Edits apply on the next spawn.
export default function Profiles() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [reloadNonce, setReloadNonce] = useState(0); // bumped on revert to remount the editor onto bundled content

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
      qc.setQueryData(["profile", p.id], p);
      qc.invalidateQueries({ queryKey: ["profiles"] });
      qc.invalidateQueries({ queryKey: ["profile", p.id] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteProfile(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["profiles"] }); setSelected(null); },
  });
  const revert = useMutation({
    mutationFn: (id: string) => api.resetProfile(id),
    onSuccess: (p) => {
      qc.setQueryData(["profile", p.id], p); // sync editor to bundled fields (no refetch race)
      qc.invalidateQueries({ queryKey: ["profiles"] });
      setReloadNonce((n) => n + 1); // remount the editor onto the restored content
    },
  });

  const validNew = newName.trim().length > 0 && !profiles.data?.some((p) => p.name === newName.trim());
  const bundled = current.data ? BUNDLED_PROFILE_NAMES.has(current.data.name) : false;

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
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</span>
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
          <ProfileEditor key={`${selected}:${reloadNonce}`} profile={current.data} bundled={bundled}
            onSave={(patch) => save.mutate({ id: selected, patch })} saving={save.isPending}
            onDelete={() => remove.mutate(selected)} deleting={remove.isPending}
            onRevert={() => revert.mutate(selected)} reverting={revert.isPending} />
        ) : <p style={{ color: color.textMuted, padding: 12 }}>Select a profile to edit it, or create a new one.</p>}
      </Panel>
    </div>
  );
}

// Remounted per profile (key=id) so the fields reset on switch; after Save the query updates and
// `dirty` clears against the new values. Mirrors the Skills / agent-preset editors.
function ProfileEditor({ profile, bundled, onSave, saving, onDelete, deleting, onRevert, reverting }:
  { profile: Profile; bundled: boolean; onSave: (patch: Partial<Omit<Profile, "id">>) => void; saving: boolean;
    onDelete: () => void; deleting: boolean; onRevert: () => void; reverting: boolean }) {
  const [name, setName] = useState(profile.name);
  const [role, setRole] = useState<SessionRole | "">(profile.role ?? "");
  const [description, setDescription] = useState(profile.description);
  const [allowText, setAllowText] = useState(profile.allowDelta.join("\n"));
  const [icon, setIcon] = useState(profile.icon ?? "");
  const [model, setModel] = useState(profile.model ?? "");
  const [browserTesting, setBrowserTesting] = useState(profile.browserTesting ?? false);
  // Skill subset (empty = deliver ALL, the default — null and [] are equivalent, matching the daemon).
  const [skills, setSkills] = useState<string[]>(profile.skills ?? []);
  const [confirmDel, setConfirmDel] = useState(false);
  const [confirmRevert, setConfirmRevert] = useState(false);

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
    sortedJson(skills) !== sortedJson(profile.skills ?? []);

  const fieldLabel = { fontFamily: font.head as string, fontSize: 11, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.08em", color: color.textDim };
  const ta = {
    width: "100%", boxSizing: "border-box" as const, resize: "vertical" as const, fontFamily: font.mono, fontSize: 13, lineHeight: 1.5,
    background: color.panel2, color: color.text, border: `1px solid ${color.border}`, borderRadius: 6, padding: 8,
  };

  const reset = () => { setName(profile.name); setRole(profile.role ?? ""); setDescription(profile.description); setAllowText(profile.allowDelta.join("\n")); setIcon(profile.icon ?? ""); setModel(profile.model ?? ""); setBrowserTesting(profile.browserTesting ?? false); setSkills(profile.skills ?? []); };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <strong style={{ fontFamily: font.head, textTransform: "uppercase", letterSpacing: "0.08em", color: color.text }}>{profile.name}</strong>
        <RoleBadge role={role || null} />
        {bundled && <Badge tone="cyan">bundled</Badge>}
        <span style={{ flex: 1 }} />
        {confirmDel ? (
          <>
            <span style={{ color: color.red, fontSize: 12, fontFamily: font.mono }}>delete {profile.name}?</span>
            <Button variant="danger" disabled={deleting} onClick={onDelete}>Confirm</Button>
            <Button onClick={() => setConfirmDel(false)}>Cancel</Button>
          </>
        ) : <Button variant="danger" onClick={() => setConfirmDel(true)}>Delete</Button>}
      </div>

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
          onClick={() => onSave({ name: name.trim(), role: role || null, description, allowDelta, icon: icon.trim() || null, model: model.trim() || null, browserTesting, skills: skills.length ? skills : null })}>
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
    </div>
  );
}
