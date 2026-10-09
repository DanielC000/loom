import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { LOOM_HOME } from "../paths.js";
import { canonicalRepoLockKey, isRepoPathCurrentlyResolvable, findExistingAncestorRealpath } from "./repo-lock.js";

/**
 * The QUARANTINE mechanism, DELIBERATELY SEPARATE from merge-danger-window.ts's in-flight/crash-recovery
 * tracker: the in-flight window is a NARROW, SECONDS-LONG span `gracefulShutdown` waits a bounded grace
 * for and a crash-boot residue scan attributes; a quarantine is a POTENTIALLY-PERMANENT state that must
 * survive a restart, must NEVER make a shutdown wait, and must NEVER block an emergency manager recycle.
 *
 * ALWAYS keyed to the CANONICAL repo path, even when raised from a BATCH worktree: the batch worktree's
 * `.git` is a linked worktree of the SAME repo, sharing the SAME hooks directory and object database, so
 * an orphan escaped from a batch candidate's own hook can reach the shared state the canonical repo itself
 * depends on — keying on the (ephemeral, per-attempt) batch worktree path instead left the canonical repo
 * (and every OTHER batch/solo attempt against it) completely unprotected.
 *
 * @decision 24c0bdba (round 4, Code Review b2ebf41f) — see the decision record for the full B-1/B-2
 * incident this closes (round 3 raised a quarantine by reusing the in-flight tracker directly, which a
 * restart silently discarded and which was keyed on the wrong path for a batch-raised quarantine).
 *
 * @decision 7673d096 — the key COLLAPSES two sibling subdir-bound projects of ONE physical repo onto ONE
 * entry: a quarantine against either sibling refuses BOTH, and ONE human clear lifts it for both — intended.
 */
export interface MergeQuarantineEntry {
  repoPath: string;
  branch: string;
  reason: string;
  opId?: string;
  enteredAt: number;
  /** A SET of outstanding per-raise tokens, not a scalar — a repo can be quarantined by more than one
   *  unconfirmed kill at once. {@link clearMergeQuarantineByToken} removes only its own token; the repo is
   *  lifted only once the set is EMPTY.
   *
   *  @decision 24c0bdba (round 7, M1) — see the decision record for the full ta/tb primitive repro this
   *  closes (a scalar token let a later raiser's own auto-clear silently lift an earlier raiser's own
   *  still-unconfirmed threat). */
  tokens: string[];
  /** Boot-time filenames (not full paths) of other latch file(s) this entry still needs swept once
   *  nothing references them any more. {@link clearMergeQuarantine} deletes a name listed here once no
   *  OTHER active entry still references/owns it.
   *
   *  @decision 24c0bdba (round 7, M2) — see the decision record for the fail-closed trap this closes (an
   *  orphan latch that nothing ever deleted re-quarantined every registered repo on every later boot).
   *
   *  @decision a6fa60e2 — see the decision record for why an ORDINARY, non-placeholder entry can also
   *  carry its own stale-key copy here (a failed migrate write leaves it owning nothing otherwise). */
  orphanLatchFiles?: string[];
  /** The exact `canonicalRepoLockKey(repoPath)` value at the moment this entry was raised (or last
   *  migrated to a fresh key) — `undefined` for a latch written before this field existed. Lets boot-time
   *  re-entry arm enforcement under this ORIGINAL key too, even when `repoPath` can't currently be
   *  re-resolved to verify it (see {@link reenterMergeQuarantinesAtBoot}'s PASS 1).
   *
   *  @decision 7673d096 — never trust a freshly-recomputed key enough to migrate/discard a durable latch
   *  when `repoPath` isn't currently resolvable (see `isRepoPathCurrentlyResolvable`) — record this instead. */
  resolvedKey?: string;
  /** IN-MEMORY BOOKKEEPING ONLY — never persisted ({@link writeMergeQuarantineLatch} strips it before
   *  serializing). The full set of `activeQuarantines` map keys this exact logical entry currently
   *  occupies, threaded through every arm/union/merge ({@link armQuarantineKey},
   *  {@link unionQuarantineEntries}, PASS 2's orphan merge). `clearMergeQuarantine`/
   *  `clearMergeQuarantineByToken` lift every key named here instead of scanning the map for reference
   *  equality — which breaks the moment an entry is REBUILT (a union, an orphan merge) rather than mutated
   *  in place, since the rebuilt object is no longer `===` the one still sitting at another of its own keys.
   *
   *  @decision 54054c01 (Code Review round 2) — see the decision record for the R3 repro this closes. */
  armedKeys?: string[];
  /** `true` only for a GENERIC fail-closed/self-heal placeholder this module minted itself (boot-time
   *  dir-scan failure, a corrupt-matched latch/tmp, or an orphan with no entry of its own) — never for a
   *  real, raise-time entry. Unlike `armedKeys`, this IS persisted: it must survive to the NEXT boot, where
   *  a cleanly-parsing placeholder final would otherwise be indistinguishable from real data (see
   *  {@link reenterMergeQuarantinesAtBoot}'s `cleanlyParsedKeys` gate) and {@link unionQuarantineEntries}
   *  would have no basis to prefer a real sibling's identity over it.
   *
   *  @decision 92c645cc (round 2) — see the decision record for the two-boot repro this closes (a
   *  placeholder's own self-heal write succeeds while a real tmp's promote fails; the NEXT boot then reads
   *  the placeholder as a clean parse and deletes the still-only-durable-copy real tmp). */
  placeholder?: true;
}

/** The two literal `branch` strings this module writes into every GENERIC placeholder entry it mints
 *  itself (never a real raise) — centralized so every call site shares the exact text, and so
 *  {@link isPlaceholderEntryShape} can recognize a LEGACY placeholder final/tmp written before the
 *  `placeholder` field existed (round-1/main code), by branch text alone, with no risk of misfiring on a
 *  genuine entry: a real git branch name cannot contain a space or a `(` (`git check-ref-format` rejects
 *  both), so neither string can ever be an actual branch someone raised a quarantine for.
 *
 * @decision 92c645cc (round 2) — do not inline either string at a new call site; reuse these consts, or a
 * hand-copied drift between two call sites reopens the exact gap the branch-text fallback exists to close. */
export const PLACEHOLDER_BRANCH_CORRUPT = "(unknown — corrupt boot-time latch)";
export const PLACEHOLDER_BRANCH_UNRESOLVED = "(unknown — boot could not resolve which repo/branch this protects)";

/** `true` for an in-memory {@link MergeQuarantineEntry} (via its own `placeholder` field) OR a raw,
 *  not-yet-validated parsed-JSON object (via the legacy branch-text fallback — see the consts' own doc
 *  comment for why that fallback can never misfire on a real entry). */
function isPlaceholderEntryShape(parsed: { placeholder?: unknown; branch?: unknown }): boolean {
  return parsed.placeholder === true || parsed.branch === PLACEHOLDER_BRANCH_CORRUPT || parsed.branch === PLACEHOLDER_BRANCH_UNRESOLVED;
}

const activeQuarantines = new Map<string, MergeQuarantineEntry>();

/** Dedup set for {@link wouldOverwriteDifferentUnresolvableOccupant}'s own refusal log — one entry per
 *  `<final path>|<occupant identity>` pair, so a query repeated many times over one process's lifetime
 *  logs the refusal ONCE, not once per query. Never cleared mid-process; a fresh process (reboot) starts
 *  fresh. */
const loggedDegradedOccupantRefusals = new Set<string>();

/** One {@link reenterMergeQuarantinesAtBoot} PASS 1 entry that could NOT be key-verified at all — no
 *  `resolvedKey` to dual-arm under (a pre-7673d096 latch), AND the registered path was unresolvable at
 *  load time. Arming it under the one key computed THEN (an existing-ancestor fallback, while absent)
 *  would enforce against a key a later remount in the SAME boot will never actually produce — instead it
 *  sits here, out of `activeQuarantines` entirely, and {@link activeMergeQuarantineFor} re-resolves it
 *  lazily on every query — matched by stored identity first (never a blind key recompute), then, only once
 *  this entry's OWN path genuinely resolves again, by a real (not coincidental) walked key (round 7).
 *
 *  `sourceFile` (the on-disk filename, not a full path, this entry was loaded from — PASS 1 deliberately
 *  never migrates/deletes it while pending, since its key can't be verified) lets a later clear OR a
 *  successful graduation ({@link activeMergeQuarantineFor}) clean it up explicitly, rather than leaving it
 *  to resurrect the quarantine on a later boot (round 2 finding 1).
 */
interface PendingUnresolvedQuarantine {
  entry: MergeQuarantineEntry;
  sourceFile: string;
}
let pendingUnresolvedQuarantines: PendingUnresolvedQuarantine[] = [];

/** Every `pendingUnresolvedQuarantines` index satisfying `pred` — never just the first (card 188b145f,
 *  round 2). Shared by {@link activeMergeQuarantineFor}'s lazy-graduation match cascade and
 *  {@link enterMergeQuarantine}'s own pending-merge branch: both used to `findIndex` a single match and
 *  consume only it, silently stranding every OTHER identity-matching pending entry forever (its own
 *  tokens invisible, its own sourceFile never folded in, the repo permanently duplicate-listed) whenever
 *  more than one existed for the same repo. Collecting every index here is what lets each caller union
 *  and consume all of them together in one step instead. */
function collectPendingIndices(pred: (p: PendingUnresolvedQuarantine) => boolean): number[] {
  return pendingUnresolvedQuarantines.reduce<number[]>((acc, p, i) => { if (pred(p)) acc.push(i); return acc; }, []);
}

/** Every `pendingUnresolvedQuarantines` index (excluding `excludeIndices`) whose own path currently
 *  resolves and whose `canonicalRepoLockKey` equals `key` — the SAME tier-3 predicate
 *  {@link activeMergeQuarantineFor}'s own three-tier cascade already trusts for graduation, applied here
 *  to absorb a SIBLING pending entry that the winning match never catches on its own identity (card
 *  `8a1bc2ef`): two separately-registered repo paths bound to ONE physical repo (card `7673d096` — e.g. a
 *  project at a repo's toplevel and another at one of its subdirs) collapse onto the same canonical key
 *  once both resolve, but each keeps its OWN `directPathIdentity`, so neither tier 1 nor tier 2 of that
 *  cascade — nor a bare `activeQuarantines.get(key)` hit, nor `enterMergeQuarantine`'s own
 *  `directPathIdentity`-only pending match — ever sees the other as a match. Selects indices ONLY — every
 *  caller must still route the result through {@link consumeMatchedPendingsIntoArmedEntry}, never splice
 *  or union anything here directly. */
function collectCrossTierSiblingIndices(key: string, excludeIndices: number[]): number[] {
  return collectPendingIndices((p) => isRepoPathCurrentlyResolvable(p.entry.repoPath) && canonicalRepoLockKey(p.entry.repoPath) === key)
    .filter((i) => !excludeIndices.includes(i));
}

/** `true` iff `repoPath` currently resolves AND its OWN freshly-recomputed `canonicalRepoLockKey` equals
 *  `key` — i.e. `repoPath` is GENUINELY, currently verified to BE the repo at `key`, never merely "armed
 *  there" (card `8a1bc2ef`, round 2 — Code Review repro): an entry can occupy `key` via PASS 1's own
 *  degraded dual-arm fallback (its OWN `repoPath` unresolvable at boot, so `canonicalRepoLockKey` walked
 *  up to an ENCLOSING repo and dual-armed there) without `repoPath` ever having been confirmed to
 *  actually BE that enclosing repo. Absorbing a cross-tier sibling into such a receiver would merge a
 *  genuinely unrelated, still-pending quarantine into one that isn't verified to be at that key at all —
 *  gate every cross-tier absorb INTO an already-armed/already-raised entry on this check first. */
function isKeyVerifiedFor(repoPath: string, key: string): boolean {
  return isRepoPathCurrentlyResolvable(repoPath) && canonicalRepoLockKey(repoPath) === key;
}

export const MERGE_QUARANTINE_DIR = path.join(LOOM_HOME, "merge-quarantines");

/** Hash a raw canonical-repo-lock KEY directly (never a repoPath) — the primitive every other
 *  `quarantineHashFor`/`quarantinePathFor`/residue helper below delegates to, so a caller holding an
 *  entry's recorded {@link MergeQuarantineEntry.resolvedKey} (which may now differ from what
 *  `canonicalRepoLockKey(repoPath)` recomputes) can still address that entry's own on-disk latch without
 *  re-deriving the key from a repoPath it may not even trust. */
function quarantineHashForKey(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

/** The stable hash component of a quarantine latch's filename for `repoPath` — factored out of
 *  {@link quarantinePathFor} so boot-time re-entry can compute the SAME hash for every REGISTERED repo and
 *  match it against an unparsable latch's filename (round 6, BLOCKER 2) without reconstructing the path. */
function quarantineHashFor(repoPath: string): string {
  return quarantineHashForKey(canonicalRepoLockKey(repoPath));
}

/**
 * @decision f5c42043 — never write/arm at one of these hashes; an ancestor walk is never proof that `p`
 * itself owns a corrupt latch, only that it WOULD have degraded there. Pure pending-divert only.
 */
function ancestorToplevelHashes(p: string): string[] {
  const hashes = new Set<string>();
  let dir = path.dirname(path.resolve(p));
  for (;;) {
    // Gated on existence purely to SKIP a redundant walk, never to drop a reachable key —
    // canonicalRepoLockKey already tolerates a non-existent node internally (@decision 7673d096) and
    // would just re-derive the SAME value a higher existing ancestor's own walk already produces.
    if (fs.existsSync(dir)) hashes.add(quarantineHashForKey(canonicalRepoLockKey(dir)));
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return [...hashes];
}

/**
 * Direct (non-walking) path identity: realpath + lowercase-on-win32 of `repoPath` AS GIVEN, falling back
 * to `path.resolve` when it doesn't currently exist on disk at all — deliberately NEVER walking up to find
 * an enclosing git toplevel (unlike `canonicalRepoLockKey`). Factored out of {@link legacyQuarantineHashFor}
 * (which hashes it — see that function's own "frozen, never change" doc, unaffected by this extraction) so
 * {@link clearMergeQuarantineByRecordedPath} can also compare it DIRECTLY, never hashed, against an entry's
 * own stored `repoPath` field.
 *
 * @decision abccee85 — comparing this identity (never a freshly-recomputed, walking `canonicalRepoLockKey`)
 * is what makes a stored-repoPath match immune to a nested `.git` disappearing between match and act; see
 * `clearMergeQuarantineByRecordedPath`'s own doc for the drift this closes.
 */
function directPathIdentity(repoPath: string): string {
  let real: string;
  try { real = fs.realpathSync.native(repoPath); } catch { real = path.resolve(repoPath); }
  return process.platform === "win32" ? real.toLowerCase() : real;
}

/**
 * A SEPARATE, newer comparison identity (card abccee85, round 7) — never folded into
 * {@link directPathIdentity} itself, which is frozen (its legacy hash depends on it byte-for-byte). When
 * `repoPath` doesn't currently resolve, `directPathIdentity`'s own fallback is a plain `path.resolve` —
 * no filesystem lookup at all — so a junction/8.3-short-name alias spelling an EXISTING ancestor segment
 * differently than the spelling used elsewhere (e.g. the query's own, fully-resolvable path) makes two
 * strings that denote the SAME physical location compare unequal for no reason but spelling.
 *
 * This normalizes via {@link findExistingAncestorRealpath} (never `canonicalRepoLockKey`'s own toplevel
 * walk, which looks for an enclosing `.git` — reusing THAT here would reopen the exact (S)/(T)/(W)
 * coincidental-ancestor-collision hazard `directPathIdentity`-only pending-matching exists to close):
 * realpath the nearest EXISTING ancestor (resolving any junction/8.3 alias on it), then reattach whatever
 * trailing segments don't exist yet, literally. A non-existent tail is never normalized, so this can only
 * ever match two paths that are genuinely the SAME location (including the same non-existent tail) —
 * never two different-but-unresolvable paths that merely share a real ancestor.
 */
function ancestorAwarePathIdentity(repoPath: string): string {
  const real = findExistingAncestorRealpath(repoPath);
  return process.platform === "win32" ? real.toLowerCase() : real;
}

/**
 * FROZEN replica of the PRE-7673d096 `canonicalRepoLockKey` (realpath + lowercase-on-win32 of the BOUND
 * path directly, no toplevel walk) — kept ONLY so boot-time re-entry can still match a latch (or `.tmp`
 * residue) a pre-upgrade daemon filed under that old scheme to its OWN registered repo, rather than letting
 * it fall through to the broad every-repo fail-closed sweep. Never "fix" this to match current behavior —
 * its entire purpose is to reproduce the OLD one.
 *
 * @decision 7673d096 — if `canonicalRepoLockKey` itself ever changes again, add a THIRD legacy replica here
 * rather than updating this one; each represents one real on-disk naming era a running fleet may still hold
 * latches under.
 */
function legacyQuarantineHashFor(repoPath: string): string {
  return createHash("sha256").update(directPathIdentity(repoPath)).digest("hex").slice(0, 24);
}

function quarantinePathForKey(key: string): string {
  return path.join(MERGE_QUARANTINE_DIR, `${quarantineHashForKey(key)}.json`);
}

function quarantinePathFor(repoPath: string): string {
  return quarantinePathForKey(canonicalRepoLockKey(repoPath));
}

/**
 * Merge two quarantine entries that have come to share ONE key (e.g. two latches for what the toplevel walk
 * now recognizes as the same physical repo) — union their token sets (a repo can be quarantined by more
 * than one outstanding raise) and keep the EARLIER identity (repoPath/branch/reason/opId/enteredAt/
 * resolvedKey), mirroring {@link enterMergeQuarantine}'s own "longest-outstanding, still-unresolved raise"
 * rule. Also unions `orphanLatchFiles`. Safe to call with `a === b` (a no-op merge).
 *
 * @decision 92c645cc (round 2, item 3) — never let `enteredAt` arbitrate placeholder-vs-real; a
 * placeholder's own `Date.now()` stamp (or a tmp missing `enteredAt`, or a clock set back) can otherwise
 * coincidentally look "older" and let fail-closed boilerplate win over a real identity.
 */
function unionQuarantineEntries(a: MergeQuarantineEntry, b: MergeQuarantineEntry): MergeQuarantineEntry {
  const aIsPlaceholder = isPlaceholderEntryShape(a);
  const bIsPlaceholder = isPlaceholderEntryShape(b);
  const [older, newer] = aIsPlaceholder !== bIsPlaceholder
    ? (aIsPlaceholder ? [b, a] : [a, b])
    : (a.enteredAt <= b.enteredAt ? [a, b] : [b, a]);
  const orphanLatchFiles = older.orphanLatchFiles || newer.orphanLatchFiles
    ? [...new Set([...(older.orphanLatchFiles ?? []), ...(newer.orphanLatchFiles ?? [])])]
    : undefined;
  const armedKeys = [...new Set([...(older.armedKeys ?? []), ...(newer.armedKeys ?? [])])];
  return { ...older, tokens: [...new Set([...older.tokens, ...newer.tokens])], orphanLatchFiles, armedKeys };
}

/**
 * THE single chokepoint for replacing an entry OBJECT with a new one representing the SAME LOGICAL
 * IDENTITY (a fold, a re-point, an orphan-ref merge — NEVER a union of two possibly-different
 * identities sharing a key; see {@link armQuarantineKey}'s own doc for why that case is excluded).
 * Keeps `byRepoKey` AND `pendingUnresolvedQuarantines` in sync regardless of which side's own write
 * triggered the replacement, scanning `byRepoKey` by VALUE (never trusting `oldEntry.armedKeys` to be
 * complete). Cards a2f381dc and fd189d91 item (d) are the SAME bug, reached from opposite directions —
 * see the decision record.
 */
function replaceEntryEverywhere(byRepoKey: Map<string, MergeQuarantineEntry>, oldEntry: MergeQuarantineEntry, newEntry: MergeQuarantineEntry): void {
  if (oldEntry === newEntry) return;
  for (const [k, v] of byRepoKey) {
    if (v === oldEntry) byRepoKey.set(k, newEntry);
  }
  for (const p of pendingUnresolvedQuarantines) {
    if (p.entry === oldEntry) p.entry = newEntry;
  }
}

/** Set `key` -> `entry` in `byRepoKey`, UNIONING with whatever entry (if any) already occupies that key
 *  rather than silently overwriting it — see {@link unionQuarantineEntries}. Every boot-time PASS 1/1b
 *  write into `byRepoKey` must route through this, never a bare `.set()`, since the toplevel walk can make
 *  two previously-distinct latches collapse onto the same key. Also folds `key` itself into the result's
 *  `armedKeys` and returns the final (armed) object — a caller dual-arming the SAME entry under a SECOND
 *  key must pass this call's return value as the `entry` for that second call (see PASS 1/1b), or the
 *  second key's slot ends up with an `armedKeys` missing the first.
 *
 *  @decision 54054c01 — set the final armed object at EVERY key in its OWN armedKeys, not just `key` — a
 *  union can inherit a key from an already-dual-armed `prior`, which would otherwise keep pointing stale.
 *
 *  @decision fd189d91 — never route unconditionally through {@link replaceEntryEverywhere}: `prior`/
 *  `entry` can be two different identities sharing one key. See the decision record.
 *
 *  @decision a2f381dc — the exclusion is IDENTITY-CONDITIONAL (compare `prior` against `armed`, not
 *  `entry`), never absolute — see the decision record for the M-1 fix and why M-2 stays excluded. */
function armQuarantineKey(byRepoKey: Map<string, MergeQuarantineEntry>, key: string, entry: MergeQuarantineEntry): MergeQuarantineEntry {
  const prior = byRepoKey.get(key);
  const merged = prior ? unionQuarantineEntries(prior, entry) : entry;
  const armed: MergeQuarantineEntry = { ...merged, armedKeys: [...new Set([...(merged.armedKeys ?? []), key])] };
  if (prior && directPathIdentity(prior.repoPath) === directPathIdentity(armed.repoPath)) {
    replaceEntryEverywhere(byRepoKey, prior, armed);
  }
  for (const k of armed.armedKeys ?? [key]) byRepoKey.set(k, armed);
  return armed;
}

/**
 * The runtime twin of {@link reenterMergeQuarantinesAtBoot}'s own `degradedOccupiedKeys` check —
 * `degradedOccupiedKeys` is a `Set` LOCAL to that one boot call, discarded the moment it returns, so a
 * runtime mutation (reached long after boot, once the in-memory state has already merged everything into
 * one object) has no equivalent live signal to consult. This re-derives the same fact on demand, by
 * reading whatever is CURRENTLY on disk at `final` instead of a precomputed boot-time scan.
 *
 * Four branches, in order: a corrupt or missing existing file has nothing to protect (`undefined`); the
 * SAME identity (compared via {@link directPathIdentity}, matching {@link armQuarantineKey}'s own M-1
 * check and {@link clearMergeQuarantineByKey}'s own pending-filter — never {@link ancestorAwarePathIdentity},
 * which answers a different question: normalizing an UNRESOLVABLE query path against a resolvable
 * ancestor, not comparing two already-concrete repoPath strings) is always safe to touch (`undefined`);
 * a DIFFERENT identity that is CURRENTLY RESOLVABLE is also safe — today's existing, legitimate
 * overwrite-a-stale-different-repo's-leftover-file case (`undefined`); only a DIFFERENT identity
 * that is CURRENTLY UNRESOLVABLE is flagged (its own `repoPath`, truthy) — that identity has no other way
 * to get its data back, so `final` is its sole durable copy, exactly the hazard `degradedOccupiedKeys`
 * exists to prevent at boot.
 *
 * Used ONLY by {@link wouldOverwriteDifferentUnresolvableOccupant} (gates a WRITE) — NOT by
 * {@link deleteMergeQuarantineLatchByKey}/{@link clearMergeQuarantineByKey}, despite the identical-looking
 * hazard: an ordinary CLEAR/DELETE of a resolvable repo colliding with a degraded occupant's own key is
 * OUT OF SCOPE for this guard (a draft that gated the delete side too was tried and RETRACTED — see the
 * decision record's "Do not" section for why).
 *
 * @decision e1cb7d33 — see the decision record.
 */
function differentUnresolvableOccupantRepoPathAt(final: string, ownIdentityRepoPath: string): string | undefined {
  let existingRaw: string;
  try {
    existingRaw = fs.readFileSync(final, "utf8");
  } catch {
    return undefined; // missing — nothing to protect
  }
  let existing: { repoPath?: unknown };
  try {
    existing = JSON.parse(existingRaw);
  } catch {
    return undefined; // corrupt — nothing to protect
  }
  if (typeof existing.repoPath !== "string") return undefined;
  if (directPathIdentity(existing.repoPath) === directPathIdentity(ownIdentityRepoPath)) return undefined; // same identity
  if (isRepoPathCurrentlyResolvable(existing.repoPath)) return undefined; // different but resolvable — today's behavior
  return existing.repoPath;
}

/**
 * Boolean, write-side wrapper of {@link differentUnresolvableOccupantRepoPathAt} — logs its refusal ONCE
 * per `(final, occupant identity)` pair per process (see {@link loggedDegradedOccupantRefusals}), never
 * once per query — a refusal recurs on every subsequent query of the identity that triggered it, for the
 * lifetime of the process.
 *
 * @decision e1cb7d33 — see the decision record.
 */
function wouldOverwriteDifferentUnresolvableOccupant(final: string, entry: MergeQuarantineEntry): boolean {
  const occupantRepoPath = differentUnresolvableOccupantRepoPathAt(final, entry.repoPath);
  if (!occupantRepoPath) return false;
  const dedupeKey = `${final}|${directPathIdentity(occupantRepoPath)}`;
  if (!loggedDegradedOccupantRefusals.has(dedupeKey)) {
    loggedDegradedOccupantRefusals.add(dedupeKey);
    // eslint-disable-next-line no-console
    console.error(`[merge-quarantine] refusing to write ${path.basename(final)} for ${entry.repoPath} — this key's own physical file is a DIFFERENT, currently-unresolvable entry's own exclusive backing (${occupantRepoPath}); overwriting it would destroy that entry's only durable copy. ${entry.repoPath} stays enforced in-memory only for this process; a later boot (or this process re-reading the file) can still recover ${occupantRepoPath}'s own data untouched. (Logged once per key+occupant per process — this refusal recurs on every subsequent query.)`);
  }
  return true;
}

/**
 * Durable write, ATOMIC (tmp + rename, FSYNC'd before the rename — round 6, BLOCKER 2), mirrors
 * merge-danger-latch.ts's own discipline. Unlike that latch, this file is NOT consume-on-read at boot: it
 * IS the persistent quarantine state, so boot loads it back in rather than discarding it (see
 * {@link reenterMergeQuarantinesAtBoot}).
 *
 * Returns `false` (never throws) on failure. The in-memory quarantine — already applied by the caller
 * BEFORE this runs — still takes effect for THIS process either way, but a caller MUST treat `false`
 * loudly: a failed durable write means this quarantine will NOT survive a restart, silently reopening the
 * exact restart-lifts-it bypass round 4 closed. This function itself logs the raw failure; the caller
 * ({@link enterMergeQuarantine}) additionally logs the repo-identifying consequence.
 *
 * @decision 92c645cc — never go back to a deterministic tmp name (it truncates an earlier durable tmp
 * before this write is confirmed); never pass `sweepOtherTmpsOnSuccess:true` unless the entry is proven a
 * superset of any older tmp for the same key.
 *
 * @decision 97cff6db (round 3) — `targetKey`, when given, names the write target directly: a recovered
 * safety-tmp's union can win its identity from a degraded occupant whose `repoPath` does NOT
 * canonical-key back to the key it is actually being recovered for.
 *
 * @decision e1cb7d33 — the ONE chokepoint for {@link wouldOverwriteDifferentUnresolvableOccupant}.
 * TWO opt-out families: `bootWriteLatch` (Phase 0 already secured the at-risk content) and
 * {@link enterMergeQuarantine} (a refused raise is lost on reboot). See the decision record.
 */
function writeMergeQuarantineLatch(entry: MergeQuarantineEntry, sweepOtherTmpsOnSuccess = false, targetKey?: string, skipDegradedOccupantGuard = false): boolean {
  let fd: number | undefined;
  try {
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const final = targetKey ? quarantinePathForKey(targetKey) : quarantinePathFor(entry.repoPath);
    if (!skipDegradedOccupantGuard && wouldOverwriteDifferentUnresolvableOccupant(final, entry)) return false;
    const tmp = `${final}.tmp-${process.pid}-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    fd = fs.openSync(tmp, "w");
    // `armedKeys` is IN-MEMORY bookkeeping only (see its own doc comment) — never persisted. A restart
    // rebuilds it fresh via arming, and a stale persisted value from a PRIOR process's keying would be
    // actively misleading to a human reading the raw file.
    const { armedKeys: _armedKeys, ...persistable } = entry;
    fs.writeSync(fd, JSON.stringify(persistable, null, 2) + "\n");
    fs.fsyncSync(fd); // round 6 — durable on disk BEFORE the rename makes it visible, not just buffered
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, final);
    // @decision 92c645cc (item 2) — only AFTER this write's own rename has durably superseded whatever was
    // there before (bde5d1fe's rule: sweep/unlink only follows a successful superseding write) — and only
    // when the CALLER has asserted the superset property holds for this entry.
    //
    // @decision be79f4d5 (round 3) — "proven superset" is a claim about THIS entry's own history, never
    // about who else references a same-hash tmp — sweep reference-aware, never unconditional-by-hash.
    if (sweepOtherTmpsOnSuccess) sweepTmpResidueForHashIfUnreferenced(quarantineHashFor(entry.repoPath));
    return true;
  } catch (e) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already broken; nothing more to close */ } }
    // @decision bde5d1fe (round 2, reverting round 1) — do NOT unlink: fsync'd, it's the ONLY durable
    // record of an ACTIVE quarantine. PASS 1b recovers it at boot; CLEAR paths sweep it instead.
    // eslint-disable-next-line no-console
    console.error(`[merge-quarantine] FAILED to durably persist the quarantine latch for ${entry.repoPath} (branch '${entry.branch}'): ${(e as Error).message}`);
    return false;
  }
}

/**
 * Matches ONLY a safety-tmp residue's own distinct filename shape — `<hash>.json.tmp-safety-<pid>-<hex>`.
 * Deliberately disjoint from the ORDINARY tmp pattern (`\.json\.tmp-\d+(-[0-9a-f]+)?$`, which requires
 * digits immediately after `.tmp-`): recovery must tell the two apart BY NAME, never by inference (Lead
 * ruling, card 97cff6db round 2) — an ordinary tmp is a genuinely-stale, discardable torn-write residue;
 * a safety-tmp is a durable pre-image of a key's own union that must always be UNIONED into that key's
 * final, never blind-deleted. See the decision record for the full reasoning.
 */
const SAFETY_TMP_RE = /\.json\.tmp-safety-\d+-[0-9a-f]+$/;

/**
 * Durably write `entry`'s own union as a `.json.tmp-safety-<pid>-<hex>` RESIDUE at `hash` directly — the
 * SAME tmp-write primitive `writeMergeQuarantineLatch` itself uses (open, write, fsync, close), but
 * deliberately NEVER renamed to the final name. Returns the tmp's own absolute path on success, or
 * `false` (never throws) on failure.
 *
 * @decision 97cff6db — call this BEFORE any write in the same pass could clobber a path this entry's data
 * currently occupies, never after. See the decision record for the repro and why this is the durable floor.
 *
 * @decision ef651188 — extracted so a PENDING entry (no verified key at all) can secure itself at the
 * hash already embedded in its own `sourceFile`. See the decision record for the mis-attribution residual.
 *
 * @decision ef651188 (round 2, CRITICAL 1) — `selfReference`, when true, bakes this tmp's OWN basename
 * into `entry.orphanLatchFiles` BEFORE writing, so a later boot's recovery read carries the self-reference
 * from disk alone, never only from the caller's own in-memory re-point. See the decision record.
 */
function writeSafetyTmpResidueAtHash(hash: string, entry: MergeQuarantineEntry, selfReference = false): string | false {
  let fd: number | undefined;
  const final = path.join(MERGE_QUARANTINE_DIR, `${hash}.json`);
  const tmp = `${final}.tmp-safety-${process.pid}-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  try {
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    fd = fs.openSync(tmp, "w");
    const { armedKeys: _armedKeys, ...persistable } = entry;
    const toPersist = selfReference
      ? { ...persistable, orphanLatchFiles: [...new Set([...(persistable.orphanLatchFiles ?? []), path.basename(tmp)])] }
      : persistable;
    fs.writeSync(fd, JSON.stringify(toPersist, null, 2) + "\n");
    fs.fsyncSync(fd); // durable on disk before this function returns — the whole point of a SAFETY copy
    fs.closeSync(fd);
    fd = undefined;
    return tmp;
  } catch (e) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already broken; nothing more to close */ } }
    // eslint-disable-next-line no-console
    console.error(`[merge-quarantine] FAILED to write a safety-tmp residue for ${entry.repoPath} (branch '${entry.branch}') before a risky write: ${(e as Error).message}`);
    return false;
  }
}

