// Card 9623e943 (epic 8b6c750a) — card-policy enforcement: the pure evaluator.
//
// @decision 9623e943 — `evaluateCardPolicies` is the ONLY reader of `orchestration.cardPolicies` for
// enforcement. It parses the RAW stored override, never `resolveConfig().orchestration.cardPolicies` (which
// silently degrades an invalid list to the default). Unreadable config or evidence fails CLOSED.
import { parseCardPolicies, PERMISSION_ANSWERS, type CardPolicy, type PolicyRequirement, type PolicyRequirementKind } from "@loom/shared";
import { cardPolicyMatches } from "../tasks/title-guard.js";
import { isSshApprovalAction, isPermissionLapsed } from "../mcp/questionTool.js";
import { resolveIdPrefix } from "../id-prefix.js";

export type PolicyPhase = "spawn" | "merge";
/** Requirement kinds enforced at each phase; the other phase's kinds report `deferred` (visible, not blocking). */
export const POLICY_PHASE_KINDS: Record<PolicyPhase, readonly PolicyRequirementKind[]> = {
  spawn: ["approved-request"],
  merge: ["code-review-report", "investigate-checkpoint"],
};
export type RequirementStatus = "met" | "unmet" | "unreadable" | "waived" | "deferred";
export interface RequirementVerdict {
  policyId: string;
  policyName: string;
  /** `config` is the synthetic verdict for an unreadable stored `cardPolicies` list. */
  kind: PolicyRequirementKind | "config";
  status: RequirementStatus;
  /** Evidence-reader detail (what was found / why unreadable). */
  detail: string;
}
export interface PolicyEvaluation {
  verdicts: RequirementVerdict[];
  /** The verdicts that block the action: `unmet` or `unreadable`. */
  blocking: RequirementVerdict[];
}
export interface EvidenceResult { met: boolean; detail?: string }
/** Injected evidence readers. A reader that THROWS yields `unreadable` (fail closed). */
export interface PolicyEvidence {
  authorizedPermissionRequest(taskId: string): EvidenceResult | Promise<EvidenceResult>;
  codeReview(taskId: string): EvidenceResult | Promise<EvidenceResult>;
  checkpoint(taskId: string): EvidenceResult | Promise<EvidenceResult>;
  waived(taskId: string, policyId: string, kind: PolicyRequirementKind): boolean | Promise<boolean>;
}

/** Fixed label per requirement kind, naming exactly what is proven (not more). */
export const REQUIREMENT_LABEL: Record<PolicyRequirementKind | "config", string> = {
  "approved-request": "an owner-authorized permission Request linked to this card",
  "code-review-report": "a Code Review report (a review ran; not that it passed) on this card's CURRENT branch tip",
  "investigate-checkpoint": "a worker_report checkpoint (blocked or progress) before the first commit",
  config: "a readable card-policy configuration",
};

/** Appended to the kickoff of a tasked spawn whose card carries an (unwaived) investigate-checkpoint requirement. One constant; doctrine points here, never restates it. */
export const INVESTIGATE_CHECKPOINT_KICKOFF_PARAGRAPH =
  "CARD POLICY — investigate first: before you edit or commit anything, report your plan with worker_report (status \"blocked\" or \"progress\") and STOP until your manager replies. A plan written only as chat prose does not count; the merge is refused without that report preceding your first commit.";

/**
 * The ONE implementation of the two DB-only evidence readers (permission-Request approval + waivers), shared by
 * the spawn/merge sites in sessions/service.ts and the read-only `policy` view in mcp/tasks.ts.
 * A Request counts ONLY when it is type "permission", state answered|consumed, and chosenOption is
 * PERMISSION_ANSWERS[0] ("authorize"): an answered decision/input Request has no structured affirmative and never
 * counts (a "reject" option must not pass). A grant whose DECIDED expiry (`decidedExpiresAt`) has lapsed does not
 * count; "once" is not consumed by a spawn (the approval is per card, not per action).
 *
 * @decision 9623e943 — the affirmative predicate is permission-only on purpose; never widen it to free text.
 */
