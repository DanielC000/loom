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
import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { profileRoleBindsAsPlainSession, type Agent, type SessionRole } from "@loom/shared";
import { api } from "../lib/api";
import { Button, Input, Select } from "./ui";
import { isDevLayerRole } from "../lib/roleDisplay";
import { useFormSync } from "../lib/useFormSync";
import { color, font } from "../theme";

// The one wording for a profile whose role the spawn would clamp away — stated as the consequence ("what
// do I get"), not the mechanism. One constant so all three places that disclose it can never word it
// differently: the bind dropdown's <optgroup>, the inline note below the select (shown once the collapsed
// <select> hides that group), and the agent list row's tooltip (card 57deed24).
export const PLAIN_BIND_GROUP_LABEL = "role not conferred — binds as a plain session";

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
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteAgent(id),
    onSuccess: (_r, id) => {
      invalidateAgents();
      qc.invalidateQueries({ queryKey: ["allSessions"] });
      hooks.onDeleted?.(id);
    },
  });
  return { create, update, remove };
}

/**
 * The CREATE form — a name and the startup prompt, nothing else. A fresh agent gets its rig on the
 * editor below, not here: asking which capabilities to bind before the agent exists puts that choice
 * in front of someone who has not yet said what the agent is for.
 */
export function AgentForm({ onCreate, pending, onCancel }: { onCreate: (b: { name: string; startupPrompt: string }) => void; pending: boolean; onCancel: () => void }) {
  const [name, setName] = useState(""), [startupPrompt, setPrompt] = useState("");
  // Fills its host's `fill` body: name at natural height, the prompt textarea grows (`flex:1`) to take
  // the rest of the pane so a roomy frame is actually used, buttons pinned below.
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1, minHeight: 0 }} data-testid="agent-create-form">
      <Input placeholder="agent name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Agent name" />
      <textarea
        style={{ flex: 1, minHeight: 200, width: "100%", boxSizing: "border-box", resize: "none", background: color.panel2, color: color.text, border: `1px solid ${color.borderStrong}`, borderRadius: 4, padding: 8, fontFamily: font.mono, fontSize: 13, lineHeight: 1.5 }}
        placeholder="startup prompt (injected as the first turn of each new session)"
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
  { agent, profiles, isDev, liveCount, onAssignProfile, onSavePrompt, onDelete, saving, deleting }:
  { agent: Agent; profiles: EditorProfile[]; isDev: boolean;
    liveCount: number; onAssignProfile: (profileId: string | null) => void; onSavePrompt: (startupPrompt: string) => void;
    onDelete: () => void; saving: boolean; deleting: boolean },
) {
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
      {/* Editor header: identity + profile assignment + delete */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontFamily: font.head, fontSize: 14, color: color.text }}>{agent.name}</span>
        <span style={{ flex: 1 }} />
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>
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
        <div data-testid="agent-profile-plain-bind" style={{ display: "flex", alignItems: "baseline", gap: 6, color: color.amber, fontFamily: font.mono, fontSize: 11, lineHeight: 1.5 }}>
          <span aria-hidden>△</span>
          <span>This profile's role isn't one a profile can confer, so sessions from this agent spawn plain.</span>
        </div>
      )}
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontFamily: font.head, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: color.textDim }}>Startup prompt</span>
        <span style={{ color: color.textMuted, fontSize: 12, fontFamily: font.mono }}>injected as the first turn of each new session</span>
      </div>
      <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} spellCheck={false}
        data-testid={`agent-prompt-${agent.id}`}
        style={{
          flex: 1, minHeight: 0, width: "100%", boxSizing: "border-box", resize: "none",
          fontFamily: font.mono, fontSize: 13, lineHeight: 1.5,
          background: color.panel2, color: color.text, border: `1px solid ${color.border}`, borderRadius: 6, padding: 8,
        }} />
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Button variant="primary" disabled={!dirty || saving} data-testid={`agent-save-${agent.id}`}
          onClick={() => onSavePrompt(prompt)}>{saving ? "Saving…" : "Save"}</Button>
        {dirty
          ? <Button onClick={() => setPrompt(seed)}>Reset</Button>
          : <span style={{ color: color.phosphor, fontSize: 12, fontFamily: font.mono }}>saved</span>}
        {conflict && (
          <span data-testid="agent-prompt-conflict" style={{ color: color.amber, fontSize: 11, fontFamily: font.mono, lineHeight: 1.5 }}>
            This prompt changed elsewhere since you opened it — Save replaces it with your version, Reset takes theirs.
          </span>
        )}
      </div>
    </div>
  );
}
