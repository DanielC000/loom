import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { loomRepoRoot } from "./paths.js";
import { nonInteractiveEnv } from "./git/writer.js";
import { DEPLOY_PACKAGES } from "./deploy-packages.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * @decision 5e30c4bd — never use `version`/`webBundle` as a staleness proxy: both stay byte-identical
 * across a source-only deploy — the exact incident (a daemon-src commit merged but unrestarted for
 * ~1h50m, invisible to every surface) this module exists to catch.
 *
 * @decision 637558ca — never widen `stale`/`commitsBehind` past `packages/daemon/src`/
 * `packages/shared/src` (`DEPLOY_PACKAGES`) to count docs/assets/scripts changes — a signal that cries
 * stale on those gets ignored within a day, which is worse than no signal at all.
 * @decision e8697dd3 — `assets/skills/**` is excluded from this reasoning, not covered by it: never read
 * this module's silence on it as "no restart needed" — it needs one for a DIFFERENT reason (a separate
 * store re-sync), tracked by `skills/store.ts`'s own `skillStoreStaleness()` signal.
 *
 * @decision c3ce92ea — never fold `packages/web` changes into `stale`/`commitsBehind`: a web-only merge
 * must never advise a `daemon_restart`. It gets its own `webStale`/`webCommitsBehind` signal instead,
 * since the daemon serves `packages/web/dist` live from disk and only needs a rebuild, never a restart.
 *
 * @decision c1072385 — never read a single dist file's mtime (e.g. `dist/index.js`) as the build clock:
 * an incremental `tsc` build can leave it untouched for hours after a real rebuild. Use the NEWEST mtime
 * across every file recursively under BOTH `packages/daemon/dist` and `packages/shared/dist` instead.
 *
 * DoD #4: every clock is DERIVED at call time, NEVER persisted — the dist scans and `git log` calls all
 * run fresh on every call. No caching, no stored "deploy is current" flag (that would recreate the exact
 * defect one layer down). Bounded — THREE unconditional `runGit` calls (mainline HEAD, the restart-relevant
 * log, and `webStale`'s own web-relevant log), each capped at `GIT_TIMEOUT_MS`, PLUS a conditional FOURTH
 * (see `deploySignatureMismatch` below — a single-object `git log -1 <sha>` lookup, not a graph walk, fired
 * only when the date-based clock already claims `stale:false` and `processBuiltSha` differs from `mainlineHeadSha`)
 * PLUS a conditional FIFTH and SIXTH (card 3d7dccb9 — `builtContentMatchesHead`'s `git merge-base
 * --is-ancestor` + `git diff --name-only`, fired only when `processBuiltSha` is resolvable AND not an
 * ancestor of `mainlineHeadSha` — the same rare, already-anomalous branch the fourth call's sibling logic
 * lives in, not an additional unconditional cost) — worst case 6×`GIT_TIMEOUT_MS` of the event loop fully
 * blocked (this is a synchronous `execFileSync`, unlike the async claude-version cache — see the call-site
 * doc at `manager-prompt.ts` for why that's an acceptable tradeoff here) PLUS the (cheap, synchronous `fs`)
 * dist scans.
 * @decision c6e7ebe7 — never raise `GIT_TIMEOUT_MS` without a measured stall (147–275ms IDLE / 220–465ms
 * at 3× oversubscription measured, never approached up to 9×) and never single out a timeout from the
 * `unavailable()` reason taxonomy on its own initiative — see `d3d4d432`'s record for the actual axis.
 * NEVER throws — any failure (not a git checkout, e.g. a packaged `loomctl` install; git unavailable; dist
 * not built; a timeout) degrades to `{available:false, reason}`, never a false stale/clean verdict — and
 * this applies uniformly to BOTH the restart signal and the web signal: a failure computing either degrades
 * the WHOLE result, so `webStale` never reports a false clean/stale independent of `stale`'s own guarantee.
 *
 * @decision f26339d7 — `distBuiltSha`/`processBuiltSha` are the missing POSITIVE signal, closing the gap
 * where a turbo cache-replay (the `aad5fff3` footgun) can make every DERIVED clock above agree and all be
 * wrong at once. Never cache `processBuiltSha` here — capture it once at process START, in the caller.
 * @decision 3d7dccb9 — never remove, bypass, or let run cached the `stamp` turbo task that (re)writes
 * `build-info.json` on every build: turbo's local cache is SHARED across every git worktree of this
 * repo, so only an uncached, same-invocation stamp keeps the baked sha off a replayed foreign worktree's.
 * @decision 24f53a72 — never assume a forced `"build"` protects its own cache WRITE the way `--force`
 * protects the READ: it still writes a cache entry that can clobber `stamp`'s own output. `turbo.json`'s
 * `build` outputs exclude `"!dist/build-info.json"` so only `stamp` can ever touch that file.
 *
 * @decision 8ff7ccde — never compute `stale`/`commitsBehind` against the raw `distBuiltAt` clock: a
 * rebuild without a restart can advance it while the process still runs older code. Use
 * `runningCodeBuiltAt` (`min(distBuiltAt, processStartedAt)`) instead, or staleness gets understated.
 * @decision 9aa4e2c9 — never derive `processStartedAt` as `Date.now() - process.uptime() * 1000` (mixes
 * a wall clock with a monotonic one and drifts between calls in the same boot); never recompute it per
 * call like every other clock here — read it ONCE from `performance.timeOrigin` instead.
 *
 * ⚠️ KNOWN LIMITATION (card c1072385 — see its own record above) — this is a DATE comparison, not an
 * ANCESTRY computation, for BOTH signals: `commitsBehind`/`webCommitsBehind` count commits whose COMMITTER
 * DATE is later than the relevant dist's mtime, which can be wrong in both directions on an unusual git
 * operation directly on mainline (rebase, cherry-pick, clock skew; building before committing) — accepted
 * because Loom lands every card via a squash merge, which stamps a fresh, effectively-monotonic committer
 * date at merge time.
 */
/** @decision d3d4d432 — never classify `reasonKind` downstream by string-matching the `reason` prose;
 * classify it at THE SOURCE (each `unavailable()` call site below), or the same defect this card fixed
 * comes back.
 *
 * `"not-applicable"` means the signal is NEVER meaningful here (today: no `.git` — a packaged install)
 * and staying silent is correct forever. `"could-not-measure"` means the instrument was reachable in
 * principle but a step failed (a race, a git error, a timeout) — never collapse the two into one silent
 * case, or a consumer produces a false all-clear for a signal that was merely unreachable. */
export type DeployUnavailableReasonKind = "not-applicable" | "could-not-measure";

export interface DeployStalenessResult {
  /** false when this daemon isn't running from a real Loom source checkout, or the check failed. */
  available: boolean;
  /** Present only when available is false — why the signal could not be computed. */
  reason?: string;
  /** Present only when available is false — see `DeployUnavailableReasonKind`'s own doc. */
  reasonKind?: DeployUnavailableReasonKind;
  /** ISO mtime of the NEWEST file across this daemon's built output (`packages/daemon/dist`) and
   * `packages/shared/dist`, recursively — see the module doc for why a single file's mtime (e.g.
   * `dist/index.js`) is unusable as a build clock under an incremental `tsc` build. An ON-DISK ARTIFACT
   * clock ONLY — card 8ff7ccde: it can be NEWER than the code this process is actually executing (a
   * rebuild without a restart). Use `runningCodeBuiltAt` for staleness; this field is for display/
   * transparency (see `distAheadOfProcess`). */
  distBuiltAt: string | null;
  /** ISO instant this process itself started — i.e. when its OWN currently-loaded code was read off disk
   * (Node imports a module's file once and never re-reads it). Card 8ff7ccde. Card 9aa4e2c9: a STABLE
   * value, read once from `performance.timeOrigin` (fixed by the runtime at process start) — deliberately
   * NOT recomputed per call the way every other clock in this module is; two reads of the same boot are
   * guaranteed to return the identical string, so this value IS safely joinable/comparable across reads
   * and across parties, unlike a clock this module derives fresh each time. */
  processStartedAt: string | null;
  /** `min(distBuiltAt, processStartedAt)` — the clock `commitsBehind`/`stale` are actually computed
   * against. Card 8ff7ccde: the earlier of the two is always a safe bound on what this process could
   * possibly be executing — a dist rebuilt after this process started can't have been loaded by it, so the
   * process's own start time is the honest clock in that case; otherwise the dist clock is already correct. */
  runningCodeBuiltAt: string | null;
  /** `distBuiltAt` is later than `processStartedAt` — the on-disk artifact has been rebuilt since this
   * process started and never picked that rebuild up (needs a restart to catch up). Card 8ff7ccde: kept as
   * its OWN visible field rather than folded silently into `commitsBehind`, so this is legible even in the
   * (rare) case `commitsBehind` itself still reads 0. */
  distAheadOfProcess: boolean;
  /** Mainline HEAD's full commit sha (unfiltered — the repo's actual current tip). */
  mainlineHeadSha: string | null;
  /** Mainline HEAD's committer date, ISO. */
  mainlineHeadDate: string | null;
  /** Count of `packages/daemon/src` / `packages/shared/src` commits committed AFTER distBuiltAt.
   * Card 7a44e7a1: this is DELIBERATELY path-scoped, so it is NOT comparable 1:1 with
   * `processBuiltShaMatchesHead` (which is unscoped — any file). Reading `0` here while
   * `processBuiltShaMatchesHead` is `false` is NOT a contradiction: it means mainline moved on a
   * non-restart-relevant commit (docs/assets/tests/scripts) — the same case test (20)'s CRY-WOLF CONTROL
   * in deploy-staleness.mjs asserts is correct, not a defect. */
  commitsBehind: number;
  /** commitsBehind > 0 — mainline carries daemon-src/shared changes this running process was not built with.
   * Same scoping caveat as `commitsBehind` applies — see its own doc. */
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
  /** Card f26339d7 — the git commit sha baked into THIS daemon's own `dist/build-info.json`, read FRESH
   * from disk on EVERY call (like every other field in this module — DoD #4, never cached here) — "what
   * is on disk RIGHT NOW". A rebuild lands here immediately, even without a restart. `null` when the
   * artifact was built outside a git checkout (e.g. a published npm tarball) or the bake step couldn't
   * resolve a sha — NEVER a fabricated or stale substitute. See `processBuiltSha` for "what this PROCESS
   * is actually executing" — the two are DELIBERATELY different questions; a rebuild-without-restart is
   * exactly the case where they diverge (`distBuiltShaDiffersFromProcess`). */
  distBuiltSha: string | null;
  /** `true`/`false`/`null` — see `BuildInfo.dirty`'s own doc — for the SAME `dist/build-info.json` read as
   * `distBuiltSha`, read fresh every call. */
  distBuiltDirty: boolean | null;
  /** Card f26339d7, AMENDMENT 1 — the git commit sha THIS PROCESS is actually executing: captured ONCE,
   * at process start (module load), by the caller — see `served-status.ts`'s top-level capture — and
   * passed in via the `processBuiltSha` option (this function itself stays PURE and does no caching of its
   * own; see `ComputeDeployStalenessOptions`'s own doc). `null` when the caller didn't provide one, or it couldn't be resolved
   * at that process's start — NEVER a fabricated or stale substitute. A rebuild that lands after this
   * process started does NOT change this value; only a restart (which re-captures it fresh) can. */
  processBuiltSha: string | null;
  /** `true`/`false`/`null` for the SAME captured-once build as `processBuiltSha` — see `BuildInfo.dirty`.
   * Code Review BLOCKING 3: `processBuiltShaMatchesHead` can only ever read `true` when this is EXACTLY
   * `false` (a provably clean build) — `true` or `null` (dirty, or unknown) must never let a baked sha
   * that happens to textually equal `mainlineHeadSha` count as a genuine, trustworthy match. */
  processBuiltDirty: boolean | null;
  /** `distBuiltSha !== processBuiltSha` (both resolved) — a CONTENT-BASED "this process needs a restart
   * to catch up" signal, strictly stronger than the existing mtime-based `distAheadOfProcess`: that field
   * INFERS the same fact from clocks (and can be fooled by a cache-replay's mtime bump — see the module
   * doc); this one is a direct comparison of the two actual commits. `false` whenever either side is
   * unresolvable (never fabricates a positive without proof). Unaffected by either `dirty` flag — this
   * comparison's meaning (does the on-disk artifact differ from what this process captured) holds
   * regardless of whether either build was itself clean. */
  distBuiltShaDiffersFromProcess: boolean;
  /** `processBuiltDirty === false && processBuiltSha === mainlineHeadSha` — "is what this process is
   * running exactly mainline HEAD, from a PROVABLY CLEAN build". `null` when `processBuiltSha` itself is
   * unavailable. Often `false` in ordinary healthy operation — mainline moves ahead on unrelated
   * (docs/web/assets) commits constantly while the daemon is genuinely still fresh, and a dirty/unknown
   * build can never read `true` here even if the sha string happens to match (Code Review BLOCKING 3) —
   * so this is NOT itself a staleness signal, just the raw, trustworthy-or-not fact. See
   * `deploySignatureMismatch` for the actual defect detector. */
  processBuiltShaMatchesHead: boolean | null;
  /** True when the date-derived clock already claims this process is caught up (`stale:false`) BUT
   * `processBuiltSha`'s OWN real committer date proves at least one restart-relevant commit landed after
   * it — i.e. the mtime-based clock and the baked-sha ground truth (of what this PROCESS is running)
   * disagree. This is the exact signature of a turbo cache-replay that advances dist's mtime without
   * rebuilding from current source (the `aad5fff3` footgun — see the module doc's mechanism section).
   * Fed from `processBuiltSha`, deliberately NOT `distBuiltSha` — the question is "what is this process
   * running", and in the cache-replay case (no restart since the replay) the two already agree anyway.
   * Always `false` when `processBuiltSha` is unresolvable (never fabricates a positive without proof) and
   * whenever `stale` is already `true` (ordinary staleness isn't a "disagreement" — both signals already
   * agree something needs a rebuild). */
  deploySignatureMismatch: boolean;
  /** @decision 3d7dccb9 — a sha comparison alone can never distinguish "different commit, identical
   * shipped tree" from "genuinely stale" — the former is exactly what a squash-merged card looks like
   * from the vantage of its own unsquashed worktree form; this field is the CONTENT-based fallback.
   *
   * Computed ONLY when `processBuiltSha` is resolvable AND is NOT an ancestor of `mainlineHeadSha` (a
   * `git merge-base --is-ancestor` check) — the one case a plain sha/date comparison is structurally
   * unable to answer; when `processBuiltSha` IS an ancestor (the ordinary case — ordinary commit history,
   * an ordinary rebuild), the existing `stale`/`commitsBehind`/`processBuiltShaMatchesHead` signals already
   * answer the question correctly and this stays `null` (no git call spent confirming what's already
   * known). `true` means `git diff --name-only` between `processBuiltSha` and `mainlineHeadSha`, scoped to
   * the shipped paths (`packages/`, `scripts/`, `bin/` — see `CONTENT_CHECK_PATHSPECS`), came back EMPTY:
   * the built tree is byte-identical to mainline HEAD across everything actually served, so this is NOT
   * stale despite the sha mismatch. `false` means that diff was non-empty — a genuine content difference,
   * i.e. actually stale. `null` also when the diff itself couldn't be computed (an unresolvable sha, a
   * pruned/GC'd commit, a timeout) — never fabricates a verdict without proof, same discipline as every
   * other field in this module. */
  builtContentMatchesHead: boolean | null;
  /** Card f26339d7 — the WEB analogue of `distBuiltSha`: the git commit sha baked into
   * `packages/web/dist/build-info.json` at build time, read fresh every call. `packages/web/dist` is
   * already served live from disk with no restart needed (card c3ce92ea), so there is no
   * process/dist distinction for web the way there is for the daemon — a web rebuild SHOULD be reflected
   * immediately. `null` under the same graceful-degradation rules as `distBuiltSha`. Informational only —
   * no `deploySignatureMismatch` analogue for web in this card; `webStale`/`webCommitsBehind` already
   * answer "does web need a rebuild". */
  webBuiltSha: string | null;
  /** `true`/`false`/`null` for the SAME `packages/web/dist/build-info.json` read as `webBuiltSha`, read
   * fresh every call — see `BuildInfo.dirty`. No web `deploySignatureMismatch` analogue in this card, so
   * this is informational only, same as `webBuiltSha` itself. */
  webBuiltDirty: boolean | null;
}

/** Paths whose changes actually require a daemon rebuild+RESTART — see the module doc's DoD #2 note. */
const RESTART_RELEVANT_PATHSPECS = DEPLOY_PACKAGES.filter((p) => p.restartRequired).map((p) => p.srcPathspec);
/** Paths whose changes need only a REBUILD (no restart) — currently just `packages/web/src`. */
const REBUILD_ONLY_PATHSPECS = DEPLOY_PACKAGES.filter((p) => !p.restartRequired).map((p) => p.srcPathspec);
/** Card 3d7dccb9 — the paths `builtContentMatchesHead` diffs: everything actually SHIPPED, not just the
 * restart-relevant `src` trees above (a compiled `dist/` isn't diffable against a git ref, so this checks
 * the SOURCE that produces what's served — `packages/` (daemon+shared+web src), `scripts/` (the build/
 * deploy scripts themselves — this file included), and `bin/` (the packaged CLI entry)). */
const CONTENT_CHECK_PATHSPECS = ["packages/", "scripts/", "bin/"];

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

/** Card f26339d7 (Code Review "ALSO REQUIRED") — the baked sha/dirty fields are DERIVED INDEPENDENTLY of
 * git availability (they're a plain disk read + the caller's own override), so a packaged end-user
 * install (no `.git` at all — the exact case `unavailable()` exists to describe) must NOT lose "what
 * commit is this artifact/process?" just because every GIT-derived field below it degrades. `baked` lets
 * every early-bail call site pass through whatever it already resolved before hitting whatever made this
 * particular call unavailable — see `computeDeployStaleness`'s own call sites for what's known at each
 * bail point. `distBuiltShaDiffersFromProcess` is recomputed from the SAME two values here (not hardcoded
 * false) since it needs no git at all either. */
function unavailable(reason: string, reasonKind: DeployUnavailableReasonKind, baked?: Partial<Pick<DeployStalenessResult,
  "distBuiltSha" | "distBuiltDirty" | "processBuiltSha" | "processBuiltDirty" | "webBuiltSha" | "webBuiltDirty">>): DeployStalenessResult {
  const distBuiltSha = baked?.distBuiltSha ?? null;
  const processBuiltSha = baked?.processBuiltSha ?? null;
  return {
    available: false,
    reason,
    reasonKind,
    distBuiltAt: null,
    processStartedAt: null,
    runningCodeBuiltAt: null,
    distAheadOfProcess: false,
    mainlineHeadSha: null,
    mainlineHeadDate: null,
    commitsBehind: 0,
    stale: false,
    webDistBuiltAt: null,
    webCommitsBehind: 0,
    webStale: false,
    distBuiltSha,
    distBuiltDirty: baked?.distBuiltDirty ?? null,
    processBuiltSha,
    processBuiltDirty: baked?.processBuiltDirty ?? null,
    distBuiltShaDiffersFromProcess: distBuiltSha !== null && processBuiltSha !== null && distBuiltSha !== processBuiltSha,
    // Can't compare against mainlineHeadSha or run a commit-date lookup without git — always null/false.
    processBuiltShaMatchesHead: null,
    deploySignatureMismatch: false,
    // Can't run `git merge-base`/`git diff` without git — always null, same "unknown, not a verdict" rule.
    builtContentMatchesHead: null,
    webBuiltSha: baked?.webBuiltSha ?? null,
    webBuiltDirty: baked?.webBuiltDirty ?? null,
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

export interface BuildInfo {
  sha: string | null;
  /** `true` when the build ran from a checkout with uncommitted changes (`git status --porcelain` was
   * non-empty) — a build like this bakes HEAD's sha for an artifact that is NOT actually HEAD's content.
   * `null` when the dirty-check itself couldn't be determined. Treated the SAME as `true` everywhere this
   * is consulted for "can this count as a clean match" — a build that can't prove it's clean must never be
   * assumed clean (card f26339d7 DoD #1, Code Review BLOCKING 3). */
  dirty: boolean | null;
}

/** Reads `<distDir>/build-info.json` — the sha + dirty-flag `scripts/write-build-info.mjs` resolved at
 * BUILD time. Never throws: a missing file (an old dist built before this card), malformed JSON, or a
 * non-string/empty `sha` / non-boolean `dirty` all degrade to `null` — never a fabricated or stale
 * substitute (card f26339d7 DoD #1). Exported so `served-status.ts` can reuse this exact parsing for its
 * OWN "once at process start" capture (`processBuiltSha`/`processBuiltDirty`) — one parser, not two
 * hand-maintained copies.
 * @decision 119fd301 — never make this walk up looking for the file, write it outside a `dist/` build
 * output dir, or default a `distDir` override to a resolved `dist` path regardless of runtime: any of the
 * three turns an honest "not built" gap (a from-source `tsx watch` boot) into a silently WRONG stale bake. */
export function readBuildInfo(distDir: string): BuildInfo {
  try {
    const raw = fs.readFileSync(path.join(distDir, "build-info.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    const obj = parsed as { sha?: unknown; dirty?: unknown } | null;
    const sha = typeof obj?.sha === "string" && obj.sha.length > 0 ? obj.sha : null;
    const dirty = typeof obj?.dirty === "boolean" ? obj.dirty : null;
    return { sha, dirty };
  } catch {
    return { sha: null, dirty: null };
  }
}

/** Single-object `git log -1 --pretty=%cI <sha>` lookup (NOT a graph walk) — resolves one commit's own
 * committer date, in ms since epoch. Never throws: an unresolvable sha (pruned, wrong repo, garbage
 * input) degrades to `null`. Used only by `deploySignatureMismatch`'s discrepancy check, below. */
function commitDateMs(repoRoot: string, sha: string): number | null {
  try {
    const out = runGit(repoRoot, ["log", "-1", "--pretty=%cI", sha]).trim();
    if (!out) return null;
    const ms = new Date(out).getTime();
    return Number.isNaN(ms) ? null : ms;
  } catch {
    return null;
  }
}

/** `git merge-base --is-ancestor <sha> <of>` — exit 0 means `sha` IS an ancestor of (or equal to) `of`,
 * exit 1 means it is definitively NOT (both are legitimate, well-defined answers from git). Any OTHER
 * outcome (an unresolvable/GC'd sha, a timeout, git itself missing) degrades to `null` — "unknown", never
 * a fabricated `true`/`false`. Used only by `builtContentMatchesHead`'s gate, below: the content diff is
 * worth its git cost only in the one case ancestry can't already answer the question. */
function isAncestor(repoRoot: string, sha: string, of: string): boolean | null {
  try {
    runGit(repoRoot, ["merge-base", "--is-ancestor", sha, of]);
    return true;
  } catch (err) {
    const status = (err as { status?: number | null }).status;
    if (status === 1) return false;
    return null;
  }
}

/**
 * Recursively finds the newest file mtime under `dir`, in ms since epoch. Returns `null` if `dir`
 * doesn't exist or contains no files (an empty/missing dist dir contributes nothing to the build
 * clock, rather than being treated as an error — `packages/shared/dist` in particular may be absent in
 * some checkouts, and that must not make the whole signal unavailable). Never throws: an unreadable
 * directory or a file that vanishes between listing and stat (a build racing this read) is skipped, not
 * fatal — this best-effort scan only ever needs to find the max mtime, not certify every file.
 *
 * @decision c241d54b — a `null` return here is ambiguous (never-built vs. transiently unreadable); a
 * caller that already confirmed the dir's presence moments earlier must treat it as "unreadable now",
 * never coerce it to a default "very old" value — that silently corrupts every downstream clock reader.
 */
export function newestMtimeMs(dir: string): number | null {
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
 * Options for `computeDeployStaleness` (card 119fd301 — replaced the earlier seven-positional-param form:
 * with all seven optional, a real production call site read as five consecutive `undefined`s whose only
 * meaning was POSITIONAL — a param inserted, reordered, or miscounted was silently wrong, typechecked, ran,
 * and returned a confident answer. A misspelled or omitted key here is a type error or an explicit `null`/
 * `undefined` read, never a silently-wrong positional value.)
 */
export interface ComputeDeployStalenessOptions {
  /** Test seam: a fixture `dist/index.js` path. Production callers omit this and get the real running
   * daemon's own path. */
  distEntry?: string;
  /** Test seam: a fixture git repo root. Production callers omit this and get the real repo root. */
  repoRoot?: string;
  /** Test seam: a fixture `packages/shared/dist` dir. Production callers omit this and get the real one. */
  sharedDist?: string;
  /** Test seam: a fixture `packages/web/dist` dir. Production callers omit this and get the real one. */
  webDist?: string;
  /** Card 8ff7ccde — test seam: a fixture ISO instant standing in for this process's own start. A real
   * caller omits this and gets the real `process.uptime()`-derived value. */
  processStartedAt?: string;
  /** Card f26339d7, AMENDMENT 1 — NOT a test-only seam, the REAL production plumbing: this function stays
   * PURE and does no caching of its own, so the caller (`served-status.ts`) is responsible for capturing
   * "what this process is executing" ONCE at its own module load and passing that SAME pair in on every
   * call. Omitting it (the default) means "the caller didn't tell me" — `processBuiltSha`/`processBuiltDirty`/
   * `processBuiltShaMatchesHead`/`deploySignatureMismatch` all degrade to null/false rather than falling
   * back to a fresh disk read, which would silently reintroduce the exact bug this amendment exists to
   * prevent (see the module doc). */
  processBuiltSha?: string | null;
  /** Card f26339d7, AMENDMENT 1 — see `processBuiltSha`'s own doc; the same "real production plumbing, not
   * a test seam" applies here. */
  processBuiltDirty?: boolean | null;
}

/**
 * Compute the deploy-staleness signal fresh, right now — see the module doc for the design rationale, and
 * `ComputeDeployStalenessOptions`'s own doc for what each option means and defaults to. A production caller
 * passes only the option(s) it actually has (e.g. `computeDeployStaleness({ processBuiltSha, processBuiltDirty })`);
 * a test passes whichever fixture seams that section needs; omitting the argument entirely (or passing `{}`)
 * gets every real-production default.
 *
 * Code Review "ALSO REQUIRED" — `distBuiltSha`/`distBuiltDirty`/`processBuiltSha`/`processBuiltDirty`/
 * `webBuiltSha`/`webBuiltDirty` are resolved BEFORE the `.git`-availability bail (and threaded through
 * every earlier `unavailable()` return that can reach them) — a packaged end-user install has no `.git`
 * but DOES ship `dist/build-info.json`, so "what commit is this artifact/process?" must not be thrown away
 * just because every git-derived comparison field is correctly unavailable.
 */
export function computeDeployStaleness(options: ComputeDeployStalenessOptions = {}): DeployStalenessResult {
  const {
    distEntry: distEntryOverride,
    repoRoot: repoRootOverride,
    sharedDist: sharedDistOverride,
    webDist: webDistOverride,
    processStartedAt: processStartedAtOverride,
    processBuiltSha: processBuiltShaOverride,
    processBuiltDirty: processBuiltDirtyOverride,
  } = options;
  // Known immediately, regardless of dist/git state — just the caller's own override, not derived from
  // anything this function might fail to resolve below.
  const processBuiltSha = processBuiltShaOverride ?? null;
  const processBuiltDirty = processBuiltDirtyOverride ?? null;

  const distIndex = distEntryOverride ?? path.join(__dirname, "index.js");
  try {
    fs.statSync(distIndex);
  } catch {
    return unavailable("this daemon's own built entry (dist/index.js) was not found — cannot derive a build time", "could-not-measure", { processBuiltSha, processBuiltDirty });
  }
  const distDir = path.dirname(distIndex);
  const { sha: distBuiltSha, dirty: distBuiltDirty } = readBuildInfo(distDir);

  const repoRoot = repoRootOverride ?? loomRepoRoot();
  // webDistDir/webBuiltSha need only `repoRoot` (a plain path resolution) and disk I/O — no git — so they,
  // like distBuiltSha above, are resolvable even for a packaged install with no `.git` at all.
  const webDistDir = webDistOverride ?? path.join(repoRoot, "packages", "web", "dist");
  const { sha: webBuiltSha, dirty: webBuiltDirty } = readBuildInfo(webDistDir);
  const baked = { distBuiltSha, distBuiltDirty, processBuiltSha, processBuiltDirty, webBuiltSha, webBuiltDirty };

  if (!fs.existsSync(path.join(repoRoot, ".git"))) {
    return unavailable("this daemon is not running from a Loom source checkout (no .git at the resolved repo root) — not applicable to a packaged install", "not-applicable", baked);
  }

  const sharedDistDir = sharedDistOverride ?? path.join(repoRoot, "packages", "shared", "dist");
  // @decision c241d54b — distDir is confirmed to exist above, so never coerce a null here to epoch the
  // way sharedDistDir's own null safely does below: unlike sharedDistDir, distDir is not legitimately
  // absent at this point — a null means "unreadable now" (a build racing this read), never "very old".
  const distMaxMs = newestMtimeMs(distDir);
  if (distMaxMs === null) {
    return unavailable("this daemon's own dist directory became unreadable while deriving its build clock (a build likely raced this read) — cannot derive a build time", "could-not-measure", baked);
  }
  // sharedDistDir may legitimately be absent (newestMtimeMs ⇒ null) without making the signal unavailable —
  // distDir above already guarantees a real contribution, so a missing shared dist safely defaults to 0 in
  // the max (it can never be the one that wins).
  const buildMaxMs = Math.max(distMaxMs, newestMtimeMs(sharedDistDir) ?? 0);
  const distBuiltAt = new Date(buildMaxMs).toISOString();

  // Card 8ff7ccde: when this process itself started (i.e. when its OWN currently-loaded code was read off
  // disk). Card 9aa4e2c9 — this is a DELIBERATE, NAMED EXCEPTION to this module's own DoD #4 ("never
  // cached/memoized"): that discipline is right for every other clock here (a dist mtime, mainline HEAD)
  // because those genuinely change between calls, but a process's own start time does not — recomputing it
  // as `Date.now() - process.uptime() * 1000` (the old approach) subtracts a WALL clock from a MONOTONIC
  // one and drifts by a few ms between calls in the SAME boot, which breaks the one thing callers actually
  // need from this field: that two reads of the same boot agree. `performance.timeOrigin` is captured ONCE
  // by the runtime at process start and is fixed for the process's lifetime — the exact primitive this
  // field wants, so it is read directly rather than derived, and is exempt from the "recompute every call"
  // rule the rest of this module follows. `runningCodeBuiltAt` is the earlier of the two clocks — a safe
  // bound on what this process could actually be executing (see the module doc for why).
  const processStartedAtMs = processStartedAtOverride
    ? new Date(processStartedAtOverride).getTime()
    : performance.timeOrigin;
  const processStartedAt = new Date(processStartedAtMs).toISOString();
  const runningCodeBuiltAtMs = Math.min(buildMaxMs, processStartedAtMs);
  const runningCodeBuiltAt = new Date(runningCodeBuiltAtMs).toISOString();
  const distAheadOfProcess = buildMaxMs > processStartedAtMs;

  // Card c3ce92ea — the web build clock is INDEPENDENT of the daemon/shared one above: a web-only rebuild
  // must not read clean off the daemon's dist, and vice versa. `packages/web/dist` may legitimately be
  // entirely absent (an API-only deploy, or web never built) — that degrades to a null webDistBuiltAt and
  // an effective clock of epoch 0 (every web-src commit ever counts as unbuilt), never to `unavailable`.
  // (webDistDir/webBuiltSha/webBuiltDirty were already resolved above, before the `.git` bail.)
  const webBuildMaxMsRaw = newestMtimeMs(webDistDir);
  const webBuildMaxMs = webBuildMaxMsRaw ?? 0;
  const webDistBuiltAt = webBuildMaxMsRaw === null ? null : new Date(webBuildMaxMsRaw).toISOString();

  let headLine: string;
  try {
    headLine = runGit(repoRoot, ["log", "-1", `--pretty=%H${UNIT_SEP}%cI`]).trim();
  } catch (err) {
    return unavailable(`could not read mainline HEAD: ${err instanceof Error ? err.message : String(err)}`, "could-not-measure", baked);
  }
  const [mainlineHeadSha, mainlineHeadDate] = headLine.split(UNIT_SEP);
  if (!mainlineHeadSha) return unavailable("git log returned no HEAD commit (a commitless repo?)", "could-not-measure", baked);

  let relevantLog: string;
  try {
    relevantLog = runGit(repoRoot, ["log", `--pretty=%H${UNIT_SEP}%cI`, "--max-count=2000", "--", ...RESTART_RELEVANT_PATHSPECS]);
  } catch (err) {
    return unavailable(`could not read daemon-src/shared commit history: ${err instanceof Error ? err.message : String(err)}`, "could-not-measure", baked);
  }
  // Card 8ff7ccde: computed against `runningCodeBuiltAtMs`, NOT the raw dist clock `buildMaxMs` — a
  // rebuild-without-restart must not UNDERSTATE staleness (see the module doc).
  const commitsBehind = countCommitsAfter(relevantLog, runningCodeBuiltAtMs);

  let webRelevantLog: string;
  try {
    webRelevantLog = runGit(repoRoot, ["log", `--pretty=%H${UNIT_SEP}%cI`, "--max-count=2000", "--", ...REBUILD_ONLY_PATHSPECS]);
  } catch (err) {
    return unavailable(`could not read web-src commit history: ${err instanceof Error ? err.message : String(err)}`, "could-not-measure", baked);
  }
  const webCommitsBehind = countCommitsAfter(webRelevantLog, webBuildMaxMs);
  const stale = commitsBehind > 0;

  let processBuiltShaMatchesHead: boolean | null = null;
  let deploySignatureMismatch = false;
  if (processBuiltSha) {
    // Code Review BLOCKING 3: a dirty (or unknown-dirtiness) build must NEVER read as a clean match, even
    // when its baked sha happens to textually equal mainlineHeadSha — `processBuiltDirty` must be EXACTLY
    // `false` (provably clean), not merely falsy, for this to be eligible to read `true`.
    processBuiltShaMatchesHead = processBuiltDirty === false && processBuiltSha === mainlineHeadSha;
    // Only meaningful to check when the date-based clock already claims "not stale" — when it's already
    // true, both signals already agree something needs a rebuild, so there's no "disagreement" to surface,
    // and this also skips the extra git call entirely in that case.
    if (!stale && !processBuiltShaMatchesHead) {
      const processBuiltShaDateMs = commitDateMs(repoRoot, processBuiltSha);
      if (processBuiltShaDateMs !== null) {
        // Re-run the SAME date-based count the mtime clock used for `commitsBehind`, but keyed to
        // `processBuiltSha`'s OWN real committer date instead of the (untrustworthy, mtime-derived)
        // `runningCodeBuiltAtMs`. A cache-replay leaves `runningCodeBuiltAtMs` reading "fresh" while the
        // process is genuinely still running older code — this is what surfaces that disagreement.
        deploySignatureMismatch = countCommitsAfter(relevantLog, processBuiltShaDateMs) > 0;
      }
    }
  }

  // distBuiltSha/distBuiltDirty/processBuiltSha/processBuiltDirty/webBuiltSha/webBuiltDirty were all
  // already resolved above (before the `.git` bail) and are reused here via `baked` — not re-read.
  const distBuiltShaDiffersFromProcess = distBuiltSha !== null && processBuiltSha !== null && distBuiltSha !== processBuiltSha;

  // Card 3d7dccb9 — the CONTENT-based fallback: only worth its two extra git calls when a sha comparison
  // has already told us it CAN'T answer the question, i.e. `processBuiltSha` names a real commit that is
  // NOT an ancestor of `mainlineHeadSha` (a divergent/foreign commit — the exact shape of a worker
  // worktree's own union-forward merge commit vs. its later squash-merge onto mainline). When
  // `processBuiltSha` IS an ancestor (the ordinary case), `stale`/`commitsBehind`/`processBuiltShaMatchesHead`
  // already answer this correctly and no extra git call is spent confirming it.
  let builtContentMatchesHead: boolean | null = null;
  if (processBuiltSha) {
    const ancestor = isAncestor(repoRoot, processBuiltSha, mainlineHeadSha);
    if (ancestor === false) {
      try {
        const diffOut = runGit(repoRoot, ["diff", "--name-only", processBuiltSha, mainlineHeadSha, "--", ...CONTENT_CHECK_PATHSPECS]).trim();
        builtContentMatchesHead = diffOut.length === 0;
      } catch {
        // An unresolvable sha on either side, or a timeout — unknown, not a fabricated verdict.
        builtContentMatchesHead = null;
      }
    }
  }

  return {
    available: true,
    distBuiltAt,
    processStartedAt,
    runningCodeBuiltAt,
    distAheadOfProcess,
    mainlineHeadSha,
    mainlineHeadDate: mainlineHeadDate ?? null,
    commitsBehind,
    stale,
    webDistBuiltAt,
    webCommitsBehind,
    webStale: webCommitsBehind > 0,
    distBuiltSha,
    distBuiltDirty,
    processBuiltSha,
    processBuiltDirty,
    distBuiltShaDiffersFromProcess,
    processBuiltShaMatchesHead,
    deploySignatureMismatch,
    builtContentMatchesHead,
    webBuiltSha,
    webBuiltDirty,
  };
}
