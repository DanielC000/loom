import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { simpleGit, type SimpleGit, type SimpleGitOptions } from "simple-git";
import { killGateProcessTree } from "../orchestration/gate-runner.js";
import { assertRepoNotQuarantined } from "./merge-quarantine.js";
import { RepoQuarantinedError, resolveGitDirsSync } from "./repo-lock.js";
import { WIN_JOB_LAUNCHER_PATH, LOOM_HOME } from "../paths.js";

/**
 * Neutral extraction (card 9df3ea71) of the bounded-git primitives six independent copies across this
 * codebase each reimplemented: `git/worktrees.ts`, `git/writer.ts`, `orchestration/restart.ts`,
 * `sessions/service.ts`, `setup/bootstrap.ts`, `vault/versioner.ts`. A LEAF module relative to those six —
 * imports nothing from any of them, so it can be imported by all of them without reintroducing the
 * `git/writer.ts` → `vault/versioner.ts` import cycle those two already have.
 *
 * @decision 24c0bdba — one exception: `orchestration/gate-runner.ts`'s `killGateProcessTree`, reused by
 * {@link killableCanonicalRaw}'s tree-kill path rather than a second tree-killer — verified acyclic
 * (`gate-runner.ts` → `gate-spill.ts` → `paths.ts` → `pty/resolve-bin.ts` → node builtins only).
 *
 * @decision bde5d1fe — a second exception, same shape: `./merge-quarantine.js`/`./repo-lock.js`, reused by
 * {@link killableCanonicalRaw}'s own re-check rather than a third quarantine-checking copy — do not swap
 * either import for a hand-rolled quarantine check here; both are verified acyclic against this file.
 *
 * This module intentionally does NOT bundle a `withTimeout` race with `.env()` handling, a fixed timeout
 * constant, or non-interactive env into one opinionated helper: the six sites differ on purpose (per-
 * call-class timeout budgets, and whether/what non-interactive env is applied — see {@link
 * boundedSimpleGit}'s own doc), and folding those differences away would be a regression, not a fix.
 */

/**
 * Reject `p` after `ms` if it hasn't settled, so a git step is bounded even if the underlying promise
 * NEVER settles. `boundedSimpleGit`'s own `block` timeout also bounds the child in production, but is an
 * IDLE timer, not total-elapsed (see that function's own doc) — this race is the actual backstop
 * regardless. The timer is cleared on the winning path; if it fires first the timer is already done, so
 * nothing lingers on the event loop.
 *
 * @decision 8e75ee20 — this settles INDEPENDENT of the underlying git child: on expiry it rejects and
 * walks away, leaving the child (if still running) alone, still mutating shared state. NOT safe for a
 * call made while holding a lock (e.g. `withCanonicalIndexLock`) — use {@link withTimeoutKillingChild}.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms (hung git child?)`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** Does `e` mean "there is genuinely no git repository here" (git's own `--show-toplevel`/discovery
 *  exit-128 failure), as opposed to a timeout/killed-child/other probe failure (a bare refusal, dubious
 *  ownership, `safe.bareRepository` refusing a bare-looking dir)? Message-matched, same posture as
 *  `git/writer.ts`'s `isNoUpstreamError`. Lives in this LEAF module (card 306dd105) rather than in
 *  `git/writer.ts` (which re-exports it for compatibility) so BOTH `git/writer.ts` and
 *  `vault/versioner.ts` can share the one classifier without recreating the import cycle this module's
 *  own doc above exists to avoid between those two. */
export function isNotAGitRepositoryError(e: unknown): boolean {
  return /not a git repository/i.test((e as Error)?.message ?? String(e));
}

/** @decision 2267e8fa — generic, non-personal identity used ONLY when git itself cannot determine an
 *  identity for a commit role at all. Do not duplicate this constant per call site again — every
 *  commit-creating path shares this ONE copy; a duplicate is how the per-site probes drifted before. */
export const FALLBACK_GIT_IDENTITY = { name: "Loom", email: "loom@localhost" } as const;

/** @decision 2267e8fa — `git var` fatal for a genuinely unresolvable identity, INCLUDING the different
 *  fatal under `user.useConfigOnly=true` (card 7b59e981). Never match this against an unpinned-locale
 *  probe, and never re-duplicate this regex — the sync mirror (`vault/versioner.ts`) reuses this export. */
export function isGitIdentityUnresolvedError(e: unknown): boolean {
  return /(unable to auto-detect (?:name|email address)|empty ident (?:name|email)|no (?:name|email) was given and auto-detection is disabled)/i.test((e as Error)?.message ?? "");
}

/** @decision 2267e8fa — never drop this `withTimeout` wrap: a never-settling `git var` must not silently
 *  widen the caller's own total-elapsed bound. True iff `<varName>` resolves on `probeGit`; any OTHER
 *  probe failure is treated as resolvable — see {@link resolveGitIdentityFallbackArgs}. */
async function probeGitIdentResolvable(
  probeGit: Pick<SimpleGit, "raw">,
  varName: "GIT_AUTHOR_IDENT" | "GIT_COMMITTER_IDENT",
  timeoutMs: number,
): Promise<boolean> {
  try {
    await withTimeout(probeGit.raw(["var", varName]), timeoutMs, `git var ${varName}`);
    return true;
  } catch (e) {
    return !isGitIdentityUnresolvedError(e);
  }
}

/** @decision 2267e8fa — per-role (card 7b59e981): injects only the unresolvable role's GIT_<ROLE>_NAME/EMAIL,
 *  never a shared user.name/user.email pair that would also override an already-resolvable role.
 *  Residual: still replaces that role's identity wholesale, even when only one of its two fields failed. */
export function buildGitIdentityFallbackEnv(authorResolvable: boolean, committerResolvable: boolean): Record<string, string> {
  return {
    ...(authorResolvable ? {} : { GIT_AUTHOR_NAME: FALLBACK_GIT_IDENTITY.name, GIT_AUTHOR_EMAIL: FALLBACK_GIT_IDENTITY.email }),
    ...(committerResolvable ? {} : { GIT_COMMITTER_NAME: FALLBACK_GIT_IDENTITY.name, GIT_COMMITTER_EMAIL: FALLBACK_GIT_IDENTITY.email }),
  };
}

/** @decision 2267e8fa — THE ONE shared helper every commit-creating path uses for a fallback identity
 *  decision. Do not probe with a bare `user.name`/`user.email` config read, or re-duplicate this per
 *  site, again — both are how a resolvable (e.g. env-only) identity used to be wrongly read as missing.
 *
 *  Builds its OWN, DEDICATED probe-only git instance via `makeProbeGit` (default {@link canonicalGit}),
 *  rather than reusing the caller's real commit instance — a `SimpleGit` instance's `.env()` MUTATES it
 *  in place (simple-git's own `Git2.prototype.env`, single-object form, replaces `_executor.env`
 *  wholesale), so calling it on the caller's real instance would permanently clobber whatever env that
 *  instance needs for the REAL commit that follows. `baseEnv` (the caller's OWN env for its real
 *  instance — `undefined` meaning "whatever `canonicalGit`/the real instance already defaults to", i.e.
 *  `process.env`) is merged with a `LC_ALL=C`/`LANGUAGE=C` pin via {@link localReadGitEnv} and handed to
 *  `makeProbeGit` — so the PROBE always reads git's fatal in English (git's own locale negotiation
 *  consults `LANGUAGE`, a GNU gettext extension, AHEAD of `LC_ALL`; pinning only one is not enough) no
 *  matter what locale the host or the caller's real instance runs under, while the real commit's own
 *  env is untouched — never built from this merged probe env.
 *
 *  @decision 2267e8fa (card 7b59e981) — returns PER-ROLE env overrides ({@link buildGitIdentityFallbackEnv}), merged by the
 *  caller into the real commit's own explicit env (never `.env()` on an existing instance). Never throws: a
 *  synchronous `makeProbeGit` construct failure degrades to resolvable ({}) — some callers have no try/catch. */
export async function resolveGitIdentityFallbackArgs(
  cwd: string,
  timeoutMs: number,
  makeProbeGit: (cwd: string, timeoutMs: number, env: Record<string, string | undefined>) => Pick<SimpleGit, "raw"> = canonicalGit,
  baseEnv?: Record<string, string | undefined>,
): Promise<Record<string, string>> {
  const probeEnv = localReadGitEnv(baseEnv ?? process.env, { LC_ALL: "C", LANGUAGE: "C" });
  let probeGit: Pick<SimpleGit, "raw">;
  try {
    probeGit = makeProbeGit(cwd, timeoutMs, probeEnv);
  } catch {
    return {};
  }
  const authorResolvable = await probeGitIdentResolvable(probeGit, "GIT_AUTHOR_IDENT", timeoutMs);
  const committerResolvable = await probeGitIdentResolvable(probeGit, "GIT_COMMITTER_IDENT", timeoutMs);
  return buildGitIdentityFallbackEnv(authorResolvable, committerResolvable);
}

/** @decision 2267e8fa — adapts a legacy 2-arg `gitFactory` test seam to the 3-arg probe shape. Do not
 *  treat this as pinning anything — a 2-arg factory has nowhere to put `env`, so the probe stays UNPINNED
 *  (test-only). A test needing the pin should pass its own `identityProbeGitFactory` instead. */
export function unpinnedProbeFactoryFromLegacy(
  legacy: (cwd: string, timeoutMs: number) => Pick<SimpleGit, "raw">,
): (cwd: string, timeoutMs: number, env: Record<string, string | undefined>) => Pick<SimpleGit, "raw"> {
  return (cwd, timeoutMs) => legacy(cwd, timeoutMs);
}

/**
 * A TYPED marker (a non-enumerable property, never a message-text change) carried on an Error to mean "we
 * killed something, or gave up trying, without a positive confirmation the whole process TREE actually
 * died." Message text is deliberately left unchanged everywhere this is applied —
 * `test/bounded-git-kill-on-timeout.mjs` already pins the exact wording of every rejection shape this file
 * produces, and this marker rides alongside it, never replaces it.
 *
 * @decision 24c0bdba (round 3, Code Review B-1) — {@link treeDeathUnconfirmed} checks this FIRST, not a
 * string match alone: a string match alone is what let this bug happen (see {@link withTimeoutKillingChild}'s own doc).
 */
const UNCONFIRMED_KILL = Symbol("loom.unconfirmedKill");
function markUnconfirmedKill<E extends Error>(e: E): E {
  Object.defineProperty(e, UNCONFIRMED_KILL, { value: true, enumerable: false, configurable: true });
  return e;
}
function isMarkedUnconfirmedKill(e: unknown): boolean {
  return e instanceof Error && (e as unknown as Record<symbol, unknown>)[UNCONFIRMED_KILL] === true;
}

/**
 * The POSITIVE twin of {@link UNCONFIRMED_KILL}: a non-enumerable marker meaning "we killed this child AND
 * positively confirmed the whole process tree actually died." Set only at {@link spawnCanonicalGitTree}'s
 * two `confirmed:true` sites and propagated by {@link withTimeoutKillingChild} alongside
 * {@link UNCONFIRMED_KILL} — a caller must check {@link treeDeathConfirmed} directly, never infer this from
 * "not unconfirmed" (which also matches an unrelated non-kill failure).
 *
 * @decision 9f5ae011 (round 2) — mutually exclusive with {@link UNCONFIRMED_KILL} by construction: every
 * site that marks one is the disjoint if/else branch of the site that marks the other.
 */
const CONFIRMED_KILL = Symbol("loom.confirmedKill");
function markConfirmedKill<E extends Error>(e: E): E {
  Object.defineProperty(e, CONFIRMED_KILL, { value: true, enumerable: false, configurable: true });
  return e;
}
function isMarkedConfirmedKill(e: unknown): boolean {
  return e instanceof Error && (e as unknown as Record<symbol, unknown>)[CONFIRMED_KILL] === true;
}

