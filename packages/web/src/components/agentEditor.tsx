// THE AGENT EDITOR — the one implementation of agent CRUD, shared by every surface that offers it.
//
// It was born inside pages/Projects.tsx and lived there alone until card 318b5a21 brought the same
// three writes (create / re-profile + re-prompt / delete) onto the Atlas Agents node. The node needed
// an EDITOR, not a second editor: this file is that extraction, MOVED rather than copied, so
// `AgentEditor`'s useFormSync bookkeeping, its two-axis profile-dropdown filter and its live-session
// delete guard exist exactly once.
//
// ⛔ Do NOT re-implement any of this in a host. A host chooses the FRAME (Projects' roomy third pane,
// the Agents node's dialog) and supplies the callbacks; the writes come from `useAgentWrites`.
//
// @decision 318b5a21 — one editor. A second copy of this form drifts from the first within one card.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { profileRoleBindsAsPlainSession, type Agent, type SessionRole, type CapabilityGrant } from "@loom/shared";
import { api } from "../lib/api";
import { Button, Input, Select, Badge } from "./ui";
import { isDevLayerRole } from "../lib/roleDisplay";
import { modEnterSubmit } from "../lib/modEnter";
import { useFormSync } from "../lib/useFormSync";
import { errorText } from "../lib/loopbackCredential";
import { color, font, radius, fs, toneText } from "../theme";

// The one wording for a profile whose role the spawn would clamp away — stated as the consequence ("what
// do I get"), not the mechanism. One constant so all three places that disclose it can never word it
// differently: the bind dropdown's <optgroup>, the inline note below the select (shown once the collapsed
// <select> hides that group), and the agent list row's tooltip (card 57deed24).
export const PLAIN_BIND_GROUP_LABEL = "role not conferred — binds as a plain session";

/**
 * The startup-prompt field's sizing, shared by the create form and the editor (card 5e628a76): it takes
 * whatever height the host frame leaves (`flex-grow`), never shrinks below a real floor, and stays
 * user-resizable. `flex-basis:auto` (not `flex:1`'s `0%`) is what makes the drag handle work: a
 * dragged `height` becomes the basis, where a `0%` basis would silently ignore it.
 */
const PROMPT_FIELD_SIZE = {
  flex: "1 0 auto", height: "min(360px, 40vh)", minHeight: 160,
  width: "100%", boxSizing: "border-box", resize: "vertical",
} as const;

/** The startup-prompt field's placeholder, shared by the create form and the editor (card dd83149f):
 *  an empty field should teach what belongs in it, not sit there as a blank box. */
const PROMPT_PLACEHOLDER =
  "First turn of every new session. Describe the role, the repo's conventions, and what done means.";

/**
 * The inline "you have unsaved work" bar a FRAME shows when a close is requested over a dirty draft
 * (card dd83149f). Same shape as the board card dialog's dirty-close confirm (pages/Board.tsx): the
 * dialog stays open, the draft stays in the field, and leaving takes an explicit Discard.
 *
 * @decision dd83149f — a dirty draft blocks the close; it is never silently dropped and never parked
 * in hidden state to reappear later. A draft kept across close would survive only until the next
 * reload and give no sign it exists, which is a slower way to lose it.
 */
export function UnsavedCloseBar({ what, onSave, saveDisabled, onDiscard, onKeepEditing }: {
  /** What is unsaved, as a noun phrase: "prompt", "prompt and grants", "new agent". */
  what: string;
  /** Omitted where there is nothing a single click can save (the create form needs a name first). */
  onSave?: () => void;
  saveDisabled?: boolean;
  onDiscard: () => void;
  onKeepEditing: () => void;
}) {
  return (
    <div role="alert" data-testid="agent-unsaved-bar"
      style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", padding: "6px 8px",
        borderRadius: radius.base, background: color.attnSoft }}>
      <span style={{ flex: 1, minWidth: 160, color: toneText.attn, fontSize: fs.sm, fontFamily: font.ui }}>
        Unsaved {what}. Save it, or discard it and close?
      </span>
      {onSave && (
        <Button variant="primary" disabled={saveDisabled} data-testid="agent-unsaved-save" onClick={onSave}>Save</Button>
      )}
      <Button variant="danger" data-testid="agent-unsaved-discard" onClick={onDiscard}>Discard and close</Button>
      <Button data-testid="agent-unsaved-keep" onClick={onKeepEditing}>Keep editing</Button>
    </div>
  );
}

