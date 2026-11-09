import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Profile, ProfileSummary, ProfileMergeResult, ProfileFieldMerge, ProfileGrantReach, SessionRole, CodexProvider } from "@loom/shared";
import { CodexProviderField } from "../components/CodexProviderField";
import type { CapabilitySummary } from "@loom/shared";
import { api, type ProfileFieldResolution } from "../lib/api";
import {
  PROVISION_STATE_META, capabilityNeedsNetwork, capabilityReportsProvisioning, provisionReasonText,
  provisioningSourceOf, type CapabilityProvisioning as CapabilityProvisioningStatus,
} from "../lib/capabilityProvisioning";
import { Panel, Button, Input, Select, SectionLabel, Badge } from "../components/ui";
import { color, font, radius, tone, toneFill, type Tone, fs } from "../theme";
import { agentProfiles } from "../lib/profileRoles";
import { RolePicker } from "../components/RolePicker";
import { HarnessPicker, HarnessDropSummary, HarnessFieldDrop, HarnessRejectWarning, HarnessTag, dropStyle } from "../components/HarnessPicker";
import { CODEX_REJECTED_FIELDS, HARNESS_FIELD_LABELS, clearCodexRejectedFields, harnessOf, type Harness } from "../lib/harnessFields";
import { RoleBadge, roleDisplay, roleColor } from "../lib/roleDisplay";
import { changedFields, type FieldComparers } from "../lib/formSync";
import { useFormSync } from "../lib/useFormSync";
import { errorText } from "../lib/loopbackCredential";
import {
  grantFieldsOfProfile, grantFieldsOfValues, grantKeyList, parseAllowDelta, planGrantSave,
  GRANT_REACH_CHECKING, type GrantSavePlan,
} from "../lib/profileGrantReach";
import { GrantReachConfirm } from "../components/GrantReachConfirm";
import { useAllAgents } from "../lib/useAllAgents";

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
  // Deep-link: /actors?tab=profiles&profile=<id> opens that profile's editor. (The `grant=<connectionId>`
  // pre-selection the pending-bindings queue used is RETIRED with the profile-level connections — card
  // afe1bc90: a pending binding now targets the requesting AGENT's editor instead.)
  const [params] = useSearchParams();
  const profileParam = params.get("profile");
  const [selected, setSelected] = useState<string | null>(profileParam);
  // Apply the deep-link when it changes (mount, or a new "Review & grant" while already on this page).
  // Keyed on the param only — a manual sidebar click doesn't touch the URL, so it's never overridden.
  useEffect(() => { if (profileParam) setSelected(profileParam); }, [profileParam]);
  const [newName, setNewName] = useState("");
  const [reloadNonce, setReloadNonce] = useState(0); // bumped on revert/adopt to remount the editor onto fresh fields
  // Card 8fd36112: a delete that widens reach (the dangling-profileId backstop un-restricts/re-roles every
  // still-bound agent) has no editor to confirm it IN — the row is gone by the time the response lands. So
  // this shows AFTER, not before; it lives here (not inside ProfileEditor) because the editor unmounts the
  // instant the delete succeeds (`selected` goes null), and the notice needs to outlive that unmount.
  const [deleteReach, setDeleteReach] = useState<{ name: string; reach: ProfileGrantReach } | null>(null);

  const profiles = useQuery({ queryKey: ["profiles"], queryFn: ({ signal }) => api.profiles(signal) });
  const current = useQuery({ queryKey: ["profile", selected], queryFn: ({ signal }) => api.profile(selected!, signal), enabled: !!selected });

  const create = useMutation({
    mutationFn: (name: string) =>
      api.createProfile({ name, role: null, description: "", allowDelta: [], skills: null, model: null, icon: null }),
    onSuccess: (p) => { qc.invalidateQueries({ queryKey: ["profiles"] }); setSelected(p.id); setNewName(""); },
  });
  const save = useMutation({
    meta: { inlineError: true },
    mutationFn: (v: { id: string; patch: Partial<Omit<Profile, "id">> }) => api.updateProfile(v.id, v.patch),
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: ["profiles"] });
      qc.invalidateQueries({ queryKey: ["profile", p.id] }); // refetch the SUMMARY (PUT returns the bare row, no computed state)
    },
  });
  const remove = useMutation({
    mutationFn: (v: { id: string; name: string }) => api.deleteProfile(v.id),
    onSuccess: (res, v) => {
      qc.invalidateQueries({ queryKey: ["profiles"] });
      setSelected(null);
      setDeleteReach(res.grantReach ? { name: v.name, reach: res.grantReach } : null);
    },
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
    meta: { inlineError: true },
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
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {deleteReach && (
        <DeleteGrantReachNotice name={deleteReach.name} reach={deleteReach.reach} onDismiss={() => setDeleteReach(null)} />
      )}
      {/* The list→editor shell, shared with Skills (the Actors page's other body). Both tracks and the
          phone fold live in `.loom-actor-split` (styles/global.css) — an inline `300px 1fr` here
          overflowed the page by 340px at 390px. */}
      <div className="loom-actor-split">
        <Panel style={{ alignSelf: "start" }}>
          <SectionLabel>Profiles</SectionLabel>
          <p style={{ color: color.text3, fontSize: fs.sm, margin: "0 0 10px", lineHeight: 1.5 }}>
            Reusable, cross-project rig — role, model, permission deltas, skill subset, icon, plus a
            description blurb. An agent runs under one to drive how its sessions spawn; the injected
            prompt comes from the agent. Human-managed only; edits apply on the next spawn.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {/* The companion's assistant-role rig is HIDDEN here — companion config lives entirely under
                Companion → Manage now, so it never shows among the agent rigs. */}
            {agentProfiles(profiles.data ?? []).map((p) => (
              // A selected row is a SELECTION, not a call to action: the kit's `loom-btn-on` (neutral selected
              // fill + ink edge), never the primary fill, which inverted the row and left the role label's
              // muted grey at ~2:1 (audit A-09). Same treatment as the Skills list.
              <Button key={p.id} className={p.id === selected ? "loom-btn-on" : undefined} aria-pressed={p.id === selected}
                style={{ textAlign: "left", display: "flex", alignItems: "center", gap: 8 }}
                onClick={() => setSelected(p.id)} title={p.description || p.name}>
                {/* A fixed icon slot, empty when the profile has none, so every name starts at the same x (A-16). */}
                <span aria-hidden="true" style={{ flex: "0 0 18px", width: 18, display: "inline-flex", justifyContent: "center", lineHeight: 1 }}>{p.icon}</span>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
                {/* A rig that spawns a DIFFERENT vendor binary should be identifiable without opening it
                    (card fa2277b6 item 5). Only codex is marked — claude is the default, so badging every
                    row would be noise, not signal. */}
                <HarnessTag harness={harnessOf(p.harness)} title={`${p.name} spawns the codex CLI, not claude`} />
                <StatusDots customized={!!p.customized} updateAvailable={!!p.updateAvailable} />
                <span style={{ fontSize: fs.sm, color: roleColor(p.role) }}>{roleDisplay(p.role).short}</span>
              </Button>
            ))}
            {agentProfiles(profiles.data ?? []).length === 0 && <span style={{ color: color.text3, fontSize: fs.sm }}>No profiles yet.</span>}
          </div>
          <div style={{ marginTop: 12, display: "flex", gap: 6 }}>
            <Input placeholder="new profile name" value={newName} onChange={(e) => setNewName(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
            <Button variant="primary" disabled={!validNew || create.isPending} onClick={() => create.mutate(newName.trim())}>+ New</Button>
          </div>
        </Panel>

        <Panel style={{ minHeight: "72vh", padding: 12 }}>
          {selected && current.data ? (
            <ProfileEditor key={`${selected}:${reloadNonce}`} profile={current.data}
              onSave={(patch) => save.mutate({ id: selected, patch })} saving={save.isPending}
              saveError={save.error as Error | null}
              onDelete={() => remove.mutate({ id: selected, name: current.data!.name })} deleting={remove.isPending}
              onRevert={() => revert.mutate(selected)} reverting={revert.isPending}
              onAdopt={(resolutions) => adopt.mutate(resolutions)} adopting={adopt.isPending} adoptError={adopt.error as Error | null} />
          ) : <p style={{ color: color.text3, padding: 12 }}>Select a profile to edit it, or create a new one.</p>}
        </Panel>
      </div>
    </div>
  );
}

// Card 8fd36112: a profile delete that widened reach (the dangling-profileId backstop un-restricting /
// re-roling every still-bound agent) has no pre-delete confirm — the row is already gone by the time the
// response lands. This is the AFTER-the-fact equivalent of GrantReachConfirm: same restrained, amber
// hairline language, past tense, and a dismiss instead of the two forward-looking choices.
function DeleteGrantReachNotice({ name, reach, onDismiss }: { name: string; reach: ProfileGrantReach; onDismiss: () => void }) {
  return (
    <Panel data-testid="delete-grant-reach-notice" role="alert"
      style={{ boxShadow: `inset 0 0 0 1px ${color.attn}`, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Badge tone="attn">grant</Badge>
        <strong style={{ fontFamily: font.ui, fontSize: fs.sm, color: color.text }}>
          Deleting {name} widened what agents can do
        </strong>
        <span style={{ flex: 1 }} />
        <Button onClick={onDismiss}>Dismiss</Button>
      </div>
      <p style={{ margin: 0, fontSize: fs.sm, lineHeight: 1.6, color: color.text }}>
        The deleted profile granted <strong style={{ color: color.attnText }}>{grantKeyList(reach.addedKeys)}</strong>.
        {" "}Agents bound to it now fall back to the plain default, so{" "}
        <strong style={{ color: color.attnText }} data-testid="delete-grant-reach-count">
          {reach.agentCount} agent{reach.agentCount === 1 ? "" : "s"}
        </strong>{" "}
        {reach.agentCount === 1 ? "picks" : "pick"} this up on their next session.
      </p>
      {reach.roleChange && (
        <p data-testid="delete-grant-reach-role-change" style={{ margin: 0, fontSize: fs.sm, lineHeight: 1.6, color: color.text }}>
          Role changes from <strong style={{ color: color.attnText }}>{reach.roleChange.from ?? "none"}</strong>
          {" "}to <strong style={{ color: color.attnText }}>{reach.roleChange.to ?? "none"}</strong>.
        </p>
      )}
      {reach.agentCount > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <SectionLabel>Affected</SectionLabel>
          <ul data-testid="delete-grant-reach-agents"
            style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 2 }}>
            {reach.agents.map((a) => (
              <li key={a.id} style={{ fontSize: fs.sm, color: color.text }}>
                <span style={{ color: color.text2 }}>{a.projectName}</span>
                <span style={{ color: color.text3 }}> / </span>
                {a.name}
              </li>
            ))}
          </ul>
          {reach.truncated && (
            <span style={{ fontSize: fs.sm, color: color.text3 }}>+more (truncated)</span>
          )}
        </div>
      )}
    </Panel>
  );
}

// Compact sidebar status: a muted dot for "customized", an attn dot for "update available". Restrained —
// the full-text badges live in the editor header; here it's a glanceable signal with a hover title.
// Mirrors Skills.tsx StatusDots.
function StatusDots({ customized, updateAvailable }: { customized: boolean; updateAvailable: boolean }) {
  if (!customized && !updateAvailable) return null;
  return (
    <span style={{ display: "inline-flex", gap: 4, flexShrink: 0 }}>
      {customized && <Dot tone="muted" title="Customized — you edited this profile" />}
      {updateAvailable && <Dot tone="attn" title="Update available — Loom shipped a newer version" />}
    </span>
  );
}
function Dot({ tone: t, title }: { tone: Tone; title: string }) {
  return <span title={title} style={{ width: 7, height: 7, borderRadius: radius.base, background: toneFill[t], display: "inline-block" }} />;
}

// Per-capability provisioning status — ONE widget for every granted capability that reports one (card
// cd9a78bc, generalising what was a single hardcoded markitdown row). The status is CAPABILITY-wide, not
// per-profile: one Loom-managed venv / downloaded binary / pinned npm install backs every rig that grants
// the slug, so this reads the shared state and never implies per-profile health.
//
// It exists because the failure is otherwise SILENT: a session mounts without the MCP when provisioning is
// still running or has failed, and the checkbox beside it still reads ON. WHICH ENDPOINT it reads is
// `provisioningSourceOf`'s call, never this component's — a capability with no status is never rendered.
// Polls only while `installing`; the hairline tints toward the state only when it wants attention.
function CapabilityProvisioningRow({ capability }: { capability: CapabilitySummary }) {
  const { slug, name, kind } = capability;
  const source = provisioningSourceOf(capability);
  const qc = useQueryClient();
  const [showTail, setShowTail] = useState(false);
  // One query key per source so the two readers never share a cache entry: the global python status is
  // daemon-wide, a per-slug one is not, and keying both as ["pythonProvisioning"] would cross them.
  const queryKey = source === "global-python" ? ["pythonProvisioning"] : ["capabilityProvisioning", slug];
  const q = useQuery({
    queryKey,
    queryFn: ({ signal }) => (source === "global-python" ? api.pythonProvisioning(signal) : api.capabilityProvisioning(slug, signal)),
    refetchInterval: (query) => (query.state.data?.state === "installing" ? 2000 : false),
  });
  const retry = useMutation({
    meta: { inlineError: true },
    mutationFn: () => (source === "global-python" ? api.retryPythonProvisioning() : api.retryCapabilityProvisioning(slug)),
    onSuccess: (s: CapabilityProvisioningStatus) => { qc.setQueryData(queryKey, s); qc.invalidateQueries({ queryKey }); },
  });

  const s = q.data;
  const state = s?.state;
  const meta = state ? PROVISION_STATE_META[state] : null;
  const accent = meta ? tone[meta.tone] : color.line;
  // The hairline tints toward the state ONLY when it wants attention (installing / failed); ready + idle
  // stay neutral so the row reads as ambient status, not an alert.
  const borderColor = state === "failed" || state === "installing" ? accent : color.line;
  const reasonText = provisionReasonText(s?.reason, kind);
  const labelStyle = { fontSize: fs.sm, color: color.text3, lineHeight: 1.5 };

  return (
    <div data-testid={`capability-provisioning-${slug}`} style={{ border: `1px solid ${borderColor}`, borderRadius: radius.base,
      padding: "8px 10px", background: color.inset, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontFamily: font.ui, fontSize: fs.sm, fontWeight: 700, color: color.text2 }}>
          {name}
        </span>
        {q.isLoading && !s ? (
          <span style={labelStyle}>checking…</span>
        ) : q.isError && !s ? (
          <span style={{ ...labelStyle, color: color.danger }}>couldn't read status</span>
        ) : meta ? (
          <span data-testid={`provisioning-state-${slug}`} style={{ display: "inline-flex", alignItems: "center", gap: 6,
            fontSize: fs.sm, color: accent }}>
            <span aria-hidden style={{ width: 8, height: 8, borderRadius: radius.base, background: accent, display: "inline-block",
              ...(state === "installing" ? { boxShadow: `0 0 6px ${accent}` } : null) }} />
            {meta.label}
            {state === "failed" && reasonText && (
              <span style={{ color: color.text3 }}>— {reasonText}</span>
            )}
          </span>
        ) : null}
        <span style={{ flex: 1 }} />
        {s?.errorTail && (
          <Button onClick={() => setShowTail((v) => !v)}>{showTail ? "Hide details" : "Show details"}</Button>
        )}
        {state === "failed" && (
          <Button variant="primary" disabled={retry.isPending} onClick={() => retry.mutate()}
            title={`Re-run provisioning for ${name}`}>
            {retry.isPending ? "Retrying…" : "Retry install"}
          </Button>
        )}
      </div>

      {/* Ready: name the resolved binary so the user can confirm WHICH install is actually live. */}
      {state === "ready" && s?.binary && (
        <span style={{ ...labelStyle, fontFamily: font.mono, wordBreak: "break-all" }}>{s.binary}</span>
      )}
      {/* Idle: say it provisions lazily, so the state word doesn't read as something to act on. Kept to ONE
          short line because it repeats per granted capability — the long form was the least informative
          state saying the most, N times over. */}
      {state === "idle" && (
        <span style={labelStyle}>Provisioned on the first session that grants it. Nothing to do.</span>
      )}
      {retry.isError && <span style={{ ...labelStyle, color: color.danger }}>retry failed: {errorText(retry.error)}</span>}

      {/* The captured install/download output tail — the real proxy / SSL / resolver cause, on demand. */}
      {showTail && s?.errorTail && (
        <pre style={{ margin: 0, maxHeight: 220, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word",
          fontFamily: font.mono, fontSize: fs.mono, lineHeight: 1.5, color: color.text3,
          background: color.surface, border: `1px solid ${color.line}`, borderRadius: radius.sm, padding: 8 }}>
          {s.errorTail}
        </pre>
      )}
    </div>
  );
}

// ── Concurrent-write safety (card 65aa951c) ─────────────────────────────────────────────────────────
//
// Every field below is seeded from the profile row, and an AGENT can rewrite that row while the human has
// this editor open (the Platform Lead's and Setup operator's own profile tools both write it). Seeding
// once at mount and then PUTting every modelled field back reverts whatever landed in between — silently,
// since the PUT merges and then succeeds exactly as it would have anyway. `lib/formSync` owns both halves
// of the remedy: diff against the SEED this editor last synced from, send only what differs, and adopt a
// refetched value into any field the human never touched.
interface ProfileFields {
  name: string;
  role: SessionRole | "";
  description: string;
  allowText: string;
  icon: string;
  model: string;
  browserTesting: boolean;
  documentConversion: boolean;
  vaultWrite: boolean;
  restrictedTools: boolean;
  noCommit: boolean;
  harness: Harness;
  /** Card 2ef54430: the codex model-provider endpoint; `null` = codex's default. Only meaningful on codex. */
  codexProvider: CodexProvider | null;
  skills: string[];
}

/** The profile row projected into this editor's field shape — the ONE place the seed is derived. */
const profileFieldsOf = (p: ProfileSummary): ProfileFields => ({
  name: p.name,
  role: p.role ?? "",
  description: p.description,
  allowText: p.allowDelta.join("\n"),
  icon: p.icon ?? "",
  model: p.model ?? "",
  browserTesting: p.browserTesting ?? false,
  documentConversion: p.documentConversion ?? false,
  vaultWrite: p.vaultWrite ?? false,
  restrictedTools: p.restrictedTools ?? false,
  noCommit: p.noCommit ?? false,
  harness: harnessOf(p.harness),
  codexProvider: p.codexProvider ?? null,
  skills: p.skills ?? [],
});

// `parseAllowDelta` + the two grant-slice adapters (`grantFieldsOfValues` / `grantFieldsOfProfile`) live
// in lib/profileGrantReach.ts, imported above: this file is JSX, so a unit test cannot reach them here.
// Both adapters read their fields LIVE; the decision record for that rule is anchored there, not here.

const sortedJson = (xs: readonly string[]) => JSON.stringify([...xs].sort());

// Each comparer mirrors the NORMALIZATION `submit` applies to that field, so a difference the wire cannot
// express — a trailing newline, surrounding whitespace, a reordered multiselect — is neither reported as a
// human edit nor sent. Getting this wrong in the other direction is the stuck-dirty failure: a field whose
// local text normalizes to what was saved but does not match it byte-for-byte would stay dirty forever.
const PROFILE_FIELD_COMPARERS: FieldComparers<ProfileFields> = {
  name: (a, b) => a.trim() === b.trim(),
  allowText: (a, b) => JSON.stringify(parseAllowDelta(a)) === JSON.stringify(parseAllowDelta(b)),
  icon: (a, b) => a.trim() === b.trim(),
  model: (a, b) => a.trim() === b.trim(),
  skills: (a, b) => sortedJson(a) === sortedJson(b),
  // Normalizes exactly as `submit` does (empty optional strings ⇒ absent, trimmed URL), so an untouched
  // custom row never reads as a human edit.
  codexProvider: (a, b) => JSON.stringify(normCodexProvider(a)) === JSON.stringify(normCodexProvider(b)),
};

/** The wire spelling of the editor's provider value: empty optional strings dropped, URL trimmed, a blank id ⇒ none. */
const normCodexProvider = (p: CodexProvider | null): CodexProvider | null => {
  if (!p) return null;
  const id = p.id.trim();
  const baseUrl = p.baseUrl?.trim();
  const connectionId = p.connectionId?.trim();
  if (!id && !baseUrl && !connectionId) return null;
  return { id, ...(baseUrl ? { baseUrl } : {}), ...(connectionId ? { connectionId } : {}) };
};

// Remounted per profile (key=id:nonce) so the fields reset on switch / revert / adopt; after Save the
// query updates and `dirty` clears against the new values. Mirrors the Skills / agent-preset editors.
function ProfileEditor({ profile, onSave, saving, saveError, onDelete, deleting, onRevert, reverting, onAdopt, adopting, adoptError }:
  { profile: ProfileSummary; onSave: (patch: Partial<Omit<Profile, "id">>) => void; saving: boolean; saveError: Error | null;
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
  // Confined vault-write grant (card be8be211). HUMAN-only — on AGENT_FORBIDDEN_PROFILE_KEYS, so this
  // control and the loopback REST it drives are the ONLY way it can ever be set. Harness-agnostic:
  // `profiles/field-consumers.ts` proves the loom-tasks router reads it LIVE per request on BOTH
  // harnesses, so unlike the capability grants above there is nothing for codex to drop.
  const [vaultWrite, setVaultWrite] = useState(profile.vaultWrite ?? false);
  const [restrictedTools, setRestrictedTools] = useState(profile.restrictedTools ?? false);
  const [noCommit, setNoCommit] = useState(profile.noCommit ?? false);
  // Which vendor CLI this rig spawns (card fa2277b6). Absent on the row ⇒ "claude", so an untouched
  // profile never reads as having chosen a harness. HUMAN-only: `harness` sits on the daemon's
  // AGENT_FORBIDDEN_PROFILE_KEYS, so this editor and the loopback REST it drives are the ONLY grant path.
  const [harness, setHarness] = useState<Harness>(harnessOf(profile.harness));
  // The codex model-provider endpoint (card 2ef54430). HUMAN-only (AGENT_FORBIDDEN_PROFILE_KEYS); a spend surface.
  const [codexProvider, setCodexProvider] = useState<CodexProvider | null>(profile.codexProvider ?? null);
  // Skill subset (empty = deliver ALL, the default — null and [] are equivalent, matching the daemon).
  const [skills, setSkills] = useState<string[]>(profile.skills ?? []);
  // A pending save held back by the grant confirm (card 3c4e0df6): the already-built patch plus the plan
  // that explains WHY it is held. Held as ONE object so what the human is shown and what eventually goes
  // on the wire cannot drift apart — the confirm never rebuilds the patch.
  const [pendingGrant, setPendingGrant] = useState<
    { patch: Partial<Omit<Profile, "id">>; plan: Extract<GrantSavePlan, { kind: "confirm" } | { kind: "confirm-unknown" }> } | null
  >(null);
  // Card 586a0efe: a Save clicked while the cross-project agent list was still in flight. A bare flag,
  // deliberately NOT a captured patch like `pendingGrant` above — the two are opposites. `pendingGrant`
  // freezes a patch the human has ALREADY REVIEWED in the confirm; this one holds a save nobody has been
  // shown anything about yet, while they stay free to keep editing. So resolving it RE-PLANS from live
  // state (see the effect below) and a snapshot here would be the bug, not the safety.
  const [awaitingAgents, setAwaitingAgents] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [confirmRevert, setConfirmRevert] = useState(false);
  const [resolver, setResolver] = useState<ProfileMergeResult | null>(null); // open ⇔ a conflicting adopt

  // Adopt step 1 — dry-run the field-level merge. Clean → one-click adopt (no resolutions). Conflict → resolver.
  const preview = useMutation({
    meta: { inlineError: true },
    mutationFn: () => api.profileMergePreview(profile.id),
    onSuccess: (p) => { if (p.clean) onAdopt(undefined); else setResolver(p); },
  });
  const adoptBusy = preview.isPending || adopting;

  // The store's skill names — the menu of what a subset can pick from (same list the Skills page edits).
  const skillList = useQuery({ queryKey: ["skills"], queryFn: ({ signal }) => api.skills(signal) });
  const available = (skillList.data ?? []).map((s) => s.name);
  const toggleSkill = (n: string) => setSkills((cur) => (cur.includes(n) ? cur.filter((s) => s !== n) : [...cur, n]));

  // The capability registry catalog (agent-tooling P4): builtins + owner-added, ONE unified list — the
  // Profile editor's picker renders every entry as a checkbox, transparently backed by browserTesting/
  // documentConversion for the two reserved slugs and by the `capabilities` array
  // for everything else.
  // Every agent across every project — the BINDING map behind the pre-save grant confirm (card 3c4e0df6).
  // Via the SHARED hook, never a local useQuery on the same key: a second queryFn on ["allAgents"]
  // that projected the rows would serve its reduced shape here from cache whenever a page using it
  // mounted first, dropping profileId — which reads as isSuccess with nobody bound, i.e. no prompt.
  // `isSuccess` is the gate, NOT `data`: an unresolved or failed fetch must stay DISTINCT from "nobody
  // is bound", or a trust-boundary grant saves silently. lib/profileGrantReach carries the @decision.
  const allAgents = useAllAgents();
  const boundAgents = allAgents.isSuccess ? allAgents.data : null;
  // Card 586a0efe — "still arriving" is NOT "could not load", and the gate above cannot tell them apart:
  // both read as `boundAgents === null`. `isPending` alone can't either, because react-query stays PENDING
  // across its whole retry backoff (~7s at the defaults) after the first attempt fails — so a broken or
  // aborted request would sit under a "checking…" hint for seconds before admitting anything is wrong.
  // `failureCount` moves on the FIRST failed attempt, so pairing them puts a real outage straight onto the
  // error confirm while a genuinely in-flight first load is the only thing that reads as loading.
  const agentsLoading = allAgents.isPending && allAgents.failureCount === 0;

  // @decision afe1bc90 — only the two RESERVED builtins (browser-testing / document-conversion) are still
  // profile-level; every other registry capability is granted per AGENT (agent editor), not here.
  const capabilityList = useQuery({ queryKey: ["capabilities"], queryFn: ({ signal }) => api.capabilities(signal) });
// Card 2ef54430: the stored Connections a custom codex endpoint can bind (the field filters to api-key/bearer).
  const connectionList = useQuery({ queryKey: ["connections"], queryFn: ({ signal }) => api.connections(signal) });
  const availableConnections = connectionList.data ?? [];
  const availableCapabilities = (capabilityList.data ?? []).filter((c) => c.slug === "browser-testing" || c.slug === "document-conversion");
  const isCapabilityChecked = (slug: string) =>
    slug === "browser-testing" ? browserTesting : slug === "document-conversion" ? documentConversion : false;
  const toggleCapability = (slug: string) => {
    if (slug === "browser-testing") return setBrowserTesting((v) => !v);
    if (slug === "document-conversion") return setDocumentConversion((v) => !v);
  };

  // The live field values, as ONE record — what gets diffed, reconciled and narrowed into a patch below.
  const values: ProfileFields = {
    name, role, description, allowText, icon, model, browserTesting, documentConversion, vaultWrite,
    restrictedTools, noCommit, harness, codexProvider, skills,
  };
  const applyFields = (v: ProfileFields) => {
    setName(v.name); setRole(v.role); setDescription(v.description); setAllowText(v.allowText);
    setIcon(v.icon); setModel(v.model); setBrowserTesting(v.browserTesting);
    setDocumentConversion(v.documentConversion); setVaultWrite(v.vaultWrite);
    setRestrictedTools(v.restrictedTools);
    setNoCommit(v.noCommit); setHarness(v.harness); setCodexProvider(v.codexProvider); setSkills(v.skills);
  };

  // Seed / delta / re-sync / conflict bookkeeping, shared with Settings' ConfigEditor and AgentEditor
  // (card 65aa951c). The seed is NOT `profile`: the whole point is to tell "the human typed this" apart
  // from "this is just what the row said when we mounted", and only a seed that LAGS the live row can
  // express that difference. The hook owns advancing it, adopting an agent's write into any untouched
  // field, and retiring a conflict once the field stops diverging — which is what this editor got wrong
  // on its own: it never cleared `conflicted` after a successful save, so a later re-edit of that same
  // field accused the human of overwriting a write they had just deliberately replaced.
  const sync = useFormSync(profile, profileFieldsOf, values, applyFields, PROFILE_FIELD_COMPARERS);
  const { seed, changed, dirty, conflicts: liveConflicts } = sync;

  const fieldLabel = { fontFamily: font.ui as string, fontSize: fs.sm, fontWeight: 700, color: color.text2 };
  const ta = {
    width: "100%", boxSizing: "border-box" as const, resize: "vertical" as const, fontSize: fs.body, lineHeight: 1.5,
    background: color.inset, color: color.text, border: `1px solid ${color.line}`, borderRadius: radius.sm, padding: 8,
  };

  // Reset to the SEED, not to `profile` directly — identical in the steady state, but it keeps "discard my
  // edits" and "what counts as an edit" reading off one value, so the two can never disagree about what
  // Reset should restore (and a conflicting field resets to the OTHER party's write, as the notice says).
  const reset = () => applyFields(seed);

  // Card 6232fe9d. `clearCodexRejectedFields` is the ONE place a payload is made storable on codex — the
  // same helper that drives the warning copy above the Save button, so what the reader is told and what
  // gets sent cannot disagree. A no-op on claude and on a codex rig with none of them set, so every other
  // save is byte-identical to before.
  //
  // Local state is then reconciled to WHAT WAS SENT, not left holding the pre-clear values. Without this
  // the editor would stay permanently dirty after a codex save (local `restrictedTools: true` against a
  // stored `false`), offering a Save that could never settle. The four setters are read off `sent`, so
  // they can't disagree with it about values — but they do name the fields, so a field ADDED to the
  // rejection mirror needs a setter here too.
  //
  // @decision 65aa951c — narrow the payload to the CHANGED fields, and do it AFTER the codex clear: a
  // field the clear moved must still reach the wire, and diffing the pre-clear values would drop it.
  const submit = () => {
    // Card 2ef54430: a provider is codex-only (validateProfile refuses it on claude), so leaving codex drops
    // it from what is sent — and reconciles local state to match, like the four fields below.
    const sent = { ...clearCodexRejectedFields(harness, values), codexProvider: harness === "codex" ? normCodexProvider(codexProvider) : null };
    setCodexProvider(sent.codexProvider);
    setRestrictedTools(sent.restrictedTools);
    setBrowserTesting(sent.browserTesting);
    setDocumentConversion(sent.documentConversion);
    // Only what the human actually changed. PUT /api/profiles/:id merges the patch over the stored row
    // before validating, so an omitted field is PRESERVED — including a value an agent wrote after this
    // editor opened. An untouched field is therefore never on the wire at all, which is what makes this
    // hold with no refetch at all (the re-sync above is the honesty half, not the safety half).
    const delta = new Set(changedFields(seed, sent, PROFILE_FIELD_COMPARERS));
    // 🔴 The delta alone is NOT safe for a switch ONTO codex. A cleared field is dropped from the payload
    // whenever it already equals the seed — and the seed is the row as it stood at MOUNT. An agent writing
    // `browserTesting: true` afterwards therefore leaves the store holding a value codex REFUSES while the
    // patch carries only `harness`; the server merges the two and `validateProfile` 400s a save the reader
    // was given no way to fix (the control is disabled on codex, and no reject warning fires either,
    // because `codexRejectedFields` is computed from local state that is already clear).
    //
    // So the whole rejection set goes on the wire explicitly, from `sent` — i.e. cleared. Only in this
    // direction: nothing is refused on claude, so widening the payload there would send values the human
    // never touched for no reason at all.
    //
    // @decision 65aa951c — a field whose SERVER value can make a save invalid must be sent explicitly,
    // never left to the delta: a delta can only know what the human changed, not what the store holds.
    if (delta.has("harness") && sent.harness === "codex") for (const f of CODEX_REJECTED_FIELDS) if (f !== "capabilities") delta.add(f); // `capabilities` is an agent field now (afe1bc90)
    const patch: Partial<Omit<Profile, "id">> = {};
    if (delta.has("name")) patch.name = sent.name.trim();
    if (delta.has("role")) patch.role = sent.role || null;
    if (delta.has("description")) patch.description = sent.description;
    if (delta.has("allowText")) patch.allowDelta = parseAllowDelta(sent.allowText);
    if (delta.has("icon")) patch.icon = sent.icon.trim() || null;
    if (delta.has("model")) patch.model = sent.model.trim() || null;
    if (delta.has("browserTesting")) patch.browserTesting = sent.browserTesting;
    if (delta.has("documentConversion")) patch.documentConversion = sent.documentConversion;
    if (delta.has("vaultWrite")) patch.vaultWrite = sent.vaultWrite;
    if (delta.has("restrictedTools")) patch.restrictedTools = sent.restrictedTools;
    if (delta.has("noCommit")) patch.noCommit = sent.noCommit;
    if (delta.has("harness")) patch.harness = sent.harness;
    // null clears (updateProfile: undefined leaves the column). Sent when the provider changed OR the harness
    // did — switching a rig OFF codex must clear a stored provider in the same save, or the merge is refused.
    if (delta.has("codexProvider") || delta.has("harness")) patch.codexProvider = sent.codexProvider;
    if (delta.has("skills")) patch.skills = sent.skills.length ? sent.skills : null;

    // Card 3c4e0df6 (grants) + be447b3f (role change / restrictedTools relaxing). Profiles are GLOBAL, so
    // a widening here reaches every agent already bound to this rig, in every project — a trust boundary
    // the human should see BEFORE it takes effect, not discover afterwards. Computed from the STORED row
    // against what this save would land, by the same `@loom/shared` helpers the daemon uses on its side
    // to record the audit event.
    const plan = planGrantSave(grantFieldsOfProfile(profile), grantFieldsOfValues(sent), profile.id, boundAgents, agentsLoading);
    // Card 586a0efe. `wait` means the reach is still arriving, so there is nothing truthful to show yet:
    // hold the save pending rather than planning against a null list, which would draw the "could not
    // load" confirm (and a dead Save) over a list that is merely a few hundred ms late. The patch built
    // above is DROPPED on purpose — the effect below re-runs this whole function once the list settles.
    if (plan.kind === "wait") { setAwaitingAgents(true); return; }
    if (plan.kind !== "save") { setPendingGrant({ patch, plan }); return; }
    onSave(patch);
  };

  // Card 586a0efe — resolve a held save by RE-RUNNING `submit` against the values as they stand NOW, not a
  // patch captured when Save was clicked: the human can keep editing while this is held (including the very
  // field being granted), and what lands must be what they can still see on screen. `submit` reads only
  // live state, so re-running it IS the re-plan — there is no second code path to keep in step.
  //
  // Terminates on EITHER outcome: `agentsLoading` goes false when the list resolves (→ the normal `save`/
  // `confirm` flow) AND when it fails (→ the ordinary `confirm-unknown`, i.e. exactly today's behaviour),
  // so a dead request can never strand this flag. Unmounting drops it with the component, and Cancel below
  // clears the flag, which is why that is enough to stop the save rather than merely hiding the hint.
  //
  // `submit` is NOT a dep, deliberately: it is rebuilt every render, so listing it would fire this effect
  // on every keystroke. React runs the callback belonging to the render whose deps CHANGED — the render
  // where the list settled — so the closure it fires with already holds the human's latest values. That is
  // the re-plan, not a loophole in it; adding `submit` back would change nothing but the churn.
  useEffect(() => {
    if (!awaitingAgents || agentsLoading) return;
    setAwaitingAgents(false);
    submit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaitingAgents, agentsLoading]);

  // The confirm Save. Submits the patch EXACTLY as `submit` built it — never a rebuilt one, which
  // could pick up state that changed while the confirm was open and save something nobody reviewed.
  const confirmGrantSave = () => {
    if (!pendingGrant) return;
    const { patch } = pendingGrant;
    setPendingGrant(null);
    onSave(patch);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <strong style={{ fontFamily: font.ui, color: color.text }}>{profile.name}</strong>
        <RoleBadge role={role || null} />
        <HarnessTag harness={harness} />
        {bundled && <Badge tone="muted">bundled</Badge>}
        {customized && <Badge tone="muted">customized</Badge>}
        {updateAvailable && <Badge tone="attn">update available</Badge>}
        <span style={{ flex: 1 }} />
        {confirmDel ? (
          <>
            <span style={{ color: color.danger, fontSize: fs.sm }}>delete {profile.name}?</span>
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

      <div className="loom-field-grid loom-field-grid-trail" style={{ gap: 10 }}>
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

      {/* Harness — which vendor CLI a session under this rig spawns (card fa2277b6, owner directive).
          Placed directly under Role and ABOVE every field it invalidates, so the annotations below read
          as consequences of this choice rather than as unexplained disabled controls. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={fieldLabel}>Harness · which CLI this rig spawns</span>
        <HarnessPicker value={harness} onChange={setHarness} />
        <HarnessDropSummary harness={harness} />
        {harness === "codex" && <CodexProviderField value={codexProvider} onChange={setCodexProvider} connections={availableConnections} />}
        {/* Named BEFORE the Save click, and only while this rig actually holds something codex refuses to
            store — see card 6232fe9d. Sits here rather than beside each field because the loss is a
            consequence of THIS choice, and a reader who has just picked codex is looking right at it. */}
        <HarnessRejectWarning harness={harness} values={{ restrictedTools, browserTesting, documentConversion, capabilities: [] }} />
      </div>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={fieldLabel}>Description</span>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} spellCheck={false}
          style={{ ...ta, minHeight: 140 }} placeholder="A human-facing blurb shown here in the Profiles UI — what this rig is for. NEVER injected into a session (the startup prompt comes from the agent)." />
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={fieldLabel}>Allow delta <span style={{ fontWeight: 400, color: color.text3 }}>· one permission glob per line, layered onto the resolved allowlist</span></span>
        <textarea value={allowText} onChange={(e) => setAllowText(e.target.value)} spellCheck={false}
          disabled={!!dropStyle(harness, "allowDelta")}
          style={{ ...ta, fontFamily: font.mono, minHeight: 80, ...dropStyle(harness, "allowDelta") }} placeholder={"Bash(pnpm *)\nRead(*)"} />
        <HarnessFieldDrop harness={harness} field="allowDelta" />
      </label>

      {/* The two BUILTIN capabilities (browser testing / document conversion) — profile-level booleans, human-set
          here only. Registry capabilities and connections are granted per AGENT (card afe1bc90): see the note below. */}
      <label style={fieldLabel}>Capabilities</label>
      <div data-testid="profile-credential-grants-moved" style={{ fontSize: fs.sm, color: color.text3, lineHeight: 1.5, marginBottom: 6 }}>
        Connections and registry capabilities are granted per AGENT, not per profile. Open the agent in the agent editor
        (Agents) to grant them.
      </div>
      <HarnessFieldDrop harness={harness} field="capabilities" />
      <div style={{ display: "flex", flexDirection: "column", gap: 10, ...dropStyle(harness, "capabilities") }}>
        {availableCapabilities.map((c) => {
          const checked = isCapabilityChecked(c.slug);
          const isLegacy = c.slug === "browser-testing" || c.slug === "document-conversion";
          const capsDropped = !!dropStyle(harness, "capabilities");
          return (
            <label key={c.slug} style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: capsDropped ? "default" : "pointer" }}>
              <input type="checkbox" checked={checked} disabled={capsDropped} onChange={() => toggleCapability(c.slug)} style={{ marginTop: 2 }} />
              {/* `minWidth: 0` releases this column's min-content floor, and the name+badge row below
                  wraps rather than holding one line — the same treatment every other badge cluster on
                  this page already uses. Without the pair, a long capability name plus two badges (e.g.
                  "Image Generation (Gemini/Imagen)" + "needs connection" + "network") floored this row
                  at 302px inside a 264px panel and pushed the page sideways at phone width. */}
              <span style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
                <span style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <span style={{ ...fieldLabel, fontSize: fs.body }}>{c.name}</span>
                  {c.builtin && <Badge tone="muted">builtin</Badge>}
                  {c.requiresConnection && <Badge tone="muted">needs connection</Badge>}
                  {/* Card cd9a78bc: provisioning FETCHES for this kind (pip / a GitHub release asset /
                      `npm install`), so an offline or proxied host is a real reason the MCP won't mount.
                      Muted deliberately — it is a property to know, not a warning to act on. The badge is
                      absent (never a "no network" claim) for a kind we can't tell from here; see
                      lib/capabilityProvisioning.ts's NETWORK_KINDS. */}
                  {capabilityNeedsNetwork(c) && (
                    <Badge tone="muted" data-testid={`capability-network-${c.slug}`} title="Provisioning downloads over the network: pip, a GitHub release, or npm. An offline or proxied host can keep this from mounting.">network</Badge>
                  )}
                </span>
                <span style={{ fontWeight: 400, color: color.text3, fontSize: fs.sm, lineHeight: 1.5 }}>
                  {c.description}
                </span>
              </span>
            </label>
          );
        })}
        {availableCapabilities.length === 0 && (
          <span style={{ color: color.text3, fontSize: fs.sm }}>Loading capability catalog…</span>
        )}
      </div>

      {/* Provisioning status, one row per GRANTED capability that reports one (card cd9a78bc). Rendered
          here rather than inline inside each picker row on purpose: the row carries a Retry button, and a
          button nested in a <label> toggles that label's checkbox on click.
          Hidden on codex: NO capability is mounted there at all, so a "ready" row beside one would report
          health for something that is not going to run — the same false green the row exists to kill, one
          layer down. */}
      {harness !== "codex" && availableCapabilities
        .filter((c) => isCapabilityChecked(c.slug) && capabilityReportsProvisioning(c))
        .map((c) => <CapabilityProvisioningRow key={c.slug} capability={c} />)}

      {/* Vault write (card be8be211) — grouped with the capability grants above because it is one: a
          human-only widening of what a session may do. Rendered as its own checkbox rather than a
          registry row because it mounts no host process and binds no connection — it unhides ONE MCP
          tool, gated live off the session row. No harness annotation, deliberately: the loom-tasks
          router is mounted for every harness, so unlike the picker above nothing is dropped on codex. */}
      <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
        <input type="checkbox" data-testid="profile-vault-write" checked={vaultWrite}
          onChange={(e) => setVaultWrite(e.target.checked)} style={{ marginTop: 2 }} />
        <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={fieldLabel}>Vault write</span>
          <span style={{ fontWeight: 400, color: color.text3, fontSize: fs.sm, lineHeight: 1.5 }}>
            Let a session under this rig write notes into its OWN project's vault — the vault_write tool
            may create a new file or overwrite an existing one, and nothing else: there is no delete, and
            no path outside that project's vault root. Off by default; the tool is hidden entirely, not
            merely refused, until you turn this on. Grant it to a rig whose job is to leave durable notes
            (research, design write-ups); leave it off for anything that only needs to read the vault.
          </span>
        </span>
      </label>

      {/* Opt-in restricted tools: a session under this rig spawns with the dangerous NATIVE tools (raw
          shell + host-writes) removed from the model's tool list. Blast-radius control for a chat-reachable
          Companion driven by untrusted input — human-set here only, never via an agent tool. */}
      <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: dropStyle(harness, "restrictedTools") ? "default" : "pointer" }}>
        <input type="checkbox" checked={restrictedTools} disabled={!!dropStyle(harness, "restrictedTools")}
          onChange={(e) => setRestrictedTools(e.target.checked)} style={{ marginTop: 2 }} />
        <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {/* Deliberately NOT dimmed like the other four, even though the input IS disabled: this is the
              one FAIL-OPEN drop, and greying the row would make a safety toggle that is silently doing
              nothing read as safely deactivated — the opposite of true. It stays at full contrast so it
              stands out AMONG the dimmed ones, which is the whole point of triaging by failure direction. */}
          <span style={fieldLabel}>Restricted tools</span>
          <span style={{ fontWeight: 400, color: color.text3, fontSize: fs.sm, lineHeight: 1.5 }}>
            Lock down blast radius: remove the dangerous native tools (Bash / Edit / Write / NotebookEdit /
            MultiEdit, subagent delegation Task / Agent, and network egress WebFetch / WebSearch) from this
            rig's tool list — so it can't run a shell, write host files, spawn a subagent that re-acquires
            them, or reach the network. Read / Glob / Grep and the Loom MCP tools stay. Turn ON for a companion
            reachable from untrusted chat; turning it OFF widens the rig deliberately.
          </span>
          {/* The one FAIL-OPEN drop of the five: a safety toggle that reads ON while removing nothing.
              It is deliberately NOT dimmed with the rest — the annotation must stay at full contrast
              precisely because the control it corrects looks enabled. */}
          <HarnessFieldDrop harness={harness} field="restrictedTools" />
        </span>
      </label>

      {/* Declared no-commit role: a read-only worker (e.g. a code reviewer) whose correct contract is to
          produce NO commit. Lifecycle-only — confers no spawn capability; human-set here only. */}
      <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
        <input type="checkbox" checked={noCommit} onChange={(e) => setNoCommit(e.target.checked)} style={{ marginTop: 2 }} />
        <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={fieldLabel}>No-commit role</span>
          <span style={{ fontWeight: 400, color: color.text3, fontSize: fs.sm, lineHeight: 1.5 }}>
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
        <span style={{ ...fieldLabel, ...dropStyle(harness, "model") }}>Model</span>
        <Input value={model} disabled={!!dropStyle(harness, "model")} onChange={(e) => setModel(e.target.value)}
          style={dropStyle(harness, "model")} placeholder="engine default (e.g. claude-opus-4-8)" />
        <HarnessFieldDrop harness={harness} field="model" />
      </label>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {/* The "none selected → ALL delivered" caption is only true on claude — on codex NOTHING is
            injected either way, so the caption is suppressed rather than left to assert the opposite. */}
        <span style={{ ...fieldLabel, ...dropStyle(harness, "skills") }}>Skills {!dropStyle(harness, "skills") && <span style={{ fontWeight: 400, color: color.text3 }}>· {skills.length === 0 ? "none selected → ALL skills delivered (default)" : `${skills.length} selected → only these delivered`}</span>}</span>
        <HarnessFieldDrop harness={harness} field="skills" />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, ...dropStyle(harness, "skills") }}>
          {available.map((n) => {
            const on = skills.includes(n);
            const skillsDropped = !!dropStyle(harness, "skills");
            return (
              <button key={n} type="button" onClick={() => toggleSkill(n)} disabled={skillsDropped}
                style={{ cursor: skillsDropped ? "default" : "pointer", fontFamily: font.mono, fontSize: fs.mono, padding: "3px 9px", borderRadius: radius.lg,
                  border: `1px solid ${on ? color.accentEdge : color.line}`, background: on ? color.inset : "transparent",
                  color: on ? color.accentFg : color.text3 }}>
                {on ? "✓ " : ""}{n}
              </button>
            );
          })}
          {available.length === 0 && <span style={{ color: color.text3, fontSize: fs.sm }}>No skills in the store yet.</span>}
        </div>
        {skills.length > 0 && !dropStyle(harness, "skills") && <button type="button" onClick={() => setSkills([])} style={{ alignSelf: "flex-start", cursor: "pointer", fontSize: fs.sm, padding: "2px 8px", borderRadius: radius.base, border: `1px solid ${color.line}`, background: "transparent", color: color.text3 }}>clear → deliver all</button>}
        {/* A subset name no longer in the store (e.g. a deleted skill) — surfaced so it can be cleared. */}
        {skills.filter((n) => !available.includes(n)).length > 0 && (
          <span style={{ color: color.attnText, fontSize: fs.sm }}>
            not in store (will be ignored at spawn): {skills.filter((n) => !available.includes(n)).join(", ")}
          </span>
        )}
      </div>
      {harness !== "codex" && <span style={{ color: color.text3, fontSize: fs.sm, marginTop: -6 }}>Model + skills apply on the next spawn. Skills delivery is per-session — sessions sharing a repo see the union of their subsets, never each other stripped.</span>}

      <span style={{ flex: 1 }} />
      {/* Card 65aa951c. An UNTOUCHED field silently adopts whatever landed while this editor was open —
          that is just the truth arriving, and announcing it would be noise. A field the human is ALREADY
          editing cannot be adopted, so Save will overwrite the other write: that one is named here, with
          the two real options, rather than left to be discovered afterwards. */}
      {liveConflicts.length > 0 && (
        <span data-testid="profile-conflict-notice" style={{ color: color.attnText, fontSize: fs.sm, lineHeight: 1.5 }}>
          Changed elsewhere since you opened this: {liveConflicts.map(fieldDisplayName).join(", ")}.
          Saving replaces {liveConflicts.length === 1 ? "it" : "them"} with your version — Reset takes theirs.
        </span>
      )}
      {/* Card 3c4e0df6: a save that ADDS a human-only grant is held here until the human confirms the
          blast radius. Rendered in the flow directly above Save — the same placement as the conflict
          notice — rather than as an overlay, matching this page’s existing inline-confirm language. */}
      {pendingGrant && (
        <GrantReachConfirm plan={pendingGrant.plan} saving={saving}
          onConfirm={confirmGrantSave} onCancel={() => setPendingGrant(null)} />
      )}
      {/* Card 586a0efe: the save is held because the reach isn't known YET. One cyan status line in the
          same inline slot the amber confirm uses — not that confirm in a gentler colour: this is a
          progress state with no decision in it, so it carries no Grant button, and amber here would read
          as a warning about a save that hasn't been judged. A Cancel, because the human is otherwise
          waiting on a request they can't see; it clears the hold outright, it does not merely hide it. */}
      {awaitingAgents && (
        <div data-testid="grant-reach-checking" role="status"
          style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ color: color.text2, fontSize: fs.sm, lineHeight: 1.5 }}>
            {GRANT_REACH_CHECKING} Your save lands as soon as that is known.
          </span>
          <Button data-testid="grant-reach-checking-cancel" onClick={() => setAwaitingAgents(false)}>Cancel</Button>
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {/* Disabled while the confirm is open so the row underneath cannot re-submit around it — and while
            a save is HELD awaiting the reach, where a second click would only re-set a flag already set.
            `awaitingAgents` wins the LABEL over `saving` because nothing is being written yet: calling it
            "Saving…" there would claim a write that deliberately has not happened. */}
        <Button variant="primary" disabled={!dirty || !name.trim() || saving || !!pendingGrant || awaitingAgents} onClick={submit}>
          {awaitingAgents ? "Checking…" : saving ? "Saving…" : "Save"}
        </Button>
        {dirty
          ? <Button onClick={reset}>Reset</Button>
          : <span style={{ color: color.liveFg, fontSize: fs.sm }}>saved</span>}
        <span style={{ flex: 1 }} />
        {bundled && (confirmRevert ? (
          <>
            <span style={{ color: color.attnText, fontSize: fs.sm }}>discard edits & restore shipped?</span>
            <Button variant="danger" disabled={reverting} onClick={onRevert}>Revert</Button>
            <Button onClick={() => setConfirmRevert(false)}>Cancel</Button>
          </>
        ) : <Button onClick={() => setConfirmRevert(true)} title="Discard edits and restore this profile to its shipped (bundled) fields">Revert to bundled</Button>)}
      </div>
      {/* Card 6232fe9d. The save mutation's error used to be thrown away, so a refused PUT left the editor
          silently dirty — indistinguishable from a Save button that does nothing, which is exactly how the
          codex rejection this card fixes stayed invisible. The daemon's refusals already name the offending
          field AND the remedy, so the text is worth showing verbatim. Its own line below the row, not
          inside it: these messages run to several lines and would otherwise squeeze the buttons. Matches
          the update banner's error line above. Rendering here is why `save` sets `meta: { inlineError: true }`
          — without it the MutationCache would stack a blocking modal on top of this line. */}
      {saveError && (
        <span data-testid="profile-save-error" role="alert"
          style={{ color: color.danger, fontSize: fs.sm, lineHeight: 1.5 }}>
          {errorText(saveError)}
        </span>
      )}

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
    queryFn: ({ signal }) => api.profileUpdateDiff(id, signal),
    enabled: showDiff,
  });
  return (
    <div style={{ border: `1px solid ${color.attn}`, borderRadius: radius.base, padding: "8px 10px",
      background: color.inset, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ color: color.attnText, fontSize: fs.sm }}>
          Loom shipped an update to this profile.
        </span>
        <span style={{ flex: 1 }} />
        <Button onClick={() => setShowDiff((v) => !v)}>{showDiff ? "Hide changes" : "What changed"}</Button>
        <Button variant="primary" disabled={adoptBusy} onClick={onAdopt} title="Merge the shipped update onto your edits">
          {adoptBusy ? "Adopting…" : "Adopt update"}
        </Button>
      </div>
      {error && <span style={{ color: color.danger, fontSize: fs.sm }}>{errorText(error)}</span>}
      {showDiff && (
        diff.isLoading ? <span style={{ color: color.text3, fontSize: fs.sm }}>Loading diff…</span>
        : diff.data ? <FieldDiff changed={diff.data.changed} />
        : <span style={{ color: color.danger, fontSize: fs.sm }}>Couldn't load the diff.</span>
      )}
    </div>
  );
}

