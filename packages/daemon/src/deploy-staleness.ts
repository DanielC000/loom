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
 * changes actually require a rebuild+RESTART of THIS PROCESS to take effect — `packages/daemon/src` and
 * `packages/shared/src` (see `DEPLOY_PACKAGES`, `./deploy-packages.js`). `assets/hook-relay.mjs` and
 * `assets/vault-lint/**` are read live per-use straight from the package dir with NO restart needed, and a
 * vault/docs-only merge needs no restart either — a signal that cries stale on those gets ignored within a
 * day, which is worse than no signal. ⚠️ Card e8697dd3: `assets/skills/**` is DIFFERENT and deliberately
 * excluded from THAT reasoning — a bundled skill is delivered to sessions from a separate STORE
 * (`<LOOM_HOME>/skills/<name>/SKILL.md`, see `skills/inject.ts`), and the store only re-syncs from
 * `assets/skills/**` on daemon boot/restart (`seedGlobalSkills()`). This module's own `stale`/
 * `commitsBehind` correctly never counts an assets-only merge either way (it answers "does the daemon
 * PROCESS need a restart", not "does anything need a restart") — but do not generalize its silence on
 * `assets/skills/**` into "that subtree needs no restart too". See `skills/store.ts`'s
 * `skillStoreStaleness()` for that separate signal, surfaced on `served_status` as its own field.
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
 * defect one layer down). Bounded — THREE unconditional `runGit` calls (mainline HEAD, the restart-relevant
 * log, and `webStale`'s own web-relevant log), each capped at `GIT_TIMEOUT_MS`, PLUS a conditional FOURTH
 * (see `deploySignatureMismatch` below — a single-object `git log -1 <sha>` lookup, not a graph walk, fired
 * only when the date-based clock already claims `stale:false` and `processBuiltSha` differs from `mainlineHeadSha`)
 * — worst case 4×`GIT_TIMEOUT_MS` of the event loop fully blocked (this is a synchronous `execFileSync`,
 * unlike the async claude-version cache — see the call-site doc at `manager-prompt.ts` for why that's an
 * acceptable tradeoff here) PLUS the (cheap, synchronous `fs`) dist scans. Manager spawns can BURST
 * (boot-reconcile resumes every manager across every project at once), so keep the git timeout constant
 * small. Card c6e7ebe7 measured the THREE-call baseline directly on Windows: 147–275ms at IDLE, 220–465ms
 * at 3× CPU oversubscription — NOT the "tens of ms" this comment used to claim (a real 15–27% of the 1s
 * budget consumed at idle alone). Still a comfortable margin even with the fourth call added (a
 * single-object lookup, cheap relative to the two full-history `git log` walks already in the baseline),
 * and no observed in-flight call — idle or oversubscribed — has ever come close to the timeout (see that
 * card for the full data); a *different* tail shows up only in the outer node process's own scheduling
 * latency under heavy oversubscription, which is not a git-call tail and must not be conflated with one.
 * NEVER throws — any failure (not a git checkout, e.g. a packaged `loomctl` install; git unavailable; dist
 * not built; a timeout) degrades to `{available:false, reason}`, never a false stale/clean verdict — and
 * this applies uniformly to BOTH the restart signal and the web signal: a failure computing either degrades
 * the WHOLE result, so `webStale` never reports a false clean/stale independent of `stale`'s own guarantee.
 *
 * Card f26339d7 — every signal above is DERIVED (clocks + a live git read), so a single fault class (a
 * turbo cache-replay that advances dist's mtime without rebuilding from current source — the `aad5fff3`
 * footgun documented in this repo's CLAUDE.md) can make every one of them agree, and all be wrong at once.
 * `distBuiltSha`/`processBuiltSha` are the missing POSITIVE signal: the actual `git rev-parse HEAD` an
 * artifact was compiled from, baked into `dist/build-info.json` at BUILD time by
 * `scripts/write-build-info.mjs` (never at runtime).
 * ⭐ THE MECHANISM (not obvious — write this down before someone "optimizes" it away): `build-info.json`
 * lands INSIDE the same `dist/**` output turbo caches for the `build` task. A turbo cache-HIT replay
 * restores that file's ORIGINAL baked sha verbatim — even though the replay simultaneously advances every
 * restored file's mtime to "now" — because a cache restore is a file-content restore, not a rebuild. That
 * is EXACTLY what makes a cache-replay detectable: the mtime-derived clocks above all read fresh (mtime
 * moved), but the baked sha still names the OLD commit the cached output was actually compiled from. If
 * `build-info.json` were regenerated on every build outside the cached outputs (e.g. written by a
 * postinstall hook, or excluded from `outputs` in turbo.json), a cache replay would silently regenerate a
 * FRESH (wrong) sha and this detector would go blind while every test still passed. Do not move it.
 * ⚠️ TWO FIELDS, ONE PER QUESTION — AMENDMENT 1, the correction that produced this shape: an earlier draft
 * of this card had ONE cached `builtSha` field, read once per dist dir and frozen. That is WRONG for a
 * subtle reason worth stating precisely: a per-process/per-distDir cache is "read once at FIRST USE", not
 * "read once at PROCESS START" — if the first call into this module happens to land AFTER a rebuild landed
 * on disk (a real, if narrow, window), the cache poisons itself with the NEW sha even though the process
 * has been running the OLD code the whole time, permanently. A value that can be wrong depending on WHEN
 * it happens to be first read is not a baked signal, it is a race. The fix: split "what's on disk" from
 * "what this process is running" into two fields with two different lifetimes:
 *   - `distBuiltSha` — a FRESH read on every call, like every other field in this module (DoD #4). Answers
 *     "what's on disk right now". Computed HERE, from `distDir`, unconditionally.
 *   - `processBuiltSha` — captured EXACTLY ONCE, at PROCESS START (module load time, not first use),
 *     by the CALLER (`served-status.ts`'s own top-level capture) and threaded in via
 *     `processBuiltShaOverride`. This function does NOT read it, cache it, or know how it was captured —
 *     it stays PURE, so the existing `distDir` test seam keeps testing it trivially, with no module-level
 *     state of its own to reset between test sections. See `computeDeployStaleness`'s own param doc.
 * They are DELIBERATELY allowed to diverge — `distBuiltShaDiffersFromProcess` (distinct from
 * `distAheadOfProcess`, which infers the same fact from clocks and can be fooled by a mtime-bumping
 * cache-replay) is the CONTENT-BASED, direct answer to "has a rebuild landed that this process hasn't
 * picked up yet". `deploySignatureMismatch` is fed from `processBuiltSha` specifically (not
 * `distBuiltSha`) — the question it answers is "what is THIS PROCESS running", and in the cache-replay
 * case (no restart since the replay landed) the two values already agree anyway, so feeding either would
 * give the same answer there; they diverge only in the ALSO-real "process is currently running old code,
 * on-disk already has the fix" case, where `processBuiltSha` is the honest one to ask.
 *
 * Card 8ff7ccde — `distBuiltAt` (above) is an ON-DISK ARTIFACT clock: the newest mtime under the dist
 * directories, RIGHT NOW, at call time. It is NOT "when this running process was built" — a rebuild that
 * lands without a restart advances `distBuiltAt` while the process keeps executing whatever it loaded at
 * its OWN start (Node reads a module's file once, at import time, and never re-reads it off disk again).
 * Measured live: a process that started at `04:14:01Z` was still reporting `distBuiltAt` of `10:05:14Z` —
 * a build that landed nearly six hours AFTER the process began, that the process could not possibly be
 * executing — and every gate-kind DB row this process wrote in between (1880 of them) was missing a field
 * a merge at `07:30:24Z` unconditionally adds, proving the process really was still running pre-merge code
 * the whole time. `processStartedAt` fixes this: computed fresh at call time from `process.uptime()` (never
 * cached — same DoD #4 discipline as everything else in this module), it is the moment this process's OWN
 * currently-loaded code was read from disk. `runningCodeBuiltAt` is `min(distBuiltAt, processStartedAt)` —
 * the EARLIER of the two is always a safe upper bound on what the process could actually be executing: if
 * the dist is newer than the process, the process cannot have loaded that newer code no matter what its
 * mtime says, so the process's own start time is the honest clock; if the process is newer than the dist
 * (the normal case — no rebuild has happened since it started), the dist clock is already correct on its
 * own. `stale`/`commitsBehind` are computed against THIS clock, not the raw dist clock, so staleness can no
 * longer be UNDERSTATED by a rebuild that outpaced a restart. `distAheadOfProcess` (`distBuiltAt` after
 * `processStartedAt`) makes that exact divergence VISIBLE as its own field, rather than folding it silently
 * into a corrected number — a manager reading it can tell "this daemon needs a restart to catch up to its
 * own dist" even in the (rare) case `commitsBehind` itself happens to read 0.
 *
 * This does NOT apply to the web signal (`webStale`/`webCommitsBehind`/`webDistBuiltAt`) — the daemon
 * serves `packages/web/dist` live from disk on every request (see the module doc above), so there is no
 * "loaded at process start" gap for web assets to fall into; `webBuildMaxMs` alone stays correct.
 *
 * Card c6e7ebe7 — investigated the `GIT_TIMEOUT_MS` margin above and considered, then REJECTED, two
 * further changes. (b) Distinguishing a TIMEOUT specifically from every other `unavailable()` cause (no
 * `.git`, no HEAD commit, git not installed) was considered because a timed-out call degrades to the same
 * `{available:false, reason}` shape as any other unreadable-repo case. But the one consumer that treats
 * `available:false` as silent — `composeManagerStartupPrompt` in `manager-prompt.ts` — already does so
 * DELIBERATELY and UNIFORMLY for every `available:false` reason, not just a timeout (see that call site's
 * own doc: this is the DoD #2 cry-wolf precedent, not an oversight). Singling out timeouts there would be
 * inconsistent with that existing, considered policy, not a fix to it; anyone who wants "unavailable"
 * itself surfaced already can — `served_status` returns the raw `available`/`reason` fields uncollapsed.
 * (c) Raising or retrying the timeout was rejected for lack of evidence: no observed git call, idle or at
 * up to 9× CPU oversubscription, has ever approached this budget (see the card for the full measurement).
 * Widening a timeout with no observed stall to justify it is exactly the kind of change this project has
 * a standing rule against.
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
   * `dist/index.js`) is unusable as a build clock under an incremental `tsc` build. An ON-DISK ARTIFACT
   * clock ONLY — card 8ff7ccde: it can be NEWER than the code this process is actually executing (a
   * rebuild without a restart). Use `runningCodeBuiltAt` for staleness; this field is for display/
   * transparency (see `distAheadOfProcess`). */
  distBuiltAt: string | null;
  /** ISO instant this process itself started — i.e. when its OWN currently-loaded code was read off disk
   * (Node imports a module's file once and never re-reads it). Card 8ff7ccde. Derived fresh at call time
   * from `process.uptime()`, never cached. */
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
   * passed in via `processBuiltShaOverride` (this function itself stays PURE and does no caching of its
   * own; see that param's own doc). `null` when the caller didn't provide one, or it couldn't be resolved
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
function unavailable(reason: string, baked?: Partial<Pick<DeployStalenessResult,
  "distBuiltSha" | "distBuiltDirty" | "processBuiltSha" | "processBuiltDirty" | "webBuiltSha" | "webBuiltDirty">>): DeployStalenessResult {
  const distBuiltSha = baked?.distBuiltSha ?? null;
  const processBuiltSha = baked?.processBuiltSha ?? null;
  return {
    available: false,
    reason,
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
 * hand-maintained copies. */
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

/**
 * Recursively finds the newest file mtime under `dir`, in ms since epoch. Returns `null` if `dir`
 * doesn't exist or contains no files (an empty/missing dist dir contributes nothing to the build
 * clock, rather than being treated as an error — `packages/shared/dist` in particular may be absent in
 * some checkouts, and that must not make the whole signal unavailable). Never throws: an unreadable
 * directory or a file that vanishes between listing and stat (a build racing this read) is skipped, not
 * fatal — this best-effort scan only ever needs to find the max mtime, not certify every file.
 *
 * ⚠️ Card c241d54b — a `null` return is ambiguous on ITS OWN: it means "this dir has no files right now",
 * which covers both "legitimately never built" AND "existed moments ago but vanished/emptied mid-scan
 * (a build racing this read)". This function cannot and does not disambiguate those — the guard above
 * only covers an individual FILE vanishing between listing and stat, not the whole tree being transiently
 * unreadable across two separate calls into this module. A CALLER that already confirmed the dir's
 * presence moments earlier must treat a `null` here as "unreadable now", never coerce it to a default
 * "very old" value — see `computeDeployStaleness`'s handling of `distDir` for the caller that got this
 * wrong once already.
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
 * Compute the deploy-staleness signal fresh, right now — see the module doc for the design rationale.
 * `distEntryOverride`/`repoRootOverride`/`sharedDistOverride`/`webDistOverride` are test seams (a fixture
 * `dist/index.js` path, a fixture git repo, a fixture `packages/shared/dist` dir, and a fixture
 * `packages/web/dist` dir); production callers omit all four and get the real running daemon's own paths.
 * `processStartedAtOverride` (card 8ff7ccde) is a 5th test seam (a fixture ISO instant standing in for
 * this process's own start); a real caller omits it and gets the real `process.uptime()`-derived value.
 * `processBuiltShaOverride`/`processBuiltDirtyOverride` (card f26339d7, AMENDMENT 1) are a 6th/7th param —
 * NOT test-only seams, the REAL production plumbing: this function stays PURE and does no caching of its
 * own, so the caller (`served-status.ts`) is responsible for capturing "what this process is executing"
 * ONCE at its own module load and passing that SAME pair in on every call. Omitting them (the default)
 * means "the caller didn't tell me" — `processBuiltSha`/`processBuiltDirty`/`processBuiltShaMatchesHead`/
 * `deploySignatureMismatch` all degrade to null/false rather than falling back to a fresh disk read, which
 * would silently reintroduce the exact bug this amendment exists to prevent (see the module doc).
 *
 * Code Review "ALSO REQUIRED" — `distBuiltSha`/`distBuiltDirty`/`processBuiltSha`/`processBuiltDirty`/
 * `webBuiltSha`/`webBuiltDirty` are resolved BEFORE the `.git`-availability bail (and threaded through
 * every earlier `unavailable()` return that can reach them) — a packaged end-user install has no `.git`
 * but DOES ship `dist/build-info.json`, so "what commit is this artifact/process?" must not be thrown away
 * just because every git-derived comparison field is correctly unavailable.
 */
export function computeDeployStaleness(
  distEntryOverride?: string,
  repoRootOverride?: string,
  sharedDistOverride?: string,
  webDistOverride?: string,
  processStartedAtOverride?: string,
  processBuiltShaOverride?: string | null,
  processBuiltDirtyOverride?: boolean | null,
): DeployStalenessResult {
  // Known immediately, regardless of dist/git state — just the caller's own override, not derived from
  // anything this function might fail to resolve below.
  const processBuiltSha = processBuiltShaOverride ?? null;
  const processBuiltDirty = processBuiltDirtyOverride ?? null;

  const distIndex = distEntryOverride ?? path.join(__dirname, "index.js");
  try {
    fs.statSync(distIndex);
  } catch {
    return unavailable("this daemon's own built entry (dist/index.js) was not found — cannot derive a build time", { processBuiltSha, processBuiltDirty });
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
    return unavailable("this daemon is not running from a Loom source checkout (no .git at the resolved repo root) — not applicable to a packaged install", baked);
  }

  const sharedDistDir = sharedDistOverride ?? path.join(repoRoot, "packages", "shared", "dist");
  // Card c241d54b — distDir was just confirmed to exist via the statSync on distIndex above, so a null
  // return from newestMtimeMs(distDir) here means the tree became unreadable/vanished in the window
  // between that check and this scan (a build racing this read), NOT "very old". The prior code coerced
  // that null to `?? 0` (epoch) alongside sharedDistDir's — but unlike sharedDistDir below, distDir is NOT
  // "legitimately absent" at this point, and "unreadable right now" is a different fact than "very old":
  // coercing it to epoch silently corrupted every downstream reader of this clock (commitsBehind counted
  // almost every restart-relevant commit ever, since runningCodeBuiltAt clamps to the same epoch; a test
  // then fed the resulting epoch-derived date into GIT_AUTHOR_DATE, which git rejected outright). Surface
  // it as unavailable instead of guessing.
  const distMaxMs = newestMtimeMs(distDir);
  if (distMaxMs === null) {
    return unavailable("this daemon's own dist directory became unreadable while deriving its build clock (a build likely raced this read) — cannot derive a build time", baked);
  }
  // sharedDistDir may legitimately be absent (newestMtimeMs ⇒ null) without making the signal unavailable —
  // distDir above already guarantees a real contribution, so a missing shared dist safely defaults to 0 in
  // the max (it can never be the one that wins).
  const buildMaxMs = Math.max(distMaxMs, newestMtimeMs(sharedDistDir) ?? 0);
  const distBuiltAt = new Date(buildMaxMs).toISOString();

  // Card 8ff7ccde: when this process itself started (i.e. when its OWN currently-loaded code was read off
  // disk) — derived fresh at call time from `process.uptime()`, exactly like every other clock in this
  // module (DoD #4: never cached/memoized). `runningCodeBuiltAt` is the earlier of the two clocks — a safe
  // bound on what this process could actually be executing (see the module doc for why).
  const processStartedAtMs = processStartedAtOverride
    ? new Date(processStartedAtOverride).getTime()
    : Date.now() - process.uptime() * 1000;
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
    return unavailable(`could not read mainline HEAD: ${err instanceof Error ? err.message : String(err)}`, baked);
  }
  const [mainlineHeadSha, mainlineHeadDate] = headLine.split(UNIT_SEP);
  if (!mainlineHeadSha) return unavailable("git log returned no HEAD commit (a commitless repo?)", baked);

  let relevantLog: string;
  try {
    relevantLog = runGit(repoRoot, ["log", `--pretty=%H${UNIT_SEP}%cI`, "--max-count=2000", "--", ...RESTART_RELEVANT_PATHSPECS]);
  } catch (err) {
    return unavailable(`could not read daemon-src/shared commit history: ${err instanceof Error ? err.message : String(err)}`, baked);
  }
  // Card 8ff7ccde: computed against `runningCodeBuiltAtMs`, NOT the raw dist clock `buildMaxMs` — a
  // rebuild-without-restart must not UNDERSTATE staleness (see the module doc).
  const commitsBehind = countCommitsAfter(relevantLog, runningCodeBuiltAtMs);

  let webRelevantLog: string;
  try {
    webRelevantLog = runGit(repoRoot, ["log", `--pretty=%H${UNIT_SEP}%cI`, "--max-count=2000", "--", ...REBUILD_ONLY_PATHSPECS]);
  } catch (err) {
    return unavailable(`could not read web-src commit history: ${err instanceof Error ? err.message : String(err)}`, baked);
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
    webBuiltSha,
    webBuiltDirty,
  };
}