/** The profile shape this editor's bind dropdown needs. `ProfileSummary` satisfies it. */
export type EditorProfile = { id: string; name: string; role: string | null; icon: string | null };

/**
 * The THREE agent writes, wired once: create, update (profile and/or prompt), delete.
 *
 * Every host gets the SAME react-query invalidations — `["agents", projectId]` on all three, plus
 * `["allSessions"]` on the delete, because deleting an agent cascades its sessions and a stale
 * session list would keep rendering rows for a row that is gone. Hosts differ only in what they do
 * AFTERWARDS (select the new agent, close a dialog), which is what the two optional hooks are for.
 *
 * ⛔ No `meta: { inlineError: true }` on any of them, deliberately: no host renders these mutations'
 * own `.isError`, so the global mutation-error handler (src/main.tsx) is what discloses a refusal.
 * Opting out of it here would silence a failed delete entirely. A host that ever DOES want the
 * message beside the button has to add the flag AND render it — packages/web/test/loopback-credential.mjs
 * fails the build on half of that pair.
 */
export function useAgentWrites(
  projectId: string,
  hooks: { onCreated?: (agent: Agent) => void; onDeleted?: (id: string) => void } = {},
) {
  const qc = useQueryClient();
  const invalidateAgents = () => qc.invalidateQueries({ queryKey: ["agents", projectId] });
  const create = useMutation({
    mutationFn: (b: { name: string; startupPrompt: string }) => api.createAgent(projectId, b),
    onSuccess: (agent) => { invalidateAgents(); hooks.onCreated?.(agent); },
  });
  const update = useMutation({
    mutationFn: (v: { id: string; patch: { name?: string; startupPrompt?: string; profileId?: string | null } }) =>
      api.updateAgent(v.id, v.patch),
    onSuccess: invalidateAgents,
  });
  // A SEPARATE mutation for the credential-grant save (card caca806c), never folded into `update` above:
  // `meta: { inlineError: true }` suppresses the global mutation-error modal for THIS write only, so the
  // editor can render the server's write-time refusal (cross-project grant, oauth2/ssh binding, reserved
  // slug) verbatim beside its own Save button — `update`'s existing callers (profile-assign, prompt-save)
  // keep today's global-modal behavior unchanged, exactly as the create/delete mutations already do.
  const saveGrants = useMutation({
    meta: { inlineError: true },
    mutationFn: (v: { id: string; patch: { connections: string[]; capabilities: CapabilityGrant[] } }) =>
      api.updateAgent(v.id, v.patch),
    // ["allAgents"] too: the Connections page's per-connection "Granted to N agents" reads that cache.
    onSuccess: () => { invalidateAgents(); qc.invalidateQueries({ queryKey: ["allAgents"] }); },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteAgent(id),
    onSuccess: (_r, id) => {
      invalidateAgents();
      qc.invalidateQueries({ queryKey: ["allSessions"] });
      hooks.onDeleted?.(id);
    },
  });
  return { create, update, saveGrants, remove };
}

/** Canonical per-grant JSON (key-sorted, order-insensitive) — mirrors the Profile editor's own
 *  `sortedJson`/`capsJson` (pages/Profiles.tsx) and the daemon's `customization.ts` fieldEqual for the
 *  same field, so a reordered multiselect is never reported as a human edit. */