/**
 * `key`-addressed wrapper of {@link writeSafetyTmpResidueAtHash} for a caller holding a VERIFIED key (a
 * migrating/degraded-occupied key's own target) — never derive `key` from `entry.repoPath`: a
 * degraded-occupied union can carry the occupant's own unresolvable `repoPath` as its winning identity
 * (`unionQuarantineEntries`'s tie-break), so recomputing the key from that path produces the wrong hash.
 */
function writeSafetyTmpResidue(key: string, entry: MergeQuarantineEntry): string | false {
  return writeSafetyTmpResidueAtHash(quarantineHashForKey(key), entry);
}

/**
 * Best-effort fsync of `MERGE_QUARANTINE_DIR` itself, never throws. Belt-and-suspenders on top of each
 * safety-tmp's own per-FILE fsync (which is what actually matters for THAT file's content durability):
 * on a filesystem that requires it, the DIRECTORY ENTRY for a newly-created file is not itself durable
 * until the containing directory is also fsync'd. Some platforms (notably Windows) don't support
 * `fsync` on a directory handle at all — that failure is swallowed silently, since the per-file fsync
 * already covers the property this call exists to harden, not originate.
 */
function fsyncQuarantineDir(): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(MERGE_QUARANTINE_DIR, "r");
    fs.fsyncSync(fd);
  } catch { /* best-effort — not every platform/filesystem supports a directory fsync */ } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already broken; nothing more to close */ } }
  }
}

/**
 * Delete `sourceFile` (a latch basename previously loaded from disk — a stale/legacy/pending source,
 * never a full path) ONLY IF it is NOT the same file `writtenEntry` was just durably written under.
 * Returns `true` on a genuine success (deleted, ENOENT/already-gone, or a no-op skip because it IS the
 * fresh write target) and `false` only when an unlink was actually attempted and failed (e.g. EBUSY) —
 * card `8a1bc2ef`: the caller must fold a `false` into `orphanLatchFiles` rather than silently swallow
 * it, or the surviving file goes untracked (see {@link consumeMatchedPendingsIntoArmedEntry}'s own doc).
 *
 * @decision 54054c01 (Code Review round 3, CRITICAL) — for a repo bound at its own git toplevel, the old
 * and current key algorithms compute the IDENTICAL value, so a stale source's name can equal the file a
 * graduation/merge just wrote — unlinking unconditionally deletes the quarantine just written, not a leftover.
 *
 * Shared by graduation, `enterMergeQuarantine`'s merge-into-pending path, and PASS 1's migrate branch (see
 * docs/decisions/54054c01-clear-lifts-every-key-an-entry-was-armed-under.md for the full repro).
 *
 * @decision 882d6cff (round 3) — ALSO a no-op (kept, `true`) when a DIFFERENT, still-pending entry
 * still names `sourceFile` as its own (multiple unresolvable claimants can share one source) — never
 * collaterally destroy a surviving sibling's own evidence. See the decision record.
 *
 * @decision 97cff6db (round 4, finding G1) — ALSO a no-op (`true`, nothing to fold) when a DIFFERENT,
 * currently-ACTIVE entry now physically owns `sourceFile` ({@link physicalOwnerRepoPaths}, decision
 * 9cabd143) — never unlink a filename a live sibling has since claimed. See the decision record.
 *
 * @decision 97cff6db (round 5) — takes `key` explicitly, never `writtenEntry.repoPath`: the write this
 * call follows already targeted `key` (via `targetKey`), so the deletion check must key off the SAME
 * identity, not a fresh, possibly-degraded recompute. See the decision record.
 */
function deleteSourceLatchIfSuperseded(sourceFile: string, writtenEntry: MergeQuarantineEntry, key: string): boolean {
  const writtenFile = path.basename(quarantinePathForKey(key));
  if (sourceFile === writtenFile) return true; // the "stale" source IS the file we just wrote — nothing to delete
  if (pendingUnresolvedQuarantines.some((p) => p.sourceFile === sourceFile)) return true; // a sibling still owns it
  // Excludes writtenEntry's OWN identity: a legitimately dual-armed entry can have ITS OWN alternate key
  // hash to this exact filename too (physicalOwnerRepoPaths doesn't special-case "the entry being
  // written"), and that must never be mistaken for a DIFFERENT repo's live ownership.
  const owners = physicalOwnerRepoPaths(sourceFile).filter((o) => directPathIdentity(o) !== directPathIdentity(writtenEntry.repoPath));
  if (owners.length > 0) return true; // owned elsewhere now — not ours to touch, and nothing to fold
  try {
    fs.unlinkSync(path.join(MERGE_QUARANTINE_DIR, sourceFile));
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT"; // already gone is a genuine success, never a fold-worthy failure
  }
}

/**
 * THE ONE place `pendingUnresolvedQuarantines` entries at `indices` get consumed into a single armed
 * entry under `key` — shared by {@link activeMergeQuarantineFor}'s lazy-graduation branch and
 * {@link enterMergeQuarantine}'s own pending-merge branch (card 188b145f, round 3; Delta Code Review
 * `f61b7f6e` found the two callers had drifted — `enterMergeQuarantine`'s own inline copy never spliced
 * or folded on a FAILED write). `extra` is an additional entry to union in last (a fresh raise, for
 * `enterMergeQuarantine`) — omit it for a bare graduation query, which has nothing else to union.
 *
 * Splices every matched index out of `pendingUnresolvedQuarantines` UNCONDITIONALLY, before the durable
 * write is even attempted — enforcement for THIS process must not wait on disk I/O succeeding, and a
 * LATER query/raise must never re-discover these as still pending (that re-discovery, via a stale
 * `findIndex` that only ever consumed the first match, is the whole defect class this helper exists to
 * close once, for every caller, rather than per call site).
 *
 * @decision be79f4d5 — every matched entry's own `sourceFile` is stripped from the unioned
 * `orphanLatchFiles` BEFORE the write is attempted, or a dangling self-reference falsely "protects" a
 * file this same write is about to delete on success.
 *
 * On success, every matched `sourceFile` is deleted via {@link deleteSourceLatchIfSuperseded} (a safe
 * per-file no-op, looped). On FAILURE, every matched `sourceFile` (skipping only one that already equals
 * the fresh write target) is folded into the armed entry's `orphanLatchFiles` instead — so a raw
 * clear-by-id of ANY of their stale hashes keeps them, never destroying the quarantine's only durable copy.
 *
 * @decision 8a1bc2ef (item 2) — a per-file delete failure (EBUSY) on an otherwise-successful write is
 * folded into `orphanLatchFiles` too, like the whole-write failure branch — see the decision record for
 * the untracked-file/fail-closed-reboot repro this closes.
 *
 * @decision 8a1bc2ef (item 1) — `armedKeys` is UNIONED and armed at every one of those keys, never
 * overwritten to `[key]` alone — see the decision record for the dual-arm stranding this closes.
 *
 * @decision e1cb7d33 — `skipDegradedOccupantGuard` forwards to both own `writeMergeQuarantineLatch` calls;
 * passed `true` ONLY by {@link enterMergeQuarantine}'s own call sites (a RAISE must persist). Every other
 * caller (`activeMergeQuarantineFor`, a QUERY) leaves it `false`. See the decision record.
 */
function consumeMatchedPendingsIntoArmedEntry(
  indices: number[],
  key: string,
  extra?: MergeQuarantineEntry,
  skipDegradedOccupantGuard = false,
): { armed: MergeQuarantineEntry; matched: PendingUnresolvedQuarantine[]; writeSucceeded: boolean } {
  const matched = indices.map((i) => pendingUnresolvedQuarantines[i] as PendingUnresolvedQuarantine);
  for (const i of [...indices].sort((a, b) => b - a)) pendingUnresolvedQuarantines.splice(i, 1); // descending so earlier indices stay valid
  const first = matched[0] as PendingUnresolvedQuarantine;
  let unioned = matched.slice(1).reduce((acc, p) => unionQuarantineEntries(acc, p.entry), first.entry);
  if (extra) unioned = unionQuarantineEntries(unioned, extra);
  const sourceFiles = matched.map((p) => p.sourceFile);
  const strippedOrphanLatchFiles = unioned.orphanLatchFiles?.filter((f) => !sourceFiles.includes(f));
  const armedKeys = [...new Set([...(unioned.armedKeys ?? []), key])];
  let armed: MergeQuarantineEntry = { ...unioned, resolvedKey: key, armedKeys, orphanLatchFiles: strippedOrphanLatchFiles };
  for (const k of armedKeys) activeQuarantines.set(k, armed);
  // @decision 97cff6db (round 4) — pass `key` explicitly, never derived from `armed.repoPath` — same
  // "never trust entry.repoPath at a site that can see a degraded identity" rule as every boot write site.
  const writeSucceeded = writeMergeQuarantineLatch(armed, false, key, skipDegradedOccupantGuard);
  if (writeSucceeded) {
    const failedToDelete = sourceFiles.filter((sourceFile) => !deleteSourceLatchIfSuperseded(sourceFile, armed, key));
    if (failedToDelete.length > 0) {
      armed = { ...armed, orphanLatchFiles: [...new Set([...(armed.orphanLatchFiles ?? []), ...failedToDelete])] };
      for (const k of armedKeys) activeQuarantines.set(k, armed);
      if (!writeMergeQuarantineLatch(armed, false, key, skipDegradedOccupantGuard)) {
        // eslint-disable-next-line no-console
        console.error(`[merge-quarantine] graduated ${armed.repoPath} but could NOT re-persist it after ${failedToDelete.length} stale source file(s) (${failedToDelete.join(", ")}) failed to unlink — those file(s) stay on disk, UNTRACKED by this entry's own bookkeeping in THIS process; a restart may re-arm this quarantine from them (fail-closed, never open, but investigate the unlink failure).`);
      }
    }
  } else {
    // @decision 97cff6db (round 5) — key off `key`, never `armed.repoPath` — same rule as the write above.
    const freshWriteTarget = path.basename(quarantinePathForKey(key));
    const toFold = sourceFiles.filter((f) => f !== freshWriteTarget);
    if (toFold.length > 0) {
      armed = { ...armed, orphanLatchFiles: [...new Set([...(armed.orphanLatchFiles ?? []), ...toFold])] };
      for (const k of armedKeys) activeQuarantines.set(k, armed);
    }
  }
  return { armed, matched, writeSucceeded };
}

/** Best-effort; a missing file is not an error. Never throws. Also sweeps any leftover `.json.tmp-<pid>`
 *  residue for KEY — a failed write DELIBERATELY leaves its tmp behind (round 2: it's the only durable
 *  record of an active quarantine until resolved) — HERE, at clear time, is where it gets swept.
 *
 * @decision 54054c01 — takes a raw KEY, never a repoPath: a clear must address BOTH a key an entry is
 * armed under, not just the one `canonicalRepoLockKey(repoPath)` recomputes fresh right now.
 *
 * @decision e1cb7d33 — an ordinary clear through this function is OUT OF SCOPE for the degraded-occupant
 * guard (card d4b25feb already owns, and deliberately defers, the "clearing a resolvable repo collaterally
 * destroys a degraded sibling's own file" consequence — see the decision record). This stays unconditional.
 */
function deleteMergeQuarantineLatchByKey(key: string): void {
  try { fs.unlinkSync(quarantinePathForKey(key)); } catch { /* ENOENT is the common case */ }
  // @decision be79f4d5 (round 3) — reference-aware, never the unconditional-by-hash sibling: a same-hash
  // tmp a DIFFERENT, surviving entry's own `orphanLatchFiles` still lists must not be destroyed just
  // because THIS key's own entry is being legitimately cleared.
  sweepTmpResidueForHashIfUnreferenced(quarantineHashForKey(key));
}

/**
 * The Windows/MSYS-hook guidance appended to EVERY `enterMergeQuarantine` reason raised for an unconfirmed
 * KILL — ONE shared string, never hand-copied per call site, so a wording change lands in one place and
 * `test/quarantine-reason-windows-guidance.mjs` can assert every real call site carries it. Deliberately
 * does NOT say the repo is "probably/very likely fine" — names a concrete check instead.
 *
 * @decision b966962b — do not re-attempt a PID/creation-time or MSYS-`ps`-based confirmation mechanism for
 * this residual without reading the record first; both were verified non-viable on a real host.
 */
export const UNCONFIRMED_KILL_WINDOWS_GUIDANCE =
  "on Windows this commonly happens with an ordinary sh-based hook (husky/lefthook/pre-commit) whose MSYS " +
  "child process can't be confirmed dead; before clearing, check that no git/sh/hook process is still " +
  "running for this repo (Git-for-Windows' bundled `usr/bin/ps.exe -W`, or Task Manager filtered by the " +
  "hook's own tool name), then POST /internal/merge-quarantine/clear";

/**
 * Build an `enterMergeQuarantine` `reason` string for an UNCONFIRMED-KILL raise: `detail` (what actually
 * failed, specific to the call site) plus the shared {@link UNCONFIRMED_KILL_WINDOWS_GUIDANCE} clause — the
 * ONE place every such call site assembles this text, so the guidance can never drift between call sites or
 * be silently omitted at a new one. Every `enterMergeQuarantine` call raised from a `treeDeathUnconfirmed`
 * branch (`git/worktrees.ts`, `git/batch-merge.ts`, `git/writer.ts`) must route its `reason` through this —
 * never hand-build an equivalent string. NOT for the boot-time corrupt-latch fail-closed path
 * ({@link quarantineAllRegisteredFailClosed} below) — that cause has nothing to do with an unconfirmed kill
 * or MSYS hooks, and naming this guidance there would be actively misleading.
 */
export function unconfirmedKillReason(detail: string): string {
  return `${detail} — ${UNCONFIRMED_KILL_WINDOWS_GUIDANCE}`;
}

/**
 * Matches ONLY {@link enterMergeQuarantine}'s own pending-divert filename shape — `pending-<24hex>.json`.
 * Deliberately disjoint, BY A DISTINCT PREFIX, from every other name this module writes: a canonical or
 * legacy key hash is always a BARE `<24hex>.json` with no prefix, and a safety-tmp/ordinary-tmp residue
 * always carries a `.tmp-...` suffix a bare `.json` final never does — so this can never collide with, or
 * be mistaken for, any of them.
 *
 * @decision d4b25feb — never write a pending-divert entry under a canonical/legacy key-hash filename — a
 * degraded, walked-up `canonicalRepoLockKey(repoPath)` may already belong to an unrelated entry. See the
 * decision record for the existing machinery this format reuses (boot's scan, graduation, clear-by-path).
 */
const PENDING_DIVERT_RE = /^pending-[0-9a-f]{24}\.json$/;

/** Matches a crash-left TORN-WRITE residue of {@link writePendingDivertFile}'s own fresh-divert write —
 *  the ORDINARY `.json.tmp-<pid>(-<hex>)?` shape every write in this module uses, just with the
 *  `pending-<24hex>` prefix instead of a bare hash (e.g. a process crash between this module's own
 *  `fsyncSync`/`close` and `renameSync`). Already correctly RECOVERED by PASS 1b's own pre-existing,
 *  content-based "no resolvedKey, unresolvable" branch with zero code changes (a pending-divert entry
 *  never carries `resolvedKey`, matching that branch's existing gate exactly) — this regex exists ONLY so
 *  {@link pendingLatchIdFor} can also derive a valid 24-hex id for it, mirroring {@link PENDING_DIVERT_RE}'s
 *  own branch below. */
const PENDING_DIVERT_TMP_RE = /^pending-[0-9a-f]{24}\.json\.tmp-\d+(-[0-9a-f]+)?$/;

/** Deterministic, collision-proof filename for a repoPath's own pending-divert entry — hashes
 *  {@link directPathIdentity}, NEVER `canonicalRepoLockKey` (which is exactly the degraded, walked-up
 *  value this format exists to avoid writing under). Determinism is a convenience (the SAME identity
 *  raising twice while still unresolvable reuses one file rather than minting garbage) — correctness never
 *  depends on it, since every match against this file is by entry CONTENT (`directPathIdentity`), never by
 *  filename. */
function pendingDivertFilenameFor(repoPath: string): string {
  return `pending-${createHash("sha256").update(directPathIdentity(repoPath)).digest("hex").slice(0, 24)}.json`;
}

/**
 * Durable write primitive for a pending entry at its own `filename` — mirrors
 * {@link writeMergeQuarantineLatch}'s own open/write/fsync/close/rename discipline, but with no
 * degraded-occupant guard and no key/sweep logic. `filename` is NOT always a freshly-minted
 * `pending-<24hex>.json` name (that shape is ONLY what `enterMergeQuarantine`'s own brand-new-entry
 * divert branch mints) — {@link mergeTokenIntoPendingEntries} and {@link clearPendingEntryByToken}'s own
 * partial-clear branch both call this to rewrite an ALREADY-EXISTING pending entry's own `sourceFile` IN
 * PLACE, which can be a canonical-shaped `<24hex>.json`, a `.tmp-<pid>(-<hex>)?` residue, or a filename
 * shared by multiple unresolvable claimants (card `882d6cff`) — whatever name that entry already lives
 * under on disk (Code Review `beea936c`, round 2, MINOR — ruled correct as designed, not a redesign: the
 * disjointness guarantee below applies ONLY to a freshly-minted name, never to a reused `sourceFile`).
 * This call never calls {@link writeMergeQuarantineLatch} (a THIRD site, alongside `bootWriteLatch` and
 * `enterMergeQuarantine`'s own 4): a fresh divert's name is disjoint by construction; a reused `sourceFile`
 * is this SAME entity's own existing file, never a different one — nothing for that guard to protect here.
 * NOT a claim that a reused `sourceFile` can never collide with an unrelated occupant elsewhere in this
 * module — that residual is card `2a6a8073`'s own, at `enterMergeQuarantine`'s brand-new-entry arm instead.
 *
 * @decision d4b25feb (round 2) — see the paragraph above for why this site needs no degraded-occupant guard.
 */
