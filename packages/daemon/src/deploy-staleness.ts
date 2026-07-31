import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loomRepoRoot } from "./paths.js";
import { nonInteractiveEnv } from "./git/writer.js";
import { DEPLOY_PACKAGES } from "./deploy-packages.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Card 5e30c4bd — "merged" and "running" silently diverged for ~1h50m (a daemon-`src` commit sat on
 * mainline, unrestarted, invisible to every surface). This derives a STALENESS signal by comparing the
 * RUNNING daemon's own build artifact against mainline HEAD — never `version`/`webBundle`, which the
 * incident's own after-action measurement proved BOTH stay byte-identical across a source-only deploy
 * (see served_status's doc comment) — so either would report a false CLEAN for exactly this case.
 *
 * DoD #2 (`637558ca` cry-wolf precedent): `stale`/`commitsBehind` are scoped to ONLY the paths whose
 * changes actually require a rebuild+RESTART to take effect — `packages/daemon/src` and
 * `packages/shared/src` (see `DEPLOY_PACKAGES`, `./deploy-packages.js`). `assets/**` (skills, hook-relay)
 * is read live per-spawn with NO restart needed (see CLAUDE.md's asset-merge caveat), and a vault/docs-only
 * merge needs no restart either — a signal that cries stale on those gets ignored within a day, which is
 * worse than no signal.
 *
 * Card c3ce92ea — `packages/web` is DELIBERATELY excluded from `stale`/`commitsBehind` (a web-only merge
 * must never advise a `daemon_restart`, which drops every live session across ALL projects), but it is NOT
 * ignored: the daemon serves `packages/web/dist` LIVE FROM DISK on every request (`@fastify/static`'s
 * `root`, `gateway/server.ts`) — confirmed by reading that registration, not assumed — so a web-only change
 * needs only a REBUILD, never a restart. That gets its OWN independent signal, `webStale`/
 * `webCommitsBehind`, comparing `packages/web/src` commits against `packages/web/dist`'s own build clock.
 * A prior version of this module's doc claimed `served_status`'s `webBundle` hash check already covered
 * this — it does not: `webBundle` only proves a *hash changed after a rebuild*, it has no notion of
 * "commits landed since the last rebuild" and cannot answer "is a rebuild needed right now", which is what
 * `webStale` answers instead.
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
 * DoD #4: every clock is DERIVED at call time, NEVER persisted — the dist scans and `git log` calls all
 * run fresh on every call. No caching, no stored "deploy is current" flag (that would recreate the exact
 * defect one layer down). Bounded — THREE `runGit` calls (mainline HEAD, the restart-relevant log, and
 * `webStale`'s own web-relevant log), each capped at `GIT_TIMEOUT_MS`, so the worst case is
 * 3×`GIT_TIMEOUT_MS` of the event loop fully blocked (this is a synchronous `execFileSync`, unlike the
 * async claude-version cache — see the call-site doc at `manager-prompt.ts` for why that's an acceptable
 * tradeoff here) PLUS the (cheap, synchronous `fs`) dist scans. Manager spawns can BURST (boot-reconcile
 * resumes every manager across every project at once), so keep the git timeout constant small — a local
 * `git log` is normally tens of ms; the timeout only matters when something is already wrong. NEVER
 * throws — any failure (not a git checkout, e.g. a packaged `loomctl` install; git unavailable; dist not
 * built; a timeout) degrades to `{available:false, reason}`, never a false stale/clean verdict — and this
 * applies uniformly to BOTH the restart signal and the web signal: a failure computing either degrades
 * the WHOLE result, so `webStale` never reports a false clean/stale independent of `stale`'s own guarantee.
 *
 * ⚠️ KNOWN LIMITATION — this is a DATE comparison, not an ANCESTRY computation, for BOTH signals.
 * `commitsBehind`/`webCommitsBehind` count commits whose COMMITTER DATE is later than the relevant dist's
 * mtime — the only signal available from an mtime (there is no built-from-sha stamped anywhere to diff
 * against). This can be wrong in both directions: a commit landing with a non-monotonic committer date
 * (rebase, cherry-pick, clock skew) can be MISSED ⇒ false CLEAN; a build that runs BEFORE a commit is made
 * (build locally, then commit) counts that commit ⇒ false STALE. In practice this holds: Loom lands every
 * card via a squash merge, which stamps a FRESH committer date at merge time, so mainline dates are
 * effectively monotonic — the failure modes above need an unusual git operation directly on mainline to
 * trigger. This is a pre-existing, deliberately accepted tradeoff (card c1072385) — not something this
 * card changes.
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
  /** ISO mtime of the NEWEST file under `packages/web/dist`, or `null` if that dir is missing/empty (web
   * never built). Card c3ce92ea — the WEB analogue of `distBuiltAt`, kept fully independent so a web-only
   * change never feeds `stale`/`commitsBehind` (which mean "the daemon PROCESS needs a restart"). */
  webDistBuiltAt: string | null;
  /** Count of `packages/web/src` commits committed AFTER `webDistBuiltAt`. */
  webCommitsBehind: number;
  /** webCommitsBehind > 0 — mainline carries web changes the served `packages/web/dist` was not built
   * with. Unlike `stale`, this means "rebuild web", NOT "restart the daemon" — the daemon serves
   * `packages/web/dist` live from disk (see the module doc), so no restart is needed for this to clear. */
  webStale: boolean;
}

/** Paths whose changes actually require a daemon rebuild+RESTART — see the module doc's DoD #2 note. */
const RESTART_RELEVANT_PATHSPECS = DEPLOY_PACKAGES.filter((p) => p.restartRequired).map((p) => p.srcPathspec);
/** Paths whose changes need only a REBUILD (no restart) — currently just `packages/web/src`. */
const REBUILD_ONLY_PATHSPECS = DEPLOY_PACKAGES.filter((p) => !p.restartRequired).map((p) => p.srcPathspec);

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
  return {
    available: false,
    reason,
    distBuiltAt: null,
    mainlineHeadSha: null,
    mainlineHeadDate: null,
    commitsBehind: 0,
    stale: false,
    webDistBuiltAt: null,
    webCommitsBehind: 0,
    webStale: false,
  };
}

/** Counts entries in a `runGit`-produced `%H<UNIT_SEP>%cI` log whose committer date is after `sinceMs`. */
function countCommitsAfter(log: string, sinceMs: number): number {
  return log
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split(UNIT_SEP)[1])
    .filter((dateStr) => !!dateStr && new Date(dateStr).getTime() > sinceMs).length;
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
 * `distEntryOverride`/`repoRootOverride`/`sharedDistOverride`/`webDistOverride` are test seams (a fixture
 * `dist/index.js` path, a fixture git repo, a fixture `packages/shared/dist` dir, and a fixture
 * `packages/web/dist` dir); production callers omit all four and get the real running daemon's own paths.
 */
export function computeDeployStaleness(
  distEntryOverride?: string,
  repoRootOverride?: string,
  sharedDistOverride?: string,
  webDistOverride?: string,
): DeployStalenessResult {
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

  // Card c3ce92ea — the web build clock is INDEPENDENT of the daemon/shared one above: a web-only rebuild
  // must not read clean off the daemon's dist, and vice versa. `packages/web/dist` may legitimately be
  // entirely absent (an API-only deploy, or web never built) — that degrades to a null webDistBuiltAt and
  // an effective clock of epoch 0 (every web-src commit ever counts as unbuilt), never to `unavailable`.
  const webDistDir = webDistOverride ?? path.join(repoRoot, "packages", "web", "dist");
  const webBuildMaxMsRaw = newestMtimeMs(webDistDir);
  const webBuildMaxMs = webBuildMaxMsRaw ?? 0;
  const webDistBuiltAt = webBuildMaxMsRaw === null ? null : new Date(webBuildMaxMsRaw).toISOString();

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
  const commitsBehind = countCommitsAfter(relevantLog, buildMaxMs);

  let webRelevantLog: string;
  try {
    webRelevantLog = runGit(repoRoot, ["log", `--pretty=%H${UNIT_SEP}%cI`, "--max-count=2000", "--", ...REBUILD_ONLY_PATHSPECS]);
  } catch (err) {
    return unavailable(`could not read web-src commit history: ${err instanceof Error ? err.message : String(err)}`);
  }
  const webCommitsBehind = countCommitsAfter(webRelevantLog, webBuildMaxMs);

  return {
    available: true,
    distBuiltAt,
    mainlineHeadSha,
    mainlineHeadDate: mainlineHeadDate ?? null,
    commitsBehind,
    stale: commitsBehind > 0,
    webDistBuiltAt,
    webCommitsBehind,
    webStale: webCommitsBehind > 0,
  };
}