const sortedJson = (xs: readonly string[]) => JSON.stringify([...xs].sort());
const capsJson = (xs: readonly CapabilityGrant[]) =>
  JSON.stringify(xs.map((g) => JSON.stringify(g, Object.keys(g).sort())).sort());

/**
 * The CREATE form — a name and the startup prompt, nothing else. A fresh agent gets its rig on the
 * editor below, not here: asking which capabilities to bind before the agent exists puts that choice
 * in front of someone who has not yet said what the agent is for.
 */
export function AgentForm({ onCreate, pending, onCancel, onDirtyChange }: {
  onCreate: (b: { name: string; startupPrompt: string }) => void; pending: boolean; onCancel: () => void;
  /** Lets a closable frame guard its close while anything has been typed (card dd83149f). */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [name, setName] = useState(""), [startupPrompt, setPrompt] = useState("");
  const dirty = name !== "" || startupPrompt !== "";
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  // Fills its host's `fill` body: name at natural height, the prompt textarea grows (`flex:1`) to take
  // the rest of the pane so a roomy frame is actually used, buttons pinned below.
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1, minHeight: 0 }} data-testid="agent-create-form">
      <Input placeholder="agent name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Agent name" />
      <textarea
        style={{ ...PROMPT_FIELD_SIZE, background: color.inset, color: color.text, border: `1px solid ${color.lineStrong}`, borderRadius: radius.sm, padding: 8, fontFamily: font.ui, fontSize: fs.body, lineHeight: 1.5 }}
        placeholder={`Startup prompt. ${PROMPT_PLACEHOLDER}`} aria-label="Startup prompt"
        value={startupPrompt} onChange={(e) => setPrompt(e.target.value)} />
      <div style={{ display: "flex", gap: 8 }}>
        <Button variant="primary" disabled={!name || pending} data-testid="agent-create-submit"
          onClick={() => onCreate({ name, startupPrompt })}>{pending ? "Creating…" : "Create"}</Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

