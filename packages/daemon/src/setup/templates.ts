import { randomUUID } from "node:crypto";
import { resolveConfig, columnKeyForRole } from "@loom/shared";
import type { Agent, Profile, Task } from "@loom/shared";
import type { Db } from "../db.js";
import { agentAssignableProfileError } from "../profiles/validate.js";
import { reservedProjectManagerProfileError } from "../agents/clone-core.js";
import { resolveAgentName } from "../agents/validate.js";
import { newAgentNameScope } from "./seed.js";

/**
 * Guided Onboarding & Templates (onboarding C1) — the workflow-template model. A BUNDLED TS preset, the
 * exact analog of `BUNDLED_PROFILES` (profiles/seed.ts): NO new DB table, NO new writer surface.
 * `applyWorkflowTemplate` writes ONLY existing agent-create + task-insert rows into an ALREADY-EXISTING
 * project.
 *
 * `profileName` on a templated agent BINDS an existing bundled Profile by name (looked up the same way
 * `seedPlatformHome`/`seedSetupHome` bind their agents to a bundled profile) — a template NEVER mints a
 * profile. Skills are inherited from the bound profile.
 *
 * @decision 3de74275 — `applyWorkflowTemplate` checks every resolved profile itself (role unconditional,
 * every caller; field fail-closed unless `humanAuthorized`) — see that function's own doc for the split.
 */

/** One agent a workflow template stands up, bound to an EXISTING bundled profile by name. */
export interface WorkflowTemplateAgent {
  name: string;
  profileName: string;
  startupPrompt: string;
  position: number;
}

/** One starter board card a workflow template seeds onto the project's default-landing column. */
export interface WorkflowTemplateCard {
  title: string;
  body: string;
}

/**
 * A template agent that was NOT created because the project already has an agent with that exact name
 * (case-insensitive). The existing agent is kept untouched; `promptDiffers` / `profileDiffers` say only whether
 * its startup prompt / bound profile differ from the template's (booleans, the text is never returned).
 */
export interface SkippedTemplateAgent {
  name: string;
  existingAgentId: string;
  promptDiffers: boolean;
  profileDiffers: boolean;
}

/** A starter card NOT seeded because the project already has a card with that title (any column). */
export interface SkippedTemplateCard {
  title: string;
  existingTaskId: string;
}

/** A workflow template: the agents to stand up + the starter board cards to seed. */
export interface WorkflowTemplate {
  name: string;
  description: string;
  agents: WorkflowTemplateAgent[];
  boardSeed: WorkflowTemplateCard[];
}

const ORCHESTRATOR_PROMPT = `Load your **/orchestrate** doctrine skill first — it is your operating manual (plan and decompose work into board tasks, spawn workers to implement them, review their work, and merge what's ready). This prompt adds only your identity on top of it.

You are this project's **Orchestrator** — the lead that turns incoming work into well-scoped board tasks, delegates each to a worker, reviews what comes back, and merges it. Read this project's own CLAUDE.md first for its conventions, its build/test gate, and any project-specific constraints before you plan or delegate anything.`;

const DEV_PROMPT = `Load your **/worker** doctrine skill first — it is your operating manual (stay in scope, escalate up via worker_report, verify before reporting). This prompt adds only your identity on top of it.

You are a **Dev** worker — you implement one assigned board task on your own isolated worktree branch: understand the surrounding code, make a focused change that matches the task's definition of done, verify it against the project's own gate, then report. Read this project's own CLAUDE.md first for its conventions and gate command.`;

const BUGFIX_PROMPT = `Load your **/worker** doctrine skill first — it is your operating manual (stay in scope, escalate up via worker_report, verify before reporting). This prompt adds only your identity on top of it.

You are a **Bugfix** worker — you reproduce an assigned bug, fix it on your own isolated worktree branch with the smallest change that addresses the root cause, add or update a regression check, verify against the project's own gate, then report. Read this project's own CLAUDE.md first for its conventions and gate command.`;

