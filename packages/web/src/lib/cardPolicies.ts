// Card policies in the board UI (card 61d32daf, epic 8b6c750a): the pure half behind the Settings editor, the
// card-drawer Policy block and the board badge (components/cardPolicies.tsx).
//
// The daemon is the only evaluator. Everything here either SHAPES what the human writes (the editor's drafts →
// the `orchestration.cardPolicies` list the config PATCH stores) or LABELS a verdict the daemon already computed
// (`GET /api/tasks/:id/policy`, the same view tasks_get carries). Nothing here decides met/unmet.
import {
  CONVENTIONAL_TYPES, POLICY_REQUIREMENT_KINDS, parseCardPolicies,
  type CardPolicy, type PolicyRequirement, type PolicyRequirementKind,
} from "@loom/shared";
import type { Tone } from "../theme";

export { CONVENTIONAL_TYPES, POLICY_REQUIREMENT_KINDS };

/** One requirement's verdict, as the daemon's `policyView` returns it. `config` is the synthetic row for an unreadable stored list. */
export type CardPolicyStatus = "met" | "unmet" | "unreadable" | "waived" | "deferred";
export interface CardPolicyVerdict {
  policyId: string;
  policy: string;
  requirement: PolicyRequirementKind | "config";
  status: CardPolicyStatus;
  detail: string;
}
/** One card's entry in `GET /api/projects/:id/card-policy-status` (cards no policy applies to are absent). */
export interface CardPolicyCardStatus { blocking: number; total: number }

/** What each requirement proves, and when Loom checks it. The label names exactly what is proven, never more. */
export const REQUIREMENT_COPY: Record<PolicyRequirementKind, { label: string; phase: "spawn" | "merge"; hint: string }> = {
  "approved-request": {
    label: "Permission Request you approved",
    phase: "spawn",
    hint: "A permission Request linked to the card that you authorized in the Requests inbox. Checked before a worker is spawned onto the card.",
  },
  "code-review-report": {
    label: "Code Review report on the merged tip",
    phase: "merge",
    hint: "A reviewer's done report on the exact branch tip being merged. Proves a review ran, not that it passed.",
  },
  "investigate-checkpoint": {
    label: "Plan checkpoint before the first commit",
    phase: "merge",
    hint: "The worker reported its plan (blocked or progress) before its first commit. Checked at merge.",
  },
};

export function requirementLabel(kind: CardPolicyVerdict["requirement"]): string {
  return kind === "config" ? "Readable policy configuration" : REQUIREMENT_COPY[kind].label;
}

/** Status → the word and tone the UI shows. `deferred` is a merge-time requirement the read-only view does not evaluate. */
export const STATUS_COPY: Record<CardPolicyStatus, { label: string; tone: Tone }> = {
  met: { label: "Met", tone: "live" },
  unmet: { label: "Unmet", tone: "danger" },
  unreadable: { label: "Unreadable", tone: "busy" },
  waived: { label: "Waived", tone: "muted" },
  deferred: { label: "Checked at merge", tone: "info" },
};

/** Requirements that would refuse the action today: unmet or unreadable (fail closed). */
export function blockingCount(view: readonly CardPolicyVerdict[]): number {
  return view.filter((v) => v.status === "unmet" || v.status === "unreadable").length;
}

/** A verdict the owner may waive (a real requirement, not yet waived, not already met). */
export function canWaive(v: CardPolicyVerdict): boolean {
  return v.requirement !== "config" && v.status !== "waived" && v.status !== "met";
}

/** True when the project STORES a policy list worth reading (an unparseable value counts: it fails closed on every card). */
export function hasStoredCardPolicies(orchestration: { cardPolicies?: unknown } | undefined): boolean {
  const raw = orchestration?.cardPolicies;
  return raw !== undefined && !(Array.isArray(raw) && raw.length === 0);
}

// ── Editor drafts ───────────────────────────────────────────────────────────────────────────────────