type PolicyQuestionRow = { type: string; state: string; chosenOption: string | null; decidedExpiresAt?: string | null; answeredVia?: "human" | null; permissionAction?: string | null };

/**
 * The ONE affirmative predicate, shared by the per-card reader and the batched board reader (card f9a774c4): a
 * second copy would let the two drift, and the human-path check below is the trust boundary (an agent can write
 * `chosenOption` through question_resolve, so only a human-path answer counts).
 */
function permissionRequestAuthorizes(q: PolicyQuestionRow, nowMs: number): boolean {
  const lapsed = isPermissionLapsed(q.decidedExpiresAt ?? null, nowMs); // the ONE shared lapse predicate (an unparseable value fails closed as lapsed)
  return q.type === "permission" && (q.state === "answered" || q.state === "consumed") && q.chosenOption === PERMISSION_ANSWERS[0] && q.answeredVia === "human" && !isSshApprovalAction(q.permissionAction) && !lapsed;
}
const NO_AUTHORIZING_REQUEST = "no answered permission Request with an affirmative answer is linked to this card";

export function dbPolicyEvidence(
  db: { listQuestionsForTask(projectId: string, taskId: string): PolicyQuestionRow[]; listCardPolicyWaivers(taskId: string, projectId: string): { policyId: string; requirementKind: string }[] },
  projectId: string,
  nowMs: () => number = Date.now,
): Pick<PolicyEvidence, "authorizedPermissionRequest" | "waived"> {
  return {
    authorizedPermissionRequest: (taskId) => {
      const hit = db.listQuestionsForTask(projectId, taskId).some((q) => permissionRequestAuthorizes(q, nowMs()));
      return { met: hit, detail: hit ? "" : NO_AUTHORIZING_REQUEST };
    },
    waived: (taskId, policyId, kind) => db.listCardPolicyWaivers(taskId, projectId).some((w) => w.policyId === policyId && w.requirementKind === kind),
  };
}

/**
 * Card f9a774c4 — {@link dbPolicyEvidence} for the board's whole-project read: both DB evidence sets are fetched ONCE
 * (project-keyed, `project_id = ?`) instead of per card. Same answers per card as the per-card reader: the question
 * lookup mirrors `listQuestionsForTask`'s WHERE (exact `task_id`, or a legacy 8-char prefix followed by `-`, matched
 * case-insensitively like its LIKE) and the affirmative check is the shared {@link permissionRequestAuthorizes}.
 */
export function batchedDbPolicyEvidence(
  db: { listAnsweredPermissionQuestionsForProject(projectId: string): Map<string, PolicyQuestionRow[]>; listCardPolicyWaiversForProject(projectId: string): Map<string, { policyId: string; requirementKind: string }[]> },
  projectId: string,
  nowMs: () => number = Date.now,
): Pick<PolicyEvidence, "authorizedPermissionRequest" | "waived"> {
  const byTask = db.listAnsweredPermissionQuestionsForProject(projectId);
  const waivers = db.listCardPolicyWaiversForProject(projectId);
  const byLegacyPrefix = new Map<string, PolicyQuestionRow[]>();
  for (const [k, rows] of byTask) if (k.length === 8) byLegacyPrefix.set(k.toLowerCase(), [...(byLegacyPrefix.get(k.toLowerCase()) ?? []), ...rows]);
  return {
    authorizedPermissionRequest: (taskId) => {
      const now = nowMs();
      const legacy = taskId.length > 8 && taskId[8] === "-" ? byLegacyPrefix.get(taskId.slice(0, 8).toLowerCase()) : undefined;
      const hit = (byTask.get(taskId) ?? []).some((q) => permissionRequestAuthorizes(q, now)) || (legacy ?? []).some((q) => permissionRequestAuthorizes(q, now));
      return { met: hit, detail: hit ? "" : NO_AUTHORIZING_REQUEST };
    },
    waived: (taskId, policyId, kind) => (waivers.get(taskId) ?? []).some((w) => w.policyId === policyId && w.requirementKind === kind),
  };
}

