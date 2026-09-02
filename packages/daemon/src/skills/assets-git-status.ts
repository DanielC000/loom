import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loomRepoRoot } from "../paths.js";
import { nonInteractiveEnv } from "../git/writer.js";
import type { SkillStoreStaleness } from "./store.js";

/**
 * Card bb76b8d8 — `skillStoreStaleness()` (store.ts) compares the STORE against the assets WORKING TREE
 * (`customizationState`'s `shipped = readFileOrNull(assetMd(name))`, a plain `fs.readFileSync`) and never
 * consults git. That makes a live, uncommitted `assets/skills/**` edit invisible: once the edit is also
 * reflected in the store (however that happened — a manual sync, a publish, hand-copying), `shipped ===
 * base === mine` and `skillStoreStaleness()` reports a clean bill — even though the edit exists in NO
 * commit, and a `git checkout -- .` / `git stash` / clean clone would silently destroy it. This module is
 * the missing git-aware half: does `packages/daemon/assets/skills` differ from HEAD right now?
 *
 * Mirrors `deploy-staleness.ts`'s discipline exactly (same reasoning, read it before touching this):
 * bounded `execFileSync` git calls (`GIT_TIMEOUT_MS`), NEVER throws, and degrades to an explicit
 * `available:false` for a non-git checkout (a packaged `loomctl` install has no `.git` at all — this must
 * never report a false "uncommitted" there) or any other git failure (a timeout, git missing, a corrupt
 * repo) — same two-way `reasonKind` split (`"not-applicable"` vs `"could-not-measure"`) as that module.
 *
 * DELIBERATELY a VISIBILITY signal only (card bb76b8d8 DoD #3) — never a blocking check or a boot refusal.
 * Surfaced on `served_status` (served-status.ts), the same human-facing surface `skillStoreStaleness`
 * already uses, rather than a new standalone tool — a manager/human diagnosing "why is this skill stale"
 * already reads that one place.
 */

export type SkillAssetsUncommittedReasonKind = "not-applicable" | "could-not-measure";

export interface SkillAssetsGitStatus {
  /** false when this daemon isn't running from a real Loom source checkout, or the git read failed. */
  available: boolean;
  /** Present only when available is false — why the signal could not be computed. */
  reason?: string;
  /** Present only when available is false — same "not-applicable" (no `.git`, e.g. a packaged install —
   *  never meaningful here) vs "could-not-measure" (reachable in principle, a step failed) split as
   *  `deploy-staleness.ts`'s `DeployUnavailableReasonKind`, reused unchanged. */
  reasonKind?: SkillAssetsUncommittedReasonKind;
  /** true when `git status --porcelain` shows a staged or unstaged change (including a new untracked
   *  file) under `packages/daemon/assets/skills`, relative to HEAD — a live, unrecorded skill edit.
   *  Always `false` when `available` is false (never a fabricated positive without proof). */
  uncommitted: boolean;
  /** Repo-relative `git status --porcelain` lines (status chars stripped) under assets/skills that are
   *  dirty, when `uncommitted` is true. Empty when available is false or nothing is dirty. */
  uncommittedPaths: string[];
}

const GIT_TIMEOUT_MS = 1000;
/** Relative to repoRoot — the real on-disk location of the bundled skill assets (see store.ts's own
 *  `ASSET_SKILLS`: `dist/skills/../../assets/skills` resolves to `packages/daemon/assets/skills`).
 *  Hardcoded, like `deploy-staleness.ts`'s own `DEPLOY_PACKAGES` pathspecs — this is a git pathspec
 *  against the REAL repo tree, independent of the `LOOM_ASSET_SKILLS` test-seam env override store.ts
 *  supports for its own CRUD tests (that override can point anywhere, including outside any git repo —
 *  this module never reads it). */
const ASSET_SKILLS_PATHSPEC = "packages/daemon/assets/skills";

function runGit(repoRoot: string, args: string[]): string {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    env: nonInteractiveEnv(),
  });
}

function unavailable(reason: string, reasonKind: SkillAssetsUncommittedReasonKind): SkillAssetsGitStatus {
  return { available: false, reason, reasonKind, uncommitted: false, uncommittedPaths: [] };
}

export interface SkillAssetsGitStatusOptions {
  /** Test seam: a fixture git repo root. Production callers omit this and get the real repo root
   *  (`loomRepoRoot()`, itself overridable via `LOOM_REPO_ROOT` — see paths.ts). */
  repoRoot?: string;
}

/** Fresh, uncached read of whether `packages/daemon/assets/skills` has uncommitted changes relative to
 *  HEAD — see the module doc above for why this exists and what it deliberately does NOT do (block, or
 *  replace `skillStoreStaleness`). */
export function skillAssetsGitStatus(options: SkillAssetsGitStatusOptions = {}): SkillAssetsGitStatus {
  const repoRoot = options.repoRoot ?? loomRepoRoot();
  if (!fs.existsSync(path.join(repoRoot, ".git"))) {
    return unavailable(
      "this daemon is not running from a Loom source checkout (no .git at the resolved repo root) — not applicable to a packaged install",
      "not-applicable",
    );
  }
  let out: string;
  try {
    out = runGit(repoRoot, ["status", "--porcelain", "--", ASSET_SKILLS_PATHSPEC]);
  } catch (err) {
    return unavailable(
      `could not read git status for ${ASSET_SKILLS_PATHSPEC}: ${err instanceof Error ? err.message : String(err)}`,
      "could-not-measure",
    );
  }
  // Porcelain v1: each line is "XY <path>" — 2 status chars + one space, then the path (a rename appends
  // " -> <new path>", left intact in the slice below — still a real dirty entry, just not further parsed).
  const uncommittedPaths = out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.slice(3).trim());
  return { available: true, uncommitted: uncommittedPaths.length > 0, uncommittedPaths };
}

/** The three (plus one honest "can't tell") states card bb76b8d8 DoD #4 requires distinguished. A boolean
 *  that collapsed the middle state into either neighbour would not have fixed anything — see each arm's
 *  own comment in `deriveSkillAssetsSyncState` below. */
export type SkillAssetsSyncState = "clean" | "uncommitted" | "stale" | "undetermined";

/**
 * Combines `skillStoreStaleness()` (does the STORE match the shipped asset on disk) with
 * `skillAssetsGitStatus()` (does that shipped asset match git HEAD) into one legible verdict:
 *  - "stale"       — `storeStaleness.stale`: the store itself is behind the (possibly also uncommitted)
 *                    shipped asset — pending restart/adopt, independent of git state. Checked FIRST: a
 *                    store genuinely out of sync is the more actionable fact even on the rare overlap
 *                    where the asset edit that produced it is ALSO uncommitted.
 *  - "uncommitted" — the store IS in sync with the shipped asset (`skillStoreStaleness` reads clean), but
 *                    that shipped asset itself has an uncommitted change relative to HEAD — THE BUG this
 *                    card exists for: a live-but-unrecorded skill edit that used to read as fully clean.
 *  - "clean"       — in sync AND committed — the ordinary healthy state.
 *  - "undetermined"— git status couldn't be read (no `.git` / a packaged install / a git failure) — never
 *                    collapsed into "clean", which would be a false all-clear for a genuinely unknown state.
 */
export function deriveSkillAssetsSyncState(
  storeStaleness: SkillStoreStaleness,
  gitStatus: SkillAssetsGitStatus,
): SkillAssetsSyncState {
  if (storeStaleness.stale) return "stale";
  if (!gitStatus.available) return "undetermined";
  return gitStatus.uncommitted ? "uncommitted" : "clean";
}
