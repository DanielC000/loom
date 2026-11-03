import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { SessionRole } from "@loom/shared";
import { SKILLS_DIR, OBSIDIAN_PREFLIGHT_FRAGMENT, WORKTREES_DIR } from "../paths.js";
import { claudeSkillsDir, doctrineGitExcludeEntries, QUARANTINED_SKILLS_DIRNAME } from "../pty/claude-doctrine.js";
import { isValidSkillName, isBundledSkill, skillProvenance, isPristineBundledContent } from "./store.js";
import { stripPermissionWidening } from "./permissionGuard.js";
import { LOCKED_PROFILE_ROLES } from "../profiles/validate.js";
import { resolveGitDirsSync } from "../git/repo-lock.js";
import { canonicalGit, withTimeout } from "../git/bounded.js";
import { comparisonKey } from "../projects/repos.js";

const MANIFEST = ".loom-skills.json"; // records which skill names EACH session injected into the doctrine dir's skills subtree
// CR round 3 (card 31f997e7): a SEPARATE sidecar file, never merged into MANIFEST's own shape — keeps
// every existing reader of MANIFEST (several other test files parse it directly) byte-for-byte
// unaffected, and needs no legacy-format handling of its own (nothing pre-dates it). Absent (an old
// worktree this version hasn't touched yet) ⇒ no fingerprints for anything in it, same as a parse error.
const FINGERPRINTS_FILE = ".loom-skills-fingerprints.json";

/**
 * DAEMON-SIDE placement fingerprints, keyed by `cwd` then skill name — never read from disk. The
 * {@link FINGERPRINTS_FILE} sidecar above lives INSIDE the very `.claude/skills` directory the cwd-skill
 * permission scan (`permission-scan.ts`) reads, so anything that can write `evil/SKILL.md` there can also
 * forge a manifest + sidecar entry claiming Loom itself placed it — and the scan would then wrongly trust
 * that forged claim and skip scanning it. This map is populated ONLY at the exact instant THIS daemon
 * process's own `injectSkills` call below places a skill (see `recordLoomPlacedFingerprint`), so nothing a
 * repo/worktree can write to disk can ever populate it. It does not survive a daemon restart: a claimed
 * name with no entry here fails toward being SCANNED, never toward being trusted (see the decision
 * record's "After a daemon restart" note). Never consulted by the dead-claim cleanup below, which is a
 * different concern (safe deletion of an orphaned worktree dir) that legitimately needs cross-restart
 * persistence and keeps reading the file-based sidecar.
 *
 * @decision 015fdb23 — CR round 4, item 3: the cwd sidecar is never trusted for the scan's own exclusion
 * decision; only this daemon-side registry is.
 *
 * Bounded two ways (card 22813c50, M1): (1) `recordLoomPlacedFingerprint` REPLACES a name's recorded
 * fingerprint on every placement rather than accumulating one per content version ever placed — by the
 * time a scan reads this, the dir's on-disk content is always whatever the LATEST placement wrote, so an
 * older fingerprint can never legitimately match again and is pure dead weight. (2) the outer map is
 * capped at {@link LOOM_PLACED_FINGERPRINTS_MAX_CWDS} distinct cwds, LRU-evicted — bounding the OTHER
 * growth axis (one entry per cwd this daemon process has ever injected into, which never shrinks on its
 * own: nothing here is told when a worktree is removed). Named residual: a removed worktree's entry
 * lingers, harmlessly (it only ever makes the scan MORE conservative — see `scanCwdSkillsForPermissionFrontmatter`'s
 * own doc, "fail toward scanning"), until the LRU cap evicts it or the daemon restarts.
 */
const loomPlacedFingerprintsByCwd = new Map<string, Map<string, Set<string>>>();

/** Card 22813c50 (M1) — a defensive cap on distinct cwds tracked, same posture as this file's own
 *  `UNTRACKED_CACHE_MAX_ENTRIES`/`PENDING_RECLAIM_MAX_PER_CWD`. LRU: `recordLoomPlacedFingerprint` moves a
 *  cwd to the back of the map on every write (insertion order = recency), so the entry evicted here is
 *  always the least-recently-placed-into one. */
const LOOM_PLACED_FINGERPRINTS_MAX_CWDS = 300;

function recordLoomPlacedFingerprint(cwd: string, name: string, fingerprint: string): void {
  const key = comparisonKey(cwd); // card 22813c50 (M1) — consistent with sessions/service.ts's push-dedupe key for the same cwd
  let byName = loomPlacedFingerprintsByCwd.get(key);
  if (!byName) byName = new Map();
  byName.set(name, new Set([fingerprint])); // REPLACE — the latest placement supersedes; never accumulate
  loomPlacedFingerprintsByCwd.delete(key); // move-to-end (Map preserves insertion order) — LRU touch
  loomPlacedFingerprintsByCwd.set(key, byName);
  if (loomPlacedFingerprintsByCwd.size > LOOM_PLACED_FINGERPRINTS_MAX_CWDS) {
    const oldestKey = loomPlacedFingerprintsByCwd.keys().next().value;
    if (oldestKey !== undefined) loomPlacedFingerprintsByCwd.delete(oldestKey);
  }
}

// The shared-cwd dead-claim RECLAIM: ASYNC COMPUTES THE FACT, SYNC ACTS ON IT — injectSkills runs
// synchronously on the spawn hot path and must never run a git subprocess itself. See the decision
// record for the full mechanism, why a synchronous git call was rejected, and the named residuals.
//
// @decision f4e93dbf — never run git synchronously here; the fire-and-forget check below (and its
// consumption at the NEXT injectSkills call for this cwd) is the only sanctioned way to verify this.

/** Pure fs walk, no subprocess, no git call: the nearest ancestor of `dir` (inclusive) containing a
 *  `.git` entry — the INNERMOST real git repository root containing `dir`, or null if none exists before
 *  the filesystem root. Mirrors `git/repo-lock.ts`'s own `resolveGitToplevelSync` walk — cheap enough to
 *  call synchronously even on the hot path (the same cost class as `fingerprintSkillDir`, already called
 *  synchronously elsewhere in this file). Callers must walk from the TARGET SKILL DIR, never from `cwd` —
 *  see the decision record for why a nested repo below `cwd` needs this and the named `GIT_DIR`/
 *  `GIT_WORK_TREE` residual.
 *
 *  @decision f4e93dbf — never pass `cwd` here; the target skill dir is the only correct starting point. */
function innermostGitRepoRoot(dir: string): string | null {
  let cur = dir;
  for (;;) {
    try { if (fs.existsSync(path.join(cur, ".git"))) return cur; } catch { /* treat as absent */ }
    const parent = path.dirname(cur);
    if (parent === cur) return null; // reached the filesystem root — no repo anywhere up-tree
    cur = parent;
  }
}
const UNTRACKED_CHECK_TIMEOUT_MS = 10_000; // matches this codebase's own convention for one quick, bounded git read (sessions/service.ts's mainlineGitMs)
const UNTRACKED_CACHE_TTL_MS = 60_000; // bounds the one named residual: a commit landing AFTER the check but BEFORE a later call consumes it
const UNTRACKED_CACHE_MAX_ENTRIES = 500; // defensive cap — this only ever grows on a genuine dead-claim reclaim event, which is rare

interface UntrackedCheckEntry { readonly fingerprint: string; readonly expiresAt: number; }
/** `${cwd}\u0000${name}` -> the fingerprint that was confirmed untracked, plus when that confirmation
 *  expires. NUL-separated so neither half can ever be ambiguous about where it ends (a skill name is
 *  already a validated kebab slug with no NUL byte; `cwd` is a filesystem path, same reasoning). This
 *  cache holds ONLY the verified-untracked FACT, with its own short TTL — it is deliberately NOT where a
 *  caller remembers "this name is an orphan worth re-checking"; that is the separate, disk-persisted
 *  {@link PendingReclaimMap} below, which has no TTL and survives across this cache's own expiry.
 *
 *  @decision f4e93dbf round 2 — the 60s TTL applies ONLY to this verified fact, never to the fact that an
 *  orphan exists at all; see the decision record for the gap this split closes. */
const verifiedUntrackedCache = new Map<string, UntrackedCheckEntry>();
/** Dedupes concurrent kicks for the exact same (cwd, name) — same key shape as the cache above. Also the
 *  TEST-ONLY await surface ({@link __awaitPendingSkillTrackChecks}): production never awaits an entry
 *  here (that would defeat the whole point of firing it fire-and-forget off the hot path). */
const inFlightTrackChecks = new Map<string, Promise<void>>();

function untrackedCacheKey(cwd: string, name: string): string { return `${cwd}\u0000${name}`; }

/** Bounded (10s), fire-and-forget, deduped: is `target` (the session's doctrine skills dir for `name`)
 *  git-tracked right now, in the INNERMOST repo that actually contains it (`repoRoot`, from {@link
 *  innermostGitRepoRoot} — never assumed to be `cwd`)? Never throws — every failure (no repo, git error,
 *  timeout) is swallowed and logged once, and caches NOTHING, which is exactly the fail-closed "never
 *  reclaim" default a later sync call reads. `name` must already be a validated skill name (every caller
 *  here draws it from the manifest, which `sanitizeManifestEntries` already restricted to a safe kebab
 *  slug) — built into a POSIX-style git pathspec (forward slashes, never a win32 `path.join` separator)
 *  relative to `repoRoot`, never a hardcoded `.claude/skills` literal of this function's own. Reads the
 *  wall clock via a bare `Date.now()` (this codebase's own convention for a test-overridable clock —
 *  several other test files reassign `Date.now` directly, e.g. `temp-path-collision-guard.mjs` — rather
 *  than threading an injectable clock parameter through every caller). */
