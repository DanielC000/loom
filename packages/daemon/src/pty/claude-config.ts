import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveGitMainCheckoutRootSync } from "../git/repo-lock.js";
import { normForCompare, containmentForms } from "../git/worktrees.js";
import { WORKTREES_DIR } from "../paths.js";

/**
 * Resolve Claude's main JSON config file. Honors CLAUDE_CONFIG_DIR (Claude relocates the
 * config — incl. the trust flags below — to <CLAUDE_CONFIG_DIR>/.claude.json when it is set),
 * falling back to ~/.claude.json. Read fresh each call so the env can be set per-process
 * (e.g. an isolated config dir for hermetic tests) without re-importing this module.
 */
export function claudeJsonPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir ? path.join(dir, ".claude.json") : path.join(os.homedir(), ".claude.json");
}

// Windows can transiently throw EPERM/EACCES/EBUSY (instead of succeeding, or EEXIST/ENOENT as
// POSIX would) when a create/rename/delete races another process's brief handle on the SAME path —
// an AV/indexer mid-scan, or (for the lock below) a create landing just as another process's
// release-delete of that lockfile is completing. It clears in milliseconds, so both writeJsonAtomic's
// rename retry and withTrustLock's lock-acquire retry treat it as transient and retry it with this
// SAME bounded count + backoff, rather than inventing separate numbers that could drift apart.
const DEFAULT_TRANSIENT_FS_RETRY_LIMIT = 12; // worst case (1,2,4,8,16,32,50,50,…ms backoff) well under 1s
// Ceiling for an env override — withTrustLock's transient-retry branch (below) loops WITHOUT
// re-checking the trustLockMs() deadline, so an unbounded override would block the synchronous spawn
// thread far past LOOM_TRUST_LOCK_MS's own "bounded" contract. 1000 × the ~50ms backoff ceiling is
// ~50s worst case — generous for even extreme contention, while still bounding a typo'd huge value.
const MAX_TRANSIENT_FS_RETRY_LIMIT = 1000;
// Under EXTREME concurrent Windows FS contention (heavy-stress repro: ~1 in ~64 attempts at 12
// concurrent writers), the fixed default budget above can genuinely exhaust and surface an EPERM that
// would have cleared given a bit more time — asymmetric with the lock-acquire timeout below
// (LOOM_TRUST_LOCK_MS), which is already env-overridable. LOOM_TRANSIENT_FS_RETRY_LIMIT mirrors that
// same override pattern (trustLockMs() below) for this budget: read fresh on each call (never cached
// at module load) so a test can flip it per-run, an operator on a heavily-contended host can raise it
// without a code change, and — left unset — retry behavior is BYTE-IDENTICAL to the pre-fix fixed
// constant. Floor BEFORE the positivity check (not after) — a fractional override like "0.5" is
// `> 0` but floors to 0, which would DISABLE retries entirely (writeJsonAtomic throws on the very
// first transient EPERM) instead of falling back to the default.
export function transientFsRetryLimit(): number {
  const n = Number(process.env.LOOM_TRANSIENT_FS_RETRY_LIMIT);
  const floored = Math.floor(n);
  if (!Number.isFinite(n) || floored < 1) return DEFAULT_TRANSIENT_FS_RETRY_LIMIT;
  return Math.min(floored, MAX_TRANSIENT_FS_RETRY_LIMIT);
}
// Exported so a caller outside this module (ensureTrustedResilient's host.ts call site) can classify an
// error the SAME way writeJsonAtomic/withTrustLock already do, instead of re-listing the three codes.
export const isTransientFsError = (code: string): boolean =>
  code === "EPERM" || code === "EACCES" || code === "EBUSY";

/** TEST SEAM: swap the fs.openSync used by withTrustLock's lock-acquire — fs's ESM namespace import
 *  is immutable and can't be monkeypatched directly, mirroring companion/tts.ts's spawnImpl seam. Lets
 *  a hermetic test fault-inject transient EPERM/EACCES/EBUSY on the lock-acquire open, deterministically
 *  exercising the retry-then-degrade branch on every platform (the real race is Windows-only). Defaults
 *  to the real fs.openSync; production code never calls the setter. */
type OpenSyncFn = typeof fs.openSync;
let openSyncImpl: OpenSyncFn = fs.openSync;
export function __setOpenSyncForTest(fn?: OpenSyncFn): void { openSyncImpl = fn ?? fs.openSync; }

/** TEST SEAM: swap the fs.renameSync used by writeJsonAtomic's rename retry — same rationale/shape as
 *  __setOpenSyncForTest above. Lets a hermetic test fault-inject transient EPERM/EACCES/EBUSY on the
 *  rename deterministically. Defaults to the real fs.renameSync; production code never calls the setter. */
type RenameSyncFn = typeof fs.renameSync;
let renameSyncImpl: RenameSyncFn = fs.renameSync;
export function __setRenameSyncForTest(fn?: RenameSyncFn): void { renameSyncImpl = fn ?? fs.renameSync; }

/**
 * Atomically write `value` as pretty JSON to `filePath`: a uniquely-named temp file in the
 * same directory (so two concurrent writers can't collide on it) followed by a rename onto
 * the target. The rename is atomic on a single filesystem, so a crash mid-write can never
 * leave the real (possibly large, concurrently-read) config truncated/corrupt.
 */
export function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.loom.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  // On Windows, rename onto an EXISTING target can transiently throw EPERM/EACCES/EBUSY when another
  // process holds a handle on it — exactly the lock-free fast-path readers of .claude.json during
  // concurrent spawns (ensureTrusted's fast-path readCfg runs OUTSIDE the trust lock by design), or an
  // AV/indexer mid-scan. POSIX rename(2) has no such issue. The handle is released in milliseconds, so
  // retry with a short bounded backoff; rethrow once it persists (a genuine permission error still
  // surfaces), cleaning up the temp file so a terminal failure leaves nothing behind.
  for (let attempt = 0; ; attempt++) {
    try { renameSyncImpl(tmp, filePath); return; }
    catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (attempt >= transientFsRetryLimit() || !isTransientFsError(code)) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort cleanup */ }
        throw err;
      }
      sleepSync(Math.min(50, 2 ** attempt)); // 1,2,4,8,16,32,50,50,… ms — worst case well under 1s
    }
  }
}

type ClaudeCfg = { projects?: Record<string, Record<string, unknown>> };

/** Read+parse the config; a missing/corrupt file is treated as empty (fresh). */
function readCfg(claudeJson: string): ClaudeCfg {
  try { return JSON.parse(fs.readFileSync(claudeJson, "utf8")); } catch { return {}; }
}

// @decision 17237fba — only check `hasTrustDialogAccepted`; `hasCompletedProjectOnboarding` is stripped
// from every project entry by the CLI itself on every save, so requiring it made this fast path dead.
function isTrusted(cfg: ClaudeCfg, key: string): boolean {
  const e = cfg.projects?.[key];
  return e?.hasTrustDialogAccepted === true;
}

/**
 * True iff `key`'s project entry already carries ANY decision for the external-CLAUDE.md-import
 * approval dialog — either an explicit approval (`hasClaudeMdExternalIncludesApproved:true`, a human
 * clicked "Yes, allow external imports") or an explicit decline/acknowledgement
 * (`hasClaudeMdExternalIncludesWarningShown:true`, set on EITHER answer — see ensureTrusted's own doc).
 * `false`/absent on both means genuinely undecided — the shape a fresh worktree is always in, and the
 * ONLY shape ensureTrusted is allowed to write into (see "Never overwrite" there).
 */
function isExternalImportDecided(cfg: ClaudeCfg, key: string): boolean {
  const e = cfg.projects?.[key];
  return e?.hasClaudeMdExternalIncludesApproved === true || e?.hasClaudeMdExternalIncludesWarningShown === true;
}

/** TEST SEAM: swap the git-main-checkout-root resolver claudeCliProjectKey delegates to — same rationale
 *  as the fs seams above. Lets a hermetic test fault-inject a resolver that throws, deterministically
 *  exercising the fallback-to-plain-key branch without needing a real repo layout that naturally fails.
 *  Defaults to the real resolveGitMainCheckoutRootSync; production code never calls the setter. */
