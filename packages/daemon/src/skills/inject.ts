import fs from "node:fs";
import path from "node:path";
import os from "node:os";
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
import { writeJsonAtomic } from "../write-json-atomic.js";

const MANIFEST = ".loom-skills.json"; // records which skill names EACH session injected into the doctrine dir's skills subtree
// CR round 3 (card 31f997e7): a SEPARATE sidecar file, never merged into MANIFEST's own shape — keeps
// every existing reader of MANIFEST (several other test files parse it directly) byte-for-byte
// unaffected, and needs no legacy-format handling of its own (nothing pre-dates it). Absent (an old
// worktree this version hasn't touched yet) ⇒ no fingerprints for anything in it, same as a parse error.
const FINGERPRINTS_FILE = ".loom-skills-fingerprints.json";
// card 4c2a0bfd: writeJsonAtomic's tmp name is `${filePath}.${pid}.${randomUUID()}.loom.tmp` — unique
// EVERY call, unlike the old fixed `.tmp` suffix it replaces. A crash between its write and its rename
// used to self-heal (the next successful write reused + overwrote the SAME fixed name); a unique name
// never gets reused, so a crash-stranded one needs its own (globbed — the pid/uuid differ every call)
// git-exclude entry below `hideFromGit`'s existing per-cwd `entries` array already carries bare
// non-skill names (MANIFEST, FINGERPRINTS_FILE) through, or it accumulates as permanent untracked noise
// in the worktree forever instead of the old scheme's at-most-one self-overwriting orphan.
const MANIFEST_TMP_GLOB = `${MANIFEST}.*.loom.tmp`;
const FINGERPRINTS_TMP_GLOB = `${FINGERPRINTS_FILE}.*.loom.tmp`;

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
 * @decision 31f997e7 — single-purpose now (card f4272888): the overwrite/delete gate reads only the
 * persisted `__lastPlaced` sidecar fact, never this map; see the record's "CARD f4272888" section for why.
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
// card f4e93dbf round 3 (card d467d56d): how long a NEGATIVE outcome (confirmed tracked, or the check
// itself failed/was refused) backs off before the NEXT injectSkills call at this (cwd, name) is allowed
// to kick a fresh git subprocess again. Deliberately much longer than UNTRACKED_CACHE_TTL_MS (that one
// bounds a race window; this one bounds REPEATED COST) but still finite and far shorter than
// PENDING_RECLAIM_MAX_AGE_MS — a negative outcome is NEVER treated as permanent: a genuinely-untracked
// dir whose check merely failed once (a timeout, a transient lock) is re-verified on this cadence rather
// than abandoned for the life of the daemon process, and a genuinely, durably tracked dir just costs one
// re-check per window instead of one per call.
const NEGATIVE_CHECK_BACKOFF_MS = 60 * 60 * 1000; // 1 hour

interface UntrackedCheckEntry { readonly fingerprint: string; readonly expiresAt: number; readonly negative?: boolean; }
/** `${cwd}\u0000${name}` -> either (a) the fingerprint that was confirmed UNTRACKED, plus when that
 *  confirmation expires (`negative` absent/false) — a genuine reclaim opportunity — or (b) `negative:true`
 *  (card d467d56d): the fingerprint was confirmed TRACKED, or the check itself failed/was refused, for
 *  this exact content, backing off for {@link NEGATIVE_CHECK_BACKOFF_MS} before the next call may kick a
 *  fresh check again. NEVER a permanent "stop asking" — only `expiresAt`-bounded, so a failed check is
 *  retried on a cadence rather than abandoned, and the pending-reclaim record itself is left entirely
 *  untouched while backing off (this cache entry is the ONLY thing a negative outcome writes). NUL-
 *  separated so neither half can ever be ambiguous about where it ends (a skill name is already a
 *  validated kebab slug with no NUL byte; `cwd` is a filesystem path, same reasoning). This cache holds
 *  ONLY a verified CHECK OUTCOME (reclaimable or not), never "an orphan is worth checking at all" — that
 *  is the separate, disk-persisted {@link PendingReclaimMap} below, which has no TTL of its own and
 *  survives across (and past) this cache's own entries.
 *
 *  @decision f4e93dbf round 2 — the 60s TTL applies ONLY to the reclaimable (untracked) fact, never to
 *  the fact that an orphan exists at all; see the decision record for the gap this split closes.
 *
 *  @decision f4e93dbf — a `negative:true` entry is read regardless of `want` (it is never a reclaim
 *  opportunity for anyone to consume) but still expires — see the decision record's own section for why
 *  "tracked" and "check failed" share one bounded backoff instead of a permanent resolution. */
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
/** Bounded cache-write, shared by every outcome {@link kickUntrackedCheck} can produce — the single
 *  place that enforces {@link UNTRACKED_CACHE_MAX_ENTRIES}, so a `negative:true` backoff write (now far
 *  more frequent than before card d467d56d, since it fires for every tracked/failed check too) can't
 *  drift from the reclaimable-fact write's own eviction policy. */
function cacheCheckResult(key: string, entry: UntrackedCheckEntry): void {
  if (verifiedUntrackedCache.size >= UNTRACKED_CACHE_MAX_ENTRIES) {
    const oldestKey = verifiedUntrackedCache.keys().next().value;
    if (oldestKey !== undefined) verifiedUntrackedCache.delete(oldestKey); // defensive eviction; practically never hit
  }
  verifiedUntrackedCache.set(key, entry);
}

function kickUntrackedCheck(cwd: string, name: string, fingerprint: string, repoRoot: string, target: string): void {
  const key = untrackedCacheKey(cwd, name);
  if (inFlightTrackChecks.has(key)) return; // already checking this exact (cwd, name) — don't pile on another
  const pathspec = path.relative(repoRoot, target).split(path.sep).join("/");
  const run = (async () => {
    try {
      const git = canonicalGit(repoRoot, UNTRACKED_CHECK_TIMEOUT_MS);
      const out = await withTimeout(git.raw(["ls-files", "--", pathspec]), UNTRACKED_CHECK_TIMEOUT_MS, "git ls-files (skill dead-claim reclaim check)");
      if (out.trim() === "") {
        cacheCheckResult(key, { fingerprint, expiresAt: Date.now() + UNTRACKED_CACHE_TTL_MS });
      } else {
        // At least one file under it is git-tracked. Back off rather than cache nothing — without this,
        // every future injectSkills call at this cwd re-kicked a fresh git subprocess for up to
        // PENDING_RECLAIM_MAX_AGE_MS (30 days) for a dir unlikely to become reclaimable soon. Bounded, not
        // permanent: a later content change (a different fingerprint), or the backoff simply expiring,
        // re-checks from scratch — see NEGATIVE_CHECK_BACKOFF_MS's own doc for why.
        //
        // @decision f4e93dbf — cache a confirmed-tracked result as a bounded backoff, never nothing.
        console.log(`[skills] dead-claim reclaim: '${name}' at ${cwd} is git-tracked — backing off for ${NEGATIVE_CHECK_BACKOFF_MS}ms before checking again`);
        cacheCheckResult(key, { fingerprint, expiresAt: Date.now() + NEGATIVE_CHECK_BACKOFF_MS, negative: true });
      }
    } catch (e) {
      // A FAILED check (a timeout, or canonicalGit's own fail-closed refusal — e.g. a FILE-shaped
      // `.git`, see the decision record's named residual) gets the SAME bounded backoff as a confirmed-
      // tracked result — never a permanent give-up, since the failure could be transient (unlike a
      // confirmed-tracked result, which we actually know for a fact).
      //
      // @decision f4e93dbf — cache a failed/refused check as a bounded backoff too, same as tracked.
      console.log(`[skills] dead-claim reclaim: git-tracked check failed for '${name}' at ${cwd} (backing off for ${NEGATIVE_CHECK_BACKOFF_MS}ms before checking again): ${(e as Error)?.message ?? e}`);
      cacheCheckResult(key, { fingerprint, expiresAt: Date.now() + NEGATIVE_CHECK_BACKOFF_MS, negative: true });
    } finally {
      inFlightTrackChecks.delete(key);
    }
  })();
  inFlightTrackChecks.set(key, run);
}

const PENDING_RECLAIM_KEY = "__pendingReclaim"; // reserved top-level key in FINGERPRINTS_FILE; never a real session id
const PENDING_RECLAIM_MAX_PER_CWD = 200; // defensive cap — practically never hit (mirrors UNTRACKED_CACHE_MAX_ENTRIES's own framing)
const PENDING_RECLAIM_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — generous; bounds disk growth for an orphan nobody ever asks for again, not a safety mechanism

// card 3b2a8707 Code Review round 3: a SECOND reserved top-level key in FINGERPRINTS_FILE, same posture
// as PENDING_RECLAIM_KEY (never a real session id — see readFingerprintsFile/serializeFingerprintsFile).
const LAST_PLACED_KEY = "__lastPlaced";
// Cap on how many distinct fingerprints lastPlaced.get(name) may hold at once. A normal write (a real
// placement) REPLACES the whole entry with ONE element (card f4272888); more than one can occur only
// transiently, from readFingerprintsFile's one-shot fold of a pre-card legacy per-session record — see
// that function's own doc.
const LAST_PLACED_MAX_FPS_PER_NAME = 8;

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
/** skill name -> record. A `Map` (card f4272888), same reasoning as {@link Manifest} — the name is
 *  read from the same untrusted sidecar file, and a `Map` has no `"__proto__"` bracket-assignment hazard. */
type PendingReclaimMap = Map<string, PendingReclaimRecord>;

/** TEST-ONLY. Awaits every currently in-flight {@link kickUntrackedCheck} call. Production code never
 *  calls this — every real caller fires the check and walks away; awaiting it here would reintroduce the
 *  exact spawn-hot-path block this whole mechanism exists to avoid. Named with the double-underscore
 *  prefix + a full descriptive name specifically so it reads as what it is at every call site, including
 *  an accidental one. */