const QA_TESTER_PROMPT = `Load your **/worker** doctrine skill first — it is your operating manual (stay in scope, escalate up via worker_report, verify before reporting). This prompt adds only your identity on top of it.

You are a **QA Tester** worker — you drive your own isolated headless browser end-to-end against an assigned feature or change (navigate, click, fill, assert) to confirm it actually works, on your own isolated worktree branch, then report what you observed. Read this project's own CLAUDE.md first for its conventions, its gate command, and how to run the app locally.`;

const WEB_DESIGNER_PROMPT = `Load your **/worker** doctrine skill first — it is your operating manual (stay in scope, escalate up via worker_report, verify before reporting); also invoke the **web-design** skill by name for UI/frontend work. This prompt adds only your identity on top of it.

You are a **Web Designer** worker — you implement UI/frontend work on your own isolated worktree branch and drive your own isolated headless browser to see the running app and iterate on the design, then report. Read this project's own CLAUDE.md first for its conventions, its gate command, and how to run the app locally.`;

const CODE_REVIEWER_PROMPT = `Load your **/worker** doctrine skill first — it is your operating manual (stay in scope, escalate up via worker_report, verify before reporting). This prompt adds only your identity on top of it.

You are a **Code Reviewer** worker — you review an assigned change on its worktree branch and report findings WITHOUT committing; reporting done with no files changed is your correct contract, not a mistake. Read this project's own CLAUDE.md first for its conventions before you review.`;

const ORIENT_CARD: WorkflowTemplateCard = {
  title: "Get oriented in this project",
  body: "Read this project's own CLAUDE.md (or README, if there is no CLAUDE.md yet) to learn its conventions, its build/test gate, and how the codebase is laid out. Then plan the first round of work and delegate it.",
};

/** The two canonical workflow-template presets (onboarding C1). Keyed by NAME (the future preset lookup key). */
export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    name: "Software team (orchestrated)",
    description:
      "A full orchestrated team: an Orchestrator plans and delegates to four specialist workers (Dev, Bugfix, QA Tester, Web Designer) and a no-commit Code Reviewer.",
    agents: [
      { name: "Orchestrator", profileName: "Orchestrator", startupPrompt: ORCHESTRATOR_PROMPT, position: 0 },
      { name: "Dev", profileName: "Dev", startupPrompt: DEV_PROMPT, position: 1 },
      { name: "Bugfix", profileName: "Bugfix", startupPrompt: BUGFIX_PROMPT, position: 2 },
      { name: "QA Tester", profileName: "QA Tester", startupPrompt: QA_TESTER_PROMPT, position: 3 },
      { name: "Web Designer", profileName: "Web Designer", startupPrompt: WEB_DESIGNER_PROMPT, position: 4 },
      { name: "Code Reviewer", profileName: "Code Reviewer", startupPrompt: CODE_REVIEWER_PROMPT, position: 5 },
    ],
    boardSeed: [ORIENT_CARD],
  },
  {
    name: "Solo builder",
    description:
      "A minimal team for a solo project: an Orchestrator plans and delegates to a single Dev worker, with a no-commit Code Reviewer to check its work.",
    agents: [
      { name: "Orchestrator", profileName: "Orchestrator", startupPrompt: ORCHESTRATOR_PROMPT, position: 0 },
      { name: "Dev", profileName: "Dev", startupPrompt: DEV_PROMPT, position: 1 },
      { name: "Code Reviewer", profileName: "Code Reviewer", startupPrompt: CODE_REVIEWER_PROMPT, position: 2 },
    ],
    boardSeed: [ORIENT_CARD],
  },
];

/** Look up a canonical workflow template by name (the seed-key lookup, mirroring `findBundledProfile`). */
export function findWorkflowTemplate(name: string): WorkflowTemplate | undefined {
  return WORKFLOW_TEMPLATES.find((t) => t.name === name);
}

/**
 * EARLY, agent-surface-only pre-flight check for a template apply (the `template_apply` MCP tools in
 * setup.ts/platform.ts call this BEFORE `applyWorkflowTemplate`, for a clearer error at the point of the
 * actual request) — NOT the only defense: `applyWorkflowTemplate`'s own check (below) backstops it, per
 * the 3de74275 record's fix-round ruling. Checks every resolved agent's profile against
 * `agentAssignableProfileError` at its true default (strict — no `allowElevatedRoles`/`humanAuthorized`:
 * applying a template through an agent-facing tool is never a legitimate way to bind an elevated or
 * field-bearing rig). Returns the FIRST offending agent's error, or null when every resolved profile is
 * clean. An unresolvable `profileName` is left to `applyWorkflowTemplate`'s own pre-flight (its dedicated
 * "unknown bundled profile" error), not this check.
 */