function kickUntrackedCheck(cwd: string, name: string, fingerprint: string, repoRoot: string, target: string): void {
  const key = untrackedCacheKey(cwd, name);
  if (inFlightTrackChecks.has(key)) return; // already checking this exact (cwd, name) — don't pile on another
  const pathspec = path.relative(repoRoot, target).split(path.sep).join("/");
  const run = (async () => {
    try {
      const git = canonicalGit(repoRoot, UNTRACKED_CHECK_TIMEOUT_MS);
      const out = await withTimeout(git.raw(["ls-files", "--", pathspec]), UNTRACKED_CHECK_TIMEOUT_MS, "git ls-files (skill dead-claim reclaim check)");
      if (out.trim() === "") {
        if (verifiedUntrackedCache.size >= UNTRACKED_CACHE_MAX_ENTRIES) {
          const oldestKey = verifiedUntrackedCache.keys().next().value;
          if (oldestKey !== undefined) verifiedUntrackedCache.delete(oldestKey); // defensive eviction; practically never hit
        }
        verifiedUntrackedCache.set(key, { fingerprint, expiresAt: Date.now() + UNTRACKED_CACHE_TTL_MS });
      }
      // non-empty output => at least one file under it is git-tracked — cache nothing, same as an error below
    } catch (e) {
      console.log(`[skills] dead-claim reclaim: git-tracked check failed for '${name}' at ${cwd} (treating as tracked — not reclaiming): ${(e as Error)?.message ?? e}`);
    } finally {
      inFlightTrackChecks.delete(key);
    }
  })();
  inFlightTrackChecks.set(key, run);
}

const PENDING_RECLAIM_KEY = "__pendingReclaim"; // reserved top-level key in FINGERPRINTS_FILE; never a real session id
const PENDING_RECLAIM_MAX_PER_CWD = 200; // defensive cap — practically never hit (mirrors UNTRACKED_CACHE_MAX_ENTRIES's own framing)
const PENDING_RECLAIM_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — generous; bounds disk growth for an orphan nobody ever asks for again, not a safety mechanism

/** One persisted, disk-durable record of a shared-cwd dead-claim orphan still awaiting reclaim — the
 *  "remember the orphan" half of the split {@link verifiedUntrackedCache} documents. `deadFingerprints`
 *  is every content fingerprint any dead claimant has ever recorded placing under this name (unioned
 *  across discoveries); `firstSeenAt` is when this name was FIRST recorded pending (never refreshed by a
 *  later call that merely re-confirms it — see the decision record's age-bound rationale). Lives until it
 *  RESOLVES: reclaimed, edited (content no longer matches any recorded fingerprint), claimed by a live
 *  session, or the dir is gone — see `injectSkills`'s shared-cwd block for where each resolution fires.
 *
 *  @decision f4e93dbf round 2 — persisted here, in the EXISTING fingerprints sidecar, under this one
 *  reserved key; never a third sidecar file, and never merged into a real session's own fingerprint map. */
interface PendingReclaimRecord { readonly deadFingerprints: readonly string[]; readonly firstSeenAt: number; }
type PendingReclaimMap = Record<string, PendingReclaimRecord>; // skill name -> record

/** TEST-ONLY. Awaits every currently in-flight {@link kickUntrackedCheck} call. Production code never
 *  calls this — every real caller fires the check and walks away; awaiting it here would reintroduce the
 *  exact spawn-hot-path block this whole mechanism exists to avoid. Named with the double-underscore
 *  prefix + a full descriptive name specifically so it reads as what it is at every call site, including
 *  an accidental one. */
export async function __awaitPendingSkillTrackChecks(): Promise<void> {
  await Promise.all([...inFlightTrackChecks.values()]);
}

/** The skills whose injected SKILL.md gets the Obsidian "vault preflight" fragment appended — and ONLY
 *  these — when the session's project has `obsidian.autoStart` on. Every other skill is untouched. */
const OBSIDIAN_FRAGMENT_SKILLS = new Set(["loom-pickup", "loom-session-end"]);

/** Generic slug→skill-name binding (agent-tooling P4 phase 2): a bound skill is withheld from the
 *  deliver-all default unless (a) `cwd` is a worktree-isolated cwd (see `isWorktreeCwd` below) AND (b)
 *  the session's resolved capabilities include the named slug — see `injectSkills`'s own doc comment for
 *  the full mechanism and residuals. Ships EMPTY here — this card adds only the mechanism; a real binding
 *  (e.g. a `shadcn` skill bound to the `shadcn` capability) lands in a later card. `Object.create(null)`,
 *  not `{}` (mirrors `store.ts`'s `emptyProvenanceMap`), paired with `passesCapabilityGate`'s own
 *  `Object.hasOwn` read: neither a lookup here nor a caller-supplied override can resolve a prototype
 *  property name ("constructor" and friends) as if it were a real binding.
 *
 *  @decision 31f997e7 — this gate is delivery hygiene, NOT a security boundary; never the only thing
 *  standing between an agent and a capability. See the decision record for the full mechanism. */
const CAPABILITY_BOUND_SKILLS: Record<string, string> = Object.create(null);

/** Whether `cwd` is a worktree-isolated session home — i.e. genuinely exclusive to ONE session, never
 *  shared with another live session the way `project.repoPath` is (manager/platform/setup/auditor/plain/
 *  assistant sessions). A plain `path.relative` ancestor check against `WORKTREES_DIR`, the same idiom
 *  `escapedAncestor` above uses — `WORKTREES_DIR` and `cwd` are both Loom-internal values here (never
 *  attacker-controlled repo content), so no `realpathSync` symlink defense is needed, unlike that
 *  function's own untrusted-ancestor check.
 *
 *  Every worker (tasked or taskless) spawns/resumes/forks/recycles with `cwd: worktreePath`, always
 *  nested under `WORKTREES_DIR` (`git/worktrees.ts`'s `createWorktree`); every other role spawns with
 *  `cwd: project.repoPath` (shared) except "run" (a disposable snapshot dir, moot here since a run
 *  session's `capabilities` is hardcoded `[]` and can never be granted). A role check (`role ===
 *  "worker"`) would be a proxy for this same fact; this checks the structural fact itself, so it
 *  self-corrects if a future spawn path's cwd assignment ever drifts from today's role↔cwd mapping.
 *
 *  @decision 31f997e7 — the ONLY discriminator the capability-bound-skill gate trusts for "this cwd
 *  belongs to this session alone." */
function isWorktreeCwd(cwd: string): boolean {
  const rel = path.relative(WORKTREES_DIR, cwd);
  // CR round 2 (reviewer 3e7c525e) NIT: a bare `rel.startsWith("..")` false-negatives on a genuine
  // descendant literally named e.g. "..foo" (a string-prefix match with no actual ".." path segment) —
  // only an EXACT ".." segment, or one followed by a real separator, means "escaped".
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
}

/** Map a Loom-DRIVEN session role to its operating-doctrine skill name in the store. A role here MUST get
 *  its doctrine skill no matter what the profile's pinned subset says (a subset that omits "worker" must
 *  still ship the worker doctrine). run/plain/null carry no doctrine ⇒ absent here. */
const ROLE_DOCTRINE_SKILL: Partial<Record<SessionRole, string>> = {
  worker: "worker",
  manager: "orchestrate",
  platform: "platform-lead",
  auditor: "platform-audit",
  "workspace-auditor": "workspace-audit",
  setup: "setup-assistant",
};

/** The store skill name carrying `role`'s operating doctrine, or null when the role has none (run/plain/
 *  assistant/operator/null). The single source for both harnesses' role→doctrine mapping. */
export function roleDoctrineSkillName(role: string | null | undefined): string | null {
  return (role && ROLE_DOCTRINE_SKILL[role as SessionRole]) || null;
}

/** Whether a locked role should trust store skill `n` — bundled-but-not-agent-stamped, or explicitly
 *  human-stamped. Provenance-only, never content-equality. The SHARED gate for both locked-role trust
 *  checks in `injectSkills` below (the `want` filter and the force-included role-doctrine skill), so the
 *  two can never diverge.
 *
 *  @decision 9a3dea30 — provenance-only, never content-equality; see the decision record. */
function isTrustedForLockedRole(n: string): boolean {
  return (isBundledSkill(n) && skillProvenance(n) !== "agent") || skillProvenance(n) === "human";
}

/** Per-session injected-skill record for a shared `.claude/skills`: `{ "<sessionId>": ["worker", …] }`.
 *  Keyed by session so a concurrent session sharing the cwd never strips another's (or the repo's) skills. */
type Manifest = Record<string, string[]>;

/** A manifest entry is only ever used to build a path under `targetDir` for delivery/pruning — including
 *  `fs.rmSync(..., { recursive: true, force: true })`. The manifest file lives in the repo/worktree and is
 *  committable, so it's untrusted input: an entry like `"../../../victim"` or `""`/`"."` must never reach
 *  that path.join unvalidated. Require the SAME kebab-slug shape the skill store itself enforces (also a
 *  basename — no separators — and never `.`/`..`, though those are already excluded by the shape). */
export function isSafeManifestEntry(n: unknown): n is string {
  return typeof n === "string" && isValidSkillName(n) && path.basename(n) === n;
}

/**
 * Whether any of `candidates` (ancestor dirs of the injection target, outermost first) is a symlink or
 * junction that resolves OUTSIDE `cwd` — e.g. a committed git symlink, or a Windows junction a user
 * created by hand. Must run BEFORE any mkdir/write: `fs.mkdirSync(dir, { recursive: true })` happily
 * traverses an EXISTING symlink/junction ancestor and creates directories on the far side, so checking
 * only after the fact is already too late. Only an ancestor that already EXISTS can redirect anywhere —
 * a missing one is about to be freshly created by mkdirSync, under the real `cwd`, so `fs.realpathSync`
 * failing (ENOENT) on a candidate just means "nothing to escape through yet," not an error worth
 * surfacing. Returns the first escaping candidate (its real target, for the log line), or null if none
 * escape — including when `cwd` itself can't be resolved, in which case the caller's own mkdir is left
 * to surface whatever is actually wrong with `cwd`.
 */