export async function __awaitPendingSkillTrackChecks(): Promise<void> {
  await Promise.all([...inFlightTrackChecks.values()]);
}

// card 8b38b920: a THIRD reserved top-level key in FINGERPRINTS_FILE, same posture as PENDING_RECLAIM_KEY/
// LAST_PLACED_KEY (never a real session id). Durably records that Loom has stopped managing a (cwd, name)
// copy — the gap the card closes: every release site below used to ONLY console.log at the moment it
// happened, with nothing a human could read later.
const RELEASED_KEY = "__released";
const RELEASED_MAX_PER_CWD = 200; // same defensive-cap posture as PENDING_RECLAIM_MAX_PER_CWD

/** Why a (cwd, name) copy is no longer managed:
 *  - "modified" — Loom recorded a fingerprint for a real past placement, but the on-disk content no
 *    longer matches it (a hand edit, a force-add, a tracked same-named replacement).
 *  - "unverifiable-legacy" — a dead claimant's manifest entry named it, but no fingerprint was ever
 *    recorded for it at all (a pre-f4272888 legacy claim) — Loom genuinely cannot tell modified from
 *    untouched here, so it never even attempts the content comparison (see `matchesRecordedFingerprint`'s
 *    own doc on the two existing dead-claim call sites never passing a `storeFallback`).
 *  - "abandoned" — a shared-cwd dead-claim orphan that Loom gave up verifying as safe to reclaim (the
 *    30-day age bound, or the per-cwd pending-reclaim cap) — content may be byte-identical to Loom's own
 *    placement; this is NOT a claim that a human edited it, just that Loom stopped trying. */
export type ReleaseReason = "modified" | "unverifiable-legacy" | "abandoned";
/** `firstSeenAt` is set once, on first release, and never refreshed by a later call that merely re-
 *  confirms the same release — same discipline as {@link PendingReclaimRecord.firstSeenAt}. */
interface ReleasedRecord { readonly reason: ReleaseReason; readonly firstSeenAt: number; }
type ReleasedMap = Map<string, ReleasedRecord>;

/** Record (or re-affirm, without disturbing `firstSeenAt`) that `name` at `cwd` is no longer managed.
 *  Bounded the same way `pendingWorking` is bounded in `injectSkills`'s shared-cwd block (oldest
 *  `firstSeenAt` evicted first) — see the eviction call at the end of `injectSkills`. */
function recordReleased(released: ReleasedMap, name: string, reason: ReleaseReason): void {
  if (released.has(name)) return; // keep the original firstSeenAt + reason; a repeat sighting is not a new event
  released.set(name, { reason, firstSeenAt: Date.now() });
}

/** Clear a stale `__released` record the moment `name` is legitimately (re)placed or pruned — e.g. a
 *  hand-reverted copy whose content now matches Loom's own placement again, or a human's explicit
 *  re-adopt. Logged, never silent: a copy resuming Loom management (or finally being pruned) after being
 *  released is exactly the kind of state change this whole card exists to make visible. No-op if nothing
 *  was recorded. */
function clearReleased(released: ReleasedMap, name: string, cwd: string, how: string): void {
  if (!released.delete(name)) return;
  console.log(`[skills] '${name}' at ${cwd} is Loom-managed again (${how}) — cleared its released record`);
}

/** Drop the oldest-by-`firstSeenAt` entries beyond {@link RELEASED_MAX_PER_CWD} — defensive, practically
 *  never hit in a real project (mirrors the pending-reclaim cap eviction in `injectSkills`). */
function boundReleased(released: ReleasedMap): void {
  if (released.size <= RELEASED_MAX_PER_CWD) return;
  const overflow = [...released.keys()]
    .sort((a, b) => (released.get(a)!.firstSeenAt - released.get(b)!.firstSeenAt) || a.localeCompare(b))
    .slice(0, released.size - RELEASED_MAX_PER_CWD);
  for (const name of overflow) released.delete(name);
}

function sanitizeReleasedRecord(raw: unknown): ReleasedRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as { reason?: unknown; firstSeenAt?: unknown };
  if (r.reason !== "modified" && r.reason !== "unverifiable-legacy" && r.reason !== "abandoned") return null;
  if (typeof r.firstSeenAt !== "number" || !Number.isFinite(r.firstSeenAt) || r.firstSeenAt < 0) return null;
  return { reason: r.reason, firstSeenAt: r.firstSeenAt };
}

function sanitizeReleasedMap(raw: unknown): ReleasedMap {
  const out: ReleasedMap = new Map();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [name, rec] of Object.entries(raw as Record<string, unknown>)) {
    if (!isSafeManifestEntry(name)) continue;
    const sanitized = sanitizeReleasedRecord(rec);
    if (sanitized) out.set(name, sanitized);
  }
  return out;
}

// A FOURTH reserved top-level key: names a skill a human has explicitly re-adopted (the REST path below)
// but that no LIVE session's manifest claims yet — bridging `injectSkills`'s own "unclaimed dir = the
// repo's own, never touch it" default (see the `want`-loop's early skip) until the next live session at
// this cwd actually claims it. Resolves (clears) the moment that happens — see the `want` loop's success
// branch. Same bounded-cap posture as the other reserved keys.
const READOPTED_KEY = "__readopted";
const READOPTED_MAX_PER_CWD = 200;
interface ReadoptedRecord { readonly firstSeenAt: number; }
type ReadoptedMap = Map<string, ReadoptedRecord>;

function sanitizeReadoptedMap(raw: unknown): ReadoptedMap {
  const out: ReadoptedMap = new Map();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [name, rec] of Object.entries(raw as Record<string, unknown>)) {
    if (!isSafeManifestEntry(name)) continue;
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) continue;
    const firstSeenAt = (rec as { firstSeenAt?: unknown }).firstSeenAt;
    if (typeof firstSeenAt !== "number" || !Number.isFinite(firstSeenAt) || firstSeenAt < 0) continue;
    out.set(name, { firstSeenAt });
  }
  return out;
}

function boundReadopted(readopted: ReadoptedMap): void {
  if (readopted.size <= READOPTED_MAX_PER_CWD) return;
  const overflow = [...readopted.keys()]
    .sort((a, b) => (readopted.get(a)!.firstSeenAt - readopted.get(b)!.firstSeenAt) || a.localeCompare(b))
    .slice(0, readopted.size - READOPTED_MAX_PER_CWD);
  for (const name of overflow) readopted.delete(name);
}

/** The skills whose injected SKILL.md gets the Obsidian "vault preflight" fragment appended — and ONLY
 *  these — when the session's project has `obsidian.autoStart` on. Every other skill is untouched. */
const OBSIDIAN_FRAGMENT_SKILLS = new Set(["loom-pickup", "loom-session-end"]);

/** Generic slug→skill-name binding (agent-tooling P4 phase 2): a bound skill is withheld from the
 *  deliver-all default unless (a) `cwd` is a worktree-isolated cwd (see `isWorktreeCwd` below) AND (b)
 *  the session's resolved capabilities include the named slug — see `injectSkills`'s own doc comment for
 *  the full mechanism and residuals. `Object.create(null)`, not `{}` (mirrors `store.ts`'s
 *  `emptyProvenanceMap`), paired with `passesCapabilityGate`'s own `Object.hasOwn` read: neither a lookup
 *  here nor a caller-supplied override can resolve a prototype property name ("constructor" and friends)
 *  as if it were a real binding.
 *
 *  Card 00a7d511: `loom-shadcn` is the first real entry — a generic doctrine skill delivered only to a
 *  session granted the `shadcn` capability (`capabilities/seed.ts`'s "shadcn" row).
 *
 *  @decision 31f997e7 — this gate is delivery hygiene, NOT a security boundary; never the only thing
 *  standing between an agent and a capability. See the decision record for the full mechanism. */
export const CAPABILITY_BOUND_SKILLS: Record<string, string> = Object.assign(Object.create(null), {
  "loom-shadcn": "shadcn",
});

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
 *  assistant/null). The single source for both harnesses' role→doctrine mapping. */
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

/** Per-session injected-skill record for a shared `.claude/skills`: `sessionId -> ["worker", …]`.
 *  Keyed by session so a concurrent session sharing the cwd never strips another's (or the repo's) skills.
 *  A `Map`, not a plain object (card f4272888) — `sessionId` is read straight from an untrusted,
 *  committable file, and a top-level JSON key literally named `"__proto__"` would otherwise reach a
 *  bracket-assignment write (`out[sid] = …`) and reassign the WHOLE manifest's prototype instead of
 *  creating an entry; a `Map.set` has no such hazard for any key, including that one. */
type Manifest = Map<string, string[]>;

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

/** Shared chokepoint (card 8b38b920 CR fix round, item 2): resolve `cwd`'s `.claude/skills` dir, refusing
 *  BEFORE any read/write if `.claude` or `.claude/skills` escapes `cwd` via a symlink/junction (the same
 *  {@link escapedAncestor} check `injectSkills` has always run). Before this, the released/readopt
 *  functions below each computed `claudeSkillsDir(cwd)` directly, with NO escape check at all — through a
 *  `.claude`/`.claude/skills` junction, an agent could steer a human's released-diff read or readopt click
 *  into reading or writing outside the repo entirely. Every caller that touches this dir — a live
 *  `injectSkills` placement, or any of `releasedSkillsAt`/`releasedSkillDiffSummary`/`releasedSkillDiffFile`/
 *  `reAdoptReleasedSkill` (which run off a human's REST click, with no live session of their own) — now goes
 *  through this ONE function, so the check can never again drift between callers. Returns null (logging the
 *  refusal) when escaped; every caller then degrades the same way `injectSkills` always has for this case —
 *  never touching the escaped target, never throwing. Refuses BEFORE any write, never after (the original
 *  escape-check discipline from card 5c3d0518).
 *
 *  `action` is a short caller-supplied label folded into the refusal's own log line (e.g. "injection",
 *  "readopt") purely so the daemon log reads sensibly per caller — `injectSkills`'s own regression test
 *  (`skills-inject-symlink-escape.mjs`) asserts on its literal text, so it keeps passing "injection" here
 *  unchanged; it carries no other meaning and never affects the check itself.
 *
 *  @decision 8b38b920 — the ONE resolver every reader/writer of this dir must share; do not re-derive the
 *  escape check per caller again. */