function writePendingDivertFile(filename: string, entry: MergeQuarantineEntry): boolean {
  let fd: number | undefined;
  const final = path.join(MERGE_QUARANTINE_DIR, filename);
  const tmp = `${final}.tmp-${process.pid}-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  try {
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    fd = fs.openSync(tmp, "w");
    const { armedKeys: _armedKeys, ...persistable } = entry;
    fs.writeSync(fd, JSON.stringify(persistable, null, 2) + "\n");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, final);
    // @decision d4b25feb (round 2, MINOR) — this write is never batched the way boot's own safety-tmp
    // writes are (Phase 0 fsyncs the directory ONCE after the whole batch) — fsync the directory here,
    // per call, so the rename's own directory-entry visibility is durable too, not just the file's bytes.
    fsyncQuarantineDir();
    return true;
  } catch (e) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already broken; nothing more to close */ } }
    // eslint-disable-next-line no-console
    console.error(`[merge-quarantine] FAILED to durably persist the pending-divert latch for ${entry.repoPath} (branch '${entry.branch}'): ${(e as Error).message}`);
    return false;
  }
}

/**
 * Merge a FRESH `token` into the pending entry/entries at `indices` — all already matched, by the caller,
 * against the SAME still-unresolvable `repoPath` — WITHOUT arming anything. Unlike {@link
 * consumeMatchedPendingsIntoArmedEntry}, this never touches `activeQuarantines` and never derives a write
 * target from a canonical key: the caller's own `repoPath` cannot currently be verified, so there is no
 * key safe to arm or write under.
 *
 * @decision d4b25feb — never route a still-unresolvable repoPath's own second raise through
 * `consumeMatchedPendingsIntoArmedEntry` (it arms at a canonical key) — merge in place, here, instead.
 *
 * Built by hand, never via {@link unionQuarantineEntries} — that helper also unions `armedKeys`, which a
 * pure-pending entry must never carry (it was never armed anywhere); reusing it here would leave a
 * cosmetic-but-needless `armedKeys: []` on an entry that has always been `undefined` in that field.
 * Keeps (and durably rewrites) the EARLIEST-`enteredAt` matched entry's own `sourceFile` — mirrors
 * `enterMergeQuarantine`'s own "existing" branch's "longest-outstanding raise wins the identity" rule —
 * folding every OTHER matched entry's own `sourceFile` into `orphanLatchFiles` (defensive: in production
 * this is expected to always be a single match, since the caller's own `siblingIndices` is always empty
 * while `repoPath` is unresolvable).
 */
function mergeTokenIntoPendingEntries(indices: number[], token: string): string {
  const matched = indices.map((i) => pendingUnresolvedQuarantines[i] as PendingUnresolvedQuarantine);
  for (const i of [...indices].sort((a, b) => b - a)) pendingUnresolvedQuarantines.splice(i, 1); // descending so earlier indices stay valid
  const base = matched.reduce((a, b) => (a.entry.enteredAt <= b.entry.enteredAt ? a : b));
  const others = matched.filter((p) => p !== base);
  const tokens = [...new Set([...matched.flatMap((p) => p.entry.tokens), token])];
  const orphanLatchFiles = [...new Set([
    ...(base.entry.orphanLatchFiles ?? []),
    ...others.flatMap((p) => p.entry.orphanLatchFiles ?? []),
    ...others.map((p) => p.sourceFile).filter((f) => f !== base.sourceFile),
  ])];
  const merged: MergeQuarantineEntry = { ...base.entry, tokens, orphanLatchFiles: orphanLatchFiles.length > 0 ? orphanLatchFiles : undefined };
  const persisted = writePendingDivertFile(base.sourceFile, merged);
  pendingUnresolvedQuarantines.push({ entry: merged, sourceFile: base.sourceFile });
  if (!persisted) {
    // eslint-disable-next-line no-console
    console.error(`[merge-quarantine] canonical repo ${merged.repoPath} is quarantined IN THIS PROCESS ONLY right now (merged into its own still-unresolvable pending latch) — the durable pending-divert latch failed to re-write (see the error just above), so a daemon restart BEFORE that is fixed would silently LIFT this quarantine instead of re-arming it. Investigate (disk full? permissions on ${MERGE_QUARANTINE_DIR}?) immediately.`);
  }
  return token;
}

/**
 * Raise (or ADD ANOTHER outstanding raise to) the quarantine for `repoPath` — the canonical repo, ALWAYS
 * (see this module's own header doc for why a batch caller must resolve its canonical repoPath first,
 * never pass its own scratch worktree path). Round 7 (M1): if the repo is ALREADY quarantined, this APPENDS
 * a fresh token to the existing entry's `tokens` SET rather than overwriting it — the original
 * branch/reason/opId/enteredAt are kept (they describe the LONGEST-outstanding, still-unresolved raise),
 * so a second, unrelated raise never erases the first raise's own identity.
 *
 * @decision 54054c01 — ALSO checks `pendingUnresolvedQuarantines` for a match before minting a brand-new
 * entry: a fresh raise on a repo with an old pending (key-unverifiable) latch must merge into it, never
 * mint an unrelated second entry that leaves the pending one's identity/tokens orphaned.
 *
 * @decision abccee85 (round 6) — that pending match is by {@link directPathIdentity}, never a freshly
 * recomputed `canonicalRepoLockKey` — see the decision record for the cross-identity merge bug this closes.
 *
 * Returns the fresh token — the caller MUST hold onto it and present it back to
 * {@link clearMergeQuarantineByToken} for its own in-process auto-clear; never guess or reconstruct one.
 *
 * @decision e1cb7d33 — every write here opts OUT of the degraded-occupant guard (mirrors `bootWriteLatch`):
 * a RAISE must persist, never silently fail open on reboot. See the decision record for the residual.
 *
 * @decision d4b25feb — `key` is only THIS repoPath's own identity when `verified`; a degraded, walked-up
 * `key` may belong to an unrelated entry — never append a raise into, or arm one at, an unverified `key`.
 */
export function enterMergeQuarantine(repoPath: string, branch: string, reason: string, opId?: string): string {
  const token = randomUUID();
  const key = canonicalRepoLockKey(repoPath);
  const verified = isRepoPathCurrentlyResolvable(repoPath);
  const existing = verified ? activeQuarantines.get(key) : undefined;
  if (existing) {
    const entry: MergeQuarantineEntry = { ...existing, tokens: [...existing.tokens, token] };
    // `existing` may be armed under a SECOND key too (its own resolvedKey) — update every one of those
    // slots to this rebuilt object, not just `key` (round 2 finding 2).
    for (const k of existing.armedKeys?.length ? existing.armedKeys : [key]) activeQuarantines.set(k, entry);
    // @decision 8a1bc2ef (round 2, Code Review) — only absorb into `entry` when IT is genuinely
    // key-verified, never when `existing` merely occupies `key` via PASS 1's degraded dual-arm fallback —
    // see the decision record for the nested-repo repro this guard closes.
    //
    // @decision 8a1bc2ef — absorb any SIBLING pending entry sharing this exact canonical key (card
    // 7673d096) before persisting — this branch otherwise never looks at pendingUnresolvedQuarantines at
    // all, see the decision record for the stranding-behind-the-already-armed-key repro this closes.
    const siblingIndices = isKeyVerifiedFor(entry.repoPath, key) ? collectCrossTierSiblingIndices(key, []) : [];
    if (siblingIndices.length > 0) {
      const { writeSucceeded } = consumeMatchedPendingsIntoArmedEntry(siblingIndices, key, entry, true);
      if (!writeSucceeded) {
        // eslint-disable-next-line no-console
        console.error(`[merge-quarantine] canonical repo ${repoPath} is quarantined IN THIS PROCESS ONLY right now (absorbed ${siblingIndices.length} sibling pending latch(es)) — the durable latch failed to write; a later boot can still recover it from the sibling(s)' own still-present source file(s).`);
      }
      return token;
    }
    // @decision 92c645cc — safe to sweep: `entry.tokens` is `[...existing.tokens, token]`, a visible
    // superset of whatever `existing` (this process's own authoritative record for this key) already
    // held, so no older tmp for this key can carry a token this write doesn't already carry forward.
    if (!writeMergeQuarantineLatch(entry, true, undefined, true)) {
      // eslint-disable-next-line no-console
      console.error(`[merge-quarantine] canonical repo ${repoPath} is quarantined IN THIS PROCESS ONLY right now — the durable latch failed to write (see the error just above), so a daemon restart BEFORE that is fixed would silently LIFT this quarantine instead of re-arming it. Investigate (disk full? permissions on ${MERGE_QUARANTINE_DIR}?) immediately.`);
    }
    return token;
  }
  const identityForPendingMatch = directPathIdentity(repoPath);
  // @decision 188b145f (round 2) — collect EVERY identity-matching pending index, never just the first,
  // same reason and same fix shape as `activeMergeQuarantineFor`'s own lazy-graduation cascade: a second
  // (or later) same-identity pending entry here was left permanently stranded otherwise.
  const pendingIndices = collectPendingIndices((p) => directPathIdentity(p.entry.repoPath) === identityForPendingMatch);
  // @decision 8a1bc2ef — ALSO absorb a sibling pending entry sharing this exact canonical key, even when
  // `repoPath` itself has no pending entry of its own — see the decision record for why the "brand new
  // entry" branch below would otherwise strand it exactly like the pending-merge branch used to.
  //
  // @decision 8a1bc2ef (round 2, Code Review) — only when `repoPath` ITSELF currently resolves — `key` is
  // computed from `repoPath` above, so an unresolvable `repoPath` makes `key` a DEGRADED (walked-up)
  // value never actually verified to be `repoPath`'s own; see the decision record for the repro.
  const siblingIndices = verified ? collectCrossTierSiblingIndices(key, pendingIndices) : [];
  const allPendingIndices = siblingIndices.length > 0 ? [...pendingIndices, ...siblingIndices] : pendingIndices;
  if (allPendingIndices.length > 0) {
    if (!verified) {
      // @decision d4b25feb — repoPath is STILL unresolvable: merge the fresh token into its own matched
      // pending entry/entries in place, never arm at the degraded `key` (siblingIndices is always empty
      // here, so this is always a self-identity match — see mergeTokenIntoPendingEntries' own doc).
      return mergeTokenIntoPendingEntries(allPendingIndices, token);
    }
    const fresh: MergeQuarantineEntry = { repoPath, branch, reason, opId, enteredAt: Date.now(), tokens: [token] };
    // @decision 188b145f (round 3, Delta Code Review f61b7f6e) — route through the SAME shared helper
    // `activeMergeQuarantineFor` uses, never a second inline copy: this branch used to splice/fold ONLY
    // on a SUCCESSFUL write, stranding every matched pending entry and its sourceFile on a FAILED one.
    const { matched: consumed, writeSucceeded } = consumeMatchedPendingsIntoArmedEntry(allPendingIndices, key, fresh, true);
    if (!writeSucceeded) {
      // eslint-disable-next-line no-console
      console.error(`[merge-quarantine] canonical repo ${repoPath} is quarantined IN THIS PROCESS ONLY right now (merged with ${consumed.length} pending latch(es)) — the durable latch failed to write, so the pending latch(es)' own source file(s) (${consumed.map((p) => p.sourceFile).join(", ")}) are now tracked as owned by this entry's own orphanLatchFiles rather than deleted; a later boot can still recover from it.`);
    }
    return token;
  }
  if (!verified) {
    // @decision d4b25feb — a genuinely BRAND NEW raise while repoPath is unresolvable: divert to
    // pendingUnresolvedQuarantines under its own, disjoint filename — never arm `activeQuarantines` at the
    // degraded, walked-up `key` (883e29bc's own fix, generalized here from boot to runtime).
    const fresh: MergeQuarantineEntry = { repoPath, branch, reason, opId, enteredAt: Date.now(), tokens: [token] };
    const filename = pendingDivertFilenameFor(repoPath);
    const persisted = writePendingDivertFile(filename, fresh);
    pendingUnresolvedQuarantines.push({ entry: fresh, sourceFile: filename });
    if (!persisted) {
      // eslint-disable-next-line no-console
      console.error(`[merge-quarantine] canonical repo ${repoPath} is quarantined IN THIS PROCESS ONLY right now (unresolvable raise, diverted to pending) — the durable pending-divert latch failed to write (see the error just above), so a daemon restart BEFORE that is fixed would silently LIFT this quarantine instead of re-arming it. Investigate (disk full? permissions on ${MERGE_QUARANTINE_DIR}?) immediately.`);
    }
    return token;
  }
  const entry: MergeQuarantineEntry = { repoPath, branch, reason, opId, enteredAt: Date.now(), tokens: [token], resolvedKey: key, armedKeys: [key] };
  activeQuarantines.set(key, entry);
  const persisted = writeMergeQuarantineLatch(entry, false, undefined, true);
  if (!persisted) {
    // eslint-disable-next-line no-console
    console.error(`[merge-quarantine] canonical repo ${repoPath} is quarantined IN THIS PROCESS ONLY right now — the durable latch failed to write (see the error just above), so a daemon restart BEFORE that is fixed would silently LIFT this quarantine instead of re-arming it. Investigate (disk full? permissions on ${MERGE_QUARANTINE_DIR}?) immediately.`);
  }
  return token;
}

/**
 * The PENDING twin of {@link clearMergeQuarantineByToken}'s own `activeQuarantines` logic — same
 * compare-and-clear SET semantics, applied to a repoPath whose own raise(s) live ONLY in
 * `pendingUnresolvedQuarantines` (still unresolvable, never armed). Matches by {@link directPathIdentity}
 * (never a fresh, possibly-degraded `canonicalRepoLockKey` recompute), mirroring every other pending-aware
 * clear path in this module.
 *
 * @decision d4b25feb (round 2, CRITICAL) — the LAST token lifts ONLY the one matched pending entry,
 * directly — never via {@link clearMergeQuarantineByRecordedPath}, which clears EVERY entry sharing this
 * identity and would destroy a wholly separate, still-armed ACTIVE entry for the same repoPath.
 */
function clearPendingEntryByToken(repoPath: string, token: string): void {
  const identity = directPathIdentity(repoPath);
  const idx = pendingUnresolvedQuarantines.findIndex((p) => directPathIdentity(p.entry.repoPath) === identity && p.entry.tokens.includes(token));
  if (idx === -1) return; // not ours — leave whatever is (or isn't) there alone
  const pending = pendingUnresolvedQuarantines[idx] as PendingUnresolvedQuarantine;
  const remaining = pending.entry.tokens.filter((t) => t !== token);
  if (remaining.length === 0) {
    pendingUnresolvedQuarantines.splice(idx, 1);
    const orphanFilesToSweep = new Set(pending.entry.orphanLatchFiles ?? []);
    for (const k of pending.entry.armedKeys ?? []) {
      if (!pendingEntryStillOwnsKey(k, pending.entry)) continue;
      activeQuarantines.delete(k);
      deleteMergeQuarantineLatchByKey(k);
    }
    sweepOwnLatchFileUnlessOwnedElsewhere(pending.sourceFile);
    for (const orphanFile of orphanFilesToSweep) sweepOrphanLatchFileIfUnreferenced(orphanFile);
    return;
  }
  const updated: MergeQuarantineEntry = { ...pending.entry, tokens: remaining };
  // @decision d4b25feb (round 3) — re-point EVERY in-memory reference to this entry (883e29bc's own
  // divert can make it the SAME object armed in activeQuarantines) before durably rewriting each owned key.
  replaceEntryEverywhere(activeQuarantines, pending.entry, updated);
  pendingUnresolvedQuarantines[idx] = { ...pending, entry: updated };
  for (const k of pending.entry.armedKeys ?? []) {
    if (activeQuarantines.get(k) !== updated) continue; // no longer genuinely owned — do not write there
    if (!writeMergeQuarantineLatch(updated, false, k)) {
      // eslint-disable-next-line no-console
      console.error(`[merge-quarantine] could not durably persist the reduced token set for ${repoPath}'s own armed copy at key ${k} after a partial clear — the PRE-EXISTING durable state there is left UNTOUCHED, so a restart before this is fixed may re-union the just-cleared token back in.`);
    }
  }
  if (!writePendingDivertFile(pending.sourceFile, updated)) {
    // eslint-disable-next-line no-console
    console.error(`[merge-quarantine] could not durably persist the reduced token set for ${repoPath}'s own pending-divert latch after a partial clear — the PRE-EXISTING durable state is left UNTOUCHED, so a restart before this is fixed re-arms with the just-cleared token still counted as outstanding (delays the eventual full lift; never a false lift).`);
  }
}

/**
 * COMPARE-AND-CLEAR (round 6, Code Review #5; SET semantics round 7, M1): removes ONLY `token` from the
 * currently active entry's outstanding-token SET — the repo is lifted ONLY once that set becomes EMPTY. A
 * mismatch (this token isn't in the set — a DIFFERENT op's quarantine is now the only one active, or the
 * entry is already gone) is a SILENT no-op — this is the one and only in-process auto-clear path
 * (`onTreeDeathSettled(true)` closures in `git/worktrees.ts`/`git/batch-merge.ts`), and without SET
 * semantics a LATER raiser's own confirmed-dead settlement could lift the whole quarantine while an
 * EARLIER raiser's own orphan was still genuinely unconfirmed (round 7 M1 — reproduced at the primitive
 * level: `ta=enter(A); tb=enter(B); clearByToken(tb)` used to wrongly lift it even though `ta` was untouched).
 *
 * Never used for the human REST route — that clear is unconditional (see {@link clearMergeQuarantine})
 * because a human resolving this by hand does not necessarily hold (or need) every outstanding token.
 */
/**
 * Shared compare-and-clear body for {@link clearMergeQuarantineByToken}'s own fast path AND its round-3
 * identity-scan fallback below — both have ALREADY matched a specific `key`/`entry` pair known to hold
 * `token`. Takes `key` explicitly and never re-derives a write target from `entry.repoPath` (which may not
 * currently resolve at all when this is reached via the identity scan) — same rule as every other
 * degraded-identity-aware write site in this module.
 */
function clearActiveEntryTokenAtKey(key: string, entry: MergeQuarantineEntry, token: string): void {
  const remaining = entry.tokens.filter((t) => t !== token);
  if (remaining.length === 0) {
    // @decision 883e29bc — clear via the key/entry ALREADY matched (c0be9bf9's rule), never by
    // re-deriving from a repoPath again — `entry.repoPath` can be a DIFFERENT, longer-outstanding
    // raiser's own identity (enterMergeQuarantine's `existing` branch).
    clearMergeQuarantineByKey(key, entry.repoPath);
    return;
  }
  const updated: MergeQuarantineEntry = { ...entry, tokens: remaining };
  // Update EVERY key `entry` is armed under, not just `key` — reference equality breaks the moment an
  // entry is REBUILT elsewhere (a union, an orphan merge), since the rebuilt object stops being `===` the
  // one still sitting at another of its own keys (round 2 finding 2).
  for (const k of entry.armedKeys?.length ? entry.armedKeys : [key]) activeQuarantines.set(k, updated);
  // @decision d4b25feb (round 3) — ALSO re-point any pending entry sharing this EXACT reference
  // (883e29bc's own boot-diverted twin) — a stale sibling keeps the cleared token; graduation unions it back.
  replaceEntryEverywhere(activeQuarantines, entry, updated);
  // @decision bde5d1fe (Code Review of eae23ebe) — a sweep may only run AFTER a durable write of the
  // state that supersedes it has succeeded, never before: sweeping THEN failing this write would leave
  // NOTHING durable for a repo whose only prior copy was this same tmp.
  // @decision 92c645cc — `updated.tokens` deliberately DROPS the cleared token, so this call does NOT
  // pass `writeMergeQuarantineLatch`'s own `sweepOtherTmpsOnSuccess` (not a superset write); the sweep
  // below is this call's OWN pre-existing, separate step, unaffected by that flag.
  if (writeMergeQuarantineLatch(updated, false, key)) {
    // @decision be79f4d5 (round 4) — reference-aware, same reason as the other two sites: a DIFFERENT,
    // surviving entry's own same-hash tmp must survive a partial clear here too.
    sweepTmpResidueForHashIfUnreferenced(quarantineHashForKey(key));
  } else {
    // eslint-disable-next-line no-console
    console.error(`[merge-quarantine] could not durably persist the reduced token set for ${entry.repoPath} after a partial clear — the PRE-EXISTING durable state (this repo's own latch file, final or tmp) is left UNTOUCHED, so a restart before this is fixed re-arms with the just-cleared token still counted as outstanding (delays the eventual full lift; never a false lift).`);
  }
}

export function clearMergeQuarantineByToken(repoPath: string, token: string): void {
  const key = canonicalRepoLockKey(repoPath);
  const current = activeQuarantines.get(key);
  if (current?.tokens.includes(token)) {
    clearActiveEntryTokenAtKey(key, current, token);
    return;
  }
  // @decision d4b25feb (round 3) — repoPath's OWN token can still live in a SEPARATE active entry, armed
  // at its historical TRUE key (captured while resolvable, before it raised again unverified) — scan by
  // identity, not key, before giving up to the pending fallback.
  const identity = directPathIdentity(repoPath);
  const seen = new Set<MergeQuarantineEntry>();
  for (const [k, entry] of activeQuarantines) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    if (directPathIdentity(entry.repoPath) !== identity || !entry.tokens.includes(token)) continue;
    clearActiveEntryTokenAtKey(k, entry, token);
    return;
  }
  // @decision d4b25feb (round 2, MAJOR) — fall back whenever nothing active holds `token` either way —
  // repoPath's own raise may live ONLY in `pendingUnresolvedQuarantines` (never armed anywhere).
  clearPendingEntryByToken(repoPath, token);
}

/**
 * repoPaths of every surviving entry that currently OWNS `filename` as its own CURRENT physical latch —
 * check (2) from {@link sweepOrphanLatchFileIfUnreferenced}'s own doc, factored out so a caller deleting
 * an entry's OWN file (see {@link sweepOwnLatchFileUnlessOwnedElsewhere}) can gate on ownership alone,
 * never on a mere `orphanLatchFiles` reference. An active entry owns `filename` if ANY key it is
 * currently armed under hashes to it, OR (round 2, item 3) if `filename` is its TRUE current write
 * target — `basename(quarantinePathFor(e.repoPath))`, recomputed fresh from `e.repoPath` rather than
 * trusting `armedKeys` alone, since a key can drift after an entry was last armed (see decision
 * abccee85) and `writeMergeQuarantineLatch` always targets the FRESH key, not a stale armed one. A
 * pending entry owns `filename` if its own `sourceFile` is it.
 *
 * @decision 9cabd143 — round 2, item 4: the PENDING half of this check protects a case
 * {@link sweepOrphanLatchFileIfUnreferenced}'s own call sites (e.g. clearMergeQuarantineByKey's
 * orphan-reference sweep) genuinely reach — see test (AA) and the decision record.
 *
 * @decision 882d6cff (round 4) — the FRESH-recompute half is gated on `e.repoPath` being CURRENTLY
 * resolvable: for an entry that graduated then went unresolvable again, recomputing its key now
 * degrades back to a shared ancestor, falsely "protecting" an unrelated file. See the decision record.
 */
function physicalOwnerRepoPaths(filename: string): string[] {
  const owners = new Set<string>();
  for (const [k, e] of activeQuarantines) {
    const isFreshWriteTarget = isRepoPathCurrentlyResolvable(e.repoPath) && path.basename(quarantinePathFor(e.repoPath)) === filename;
    if (`${quarantineHashForKey(k)}.json` === filename || isFreshWriteTarget) {
      owners.add(e.repoPath);
    }
  }
  for (const p of pendingUnresolvedQuarantines) {
    if (p.sourceFile === filename) owners.add(p.entry.repoPath);
  }
  return [...owners];
}

function unlinkLatchFile(filename: string): void {
  try {
    fs.unlinkSync(path.join(MERGE_QUARANTINE_DIR, filename));
    // eslint-disable-next-line no-console
    console.log(`[merge-quarantine] deleted orphan latch ${filename} — no remaining quarantine entry references it.`);
  } catch { /* already gone, or never existed under that exact name — either way, nothing left to do */ }
}

/**
 * Delete `filename` (a basename under {@link MERGE_QUARANTINE_DIR}) from disk IFF it is not NEEDED by any
 * remaining entry — ACTIVE or PENDING. "Needed" is checked two ways: (1) some surviving entry's own
 * `orphanLatchFiles` still lists `filename` (the ordinary orphan-reference case), or (2) `filename` is
 * owned by a surviving entry — see {@link physicalOwnerRepoPaths}. Call this ONLY after the caller has
 * already removed whatever entry/entries it is in the process of clearing from
 * `activeQuarantines`/`pendingUnresolvedQuarantines`, so "remaining" genuinely excludes them — never
 * before. Use this for a TRUE orphan-reference file (one NOT being removed as part of clearing the entry
 * that names it); for an entry's OWN file, use {@link sweepOwnLatchFileUnlessOwnedElsewhere} instead —
 * see that function's own doc for why the two must never be conflated.
 *
 * @decision 6237bef6 — shared by every orphan-latch sweep (active-entry clear AND every pending-entry
 * clear) so "still referenced" always means the same thing. See the decision record for the gap this
 * closes and why checking only one of active/pending is wrong.
 *
 * @decision 9cabd143 — never drop check (2): a filename's deterministic hash can be legitimately
 * reclaimed by its own rightful repo after being fanned out as someone else's orphan reference. See the
 * decision record for the fail-open repro this closes.
 */
function sweepOrphanLatchFileIfUnreferenced(filename: string): { kept: boolean; referencingRepoPaths: string[] } {
  const referencingRepoPaths = new Set<string>();
  for (const e of activeQuarantines.values()) {
    if (e.orphanLatchFiles?.includes(filename)) referencingRepoPaths.add(e.repoPath);
  }
  for (const p of pendingUnresolvedQuarantines) {
    if (p.entry.orphanLatchFiles?.includes(filename)) referencingRepoPaths.add(p.entry.repoPath);
  }
  for (const rp of physicalOwnerRepoPaths(filename)) referencingRepoPaths.add(rp);
  if (referencingRepoPaths.size > 0) return { kept: true, referencingRepoPaths: [...referencingRepoPaths] };
  unlinkLatchFile(filename);
  return { kept: false, referencingRepoPaths: [] };
}