export function templateAssignableProfileError(db: Db, template: WorkflowTemplate): string | null {
  const profilesByName = new Map(db.listProfiles().map((p) => [p.name, p]));
  for (const spec of template.agents) {
    const profile = profilesByName.get(spec.profileName);
    if (!profile) continue;
    const assignErr = agentAssignableProfileError(profile);
    if (assignErr) return `agent "${spec.name}" — ${assignErr}`;
  }
  return null;
}

/**
 * Apply a workflow template to an ALREADY-EXISTING project: create its agents (each bound to an existing
 * bundled profile by name) and seed its starter board cards. PURE in the sense of writing only through
 * the existing `insertAgent`/`insertTask` rows — no new writer surface, no new DB table.
 *
 * ATOMIC: a pre-flight VALIDATION pass resolves + checks EVERY `template.agents` entry BEFORE any write —
 * so a mixed-validity template (a valid agent before an invalid one) throws with NOTHING written, rather
 * than leaking the valid agents inserted before the throw. The write phase itself runs in one transaction.
 * An agent whose exact name (case-insensitive) already exists is skipped and reported in `skipped`; if that
 * leaves nothing to add, the apply throws.
 *
 * @decision 3de74275 — every resolved profile is checked via `agentAssignableProfileError(profile,
 * { humanAuthorized: opts?.humanAuthorized })`: ROLE is unconditional on every caller, REST included
 * (manager/worker/null only); FIELD is fail-closed, skippable ONLY by the REST template-apply route.
 *
 * @decision ced4285e — ALSO checks every resolved profile via `reservedProjectManagerProfileError`, so
 * a manager-role roster (e.g. "Orchestrator") can never land in a reserved project; skippable only by
 * `humanAuthorized: true`, same opt-out as the field check above.
 */
