import { randomUUID } from "node:crypto";
import type { Profile } from "@loom/shared";
import type { Db } from "../db.js";

/**
 * Loom's bundled Agent Profiles — the reusable, platform-level "who", encoding the role scaffolds the
 * web's TEMPLATE_TOPICS (web/src/pages/Workspace.tsx) describes in prose. Orchestrator=manager,
 * Dev/Bugfix=worker, Planning & Triage / Content Strategy = plain (role null), plus a Platform-lead
 * (role=platform; today REST/internal-only). Cross-project, so NO project FK. Keyed by NAME for the
 * seed-if-absent idempotent seed (UUID id assigned on first seed). No "reset to bundled" yet (P3).
 */
export const BUNDLED_PROFILES: Omit<Profile, "id">[] = [
  {
    name: "Orchestrator",
    role: "manager",
    startupPrompt:
      "You are the lead orchestrator for this project. Plan work into board tasks, spawn and review workers, and merge their branches via your loom-orchestration tools.",
    allowDelta: [],
    skills: null,
    model: null,
    icon: null,
  },
  {
    name: "Planning & Triage",
    role: null,
    startupPrompt:
      "Triage incoming work for this project into clear, well-scoped board tasks, each with a sharp definition of done.",
    allowDelta: [],
    skills: null,
    model: null,
    icon: null,
  },
  {
    name: "Dev",
    role: "worker",
    startupPrompt:
      "Implement the assigned board task on your worktree branch. Keep the change small and focused; run the build/tests; then report.",
    allowDelta: [],
    skills: null,
    model: null,
    icon: null,
  },
  {
    name: "Bugfix",
    role: "worker",
    startupPrompt:
      "Reproduce, fix, and verify the assigned bug on your worktree branch. Add a regression check; then report.",
    allowDelta: [],
    skills: null,
    model: null,
    icon: null,
  },
  {
    name: "Content Strategy",
    role: null,
    startupPrompt: "Work on content and strategy for this project, grounded in the vault notes.",
    allowDelta: [],
    skills: null,
    model: null,
    icon: null,
  },
  {
    name: "Platform-lead",
    role: "platform",
    startupPrompt:
      "You are a platform-lead. Stand up and configure projects and topics via your loom-platform tools so the orchestration queue has well-formed work to drain.",
    allowDelta: [],
    skills: null,
    model: null,
    icon: null,
  },
];

/**
 * Seed the bundled profiles into the platform-level `profiles` table ONLY IF ABSENT (matched by
 * name), mirroring seedGlobalSkills' seed-if-absent contract: a user's future edits survive reboots,
 * and re-running is idempotent (no duplicates). Returns the names actually seeded this call.
 */
export function seedDefaultProfiles(db: Db): string[] {
  const existing = new Set(db.listProfiles().map((p) => p.name));
  const seeded: string[] = [];
  for (const p of BUNDLED_PROFILES) {
    if (existing.has(p.name)) continue; // preserve user edits / avoid duplicates
    db.insertProfile({ id: randomUUID(), ...p });
    seeded.push(p.name);
  }
  return seeded;
}