/**
 * The `.json.tmp-<pid>` twin of {@link sweepOrphanLatchFileIfUnreferenced}'s check (1) — deletes every tmp
 * residue file for `hash` EXCEPT one whose EXACT filename a surviving entry's own `orphanLatchFiles` still
 * lists, keeping (and reporting) that one instead. The ownership scan is NOT entry-scoped: it checks
 * `activeQuarantines` as a whole, so the ENTRY whose own key `hash` is — the one actually being
 * written/cleared/superseded at THIS call — gets NO special EXCLUSION from it either (round 4, Code
 * Review `18485645`, correcting an earlier false claim that it was always exempt). If that entry's OWN
 * `orphanLatchFiles` self-references a same-hash tmp (e.g. a stale source folded in by an EARLIER failed
 * graduation), this call sees it as "owned" by that still-armed entry and KEEPS it — a BENIGN keep: the
 * same file is swept once that entry is later FULLY cleared (`clearMergeQuarantineByKey` folds
 * `orphanLatchFiles` into its own sweep once nothing is left to re-arm it), never resurrected, never
 * mistakenly kept forever. Only a filename NEITHER a different surviving entry's cross-reference NOR this
 * same entry's own self-reference names is genuinely swept at THIS call.
 *
 * Used by every call site a same-hash tmp residue can be swept from: `clearMergeQuarantineLatchFile`'s raw
 * "no entry matches this id" fallback (card c0be9bf9/9cabd143), `deleteMergeQuarantineLatchByKey`'s own
 * legitimate-clear sweep, `writeMergeQuarantineLatch`'s `sweepOtherTmpsOnSuccess` path, and
 * `clearMergeQuarantineByToken`'s own partial-clear branch (round 4).
 *
 * @decision be79f4d5 (round 3) — call THIS at every site that sweeps a same-hash tmp, never an
 * unconditional-by-hash delete. RETRACTED: an earlier "leaves residue behind forever" rationale was
 * never true (a kept file sweeps once its owner clears).
 */
function sweepTmpResidueForHashIfUnreferenced(hash: string): { kept: boolean; referencingRepoPaths: string[] } {
  const prefix = `${hash}.json.tmp-`;
  let files: string[];
  try { files = fs.readdirSync(MERGE_QUARANTINE_DIR); } catch { return { kept: false, referencingRepoPaths: [] }; }
  const referencingRepoPaths = new Set<string>();
  for (const f of files) {
    if (!f.startsWith(prefix)) continue;
    const owners = new Set<string>();
    for (const e of activeQuarantines.values()) if (e.orphanLatchFiles?.includes(f)) owners.add(e.repoPath);
    for (const p of pendingUnresolvedQuarantines) if (p.entry.orphanLatchFiles?.includes(f)) owners.add(p.entry.repoPath);
    if (owners.size > 0) {
      for (const o of owners) referencingRepoPaths.add(o);
    } else {
      try { fs.unlinkSync(path.join(MERGE_QUARANTINE_DIR, f)); } catch { /* best-effort */ }
    }
  }
  return { kept: referencingRepoPaths.size > 0, referencingRepoPaths: [...referencingRepoPaths] };
}

/**
 * Delete `filename` — an entry's OWN latch file, being removed as part of clearing that very entry — IFF
 * no SURVIVING entry currently OWNS it (check (2) alone, via {@link physicalOwnerRepoPaths}). Deliberately
 * NEVER gated on check (1) (another entry's `orphanLatchFiles` merely LISTING `filename`): the entry
 * being cleared is who that filename belongs to, so some other entry's stale reference to it is never a
 * reason to keep it — `/clear`/`/clear-by-path {repoPath}` already delete an entry's own file this way
 * unconditionally, and this must agree.
 *
 * @decision 9cabd143 — never gate this on check (1) — a cleared quarantine's own file kept alive by some
 * OTHER entry's stale `orphanLatchFiles` reference re-arms on the next boot. See the decision record.
 */
function sweepOwnLatchFileUnlessOwnedElsewhere(filename: string): { kept: boolean; referencingRepoPaths: string[] } {
  const owners = physicalOwnerRepoPaths(filename);
  if (owners.length > 0) return { kept: true, referencingRepoPaths: owners };
  unlinkLatchFile(filename);
  return { kept: false, referencingRepoPaths: [] };
}

/** `true` iff `key`'s CURRENT occupant in `activeQuarantines` is genuinely `pendingEntry` itself — either
 *  the exact same object (the ordinary, still-valid diverted case) or a DIFFERENT object that shares its
 *  own recorded identity (a legitimate rebuild — a union, an orphan merge — of the SAME logical entry).
 *  `false` for anything else: nothing occupies `key` at all, or a WHOLLY UNRELATED entry does — e.g. a
 *  fresh raise that reused a key a now-stale pending snapshot's own `armedKeys` still names (card
 *  883e29bc, round 3, finding 1). Lifting `key` in that case would destroy an unrelated repo's own,
 *  completely unrelated, genuine quarantine — gate EVERY pending-sweep's `armedKeys` lift on this. */
function pendingEntryStillOwnsKey(key: string, pendingEntry: MergeQuarantineEntry): boolean {
  const occupant = activeQuarantines.get(key);
  if (!occupant) return false;
  if (occupant === pendingEntry) return true;
  return directPathIdentity(occupant.repoPath) === directPathIdentity(pendingEntry.repoPath);
}

/**
 * KEY-ADDRESSED core — empties the WHOLE outstanding-token set at once (round 7, M1) for the entry
 * currently armed at `key`: lifts every map slot it's armed under, deletes each one's physical latch,
 * sweeps a PENDING entry sharing `identityRepoPath`'s own identity, and deletes any now-unreferenced
 * `orphanLatchFiles` (round 7 M2). {@link clearMergeQuarantine} wraps this with a freshly-recomputed key
 * from a repoPath.
 *
 * @decision c0be9bf9 — a caller that already matched a SPECIFIC key some other way (never derived it
 * fresh from a repoPath) must call this directly, not `clearMergeQuarantine` — see the decision record.
 *
 * @decision abccee85 (round 5) — match a pending entry against `identityRepoPath` via {@link
 * directPathIdentity}, never a freshly-recomputed walking `canonicalRepoLockKey` — see the decision
 * record for the reverse-drift repro this closes.
 *
 * @decision e1cb7d33 — an ordinary clear through this function is OUT OF SCOPE for the degraded-occupant
 * guard — see the decision record for why (card d4b25feb already owns this consequence, and the
 * established precedent, 4480b077/883e29bc, is that the clear proceeds).
 */
export function clearMergeQuarantineByKey(key: string, identityRepoPath: string): { wasQuarantined: true; latchKept: true; referencingRepoPaths: string[] } | void {
  const entry = activeQuarantines.get(key);
  // Lift EVERY key this entry is armed under (its own tracked set), never reference equality — a union or
  // an orphan merge REBUILDS the entry object, so a map slot holding an OLDER build of the "same" logical
  // entry is no longer `===` the one `key` resolves to (round 2 finding 2).
  const keysToLift = entry?.armedKeys?.length ? entry.armedKeys : [key];
  for (const k of keysToLift) activeQuarantines.delete(k);
  // The entry's own physical latch file(s) may live at a DIFFERENT hash than `key`'s — e.g. never migrated
  // because the registered path was unresolvable at boot (PASS 1 never migrates on an unverifiable key).
  // Sweep every armed key's own latch path, or a stale file survives a "successful" clear and resurrects
  // the quarantine on the next boot.
  for (const k of keysToLift) deleteMergeQuarantineLatchByKey(k);
  // A pending (boot-unverifiable, no-resolvedKey) entry isn't keyed into activeQuarantines at all — see
  // reenterMergeQuarantinesAtBoot's PASS 1 and activeMergeQuarantineFor's lazy re-resolve. Match it by
  // DIRECT identity against `identityRepoPath` (never a fresh walking recompute — see this function's own
  // doc comment) so a clear issued while still unresolvable actually lifts it, and delete its OWN source
  // file too (round 2 finding 1), or it survives to resurrect the quarantine.
  const identity = directPathIdentity(identityRepoPath);
  const orphanFilesToSweep = new Set<string>(entry?.orphanLatchFiles ?? []);
  const sourceFilesToSweep: string[] = [];
  pendingUnresolvedQuarantines = pendingUnresolvedQuarantines.filter((p) => {
    if (directPathIdentity(p.entry.repoPath) !== identity) return true;
    // When an ACTIVE entry really is being cleared (`entry` truthy), a same-identity pending entry is tied
    // to THIS SAME entity three ways: the same object reference, it shares a key being lifted, or the
    // active entry's own `orphanLatchFiles` already names its `sourceFile` (97cff6db's own standalone-
    // tracking-reference shape for a colliding sibling's folded migrate source — never `===` the union,
    // never armed, but still legitimately part of what this clear sweeps). When `entry` is undefined (a
    // PURE pending clear, nothing armed anywhere), there is no active entry to confuse it with — keep the
    // pre-existing, unconditional identity sweep (card 882d6cff's own multi-claimant design needs it).
    //
    // @decision d4b25feb (round 2) — outside those cases, a same-identity pending entry is a wholly
    // INDEPENDENT later raise (this card's own new shape) and must survive this clear untouched.
    const tiedToThisEntity = !entry || p.entry === entry || keysToLift.some((k) => p.entry.armedKeys?.includes(k)) || !!entry.orphanLatchFiles?.includes(p.sourceFile);
    if (!tiedToThisEntity) return true;
    for (const f of p.entry.orphanLatchFiles ?? []) orphanFilesToSweep.add(f);
    // @decision 883e29bc — a diverted-pending entry is also armed under resolvedKey; lift that too, but
    // ONLY when it still genuinely occupies that key (pendingEntryStillOwnsKey) — a stale snapshot can
    // otherwise name a key a wholly unrelated later raise has since reused.
    for (const k of p.entry.armedKeys ?? []) {
      if (!pendingEntryStillOwnsKey(k, p.entry)) continue;
      activeQuarantines.delete(k);
      deleteMergeQuarantineLatchByKey(k);
    }
    sourceFilesToSweep.push(p.sourceFile);
    return false;
  });
  // @decision 883e29bc (round 4) — sweep each removed entry's own sourceFile via
  // sweepOwnLatchFileUnlessOwnedElsewhere (never a bare unlink): it can be the SAME physical path a
  // different, surviving repo's fresh raise now owns (reusing the freed key).
  //
  // @decision f5c42043 — CAPTURE and SURFACE this sweep's `{kept, referencingRepoPaths}` (previously
  // discarded) instead of a bare unqualified success, mirroring clearMergeQuarantineByRecordedPath's own
  // `latchKept` reporting for the SAME "a sibling still needs this file" shape.
  const keptReferencingRepoPaths = new Set<string>();
  for (const f of sourceFilesToSweep) {
    const result = sweepOwnLatchFileUnlessOwnedElsewhere(f);
    if (result.kept) for (const rp of result.referencingRepoPaths) keptReferencingRepoPaths.add(rp);
  }
  for (const orphanFile of orphanFilesToSweep) sweepOrphanLatchFileIfUnreferenced(orphanFile);
  if (keptReferencingRepoPaths.size > 0) {
    return { wasQuarantined: true, latchKept: true, referencingRepoPaths: [...keptReferencingRepoPaths] };
  }
}

/** For a repoPath that is NOT currently resolvable, its OWN recorded entry (active, any key; else
 *  pending) by {@link directPathIdentity} — never the generic key-based lookup, which can surface an
 *  unrelated repo's entry merely occupying the same walked-up key (card 883e29bc, round 2). Returns
 *  undefined when repoPath has no entry of its own at all. */
function ownIdentityEntryFor(repoPath: string): MergeQuarantineEntry | undefined {
  const identity = directPathIdentity(repoPath);
  for (const entry of activeQuarantines.values()) {
    if (directPathIdentity(entry.repoPath) === identity) return entry;
  }
  return pendingUnresolvedQuarantines.find((p) => directPathIdentity(p.entry.repoPath) === identity)?.entry;
}

/** The entry a query for `repoPath` should treat as ITS OWN blocker: {@link ownIdentityEntryFor} when
 *  repoPath is currently unresolvable and has one, else the ordinary key-based {@link
 *  activeMergeQuarantineFor} (unchanged for the resolvable case, and the fallback — an ancestor's own
 *  fail-closed signal is still legitimate — when repoPath has no entry of its own). Shared by {@link
 *  assertRepoNotQuarantined} and {@link clearMergeQuarantineReporting} (card 883e29bc, round 2, findings
 *  1/2) so the two never disagree about which entry a given repoPath is actually blocked by. */
function resolveQuarantineFor(repoPath: string): MergeQuarantineEntry | undefined {
  if (!isRepoPathCurrentlyResolvable(repoPath)) {
    const own = ownIdentityEntryFor(repoPath);
    if (own) return own;
  }
  return activeMergeQuarantineFor(repoPath);
}

/**
 * UNCONDITIONAL clear for `repoPath`. Called from exactly two places: (1) the human-only loopback REST
 * route (`POST /internal/merge-quarantine/clear`, gateway/server.ts), and (2) internally, once {@link
 * clearMergeQuarantineByToken} empties the token set itself. A RESTORED quarantine (re-entered at boot)
 * can ONLY ever be cleared this way, since the original in-process promise chain(s) that could
 * auto-clear it are gone once the process(es) that held them have exited.
 *
 * When `repoPath` is NOT currently resolvable, a freshly-recomputed `canonicalRepoLockKey(repoPath)` can
 * walk UP past repoPath's own absence to an ENCLOSING repo's real key and lift ITS unrelated quarantine
 * instead of repoPath's own — `abccee85` deliberately kept this function on the fresh key for the
 * RESOLVABLE case, which stays unchanged; only the unresolvable branch is redirected.
 *
 * @decision 883e29bc — delegate to clearMergeQuarantineByRecordedPath (resolves by STORED identity)
 * instead, when repoPath is not currently resolvable.
 *
 * @decision 882d6cff (round 4) — returns the unresolvable branch's own result (`latchKept`/
 * `referencingRepoPaths` when a shared latch survives); `void` for the resolvable branch, unchanged.
 */
export function clearMergeQuarantine(repoPath: string): { wasQuarantined: boolean; reason?: string; latchKept?: true; referencingRepoPaths?: string[] } | void {
  if (!isRepoPathCurrentlyResolvable(repoPath)) {
    return clearMergeQuarantineByRecordedPath(repoPath);
  }
  return clearMergeQuarantineByKey(canonicalRepoLockKey(repoPath), repoPath);
}

/**
 * Clear every quarantine entry addressed by its STORED `repoPath` — matches EACH ACTIVE entry's own
 * recorded `repoPath` field via {@link directPathIdentity} (never a fresh, walking `canonicalRepoLockKey`
 * recompute of the GIVEN string) and clears every match via that entry's own already-armed key (round 5:
 * two distinct active entries, under two distinct keys, can share one stored repoPath after a raise-time
 * key drift — clearing only the first one found left the other fully armed). Falls back to a direct
 * {@link directPathIdentity} match against `pendingUnresolvedQuarantines` when nothing ACTIVE matches, and
 * reports NOT FOUND (round 7) when NEITHER matches at all — never a recompute (see this function's own
 * `@decision` tag below for why).
 *
 * Used directly by `/clear-by-path`'s `{repoPath}` form, AND (card 883e29bc, round 2) by {@link
 * clearMergeQuarantine} itself whenever its own `repoPath` is not currently resolvable — including,
 * transitively, `/clear` (project-resolved) via {@link clearMergeQuarantineReporting}. No longer the
 * no-project-resolution route's own exclusive caller.
 *
 * @decision abccee85 — never recompute `canonicalRepoLockKey` from a human-supplied repoPath string to
 * decide which entry to clear; see the decision record for the key-drift bugs this closes, including
 * round 7's fix to this function's OWN final fallback (it used to do exactly that).
 */
export function clearMergeQuarantineByRecordedPath(repoPath: string): { wasQuarantined: boolean; reason?: string; latchKept?: true; referencingRepoPaths?: string[] } {
  const identity = directPathIdentity(repoPath);
  const matched: Array<{ key: string; repoPath: string }> = [];
  const seen = new Set<MergeQuarantineEntry>();
  for (const [key, entry] of activeQuarantines) {
    if (directPathIdentity(entry.repoPath) !== identity) continue;
    if (seen.has(entry)) continue; // same logical entry armed under >1 key (armedKeys) — clear it once
    seen.add(entry);
    matched.push({ key, repoPath: entry.repoPath });
  }
  const keptReferencingRepoPaths = new Set<string>();
  let wasQuarantined = false;
  if (matched.length > 0) {
    wasQuarantined = true;
    for (const m of matched) {
      const result = clearMergeQuarantineByKey(m.key, m.repoPath);
      if (result?.latchKept) for (const rp of result.referencingRepoPaths) keptReferencingRepoPaths.add(rp);
    }
  }
  // Also sweep every PENDING (boot-unverifiable) entry sharing this exact identity — UNCONDITIONALLY, never
  // only when no active match was found. A pending entry's own path typically can't resolve at all, so a
  // fresh canonicalRepoLockKey recompute of `repoPath` can walk UP to an ENCLOSING repo's key and wrongly
  // lift THAT repo's active quarantine instead of this (unrelated) pending entry — see the decision
  // record, round 5. Drop EVERY matching pending entry (round 6, consistent with clearMergeQuarantineByKey's
  // own identity-matched filter — more than one pending latch can share one identity), never just the first
  // found.
  //
  // @decision d4b25feb (round 3, MAJOR) — NOT merely an `else` to the active branch: this function's own
  // job is a BROAD, identity-wide clear; `clearMergeQuarantineByKey`'s round-2 fix narrowed ITS own sweep.
  const matchedPending = pendingUnresolvedQuarantines.filter((p) => directPathIdentity(p.entry.repoPath) === identity);
  if (matchedPending.length > 0) {
    wasQuarantined = true;
    pendingUnresolvedQuarantines = pendingUnresolvedQuarantines.filter((p) => !matchedPending.includes(p));
    // @decision 6237bef6 — sweep each dropped pending entry's OWN orphanLatchFiles too, not just its
    // sourceFile; see the decision record (site 3 of 3 — abccee85's own trace named only the other two).
    const orphanFilesToSweep = new Set<string>();
    // @decision 882d6cff (round 4) — capture whether this claimant's own sourceFile survived because a
    // DIFFERENT, still-pending claimant shares it (never surfaced before this round) — see the decision
    // record for why this is expected, not a bug, and how to lift it durably.
    for (const p of matchedPending) {
      for (const f of p.entry.orphanLatchFiles ?? []) orphanFilesToSweep.add(f);
      // @decision 883e29bc — mirror clearMergeQuarantineByKey's own armedKeys lift, gated the same way
      // via pendingEntryStillOwnsKey — a key here can belong to someone else entirely by now.
      for (const k of p.entry.armedKeys ?? []) {
        if (!pendingEntryStillOwnsKey(k, p.entry)) continue;
        activeQuarantines.delete(k);
        deleteMergeQuarantineLatchByKey(k);
      }
      // @decision 883e29bc (round 4) — never a bare unlink: `p` is already removed from
      // pendingUnresolvedQuarantines above, so this correctly checks whether a SURVIVING entry (e.g. a
      // fresh raise reusing the freed key) now physically owns this exact filename.
      const sweepResult = sweepOwnLatchFileUnlessOwnedElsewhere(p.sourceFile);
      if (sweepResult.kept) for (const rp of sweepResult.referencingRepoPaths) keptReferencingRepoPaths.add(rp);
    }
    for (const orphanFile of orphanFilesToSweep) sweepOrphanLatchFileIfUnreferenced(orphanFile);
  }
  if (!wasQuarantined) {
    // Nothing active or pending matches this identity at all (round 7) — report NOT FOUND rather than
    // falling through to a recompute: a fresh canonicalRepoLockKey walk of a given string that resolves to
    // NOTHING under this exact repoPath can still walk UP to an ENCLOSING repo's real `.git` and collaterally
    // lift THAT unrelated, genuinely-quarantined repo (the same drift class round 5/6 already closed for the
    // pending-entry case, reached here through the "nothing matches at all" door instead — see the decision
    // record, round 7).
    return {
      wasQuarantined: false,
      reason: `no active or pending quarantine is stored under the exact repoPath '${repoPath}' — see GET /internal/merge-quarantine/list for the exact recorded repoPath/id to clear by`,
    };
  }
  if (keptReferencingRepoPaths.size > 0) {
    const refs = [...keptReferencingRepoPaths];
    return {
      wasQuarantined: true, latchKept: true, referencingRepoPaths: refs,
      reason: `this identity's own quarantine is lifted, but a SHARED latch file it referenced is still needed by ${refs.length} other claimant(s) sharing this exact degraded key (${refs.join(", ")}) — it stays on disk, and this (and every other) claimant sharing it WILL RE-DIVERT on the next restart until EVERY claimant sharing it has been cleared too. To lift all of them durably right now, clear the shared latch by its own 24-hex id (POST /internal/merge-quarantine/clear-by-path with {id}) instead of by repoPath.`,
    };
  }
  return { wasQuarantined: true };
}

/**
 * @decision abccee85 (round 6) — the pending lookup below matches by {@link directPathIdentity}, never a
 * freshly recomputed `canonicalRepoLockKey` — see the decision record for the "clear(outer) reports
 * ok:true while outer stays blocked by an unrelated pending inner, forever" bug this closes.
 *
 * @decision abccee85 (round 7) — identity-only matching still fails OPEN for the R/sub-then-query-R shape
 * (a pending nested-path latch queried later via a different same-repo path, once resolvable again) — see
 * the decision record's "Round 7" section for the repro and the two fallback passes' own safety argument.
 */
export function activeMergeQuarantineFor(repoPath: string): MergeQuarantineEntry | undefined {
  const key = canonicalRepoLockKey(repoPath);
  const direct = activeQuarantines.get(key);
  if (pendingUnresolvedQuarantines.length === 0) return direct;
  if (direct) {
    // @decision 8a1bc2ef (round 2, Code Review) — only absorb into `direct` when IT is genuinely
    // key-verified, never when it merely occupies `key` via PASS 1's degraded dual-arm fallback — see the
    // decision record for the nested-repo repro this guard closes.
    if (!isKeyVerifiedFor(direct.repoPath, key)) return direct;
    // @decision 8a1bc2ef — a sibling pending entry (card 7673d096) can share this exact key without ever
    // matching the identity that originally armed `direct` — absorb it now, or this fast path never
    // looks at `pendingUnresolvedQuarantines` again for this key. See the decision record for the repro.
    const siblingIndices = collectCrossTierSiblingIndices(key, []);
    if (siblingIndices.length === 0) return direct;
    return consumeMatchedPendingsIntoArmedEntry(siblingIndices, key, direct).armed;
  }
  const identity = directPathIdentity(repoPath);
  // @decision 188b145f — collect EVERY identity-matching index at the winning tier, never just the first
  // (mirrors `clearMergeQuarantineLatchFile`'s/`clearMergeQuarantineByRecordedPath`'s own `.filter(...)`
  // pending match loops) — see the decision record for why "first hit" silently orphaned the rest forever.
  let indices = collectPendingIndices((p) => directPathIdentity(p.entry.repoPath) === identity);
  if (indices.length === 0) {
    const ancestorIdentity = ancestorAwarePathIdentity(repoPath);
    indices = collectPendingIndices((p) => ancestorAwarePathIdentity(p.entry.repoPath) === ancestorIdentity);
  }
  if (indices.length === 0) {
    indices = collectPendingIndices((p) => isRepoPathCurrentlyResolvable(p.entry.repoPath) && canonicalRepoLockKey(p.entry.repoPath) === key);
  }
  if (indices.length === 0) {
    // @decision 883e29bc — match a STILL-unresolvable entry by key, gated on its OWN resolvedKey (PASS
    // 1/1b's divert); never a bare never-resolved no-resolvedKey latch (abccee85/r7's "nothing to walk").
    indices = collectPendingIndices((p) => !isRepoPathCurrentlyResolvable(p.entry.repoPath) && !!p.entry.resolvedKey && canonicalRepoLockKey(p.entry.repoPath) === key);
  }
  if (indices.length === 0) return undefined;
  const matched = indices.map((i) => pendingUnresolvedQuarantines[i] as PendingUnresolvedQuarantine); // indices are verified hits above
  const first = matched[0] as PendingUnresolvedQuarantine;
  if (!isRepoPathCurrentlyResolvable(first.entry.repoPath)) {
    // STILL can't be verified — report it active for THIS query, but leave EVERY matched entry in
    // `pendingUnresolvedQuarantines` rather than pinning any of them to a key that may not hold once the
    // path genuinely resolves. Pinning here would reopen the exact bug this pending mechanism exists to
    // close: a LATER remount recomputes a DIFFERENT (real) key, and an already-graduated entry sitting
    // under the degraded key would miss it exactly like the original one-boot fail-open did, just later.
    // Every matched entry shares `first`'s identity by construction, so its resolvability speaks for all.
    return first.entry;
  }
  // Genuinely resolvable now — graduate EVERY identity-matching pending entry in ONE step via the shared
  // {@link consumeMatchedPendingsIntoArmedEntry} helper (card 188b145f, round 3): splicing only the first
  // used to leave the rest stuck in `pendingUnresolvedQuarantines` forever (a later query for the same
  // repo always hits `direct` above and never looks at `pendingUnresolvedQuarantines` again). This happens
  // UNCONDITIONALLY, in-memory, regardless of whether the durable write succeeds — mirroring PASS 1's own
  // migrate branch, enforcement for THIS process must not wait on disk I/O succeeding.
  //
  // @decision 8a1bc2ef — ALSO absorb any OTHER pending entry sharing this exact canonical key, even one
  // that never matched at the winning tier's own identity (e.g. a toplevel-bound sibling's own pending
  // entry when THIS query graduated via a subdir's identity instead) — see the decision record.
  const siblingIndices = collectCrossTierSiblingIndices(key, indices);
  const allIndices = siblingIndices.length > 0 ? [...indices, ...siblingIndices] : indices;
  const { armed, matched: consumed, writeSucceeded } = consumeMatchedPendingsIntoArmedEntry(allIndices, key);
  if (!writeSucceeded) {
    // eslint-disable-next-line no-console
    console.error(`[merge-quarantine] lazily re-resolved ${consumed.length} pending unverifiable quarantine entr${consumed.length === 1 ? "y" : "ies"} for ${armed.repoPath} but could NOT durably persist it under its now-known key — still enforced in THIS process, but the ORIGINAL file(s) (${consumed.map((p) => p.sourceFile).join(", ")}) are now tracked as owned by this entry's own orphanLatchFiles rather than deleted; a later boot can still recover it.`);
  }
  return armed;
}