/**
 * Like {@link withTimeout}, but for a caller that CANNOT tolerate the underlying child outliving the
 * wrapper's settlement — concretely, a call made inside a lock that guards shared on-disk state. Unlike
 * {@link withTimeout}, this does not settle independently on expiry: it calls `controller.abort()` (`p`'s
 * git instance must be constructed with that same `signal` via {@link boundedSimpleGit}'s `abortSignal`)
 * and then waits for `p` itself to settle.
 *
 * @decision 8e75ee20 — the load-bearing property: `p` only settles once the child is CONFIRMED dead, so a
 * caller inside a lock is safe to release it on return. Do NOT "simplify" this into a bare kill-then-settle
 * race — that reintroduces the exact lock race this function exists to close.
 *
 * `killGraceMs` (default `ms`) is the bounded fallback for a child that never dies on signal — past it,
 * this gives up and rejects anyway, the same abandon-the-child risk `withTimeout` always has.
 *
 * Giving up is ITSELF an unconfirmed-death outcome, not a distinct third thing: this rejection is tagged
 * {@link markUnconfirmedKill} unconditionally. Because `giveUpTimer`'s deadline is measured from THIS
 * call's own start while {@link spawnCanonicalGitTree}'s own confirmation only starts counting after the
 * child's `close` fires (strictly later), give-up structurally wins the race whenever confirmation is
 * genuinely slow — tagging give-up is what actually closes that gap, not a timing fix. When `p`'s own
 * rejection wins the race first instead (the common case: a child that dies promptly), its own tag (or
 * lack of one) is propagated onto the wrapped error unchanged below.
 *
 * @decision 24c0bdba (round 3, Code Review B-1) — before this, `giveUpTimer`'s message carried nothing
 * {@link treeDeathUnconfirmed} matched, so a caller checking it after a give-up always saw `false` and ran
 * further mutating cleanup (`resetOrSkip`/rollback) anyway — the exact bug the fail-closed path prevents.
 *
 * @decision 1a858805 — a successful kill only guarantees the child is dead, never that its on-disk
 * writes are undone; `createWorktree`'s own `worktree add` call site owns recovering any residue.
 *
 * @decision 963f69ab — the "confirmed dead" guarantee holds only for this function's PATH-1
 * settlement, never its `giveUpTimer` PATH-2 fallback; anchor discrimination to the specific
 * "Abort signal received" suffix, not the generic "(git child killed)" substring.
 */
export function withTimeoutKillingChild<T>(
  p: Promise<T>,
  ms: number,
  label: string,
  controller: AbortController,
  killGraceMs: number = ms,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ms);
    const giveUpTimer = setTimeout(() => {
      reject(markUnconfirmedKill(new Error(`${label} exceeded ${ms}ms, killed, but did not die within ${killGraceMs}ms — giving up (hung git child?)`)));
    }, ms + killGraceMs);
    p.then(
      (v) => {
        clearTimeout(killTimer); clearTimeout(giveUpTimer);
        if (timedOut) { reject(new Error(`${label} exceeded ${ms}ms (git child killed)`)); return; }
        resolve(v);
      },
      (e) => {
        clearTimeout(killTimer); clearTimeout(giveUpTimer);
        if (!timedOut) { reject(e); return; }
        const wrapped = new Error(`${label} exceeded ${ms}ms (git child killed): ${e?.message ?? e}`);
        if (isMarkedUnconfirmedKill(e)) markUnconfirmedKill(wrapped);
        else if (isMarkedConfirmedKill(e)) markConfirmedKill(wrapped);
        reject(wrapped);
      },
    );
  });
}

/** {@link rawViaWinJobLauncher}'s exit-code contract — see native/win-job-launcher/launcher.cs's own
 *  file-header doc for the authoritative definition; these consts just mirror it for TS callers.
 *  Exported (round 3, optional) so a test imports the REAL values rather than keeping its own copy —
 *  {@link LAUNCHER_EXIT_UNCONFIRMED_KILLED} is unused inside this file (bounded.ts only ever checks
 *  "is it the confirmed code", everything else is unconfirmed by construction) but is still exported for
 *  exactly that reason: a test simulating the launcher's own close code needs the real UNCONFIRMED value.
 *
 * @decision 1718416d — moved out of 0-255 (git's own exit-code range) and collapsed every "git never
 * ran" reason into the ONE refusal code; see the decision record's "round 2" update for why. */
export const LAUNCHER_EXIT_CONFIRMED_KILLED = 0x4c4f0001;
export const LAUNCHER_EXIT_UNCONFIRMED_KILLED = 0x4c4f0002;
export const LAUNCHER_EXIT_REFUSED = 0x4c4f0003;

/** @decision 1718416d — never rename/unlink/overwrite the REAL `win-job-launcher.exe` from a test to
 *  force the fallback (it backs the self-hosting daemon live); use this override instead. Test-only. */
let winJobLauncherOverrideActive = false;
let winJobLauncherOverrideValue: string | null = null;
export function setWinJobLauncherOverrideForTest(pathOrNull: string | null | undefined): void {
  winJobLauncherOverrideActive = pathOrNull !== undefined;
  winJobLauncherOverrideValue = pathOrNull ?? null;
  winJobLauncherAvailableCache = undefined;
  loggedWinJobLauncherUnavailable = false;
  // round 3, nit: without this, a test that triggers a real spawn-failure log in an EARLIER case stays
  // permanently silent for every LATER case in the same process — this flag is otherwise never reset.
  loggedWinJobLauncherSpawnFailure = false;
}

/** The path `rawViaWinJobLauncher`/`signalWinJobLauncherAbort` actually spawn — the test override when
 *  one is active, else the real fixed build path. Never read directly elsewhere; go through this. */
function resolveWinJobLauncherPath(): string {
  return winJobLauncherOverrideActive && winJobLauncherOverrideValue !== null ? winJobLauncherOverrideValue : WIN_JOB_LAUNCHER_PATH;
}

/** Memoized (never re-`fs.existsSync`'d after the first check — the file is a build-time artifact, not
 *  something that appears mid-process) win32-only check for whether `win-job-launcher.exe` was built.
 *  Logs ONCE, the first time it resolves `false`, so a host that never ran `build:native` doesn't get a
 *  log line per canonical git call. {@link setWinJobLauncherOverrideForTest} is the ONLY sanctioned way
 *  to force a fresh re-check within one process — a real build never appears mid-process either. */
let winJobLauncherAvailableCache: boolean | undefined;
let loggedWinJobLauncherUnavailable = false;
export function isWinJobLauncherAvailable(): boolean {
  if (winJobLauncherAvailableCache === undefined) {
    if (winJobLauncherOverrideActive) {
      winJobLauncherAvailableCache = process.platform === "win32" && winJobLauncherOverrideValue !== null && fs.existsSync(winJobLauncherOverrideValue);
    } else {
      winJobLauncherAvailableCache = process.platform === "win32" && fs.existsSync(WIN_JOB_LAUNCHER_PATH);
    }
    if (!winJobLauncherAvailableCache && process.platform === "win32" && !loggedWinJobLauncherUnavailable) {
      loggedWinJobLauncherUnavailable = true;
      // round 2, nit (e): a test override forcing `null` is a DELIBERATE test setup, not a missing build
      // — say so, rather than printing "not found at null" as if `build:native` were the fix for it.
      const reason = winJobLauncherOverrideActive && winJobLauncherOverrideValue === null
        ? "disabled by test override (setWinJobLauncherOverrideForTest(null))"
        : `not found at ${resolveWinJobLauncherPath()} — run \`pnpm --filter @loom/daemon build:native\` to build it`;
      // eslint-disable-next-line no-console
      console.log(`[git] win-job-launcher.exe ${reason} — falling back to the taskkill-based kill-confirm path for every canonical git call this process makes.`);
    }
  }
  return winJobLauncherAvailableCache;
}

/**
 * @decision 5b50eede — "absolute" means drive-rooted or UNC ONLY, never `path.isAbsolute` (also `true`
 * for a current-drive-relative `\foo`) — the SAME predicate launcher.cs's `IsAbsoluteGitExePath` uses.
 */
export function isAbsoluteWindowsExePath(p: string): boolean {
  if (p.length >= 3 && /^[A-Za-z]$/.test(p[0] ?? "") && p[1] === ":" && (p[2] === "\\" || p[2] === "/")) return true;
  if (p.startsWith("\\\\") || p.startsWith("//")) return true;
  return false;
}

/**
 * @decision 5b50eede — round 2 (CR `792785cb`): SKIP a PATH entry failing {@link isAbsoluteWindowsExePath}
 * (a relative hit used to resolve to a repo-reachable RELATIVE spawn target); test ONLY `<dir>\git.exe`.
 */
export function resolveAbsoluteGitExePath(pathOverride?: string): string | null {
  const PATH = pathOverride ?? (process.env.PATH || process.env.Path || "");
  const dirs = PATH.split(";").filter(Boolean);
  for (const dir of dirs) {
    if (!isAbsoluteWindowsExePath(dir)) continue;
    const candidate = path.join(dir, "git.exe");
    if (fs.existsSync(candidate)) return candidate;
  }
  logGitPathUnresolvedOnce();
  return null;
}

let loggedGitPathUnresolved = false;
function logGitPathUnresolvedOnce(): void {
  if (loggedGitPathUnresolved) return;
  loggedGitPathUnresolved = true;
  // eslint-disable-next-line no-console
  console.log(`[git] could not resolve an absolute git.exe on PATH — the win32 job-launcher path is skipped for THIS call (resolution is retried on every call, never cached as permanently unresolved); every other git spawn keeps today's bare "git" resolution for this call too.`);
}

/**
 * The ONE chokepoint every caller shares for "what absolute git.exe should THIS win32 call use" — wraps
 * {@link resolveAbsoluteGitExePath} + the SAME {@link isAbsoluteWindowsExePath} re-check applied at the
 * use site (round 2, CR `792785cb`), re-resolved on every call (never cached). `undefined` on POSIX or
 * when unresolved. {@link boundedSimpleGit} calls this automatically; {@link resolveGitBinaryForSpawn} is
 * the sibling for a raw child-process spawn that can't go through simple-git.
 *
 * @decision 5b50eede — never add a second resolver; every simple-git AND raw-spawn git call in this
 * codebase funnels through this one function (or its `resolveGitBinaryForSpawn` sibling below).
 */
export function resolveWin32GitBinary(): string | undefined {
  if (process.platform !== "win32") return undefined;
  const resolved = resolveAbsoluteGitExePath();
  return resolved && isAbsoluteWindowsExePath(resolved) ? resolved : undefined;
}

/**
 * For a raw `execFileSync`/`execFile`/`spawn`/`spawnSync`("git", …) site that cannot go through
 * simple-git (so {@link boundedSimpleGit}'s own auto-resolution never reaches it): the absolute git.exe
 * on win32 when {@link resolveWin32GitBinary} resolves one, else the literal `"git"` — always `"git"` on
 * POSIX.
 *
 * @decision 5b50eede — never hand-roll a literal `"git"` spawn argument anywhere in this codebase; call
 * this instead, so a caller can't forget the resolution the way the pre-this-card raw
 * `execFileSync("git", …)`/`spawn("git", …)` sites did.
 */
export function resolveGitBinaryForSpawn(): string {
  return resolveWin32GitBinary() ?? "git";
}

/**
 * round 3, MINOR-1: EACCES (permission denied) and ENOENT (path vanished) are properties of THIS exe —
 * retrying it on a later call won't help. So is a Windows bad-executable-format failure, which libuv
 * surfaces with no more specific code than `UNKNOWN`/errno `-4094` (verified directly against a real
 * non-executable file in round 2's own smoke test — there is no finer-grained code to check for it).
 * EAGAIN/EMFILE/ENFILE are host resource exhaustion — nothing to do with whether THIS exe works — and a
 * `TypeError` means invalid `spawn()` arguments (a code bug), not an exe problem either; neither should
 * disable the launcher for every later call over what's a one-off, call-scoped condition.
 */