/**
 * True when `policyId` names a policy in the project's RAW stored `cardPolicies` list (the waiver route refuses a
 * waiver for a policy that does not exist). An unreadable or absent list answers false.
 */
export function policyIdIsConfigured(project: { config?: unknown }, policyId: string): boolean {
  const raw = (project.config as { orchestration?: { cardPolicies?: unknown } } | undefined)?.orchestration?.cardPolicies;
  const parsed = parseCardPolicies(raw);
  return parsed.ok && parsed.policies.some((p) => p.id === policyId);
}

const FULL_TASK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Card 61d32daf — resolve every `match.cardIds` entry of a policy list being WRITTEN to the full id of one existing
 * task (an exact id, or an unambiguous 8+-char prefix, via the shared `resolveIdPrefix`), refusing an unknown or
 * ambiguous entry. `tasks` is the writing project's own board, so a card on another project never resolves. Run by
 * the human config PATCH before it stores the list, so a stored entry always names one real card and a card created
 * later with the same prefix is never captured by the matcher's `startsWith`. Duplicate resolutions collapse to one.
 */
export function resolveCardPolicyCardIds(
  policies: readonly CardPolicy[],
  tasks: readonly { id: string }[],
  storedCardIds?: ReadonlyMap<string, ReadonlySet<string>>,
): { ok: true; policies: CardPolicy[] } | { ok: false; error: string } {
  const out: CardPolicy[] = [];
  for (const p of policies) {
    if (!p.match.cardIds) { out.push(p); continue; }
    const full: string[] = [];
    for (const ref of p.match.cardIds) {
      const r = resolveIdPrefix([...tasks], ref);
      // An EXACT full id already stored for this same policy stays valid after its card is deleted, so one dead entry
      // never blocks every later whole-list save. A new, prefix or other policy's entry still has to resolve.
      // Only a FULL id qualifies (card f9a774c4): a short prefix stored before 61d32daf would otherwise be carried forward unresolved.
      if (r.kind === "none" && FULL_TASK_ID_RE.test(ref) && storedCardIds?.get(p.id)?.has(ref)) { if (!full.includes(ref)) full.push(ref); continue; }
      if (r.kind === "ambiguous") return { ok: false, error: `card policy '${p.id}': card id '${ref}' is ambiguous (matches ${r.ids.join(", ")}); use more characters or the full id` };
      if (r.kind === "none") return { ok: false, error: `card policy '${p.id}': card id '${ref}' matches no card on this project` };
      if (!full.includes(r.record.id)) full.push(r.record.id);
    }
    out.push({ ...p, match: { ...p.match, cardIds: full } });
  }
  return { ok: true, policies: out };
}

/**
 * Card 61d32daf — {@link resolveCardPolicyCardIds} applied to the list a config PATCH is WRITING (`override` is the
 * validated incoming override, never the stored one). Returns the override to store, with full card ids. An override
 * that writes no list passes through untouched, as does one the shared parser rejects (the validator refused it already).
 */
export function resolveWrittenCardPolicyIds<T extends { orchestration?: object }>(
  override: T,
  tasks: readonly { id: string }[],
  storedConfig?: { orchestration?: object },
): { ok: true; value: T } | { ok: false; error: string } {
  const storedRaw = (storedConfig?.orchestration as { cardPolicies?: unknown } | undefined)?.cardPolicies;
  const written = (override.orchestration as { cardPolicies?: unknown } | undefined)?.cardPolicies;
  if (written === undefined) return { ok: true, value: override };
  const parsed = parseCardPolicies(written);
  if (!parsed.ok) return { ok: true, value: override };
  const stored = new Map<string, Set<string>>();
  const prior = storedRaw === undefined ? undefined : parseCardPolicies(storedRaw);
  if (prior?.ok) for (const p of prior.policies) if (p.match.cardIds) stored.set(p.id, new Set(p.match.cardIds));
  const r = resolveCardPolicyCardIds(parsed.policies, tasks, stored);
  if (!r.ok) return r;
  return { ok: true, value: { ...override, orchestration: { ...override.orchestration, cardPolicies: r.policies } } };
}

