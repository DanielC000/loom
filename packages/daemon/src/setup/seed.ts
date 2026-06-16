import { randomUUID } from "node:crypto";
import type { Agent, Project } from "@loom/shared";
import { LOOM_HOME } from "../paths.js";
import type { Db } from "../db.js";

/**
 * Setup Assistant — the reserved, UNGATED "Getting Started" home + its single Setup Assistant agent.
 *
 * The user-facing onboarding rig that ships to EVERY loomctl user. It is the lower-privilege sibling of
 * the dev-only Platform home (platform/seed.ts): same reserved-project pattern (a real board/agent/session
 * scope, reusing all existing project machinery and hidden from the ordinary picker), but seeded on the
 * CORE path — there is NO isLoomDev gate. The single agent runs the bundled "Setup Assistant" profile
 * (role "setup", seeded ungated by seedDefaultProfiles) and the ungated /setup-assistant doctrine skill.
 *
 * Like seedPlatformHome / seedDefaultProfiles this is SEED-IF-ABSENT (idempotent), keyed NAME-SCOPED to
 * this home's own name so it coexists with the platform home without either suppressing the other's seed
 * (see db.hasReservedProjectNamed). It runs every boot and no-ops once the home exists, so a user's later
 * edits (renamed agent, edited prompt, archived home) are never clobbered.
 *
 * E1-4 SCOPE ONLY: this seeds the project + agent + its default prompt. It does NOT spawn the assistant
 * (startSetup is a separate human-REST / first-run-boot path — E1, later card) and adds no spawn path of
 * its own. The invariant that NO agent MCP path can mint a setup-role session is preserved elsewhere.
 */

/** The reserved setup home's display name (also the name-scoped idempotency anchor). */
export const SETUP_PROJECT_NAME = "Getting Started";

/**
 * The Setup home has NO real git repo — it is an onboarding scope, not a codebase. Both repoPath and
 * vaultPath bind to LOOM_HOME (~/.loom): a stable, always-present directory (ensureDirs creates it at
 * boot) that is never a worktree — mirroring how the platform home is bound. The assistant acts on the
 * user's behalf via the curated loom-setup MCP surface, not by editing this directory's files.
 */
const SETUP_HOME_PATH = LOOM_HOME;

/** The bundled profile the Setup Assistant agent runs under (seeded ungated by seedDefaultProfiles). */
const SETUP_PROFILE_NAME = "Setup Assistant";

/** The seeded agent's display name (also the name-scoped anchor the first-run auto-launch resolves by). */
export const SETUP_AGENT_NAME = "Setup Assistant";

/** The default startup prompt shipped for the Setup Assistant agent (user-editable after seed). */
const SETUP_ASSISTANT_PROMPT = `Load your **/setup-assistant** doctrine skill first — it is your operating manual (your friendly onboarding identity, the curated loom-setup tool surface, the confirm-first posture, and what you are NOT). This prompt adds only the specifics on top of it.

You are Loom's **Setup Assistant** — the warm, always-available helper a brand-new user meets first. Your job is to get someone from an empty install to a working setup: their **projects**, **agents**, **profiles**, a sensible set of **default skills**, and a **workflow** they understand. Explain how Loom fits together in plain language, then **act on the user's behalf** over your curated tools so they don't have to learn every screen before getting value.

Be warm, concrete, and brief — guide, don't lecture. Ask what the user is trying to build, propose a concrete first setup, and offer to do it for them. Confirm anything big or irreversible before acting.

You are **not** the Platform Lead. You ship to every user on a curated, fail-closed surface with **no elevated or outward capability**: you do not self-improve Loom, file escalations, run audits, reach git/vault writers or gateCommand, or spawn platform/auditor/worker/setup sessions. If a user asks for something outside your role, say so plainly and point them at the right place rather than improvising around the limit.`;

/**
 * Seed the reserved "Getting Started" home and its Setup Assistant agent IF ABSENT. UNGATED — runs for
 * every loomctl user regardless of LOOM_DEV (the deliberate difference from seedPlatformHome). Idempotent:
 * once the named reserved home exists this no-ops (preserving any user edits). The agent is bound to the
 * bundled "Setup Assistant" profile, looked up by name from the already-seeded profiles (seedDefaultProfiles
 * runs first at boot); if that profile is somehow missing the agent is still seeded with profileId null
 * (resolveProfile's plain backstop) so the seed never throws. Returns a short summary ([] when it no-ops).
 */
export function seedSetupHome(db: Db): string[] {
  if (db.hasReservedProjectNamed(SETUP_PROJECT_NAME)) return []; // already seeded — never clobber user edits

  const now = new Date().toISOString();
  const project: Project = {
    id: randomUUID(),
    name: SETUP_PROJECT_NAME,
    repoPath: SETUP_HOME_PATH,
    vaultPath: SETUP_HOME_PATH,
    config: {},
    createdAt: now,
    archivedAt: null,
    reserved: true, // a reserved home — hidden from the picker, minted only here at boot-seed
  };
  db.insertProject(project);

  const profile = db.listProfiles().find((p) => p.name === SETUP_PROFILE_NAME);
  const agent: Agent = {
    id: randomUUID(),
    projectId: project.id,
    name: SETUP_AGENT_NAME,
    startupPrompt: SETUP_ASSISTANT_PROMPT,
    position: 0,
    profileId: profile?.id ?? null, // plain backstop if the bundled profile is unexpectedly absent
    endpoint: false, ioSchema: null, // not an API endpoint
  };
  db.insertAgent(agent);

  return [`project:${project.name}`, `agent:${agent.name}`];
}