function isPermanentLauncherSpawnFailure(e: unknown): boolean {
  if (e instanceof TypeError) return false;
  const err = e as NodeJS.ErrnoException;
  if (err?.code === "EACCES" || err?.code === "ENOENT") return true;
  if (err?.code === "UNKNOWN" || err?.errno === -4094) return true;
  return false;
}

/**
 * round 2, MAJOR 3: a REAL spawn attempt against the launcher failed for THIS call — the exe exists per
 * {@link isWinJobLauncherAvailable} but could not actually run (Smart App Control, AppLocker/WDAC, an AV
 * quarantine, or a corrupt binary). git never ran on this call, so falling back for it is always safe;
 * whether this ALSO flips the memoized availability to `false` (so every LATER call skips straight to
 * the fallback too) depends on {@link isPermanentLauncherSpawnFailure} — round 3, MINOR-1: a transient
 * failure falls back for only THIS call, leaving the launcher available for the next one. Logged once
 * per outcome KIND, the first time each fires.
 */
let loggedWinJobLauncherSpawnFailure = false;
function markWinJobLauncherSpawnFailed(e: unknown): void {
  if (!isPermanentLauncherSpawnFailure(e)) {
    // eslint-disable-next-line no-console
    console.log(`[git] win-job-launcher.exe spawn failed transiently (${(e as Error)?.message ?? e}) — falling back to the taskkill-based kill-confirm path for THIS call only; the launcher stays available for later calls.`);
    return;
  }
  winJobLauncherAvailableCache = false;
  if (loggedWinJobLauncherSpawnFailure) return;
  loggedWinJobLauncherSpawnFailure = true;
  // eslint-disable-next-line no-console
  console.log(`[git] win-job-launcher.exe exists but could not be spawned (${(e as Error)?.message ?? e}) — likely blocked (Smart App Control / AppLocker / WDAC / antivirus) or corrupt. Falling back to the taskkill-based kill-confirm path for this and every later canonical git call this process makes.`);
}

/**
 * round 3, MINOR-2: a caller whose `signal` is ALREADY aborted by the time one of
 * {@link rawViaWinJobLauncher}'s three fallback paths is about to spawn a replacement `git` has nothing
 * real to kill yet — rejecting immediately as a trivially CONFIRMED abort (an empty "tree", by
 * construction, is fully dead) is both correct and avoids starting a now-pointless `git` process just to
 * kill it again moments later. Returns `true` iff it rejected (the caller must not proceed to spawn).
 */
function abortedBeforeFallbackSpawn(signal: AbortSignal, reject: (e: Error) => void): boolean {
  if (!signal.aborted) return false;
  reject(markConfirmedKill(new Error("Abort signal received (never spawned the fallback — already aborted)")));
  return true;
}

/** Logged every occurrence (never deduped — see {@link rawViaWinJobLauncher}'s own doc: each one is an
 *  independently rare, diagnostic-worthy event, not "the feature is broken"). The launcher no longer
 *  distinguishes WHY it refused (round 2, MAJOR 2 collapsed event-collision/CreateProcessW-failed/
 *  assign-failed into one code) — there is nothing left to discriminate on here. */
function logWinJobLauncherCallFallback(): void {
  // eslint-disable-next-line no-console
  console.log("[git] win-job-launcher.exe refused this call (git was never spawned) — falling back to the direct taskkill-based path for THIS call only; the launcher stays available for later calls.");
}

// @decision 62c4953a (round 6) — an ALLOWLIST: never add a subcommand without verifying (git's own docs)
// it has NO value-bearing message/identity/trailer/reason/config-value flag. `worktree` was REMOVED here
// (round 6) — `worktree lock --reason <string>`/`add --lock --reason <string>` both take free text.
const SAFE_FULL_ARGS_SUBCOMMANDS = new Set([
  "status", "diff", "ls-files", "rev-parse", "rev-list", "merge-base", "show-ref", "for-each-ref",
  "cat-file", "read-tree", "write-tree", "reset", "checkout", "branch", "prune", "log", "grep",
]);

/**
 * Walks a `raw` git arg list's GLOBAL-OPTION prefix — the ONE shared walker `gitSubcommand`/
 * `gitGlobalArgs` (below) and {@link summarizeGitArgsForLog} all call, so they can never independently
 * drift on where the prefix ends.
 *
 * @decision 62c4953a (round 6, Code Review `b0e10423`) — `summarizeGitArgsForLog` used to re-scan an
 * ALREADY-SLICED prefix ARRAY by CONTENT (`a === "-c"`) for its own redaction, instead of re-walking the
 * ORIGINAL args by POSITION — so a `-C`/`--git-dir` VALUE that happened to equal the literal string `"-c"`
 * was mistaken for a real `-c` flag, mis-pairing the REAL following `-c`'s own value as that fake flag's
 * value and leaking it unredacted (e.g. `["-C","-c","-c","user.password=LEAK",...]`). Walking the
 * ORIGINAL args once, by position, with the SAME `GLOBAL_OPTS_WITH_VALUE` set every value-taking global
 * option is paired by, closes this for every such option, not just `-c`.
 */
function walkGitGlobalPrefix(args: readonly string[]): { subcommandIndex: number; renderedForLog: string[] } {
  const renderedForLog: string[] = [];
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-c") {
      // `-c key=value` redacts only the VALUE half — the key is a config path name, not a secret, and is
      // useful to a human diagnosing the call.
      renderedForLog.push(a);
      const kv = args[i + 1];
      if (kv !== undefined) {
        const eq = kv.indexOf("=");
        renderedForLog.push(eq === -1 ? "<redacted>" : `${kv.slice(0, eq)}=<redacted>`);
        i++;
      }
      continue;
    }
    if (GLOBAL_OPTS_WITH_VALUE.has(a)) {
      // `-C <path>`/`--git-dir <path>`/etc. — logged unchanged; none of these carry a message/identity/
      // trailer value, only a path/namespace.
      renderedForLog.push(a);
      const v = args[i + 1];
      if (v !== undefined) { renderedForLog.push(v); i++; }
      continue;
    }
    if (a.startsWith("-")) { renderedForLog.push(a); continue; } // another global flag with no value
    break; // reached the subcommand
  }
  return { subcommandIndex: i, renderedForLog };
}

// @decision 62c4953a (round 5) — NEVER reintroduce flag-level parsing to decide what to redact: three
// straight rounds each closed one leaked flag shape and missed another. Fails closed at the SUBCOMMAND
// level instead — a subcommand not on the allowlist above gets its whole tail collapsed to a bare count.
export function summarizeGitArgsForLog(args: readonly string[]): string {
  const { subcommandIndex, renderedForLog } = walkGitGlobalPrefix(args);
  const subcommand = args[subcommandIndex];
  const rest = args.slice(subcommandIndex);

  let tailOut: string[];
  if (subcommand !== undefined && SAFE_FULL_ARGS_SUBCOMMANDS.has(subcommand)) {
    tailOut = [...rest]; // verified safe — every arg after the subcommand logged in full
  } else if (subcommand !== undefined) {
    // Deny by default: an unrecognized subcommand is collapsed exactly like a known-unsafe one. Nothing
    // past the subcommand token itself is ever individually inspected — duration + subcommand is all the
    // index-lock diagnosis this log line exists for needs; the args are a secret-shaped unknown.
    const redactedCount = rest.length - 1;
    tailOut = [subcommand, `<${redactedCount} arg${redactedCount === 1 ? "" : "s"} redacted>`];
  } else {
    tailOut = []; // no subcommand at all (a bare global-option-only call) — nothing left to redact
  }

  const joined = [...renderedForLog, ...tailOut].join(" ");
  return joined.length > 300 ? `${joined.slice(0, 300)}…` : joined;
}

// Subcommands safe to assume do NOT touch `.git/index.lock`, for logCanonicalGitAbnormalOutcome's WARN
// classification ONLY — a DEDICATED set, never PURE_READ_SUBCOMMANDS (that one answers "could this run
// a merge driver", a different question). `status`/`diff`/`ls-files` are excluded even though `status`
// is in that other set: git opportunistically takes `.git/index.lock` to refresh stat-cache info on
// `status` (and `diff`, per git's own GIT_OPTIONAL_LOCKS docs) unless GIT_OPTIONAL_LOCKS=0 is set (never
// is, anywhere here); `ls-files` reads the index directly and can refresh it too. Every other member here
// operates purely on refs/objects/a named tree, never the index.
/** @decision 62c4953a (round 2, CR 6ed0d5da M4) — never fold `status`/`diff`/`ls-files` back into this
 *  set; each can opportunistically take `.git/index.lock` and must keep getting the WARN. */
const NEVER_INDEX_TOUCHING_SUBCOMMANDS = new Set([
  "rev-parse", "rev-list", "log", "show", "cat-file", "ls-tree", "merge-base", "config", "diff-tree",
  "update-ref", "symbolic-ref", "for-each-ref", "show-ref", "worktree", "remote",
  "count-objects", "describe", "name-rev", "grep", "init", "reflog",
]);

/**
 * @decision 62c4953a — log a canonical git call ONLY for an abnormal (killed/timed-out) outcome, never a
 * normal success or ordinary git failure — must not flood daemon-output.log.
 *
 * `args` is the caller's own args (never the `CANONICAL_GIT_CONFIG_ARGS`/merge-driver-blanking prefix) —
 * what a human actually needs to identify the culprit call.
 */
function logCanonicalGitAbnormalOutcome(repoPath: string, args: readonly string[], durationMs: number, outcome: string): void {
  const summary = summarizeGitArgsForLog(args);
  // eslint-disable-next-line no-console
  console.log(`[git] canonical git call ${outcome} after ${Math.round(durationMs)}ms in ${repoPath}: git ${summary}`);
  const sub = gitSubcommand(args);
  // Deny-by-default: an unrecognised subcommand is assumed capable of touching the index.
  const indexWriting = sub === undefined || !NEVER_INDEX_TOUCHING_SUBCOMMANDS.has(sub);
  if (indexWriting) {
    // eslint-disable-next-line no-console
    console.warn(`[git] canonical git call "git ${sub ?? summary}" in ${repoPath} was ${outcome} — its .git/index.lock may have been left behind; a later call refusing with canonical_index_lock_present is this.`);
  }
}

/**
 * {@link killableCanonicalRaw}'s tree-kill spawn primitive. Bypasses simple-git entirely so an abort kills
 * the WHOLE process tree, not just git's own direct child: simple-git's `abortPlugin` only ever sends
 * `spawned.kill("SIGINT")` to that ONE process (verified on Windows 11 and Linux/WSL — a hook's own
 * `sh`/`node` descendants survive it and can keep mutating the repo afterwards, e.g. a lint-staged-shaped
 * `sleep; git add` tail landing a DIFFERENT merge's file under this call's own trailer). `canonicalRaw`
 * (356538ef) still runs its full merge-driver enumeration/blanking/verification against this adapter —
 * only WHAT executes the final git process changes, never the protection pipeline around it.
 *
 * @decision 24c0bdba — settle only once the DIRECT child's own `close` fires (never independently of it —
 * same confirmed-dead contract {@link withTimeoutKillingChild} already documents), and, on POSIX, only
 * once {@link confirmProcessGroupDead} also clears within `killGraceMs` — see {@link treeDeathUnconfirmed}.
 *
 * `onTreeDeathSettled`, when supplied, is invoked EXACTLY ONCE, asynchronously, the moment this function's
 * OWN confirmation determination is finally made (win32/pid-less: once {@link killGateProcessTree}'s own
 * promise resolves; POSIX: once {@link confirmProcessGroupDead} resolves) — independent of whether the
 * OUTER {@link withTimeoutKillingChild} wrapper already gave up and settled first via its own
 * `giveUpTimer` (round 3, Code Review B-1/B-2: a caller uses this to auto-clear a quarantine it entered on
 * an outer give-up, once the real answer eventually arrives). Never invoked on the non-aborted path.
 *
 * `spawnImpl` (default the real `spawn`) is a test seam, EXPORTED for it (card 9f5ae011, round 3) — the
 * real marker application (`markConfirmedKill`/`markUnconfirmedKill`) lives entirely inside this
 * function's `close` handler below, reachable hermetically ONLY by substituting the OS-level spawn: a
 * fake child whose `pid` is `null` takes the SAME unconditional-confirm branch this function already uses
 * for a real win32 close (see below), with zero real process involved and zero platform dependence — see
 * `bounded-git-kill-marker-exclusivity.mjs`'s `[confirmed, real marker]` case, which deletes
 * `markConfirmedKill` to confirm this goes RED. Production call sites never pass this — the default is
 * the real `spawn`, byte-identical to before this param existed.
 *
 * `extraConfigArgs` (card bf11ac3f), when supplied, is spliced into the raw() closure's argv between
 * {@link CANONICAL_GIT_CONFIG_ARGS} and the real call args — see that closure below. Per-call, never a
 * module-level default: the ONE caller that needs it (`vault/versioner.ts`'s own `commitVault`, for its
 * `VAULT_GIT_SAFETY_ARGS`) passes it explicitly; every other caller omits it and sees byte-identical argv.
 */