function resolveSkillsTargetDir(cwd: string, action: string): { targetDir: string; claudeDir: string } | null {
  const targetDir = claudeSkillsDir(cwd);
  const claudeDir = path.dirname(targetDir);
  const escaped = escapedAncestor(cwd, [claudeDir, targetDir]);
  if (escaped) {
    console.log(`[skills] refusing ${action}: ${escaped.path} resolves to ${escaped.real}, outside this working directory (${cwd}) — ${action} skipped`);
    return null;
  }
  return { targetDir, claudeDir };
}

/** card 8b38b920 CR fix round 2, item 5 (INVESTIGATE+FIX): {@link resolveSkillsTargetDir} only guards the
 *  `.claude`/`.claude/skills` ANCESTORS — it never checks the PER-SKILL dir itself. A
 *  `.claude/skills/<released-name>` that is ITSELF a symlink/junction escaping `cwd` would otherwise let
 *  `releasedSkillDiffSummary`/`releasedSkillDiffFile` list/serve files from its far end into a human's
 *  diff view, and let `reAdoptReleasedSkill` copy the store's content INTO it. Checked here, as a second,
 *  separate call at each of those three call sites — NOT folded into `resolveSkillsTargetDir` itself,
 *  because `injectSkills`'s own per-name placement logic is explicitly OUT of scope for this fix (see the
 *  decision record's residual note; it keeps its existing behavior unchanged). Deliberately checks only
 *  the one candidate (the per-name dir) — the ancestors above it are already covered by the caller's own
 *  `resolveSkillsTargetDir` call. */
function perSkillDirEscapes(cwd: string, dest: string): boolean {
  return escapedAncestor(cwd, [dest]) !== null;
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
  catch { return new Map(); } // no manifest yet — normal first run, not an error worth surfacing
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch (e) { console.log(`[skills] ignoring corrupt manifest at ${manifestPath}: ${(e as Error).message}`); return new Map(); }
  if (Array.isArray(raw)) return new Map([[sessionId, sanitizeManifestEntries(raw, sessionId)]]); // legacy global array → this session owns it now
  if (raw && typeof raw === "object") {
    const out: Manifest = new Map();
    for (const [sid, ns] of Object.entries(raw as Record<string, unknown>)) out.set(sid, sanitizeManifestEntries(ns, sid));
    return out;
  }
  return new Map();
}

/** One cwd's full parse of the {@link FINGERPRINTS_FILE} sidecar: the reserved {@link PENDING_RECLAIM_KEY}
 *  entry (never a real session id) parsed as a {@link PendingReclaimMap}, PLUS the reserved
 *  {@link LAST_PLACED_KEY} entry parsed as `lastPlaced` — `name -> the content fingerprint(s) Loom itself
 *  actually recorded placing there`, now the SOLE source the overwrite/delete gate reads (card f4272888 —
 *  see the decision record for the full redesign). Every OTHER top-level key is a pre-f4272888 per-session
 *  fingerprint record; see `readFingerprintsFile`'s own doc for the one-shot migration fold. */
interface FingerprintsFileData { pending: PendingReclaimMap; lastPlaced: LastPlacedMap; released: ReleasedMap; readopted: ReadoptedMap; }
/** `name -> every fingerprint recorded as Loom's own for it`. A `Map`, not `Record<string,string[]>`
 *  (card f4272888) — the same "__proto__"/untrusted-key reasoning as {@link Manifest}. A normal write
 *  (a real placement, any session) REPLACES the whole entry with a single-element array; more than one
 *  element can occur only transiently, from the one-shot legacy-fold described below. */
type LastPlacedMap = Map<string, string[]>;
/** A FRESH object every call — never a shared constant. `injectSkills` mutates the returned maps in place;
 *  a shared singleton here would let one call's write leak into every OTHER call whose fingerprints file
 *  happens to be missing/corrupt (a real regression this fixed — card f4e93dbf round 2, caught by
 *  `skills-capability-bound.mjs` case 17 only after several EARLIER worktree cases had already written
 *  through the same stale reference). */
function emptyFingerprintsFile(): FingerprintsFileData { return { pending: new Map(), lastPlaced: new Map(), released: new Map(), readopted: new Map() }; }

/** Validate+bound one untrusted {@link LAST_PLACED_KEY} entry: a non-empty array of valid fingerprints
 *  (same `sanitizeFingerprint` bound as everywhere else in this file), capped at
 *  {@link LAST_PLACED_MAX_FPS_PER_NAME} (a malformed/huge array is truncated, never rejected outright —
 *  "too many" is still real fingerprint data, worth keeping some of, unlike a wrong-shaped value). */
function sanitizeLastPlacedRecord(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const fps = [...new Set(raw.map(sanitizeFingerprint).filter((fp): fp is string => fp !== null))];
  return fps.length > 0 ? fps.slice(0, LAST_PLACED_MAX_FPS_PER_NAME) : null;
}

function sanitizeLastPlacedMap(raw: unknown): LastPlacedMap {
  const out: LastPlacedMap = new Map();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [name, rec] of Object.entries(raw as Record<string, unknown>)) {
    if (!isSafeManifestEntry(name)) continue;
    const sanitized = sanitizeLastPlacedRecord(rec);
    if (sanitized) out.set(name, sanitized);
  }
  return out;
}

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
  const out: PendingReclaimMap = new Map();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [name, rec] of Object.entries(raw as Record<string, unknown>)) {
    if (!isSafeManifestEntry(name)) continue;
    const sanitized = sanitizePendingReclaimRecord(rec);
    if (sanitized) out.set(name, sanitized);
  }
  return out;
}

/** Read the {@link FINGERPRINTS_FILE} sidecar. ABSENT (an old worktree, or any worktree this version
 *  hasn't written to yet) and CORRUPT both simply read as the empty {@link FingerprintsFileData}, the
 *  same fail-toward-keeping outcome the dead-claim cleanup already gives a missing entry.
 *
 *  @decision 31f997e7 — a top-level key that is neither reserved key is a legacy per-session record;
 *  fold its fingerprints into `lastPlaced` (never written back), using the key only as a loop
 *  discriminant — never store a forged/corrupted top-level key as an object/Map key anywhere.
 *
 *  @decision f4e93dbf — {@link PENDING_RECLAIM_KEY} is never iterated as a legacy per-session record; a
 *  real session id is minted by the orchestration DB and never equals this reserved literal. */
function readFingerprintsFile(fingerprintsPath: string): FingerprintsFileData {
  let text: string;
  try { text = fs.readFileSync(fingerprintsPath, "utf8"); }
  catch { return emptyFingerprintsFile(); }
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch (e) { console.log(`[skills] ignoring corrupt fingerprints file at ${fingerprintsPath}: ${(e as Error).message}`); return emptyFingerprintsFile(); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyFingerprintsFile();
  let pending: PendingReclaimMap = new Map();
  let released: ReleasedMap = new Map();
  let readopted: ReadoptedMap = new Map();
  const lastPlaced: LastPlacedMap = new Map();
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === PENDING_RECLAIM_KEY) { pending = sanitizePendingReclaimMap(value); continue; }
    if (key === RELEASED_KEY) { released = sanitizeReleasedMap(value); continue; }
    if (key === READOPTED_KEY) { readopted = sanitizeReadoptedMap(value); continue; }
    // @decision 31f997e7 — UNION with any legacy fold already set for this name here; a bare REPLACE
    // discards it whenever this key is reached AFTER a legacy section for the same name in one read.
    if (key === LAST_PLACED_KEY) {
      for (const [name, fps] of sanitizeLastPlacedMap(value)) {
        const existing = lastPlaced.get(name) ?? [];
        const merged = [...new Set([...existing, ...fps])].slice(0, LAST_PLACED_MAX_FPS_PER_NAME);
        lastPlaced.set(name, merged);
      }
      continue;
    }
    // Legacy per-session fingerprint record — fold into lastPlaced once; see this function's own doc.
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const [name, fp] of Object.entries(value as Record<string, unknown>)) {
      if (!isSafeManifestEntry(name)) continue;
      const sanitized = sanitizeFingerprint(fp);
      if (!sanitized) continue;
      const existing = lastPlaced.get(name) ?? [];
      if (!existing.includes(sanitized)) lastPlaced.set(name, [...existing, sanitized].slice(0, LAST_PLACED_MAX_FPS_PER_NAME));
    }
  }
  return { pending, lastPlaced, released, readopted };
}

/** Serialize `pending`/`lastPlaced`/`released`/`readopted` back to the {@link FINGERPRINTS_FILE} on-disk
 *  shape — the exact inverse of `readFingerprintsFile`'s parse, MINUS any legacy per-session section (card
 *  f4272888: never written back — see that function's own "ONE-SHOT MIGRATION FOLD" doc). Each reserved
 *  key is omitted entirely when its map is empty, so an ordinary cwd with nothing ever orphaned/placed/
 *  released never carries any of them at all. `Object.fromEntries` on a `Map`, never a bracket-assignment
 *  loop — spec'd to use `CreateDataProperty` (the same safe operation `JSON.parse` itself uses), so a
 *  `"__proto__"`-keyed entry becomes a genuine own property instead of reassigning `out`'s prototype. */