function escapedAncestor(cwd: string, candidates: string[]): { path: string; real: string } | null {
  let cwdReal: string;
  try { cwdReal = fs.realpathSync(cwd); } catch { return null; }
  for (const candidate of candidates) {
    let real: string;
    try { real = fs.realpathSync(candidate); } catch { continue; } // doesn't exist yet — safe, mkdirSync will create it fresh
    const rel = path.relative(cwdReal, real);
    if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) return { path: candidate, real };
  }
  return null;
}

/** Filter a raw manifest entry list (one session's record) down to safe names. A non-array value (e.g. a
 *  dict `{"x":5}` where an array was expected) is COERCED to `[]` rather than thrown on — readManifest's
 *  caller must never have injection disabled for the whole session just because one record is malformed.
 *  Dropped entries are logged, bounded + truncated (untrusted content, but still worth seeing what/how many). */
function sanitizeManifestEntries(raw: unknown, context: string): string[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined) console.log(`[skills] manifest record for '${context}' is not an array (${typeof raw}); treating as empty`);
    return [];
  }
  const safe: string[] = [];
  const dropped: string[] = [];
  for (const n of raw) {
    if (isSafeManifestEntry(n)) safe.push(n);
    else dropped.push(typeof n === "string" ? n.slice(0, 80) : `<${typeof n}>`);
  }
  if (dropped.length) {
    const shown = dropped.slice(0, 5).join(", ");
    console.log(`[skills] dropped ${dropped.length} invalid manifest entr${dropped.length === 1 ? "y" : "ies"} for '${context}': ${shown}${dropped.length > 5 ? ", …" : ""}`);
  }
  return safe;
}

/** Validate+bound one untrusted fingerprint value read from the manifest file. Anything else (not a
 *  string, empty, oversized) reads as "no fingerprint" — the CR round-3 cleanup already treats that as
 *  "cannot verify, don't delete," so a malformed value only ever makes the gate MORE conservative, never
 *  less. */
function sanitizeFingerprint(raw: unknown): string | null {
  return typeof raw === "string" && raw.length > 0 && raw.length <= FINGERPRINT_MAX_LEN ? raw : null;
}

/** Read the manifest map. A legacy ARRAY (the pre-subset single-session format) is adopted AS the current
 *  session's record so it reconciles + retires cleanly on this run. Any other shape ⇒ empty map.
 *  A MISSING file is the normal first-run case (silent empty map); a present-but-CORRUPT manifest (a torn
 *  write, bad JSON) is SURFACED — it means we lost the record of what other sessions injected, so we log it
 *  rather than swallow it — then recover to an empty map (safe: every existing dir then reads as the repo's
 *  own and is left untouched; we only add our own `want`).
 *  Every entry — in the legacy array form and in every session's record in the dict form — is validated by
 *  `sanitizeManifestEntries` before it's trusted: the manifest is repo/worktree-committable and its entries
 *  flow straight into a prune `rmSync`, so an invalid entry here would otherwise be a path-escape/wipe
 *  vector (card 97e6a1c6). This file's own shape is UNCHANGED by card 31f997e7 round 3 (content
 *  fingerprints live in the separate {@link FINGERPRINTS_FILE} sidecar instead — see `readFingerprintsFile`
 *  — specifically so every existing reader of this file stays byte-for-byte unaffected). */
function readManifest(manifestPath: string, sessionId: string): Manifest {
  let text: string;
  try { text = fs.readFileSync(manifestPath, "utf8"); }
  catch { return {}; } // no manifest yet — normal first run, not an error worth surfacing
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch (e) { console.log(`[skills] ignoring corrupt manifest at ${manifestPath}: ${(e as Error).message}`); return {}; }
  if (Array.isArray(raw)) return { [sessionId]: sanitizeManifestEntries(raw, sessionId) }; // legacy global array → this session owns it now
  if (raw && typeof raw === "object") {
    const out: Manifest = {};
    for (const [sid, ns] of Object.entries(raw as Record<string, unknown>)) out[sid] = sanitizeManifestEntries(ns, sid);
    return out;
  }
  return {};
}

/** One cwd's full parse of the {@link FINGERPRINTS_FILE} sidecar: every real session's own fingerprint
 *  record, PLUS the reserved {@link PENDING_RECLAIM_KEY} entry (never a real session id) parsed
 *  separately as a {@link PendingReclaimMap}. */
interface FingerprintsFileData { bySession: FingerprintMap; pending: PendingReclaimMap; }
/** A FRESH object every call — never a shared constant. `injectSkills` mutates the returned `bySession`
 *  in place (`delete fingerprints[sid]`, `fingerprints[sessionId] = …`); a shared singleton here would
 *  let one call's write leak into every OTHER call whose fingerprints file happens to be missing/corrupt
 *  (a real regression this fixed — card f4e93dbf round 2, caught by `skills-capability-bound.mjs` case
 *  17 only after several EARLIER worktree cases had already written through the same stale reference). */
function emptyFingerprintsFile(): FingerprintsFileData { return { bySession: {}, pending: {} }; }

/** Validate+bound one untrusted pending-reclaim record read from the {@link PENDING_RECLAIM_KEY} entry.
 *  `deadFingerprints` must be a non-empty array of valid fingerprints (bounded the same way a session's
 *  own fingerprint record is — see `sanitizeFingerprint`), `firstSeenAt` a finite, non-negative number.
 *  Anything else reads as "no usable record" (caller drops the name entirely) — the same fail-toward-
 *  forgetting-the-bookkeeping, never fail-toward-trusting-garbage, posture the rest of this file's
 *  manifest/fingerprint parsing already uses. */
function sanitizePendingReclaimRecord(raw: unknown): PendingReclaimRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as { deadFingerprints?: unknown; firstSeenAt?: unknown };
  if (!Array.isArray(r.deadFingerprints)) return null;
  const deadFingerprints = r.deadFingerprints.map(sanitizeFingerprint).filter((fp): fp is string => fp !== null);
  if (deadFingerprints.length === 0) return null;
  if (typeof r.firstSeenAt !== "number" || !Number.isFinite(r.firstSeenAt) || r.firstSeenAt < 0) return null;
  return { deadFingerprints, firstSeenAt: r.firstSeenAt };
}

function sanitizePendingReclaimMap(raw: unknown): PendingReclaimMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: PendingReclaimMap = {};
  for (const [name, rec] of Object.entries(raw as Record<string, unknown>)) {
    if (!isSafeManifestEntry(name)) continue;
    const sanitized = sanitizePendingReclaimRecord(rec);
    if (sanitized) out[name] = sanitized;
  }
  return out;
}

/** Read the {@link FINGERPRINTS_FILE} sidecar: `{ sid: { skillName: fingerprint }, [PENDING_RECLAIM_KEY]:
 *  PendingReclaimMap }`. Brand new as of card 31f997e7 round 3 — there is no legacy format to migrate, so
 *  ABSENT (an old worktree, or any worktree this version hasn't written to yet) and CORRUPT both simply
 *  read as the empty {@link FingerprintsFileData} (no fingerprint, no pending record, for anything), the
 *  same fail-toward-keeping outcome the dead-claim cleanup already gives a missing entry. Every sid's
 *  inner map is validated the same way: a skill-name key must pass `isSafeManifestEntry` (mirrors the
 *  main manifest's own entry validation) and its value `sanitizeFingerprint`.
 *
 *  @decision f4e93dbf — {@link PENDING_RECLAIM_KEY} is never iterated as a session id here; a real
 *  session id is minted by the orchestration DB and never equals this reserved literal. */