export function spawnCanonicalGitTree(
  repoPath: string,
  env: Record<string, string | undefined> | undefined,
  signal: AbortSignal,
  killGraceMs: number,
  onTreeDeathSettled?: (confirmed: boolean) => void,
  spawnImpl: typeof spawn = spawn,
  extraConfigArgs?: string[],
): Pick<SimpleGit, "raw"> {
  // Cast: simple-git's own `raw` is a heavily overloaded `Response<string>`-returning signature (chainable
  // builder methods included) that a plain `(...args) => Promise<string>` can never structurally satisfy —
  // `canonicalRaw`'s callers only ever invoke `.raw(argsArray)` and `await` it, so a plain Promise is all
  // that's actually needed at runtime; the OLD `canonicalGit`'s own `raw` reassignment sidestepped this
  // same mismatch by going through a `Proxy` instead, whose `get` trap TypeScript does not check per-
  // property against the target's real type.
  const raw = (...callArgs: unknown[]): Promise<string> => {
    const rawArgs = (Array.isArray(callArgs[0]) ? callArgs[0] : callArgs) as string[];
    const args = [...CANONICAL_GIT_CONFIG_ARGS, ...(extraConfigArgs ?? []), ...rawArgs];
    // @decision 5b50eede — resolved ONCE per call via the shared chokepoint, shared by both paths below
    // (never a second copy of the resolve-and-re-check logic); POSIX never resolves (stays "git").
    const resolvedGitExe = resolveWin32GitBinary() ?? null;
    const directSpawnTarget = resolvedGitExe ?? "git";
    // @decision 1718416d — win32-only Job Object containment; unavailable/missing falls back byte-identical.
    // @decision 5b50eede — ALSO requires a resolved absolute git.exe; an unresolved git skips the launcher
    // for this call (same as "unavailable") rather than handing it a bare/relative target.
    // @decision 62c4953a — `startedAt`/the `.catch` below cover BOTH dispatch targets (the win-job-launcher
    // path and its own taskkill-based fallback) from this ONE chokepoint — see logCanonicalGitAbnormalOutcome.
    const startedAt = performance.now();
    const dispatched = (process.platform === "win32" && resolvedGitExe && isWinJobLauncherAvailable())
      ? rawViaWinJobLauncher(repoPath, env, signal, killGraceMs, onTreeDeathSettled, spawnImpl, args, rawArgs, resolvedGitExe)
      : rawViaDirectSpawn(repoPath, env, signal, killGraceMs, onTreeDeathSettled, spawnImpl, args, rawArgs, directSpawnTarget);
    return dispatched.catch((e: unknown) => {
      if (treeDeathConfirmed(e)) logCanonicalGitAbnormalOutcome(repoPath, rawArgs, performance.now() - startedAt, "confirmed-killed");
      else if (treeDeathUnconfirmed(e)) logCanonicalGitAbnormalOutcome(repoPath, rawArgs, performance.now() - startedAt, "kill-unconfirmed");
      throw e;
    });
  };
  return { raw } as unknown as Pick<SimpleGit, "raw">;
}

/**
 * Invokes `onTreeDeathSettled` defensively. Every call site below sits inside a `void`'d async IIFE
 * (`child.on("close", ...)`) with no surrounding try/catch of its own — an uncaught throw from this
 * caller-supplied callback (e.g. a merge-quarantine auto-clear) becomes an unhandled rejection, and the
 * `reject(...)` a few lines below it NEVER runs, so the bounded git promise this callback is nested
 * inside never settles at all. Swallow (never rethrow) so the caller can always still settle.
 *
 * @decision 24c0bdba (Follow-up 495fd320) — see the decision record.
 */
