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

/**
 * Restore a profile to its shipped BUNDLED_PROFILES version, discarding any UI edits — the profile
 * analogue of skills/store.ts resetSkillToBundled, closing the same seed-if-absent gap (seeding never
 * overwrites, so improvements to a bundled profile don't reach an existing row on reboot). The bundled
 * entry is matched by NAME (the seed key), preserving the row's id + any topic assignments. Returns
 * false (caller → 404) if the id is unknown OR its name isn't a bundled one (a user-created profile
 * can't be "reset"). The user may have renamed a bundled profile, in which case it's no longer matchable
 * — that's the documented limitation, identical to the skill reset's bundled-by-name contract.
 */
export function resetProfileToBundled(db: Db, id: string): boolean {
  const existing = db.getProfile(id);
  if (!existing) return false;
  const bundled = BUNDLED_PROFILES.find((b) => b.name === existing.name);
  if (!bundled) return false; // not a bundled profile (or renamed away from its bundled name)
  db.updateProfile(id, { ...bundled }); // overwrite every field with the shipped values
  return true;
}