type GitMainCheckoutRootResolverFn = (bp: string) => string | null;
let gitMainCheckoutRootResolverImpl: GitMainCheckoutRootResolverFn = resolveGitMainCheckoutRootSync;
export function __setGitMainCheckoutRootResolverForTest(fn?: GitMainCheckoutRootResolverFn): void {
  gitMainCheckoutRootResolverImpl = fn ?? resolveGitMainCheckoutRootSync;
}

/**
 * Resolve the `.claude.json` project key the installed `claude` CLI's OWN per-project lookup
 * (`canonicalRootByRoot`/`yIe()` in its bundle) reads for `dir` — the canonical git root: for a LINKED
 * WORKTREE, the MAIN checkout, never the worktree's own path (see
 * {@link resolveGitMainCheckoutRootSync}); for a non-git `dir`, `dir` itself (the CLI's own `?? cwd`
 * fallback, normalized the same `path.resolve` + forward-slashes way as the plain worktree `key`
 * computed in `ensureTrusted` below, with NO case-folding — matching the CLI's own written entries,
 * which preserve `path.resolve`'s drive-letter casing verbatim for a non-worktree cwd).
 *
 * ⚠️ CASING CAVEAT (e789ef3b review Minor 1, unresolved — card 17237fba): for a GIT `dir`, the value
 * above instead comes from {@link resolveGitMainCheckoutRootSync}'s ancestor walk, which realpaths via
 * `fs.realpathSync.native` — on Windows this CANONICALIZES drive-letter/8.3 casing, unlike the CLI's own
 * equivalent resolution, which is casing-preserving. A `repoPath` stored with non-canonical casing (e.g.
 * `c:\users\...`) can therefore diverge from the key the CLI itself reads, reopening the hang this whole
 * mechanism exists to close. Measured exposure today: nil (0 of 8852 real keys are lowercase on this
 * host) — not fixed here; re-measure before relying on that staying true.
 *
 * Bounded + fail-safe for the spawn hot path: the resolver is a handful of synchronous `fs` calls bounded
 * by directory depth (no subprocess). On ANY error escaping it, this falls back to `dir`'s own plain key
 * — the caller (`ensureTrusted`) must still write the decline under that fallback key rather than skip
 * the protection entirely just because canonical-root resolution failed.
 *
 * @decision 7673d096 — the resolver's own synchronous/no-subprocess/no-cache constraints apply here too.
 *
 * Re-verify this key-resolution mechanism after any `claude` CLI upgrade — it was discovered by static
 * decompilation of an installed bundle, not a published API; see
 * docs/decisions/37310431-loom-home-write-deny.md § "FIXED (card e789ef3b)".
 */
export function claudeCliProjectKey(dir: string): string {
  const plainKey = path.resolve(dir).replace(/\\/g, "/");
  try {
    const root = gitMainCheckoutRootResolverImpl(dir);
    return root ? root.replace(/\\/g, "/") : plainKey;
  } catch {
    return plainKey;
  }
}

/** Pull the mcpServers names out of one .mcp.json (canonical shape `{mcpServers:{<name>:…}}`). */
function readMcpServerNames(mcpJsonPath: string, into: Set<string>): void {
  try {
    const j = JSON.parse(fs.readFileSync(mcpJsonPath, "utf8")) as { mcpServers?: Record<string, unknown> };
    if (j.mcpServers && typeof j.mcpServers === "object") for (const n of Object.keys(j.mcpServers)) into.add(n);
  } catch { /* no/invalid .mcp.json here — best-effort */ }
}

/**
 * Discover the `.mcp.json` MCP-server names the about-to-spawn `claude` would surface a per-project
 * "N new MCP servers found in this project — enable?" prompt for, so we can pre-reject them (below).
 *
 * THE ACTUAL TRIGGER (empirically confirmed against CLI 2.1.172 on 2026-06-11): the CLI walks UP the
 * directory tree from cwd reading every `.mcp.json` it finds. EVERY Loom worktree lives under the home
 * dir (`~/.loom/worktrees/…`), so the walk reaches `~/.mcp.json` — a user-global MCP config (e.g.
 * docker/sentry servers) — and prompts to enable those servers BEFORE SessionStart. This is the
 * docker/sentry prompt host.ts dismisses with Esc; `--strict-mcp-config` does NOT suppress it (the
 * prompt is computed independently of the spawn's --mcp-config). The OLD "not config-suppressible"
 * note was about CLI flags; per-project `~/.claude.json` `disabledMcpjsonServers` DOES suppress it
 * (the CLI's `leH()` reads it → server = "rejected" → not "pending" → never offered).
 *
 * We walk cwd → … → home (inclusive) and STOP at home: that bounds the walk (it never escapes into
 * the wider filesystem) and is exactly the set the CLI inherits for a worktree under home. Over-listing
 * is harmless (a reject-list entry for a server not present is a no-op). Plugin-provided MCP servers, if
 * any ever surface, are NOT covered here by design — the retained Esc fallback in host.ts catches those.
 */
export function discoverProjectMcpServerNames(dir: string): string[] {
  const names = new Set<string>();
  const home = path.resolve(os.homedir());
  let cur = path.resolve(dir);
  // Up-tree walk, bounded at the home dir (inclusive) or the filesystem root, whichever comes first.
  for (;;) {
    readMcpServerNames(path.join(cur, ".mcp.json"), names);
    if (cur === home) break;
    const parent = path.dirname(cur);
    if (parent === cur) break; // filesystem root
    cur = parent;
  }
  // If cwd was NOT under home (the walk stopped at a different root), still cover ~/.mcp.json explicitly.
  readMcpServerNames(path.join(home, ".mcp.json"), names);
  return [...names];
}

/**
 * True iff an unattended boot has NOTHING left pending across the (up to two) project entries
 * `ensureTrusted` writes: `key`'s entry trusted, AND every MCP server in `mcpToDisable` already in
 * `key`'s `disabledMcpjsonServers` (so the enable-prompt has nothing pending), AND `canonicalKey`'s entry
 * already carries SOME decision for the external-import dialog (ours or a human's — see
 * `isExternalImportDecided`). `key` and `canonicalKey` are the SAME string for a non-worktree cwd (see
 * `claudeCliProjectKey`), so this reduces to one entry in the common case; for a linked worktree they
 * differ, and this checks BOTH entries. When `mcpToDisable` is empty the trust/MCP half reduces to just
 * `isTrusted`. A pre-existing entry that was already `isTrusted` before the import flag existed (written
 * by an older Loom build, or a human's own interactive `claude` run) is NOT fully decided until
 * `canonicalKey`'s import flag is also present — this is what makes the fast path actually reach and
 * decline on such an entry's next spawn, instead of treating old trust alone as "nothing to do".
 */
function isFullyDecided(cfg: ClaudeCfg, key: string, canonicalKey: string, mcpToDisable: string[]): boolean {
  if (!isTrusted(cfg, key)) return false;
  if (!isExternalImportDecided(cfg, canonicalKey)) return false;
  if (mcpToDisable.length === 0) return true;
  const disabled = cfg.projects?.[key]?.disabledMcpjsonServers;
  const set = Array.isArray(disabled) ? new Set(disabled as string[]) : new Set<string>();
  return mcpToDisable.every((n) => set.has(n));
}

/** Cross-process lock ACQUIRE DEADLINE (ms): how long THIS caller personally waits before giving up
 *  and degrading. Env-overridable for tests. Card 5b97da80: this used to ALSO serve as the staleness
 *  threshold (see {@link staleLockCeilingMs} for why that was wrong and what replaced it) — the name
 *  and doc were corrected to state only what this constant actually governs now. */
function trustLockMs(): number {
  const n = Number(process.env.LOOM_TRUST_LOCK_MS);
  return Number.isFinite(n) && n > 0 ? n : 5000;
}

/**
 * The HARD CEILING a held lock's age must exceed before {@link shouldBreakLock} breaks it regardless of
 * what the holder-liveness probe says. A backstop, not the normal recovery path (that's a confirmed-dead
 * pid, no age check needed) — set far above any real measured hold (ensureTrusted/the bulk prune topped
 * out at ~271ms at 60,000 synthetic entries), so a genuine still-alive holder is never caught by it. No
 * separate env override: a project needing a bigger ceiling raises `LOOM_TRUST_LOCK_MS`, raising both
 * numbers together.
 *
 * @decision 5b97da80 — never remove this ceiling or make pid-liveness the sole break condition: if the
 * OS reuses a crashed holder's pid for an unrelated live process before anyone checks, that pid reads
 * "alive" forever, and without this backstop the lock wedges permanently — worse than the heuristic it replaces.
 */
