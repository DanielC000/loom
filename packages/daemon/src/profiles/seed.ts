import { randomUUID } from "node:crypto";
import type { Profile } from "@loom/shared";
import { isLoomDev } from "../paths.js";
import type { Db } from "../db.js";

/**
 * Loom's bundled Profiles — the reusable, platform-level "rig" (role + model + allow-delta +
 * skill-subset + icon) an agent runs under. Orchestrator=manager, Dev/Bugfix=worker, Planning &
 * Triage / Content Strategy = plain (role null), Setup Assistant=setup (the ungated onboarding rig),
 * plus the two platform rigs: Platform-lead
 * (role=platform — the full human-equivalent operator) and Platform-audit (role=auditor — the
 * lower-privilege, read-and-file-only scheduled transcript reviewer; P5). Cross-project, so NO project
 * FK. Keyed by NAME for the seed-if-absent idempotent seed (UUID id assigned on first seed); "reset to
 * bundled" restores a row to these.
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
      "Browser-testing worker rig: drives its OWN isolated headless browser (a per-session Playwright MCP) to exercise the running app end-to-end — navigate, click, fill, assert — on a worktree branch, then report. One of the bundled rigs with browser automation enabled (alongside Web Designer).",
    allowDelta: [],
    skills: null,
    model: null,
    icon: "🧪",
    browserTesting: true, // a browser-capable profile (like Web Designer) — injects the per-session Playwright MCP at spawn
  },
  {
    name: "Web Designer",
    role: "worker",
    description:
      "Browser-capable frontend worker rig: implements UI/frontend work on a worktree branch and drives its OWN isolated headless browser (a per-session Playwright MCP) to see the running app and iterate on the design — navigate, click, inspect, screenshot — then report. Mirrors QA Tester's browser rig for design/build work (invoke the web-design skill by name).",
    allowDelta: [],
    skills: null,
    model: null,
    icon: "🎨",
    browserTesting: true, // browser-capable, like QA Tester — injects the per-session Playwright MCP at spawn
  },
  {
    // CORE product, UNGATED (role "worker", not platform-exclusive) — the no-commit demonstration rig, the
    // noCommit analog of how QA Tester/Web Designer carry browserTesting. A read-only reviewer: it reviews an
    // assigned change on its worktree branch and reports findings WITHOUT committing (its CORRECT contract is
    // 0 files changed). Because `noCommit` is set, a worker under it that reports done with 0 commits is
    // AUTO-RETIRED — its concurrency slot freed with no manual worker_stop (a read-only worker has no merge
    // step to free it) — and the "forgot to commit" warning is suppressed.
    name: "Code Reviewer",
    role: "worker",
    description:
      "Read-only reviewer rig: reviews an assigned change on an isolated worktree branch and reports findings WITHOUT committing — its correct contract is 0 files changed. Declared no-commit (noCommit), so reporting done with no commit auto-retires the session and frees the manager's concurrency slot (no manual stop), and the forgot-to-commit guard is suppressed. The no-commit analog of the browser-capable QA Tester / Web Designer rigs.",
    allowDelta: [],
    skills: null,
    model: null,
    icon: "🧐",
    noCommit: true,
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
    // CORE product, UNGATED (role "assistant" is NOT a platform-exclusive role, so isPlatformProfile()
    // returns false and this seeds for every loomctl user regardless of LOOM_DEV, like the workers above).
    // The default spawn TARGET for the human-triggered "New companion" provision flow: a long-lived
    // chat-reachable assistant. `restrictedTools: true` by construction — a companion is driven by UNTRUSTED
    // inbound chat (a prompt-injection surface), so it ships LEAST-PRIVILEGE with raw shell + host-writes
    // withdrawn (the human widens deliberately by turning the flag OFF), the same way QA Tester/Web Designer
    // ship browserTesting on. Seeding this rig only removes author-your-own friction; it creates NO
    // companion session and NO companion_config — the rig stays invisible until a human provisions from it.
    name: "Companion",
    role: "assistant",
    description:
      "Companion rig: a long-lived, chat-reachable assistant a single user talks to over a chat channel (e.g. Telegram). The default spawn target for the 'New companion' flow. Ships with restricted tools (restrictedTools) — raw shell + host-writes withdrawn — because a companion is driven by untrusted inbound chat; widen it deliberately by turning that off. Seeded as a template only; provision a companion from it to create a live session.",
    allowDelta: [],
    skills: null,
    model: null,
    icon: "💬",
    restrictedTools: true, // chat-reachable ⇒ least-privilege out of the box (untrusted-input blast-radius control)
  },
  {
    // CORE product, UNGATED: role "setup" is NOT a platform-exclusive role, so isPlatformProfile()
    // returns false and this seeds for every loomctl user regardless of LOOM_DEV (like the workers above).
    name: "Setup Assistant",
    role: "setup",
    description:
      "Platform operator rig: the user-facing workspace operator that helps a human stand up and maintain their setup — creating, configuring, and archiving projects, defining agents and profiles, and seeding the first board work — over a curated, fail-closed surface (no elevated or outward capability).",
    allowDelta: [],
    skills: null,
    model: null,
    icon: "🧭",
  },
  {
    // CORE product, UNGATED — the end-user Platform tier's SUGGEST-ONLY reviewer, the de-privileged
    // user-workspace twin of Platform-audit. Role "workspace-auditor" is NOT a platform-exclusive role, so
    // isPlatformProfile() returns false and this seeds for every loomctl user (like Setup Assistant). The
    // role here is COSMETIC for routing — the session role is LOCKED to "workspace-auditor" by the future
    // startWorkspaceAuditor (B5), never by this profile (a profile carrying it is dropped to plain — B1
    // GUARD 3a). EXACT Platform-audit mirror: `skills: null` (deliver the standard set — the house pattern
    // for bundled specialist rigs), the workspace-audit doctrine (B2) is carried by the seeded agent's
    // `/workspace-audit` startup prompt, NOT a restricted skill list (skills are not the trust boundary —
    // the role-locked loom-user-audit MCP surface is). The agent itself is seeded into the reserved
    // "Getting Started" home by seedSetupAuditorAgent (setup/seed.ts), alongside the operator (B4).
    name: "Workspace Auditor",
    role: "workspace-auditor",
    description:
      "Workspace Auditor rig: the on-demand, read-mostly, SUGGEST-ONLY reviewer of the user's OWN workspace. Scans the user's recent session transcripts for vague/ambiguous instructions in their own agent prompts and skills, and recurring prompts worth saving as presets — filing improvement suggestions as board cards on the user's home and emitting preset suggestions, never auto-applying. Reviews the user's own workspace for their benefit.",
    allowDelta: [],
    skills: null,
    model: null,
    icon: "🔬",
  },
  {
    name: "Platform-lead",
    role: "platform",
    description:
      "Platform-lead rig: runs with the loom-platform tools to stand up and configure projects + agents so the orchestration queue has well-formed work to drain.",
    allowDelta: [],
    skills: null,
    model: null,
    icon: "🛰️",
  },
  {
    name: "Platform-audit",
    // Role 'auditor' (P5): the DISTINCT, lower-privilege role that gets ONLY the restricted loom-audit
    // surface (cross-project transcript reads + file-finding to the Platform backlog) and 404s on the
    // Lead's elevated /mcp-platform AND on /mcp-orch — the load-bearing prompt-injection containment for
    // an agent that ingests UNTRUSTED transcript content. NOTE: the session role is what gates the
    // surface, and startAuditor LOCKS it to "auditor" via callerRole regardless of this profile role —
    // so this value is COSMETIC for routing (it just keeps a fresh seed self-consistent + lets an
    // auditor-kind schedule that routes by profile role resolve correctly). An already-seeded prod row
    // (P1 seeded it as 'platform') will NOT auto-update (seed-if-absent); reset it via
    // POST /api/profiles/:id/reset post-deploy to make the row match.
    role: "auditor",
    description:
      "Platform-audit rig: the scheduled, read-and-file-only transcript reviewer. Scans recent session transcripts across projects for Loom bugs, agent friction, and vague skill/prompt instructions, and files structured findings onto the Platform backlog. Lower-privilege than the Lead by design (it reads untrusted content).",
    allowDelta: [],
    skills: null,
    model: null,
    icon: "🔎",
  },
];

/**
 * A bundled profile belongs to the dev-only Platform layer (Platform-lead / Platform-audit) iff its role
 * is one of the two platform-exclusive roles. Those two profiles seed only under LOOM_DEV; every other
 * bundled profile is CORE product and always seeds. Keyed by role (not name) so a future bundled platform
 * profile is gated automatically without touching this gate.
 *
 * NB: the END-USER Auditor's "workspace-auditor" role is deliberately NOT in this set — it is CORE
 * product, so its future bundled "Workspace Auditor" rig (B4) must seed ungated for every loomctl user
 * (like the worker/Setup-Assistant rigs), NOT only under LOOM_DEV. See `[[End-User Platform Tier Design]]`
 * gotcha #6.
 */