// "What shipped changed": a field-by-field old→new table (base → shipped). Each row names a field and
// shows the shipped def's old value (dim) → the new value (phosphor). Profiles are small + structured, so
// a compact grid reads better than a line diff.
function FieldDiff({ changed }: { changed: ProfileFieldMerge[] }) {
  if (changed.length === 0) {
    return <span style={{ color: color.text3, fontSize: fs.sm }}>No field changed.</span>;
  }
  return (
    <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto 1fr", gap: "6px 10px", alignItems: "start",
      background: color.surface, border: `1px solid ${color.line}`, borderRadius: radius.sm, padding: 8,
      fontFamily: font.mono, fontSize: fs.mono, lineHeight: 1.5 }}>
      {changed.map((c) => (
        <div key={c.field} style={{ display: "contents" }}>
          <span style={{ color: color.text2, fontSize: fs.sm }}>{fieldDisplayName(c.field)}</span>
          <span style={{ color: color.text3, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{formatFieldValue(c.field, c.base)}</span>
          <span style={{ color: color.text3 }}>→</span>
          <span style={{ color: color.text, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{formatFieldValue(c.field, c.shipped)}</span>
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
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 14px", borderBottom: `1px solid ${color.line}` }}>
            <strong style={{ fontFamily: font.ui, color: color.text }}>Resolve update</strong>
            <Badge tone="muted">{name}</Badge>
            <span style={{ color: color.text3, fontSize: fs.sm }}>
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
                  <span style={{ fontSize: fs.sm, color: color.text2 }}>{fieldDisplayName(c.field)}</span>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <FieldSide label="Your version" tone="muted" active={choice === "mine"} value={formatFieldValue(c.field, c.mine)}
                      onPick={() => setChoices((m) => ({ ...m, [c.field]: "mine" }))} />
                    <FieldSide label="Shipped version" tone="muted" active={choice === "shipped"} value={formatFieldValue(c.field, c.shipped)}
                      onPick={() => setChoices((m) => ({ ...m, [c.field]: "shipped" }))} />
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ borderTop: `1px solid ${color.line}`, padding: "10px 14px", display: "flex", alignItems: "center", gap: 8 }}>
            {error && <span style={{ color: color.danger, fontSize: fs.sm }}>{errorText(error)}</span>}
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
  const accent = toneFill[t];
  return (
    <button onClick={onPick} title={`Keep this version (${label})`}
      style={{ textAlign: "left", cursor: "pointer", borderRadius: radius.sm, padding: 8,
        background: active ? color.surface : color.inset,
        border: `1px solid ${active ? color.accentEdge : color.line}`,
        boxShadow: active ? `inset 0 0 0 1px ${color.lineStrong}` : undefined }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <span style={{ width: 7, height: 7, borderRadius: radius.base, background: accent, display: "inline-block" }} />
        <span style={{ fontSize: fs.sm, color: active ? color.accentFg : color.text2 }}>
          {label}{active ? " ✓" : ""}
        </span>
      </div>
      <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: font.mono, fontSize: fs.mono,
        lineHeight: 1.5, color: active ? color.text : color.text3 }}>
        {value}
      </pre>
    </button>
  );
}

// --- field formatting helpers (pure) ------------------------------------------------------------

// Human label for a mergeable profile field (keys mirror the daemon's MERGEABLE_PROFILE_FIELDS). The seven
// fields the harness annotations also name are SPREAD from HARNESS_FIELD_LABELS rather than restated, so
// the conflict resolver here and the codex drop/reject copy can never call the same field two things.
const FIELD_DISPLAY: Record<string, string> = {
  ...HARNESS_FIELD_LABELS,
  role: "Role", description: "Description", icon: "Icon",
  noCommit: "No-commit role", connections: "Connections", harness: "Harness",
  vaultWrite: "Vault write",
  // The editor's own ProfileFields keys that have no schema-field twin above (card 65aa951c's conflict
  // notice names fields by this map, and `allowDelta` is held in the form as raw text).
  name: "Name", allowText: HARNESS_FIELD_LABELS.allowDelta,
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