function staleLockCeilingMs(): number {
  return Math.max(10 * trustLockMs(), 60_000);
}

/** Synchronous sleep that parks the thread (no busy-spin) — ensureTrusted is sync by contract. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Card 5b97da80: the lock file's own content, written at acquire time so a later waiter can identify
 *  (and liveness-probe) the holder instead of treating the lockfile as an opaque marker. */
function lockHolderContent(): string {
  return JSON.stringify({ pid: process.pid, acquiredAt: Date.now() });
}

/** TEST SEAM: swap the `fs.statSync(path, {bigint:true})` {@link shouldBreakLock} uses to identify a
 *  lock's filesystem INCARNATION (dev+ino), separate from `__setStatSyncForTest` above (that one feeds
 *  `classifyPathLiveness`'s unrelated worktree-liveness checks — conflating the two would make a test
 *  fault-injecting one unintentionally affect the other). Lets a hermetic test simulate a lock being
 *  released and re-created with a DIFFERENT incarnation between two calls — the exact race dev+ino
 *  (not mtime alone) exists to catch (Code Review f82607a6, Minor 1). Defaults to the real bigint
 *  `fs.statSync`; production code never calls the setter. */
type LockStatSyncFn = (p: string) => fs.BigIntStats;
let lockStatSyncImpl: LockStatSyncFn = (p) => fs.statSync(p, { bigint: true });
export function __setLockStatSyncForTest(fn?: LockStatSyncFn): void {
  lockStatSyncImpl = fn ?? ((p) => fs.statSync(p, { bigint: true }));
}

/** TEST SEAM: swap the `fs.readFileSync` {@link readLockHolderContent} uses to read a lock's own
 *  holder-identity content — separate from `__setReadFileSyncForTest` above (that one feeds
 *  `readCfgFailClosed`'s unrelated `.claude.json` read). Lets a hermetic test simulate the lock's
 *  content changing (or staying fixed) between the two reads {@link shouldBreakLock} makes. Defaults
 *  to the real `fs.readFileSync`; production code never calls the setter. */
type LockContentReadFn = (p: string) => string;
let lockContentReadImpl: LockContentReadFn = (p) => fs.readFileSync(p, "utf8");
export function __setLockContentReadForTest(fn?: LockContentReadFn): void {
  lockContentReadImpl = fn ?? ((p) => fs.readFileSync(p, "utf8"));
}

/** A lock file's parsed holder-identity content (card 5b97da80). */
interface LockHolderContent { pid: number; acquiredAt: number }

/** Best-effort parse of a lock file's JSON content (card 5b97da80). Returns `null` for anything that
 *  isn't a well-formed `{pid:number, acquiredAt:number}` object — a lock written by a pre-fix Loom
 *  build (an empty marker file), or any other unreadable/malformed content, is UNKNOWN liveness, never
 *  a confirmed-dead holder (the same "unknown treated like alive, never deleted" conservatism
 *  {@link classifyPathLiveness} already uses elsewhere in this file). */
function readLockHolderContent(lockPath: string): LockHolderContent | null {
  try {
    const parsed = JSON.parse(lockContentReadImpl(lockPath)) as { pid?: unknown; acquiredAt?: unknown };
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
    if (typeof parsed.acquiredAt !== "number") return null;
    return { pid: parsed.pid, acquiredAt: parsed.acquiredAt };
  } catch {
    return null;
  }
}

/**
 * Card 5b97da80: a synchronous, cross-platform liveness probe for a lock's recorded holder pid.
 * `process.kill(pid, 0)` sends no signal; it only probes existence, and works synchronously on both
 * POSIX and win32 (verified against a real win32 host: a live pid never throws, pid 999999 throws
 * ESRCH). `ESRCH` unambiguously means the pid no longer exists — confirmed dead. `EPERM` means the pid
 * EXISTS but we lack permission to signal it — still alive (e.g. pid 4 "System" on win32, or pid 1
 * "init" on POSIX as a non-root caller — see `packages/daemon/test/trust-lock-incarnation-guard.mjs`'s
 * pinned EPERM coverage, Code Review f82607a6 Minor 2). Anything else (including no error at all, i.e.
 * a live pid) is NOT treated as dead — same "unknown == alive" conservatism as `classifyPathLiveness`.
 */
function isPidConfirmedDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * Should a HELD lock (one we just failed to acquire with EEXIST) be broken? `stat` must be the
 * caller's own fresh {@link lockStatSyncImpl} bigint stat of that same lock, taken right before this
 * call. Two independent break conditions, either is sufficient: (1) the recorded holder pid is
 * confirmed dead ({@link isPidConfirmedDead}) — detected on the FIRST poll, not only after the lock
 * ages past some threshold; (2) the lock is older than {@link staleLockCeilingMs} — a hard backstop
 * against OS pid reuse making condition (1) falsely read "alive" forever. A lock with no parseable
 * holder content can only ever be broken via condition (2).
 */
export function shouldBreakLock(lockPath: string, stat: fs.BigIntStats): boolean {
  const age = Date.now() - Number(stat.mtimeMs);
  if (age > staleLockCeilingMs()) return true;
  const content = readLockHolderContent(lockPath);
  if (content === null || !isPidConfirmedDead(content.pid)) return false;
  // @decision 5b97da80 — never trust a dead-pid verdict without re-verifying the SAME lock incarnation:
  // mtime equality alone does NOT prove it (measured 1064/2000 identical-mtime collisions across
  // distinct dev+ino on a real NTFS host). Require dev+ino equality AND byte-identical re-read content.
  let reStat: fs.BigIntStats;
  try { reStat = lockStatSyncImpl(lockPath); } catch { return false; /* vanished under us */ }
  if (reStat.dev !== stat.dev || reStat.ino !== stat.ino) return false;
  const reContent = readLockHolderContent(lockPath);
  return reContent !== null && reContent.pid === content.pid && reContent.acquiredAt === content.acquiredAt;
}

/** Open `lockPath` exclusively and write the holder-identity content into it (card 5b97da80). On
 *  failure the error `code` rides the return (never swallowed) so a caller can classify it — e.g.
 *  `withTrustLock`'s loop distinguishes a transient Windows error from a genuine `EEXIST` — without a
 *  second, redundant (and racy: the lock's state could change between two separate open attempts)
 *  `openSync` call just to recover the code attemptCreateLock already saw. A content-write failure
 *  AFTER a successful create is swallowed — best-effort diagnostics, never a reason to report the lock
 *  as not-held when the exclusive create itself already succeeded. */
function attemptCreateLock(lockPath: string): { ok: true } | { ok: false; code: string } {
  let fd: number;
  try { fd = openSyncImpl(lockPath, "wx"); }
  catch (err) { return { ok: false, code: (err as NodeJS.ErrnoException).code ?? "" }; }
  try { fs.writeSync(fd, lockHolderContent()); } catch { /* best-effort — we still hold the lock */ }
  try { fs.closeSync(fd); } catch { /* already gone */ }
  return { ok: true };
}