/** One editable rule. `id` is null until first save (minted from the name); a saved id never changes, since waivers and refusals cite it. */
export interface CardPolicyDraft {
  key: string;
  id: string | null;
  name: string;
  types: string[];
  /** Free text, split on commas/whitespace. */
  scopes: string;
  cardIds: string;
  require: PolicyRequirementKind[];
  /** The stored requirement objects, so a field the editor does not show (approved-request's `requestKind`) survives a save. */
  stored: PolicyRequirement[];
}

let draftSeq = 0;
const nextKey = (): string => `policy-draft-${++draftSeq}`;

export function emptyDraft(): CardPolicyDraft {
  return { key: nextKey(), id: null, name: "", types: [], scopes: "", cardIds: "", require: [], stored: [] };
}

/** The stored list as drafts. An unparseable stored value is reported, never silently replaced by an empty editor. */
export function draftsFromStored(raw: unknown): { ok: true; drafts: CardPolicyDraft[] } | { ok: false; error: string } {
  const parsed = parseCardPolicies(raw);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return {
    ok: true,
    drafts: parsed.policies.map((p) => ({
      key: nextKey(), id: p.id, name: p.name ?? "",
      types: p.match.types ?? [], scopes: (p.match.scopes ?? []).join(", "), cardIds: (p.match.cardIds ?? []).join(", "),
      require: p.require.map((r) => r.kind), stored: p.require,
    })),
  };
}

export function splitList(text: string): string[] {
  return text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

/** A stable, readable id for a new rule: its name as a slug, suffixed until unique. */
export function mintPolicyId(name: string, taken: ReadonlySet<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "policy";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** What a new (unsaved) draft's id WILL be, for the editor's preview. */
export function previewIds(drafts: readonly CardPolicyDraft[]): Map<string, string> {
  const taken = new Set(drafts.flatMap((d) => (d.id ? [d.id] : [])));
  const out = new Map<string, string>();
  for (const d of drafts) {
    if (d.id) { out.set(d.key, d.id); continue; }
    const id = mintPolicyId(d.name, taken);
    taken.add(id);
    out.set(d.key, id);
  }
  return out;
}

function draftLabel(d: CardPolicyDraft, i: number): string {
  return d.name.trim() ? `"${d.name.trim()}"` : `Policy ${i + 1}`;
}

/**
 * Drafts → the list the config PATCH stores, checked by the SAME shared parser the daemon uses, so a draft that
 * would 400 says why before it is sent. Card ids are sent as typed; the daemon resolves each to a full id on write.
 */
export function buildPolicies(drafts: readonly CardPolicyDraft[]): { ok: true; policies: CardPolicy[] } | { ok: false; error: string } {
  const ids = previewIds(drafts);
  const out: CardPolicy[] = [];
  for (const [i, d] of drafts.entries()) {
    const types = CONVENTIONAL_TYPES.filter((t) => d.types.includes(t));
    const scopes = splitList(d.scopes);
    const cardIds = splitList(d.cardIds);
    if (types.length === 0 && scopes.length === 0 && cardIds.length === 0) {
      return { ok: false, error: `${draftLabel(d, i)}: pick at least one type, scope or card it applies to.` };
    }
    if (d.require.length === 0) return { ok: false, error: `${draftLabel(d, i)}: tick at least one requirement.` };
    const require = POLICY_REQUIREMENT_KINDS.filter((k) => d.require.includes(k))
      .map((k) => d.stored.find((r) => r.kind === k) ?? ({ kind: k } as PolicyRequirement));
    const name = d.name.trim();
    out.push({
      id: ids.get(d.key)!,
      ...(name ? { name } : {}),
      match: { ...(types.length ? { types } : {}), ...(scopes.length ? { scopes } : {}), ...(cardIds.length ? { cardIds } : {}) },
      require,
    });
  }
  const checked = parseCardPolicies(out);
  return checked.ok ? { ok: true, policies: checked.policies } : { ok: false, error: checked.error };
}

/** A draft list's comparable shape (key-free), for the editor's dirty state. */
export function draftsSignature(drafts: readonly CardPolicyDraft[]): string {
  return JSON.stringify(drafts.map((d) => [d.id, d.name.trim(), [...d.types].sort(), splitList(d.scopes), splitList(d.cardIds), [...d.require].sort()]));
}