function readFingerprintsFile(fingerprintsPath: string): FingerprintsFileData {
  let text: string;
  try { text = fs.readFileSync(fingerprintsPath, "utf8"); }
  catch { return emptyFingerprintsFile(); }
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch (e) { console.log(`[skills] ignoring corrupt fingerprints file at ${fingerprintsPath}: ${(e as Error).message}`); return emptyFingerprintsFile(); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyFingerprintsFile();
  const bySession: FingerprintMap = {};
  let pending: PendingReclaimMap = {};
  for (const [sid, m] of Object.entries(raw as Record<string, unknown>)) {
    if (sid === PENDING_RECLAIM_KEY) { pending = sanitizePendingReclaimMap(m); continue; }
    if (!m || typeof m !== "object" || Array.isArray(m)) continue;
    const inner: Record<string, string> = {};
    for (const [name, fp] of Object.entries(m as Record<string, unknown>)) {
      if (!isSafeManifestEntry(name)) continue;
      const sanitized = sanitizeFingerprint(fp);
      if (sanitized) inner[name] = sanitized;
    }
    bySession[sid] = inner;
  }
  return { bySession, pending };
}

/** Serialize `bySession` + `pending` back to the {@link FINGERPRINTS_FILE} on-disk shape — the exact
 *  inverse of `readFingerprintsFile`'s parse. `pending` is omitted entirely when empty, so an ordinary
 *  cwd with nothing ever orphaned never carries the reserved key at all. */
function serializeFingerprintsFile(bySession: FingerprintMap, pending: PendingReclaimMap): Record<string, unknown> {
  const out: Record<string, unknown> = { ...bySession };
  if (Object.keys(pending).length > 0) out[PENDING_RECLAIM_KEY] = pending;
  return out;
}

/**
 * Deliver one store skill dir into the session's .claude/skills, mirroring the tmp+rename pattern
 * store.ts uses for SKILL.md — but for a DIRECTORY: copy into a sibling tmp dir first, build the new
 * copy fully there, THEN remove the old `dest` and rename the tmp into its place. NOT a single atomic
 * replace-over-an-existing-dir (`rename()` can't do that for a non-empty directory on this codebase's
 * target platforms) — it is rm-then-rename, so there IS a brief window, between the `rmSync` and the
 * `renameSync`, where `dest` does not exist at all.
 *
 * @decision f4e93dbf — never describe this as an atomic replace with no delete step; it rm's `dest` then
 * renames, with a real (if brief) window where `dest` is simply missing.
 *
 * Two correctness wins this sequencing still gives over a bare cpSync into `dest`:
 *  - A copy interrupted partway never leaves a half-written skill at `dest`: the new copy is built
 *    entirely off to the side first, and the existing `dest` is removed ONLY once that copy is ready — so
 *    a FAILED copy leaves the old skill fully intact instead of nuking it.
 *  - RETRIED + SURFACED: transient FS errors (AV/lock/EBUSY on Windows) get a few attempts; a persistent
 *    failure is logged and reported back (false) so the caller can surface it — never silently swallowed,
 *    which would let a session run WITHOUT its pinned doctrine skill.
 * Returns true iff the skill is now in place.
 */
function copySkillAtomic(src: string, dest: string): boolean {
  const tmp = `${dest}.loom-tmp`;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Clear a stale tmp DIR from a prior crash so we never MERGE old store content into the fresh copy.
      // A stale tmp FILE is anomalous (we only ever create tmp dirs) — leave it so cpSync surfaces the type
      // mismatch rather than us blindly deleting an unexpected file at our temp path.
      try { if (fs.statSync(tmp).isDirectory()) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* no stale tmp */ }
      fs.cpSync(src, tmp, { recursive: true });           // build the new copy off to the side
      fs.rmSync(dest, { recursive: true, force: true });  // retire the old copy ONLY now the new one is ready
      fs.renameSync(tmp, dest);                            // atomic swap into place
      return true;
    } catch (e) { lastErr = e; }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`[skills] failed to inject '${path.basename(dest)}' after 3 attempts: ${(lastErr as Error)?.message}`);
  return false;
}

/** sha256 hex is 64 chars; this bounds an UNTRUSTED fingerprint read from the manifest file (card
 *  97e6a1c6's posture: the manifest lives in the repo/worktree and is committable) well above that, but
 *  nowhere near unbounded. */
const FINGERPRINT_MAX_LEN = 128;

/** sid -> (skill name -> content fingerprint), the CR round-3 sibling of {@link Manifest} — see
 *  `readFingerprintsFile`'s doc for the on-disk shape and `fingerprintSkillDir` for what the value means. */
type FingerprintMap = Record<string, Record<string, string>>;

/** Every regular FILE under `dir`, recursively, as POSIX-style relative paths, sorted for determinism.
 *  A symlink/junction child is neither a file nor a directory per `Dirent` and is silently excluded —
 *  never followed, matching this module's broader symlink-escape posture elsewhere. Throws on a read
 *  error (missing dir, EPERM, …); the caller treats that as "cannot fingerprint," never as "empty." */
function listFilesRecursiveSorted(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, prefix: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), rel);
      else if (e.isFile()) out.push(rel);
    }
  };
  walk(dir, "");
  return out.sort();
}

/**
 * A deterministic content fingerprint for a skill DIRECTORY: sha256 over the sorted list of
 * "<relative-path>:<sha256-of-that-file's-bytes>" lines. Recorded at placement time (right after a
 * successful {@link copySkillAtomic} + any Obsidian fragment append — i.e. the FINAL bytes Loom actually
 * left on disk, not an intermediate state) and compared later to decide whether the CR round-3 dead-claim
 * cleanup may safely delete a dead session's claimed dir — see `injectSkills`'s own doc and the decision
 * record.
 *
 * Returns null when the dir is missing or ANY file under it can't be read — "cannot verify" is never
 * silently treated as "empty" or "matches," since every caller of this function must fail toward NOT
 * deleting when it can't compute a fingerprint to compare against.
 */
export function fingerprintSkillDir(dir: string): string | null {
  let rels: string[];
  try { rels = listFilesRecursiveSorted(dir); } catch { return null; }
  const h = crypto.createHash("sha256");
  for (const rel of rels) {
    let content: Buffer;
    try { content = fs.readFileSync(path.join(dir, ...rel.split("/"))); } catch { return null; }
    h.update(`${rel}:${crypto.createHash("sha256").update(content).digest("hex")}\n`);
  }
  return h.digest("hex");
}

/**
 * Append the Obsidian "vault preflight" fragment to a JUST-injected skill's SKILL.md, after its whole body
 * and NEVER into the top frontmatter block. Called ONLY when a session's project has `obsidian.autoStart`
 * on (the additive-when-off invariant: with it off this is never reached, so the injected file is
 * byte-identical to the store base). Uses the SAME atomic tmp+swap discipline as copySkillAtomic. Because
 * copySkillAtomic re-copies the fresh store base on every inject BEFORE this runs, the append is not
 * idempotency-sensitive — each inject starts from a fragment-free base and appends exactly once.
 * Best-effort: the fragment is a pure enhancement (the base skill is fully functional without it), so a
 * failure is logged and the session runs with the short base skill rather than blocking the spawn.
 */
function appendObsidianFragment(skillDir: string, fragment: string): void {
  const skillMd = path.join(skillDir, "SKILL.md");
  let body: string;
  try { body = fs.readFileSync(skillMd, "utf8"); }
  catch { return; } // no SKILL.md to extend (a fragment-target skill with no SKILL.md) — nothing to do
  // Exactly the store base bytes, then a single blank-line separator, then the fragment verbatim. This is
  // the ONLY delta from the off (byte-identical) case, so the test can reconstruct it deterministically.
  const combined = `${body.endsWith("\n") ? body : `${body}\n`}\n${fragment}`;
  const tmp = `${skillMd}.loom-frag-tmp`;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      fs.writeFileSync(tmp, combined);
      fs.renameSync(tmp, skillMd); // atomic swap over the fresh base copy (rename replaces on win32 + posix)
      return;
    } catch (e) { lastErr = e; }
  }
  try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
  console.log(`[skills] failed to append obsidian preflight to ${skillMd} after 3 attempts: ${(lastErr as Error)?.message}`);
}

// A bundled name is exempt from the strip only while its store copy is still content-equal
// (normalizeForCompare-tolerant) to the shipped asset (`isPristineBundledContent`, never `customized`,
// which compares against a possibly-stale `base` snapshot a direct out-of-band store write never touches).
//
// @decision 51a2462a round 2 — a bare `isBundledSkill(name)` check is NOT enough on its own; this
// content-equality check is what actually gates the exemption.
/**
 *  Strip a skill's delivered copy unless it's human-provenance-stamped, or it's a bundled name whose
 *  store copy passes that check; agent-stamped AND unstamped (fail closed, same posture as decision
 *  509176c8) both get stripped, regardless of how the name reached `want` (deliver-all or an explicit
 *  profile subset). `skillDir` is the just-copied delivered dir — read here (never the store directly)
 *  since the caller is about to re-read this same file anyway for the strip itself; an unreadable file
 *  fails CLOSED by returning `true` here — the caller's own `stripPermissionWideningFile` then WITHHOLDS
 *  the skill entirely on that same non-ENOENT read failure, it does not silently no-op. */
function needsPermissionStrip(name: string, skillDir: string): boolean {
  if (skillProvenance(name) === "human") return false;
  if (!isBundledSkill(name)) return true;
  let mine: string;
  try { mine = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8"); }
  catch { return true; } // can't verify pristine — fail closed
  return !isPristineBundledContent(name, mine);
}

/**
 * @decision 51a2462a round 2 — returns `false` on any strip failure; the caller MUST then treat this
 * skill as undeliverable (remove `dest`, record it failed) rather than deliver an unstripped hazard
 * fingerprinted as Loom's own trusted placement, which every failure shape here used to do (only logged).
 *
 * Rewrite a JUST-copied skill's SKILL.md in place to remove any permission-widening construct
 * (`skills/permissionGuard.ts`'s `stripPermissionWidening`) — defense in depth for an agent-provenance
 * store skill that predates the write-time refuse in `skillWriteData`, or that reached the store out of
 * band. Same atomic tmp+swap discipline as `appendObsidianFragment`. Runs BEFORE that fragment append
 * and BEFORE fingerprinting (see the call site), so a fragment-target skill's fragment is appended to
 * the already-stripped base, and the RECORDED fingerprint always covers the bytes actually delivered.
 * A no-op write (`stripPermissionWidening` returns its input unchanged) is skipped entirely — a clean
 * skill's delivered file is never touched, not even its mtime.
 */
function stripPermissionWideningFile(skillDir: string): boolean {
  const skillMd = path.join(skillDir, "SKILL.md");
  let body: string;
  try { body = fs.readFileSync(skillMd, "utf8"); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return true; // no SKILL.md — nothing to strip
    console.log(`[skills] failed to read ${skillMd} to check for permission-widening content: ${(e as Error).message}`);
    return false; // can't verify clean — fail closed
  }
  const stripped = stripPermissionWidening(body);
  if (stripped === body) return true; // clean — never touch the file for a no-op
  if (stripped === null) {
    console.log(`[skills] refusing to deliver ${skillMd}: permission-widening content could not be stripped to a verified-clean result`);
    return false;
  }
  const tmp = `${skillMd}.loom-permstrip-tmp`;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      fs.writeFileSync(tmp, stripped);
      fs.renameSync(tmp, skillMd); // atomic swap over the fresh base copy (rename replaces on win32 + posix)
      return true;
    } catch (e) { lastErr = e; }
  }
  try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
  console.log(`[skills] failed to strip permission-widening content from ${skillMd} after 3 attempts: ${(lastErr as Error)?.message}`);
  return false;
}

