// Card policies in the classic UI (card 61d32daf, epic 8b6c750a): the Settings editor, the card-drawer Policy block
// and the board badge. The daemon evaluates; these surfaces author (human-only config PATCH), show the verdict the
// daemon returns, and record or revoke a waiver through the human-only REST route. Pure shaping lives in
// lib/cardPolicies.ts.
import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project } from "@loom/shared";
import { api } from "../lib/api";
import { errorText } from "../lib/loopbackCredential";
import {
  CONVENTIONAL_TYPES, POLICY_REQUIREMENT_KINDS, REQUIREMENT_COPY, STATUS_COPY,
  blockingCount, buildPolicies, canWaive, draftsFromStored, draftsSignature, emptyDraft, hasStoredCardPolicies,
  previewIds, requirementLabel,
  type CardPolicyCardStatus, type CardPolicyDraft, type CardPolicyVerdict,
} from "../lib/cardPolicies";
import { color, font, fs, radius, tone, toneSoft, toneText } from "../theme";
import { Button, Dot, Input, StatusPill } from "./ui";

// ── Queries ──────────────────────────────────────────────────────────────────────────────────────────

/** The board badge counts. Off (no request at all) for a project that stores no policy. */
export function useCardPolicyStatus(projectId: string | null | undefined, project: Pick<Project, "config"> | null | undefined) {
  const enabled = !!projectId && hasStoredCardPolicies(project?.config?.orchestration as { cardPolicies?: unknown } | undefined);
  return useQuery({
    queryKey: ["cardPolicyStatus", projectId],
    queryFn: () => api.cardPolicyStatus(projectId!),
    enabled,
    // Slower than the board's 4s: every badge is one evaluation per card. A waiver invalidates it directly.
    refetchInterval: 10_000,
    retry: false,
  });
}

// ── Board badge ──────────────────────────────────────────────────────────────────────────────────────

/** "2 unmet" on a board card. Renders nothing unless a requirement would block the card today. */
export function CardPolicyBadge({ status }: { status: CardPolicyCardStatus | undefined }) {
  if (!status || status.blocking === 0) return null;
  const n = status.blocking;
  return (
    <span data-testid="card-policy-badge"
      title={`${n} card-policy requirement${n === 1 ? "" : "s"} unmet. Open the card to see which.`}
      style={{ flexShrink: 0, fontFamily: font.ui, fontSize: fs.xs, fontWeight: 600, borderRadius: radius.pill,
        padding: "1px 7px", lineHeight: "16px", color: toneText.danger, background: toneSoft.danger }}>
      {n} unmet
    </span>
  );
}

// ── Drawer block ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The card's policy verdict, one row per requirement, with the owner's Waive / Un-waive. Renders nothing when no
 * policy applies (no placeholder: most cards carry none). A failed read says so instead of reading as "no policy".
 */
export function CardPolicyBlock({ taskId, projectId }: { taskId: string; projectId: string }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["taskPolicy", taskId],
    queryFn: () => api.taskPolicy(taskId),
    refetchInterval: 4000,
    retry: false,
  });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["taskPolicy", taskId] });
    void qc.invalidateQueries({ queryKey: ["cardPolicyStatus", projectId] });
  };
  if (q.isError && !q.data) {
    return (
      <div data-testid="card-policy-unavailable" style={{ display: "flex", alignItems: "center", gap: 6, color: color.text3, fontFamily: font.mono, fontSize: fs.xs }}>
        <Dot tone="attn" />
        <span>card policy unavailable: couldn’t read this card’s requirements (retrying…)</span>
      </div>
    );
  }
  const view = q.data?.policy ?? [];
  if (view.length === 0) return null;
  const blocking = blockingCount(view);
  // With nothing blocking, a merge-time requirement is still unchecked, so the summary must not read as all-clear.
  const pending = view.some((v) => v.status === "deferred");
  const policies = [...new Map(view.map((v) => [v.policyId, v.policy])).entries()];
  return (
    <section data-testid="card-policy-block" aria-label="Card policy"
      style={{ border: `1px solid ${blocking ? color.dangerLine : color.line}`, borderRadius: radius.base, padding: "10px 12px",
        display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontFamily: font.ui, fontSize: fs.sm, fontWeight: 600, color: color.text }}>Card policy</span>
        <StatusPill data-testid="card-policy-summary" tone={blocking ? "danger" : pending ? "muted" : "live"}
          label={blocking ? `${blocking} unmet` : pending ? "Nothing blocking yet" : "Nothing blocking"} />
      </div>
      {policies.map(([policyId, policyName]) => (
        <div key={policyId} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontFamily: font.ui, fontSize: fs.sm, color: color.text2 }}>
            {policyName}{policyName !== policyId && <span style={{ fontFamily: font.mono, fontSize: fs.xs, color: color.text3 }}> · {policyId}</span>}
          </div>
          {view.filter((v) => v.policyId === policyId).map((v) => (
            <RequirementRow key={`${v.policyId}:${v.requirement}`} taskId={taskId} v={v} onChanged={invalidate} />
          ))}
        </div>
      ))}
    </section>
  );
}