/** True when the project STORES a policy list (absent or empty = false; an unparseable value = true, since it fails closed on every card). */
export function projectStoresCardPolicies(project: { config?: unknown }): boolean {
  const raw = (project.config as { orchestration?: { cardPolicies?: unknown } } | undefined)?.orchestration?.cardPolicies;
  return raw !== undefined && !(Array.isArray(raw) && raw.length === 0);
}

function nameOf(p: CardPolicy): string {
  return p.name ?? p.id;
}

/**
 * Evaluate every card policy matching `task` for `phase`. Returns before ANY evidence read when the stored
 * list is absent/empty (byte-identical default). `rawPolicies` is the RAW stored override value.
 */
export async function evaluateCardPolicies(input: {
  rawPolicies: unknown;
  task: { id: string; title: string };
  phase: PolicyPhase;
  evidence: PolicyEvidence;
  /**
   * Policy ids that have EVER matched this card (the Db's project-scoped sticky `card_policy_matches_v2`). Enforced as the UNION of these
   * and the live title match, so retitling a card out of a selector never drops its policy. An id whose policy no
   * longer exists in the stored list is simply never reached (the loop iterates the configured policies), so a policy
   * the owner deleted stops applying.
   */
  stickyPolicyIds?: ReadonlySet<string>;
}): Promise<PolicyEvaluation> {
  const { rawPolicies, task, phase, evidence, stickyPolicyIds } = input;
  if (rawPolicies === undefined || (Array.isArray(rawPolicies) && rawPolicies.length === 0)) return { verdicts: [], blocking: [] };
  const parsed = parseCardPolicies(rawPolicies);
  if (!parsed.ok) {
    const v: RequirementVerdict = { policyId: "(config)", policyName: "card policy configuration", kind: "config", status: "unreadable", detail: `card policy config unreadable (${parsed.error})` };
    return { verdicts: [v], blocking: [v] };
  }
  const verdicts: RequirementVerdict[] = [];
  for (const policy of parsed.policies) {
    if (!cardPolicyMatches(policy, task) && !stickyPolicyIds?.has(policy.id)) continue;
    for (const req of policy.require as PolicyRequirement[]) {
      const base = { policyId: policy.id, policyName: nameOf(policy), kind: req.kind };
      let waived = false;
      try { waived = (await evidence.waived(task.id, policy.id, req.kind)) === true; } catch { waived = false; }
      if (waived) { verdicts.push({ ...base, status: "waived", detail: "waived by the owner" }); continue; }
      if (!POLICY_PHASE_KINDS[phase].includes(req.kind)) { verdicts.push({ ...base, status: "deferred", detail: `evaluated at ${req.kind === "approved-request" ? "spawn" : "merge"}` }); continue; }
      try {
        const r = await (req.kind === "approved-request" ? evidence.authorizedPermissionRequest(task.id)
          : req.kind === "code-review-report" ? evidence.codeReview(task.id)
          : evidence.checkpoint(task.id));
        verdicts.push({ ...base, status: r.met ? "met" : "unmet", detail: r.detail ?? "" });
      } catch (e) {
        verdicts.push({ ...base, status: "unreadable", detail: `evidence unreadable (${e instanceof Error ? e.message : String(e)})` });
      }
    }
  }
  return { verdicts, blocking: verdicts.filter((v) => v.status === "unmet" || v.status === "unreadable") };
}

/**
 * Card 61d32daf — the board's project-wide status read, with every per-request input hoisted: the stored list is
 * read and parsed ONCE, the sticky matches arrive pre-fetched (`stickyByTask`, one project-keyed query), and the shared
 * {@link evaluateCardPolicies} runs ONLY for a card some policy can match (live selector, or a sticky row naming a
 * configured policy). Every evaluated card gets exactly the verdict `taskPolicyView` gives it (same evaluator, same
 * spawn-phase evidence). An unparseable list yields the same `config` verdict on every card, so it is evaluated once.
 * Returns `{}` for a project that stores no list.
 */