/**
 * Run `fn` under a best-effort cross-process advisory lock at `lockPath`. The lock is an
 * O_EXCL lockfile (`fs.openSync(..., "wx")`) — atomic across processes (parallel spawns,
 * multiple Loom daemons) on a single host.
 *
 * BOUNDED + NEVER-DEADLOCK + NEVER-NEWLY-FATAL (load-bearing — this is on the spawn path):
 * - Acquire with a short retry loop up to `trustLockMs()`.
 * - If the lock looks abandoned ({@link shouldBreakLock} — a confirmed-dead holder, or the hard
 *   ceiling), break it and retry.
 * - If we still can't acquire within the timeout, proceed best-effort WITHOUT the lock (warn).
 *   Worst case degrades to exactly the pre-lock behavior (a possible clobber) — never a hang.
 * - A transient Windows EPERM/EACCES/EBUSY on the acquire `open` (see transientFsRetryLimit()
 *   above writeJsonAtomic) is retried, bounded, THEN degrades to the same best-effort fallback —
 *   never treated as an immediate lock-abandon (that used to let a real writer through unlocked;
 *   see the acquire loop below).
 * - `fn` ALWAYS runs, and the lock (if held) is ALWAYS released in `finally`. We never throw a
 *   new error that would abort the spawn.
 *
 * Why the synchronous sleepSync wait is acceptable on the spawn hot path (NOT the markitdown
 * blocking-the-event-loop class): the caller (ensureTrusted → host.ts createPty) is fully
 * synchronous and JS is single-threaded, so two IN-PROCESS spawns can never interleave — each
 * acquire+`fn`+release completes within one synchronous call stack before the event loop starts the
 * next spawn. The lock is therefore NEVER contended by this daemon's own (even fan-out) spawns, so
 * the sleepSync retry loop is unreachable in-process; it fires ONLY when another PROCESS holds the
 * lock (a second Loom daemon sharing ~/.claude.json, OR the standalone bulk-prune script — the
 * cross-process clobber this lock exists to prevent), and there it is bounded by trustLockMs() and
 * degrades best-effort rather than hanging.
 * @decision 5b97da80 — do not convert this to an async wait: createPty's own synchronous contract (the
 * trust write MUST land before the pty spawns) requires this call chain to stay fully synchronous.
 *
 * `opts.requireLock` (card 498452c0 review item 3): when set, a caller that cannot tolerate the
 * best-effort unlocked degrade — a BULK write that deletes many entries at once, where writing unlocked
 * risks clobbering a concurrent writer's own in-flight change — gets `fn` SKIPPED (never called) once
 * the acquire loop above gives up, instead of the ordinary best-effort "run unlocked anyway". The
 * return's `held` reports whether the lock was actually held when (and only when) `fn` ran; `reason` is
 * set (card 5b97da80) whenever `held` is false, naming why — a caller that doesn't pass `requireLock`
 * can ignore both; `fn` always runs exactly as before, byte-identical to the pre-498452c0-round-2
 * behaviour (`ensureTrusted`'s own call is unchanged by this addition beyond now reading `reason`).
 */
/** Card 5b97da80, Code Review f82607a6 Minor 4: per-process memo of lock INCARNATIONS (dev+ino) already
 *  waited out to the acquire deadline at least once. Without this, a stuck-but-alive (or unparseable,
 *  or pid-reused) lock makes EVERY non-fast-path `ensureTrusted` call sleepSync the FULL `trustLockMs()`
 *  again — up to ~12 whole-daemon event-loop freezes in a spawn burst, where pre-fix only the FIRST
 *  spawn ever paid that cost. A later call against the SAME incarnation degrades immediately instead of
 *  re-waiting; a genuinely DIFFERENT incarnation (the holder actually changed) gets its own fresh wait.
 *  Bounded defensively against unbounded growth over a long daemon lifetime (in practice there is only
 *  ever one real `.claude.json` lock path and realistically few distinct stuck incarnations ever seen). */
const knownStuckIncarnations = new Set<string>();
const MAX_KNOWN_STUCK_INCARNATIONS = 1000;
function incarnationKey(lockPath: string, dev: bigint, ino: bigint): string { return `${lockPath}:${dev}:${ino}`; }
/** TEST SEAM: reset the module-level memo above between hermetic test scenarios in the SAME process. */
export function __clearKnownStuckIncarnationsForTest(): void { knownStuckIncarnations.clear(); }

function withTrustLock(lockPath: string, fn: () => void, opts?: { requireLock?: boolean }): { held: boolean; reason?: string } {
  const timeout = trustLockMs();
  const deadline = Date.now() + timeout;
  let held = false;
  let transientAttempt = 0;
  let degradeReason: string | undefined;
  try { fs.mkdirSync(path.dirname(lockPath), { recursive: true }); } catch { /* best-effort */ }
  while (true) {
    const attempt = attemptCreateLock(lockPath);
    if (attempt.ok) { held = true; break; }
    const code = attempt.code;
    if (isTransientFsError(code)) {
      // Windows can throw EPERM/EACCES/EBUSY here instead of EEXIST when our create races another
      // process's release (rmSync) of this SAME lockfile — reproduced with 12 concurrent writers and
      // ZERO ambient processes involved, i.e. a real bug, not ambient load. Treating it as a permanent
      // "odd FS error" used to break out lock-FREE and run the read-modify-write below unlocked — a
      // genuine clobber. Retry it bounded (same limit/backoff as writeJsonAtomic's rename retry);
      // only once that budget is exhausted does it fall through to the pre-existing best-effort
      // (lock-free) degrade below.
      if (transientAttempt < transientFsRetryLimit()) {
        sleepSync(Math.min(50, 2 ** transientAttempt));
        transientAttempt++;
        continue;
      }
    }
    if (code !== "EEXIST") {
      degradeReason = `trust lock ${lockPath} acquire failed with an unexpected error (${code || "unknown"}) — proceeding best-effort (possible clobber)`;
      break; // genuinely unexpected (or exhausted-transient) error → best-effort
    }
    // Lock is held by someone else. Break it only if it looks abandoned (card 5b97da80 — see
    // shouldBreakLock's own doc: a confirmed-dead holder, or the hard ceiling).
    let lockStat: fs.BigIntStats;
    try { lockStat = lockStatSyncImpl(lockPath); }
    catch { continue; /* lock vanished between open and stat → retry immediately */ }
    if (shouldBreakLock(lockPath, lockStat)) { try { fs.rmSync(lockPath); } catch { /* lost the race */ } continue; }
    const key = incarnationKey(lockPath, lockStat.dev, lockStat.ino);
    if (knownStuckIncarnations.has(key)) {
      // Card 5b97da80 Minor 4: this EXACT incarnation already cost a full wait once this process —
      // degrade immediately rather than paying another whole-daemon sleepSync(trustLockMs()) freeze.
      degradeReason = `trust lock ${lockPath} is a previously-observed stuck incarnation (dev=${lockStat.dev} ino=${lockStat.ino}) — degrading immediately without re-waiting`;
      console.warn(`[claude-config] ${degradeReason}`);
      break;
    }
    if (Date.now() >= deadline) {
      degradeReason = `trust lock ${lockPath} busy after ${timeout}ms — ${
        opts?.requireLock ? "requireLock set, SKIPPING the write" : "proceeding best-effort (possible clobber)"
      }`;
      console.warn(`[claude-config] ${degradeReason}`);
      if (knownStuckIncarnations.size >= MAX_KNOWN_STUCK_INCARNATIONS) knownStuckIncarnations.clear();
      knownStuckIncarnations.add(key);
      break;
    }
    sleepSync(50);
  }
  if (!held && opts?.requireLock) return { held: false, reason: degradeReason }; // caller must perform NO write when the lock couldn't be acquired
  try {
    fn();
  } finally {
    if (held) {
      try { fs.rmSync(lockPath); } catch { /* already gone */ }
    }
  }
  return { held, reason: held ? undefined : degradeReason };
}

/**
 * Non-blocking variant of the acquire step above, for a caller that must never sleep or loop (card
 * 498452c0 review item 1b: the per-worktree GC removal hot path). Makes a `wx` create attempt and
 * returns immediately: `true` (and the lock is HELD — the caller owns releasing it via
 * {@link releaseTrustLockOnce}) on success; `false` for ANY failure that doesn't recover. `false` means
 * "skip entirely for now", never "proceed unlocked" — unlike {@link withTrustLock}'s own best-effort
 * degrade, a caller of this function must do nothing when it returns false.
 *
 * @decision 5b97da80 — ONE bounded extra attempt (never a sleep, never a loop) when the first attempt's
 * failure is a held lock that {@link shouldBreakLock} judges abandoned (confirmed-dead holder, or past
 * the hard ceiling). Before this, a crashed holder's lockfile disabled every GC removal forever, with
 * recovery depending entirely on an UNRELATED `withTrustLock` caller's own stale-break happening to clear
 * it as a side effect. This still honors the "never sleep or retry" contract: it is a single additional
 * synchronous attempt, not a retry loop.
 */
function tryTrustLockOnce(lockPath: string): boolean {
  try { fs.mkdirSync(path.dirname(lockPath), { recursive: true }); } catch { /* best-effort */ }
  if (attemptCreateLock(lockPath).ok) return true;
  let lockStat: fs.BigIntStats;
  try { lockStat = lockStatSyncImpl(lockPath); } catch { return attemptCreateLock(lockPath).ok; /* vanished → one more try */ }
  if (!shouldBreakLock(lockPath, lockStat)) return false;
  try { fs.rmSync(lockPath); } catch { return false; /* lost the race */ }
  return attemptCreateLock(lockPath).ok;
}

