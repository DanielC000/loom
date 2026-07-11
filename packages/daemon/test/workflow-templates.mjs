import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Guided Onboarding & Templates (onboarding C1) — the workflow-template model + canonical team presets.
// HERMETIC + CLAUDE-FREE + NETWORK-FREE, modeled on companion-seed.mjs: an isolated LOOM_HOME + sandboxed
// HOME, a REAL Db handle + the REAL seeders/applier. Proves:
//   (1) the two canonical presets ('Software team (orchestrated)' / 'Solo builder') are found by name and
//       have the shape the card specifies (agent roster + which bundled profile each binds).
//   (2) applyWorkflowTemplate(db, template, projectId), applied to an EXISTING project, writes ONLY
//       existing agent-create + task-insert rows — no new table: every agent + task shows up via the
//       ordinary listAgents/listTasks reads, each agent bound to its EXISTING bundled profile by name
//       (never a minted one), and every resolved role is LEGAL (passes setupRoleError).
//   (3) the canonical startupPrompts are grep-clean of Loom-dev-specifics (no packages/ path, no @loom/*,
//       no pnpm --filter, no Projects/Loom vault path, no Loom build commands) — they ship to end users'
//       own projects and must defer all specifics to the project's own CLAUDE.md.
//   (4) defense-in-depth: applying a template whose agent resolves to an ELEVATED profile role (platform/
//       auditor/workspace-auditor) THROWS rather than silently seeding an elevation back-door; likewise an
//       unknown profileName throws rather than silently minting one.
//
// Run: 1) build (turbo builds shared first), 2) node test/workflow-templates.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import
// time). LOOM_DEV deliberately UNSET — the canonical presets bind only CORE (ungated) bundled profiles. ---
const tmpHome = path.join(os.tmpdir(), `loom-wt-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX
delete process.env.LOOM_DEV;

const { Db } = await import("../dist/db.js");
const { seedDefaultProfiles } = await import("../dist/profiles/seed.js");
const { setupRoleError } = await import("../dist/mcp/setup.js");
const { WORKFLOW_TEMPLATES, findWorkflowTemplate, applyWorkflowTemplate } = await import("../dist/setup/templates.js");

// Loom-dev-specific tokens a shipped-to-end-users startupPrompt must never contain.
const FORBIDDEN_TOKENS = ["packages/", "@loom/", "pnpm --filter", "Projects/Loom", "pnpm build", "pnpm daemon"];

try {
  const db = new Db(path.join(tmpHome, "fresh.db"));
  seedDefaultProfiles(db);

  const project = {
    id: randomUUID(), name: "Test Project", repoPath: tmpHome, vaultPath: tmpHome,
    config: {}, createdAt: new Date().toISOString(), archivedAt: null, reserved: false,
  };
  db.insertProject(project);

  // ===================== (1) the two canonical presets exist with the specified roster =====================
  check("(1) exactly two canonical templates", WORKFLOW_TEMPLATES.length === 2);
  const orchestrated = findWorkflowTemplate("Software team (orchestrated)");
  const solo = findWorkflowTemplate("Solo builder");
  check("(1) 'Software team (orchestrated)' found by name", !!orchestrated);
  check("(1) 'Solo builder' found by name", !!solo);
  check("(1) unknown template name is not found", findWorkflowTemplate("nope") === undefined);

  const orchestratedNames = orchestrated.agents.map((a) => a.name).sort();
  check("(1) 'Software team (orchestrated)' agent roster matches the card spec",
    JSON.stringify(orchestratedNames) === JSON.stringify(["Bugfix", "Code Reviewer", "Dev", "Orchestrator", "QA Tester", "Web Designer"].sort()));
  const soloNames = solo.agents.map((a) => a.name).sort();
  check("(1) 'Solo builder' agent roster matches the card spec",
    JSON.stringify(soloNames) === JSON.stringify(["Code Reviewer", "Dev", "Orchestrator"].sort()));

  const profileNameFor = (tpl, agentName) => tpl.agents.find((a) => a.name === agentName).profileName;
  check("(1) each templated agent binds an EXISTING bundled profile name (never mints one)",
    [...orchestrated.agents, ...solo.agents].every((a) => !!db.listProfiles().find((p) => p.name === a.profileName)));
  check("(1) Orchestrator binds the 'Orchestrator' bundled profile (role manager)",
    db.listProfiles().find((p) => p.name === profileNameFor(orchestrated, "Orchestrator"))?.role === "manager");
  check("(1) Code Reviewer binds the 'Code Reviewer' bundled profile (role worker, noCommit)",
    db.listProfiles().find((p) => p.name === profileNameFor(orchestrated, "Code Reviewer"))?.noCommit === true);

  // ===================== (2) applyWorkflowTemplate writes ONLY agent-create + task-insert rows =====================
  const beforeAgents = db.listAgents(project.id).length;
  const beforeTasks = db.listTasks(project.id).length;
  const applied = applyWorkflowTemplate(db, orchestrated, project.id);
  check("(2) applyWorkflowTemplate returns one Agent per templated agent", applied.agents.length === orchestrated.agents.length);
  check("(2) applyWorkflowTemplate returns one Task per boardSeed card", applied.tasks.length === orchestrated.boardSeed.length);
  check("(2) every returned agent is visible via the ordinary listAgents read",
    db.listAgents(project.id).length === beforeAgents + orchestrated.agents.length);
  check("(2) every returned task is visible via the ordinary listTasks read",
    db.listTasks(project.id).length === beforeTasks + orchestrated.boardSeed.length);
  check("(2) every applied agent is bound to its EXISTING bundled profile (profileId set, not null)",
    applied.agents.every((a) => a.profileId != null));
  check("(2) every applied agent's resolved profile role passes setupRoleError (legal, not elevated)",
    applied.agents.every((a) => setupRoleError(db.getProfile(a.profileId).role) === null));
  check("(2) the Orchestrator agent's profile role is 'manager'",
    db.getProfile(applied.agents.find((a) => a.name === "Orchestrator").profileId).role === "manager");
  check("(2) the Dev agent's profile role is 'worker'",
    db.getProfile(applied.agents.find((a) => a.name === "Dev").profileId).role === "worker");
  check("(2) applied tasks land on the project's default-landing column",
    applied.tasks.every((t) => t.columnKey === "backlog"));

  // Apply the second preset to a fresh project too, proving both presets independently apply cleanly.
  const project2 = { ...project, id: randomUUID(), name: "Test Project 2" };
  db.insertProject(project2);
  const appliedSolo = applyWorkflowTemplate(db, solo, project2.id);
  check("(2) 'Solo builder' applies its 3-agent roster to a distinct project",
    appliedSolo.agents.length === 3 && db.listAgents(project2.id).length === 3);
  check("(2) 'Solo builder' agents never leak into the first project", db.listAgents(project.id).length === beforeAgents + orchestrated.agents.length);

  // ===================== (3) canonical startupPrompts are grep-clean of Loom-dev-specifics =====================
  const allPrompts = [...orchestrated.agents, ...solo.agents].map((a) => a.startupPrompt);
  for (const token of FORBIDDEN_TOKENS) {
    check(`(3) no canonical startupPrompt contains "${token}"`, allPrompts.every((p) => !p.includes(token)));
  }
  check("(3) every canonical startupPrompt is non-empty", allPrompts.every((p) => typeof p === "string" && p.length > 20));

  // ===================== (4) defense-in-depth: elevation + unknown-profile guards =====================
  const elevatedProfileId = randomUUID();
  db.insertProfile({
    id: elevatedProfileId, name: "Sneaky Elevated Profile", role: "platform",
    description: "test-only elevated profile", allowDelta: [], skills: null, model: null, icon: null,
  });
  const elevatedTemplate = {
    name: "Elevation attempt", description: "test-only",
    agents: [{ name: "Sneaky", profileName: "Sneaky Elevated Profile", startupPrompt: "x", position: 0 }],
    boardSeed: [],
  };
  let elevationThrew = false;
  try { applyWorkflowTemplate(db, elevatedTemplate, project.id); } catch { elevationThrew = true; }
  check("(4) applying a template whose agent resolves to an ELEVATED role (platform) throws — never seeded", elevationThrew);
  check("(4) no 'Sneaky' agent was actually created", db.listAgents(project.id).find((a) => a.name === "Sneaky") === undefined);

  const unknownProfileTemplate = {
    name: "Unknown profile", description: "test-only",
    agents: [{ name: "Ghost", profileName: "Does Not Exist", startupPrompt: "x", position: 0 }],
    boardSeed: [],
  };
  let unknownThrew = false;
  try { applyWorkflowTemplate(db, unknownProfileTemplate, project.id); } catch { unknownThrew = true; }
  check("(4) applying a template with an unknown profileName throws — never mints a profile", unknownThrew);
  check("(4) no new profile was minted by the unknown-profileName attempt", db.listProfiles().length === db.listProfiles().filter((p) => p.name !== "Ghost").length);

  let unknownProjectThrew = false;
  try { applyWorkflowTemplate(db, solo, "nonexistent-project-id"); } catch { unknownProjectThrew = true; }
  check("(4) applying to an unknown projectId throws", unknownProjectThrew);

  // ===================== (5) atomicity: a mixed-validity template writes NOTHING =====================
  // A valid agent BEFORE an invalid one (unknown profileName) must not leak the valid agent's insert —
  // proves the pre-flight validation pass runs over ALL agents before any write.
  const beforeAgentsAtomic = db.listAgents(project.id).length;
  const beforeTasksAtomic = db.listTasks(project.id).length;
  const mixedValidityTemplate = {
    name: "Mixed validity", description: "test-only",
    agents: [
      { name: "ValidFirst", profileName: profileNameFor(orchestrated, "Dev"), startupPrompt: "x", position: 0 },
      { name: "InvalidSecond", profileName: "Does Not Exist", startupPrompt: "x", position: 1 },
    ],
    boardSeed: [{ title: "should never be seeded", body: "x" }],
  };
  let mixedValidityThrew = false;
  try { applyWorkflowTemplate(db, mixedValidityTemplate, project.id); } catch { mixedValidityThrew = true; }
  check("(5) applying a mixed-validity template (valid agent before an invalid one) throws", mixedValidityThrew);
  check("(5) ZERO agents inserted — the valid agent before the invalid one did not leak",
    db.listAgents(project.id).length === beforeAgentsAtomic);
  check("(5) no 'ValidFirst' agent was actually created", db.listAgents(project.id).find((a) => a.name === "ValidFirst") === undefined);
  check("(5) ZERO tasks inserted", db.listTasks(project.id).length === beforeTasksAtomic);

  // Same shape, but the 2nd agent is ELEVATED rather than unknown — still fully atomic.
  const mixedElevatedTemplate = {
    name: "Mixed elevated", description: "test-only",
    agents: [
      { name: "ValidFirst2", profileName: profileNameFor(orchestrated, "Dev"), startupPrompt: "x", position: 0 },
      { name: "SneakySecond", profileName: "Sneaky Elevated Profile", startupPrompt: "x", position: 1 },
    ],
    boardSeed: [],
  };
  let mixedElevatedThrew = false;
  try { applyWorkflowTemplate(db, mixedElevatedTemplate, project.id); } catch { mixedElevatedThrew = true; }
  check("(5) applying a mixed-validity template (valid agent before an elevated one) throws", mixedElevatedThrew);
  check("(5) ZERO agents inserted for the elevated-second case",
    db.listAgents(project.id).length === beforeAgentsAtomic);

  db.close();
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* retry (WAL handle on Windows) */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the workflow-template model ships the two canonical presets (each binding EXISTING bundled profiles by name, never minting one); applyWorkflowTemplate writes only ordinary agent-create + task-insert rows into an existing project with every resolved role legal (setupRoleError); the canonical startupPrompts are grep-clean of Loom-dev-specifics; and applying an elevated or unknown-profile template throws rather than silently seeding a back-door."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