function RequirementRow({ taskId, v, onChanged }: { taskId: string; v: CardPolicyVerdict; onChanged: () => void }) {
  const [waiving, setWaiving] = useState(false);
  const [reason, setReason] = useState("");
  const reasonId = useId();
  const st = STATUS_COPY[v.status];
  const waive = useMutation({
    meta: { inlineError: true },
    mutationFn: () => api.waiveCardPolicy(taskId, { policyId: v.policyId, requirement: v.requirement as Exclude<typeof v.requirement, "config">, reason: reason.trim() }),
    onSuccess: () => { setWaiving(false); setReason(""); onChanged(); },
  });
  const revoke = useMutation({
    meta: { inlineError: true },
    mutationFn: () => api.revokeCardPolicyWaiver(taskId, { policyId: v.policyId, requirement: v.requirement as Exclude<typeof v.requirement, "config"> }),
    onSuccess: onChanged,
  });
  const phase = v.requirement === "config" ? null : REQUIREMENT_COPY[v.requirement].phase;
  const err = waive.error ?? revoke.error;
  return (
    <div data-testid={`card-policy-req-${v.policyId}-${v.requirement}`} data-status={v.status}
      style={{ display: "flex", flexDirection: "column", gap: 6, paddingLeft: 10, borderLeft: `2px solid ${tone[st.tone]}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <StatusPill tone={st.tone} label={st.label} />
        <span style={{ fontFamily: font.ui, fontSize: fs.sm, color: color.text, minWidth: 0 }}
          title={v.requirement === "config" ? undefined : REQUIREMENT_COPY[v.requirement].hint}>
          {requirementLabel(v.requirement)}
        </span>
        {/* A deferred row's pill already says when it is checked. */}
        {phase && v.status !== "deferred" && <span style={{ fontFamily: font.mono, fontSize: fs.xs, color: color.text3 }}>at {phase}</span>}
        <span style={{ flex: 1 }} />
        {canWaive(v) && !waiving && (
          <Button variant="ghost" onClick={() => setWaiving(true)}>Waive…</Button>
        )}
        {v.status === "waived" && (
          <Button variant="ghost" disabled={revoke.isPending} onClick={() => revoke.mutate()}>
            {revoke.isPending ? "Removing…" : "Remove waiver"}
          </Button>
        )}
      </div>
      {v.detail && v.status !== "waived" && v.status !== "deferred" && (
        <span style={{ fontFamily: font.mono, fontSize: fs.xs, color: color.text3, lineHeight: 1.45 }}>{v.detail}</span>
      )}
      {waiving && (
        <form onSubmit={(e) => { e.preventDefault(); if (reason.trim()) waive.mutate(); }}
          style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <label htmlFor={reasonId} style={{ fontFamily: font.ui, fontSize: fs.sm, color: color.text2 }}>Reason</label>
          <Input id={reasonId} autoFocus value={reason} maxLength={500} data-testid="card-policy-waive-reason"
            onChange={(e) => setReason(e.target.value)} placeholder="Why this card may skip the requirement"
            style={{ flex: "1 1 240px", minWidth: 0 }} />
          <Button type="submit" variant="primary" disabled={!reason.trim() || waive.isPending}>
            {waive.isPending ? "Waiving…" : "Waive requirement"}
          </Button>
          <Button type="button" onClick={() => { setWaiving(false); setReason(""); waive.reset(); }}>Cancel</Button>
        </form>
      )}
      {err && <span role="alert" style={{ fontFamily: font.mono, fontSize: fs.xs, color: color.danger }}>{errorText(err)}</span>}
    </div>
  );
}

// ── Settings editor ──────────────────────────────────────────────────────────────────────────────────

/**
 * Per-project rule list with its OWN save (like the board-column editor): the whole list is written through the
 * human config PATCH as `orchestration.cardPolicies`, and an empty list unsets the key. Agents can read these
 * policies but have no way to write them.
 */
export function CardPoliciesEditor({ project }: { project: Project }) {
  const qc = useQueryClient();
  const stored = (project.config?.orchestration as { cardPolicies?: unknown } | undefined)?.cardPolicies;
  const [seed, setSeed] = useState(() => draftsFromStored(stored));
  const [drafts, setDrafts] = useState<CardPolicyDraft[]>(() => (seed.ok ? seed.drafts : []));
  const [baseline, setBaseline] = useState(() => draftsSignature(seed.ok ? seed.drafts : []));
  const [justSaved, setJustSaved] = useState(false);
  const built = buildPolicies(drafts);
  // A corrupt stored list is always saveable, even as an empty draft: that save is the repair.
  const dirty = draftsSignature(drafts) !== baseline || !seed.ok;
  const ids = previewIds(drafts);

  const save = useMutation({
    meta: { inlineError: true },
    mutationFn: () => {
      if (!built.ok) throw new Error(built.error);
      return built.policies.length > 0
        ? api.updateProjectConfig(project.id, { orchestration: { cardPolicies: built.policies } })
        : api.updateProjectConfig(project.id, {}, ["orchestration.cardPolicies"]);
    },
    onSuccess: (saved) => {
      // Re-seed from what the daemon STORED: card ids come back resolved to full ids.
      const next = draftsFromStored((saved.config?.orchestration as { cardPolicies?: unknown } | undefined)?.cardPolicies);
      setSeed(next);
      const nextDrafts = next.ok ? next.drafts : [];
      setDrafts(nextDrafts);
      setBaseline(draftsSignature(nextDrafts));
      setJustSaved(true);
      void qc.invalidateQueries({ queryKey: ["projects"] });
      void qc.invalidateQueries({ queryKey: ["cardPolicyStatus", project.id] });
      void qc.invalidateQueries({ queryKey: ["taskPolicy"] });
    },
  });

  const update = (key: string, patch: Partial<CardPolicyDraft>) => {
    setJustSaved(false);
    setDrafts((ds) => ds.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  };
  const reset = () => {
    const again = draftsFromStored(stored);
    setSeed(again);
    setDrafts(again.ok ? again.drafts : []);
    setBaseline(draftsSignature(again.ok ? again.drafts : []));
    save.reset();
  };

  return (
    <div data-testid="card-policies-editor" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <p style={{ margin: 0, fontFamily: font.ui, fontSize: fs.sm, color: color.text2, lineHeight: 1.5, maxWidth: "70ch" }}>
        Require evidence before a worker is spawned onto, or merged from, a matching card. Only you can set these
        or waive one on a card; agents can read them.
      </p>
      {!seed.ok && (
        <div role="alert" style={{ fontFamily: font.mono, fontSize: fs.xs, color: color.attnText, lineHeight: 1.5 }}>
          The stored policy list can’t be read ({seed.error}), so every spawn and merge on a card of this project is
          refused. Saving below replaces it.
        </div>
      )}
      {drafts.length === 0 && (
        <div style={{ fontFamily: font.ui, fontSize: fs.sm, color: color.text3 }}>No card policies. Every card can be worked and merged without extra evidence.</div>
      )}
      {drafts.map((d, i) => (
        <PolicyRuleEditor key={d.key} draft={d} index={i} id={ids.get(d.key)!}
          onChange={(p) => update(d.key, p)}
          onRemove={() => { setJustSaved(false); setDrafts((ds) => ds.filter((x) => x.key !== d.key)); }} />
      ))}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Button variant="ghost" data-testid="card-policy-add" onClick={() => { setJustSaved(false); setDrafts((ds) => [...ds, emptyDraft()]); }}>
          Add policy
        </Button>
        <span style={{ flex: 1 }} />
        {dirty && !built.ok && (
          <span data-testid="card-policy-draft-error" style={{ fontFamily: font.mono, fontSize: fs.xs, color: color.attnText }}>{built.error}</span>
        )}
        {dirty && <Button onClick={reset} disabled={save.isPending}>Discard changes</Button>}
        {!dirty && justSaved && <span style={{ fontFamily: font.mono, fontSize: fs.xs, color: color.liveText }}>saved</span>}
        <Button variant="primary" data-testid="card-policy-save" disabled={!dirty || !built.ok || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save policies"}
        </Button>
      </div>
      {save.error && (
        <span role="alert" data-testid="card-policy-save-error" style={{ fontFamily: font.mono, fontSize: fs.xs, color: color.danger, lineHeight: 1.45 }}>
          {errorText(save.error)}
        </span>
      )}
    </div>
  );
}

const subLabel = { fontFamily: font.ui, fontSize: fs.sm, fontWeight: 600, color: color.text2 } as const;

function PolicyRuleEditor({ draft, index, id, onChange, onRemove }: {
  draft: CardPolicyDraft; index: number; id: string; onChange: (p: Partial<CardPolicyDraft>) => void; onRemove: () => void;
}) {
  const nameId = useId();
  const scopesId = useId();
  const cardsId = useId();
  const toggleType = (t: string) => onChange({ types: draft.types.includes(t) ? draft.types.filter((x) => x !== t) : [...draft.types, t] });
  const toggleReq = (k: (typeof POLICY_REQUIREMENT_KINDS)[number]) =>
    onChange({ require: draft.require.includes(k) ? draft.require.filter((x) => x !== k) : [...draft.require, k] });
  return (
    <fieldset data-testid={`card-policy-rule-${index}`}
      style={{ margin: 0, padding: "12px 0 0", border: "none", borderTop: `1px solid ${color.line}`, display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
      <legend className="sr-only" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
        {draft.name.trim() || `Policy ${index + 1}`}
      </legend>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <label htmlFor={nameId} style={subLabel}>Name</label>
        <Input id={nameId} value={draft.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="e.g. Reviewed web changes"
          data-testid="card-policy-name" style={{ flex: "1 1 220px", minWidth: 0, maxWidth: 360 }} />
        <span title={draft.id ? "The policy id refusals and waivers cite. Fixed once saved." : "Set from the name when you save."}
          style={{ fontFamily: font.mono, fontSize: fs.xs, color: color.text3 }}>
          id {id}{draft.id ? "" : " (new)"}
        </span>
        <span style={{ flex: 1 }} />
        <Button variant="ghost" onClick={onRemove} aria-label={`Remove ${draft.name.trim() || `policy ${index + 1}`}`}>Remove</Button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={subLabel}>Applies to card titles of type</span>
        <div role="group" aria-label="Conventional types" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {CONVENTIONAL_TYPES.map((t) => {
            const on = draft.types.includes(t);
            return (
              <button key={t} type="button" aria-pressed={on} onClick={() => toggleType(t)}
                data-testid={`card-policy-type-${t}`} className={`loom-toggle${on ? " is-active" : ""}`}
                style={{ fontFamily: font.mono, fontSize: fs.sm, fontWeight: on ? 600 : 500, padding: "3px 10px", borderRadius: radius.pill,
                  lineHeight: "16px", color: on ? toneText.accent : color.text2, background: on ? toneSoft.accent : "transparent",
                  border: `1px solid ${on ? tone.accent : color.line}` }}>
                {t}
              </button>
            );
          })}
        </div>
      </div>
      <div className="loom-field-grid loom-field-grid-2">
        <label htmlFor={scopesId} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={subLabel}>And scope</span>
          <Input id={scopesId} mono spellCheck={false} value={draft.scopes} onChange={(e) => onChange({ scopes: e.target.value })}
            placeholder="web, daemon (blank = any scope)" data-testid="card-policy-scopes" />
        </label>
        <label htmlFor={cardsId} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={subLabel}>Or these cards</span>
          <Input id={cardsId} mono spellCheck={false} value={draft.cardIds} onChange={(e) => onChange({ cardIds: e.target.value })}
            placeholder="card ids, 8+ characters each" data-testid="card-policy-cards" />
        </label>
      </div>
      <span style={{ fontFamily: font.ui, fontSize: fs.xs, color: color.text3, lineHeight: 1.45 }}>
        A card matches when its title has a ticked type and, if you list scopes, one of those scopes. Listed cards always
        match. Once a card has matched, retitling it does not remove the policy.
      </span>
      <div role="group" aria-label="Requirements" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={subLabel}>Requires</span>
        {POLICY_REQUIREMENT_KINDS.map((k) => (
          <label key={k} title={REQUIREMENT_COPY[k].hint} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontFamily: font.ui, fontSize: fs.sm, color: color.text }}>
            <input type="checkbox" checked={draft.require.includes(k)} onChange={() => toggleReq(k)} data-testid={`card-policy-require-${k}`}
              style={{ accentColor: color.accent, width: 15, height: 15, margin: 0 }} />
            <span>{REQUIREMENT_COPY[k].label}</span>
            <span style={{ fontFamily: font.mono, fontSize: fs.xs, color: color.text3 }}>at {REQUIREMENT_COPY[k].phase}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