// `fs.rmSync` alone is not fail-safe: an EBUSY on the rm (correlated with the SAME rename/write failure
// that got us here — an AV/handle lock on Windows) can leave the unstripped hazard sitting at `dest`,
// where Claude Code's own discovery still finds and loads it. Three ordered fallbacks, each tried only if
// the one before it didn't actually make `dest` disappear.
//
// @decision 51a2462a round 3 — a bare `try { fs.rmSync(dest, …) } catch {}` is not enough; this is the
// fail-safe replacement every "undeliverable skill" call site below must use instead.
//
// @decision 51a2462a round 4 — the quarantine dir uses ONE FIXED name per skill (never a timestamp+random
// suffix), replacing any prior copy (best effort) — never accumulates unbounded dirs. See the decision
// record's "Round 4" section for why a fixed name was chosen over pruning at `injectSkills`'s start.
/**
 * (1) rename `dest` ASIDE, OUTSIDE the `.claude/skills` discovery tree entirely (a sibling under
 *     `.claude` named `.loom-quarantined-skills/<name>` — never a renamed/dotted sibling still INSIDE
 *     `skills/`, which Claude Code's own discovery walk would still find as a skill directory);
 * (2) else overwrite `<dest>/SKILL.md` in place with a neutral, frontmatter-free stub naming the
 *     withheld skill — the hazardous construct is gone even though the directory itself couldn't move;
 * (3) else log loudly at error level — nothing more Loom can do from here (see the decision record's
 *     residual (b): the hazard can still be sitting at `dest`, unmodified, if every fallback failed).
 *
 * Returns true once `dest` is confirmed gone or neutralized; false only in that last, logged case.
 */
function quarantineUndeliverableDest(dest: string, name: string, claudeDir: string): boolean {
  try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* fall through */ }
  if (!fs.existsSync(dest)) return true;

  try {
    const quarantineDir = path.join(claudeDir, QUARANTINED_SKILLS_DIRNAME);
    fs.mkdirSync(quarantineDir, { recursive: true });
    const aside = path.join(quarantineDir, name); // fixed name — replace any prior copy, never accumulate
    try { fs.rmSync(aside, { recursive: true, force: true }); } catch { /* best effort — renameSync below fails closed anyway if this didn't actually clear it */ }
    fs.renameSync(dest, aside);
    console.log(`[skills] quarantine: could not remove ${dest}; relocated it to ${aside} (outside the skill-discovery tree)`);
    return true;
  } catch { /* fall through */ }

  try {
    const stub = `Loom withheld "${name}"'s real content: a permission-widening construct could not be ` +
      "safely stripped, and the delivered copy could not be removed or relocated. See the daemon log.\n";
    fs.writeFileSync(path.join(dest, "SKILL.md"), stub);
    console.log(`[skills] quarantine: could not remove or relocate ${dest}; overwrote its SKILL.md with a neutral stub instead`);
    return true;
  } catch (e) {
    console.log(`[skills] quarantine FAILED for ${dest}: could not remove, relocate, or neutralize it — an unstripped hazard may still be present (${(e as Error).message})`);
    return false;
  }
}

/**
 * Deliver Loom's managed skills to a session by mirroring ~/.loom/skills/<name> into
 * <cwd>/.claude/skills/<name>. Claude discovers these as PROJECT-LOCAL skills (bare names) —
 * WITHOUT touching the user's personal set or CLAUDE_CONFIG_DIR.
 *
 * @decision d63585ca — project-local does NOT shadow same-named personal skills (Claude Code's
 * precedence is the OPPOSITE); a bundled name colliding with a personal skill loses the collision
 * and never fires, with no config lever to reverse it — so Loom's own skill names must never collide.
 *
 * `subset` (profile-pinned, per session): when a non-empty list, deliver ONLY those skills; null/empty ⇒
 * ALL store skills (today's behavior — the regression-guarded default) — EXCEPT for a LOCKED role (see
 * below), where the default additionally withholds any AGENT-authored user-store skill.
 *
 * `role` (the session's resolved role): its operating-doctrine skill (worker→"worker", manager→
 * "orchestrate", …) is FORCE-INCLUDED regardless of the subset — a profile whose subset omits its own
 * role doctrine would otherwise ship a doctrine-less session. Only added if the doctrine skill is in the
 * store (a missing one is still dropped, like any subset name). null/run/plain ⇒ no doctrine skill. A
 * doctrine skill is always bundled, so it is never affected by the locked-role filter below.
 *
 * @decision 509176c8 — a LOCKED role's deliver-all default must withhold an AGENT-written (or
 * unstamped — fail closed) user-store skill; a human-written one, or an explicit non-empty `subset`
 * (human-only to set), still flows. See the full record for why.
 *
 * Shared-cwd safety (the load-bearing invariant): managers/platform/plain sessions SHARE project.repoPath
 * as cwd, so two sessions with DIFFERENT subsets write the SAME `.claude/skills`. The manifest is therefore
 * keyed PER SESSION, and this function only ever PRUNES a skill THIS session previously injected — and even
 * then only if no OTHER session's record still claims it. So injecting session B's subset can never strip
 * session A's skills (or vice-versa); the shared dir holds the UNION of all live sessions' subsets. (A
 * separate-cwd session — every worker, in its own worktree — gets its subset delivered EXACTLY, no union.)
 *
 * Safety (unchanged):
 *  - Manages ONLY skill names Loom ships; NEVER clobbers a repo's own pre-existing project-local skill of
 *    the same name. "Repo's own" = a pre-existing dir NO session's manifest claims (mine or another's).
 *  - Each session gets an INDEPENDENT recursive COPY of the skill (NOT a junction/symlink). A junction
 *    is fatal on Windows: worktree removal (git/worktrees.ts removeWorktree's recursive-rm backstop)
 *    follows the junction and deletes the STORE's SKILL.md contents, nuking ~/.loom/skills for every
 *    later session. A copy is deleted with the worktree without ever reaching the store.
 *  - Hides the injected skills from git via the shared .git/info/exclude (local only; never edits a tracked
 *    .gitignore) — resolved through to the main repo's common dir even when `cwd` is a linked worktree, so a
 *    worker session hides its own injected skills instead of relying on the manager having synced them.
 *
 * `obsidianEnabled` (per session, from `opts.sessionEnv?.LOOM_OBSIDIAN_AUTOSTART === "1"` at the spawn
 * seam): when TRUE, the Obsidian "vault preflight" fragment is appended to the injected loom-pickup/
 * loom-session-end SKILL.md (after its body; frontmatter untouched). Default FALSE ⇒ NO fragment read, NO append — every
 * injected file is byte-identical to the store base (the additive-when-off invariant, mirroring
 * browserTesting/documentConversion). Only loom-pickup + loom-session-end are affected; all other skills are
 * byte-identical regardless.
 *
 * `isSessionLive` (card 9d73e537): an OPTIONAL predicate, INJECTED by the caller — this module must not
 * import the DB directly — answering "is this OTHER session id CURRENTLY live or starting?" for every key
 * the shared manifest holds besides our own (we are live by definition, right now, so we never ask about
 * ourselves). A manifest key this predicate says is NOT currently live/starting is PRUNED from the
 * manifest before `otherClaimed` is computed from it. Deliberately NOT "resumable" (an earlier version of
 * this fix used `resumability !== "dead"`, which code review caught as under-pruning): an exited-but-
 * resumable row (the common steady state of a stopped worker/plain session — processState exited,
 * archivedAt set, resumability still "resumable") would keep its claim forever, which is most of the
 * growth this card exists to stop. Pruning it is SAFE — `injectSkills` runs on EVERY `createPty`
 * (fresh/resume/fork/recycle), so a session that is later actually resumed RE-CLAIMS its skills the
 * moment it resumes; nothing is lost by pruning a claim between resumes, only bookkeeping that would
 * otherwise be regenerated anyway. Without this, a shared-cwd manifest (manager/platform/setup/auditor/
 * plain sessions sharing `project.repoPath`) grows without bound across every recycle generation, and a
 * no-longer-live session's claimed names stay in `otherClaimed` forever — permanently defeating the
 * "never clobber the repo's own pre-existing skill" check below (safety bullet 1) for any name a session
 * that's since gone idle ever touched. Absent (every legacy caller/test) ⇒ NO pruning at all,
 * byte-identical to before this param existed — fail-safe: a caller that can't answer the question must
 * never cause a prune. A predicate that THROWS for one session id is treated the same way for THAT entry
 * only (keep it) — one bad lookup must never cost the rest of the manifest.
 *
 * `grantedCapabilities` (agent-tooling P4 phase 2, card 31f997e7): the session's resolved registry-
 * capability slugs (e.g. via `resolveProfileCapabilities(opts).map(g => g.slug)` at the one production
 * call site). Default/absent ⇒ no grants. Consulted ONLY against `capabilityBindings` (below) to decide
 * whether a CAPABILITY-BOUND skill is included in the deliver-all default — see that param's own doc.
 *
 * `capabilityBindings` (card 31f997e7): skill name → the capability slug it requires. Defaults to the
 * real `CAPABILITY_BOUND_SKILLS` map (ships empty in this card); overridable so a test can exercise the
 * mechanism without any real bound skill existing in the store. A skill NOT in this map is never gated —
 * byte-identical to before this param existed. Applies ONLY to the no-subset deliver-all default: an
 * EXPLICIT non-empty `subset` naming a bound skill still wins (same "subset is a deliberate, human-
 * attributable grant" posture `509176c8` already gives the locked-role filter — see that record).
 *
 * A bound skill ALSO requires `cwd` to be a worktree-isolated session home (`isWorktreeCwd` below), on
 * top of the grant, and a dead session's own claimed copies in such a cwd are cleaned up rather than left
 * to orphan — but ONLY when their current content fingerprint still matches what Loom recorded at
 * placement (never a hand-edited or added-to dir, and never a legacy claim with no recorded fingerprint)
 * — see the decision record for the reproduced incidents this closes, the data-loss finding that added
 * the fingerprint check, and the residual that remains (an explicit `subset` still bypasses every check
 * here).
 *
 * @decision 31f997e7 — delivery hygiene, not a security boundary; never the only thing standing between
 * an agent and a capability.
 */