/** Diagnostic snapshot only (e.g. a status endpoint) — never used to decide anything itself. Includes
 *  PENDING (boot-unverifiable) entries too, so a human reading this never sees a blind spot that
 *  `activeMergeQuarantineFor` itself would resolve the moment it's actually queried for that repo.
 *  De-duped by entry IDENTITY (reference) ACROSS BOTH sources in ONE Set — an entry armed under two keys
 *  (see `armedKeys`) sits twice in `activeQuarantines.values()` (once per key), and (card 883e29bc) PASS
 *  1/1b's degraded-arm diversion can ALSO push the SAME object into `pendingUnresolvedQuarantines` (it is
 *  armed at its own resolvedKey while its degraded walked-up key's signal is deferred to pending) — either
 *  way, it must be reported once, never twice. */
export function listActiveMergeQuarantines(): MergeQuarantineEntry[] {
  return [...new Set([...activeQuarantines.values(), ...pendingUnresolvedQuarantines.map((p) => p.entry)])];
}

/**
 * A STRUCTURAL invariant this module WANTS every boot's final state to satisfy: for each distinct repo
 * IDENTITY (never a key, which can be shared/degraded), at most ONE object represents it, OR EXACTLY TWO
 * forming one genuinely-active entry plus one independent, genuinely-pending entry (card `d4b25feb`'s own
 * "one identity, two raise-groups" shape — a repoPath raised once while resolvable, then again later while
 * unresolvable) — and in that two-object case, their token SETS must be completely DISJOINT (no token in
 * both; a shared token would mean a stale, un-synced copy, the exact staleness `d4b25feb` round 3 fixed).
 * `listActiveMergeQuarantines`'s own reported count must equal the total number of distinct OBJECTS (never
 * identities — one identity can now legitimately own two). TEST-ONLY (never a production call site — this
 * module's own guard, `no-src-testonly-import-guard.mjs`, keeps a `packages/daemon/src/**` file from ever
 * importing it).
 *
 * ⚠️ NOT actually true of every reachable fixture: a degraded X at Kx with an OLDER stale-named sibling S
 * migrating to Kx is a KNOWN, pre-existing, by-design counter-example where S is reported twice and X
 * zero times. Calling this on such a fixture correctly reports a violation; that is NOT a sign this check
 * is broken, it is the check doing its job against a case no current fix reaches.
 *
 * @decision a2f381dc — the counter-example above (M-2) is accepted and documented, not fixed. See the
 * decision record.
 *
 * @decision fd189d91 — catches the NEXT spread-replace site that forgets to route through
 * {@link replaceEntryEverywhere}, not just the two this card already found. See the decision record.
 *
 * @decision d4b25feb (round 3) — the ORIGINAL "at most one object per identity, always" invariant this
 * function asserted is now TOO STRICT (it would flag this card's own legitimate new shape as a violation);
 * see this function's own updated doc above for the replacement rule.
 */
export function assertQuarantineIdentityInvariantTestOnly(): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  const byIdentity = new Map<string, MergeQuarantineEntry[]>();
  const activeEntrySet = new Set(activeQuarantines.values());
  const pendingEntrySet = new Set(pendingUnresolvedQuarantines.map((p) => p.entry));
  const allRaw: MergeQuarantineEntry[] = [...activeQuarantines.values(), ...pendingUnresolvedQuarantines.map((p) => p.entry)];
  for (const e of allRaw) {
    const identity = directPathIdentity(e.repoPath);
    const list = byIdentity.get(identity) ?? [];
    if (!list.includes(e)) list.push(e); // reference-dedup within the same identity bucket
    byIdentity.set(identity, list);
  }
  for (const [identity, list] of byIdentity) {
    if (list.length <= 1) continue;
    // @decision d4b25feb (round 3) — exactly TWO is legitimate when one is genuinely active-only, the
    // other genuinely pending-only, and their token sets are completely disjoint (card's own new shape).
    if (list.length === 2) {
      const [a, b] = list as [MergeQuarantineEntry, MergeQuarantineEntry];
      const aActive = activeEntrySet.has(a), bActive = activeEntrySet.has(b);
      const aPending = pendingEntrySet.has(a), bPending = pendingEntrySet.has(b);
      const oneActiveOnePending = (aActive && !aPending && bPending && !bActive) || (bActive && !bPending && aPending && !aActive);
      const tokensOverlap = a.tokens.some((t) => b.tokens.includes(t));
      if (oneActiveOnePending && !tokensOverlap) continue; // legitimate
    }
    violations.push(`identity ${identity} (repoPath '${list[0]?.repoPath}') has ${list.length} DISTINCT (non-reference-equal) objects representing it — expected exactly 1, or exactly 2 forming one active + one independent pending entry with disjoint tokens`);
  }
  const reportedCount = listActiveMergeQuarantines().length;
  // @decision d4b25feb (round 3) — compare against the total distinct OBJECT count, never the identity
  // count: one identity can now legitimately own two distinct objects, so `byIdentity.size` under-counts.
  const distinctObjectCount = new Set(allRaw).size;
  if (reportedCount !== distinctObjectCount) {
    violations.push(`listActiveMergeQuarantines() reported ${reportedCount} entries but there are ${distinctObjectCount} distinct objects`);
  }
  return { ok: violations.length === 0, violations };
}

/** The bare 24-hex-character latch FILE id (never a repoPath) `repoPath`'s own canonical key currently
 *  hashes to. TEST/DIAGNOSTIC HELPER ONLY (round 3, card c0be9bf9) — no production call site hands this to
 *  a human; `GET /internal/merge-quarantine/list` hands out {@link quarantineLatchFileIdsFor}'s own id
 *  list instead. Kept for a caller (today, only tests) that already holds a bare repoPath and wants the
 *  exact id a FRESH recompute would produce for it, without duplicating this module's hashing by hand.
 *
 *  ⚠️ Do not reach for this in new production code — for an entry armed under more than one key (a
 *  dual-armed `resolvedKey`-vs-current-key entry, decision 54054c01) it can name a DIFFERENT file than the
 *  one that is actually durable on disk, or miss one entirely. */
export function quarantineLatchIdFor(repoPath: string): string {
  return quarantineHashFor(repoPath);
}

/**
 * THE single id-derivation chokepoint for a PENDING entry's `sourceFile` — used by BOTH
 * {@link quarantineLatchFileIdsFor} (the forward, entry→id direction) and
 * {@link clearMergeQuarantineLatchFile}'s own reverse, id→entries match, so the two can never compute a
 * DIFFERENT id for the same `sourceFile`.
 *
 * @decision fd189d91 — a `.tmp-safety-` shaped sourceFile's embedded hash prefix is the COLLIDING
 * SIBLING's own real key hash, never this entry's own identity — hand out a hash of the FULL basename
 * instead, or this id collides with the sibling's real one. See the decision record for the repro.
 */
function pendingLatchIdFor(sourceFile: string): string {
  if (SAFETY_TMP_RE.test(sourceFile)) {
    return createHash("sha256").update(sourceFile).digest("hex").slice(0, 24);
  }
  // @decision d4b25feb — a pending-divert basename (clean final OR a crash-left tmp residue) is NOT
  // itself a valid 24-hex id — hash the FULL basename, mirroring the SAFETY_TMP_RE branch above.
  if (PENDING_DIVERT_RE.test(sourceFile) || PENDING_DIVERT_TMP_RE.test(sourceFile)) {
    return createHash("sha256").update(sourceFile).digest("hex").slice(0, 24);
  }
  // @decision 6237bef6 — sourceFile is `<hash>.json` for a PASS-1-sourced pending entry but
  // `<hash>.json.tmp-<pid>` for a PASS-1b tmp-residue one — cut at the first `.json`, not a fixed
  // trailing-length slice, so both shapes recover the bare hash (never a literal `.json` substring).
  const jsonIdx = sourceFile.indexOf(".json");
  return jsonIdx === -1 ? sourceFile : sourceFile.slice(0, jsonIdx);
}

/** The on-disk latch file id(s) for `entry` — one per key it is armed under
 *  ({@link MergeQuarantineEntry.armedKeys}), or, for a PENDING (boot-unverifiable) entry with no
 *  `armedKeys` of its own, the id {@link pendingLatchIdFor} derives from its own recorded `sourceFile`
 *  name. Exported so a human-facing listing route can hand out id(s) usable with
 *  {@link clearMergeQuarantineLatchFile}.
 *
 * @decision c0be9bf9 — not every id in the array has its own physical file; `ids[0]` names a real one
 * whenever any armed key has one (sorted real-file-first), but not when a failed durable write leaves
 * none with a file at all — see the decision record.
 */
export function quarantineLatchFileIdsFor(entry: MergeQuarantineEntry): string[] {
  if (entry.armedKeys?.length) {
    const ids = [...new Set(entry.armedKeys.map(quarantineHashForKey))];
    return ids.sort((a, b) => {
      const aExists = fs.existsSync(path.join(MERGE_QUARANTINE_DIR, `${a}.json`));
      const bExists = fs.existsSync(path.join(MERGE_QUARANTINE_DIR, `${b}.json`));
      return aExists === bExists ? 0 : aExists ? -1 : 1;
    });
  }
  const pending = pendingUnresolvedQuarantines.find((p) => p.entry === entry);
  if (pending) return [pendingLatchIdFor(pending.sourceFile)];
  return [quarantineHashFor(entry.repoPath)];
}

/** Thin wrapper over {@link clearMergeQuarantine} for the project-resolved `/internal/merge-quarantine/clear`
 *  route (card c0be9bf9) — that route's own job ends at resolving projectId/repoKey down to a `repoPath`
 *  and calling this.
 *
 * A clear can run and lift NOTHING belonging to `repoPath`'s own entry: `repoPath` may be resolvable
 * (its own key addressed, unchanged) while what makes it read quarantined is a DIFFERENT repo's diverted
 * entry merely occupying that same key (PASS 1's degraded-divert; the 4th `activeMergeQuarantineFor`
 * tier). Plain `wasQuarantined:true` there would falsely imply success.
 *
 * @decision 883e29bc — judge by RE-RESOLVING repoPath fresh AFTER the clear, never by whether the
 * PRE-clear object still exists: a lifted blocker can unmask a different one; a stale pending remnant
 * of an already-lifted blocker can look like "still quarantined" when it is not.
 *
 * @decision 882d6cff (round 4) — ALSO surfaces `clearMergeQuarantine`'s own `latchKept`/
 * `referencingRepoPaths`; re-resolving `repoPath` afterward finds nothing (a diverted entry never
 * blocks via the degraded-key tier), so without this the caller sees a plain, uninformative success.
 */
export function clearMergeQuarantineReporting(repoPath: string): { wasQuarantined: boolean; reason?: string; latchKept?: true; referencingRepoPaths?: string[] } {
  const before = resolveQuarantineFor(repoPath);
  const wasQuarantined = !!before;
  const clearResult = clearMergeQuarantine(repoPath);
  const after = resolveQuarantineFor(repoPath);
  if (after) {
    const latchId = quarantineLatchFileIdsFor(after)[0];
    // @decision 883e29bc — word by WHICH blocker remains: the SAME one `before` already was (never
    // touched), or a DIFFERENT repo's own separate quarantine (not residue of this clear).
    const sameAsBefore = !!before && directPathIdentity(before.repoPath) === directPathIdentity(after.repoPath);
    const reason = sameAsBefore
      ? `repoPath is still quarantined by its own recorded entry (repoPath '${after.repoPath}', latch id '${latchId}') — this clear did not lift it`
      : `repoPath is quarantined by ANOTHER repo's own, separate quarantine (repoPath '${after.repoPath}', latch id '${latchId}') that this clear never addressed`;
    return {
      wasQuarantined: true,
      reason: `${reason} — use POST /internal/merge-quarantine/clear-by-path with ${JSON.stringify({ repoPath: after.repoPath })} or ${JSON.stringify({ id: latchId })} to clear it directly.`,
    };
  }
  if (clearResult && "latchKept" in clearResult && clearResult.latchKept) {
    return { wasQuarantined, latchKept: true, referencingRepoPaths: clearResult.referencingRepoPaths, reason: clearResult.reason };
  }
  return { wasQuarantined };
}

const QUARANTINE_LATCH_ID_PATTERN = /^[0-9a-f]{24}$/;

/**
 * Clear a quarantine latch by its bare FILE id (card c0be9bf9). `id` must be EXACTLY the 24-hex-character
 * form {@link quarantineLatchIdFor}/{@link quarantineLatchFileIdsFor} produce — validated BEFORE any
 * filesystem access, so a malformed id can never reach a path join.
 *
 * @decision c0be9bf9 — resolve `id` to the matched entry's own Map KEY and delegate to
 * clearMergeQuarantineByKey — never to its `repoPath` via clearMergeQuarantineReporting/
 * clearMergeQuarantine (round 1, superseded in round 3 — see the decision record for why that drifts).
 *
 * Falls back to a reference-aware sweep of `<id>.json` (+ tmp residue) ONLY when no entry anywhere
 * matches `id` — a genuinely corrupt/unparsable latch with no repoPath to delegate to.
 *
 * @decision 9cabd143 — that fallback, and the pending-match branch's own belt-and-suspenders sweep,
 * route `<id>.json` through a check-1-AND-2 sweep when it is NOT a matched entry's own sourceFile
 * (be79f4d5), never a bare `fs.unlinkSync`. A kept file is reported via `latchKept`, never silent.
 *
 * @decision fd189d91 — the active and pending matches are both found BEFORE either is acted on; when
 * `id` matches an active entry AND a pending entry for a genuinely DIFFERENT repo, this refuses rather
 * than silently picking the active one. See the decision record for the repro.
 */
export function clearMergeQuarantineLatchFile(id: string): { ok: true; wasQuarantined: boolean; liftedRepoPaths: string[]; latchKept?: true; referencingRepoPaths?: string[] } | { ok: false; reason: string } {
  if (!QUARANTINE_LATCH_ID_PATTERN.test(id)) {
    return { ok: false, reason: `invalid latch id '${id}' — expected a 24-hex-character id (see GET /internal/merge-quarantine/list)` };
  }
  const resolvedDir = path.resolve(MERGE_QUARANTINE_DIR);
  const finalPath = path.resolve(resolvedDir, `${id}.json`);
  if (path.dirname(finalPath) !== resolvedDir || path.basename(finalPath) !== `${id}.json`) {
    return { ok: false, reason: "resolved path escaped the quarantine directory — refusing" };
  }
  let activeMatch: { key: string; entry: MergeQuarantineEntry } | undefined;
  for (const [key, matchedEntry] of activeQuarantines) {
    if (quarantineHashForKey(key) === id) { activeMatch = { key, entry: matchedEntry }; break; }
  }
  // @decision 6237bef6 (round 2, item 1) — collect EVERY pending entry sharing this id, never just the
  // first found — see the decision record for the multi-pending-entries-per-id repro this closes.
  const matchedPending = pendingUnresolvedQuarantines.filter((p) => pendingLatchIdFor(p.sourceFile) === id);
  if (activeMatch) {
    const activeIdentity = directPathIdentity(activeMatch.entry.repoPath);
    const differentRepoPending = matchedPending.filter((p) => directPathIdentity(p.entry.repoPath) !== activeIdentity);
    if (differentRepoPending.length > 0) {
      const candidates = [activeMatch.entry.repoPath, ...differentRepoPending.map((p) => p.entry.repoPath)];
      return {
        ok: false,
        reason: `latch id '${id}' matches BOTH an active quarantine ('${activeMatch.entry.repoPath}') AND ${differentRepoPending.length} ` +
          `pending entr${differentRepoPending.length === 1 ? "y" : "ies"} for a DIFFERENT repo (${differentRepoPending.map((p) => `'${p.entry.repoPath}'`).join(", ")}) — ` +
          `refusing to guess which one you meant. Clear by repoPath instead: POST /internal/merge-quarantine/clear-by-path with one of ${JSON.stringify(candidates)}.`,
      };
    }
    clearMergeQuarantineByKey(activeMatch.key, activeMatch.entry.repoPath);
    return { ok: true, wasQuarantined: true, liftedRepoPaths: [activeMatch.entry.repoPath] };
  }
  if (matchedPending.length > 0) {
    // A pending entry isn't armed into activeQuarantines under any key — drop ONLY these exact pending
    // entries and their own sourceFiles directly, never a recomputed-key delegation (which could drift
    // onto an unrelated repo's entry the same way the active-entry path used to — round 3).
    pendingUnresolvedQuarantines = pendingUnresolvedQuarantines.filter((p) => !matchedPending.includes(p));
    const orphanFilesToSweep = new Set<string>();
    const keptRepoPaths = new Set<string>();
    // @decision 9cabd143 (round 2, item 1) — each pending entry's own sourceFile is OWNED by the entry
    // being cleared, never gated on check (1) — see sweepOwnLatchFileUnlessOwnedElsewhere's own doc.
    for (const pending of matchedPending) {
      for (const f of pending.entry.orphanLatchFiles ?? []) orphanFilesToSweep.add(f);
      const ownSweep = sweepOwnLatchFileUnlessOwnedElsewhere(pending.sourceFile);
      if (ownSweep.kept) for (const rp of ownSweep.referencingRepoPaths) keptRepoPaths.add(rp);
    }
    for (const orphanFile of orphanFilesToSweep) sweepOrphanLatchFileIfUnreferenced(orphanFile);
    // Belt-and-suspenders: sweep this id's own final (if any) and any remaining tmp residue directly, in
    // case something under this exact id sits on disk but was never captured as an in-memory pending
    // entry (e.g. a sibling tmp this process never parsed).
    //
    // @decision be79f4d5 — `${id}.json` is check-2-only (9cabd143 unchanged) ONLY when it's actually one
    // of the entries matched/removed above; otherwise it may be a DIFFERENT surviving entry's own
    // orphan reference sharing this hash prefix, so route it through the full check-1-AND-2 sweep.
    const idJsonIsMatchedSourceFile = matchedPending.some((p) => p.sourceFile === `${id}.json`);
    const finalSweep = idJsonIsMatchedSourceFile
      ? sweepOwnLatchFileUnlessOwnedElsewhere(`${id}.json`)
      : sweepOrphanLatchFileIfUnreferenced(`${id}.json`);
    if (finalSweep.kept) for (const rp of finalSweep.referencingRepoPaths) keptRepoPaths.add(rp);
    // @decision be79f4d5 — ownership-checked (never the unconditional sibling): a DIFFERENT, surviving
    // pending/active entry can own a `.tmp-<pid>` residue sharing THIS exact hash prefix (e.g. its own
    // stale graduation source) even though no entry actually matched/removed above claims it.
    const tmpSweep = sweepTmpResidueForHashIfUnreferenced(id);
    if (tmpSweep.kept) for (const rp of tmpSweep.referencingRepoPaths) keptRepoPaths.add(rp);
    return {
      ok: true, wasQuarantined: true, liftedRepoPaths: matchedPending.map((p) => p.entry.repoPath),
      ...(keptRepoPaths.size > 0 ? { latchKept: true, referencingRepoPaths: [...keptRepoPaths] } : {}),
    };
  }
  // No in-memory entry anywhere matches this id — a truly corrupt/unparsable latch (or its own tmp
  // residue) with no repoPath to delegate to. Routed through the shared helper (card 9cabd143 — see this
  // function's own doc), never a bare unlink: `<id>.json` can still be a SURVIVING entry's own reference
  // or physical latch even when nothing in-memory matches `id` itself.
  const ownSweep = sweepOrphanLatchFileIfUnreferenced(`${id}.json`);
  // @decision be79f4d5 — the tmp-residue twin of the `.json` sweep just above: ownership-checked, never
  // an unconditional-by-hash delete.
  const tmpSweep = sweepTmpResidueForHashIfUnreferenced(id);
  const keptRepoPaths = new Set<string>([...ownSweep.referencingRepoPaths, ...tmpSweep.referencingRepoPaths]);
  return {
    ok: true, wasQuarantined: false, liftedRepoPaths: [],
    ...(keptRepoPaths.size > 0 ? { latchKept: true, referencingRepoPaths: [...keptRepoPaths] } : {}),
  };
}

/**
 * Split `entries` (the shape {@link listActiveMergeQuarantines} / {@link reenterMergeQuarantinesAtBoot}
 * return) by whether each one's repo is a member of `registeredRepoPaths` — i.e. whether any currently-
 * configured project (including an archived one — see the caller's own doc for why that matters) still
 * names this exact repo. Shared by the boot-time summary (card c0be9bf9, collapsing a wall of per-latch
 * warnings for repos that were never registered, or no longer are, into one line) AND the read-only list
 * route's own `registered` flag — the two must use the IDENTICAL criterion, or a human reading the list
 * sees a different answer than what the boot log just told them.
 *
 * Registration is checked by CANONICAL KEY, never a raw string match — a registered repoPath and a
 * quarantine entry's own `repoPath` can be different spellings of the same physical repo (case, trailing
 * slash), and `canonicalRepoLockKey` is the one place this module already trusts for that comparison.
 *
 * @decision abccee85 (round 6) — a PENDING entry (its own path unresolvable) is matched via
 * {@link directPathIdentity} instead, never `canonicalRepoLockKey` — its path can walk UP to an ENCLOSING
 * registered repo's key and get misreported as `registered:true` under that unrelated repo's identity.
 */
export function partitionQuarantinesByRegistration(
  entries: MergeQuarantineEntry[],
  registeredRepoPaths: string[],
): { registered: MergeQuarantineEntry[]; orphaned: MergeQuarantineEntry[] } {
  const registeredKeys = new Set(registeredRepoPaths.map(canonicalRepoLockKey));
  const registeredIdentities = new Set(registeredRepoPaths.map(directPathIdentity));
  const pendingEntries = new Set(pendingUnresolvedQuarantines.map((p) => p.entry));
  const registered: MergeQuarantineEntry[] = [];
  const orphaned: MergeQuarantineEntry[] = [];
  for (const entry of entries) {
    const matches = pendingEntries.has(entry)
      ? registeredIdentities.has(directPathIdentity(entry.repoPath))
      : registeredKeys.has(canonicalRepoLockKey(entry.repoPath));
    (matches ? registered : orphaned).push(entry);
  }
  return { registered, orphaned };
}

/**
 * THE one shared refusal check every canonical-mutating entry point on the merge/batch path calls — never
 * re-derive this by hand at a call site. Read-only; raising/clearing a quarantine is always a SEPARATE,
 * explicit call (this never mutates state itself).
 *
 * @decision abccee85 (round 6) — name the BLOCKING entry's own `repoPath`/latch id and point at
 * `/clear-by-path`, never bare `/clear` — see the decision record for why the blocking repo can differ
 * from the one asked about, and why `/clear` alone can be a dead end.
 *
 * @decision 883e29bc (round 2, finding 1) — resolve via {@link resolveQuarantineFor}, never a bare
 * `activeMergeQuarantineFor`: when repoPath is unresolvable and has its OWN recorded (diverted) entry,
 * name THAT one — never an unrelated repo's entry that merely occupies the same walked-up key.
 */
export function assertRepoNotQuarantined(repoPath: string): { ok: true } | { ok: false; reason: string } {
  const q = resolveQuarantineFor(repoPath);
  if (!q) return { ok: true };
  const latchId = quarantineLatchFileIdsFor(q)[0];
  return {
    ok: false,
    reason: `canonical repo is QUARANTINED after an earlier operation's git process tree could not be confirmed dead ` +
      `(blocking repo '${q.repoPath}', latch id '${latchId}', branch '${q.branch}'${q.opId ? `, op ${q.opId}` : ""}, entered ${new Date(q.enteredAt).toISOString()}): ${q.reason} — ` +
      `refusing further canonical-repo mutations here until that kill is confirmed dead (auto-clears, same process only) ` +
      `or a human clears it: POST /internal/merge-quarantine/clear-by-path with ${JSON.stringify({ repoPath: q.repoPath })} or ${JSON.stringify({ id: latchId })} ` +
      `(the project-resolved POST /internal/merge-quarantine/clear works only if a registered project's repo resolves to this entry).`,
  };
}

/** Quarantine EVERY repo in `registeredRepoPaths`, fail-closed, with one loud log line naming why — the
 *  round-6 BLOCKER 2 response to a boot-time latch this process cannot positively rule out as real (here:
 *  the latch DIRECTORY itself couldn't even be listed, so there is no per-orphan-file bookkeeping to do —
 *  see {@link reenterMergeQuarantinesAtBoot}'s own PASS 2 for the unmatched-corrupt-LATCH-FILE case, which
 *  tracks `orphanLatchFiles` instead of calling this). A human must inspect and clear each one that turns
 *  out to be fine: `POST /internal/merge-quarantine/clear`. */
function quarantineAllRegisteredFailClosed(registeredRepoPaths: string[], reason: string): MergeQuarantineEntry[] {
  // eslint-disable-next-line no-console
  console.error(`[merge-quarantine] ${reason} — QUARANTINING EVERY REGISTERED CANONICAL REPO (${registeredRepoPaths.length}) as a fail-closed precaution; a human must clear each one that turns out to be fine: POST /internal/merge-quarantine/clear`);
  const out: MergeQuarantineEntry[] = [];
  for (const repoPath of registeredRepoPaths) {
    const key = canonicalRepoLockKey(repoPath);
    const entry: MergeQuarantineEntry = {
      repoPath, branch: PLACEHOLDER_BRANCH_UNRESOLVED,
      reason, enteredAt: Date.now(), tokens: [randomUUID()], armedKeys: [key], placeholder: true,
    };
    activeQuarantines.set(key, entry);
    // Round 7 cheap-minor: don't ignore a failed durable write here either.
    if (!writeMergeQuarantineLatch(entry)) {
      // eslint-disable-next-line no-console
      console.error(`[merge-quarantine] fail-closed quarantine for ${repoPath} could NOT be durably persisted — it will NOT survive another restart until this is fixed.`);
    }
    out.push(entry);
  }
  return out;
}