function serializeFingerprintsFile(lastPlaced: LastPlacedMap, pending: PendingReclaimMap, released: ReleasedMap = new Map(), readopted: ReadoptedMap = new Map()): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (pending.size > 0) out[PENDING_RECLAIM_KEY] = Object.fromEntries(pending);
  if (lastPlaced.size > 0) out[LAST_PLACED_KEY] = Object.fromEntries(lastPlaced);
  if (released.size > 0) out[RELEASED_KEY] = Object.fromEntries(released);
  if (readopted.size > 0) out[READOPTED_KEY] = Object.fromEntries(readopted);
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
 * Shared gate for every Loom write/delete path that must never clobber or remove a hand-edited (or
 * otherwise diverged) skill copy: is `currentFp` — the CALLER's own already-computed current on-disk
 * fingerprint for the dir in question (several callers need that same fingerprint for OTHER purposes too,
 * e.g. the shared-cwd untracked-check cache below, so this takes the value rather than a path to compute
 * it twice) — safe to treat as still Loom's own? Safe when EITHER (a) it matches one of `recorded` — the
 * fingerprint(s) actually recorded at a real Loom placement — OR (b) a `storeFallback` is supplied and it
 * matches the CURRENT store copy's own fingerprint — nothing would be lost by overwriting/pruning content
 * that's already byte-identical to what we'd write there anyway. Any other case — content diverges from
 * both, or `currentFp`/the store copy can't be read at all — fails CLOSED: "cannot verify" never means
 * "safe to destroy." `storeFallback` is a lazily-invoked thunk, called only when nothing in `recorded`
 * already matched, so the two existing dead-claim call sites, which never pass one, pay no extra
 * fingerprinting cost and keep their exact pre-card-6db94dfe behavior (fail toward keeping on ANY
 * unrecorded claim, no store comparison at all).
 *
 * @decision 31f997e7 — a caller must pass `recorded` as `lastPlaced.get(name)` directly, never the
 * retired multi-source union (per-session fingerprints, the in-process registry, a merged/capped
 * carry-forward) — one persisted per-(cwd,name) fact replaces all three (card f4272888).
 *
 * @decision 31f997e7 — card 6db94dfe closed the same-session-resume residual named in that record's
 * "What remains"; see it for the full history and the two existing dead-claim call sites this helper was
 * extracted from (behaviour-preserving — neither passes `storeFallback`).
 */
function matchesRecordedFingerprint(currentFp: string | null, recorded: Iterable<string> | undefined, storeFallback?: () => string | null): boolean {
  if (!currentFp) return false;
  if (recorded) {
    for (const fp of recorded) {
      if (fp === currentFp) return true;
    }
  }
  if (storeFallback) {
    const storeFp = storeFallback();
    if (storeFp && storeFp === currentFp) return true;
  }
  return false;
}

/**
 * What `fingerprintSkillDir` would compute for `name` if Loom placed it RIGHT NOW — applying the exact
 * same transforms real placement does (permission-strip, then the Obsidian fragment append when this
 * session has it enabled), never the raw, untransformed store bytes. Built off to the side, under the OS
 * temp dir (never this session's own cwd), and unconditionally cleaned up. Returns null when the store
 * copy is missing, a strip would FAIL (the same "undeliverable" outcome real placement treats as never
 * fingerprinted at all — see `needsPermissionStrip`/`stripPermissionWideningFile`), or the temp copy can't
 * be built/read: "cannot verify" fails toward keeping here too. Lazy by construction (only ever invoked
 * from `matchesRecordedFingerprint`'s `storeFallback` thunk, as the LAST resort once `lastPlaced.get(name)`
 * didn't already match) — never on the ordinary-resume hot path.
 *
 * @decision 31f997e7 — Code Review on card 6db94dfe: the legacy-claim fallback originally compared
 * against the RAW store dir, which false-mismatched a legacy claim of an agent-written (strip-needing) or
 * fragment-target skill even when the delivered copy was exactly what real placement would produce.
 */
function wouldPlaceFingerprint(name: string, obsidianEnabled: boolean): string | null {
  const src = path.join(SKILLS_DIR, name);
  if (!fs.existsSync(src)) return null;
  let tmp: string;
  try { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-skill-wouldplace-")); } catch { return null; }
  try {
    const dest = path.join(tmp, name);
    fs.cpSync(src, dest, { recursive: true });
    // card 3b2a8707 (item 3 nit): `applyPlacementTransforms` is the one place that decides whether `name`
    // is actually a fragment-target skill (OBSIDIAN_FRAGMENT_SKILLS) — this caller only decides whether
    // the fragment is enabled AT ALL for this session, never re-checking the per-name eligibility the
    // helper already checks. A harmless, rare-path file read for an ineligible name (never appended
    // either way) is cheaper than the two checks drifting apart.
    let fragment: string | null = null;
    if (obsidianEnabled) {
      try { fragment = fs.readFileSync(OBSIDIAN_PREFLIGHT_FRAGMENT, "utf8"); } catch { /* best effort, same degrade real placement gives a missing fragment */ }
    }
    if (!applyPlacementTransforms(name, dest, fragment, true)) return null; // would be undeliverable — never fingerprinted
    return fingerprintSkillDir(dest);
  } catch { return null; }
  finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } }
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
 *
 * `isProbe` (card 3b2a8707, item 4) affects ONLY the failure log wording, never behavior: `dir` is a real
 * SKILL.md on the real on-disk delivery path when false (the default, every pre-card-3b2a8707 call site),
 * but `wouldPlaceFingerprint`'s own off-to-the-side probe copy (a `loom-skill-wouldplace-*` temp dir) when
 * true — logging that temp path as "refusing to deliver" read as a real, actionable delivery failure when
 * it was only ever a scratch comparison; the probe wording below names the skill instead of that path.
 */
function stripPermissionWideningFile(skillDir: string, isProbe = false): boolean {
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
    console.log(isProbe
      ? `[skills] probe placement for '${path.basename(skillDir)}' would refuse to deliver: permission-widening content could not be stripped to a verified-clean result`
      : `[skills] refusing to deliver ${skillMd}: permission-widening content could not be stripped to a verified-clean result`);
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
  console.log(isProbe
    ? `[skills] probe placement for '${path.basename(skillDir)}' failed to strip permission-widening content after 3 attempts: ${(lastErr as Error)?.message}`
    : `[skills] failed to strip permission-widening content from ${skillMd} after 3 attempts: ${(lastErr as Error)?.message}`);
  return false;
}

/**
 * Apply, in order, the two transforms real placement performs on an already-copied skill dir: permission
 * strip, then the Obsidian fragment append (only when `fragment` is non-null AND `name` is a fragment-
 * target skill — the ONE place deciding this per-name eligibility; a caller only decides whether to
 * prepare a non-null `fragment` at all) — shared by the real placement loop below and
 * `wouldPlaceFingerprint`'s probe above (card 3b2a8707 item 3, replacing their prior duplication).
 * Returns false iff the strip failed (`dir` is UNDELIVERABLE — quarantine/discard it, never fingerprint
 * it, same as both callers already did before this extraction). `isProbe` forwards unchanged to
 * `stripPermissionWideningFile` — see that function's own doc.
 */