export async function evaluateProjectCardPolicyStatus(input: {
  project: { config?: unknown };
  tasks: readonly { id: string; title: string }[];
  stickyByTask: ReadonlyMap<string, ReadonlySet<string>>;
  evidence: PolicyEvidence;
}): Promise<Record<string, { blocking: number; total: number }>> {
  const { project, tasks, stickyByTask, evidence } = input;
  const out: Record<string, { blocking: number; total: number }> = {};
  if (!projectStoresCardPolicies(project)) return out;
  const raw = (project.config as { orchestration?: { cardPolicies?: unknown } } | undefined)?.orchestration?.cardPolicies;
  const parsed = parseCardPolicies(raw);
  const record = (id: string, ev: PolicyEvaluation): void => {
    if (ev.verdicts.length > 0) out[id] = { blocking: ev.blocking.length, total: ev.verdicts.length };
  };
  if (!parsed.ok) {
    if (tasks.length === 0) return out;
    const ev = await evaluateCardPolicies({ rawPolicies: raw, task: tasks[0]!, phase: "spawn", evidence });
    for (const t of tasks) record(t.id, ev);
    return out;
  }
  const configured = new Set(parsed.policies.map((p) => p.id));
  for (const t of tasks) {
    const sticky = stickyByTask.get(t.id);
    const stickyHit = sticky !== undefined && [...sticky].some((id) => configured.has(id));
    if (!stickyHit && !parsed.policies.some((p) => cardPolicyMatches(p, t))) continue;
    record(t.id, await evaluateCardPolicies({ rawPolicies: raw, task: t, phase: "spawn", evidence, stickyPolicyIds: sticky }));
  }
  return out;
}

const WAIVER_REMEDY = "Or the owner can record a waiver for this requirement (human-only; agents cannot waive).";

/** Refusal text for one blocking verdict: names the policy, the requirement, BOTH remedies, and the waiver. */
export function describePolicyRefusal(v: RequirementVerdict, ctx: { phase: PolicyPhase; taskId: string }): string {
  const head = v.kind === "config"
    ? `Blocked by card policy: ${v.detail}. Remedy: the owner must fix the card policy configuration in Settings. ${v.status === "unreadable" ? "Until then every tasked spawn and merge is refused (fail closed)." : ""}`.trim()
    : `${ctx.phase === "spawn" ? `worker_spawn taskId '${ctx.taskId}' is blocked` : "Merge refused"} by card policy '${v.policyName}' (${v.policyId}): requires ${REQUIREMENT_LABEL[v.kind]}. ${v.status === "unreadable" ? `Could not verify: ${v.detail}.` : v.detail ? `Found: ${v.detail}.` : ""}`.replace(/\s+/g, " ").trim();
  if (v.kind === "config") return head;
  const remedy = v.kind === "approved-request"
    ? `Remedy: file a permission Request linked to this card (question_ask type "permission", taskId set), have the owner authorize it, then re-spawn.`
    : v.kind === "code-review-report"
      ? `Remedy: worker_spawn a reviewer with reviewOfTaskId='${ctx.taskId}', wait for its done report, then re-confirm (a branch that moved after the review needs a new one).`
      : `Remedy: the checkpoint report must precede the first commit; it cannot be added retroactively.`;
  return `${head} ${remedy} ${WAIVER_REMEDY}`;
}

/** True when the card carries an investigate-checkpoint requirement that is not waived (drives the kickoff paragraph). */
export function hasActiveInvestigateCheckpoint(ev: PolicyEvaluation): boolean {
  return ev.verdicts.some((v) => v.kind === "investigate-checkpoint" && v.status !== "waived");
}

/** Read-only agent view of an evaluation (tasks_get `policy`, kickoff note). */
export function policyView(ev: PolicyEvaluation): { policyId: string; policy: string; requirement: string; status: RequirementStatus; detail: string }[] {
  return ev.verdicts.map((v) => ({ policyId: v.policyId, policy: v.policyName, requirement: v.kind, status: v.status, detail: v.detail }));
}
