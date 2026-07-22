import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SKILLS_DIR } from "../paths.js";
import { seedBaseSnapshots, seedFileBaseSnapshots, autoFastForwardPristineSkills, retireOrphanedBundledSkillDirs } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/skills -> dist -> daemon root -> assets/skills
const ASSET_SKILLS = path.join(__dirname, "..", "..", "assets", "skills");

/**
 * Seed Loom's bundled, project-agnostic skills into the Loom-OWNED skill store (~/.loom/skills) —
 * NOT ~/.claude/skills. This keeps Loom's skills separate from the user's personal set; each session
 * gets them injected as PROJECT-LOCAL skills (see skills/inject.ts). NOTE: a same-named personal
 * skill still wins over these (Claude Code's precedence is personal-overrides-project, not the
 * reverse) — see injectSkills' doc comment — so bundled skill names must not collide with common
 * personal ones.
 *
 * Seeds each bundled skill ONLY IF its SKILL.md is absent, so a user's UI edits to a skill survive
 * reboots (the old behavior force-copied every boot, which would clobber edits). A future "reset to
 * bundled" can force-refresh a single skill on demand.
 *
 * Self-heal: the gate is the skill's SKILL.md, not the dir. If a skill's dir exists but is EMPTY
 * (the historical junction bug let worktree removal delete the store's SKILL.md contents, leaving
 * a hollow dir that a dir-keyed "if absent" check would never refill), this (re)copies the bundled
 * asset so the store repopulates on the next boot. A present SKILL.md means a genuine skill (possibly
 * UI-edited) and is left untouched — EXCEPT that non-SKILL.md asset entries (a `scripts/` helper, a
 * `references/` doc, `NOTICE`, …) shipped by a LATER asset update are still backfilled here so a
 * BRAND-NEW file lands even for a skill seeded before it existed (card 7f73979f) — an EXISTING
 * reference/script file's own content updates are the separate, per-file base-tracked fast-forward
 * below (seedFileBaseSnapshots / autoFastForwardPristineSkills, card 75a0755d), not this seed-if-absent
 * copy. `force:false` copies only entries ABSENT from the store; every existing file (incl. an edited
 * SKILL.md) is left completely untouched.
 */
export function seedGlobalSkills(): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(ASSET_SKILLS, { withFileTypes: true }); } catch { return []; }
  const seeded: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const src = path.join(ASSET_SKILLS, e.name);
    const dest = path.join(SKILLS_DIR, e.name);
    if (fs.existsSync(path.join(dest, "SKILL.md"))) {
      // Genuine skill (incl. UI edits) — never overwrite, but backfill any NEW asset file/dir the store
      // doesn't have yet. Best-effort: a backfill hiccup must never break boot seeding of other skills.
      try { fs.cpSync(src, dest, { recursive: true, force: false }); } catch { /* best-effort backfill */ }
      continue;
    }
    fs.cpSync(src, dest, { recursive: true }); // missing or hollow dir → (re)seed
    seeded.push(e.name);
  }
  // Backfill the per-bundled-skill `base` snapshot (seed-if-absent) so listSkills can derive precise
  // customized / updateAvailable state and the adopt-update 3-way merge has a common ancestor. Lives
  // OUTSIDE SKILLS_DIR (never injected); store.ts owns the asset-path resolution (LOOM_ASSET_SKILLS-aware).
  seedBaseSnapshots();
  // Per-file (references/**, scripts/**, …) base backfill — the non-SKILL.md analog of the line above.
  // AFTER seedBaseSnapshots (mirrors its position, though the two aren't order-dependent on each other)
  // and BEFORE autoFastForwardPristineSkills, which needs every base to exist for its equality checks
  // to mean anything.
  seedFileBaseSnapshots();
  // Auto-retire store dirs left behind by a bundled-skill RENAME (e.g. `pickup` -> `loom-pickup`) — see
  // retireOrphanedBundledSkillDirs' own doc for the safety predicate. Uses each retired name's OWN base
  // snapshot (already backfilled above, or from a prior boot while it was still bundled), so it must run
  // AFTER seedBaseSnapshots.
  retireOrphanedBundledSkillDirs();
  // AFTER the base backfill (base must exist for the equality to mean anything): auto-fast-forward only
  // bundled skills that are customized:false (mine == base) and have a shipped update — lossless, since
  // there are no user edits to preserve. This deploys self-host doctrine changes on restart like code.
  // customized:true skills are NEVER auto-advanced — they wait for manual adopt exactly as today.
  autoFastForwardPristineSkills();
  return seeded;
}