function invokeTreeDeathSettledSafely(onTreeDeathSettled: ((confirmed: boolean) => void) | undefined, confirmed: boolean): void {
  try {
    onTreeDeathSettled?.(confirmed);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[git/bounded] onTreeDeathSettled callback threw — swallowing it so the bounded git promise can still settle: ${(e as Error)?.message ?? e}`);
  }
}

/** The pre-1718416d direct-spawn path (now also the per-call fallback {@link rawViaWinJobLauncher}
 *  reaches for on a launcher-side refusal — see that function's own doc). This is what runs on every
 *  platform when the win32 launcher is unavailable OR its own git resolution came up empty.
 *  @decision 5b50eede — `gitBin` is a resolved absolute `.exe` path on win32 (or the literal `"git"` on an
 *  unresolved win32 host, same as before this card), and always the literal `"git"` on POSIX. */
function rawViaDirectSpawn(
  repoPath: string,
  env: Record<string, string | undefined> | undefined,
  signal: AbortSignal,
  killGraceMs: number,
  onTreeDeathSettled: ((confirmed: boolean) => void) | undefined,
  spawnImpl: typeof spawn,
  args: string[],
  rawArgs: string[],
  gitBin: string,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawnImpl(gitBin, args, {
      cwd: repoPath,
      env: prepareCanonicalEnv(env),
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let aborted = false;
    let killIssued: Promise<void> | undefined;
    child.stdout?.on("data", (d: Buffer) => { stdout += d; });
    child.stderr?.on("data", (d: Buffer) => { stderr += d; });
    const onAbort = () => {
      if (settled || aborted) return;
      aborted = true;
      // Captured (round 3, m-b), never `void`'d: the close handler below now AWAITS this — win32's own
      // `taskkill /T /F` completing is part of what "confirmed" means there, not merely "issued".
      killIssued = killGateProcessTree(child);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(e);
    });
    child.on("close", (code) => {
      if (settled) return;
      if (!aborted) {
        settled = true;
        signal.removeEventListener("abort", onAbort);
        if (code === 0) { resolve(stdout); return; }
        const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n") || `git ${rawArgs.join(" ")} exited with code ${code}`;
        reject(new Error(detail));
        return;
      }
      settled = true;
      void (async () => {
        if (killIssued) await killIssued;
        const pid = child.pid;
        if (pid == null || process.platform === "win32") {
          // win32: taskkill /T /F (awaited above) has now itself completed walking + killing the whole
          // subtree, and this child's own close firing here is confirmation on top of that — no further
          // poll available without extra tooling. Residual: a descendant reparented BEFORE taskkill ran
          // (round 3, Code Review B-2) is unreachable by a PPID-walking taskkill and can hold this same
          // pipe open indefinitely instead — `close` then never fires at all, and the OUTER
          // `withTimeoutKillingChild` give-up timer (itself now tagged unconfirmed) is what catches it.
          invokeTreeDeathSettledSafely(onTreeDeathSettled, true);
          reject(markConfirmedKill(new Error("Abort signal received")));
          return;
        }
        const confirmed = await confirmProcessGroupDead(pid, killGraceMs);
        invokeTreeDeathSettledSafely(onTreeDeathSettled, confirmed);
        const e = new Error(confirmed ? "Abort signal received" : "Abort signal received (process tree not fully confirmed dead)");
        if (confirmed) markConfirmedKill(e); else markUnconfirmedKill(e);
        reject(e);
      })();
    });
  });
}

/**
 * @decision 1718416d — never infer "confirmed" from a raw launcher exit code alone (both launcher codes
 * sit well outside git's own 0-255 range, but gate it on THIS call's own `aborted` flag regardless); a
 * launcher-side refusal routes back through {@link rawViaDirectSpawn} rather than git's own exit.
 */
function rawViaWinJobLauncher(
  repoPath: string,
  env: Record<string, string | undefined> | undefined,
  signal: AbortSignal,
  killGraceMs: number,
  onTreeDeathSettled: ((confirmed: boolean) => void) | undefined,
  spawnImpl: typeof spawn,
  args: string[],
  rawArgs: string[],
  gitExePath: string,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    // 128 bits, so two concurrent canonical git calls never accidentally collide on the same
    // abort-event name. NOT a secret (round 2, nit e): any same-user process can already read this
    // call's own command line (e.g. via WMI) — see docs/decisions/1718416d-*.md for why that's harmless.
    const nonce = crypto.randomBytes(16).toString("hex");
    let child: ReturnType<typeof spawn>;
    try {
      // @decision 5b50eede — gitExePath is a resolved absolute .exe (the caller already checked); the
      // launcher independently refuses a non-absolute value too (defense in depth, never trust-only).
      child = spawnImpl(resolveWinJobLauncherPath(), ["run", nonce, gitExePath, ...args], {
        cwd: repoPath,
        env: prepareCanonicalEnv(env),
        windowsHide: true,
        detached: false,
      });
    } catch (e) {
      // round 2 (found via real-spawn testing against a genuine non-executable file, not a simulation):
      // Node's `spawn()` can throw SYNCHRONOUSLY on Windows for a bad-executable-format target, instead
      // of returning a child that later emits an async "error" event — so `child.on("error", ...)` below
      // is NEVER reached (there's no `child` to attach it to). Handle this identically to that async path:
      // fall back for THIS call, flip availability for later ones. Never let this throw escape and reject
      // the whole call outright, which would skip the fallback MAJOR 3 exists to provide.
      markWinJobLauncherSpawnFailed(e);
      void (async () => {
        if (abortedBeforeFallbackSpawn(signal, reject)) return; // round 3, MINOR-2
        try {
          resolve(await rawViaDirectSpawn(repoPath, env, signal, killGraceMs, onTreeDeathSettled, spawnImpl, args, rawArgs, gitExePath));
        } catch (e2) { reject(e2); }
      })();
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let aborted = false;
    let spawnedOk = false; // round 3, MAJOR-A — see the "error" handler below for why this matters.
    let killIssued: Promise<void> | undefined;
    child.on("spawn", () => { spawnedOk = true; });
    child.stdout?.on("data", (d: Buffer) => { stdout += d; });
    child.stderr?.on("data", (d: Buffer) => { stderr += d; });
    const onAbort = () => {
      if (settled || aborted) return;
      aborted = true;
      killIssued = signalWinJobLauncherAbort(nonce, spawnImpl, child);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (!spawnedOk) {
        // round 2, MAJOR 3: a spawn error here (and the child never reached "spawn" at all) means the
        // exe exists (isWinJobLauncherAvailable() already checked that) but could not actually run —
        // Smart App Control, AppLocker/WDAC, an AV quarantine, or a corrupt binary. git never ran on
        // THIS call either way, so fall back for it safely, and flip the memoized availability so later
        // calls don't keep re-attempting a spawn already shown to fail.
        markWinJobLauncherSpawnFailed(e);
        void (async () => {
          if (killIssued) await killIssued; // best-effort; nothing real to wait on if it never truly spawned
          if (abortedBeforeFallbackSpawn(signal, reject)) return; // round 3, MINOR-2
          try {
            resolve(await rawViaDirectSpawn(repoPath, env, signal, killGraceMs, onTreeDeathSettled, spawnImpl, args, rawArgs, gitExePath));
          } catch (e2) { reject(e2); }
        })();
        return;
      }
      // round 3, MAJOR-A: the child DID spawn — Node also emits "error" on a still-RUNNING child when
      // `.kill()` fails with anything but ESRCH (e.g. EPERM), and `signalWinJobLauncherAbort`'s own
      // `killLauncherDirectly()` calls `launcherChild.kill()` on a missed/failed --signal. Falling back
      // here would be UNSAFE: the real launcher (and the git it may still be running) could still be
      // alive, so spawning a SECOND, independent git on the same repo is not idempotent, and whichever
      // one's verdict we'd report would be the WRONG one. Never fall back and never flip availability
      // for this shape — we simply don't know the real tree's fate, so fail closed as unconfirmed.
      void (async () => {
        if (killIssued) await killIssued;
        reject(markUnconfirmedKill(new Error(`win-job-launcher.exe reported an error after spawning (its kill may have failed): ${(e as Error)?.message ?? e}`)));
      })();
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (code === LAUNCHER_EXIT_REFUSED) {
        logWinJobLauncherCallFallback();
        void (async () => {
          if (killIssued) await killIssued; // best-effort; git was never actually spawned on this path
          if (abortedBeforeFallbackSpawn(signal, reject)) return; // round 3, MINOR-2
          try {
            resolve(await rawViaDirectSpawn(repoPath, env, signal, killGraceMs, onTreeDeathSettled, spawnImpl, args, rawArgs, gitExePath));
          } catch (e) { reject(e); }
        })();
        return;
      }
      if (!aborted) {
        // We did not request a kill — every exit code passes through as git's OWN, exactly like the
        // direct-spawn path. Never infer "confirmed" from LAUNCHER_EXIT_CONFIRMED_KILLED here (round 3
        // nit — this comment used to cite the retired 214/215 codes); see this function's own doc.
        if (code === 0) { resolve(stdout); return; }
        const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n") || `git ${rawArgs.join(" ")} exited with code ${code}`;
        reject(new Error(detail));
        return;
      }
      void (async () => {
        if (killIssued) await killIssued;
        const confirmed = code === LAUNCHER_EXIT_CONFIRMED_KILLED;
        invokeTreeDeathSettledSafely(onTreeDeathSettled, confirmed);
        const e = new Error(confirmed ? "Abort signal received" : "Abort signal received (process tree not fully confirmed dead)");
        if (confirmed) markConfirmedKill(e); else markUnconfirmedKill(e);
        reject(e);
      })();
    });
  });
}

/**
 * Best-effort — the real outcome is observed via the MAIN launcher's own `close` event (see
 * {@link rawViaWinJobLauncher}), never via this signaler invocation's own exit code — EXCEPT that a
 * non-zero/missing signal (round 2, MINOR a) means the main launcher (`launcherChild`) was never
 * actually told to abort, so this kills it directly instead: its job handle closing on exit fires
 * KILL_ON_JOB_CLOSE on the whole tree, same as a clean signal, just without the launcher's own
 * TerminateJobObject confirmation poll — so the caller correctly reports this path as UNCONFIRMED.
 * Mirrors the shape (and the `spawnImpl` test seam) {@link killGateProcessTree} uses for taskkill.
 */
function signalWinJobLauncherAbort(nonce: string, spawnImpl: typeof spawn, launcherChild: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => {
    const killLauncherDirectly = () => {
      try { launcherChild.kill(); } catch { /* already gone */ }
    };
    try {
      const signaler = spawnImpl(resolveWinJobLauncherPath(), ["--signal", nonce], { windowsHide: true, detached: false });
      signaler.on("close", (code) => {
        if (code !== 0) killLauncherDirectly();
        resolve();
      });
      signaler.on("error", () => {
        killLauncherDirectly();
        resolve();
      });
    } catch {
      killLauncherDirectly();
      resolve();
    }
  });
}

/**
 * POSIX-only: poll a pure liveness probe (`process.kill(-pid, 0)` — no signal delivered) until it throws
 * ESRCH (the whole process GROUP is gone) or `graceMs` elapses. SIGKILL to a group is immediate and
 * uncatchable, so a member not yet REAPED by its parent (a brief zombie window) can still make this probe
 * see it as "present" for a few ms without being able to act further — an accepted, documented residual
 * (a zombie cannot execute code), not a correctness gap.
 */
async function confirmProcessGroupDead(pid: number, graceMs: number): Promise<boolean> {
  const deadline = performance.now() + graceMs;
  for (;;) {
    try { process.kill(-pid, 0); } catch { return true; }
    if (performance.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * True iff `e` represents a kill (or a give-up waiting on one) that could NOT positively confirm the whole
 * process tree actually died — checks {@link markUnconfirmedKill}'s typed marker FIRST, falling back to
 * the two known message shapes only for an error this file's own tagging somehow missed.
 *
 * @decision 24c0bdba (round 3, Code Review B-1) — a caller must never run a further mutating cleanup (a
 * canonical `reset --hard` / a batch rollback) when this is true; that would race whatever might still be
 * alive. Fail closed instead — report the failure loudly, quarantine the repo, and touch nothing else.
 */
const UNCONFIRMED_TREE_RE = /\(git child killed\): Abort signal received \(process tree not fully confirmed dead\)/;
const GIVE_UP_RE = /, killed, but did not die within \d+ms — giving up \(hung git child\?\)$/;
export function treeDeathUnconfirmed(e: unknown): boolean {
  if (isMarkedUnconfirmedKill(e)) return true;
  const msg = (e as Error)?.message ?? "";
  return UNCONFIRMED_TREE_RE.test(msg) || GIVE_UP_RE.test(msg);
}

/**
 * True iff `e` represents a kill whose whole process tree was POSITIVELY CONFIRMED dead — checks
 * {@link markConfirmedKill}'s typed marker first; the `$`-anchored message-regex fallback exists ONLY for
 * a test-seam `gitFactory` call (bypasses this file's real kill machinery entirely, so no marker is ever
 * attached) that manufactures a confirmed-kill-shaped message directly — see
 * merge-confirm-verdict-cache-solo-merge-transient.mjs. The anchor is what keeps this disjoint from
 * {@link treeDeathUnconfirmed}'s own two message shapes, both of which carry trailing text after "Abort
 * signal received" that this regex's `$` refuses to match.
 *
 * @decision 9f5ae011 (round 2) — a caller gating a retry (or a leaked-lock removal) on "confirmed" must
 * check THIS function, never infer it from `!treeDeathUnconfirmed(e)` — that negation also matches an
 * unrelated non-kill failure, which is the exact over-broad gate this function exists to replace.
 *
 * @decision 9f5ae011 (round 3) — the `(git child killed): ` PREFIX is load-bearing: simple-git's OWN
 * `abortPlugin` throws a bare, unprefixed, unmarked "Abort signal received" on ANY aborted call anywhere,
 * and this regex must never widen to match that bare shape as confirmed.
 */
const CONFIRMED_TREE_RE = /\(git child killed\): Abort signal received$/;
export function treeDeathConfirmed(e: unknown): boolean {
  if (isMarkedConfirmedKill(e)) return true;
  const msg = (e as Error)?.message ?? "";
  return CONFIRMED_TREE_RE.test(msg);
}

/**
 * A MUTATING canonical-path git call must never abandon its child on a bare `withTimeout` race (see
 * 8e75ee20); the shared dual-path kill-wired pattern {@link createWorktree}'s `boundedLockedRaw` and
 * {@link attemptCodexAutoCommit} each hand-rolled independently. `gitFactory`, when supplied (the test
 * seam), has no real child to kill, so it stays on a plain `withTimeout`; otherwise every call is a fresh
 * {@link spawnCanonicalGitTree} + `AbortController`, tree-killed on timeout — never shared across calls,
 * since killing one call's tree must never touch a DIFFERENT call already in flight. `async` (not a bare
 * arrow returning a Promise) so a synchronous construct-time throw becomes a rejection like every other
 * path here, rather than propagating as a thrown exception.
 *
 * `onTreeDeathSettled`, when supplied, is forwarded verbatim to {@link spawnCanonicalGitTree} — see that
 * function's own doc. Never invoked at all on the `gitFactory` test-seam path (no real child exists there).
 *
 * @decision bde5d1fe — RE-CHECKS the quarantine immediately before every call (real or test-seam), never
 * just once at an outer entry. `quarantineRepoPath` (default `repoPath`) is the CANONICAL repo to check
 * when `repoPath` itself is an ephemeral worktree. Throws {@link RepoQuarantinedError} before spawning.
 *
 * `extraConfigArgs` (card bf11ac3f): an ADDITIVE, per-call `-c` config-argv extension, forwarded verbatim
 * to {@link spawnCanonicalGitTree} (see its own doc) — never folded into {@link CANONICAL_GIT_CONFIG_ARGS}
 * itself, since per-call-class config differences (e.g. `vault/versioner.ts`'s own hooksPath/fsmonitor/
 * gpgsign/safe.bareRepository neutralisation) must not silently widen onto every OTHER caller. Omitted (the
 * default) for every existing caller — byte-identical argv. Ignored on the `gitFactory` test-seam branch,
 * same as `env`/`onTreeDeathSettled` above (a fake `.raw()` builds its own argv, if any).
 */
export async function killableCanonicalRaw(
  repoPath: string,
  args: string[],
  timeoutMs: number,
  label: string,
  gitFactory?: (repoPath: string, blockTimeoutMs: number) => Pick<SimpleGit, "raw">,
  env?: Record<string, string | undefined>,
  onTreeDeathSettled?: (confirmed: boolean) => void,
  quarantineRepoPath: string = repoPath,
  extraConfigArgs?: string[],
): Promise<string> {
  const quarantineCheck = assertRepoNotQuarantined(quarantineRepoPath);
  if (!quarantineCheck.ok) throw new RepoQuarantinedError(quarantineCheck.reason);
  if (gitFactory) return withTimeout(gitFactory(repoPath, timeoutMs).raw(args), timeoutMs, label);
  const controller = new AbortController();
  return withTimeoutKillingChild(
    canonicalRaw(spawnCanonicalGitTree(repoPath, env, controller.signal, timeoutMs, onTreeDeathSettled, undefined, extraConfigArgs), args),
    timeoutMs, label, controller,
  );
}

/**
 * Env keys simple-git's `blockUnsafeOperationsPlugin` refuses when present in an explicitly-supplied
 * `.env()` object, that (1) a real host/session can plausibly carry ambiently AND (2) no non-interactive
 * git op in this codebase (piped stdio, never a real TTY — no op here ever opens an editor/pager/diff
 * tool) legitimately needs. Unconditionally safe to strip: a leftover value here could only cause an
 * unwanted throw, never a needed effect. This is the STRIP half of the design call — see
 * {@link boundedSimpleGit}'s doc for the sibling PASS-THROUGH half (the `GIT_CONFIG_*` / config-path
 * family), which is deliberately NOT in this list.
 *
 * @decision f7a80d76 — this is the FULL set, verified by EXECUTING `@simple-git/argv-parser@1.1.1`'s
 * real `parseEnv` against the installed simple-git, one key at a time — a prior audit's "eight keys"
 * undercounted it by ten.
 *
 * Left OUT of this list, deliberately, matching `git/writer.ts`'s original `nonInteractiveEnv()` reasoning
 * (card 42544916) extended to the now-verified full set:
 *  - `GIT_ASKPASS` / `SSH_ASKPASS` / `GIT_SSH` / `GIT_SSH_COMMAND` / `GIT_PROXY_COMMAND` — each names an
 *    arbitrary program git would exec in its place; bypassing simple-git's refusal is an arbitrary-command
 *    vector during real auth/transport. Left BLOCKED (present ⇒ simple-git still throws) rather than
 *    stripped or allowed — a caller with one of these ambiently set gets a loud, honest failure, not a
 *    silently-widened trust boundary.
 *  - `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` / `GIT_CONFIG` / `GIT_EXEC_PATH` / `PREFIX` — simple-git's
 *    `allowUnsafeConfigPaths` category; see {@link boundedSimpleGit}'s doc — passed THROUGH, not stripped.
 *  - `GIT_CONFIG_COUNT` / `GIT_TEMPLATE_DIR` — a separate category each (`allowUnsafeConfigEnvCount` /
 *    `allowUnsafeTemplateDir`); not realistically ambient (a script-authored env-config convention and a
 *    `git init`-only var this codebase's ops never invoke that way) and not exercised by anything this
 *    fix touches — left unhandled (blocked if ever present), same posture `writer.ts` already documented.
 */
export const GIT_ENV_STRIP_KEYS = [
  "GIT_EDITOR", "GIT_SEQUENCE_EDITOR", "EDITOR", "GIT_PAGER", "PAGER", "GIT_EXTERNAL_DIFF",
] as const;

/**
 * The ONE place this codebase decides which ambient env vars are safe to remove before handing an env to
 * simple-git — returns a NEW object with {@link GIT_ENV_STRIP_KEYS} deleted (never mutates `env`).
 * {@link boundedSimpleGit} applies this ITSELF, unconditionally, to whatever `env` it is given (card
 * f7a80d76 review round 2) — so a caller does NOT need to call this before passing an env; it is exported
 * for a caller that wants the scrubbed value earlier (to inspect/log/test it, or to feed it to something
 * other than `boundedSimpleGit`), not because skipping it would be unsafe. This function only ever handles
 * the STRIP half; the sibling config-path PASS-THROUGH+ALLOW half lives entirely in
 * {@link boundedSimpleGit} (below), since it's a construction-time simple-git option, not an env
 * transform.
 */
export function scrubGitEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out = { ...env };
  deleteEnvKeys(out, GIT_ENV_STRIP_KEYS);
  return out;
}

/**
 * The env keys simple-git's `blockUnsafeOperationsPlugin` refuses that {@link GIT_ENV_STRIP_KEYS} does NOT strip and {@link boundedSimpleGit} does not pass through:
 * the transport/auth family (ask-pass, ssh, proxy programs), the template dir and the config-env count. Derived from `@simple-git/argv-parser@1.1.1`'s own `dist/index.mjs`
 * (the `const y = { … }` env→category map read by `parseEnv`); the remaining keys of that map are the editor/pager keys (stripped by {@link scrubGitEnv}) and the
 * config-path keys (`GIT_CONFIG_GLOBAL/SYSTEM`, `GIT_CONFIG`, `GIT_EXEC_PATH`, `PREFIX`: allowed by {@link boundedSimpleGit}).
 */
export const GIT_ENV_TRANSPORT_KEYS = ["GIT_ASKPASS", "SSH_ASKPASS", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_PROXY_COMMAND", "GIT_TEMPLATE_DIR", "GIT_CONFIG_COUNT"] as const;

/**
 * Env keys that PIN which repo/working-tree/object-store a git invocation targets, overriding its
 * normal cwd-based upward discovery outright. An UNPINNED discovery probe (one that must answer "is
 * `repoPath` itself a repo, or which repo governs it") needs these ABSENT, never merely benign.
 *
 * @decision 306dd105 — an ambient `GIT_DIR` (a shell export, an IDE terminal, a decoy left by a prior
 * step) silently redirects such a probe at a DIFFERENT repo while it keeps reporting success, which is
 * worse than an honest error; see that record's "Round 3" for the regression this closed.
 *
 * Deliberately EXCLUDES `GIT_CEILING_DIRECTORIES`: that var bounds how far UPWARD a search may walk, it
 * does not point at a specific repo the way every key below does, and a caller legitimately bounding
 * discovery to its own temp root may want it left alone on an otherwise-stripped probe env.
 *
 * @see {@link stripRepoLocationEnv} — the one place this list is applied; reuses {@link deleteEnvKeys},
 * never a second hand-rolled removal loop.
 */
export const GIT_ENV_REPO_LOCATION_KEYS = [
  "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE",
] as const;

/**
 * Deletes {@link GIT_ENV_REPO_LOCATION_KEYS} from `env`, IN PLACE (mirrors {@link deleteEnvKeys}'s own
 * mutate-in-place contract) — for an UNPINNED discovery/read probe that must use git's own cwd-based
 * repo resolution and must not be silently redirected by an ambient `GIT_DIR`/`GIT_WORK_TREE`/etc.
 *
 * Never call this on an env a caller is ABOUT to pin (e.g. via `localReadGitEnv`'s own `GIT_DIR`/
 * `GIT_WORK_TREE` overrides) in order to "be safe" — stripping first is harmless there (the override
 * re-adds exactly those two keys), but the helper exists for the UNPINNED case; a caller that wants to
 * pin should just pin.
 */
export function stripRepoLocationEnv(env: Record<string, string | undefined>): void {
  deleteEnvKeys(env, GIT_ENV_REPO_LOCATION_KEYS);
}

/**
 * The env for a LOCAL, read-only git probe that needs a pinned setting (e.g. `LC_ALL=C`, to read git's English message): `base` (case-aware) MINUS {@link GIT_ENV_TRANSPORT_KEYS},
 * with `overrides` applied (any differently-cased spelling of an override key removed first, win32 env names being case-insensitive). Such a probe never authenticates or talks
 * to a remote, so the stripped keys cannot matter to it, whereas an EXPLICIT env carrying one (VS Code's terminal sets `GIT_ASKPASS`) would make simple-git throw "unsafe" on
 * EVERY call. Returns a NEW object; never mutates `base`. Callers that DO reach a remote must not use this: those keep the loud failure (see {@link GIT_ENV_STRIP_KEYS}).
 */
export function localReadGitEnv(base: Record<string, string | undefined>, overrides: Record<string, string>): Record<string, string | undefined> {
  const out = { ...base };
  deleteEnvKeys(out, GIT_ENV_TRANSPORT_KEYS);
  deleteEnvKeys(out, Object.keys(overrides));
  return { ...out, ...overrides };
}

/** The keys of `env` that name one of `names` — on win32 case-INSENSITIVELY (env names are case-insensitive there: `Git_Pager` IS `GIT_PAGER` to git-for-windows, and
 *  a `{...process.env}` copy keeps the key as spelled); on POSIX exact-match only (`Git_Config` is a different, inert variable). Card e93703d9. */
export function envKeysNamed(env: Record<string, string | undefined>, names: readonly string[]): string[] {
  if (process.platform !== "win32") return names.filter((n) => Object.prototype.hasOwnProperty.call(env, n));
  const upper = new Set(names.map((n) => n.toUpperCase()));
  return Object.keys(env).filter((k) => upper.has(k.toUpperCase()));
}
/** Delete every key {@link envKeysNamed} finds, in place. */
export function deleteEnvKeys(env: Record<string, string | undefined>, names: readonly string[]): void {
  for (const k of envKeysNamed(env, names)) delete env[k];
}

/**
 * Build a simpleGit instance bound by a block timeout. ⚠️ **`block` is an IDLE timeout — the kill timer
 * resets on every `data` event from the child's stdout/stderr (verified at source,
 * `node_modules/.pnpm/simple-git@3.36.0/.../timeoutPlugin`) — it is NOT a total-elapsed ceiling.** A
 * child that emits output at least once per `blockTimeoutMs` is never killed by this, however long it
 * runs in total. It still kills a genuinely HUNG (no-output) child, which is the case most callers
 * actually care about; a caller that also needs a total-elapsed kill (not just idle) passes `abortSignal`
 * (below) and bounds elapsed time itself via {@link withTimeoutKillingChild}.
 *
 * @decision f7a80d76 — `env`, when supplied, is scrubbed via {@link scrubGitEnv} and the config-path
 * family is explicitly allowed, BOTH unconditionally HERE at the one construction chokepoint — a
 * caller must never scrub or allow config-paths itself; that per-caller drift caused the M1/M2 gap.
 *
 * `abortSignal`, when supplied, is passed through as simple-git's own `abort` option, wiring up its
 * `abortPlugin` so a later `controller.abort()` issues a real kill of the spawned child — see the
 * `8e75ee20` record for the one caller that needs it. OMIT it (the default) for a plain instance with no
 * abort wiring, matching every existing caller byte-for-byte.
 *
 * Card 00a6cdd6 (Code Review S4): `extraUnsafe`, when supplied, is merged into the SAME `unsafe` object
 * — but ONLY for the ONE call that passes it. This is deliberately NOT another unconditional addition
 * next to `allowUnsafeConfigPaths` above: a caller-scoped opt-in keeps every OTHER existing/future
 * caller's `unsafe` allowlist exactly what it is on main, rather than silently widening it for all of
 * them. The codex auto-commit path (`git/worktrees.ts`'s `attemptCodexAutoCommit`) is the one caller
 * that passes `{ allowUnsafeHooksPath: true, allowUnsafeFsMonitor: true }` here, via its OWN dedicated
 * `gitFactory` — see that function's own doc for why it needs both.
 *
 * @decision 5b50eede (round 3, card `cf9a32cf`) — a resolved `binary` auto-enables `allowUnsafeCustomBinary`;
 * a real Windows git path (`C:\Program Files\Git\...`) fails simple-git's own binary regex on the space
 * alone, so leaving it off would throw on construction instead of resolving.
 *
 * @decision 5b50eede (round 4, card `b5416a46`) — THIS is now the chokepoint that calls
 * {@link resolveWin32GitBinary} itself when `binaryOverride` is omitted, so every caller (not just
 * `canonicalGit`) gets the resolved absolute git.exe on win32 automatically, with no opt-in needed.
 *
 * Unresolved/POSIX still falls back to simple-git's bare `"git"` default, byte-identical to before this
 * round; `binaryOverride` remains for pinning a specific value (a test seam).
 */
/**
 * A Proxy wrapping `git` that refuses a real `.customBinary(` call with `message`, forwarding every
 * other property/method bound to the real target — the shared shape {@link boundedSimpleGit} and
 * {@link canonicalGit} both need (fail-closed): `allowUnsafeCustomBinary:true` is scoped at construction
 * to OUR OWN resolved path, but simple-git's own `customBinaryPlugin` captures that flag once and reuses
 * it for every LATER `.customBinary()` call too — unwrapped, any later caller holding the instance could
 * silently swap in an unvalidated binary with no check at all.
 *
 * @decision 5b50eede (round 4 follow-up, CR `201f0c7e`) — this used to live ONLY in canonicalGit's own
 * Proxy; a plain `boundedSimpleGit` caller got the SAME flag (round 4 made it automatic) with no refusal.
 * `boundedSimpleGit` now applies this itself, so protection travels with the flag, not each caller's memory.
 */
function refuseCustomBinaryProxy(git: SimpleGit, message: string): SimpleGit {
  const refuse = (): never => { throw new Error(message); };
  return new Proxy(git, {
    get(target, prop) {
      if (prop === "customBinary") return refuse;
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

export function boundedSimpleGit(
  repoPath: string,
  blockTimeoutMs: number,
  env?: Record<string, string | undefined>,
  abortSignal?: AbortSignal,
  extraUnsafe?: SimpleGitOptions["unsafe"],
  config?: string[],
  binaryOverride?: string,
): SimpleGit {
  const scrubbedEnv = env ? scrubGitEnv(env) : undefined;
  const hasEnv = !!scrubbedEnv && Object.keys(scrubbedEnv).length > 0;
  const binary = binaryOverride ?? resolveWin32GitBinary();
  const unsafe: SimpleGitOptions["unsafe"] = {
    allowUnsafeConfigPaths: true,
    ...(binary ? { allowUnsafeCustomBinary: true } : {}),
    ...extraUnsafe,
  };
  const buildGit = () => simpleGit(repoPath, {
    timeout: { block: blockTimeoutMs },
    ...(abortSignal ? { abort: abortSignal } : {}),
    ...(hasEnv || extraUnsafe || binary ? { unsafe } : {}),
    ...(config && config.length > 0 ? { config } : {}),
    ...(binary ? { binary } : {}),
  });
  // @decision 5b50eede (round 3) — simple-git still console.warns on a regex-failing `binary` even WITH
  // allowUnsafeCustomBinary; suppressed (synchronous construction only) as benign, expected noise.
  const git = binary ? withConsoleWarnSuppressed(buildGit) : buildGit();
  const final = hasEnv ? git.env(scrubbedEnv as Record<string, string | undefined>) : git;
  // @decision 5b50eede (round 4 follow-up, CR `201f0c7e`) — only when `binary` actually resolved: an
  // unresolved/POSIX instance never set `allowUnsafeCustomBinary` in the first place, so simple-git's own
  // default (`allowUnsafe:false`) already refuses `.customBinary()` with no wrapping needed here.
  return binary
    ? refuseCustomBinaryProxy(final, "boundedSimpleGit: customBinary() is refused — this instance's git binary was resolved once at construction (win32's absolute-path resolution); construct a fresh boundedSimpleGit(...) instead of swapping the binary on an existing instance.")
    : final;
}

/** Substring of simple-git's `WRONG_CHARS_ERR` (`custom-binary.plugin.ts`, verified against the installed
 *  `simple-git@3.36.0`) — the ONE warning {@link withConsoleWarnSuppressed} drops; anything else still
 *  reaches the real `console.warn`, so an unrelated future construction-time warning is never swallowed. */
const SIMPLE_GIT_CUSTOM_BINARY_WARNING = "restricted characters must be removed or supply the unsafe.allowUnsafeCustomBinary option";

/** Filters OUT only simple-git's own "binary has restricted characters" warning around a synchronous
 *  call, then restores `console.warn` unconditionally — see {@link boundedSimpleGit}'s own doc for the
 *  one caller. Every other `console.warn` (from simple-git or anything else) is forwarded unchanged. */
function withConsoleWarnSuppressed<T>(fn: () => T): T {
  const original = console.warn;
  // eslint-disable-next-line no-console
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].includes(SIMPLE_GIT_CUSTOM_BINARY_WARNING)) return;
    original(...args);
  };
  try {
    return fn();
  } finally {
    console.warn = original;
  }
}

/**
 * The ONE factory every CANONICAL merge-path git call uses (`git/worktrees.ts`, `git/batch-merge.ts`): ignores replace refs on every
 * command, neutralizes a worker-planted `info/grafts`/`.git/shallow` (via {@link prepareCanonicalEnv}'s sentinel env vars), and fails
 * closed on worker-set merge drivers in the shared `.git`. Deny-by-default: an unrecognised subcommand is exec-capable.
 *
 * @decision 356538ef — do NOT construct git on the canonical path any other way (guarded by canonical-git-helper-guard.mjs), and do NOT
 * swap the driver blanking for `--attr-source`/`core.attributesFile` (verified not to stop a driver). Residual + not-hardened: the record.
 */
export const CANONICAL_GIT_CONFIG = ["core.useReplaceRefs=false", "core.commitGraph=false"] as const;
/** The `-c` argv equivalent of {@link CANONICAL_GIT_CONFIG}, for a raw `spawn("git", …)` site that cannot use {@link canonicalGit}. */
export const CANONICAL_GIT_CONFIG_ARGS: readonly string[] = CANONICAL_GIT_CONFIG.flatMap((c) => ["-c", c]);

/** Subcommands that cannot run a merge driver UNLESS an arg asks them to (`--remerge-diff` on show/log/diff-tree does — see
 *  {@link canRunMergeDriver}). ANYTHING else is exec-capable (deny-by-default). */
const PURE_READ_SUBCOMMANDS = new Set([
  "rev-parse", "rev-list", "log", "show", "cat-file", "ls-files", "ls-tree", "merge-base", "config", "diff-tree",
  "diff", "status", "branch", "update-ref", "symbolic-ref", "for-each-ref", "show-ref", "worktree", "remote",
  "count-objects", "describe", "name-rev", "grep", "init", "reflog",
]);

/** Global options that take their value as a SEPARATE arg when written without `=` (`--exec-path`/`--super-prefix` are deliberately absent: bare, they take no value, and mis-skipping a real subcommand would be the UNSAFE direction) — the value must never be read as the subcommand. */
const GLOBAL_OPTS_WITH_VALUE = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--config-env", "--attr-source"]);

// @decision 62c4953a (round 6) — routes through the SAME walkGitGlobalPrefix() summarizeGitArgsForLog
// uses, so the two can never drift on where the global-option prefix ends.
/** Parse a `raw` arg list's global options: the subcommand (or undefined). */
function parseGitArgs(args: readonly string[]): { sub: string | undefined } {
  return { sub: args[walkGitGlobalPrefix(args).subcommandIndex] };
}

/** The git subcommand of a `raw` arg list, skipping global options and their separate-arg values (`-c k=v`, `-C p`, `--git-dir p`, `--x[=y]`). */
export function gitSubcommand(args: readonly string[]): string | undefined {
  return parseGitArgs(args).sub;
}

/** Could this command run a merge driver? Deny-by-default; a known pure read is exec-capable only if an arg names `--remerge-diff` (any arg matching /remerge/). */
export function canRunMergeDriver(args: readonly string[]): boolean {
  const { sub } = parseGitArgs(args);
  if (sub === undefined || !PURE_READ_SUBCOMMANDS.has(sub)) return true;
  // `--remerge-diff`, `--diff-merges=r`, and `-m`/`--diff-merges=on` (a worker-set `log.diffMerges=remerge` turns those into remerge) all run merge drivers on a read.
  return args.some((a) => /remerge/i.test(a) || /^--diff-merges/i.test(a) || /^-[A-Za-z]*m[A-Za-z]*$/.test(a));
}

/** A canonicalGit refusal: thrown BEFORE any git process runs, so nothing was changed. Callers tell it from a real git failure via {@link describeGitFailure}. */
export class CanonicalGitRefusal extends Error {
  constructor(message: string) { super(message); this.name = "CanonicalGitRefusal"; }
}

/** One shared way to describe a git failure in a result `reason`: the first line of the message (capped), and whether it was a {@link CanonicalGitRefusal} (nothing changed). */
export function describeGitFailure(e: unknown): { text: string; refusal: boolean } {
  const text = String((e as Error)?.message ?? e).split(/\r?\n/, 1)[0]!.slice(0, 400);
  return { text, refusal: e instanceof CanonicalGitRefusal };
}

// @decision 62c4953a (round 6) — routes through the SAME walkGitGlobalPrefix() summarizeGitArgsForLog
// uses, so the two can never drift on where the global-option prefix ends.
/** The global options in front of the subcommand (`--git-dir p`, `-C p`, `-c k=v`, `--work-tree=…`, …): the config-affecting context the REAL call runs in. */
export function gitGlobalArgs(args: readonly string[]): string[] {
  return args.slice(0, walkGitGlobalPrefix(args).subcommandIndex);
}

const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);
/** `merge.<name>.driver`, matched in JS (any `<name>`, including empty, with `=`, or U+FFFD). Case-insensitive on section/variable as git canonicalises them. */
const MERGE_DRIVER_KEY = /^merge\.([\s\S]*)\.driver$/i;

/** A config key that cannot be trusted to round-trip through argv/UTF-8 decoding (a non-UTF-8 byte decodes to U+FFFD, colliding with our own `-c` key), or holds a control char. */
const keyIsUnsafe = (k: string): boolean => k.includes(REPLACEMENT_CHAR) || /[\x00-\x1f\x7f]/.test(k);

/**
 * THE INVARIANT (rulings after review rounds 1-4): stop predicting key spelling and VERIFY the resulting state, self-sufficiently. With `prefix` applied
 * — and with the call's OWN global options (`-C`, `--git-dir`, `-c`, …) so this read sees exactly the config the real call sees — re-read every
 * `merge.*.driver` and THROW a {@link CanonicalGitRefusal} unless the EFFECTIVE (last-wins) value of every key is empty. Fails closed on anything it cannot
 * PROVE empty: a key with no value is live, and so is any key containing U+FFFD or a control character (decoding collapses the real key and our
 * blanking `-c` key into one map entry, so the blank would hide the live driver — this check must not depend on the enumeration having refused first).
 */
export async function assertNoLiveMergeDrivers(git: Pick<SimpleGit, "raw">, prefix: readonly string[], args: readonly string[]): Promise<void> {
  const out = await git.raw([...prefix, ...gitGlobalArgs(args), "config", "-z", "--list"]);
  const effective = new Map<string, string | null>();
  for (const rec of out.split("\0")) {
    if (rec === "") continue;
    const nl = rec.indexOf("\n");
    const key = nl < 0 ? rec : rec.slice(0, nl);
    if (MERGE_DRIVER_KEY.test(key)) effective.set(key, nl < 0 ? null : rec.slice(nl + 1));
  }
  const live = [...effective].filter(([k, v]) => v !== "" || keyIsUnsafe(k)).map(([k]) => k);
  if (live.length > 0) {
    throw new CanonicalGitRefusal(`canonicalGit: refusing to run "git ${gitSubcommand(args) ?? ""}" — merge driver key(s) ${live.map((k) => JSON.stringify(k)).join(", ")} would still be live after neutralising (a name that cannot be carried in a -c override); remove them from the repository's git config`);
  }
}

/** Names `<x>` of every `merge.<x>.driver` visible from the call's cwd/globals (includes + worktree config honoured). */
async function configuredMergeDriverNames(git: Pick<SimpleGit, "raw">, globals: readonly string[]): Promise<string[]> {
  // LIST every entry and filter IN JS — never `--get-regexp`: on glibc in a UTF-8 locale git's regex `.` does NOT match an invalid byte, so a regex read
  // returned NOTHING for a raw-0xE9 driver name and the driver ran (a Windows git matches in every locale, so only POSIX could see it). A real error throws (fail closed).
  const out = await git.raw([...globals, "config", "-z", "--list"]);
  const names = new Set<string>();
  for (const rec of out.split("\0")) {
    const key = rec.split("\n", 1)[0]!;
    const m = MERGE_DRIVER_KEY.exec(key);
    if (m) names.add(m[1]!);
  }
  return [...names];
}

/** Builds the `-c merge.<x>.driver=` prefix from the enumerated names. The DEFAULT refuses names `-c` cannot carry; {@link canonicalRaw}'s post-check is the backstop. */
export type MergeDriverPrefixBuilder = (names: readonly string[], args: readonly string[]) => string[];
const defaultPrefixBuilder: MergeDriverPrefixBuilder = (names, args) => {
  // `-c` splits key/value at the FIRST `=`, so a name containing `=` (gitattributes accept `merge=a=b`) can never be blanked that way; refuse rather than try
  // (also control chars and U+FFFD).
  const bad = names.find((n) => n.includes("=") || keyIsUnsafe(n));
  if (bad !== undefined) {
    throw new CanonicalGitRefusal(`canonicalGit: refusing to run "git ${gitSubcommand(args) ?? ""}" — the repository's git config defines merge driver key ${JSON.stringify(`merge.${bad}.driver`)}, whose name contains "=", a control character or a non-UTF-8 byte and so cannot be safely neutralised; remove that key from the shared .git/config (or worktree/included config)`);
  }
  return names.flatMap((n) => ["-c", `merge.${n}.driver=`]);
};

/**
 * The whole `raw` pipeline of {@link canonicalGit}: enumerate (with the call's own globals) → build the blanking prefix → VERIFY it via
 * {@link assertNoLiveMergeDrivers} → run. Exported ONLY so a test can inject a `buildPrefix` that deliberately misses a driver and prove the post-check is
 * WIRED and is the last line of defence (production always uses the default builder).
 */
export async function canonicalRaw(git: Pick<SimpleGit, "raw">, args: string[], buildPrefix: MergeDriverPrefixBuilder = defaultPrefixBuilder): Promise<string> {
  let prefix: string[] = [];
  if (canRunMergeDriver(args)) {
    const names = await configuredMergeDriverNames(git, gitGlobalArgs(args));
    prefix = buildPrefix(names, args);
    await assertNoLiveMergeDrivers(git, prefix, args);
  }
  return git.raw([...prefix, ...args]);
}

/**
 * A fresh, almost-certainly-nonexistent absolute path under a Loom-controlled dir, for neutralizing a
 * worker-writable `info/grafts`/`.git/shallow` via `GIT_GRAFT_FILE`/`GIT_SHALLOW_FILE` (see
 * {@link prepareCanonicalEnv}). Fresh per {@link prepareCanonicalEnv} CALL — i.e. per `canonicalGit`
 * CONSTRUCTION, but per `raw()` CALL for {@link spawnCanonicalGitTree} (card 7ebb4acf, N1 — `prepareCanonicalEnv`
 * runs INSIDE `rawViaDirectSpawn`/`rawViaWinJobLauncher`, not at `spawnCanonicalGitTree`'s own construction
 * time, so every mutating `raw()` call on that path gets its own fresh pair of sentinels) — never memoized,
 * never created here.
 *
 * @decision 356538ef — never use the literal `"NUL"` (an MSYS/bash-invoked git resolves it as a
 * plantable cwd-relative file, not the real null device) and never a FIXED literal path (this repo is
 * public — a worker could pre-plant it); always a fresh absolute path, never created here.
 *
 * `path.resolve` (not `path.join`) on `LOOM_HOME`: a relative `LOOM_HOME` (an unusual, but not
 * impossible, env override) would otherwise produce a relative sentinel, resolved against whatever cwd
 * the spawned git child happens to run in — never the intended Loom-controlled location.
 */
export function freshGitSentinelPath(label: "graft" | "shallow"): string {
  const dir = path.resolve(LOOM_HOME, "tmp", "git-sentinel");
  return path.join(dir, `${label}-${crypto.randomBytes(16).toString("hex")}`);
}

/**
 * The env-prep `canonicalGit` itself applies before construction: strip ambient `GIT_CONFIG` (honoured
 * ONLY by the `git config` builtin, never by `git merge` — left in place it blinds both driver reads to a
 * file the real merge never reads; every OTHER config env var feeds the ONE config stack `merge` and
 * `config` both read, so only this one needs stripping), then unconditionally layer the two graft/shallow
 * neutralization sentinels (`GIT_GRAFT_FILE`/`GIT_SHALLOW_FILE`, {@link freshGitSentinelPath}) on top,
 * then {@link scrubGitEnv}. Shared with {@link spawnCanonicalGitTree} so its raw spawn sees the
 * IDENTICAL env `canonicalGit` itself would build (see that function's own doc for its `24c0bdba` anchor).
 *
 * ALWAYS returns a materialized object now (never `undefined`): the two sentinels must reach EVERY
 * canonical call, including the common env-less one. Built by spreading whatever `cleanEnv` already
 * resolved to (the caller's own env, or a GIT_CONFIG-stripped copy), defaulting to `{...base}` (i.e.
 * `{...process.env}` for the common no-explicit-env call) when `cleanEnv` is still `undefined`.
 *
 * @decision 356538ef — never shrink this to a bare `{GIT_GRAFT_FILE, GIT_SHALLOW_FILE}` object: simple-git's
 * own `.env(obj)` REPLACES the spawned child's entire environment wholesale (never merges with
 * `process.env`), so a small object here would silently strip PATH/HOME/everything else for every call.
 *
 * @decision 356538ef (card 7ebb4acf, N3) — also strips ambient `GIT_TEST_COMMIT_GRAPH` (same case-aware
 * presence-check-and-strip as `GIT_CONFIG` below): MEASURED to override `-c core.commitGraph=false` and
 * resurrect item 9's forged-graph skew. See that item's own record entry for the measurement.
 *
 * Deliberately does NOT strip {@link GIT_ENV_TRANSPORT_KEYS} here (card `23c74c62`'s Code Review round):
 * the raw-spawn path ({@link spawnCanonicalGitTree}'s own `rawViaDirectSpawn`/`rawViaWinJobLauncher`) is
 * the OTHER consumer of this function, never arms `blockUnsafeOperationsPlugin` (it never touches
 * simple-git at all), and may legitimately need those vars for an IMPLICIT fetch during a canonical
 * mutation (an LFS smudge filter, a partial-clone promisor fetch during `worktree add`/checkout —
 * `CANONICAL_GIT_CONFIG` does not disable filters). {@link canonicalGit} applies its own narrower strip,
 * for the ONE consumer that actually needs it — see its own doc below. `GIT_GRAFT_FILE`/`GIT_SHALLOW_FILE`
 * are NOT in simple-git's own unsafe-env blocklist (verified directly against the installed
 * `@simple-git/argv-parser@1.1.1`'s own env→category map), so adding them needs no new `unsafe:` flag.
 */
export function prepareCanonicalEnv(env?: Record<string, string | undefined>): Record<string, string | undefined> {
  const base = env ?? process.env;
  let cleanEnv = env;
  // Presence check AND strip both go through the ONE case-aware helper (win32: `Git_Config` is `GIT_CONFIG` — card e93703d9); a bare `base.GIT_CONFIG` read would find
  // it on process.env (Node's case-insensitive accessor) while a plain-object `delete` misses it.
  // `GIT_TEST_COMMIT_GRAPH` rides the SAME check (card 7ebb4acf, N3) — see this function's own doc above.
  if (envKeysNamed(base, ["GIT_CONFIG", "GIT_TEST_COMMIT_GRAPH"]).some((k) => base[k] !== undefined)) { cleanEnv = { ...base }; deleteEnvKeys(cleanEnv, ["GIT_CONFIG", "GIT_TEST_COMMIT_GRAPH"]); }
  const withSentinels = { ...(cleanEnv ?? base), GIT_GRAFT_FILE: freshGitSentinelPath("graft"), GIT_SHALLOW_FILE: freshGitSentinelPath("shallow") };
  return scrubGitEnv(withSentinels);
}

/**
 * The canonical merge path does NOT support a shallow-cloned repo — fail closed, loudly, BEFORE any
 * canonical read/mutation. Measured (card 7ebb4acf, B2): with `GIT_SHALLOW_FILE` neutralized (above) a
 * read that must walk past the shallow boundary either errors (`merge-base` exit 255, a `^N`/`..`-range
 * resolution exit 128) or, worse, `git merge --squash` silently reports "nothing to squash" and exits 0
 * with the real content never staged — a SILENT no-op that must never be reachable. Returns a refusal
 * reason string when `repoPath`'s COMMON git dir has a non-empty `shallow` file; `null` otherwise.
 *
 * @decision 356538ef (card 7ebb4acf, item 10 — SF4) — a `resolveGitDirsSync` `null` (a subdir-bound
 * repo, or a `GIT_DIR`-pointed call) must never be read as "not shallow"; it now fails CLOSED via a
 * `rev-parse --git-common-dir` probe instead, or an honest refusal if that probe itself fails.
 */
export async function detectShallowCanonicalRepo(
  repoPath: string,
  timeoutMs: number,
  gitFactory?: (repoPath: string, blockTimeoutMs: number) => Pick<SimpleGit, "raw">,
): Promise<string | null> {
  const dirs = resolveGitDirsSync(repoPath);
  const shallowMessage = (shallowPath: string) =>
    `canonical repo is shallow (${shallowPath} is non-empty) — the canonical merge path does not support a shallow-cloned repository. An AGENT running \`git fetch --depth=N\` inside a worktree writes to this SAME shared \`shallow\` file, so a worktree can leave the canonical repo shallow even when nobody shallow-cloned the canonical checkout itself. Project managers have no canonical-repo git write access — escalate this to the Platform Lead, or ask the owner to run \`git fetch --unshallow\` in ${repoPath} (or re-clone it fully).`;
  if (dirs) {
    const shallowPath = path.join(dirs.commonDir, "shallow");
    let size: number;
    try { size = fs.statSync(shallowPath).size; } catch { return null; }
    return size === 0 ? null : shallowMessage(shallowPath);
  }
  // FAIL CLOSED: `resolveGitDirsSync` could not resolve `repoPath` fs-only (a subdir-bound repo, or a
  // `GIT_DIR` override) — ask git itself, via a call that reads no history.
  //
  // @decision 356538ef (card 7ebb4acf, item 13 — SF2) — the git factory CONSTRUCTION, not just the
  // `.raw()` call, must sit inside this try: simple-git throws SYNCHRONOUSLY for a nonexistent repoPath.
  let commonDirRaw: string;
  try {
    const git = (gitFactory ?? ((p, ms) => canonicalGit(p, ms)))(repoPath, timeoutMs);
    commonDirRaw = (await withTimeout(git.raw(["rev-parse", "--git-common-dir"]), timeoutMs, "git rev-parse --git-common-dir (shallow check)")).trim();
  } catch (e) {
    return `could not determine whether the canonical repo is shallow (resolveGitDirsSync could not resolve ${repoPath} fs-only, and \`git rev-parse --git-common-dir\` failed: ${(e as Error).message}) — refusing to merge rather than risk a silent no-op against an unverifiable repository`;
  }
  const commonDir = path.resolve(repoPath, commonDirRaw);
  const shallowPath = path.join(commonDir, "shallow");
  let size: number;
  try { size = fs.statSync(shallowPath).size; } catch { return null; }
  return size === 0 ? null : shallowMessage(shallowPath);
}

export function canonicalGit(
  repoPath: string,
  blockTimeoutMs: number,
  env?: Record<string, string | undefined>,
  abortSignal?: AbortSignal,
  extraUnsafe?: SimpleGitOptions["unsafe"],
): SimpleGit {
  // @decision 5b50eede (round 4, card `b5416a46`) — no longer resolves its OWN absolute git.exe here;
  // `boundedSimpleGit` below now resolves it itself for every caller, canonicalGit included (never
  // double-resolve by passing an explicit `binary` again here).
  //
  // `allowUnsafeMergeDriver` is required for simple-git to pass OUR `-c merge.<x>.driver=` (a blanking, never a set).
  // `boundedSimpleGit` re-applies `scrubGitEnv` to whatever `prepareCanonicalEnv` already scrubbed — idempotent, kept for its own unconditional-at-construction guarantee (f7a80d76).
  let simpleGitEnv = prepareCanonicalEnv(env);
  // @decision a746a3eb (Follow-up 23c74c62) — strip GIT_ENV_TRANSPORT_KEYS here, ONLY for this real
  // SimpleGit consumer, and gate on "did the caller pass no `env`" alone — never on whether
  // `prepareCanonicalEnv` materialized one (since 356538ef's graft/shallow fix it ALWAYS does).
  if (env === undefined) { simpleGitEnv = { ...simpleGitEnv }; deleteEnvKeys(simpleGitEnv, GIT_ENV_TRANSPORT_KEYS); }
  const git = boundedSimpleGit(repoPath, blockTimeoutMs, simpleGitEnv, abortSignal, { ...extraUnsafe, allowUnsafeMergeDriver: true }, [...CANONICAL_GIT_CONFIG]);
  const raw = async (...callArgs: unknown[]): Promise<string> => {
    const args = (Array.isArray(callArgs[0]) ? callArgs[0] : callArgs) as string[];
    const startedAt = performance.now();
    try {
      return await canonicalRaw(git, args);
    } catch (e) {
      // @decision 62c4953a — no abort-kill machinery on this path; label the honest weaker claim, never
      // an affirmative "timed out" an ordinary same-duration slow failure would read identically to.
      const elapsed = performance.now() - startedAt;
      if (elapsed >= blockTimeoutMs) logCanonicalGitAbnormalOutcome(repoPath, args, elapsed, `slow failure (elapsed ${Math.round(elapsed)}ms >= idle bound ${blockTimeoutMs}ms)`);
      throw e;
    }
  };
  // @decision 5b50eede (round 3, CR `18aac4c9`; unchanged by round 4 follow-up CR `201f0c7e`) — refuse
  // `customBinary(` with canonicalGit's own message. `git` already carries boundedSimpleGit's OWN
  // refusal underneath too (round 4 follow-up); this is canonicalGit-specific messaging layered on top.
  const customBinaryRefused = () => {
    throw new Error("canonicalGit: customBinary() is refused — the canonical path's git binary is resolved once at construction; call canonicalGit(...) again instead of swapping the binary on an existing instance.");
  };
  return new Proxy(git, {
    get(target, prop) {
      if (prop === "raw") return raw;
      if (prop === "customBinary") return customBinaryRefused;
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}