/** Release a lock acquired via {@link tryTrustLockOnce}. Best-effort — never throws. */
function releaseTrustLockOnce(lockPath: string): void {
  try { fs.rmSync(lockPath); } catch { /* already gone */ }
}

/** {@link ensureTrusted}'s result (card 5b97da80). `locked:true` means either no write was needed (the
 *  fast path) or the write ran under the lock — nothing could have raced. `locked:false` means
 *  ensureTrusted degraded to writing WITHOUT the lock after its acquire attempt gave up (see
 *  `withTrustLock`'s own doc) — the write still happened (ensureTrusted never refuses: the trust write
 *  must land before the pty spawns), but it ran unlocked and carries a possible-clobber risk; `reason`
 *  (always present when `locked` is false) is the human-readable cause, the same text `withTrustLock`
 *  already logs via `console.warn`. A caller that wants this degrade to be durably OBSERVABLE (rather
 *  than just a transient log line) records it itself — see `pty/host.ts`'s `createPty` for the one real
 *  caller that does. */
export interface EnsureTrustedResult {
  locked: boolean;
  reason?: string;
}

/**
 * Pre-clear the things that block an unattended spawned `claude` from reaching SessionStart:
 *
 *  1. The workspace-trust dialog ("Is this a project you trust?") — the CLI's own trust writer, on
 *     clicking "Yes, I trust this folder", persists ONLY `hasTrustDialogAccepted:true` (per `isTrusted`'s
 *     own card-17237fba doc above — `hasCompletedProjectOnboarding` is stripped from every project entry
 *     on every CLI save, so it's never a real persisted signal). Loom's own write below still sets BOTH
 *     flags unconditionally (the second is inert but harmless, and several tests assert its presence
 *     post-write — card `6f52c3f5`), persisted into .claude.json under projects[<abs path, forward
 *     slashes>] — `key` below, the plain cwd-resolved path. Unchanged keying (card 17237fba owns
 *     revisiting this; out of scope here).
 *  2. The per-project "N new MCP servers found in this project — enable?" prompt. The CLI walks UP
 *     the tree from cwd reading every `.mcp.json`; since worktrees live under home it reaches
 *     `~/.mcp.json` and prompts for those servers (docker/sentry on this host). We discover those
 *     names (discoverProjectMcpServerNames) and pre-write them to `disabledMcpjsonServers` (plus an
 *     empty `enabledMcpjsonServers` and `enableAllProjectMcpServers:false`) so the CLI treats every
 *     one as already "rejected" → nothing pending → the prompt never appears. This REPLACES the
 *     fragile fire-and-forget Esc dismissal as the primary fix (host.ts keeps the Esc handler as a
 *     belt-and-suspenders fallback for anything not pre-decided here). Validated empirically against
 *     CLI 2.1.172 on 2026-06-11: a real spawn with these keys never surfaces the prompt. Also keyed at
 *     `key` — unchanged.
 *  3. The external-CLAUDE.md-import approval dialog ("Allow external CLAUDE.md file imports?") — a
 *     project CLAUDE.md/.claude/rules `@import` resolving outside cwd hangs an unattended spawn on
 *     this dialog indefinitely, before SessionStart ever fires. We DECLINE it — but keyed at
 *     `canonicalKey` (`claudeCliProjectKey(dir)`), NOT `key`: the CLI reads this dialog's decision from
 *     the canonical git root (for a linked worktree, the MAIN checkout), so a decline written under the
 *     worktree's own path never reaches a real spawn there. `key` and `canonicalKey` are the same
 *     string for a non-worktree cwd (see claudeCliProjectKey), so this degenerates to one shared entry
 *     in that common case.
 *
 *     @decision 37310431 — only write the decline into a GENUINELY UNDECIDED `canonicalKey` entry; never
 *     overwrite an existing human decision there. Owner ruling (request f8c268c9, option A): decline at
 *     the canonical-repo level when undecided — see the decision record for the accepted tradeoff.
 *
 * Idempotent: a no-op once `key`'s entry is trusted (+ every discovered MCP server already disabled)
 * AND `canonicalKey`'s entry already carries SOME decision for the external-import dialog (ours or a
 * human's) — see `isFullyDecided`. The read-modify-write of the (large, possibly concurrently-used)
 * .claude.json happens at most once per `ensureTrusted` CALL, touching up to TWO distinct project
 * entries in that one write when `key` and `canonicalKey` differ (a linked worktree's own key for
 * trust/MCP, the main checkout's canonical key for the import decision). When no `.mcp.json` servers
 * are discoverable, the written entry omits the MCP keys exactly as before this dialog existed.
 *
 * Concurrency: writeJsonAtomic (temp+rename) prevents *corruption*, but two concurrent calls could
 * each read state S and each write S+theirs, last-writer-wins clobbering the other's entry. So the
 * read-modify-write runs under a cross-process advisory lock (see withTrustLock), with a RE-READ
 * inside the lock. The already-decided fast-path stays OUTSIDE the lock, so the hot/common case is
 * lock-free. We also MERGE (union) into any existing `disabledMcpjsonServers` rather than clobber it.
 *
 * Residual limitation (OUT of scope — by design unsolvable here): this only serializes Loom against
 * Loom. An external `claude` process writing .claude.json honors no Loom lock, so a Loom-vs-external
 * clobber is still possible; we can't lock an uncooperative external writer.
 */
export function ensureTrusted(dir: string): EnsureTrustedResult {
  const claudeJson = claudeJsonPath();
  const key = path.resolve(dir).replace(/\\/g, "/");
  // The CLI's OWN read key for the external-import dialog (canonical git root — the main checkout for a
  // linked worktree). Computed unconditionally so a resolver failure degrades to `key` itself (same
  // value as the plain non-git fallback) rather than skipping the decline write below. See claudeCliProjectKey.
  const canonicalKey = claudeCliProjectKey(dir);
  const mcpToDisable = discoverProjectMcpServerNames(dir); // [] when none → trust-only, pre-fix behavior

  // Fast-path, lock-free: already trusted, the import dialog already decided, AND every discovered MCP
  // server pre-rejected → no-op (common). Nothing was written, so there's nothing that could have raced.
  if (isFullyDecided(readCfg(claudeJson), key, canonicalKey, mcpToDisable)) return { locked: true };

  // A write is needed — serialize it. RE-READ inside the lock: another writer may have changed
  // (or already decided) the config since the fast-path read above.
  const { held, reason } = withTrustLock(`${claudeJson}.loom-lock`, () => {
    const cfg = readCfg(claudeJson);
    if (isFullyDecided(cfg, key, canonicalKey, mcpToDisable)) return;
    cfg.projects ??= {};

    // Trust + per-project MCP prompt, keyed at `key` (unchanged keying — card 17237fba owns revisiting it).
    const entry = cfg.projects[key] ?? {};
    const merged: Record<string, unknown> = {
      ...entry,
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
    };
    if (mcpToDisable.length > 0) {
      const existing = Array.isArray(entry.disabledMcpjsonServers) ? (entry.disabledMcpjsonServers as string[]) : [];
      merged.disabledMcpjsonServers = [...new Set([...existing, ...mcpToDisable])];
      // Preserve any prior explicit enable list; default to empty so the entry reads as fully decided.
      merged.enabledMcpjsonServers = Array.isArray(entry.enabledMcpjsonServers) ? entry.enabledMcpjsonServers : [];
      merged.enableAllProjectMcpServers = false;
    }
    cfg.projects[key] = merged;

    // External-import decline, keyed at `canonicalKey` — the CLI's OWN read key for this dialog, which
    // may be a DIFFERENT project entry than `key` above (a linked worktree's canonical root is its main
    // checkout). Re-read AFTER the write above: when canonicalKey === key this picks up `merged` itself,
    // so the two halves land in ONE entry rather than one clobbering the other. Only write into a
    // GENUINELY UNDECIDED entry — never overwrite a human's own prior decision (an explicit approval, or
    // an existing decline/acknowledgement). See isExternalImportDecided.
    if (!isExternalImportDecided(cfg, canonicalKey)) {
      const canonicalEntry = cfg.projects[canonicalKey] ?? {};
      cfg.projects[canonicalKey] = {
        ...canonicalEntry,
        hasClaudeMdExternalIncludesApproved: false,
        hasClaudeMdExternalIncludesWarningShown: true,
      };
    }

    writeJsonAtomic(claudeJson, cfg);
  });
  return { locked: held, reason };
}

