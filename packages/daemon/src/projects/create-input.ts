import type { Db } from "../db.js";
import type { ProjectConfigOverride, RepoRegistryEntry } from "@loom/shared";
import { validateReferenceRepos } from "./reference-repos.js";
import { validateDenyGlobs } from "./deny-globs.js";
import { validateRepoRegistry } from "./repos.js";
import { checkVaultRepoTripleContainment } from "./vault-path.js";
import { foreignRepoContext } from "./foreign-repos.js";
import { validateProjectConfigOverride } from "../mcp/platform.js";
import { resolveWrittenCardPolicyIds } from "../orchestration/card-policy.js";

/** Raw, unvalidated create-time fields shared by every human-only REST "bind a project" route. */
export interface ProjectCreateInputRaw {
  referenceRepos?: unknown;
  noGateByDesign?: unknown;
  denyGlobs?: unknown;
  repos?: unknown;
  config?: ProjectConfigOverride;
}

export interface ProjectCreateInputValidated {
  referenceRepos: string[];
  noGateByDesign: boolean;
  denyGlobs: string[];
  repos: RepoRegistryEntry[];
  repoGateWarning?: string;
  config: ProjectConfigOverride;
}

export type ProjectCreateInputCheck =
  | { ok: true; value: ProjectCreateInputValidated }
  | { ok: false; status: 400 | 409; error: string };

/**
 * Card 793010d9 — the ONE shared validator for the human-only REST project-create chain:
 * referenceRepos -> noGateByDesign -> denyGlobs -> repos -> config -> triple-containment -> pin
 * pre-flight, run in exactly that order, before any disk/DB side effect. `POST /api/projects` and
 * `POST /api/setup/project-init` (gateway/server.ts) both call this instead of hand-wiring the chain
 * themselves — that two-path duplication is exactly how `config` validation was missed on both routes
 * until card afda2a26. Each caller resolves its OWN repoPath/vaultPath first (that part genuinely
 * differs between the two routes — project-init derives a fresh, not-yet-created target; the other
 * route takes a caller-given, already-existing path) and passes the result in as `ctx`.
 *
 * Deliberately does NOT touch which config validator runs: `config` always goes through the REST/human
 * validator here, never the restricted agent one. The agent-facing MCP create tools (mcp/platform.ts,
 * mcp/setup.ts) stay on their own stricter validator and do not call this function — they never accept
 * referenceRepos/noGateByDesign/denyGlobs/repos as input at all (human-only fields), so there is no
 * shared chain for them to adopt here.
 *
 * Deliberately does NOT create a directory or insert the project row — the two REST routes differ there
 * (one bootstraps a fresh dir only after this returns ok; the other never creates one) — this function
 * is validation only, so a refusal here can never leave a stray side effect behind.
 */
export async function validateProjectCreateInput(
  db: Db,
  raw: ProjectCreateInputRaw,
  ctx: { projectId: string; repoPath: string; vaultPath: string; pairingIsIntentional: boolean },
): Promise<ProjectCreateInputCheck> {
  let referenceRepos: string[] = [];
  if (raw.referenceRepos !== undefined) {
    const check = await validateReferenceRepos(raw.referenceRepos);
    if (!check.ok) return { ok: false, status: 400, error: check.error };
    referenceRepos = check.value;
  }
  const noGateByDesign = raw.noGateByDesign === true;
  let denyGlobs: string[] = ["mockups/**"];
  if (raw.denyGlobs !== undefined) {
    const check = validateDenyGlobs(raw.denyGlobs);
    if (!check.ok) return { ok: false, status: 400, error: check.error };
    denyGlobs = check.value;
  }
  let repos: RepoRegistryEntry[] = [];
  let repoGateWarning: string | undefined;
  if (raw.repos !== undefined) {
    const check = await validateRepoRegistry(raw.repos, { repoPath: ctx.repoPath, vaultPath: ctx.vaultPath });
    if (!check.ok) return { ok: false, status: 400, error: check.error };
    repos = check.value;
    if (check.warnings.length) repoGateWarning = check.warnings.join(" | ");
  }
  const configCheck = validateProjectConfigOverride(raw.config);
  if (!configCheck.ok) return { ok: false, status: 400, error: `invalid config: ${configCheck.error}` };
  // A new project has no cards, so a card-policy `cardIds` entry cannot resolve and is refused (a prefix stored
  // unresolved would later capture unrelated cards via startsWith). Both human POST routes share this point.
  const idsResolved = resolveWrittenCardPolicyIds(configCheck.value, []);
  if (!idsResolved.ok) return { ok: false, status: 400, error: `invalid config: ${idsResolved.error}` };
  const tripleCheck = await checkVaultRepoTripleContainment(
    { repoPath: ctx.repoPath, vaultPath: ctx.vaultPath, repos },
    { pairingIsIntentional: ctx.pairingIsIntentional, foreign: foreignRepoContext(db, ctx.projectId) },
  );
  if (!tripleCheck.ok) return { ok: false, status: 400, error: tripleCheck.error };
  const pinCheck = db.checkCommondirPinConflicts(ctx.projectId, [
    { repoKey: "primary", repoPath: ctx.repoPath },
    ...repos.map((r) => ({ repoKey: r.key, repoPath: r.path })),
  ]);
  if (!pinCheck.ok) return { ok: false, status: 409, error: pinCheck.error };
  return { ok: true, value: { referenceRepos, noGateByDesign, denyGlobs, repos, repoGateWarning, config: idsResolved.value } };
}