// The selected agent's detail: an editor header (name + profile-assign + delete, all relocated here out of
// the old cramped rail) over the roomy startup-prompt editor. Remounted per agent (key=agent.id) so the
// textarea + assignment reset on switch; after Save the query refetches and `dirty` clears.
export function AgentEditor(
  { agent, profiles, isDev, liveCount, onAssignProfile, onSavePrompt, onSaveGrants, onDelete, saving, savingGrants, grantsError, grantsErrorAgentId, deleting,
    onDirtyChange, closeArmed = false, onDiscardClose, onKeepEditing }:
  { agent: Agent; profiles: EditorProfile[]; isDev: boolean;
    liveCount: number; onAssignProfile: (profileId: string | null) => void; onSavePrompt: (startupPrompt: string) => void;
    onSaveGrants: (patch: { connections: string[]; capabilities: CapabilityGrant[] }) => void;
    onDelete: () => void; saving: boolean; savingGrants: boolean;
    // @decision caca806c (round 3, item 5) — `grantsError` is the SHARED `saveGrants` mutation's error,
    // not one scoped to this agent; `grantsErrorAgentId` (its `variables?.id`) scopes it IN HERE, by
    // construction, so every host (Projects.tsx, atlasAgents.tsx) gets this for free on agent switch.
    grantsError: Error | null; grantsErrorAgentId: string | undefined; deleting: boolean;
    // A CLOSABLE frame's dirty-close guard (card dd83149f). The frame owns the close request (it hears
    // Escape / the scrim / ×) and arms `closeArmed`; the editor owns the bar, because only it holds the
    // draft a Save would write. Projects' third pane has no close, but arms the same bar when a pick
    // elsewhere on the page would replace this editor (card f58b1250).
    onDirtyChange?: (dirty: boolean) => void; closeArmed?: boolean;
    onDiscardClose?: () => void; onKeepEditing?: () => void },
) {
  const scopedGrantsError = grantsErrorAgentId === agent.id ? grantsError : null;
  const [prompt, setPrompt] = useState(agent.startupPrompt);
  // Seed / delta / re-sync / conflict bookkeeping, shared with Settings' ConfigEditor and ProfileEditor
  // (card 65aa951c). An AGENT can rewrite `startupPrompt` while this is open — the Platform Lead's
  // `agent_update`, the Setup operator's, an agent-prompt preset apply — and comparing against the LIVE
  // row instead would both hide that write behind stale text AND report it as a pending human edit: Save
  // would light up with nothing typed, and one click would revert it.
  //
  // A one-field form goes through the same hook as the twenty-eight-field one deliberately. Its hand-
  // rolled version was the shortest of the three and still carried the same defect as ProfileEditor's —
  // a `conflict` boolean that nothing ever cleared, so the notice came back on any later re-edit — which
  // is the argument for there being one implementation rather than three short ones.
  const sync = useFormSync(
    agent.startupPrompt,
    (startupPrompt: string) => ({ startupPrompt }),
    { startupPrompt: prompt },
    (v) => setPrompt(v.startupPrompt),
  );
  const seed = sync.seed.startupPrompt;
  const dirty = sync.dirty;
  // Named only when the human is already editing, since that is the one case the re-sync cannot resolve
  // on its own: their draft is kept (never clobbered mid-type) and Save will overwrite the other write, so
  // the choice is stated rather than discovered afterwards. Already filtered to "still changed" by the
  // hook, so Reset retires it with no extra bookkeeping here.
  const conflict = sync.conflicts.length > 0;
  const live = liveCount > 0;

  // --- Credential grants (card caca806c): authenticated-egress connections + credential-bound capability
  // grants, agent-level (never a secret — ids only). Same seed-backed re-sync shape as the prompt above,
  // its own mutation (so a refused grant save never clobbers the prompt field's dirty state or vice versa).
  const [connections, setConnections] = useState<string[]>(agent.connections ?? []);
  const [capabilities, setCapabilities] = useState<CapabilityGrant[]>(agent.capabilities ?? []);
  const grantSync = useFormSync(
    agent,
    (a: Agent) => ({ connections: a.connections ?? [], capabilities: a.capabilities ?? [] }),
    { connections, capabilities },
    (v) => { setConnections(v.connections); setCapabilities(v.capabilities); },
    { connections: (a, b) => sortedJson(a) === sortedJson(b), capabilities: (a, b) => capsJson(a) === capsJson(b) },
  );
  const grantsDirty = grantSync.dirty;
  const grantsConflict = grantSync.conflicts.length > 0;
  useEffect(() => { onDirtyChange?.(dirty || grantsDirty); }, [dirty, grantsDirty, onDirtyChange]);

  // "saved" is a claim about a save THIS session made (card dd83149f, audit A-12) — not "nothing is
  // dirty", which is also true of a field nobody has touched. Each Save records the value it wrote; the
  // notice shows only once the persisted value (the seed) has caught up to it. A refused write never
  // reaches the seed, so it can never read "saved", and Reset after a failed Save cannot either.
  const [savedPrompt, setSavedPrompt] = useState<string | null>(null);
  const [savedGrants, setSavedGrants] = useState<string | null>(null);
  const grantsKey = (v: { connections: string[]; capabilities: CapabilityGrant[] }) =>
    `${sortedJson(v.connections)}|${capsJson(v.capabilities)}`;
  const promptShowsSaved = !dirty && !saving && savedPrompt !== null && savedPrompt === seed;
  const grantsShowSaved = !grantsDirty && !savingGrants && savedGrants !== null && savedGrants === grantsKey(grantSync.seed);
  const savePrompt = () => { setSavedPrompt(prompt); onSavePrompt(prompt); };
  const saveGrantsNow = () => { setSavedGrants(grantsKey({ connections, capabilities })); onSaveGrants({ connections, capabilities }); };
  const unsavedWhat = dirty && grantsDirty ? "prompt and grants" : dirty ? "prompt" : "grants";
  // The P1 credential store's connections — the menu of what this agent's egress allowlist can grant.
  // Filtered to what THIS agent could actually be granted (mirrors the daemon's own write-time
  // agentCredentialGrantCrossProjectError / connections/store.ts's isConnectionUsableByProject): a GLOBAL
  // connection (projectId === null) is reachable by any agent, a project-scoped one only by an agent in
  // THAT SAME project — the unfiltered list used to offer every other project's scoped connections too.
  const connectionList = useQuery({ queryKey: ["connections"], queryFn: ({ signal }) => api.connections(signal) });
  const availableConnections = (connectionList.data ?? []).filter((c) => c.projectId == null || c.projectId === agent.projectId);
  const toggleConnection = (id: string) => setConnections((cur) => (cur.includes(id) ? cur.filter((c) => c !== id) : [...cur, id]));
  // The capability registry catalog, MINUS the two reserved legacy slugs (browser-testing/document-
  // conversion) — those stay credential-free and PROFILE-only (its own browserTesting/documentConversion
  // booleans), never grantable through an agent's own capabilities array (agents/validate.ts rejects
  // them at write time too; this filter just keeps the picker from ever offering what the server refuses).
  const capabilityList = useQuery({ queryKey: ["capabilities"], queryFn: ({ signal }) => api.capabilities(signal) });
  const availableCapabilities = (capabilityList.data ?? []).filter((c) => c.slug !== "browser-testing" && c.slug !== "document-conversion");
  const toggleCapability = (slug: string) =>
    setCapabilities((cur) => (cur.some((g) => g.slug === slug) ? cur.filter((g) => g.slug !== slug) : [...cur, { slug }]));
  const capabilityConnectionId = (slug: string) => capabilities.find((g) => g.slug === slug)?.connectionId ?? "";
  const setCapabilityConnectionId = (slug: string, connectionId: string) =>
    setCapabilities((cur) => cur.map((g) => (g.slug === slug ? { ...g, connectionId: connectionId || undefined } : g)));
  // Which profiles this dropdown may offer, on TWO independent axes — neither hand-lists a role.
  // VISIBILITY (`isDevLayerRole`, read off the role map's own `confer`): a dev-layer rig (platform /
  // auditor) isn't human-creatable on a non-dev install, so offering one there is noise. On dev it stays.
  // GROUPING (`profileRoleBindsAsPlainSession`, derived from the daemon's PROFILE_SPAWNABLE_ROLES): a
  // profile confers only manager / worker / assistant, so binding one carrying ANY other role spawns a
  // PLAIN session with that role silently dropped — safe, but it reads as an offer of powers that don't
  // exist. 921e06b0 fixed the dev-layer pair; c40489c6 covers setup / operator / workspace-auditor,
  // which are `confer: "user"`/`"hidden"` and so slip past the visibility axis. Those stay OFFERED (a
  // user may legitimately want one bound) under a group label stating what binding one really does.
  // Reading the set from @loom/shared instead of re-listing it here is what survives the clamp moving.
  // The CURRENTLY-assigned profile is always kept, whichever axis would drop it: removing the selected
  // option would leave the <select> with no matching value and silently render this agent as "— none —".
  const [ordinaryProfiles, plainBindProfiles] = useMemo(() => {
    const ordinary: EditorProfile[] = [], plainBind: EditorProfile[] = [];
    for (const p of profiles) {
      const role = p.role as SessionRole | null;
      if (isDevLayerRole(role) && !isDev && p.id !== agent.profileId) continue;
      (profileRoleBindsAsPlainSession(role) ? plainBind : ordinary).push(p);
    }
    return [ordinary, plainBind];
  }, [profiles, isDev, agent.profileId]);
  // The group label disappears the moment a <select> collapses to its chosen option, so a bound
  // non-spawnable profile would read as conferring its role again. This restates it inline, only then.
  const boundBindsPlain = useMemo(() => {
    const bound = profiles.find((p) => p.id === agent.profileId);
    return bound ? profileRoleBindsAsPlainSession(bound.role as SessionRole | null) : false;
  }, [profiles, agent.profileId]);
  // `flex:1` (not `height:100%`) so the editor fills a host pane's own `minHeight`: a Panel in an
  // `alignItems:start` grid has `height:auto`, against which a percentage height collapses to content —
  // the flex min-height is what the prompt textarea's own `flex:1` then grows into.
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, padding: 8, gap: 10 }}
      data-testid={`agent-editor-${agent.id}`}>
      {/* The frame asked to close over unsaved work: keep the draft, say so, let the reader choose. Save
          writes and dismisses the bar (the dialog stays, now clean, showing "saved"), so a refused write
          is never followed by a close that throws the draft away. */}
      {closeArmed && (dirty || grantsDirty) && onDiscardClose && onKeepEditing && (
        <UnsavedCloseBar what={unsavedWhat} saveDisabled={saving || savingGrants}
          onSave={() => { if (dirty) savePrompt(); if (grantsDirty) saveGrantsNow(); onKeepEditing(); }}
          onDiscard={onDiscardClose} onKeepEditing={onKeepEditing} />
      )}
      {/* Editor header: identity + profile assignment + delete */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontFamily: font.ui, fontSize: fs.body, color: color.text }}>{agent.name}</span>
        <span style={{ flex: 1 }} />
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: fs.sm, color: color.text3 }}>
          profile
          {/* Assign / clear the Profile — it supplies the spawn role/rig; the prompt comes from the agent. */}
          <Select value={agent.profileId ?? ""} onChange={(e) => onAssignProfile(e.target.value || null)} style={{ maxWidth: 220 }}
            data-testid={`agent-profile-${agent.id}`}>
            <option value="">— none —</option>
            {ordinaryProfiles.map((p) => (
              <option key={p.id} value={p.id}>{p.icon ? `${p.icon} ` : ""}{p.name}{p.role ? ` (${p.role})` : ""}</option>
            ))}
            {plainBindProfiles.length > 0 && (
              <optgroup label={PLAIN_BIND_GROUP_LABEL}>
                {plainBindProfiles.map((p) => (
                  <option key={p.id} value={p.id}>{p.icon ? `${p.icon} ` : ""}{p.name}{p.role ? ` (${p.role})` : ""}</option>
                ))}
              </optgroup>
            )}
          </Select>
        </label>
        {/* Permanently delete this agent (cascades its sessions). Disabled while it has a live session —
            the server blocks it too ("stop the fleet first"). Behind a confirm. */}
        <Button variant="danger" disabled={live || deleting} data-testid={`agent-delete-${agent.id}`}
          title={live ? "stop the fleet first — this agent has a live session" : "permanently delete this agent and its sessions"}
          onClick={() => { if (window.confirm(`Permanently delete agent "${agent.name}" and ALL its sessions? This cannot be undone.`)) onDelete(); }}>
          {deleting ? "Deleting…" : "Delete agent"}
        </Button>
      </div>
      {boundBindsPlain && (
        <div data-testid="agent-profile-plain-bind" style={{ display: "flex", alignItems: "baseline", gap: 6, color: color.attnText, fontSize: fs.sm, lineHeight: 1.5 }}>
          <span aria-hidden style={{ fontFamily: font.mono }}>△</span>
          <span>This profile's role isn't one a profile can confer, so sessions from this agent spawn plain.</span>
        </div>
      )}
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontFamily: font.ui, fontSize: fs.sm, color: color.text2 }}>Startup prompt</span>
        <span style={{ color: color.text3, fontSize: fs.sm }}>injected as the first turn of each new session</span>
      </div>
      {/* ⌘/Ctrl+Enter saves, from the one shared handler AgentPromptEditor uses (lib/modEnter.ts) — the
          same gate as the Save button beside it, so the keyboard can never write what the button won't. */}
      <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} spellCheck={false}
        onKeyDown={modEnterSubmit(dirty && !saving, savePrompt)}
        data-testid={`agent-prompt-${agent.id}`} aria-label="Startup prompt" placeholder={PROMPT_PLACEHOLDER}
        style={{
          ...PROMPT_FIELD_SIZE,
          fontFamily: font.ui, fontSize: fs.body, lineHeight: 1.5,
          background: color.inset, color: color.text, border: `1px solid ${color.line}`, borderRadius: radius.sm, padding: 8,
        }} />
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Button variant="primary" disabled={!dirty || saving} data-testid={`agent-save-${agent.id}`}
          title="Save the startup prompt (⌘/Ctrl+Enter)"
          onClick={savePrompt}>{saving ? "Saving…" : "Save"}</Button>
        {dirty
          ? <Button onClick={() => setPrompt(seed)}>Reset</Button>
          : promptShowsSaved && <span data-testid={`agent-prompt-saved-${agent.id}`} style={{ color: color.liveFg, fontSize: fs.sm }}>saved</span>}
        {conflict && (
          <span data-testid="agent-prompt-conflict" style={{ color: color.attnText, fontSize: fs.sm, lineHeight: 1.5 }}>
            This prompt changed elsewhere since you opened it — Save replaces it with your version, Reset takes theirs.
          </span>
        )}
      </div>

      {/* Credential grants (card caca806c): which P1 connections this AGENT may call authenticated_request
          with, plus any credential-bound capability grant — ids only, never a secret. HUMAN-set HERE ONLY,
          same stricter trust posture the Profile editor's own connections/capabilities fields carry (not
          even the Setup Assistant / Platform Lead's own agent_update tool may touch this field). */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 4 }}>
        <span style={{ fontFamily: font.ui, fontSize: fs.sm, color: color.text2 }}>Credential grants</span>
        <span style={{ color: color.text3, fontSize: fs.sm }}>reach ONLY this agent — a sibling on the same profile never sees them</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontSize: fs.sm, color: color.text2 }}>
          Connections <span style={{ fontWeight: 400, color: color.text3 }}>· {connections.length === 0 ? "none selected → NO authenticated_request access (default)" : `${connections.length} selected → authenticated_request may use only these`}</span>
        </span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {availableConnections.map((c) => {
            const on = connections.includes(c.id);
            return (
              <button key={c.id} type="button" onClick={() => toggleConnection(c.id)}
                data-testid={`agent-connection-${agent.id}-${c.id}`}
                style={{ cursor: "pointer", fontFamily: font.ui, fontSize: fs.sm, padding: "3px 9px", borderRadius: radius.lg,
                  border: `1px solid ${on ? color.accentEdge : color.line}`, background: on ? color.inset : "transparent",
                  color: on ? color.accentFg : color.text3 }}>
                {/* Metadata only — name, target, scheme. ConnectionMetadata carries no key field to render. */}
                {on ? "✓ " : ""}{c.name} <span style={{ opacity: 0.7, fontFamily: font.mono }}>({c.authScheme === "ssh" ? `${c.user}@${c.host}` : c.host})</span>
                {c.authScheme === "ssh" && <span style={{ marginLeft: 6, fontSize: fs.xs, opacity: 0.8 }}>ssh</span>}
              </button>
            );
          })}
          {availableConnections.length === 0 && <span style={{ color: color.text3, fontSize: fs.sm }}>No connections in the credential store yet — add one in Settings.</span>}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span style={{ fontSize: fs.sm, color: color.text2 }}>Capabilities</span>
        {availableCapabilities.map((c) => {
          const checked = capabilities.some((g) => g.slug === c.slug);
          return (
            <label key={c.slug} style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
              <input type="checkbox" checked={checked} onChange={() => toggleCapability(c.slug)} style={{ marginTop: 2 }}
                data-testid={`agent-capability-${agent.id}-${c.slug}`} />
              <span style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
                <span style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <span style={{ fontSize: fs.body, color: color.text }}>{c.name}</span>
                  {c.requiresConnection && <Badge tone="muted">needs connection</Badge>}
                </span>
                {checked && c.requiresConnection && (
                  <>
                    <Select value={capabilityConnectionId(c.slug)} onChange={(e) => setCapabilityConnectionId(c.slug, e.target.value)} style={{ marginTop: 4, maxWidth: 260 }}>
                      <option value="">— pick a connection —</option>
                      {/* An api-key/bearer ALLOWLIST (matching the daemon's own RAW_SECRET_AUTH_SCHEMES) —
                          a requiresConnection grant statically injects a secret at spawn, which only
                          api-key/bearer support; oauth2/ssh never resolve through this seam. */}
                      {availableConnections.filter((conn) => conn.authScheme === "api-key" || conn.authScheme === "bearer").map((conn) => (
                        <option key={conn.id} value={conn.id}>{conn.name}</option>
                      ))}
                    </Select>
                    {availableConnections.some((conn) => conn.authScheme !== "api-key" && conn.authScheme !== "bearer") && (
                      <span style={{ fontSize: fs.sm, color: color.text3 }}>
                        oauth2/ssh connections aren't listed — they can't be statically injected here.
                      </span>
                    )}
                  </>
                )}
              </span>
            </label>
          );
        })}
        {/* Three distinct states a bare "length === 0" collapsed into one misleading "Loading…" label:
            genuinely still loading, the query errored (never resolves on its own), or the catalog
            loaded fine but is empty once the two reserved legacy slugs are filtered out above. */}
        {capabilityList.isLoading ? (
          <span style={{ color: color.text3, fontSize: fs.sm }}>Loading capability catalog…</span>
        ) : capabilityList.isError ? (
          <span role="alert" style={{ color: color.danger, fontSize: fs.sm }}>Could not load the capability catalog: {errorText(capabilityList.error as Error)}</span>
        ) : availableCapabilities.length === 0 ? (
          <span style={{ color: color.text3, fontSize: fs.sm }}>No capabilities in the registry yet — add one in Settings.</span>
        ) : null}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Button variant="primary" disabled={!grantsDirty || savingGrants} data-testid={`agent-grants-save-${agent.id}`}
          onClick={saveGrantsNow}>{savingGrants ? "Saving…" : "Save grants"}</Button>
        {grantsDirty
          ? <Button onClick={() => { setConnections(grantSync.seed.connections); setCapabilities(grantSync.seed.capabilities); }}>Reset</Button>
          : grantsShowSaved && <span data-testid={`agent-grants-saved-${agent.id}`} style={{ color: color.liveFg, fontSize: fs.sm }}>saved</span>}
        {grantsConflict && (
          <span data-testid={`agent-grants-conflict-${agent.id}`} style={{ color: color.attnText, fontSize: fs.sm, lineHeight: 1.5 }}>
            Grants changed elsewhere since you opened this — Save replaces them with your version, Reset takes theirs.
          </span>
        )}
      </div>
      {/* The daemon's refusal already names the offending field AND the remedy (cross-project grant,
          oauth2/ssh binding, a reserved legacy slug) — shown verbatim, same placement as the Profile
          editor's own save-error line (pages/Profiles.tsx). */}
      {scopedGrantsError && (
        <span data-testid={`agent-grants-error-${agent.id}`} role="alert" style={{ color: color.danger, fontSize: fs.sm, lineHeight: 1.5 }}>
          {errorText(scopedGrantsError)}
        </span>
      )}
    </div>
  );
}