// Card f024f21b: the gap between an exhausted whole `ensureTrusted()` attempt and the single outer retry
// below — short + jittered to give an EXTERNAL holder of ~/.claude.json (a live `claude` CLI process
// reading/writing its own config, or an AV/indexer mid-scan) a little more time to release the file.
// createPty's own comment establishes that two IN-PROCESS spawns can never interleave (fully synchronous,
// single-threaded), so the contender this retry is buying time against is never a sibling spawn on this
// daemon — it's always something outside this process. The jitter only matters ACROSS processes (several
// Loom daemons, or several unattended spawns each hitting their own exhausted budget around the same
// moment) so their retries don't all land back on the same busy instant; it does nothing for a single
// spawn racing itself. NOT the per-rename/lock-acquire backoff above (transientFsRetryLimit() stays
// exactly as card 53e64114 decided) — this is a coarser, one-shot courtesy retry on top of it.
const ENSURE_TRUSTED_RETRY_MIN_MS = 150;
const ENSURE_TRUSTED_RETRY_MAX_MS = 400;

/**
 * Spawn-hot-path wrapper around `ensureTrusted`: on a persistent transient Windows FS error — i.e.
 * `ensureTrusted`'s OWN internal retry budget (`transientFsRetryLimit()`) already exhausted, whether from
 * `writeJsonAtomic`'s rename or `withTrustLock`'s lock-acquire — retry the WHOLE call exactly ONCE, after
 * a short jittered delay (see constants above). The delay is bought against an EXTERNAL holder of
 * ~/.claude.json — a live `claude` CLI session reading/writing its own config, or an AV/indexer — never a
 * sibling in-process spawn (createPty's own comment covers why those can never interleave). A
 * non-transient error (anything `isTransientFsError` doesn't classify) is NEVER retried — it propagates
 * on the first attempt exactly as calling `ensureTrusted` directly would. A second exhausted attempt is
 * NOT swallowed either — its failure rethrows, so a genuinely-persistent EPERM still fails the spawn
 * exactly as it does today; this only buys one extra chance for that external race to clear. The common
 * (no-contention, first-attempt-succeeds) path is byte-identical to calling `ensureTrusted` alone: no
 * sleep, no log line.
 *
 * The sleep (`sleepSync`, same helper `withTrustLock` already uses) is SYNCHRONOUS and blocks the event
 * loop for up to `ENSURE_TRUSTED_RETRY_MAX_MS` — same posture as `writeJsonAtomic`'s own rename backoff:
 * only reachable on the already-rare failure path (the exhausted-budget case), never on an ordinary
 * uncontended spawn, so it's an acceptable one-time stall there, not a change to the common-path cost.
 *
 * @decision f024f21b — never widen transientFsRetryLimit()/the per-rename backoff to "fix" this; that was
 * already decided against on 53e64114. This is strictly a second whole-call attempt on top of it.
 */
