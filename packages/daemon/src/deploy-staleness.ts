import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loomRepoRoot } from "./paths.js";
import { nonInteractiveEnv } from "./git/writer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Card 5e30c4bd — "merged" and "running" silently diverged for ~1h50m (a daemon-`src` commit sat on
 * mainline, unrestarted, invisible to every surface). This derives a STALENESS signal by comparing the
 * RUNNING daemon's own build artifact against mainline HEAD — never `version`/`webBundle`, which the
 * incident's own after-action measurement proved BOTH stay byte-identical across a source-only deploy
 * (see served_status's doc comment) — so either would report a false CLEAN for exactly this case.
 *
 * DoD #2 (`637558ca` cry-wolf precedent): scoped to ONLY the two paths whose changes actually require a
 * rebuild+restart to take effect — `packages/daemon/src` and `packages/shared/src`. `assets/**` (skills,
 * hook-relay) is read live per-spawn with NO restart needed (see CLAUDE.md's asset-merge caveat), and a
 * vault/docs-only merge needs no restart either — a signal that cries stale on those gets ignored within
 * a day, which is worse than no signal. Deliberately excludes `packages/web` too: a web-only change is
 * caught by `served_status`'s existing `webBundle` hash check, which this signal is not meant to duplicate.
 *
 * Card c1072385 — `tsc` builds are INCREMENTAL: only files whose input changed get rewritten, so
 * `dist/index.js`'s own mtime means "when `index.ts` last changed" (rare), NOT "when this daemon was
 * last built" (frequent — a build that touches only e.g. `deploy-staleness.ts` leaves `index.js`
 * untouched). Measured live: `dist/` mtimes spanned a THREE-HOUR range for one deploy, and comparing
 * against `index.js` alone reported a FALSE `stale:true` for a daemon that had the latest commit
 * compiled in the whole time. The build clock is now the NEWEST mtime across every file recursively
 * under BOTH `packages/daemon/dist` and `packages/shared/dist` (the shared package is in the same
 * restart-relevant pathspec below, so a shared-only rebuild must not read clean off a stale daemon dist
 * either) — see `newestMtimeMs`. Measured cost on this checkout: 664 daemon-dist files + 24 shared-dist
 * files, ~18ms wall time for both recursive scans combined — negligible next to the 2×`GIT_TIMEOUT_MS`
 * git budget below, so no narrower subset was needed.
 *
 * DoD #4: both clocks are DERIVED at call time, NEVER persisted — the dist scan and `git log` mainline
 * both run fresh on every call. No caching, no stored "deploy is current" flag (that would recreate the
 * exact defect one layer down). Bounded — TWO `runGit` calls, each capped at `GIT_TIMEOUT_MS`, so the
 * worst case is 2×`GIT_TIMEOUT_MS` of the event loop fully blocked (this is a synchronous
 * `execFileSync`, unlike the async claude-version cache — see the call-site doc at `manager-prompt.ts`
 * for why that's an acceptable tradeoff here) PLUS the (cheap, synchronous `fs`) dist scan. Manager
 * spawns can BURST (boot-reconcile resumes every manager across every project at once), so keep the git
 * timeout constant small — a local `git log` is normally tens of ms; the timeout only matters when
 * something is already wrong. NEVER throws — any failure (not a git checkout, e.g. a packaged `loomctl`
 * install; git unavailable; dist not built; a timeout) degrades to `{available:false, reason}`, never a
 * false stale/clean verdict.
 *
 * ⚠️ KNOWN LIMITATION — this is a DATE comparison, not an ANCESTRY computation. `commitsBehind` counts
 * commits whose COMMITTER DATE is later than the `dist` file's mtime — the only signal available from an
 * mtime (there is no built-from-sha stamped anywhere to diff against). This can be wrong in both
 * directions: a commit landing with a non-monotonic committer date (rebase, cherry-pick, clock skew) can
 * be MISSED ⇒ false CLEAN; a build that runs BEFORE a commit is made (build locally, then commit) counts
 * that commit ⇒ false STALE. In practice this holds: Loom lands every card via a squash merge, which
 * stamps a FRESH committer date at merge time, so mainline dates are effectively monotonic — the failure
 * modes above need an unusual git operation directly on mainline to trigger.
 */
export interface DeployStalenessResult {
  /** false when this daemon isn't running from a real Loom source checkout, or the check failed. */
  available: boolean;
  /** Present only when available is false — why the signal could not be computed. */
  reason?: string;
  /** ISO mtime of the NEWEST file across this daemon's built output (`packages/daemon/dist`) and
   * `packages/shared/dist`, recursively — see the module doc for why a single file's mtime (e.g.
   * `dist/index.js`) is unusable as a build clock under an incremental `tsc` build. */
  distBuiltAt: string | null;
  /** Mainline HEAD's full commit sha (unfiltered — the repo's actual current tip). */
  mainlineHeadSha: string | null;
  /** Mainline HEAD's committer date, ISO. */
  mainlineHeadDate: string | null;
  /** Count of `packages/daemon/src` / `packages/shared/src` commits committed AFTER distBuiltAt. */
  commitsBehind: number;
  /** commitsBehind > 0 — mainline carries daemon-src/shared changes this running process was not built with. */
  stale: boolean;
}

/** Paths whose changes actually require a daemon rebuild+restart — see the module doc's DoD #2 note. */
const RESTART_RELEVANT_PATHSPECS = ["packages/daemon/src", "packages/shared/src"];

const GIT_TIMEOUT_MS = 1000;
const UNIT_SEP = "\x1f";

function runGit(repoRoot: string, args: string[]): string {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    env: nonInteractiveEnv(),
  });
}

