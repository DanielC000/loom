import { randomUUID } from "node:crypto";
import type { Profile } from "@loom/shared";
import type { Db } from "../db.js";

/**
 * Loom's bundled Profiles — the reusable, platform-level "rig" (role + model + allow-delta +
 * skill-subset + icon) an agent runs under. Orchestrator=manager, Dev/Bugfix=worker, Planning &
 * Triage / Content Strategy = plain (role null), plus a Platform-lead (role=platform; today
 * REST/internal-only). Cross-project, so NO project FK. Keyed by NAME for the seed-if-absent
 * idempotent seed (UUID id assigned on first seed); "reset to bundled" restores a row to these.
 *
 * NOTE: a Profile carries NO injected prompt — `description` is a UI-only blurb describing what the
 * rig is for. The startup prompt always comes from the Agent (resolveProfile sources it there).
 */
export const BUNDLED_PROFILES: Omit<Profile, "id">[] = [
  {
    name: "Orchestrator",
    role: "manager",
    description:
      "Lead-orchestrator rig: runs as a manager with the loom-orchestration tools — plans board work, spawns and reviews workers, merges their branches. The agent supplies the project specifics.",
    allowDelta: [],
    skills: null,
    model: null,
    icon: null,
  },
  {
    name: "Planning & Triage",
    role: null,
    description:
      "Plain rig (no orchestration role) for triaging incoming work into clear, well-scoped board tasks, each with a sharp definition of done.",
    allowDelta: [],
    skills: null,
    model: null,
    icon: null,
  },
  {
    name: "Dev",
    role: "worker",
    description:
      "Worker rig: implements one assigned board task on an isolated worktree branch — small, focused change, build/tests, then report.",
    allowDelta: [],
    skills: null,
    model: null,
    icon: null,
  },
  {
    name: "Bugfix",
    role: "worker",
    description:
      "Worker rig for bug work: reproduce, fix, and verify on a worktree branch, with a regression check, then report.",
    allowDelta: [],
    skills: null,
    model: null,
    icon: null,
  },
  {
    name: "QA Tester",
    role: "worker",
    description:
      "Browser-testing worker rig: drives its OWN isolated headless browser (a per-session Playwright MCP) to exercise the running app end-to-end — navigate, click, fill, assert — on a worktree branch, then report. The one bundled rig with browser automation enabled.",
    allowDelta: [],
    skills: null,
    model: null,
    icon: "🧪",
    browserTesting: true, // THE browser-capable profile — injects the per-session Playwright MCP at spawn
  },
  {
    name: "Content Strategy",
    role: null,
    description: "Plain rig for content and strategy work, grounded in the project's vault notes.",
    allowDelta: [],
    skills: null,
    model: null,
    icon: null,
  },
  {
    name: "Platform-lead",
    role: "platform",
    description:
      "Platform-lead rig: runs with the loom-platform tools to stand up and configure projects + agents so the orchestration queue has well-formed work to drain.",
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
 * entry is matched by NAME (the seed key), preserving the row's id + any agent assignments. Returns
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