export function isPlatformProfile(p: Pick<Profile, "role">): boolean {
  return p.role === "platform" || p.role === "auditor";
}

/**
 * Seed the bundled profiles into the platform-level `profiles` table ONLY IF ABSENT (matched by
 * name), mirroring seedGlobalSkills' seed-if-absent contract: a user's future edits survive reboots,
 * and re-running is idempotent (no duplicates). Returns the names actually seeded this call.
 *
 * DEV-ONLY GATE: the two Platform-layer profiles (Platform-lead / Platform-audit) seed only when LOOM_DEV
 * is set (see paths.ts › isLoomDev); the CORE profiles (Orchestrator/Dev/Bugfix/QA/Web Designer/…) always
 * seed for every `loomctl` user.
 */
export function seedDefaultProfiles(db: Db): string[] {
  const devMode = isLoomDev();
  const existing = new Set(db.listProfiles().map((p) => p.name));
  const seeded: string[] = [];
  for (const p of BUNDLED_PROFILES) {
    if (!devMode && isPlatformProfile(p)) continue; // dev-only Platform layer — omit for loomctl users
    if (existing.has(p.name)) continue; // preserve user edits / avoid duplicates
    db.insertProfile({ id: randomUUID(), ...p });
    seeded.push(p.name);
  }
  return seeded;
}