function unavailable(reason: string): DeployStalenessResult {
  return { available: false, reason, distBuiltAt: null, mainlineHeadSha: null, mainlineHeadDate: null, commitsBehind: 0, stale: false };
}

/**
 * Recursively finds the newest file mtime under `dir`, in ms since epoch. Returns `null` if `dir`
 * doesn't exist or contains no files (an empty/missing dist dir contributes nothing to the build
 * clock, rather than being treated as an error — `packages/shared/dist` in particular may be absent in
 * some checkouts, and that must not make the whole signal unavailable). Never throws: an unreadable
 * directory or a file that vanishes between listing and stat (a build racing this read) is skipped, not
 * fatal — this best-effort scan only ever needs to find the max mtime, not certify every file.
 */
function newestMtimeMs(dir: string): number | null {
  let max: number | null = null;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const mtimeMs = fs.statSync(full).mtimeMs;
        if (max === null || mtimeMs > max) max = mtimeMs;
      } catch {
        // vanished between readdir and stat — skip, not fatal.
      }
    }
  }
  return max;
}

/**
 * Compute the deploy-staleness signal fresh, right now — see the module doc for the design rationale.
 * `distEntryOverride`/`repoRootOverride`/`sharedDistOverride` are test seams (a fixture `dist/index.js`
 * path, a fixture git repo, and a fixture `packages/shared/dist` dir); production callers omit all three
 * and get the real running daemon's own paths.
 */
export function computeDeployStaleness(distEntryOverride?: string, repoRootOverride?: string, sharedDistOverride?: string): DeployStalenessResult {
  const distIndex = distEntryOverride ?? path.join(__dirname, "index.js");
  try {
    fs.statSync(distIndex);
  } catch {
    return unavailable("this daemon's own built entry (dist/index.js) was not found — cannot derive a build time");
  }
  const distDir = path.dirname(distIndex);

  const repoRoot = repoRootOverride ?? loomRepoRoot();
  if (!fs.existsSync(path.join(repoRoot, ".git"))) {
    return unavailable("this daemon is not running from a Loom source checkout (no .git at the resolved repo root) — not applicable to a packaged install");
  }

  const sharedDistDir = sharedDistOverride ?? path.join(repoRoot, "packages", "shared", "dist");
  // distDir always contributes at least distIndex's own mtime (just confirmed to exist above);
  // sharedDistDir may legitimately be absent (newestMtimeMs ⇒ null) without making the signal unavailable.
  const buildMaxMs = Math.max(newestMtimeMs(distDir) ?? 0, newestMtimeMs(sharedDistDir) ?? 0);
  const distBuiltAt = new Date(buildMaxMs).toISOString();

  let headLine: string;
  try {
    headLine = runGit(repoRoot, ["log", "-1", `--pretty=%H${UNIT_SEP}%cI`]).trim();
  } catch (err) {
    return unavailable(`could not read mainline HEAD: ${err instanceof Error ? err.message : String(err)}`);
  }
  const [mainlineHeadSha, mainlineHeadDate] = headLine.split(UNIT_SEP);
  if (!mainlineHeadSha) return unavailable("git log returned no HEAD commit (a commitless repo?)");

  let relevantLog: string;
  try {
    relevantLog = runGit(repoRoot, ["log", `--pretty=%H${UNIT_SEP}%cI`, "--max-count=2000", "--", ...RESTART_RELEVANT_PATHSPECS]);
  } catch (err) {
    return unavailable(`could not read daemon-src/shared commit history: ${err instanceof Error ? err.message : String(err)}`);
  }

  const commitsBehind = relevantLog
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split(UNIT_SEP)[1])
    .filter((dateStr) => !!dateStr && new Date(dateStr).getTime() > buildMaxMs)
    .length;

  return {
    available: true,
    distBuiltAt,
    mainlineHeadSha,
    mainlineHeadDate: mainlineHeadDate ?? null,
    commitsBehind,
    stale: commitsBehind > 0,
  };
}
