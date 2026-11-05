// Card 9623e943 (epic 8b6c750a) — card-policy enforcement: the pure evaluator.
//
// @decision 9623e943 — `evaluateCardPolicies` is the ONLY reader of `orchestration.cardPolicies` for
// enforcement. It parses the RAW stored override, never `resolveConfig().orchestration.cardPolicies` (which
// silently degrades an invalid list to the default). Unreadable config or evidence fails CLOSED.
import { parseCardPolicies, PERMISSION_ANSWERS, type CardPolicy, type PolicyRequirement, type PolicyRequirementKind } from "@loom/shared";
import { cardPolicyMatches } from "../tasks/title-guard.js";
import { isSshApprovalAction, isPermissionLapsed } from "../mcp/questionTool.js";

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
export function dbPolicyEvidence(
  db: { listQuestionsForTask(projectId: string, taskId: string): { type: string; state: string; chosenOption: string | null; decidedExpiresAt?: string | null; answeredVia?: "human" | null; permissionAction?: string | null }[]; listCardPolicyWaivers(taskId: string): { policyId: string; requirementKind: string }[] },
  projectId: string,
  nowMs: () => number = Date.now,
): Pick<PolicyEvidence, "authorizedPermissionRequest" | "waived"> {
  return {
    authorizedPermissionRequest: (taskId) => {
      const lapsed = (q: { decidedExpiresAt?: string | null }): boolean => isPermissionLapsed(q.decidedExpiresAt ?? null, nowMs()); // the ONE shared lapse predicate (an unparseable value fails closed as lapsed)
      const hit = db.listQuestionsForTask(projectId, taskId).some((q) => q.type === "permission" && (q.state === "answered" || q.state === "consumed") && q.chosenOption === PERMISSION_ANSWERS[0] && q.answeredVia === "human" && !isSshApprovalAction(q.permissionAction) && !lapsed(q));
      return { met: hit, detail: hit ? "" : "no answered permission Request with an affirmative answer is linked to this card" };
    },
    waived: (taskId, policyId, kind) => db.listCardPolicyWaivers(taskId).some((w) => w.policyId === policyId && w.requirementKind === kind),
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
