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

/** Set `key` -> `entry` in `byRepoKey`, UNIONING with whatever entry (if any) already occupies that key
 *  rather than silently overwriting it — see {@link unionQuarantineEntries}. Every boot-time PASS 1/1b
 *  write into `byRepoKey` must route through this, never a bare `.set()`, since the toplevel walk can make
 *  two previously-distinct latches collapse onto the same key. Also folds `key` itself into the result's
 *  `armedKeys` and returns the final (armed) object — a caller dual-arming the SAME entry under a SECOND
 *  key must pass this call's return value as the `entry` for that second call (see PASS 1/1b), or the
 *  second key's slot ends up with an `armedKeys` missing the first.
 *
 *  @decision 54054c01 — set the final armed object at EVERY key in its OWN armedKeys, not just `key` — a
 *  union can inherit a key from an already-dual-armed `prior`, which would otherwise keep pointing stale. */
function armQuarantineKey(byRepoKey: Map<string, MergeQuarantineEntry>, key: string, entry: MergeQuarantineEntry): MergeQuarantineEntry {
  const prior = byRepoKey.get(key);
  const merged = prior ? unionQuarantineEntries(prior, entry) : entry;
  const armed: MergeQuarantineEntry = { ...merged, armedKeys: [...new Set([...(merged.armedKeys ?? []), key])] };
  for (const k of armed.armedKeys ?? [key]) byRepoKey.set(k, armed);
  return armed;
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
 */
function writeMergeQuarantineLatch(entry: MergeQuarantineEntry, sweepOtherTmpsOnSuccess = false): boolean {
  let fd: number | undefined;
  try {
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const final = quarantinePathFor(entry.repoPath);
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
 * Delete `sourceFile` (a latch basename previously loaded from disk — a stale/legacy/pending source,
 * never a full path) ONLY IF it is NOT the same file `writtenEntry` was just durably written under.
 *
 * @decision 54054c01 (Code Review round 3, CRITICAL) — for a repo bound at its own git toplevel, the old
 * and current key algorithms compute the IDENTICAL value, so a stale source's name can equal the file a
 * graduation/merge just wrote — unlinking unconditionally deletes the quarantine just written, not a leftover.
 *
 * Shared by graduation, `enterMergeQuarantine`'s merge-into-pending path, and PASS 1's migrate branch (see
 * docs/decisions/54054c01-clear-lifts-every-key-an-entry-was-armed-under.md for the full repro).
 */
function deleteSourceLatchIfSuperseded(sourceFile: string, writtenEntry: MergeQuarantineEntry): void {
  const writtenFile = path.basename(quarantinePathFor(writtenEntry.repoPath));
  if (sourceFile === writtenFile) return; // the "stale" source IS the file we just wrote — nothing to delete
  try { fs.unlinkSync(path.join(MERGE_QUARANTINE_DIR, sourceFile)); } catch { /* best-effort */ }
}

/** The stable hash-prefixed glob for a bare latch HASH's own tmp residue — `<hash>.json.tmp-<pid>`, any
 *  pid. Best-effort; a missing/unreadable directory is not an error. Never throws. UNCONDITIONAL — never
 *  call this (or {@link deleteMergeQuarantineTmpResidueForKey}/{@link deleteMergeQuarantineTmpResidue})
 *  at a site that must spare a DIFFERENT, surviving entry's own cross-referenced residue; reach for
 *  {@link sweepTmpResidueForHashIfUnreferenced} there instead (card be79f4d5). As of round 4, EVERY
 *  production caller of this chain has been migrated to that reference-aware sweep instead
 *  (`clearMergeQuarantineLatchFile`'s two sweeps, `deleteMergeQuarantineLatchByKey`,
 *  `writeMergeQuarantineLatch`'s `sweepOtherTmpsOnSuccess`, and `clearMergeQuarantineByToken`'s
 *  partial-clear branch) — this function, {@link deleteMergeQuarantineTmpResidueForKey}, and
 *  {@link deleteMergeQuarantineTmpResidue} now have NO remaining caller at all (left in place rather
 *  than deleted, like the pre-existing dead {@link deleteMergeQuarantineLatch}; see
 *  docs/decisions/be79f4d5-lazy-graduation-source-latch-ownership.md). */
function deleteMergeQuarantineTmpResidueForHash(hash: string): void {
  const prefix = `${hash}.json.tmp-`;
  let files: string[];
  try { files = fs.readdirSync(MERGE_QUARANTINE_DIR); } catch { return; }
  for (const f of files) {
    if (!f.startsWith(prefix)) continue;
    try { fs.unlinkSync(path.join(MERGE_QUARANTINE_DIR, f)); } catch { /* best-effort */ }
  }
}

/** The stable hash-prefixed glob for KEY's OWN tmp residue — `<hash>.json.tmp-<pid>`, any pid. Best-effort;
 *  a missing/unreadable directory is not an error. Never throws. */
function deleteMergeQuarantineTmpResidueForKey(key: string): void {
  deleteMergeQuarantineTmpResidueForHash(quarantineHashForKey(key));
}

/** The stable hash-prefixed glob for `repoPath`'s OWN tmp residue — `<hash>.json.tmp-<pid>`, any pid.
 *  Best-effort; a missing/unreadable directory is not an error. Never throws. */
function deleteMergeQuarantineTmpResidue(repoPath: string): void {
  deleteMergeQuarantineTmpResidueForKey(canonicalRepoLockKey(repoPath));
}

/** Best-effort; a missing file is not an error. Never throws. Also sweeps any leftover `.json.tmp-<pid>`
 *  residue for KEY — a failed write DELIBERATELY leaves its tmp behind (round 2: it's the only durable
 *  record of an active quarantine until resolved) — HERE, at clear time, is where it gets swept.
 *
 * @decision 54054c01 — takes a raw KEY, never a repoPath: a clear must address BOTH a key an entry is
 * armed under, not just the one `canonicalRepoLockKey(repoPath)` recomputes fresh right now. */
function deleteMergeQuarantineLatchByKey(key: string): void {
  try { fs.unlinkSync(quarantinePathForKey(key)); } catch { /* ENOENT is the common case */ }
  // @decision be79f4d5 (round 3) — reference-aware, never the unconditional-by-hash sibling: a same-hash
  // tmp a DIFFERENT, surviving entry's own `orphanLatchFiles` still lists must not be destroyed just
  // because THIS key's own entry is being legitimately cleared.
  sweepTmpResidueForHashIfUnreferenced(quarantineHashForKey(key));
}

function deleteMergeQuarantineLatch(repoPath: string): void {
  deleteMergeQuarantineLatchByKey(canonicalRepoLockKey(repoPath));
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
 */
export function enterMergeQuarantine(repoPath: string, branch: string, reason: string, opId?: string): string {
  const token = randomUUID();
  const key = canonicalRepoLockKey(repoPath);
  const existing = activeQuarantines.get(key);
  if (existing) {
    const entry: MergeQuarantineEntry = { ...existing, tokens: [...existing.tokens, token] };
    // `existing` may be armed under a SECOND key too (its own resolvedKey) — update every one of those
    // slots to this rebuilt object, not just `key` (round 2 finding 2).
    for (const k of existing.armedKeys?.length ? existing.armedKeys : [key]) activeQuarantines.set(k, entry);
    // @decision 92c645cc — safe to sweep: `entry.tokens` is `[...existing.tokens, token]`, a visible
    // superset of whatever `existing` (this process's own authoritative record for this key) already
    // held, so no older tmp for this key can carry a token this write doesn't already carry forward.
    if (!writeMergeQuarantineLatch(entry, true)) {
      // eslint-disable-next-line no-console
      console.error(`[merge-quarantine] canonical repo ${repoPath} is quarantined IN THIS PROCESS ONLY right now — the durable latch failed to write (see the error just above), so a daemon restart BEFORE that is fixed would silently LIFT this quarantine instead of re-arming it. Investigate (disk full? permissions on ${MERGE_QUARANTINE_DIR}?) immediately.`);
    }
    return token;
  }
  const identityForPendingMatch = directPathIdentity(repoPath);
  const pendingIdx = pendingUnresolvedQuarantines.findIndex((p) => directPathIdentity(p.entry.repoPath) === identityForPendingMatch);
  if (pendingIdx !== -1) {
    const pending = pendingUnresolvedQuarantines[pendingIdx] as PendingUnresolvedQuarantine;
    const fresh: MergeQuarantineEntry = { repoPath, branch, reason, opId, enteredAt: Date.now(), tokens: [token] };
    const merged: MergeQuarantineEntry = { ...unionQuarantineEntries(pending.entry, fresh), resolvedKey: key, armedKeys: [key] };
    activeQuarantines.set(key, merged);
    if (writeMergeQuarantineLatch(merged)) {
      pendingUnresolvedQuarantines.splice(pendingIdx, 1);
      deleteSourceLatchIfSuperseded(pending.sourceFile, merged);
    } else {
      // eslint-disable-next-line no-console
      console.error(`[merge-quarantine] canonical repo ${repoPath} is quarantined IN THIS PROCESS ONLY right now (merged with a pending latch) — the durable latch failed to write, so the pending latch's OWN source file (${pending.sourceFile}) is left in place rather than deleted; a later boot can still recover from it.`);
    }
    return token;
  }
  const entry: MergeQuarantineEntry = { repoPath, branch, reason, opId, enteredAt: Date.now(), tokens: [token], resolvedKey: key, armedKeys: [key] };
  activeQuarantines.set(key, entry);
  const persisted = writeMergeQuarantineLatch(entry);
  if (!persisted) {
    // eslint-disable-next-line no-console
    console.error(`[merge-quarantine] canonical repo ${repoPath} is quarantined IN THIS PROCESS ONLY right now — the durable latch failed to write (see the error just above), so a daemon restart BEFORE that is fixed would silently LIFT this quarantine instead of re-arming it. Investigate (disk full? permissions on ${MERGE_QUARANTINE_DIR}?) immediately.`);
  }
  return token;
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
export function clearMergeQuarantineByToken(repoPath: string, token: string): void {
  const key = canonicalRepoLockKey(repoPath);
  const current = activeQuarantines.get(key);
  if (!current || !current.tokens.includes(token)) return; // not ours — leave whatever is (or isn't) there alone
  const remaining = current.tokens.filter((t) => t !== token);
  if (remaining.length === 0) {
    clearMergeQuarantine(repoPath); // last outstanding token cleared — also handles any orphan-file bookkeeping
    return;
  }
  const updated: MergeQuarantineEntry = { ...current, tokens: remaining };
  // Update EVERY key `current` is armed under, not just `key` — reference equality breaks the moment an
  // entry is REBUILT elsewhere (a union, an orphan merge), since the rebuilt object stops being `===` the
  // one still sitting at another of its own keys (round 2 finding 2).
  for (const k of current.armedKeys?.length ? current.armedKeys : [key]) activeQuarantines.set(k, updated);
  // @decision bde5d1fe (Code Review of eae23ebe) — a sweep may only run AFTER a durable write of the
  // state that supersedes it has succeeded, never before: sweeping THEN failing this write would leave
  // NOTHING durable for a repo whose only prior copy was this same tmp.
  // @decision 92c645cc — `updated.tokens` deliberately DROPS the cleared token, so this call does NOT
  // pass `writeMergeQuarantineLatch`'s own `sweepOtherTmpsOnSuccess` (not a superset write); the sweep
  // below is this call's OWN pre-existing, separate step, unaffected by that flag.
  if (writeMergeQuarantineLatch(updated)) {
    // @decision be79f4d5 (round 4) — reference-aware, same reason as the other two sites: a DIFFERENT,
    // surviving entry's own same-hash tmp must survive a partial clear here too.
    sweepTmpResidueForHashIfUnreferenced(quarantineHashFor(repoPath));
  } else {
    // eslint-disable-next-line no-console
    console.error(`[merge-quarantine] could not durably persist the reduced token set for ${repoPath} after a partial clear — the PRE-EXISTING durable state (this repo's own latch file, final or tmp) is left UNTOUCHED, so a restart before this is fixed re-arms with the just-cleared token still counted as outstanding (delays the eventual full lift; never a false lift).`);
  }
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
 */
function physicalOwnerRepoPaths(filename: string): string[] {
  const owners = new Set<string>();
  for (const [k, e] of activeQuarantines) {
    if (`${quarantineHashForKey(k)}.json` === filename || path.basename(quarantinePathFor(e.repoPath)) === filename) {
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
 * `clearMergeQuarantineByToken`'s own partial-clear branch (round 4) — the chain in
 * {@link deleteMergeQuarantineTmpResidueForHash}'s own doc now has NO remaining production caller.
 *
 * @decision be79f4d5 (round 3) — do NOT fold this into `deleteMergeQuarantineTmpResidueForHash` itself;
 * call THIS at each site instead. RETRACTED: an earlier "leaves residue behind forever" rationale was
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
 */
export function clearMergeQuarantineByKey(key: string, identityRepoPath: string): void {
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
  pendingUnresolvedQuarantines = pendingUnresolvedQuarantines.filter((p) => {
    if (directPathIdentity(p.entry.repoPath) !== identity) return true;
    for (const f of p.entry.orphanLatchFiles ?? []) orphanFilesToSweep.add(f);
    try { fs.unlinkSync(path.join(MERGE_QUARANTINE_DIR, p.sourceFile)); } catch { /* best-effort */ }
    return false;
  });
  for (const orphanFile of orphanFilesToSweep) sweepOrphanLatchFileIfUnreferenced(orphanFile);
}

/**
 * UNCONDITIONAL clear for `repoPath` — thin wrapper over {@link clearMergeQuarantineByKey}, addressed by a
 * FRESHLY-recomputed `canonicalRepoLockKey(repoPath)`. Called from exactly two places: (1) the human-only
 * loopback REST route (`POST /internal/merge-quarantine/clear`, gateway/server.ts), and (2) internally,
 * once {@link clearMergeQuarantineByToken} empties the token set itself. A RESTORED quarantine (re-entered
 * at boot) can ONLY ever be cleared this way, since the original in-process promise chain(s) that could
 * auto-clear it are gone once the process(es) that held them have exited.
 */
export function clearMergeQuarantine(repoPath: string): void {
  clearMergeQuarantineByKey(canonicalRepoLockKey(repoPath), repoPath);
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
 * Used ONLY by `/clear-by-path`'s `{repoPath}` form — `/clear` (project-resolved) keeps calling
 * {@link clearMergeQuarantineReporting} directly (see the decision record for why).
 *
 * @decision abccee85 — never recompute `canonicalRepoLockKey` from a human-supplied repoPath string to
 * decide which entry to clear; see the decision record for the key-drift bugs this closes, including
 * round 7's fix to this function's OWN final fallback (it used to do exactly that).
 */
export function clearMergeQuarantineByRecordedPath(repoPath: string): { wasQuarantined: boolean; reason?: string } {
  const identity = directPathIdentity(repoPath);
  const matched: Array<{ key: string; repoPath: string }> = [];
  const seen = new Set<MergeQuarantineEntry>();
  for (const [key, entry] of activeQuarantines) {
    if (directPathIdentity(entry.repoPath) !== identity) continue;
    if (seen.has(entry)) continue; // same logical entry armed under >1 key (armedKeys) — clear it once
    seen.add(entry);
    matched.push({ key, repoPath: entry.repoPath });
  }
  if (matched.length > 0) {
    for (const m of matched) clearMergeQuarantineByKey(m.key, m.repoPath);
    return { wasQuarantined: true };
  }
  // No ACTIVE entry's stored repoPath matches — check for PENDING (boot-unverifiable) entries sharing this
  // exact identity BEFORE falling back to not-found below. A pending entry's own path typically can't
  // resolve at all, so a fresh canonicalRepoLockKey recompute of `repoPath` can walk UP to an ENCLOSING
  // repo's key and wrongly lift THAT repo's active quarantine instead of this (unrelated) pending entry —
  // see the decision record, round 5. Drop EVERY matching pending entry (round 6, consistent with
  // clearMergeQuarantineByKey's own identity-matched filter — more than one pending latch can share one
  // identity), never just the first found.
  const matchedPending = pendingUnresolvedQuarantines.filter((p) => directPathIdentity(p.entry.repoPath) === identity);
  if (matchedPending.length > 0) {
    pendingUnresolvedQuarantines = pendingUnresolvedQuarantines.filter((p) => !matchedPending.includes(p));
    // @decision 6237bef6 — sweep each dropped pending entry's OWN orphanLatchFiles too, not just its
    // sourceFile; see the decision record (site 3 of 3 — abccee85's own trace named only the other two).
    const orphanFilesToSweep = new Set<string>();
    for (const p of matchedPending) {
      for (const f of p.entry.orphanLatchFiles ?? []) orphanFilesToSweep.add(f);
      try { fs.unlinkSync(path.join(MERGE_QUARANTINE_DIR, p.sourceFile)); } catch { /* best-effort */ }
    }
    for (const orphanFile of orphanFilesToSweep) sweepOrphanLatchFileIfUnreferenced(orphanFile);
    return { wasQuarantined: true };
  }
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
  if (direct || pendingUnresolvedQuarantines.length === 0) return direct;
  const identity = directPathIdentity(repoPath);
  let idx = pendingUnresolvedQuarantines.findIndex((p) => directPathIdentity(p.entry.repoPath) === identity);
  if (idx === -1) {
    const ancestorIdentity = ancestorAwarePathIdentity(repoPath);
    idx = pendingUnresolvedQuarantines.findIndex((p) => ancestorAwarePathIdentity(p.entry.repoPath) === ancestorIdentity);
  }
  if (idx === -1) {
    idx = pendingUnresolvedQuarantines.findIndex((p) =>
      isRepoPathCurrentlyResolvable(p.entry.repoPath) && canonicalRepoLockKey(p.entry.repoPath) === key);
  }
  if (idx === -1) return undefined;
  const pending = pendingUnresolvedQuarantines[idx] as PendingUnresolvedQuarantine; // idx is a verified hit above
  if (!isRepoPathCurrentlyResolvable(pending.entry.repoPath)) {
    // STILL can't be verified — report it active for THIS query, but leave it in
    // `pendingUnresolvedQuarantines` rather than pinning it to a key that may not hold once the path
    // genuinely resolves. Pinning it here would reopen the exact bug this pending mechanism exists to
    // close: a LATER remount recomputes a DIFFERENT (real) key, and an already-graduated entry sitting
    // under the degraded key would miss it exactly like the original one-boot fail-open did, just later.
    return pending.entry;
  }
  // Genuinely resolvable now — graduate it: durably persist under the verified key and stop treating it as
  // pending (a FUTURE query for the same repo hits `activeQuarantines` directly from here on). This happens
  // UNCONDITIONALLY, in-memory, regardless of whether the durable write below succeeds — mirroring PASS 1's
  // own migrate branch, enforcement for THIS process must not wait on disk I/O succeeding.
  pendingUnresolvedQuarantines.splice(idx, 1);
  // @decision be79f4d5 — strip a dangling self-reference to `pending.sourceFile` before arming, or a
  // persisted entry falsely "protects" a file this same write is about to delete on success.
  const strippedOrphanLatchFiles = pending.entry.orphanLatchFiles?.filter((f) => f !== pending.sourceFile);
  let armed: MergeQuarantineEntry = {
    ...pending.entry, resolvedKey: key, armedKeys: [key], orphanLatchFiles: strippedOrphanLatchFiles,
  };
  activeQuarantines.set(key, armed);
  // Delete the pending entry's stale source file only after the new write succeeds, and only if it isn't
  // the SAME file we just wrote — see deleteSourceLatchIfSuperseded's own doc comment.
  if (writeMergeQuarantineLatch(armed)) {
    deleteSourceLatchIfSuperseded(pending.sourceFile, armed);
  } else {
    // @decision be79f4d5 — fold the stale sourceFile into orphanLatchFiles (skipping only when it's
    // already this entry's own fresh write target, mirroring deleteSourceLatchIfSuperseded's equality
    // guard), or a raw clear-by-id of its hash deletes this entry's only durable copy as an orphan.
    if (pending.sourceFile !== path.basename(quarantinePathFor(armed.repoPath))) {
      armed = { ...armed, orphanLatchFiles: [...new Set([...(armed.orphanLatchFiles ?? []), pending.sourceFile])] };
      activeQuarantines.set(key, armed);
    }
    // eslint-disable-next-line no-console
    console.error(`[merge-quarantine] lazily re-resolved a pending unverifiable quarantine for ${armed.repoPath} but could NOT durably persist it under its now-known key — still enforced in THIS process, but the ORIGINAL file (${pending.sourceFile}) is left in place so a later boot can still recover it.`);
  }
  return armed;
}

/** Diagnostic snapshot only (e.g. a status endpoint) — never used to decide anything itself. Includes
 *  PENDING (boot-unverifiable) entries too, so a human reading this never sees a blind spot that
 *  `activeMergeQuarantineFor` itself would resolve the moment it's actually queried for that repo.
 *  De-duped by entry IDENTITY — an entry armed under two keys (see `armedKeys`) sits twice in
 *  `activeQuarantines.values()` (once per key) and must be reported once, not twice. */
export function listActiveMergeQuarantines(): MergeQuarantineEntry[] {
  return [...new Set(activeQuarantines.values()), ...pendingUnresolvedQuarantines.map((p) => p.entry)];
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

/** The on-disk latch file id(s) for `entry` — one per key it is armed under
 *  ({@link MergeQuarantineEntry.armedKeys}), or, for a PENDING (boot-unverifiable) entry with no
 *  `armedKeys` of its own, the id baked into its own recorded `sourceFile` name. Exported so a
 *  human-facing listing route can hand out id(s) usable with {@link clearMergeQuarantineLatchFile}.
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
  if (pending) {
    // @decision 6237bef6 — sourceFile is `<hash>.json` for a PASS-1-sourced pending entry but
    // `<hash>.json.tmp-<pid>` for a PASS-1b tmp-residue one — cut at the first `.json`, not a fixed
    // trailing-length slice, so both shapes recover the bare hash (never a literal `.json` substring).
    const jsonIdx = pending.sourceFile.indexOf(".json");
    return [jsonIdx === -1 ? pending.sourceFile : pending.sourceFile.slice(0, jsonIdx)];
  }
  return [quarantineHashFor(entry.repoPath)];
}

/** Thin, symmetric wrapper shared by BOTH the project-resolved `/internal/merge-quarantine/clear` route
 *  and its no-project-resolution twin `/internal/merge-quarantine/clear-by-path` (card c0be9bf9) — factored
 *  out so the two routes cannot drift in what a clear actually DOES; each route's own job ends at
 *  resolving its own address (projectId/repoKey, or a raw repoPath) down to a `repoPath` and calling this. */
export function clearMergeQuarantineReporting(repoPath: string): { wasQuarantined: boolean } {
  const wasQuarantined = !!activeMergeQuarantineFor(repoPath);
  clearMergeQuarantine(repoPath);
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
 */
export function clearMergeQuarantineLatchFile(id: string): { ok: true; wasQuarantined: boolean; latchKept?: true; referencingRepoPaths?: string[] } | { ok: false; reason: string } {
  if (!QUARANTINE_LATCH_ID_PATTERN.test(id)) {
    return { ok: false, reason: `invalid latch id '${id}' — expected a 24-hex-character id (see GET /internal/merge-quarantine/list)` };
  }
  const resolvedDir = path.resolve(MERGE_QUARANTINE_DIR);
  const finalPath = path.resolve(resolvedDir, `${id}.json`);
  if (path.dirname(finalPath) !== resolvedDir || path.basename(finalPath) !== `${id}.json`) {
    return { ok: false, reason: "resolved path escaped the quarantine directory — refusing" };
  }
  for (const [key, matchedEntry] of activeQuarantines) {
    if (quarantineHashForKey(key) !== id) continue;
    clearMergeQuarantineByKey(key, matchedEntry.repoPath);
    return { ok: true, wasQuarantined: true };
  }
  // @decision 6237bef6 (round 2, item 1) — match EITHER sourceFile shape (`.json` or `.json.tmp-…`), and
  // collect EVERY pending entry sharing this id, never just the first found — see the decision record for
  // the multi-pending-entries-per-id repro this closes.
  const matchedPending = pendingUnresolvedQuarantines.filter((p) =>
    p.sourceFile === `${id}.json` || p.sourceFile.startsWith(`${id}.json.tmp-`));
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
      ok: true, wasQuarantined: true,
      ...(keptRepoPaths.size > 0 ? { latchKept: true, referencingRepoPaths: [...keptRepoPaths] } : {}),
    };
  }
  // No in-memory entry anywhere matches this id — a truly corrupt/unparsable latch (or its own tmp
  // residue) with no repoPath to delegate to. Routed through the shared helper (card 9cabd143 — see this
  // function's own doc), never a bare unlink: `<id>.json` can still be a SURVIVING entry's own reference
  // or physical latch even when nothing in-memory matches `id` itself.
  const ownSweep = sweepOrphanLatchFileIfUnreferenced(`${id}.json`);
  // @decision be79f4d5 — the tmp-residue twin of the `.json` sweep just above: ownership-checked, never
  // the unconditional `deleteMergeQuarantineTmpResidueForHash` (see that function's own doc for why this
  // one call site must differ from every other caller of it).
  const tmpSweep = sweepTmpResidueForHashIfUnreferenced(id);
  const keptRepoPaths = new Set<string>([...ownSweep.referencingRepoPaths, ...tmpSweep.referencingRepoPaths]);
  return {
    ok: true, wasQuarantined: false,
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
 */
export function assertRepoNotQuarantined(repoPath: string): { ok: true } | { ok: false; reason: string } {
  const q = activeMergeQuarantineFor(repoPath);
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
export function reenterMergeQuarantinesAtBoot(registeredRepoPaths: string[] = []): MergeQuarantineEntry[] {
  // @decision 7673d096 — index BOTH the fresh AND the legacy hash per registered repo, or a pre-upgrade
  // corrupt/torn latch falls through to the broad every-repo sweep instead of its own one repo.
  const hashToRepo = new Map<string, string>();
  for (const p of registeredRepoPaths) {
    hashToRepo.set(quarantineHashFor(p), p);
    hashToRepo.set(legacyQuarantineHashFor(p), p);
  }

  let files: string[];
  // @decision bde5d1fe (item 5) — a leftover `.json.tmp-<pid>` is a write whose fsync completed but whose
  // rename never ran (a crash in that ms window) — collected below and recovered, not silently dropped.
  let tmpFiles: string[];
  try {
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const all = fs.readdirSync(MERGE_QUARANTINE_DIR);
    files = all.filter((f) => f.endsWith(".json"));
    // @decision 92c645cc — match BOTH the legacy bare-pid suffix (`.tmp-<pid>`) and the current unique
    // one (`.tmp-<pid>-<hex>`) — a pre-upgrade or foreign-pid tmp must still be recovered.
    tmpFiles = all.filter((f) => /\.json\.tmp-\d+(-[0-9a-f]+)?$/.test(f));
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
        console.warn(`[merge-quarantine] boot-time latch ${f} for ${entry.repoPath} has no recorded resolvedKey and could NOT be verified against its current key — ${entry.repoPath} (and every one of its ancestors) does not currently resolve on disk — leaving the latch file AS WRITTEN and deferring enforcement to a lazy re-resolve on first query (never guessing a key now that a later remount this boot would not match).`);
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
          // @decision a6fa60e2 — strip any dangling `f` reference BEFORE the write: on success `f` is
          // deleted below, so a persisted/armed entry still naming it would falsely "protect" a future,
          // unrelated file that happens to reuse this name; on failure the catch branch re-adds it.
          if (entry.orphanLatchFiles?.includes(f)) {
            entry = { ...entry, orphanLatchFiles: entry.orphanLatchFiles.filter((name) => name !== f) };
          }
          if (writeMergeQuarantineLatch(entry)) {
            // Uses the shared helper too (this branch is only reachable when `freshHash !== hash`, so `f`
            // can never equal the freshly-written filename here — but sharing the check means that safety
            // no longer depends on remembering to keep this gate in sync with the other two call sites).
            deleteSourceLatchIfSuperseded(f, entry);
          } else {
            // @decision a6fa60e2 — fold the old filename `f` into orphanLatchFiles here, or a raw
            // clear-by-id of its stale hash deletes this entry's only durable copy as an "unowned" orphan.
            entry = { ...entry, orphanLatchFiles: [...new Set([...(entry.orphanLatchFiles ?? []), f])] };
            // eslint-disable-next-line no-console
            console.error(`[merge-quarantine] could not durably persist ${entry.repoPath}'s migrated latch under its new key — the OLD file (${f}) is left in place so nothing is lost; a later boot can retry the migration.`);
          }
        } else {
          // entry.resolvedKey is guaranteed set here (the no-resolvedKey+unresolvable case is handled, and
          // `continue`d past, above).
          // eslint-disable-next-line no-console
          console.warn(`[merge-quarantine] boot-time latch ${f} for ${entry.repoPath} could NOT be verified against its current key — ${entry.repoPath} (and every one of its ancestors) does not currently resolve on disk (an unmounted drive? a not-yet-synced folder?) — leaving the latch file AS WRITTEN rather than risk migrating/deleting it on an unreliable reading; arming enforcement under BOTH the current (possibly degraded) key and its recorded original key.`);
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
      if (matchedRepo) {
        // eslint-disable-next-line no-console
        console.error(`[merge-quarantine] boot-time latch ${f} is CORRUPT/unparsable (${(e as Error).message}) but its filename hash matches registered repo ${matchedRepo} — quarantining THAT repo rather than risk discarding a real quarantine.`);
        const entry: MergeQuarantineEntry = {
          repoPath: matchedRepo, branch: PLACEHOLDER_BRANCH_CORRUPT,
          reason: `boot found a CORRUPT/unparsable quarantine latch (${f}: ${(e as Error).message}) matching this repo's hash — fail-closed rather than risk discarding a real quarantine`,
          enteredAt: Date.now(), tokens: [randomUUID()], placeholder: true,
        };
        armQuarantineKey(byRepoKey, canonicalRepoLockKey(matchedRepo), entry);
        // SELF-HEALING write: this OVERWRITES the corrupt file at the SAME deterministic path — no orphan
        // ever results from a matched-corrupt latch.
        if (!writeMergeQuarantineLatch(entry)) {
          // eslint-disable-next-line no-console
          console.error(`[merge-quarantine] fail-closed quarantine for ${matchedRepo} (matched-corrupt latch ${f}) could NOT be durably persisted — it will NOT survive another restart until this is fixed.`);
        }
      } else {
        // No registered repo matches this corrupt latch's hash — collect it; handled in PASS 2, AFTER
        // every file has been read, so a later file's own valid entry is never clobbered (round 7 cheap-minor).
        orphanFilenames.push(f);
        orphanReasonParts.push(`${f}: ${(e as Error).message}`);
      }
    }
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

  for (const f of tmpFiles) {
    const hash = f.slice(0, f.indexOf(".json.tmp-"));
    const tmpPath = path.join(MERGE_QUARANTINE_DIR, f);
    const matchedRepo = hashToRepo.get(hash);
    // @decision 92c645cc — gate on a CLEAN, NON-PLACEHOLDER PASS-1 parse, never on `byRepoKey.has(...)`
    // alone: a corrupt-but-hash-matched (or legacy field-less) placeholder also lands in `byRepoKey`, and
    // this tmp may be the ONLY surviving durable copy of the real entry in that shape.
    if (matchedRepo && cleanlyParsedKeys.has(canonicalRepoLockKey(matchedRepo))) {
      // A proper final `.json` for this repo already loaded CLEANLY (and non-placeholder) in PASS 1 —
      // this tmp really is stale residue from an earlier interrupted write; clean it up immediately.
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
        console.warn(`[merge-quarantine] boot-time tmp latch ${f} for ${entry.repoPath} has no recorded resolvedKey and could NOT be verified against its current key — ${entry.repoPath} (and every one of its ancestors) does not currently resolve on disk — leaving the tmp file AS WRITTEN and deferring enforcement to a lazy re-resolve on first query.`);
        pendingUnresolvedQuarantines.push({ entry, sourceFile: f });
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
        orphanFilenames.push(f);
        orphanReasonParts.push(`${f}: ${(e as Error).message}`);
      }
    }
  }

  // Resolve every deferred corrupt tmp now that every real tmp this boot has already been armed.
  // @decision 92c645cc (round 2, item 2b) — a corrupt tmp's matched repo may ALREADY carry real
  // (non-placeholder) data from a sibling tmp read earlier OR later in the loop above; order must never
  // decide whether that real data survives, or whether the corrupt tmp's own placeholder gets written.
  for (const { f, matchedRepo } of deferredCorruptTmps) {
    const key = canonicalRepoLockKey(matchedRepo);
    const existing = byRepoKey.get(key);
    const tmpPath = path.join(MERGE_QUARANTINE_DIR, f);
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
    // eslint-disable-next-line no-console
    console.error(`[merge-quarantine] boot-time tmp latch ${f} is CORRUPT/unparsable with no real sibling data recovered for registered repo ${matchedRepo} — quarantining THAT repo rather than risk discarding a real quarantine.`);
    const entry: MergeQuarantineEntry = {
      repoPath: matchedRepo, branch: PLACEHOLDER_BRANCH_CORRUPT,
      reason: `boot found a CORRUPT/unparsable torn-write quarantine latch (${f}) matching this repo's hash, with no real sibling data — fail-closed rather than risk discarding a real quarantine`,
      enteredAt: Date.now(), tokens: [randomUUID()], placeholder: true,
    };
    const armed = armQuarantineKey(byRepoKey, key, entry);
    byRepoKey.set(key, armed);
    if (!writeMergeQuarantineLatch(armed)) {
      // eslint-disable-next-line no-console
      console.error(`[merge-quarantine] fail-closed quarantine for ${matchedRepo} (matched-corrupt tmp latch ${f}) could NOT be durably persisted — it will NOT survive another restart until this is fixed.`);
    }
  }

  // Write the UNION once per key, then unlink EVERY tmp that contributed to it.
  // @decision 92c645cc (round 2, items 2/2b) — never persist one tmp's own content as the whole story,
  // and never unlink any of them until that superseding write has actually succeeded (bde5d1fe's rule,
  // applied here to a key with more than one surviving tmp instead of just one).
  for (const [key, tmps] of tmpsToUnlinkByKey) {
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
    // @decision 54054c01 — set the promoted object at EVERY key it is armed under, not just `key`, or a
    // dual-armed (stale-resolvedKey) tmp's other slot double-reports via the identity-keyed de-dupe below.
    for (const k of armedForWrite.armedKeys?.length ? armedForWrite.armedKeys : [key]) byRepoKey.set(k, armedForWrite);
    // SELF-HEALING: the content was durable (fsync'd) before any crash — promote the union to its proper
    // final name, then drop every contributing tmp — but ONLY once that promote actually succeeds (Code
    // Review of eae23ebe): unlinking unconditionally could delete the only durable copy while leaving NO
    // final behind, if the promote itself fails (EMFILE/EACCES/disk). A failed promote still leaves the
    // recovered union ACTIVE in-process for THIS boot; the surviving tmps are what let the NEXT boot
    // recover it too.
    if (writeMergeQuarantineLatch(armedForWrite)) {
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
        // `existing` may already be armed under a SECOND key too (its own resolvedKey, dual-armed by PASS
        // 1/1b) — set EVERY one of those keys to this rebuilt object, not just `key`, or the other slot
        // keeps pointing at the pre-merge `existing` forever (round 2 finding 2: the exact reference-
        // equality trap this field exists to close, reachable from PASS 2 too, not just a later clear).
        for (const k of existing.armedKeys?.length ? existing.armedKeys : [key]) byRepoKey.set(k, updated);
        if (!writeMergeQuarantineLatch(updated)) {
          // eslint-disable-next-line no-console
          console.error(`[merge-quarantine] could not durably persist the orphan-file reference on ${repoPath}'s existing quarantine — it will NOT survive another restart until this is fixed.`);
        }
        continue;
      }
      const entry: MergeQuarantineEntry = {
        repoPath, branch: PLACEHOLDER_BRANCH_UNRESOLVED,
        reason, enteredAt: Date.now(), tokens: [randomUUID()], orphanLatchFiles: [...orphanFilenames],
        armedKeys: [key], placeholder: true,
      };
      byRepoKey.set(key, entry);
      if (!writeMergeQuarantineLatch(entry)) {
        // eslint-disable-next-line no-console
        console.error(`[merge-quarantine] fail-closed quarantine for ${repoPath} (orphan latch(es) ${orphanFilenames.join(", ")}) could NOT be durably persisted — it will NOT survive another restart until this is fixed.`);
      }
    }
  }

  // An entry may be armed under TWO keys (its current key AND its recorded `resolvedKey`, when they
  // differ) — set `activeQuarantines` under every key, but de-dupe `out` by entry IDENTITY so a caller
  // never sees the same quarantine reported twice.
  for (const [key, entry] of byRepoKey) activeQuarantines.set(key, entry);
  return [...new Set(byRepoKey.values()), ...pendingUnresolvedQuarantines.map((p) => p.entry)];
}
