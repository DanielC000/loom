import { randomUUID } from "node:crypto";
import { resolveConfig, columnKeyForRole } from "@loom/shared";
import type { Agent, Task } from "@loom/shared";
import type { Db } from "../db.js";
import { setupRoleError } from "../mcp/setup.js";

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
 * Defense-in-depth: every templated agent's resolved profile role is checked against `setupRoleError`
 * (mcp/setup.ts) — the same least-privilege allowlist the ungated setup surface enforces on
 * profile/agent writes. A template can never be an elevation back-door: applying one that (by a future
 * authoring mistake) references a platform/auditor/workspace-auditor profile throws rather than silently
 * seeding an elevated agent.
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
 * Apply a workflow template to an ALREADY-EXISTING project: create its agents (each bound to an existing
 * bundled profile by name) and seed its starter board cards. PURE in the sense of writing only through
 * the existing `insertAgent`/`insertTask` rows — no new writer surface, no new DB table.
 *
 * Each agent's resolved profile role passes `setupRoleError` (mcp/setup.ts) before it is written — the
 * same least-privilege allowlist enforced on the ungated setup surface — so a template can never be an
 * elevation back-door. Throws if the project doesn't exist, if a `profileName` doesn't match an existing
 * profile, or if a resolved profile's role is elevated (platform/auditor/workspace-auditor).
 */
export function applyWorkflowTemplate(db: Db, template: WorkflowTemplate, projectId: string): { agents: Agent[]; tasks: Task[] } {
  const project = db.getProject(projectId);
  if (!project) throw new Error(`applyWorkflowTemplate: project not found: ${projectId}`);

  const profilesByName = new Map(db.listProfiles().map((p) => [p.name, p]));

  const agents: Agent[] = template.agents.map((spec) => {
    const profile = profilesByName.get(spec.profileName);
    if (!profile) throw new Error(`applyWorkflowTemplate: unknown bundled profile "${spec.profileName}" for agent "${spec.name}"`);
    const roleError = setupRoleError(profile.role);
    if (roleError) throw new Error(`applyWorkflowTemplate: agent "${spec.name}" — ${roleError}`);
    const agent: Agent = {
      id: randomUUID(),
      projectId,
      name: spec.name,
      startupPrompt: spec.startupPrompt,
      position: spec.position,
      profileId: profile.id,
      endpoint: false, // a templated agent is never an API endpoint — human-only REST publishes one
      ioSchema: null,
    };
    db.insertAgent(agent);
    return agent;
  });

  const cols = resolveConfig(project.config).kanbanColumns;
  const landing = columnKeyForRole(cols, "defaultLanding") ?? cols[0]?.key ?? "backlog";
  const now = new Date().toISOString();

  const tasks: Task[] = template.boardSeed.map((card, i) => {
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
    };
    db.insertTask(task);
    return task;
  });

  return { agents, tasks };
}