export function ensureTrustedResilient(dir: string): EnsureTrustedResult {
  try {
    return ensureTrusted(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    if (!isTransientFsError(code)) throw err;
    const jitterMs = ENSURE_TRUSTED_RETRY_MIN_MS + Math.random() * (ENSURE_TRUSTED_RETRY_MAX_MS - ENSURE_TRUSTED_RETRY_MIN_MS);
    sleepSync(jitterMs);
    try {
      const result = ensureTrusted(dir);
      console.warn(`[claude-config] ensureTrusted: transient ${code} exhausted its retry budget — whole-call retry succeeded`);
      return result;
    } catch (err2) {
      const code2 = (err2 as NodeJS.ErrnoException).code ?? "";
      console.warn(`[claude-config] ensureTrusted: transient ${code} exhausted its retry budget — whole-call retry also failed (${code2 || "?"}) — giving up`);
      throw err2;
    }
  }
}

// --- Card 498452c0: prune .claude.json entries for Loom worktrees that no longer exist. -----------------
//
// Only the PLAIN per-worktree key ensureTrusted writes (see `key` above) is ever a prune candidate. The
// `canonicalKey` entry (claudeCliProjectKey — the project's MAIN CHECKOUT root) is shared across every
// worktree of a project and is structurally outside WORKTREES_DIR (worktrees are always a sibling of
// LOOM_HOME, never nested inside it — see docs/decisions/e1c6ef65-worktrees-dir-lives-outside-loom-home-sibling-not-nested.md),
// so it can never be classified as worktree-scoped by pathOverlapKind(WORKTREES_DIR, key) below; it is
// excluded by construction, not by a special case here.
//
// ⛔ Owner-facing file (card 498452c0 / request e44d319e): never read, write, or count the REAL
// ~/.claude.json from a test. Every test exercising these two functions must redirect CLAUDE_CONFIG_DIR
// (claudeJsonPath() honors it) and, for pruneDeadWorktreeClaudeConfigEntries, pass its own worktreesRoot
// override — never rely on the real WORKTREES_DIR.

/** TEST SEAM: swap the fs.readFileSync used by readCfgFailClosed — same rationale/shape as
 *  __setOpenSyncForTest/__setRenameSyncForTest above. Lets a hermetic test deterministically simulate the
 *  file changing BETWEEN pruneDeadWorktreeClaudeConfigEntries's classification read and its fresh in-lock
 *  read (e.g. to exercise the count-drop sanity guard) by returning different content on successive
 *  calls — there is no real await point between those two reads to inject a mutation at from outside.
 *  Defaults to the real fs.readFileSync; production code never calls the setter. */
type ReadFileSyncFn = typeof fs.readFileSync;
let readFileSyncImpl: ReadFileSyncFn = fs.readFileSync;
export function __setReadFileSyncForTest(fn?: ReadFileSyncFn): void { readFileSyncImpl = fn ?? fs.readFileSync; }

/** TEST SEAM: swap the fs.statSync used by {@link classifyPathLiveness} — same rationale/shape as the
 *  other seams above. Lets a hermetic test fault-inject an EACCES/EPERM-shaped (non-ENOENT/ENOTDIR)
 *  stat error on a specific path, deterministically exercising the "unknown, never deleted" branch
 *  (card 498452c0 review item 2) without needing a real permission-denied directory on disk. Defaults
 *  to the real fs.statSync; production code never calls the setter. */
type StatSyncFn = typeof fs.statSync;
let statSyncImpl: StatSyncFn = fs.statSync;
export function __setStatSyncForTest(fn?: StatSyncFn): void { statSyncImpl = fn ?? fs.statSync; }

/**
 * Tri-state existence check for a path that may be about to be DELETED from `.claude.json` because it
 * looks dead. `fs.existsSync` collapses EVERY stat error (ENOENT, EACCES, a transient Windows glitch, a
 * permission change, …) to the SAME `false` — indistinguishable from a genuine absence. Card 498452c0
 * review item 2, repro'd: a non-existent drive root (`fs.existsSync` throwing/returning false for a
 * reason that has nothing to do with the path being gone) caused EVERY key to be classified dead.
 *
 * `"dead"` only for the two codes that unambiguously mean "this path, or a parent segment of it, does
 * not exist" (`ENOENT`/`ENOTDIR`) — never any other error. `"alive"` when the stat succeeds. `"unknown"`
 * for anything else (`EACCES`/`EPERM`/a transient FS error/…) — a caller must treat `"unknown"` exactly
 * like `"alive"` for deletion purposes (never delete), while still being able to report it distinctly as
 * `unknownKeys` for a human to investigate, rather than silently lumping it in with the confirmed-live set.
 */
function classifyPathLiveness(p: string): "dead" | "alive" | "unknown" {
  try {
    statSyncImpl(p);
    return "alive";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "dead" : "unknown";
  }
}

/** Read+parse `.claude.json` WITHOUT readCfg's fail-OPEN-to-`{}` fallback. readCfg's fallback is safe for
 *  ensureTrusted (which only ever adds ONE new entry on top of whatever it read), but both functions below
 *  can DELETE many existing entries in one write — reading a corrupt/unreadable file as `{}` and writing
 *  that back would silently destroy every other project entry in the real file. A genuinely MISSING file
 *  is reported as `{cfg:{}}` (nothing to prune, not an error — same posture readCfg already has for that
 *  one case); any other read/parse failure returns `{error}` so every caller aborts with no write. */
function readCfgFailClosed(claudeJson: string): { cfg: ClaudeCfg } | { error: string } {
  let raw: string;
  try {
    raw = readFileSyncImpl(claudeJson, "utf8") as string;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { cfg: {} };
    return { error: `could not read ${claudeJson}: ${(err as Error).message}` };
  }
  try {
    return { cfg: JSON.parse(raw) as ClaudeCfg };
  } catch (err) {
    return { error: `could not parse ${claudeJson}: ${(err as Error).message}` };
  }
}

/**
 * Remove `worktreePath`'s own `.claude.json` entry — the plain worktree-path key `ensureTrusted` writes
 * trust/MCP flags under, never `canonicalKey` (see the file header above). Called from the ONE worktree
 * removal chokepoint (`SessionService.gcWorktreeDir` — see
 * docs/decisions/dea6728e-gcworktreedir-retries-safely-and-gives-up-past-a-bound.md) once the directory
 * has ACTUALLY been removed — the entry is now dead weight the CLI's trust-check ancestor walk can never
 * reach again (it only ever walks a LIVE directory).
 *
 * @decision 498452c0 — never move this function's read+match+write back onto `gcWorktreeDir`'s
 * synchronous call stack, and never reintroduce `pathOverlapKind`/`realpathSync` on the stored-key scan
 * here: both together measured ~1.8s of frozen daemon per removal against a real ~9.6k-entry file.
 *
 * Re-verifies the directory is still absent (via {@link classifyPathLiveness} — review item 2: a
 * can't-stat path is treated as "alive, don't touch", never as dead) immediately before deleting, so a
 * respawn that reclaimed this exact path since `gcWorktreeDir`'s removal — now a wider window than before,
 * since this body runs on a later event-loop turn — is never undone. Best-effort, fire-and-forget: any
 * error is caught and logged, never thrown — same posture as every other side effect fired from
 * `gcWorktreeDir`'s own `removed` branch; must never fail or (now) ever reach back into its caller at all.
 * Fails closed on a malformed/unreadable config (see `readCfgFailClosed`): skip, log, no write — never
 * risk the real file on a corrupt read.
 */
export function removeClaudeConfigEntryForWorktree(worktreePath: string): void {
  // Card f761fdf3 item 6a: defense in depth — a non-absolute/empty worktreePath would otherwise
  // path.resolve("") to the daemon's own cwd and risk a normForCompare match against an unrelated
  // project entry. The one real caller (gcWorktreeDir) always passes a genuine absolute worktree path;
  // this is a backstop against that guarantee ever slipping, not a path reachable today.
  if (worktreePath === "" || !path.isAbsolute(worktreePath)) {
    console.warn(`[claude-config] removeClaudeConfigEntryForWorktree: refusing a non-absolute/empty worktreePath (${JSON.stringify(worktreePath)})`);
    return;
  }
  // Item 1(3): defer the whole body off gcWorktreeDir's synchronous call stack. Nothing below this line
  // runs before this function returns.
  setImmediate(() => {
    try {
      const claudeJson = claudeJsonPath();
      const lockPath = `${claudeJson}.loom-lock`;
      if (!tryTrustLockOnce(lockPath)) {
        // Card f761fdf3 item 2: this used to skip SILENTLY. "caught by a later GC" was false — a later
        // GC removal only ever matches its OWN worktree's path, never a previously-skipped one. Card
        // 5b97da80: tryTrustLockOnce now DOES recover from a crashed holder (a confirmed-dead pid, or a
        // lock past the hard age ceiling) via its own bounded extra attempt — a `false` here means the
        // lock is held by a CONFIRMED-ALIVE holder (correctly left alone), not merely "stale". Recovery
        // for the alive-holder case is still the owner-run bulk prune
        // (pruneDeadWorktreeClaudeConfigEntries / scripts/prune-claude-config-worktree-entries.mjs), not
        // a later GC.
        console.warn(`[claude-config] trust lock busy — skipped pruning entry for removed worktree ${worktreePath}; recovery is the owner-run bulk prune, not a later GC (a later GC only matches its own worktree's path)`);
        return;
      }
      try {
        // respawned/reclaimed since, or can't tell — never touch a live-or-unverifiable entry
        if (classifyPathLiveness(worktreePath) !== "dead") return;
        const read = readCfgFailClosed(claudeJson);
        if ("error" in read) {
          console.warn(`[claude-config] skipped pruning entry for removed worktree ${worktreePath} — ${read.error}`);
          return;
        }
        const cfg = read.cfg;
        if (!cfg.projects) return;
        const target = normForCompare(worktreePath);
        let matched = false;
        for (const key of Object.keys(cfg.projects)) {
          // Item 1(2): plain string compare only — NO realpath on stored keys.
          if (normForCompare(key) === target) {
            delete cfg.projects[key];
            matched = true;
          }
        }
        if (matched) writeJsonAtomic(claudeJson, cfg);
      } finally {
        releaseTrustLockOnce(lockPath);
      }
    } catch (err) {
      console.warn(`[claude-config] failed to prune .claude.json entry for removed worktree ${worktreePath}: ${(err as Error).message}`);
    }
  });
}

/** Diagnostic sample cap on {@link PruneDeadWorktreeEntriesResult}'s `deadKeysSample` — `deadCount` is
 *  always the exact count; the sample exists only so a human reading the dry-run output can eyeball a few
 *  real paths, never as the authoritative total. */
const DEAD_KEY_SAMPLE_CAP = 50;

/** {@link pruneDeadWorktreeClaudeConfigEntries}'s result. */
export interface PruneDeadWorktreeEntriesResult {
  dryRun: boolean;
  /** Exact count of entries classified as worktree-scoped (strictly under `worktreesRoot`) AND currently
   *  dead (directory absent) at classification time. Always populated when `parseError` is null. */
  deadCount: number;
  /** Capped (see {@link DEAD_KEY_SAMPLE_CAP}) sample of the dead keys — diagnostic only. */
  deadKeysSample: string[];
  /** Keys actually deleted from the file. Always empty on a dry run or an aborted/failed real run. */
  removedKeys: string[];
  /** Dead-at-classification keys found ALIVE again by the time of the real write (a worktree recreated at
   *  that exact path in the classification-to-lock window) — reported explicitly, never silently dropped.
   *  Always empty on a dry run. */
  recreatedKeys: string[];
  /** Worktree-scoped keys whose liveness could NOT be determined (a stat error other than ENOENT/ENOTDIR
   *  — see {@link classifyPathLiveness}, review item 2) at classification time, the in-lock re-verify, or
   *  both (deduplicated). Never deleted — treated exactly like `alive` for the purposes of this run, but
   *  reported separately so a human can investigate rather than have it silently fold into "alive". */
  unknownKeys: string[];
  /** Set when `.claude.json` could not be read/parsed at all (a genuinely MISSING file is NOT an error —
   *  see `readCfgFailClosed`). The call always aborts with no write when this is set. */
  parseError: string | null;
  /** Set when the call aborted without writing: `"count-drop"` — the fresh in-lock read is missing a key
   *  that was NOT classified dead by this run (review item 4: a key missing from the fresh read is only
   *  ever explained by this run's own dead classification; any other missing key means the file was
   *  truncated/clobbered by something else). `"lock-unavailable"` — `withTrustLock`'s acquire loop (review
   *  item 3) gave up without ever holding the lock. Card f761fdf3 item 4: wording only — this is most
   *  commonly a transient Windows FS error (EPERM/EACCES/EBUSY) that exhausted its own retry budget, or a
   *  non-EEXIST open error, NOT simply "another process is holding the lock": a lock that's merely held
   *  and looks STALE (older than `trustLockMs()`) is broken and retried instead of causing this abort
   *  (card 5b97da80 owns that stale-break/acquire-deadline behavior; nothing about it changes here).
   *  `"worktrees-root-missing"` — `worktreesRoot` itself doesn't stat as an existing directory (review
   *  item 2). Never set on a dry run (dry runs never take the lock or examine the root this strictly). */
  aborted: "count-drop" | "lock-unavailable" | "worktrees-root-missing" | null;
}

/** One-directional containment against ALREADY-COMPUTED root forms: `child` strictly under one of
 *  `rootForms` (never equal, and never the REVERSE — a root that happens to sit strictly under `child`,
 *  i.e. `child` is an ANCESTOR of the root, must not match). Review item 6: the bidirectional
 *  `pathOverlapKind`'s "nested" also fires on that reverse case, which would wrongly classify an
 *  ancestor-of-the-root key as worktree-scoped. `rootForms` is hoisted by the caller (one {@link
 *  containmentForms} call per bulk-prune call, not per key — classifying a large file by re-resolving
 *  the SAME root's realpath on every one of its keys was measured as the dominant cost of this scan). A
 *  non-absolute (including empty-string) `child` never matches — a relative/garbage key is never a real
 *  worktree path to begin with. */
function isStrictlyUnderRootForms(rootForms: readonly string[], child: string): boolean {
  if (child === "" || !path.isAbsolute(child)) return false;
  const childForms = containmentForms(child);
  for (const c of childForms) for (const r of rootForms) {
    if (c.startsWith(r + path.sep) && c.length > r.length + 1) return true;
  }
  return false;
}

/**
 * One-time (and re-runnable) prune of `.claude.json` entries for Loom worktrees whose directory no longer
 * exists (card 498452c0). `worktreesRoot` defaults to the real `WORKTREES_DIR` but is overridable — same
 * testability convention `worktreeRemovalRefusal`/`findNestedGitRepos` already use in `git/worktrees.ts`.
 *
 * Refuses the WHOLE call up front, before reading `.claude.json` at all, if `worktreesRoot` doesn't stat
 * as an existing directory (review item 2 — `aborted:"worktrees-root-missing"`): a wrong/typo'd root
 * could otherwise silently classify nothing (or, via a stat-error misclassification, far too much) with
 * no signal that the root itself was the problem.
 *
 * Classification (`classifyWorktreeScopedKeys`): a stored key is worktree-scoped iff it is absolute AND
 * {@link isStrictlyUnderRootForms} strictly under `worktreesRoot` — ONE-directional (never the root
 * itself, never an ancestor of it; review item 6). It is then bucketed dead/alive/unknown by {@link classifyPathLiveness}
 * (review item 2 — a stat error other than ENOENT/ENOTDIR is `unknown`, never treated as dead). The
 * `canonicalKey` main-checkout entry (see the file header above) is never nested under `worktreesRoot`
 * and so is never a candidate.
 *
 * `dryRun:true` reads ONCE, lock-free, and never writes — safe because `writeJsonAtomic`'s atomic rename
 * means a reader always observes a fully-old or fully-new file, never torn (the same reasoning
 * `ensureTrusted`'s own fast path already relies on).
 *
 * `dryRun:false` reuses that same classification read (done OUTSIDE the lock, so the lock is never held
 * for the cost of scanning every project entry), then takes the lock in REQUIRED mode (review item 3 —
 * `withTrustLock(..., { requireLock: true })`: a bulk delete must never proceed unlocked, unlike
 * `ensureTrusted`'s own additive best-effort write) and RE-READS fresh. For each previously-dead key it
 * re-verifies, INSIDE the lock, that the directory is STILL confirmed absent (alive again ⇒
 * `recreatedKeys`, never deleted; still unknown ⇒ left alone and folded into `unknownKeys`, never
 * deleted) and that the key is still present in the fresh read, before deleting it.
 *
 * @decision 498452c0 — a key missing from the fresh in-lock read is explained ONLY if THIS run itself
 * classified it dead; any other missing key aborts with NO write (`aborted:"count-drop"`). Never widen
 * into a full snapshot-compare, and never let this run's own planned-removal count mask an unrelated drop.
 *
 * Fails closed on a malformed/unreadable config at EITHER read (classification or the fresh in-lock read):
 * `parseError` is set and nothing is ever written — never treat a corrupt/unreadable file as `{}` here (see
 * `readCfgFailClosed`'s own doc for why that would be catastrophic for a bulk-delete write).
 */
export function pruneDeadWorktreeClaudeConfigEntries(
  opts: { dryRun: boolean; worktreesRoot?: string },
): PruneDeadWorktreeEntriesResult {
  const claudeJson = claudeJsonPath();
  const worktreesRoot = opts.worktreesRoot ?? WORKTREES_DIR;
  const base = (overrides: Partial<PruneDeadWorktreeEntriesResult> = {}): PruneDeadWorktreeEntriesResult => ({
    dryRun: opts.dryRun,
    deadCount: 0,
    deadKeysSample: [],
    removedKeys: [],
    recreatedKeys: [],
    unknownKeys: [],
    parseError: null,
    aborted: null,
    ...overrides,
  });

  // Review item 2: refuse up front rather than silently classifying nothing (or, via a stat-error
  // misclassification, too much) against a root that doesn't actually exist.
  try {
    if (!statSyncImpl(worktreesRoot).isDirectory()) {
      return base({ aborted: "worktrees-root-missing" });
    }
  } catch {
    return base({ aborted: "worktrees-root-missing" });
  }

  function classifyWorktreeScopedKeys(cfg: ClaudeCfg): { dead: string[]; alive: string[]; unknown: string[] } {
    const dead: string[] = [];
    const alive: string[] = [];
    const unknown: string[] = [];
    const rootForms = containmentForms(worktreesRoot); // hoisted ONCE — see isStrictlyUnderRootForms's doc
    for (const key of Object.keys(cfg.projects ?? {})) {
      if (!isStrictlyUnderRootForms(rootForms, key)) continue; // not a worktree-scoped key at all
      const liveness = classifyPathLiveness(key);
      if (liveness === "dead") dead.push(key);
      else if (liveness === "alive") alive.push(key);
      else unknown.push(key);
    }
    return { dead, alive, unknown };
  }

  const read = readCfgFailClosed(claudeJson);
  if ("error" in read) return base({ parseError: read.error });
  const { dead, unknown } = classifyWorktreeScopedKeys(read.cfg);
  const deadKeysSample = dead.slice(0, DEAD_KEY_SAMPLE_CAP);

  if (opts.dryRun) return base({ deadCount: dead.length, deadKeysSample, unknownKeys: unknown });

  let result = base({ deadCount: dead.length, deadKeysSample, unknownKeys: unknown });
  // Review item 3: the real write must never proceed unlocked — requireLock means `fn` below is simply
  // never called if the acquire loop gives up, and `held` tells us which happened.
  const { held } = withTrustLock(`${claudeJson}.loom-lock`, () => {
    const fresh = readCfgFailClosed(claudeJson);
    if ("error" in fresh) { result = base({ parseError: fresh.error }); return; }
    const freshProjects = fresh.cfg.projects;

    const removed: string[] = [];
    const recreated: string[] = [];
    const unknownAtReverify: string[] = [];
    for (const key of dead) {
      if (!freshProjects || !(key in freshProjects)) continue; // gone from the fresh read — the count-drop check below covers this
      const liveness = classifyPathLiveness(key); // re-verify AGAIN, right before deleting
      if (liveness === "alive") { recreated.push(key); continue; }
      if (liveness === "unknown") { unknownAtReverify.push(key); continue; } // can't confirm dead right now — leave it; a later run re-tries
      removed.push(key);
    }

    // @decision 498452c0 — see the function doc above: a missing-from-fresh key is explained only by
    // THIS run's own dead classification; any other missing key aborts. A concurrent add always passes.
    const deadSet = new Set(dead);
    const unexplainedMissing: string[] = [];
    for (const key of Object.keys(read.cfg.projects ?? {})) {
      if (freshProjects && key in freshProjects) continue; // still present — fine
      if (deadSet.has(key)) continue; // expected: this run's own dead classification may vanish benignly
      unexplainedMissing.push(key);
    }
    if (unexplainedMissing.length > 0) {
      console.warn(`[claude-config] prune aborted — ${unexplainedMissing.length} project entr${unexplainedMissing.length === 1 ? "y" : "ies"} vanished between the classification read and the fresh in-lock read without being classified dead by this run (e.g. ${unexplainedMissing.slice(0, 5).join(", ")}) — file may have been truncated/clobbered externally. No write performed.`);
      result = base({ deadCount: dead.length, deadKeysSample, unknownKeys: unknown, aborted: "count-drop" });
      return;
    }

    for (const key of removed) delete freshProjects![key];
    if (removed.length > 0) writeJsonAtomic(claudeJson, fresh.cfg);
    const allUnknown = [...new Set([...unknown, ...unknownAtReverify])];
    result = { dryRun: false, deadCount: dead.length, deadKeysSample, removedKeys: removed, recreatedKeys: recreated, unknownKeys: allUnknown, parseError: null, aborted: null };
  }, { requireLock: true });
  if (!held) return base({ deadCount: dead.length, deadKeysSample, unknownKeys: unknown, aborted: "lock-unavailable" });
  return result;
}