/** Every skill name `injectSkills` placed for THIS call, or any other session sharing this cwd (per the
 *  shared manifest) — i.e. everything in the target dir that IS Loom's own doing. `claimedFingerprints`:
 *  for each claimed name, every content fingerprint Loom itself actually recorded placing there (from
 *  {@link loomPlacedFingerprintsByCwd}, never the on-disk {@link FINGERPRINTS_FILE} sidecar). A caller
 *  must verify a claimed name's CURRENT on-disk content still matches an entry here, never trust bare
 *  `claimedNames` membership alone.
 *
 *  @decision 015fdb23 — the one place this is consumed; see the decision record's "Round 3"/"Round 4"
 *  sections for the forged-sidecar/edited-after-placement attacks this registry closes. */
export interface InjectSkillsResult {
  claimedNames: readonly string[];
  claimedFingerprints: ReadonlyMap<string, ReadonlySet<string>>;
}

/** Shared empty-map constant for every early-return `InjectSkillsResult` above — avoids allocating a
 *  fresh (always-empty) `Map` at each of those call sites. */
const EMPTY_FINGERPRINTS: ReadonlyMap<string, ReadonlySet<string>> = new Map();

export function injectSkills(
  cwd: string, sessionId: string, subset?: string[] | null, role?: SessionRole | null, obsidianEnabled = false,
  isSessionLive?: (sessionId: string) => boolean,
  grantedCapabilities?: Iterable<string>, capabilityBindings: Record<string, string> = CAPABILITY_BOUND_SKILLS,
): InjectSkillsResult {
  let storeNames: string[];
  try {
    // Filtered through the SAME `isValidSkillName` predicate the manifest-entry sanitizer uses (card
    // 97e6a1c6 review): what we WRITE into the manifest must always be a subset of what the read side
    // accepts, or a store dir outside that shape gets recorded on spawn 1, dropped on spawn 2 (since
    // sanitizeManifestEntries rejects it), then permanently misread as "repo's own" — never refreshed,
    // never pruned, and logged as invalid on every subsequent spawn.
    storeNames = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).filter(isValidSkillName);
  } catch { return { claimedNames: [], claimedFingerprints: EMPTY_FINGERPRINTS }; } // no store yet
  const targetDir = claudeSkillsDir(cwd);
  const claudeDir = path.dirname(targetDir);
  // Refuse BEFORE any write if `.claude` or `.claude/skills` is a symlink/junction redirecting outside
  // this session's own cwd (card 5c3d0518, from the review of 97e6a1c6) — otherwise every injection write
  // below (mkdir, the skill copies, the manifest) lands on whatever that link points at instead of this
  // repo. Logged loudly and skipped for this session, never thrown into the spawn: the session still
  // boots, just without its injected skills, exactly like the existing "no store yet" early-return above
  // and the non-fatal catch around this call at its one call site (pty/host.ts).
  const escaped = escapedAncestor(cwd, [claudeDir, targetDir]);
  if (escaped) {
    console.log(`[skills] refusing injection: ${escaped.path} resolves to ${escaped.real}, outside this session's working directory (${cwd}) — skill injection skipped for this session`);
    return { claimedNames: [], claimedFingerprints: EMPTY_FINGERPRINTS };
  }
  fs.mkdirSync(targetDir, { recursive: true });

  // What THIS session should have present: a non-empty subset ∩ the store, else ALL store skills — EXCEPT
  // for a locked role, where "all" excludes an agent-written (or unstamped — fail closed) user skill
  // (card 509176c8; see this function's own doc comment + the decision record for why).
  //
  // @decision 509176c8 — round 2's `isTrustedBundledContent` check was CUT (round 3): it withheld
  // legitimate bundled skills (a pre-provenance customization, or a pristine copy ahead of reseed).
  //
  // @decision 9a3dea30 — round 2: `isBundledSkill(n)` flips true the instant an asset merges, before the
  // next boot's rename-aside fix ever runs, so a still-"agent"-stamped collision must stay excluded even
  // once isBundledSkill is true. Provenance-only — never content-equality (see the decision record).
  const isLockedRole = role != null && LOCKED_PROFILE_ROLES.has(role);
  // Card 31f997e7: a capability-bound skill (per `capabilityBindings`) is withheld from the deliver-all
  // default unless `grantedCapabilities` includes its required slug. Applies ONLY here (the no-subset
  // branch) — an explicit subset below bypasses this exactly like it already bypasses the locked-role
  // filter (509176c8), so this never narrows that branch.
  const grantedSlugs = grantedCapabilities instanceof Set ? grantedCapabilities : new Set(grantedCapabilities ?? []);
  // @decision 31f997e7 — a bound skill is delivered ONLY into a worktree-isolated cwd, whatever the
  // grant; see the decision record for why a grant-only gate orphans permanently.
  const passesCapabilityGate = (n: string) => {
    if (!Object.hasOwn(capabilityBindings, n)) return true; // unbound — never gated, regardless of cwd
    return isWorktreeCwd(cwd) && grantedSlugs.has(capabilityBindings[n]);
  };
  const want = subset && subset.length
    ? storeNames.filter((n) => subset.includes(n))
    : storeNames.filter((n) => (!isLockedRole || isTrustedForLockedRole(n)) && passesCapabilityGate(n));
  // FORCE-INCLUDE the role's operating-doctrine skill regardless of the subset (a profile whose subset
  // omits "worker"/"orchestrate"/… must still ship its role doctrine). Only when present in the store and
  // not already wanted; a no-subset session already has every store skill, so this only bites under a subset.
  //
  // For a LOCKED role, "force" must still respect the SAME provenance trust check the `want` filter above
  // already applies — otherwise an agent-stamped collision under the role's own doctrine name (the
  // 9a3dea30 shape) bypasses the locked-role filter entirely via this one path. Shares `isTrustedForLockedRole`
  // with the `want` filter above so the two can never diverge; a non-locked role is unaffected
  // (`!isLockedRole` short-circuits true).
  const roleSkill = role ? ROLE_DOCTRINE_SKILL[role] : undefined;
  if (roleSkill && storeNames.includes(roleSkill) && !want.includes(roleSkill)) {
    const roleSkillTrusted = !isLockedRole || isTrustedForLockedRole(roleSkill);
    if (roleSkillTrusted) want.push(roleSkill);
    else console.log(`[skills] withholding role-doctrine skill '${roleSkill}' from a locked role's session: its store copy is agent-written, not human/bundled-trusted`);
  }

  const manifestPath = path.join(targetDir, MANIFEST);
  const manifest = readManifest(manifestPath, sessionId);
  const fingerprintsPath = path.join(targetDir, FINGERPRINTS_FILE);
  const fingerprintsFile = readFingerprintsFile(fingerprintsPath);
  const fingerprints = fingerprintsFile.bySession; // mutated in place below (dead-sid prune, own entry) — same discipline as pre-round-2
  // Prune a manifest key for any OTHER session the caller-injected predicate says is not CURRENTLY
  // live/starting (card 9d73e537; see this function's own doc comment for why "live", not "resumable").
  // Never asked about our own key — this call IS that session, live, right now. A throw for one id is
  // swallowed and that entry is left alone (fail-safe), not treated as grounds to abandon the whole
  // prune pass. `deadClaimed`/`deadFingerprints` collect what each pruned key claimed (+ its recorded
  // fingerprint(s), if any), BEFORE it's deleted — card 31f997e7 CR round 2/3 consumes these below to
  // clean up a dead session's own copies in an isolated worktree cwd, ONLY when content still matches.
  //
  // CR round 4 (reviewer e11c6432) MINOR: iterate the UNION of both files' sids, not just `manifest`'s —
  // a sid present only in `fingerprints` (its manifest key already gone some other way) would otherwise
  // never get pruned from the sidecar and leak there forever.
  const deadClaimed = new Set<string>();
  // CR round 4 MINOR: a name -> SET of every dead claimant's recorded fingerprint for it, not a single
  // last-writer-wins value — a `Map<string,string>` made the cleanup's outcome depend on manifest key
  // iteration order whenever two different dead sids had claimed the SAME name with DIFFERENT recorded
  // fingerprints (e.g. dead A placed v1, dead B later re-copied v2 over it). Deleting when the CURRENT
  // fingerprint matches ANY dead claimant's is order-independent and still exactly as safe: every
  // candidate fingerprint in the set is itself a real Loom-placement record, never a guess.
  const deadFingerprints = new Map<string, Set<string>>();
  if (isSessionLive) {
    const allSids = new Set([...Object.keys(manifest), ...Object.keys(fingerprints)]);
    for (const sid of allSids) {
      if (sid === sessionId) continue;
      let live = true;
      try { live = isSessionLive(sid); } catch { /* fail-safe: keep this entry on error */ }
      if (!live) {
        for (const n of manifest[sid] ?? []) {
          deadClaimed.add(n);
          const fp = fingerprints[sid]?.[n];
          if (fp) {
            let set = deadFingerprints.get(n);
            if (!set) { set = new Set(); deadFingerprints.set(n, set); }
            set.add(fp);
          }
        }
        delete manifest[sid];
        delete fingerprints[sid];
      }
    }
  }
  const myPrev = manifest[sessionId] ?? [];
  // Union of every OTHER session's injected skills sharing this cwd — these must NEVER be stripped here
  // and are NOT the repo's own (the landmine-2 invariant: concurrent sessions share project.repoPath).
  const otherClaimed = new Set<string>();
  for (const [sid, ns] of Object.entries(manifest)) if (sid !== sessionId) for (const n of ns) otherClaimed.add(n);

  // In an ISOLATED worktree cwd, a just-pruned dead session's manifest-claimed dirs are CANDIDATES for
  // cleanup — closing the worktree-REUSE orphan (a stopped/rejected worker's worktree reused by a
  // re-dispatch, possibly to a different agent with different grants; `git reset --hard` never touches
  // untracked `.claude/skills`). `deadClaimed` is built exclusively from a dead session's OWN manifest
  // entry, so a repo/user dir (never recorded in any session's manifest — see the "repo's own" skip
  // below) is never even a candidate. But being claimed is a fact about when Loom placed it, not about
  // what's there NOW: a worker may have hand-edited a FILE, or added one, since. CR round 3 (reviewer
  // 085065b7) found the round-2 cleanup deleted that work outright — the owner's standing rule is never
  // to destroy unfinished work, and a bare "it's in the manifest" was never proof the content was still
  // Loom's own. A delete now requires the dir's CURRENT content fingerprint to match ANY ONE of the
  // fingerprints recorded by a dead claimant of this name (`fingerprintSkillDir`, `deadFingerprints` —
  // see that Map's own doc for why a SET, not one value) — any mismatch, or no recorded fingerprint at
  // all (a legacy pre-round-3 claim), SKIPS the delete and leaves an orphan rather than risk data loss.
  // Named residual (CR round 4 nit — `fingerprintSkillDir` only hashes regular FILE bytes): adding a
  // symlink/junction child, or an empty subdirectory, changes neither the fingerprint nor the FILE
  // content it covers, so a dir modified ONLY that way is still deleted — the symlink's own target is
  // never touched either way (`fs.rmSync` on a symlink removes the link, never follows it).
  //
  // @decision 31f997e7 — never a shared cwd (card f4e93dbf's scope); never a dir outside a dead session's
  // own recorded claim; never a dir whose current content fingerprint matches none of that claim's
  // recorded fingerprints.
  //
  // @decision f4e93dbf — widens the above to a shared (non-worktree) cwd too, but NEVER by deleting; see
  // the decision record for the full two-pass mechanism and residuals.
  const reclaimableNow = new Set<string>();
  // The persisted "remember the orphan" half of round 2 (never populated for a worktree cwd — see the
  // "Do not" list: that path stays a single-call unconditional delete, exactly as 31f997e7 shipped it).
  // Keyed by skill name; `deadFingerprints` as a live `Set` while this call computes, converted back to
  // a plain array only at the write-back below.
  const pendingWorking = new Map<string, { deadFingerprints: Set<string>; firstSeenAt: number }>();
  if (isWorktreeCwd(cwd)) {
    for (const stale of deadClaimed) {
      if (otherClaimed.has(stale)) continue; // a still-live session (e.g. a sibling fork) legitimately needs it
      const recordedFps = deadFingerprints.get(stale);
      if (!recordedFps || recordedFps.size === 0) { console.log(`[skills] keeping dead-session claim '${stale}': no recorded content fingerprint (a legacy claim) — cannot verify it's still Loom's own, so not deleting`); continue; }
      const target = path.join(targetDir, stale);
      const currentFp = fingerprintSkillDir(target);
      if (!currentFp || !recordedFps.has(currentFp)) { console.log(`[skills] keeping dead-session claim '${stale}': on-disk content doesn't match any recorded Loom placement (edited, or files added) — not deleting`); continue; }
      if (path.dirname(target) !== targetDir) { console.log(`[skills] refusing to remove out-of-scope dead-session manifest entry: ${stale}`); continue; }
      try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  } else {
    // Seed this call's working set from whatever the sidecar already had pending, then merge in anything
    // THIS call's own prune just discovered (`deadClaimed`/`deadFingerprints` — typically gone again by
    // the time a later call runs, which is exactly why the persisted record below exists at all).
    for (const [name, rec] of Object.entries(fingerprintsFile.pending)) {
      pendingWorking.set(name, { deadFingerprints: new Set(rec.deadFingerprints), firstSeenAt: rec.firstSeenAt });
    }
    for (const stale of deadClaimed) {
      const recordedFps = deadFingerprints.get(stale);
      if (!recordedFps || recordedFps.size === 0) {
        if (!pendingWorking.has(stale)) console.log(`[skills] keeping dead-session claim '${stale}' (shared cwd): no recorded content fingerprint (a legacy claim) — cannot verify it's still Loom's own, so not reclaiming`);
        continue; // never trusted, with or without a pending record — same posture as before round 2
      }
      const existing = pendingWorking.get(stale);
      if (existing) for (const fp of recordedFps) existing.deadFingerprints.add(fp);
      else pendingWorking.set(stale, { deadFingerprints: new Set(recordedFps), firstSeenAt: Date.now() });
    }

    // Resolve (or carry forward) every candidate this call knows about — freshly discovered above, or
    // already pending from a prior call. `nowMs` is read ONCE per call (not per candidate) via a bare
    // `Date.now()` — a test overrides the global the same way `temp-path-collision-guard.mjs` does.
    const nowMs = Date.now();
    for (const [name, rec] of [...pendingWorking]) {
      if (otherClaimed.has(name)) { pendingWorking.delete(name); continue; } // resolved: a live session claims it
      const target = path.join(targetDir, name);
      if (path.dirname(target) !== targetDir) { console.log(`[skills] refusing to reclaim out-of-scope dead-session manifest entry (shared cwd): ${name}`); pendingWorking.delete(name); continue; }
      if (!fs.existsSync(target)) { pendingWorking.delete(name); continue; } // resolved: the dir is gone
      const currentFp = fingerprintSkillDir(target);
      if (!currentFp || !rec.deadFingerprints.has(currentFp)) {
        console.log(`[skills] keeping dead-session claim '${name}' (shared cwd): on-disk content doesn't match any recorded Loom placement (edited, or files added) — not reclaiming`);
        pendingWorking.delete(name); // resolved: edited — drop the record and never touch it again
        continue;
      }
      if (nowMs - rec.firstSeenAt > PENDING_RECLAIM_MAX_AGE_MS) {
        console.log(`[skills] giving up on dead-session claim '${name}' (shared cwd): still unresolved after the ${PENDING_RECLAIM_MAX_AGE_MS}ms age bound — dropping the pending-reclaim record, never acting on it again`);
        pendingWorking.delete(name);
        continue;
      }

      // @decision f4e93dbf — consume/reclaim ONLY when `want` includes `name`; a session that doesn't
      // want this name leaves the cache entry / pending record untouched for a later caller that does.
      const innermostRoot = innermostGitRepoRoot(target);
      if (!innermostRoot) {
        // No repo anywhere up-tree from the skill dir itself ⇒ no tracked-file risk to check at all.
        if (want.includes(name)) { reclaimableNow.add(name); pendingWorking.delete(name); }
        continue;
      }
      const key = untrackedCacheKey(cwd, name);
      const cacheEntry = verifiedUntrackedCache.get(key);
      if (cacheEntry) {
        if (cacheEntry.expiresAt <= nowMs || cacheEntry.fingerprint !== currentFp) {
          verifiedUntrackedCache.delete(key); // stale or invalidated by an edit since it was kicked — a wrong fact is never worth keeping, for anyone
        } else if (want.includes(name)) {
          verifiedUntrackedCache.delete(key); // consume exactly once
          reclaimableNow.add(name);
          pendingWorking.delete(name); // resolved
          continue;
        } else {
          continue; // valid + unconsumed — leave both the cache entry and the pending record for a later caller
        }
      }
      // No fresh verified-untracked fact available (never existed, just expired, or just invalidated
      // above) — kick a check, regardless of `want`, so a future caller's cache is warm by the time it
      // asks. `kickUntrackedCheck` dedupes its own in-flight calls; never touches `target` this call.
      kickUntrackedCheck(cwd, name, currentFp, innermostRoot, target);
    }

    // Bound the per-cwd bookkeeping: drop the OLDEST entries beyond the cap, deterministically
    // (firstSeenAt ascending, name tiebreak) — defensive, practically never hit in a real project.
    if (pendingWorking.size > PENDING_RECLAIM_MAX_PER_CWD) {
      const overflow = [...pendingWorking.keys()]
        .sort((a, b) => (pendingWorking.get(a)!.firstSeenAt - pendingWorking.get(b)!.firstSeenAt) || a.localeCompare(b))
        .slice(0, pendingWorking.size - PENDING_RECLAIM_MAX_PER_CWD);
      for (const name of overflow) {
        console.log(`[skills] dropping pending-reclaim record for '${name}' (shared cwd): over the per-cwd cap of ${PENDING_RECLAIM_MAX_PER_CWD} — never acting on it`);
        pendingWorking.delete(name);
      }
    }
  }

  // Read the Obsidian preflight fragment ONCE, and ONLY when the project enabled it AND a fragment-target
  // skill is actually being delivered — so with obsidian.autoStart off (the default) this asset is never
  // touched and every injected file is byte-identical to the store base. A missing/unreadable fragment
  // degrades to the short base skill (best-effort; the fragment is a pure enhancement).
  let obsidianFragment: string | null = null;
  if (obsidianEnabled && want.some((n) => OBSIDIAN_FRAGMENT_SKILLS.has(n))) {
    try { obsidianFragment = fs.readFileSync(OBSIDIAN_PREFLIGHT_FRAGMENT, "utf8"); }
    catch (e) { console.log(`[skills] obsidian preflight fragment unavailable at ${OBSIDIAN_PREFLIGHT_FRAGMENT}: ${(e as Error).message}`); }
  }

  const placed: string[] = [];
  const failed: string[] = [];
  // CR round 3 (card 31f997e7): the content fingerprint recorded for EVERY name this call places —
  // computed AFTER the obsidian-fragment append below, so it's the FINAL bytes Loom actually left on
  // disk, not an intermediate state. Replaces (never merges with) this session's prior fingerprint
  // entry, mirroring how `placed` fully replaces `myPrev` below.
  const placedFingerprints: Record<string, string> = {};
  for (const name of want) {
    const dest = path.join(targetDir, name);
    const exists = fs.existsSync(dest);
    // A pre-existing dir that NO loom session claims (not mine, not another session's) is the repo's OWN
    // project-local skill — never clobber it. A dir another session injected IS loom's: re-copying the
    // same store content is idempotent and harmless. `reclaimableNow` (card f4e93dbf): a verified
    // dead-claim orphan, already confirmed untracked — treat it as claimed too, so this same copy path
    // performs its own atomic replace over it (never a separate delete first).
    if (exists && !myPrev.includes(name) && !otherClaimed.has(name) && !reclaimableNow.has(name)) continue;
    const src = path.join(SKILLS_DIR, name);
    // COPY (atomic tmp+swap), never junction: a junction here lets worktree removal's recursive rm follow
    // it into the store and delete the store's SKILL.md (see header). An independent copy is self-contained.
    // A copy that ultimately fails is recorded (`failed`) and surfaced below — NOT silently skipped, which
    // would let the session run WITHOUT its pinned doctrine skill.
    if (copySkillAtomic(src, dest)) {
      // @decision 51a2462a round 2 — a strip failure is now treated exactly like a copy failure (remove
      // dest, record failed, never fingerprint), never the old fail-open shape. Round 3: the removal
      // itself is fail-safe (see `quarantineUndeliverableDest`'s own doc), not a bare best-effort rm.
      if (needsPermissionStrip(name, dest) && !stripPermissionWideningFile(dest)) {
        quarantineUndeliverableDest(dest, name, claudeDir);
        failed.push(name);
        continue;
      }
      placed.push(name);
      // ONLY the fragment-target skills, and ONLY when enabled + the fragment loaded. Runs after the fresh
      // base copy (copySkillAtomic re-copies the fragment-free store base first), so the append lands once.
      if (obsidianFragment && OBSIDIAN_FRAGMENT_SKILLS.has(name)) appendObsidianFragment(dest, obsidianFragment);
      const fp = fingerprintSkillDir(dest);
      if (fp) {
        placedFingerprints[name] = fp; // absent (fingerprint failed) ⇒ a future dead-claim read sees it as unverifiable, never as a false match
        recordLoomPlacedFingerprint(cwd, name, fp); // CR round 4, item 3 — daemon-side, never disk-read
      }
    } else failed.push(name);
  }

  // Prune ONLY skills I previously injected that I no longer want — and only when no OTHER session still
  // claims them. This is what makes a subset change / store deletion safe under a shared cwd: removing my
  // stale skills can never strip a concurrent session's (nor the repo's own, which is in no manifest).
  for (const stale of myPrev) {
    if (want.includes(stale)) continue;        // still want it (placed this run, or a repo collision left alone)
    if (otherClaimed.has(stale)) continue;     // a concurrent session still needs it — keep
    const target = path.join(targetDir, stale);
    // Defense in depth (card 97e6a1c6): `myPrev` is already sanitized by readManifest, so this should
    // never trip in practice — but never rmSync anything that isn't a DIRECT CHILD of targetDir, in case
    // a future manifest source (or a validation bug) ever lets something else through.
    if (path.dirname(target) !== targetDir) { console.log(`[skills] refusing to prune out-of-scope manifest entry: ${stale}`); continue; }
    try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  manifest[sessionId] = placed; // record ONLY what I actually injected (never the repo's own / collisions)
  // Atomic manifest write (tmp+rename, like store.ts): a torn write here corrupts the shared per-session
  // record — readManifest then has to discard it, losing every concurrent session's claims. Writing to a
  // tmp and renaming means a reader sees either the old whole map or the new whole map, never a half file.
  // UNCHANGED shape by card 31f997e7 round 3 — see readManifest's own doc for why.
  const manifestTmp = `${manifestPath}.tmp`;
  try {
    fs.writeFileSync(manifestTmp, JSON.stringify(manifest));
    fs.renameSync(manifestTmp, manifestPath);
  } catch (e) {
    console.log(`[skills] failed to write manifest ${manifestPath}: ${(e as Error).message}`);
    try { fs.rmSync(manifestTmp, { force: true }); } catch { /* best effort */ }
  }

  // CR round 3: the fingerprints sidecar (separate file, separate atomic write — see FINGERPRINTS_FILE's
  // own doc for why it's never merged into MANIFEST's shape). Same tmp+rename discipline.
  fingerprints[sessionId] = placedFingerprints; // full replace, same as `placed` above
  // @decision f4e93dbf — `pendingWorking` (resolved entries removed, unresolved/carried-forward ones
  // kept, as computed above) is what gets persisted here; a worktree cwd never populated it, so it
  // serializes to nothing and the reserved key is omitted entirely, same as before this card.
  const pendingOut: PendingReclaimMap = {};
  for (const [name, rec] of pendingWorking) pendingOut[name] = { deadFingerprints: [...rec.deadFingerprints], firstSeenAt: rec.firstSeenAt };
  const fingerprintsOut = serializeFingerprintsFile(fingerprints, pendingOut);
  const fingerprintsTmp = `${fingerprintsPath}.tmp`;
  try {
    fs.writeFileSync(fingerprintsTmp, JSON.stringify(fingerprintsOut));
    fs.renameSync(fingerprintsTmp, fingerprintsPath);
  } catch (e) {
    console.log(`[skills] failed to write fingerprints file ${fingerprintsPath}: ${(e as Error).message}`);
    try { fs.rmSync(fingerprintsTmp, { force: true }); } catch { /* best effort */ }
  }
  hideFromGit(cwd, [...placed, MANIFEST, FINGERPRINTS_FILE]);

  // Surface any copy that never landed (after persisting the manifest + git-hide for what DID land, so the
  // partial success is recorded and recoverable). The caller treats this as non-fatal but it's now VISIBLE
  // in the daemon log instead of a silent missing-skill.
  if (failed.length) throw new Error(`injectSkills: failed to deliver ${failed.length} skill(s) to ${targetDir}: ${failed.join(", ")}`);
  // CR round 4 (card 015fdb23, finding 3): read from the DAEMON-SIDE registry (`loomPlacedFingerprintsByCwd`
  // above) for THIS cwd, never from the on-disk `fingerprints` sidecar — that file lives inside the very
  // directory the cwd-skill permission scan reads, so anything able to write `evil/SKILL.md` there could
  // also forge a sidecar entry claiming Loom placed it. The registry can only ever have been populated by
  // THIS process's own placements (see `recordLoomPlacedFingerprint`), so a forged on-disk entry for a
  // name this process never actually placed here has no matching set and so is NOT excluded from the scan.
  const claimedNames = [...new Set([...placed, ...otherClaimed])];
  const registry = loomPlacedFingerprintsByCwd.get(comparisonKey(cwd)); // card 22813c50 (M1) — same key shape as the write side
  const claimedFingerprints = new Map<string, Set<string>>();
  if (registry) {
    for (const name of claimedNames) {
      const set = registry.get(name);
      if (set && set.size) claimedFingerprints.set(name, new Set(set));
    }
  }
  return { claimedNames, claimedFingerprints };
}

/** Append local git-ignore patterns for the injected skill dirs + manifest, PLUS Claude Code's own
 *  `.claude/settings.local.json` (written by acceptEdits permission persistence — a Loom worktree never
 *  writes this itself, but it lands in every worker's `.claude/` regardless and a blind `git add -A`
 *  would otherwise stage it onto the worker's branch) — resolving through a linked worktree to the shared
 *  common dir ({@link resolveGitDirsSync}'s `commonDir`, git/repo-lock.ts) so a worktree-cwd session
 *  (every worker) hides both too, not just a repoPath-cwd session (manager/platform/setup/auditor).
 *  Deliberately just the ONE settings file, not all of `.claude/` — a repo may track a shared
 *  `.claude/settings.json` that must stay visible to git. `info/exclude` is not one of the handful of
 *  files git keeps per-worktree (HEAD, index, logs/HEAD, …) — it lives in the common dir and git resolves
 *  it there for every linked worktree too, so a write here takes effect for `git status` in the worktree
 *  immediately, no per-worktree copy needed. */
function hideFromGit(cwd: string, entries: string[]): void {
  const gitDir = resolveGitDirsSync(cwd)?.commonDir ?? null;
  if (!gitDir) return; // no .git resolvable — nothing to hide from
  const infoDir = path.join(gitDir, "info");
  try { fs.mkdirSync(infoDir, { recursive: true }); } catch { /* ignore */ }
  const excludePath = path.join(infoDir, "exclude");
  let cur = ""; try { cur = fs.readFileSync(excludePath, "utf8"); } catch { /* none */ }
  const want = doctrineGitExcludeEntries(entries);
  const missing = want.filter((p) => !cur.split(/\r?\n/).includes(p));
  if (missing.length === 0) return;
  const prefix = cur === "" || cur.endsWith("\n") ? "" : "\n";
  try { fs.appendFileSync(excludePath, `${prefix}# loom-managed exclusions (injected per session; do not commit)\n${missing.join("\n")}\n`); } catch { /* ignore */ }
}