function applyPlacementTransforms(name: string, dir: string, fragment: string | null, isProbe = false): boolean {
  if (needsPermissionStrip(name, dir) && !stripPermissionWideningFile(dir, isProbe)) return false;
  if (fragment && OBSIDIAN_FRAGMENT_SKILLS.has(name)) appendObsidianFragment(dir, fragment);
  return true;
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
    console.error(`[skills] quarantine FAILED for ${dest}: could not remove, relocate, or neutralize it — an unstripped hazard may still be present (${(e as Error).message}); delete ${dest} by hand`);
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
  // Refuse BEFORE any write if `.claude` or `.claude/skills` is a symlink/junction redirecting outside
  // this session's own cwd (card 5c3d0518, from the review of 97e6a1c6; now the SHARED `resolveSkillsTargetDir`
  // chokepoint — card 8b38b920 CR fix round, item 2) — otherwise every injection write below (mkdir, the
  // skill copies, the manifest) lands on whatever that link points at instead of this repo. Logged loudly
  // and skipped for this session, never thrown into the spawn: the session still boots, just without its
  // injected skills, exactly like the existing "no store yet" early-return above and the non-fatal catch
  // around this call at its one call site (pty/host.ts).
  const resolvedTarget = resolveSkillsTargetDir(cwd, "injection");
  if (!resolvedTarget) return { claimedNames: [], claimedFingerprints: EMPTY_FINGERPRINTS };
  const { targetDir, claudeDir } = resolvedTarget;
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
  // card f4272888: the ONE persisted per-(cwd,name) fact the overwrite/delete gate reads below — mutated
  // in place only by a real successful placement (the `want` loop) or `fs.rmSync`-ing a resolved pending
  // reclaim away never touches it; a dead session dying never deletes anything from it, since it was
  // never session-scoped to begin with. See the decision record for the full redesign.
  const lastPlaced = fingerprintsFile.lastPlaced;
  // card 8b38b920: the durable "Loom stopped managing this (cwd,name)" record + its re-adopt bridge — see
  // RELEASED_KEY/READOPTED_KEY's own docs above.
  const released = fingerprintsFile.released;
  const readopted = fingerprintsFile.readopted;
  // Prune a manifest key for any OTHER session the caller-injected predicate says is not CURRENTLY
  // live/starting (card 9d73e537; see this function's own doc comment for why "live", not "resumable").
  // Never asked about our own key — this call IS that session, live, right now. A throw for one id is
  // swallowed and that entry is left alone (fail-safe), not treated as grounds to abandon the whole
  // prune pass. `deadClaimed` collects what each pruned key claimed, BEFORE it's deleted — card 31f997e7
  // CR round 2/3 consumes it below to clean up a dead session's own copies in an isolated worktree cwd,
  // ONLY when content still matches `lastPlaced` (card f4272888: no more per-session fingerprint
  // collection here at all — the content check reads the one persisted fact directly, later).
  const deadClaimed = new Set<string>();
  if (isSessionLive) {
    for (const sid of new Set(manifest.keys())) {
      if (sid === sessionId) continue;
      let live = true;
      try { live = isSessionLive(sid); } catch { /* fail-safe: keep this entry on error */ }
      if (!live) {
        for (const n of manifest.get(sid) ?? []) deadClaimed.add(n);
        manifest.delete(sid);
      }
    }
  }
  const myPrev = manifest.get(sessionId) ?? [];
  // Union of every OTHER session's injected skills sharing this cwd — these must NEVER be stripped here
  // and are NOT the repo's own (the landmine-2 invariant: concurrent sessions share project.repoPath).
  const otherClaimed = new Set<string>();
  for (const [sid, ns] of manifest) if (sid !== sessionId) for (const n of ns) otherClaimed.add(n);

  // In an ISOLATED worktree cwd, a just-pruned dead session's manifest-claimed dirs are CANDIDATES for
  // cleanup — closing the worktree-REUSE orphan (a stopped/rejected worker's worktree reused by a
  // re-dispatch, possibly to a different agent with different grants; `git reset --hard` never touches
  // untracked `.claude/skills`). `deadClaimed` is built exclusively from a dead session's OWN manifest
  // entry, so a repo/user dir (never recorded in any session's manifest — see the "repo's own" skip
  // below) is never even a candidate. But being claimed is a fact about when Loom placed it, not about
  // what's there NOW: a worker may have hand-edited a FILE, or added one, since. CR round 3 (reviewer
  // 085065b7) found the round-2 cleanup deleted that work outright — the owner's standing rule is never
  // to destroy unfinished work, and a bare "it's in the manifest" was never proof the content was still
  // Loom's own. A delete now requires the dir's CURRENT content fingerprint to match the one persisted
  // `lastPlaced` fact for this name (`fingerprintSkillDir` vs `lastPlaced.get(stale)`, card f4272888) —
  // any mismatch, or no recorded fingerprint at all (a legacy pre-card claim), SKIPS the delete and
  // leaves an orphan rather than risk data loss.
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
      const recordedFps = lastPlaced.get(stale);
      if (!recordedFps || recordedFps.length === 0) { console.log(`[skills] keeping dead-session claim '${stale}': no recorded content fingerprint (a legacy claim) — cannot verify it's still Loom's own, so not deleting`); continue; }
      const target = path.join(targetDir, stale);
      if (!matchesRecordedFingerprint(fingerprintSkillDir(target), recordedFps)) { console.log(`[skills] keeping dead-session claim '${stale}': on-disk content doesn't match any recorded Loom placement (edited, or files added) — not deleting`); continue; }
      if (path.dirname(target) !== targetDir) { console.log(`[skills] refusing to remove out-of-scope dead-session manifest entry: ${stale}`); continue; }
      try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  } else {
    // Seed this call's working set from whatever the sidecar already had pending, then merge in anything
    // THIS call's own prune just discovered (`deadClaimed` — typically gone again by the time a later
    // call runs, which is exactly why the persisted record below exists at all). The candidate fingerprint
    // for each name is `lastPlaced.get` directly (card f4272888) — no per-dead-session collection needed.
    for (const [name, rec] of fingerprintsFile.pending) {
      pendingWorking.set(name, { deadFingerprints: new Set(rec.deadFingerprints), firstSeenAt: rec.firstSeenAt });
    }
    for (const stale of deadClaimed) {
      const recordedFps = lastPlaced.get(stale);
      if (!recordedFps || recordedFps.length === 0) {
        if (!pendingWorking.has(stale)) console.log(`[skills] keeping dead-session claim '${stale}' (shared cwd): no recorded content fingerprint (a legacy claim) — cannot verify it's still Loom's own, so not reclaiming`);
        // card 8b38b920: a legacy claim with no recorded fingerprint is genuinely unverifiable (never a
        // storeFallback check on this path — see matchesRecordedFingerprint's own doc) — durably recorded
        // so a human can discover it, rather than only ever a console.log at the moment it happens.
        recordReleased(released, stale, "unverifiable-legacy");
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
      const currentFp = fingerprintSkillDir(target); // reused below for the untracked-check cache + kick, not just this match
      if (!currentFp || !matchesRecordedFingerprint(currentFp, rec.deadFingerprints)) {
        console.log(`[skills] keeping dead-session claim '${name}' (shared cwd): on-disk content doesn't match any recorded Loom placement (edited, or files added) — not reclaiming`);
        pendingWorking.delete(name); // resolved: edited — drop the record and never touch it again
        recordReleased(released, name, "modified"); // card 8b38b920
        continue;
      }
      if (nowMs - rec.firstSeenAt > PENDING_RECLAIM_MAX_AGE_MS) {
        console.log(`[skills] giving up on dead-session claim '${name}' (shared cwd): still unresolved after the ${PENDING_RECLAIM_MAX_AGE_MS}ms age bound — dropping the pending-reclaim record, never acting on it again`);
        pendingWorking.delete(name);
        // card 8b38b920: content may be byte-identical to Loom's own placement — this is Loom giving up
        // verifying it's SAFE to reclaim (persistently tracked, or a repeatedly-failing check), never a
        // claim that a human edited it. Keep it a distinct reason from "modified".
        recordReleased(released, name, "abandoned");
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
        // A still-valid `negative:true` entry for this exact content (confirmed tracked, or a failed/
        // refused check) is never a reclaim opportunity for anyone — skip it, regardless of `want`, but
        // leave the pending-reclaim record itself untouched: this is a backoff, not a resolution, so a
        // LATER call (once `expiresAt` passes) re-verifies from scratch rather than this name being lost.
        //
        // @decision f4e93dbf — a live `negative:true` entry is skipped (never consumed, never dropped).
        if (cacheEntry.negative && cacheEntry.fingerprint === currentFp && cacheEntry.expiresAt > nowMs) continue;
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
        recordReleased(released, name, "abandoned"); // card 8b38b920 — same reason as the age give-up above: capped out, not necessarily edited
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
  for (const name of want) {
    const dest = path.join(targetDir, name);
    const src = path.join(SKILLS_DIR, name);
    const exists = fs.existsSync(dest);
    // A pre-existing dir that NO loom session claims (not mine, not another session's) is the repo's OWN
    // project-local skill — never clobber it. A dir another session injected IS loom's: re-copying the
    // same store content is idempotent and harmless. `reclaimableNow` (card f4e93dbf): a verified
    // dead-claim orphan, already confirmed untracked — treat it as claimed too, so this same copy path
    // handles it exactly like any other refresh: `copySkillAtomic` builds the new copy fully before
    // touching the old one, but it is NOT a single atomic replace with no delete step — it rm's `dest`
    // then renames, with a real (if brief) window where `dest` is simply missing (card d467d56d; see
    // that function's own doc).
    // card 8b38b920: `readopted.has(name)` — a human explicitly re-adopted this name via the REST path but
    // no live session has claimed it yet — is treated as already-claimed too, same posture as
    // `reclaimableNow`, so the very next live session whose `want` includes it becomes its new manifest
    // owner instead of this check silently treating the freshly-readopted copy as "the repo's own."
    if (exists && !myPrev.includes(name) && !otherClaimed.has(name) && !reclaimableNow.has(name) && !readopted.has(name)) continue;
    // card f4272888: a name that already exists at `dest` — whether I placed it before, or ANOTHER live
    // session did (the `otherClaimed` case, a fresh first-time claim in a shared cwd) — is re-copied only
    // if current disk still matches `lastPlaced.get(name)` (the single persisted fact: the content SOME
    // Loom placement, by any session, last actually wrote here) OR what placement would produce right now
    // (`wouldPlaceFingerprint`, for a legacy name with no recorded fact yet). A mismatch against BOTH
    // leaves it alone, same as the "repo's own" skip above — the name then naturally drops out of `placed`
    // below and is never claimed (or overwritten) again.
    //
    // @decision 31f997e7 — a shared cwd's content reflects whatever ANY live co-claimant last placed; this
    // is why the gate is keyed on the single global `lastPlaced` fact, never a single claimant's own value.
    //
    // card 8b38b920 CR fix round, item 1 (CRITICAL): `readopted.has(name)` MUST also run through this same
    // gate. `reAdoptReleasedSkill` sets a fresh `lastPlaced` entry for `name` the moment it writes (see its
    // own doc) — so a re-adopted name is NOT "nothing recorded yet to match against"; it has exactly as
    // real a `lastPlaced` fact as a `myPrev`/`otherClaimed` name does. Without this, the early "repo's own"
    // skip above already treats a readopted name as claimed (so the `continue` there is never taken), and
    // this `if` used to fall through FALSE for it (readopted alone, with no live claimant) — reaching the
    // unconditional `copySkillAtomic` below with no check at all. That silently overwrote ANY hand edit made
    // AFTER the re-adopt, the instant the next live session's `want` included the name: readopt(correct fp)
    // -> edit again -> injectSkills(fresh session) lost the second edit with no trace, in an unbounded
    // window. See the decision record's now-corrected "Do not" bullet.
    if (exists && (myPrev.includes(name) || otherClaimed.has(name) || readopted.has(name))) {
      const recorded = lastPlaced.get(name);
      if (!matchesRecordedFingerprint(fingerprintSkillDir(dest), recorded, () => wouldPlaceFingerprint(name, obsidianEnabled))) {
        console.log(`[skills] keeping hand-modified copy of '${name}' at ${dest}: on-disk content doesn't match any current claimant's last placement (edited, or files added) — not overwriting`);
        recordReleased(released, name, "modified"); // card 8b38b920 — durable; this is the actual "frozen doctrine" bug
        // card 8b38b920 CR fix round, item 1: a re-adopted name that's since been hand-edited again is now
        // genuinely "repo's own, nobody's" again (no live claimant) — drop the stale readopted bridge so the
        // early "repo's own" skip above treats it that way on every later call too, instead of looping back
        // through this same mismatch branch forever.
        if (readopted.delete(name)) console.log(`[skills] '${name}' at ${cwd} was re-adopted but has since been hand-edited again — dropping its stale re-adopted marker`);
        continue;
      }
    }
    // COPY (atomic tmp+swap), never junction: a junction here lets worktree removal's recursive rm follow
    // it into the store and delete the store's SKILL.md (see header). An independent copy is self-contained.
    // A copy that ultimately fails is recorded (`failed`) and surfaced below — NOT silently skipped, which
    // would let the session run WITHOUT its pinned doctrine skill.
    if (copySkillAtomic(src, dest)) {
      // @decision 51a2462a round 2 — a strip failure is now treated exactly like a copy failure (remove
      // dest, record failed, never fingerprint), never the old fail-open shape. Round 3: the removal
      // itself is fail-safe (see `quarantineUndeliverableDest`'s own doc), not a bare best-effort rm.
      //
      // card 3b2a8707 (item 3): strip + fragment-append now share `applyPlacementTransforms` with
      // `wouldPlaceFingerprint`'s probe — ONLY the fragment-target skills, and ONLY when enabled + the
      // fragment loaded, still get the append; it runs after the fresh base copy (copySkillAtomic
      // re-copies the fragment-free store base first), so the append lands once.
      if (!applyPlacementTransforms(name, dest, obsidianFragment)) {
        quarantineUndeliverableDest(dest, name, claudeDir);
        failed.push(name);
        continue;
      }
      placed.push(name);
      const fp = fingerprintSkillDir(dest);
      if (fp) {
        // card f4272888: REPLACE, never merge — this IS the "last Loom write" fact, full stop; absent
        // (fingerprint failed) ⇒ a future read sees it as unverifiable, never as a false match.
        lastPlaced.set(name, [fp]);
        recordLoomPlacedFingerprint(cwd, name, fp); // unchanged — the SEPARATE in-process trust-boundary registry (015fdb23), never read by the gate above
      }
      // card 8b38b920: a successful placement here means `name` is Loom-managed again — whether that's an
      // ordinary first-time claim (nothing to clear), a hand-reverted copy whose content matches again
      // (the residual named in this card's own investigation — reworded per the CR fix round's nit 5: this
      // only resumes management while a live claimant — myPrev/otherClaimed/readopted — still exists for
      // `name`; once nothing claims it, the early "repo's own" skip above catches it first and this branch
      // never fires), or a human re-adopt now picked up by a live session. Clear + log both reserved-key
      // records unconditionally; each is a no-op if absent.
      clearReleased(released, name, cwd, "re-placed by a live session");
      if (readopted.delete(name)) console.log(`[skills] '${name}' at ${cwd} was claimed by a live session — its re-adopted marker is no longer needed`);
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
    // card f4272888: never prune a name I claimed if its on-disk content no longer matches the one
    // persisted `lastPlaced` fact (hand-edited, force-added to git, or replaced by a tracked same-named
    // skill) — same gate, same rationale, as the re-copy skip above. A legacy claim with no recorded
    // fingerprint anywhere is pruned only when it's still byte-identical to what placement would ACTUALLY
    // produce right now; a genuine divergence is kept.
    //
    // @decision 31f997e7 — see the re-copy skip's own pointer above; this is the loop's prune sibling.
    const recorded = lastPlaced.get(stale);
    if (!matchesRecordedFingerprint(fingerprintSkillDir(target), recorded, () => wouldPlaceFingerprint(stale, obsidianEnabled))) {
      console.log(`[skills] keeping hand-modified copy of '${stale}' at ${target}: on-disk content doesn't match any current claimant's last placement (edited, or files added) — not pruning`);
      recordReleased(released, stale, "modified"); // card 8b38b920 — durable; this is the actual "frozen doctrine" bug's prune-sibling trigger
      continue;
    }
    try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* ignore */ }
    // card 8b38b920: the dir is now gone, so any stale released record for it is resolved too — a name
    // that was released while still wanted, then later dropped from `want` and found to match again, is
    // pruned here rather than re-placed; either way, the release no longer applies.
    clearReleased(released, stale, cwd, "pruned after its content matched Loom's last placement again");
  }

  manifest.set(sessionId, placed); // record ONLY what I actually injected (never the repo's own / collisions)
  // Atomic manifest write via the shared `writeJsonAtomic` (card 4c2a0bfd — in ../write-json-atomic.js,
  // a tiny dependency-free module; also re-exported from pty/claude-config.ts, its original home, for
  // that file's own existing callers — see that card's "moved" note): a torn write here corrupts the
  // shared per-session
  // record — readManifest then has to discard it, losing every concurrent session's claims — AND, unlike
  // this file's own old fixed `.tmp` suffix, writeJsonAtomic's unique pid+random tmp name closes the
  // cross-process same-tmp-name collision two daemons sharing one cwd could hit (see
  // docs/decisions/31f997e7-*.md's "CARD 4c2a0bfd" section for the full analysis + accepted residuals).
  // `Object.fromEntries` on a `Map`, never a bracket-assignment loop (card f4272888) — see `Manifest`'s
  // own doc for why. A write/rename failure is NON-FATAL, same policy as before this card —
  // writeJsonAtomic already cleans up its own tmp on a terminal rename failure; this catch only keeps the
  // pre-existing "log and continue" behavior, not a cleanup duty.
  try { writeJsonAtomic(manifestPath, Object.fromEntries(manifest)); }
  catch (e) { console.log(`[skills] failed to write manifest ${manifestPath}: ${(e as Error).message}`); }

  // The fingerprints sidecar (separate file, separate atomic write — see FINGERPRINTS_FILE's own doc for
  // why it's never merged into MANIFEST's shape). Same writeJsonAtomic discipline as the manifest write
  // above. `lastPlaced` was already mutated in place above (the want-loop's own `lastPlaced.set` on a
  // successful placement) — nothing session-scoped to additionally replace here (card f4272888).
  //
  // @decision f4e93dbf — `pendingWorking` (resolved entries removed, unresolved/carried-forward ones
  // kept, as computed above) is what gets persisted here; a worktree cwd never populated it, so it
  // serializes to nothing and the reserved key is omitted entirely, same as before this card.
  const pendingOut: PendingReclaimMap = new Map();
  for (const [name, rec] of pendingWorking) pendingOut.set(name, { deadFingerprints: [...rec.deadFingerprints], firstSeenAt: rec.firstSeenAt });
  // card 8b38b920: bound both reserved keys the same defensive way pendingWorking is bounded above —
  // practically never hit in a real project.
  boundReleased(released);
  boundReadopted(readopted);
  const fingerprintsOut = serializeFingerprintsFile(lastPlaced, pendingOut, released, readopted);
  try { writeJsonAtomic(fingerprintsPath, fingerprintsOut); }
  catch (e) { console.log(`[skills] failed to write fingerprints file ${fingerprintsPath}: ${(e as Error).message}`); }
  hideFromGit(cwd, [...placed, MANIFEST, FINGERPRINTS_FILE, MANIFEST_TMP_GLOB, FINGERPRINTS_TMP_GLOB]);

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

// ---------------------------------------------------------------------------------------------------------
// card 8b38b920 — human-only REST surface (never an MCP tool): list a project's released (Loom-stopped-
// managing) skill copies, diff one against the current store, and re-adopt it after review. All three
// read/write the SAME `targetDir`/`FINGERPRINTS_FILE` sidecar `injectSkills` itself reads/writes — there is
// no separate store for this data.
// ---------------------------------------------------------------------------------------------------------

/** Best-effort read of one file's text content; `null` on any error (missing, unreadable, …) — mirrors
 *  `store.ts`'s own `readFileOrNull`, kept as a tiny local copy rather than widening that file's export
 *  surface for a single cross-module caller. */
function readTextOrNull(p: string): string | null {
  try { return fs.readFileSync(p, "utf8"); } catch { return null; }
}

/** Every relative file path under `dir`, recursively — `null`/missing reads as "no files" (never throws). */
function safeListFilesRecursiveSorted(dir: string): string[] {
  try { return listFilesRecursiveSorted(dir); } catch { return []; }
}

/** card 8b38b920 CR fix round, item 4 (LEAD DECISION); TRI-STATED in fix round 2 (MINOR) — a FAILED check
 *  (timeout, `canonicalGit`'s own fail-closed refusal, an unreadable `.git`) used to report `tracked:true`,
 *  which is simply FALSE: the REST 409 said "has at least one git-tracked file" when the truth is "could
 *  not be verified either way." `"unknown"` names that case honestly instead of folding it into either
 *  real answer. */
export type GitTrackedState = "tracked" | "untracked" | "unknown";

/** Whether ANY file currently on disk under `target` (a released skill's dir) is git-tracked, in whichever
 *  repo actually contains it (`innermostGitRepoRoot` above — never assumed to be `cwd`, same idiom the
 *  dead-claim reclaim check uses). No repo anywhere up-tree ⇒ `"untracked"` (nothing to be tracked by).
 *  Unlike `kickUntrackedCheck` above, this runs off a human's REST click, never the spawn hot path — so
 *  it's fine to await it directly instead of firing-and-forgetting it. Fails toward `"unknown"` on any
 *  error (an unreachable repo, a timeout, `canonicalGit`'s own fail-closed refusal) — NEVER toward
 *  `"untracked"` (that would silently clear the way for an overwrite of real, repo-owned content) and
 *  never toward a bare `"tracked"` either (that would misreport a merely-unverifiable state as a confirmed
 *  one). Every caller must keep REFUSING a write on `"unknown"`, exactly as it already does on `"tracked"`
 *  — see {@link reAdoptReleasedSkill}. */
async function gitTrackedState(target: string): Promise<GitTrackedState> {
  const repoRoot = innermostGitRepoRoot(target);
  if (!repoRoot) return "untracked";
  // `target` itself can BE `repoRoot` (a released dir that is itself a nested repo's root, e.g. a
  // vendored/submodule-like skill) — `path.relative` then yields `""`, and git rejects an empty pathspec
  // outright ("empty string is not a valid pathspec"). `"."` means the same thing git DOES accept: every
  // tracked file at/under `repoRoot`, which here is exactly `target`.
  const relPath = path.relative(repoRoot, target).split(path.sep).join("/");
  const pathspec = relPath === "" ? "." : relPath;
  try {
    const git = canonicalGit(repoRoot, UNTRACKED_CHECK_TIMEOUT_MS);
    const out = await withTimeout(git.raw(["ls-files", "--", pathspec]), UNTRACKED_CHECK_TIMEOUT_MS, "git ls-files (released-skill tracked check)");
    return out.trim() !== "" ? "tracked" : "untracked";
  } catch (e) {
    console.log(`[skills] tracked-check failed for ${target} (treating as unknown, refusing a readopt until it can be verified): ${(e as Error)?.message ?? e}`);
    return "unknown";
  }
}

export interface ReleasedSkillSummary {
  readonly name: string;
  readonly reason: ReleaseReason;
  readonly firstSeenAt: number;
  /** card 8b38b920 CR fix round, item 4, TRI-STATED in fix round 2 — see {@link GitTrackedState}'s own
   *  doc. Surfaced so a human sees WHY a readopt of this name will be refused, before they try it. */
  readonly tracked: GitTrackedState;
}

/** card 8b38b920 CR fix round 2 (NIT): batched sibling of {@link gitTrackedState} for {@link
 *  releasedSkillsAt}'s list — ONE `git ls-files -- .claude/skills` per repo root instead of up to
 *  `RELEASED_MAX_PER_CWD` (200) concurrent per-name git subprocesses on a single GET. Every name sharing
 *  `targetDir`'s OWN innermost repo root is resolved from that one batched read; a name whose own
 *  innermost repo root diverges from it (its skill dir is itself a nested repo — rare) still gets its own
 *  individual {@link gitTrackedState} call, so the rare case is never silently mis-answered just to avoid
 *  a second git call. A failed batched read reports `"unknown"` for every name it would have covered —
 *  same fail-closed posture as `gitTrackedState`'s own catch branch, never silently downgraded to
 *  `"untracked"` just because it's the batched path. */
async function batchGitTrackedStates(targetDir: string, names: readonly string[]): Promise<Map<string, GitTrackedState>> {
  const out = new Map<string, GitTrackedState>();
  const sharedRepoRoot = innermostGitRepoRoot(targetDir);
  if (!sharedRepoRoot) {
    for (const name of names) out.set(name, "untracked");
    return out;
  }
  const pathspec = path.relative(sharedRepoRoot, targetDir).split(path.sep).join("/");
  // `targetDir` itself can BE `sharedRepoRoot` (`.claude/skills` is itself a nested repo's root) — same
  // empty-pathspec hazard `gitTrackedState` guards against; "." is what git accepts for "everything here".
  // The BARE `pathspec` (possibly "") is still what the `rel` matching below uses — that ternary already
  // handles "" correctly (`rel = name`), so only the git ARGUMENT needs the substitution.
  const gitPathspec = pathspec === "" ? "." : pathspec;
  let tracked: Set<string> | null = null;
  try {
    const git = canonicalGit(sharedRepoRoot, UNTRACKED_CHECK_TIMEOUT_MS);
    // card 8b38b920 fix round 3 (minor, quotePath): `-z` makes git emit NUL-separated, NEVER C-quoted
    // paths — without it, git's default `core.quotePath=true` C-quotes a non-ASCII filename (e.g. a
    // literal `é` becomes `"\303\251.md"`), which then never matches the plain `rel` string built below,
    // so a released skill whose only tracked file has a non-ASCII name silently reported "untracked".
    const raw = await withTimeout(git.raw(["ls-files", "-z", "--", gitPathspec]), UNTRACKED_CHECK_TIMEOUT_MS, "git ls-files (released-skill batch tracked check)");
    tracked = new Set(raw.split("\u0000").map((l) => l.trim()).filter(Boolean));
  } catch (e) {
    console.log(`[skills] batched tracked-check failed for ${targetDir} (treating every name it would have covered as unknown): ${(e as Error)?.message ?? e}`);
  }
  const individual: string[] = [];
  for (const name of names) {
    if (innermostGitRepoRoot(path.join(targetDir, name)) !== sharedRepoRoot) { individual.push(name); continue; }
    if (tracked === null) { out.set(name, "unknown"); continue; }
    const rel = pathspec ? `${pathspec}/${name}` : name;
    out.set(name, [...tracked].some((f) => f === rel || f.startsWith(`${rel}/`)) ? "tracked" : "untracked");
  }
  for (const name of individual) out.set(name, await gitTrackedState(path.join(targetDir, name)));
  return out;
}

/** Fresh, uncached read of every currently-released skill at `cwd`'s shared doctrine dir — see
 *  `ReleaseReason`'s own doc for what each reason means. Never throws; a missing/corrupt sidecar, or an
 *  escaped `.claude`/`.claude/skills` ancestor ({@link resolveSkillsTargetDir}), both read as "nothing
 *  released," same fail-safe posture as every other reader of this file. */
export async function releasedSkillsAt(cwd: string): Promise<ReleasedSkillSummary[]> {
  const resolved = resolveSkillsTargetDir(cwd, "released-skill list");
  if (!resolved) return [];
  const fingerprintsPath = path.join(resolved.targetDir, FINGERPRINTS_FILE);
  const { released } = readFingerprintsFile(fingerprintsPath);
  const entries = [...released].sort((a, b) => a[0].localeCompare(b[0]));
  const trackedByName = await batchGitTrackedStates(resolved.targetDir, entries.map(([name]) => name));
  return entries.map(([name, rec]) => ({
    name, reason: rec.reason, firstSeenAt: rec.firstSeenAt,
    tracked: trackedByName.get(name) ?? "unknown",
  }));
}

export interface ReleasedSkillDiffFile { readonly path: string; readonly differs: boolean; }
export interface ReleasedSkillDiffSummary {
  readonly name: string;
  readonly reason: ReleaseReason;
  readonly firstSeenAt: number;
  /** The on-disk content fingerprint RIGHT NOW — pass this back to {@link reAdoptReleasedSkill} (via the
   *  REST layer) so a concurrent hand edit made after this diff was fetched is refused, never silently
   *  discarded. `null` means "cannot verify" (the dir is unreadable) — never readoptable while that holds. */
  readonly currentFingerprint: string | null;
  /** card 8b38b920 CR fix round, item 4, TRI-STATED in fix round 2 — see {@link ReleasedSkillSummary.tracked}'s own doc. */
  readonly tracked: GitTrackedState;
  /** Every tracked relative path under either the on-disk copy or the current store copy, content-free —
   *  the summary tier of the same two-tier (summary + per-file content-on-demand) shape `store.ts`'s own
   *  `skillUpdateDiff`/`skillFileDiff` already use for the global store's base/mine/shipped diff. */
  readonly files: readonly ReleasedSkillDiffFile[];
}

/** `null` iff `name` isn't currently released at `cwd` (including an escaped `.claude`/`.claude/skills`
 *  ancestor, {@link resolveSkillsTargetDir}, OR the per-name dir itself escaping, {@link
 *  perSkillDirEscapes}) — the REST layer 404s on that, never on "no diff to show" (a released name always
 *  has SOMETHING to show, even if every file happens to be identical). */
export async function releasedSkillDiffSummary(cwd: string, name: string): Promise<ReleasedSkillDiffSummary | null> {
  if (!isValidSkillName(name)) return null;
  const resolved = resolveSkillsTargetDir(cwd, "released-skill diff");
  if (!resolved) return null;
  const { targetDir } = resolved;
  const fingerprintsPath = path.join(targetDir, FINGERPRINTS_FILE);
  const { released } = readFingerprintsFile(fingerprintsPath);
  const rec = released.get(name);
  if (!rec) return null;
  const dest = path.join(targetDir, name);
  if (perSkillDirEscapes(cwd, dest)) {
    console.log(`[skills] refusing released-skill diff: '${name}' at ${cwd} is itself a symlink/junction escaping this working directory — skipped`);
    return null;
  }
  const currentFingerprint = fingerprintSkillDir(dest);
  const tracked = await gitTrackedState(dest);
  const relPaths = new Set([...safeListFilesRecursiveSorted(path.join(SKILLS_DIR, name)), ...safeListFilesRecursiveSorted(dest)]);
  const files = [...relPaths].sort().map((relPath) => {
    const onDisk = readTextOrNull(path.join(dest, ...relPath.split("/")));
    const store = readTextOrNull(path.join(SKILLS_DIR, name, ...relPath.split("/")));
    return { path: relPath, differs: onDisk !== store };
  });
  return { name, reason: rec.reason, firstSeenAt: rec.firstSeenAt, currentFingerprint, tracked, files };
}

export interface ReleasedSkillDiffFileContent { readonly path: string; readonly onDisk: string | null; readonly store: string | null; }

/** The content tier of the diff above — one tracked file's two sides, fetched on demand. `relPath` is
 *  validated by MEMBERSHIP in the live server-derived tracked-file set (mirrors `store.ts`'s own
 *  `isTrackedSkillFile` discipline: the caller names a CHOICE from that set, never a path), so traversal
 *  and untracked paths both 404 through the same `null` return, with no string sanitization to get subtly
 *  wrong. `null` iff `name` isn't released, `relPath` isn't one of its tracked files, `.claude`/
 *  `.claude/skills` escapes `cwd` ({@link resolveSkillsTargetDir}), or the per-name dir itself escapes
 *  ({@link perSkillDirEscapes}). */
export function releasedSkillDiffFile(cwd: string, name: string, relPath: string): ReleasedSkillDiffFileContent | null {
  if (!isValidSkillName(name)) return null;
  const resolved = resolveSkillsTargetDir(cwd, "released-skill diff");
  if (!resolved) return null;
  const { targetDir } = resolved;
  const fingerprintsPath = path.join(targetDir, FINGERPRINTS_FILE);
  const { released } = readFingerprintsFile(fingerprintsPath);
  if (!released.has(name)) return null;
  const dest = path.join(targetDir, name);
  if (perSkillDirEscapes(cwd, dest)) {
    console.log(`[skills] refusing released-skill diff file: '${name}' at ${cwd} is itself a symlink/junction escaping this working directory — skipped`);
    return null;
  }
  const known = new Set([...safeListFilesRecursiveSorted(path.join(SKILLS_DIR, name)), ...safeListFilesRecursiveSorted(dest)]);
  if (!known.has(relPath)) return null;
  return {
    path: relPath,
    onDisk: readTextOrNull(path.join(dest, ...relPath.split("/"))),
    store: readTextOrNull(path.join(SKILLS_DIR, name, ...relPath.split("/"))),
  };
}

export type ReAdoptReleasedSkillResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "not-released" | "fingerprint-mismatch" | "tracked" | "track-unknown" | "copy-failed"; readonly message: string };

/**
 * The human-only re-adopt action (card 8b38b920's own design decision, approved by the manager): overwrite
 * a released copy with the CURRENT store copy, write the fresh fingerprint to `lastPlaced`, clear the
 * `__released` record, and mark `name` in `__readopted` so the next live session at `cwd` claims it (see
 * `injectSkills`'s `want`-loop skip + its success-branch clear for the other half of this bridge). NEVER
 * auto-overwrite: the caller must supply `expectedFingerprint` — the fingerprint it showed the human in a
 * prior {@link releasedSkillDiffSummary} read — and this REFUSES (`"fingerprint-mismatch"`) if the on-disk
 * copy has changed since, so a concurrent hand edit made between the diff and the click is never discarded
 * unseen. There is no session here (this runs off a human's REST click, not a live `injectSkills` call), so
 * `obsidianEnabled` must be resolved by the caller (the REST handler) the same way a live session's own
 * spawn resolves it — via `resolveConfig(project.config).obsidian.autoStart` — and passed in explicitly.
 *
 * card 8b38b920 CR fix round, item 4 (LEAD DECISION): ALSO refuses (`"tracked"`) when any file under the
 * released dir is git-tracked — a readopt must never overwrite content git itself considers repo-owned,
 * even if Loom's own fingerprint bookkeeping would otherwise allow it. card 8b38b920 CR fix round 2 (MINOR,
 * tri-state): a tracked-check that could not be VERIFIED either way (`"track-unknown"`) is ALSO refused —
 * never folded into `"tracked"`'s own message, since "has at least one git-tracked file" would be a false
 * claim about a state that was never actually confirmed.
 *
 * @decision 8b38b920 — never auto-overwrite anywhere; this function is reachable ONLY from a human-only
 * REST route, never an MCP tool, and only after the stale-fingerprint and tracked-file refusals above pass.
 */
export async function reAdoptReleasedSkill(cwd: string, name: string, expectedFingerprint: string, obsidianEnabled: boolean): Promise<ReAdoptReleasedSkillResult> {
  if (!isValidSkillName(name)) return { ok: false, code: "not-released", message: "invalid skill name" };
  const resolved = resolveSkillsTargetDir(cwd, "readopt");
  if (!resolved) return { ok: false, code: "copy-failed", message: "this project's skills directory could not be safely resolved (a symlink/junction escapes its working directory) — refusing" };
  const { targetDir } = resolved;
  const dest = path.join(targetDir, name);
  // card 8b38b920 CR fix round 2, item 5: the per-name dir itself may be a symlink/junction escaping `cwd`
  // even though `.claude`/`.claude/skills` above didn't — checked BEFORE the await below so an escaped
  // path never even reaches a git subprocess, let alone the copy further down.
  if (perSkillDirEscapes(cwd, dest)) {
    return { ok: false, code: "copy-failed", message: `'${name}' at this project is itself a symlink/junction escaping its working directory — refusing` };
  }
  // card 8b38b920 CR fix round 2 (MAJOR, TOCTOU): run the ONLY await — the git subprocess below, up to
  // UNTRACKED_CHECK_TIMEOUT_MS — BEFORE touching the sidecar or the live fingerprint at all. Everything
  // from here to the final `writeJsonAtomic` below is then one uninterrupted synchronous block: nothing
  // else running in this process (notably a synchronous `injectSkills` call racing the same sidecar) can
  // observe or mutate state between this function's read and its write. Checking tracked-ness BEFORE
  // confirming `name` is even released is deliberate — it's the only way to get the await out first; the
  // tracked result is just held in a local and consulted after the released/fingerprint checks below, so
  // the returned error PRECEDENCE (not-released, then fingerprint-mismatch, then tracked) is unchanged.
  const tracked = await gitTrackedState(dest);
  // card 8b38b920 fix round 3 (minor): `resolved`/`perSkillDirEscapes` above only prove the path was safe
  // BEFORE the await — the git subprocess can take up to UNTRACKED_CHECK_TIMEOUT_MS, long enough for
  // something to swap `.claude`/`.claude/skills`/the per-name dir for a junction in the meantime (the
  // `gitTrackedState` answer above is itself a pre-await fact for the same reason — see this function's
  // own doc). Both checks are cheap and synchronous (`fs.realpathSync`), so re-running them here, before
  // the sidecar is ever read, costs nothing and closes that window with the SAME codes/messages as the
  // pre-await refusals.
  if (resolveSkillsTargetDir(cwd, "readopt") === null) {
    return { ok: false, code: "copy-failed", message: "this project's skills directory could not be safely resolved (a symlink/junction escapes its working directory) — refusing" };
  }
  if (perSkillDirEscapes(cwd, dest)) {
    return { ok: false, code: "copy-failed", message: `'${name}' at this project is itself a symlink/junction escaping its working directory — refusing` };
  }
  const fingerprintsPath = path.join(targetDir, FINGERPRINTS_FILE);
  const fingerprintsFile = readFingerprintsFile(fingerprintsPath);
  if (!fingerprintsFile.released.has(name)) {
    return { ok: false, code: "not-released", message: `'${name}' is not currently released from Loom management at this project` };
  }
  const currentFp = fingerprintSkillDir(dest);
  if (currentFp !== expectedFingerprint) {
    return { ok: false, code: "fingerprint-mismatch", message: "the on-disk copy has changed since you reviewed it — re-open the diff and try again" };
  }
  // card 8b38b920 CR fix round, item 4 (LEAD DECISION): never overwrite repo-owned content — a released
  // dir with at least one git-tracked file (force-added, or a tracked same-named replacement) is refused
  // outright, rather than silently clobbering something git itself considers committed. Fix round 2
  // (MINOR, tri-state): an UNVERIFIABLE check is refused too, but with its own honest code/message — never
  // reported as a confirmed "tracked" when it is really "couldn't tell."
  if (tracked === "unknown") {
    return { ok: false, code: "track-unknown", message: `'${name}' at this project: could not verify whether the copy is git-tracked — re-open the diff and try again once that can be checked` };
  }
  if (tracked === "tracked") {
    return { ok: false, code: "tracked", message: `'${name}' at this project has at least one git-tracked file under it — refusing to overwrite repo-owned content` };
  }
  const src = path.join(SKILLS_DIR, name);
  if (!fs.existsSync(src)) return { ok: false, code: "copy-failed", message: `'${name}' no longer exists in the skill store` };
  let fragment: string | null = null;
  if (obsidianEnabled) { try { fragment = fs.readFileSync(OBSIDIAN_PREFLIGHT_FRAGMENT, "utf8"); } catch { /* best effort, same degrade real placement gives a missing fragment */ } }
  if (!copySkillAtomic(src, dest)) {
    return { ok: false, code: "copy-failed", message: `failed to re-adopt '${name}' — the previous on-disk copy may be left in place` };
  }
  if (!applyPlacementTransforms(name, dest, fragment)) {
    quarantineUndeliverableDest(dest, name, path.dirname(targetDir));
    return { ok: false, code: "copy-failed", message: `'${name}' could not be safely delivered (its permission-widening content could not be stripped) and was withheld` };
  }
  const fp = fingerprintSkillDir(dest);
  // card 8b38b920 CR fix round, item 5 (nit): do NOT clear `__released` unless `fp` is real — an unreadable
  // fingerprint after a successful copy used to still delete the released record WITHOUT setting
  // `__readopted`, leaving the name neither released (so a human loses visibility) nor readopted (so no
  // live session's "repo's own" skip ever revisits it either) — total silence, strictly worse than before.
  if (!fp) {
    console.log(`[skills] '${name}' at ${cwd}: re-adopt copy succeeded but its fingerprint could not be computed afterward — keeping it released (never clearing without also setting '__readopted') so a human can still see and retry it`);
    return { ok: false, code: "copy-failed", message: `'${name}' was copied but its content could not be verified afterward — left released so you can retry` };
  }
  fingerprintsFile.released.delete(name);
  fingerprintsFile.lastPlaced.set(name, [fp]);
  recordLoomPlacedFingerprint(cwd, name, fp); // same trust-boundary registry injectSkills itself writes on a real placement
  fingerprintsFile.readopted.set(name, { firstSeenAt: Date.now() });
  boundReadopted(fingerprintsFile.readopted);
  try {
    writeJsonAtomic(fingerprintsPath, serializeFingerprintsFile(fingerprintsFile.lastPlaced, fingerprintsFile.pending, fingerprintsFile.released, fingerprintsFile.readopted));
  } catch (e) {
    console.log(`[skills] failed to write fingerprints file ${fingerprintsPath} after re-adopting '${name}': ${(e as Error).message}`);
  }
  console.log(`[skills] '${name}' at ${cwd} was re-adopted by a human: overwritten with the current store copy, awaiting the next live session there to claim it`);
  return { ok: true };
}