/**
 * Load every durable quarantine latch back into the in-memory map — called ONCE, early in boot, BEFORE any
 * merge/batch/worktree-create call (and BEFORE the gateway starts accepting any request at all — see
 * index.ts's own call site) can run. Unlike merge-danger-latch.ts's crash-recovery latch, this is NOT
 * consume-on-read: the file stays on disk — it only ever leaves disk via an explicit
 * {@link clearMergeQuarantine}. Never throws.
 *
 * `registeredRepoPaths` — every canonical repo this daemon knows about (the SAME list index.ts already
 * builds for the merge-danger-residue scan) — is what makes a CORRUPT/unparsable latch fail CLOSED instead
 * of open:
 *  - A latch that parses cleanly re-arms exactly as before.
 *  - A latch that does NOT parse, but whose FILENAME's hash matches one of `registeredRepoPaths`, quarantines
 *    THAT specific repo — SELF-HEALING: the fresh entry is written back to the SAME path
 *    (`quarantinePathFor` is deterministic per repo), so the corrupt file is overwritten immediately, never
 *    left as an orphan.
 *  - A latch that does NOT parse and matches NO registered repo (an ORPHAN — its filename can never be
 *    self-healing-overwritten) — or a `readdirSync`/`mkdirSync` failure that means we can't even ENUMERATE
 *    the latches — quarantines EVERY registered repo, tagging each entry's `orphanLatchFiles` with the
 *    orphan's filename (merged into a repo's own real entry if it already has one, never clobbering it) so
 *    {@link clearMergeQuarantine} can delete the orphan once nothing references it any more.
 *
 * @decision 24c0bdba (round 6 BLOCKER 2, round 7 M2 + its residual) — see the decision record for the
 * fail-open-at-boot incident this closes and the two escalating fixes to its own fail-closed sweep.
 */
/**
 * @decision ef651188 (round 2, nit 3) — NOT exported. The injection seam below must be structurally
 * unreachable from production (`index.ts` only ever imports {@link reenterMergeQuarantinesAtBoot}, whose
 * signature has no second parameter at all) rather than merely unused by it — see the decision record.
 */