/**
 * The shipped definition for a bundled profile, matched BY NAME (the seed key) — the profile analog of
 * skills/store.ts's asset lookup. Returns undefined for a user-created (or renamed-away) name. Extracted
 * from resetProfileToBundled's inline lookup so the customization engine (base snapshot / merge / adopt)
 * shares ONE definition of "what's the shipped version of this profile". Distinct from isBundledProfile(),
 * which checks role ∈ {platform,auditor} (a platform-LAYER gate) — this is matched-BY-NAME, a different
 * concept (a bundled-by-name profile may be any role).
 */
export function bundledProfileByName(name: string): Omit<Profile, "id"> | undefined {
  return BUNDLED_PROFILES.find((b) => b.name === name);
}

/**
 * Restore a profile to its shipped BUNDLED_PROFILES version, discarding any UI edits — the profile
 * analogue of skills/store.ts resetSkillToBundled, closing the same seed-if-absent gap (seeding never
 * overwrites, so improvements to a bundled profile don't reach an existing row on reboot). The bundled
 * entry is matched by NAME (the seed key), preserving the row's id + any agent assignments. Returns
 * false (caller → 404) if the id is unknown OR its name isn't a bundled one (a user-created profile
 * can't be "reset"). The user may have renamed a bundled profile, in which case it's no longer matchable
 * — that's the documented limitation, identical to the skill reset's bundled-by-name contract.
 *
 * ALSO advances the `base` snapshot to shipped (mirrors resetSkillToBundled's base re-sync) so the
 * post-reset state is PRISTINE (mine == base == shipped) rather than a stale "update available".
 */
export function resetProfileToBundled(db: Db, id: string): boolean {
  const existing = db.getProfile(id);
  if (!existing) return false;
  const bundled = bundledProfileByName(existing.name);
  if (!bundled) return false; // not a bundled profile (or renamed away from its bundled name)
  db.updateProfile(id, { ...bundled }); // overwrite every field with the shipped values
  db.setProfileBaseSnapshot(id, JSON.stringify(bundled)); // base = shipped: post-reset is pristine
  return true;
}

/**
 * Backfill the `base` snapshot for every bundled-by-name profile row that has none — one-time,
 * seed-if-absent (called from boot AFTER seedDefaultProfiles). base := the CURRENT shipped def. The SAFE
 * direction, exactly like skills/store.ts seedBaseSnapshots:
 *  - pristine (mine == shipped): base == mine == shipped → neither customized nor update.
 *  - already-customized (mine != shipped, edited before base existed): base == shipped → customized, no
 *    update — until a NEWER def ships ahead of this base (then it surfaces as an update, correctly).
 * base only ADVANCES later on adopt / reset (explicit syncs); a base left behind a freshly-shipped def is
 * exactly the "update available" signal. Newly-seeded bundled profiles get their base the same boot pass.
 * Returns the names backfilled.
 */
export function seedProfileBaseSnapshots(db: Db): string[] {
  const seeded: string[] = [];
  for (const p of db.listProfiles()) {
    const shipped = bundledProfileByName(p.name);
    if (!shipped) continue; // user-created / not bundled-by-name
    if (db.getProfileBaseSnapshot(p.id) != null) continue; // already snapshotted — never clobber
    db.setProfileBaseSnapshot(p.id, JSON.stringify(shipped));
    seeded.push(p.name);
  }
  return seeded;
}