export function applyWorkflowTemplate(
  db: Db, template: WorkflowTemplate, projectId: string,
  opts?: { humanAuthorized?: boolean },
): { agents: Agent[]; tasks: Task[]; skipped: SkippedTemplateAgent[]; skippedCards: SkippedTemplateCard[] } {
  const project = db.getProject(projectId);
  if (!project) throw new Error(`applyWorkflowTemplate: project not found: ${projectId}`);

  const profilesByName = new Map(db.listProfiles().map((p) => [p.name, p]));

  // Pre-flight: resolve + validate EVERY agent before writing any of them, so the apply is all-or-nothing.
  // Card 46d1faa5: each name is also checked (the create-side twin of the rename check) against the project's
  // existing agents AND the template's earlier entries, so applying a roster twice, or onto a project that
  // already holds "QA Tester", throws here with nothing written instead of minting a twin.
  const nameScope = newAgentNameScope(db, projectId);
  const siblings = [...nameScope.siblings];
  const existingAgents = db.listAgents(projectId);
  // A template that names one agent twice (name or slug twin) is malformed whatever the project holds, so it is
  // checked across ALL specs BEFORE the skip below — otherwise a duplicate of an already-present name would be
  // skipped twice instead of refused.
  const seenInTemplate: { id: string; name: string }[] = [];
  for (const spec of template.agents) {
    const dup = resolveAgentName(spec.name, { siblings: seenInTemplate, reservedNames: [] });
    if (!dup.ok) throw new Error(`applyWorkflowTemplate: agent "${spec.name}" — ${dup.error}`);
    seenInTemplate.push({ id: `spec:${seenInTemplate.length}`, name: dup.name });
  }
  const skipped: SkippedTemplateAgent[] = [];
  const resolved: { spec: WorkflowTemplate["agents"][number]; profile: Profile; name: string }[] = [];
  for (const spec of template.agents) {
    const profile = profilesByName.get(spec.profileName);
    if (!profile) throw new Error(`applyWorkflowTemplate: unknown bundled profile "${spec.profileName}" for agent "${spec.name}"`);
    const assignErr = agentAssignableProfileError(profile, { humanAuthorized: opts?.humanAuthorized });
    if (assignErr) throw new Error(`applyWorkflowTemplate: agent "${spec.name}" — ${assignErr}`);
    if (!opts?.humanAuthorized) {
      const reservedErr = reservedProjectManagerProfileError(project, profile);
      if (reservedErr) throw new Error(`applyWorkflowTemplate: agent "${spec.name}" — ${reservedErr}`);
    }
    // An agent already in the project under this exact name (case-insensitive) is KEPT as-is and skipped, so a
    // roster can be upgraded onto a project that ran a smaller template. A reserved built-in name is never a
    // skip (it falls through to the refusal below), and a slug-only twin is not a name match either.
    const lower = spec.name.trim().toLowerCase();
    const existing = nameScope.reservedNames.some((r) => r.toLowerCase() === lower)
      ? undefined
      : existingAgents.find((a) => a.name.toLowerCase() === lower);
    if (existing) {
      skipped.push({
        name: existing.name, existingAgentId: existing.id, promptDiffers: existing.startupPrompt !== spec.startupPrompt,
        profileDiffers: existing.profileId !== profile.id,
      });
      continue;
    }
    const named = resolveAgentName(spec.name, { siblings, reservedNames: nameScope.reservedNames });
    if (!named.ok) throw new Error(`applyWorkflowTemplate: agent "${spec.name}" — ${named.error}`);
    siblings.push({ id: `template:${siblings.length}`, name: named.name });
    resolved.push({ spec, profile, name: named.name });
  }
  if (resolved.length === 0 && skipped.length > 0) {
    throw new Error(
      `applyWorkflowTemplate: every agent in this template already exists in this project (${skipped.map((s) => `"${s.name}"`).join(", ")}) — nothing to add`,
    );
  }

  const cols = resolveConfig(project.config).kanbanColumns;
  const landing = columnKeyForRole(cols, "defaultLanding") ?? cols[0]?.key ?? "backlog";
  const now = new Date().toISOString();

  // Added agents continue the project's own ordering (max existing position + 1, +2, ... in template order) so
  // they never tie with an existing agent; a project with no agents starts at 0.
  const basePosition = existingAgents.reduce((m, a) => Math.max(m, a.position), -1) + 1;
  // A starter card whose trimmed title already exists on the project (any column, case-insensitive) is not
  // seeded again — the cards two templates share (and a re-apply after deleting one agent) land once.
  const existingByTitle = new Map<string, string>();
  for (const t of db.listTasks(projectId)) {
    const key = t.title.trim().toLowerCase();
    if (!existingByTitle.has(key)) existingByTitle.set(key, t.id);
  }
  const skippedCards: SkippedTemplateCard[] = [];
  const cardsToSeed = template.boardSeed.filter((card) => {
    const existingId = existingByTitle.get(card.title.trim().toLowerCase());
    if (existingId === undefined) return true;
    skippedCards.push({ title: card.title, existingTaskId: existingId });
    return false;
  });

  // One transaction for the whole write phase: a failing insert (e.g. a card) rolls back the agents already
  // inserted instead of stranding a half-applied project. At least one agent is being added here (the
  // all-skipped case threw above); cards are deduped by title as computed above.
  return db.runInTransaction(() => {
    const agents: Agent[] = resolved.map(({ spec, profile, name }, i) => {
      const agent: Agent = {
        id: randomUUID(),
        projectId,
        name,
        startupPrompt: spec.startupPrompt,
        position: basePosition + i,
        profileId: profile.id,
        endpoint: false, // a templated agent is never an API endpoint — human-only REST publishes one
        ioSchema: null,
      };
      db.insertAgent(agent);
      return agent;
    });

    const tasks: Task[] = cardsToSeed.map((card, i) => {
      const task: Task = {
        id: randomUUID(),
        projectId,
        title: card.title,
        body: card.body,
        columnKey: landing,
        position: i,
        priority: "p2",
        createdAt: now,
        updatedAt: now,
        version: 1,
      };
      db.insertTask(task);
      return task;
    });

    return { agents, tasks, skipped, skippedCards };
  });
}