function reenterMergeQuarantinesAtBootImpl(
  registeredRepoPaths: string[] = [],
  // @decision ef651188 — TEST-ONLY seam: lets a test push a json-shaped pending entry AFTER Phase 0's
  // own protection has already run, to prove the bootWriteLatch backstop fires when Phase 0 is bypassed
  // — a disk layout no real (post-fix) code path can produce. Always undefined in production.
  testOnlyInjectUnprotectedPending?: PendingUnresolvedQuarantine[],
): MergeQuarantineEntry[] {
  // @decision 7673d096 — index BOTH the fresh AND the legacy hash per registered repo, or a pre-upgrade
  // corrupt/torn latch falls through to the broad every-repo sweep instead of its own one repo.
  //
  // @decision 882d6cff (round 2) — index with PRECEDENCE, never a drop: a resolvable path's own fresh
  // hash claims its slot first; an unresolvable path's fresh hash is indexed only where unclaimed. See
  // the decision record for why a bare drop was wrong.
  // Order is PRECEDENCE, weakest first, so each later loop's unconditional `.set()` can override an
  // earlier one's claim at the same hash: legacy (weakest — a repo at its own git toplevel has a legacy
  // hash IDENTICAL to its own fresh hash, so this alone must never be allowed to win over a resolvable
  // SIBLING's later fresh claim at that same shared hash); resolvable fresh, unconditional (strongest —
  // always has the final say). `hashToRepo` resolves to exactly ONE repo by construction for BOTH of
  // these — a legacy hash is never degraded (always a unique, direct-identity value), and two DIFFERENT
  // resolvable paths sharing one fresh hash is the intentional sibling-collapse case (7673d096).
  //
  // @decision 882d6cff (round 3) — an unresolvable path's own degraded fresh hash is NEVER folded into
  // `hashToRepo` as a single winner (two can genuinely share one degraded key) — keep the FULL SET of
  // claimants instead, each getting its own divert. See the decision record for the fail-open repro.
  const hashToRepo = new Map<string, string>();
  for (const p of registeredRepoPaths) {
    hashToRepo.set(legacyQuarantineHashFor(p), p);
  }
  for (const p of registeredRepoPaths) {
    if (isRepoPathCurrentlyResolvable(p)) hashToRepo.set(quarantineHashFor(p), p);
  }
  const unresolvedClaimantsByHash = new Map<string, string[]>();
  for (const p of registeredRepoPaths) {
    if (!isRepoPathCurrentlyResolvable(p)) {
      const h = quarantineHashFor(p);
      const claimants = unresolvedClaimantsByHash.get(h) ?? [];
      claimants.push(p);
      unresolvedClaimantsByHash.set(h, claimants);
    }
  }
  // Every claimant for a hash `hashToRepo` ALSO resolves (a resolvable or legacy match at that exact
  // hash) is redundant to carry here — `hashToRepo`'s own verified match always takes precedence at both
  // lookup sites below, so stripping it here keeps `unresolvedClaimantsByHash` exactly the AMBIGUOUS,
  // multi-claimant-or-nothing-else-claims-it population the two lookup sites actually need to fall back to.
  for (const [h] of unresolvedClaimantsByHash) {
    if (hashToRepo.has(h)) unresolvedClaimantsByHash.delete(h);
  }
  // @decision f5c42043 — THIRD, LOWEST-precedence tier, consulted only when both tiers above miss. See
  // the decision record for why `hashToRepo`/`unresolvedClaimantsByHash` alone can go permanently stale.
  //
  // @decision f5c42043 (Code Review 2dd4401e) — built LAZILY on the FIRST miss in tiers 1+2, memoized
  // after: an unreachable UNC/SMB registered path's own ancestor walk can stall every boot otherwise.
  let ancestorHashToRepoCache: Map<string, string[]> | null = null;
  const ancestorHashToRepo = (): Map<string, string[]> => {
    if (ancestorHashToRepoCache) return ancestorHashToRepoCache;
    const built = new Map<string, string[]>();
    for (const p of registeredRepoPaths) {
      for (const h of ancestorToplevelHashes(p)) {
        const claimants = built.get(h) ?? [];
        claimants.push(p);
        built.set(h, claimants);
      }
    }
    ancestorHashToRepoCache = built;
    return built;
  };

  let files: string[];
  // @decision bde5d1fe (item 5) — a leftover `.json.tmp-<pid>` is a write whose fsync completed but whose
  // rename never ran (a crash in that ms window) — collected below and recovered, not silently dropped.
  let tmpFiles: string[];
  // @decision 97cff6db (round 2, Lead ruling 2) — a SAFETY-TMP residue (writeSafetyTmpResidue) is named
  // with a distinct `.tmp-safety-<pid>-<hex>` infix so recovery can tell it apart from an ORDINARY
  // `.tmp-<pid>(-<hex>)?` residue BY NAME, never by inference — see SAFETY_TMP_RE's own doc comment.
  let safetyTmpFiles: string[];
  try {
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const all = fs.readdirSync(MERGE_QUARANTINE_DIR);
    files = all.filter((f) => f.endsWith(".json"));
    // @decision 92c645cc — match BOTH the legacy bare-pid suffix (`.tmp-<pid>`) and the current unique
    // one (`.tmp-<pid>-<hex>`) — a pre-upgrade or foreign-pid tmp must still be recovered.
    // @decision 97cff6db — this pattern requires DIGITS immediately after `.tmp-`, so it never matches a
    // safety-tmp's own `.tmp-safety-...` infix; the two sets are disjoint by construction, not by a
    // separately-maintained exclusion.
    tmpFiles = all.filter((f) => /\.json\.tmp-\d+(-[0-9a-f]+)?$/.test(f));
    safetyTmpFiles = all.filter((f) => SAFETY_TMP_RE.test(f));
  } catch (e) {
    return quarantineAllRegisteredFailClosed(
      registeredRepoPaths,
      `boot-time quarantine-latch directory scan failed (${(e as Error).message}) — cannot rule out a real quarantine we simply couldn't read`,
    );
  }

  const byRepoKey = new Map<string, MergeQuarantineEntry>();
  const orphanFilenames: string[] = [];
  const orphanReasonParts: string[] = [];
  // @decision 92c645cc — PASS 1b's "stale tmp, safe to delete" branch must gate on a key having had a
  // CLEAN parse here, never on `byRepoKey.has(...)` alone (a corrupt-but-hash-matched placeholder also
  // lands in `byRepoKey`, even when its own self-heal write failed).
  const cleanlyParsedKeys = new Set<string>();
  // @decision 883e29bc — a degraded-divert's pending copy must reference byRepoKey's FINAL value, never
  // a mid-loop snapshot a later same-pass union would make stale; collect then flush after each pass.
  const degradedDivertsToFlush: { resolvedKey: string; sourceFile: string }[] = [];
  const flushDegradedDiverts = () => {
    for (const { resolvedKey, sourceFile } of degradedDivertsToFlush) {
      const finalEntry = byRepoKey.get(resolvedKey);
      if (finalEntry) pendingUnresolvedQuarantines.push({ entry: finalEntry, sourceFile });
    }
    degradedDivertsToFlush.length = 0;
  };
  // @decision 4480b077 (round 2) — the .json migrate-write is DEFERRED to one pass after every file is
  // read (never mid-loop), so a not-yet-read sibling's own file can't be clobbered before it's read.
  // Keyed by canonical key; value is the superseded source filenames to delete once that key's write succeeds.
  const migratedSourcesByKey = new Map<string, string[]>();
  // @decision 97cff6db — each source's own STANDALONE entry (never a shared union), by filename — the
  // degraded-occupied fold's own pending reference must use THIS, never `folded`. See the decision record.
  const originalEntryBySource = new Map<string, MergeQuarantineEntry>();
  // @decision 4480b077 (round 2) — every key a DEGRADED entry occupies via its own trusted resolvedKey
  // (883e29bc) — that key's file is that entry's only durable copy; no write pass below may touch it.
  const degradedOccupiedKeys = new Set<string>();
  // @decision 882d6cff (folds in ed74603b) — a matched-corrupt `.json` final is DEFERRED here too, never
  // armed/written inline inside this read loop; see the decision record for why.
  const deferredCorruptJsons: { f: string; matchedRepo: string }[] = [];
  // @decision f5c42043 — a THIRD, distinct deferred collection for an ancestor-tier-only match: resolved
  // by its OWN, simpler loop below that is ALWAYS a pure pending-divert, never the resolvable self-heal
  // branch `deferredCorruptJsons` can take — an ancestor walk is never proof of ownership.
  const deferredAncestorCorruptJsons: { f: string; matchedRepo: string }[] = [];

  // PASS 1 — process EVERY file, never return early.
  for (const f of files) {
    const hash = f.slice(0, -".json".length);
    try {
      const raw = fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f), "utf8");
      const parsed = JSON.parse(raw) as Partial<MergeQuarantineEntry> & { token?: string };
      if (typeof parsed.repoPath !== "string" || typeof parsed.branch !== "string" || typeof parsed.reason !== "string") {
        throw new Error("latch JSON is missing repoPath/branch/reason");
      }
      // A pre-round-7 latch may carry the OLD singular `token` (or, pre-round-6, none at all) — accept
      // either shape. It can never be auto-cleared this way regardless (every raising process is gone by
      // definition of a restart); only the human REST route (or a fresh in-process raise) ever reaches it.
      const tokens = Array.isArray(parsed.tokens) && parsed.tokens.length > 0 && parsed.tokens.every((t): t is string => typeof t === "string")
        ? parsed.tokens
        : [typeof parsed.token === "string" ? parsed.token : randomUUID()];
      // @decision 92c645cc (round 2, item 2) — a LEGACY (field-less) placeholder final, written by
      // round-1/main code before this field existed, is recognized by branch text alone via
      // isPlaceholderEntryShape — never trust a clean JSON.parse by itself to mean "real data".
      const parsedIsPlaceholder = isPlaceholderEntryShape(parsed);
      let entry: MergeQuarantineEntry = {
        repoPath: parsed.repoPath, branch: parsed.branch, reason: parsed.reason,
        opId: typeof parsed.opId === "string" ? parsed.opId : undefined,
        enteredAt: typeof parsed.enteredAt === "number" ? parsed.enteredAt : Date.now(),
        tokens,
        orphanLatchFiles: Array.isArray(parsed.orphanLatchFiles) && parsed.orphanLatchFiles.every((s): s is string => typeof s === "string")
          ? parsed.orphanLatchFiles : undefined,
        resolvedKey: typeof parsed.resolvedKey === "string" ? parsed.resolvedKey : undefined,
        placeholder: parsedIsPlaceholder ? true : undefined,
      };
      const currentKey = canonicalRepoLockKey(entry.repoPath);
      // A placeholder final must NEVER count as a clean parse for PASS 1b's stale-tmp gate — see that
      // Set's own doc comment and docs/decisions/92c645cc-fresh-tmp-name-and-conditional-sweep.md.
      if (!parsedIsPlaceholder) cleanlyParsedKeys.add(currentKey);
      const freshHash = createHash("sha256").update(currentKey).digest("hex").slice(0, 24);
      const resolvableNow = isRepoPathCurrentlyResolvable(entry.repoPath);
      if (!resolvableNow && !entry.resolvedKey) {
        // A PRE-upgrade latch (no resolvedKey recorded at all) whose path can't be verified AT ALL right
        // now — there is no second, trustworthy key to dual-arm under. This check runs BEFORE the
        // freshHash/hash comparison below, deliberately: when NOTHING in the path's ancestor chain
        // resolves, `canonicalRepoLockKey`'s own fallback degrades to the same "no toplevel walk" value a
        // pre-upgrade (direct-path) key would also produce — so freshHash can coincidentally EQUAL this
        // file's own (stale) hash even though the TRUE key, once the path resolves again, will differ.
        // Trusting that coincidental equality as "already correctly keyed" would arm this entry under the
        // same degraded key a plain fall-through would — see
        // docs/decisions/54054c01-clear-lifts-every-key-an-entry-was-armed-under.md. Keep it PENDING
        // instead and let activeMergeQuarantineFor re-resolve it lazily, against whatever key its own
        // repoPath resolves to at the moment it's actually queried.
        // eslint-disable-next-line no-console
        console.warn(`[merge-quarantine] boot-time latch ${f} for ${entry.repoPath} has no recorded resolvedKey and could NOT be verified against its current key — ${entry.repoPath} does not currently resolve on disk — leaving the latch file AS WRITTEN and deferring enforcement to a lazy re-resolve on first query (never guessing a key now that a later remount this boot would not match).`);
        pendingUnresolvedQuarantines.push({ entry, sourceFile: f });
        continue;
      }
      if (freshHash !== hash) {
        if (resolvableNow) {
          // @decision 7673d096 — migrate a stale-key latch ONLY when the path itself currently resolves —
          // never on an unresolvable path, or a transient drive-unmount destroys a genuinely good latch.
          // eslint-disable-next-line no-console
          console.warn(`[merge-quarantine] boot-time latch ${f} was filed under a STALE key for ${entry.repoPath} (its canonical key resolution changed) — migrating to ${freshHash}.json so a future clear can find it.`);
          entry = { ...entry, resolvedKey: currentKey };
          // @decision a6fa60e2 — strip any dangling `f` reference up front: it's about to be collected
          // for a LATER delete/fold, and a persisted/armed entry still naming it would falsely "protect"
          // a future, unrelated file that happens to reuse this name.
          if (entry.orphanLatchFiles?.includes(f)) {
            entry = { ...entry, orphanLatchFiles: entry.orphanLatchFiles.filter((name) => name !== f) };
          }
          // @decision 4480b077 (round 2) — DEFER the write: collect this source under its own target key
          // for the single post-loop write pass below, instead of writing here mid-loop where a
          // not-yet-read sibling's own file (or a degraded entry's own backing file) could be clobbered.
          const migratedList = migratedSourcesByKey.get(currentKey) ?? [];
          migratedList.push(f);
          migratedSourcesByKey.set(currentKey, migratedList);
          originalEntryBySource.set(f, entry);
        } else {
          // entry.resolvedKey is guaranteed set here (the no-resolvedKey+unresolvable case is handled, and
          // `continue`d past, above).
          //
          // @decision 883e29bc — never arm at the degraded walked-up `currentKey` directly, only at
          // resolvedKey; divert the degraded key's signal to pendingUnresolvedQuarantines instead.
          // eslint-disable-next-line no-console
          console.warn(`[merge-quarantine] boot-time latch ${f} for ${entry.repoPath} could NOT be verified against its current key — ${entry.repoPath} does not currently resolve on disk (an unmounted drive? a not-yet-synced folder?) — leaving the latch file AS WRITTEN rather than risk migrating/deleting it on an unreliable reading; arming enforcement under its recorded original key and deferring the degraded, walked-up key to a lazy re-resolve on first query.`);
          armQuarantineKey(byRepoKey, entry.resolvedKey!, entry);
          // @decision 4480b077 (round 2) — this entry's own backing file physically lives at
          // sha(resolvedKey); record it so no write pass below ever writes there.
          degradedOccupiedKeys.add(entry.resolvedKey!);
          if (currentKey !== entry.resolvedKey) {
            degradedDivertsToFlush.push({ resolvedKey: entry.resolvedKey!, sourceFile: f });
          }
          continue;
        }
      }
      // Thread the return value through both arms — armQuarantineKey folds `key` into the result's
      // `armedKeys`, so the SECOND call must build on the FIRST's output, not the original `entry`, or the
      // first key's own slot ends up missing the second key from its armedKeys (see PASS 1/1b "Do not" in
      // docs/decisions/54054c01-clear-lifts-every-key-an-entry-was-armed-under.md, round 2 finding 2).
      let armedEntry = armQuarantineKey(byRepoKey, currentKey, entry);
      if (entry.resolvedKey && entry.resolvedKey !== currentKey) {
        armedEntry = armQuarantineKey(byRepoKey, entry.resolvedKey, armedEntry);
        byRepoKey.set(currentKey, armedEntry);
      }
    } catch (e) {
      // BLOCKER 2 fix: an unparsable/corrupt latch must never fail OPEN (a 0-byte file at boot used to
      // re-arm nothing at all).
      const matchedRepo = hashToRepo.get(hash);
      const claimants = matchedRepo ? undefined : unresolvedClaimantsByHash.get(hash);
      if (matchedRepo) {
        // @decision 882d6cff (folds in ed74603b) — DEFER: never arm/write this inline, mid-loop (a
        // not-yet-read sibling's own file, or the union this repo deserves, would be clobbered/skipped).
        // eslint-disable-next-line no-console
        console.error(`[merge-quarantine] boot-time latch ${f} is CORRUPT/unparsable (${(e as Error).message}) but its filename hash matches registered repo ${matchedRepo} — deferring fail-closed handling until every file this boot has been read.`);
        deferredCorruptJsons.push({ f, matchedRepo });
      } else if (claimants && claimants.length > 0) {
        // @decision 882d6cff (round 3) — MULTIPLE unresolvable paths can share this degraded hash;
        // divert one deferred entry PER claimant, never just one "winner". See the decision record.
        // eslint-disable-next-line no-console
        console.error(`[merge-quarantine] boot-time latch ${f} is CORRUPT/unparsable (${(e as Error).message}) but its filename hash matches ${claimants.length} unresolvable registered repo(s) sharing this degraded key (${claimants.join(", ")}) — deferring fail-closed handling for EACH of them until every file this boot has been read.`);
        for (const claimant of claimants) deferredCorruptJsons.push({ f, matchedRepo: claimant });
      } else if ((ancestorHashToRepo().get(hash)?.length ?? 0) > 0) {
        // @decision f5c42043 — an ANCESTOR-walk-only match is never proof of ownership: divert to
        // pending for EACH claimant, never arm/write at this hash for any of them.
        const ancestorClaimants = ancestorHashToRepo().get(hash)!;
        // eslint-disable-next-line no-console
        console.error(`[merge-quarantine] boot-time latch ${f} is CORRUPT/unparsable (${(e as Error).message}) but its filename hash matches ${ancestorClaimants.length} registered repo(s)' own ANCESTOR-walk key, never their own verified identity (${ancestorClaimants.join(", ")}) — deferring fail-closed handling for EACH of them until every file this boot has been read.`);
        for (const claimant of ancestorClaimants) deferredAncestorCorruptJsons.push({ f, matchedRepo: claimant });
      } else {
        // No registered repo matches this corrupt latch's hash — collect it; handled in PASS 2, AFTER
        // every file has been read, so a later file's own valid entry is never clobbered (round 7 cheap-minor).
        orphanFilenames.push(f);
        orphanReasonParts.push(`${f}: ${(e as Error).message}`);
      }
    }
  }
  flushDegradedDiverts(); // PASS 1's own degraded diverts, now that byRepoKey holds its FINAL values.

  // Resolve every deferred matched-corrupt `.json` now that every real file this boot has been read.
  // @decision 882d6cff (folds in ed74603b) — gate on resolvability; never write/arm at a degraded,
  // walked-up key. See the decision record for the RESOLVABLE/UNRESOLVABLE split and why.
  for (const { f, matchedRepo } of deferredCorruptJsons) {
    if (!isRepoPathCurrentlyResolvable(matchedRepo)) {
      // eslint-disable-next-line no-console
      console.warn(`[merge-quarantine] boot-time latch ${f} is CORRUPT/unparsable and its filename hash matches registered repo ${matchedRepo}, but ${matchedRepo} does not currently resolve on disk — leaving the corrupt latch file AS WRITTEN rather than risk writing/arming it under a degraded, walked-up key; deferring to a lazy re-resolve on first query.`);
      const entry: MergeQuarantineEntry = {
        repoPath: matchedRepo, branch: PLACEHOLDER_BRANCH_CORRUPT,
        reason: `boot found a CORRUPT/unparsable quarantine latch (${f}) matching this repo's hash, while ${matchedRepo} did not currently resolve — fail-closed rather than risk discarding a real quarantine, but not armed under any walked-up key`,
        enteredAt: Date.now(), tokens: [randomUUID()], placeholder: true,
      };
      pendingUnresolvedQuarantines.push({ entry, sourceFile: f });
      continue;
    }
    const key = canonicalRepoLockKey(matchedRepo);
    const entry: MergeQuarantineEntry = {
      repoPath: matchedRepo, branch: PLACEHOLDER_BRANCH_CORRUPT,
      reason: `boot found a CORRUPT/unparsable quarantine latch (${f}) matching this repo's hash — fail-closed rather than risk discarding a real quarantine`,
      enteredAt: Date.now(), tokens: [randomUUID()], placeholder: true,
    };
    armQuarantineKey(byRepoKey, key, entry);
    const migratedList = migratedSourcesByKey.get(key) ?? [];
    migratedList.push(f);
    migratedSourcesByKey.set(key, migratedList);
    originalEntryBySource.set(f, entry);
  }

  // Resolve every ANCESTOR-TIER deferred corrupt `.json` — ALWAYS a pure pending-divert, regardless of
  // whether matchedRepo is CURRENTLY resolvable (unlike the loop above): an ancestor-walk match is never
  // proof of ownership, so this never self-heals/migrates/writes anywhere. Once matchedRepo is genuinely
  // queried via activeMergeQuarantineFor while resolvable, the EXISTING lazy-graduation path (NOT this
  // loop) arms/migrates it under its own verified key and sweeps this stale source file.
  for (const { f, matchedRepo } of deferredAncestorCorruptJsons) {
    // eslint-disable-next-line no-console
    console.warn(`[merge-quarantine] boot-time latch ${f} is CORRUPT/unparsable and its filename hash matches an ANCESTOR-walk key for registered repo ${matchedRepo} — never a verified identity for ${matchedRepo} itself, so it is NOT armed/written at any key; leaving the corrupt latch file AS WRITTEN and deferring enforcement to a lazy re-resolve on first query.`);
    const entry: MergeQuarantineEntry = {
      repoPath: matchedRepo, branch: PLACEHOLDER_BRANCH_CORRUPT,
      reason: `boot found a CORRUPT/unparsable quarantine latch (${f}) whose hash matches an ancestor-walk key ${matchedRepo}'s own resolution would produce if it (or an intermediate ancestor) were unresolvable — fail-closed rather than risk discarding a real quarantine, but not a verified identity and never armed under any walked-up key`,
      enteredAt: Date.now(), tokens: [randomUUID()], placeholder: true,
    };
    pendingUnresolvedQuarantines.push({ entry, sourceFile: f });
  }

  // PASS 1b (item 5) — recover/repair any leftover `.json.tmp-<pid>` latch. Its filename is
  // `<hash>.json.tmp-<pid>`, so the SAME hash-matching logic as a corrupt `.json` applies once the
  // `.json.tmp-` suffix is stripped.
  //
  // @decision 92c645cc (round 2, items 2b/3) — a key can carry MORE THAN ONE tmp. This loop arms every
  // parseable tmp in-memory but DEFERS the disk write/unlink to a single per-key pass below, so the
  // final's own on-disk content is the FULL union, never "whichever tmp was processed last".
  const tmpsToUnlinkByKey = new Map<string, string[]>();
  const deferredCorruptTmps: { f: string; matchedRepo: string }[] = [];
  // @decision f5c42043 — Site C's own twin of `deferredAncestorCorruptJsons`: resolved by its OWN,
  // simpler loop below that always divert-to-pending, never folds into another key's unlink list.
  const deferredAncestorCorruptTmps: { f: string; matchedRepo: string }[] = [];

  for (const f of tmpFiles) {
    const hash = f.slice(0, f.indexOf(".json.tmp-"));
    const tmpPath = path.join(MERGE_QUARANTINE_DIR, f);
    const matchedRepo = hashToRepo.get(hash);
    // @decision 92c645cc — gate on a CLEAN, NON-PLACEHOLDER PASS-1 parse, never on `byRepoKey.has(...)`
    // alone: a corrupt-but-hash-matched (or legacy field-less) placeholder also lands in `byRepoKey`, and
    // this tmp may be the ONLY surviving durable copy of the real entry in that shape.
    // @decision 5b40376c — ALSO gate on `matchedRepo` being currently resolvable, or an unresolvable
    // repo's own tmp residue gets unlinked outright via an unrelated sibling's degraded-key collision.
    if (matchedRepo && isRepoPathCurrentlyResolvable(matchedRepo) && cleanlyParsedKeys.has(canonicalRepoLockKey(matchedRepo))) {
      // A proper final `.json` for this repo already loaded CLEANLY (and non-placeholder) in PASS 1 —
      // this tmp really is stale residue from an earlier interrupted write; clean it up immediately.
      //
      // @decision 97cff6db — investigated whether a safety-tmp residue landing HERE needs a union
      // rather than a blind delete. It does not; see the decision record for why this stays a delete.
      try { fs.unlinkSync(tmpPath); } catch { /* best-effort — a leftover tmp beside a good final write is harmless */ }
      continue;
    }
    try {
      const raw = fs.readFileSync(tmpPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<MergeQuarantineEntry> & { token?: string };
      if (typeof parsed.repoPath !== "string" || typeof parsed.branch !== "string" || typeof parsed.reason !== "string") {
        throw new Error("tmp latch JSON is missing repoPath/branch/reason");
      }
      const tokens = Array.isArray(parsed.tokens) && parsed.tokens.length > 0 && parsed.tokens.every((t): t is string => typeof t === "string")
        ? parsed.tokens
        : [typeof parsed.token === "string" ? parsed.token : randomUUID()];
      const entry: MergeQuarantineEntry = {
        repoPath: parsed.repoPath, branch: parsed.branch, reason: parsed.reason,
        opId: typeof parsed.opId === "string" ? parsed.opId : undefined,
        enteredAt: typeof parsed.enteredAt === "number" ? parsed.enteredAt : Date.now(),
        tokens,
        orphanLatchFiles: Array.isArray(parsed.orphanLatchFiles) && parsed.orphanLatchFiles.every((s): s is string => typeof s === "string")
          ? parsed.orphanLatchFiles : undefined,
        resolvedKey: typeof parsed.resolvedKey === "string" ? parsed.resolvedKey : undefined,
        placeholder: isPlaceholderEntryShape(parsed) ? true : undefined,
      };
      const currentKey = canonicalRepoLockKey(entry.repoPath);
      // @decision 6237bef6 — mirror PASS 1's own unresolvable/no-resolvedKey gate (card 369b97be): defer
      // to pendingUnresolvedQuarantines here too, rather than arming a tmp-sourced entry under a possibly-
      // degraded key the way the rest of this loop otherwise would.
      if (!isRepoPathCurrentlyResolvable(entry.repoPath) && !entry.resolvedKey) {
        // eslint-disable-next-line no-console
        console.warn(`[merge-quarantine] boot-time tmp latch ${f} for ${entry.repoPath} has no recorded resolvedKey and could NOT be verified against its current key — ${entry.repoPath} does not currently resolve on disk — leaving the tmp file AS WRITTEN and deferring enforcement to a lazy re-resolve on first query.`);
        pendingUnresolvedQuarantines.push({ entry, sourceFile: f });
        continue;
      }
      if (!isRepoPathCurrentlyResolvable(entry.repoPath) && entry.resolvedKey && entry.resolvedKey !== currentKey) {
        // @decision 883e29bc — mirror PASS 1's own fix above: never arm this tmp-sourced entry at its
        // degraded walked-up `currentKey`, only at resolvedKey; divert the degraded signal to pending.
        // eslint-disable-next-line no-console
        console.warn(`[merge-quarantine] boot-time tmp latch ${f} for ${entry.repoPath} could NOT be verified against its current key — ${entry.repoPath} does not currently resolve on disk (an unmounted drive? a not-yet-synced folder?) — leaving the tmp file AS WRITTEN rather than risk promoting/deleting it on an unreliable reading; arming enforcement under its recorded original key and deferring the degraded, walked-up key to a lazy re-resolve on first query.`);
        armQuarantineKey(byRepoKey, entry.resolvedKey, entry);
        // @decision 4480b077 (round 2) — same tracking as PASS 1's own degraded branch, shared across
        // both passes so EITHER one's degraded find protects BOTH write passes below.
        degradedOccupiedKeys.add(entry.resolvedKey);
        degradedDivertsToFlush.push({ resolvedKey: entry.resolvedKey, sourceFile: f });
        continue;
      }
      // See PASS 1's identical threading note above — the second call must build on the first's result.
      const armedTmpEntry = armQuarantineKey(byRepoKey, currentKey, entry);
      if (entry.resolvedKey && entry.resolvedKey !== currentKey) {
        const dualArmed = armQuarantineKey(byRepoKey, entry.resolvedKey, armedTmpEntry);
        byRepoKey.set(currentKey, dualArmed);
      }
      // Collect this tmp for the single per-key write/unlink pass below, grouped by the entry's OWN
      // canonical key — the same key `writeMergeQuarantineLatch` physically writes to.
      const list = tmpsToUnlinkByKey.get(currentKey) ?? [];
      list.push(tmpPath);
      tmpsToUnlinkByKey.set(currentKey, list);
      originalEntryBySource.set(path.basename(tmpPath), entry);
    } catch (e) {
      // Genuinely unreadable/unparsable tmp content (a crash mid-write, before fsync even completed).
      // @decision 92c645cc (round 2, item 2b) — DEFER fail-closed handling: a sibling tmp for the SAME
      // key, read earlier or later in this loop, may carry real data an inline placeholder would clobber.
      // Unmatched joins the orphan sweep below, unaffected.
      if (matchedRepo) {
        // eslint-disable-next-line no-console
        console.error(`[merge-quarantine] boot-time tmp latch ${f} is CORRUPT/unparsable (${(e as Error).message}) but its filename hash matches registered repo ${matchedRepo} — deferring fail-closed handling until every sibling tmp for this repo has been read.`);
        deferredCorruptTmps.push({ f, matchedRepo });
      } else {
        // @decision 882d6cff (round 3) — mirror PASS 1's own fallback: MULTIPLE unresolvable paths can
        // share this exact degraded hash; divert one deferred entry PER claimant, never just one "winner".
        const claimants = unresolvedClaimantsByHash.get(hash);
        if (claimants && claimants.length > 0) {
          // eslint-disable-next-line no-console
          console.error(`[merge-quarantine] boot-time tmp latch ${f} is CORRUPT/unparsable (${(e as Error).message}) but its filename hash matches ${claimants.length} unresolvable registered repo(s) sharing this degraded key (${claimants.join(", ")}) — deferring fail-closed handling for EACH of them until every sibling tmp for this repo has been read.`);
          for (const claimant of claimants) deferredCorruptTmps.push({ f, matchedRepo: claimant });
        } else if ((ancestorHashToRepo().get(hash)?.length ?? 0) > 0) {
          // @decision f5c42043 — Site C's own twin: an ANCESTOR-walk-only match is never proof of
          // ownership; divert to pending for EACH claimant, never fold into another key's unlink list.
          const ancestorClaimants = ancestorHashToRepo().get(hash)!;
          // eslint-disable-next-line no-console
          console.error(`[merge-quarantine] boot-time tmp latch ${f} is CORRUPT/unparsable (${(e as Error).message}) but its filename hash matches ${ancestorClaimants.length} registered repo(s)' own ANCESTOR-walk key, never their own verified identity (${ancestorClaimants.join(", ")}) — deferring fail-closed handling for EACH of them until every sibling tmp for this repo has been read.`);
          for (const claimant of ancestorClaimants) deferredAncestorCorruptTmps.push({ f, matchedRepo: claimant });
        } else {
          orphanFilenames.push(f);
          orphanReasonParts.push(`${f}: ${(e as Error).message}`);
        }
      }
    }
  }
  // Declared here (rather than beside their own first USE further below) because the safety-tmp
  // recovery loop immediately below, and the Phase-0 at-risk computation after it, both populate them.
  const writeOutcomesByKey = new Map<string, { unionEntry: MergeQuarantineEntry; succeeded: boolean }>();
  const safetyTmpPathByKey = new Map<string, string>();
  const safetyTmpRecoveryByFile = new Map<string, string>();
  // @decision 97cff6db (round 2) — every write-target basename this boot must NOT write to, because
  // securing SOME other key's only copy of that exact filename failed. Consulted by every later write
  // site (the deferred-corrupt-tmp placeholder, phase 1a/2, PASS 2) before it writes anywhere.
  const blockedWriteTargets = new Set<string>();

  // @decision 97cff6db (round 4, minor 1) — recover safety-tmp residue BEFORE flushDegradedDiverts()
  // runs below, never after — PASS 1/1b's own degraded diverts are already fully populated by this
  // point, so byRepoKey holds its POST-recovery-union value by the time that snapshot is taken.
  //
  // @decision 97cff6db (round 2) — recover any SAFETY-TMP residue from a previous boot FIRST, arming it
  // into byRepoKey at its own key. The actual recovery WRITE (always a union) happens once, at the end.
  for (const f of safetyTmpFiles) {
    const tmpPath = path.join(MERGE_QUARANTINE_DIR, f);
    try {
      const raw = fs.readFileSync(tmpPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<MergeQuarantineEntry> & { token?: string };
      if (typeof parsed.repoPath !== "string" || typeof parsed.branch !== "string" || typeof parsed.reason !== "string") {
        throw new Error("safety-tmp latch JSON is missing repoPath/branch/reason");
      }
      const tokens = Array.isArray(parsed.tokens) && parsed.tokens.length > 0 && parsed.tokens.every((t): t is string => typeof t === "string")
        ? parsed.tokens
        : [typeof parsed.token === "string" ? parsed.token : randomUUID()];
      let entry: MergeQuarantineEntry = {
        repoPath: parsed.repoPath, branch: parsed.branch, reason: parsed.reason,
        opId: typeof parsed.opId === "string" ? parsed.opId : undefined,
        enteredAt: typeof parsed.enteredAt === "number" ? parsed.enteredAt : Date.now(),
        tokens,
        orphanLatchFiles: Array.isArray(parsed.orphanLatchFiles) && parsed.orphanLatchFiles.every((s): s is string => typeof s === "string")
          ? parsed.orphanLatchFiles : undefined,
        resolvedKey: typeof parsed.resolvedKey === "string" ? parsed.resolvedKey : undefined,
      };
      // @decision fd189d91 — strip `f` here up front, or a plain graduation keeps a dangling reference
      // to this soon-deleted tmp forever (mirrors a6fa60e2/be79f4d5); re-added below where still needed.
      if (entry.orphanLatchFiles?.includes(f)) {
        entry = { ...entry, orphanLatchFiles: entry.orphanLatchFiles.filter((name) => name !== f) };
      }
      if (!isRepoPathCurrentlyResolvable(entry.repoPath)) {
        // eslint-disable-next-line no-console
        console.warn(`[merge-quarantine] boot-time SAFETY-TMP residue ${f} for ${entry.repoPath} could NOT be verified against its current key — leaving it AS WRITTEN and deferring to a lazy re-resolve on first query.`);
        // @decision ef651188 (round 2, CRITICAL 1) — self-reference `f` here too, at READ time: do not
        // trust that every safety-tmp's own bytes already carry it (an older tmp written before this fix,
        // or another call site's write that never bakes one in) — this is the generic backstop.
        pendingUnresolvedQuarantines.push({
          entry: { ...entry, orphanLatchFiles: [...new Set([...(entry.orphanLatchFiles ?? []), f])] },
          sourceFile: f,
        });
        continue;
      }
      const currentKey = canonicalRepoLockKey(entry.repoPath);
      const armedSafety = armQuarantineKey(byRepoKey, currentKey, entry);
      if (entry.resolvedKey && entry.resolvedKey !== currentKey) {
        const dualArmed = armQuarantineKey(byRepoKey, entry.resolvedKey, armedSafety);
        byRepoKey.set(currentKey, dualArmed);
      }
      safetyTmpRecoveryByFile.set(f, currentKey);
      // @decision 97cff6db (round 3, finding E) — when degraded-occupied, give this source its OWN
      // pending reference, self-referencing `f`: a clear of the occupant removes the shared union from
      // `activeQuarantines` BEFORE its own sweep runs, so only a surviving reference keeps this safety-tmp.
      if (degradedOccupiedKeys.has(currentKey)) {
        pendingUnresolvedQuarantines.push({
          entry: { ...entry, orphanLatchFiles: [...new Set([...(entry.orphanLatchFiles ?? []), f])] },
          sourceFile: f,
        });
      }
    } catch (e) {
      // A corrupt safety-tmp should never normally happen (we write it ourselves) — leave it AS WRITTEN
      // rather than guess at its content; a human can investigate, same posture as any other unreadable
      // residue in this file.
      // eslint-disable-next-line no-console
      console.error(`[merge-quarantine] boot-time SAFETY-TMP residue ${f} is CORRUPT/unreadable (${(e as Error).message}) — leaving it AS WRITTEN; this is unexpected since Loom writes these itself.`);
      // @decision 97cff6db (round 3 minor 3; round 4 minor 2) — mirror deferredCorruptJsons'/
      // deferredCorruptTmps' FULL fallback cascade (hashToRepo, unresolvedClaimantsByHash,
      // ancestorHashToRepo, then orphanFilenames), not just the first tier.
      const hash = f.slice(0, f.indexOf(".json.tmp-safety-"));
      const pushPlaceholder = (matchedRepo: string) => {
        const placeholder: MergeQuarantineEntry = {
          repoPath: matchedRepo, branch: PLACEHOLDER_BRANCH_CORRUPT,
          reason: `boot found a CORRUPT/unreadable SAFETY-TMP residue (${f}) matching this repo's hash — fail-closed rather than risk discarding a real quarantine`,
          enteredAt: Date.now(), tokens: [randomUUID()], placeholder: true,
        };
        pendingUnresolvedQuarantines.push({ entry: placeholder, sourceFile: f });
      };
      const matchedRepo = hashToRepo.get(hash);
      const claimants = matchedRepo ? undefined : unresolvedClaimantsByHash.get(hash);
      if (matchedRepo) {
        pushPlaceholder(matchedRepo);
      } else if (claimants && claimants.length > 0) {
        for (const claimant of claimants) pushPlaceholder(claimant);
      } else if ((ancestorHashToRepo().get(hash)?.length ?? 0) > 0) {
        for (const claimant of ancestorHashToRepo().get(hash)!) pushPlaceholder(claimant);
      } else {
        // No registered repo matches this corrupt safety-tmp's hash at any tier — join the ordinary
        // orphan sweep so PASS 2 gives every registered repo a reference, enabling a human clear route.
        orphanFilenames.push(f);
        orphanReasonParts.push(`${f}: ${(e as Error).message}`);
      }
    }
  }
  flushDegradedDiverts(); // now that byRepoKey holds the POST-safety-tmp-recovery-union value too.

  // @decision 97cff6db (round 2, Lead ruling 1) — ONE phase, BEFORE ANY boot write below, computing the
  // COMPLETE set of paths this ENTIRE boot will write to, then securing every at-risk source first. See
  // the decision record for why (CRITICAL 1's ordering hazard) and what this set must include.
  // @decision 97cff6db (round 5) — register via quarantinePathForKey(key), never quarantinePathFor
  // (e.repoPath), which can recompute a DIFFERENT path than `key`'s own target — see the decision record.
  const allBootWriteTargets = new Set<string>();
  for (const [key] of migratedSourcesByKey) {
    if (degradedOccupiedKeys.has(key)) continue;
    const e = byRepoKey.get(key);
    if (e) allBootWriteTargets.add(path.basename(quarantinePathForKey(key)));
  }
  for (const [key] of tmpsToUnlinkByKey) {
    if (degradedOccupiedKeys.has(key)) continue;
    const e = byRepoKey.get(key);
    if (e && isRepoPathCurrentlyResolvable(e.repoPath)) allBootWriteTargets.add(path.basename(quarantinePathForKey(key)));
  }
  // @decision 97cff6db (round 2, CRITICAL 2) — the deferred-corrupt-tmp "no real sibling data" placeholder
  // write (below) and PASS 2's own orphan-reference writes (at the end of this function) are BOTH ungated
  // boot writes this set must also cover — over-inclusion here (counting a target that ends up taking a
  // no-write branch) is harmless; under-inclusion is the actual hazard (scenarios B and C).
  for (const { matchedRepo } of deferredCorruptTmps) {
    if (isRepoPathCurrentlyResolvable(matchedRepo)) allBootWriteTargets.add(path.basename(quarantinePathFor(matchedRepo)));
  }
  if (orphanFilenames.length > 0) {
    for (const repoPath of registeredRepoPaths) {
      if (isRepoPathCurrentlyResolvable(repoPath)) allBootWriteTargets.add(path.basename(quarantinePathFor(repoPath)));
    }
  }
  // @decision 97cff6db (round 3, finding F) — the end-of-boot safety-tmp recovery write (below) is
  // itself a boot write site this set must cover too, or a colliding migrate source never gets secured.
  for (const [, key] of safetyTmpRecoveryByFile) {
    const e = byRepoKey.get(key);
    if (e && isRepoPathCurrentlyResolvable(e.repoPath)) allBootWriteTargets.add(path.basename(quarantinePathForKey(key)));
  }
  // @decision 97cff6db (round 3, finding E) — a degraded-occupied migrate source is at-risk too; secure
  // the SOURCES' own union (never `byRepoKey.get(key)`, which can carry the occupant's unresolvable
  // `repoPath` as its winning identity) so the safety-tmp's own content stays resolvable.
  const sourcesOnlyUnion = (sources: string[]): MergeQuarantineEntry | undefined => {
    let acc: MergeQuarantineEntry | undefined;
    for (const f of sources) {
      const e = originalEntryBySource.get(f);
      if (!e) continue;
      acc = acc ? unionQuarantineEntries(acc, e) : e;
    }
    return acc;
  };
  for (const [key, sources] of migratedSourcesByKey) {
    const degraded = degradedOccupiedKeys.has(key);
    const unionEntry = byRepoKey.get(key);
    if (!unionEntry) continue;
    const ownTarget = path.basename(quarantinePathForKey(key));
    const collidingSources = sources.filter((f) => f !== ownTarget && allBootWriteTargets.has(f));
    if (collidingSources.length === 0) continue;
    const safetyContent = degraded ? sourcesOnlyUnion(sources) : unionEntry;
    if (!safetyContent) continue; // defensive — every source here came from originalEntryBySource
    const safetyTmpPath = writeSafetyTmpResidue(key, safetyContent);
    if (safetyTmpPath) {
      safetyTmpPathByKey.set(key, safetyTmpPath);
      continue;
    }
    // eslint-disable-next-line no-console
    console.error(`[merge-quarantine] could not even durably SECURE ${safetyContent.repoPath}'s migrated latch (${sources.length} source(s): ${sources.join(", ")}) before any of this boot's writes run — its real write will be skipped entirely this pass. The old source file(s) are left exactly as written; a later boot can retry.`);
    // @decision 97cff6db (round 3) — never mark a DEGRADED key's own outcome: phase 1a already skips it
    // unconditionally (its own `degradedOccupiedKeys` check), and phase 3's delete pass is not shaped for
    // a degraded key's own write-target derivation (the union's `repoPath` is the occupant's, not `key`'s).
    if (!degraded) writeOutcomesByKey.set(key, { unionEntry, succeeded: false });
    // @decision 97cff6db (round 2) — the safety write itself failing means a colliding sibling write
    // must not be allowed to proceed either, or the only source is destroyed anyway (scenario B).
    for (const f of collidingSources) blockedWriteTargets.add(f);
  }
  // @decision ef651188 (round 2, MAJOR) — exclude a degraded-occupied key's own write target from the
  // at-risk set below: bootWriteLatch's degradedOccupiedKeys refusal is unconditional, so it is never
  // actually written this boot. See the decision record.
  const degradedWriteTargetBasenames = new Set<string>();
  for (const key of degradedOccupiedKeys) degradedWriteTargetBasenames.add(path.basename(quarantinePathForKey(key)));
  // @decision ef651188 — a PENDING entry's sourceFile never went through the loop above (it has no
  // byRepoKey entry) but CAN physically be some OTHER key's write target too. See the decision record.
  pendingUnresolvedQuarantines = pendingUnresolvedQuarantines.map((p) => {
    if (!allBootWriteTargets.has(p.sourceFile) || degradedWriteTargetBasenames.has(p.sourceFile)) return p;
    // A genuinely pending entry has no verified key at all (that's why it's pending) — secure it at
    // the hash ALREADY embedded in its own at-risk filename, never a recomputed/trusted key.
    const hash = p.sourceFile.slice(0, -".json".length);
    // @decision ef651188 (round 2, CRITICAL 1) — selfReference:true bakes the self-reference into the
    // tmp's OWN persisted bytes, so a later boot's recovery read carries it from disk alone.
    const safetyTmpPath = writeSafetyTmpResidueAtHash(hash, p.entry, true);
    if (!safetyTmpPath) {
      // eslint-disable-next-line no-console
      console.error(`[merge-quarantine] could not even durably SECURE a PENDING (unresolvable) quarantine's own latch (${p.sourceFile}, for ${p.entry.repoPath}) before a boot write targeting the same filename runs — blocking that colliding write instead; the old source file is left exactly as written, and a later boot can retry.`);
      blockedWriteTargets.add(p.sourceFile);
      return p;
    }
    // @decision ef651188 — mirrors round 4/5's G1/G1a fix: re-point at the safety-tmp's own unique
    // name AND self-reference it in orphanLatchFiles, or a later clear can sweep it (sees it unowned).
    const protectiveSourceFile = path.basename(safetyTmpPath);
    const newEntry = { ...p.entry, orphanLatchFiles: [...new Set([...(p.entry.orphanLatchFiles ?? []), protectiveSourceFile])] };
    // @decision fd189d91 (item d) — a degraded-divert's own pending entry can be reference-equal to
    // byRepoKey's own occupant; replacing `.entry` here without this call orphans that reference.
    replaceEntryEverywhere(byRepoKey, p.entry, newEntry);
    return { entry: newEntry, sourceFile: protectiveSourceFile };
  });
  fsyncQuarantineDir(); // every safety-tmp above is now durable; safe to let any write below proceed.

  // @decision ef651188 — the test-only injection point itself: deliberately AFTER Phase 0's own
  // protection has already run, so an injected entry here is exactly as unprotected as a hypothetical
  // future push site that forgot to route through Phase 0 — see the decision record.
  if (testOnlyInjectUnprotectedPending) pendingUnresolvedQuarantines.push(...testOnlyInjectUnprotectedPending);

  // @decision 97cff6db (round 3, minor 4) — declared HERE, before the deferred-corrupt-tmp placeholder
  // write below, so that write-site's own success is also tracked: phase 3 must never delete a migrate
  // source that physically shares a filename with THIS freshly-written placeholder.
  const writeTargetsThisPass = new Set<string>();

  /**
   * @decision 97cff6db (round 4) — THE ONE chokepoint: every write of a latch FINAL in this function
   * goes through this, never a bare `writeMergeQuarantineLatch` call. See the decision record for the
   * four refusal conditions and why a placeholder is exempt from the resolvability one.
   */
  const bootWriteLatch = (targetKey: string, entry: MergeQuarantineEntry): boolean => {
    const targetBasename = path.basename(quarantinePathForKey(targetKey));
    if (!allBootWriteTargets.has(targetBasename)) {
      // eslint-disable-next-line no-console
      console.error(`[merge-quarantine] refusing an UNANTICIPATED boot write to ${targetBasename} for ${entry.repoPath} — its target was never registered in allBootWriteTargets (a bug in the at-risk computation, not a legitimate write); ${entry.repoPath} stays enforced in-memory only for this process.`);
      return false;
    }
    if (blockedWriteTargets.has(targetBasename)) {
      // eslint-disable-next-line no-console
      console.error(`[merge-quarantine] refusing to write ${targetBasename} for ${entry.repoPath} — a DIFFERENT key's only copy of this exact filename could not be secured this boot; ${entry.repoPath} stays enforced in-memory only for this process.`);
      return false;
    }
    // @decision ef651188 (round 2, nit 4) — check degradedOccupiedKeys BEFORE the pending backstop below:
    // a degraded-occupied target's own pending reference legitimately keeps this basename (excluded from
    // Phase 0's protection above), so a refusal here must log the real, more specific reason.
    if (degradedOccupiedKeys.has(targetKey)) {
      // eslint-disable-next-line no-console
      console.error(`[merge-quarantine] refusing to write ${targetBasename} for ${entry.repoPath} — this key is occupied by a DIFFERENT, currently-unresolvable entry's own trusted resolvedKey; overwriting it would destroy that entry's only backing file. ${entry.repoPath} stays enforced in-memory only for this process.`);
      return false;
    }
    // @decision ef651188 — STRUCTURAL BACKSTOP, not the primary protection: the Phase 0 loop above
    // already re-points every at-risk pending entry off this exact filename, so this should never fire
    // post-fix. It exists so a FUTURE push site can't silently reopen the gap this card closes.
    if (pendingUnresolvedQuarantines.some((p) => p.sourceFile === targetBasename)) {
      // eslint-disable-next-line no-console
      console.error(`[merge-quarantine] refusing an UNPROTECTED boot write to ${targetBasename} for ${entry.repoPath} — a PENDING (unresolvable) entry's own sourceFile is STILL this exact filename (Phase 0's pending-protection should have already moved it off — this is the backstop, not the primary fix; see the decision record); ${entry.repoPath} stays enforced in-memory only for this process.`);
      return false;
    }
    if (!entry.placeholder && !isRepoPathCurrentlyResolvable(entry.repoPath)) {
      // eslint-disable-next-line no-console
      console.warn(`[merge-quarantine] refusing to write ${targetBasename} for ${entry.repoPath} — its path does not currently resolve on disk; leaving it as-is rather than durably commit an unverifiable identity to a final.`);
      return false;
    }
    // @decision 97cff6db (round 4) — `targetKey` steers the WRITE PATH only; it never mutates
    // `entry.resolvedKey`. Stamping it here unconditionally regressed PASS 2's own fail-closed
    // placeholder (caught by clear-by-path.mjs's (P)/(P2)) — see the decision record.
    //
    // @decision e1cb7d33 — one of TWO opt-out families (the other: enterMergeQuarantine's 4 write
    // sites). Phase 0's safety-tmp above already secures any at-risk degraded occupant's content before
    // this write runs. See the decision record.
    const ok = writeMergeQuarantineLatch(entry, false, targetKey, true);
    if (ok) writeTargetsThisPass.add(targetBasename);
    return ok;
  };

  // Resolve every deferred corrupt tmp now that every real tmp this boot has already been armed.
  // @decision 92c645cc (round 2, item 2b) — a corrupt tmp's matched repo may ALREADY carry real
  // (non-placeholder) data from a sibling tmp read earlier OR later in the loop above; order must never
  // decide whether that real data survives, or whether the corrupt tmp's own placeholder gets written.
  for (const { f, matchedRepo } of deferredCorruptTmps) {
    const tmpPath = path.join(MERGE_QUARANTINE_DIR, f);
    // @decision 882d6cff — never recompute/arm at a degraded walked-up key here; keep the tmp untouched
    // and divert to pending instead. See the decision record for the repro.
    if (!isRepoPathCurrentlyResolvable(matchedRepo)) {
      // eslint-disable-next-line no-console
      console.warn(`[merge-quarantine] boot-time tmp latch ${f} is CORRUPT/unparsable and its filename hash matches registered repo ${matchedRepo}, but ${matchedRepo} does not currently resolve on disk — keeping the tmp AS WRITTEN rather than risk folding it into a different, degraded key's own unlink list; deferring to a lazy re-resolve on first query.`);
      const entry: MergeQuarantineEntry = {
        repoPath: matchedRepo, branch: PLACEHOLDER_BRANCH_CORRUPT,
        reason: `boot found a CORRUPT/unparsable torn-write quarantine latch (${f}) matching this repo's hash, while ${matchedRepo} did not currently resolve — fail-closed rather than risk discarding a real quarantine, but not armed under any walked-up key`,
        enteredAt: Date.now(), tokens: [randomUUID()], placeholder: true,
      };
      pendingUnresolvedQuarantines.push({ entry, sourceFile: f });
      continue;
    }
    const key = canonicalRepoLockKey(matchedRepo);
    const existing = byRepoKey.get(key);
    if (existing && !isPlaceholderEntryShape(existing)) {
      // Real data already covers this key — the corrupt tmp carries nothing recoverable and is not a
      // fail-closed risk. Fold it into the SAME unlink list so it's swept once that key's real union
      // write (below) durably succeeds — bde5d1fe's rule (a sweep follows a superseding write, never
      // precedes or replaces one) — rather than left behind as permanent, unexplained residue.
      const list = tmpsToUnlinkByKey.get(key) ?? [];
      list.push(tmpPath);
      tmpsToUnlinkByKey.set(key, list);
      continue;
    }
    const entry: MergeQuarantineEntry = {
      repoPath: matchedRepo, branch: PLACEHOLDER_BRANCH_CORRUPT,
      reason: `boot found a CORRUPT/unparsable torn-write quarantine latch (${f}) matching this repo's hash, with no real sibling data — fail-closed rather than risk discarding a real quarantine`,
      enteredAt: Date.now(), tokens: [randomUUID()], placeholder: true,
    };
    const armed = armQuarantineKey(byRepoKey, key, entry);
    byRepoKey.set(key, armed);
    // eslint-disable-next-line no-console
    console.error(`[merge-quarantine] boot-time tmp latch ${f} is CORRUPT/unparsable with no real sibling data recovered for registered repo ${matchedRepo} — quarantining THAT repo rather than risk discarding a real quarantine (bootWriteLatch may still refuse — see its own log line above/below for why).`);
    if (!bootWriteLatch(key, armed)) {
      // eslint-disable-next-line no-console
      console.error(`[merge-quarantine] fail-closed quarantine for ${matchedRepo} (matched-corrupt tmp latch ${f}) could NOT be durably persisted this boot — it will NOT survive another restart until this is fixed.`);
    }
  }

  // Resolve every ANCESTOR-TIER deferred corrupt tmp — Site C's own twin of the `.json` loop above:
  // ALWAYS a pure pending-divert, never folded into another key's unlink list (an ancestor-walk match is
  // never proof of ownership). The tmp is left untouched; a later genuine query graduates it normally.
  for (const { f, matchedRepo } of deferredAncestorCorruptTmps) {
    // eslint-disable-next-line no-console
    console.warn(`[merge-quarantine] boot-time tmp latch ${f} is CORRUPT/unparsable and its filename hash matches an ANCESTOR-walk key for registered repo ${matchedRepo} — never a verified identity for ${matchedRepo} itself; keeping the tmp AS WRITTEN and deferring enforcement to a lazy re-resolve on first query.`);
    const entry: MergeQuarantineEntry = {
      repoPath: matchedRepo, branch: PLACEHOLDER_BRANCH_CORRUPT,
      reason: `boot found a CORRUPT/unparsable torn-write quarantine latch (${f}) whose hash matches an ancestor-walk key ${matchedRepo}'s own resolution would produce — fail-closed rather than risk discarding a real quarantine, but not a verified identity and never armed under any walked-up key`,
      enteredAt: Date.now(), tokens: [randomUUID()], placeholder: true,
    };
    pendingUnresolvedQuarantines.push({ entry, sourceFile: f });
  }

  // @decision 4480b077 (round 3) — WRITE-ALL then DELETE-ALL, never interleaved per key: a stale migrate
  // SOURCE for one key can physically be a DIFFERENT key's own write TARGET (`writeTargetsThisPass`
  // itself is now declared earlier, above the deferred-corrupt-tmp loop — round 3, minor 4).

  // PHASE 1a — migrate-pass WRITES. Every at-risk key's safety-tmp was ALREADY written (and fsync'd,
  // and the directory fsync'd) by the dedicated phase above, BEFORE this loop (or any other write in
  // this function) could run — this loop only attempts the real write and cleans up on success.
  // Degraded-occupied keys are folded, never written, in phase 1b below.
  for (const [key, sources] of migratedSourcesByKey) {
    if (degradedOccupiedKeys.has(key)) continue; // handled in phase 1b below
    if (writeOutcomesByKey.has(key)) continue; // already marked failed above (its own safety-tmp write failed)
    const unionEntry = byRepoKey.get(key);
    if (!unionEntry) continue; // defensive — every key here was armed into byRepoKey above
    const succeeded = bootWriteLatch(key, unionEntry);
    writeOutcomesByKey.set(key, { unionEntry, succeeded });
    if (succeeded) {
      const safetyTmpPath = safetyTmpPathByKey.get(key);
      if (safetyTmpPath) {
        try { fs.unlinkSync(safetyTmpPath); } catch { /* best-effort — a leftover safety tmp beside a good final write is harmless; the recovery pass unions+cleans it up next boot otherwise */ }
        safetyTmpPathByKey.delete(key);
      }
    }
  }

  // PHASE 1b — migrate-pass DEGRADED-OCCUPIED fold (never written). Mirrors 4480b077's own shape, plus
  // card 97cff6db's own addition: each migrating source now ALSO gets its own pendingUnresolvedQuarantines
  // entry, independent of the degraded occupant's own divert.
  for (const [key, sources] of migratedSourcesByKey) {
    if (!degradedOccupiedKeys.has(key)) continue; // handled in phase 1a above
    // @decision 4480b077 (round 3) — fold every migrating source into the shared in-memory union's
    // own orphanLatchFiles (no disk write) so a human's ordinary clear sweeps them too — else a
    // cleared repo's own stale source survives untouched and resurrects its quarantine later.
    const occupant = byRepoKey.get(key);
    if (occupant) {
      const folded: MergeQuarantineEntry = { ...occupant, orphanLatchFiles: [...new Set([...(occupant.orphanLatchFiles ?? []), ...sources])] };
      // @decision 97cff6db (finding 1b + Minor 2) / fd189d91 — ONE call re-points BOTH byRepoKey (every
      // key `occupant` was armed under) AND any earlier pending divert of this same object, never two
      // separate hand-rolled loops. See the decision record for the double-report repros this closes.
      replaceEntryEverywhere(byRepoKey, occupant, folded);
      // @decision 97cff6db (round 4, G1) — if Phase 0 secured this key's sources in a safety-tmp (a
      // collision with a sibling's own write target this pass), protect THAT uniquely-named residue
      // instead of each raw sourceFile, which can be exactly that sibling's own already-overwritten target.
      const safetyTmpPath = safetyTmpPathByKey.get(key);
      if (safetyTmpPath) {
        const protectiveSourceFile = path.basename(safetyTmpPath);
        if (!pendingUnresolvedQuarantines.some((p) => p.sourceFile === protectiveSourceFile)) {
          // @decision 97cff6db (round 5) — self-reference protectiveSourceFile in the pushed entry's own
          // orphanLatchFiles too, mirroring L1896's recovery-loop self-reference — a bare pending
          // reference's sourceFile alone is NOT enough; see the decision record's round-5 repro.
          const protectiveEntry = sourcesOnlyUnion(sources) ?? folded;
          pendingUnresolvedQuarantines.push({
            entry: { ...protectiveEntry, orphanLatchFiles: [...new Set([...(protectiveEntry.orphanLatchFiles ?? []), protectiveSourceFile])] },
            sourceFile: protectiveSourceFile,
          });
        }
      } else {
        // No collision this pass — every raw source is still exclusively this key's own stale data;
        // protect each directly (round 1/round 3's own fix, unchanged for the non-colliding case).
        for (const sourceFile of sources) {
          if (!pendingUnresolvedQuarantines.some((p) => p.sourceFile === sourceFile)) {
            // @decision 97cff6db — the ORIGINAL, standalone entry (never `folded`): `folded`'s own
            // `repoPath` is whichever side's union happened to win, so a clear of THAT side would match
            // and sweep this reference away too — see the decision record for the exact repro this avoids.
            pendingUnresolvedQuarantines.push({ entry: originalEntryBySource.get(sourceFile) ?? folded, sourceFile });
          }
        }
      }
    }
    // eslint-disable-next-line no-console
    console.warn(`[merge-quarantine] boot found ${sources.length} migrating latch(es) (${sources.join(", ")}) resolving to a key that is ALSO occupied by a DIFFERENT, currently-unresolvable entry's own trusted resolvedKey — refusing to write/overwrite that entry's own backing file. Every migrating source is folded into the shared union's own orphanLatchFiles AND given its own pending reference (never deleted, never written) so a human's ordinary clear of EITHER side sweeps/protects correctly; both sides stay enforced in-memory until the collision resolves itself (the degraded entry remounts) or a human clears the shared union.`);
  }

  // PHASE 2 — PASS 1b's own tmp-promotion WRITES, sharing writeTargetsThisPass with phase 1a above (card
  // 97cff6db finding 1a: this write used to consult neither writeTargetsThisPass NOR migratedSourcesByKey
  // at all, so it could silently clobber a migrate source some OTHER key still needed). Runs BEFORE
  // either pass's own DELETE step (phase 3 below), so both passes' writes are fully known before either
  // decides what is safe to delete.
  for (const [key, tmps] of tmpsToUnlinkByKey) {
    // @decision 4480b077 (round 2) — same guard as the migrate pass above: never write/overwrite a key a
    // degraded entry's own trusted resolvedKey occupies.
    if (degradedOccupiedKeys.has(key)) {
      // @decision 97cff6db — same pending-reference protection as phase 1b's own degraded-occupied fold,
      // and the SAME reason it must be each tmp's own standalone entry, never the shared occupant.
      const occupant = byRepoKey.get(key);
      if (occupant) {
        for (const tmpPath of tmps) {
          const sourceFile = path.basename(tmpPath);
          if (!pendingUnresolvedQuarantines.some((p) => p.sourceFile === sourceFile)) {
            pendingUnresolvedQuarantines.push({ entry: originalEntryBySource.get(sourceFile) ?? occupant, sourceFile });
          }
        }
      }
      // eslint-disable-next-line no-console
      console.warn(`[merge-quarantine] recovered ${tmps.length} torn-write tmp(s) resolving to a key that is ALSO occupied by a DIFFERENT, currently-unresolvable entry's own trusted resolvedKey — refusing to promote/overwrite that entry's own backing file. Every tmp is left AS WRITTEN and given its own pending reference; investigate the collision before this can recover durably.`);
      continue;
    }
    const unionEntry = byRepoKey.get(key);
    if (!unionEntry) continue; // defensive — every key here was armed into byRepoKey above
    if (!isRepoPathCurrentlyResolvable(unionEntry.repoPath)) {
      // @decision 7673d096 — promote a recovered tmp to its FRESH final path only when the path itself
      // currently resolves; leave every tmp AS WRITTEN rather than promote to an unverifiable location.
      // eslint-disable-next-line no-console
      console.warn(`[merge-quarantine] recovered ${tmps.length} torn-write tmp(s) for ${unionEntry.repoPath} but could NOT verify its key — the path does not currently resolve on disk — leaving every tmp AS WRITTEN.`);
      continue;
    }
    const armedForWrite: MergeQuarantineEntry = { ...unionEntry, resolvedKey: key };
    // @decision 54054c01 / fd189d91 — replace at EVERY key `unionEntry` was armed under (never just
    // `key`), AND re-point any pending reference to it — a dual-armed (stale-resolvedKey) tmp's other
    // slot double-reports via the identity-keyed de-dupe below otherwise.
    replaceEntryEverywhere(byRepoKey, unionEntry, armedForWrite);
    // @decision 97cff6db — NO safety-tmp here, deliberately: this key's OWN surviving tmp(s) already
    // ARE its durable backup (never deleted until this promote succeeds) — a second copy would be
    // redundant and would cost every ordinary recovery an extra open several existing tests count on.
    // SELF-HEALING: the content was durable (fsync'd) before any crash — promote the union to its proper
    // final name, then drop every contributing tmp — but ONLY once that promote actually succeeds (Code
    // Review of eae23ebe): unlinking unconditionally could delete the only durable copy while leaving NO
    // final behind, if the promote itself fails (EMFILE/EACCES/disk, or bootWriteLatch's own refusal). A
    // failed promote still leaves the recovered union ACTIVE in-process for THIS boot; the surviving tmps
    // (this key's own durable backup regardless — a safety-tmp here would be redundant, see above) are
    // what let the NEXT boot recover it too.
    if (bootWriteLatch(key, armedForWrite)) {
      for (const tmpPath of tmps) {
        try { fs.unlinkSync(tmpPath); } catch { /* best-effort — a leftover tmp beside a good final write is harmless */ }
      }
      // eslint-disable-next-line no-console
      console.log(`[merge-quarantine] recovered a torn-write quarantine latch (${tmps.length} tmp file(s)) for ${armedForWrite.repoPath} at boot — the crash landed between fsync and rename; re-armed as the full union.`);
    } else {
      // eslint-disable-next-line no-console
      console.error(`[merge-quarantine] recovered torn-write latch(es) for ${armedForWrite.repoPath} but could NOT durably re-persist the union under its final name — every tmp is left IN PLACE so the next boot can still recover it.`);
    }
  }

  // PHASE 3 — migrate-pass DELETES, now that writeTargetsThisPass reflects BOTH write passes above.
  for (const [key, sources] of migratedSourcesByKey) {
    const outcome = writeOutcomesByKey.get(key);
    if (!outcome) continue; // degraded-occupied (folded above) or missing union — nothing to delete
    const { unionEntry, succeeded } = outcome;
    if (succeeded) {
      // @decision c870618c — fold any per-source unlink failure into orphanLatchFiles and re-persist,
      // mirroring consumeMatchedPendingsIntoArmedEntry's own success-branch fold, now for N sources.
      const failedToDelete: string[] = [];
      for (const sourceFile of sources) {
        // @decision 4480b077 (round 3, CRITICAL) — never delete a source whose basename is ALSO a write
        // target EITHER pass just wrote to this boot for a DIFFERENT key — it is that other key's own
        // freshly written latch now, not stale residue, even though it started this pass as our own leftover.
        if (writeTargetsThisPass.has(sourceFile)) {
          // eslint-disable-next-line no-console
          console.warn(`[merge-quarantine] migrate source ${sourceFile} for key ${key} is ALSO a write target this pass wrote to for a DIFFERENT key — refusing to delete it (would destroy that other key's freshly-written latch). Left AS WRITTEN; this repo's own entry already migrated correctly under its own key.`);
          continue;
        }
        if (!deleteSourceLatchIfSuperseded(sourceFile, unionEntry, key)) failedToDelete.push(sourceFile);
      }
      if (failedToDelete.length > 0) {
        const folded: MergeQuarantineEntry = { ...unionEntry, orphanLatchFiles: [...new Set([...(unionEntry.orphanLatchFiles ?? []), ...failedToDelete])] };
        replaceEntryEverywhere(byRepoKey, unionEntry, folded); // fd189d91 — also re-points any pending reference
        if (!bootWriteLatch(key, folded)) {
          // eslint-disable-next-line no-console
          console.error(`[merge-quarantine] migrated ${folded.repoPath} but could NOT re-persist it after ${failedToDelete.length} stale source file(s) (${failedToDelete.join(", ")}) failed to unlink — those file(s) stay on disk, UNTRACKED by this entry's own bookkeeping in THIS process; a restart may re-arm this quarantine from them (fail-closed, never open, but investigate the unlink failure).`);
        }
      }
    } else {
      // @decision a6fa60e2 — fold every old filename into orphanLatchFiles, or a raw clear-by-id of any
      // of their stale hashes deletes this entry's only durable copy as an "unowned" orphan.
      //
      // @decision 882d6cff (round 2) — EXCLUDE this key's own write target (mirrors
      // consumeMatchedPendingsIntoArmedEntry's `f !== freshWriteTarget`): Site A can feed a source equal
      // to its own target, and folding that into its own orphanLatchFiles would self-reference.
      const freshWriteTarget = path.basename(quarantinePathFor(unionEntry.repoPath));
      const toFold = sources.filter((f) => f !== freshWriteTarget);
      const folded: MergeQuarantineEntry = { ...unionEntry, orphanLatchFiles: [...new Set([...(unionEntry.orphanLatchFiles ?? []), ...toFold])] };
      replaceEntryEverywhere(byRepoKey, unionEntry, folded); // fd189d91 — also re-points any pending reference
      // @decision 97cff6db — "left in place so nothing is lost" is FALSE if a sibling's write this pass
      // already overwrote one of these filenames; the safety-tmp written BEFORE any such write is what
      // actually survives. See the decision record.
      const safetyTmpPath = safetyTmpPathByKey.get(key);
      const safetyNote = safetyTmpPath
        ? ` A durable safety-tmp residue for this key's own data survives at ${path.basename(safetyTmpPath)} regardless of what happens to those old file(s) next — the next boot's own safety-tmp recovery pass re-persists it.`
        : "";
      // eslint-disable-next-line no-console
      console.error(`[merge-quarantine] could not durably persist ${folded.repoPath}'s migrated latch under its new key — the OLD file(s) (${toFold.join(", ")}) are left as written, but may already have been overwritten by a DIFFERENT key's own successful write earlier in this same pass.${safetyNote} A later boot can retry the migration.`);
    }
  }

  // PASS 2 — an unmatched-corrupt (orphan) latch must end up referenced by EVERY registered repo's entry,
  // so the human clear route can eventually delete it once nothing references it any more (round 7, M2).
  // A repo with NO entry from PASS 1 gets a fresh fail-closed entry, exactly as before. A repo that ALREADY
  // has its OWN real (valid) entry from PASS 1 keeps that data UNCHANGED (round 7 cheap-minor: never
  // clobber a repo's genuine data) but still gets the orphan filename(s) MERGED into its OWN
  // `orphanLatchFiles` and re-persisted — round 7 M2 RESIDUAL: the first cut of this fix instead `continue`d
  // past any repo with valid data, so if EVERY registered repo already had its own valid latch when an
  // orphan was found, NOTHING ever referenced the orphan, no clear could ever delete it, and the next boot
  // re-quarantined everything all over again — the exact same trap M2 exists to close, reachable through a
  // different door.
  if (orphanFilenames.length > 0) {
    const orphanPaths = orphanFilenames.map((f) => path.join(MERGE_QUARANTINE_DIR, f));
    const reason = `boot found ${orphanFilenames.length} CORRUPT/unparsable quarantine latch(es) matching NO registered repo (${orphanReasonParts.join("; ")})`;
    // eslint-disable-next-line no-console
    console.error(`[merge-quarantine] ${reason} — orphan file(s): ${orphanPaths.join(", ")} — every registered repo's entry now references it (fail-closed for one with no entry of its own, ADDED to the real data of one that already has one) so clearing ALL of them (POST /internal/merge-quarantine/clear) deletes the orphan file(s) once nothing else references them.`);
    for (const repoPath of registeredRepoPaths) {
      const key = canonicalRepoLockKey(repoPath);
      const existing = byRepoKey.get(key);
      if (existing) {
        // Keep this repo's REAL data — only ADD the orphan filename(s) it doesn't already carry.
        const mergedOrphans = [...new Set([...(existing.orphanLatchFiles ?? []), ...orphanFilenames])];
        const updated: MergeQuarantineEntry = { ...existing, orphanLatchFiles: mergedOrphans };
        // @decision fd189d91 — `existing` can be dual-armed AND/OR pending-referenced; replace via the
        // shared chokepoint (re-points both), never a bare byRepoKey.set loop. See the decision record.
        replaceEntryEverywhere(byRepoKey, existing, updated);
        // @decision 97cff6db (round 4) — folds in card d163aef5: this site never had a
        // degradedOccupiedKeys/resolvability check of its own — bootWriteLatch now supplies both.
        if (!bootWriteLatch(key, updated)) {
          // eslint-disable-next-line no-console
          console.error(`[merge-quarantine] could not durably persist the orphan-file reference on ${repoPath}'s existing quarantine this boot — it will NOT survive another restart until this is fixed (see bootWriteLatch's own refusal log, if any, above).`);
        }
        continue;
      }
      const entry: MergeQuarantineEntry = {
        repoPath, branch: PLACEHOLDER_BRANCH_UNRESOLVED,
        reason, enteredAt: Date.now(), tokens: [randomUUID()], orphanLatchFiles: [...orphanFilenames],
        armedKeys: [key], placeholder: true,
      };
      byRepoKey.set(key, entry);
      // @decision 97cff6db (round 4) — folds in card d163aef5 (repro C): same gap as the branch above.
      if (!bootWriteLatch(key, entry)) {
        // eslint-disable-next-line no-console
        console.error(`[merge-quarantine] fail-closed quarantine for ${repoPath} (orphan latch(es) ${orphanFilenames.join(", ")}) could NOT be durably persisted this boot — it will NOT survive another restart until this is fixed (see bootWriteLatch's own refusal log, if any, above).`);
      }
    }
  }

  // @decision 97cff6db (round 2, Lead ruling 2) — recovered SAFETY-TMP residues are ALWAYS unioned into
  // the final for their own key here (never blind-deleted), deleted only once re-persisted durably.
  //
  // @decision 97cff6db (round 4, finding G2) — this write is a boot write site like any other:
  // bootWriteLatch now ALSO supplies the degradedOccupiedKeys check this site never had (round 3's own
  // blockedWriteTargets/resolvability checks it already did are now subsumed into the same chokepoint).
  for (const [f, key] of safetyTmpRecoveryByFile) {
    const unionEntry = byRepoKey.get(key);
    if (!unionEntry) continue; // diverted to pending instead (unresolvable) — nothing to recover here
    if (bootWriteLatch(key, unionEntry)) {
      try { fs.unlinkSync(path.join(MERGE_QUARANTINE_DIR, f)); } catch { /* best-effort — harmless leftover beside a good final */ }
    } else {
      // eslint-disable-next-line no-console
      console.error(`[merge-quarantine] recovered a SAFETY-TMP residue for ${unionEntry.repoPath} but could NOT durably re-persist its union — the residue is left IN PLACE so the next boot can retry.`);
    }
  }

  // An entry may be armed under TWO keys (its current key AND its recorded `resolvedKey`, when they
  // differ) — set `activeQuarantines` under every key, but de-dupe `out` by entry IDENTITY, across BOTH
  // structures in ONE Set, so a caller never sees the same quarantine reported twice.
  //
  // @decision a2f381dc — dedupe across BOTH structures in one Set, never `byRepoKey` alone then
  // concatenated with pending. See the decision record (m-3).
  for (const [key, entry] of byRepoKey) activeQuarantines.set(key, entry);
  return [...new Set([...byRepoKey.values(), ...pendingUnresolvedQuarantines.map((p) => p.entry)])];
}

/** Production entry point — no injection seam reachable through this signature at all. */
export function reenterMergeQuarantinesAtBoot(registeredRepoPaths: string[] = []): MergeQuarantineEntry[] {
  return reenterMergeQuarantinesAtBootImpl(registeredRepoPaths, undefined);
}

/**
 * @decision ef651188 (round 2, nit 3) — TEST-ONLY entry point for the `testOnlyInjectUnprotectedPending`
 * seam. Never imported by `index.ts`; a test exercising the bootWriteLatch backstop calls this instead of
 * {@link reenterMergeQuarantinesAtBoot}, whose own signature cannot accept the injection at all.
 */
export function reenterMergeQuarantinesAtBootTestOnly(
  registeredRepoPaths: string[],
  testOnlyInjectUnprotectedPending: PendingUnresolvedQuarantine[],
): MergeQuarantineEntry[] {
  return reenterMergeQuarantinesAtBootImpl(registeredRepoPaths, testOnlyInjectUnprotectedPending);
}
