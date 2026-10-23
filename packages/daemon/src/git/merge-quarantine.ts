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
  /** PERSISTED (unlike `armedKeys`) — the distinct `repoPath`(s) of every OTHER raiser whose own token
   *  got folded into this entry's `tokens` set at RUNTIME, via EITHER of two origin sites: {@link
   *  enterMergeQuarantine}'s own `existing` branch (a fresh raise appended into an already-armed entry),
   *  or {@link consumeMatchedPendingsIntoArmedEntry}'s own cross-tier-sibling union (a lazy-graduation
   *  query, or a raise's own sibling-absorb/pending-merge branch, where the raiser itself can end up the
   *  LOSING identity). Either way, only when the raising/losing repoPath's identity differed from the
   *  entry's own winning `repoPath`. Lets clear-by-id fail closed instead of guessing which identity a
   *  bare id refers to, closing the residual {@link canonicalSiblingsFor} always had (it only ever scans
   *  `pendingUnresolvedQuarantines`, never a sibling absorbed directly into an ACTIVE entry this way).
   *  Every other site that copies/rebuilds an entry (`unionQuarantineEntries`,
   *  `mergeTokenIntoPendingEntries`, `protectDegradedOccupantBeforeDelete`'s own JSON whitelist, every
   *  boot-time parse) must carry whatever is already here FORWARD, but never originate a new entry here
   *  itself — and it is still NEVER inferred from a BOOT-TIME union (`armQuarantineKey`/
   *  `unionQuarantineEntries`'s own identity-differing merges), which stays card `398f476c`'s own, larger
   *  identity-model-redesign scope.
   *
   *  @decision 82032b5c (Round 6) — widened from `enterMergeQuarantine`'s `existing` branch ALONE to
   *  also cover `consumeMatchedPendingsIntoArmedEntry`'s own runtime union — see that round's own section.
   *
   *  @decision 82032b5c — do not drop this field at any copy/rebuild site; a dropped field silently
   *  re-opens the clear-by-id hard-delete this exists to refuse. */
  contributorRepoPaths?: string[];
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
  /** PERSISTED, STICKY (unlike `armedKeys`) — set when a boot-time re-entry parse finds the shape a
   *  PRE-82032b5c daemon's own defect (A) write could have produced: a runtime union whose durable write
   *  recomputed `canonicalRepoLockKey(entry.repoPath)` fresh instead of writing to the key actually in
   *  `armedKeys`, for a degraded (unresolvable) occupant — see {@link detectUnknownProvenance}'s own doc
   *  for the exact condition and 60c8052c's own pre-fix `enterMergeQuarantine`/`writeMergeQuarantineLatch`.
   *  Unlike `contributorRepoPaths`, this can NEVER name the other identity — the bytes alone cannot tell
   *  "one repo raised twice" (benign) apart from "two different repos' raises got merged" (the real
   *  defect); {@link ambiguousIdentitiesFor} treats it as ambiguous anyway (Lead ruling, card db0a9db0):
   *  a redirected clear-by-path on the rare benign case is strictly cheaper than silently lifting a
   *  different repo's own outstanding unconfirmed-kill token.
   *
   *  Detection reads only the file's OWN static signature (physical hash vs.
   *  `quarantineHashForKey(entry.resolvedKey)`, `tokens.length`, `contributorRepoPaths`,
   *  `provenanceTracked`'s absence) — never a branch-dependent fact like current resolvability, nor which
   *  PASS 1 branch (degraded/migrate/dual-arm) reached it. Once `true`, stays `true` through every
   *  copy/rebuild/carry-forward site ({@link unionQuarantineEntries} ORs it from both sides).
   *
   *  @decision db0a9db0 (round 2) — never gate detection on resolvability or on which PASS 1 branch
   *  reached it (round 1's own fix did, letting a migrate-branch boot rewrite `resolvedKey` and arm the
   *  entry UNMARKED), and never drop this field at any copy/rebuild site. */
  provenanceUnknown?: true;
  /** PERSISTED — stamped `true` by {@link writeMergeQuarantineLatch} on EVERY latch it writes, from this
   *  landing forward. Its ABSENCE is `detectUnknownProvenance`'s precision guard: a CURRENT-format file
   *  can legitimately sit at a physical hash that differs from `quarantineHashForKey(entry.resolvedKey)`
   *  (e.g. `consumeMatchedPendingsIntoArmedEntry` stamping `resolvedKey` onto an entry whose own physical
   *  file lives at a DIFFERENT, still-correct key) — without this field, that shape is byte-indistinguishable
   *  from the pre-82032b5c defect-A stray-union shape `provenanceUnknown` exists to catch.
   *
   *  @decision db0a9db0 (round 2) — a file written strictly BETWEEN `48aeb324` (82032b5c landing) and this
   *  round's own landing also lacks this field (it did not exist yet); see the decision record's own
   *  "Do not" list for the bounded false-positive this narrow window accepts. Carry this field forward at
   *  every copy/rebuild site exactly like `provenanceUnknown`. */
  provenanceTracked?: true;
  /** PERSISTED (unlike `armedKeys`) — the historical, deduped set of every OTHER key this logical entry
   *  has ever been armed at besides whichever key a given physical latch file is itself filed under,
   *  capped at {@link RESOLVED_KEYS_CAP}. Generalizes the legacy scalar `resolvedKey` (kept for backward
   *  compat) from exactly one surviving secondary key to N.
   *
   *  @decision 8db913e2 (Follow-up 43cf3b26) — see the decision record's own "Follow-up 43cf3b26" section. */
  resolvedKeys?: string[];
}

/** Cap on {@link MergeQuarantineEntry.resolvedKeys}' own length — see
 *  {@link unionResolvedKeysRetaining}'s own doc for the retention/eviction rule this enforces.
 *  @decision 8db913e2 (Follow-up 43cf3b26) — Lead-ruled cap value; see the decision record. */
const RESOLVED_KEYS_CAP = 16;

/** Unions `fresh` into `existing` (both treated as "keys this entry is, or has been, armed at"), deduped,
 *  moving a re-confirmed key to the end (most-recently-armed) — then caps the result at
 *  {@link RESOLVED_KEYS_CAP}, evicting the OLDEST (least-recently-armed) key(s) with a loud
 *  `console.error` naming `label`, the evicted count/keys, and card 43cf3b26 (never silent). A key is
 *  NEVER removed for any other reason (no verification in this file proves a key that merely fails to
 *  re-arm one boot is permanently invalid) — only a human clear or this cap ever drops one.
 *
 *  @decision 8db913e2 (Follow-up 43cf3b26) — see the decision record's own "retention rule" section. */
function unionResolvedKeysRetaining(existing: string[] | undefined, fresh: Iterable<string>, label: string): string[] {
  const ordered = [...(existing ?? [])];
  for (const k of fresh) {
    const idx = ordered.indexOf(k);
    if (idx >= 0) ordered.splice(idx, 1);
    ordered.push(k);
  }
  if (ordered.length > RESOLVED_KEYS_CAP) {
    const evicted = ordered.splice(0, ordered.length - RESOLVED_KEYS_CAP);
    // eslint-disable-next-line no-console
    console.error(`[merge-quarantine] ${label} exceeded the ${RESOLVED_KEYS_CAP}-key resolvedKeys cap — evicting ${evicted.length} least-recently-armed key(s) (${evicted.join(", ")}); see card 43cf3b26.`);
  }
  return ordered;
}

/** Parses `parsed.resolvedKeys` off a raw latch record the SAME way every reader in this file already
 *  whitelists `orphanLatchFiles`/`contributorRepoPaths` — `undefined` unless it is an array of strings.
 *  Centralized so every one of this field's many parse sites reads it identically. */
function parseResolvedKeysField(parsed: { resolvedKeys?: unknown }): string[] | undefined {
  return Array.isArray(parsed.resolvedKeys) && parsed.resolvedKeys.every((s): s is string => typeof s === "string")
    ? parsed.resolvedKeys : undefined;
}

/** EVERY informative key `entry` carries — the scalar `resolvedKey` UNIONED with the plural
 *  `resolvedKeys`, deduped — never "array else scalar". A record can legitimately carry a scalar with no
 *  array (pre-this-generalization), an array with no scalar (CR `46c5c492`'s probe2: a pending entry
 *  whose scalar was never set but whose array was), or both — this is the ONE place that reads either
 *  field without risking a caller that only checks one of them.
 *
 *  @decision 8db913e2 (Follow-up 43cf3b26, CR 46c5c492) — every scalar-only gate must route through
 *  this. See the decision record's own CR-46c5c492 section. */
function informativeKeysFor(entry: MergeQuarantineEntry): string[] {
  return [...new Set([
    ...(entry.resolvedKey !== undefined ? [entry.resolvedKey] : []),
    ...(entry.resolvedKeys ?? []),
  ])];
}

/** The candidate secondary keys a boot-time arm site should ATTEMPT to re-arm `entry` at, besides
 *  whichever key is already being handled as the primary/anchor arm (`anchorKey`) at this call site —
 *  {@link informativeKeysFor}'s own UNION (never "array else scalar"), minus `anchorKey` itself. */
function secondaryKeysToAttempt(entry: MergeQuarantineEntry, anchorKey: string): string[] {
  return informativeKeysFor(entry).filter((k) => k !== anchorKey);
}

/** ALWAYS-UNION-WHEN-INFORMATIVE: `resolvedKeys` is the deduplicated union of every informative key
 *  ({@link informativeKeysFor}) across ALL of `all` (fed through {@link unionResolvedKeysRetaining} for
 *  cap/eviction consistency with every other accumulating call site); the scalar `resolvedKey` is kept
 *  only when every input that carries one agrees (all defined scalars `===`), else left `undefined` with
 *  every key still surviving in `resolvedKeys`. Shared by every hand-rolled merge branch that combines
 *  several CURRENT-knowledge entries about the SAME identity (never a known-stale one — each call site's
 *  own doc comment states why that premise holds there). Deliberately NOT `explicitResolvedKeyRule` (its
 *  symmetric-difference exclusion assumes one side is known-stale) and NOT `excludeLiftedResolvedKey(s)`
 *  (that exists only when a protective copy read from `final` is about to be superseded by THIS SAME
 *  operation's own fresh write to `final`) — neither premise applies to a hand-rolled union of several
 *  already-current records.
 *
 *  @decision 8db913e2 (Follow-up d524d1c4) — see the decision record's own "Follow-up d524d1c4" section
 *  for the full rationale. Extracted (card 00fd29d7) so {@link divertRaiseEntry} and
 *  {@link mergeTokenIntoPendingEntries} share ONE implementation instead of two that can drift. */
function unionInformativeResolvedKeys(all: MergeQuarantineEntry[], label: string): { resolvedKey: string | undefined; resolvedKeys: string[] | undefined } {
  const resolvedKeysRaw = unionResolvedKeysRetaining(undefined, all.flatMap((e) => informativeKeysFor(e)), label);
  const resolvedKeys = resolvedKeysRaw.length > 0 ? resolvedKeysRaw : undefined;
  const scalarsPresent = all.map((e) => e.resolvedKey).filter((k): k is string => k !== undefined);
  const resolvedKey = scalarsPresent.length > 0 && scalarsPresent.every((k) => k === scalarsPresent[0]) ? scalarsPresent[0] : undefined;
  return { resolvedKey, resolvedKeys };
}

/** ALWAYS-UNION: the deduplicated union of every key any of `all` is CURRENTLY armed under, normalized
 *  back to `undefined` when that union is empty — never a cosmetic `armedKeys: []` on a record with
 *  nothing to carry there (mirrors {@link divertRaiseEntry}'s own long-standing "never a cosmetic
 *  `armedKeys: []`" rule, and {@link unionInformativeResolvedKeys}'s own normalization for the sibling
 *  field). A matched pending entry is ORDINARILY `armedKeys:undefined` (it was never armed anywhere), but
 *  it can ALSO be an 883e29bc boot-diverted TWIN — the SAME reference also armed in `activeQuarantines`
 *  under one or more keys, per decision 64283e06 — and dropping that twin's own `armedKeys` here
 *  silently orphans whichever OTHER key(s) it was armed under the moment a caller re-points every
 *  matched reference onto this merged object: the merged object then sits in `activeQuarantines` at
 *  those keys with no record of being armed there, so a later "every key this entry is armed under"
 *  walk (clear, latch rewrite) sees only the ONE key it was told about and never touches the other's
 *  physical file.
 *
 *  @decision 8db913e2 (Follow-up 3d27c045) — extracted so {@link divertRaiseEntry} and {@link mergeTokenIntoPendingEntries}
 *  share ONE implementation instead of two that can drift, same reason {@link unionInformativeResolvedKeys}
 *  was extracted for the sibling field. */
function unionArmedKeys(all: MergeQuarantineEntry[]): string[] | undefined {
  const armedKeys = [...new Set(all.flatMap((e) => e.armedKeys ?? []))];
  return armedKeys.length > 0 ? armedKeys : undefined;
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
/** @decision 702b4241 — never conflate this with {@link PLACEHOLDER_BRANCH_CORRUPT}: "could not read"
 *  (EACCES/EMFILE/...) and "read and found bad" are different facts with different safe actions. */
export const PLACEHOLDER_BRANCH_UNREADABLE = "(unknown — boot found this latch unreadable, not corrupt)";

/** `true` for an in-memory {@link MergeQuarantineEntry} (via its own `placeholder` field) OR a raw,
 *  not-yet-validated parsed-JSON object (via the legacy branch-text fallback — see the consts' own doc
 *  comment for why that fallback can never misfire on a real entry). */
function isPlaceholderEntryShape(parsed: { placeholder?: unknown; branch?: unknown }): boolean {
  return parsed.placeholder === true || parsed.branch === PLACEHOLDER_BRANCH_CORRUPT || parsed.branch === PLACEHOLDER_BRANCH_UNRESOLVED
    || parsed.branch === PLACEHOLDER_BRANCH_UNREADABLE;
}

/** @decision 702b4241 (round 2) — `true` ONLY for card 702b4241's own synthetic boot-minted placeholder
 *  (never a genuine raise, and never the CORRUPT/UNRESOLVED siblings) — the one shape {@link
 *  reconcileMarkedBasenameBeforeWrite}'s re-ingestion branch must act on. */
function isUnreadablePlaceholderEntry(entry: MergeQuarantineEntry): boolean {
  return entry.placeholder === true && entry.branch === PLACEHOLDER_BRANCH_UNREADABLE;
}

/** @decision 702b4241 (round 2) — do not fold this into PASS 1/1b/safety-tmp's own inline parses (each
 *  is independently decision-anchored); this is a deliberate, narrow duplication for ONE new caller,
 *  {@link reconcileMarkedBasenameBeforeWrite}'s re-ingestion branch, not a shared-helper refactor. */
function latchEntryFromParsedRecord(parsed: Record<string, unknown> & { repoPath: string; branch: string; reason: string }): MergeQuarantineEntry {
  const tokens = Array.isArray(parsed.tokens) && parsed.tokens.length > 0 && parsed.tokens.every((t): t is string => typeof t === "string")
    ? parsed.tokens
    : [typeof parsed.token === "string" ? parsed.token : randomUUID()];
  return {
    repoPath: parsed.repoPath, branch: parsed.branch, reason: parsed.reason,
    opId: typeof parsed.opId === "string" ? parsed.opId : undefined,
    enteredAt: typeof parsed.enteredAt === "number" ? parsed.enteredAt : Date.now(),
    tokens,
    orphanLatchFiles: Array.isArray(parsed.orphanLatchFiles) && parsed.orphanLatchFiles.every((s): s is string => typeof s === "string")
      ? parsed.orphanLatchFiles : undefined,
    resolvedKey: typeof parsed.resolvedKey === "string" ? parsed.resolvedKey : undefined,
    resolvedKeys: parseResolvedKeysField(parsed as { resolvedKeys?: unknown }),
    contributorRepoPaths: Array.isArray(parsed.contributorRepoPaths) && parsed.contributorRepoPaths.every((s): s is string => typeof s === "string")
      ? parsed.contributorRepoPaths : undefined,
    provenanceUnknown: parsed.provenanceUnknown === true ? true : undefined,
    provenanceTracked: parsed.provenanceTracked === true ? true : undefined,
  };
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

/**
 * @decision 63e49ee2 (round 5) — a fresh READ or a detector `"none"` never un-keeps a basename, from
 * ANY caller, ANY identity comparison — only a durable overwrite-by-rename or copy-aside may. See the
 * decision record's "Round 5"; the THREE call sites that may `.delete()` are each tagged with this id.
 */
const keptUnreadableLatchFiles = new Set<string>();

/**
 * @decision 702b4241 (round 4) — every synthetic `randomUUID()` {@link divertUnreadableBootLatch} ever
 * minted — never returned to a real caller, so it must be filtered from any later union (see the
 * decision record's "Round 4" section).
 */
const unreadablePlaceholderTokens = new Set<string>();

/**
 * Every token THIS PROCESS has deliberately cleared — populated EXCLUSIVELY by
 * {@link tombstoneIfNotSurviving} (round 4; never add to this `Set` directly from any other site —
 * see that function's own doc for why). Tokens are random v4 UUIDs, minted once by
 * {@link enterMergeQuarantine} and never re-minted for a different raise — so membership here can never
 * produce a false positive against a later, unrelated raise.
 *
 * Subtracted from every union of ON-DISK tokens ({@link reconcileMarkedBasenameBeforeWrite}, and so
 * transitively {@link foldInOnDiskTokensIfMarked}) so a STALE copy of `final`'s own bytes — written
 * before this process's own clear durably removed the token, then read back by a LATER reconciliation —
 * can never resurrect a token this process already knows is gone.
 *
 * In-memory only, reset on a reboot — safe: a reboot re-reads disk fresh (no earlier in-process read to
 * contradict), and a genuinely-destroyed token's own durable write already removed it from disk before
 * the process exited; a token this process kept ALIVE elsewhere (never tombstoned) is correctly re-read
 * from wherever it actually survives.
 *
 * @decision 8db913e2 (round 3, CR2 B1) — closes the fail-closed resurrection the round-2 chokepoint union
 * introduced: a partial clear's own cleared token could be read back from a STALE pre-clear copy of
 * `final` by a LATER reconciliation, even after this process's own durable write had already removed it.
 */
const clearedTokens = new Set<string>();

/**
 * @decision 8db913e2 (round 4, CR3 BLOCKER 1) — THE ONE place any token is ever added to
 * {@link clearedTokens}; every clear site calls this, never `clearedTokens.add` directly.
 *
 * For each of `tokens`, tombstones it ONLY IF, at the moment this is called, (a) NO surviving record —
 * active OR pending — still holds it, scanning the CURRENT, live state of
 * `activeQuarantines`/`pendingUnresolvedQuarantines`, AND (b) none of `touchedFinalBasenames` — every
 * physical final this clear's own write path touched for the entry/entries being cleared — is STILL
 * marked {@link keptUnreadableLatchFiles} right now. The caller MUST call this AFTER every one of its
 * own mutations to both in-memory structures is already applied (deletes, splices, in-memory rebuilds)
 * — never before, and never speculatively from a bare "this entry occupies the key being cleared" lookup.
 *
 * (a) alone is what makes this safe for a clear that ends up durably PROTECTING a foreign (or even the
 * SAME) occupant's content elsewhere (copied aside, a sibling pending record, a dual-tracked twin)
 * rather than genuinely destroying it — CR3's own Y repro, step (1): a clear's own `finalProtectOk`
 * "safe to unlink" branch can still mean "copied aside, still enforced", not "gone".
 *
 * (b) covers the DIFFERENT shape (a), alone, cannot see — CR3's own Y repro, step (3): a clear can also
 * KEEP a final because a READ failed (never confirming whose content it holds, never copying anything
 * aside, never creating any new record for (a) to find) — the in-memory entry is evicted regardless, so
 * (a)'s scan alone would wrongly conclude "nothing surviving" and tombstone content that is still
 * physically, unconfirmed, sitting at that exact kept file. This is the documented "kept until a reboot
 * or a later successful read" residual (`63e49ee2`) — ACCEPTED as fail-closed, never changed by this
 * card: see the decision record's own Round 4 "Accepted residual" note.
 *
 * A BY-TOKEN clear ({@link clearActiveEntryTokenAtKey}/{@link clearTokenFromPendingIndices}) still goes
 * through this SAME helper, passing no `touchedFinalBasenames` of its own — calling it right after that
 * clear's own in-memory token-removal (before arming any write) already makes scan (a) correctly find
 * nothing surviving (tokens are process-unique UUIDs). **Corrected (Follow-up `8db913e2`/`d6efbc9b`):**
 * this is NOT true of every by-token call site, though — `clearActiveEntryTokenAtKey`'s own last-token
 * branch (the owner's last outstanding token) hands off entirely to {@link clearMergeQuarantineByKey},
 * which DOES pass `touchedFinalBasenames` for its own, unrelated reasons. That delegated call's own
 * tombstone attempt is correctly gated by (b) for the PHYSICAL FINAL it's deciding whether to destroy —
 * but the owner's RELEASE of `token` is a separate fact that must land regardless of what (b) decides
 * about the final, so that branch makes a SECOND, unconditional call here (no touched list) right after,
 * tombstoning `token` itself unconditionally on top of the shared, gated call. This is still not a
 * special case of the single invariant above — it is the single invariant, applied twice, to two
 * different questions ("is the final destroyed" vs. "is the owner's own token gone").
 */
function tombstoneIfNotSurviving(tokens: string[], touchedFinalBasenames: string[] = []): void {
  if (tokens.length === 0) return;
  if (touchedFinalBasenames.some((b) => keptUnreadableLatchFiles.has(b))) return;
  const surviving = new Set<string>();
  for (const entry of activeQuarantines.values()) for (const t of entry.tokens) surviving.add(t);
  for (const p of pendingUnresolvedQuarantines) for (const t of p.entry.tokens) surviving.add(t);
  for (const t of tokens) if (!surviving.has(t)) clearedTokens.add(t);
}

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

/** Every PENDING entry whose own repoPath is CURRENTLY RESOLVABLE and genuinely, freshly
 *  canonically-keyed at `key` (same predicate as {@link collectCrossTierSiblingIndices}/{@link
 *  isKeyVerifiedFor}), excluding whichever entry shares `ownIdentityRepoPath`'s own {@link
 *  directPathIdentity} — i.e. a DIFFERENT, resolvable identity that right now genuinely owns this exact
 *  key, distinct from whatever is actually armed/matched there.
 *
 *  A bare latch id addressed at `key` cannot tell apart "clear the entry armed here" from "clear by the
 *  id this OTHER identity's own refusal happened to name, because this is what's blocking it" — both
 *  shapes produce the SAME id and, per {@link activeMergeQuarantineFor}'s own `direct`-wins-over-siblings
 *  tier, the SAME refusal text.
 *
 *  @decision 9a55fb90 — a non-empty result here means real ambiguity. Read via {@link
 *  ambiguousIdentitiesFor}/{@link ambiguousIdentitiesForLatchId} — the ONE shared predicate every
 *  refusal-text caller and clear-by-id itself use, so none can disagree about one given id. */
function canonicalSiblingsFor(key: string, ownIdentityRepoPath: string): PendingUnresolvedQuarantine[] {
  const ownIdentity = directPathIdentity(ownIdentityRepoPath);
  return pendingUnresolvedQuarantines.filter((p) =>
    isRepoPathCurrentlyResolvable(p.entry.repoPath) &&
    canonicalRepoLockKey(p.entry.repoPath) === key &&
    directPathIdentity(p.entry.repoPath) !== ownIdentity);
}

/**
 * Every OTHER repoPath that makes a bare latch id for `entry` (armed at `key`) ambiguous right now — the
 * ONE predicate every refusal-text caller (`assertRepoNotQuarantined`, `stillQuarantinedReason`) and the
 * actual clear-by-id route (`clearMergeQuarantineLatchFile`) all share, so none of them can ever disagree
 * about the SAME id (9a55fb90's own rule). Two independent collision shapes, kept SEPARATE (never flattened
 * into one array) because they need DIFFERENT remediation advice — see {@link remediationTextFor}:
 *  - `siblingRepoPaths` — a resolvable PENDING sibling canonically colliding at `key` ({@link
 *    canonicalSiblingsFor} — the 9a55fb90 shape). Has its OWN entry (active or pending), so clear-by-path's
 *    `repoPath` form (`clearMergeQuarantineByRecordedPath`) genuinely clears it.
 *  - `contributorRepoPaths` — an identity already folded into `entry`'s own token set at RUNTIME ({@link
 *    MergeQuarantineEntry.contributorRepoPaths} — the 82032b5c shape). Has NO entry of its own at all —
 *    `clearMergeQuarantineByRecordedPath` matches only an entry's own STORED `repoPath`, so it reports
 *    `wasQuarantined:false` for a bare contributor (measured directly, round 3 CR `77e22256`). **CORRECTED
 *    in round 4:** the project-resolved `/clear` route does NOT reliably work for one either —
 *    `clearMergeQuarantineReporting`/`clearMergeQuarantineByKey` measured a NO-OP for a PENDING entry's
 *    contributor (that route only ever scans the ACTIVE map) and, for an active RESOLVABLE entry, lifts
 *    the WHOLE union including the entry's own still-outstanding unconfirmed-kill token with no warning.
 *    No route reliably clears a bare contributor — see {@link remediationTextFor}'s own doc for the
 *    single-route text this motivated.
 * Both empty exactly when a bare id is genuinely safe to act on.
 *
 * @decision 82032b5c (round 3) — never flatten these two back into one array; they need different advice.
 *
 * @decision db0a9db0 — a THIRD, independent collision shape, `unknownProvenance`, names NO specific
 *  identity (the bytes alone can't say who else may be folded in) — see {@link
 *  MergeQuarantineEntry.provenanceUnknown}'s own doc.
 */
interface AmbiguousIdentities {
  siblingRepoPaths: string[];
  contributorRepoPaths: string[];
  unknownProvenance: boolean;
  /** Every one of the entry's OWN informative keys (other than the one it's being reported under), when
   *  itself an absolute filesystem path — see {@link unknownProvenanceKeyPathsFor}. `[]` whenever
   *  `unknownProvenance` is false, or no OTHER informative key is path-shaped (which also covers a
   *  protect-copy pending entry, whose own whitelist strips `resolvedKey`/`resolvedKeys` entirely — see
   *  `protectDegradedOccupantBeforeDelete`'s own doc). Never fabricated when a key isn't path-shaped.
   *
   *  @decision db0a9db0 (Follow-up 150aed7b) — generalized from a single scalar path to every one; the
   *  scalar alone can miss a genuinely foreign plural key, or BE a self-reference that names nothing
   *  useful while masking a real foreign key sitting in `resolvedKeys`. */
  unknownProvenanceKeyPaths: string[];
}

function totalAmbiguousCount(a: AmbiguousIdentities): number {
  return a.siblingRepoPaths.length + a.contributorRepoPaths.length + (a.unknownProvenance ? 1 : 0);
}

function ambiguousIdentitiesFor(key: string, entry: MergeQuarantineEntry): AmbiguousIdentities {
  return {
    siblingRepoPaths: canonicalSiblingsFor(key, entry.repoPath).map((p) => p.entry.repoPath),
    contributorRepoPaths: entry.contributorRepoPaths ?? [],
    unknownProvenance: !!entry.provenanceUnknown,
    unknownProvenanceKeyPaths: entry.provenanceUnknown ? unknownProvenanceKeyPathsFor(entry, key) : [],
  };
}

/** {@link ambiguousIdentitiesFor}, but keyed off a specific OFFERED latch id — for a dual-armed entry,
 *  `entry.armedKeys?.[0]` is NOT guaranteed to be the key that hashes to `latchId` ({@link
 *  quarantineLatchFileIdsFor}'s own id list is sorted real-file-first, never `armedKeys` order), so this
 *  finds the armed key that actually hashes to `latchId` first, mirroring 9a55fb90's own round 2 fix. */
function ambiguousIdentitiesForLatchId(entry: MergeQuarantineEntry, latchId: string | undefined): AmbiguousIdentities {
  const key = latchId ? (entry.armedKeys?.find((k) => quarantineHashForKey(k) === latchId) ?? entry.armedKeys?.[0]) : undefined;
  return {
    siblingRepoPaths: key ? canonicalSiblingsFor(key, entry.repoPath).map((p) => p.entry.repoPath) : [],
    contributorRepoPaths: entry.contributorRepoPaths ?? [],
    unknownProvenance: !!entry.provenanceUnknown,
    unknownProvenanceKeyPaths: entry.provenanceUnknown ? unknownProvenanceKeyPathsFor(entry, key) : [],
  };
}

/**
 * THE one shared remediation-text builder every refusal-text site uses — so a future wording change can
 * never drift between sites. Names EXACTLY ONE route: `clear-by-path` with one of `ownRepoPaths` (the
 * entry/entries actually armed/matched here) or a listed `siblingRepoPaths` entry — verified to work in
 * every shape round 4's own re-CR measured (active+resolvable, active+degraded, pending+resolvable,
 * pending+degraded). Round 3 ALSO named the project-resolved `/clear` route for a contributor; round 4
 * retracted that — the re-CR measured it a NO-OP for a PENDING entry's contributor
 * (`clearMergeQuarantineReporting` filters only by `directPathIdentity(entry.repoPath)`, so it never even
 * finds a pending entry's own contributor) AND, for an active RESOLVABLE entry, that it lifts the WHOLE
 * union — including the entry's OWN still-outstanding unconfirmed-kill token — with no warning attached
 * to that sentence. A contributor now gets ONE flat line instead: `clear-by-path` with ITS OWN path does
 * nothing (verified: matches only an entry's own stored `repoPath`); clearing by the entry's own path
 * above lifts its token too. No tier/registration branching survives in this text.
 *
 * @decision 82032b5c (round 4) — never name a route here without a test driving its real function in
 * every refusal tier the text appears in; every prior round's own branch-specific route produced a new
 * text/action mismatch in some OTHER branch the SAME round never tested.
 */
function remediationTextFor(ownRepoPaths: string[], ambiguous: AmbiguousIdentities): string {
  const clearByPathTargets = [...ownRepoPaths, ...ambiguous.siblingRepoPaths];
  // Round 5 MINOR: clearing lifts every contributor's own folded token too, so the confirm-no-process
  // clause must cover them, not just the listed clear-by-path targets.
  const confirmClause = ambiguous.contributorRepoPaths.length === 0
    ? "under ANY of the listed paths before clearing"
    : "under ANY of the listed paths, and under every contributor named below, before clearing";
  const note = `clear by repoPath instead: POST /internal/merge-quarantine/clear-by-path with one of ${JSON.stringify(clearByPathTargets)} — this lifts the WHOLE entry there, including every contributor's own folded-in token and the listed path's own outstanding unconfirmed-kill quarantine, so first confirm no process is still running ${confirmClause}`;
  const contributorSuffix = ambiguous.contributorRepoPaths.length === 0 ? "" :
    `. ${ambiguous.contributorRepoPaths.length} other identit${ambiguous.contributorRepoPaths.length === 1 ? "y" : "ies"} ` +
    `(${ambiguous.contributorRepoPaths.map((p) => `'${p}'`).join(", ")}) had their own raise folded into this union's token set at runtime — ` +
    `clear-by-path with a contributor's own path does nothing; clearing by the entry's own path above lifts its token too`;
  // @decision db0a9db0 (Follow-up 150aed7b) — names every recorded key, never just the scalar; NEVER
  // `JSON.stringify` a path here — it doubles every backslash, breaking an exact match against a real
  // Windows path (caught by `merge-quarantine-runtime-union-provenance.mjs` going RED).
  const unknownProvenanceSuffix = !ambiguous.unknownProvenance ? "" : (
    ambiguous.unknownProvenanceKeyPaths.length > 0
      ? `. This entry may also fold together raises from more than one repo from before provenance tracking existed, and clearing lifts all of them — confirm no git/hook process is still running under ${JSON.stringify(clearByPathTargets)} AND under ${ambiguous.unknownProvenanceKeyPaths.map((p) => `'${p}'`).join(", ")} (the repo(s) this entry's own recorded key(s) name) before clearing`
      : `. This entry may also fold together raises from more than one repo from before provenance tracking existed, and clearing lifts all of them — this entry's own recorded key(s) are not themselves paths (or are not recorded at all), so there is no further repo to name here beyond the listed path(s); confirm no git/hook process is still running under ${JSON.stringify(clearByPathTargets)} before clearing`
  );
  return note + contributorSuffix + unknownProvenanceSuffix;
}

/**
 * Detects the pre-82032b5c defect-(A) stray-union shape purely from `entry`'s OWN static signature —
 * `hash` (the file's physical filename hash) vs. `quarantineHashForKey(k)` for every one of `entry`'s own
 * {@link informativeKeysFor} (scalar ∪ plural — never the scalar alone) — never a branch-dependent fact
 * like current resolvability. `tokens.length > 1` is load-bearing, not incidental: one raise mints
 * exactly one token, so a single-token entry can never be a union regardless of every other condition
 * here. `provenanceTracked`'s ABSENCE is the precision guard: a CURRENT-format file can legitimately sit
 * at a hash differing from one of its own keys' hash (a dual-armed same-identity entry) without ever
 * being the defect this detects — see both fields' own doc comments.
 *
 * @decision db0a9db0 (round 2) — call this ONCE, immediately after parsing, BEFORE any branch dispatch
 * (degraded-divert / migrate / dual-arm) and BEFORE any field on `entry` is mutated — see the decision
 * record's own round-2 section for the migrate-branch fail-open this ordering closes.
 *
 * @decision db0a9db0 (Follow-up 150aed7b) — generalized from the scalar `resolvedKey` alone to every
 * `informativeKeysFor` key; an array-only record used to short-circuit before the hash check ever ran.
 * See the decision record's own section.
 */
function detectUnknownProvenance(entry: MergeQuarantineEntry, hash: string): boolean {
  if (entry.provenanceUnknown) return true;
  if (entry.provenanceTracked) return false;
  const keys = informativeKeysFor(entry);
  if (keys.length === 0) return false;
  if (entry.tokens.length <= 1) return false;
  if (entry.contributorRepoPaths && entry.contributorRepoPaths.length > 0) return false;
  return keys.some((k) => quarantineHashForKey(k) !== hash);
}

/** `canonicalRepoLockKey` always returns a filesystem path today (realpath of a resolved `.git` toplevel,
 *  or the nearest existing ancestor — see that function's own doc, repo-lock.ts) — never a hash or other
 *  opaque token. This guards rather than assumes: {@link remediationTextFor} must never fabricate a path
 *  to name in a refusal, so a caller that cannot confirm `key` is genuinely path-shaped gets `undefined`
 *  back instead of a best-guess string. */
function absoluteKeyPathOrUndefined(key: string | undefined): string | undefined {
  return typeof key === "string" && path.isAbsolute(key) ? key : undefined;
}

/** Every one of `entry`'s own {@link informativeKeysFor} that is ITSELF absolute-path-shaped, excluding
 *  `ownKey` (there is nothing "foreign" about an entry's own key — never worth naming). `ownKey` omitted
 *  falls back to every informative key (the pending tier has no single armed key to exclude by).
 *
 * @decision db0a9db0 (Follow-up 150aed7b) — THE one shared helper every remediation-text site uses; a
 * scalar-only re-derivation at each site is exactly how this card's own asymmetry happened. See the
 * decision record's own section. */
function unknownProvenanceKeyPathsFor(entry: MergeQuarantineEntry, ownKey?: string): string[] {
  const candidates = ownKey !== undefined ? secondaryKeysToAttempt(entry, ownKey) : informativeKeysFor(entry);
  return [...new Set(candidates.map((k) => absoluteKeyPathOrUndefined(k)).filter((p): p is string => p !== undefined))];
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
 * `true` iff `value` is a JSON.parse() result safe to property-access AS A RECORD — array or plain
 * object, never `null` and never a bare scalar (number/string/boolean). The CRASH this guard exists to
 * close is narrower than what it actually excludes: `JSON.parse("null")` succeeds and returns `null`,
 * and `parsed.repoPath`/`parsed.tokens` on `null` is the ONLY property read in this module that throws —
 * a scalar top-level value (`JSON.parse("5")`, `JSON.parse('"x"')`, `JSON.parse("true")`) is already safe
 * to property-access, returning `undefined` for a missing field, same as an array or plain object. This
 * guard rejects scalars anyway (`typeof value === "object"` is false for all three), which is a REAL,
 * deliberate behavior change at exactly two call sites that read on-disk tokens with no OTHER check ahead
 * of it — `markedFinalFullyCoveredByClear` and `orphanFileTokensAccountedForByUpdate` (see each site's own
 * doc comment, below): a latch whose content is a bare scalar used to make `readSurvivingOnDiskTokens`
 * return an empty token array, which both callers' own `.every(...)` then read as VACUOUSLY covered/
 * accounted-for (fail-OPEN) — now `isReadableLatchRecord` rejects it before `readSurvivingOnDiskTokens`
 * is ever reached, so both callers instead return "cannot prove this" (fail-CLOSED, strictly SAFER, never
 * a regression — just not something to leave undocumented as a side effect of the null-crash fix). An
 * array or `{}` still passes this guard unchanged, at every site (pre- and post-fix): every OTHER site in
 * this module already had its own `typeof parsed.repoPath === "string"` (or equivalent) check ahead of
 * any token read, and a scalar already failed THAT check identically before this guard existed — so this
 * guard changes nothing for a scalar anywhere except the two sites named above.
 *
 * Every `JSON.parse(raw)` site in this module already guards the PARSE call itself with a try/catch for
 * corrupt/unparsable text — this guard closes the gap one line later, before the first property read.
 *
 * @decision 8db913e2 (Follow-up 495fd320) — see the decision record.
 */
function isReadableLatchRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Reads a quarantine latch file at `absolutePath` and returns the {@link directPathIdentity} of its OWN
 * recorded `repoPath` field — `undefined` when the file is missing, unparsable, or has no `repoPath`
 * field at all. Never throws.
 *
 * @decision d163aef5 (round 5) — the primitive the clear-side primary check uses to tell "this file's
 * content genuinely belongs to identity X" from "some entry merely CLAIMS this filename as its own
 * `sourceFile`" (a claim that can be wrong) — the file's own on-disk `repoPath` is the ground truth.
 */
function quarantineFileRepoPathIdentity(absolutePath: string): string | undefined {
  let raw: string;
  try { raw = fs.readFileSync(absolutePath, "utf8"); } catch { return undefined; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return undefined; }
  if (!isReadableLatchRecord(parsed)) return undefined; // e.g. the bare literal `null`
  return typeof parsed.repoPath === "string" ? directPathIdentity(parsed.repoPath) : undefined;
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

/**
 * `true` iff `key`'s own freshly-hashed value still equals `hash` — i.e. whatever currently resolves to
 * `key` genuinely owns the latch filename `hash` names, never merely a LEGACY-tier `hashToRepo` match
 * whose matched repo has since walked up (lost its own `.git`) to a DIFFERENT, ancestor key. Factored out
 * of the PASS 1 migrate branch's own check (8bff3cae/3a9e0027) so the deferred corrupt-`.json`/corrupt-tmp
 * resolution loops (card 4783df46) can share the IDENTICAL verification rather than each hand-rolling it.
 *
 * @decision 4783df46 — a FALSE result arms at `key` anyway and sets `provenanceUnknown`; it must never
 * divert to pending instead — see the decision record for why that "obvious" fix doesn't work.
 */
function legacyMatchStillResolvesToHash(key: string, hash: string): boolean {
  return quarantineHashForKey(key) === hash;
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
 *
 * @decision 8db913e2 (Follow-up 4b06875f, Round 3) — `options.explicitResolvedKeyRule` defaults OFF,
 * SEMANTICALLY (never byte-) equivalent to the pre-card `{...older}` spread — see the decision record
 * for the boot fail-open an unscoped rule reproduces.
 */
function unionQuarantineEntries(a: MergeQuarantineEntry, b: MergeQuarantineEntry, options?: { explicitResolvedKeyRule?: boolean }): MergeQuarantineEntry {
  const aIsPlaceholder = isPlaceholderEntryShape(a);
  const bIsPlaceholder = isPlaceholderEntryShape(b);
  const [older, newer] = aIsPlaceholder !== bIsPlaceholder
    ? (aIsPlaceholder ? [b, a] : [a, b])
    : (a.enteredAt <= b.enteredAt ? [a, b] : [b, a]);
  const orphanLatchFiles = older.orphanLatchFiles || newer.orphanLatchFiles
    ? [...new Set([...(older.orphanLatchFiles ?? []), ...(newer.orphanLatchFiles ?? [])])]
    : undefined;
  const armedKeys = [...new Set([...(older.armedKeys ?? []), ...(newer.armedKeys ?? [])])];
  // @decision 82032b5c — carry `contributorRepoPaths` forward from BOTH sides (never originate a new
  // entry here) — see that field's own doc comment for why this call site must not infer one itself.
  const contributorRepoPaths = older.contributorRepoPaths || newer.contributorRepoPaths
    ? [...new Set([...(older.contributorRepoPaths ?? []), ...(newer.contributorRepoPaths ?? [])])]
    : undefined;
  // @decision db0a9db0 — OR, never AND: sticky once either side carries it (see the field's own doc).
  const provenanceUnknown = older.provenanceUnknown || newer.provenanceUnknown ? true : undefined;
  // @decision db0a9db0 (round 2) — same OR, same carry-forward posture, for the precision-guard field.
  const provenanceTracked = older.provenanceTracked || newer.provenanceTracked ? true : undefined;
  // @decision 8db913e2 (Follow-up 43cf3b26, CR 4c59172f round 2, MAJOR) — SET semantics over A/B =
  // informativeKeysFor(older/newer), not scalar-only: either empty ⇒ union everything; both non-empty ⇒
  // keep the intersection, exclude the whole symmetric difference. See the decision record's Round 3.
  const olderInformativeKeys = informativeKeysFor(older);
  const newerInformativeKeys = informativeKeysFor(newer);
  const symmetricKeyDifference = olderInformativeKeys.length > 0 && newerInformativeKeys.length > 0
    ? new Set([
        ...olderInformativeKeys.filter((k) => !newerInformativeKeys.includes(k)),
        ...newerInformativeKeys.filter((k) => !olderInformativeKeys.includes(k)),
      ])
    : new Set<string>();
  const explicitRuleFailedClosed = !!options?.explicitResolvedKeyRule && symmetricKeyDifference.size > 0;
  const conflictExclusions = explicitRuleFailedClosed ? symmetricKeyDifference : undefined;
  // @decision 8db913e2 (Follow-up 4b06875f, Round 2/3) — EXPLICIT rule, opt-in ONLY: equal ⇒ keep it; one
  // side undefined ⇒ keep the other UNLESS it lost the SET arbitration above; both DIFFERENT ⇒ `undefined`.
  // Every other caller keeps the legacy `older.resolvedKey`.
  const resolvedKey = !options?.explicitResolvedKeyRule ? older.resolvedKey
    : older.resolvedKey === newer.resolvedKey ? older.resolvedKey
    : older.resolvedKey === undefined
      ? (newer.resolvedKey !== undefined && conflictExclusions?.has(newer.resolvedKey) ? undefined : newer.resolvedKey)
    : newer.resolvedKey === undefined
      ? (conflictExclusions?.has(older.resolvedKey) ? undefined : older.resolvedKey)
    : undefined;
  const filterConflicts = (keys: string[] | undefined): string[] =>
    conflictExclusions ? (keys ?? []).filter((k) => !conflictExclusions.has(k)) : (keys ?? []);
  const resolvedKeysRaw = unionResolvedKeysRetaining(
    filterConflicts(older.resolvedKeys),
    [...filterConflicts(newer.resolvedKeys), ...(!conflictExclusions && older.resolvedKey !== undefined ? [older.resolvedKey] : []), ...(!conflictExclusions && newer.resolvedKey !== undefined ? [newer.resolvedKey] : [])],
    `unionQuarantineEntries(${older.repoPath})`,
  );
  const resolvedKeys = resolvedKeysRaw.length > 0 ? resolvedKeysRaw : undefined;
  return { ...older, tokens: [...new Set([...older.tokens, ...newer.tokens])], orphanLatchFiles, armedKeys, contributorRepoPaths, provenanceUnknown, provenanceTracked, resolvedKey, resolvedKeys };
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

/** True iff `entry.resolvedKey` is a genuinely informative secondary key for `key` — defined, and NOT
 *  equal to `key` itself (a self-referential/no-second-arm marker). `entry` may be `undefined` (no prior
 *  occupant at all), which is never informative. Shared by every self-vs-informative arbitration site in
 *  this file (`armQuarantineKey`'s own 48bda567 correction, the PHASE 2 promote-site 1e739f4a fix) so
 *  they can never drift apart on what "informative" means. */
function isInformativeKey(entry: MergeQuarantineEntry | undefined, key: string): boolean {
  return entry?.resolvedKey !== undefined && entry.resolvedKey !== key;
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
 *  `entry`), never absolute — see the decision record for the M-1 fix and why M-2 stays excluded.
 *
 *  @decision 8db913e2 (Follow-up 48bda567) — never widen this correction beyond this one call site
 *  (never a second `unionQuarantineEntries` option, never persist `armedKeys` to fix it instead) — see
 *  the decision record for the age-dependent dual-arm loss this closes and why it stays scoped here. */
function armQuarantineKey(byRepoKey: Map<string, MergeQuarantineEntry>, key: string, entry: MergeQuarantineEntry): MergeQuarantineEntry {
  const prior = byRepoKey.get(key);
  let merged = prior ? unionQuarantineEntries(prior, entry) : entry;
  if (merged.resolvedKey === key) {
    const priorInformative = isInformativeKey(prior, key);
    const entryInformative = isInformativeKey(entry, key);
    if (priorInformative !== entryInformative) {
      merged = { ...merged, resolvedKey: priorInformative ? prior!.resolvedKey : entry.resolvedKey };
    }
  }
  const armed: MergeQuarantineEntry = { ...merged, armedKeys: [...new Set([...(merged.armedKeys ?? []), key])] };
  if (prior && directPathIdentity(prior.repoPath) === directPathIdentity(armed.repoPath)) {
    replaceEntryEverywhere(byRepoKey, prior, armed);
  }
  for (const k of armed.armedKeys ?? [key]) byRepoKey.set(k, armed);
  return armed;
}

/** Test-only pass-through to {@link armQuarantineKey}. The "both sides informative and different"
 *  shape this card's own correction must NOT engage for IS reachable through a real call site — a
 *  secondary-arm caller (e.g. `:4562`) passes the PRIMARY arm's own RESULT as `entry`, not the raw parsed
 *  entry, so if that primary arm itself unioned with an older `prior`, the result's `resolvedKey` can
 *  differ from the raw entry's own field used as `key`; PASS 1b also primary-arms every tmp residue at
 *  its own `currentKey`, so a `.json` + `.tmp` pair (or two tmps) sharing one hash can collide there with
 *  two independently-informative keys. Card `8db913e2` (Follow-up `1e739f4a`) fixed the promote-site
 *  self-stamp that used to mask this outcome, but deliberately did NOT attempt recovery for the
 *  collision itself — it is logged (never silent) and left as a fail-open residual card `43cf3b26` owns.
 *  This function is still exercised directly here, with a hand-built fixture, rather than through that
 *  boot path — not because the shape is unreachable, but because this is a REGRESSION PIN on the
 *  correction's own outer guard (`merged.resolvedKey === key`), not evidence the correction discriminates
 *  anything; see the scenario's own comment for why. */
export function armQuarantineKeyTestOnly(byRepoKey: Map<string, MergeQuarantineEntry>, key: string, entry: MergeQuarantineEntry): MergeQuarantineEntry {
  return armQuarantineKey(byRepoKey, key, entry);
}

/**
 * @decision 63e49ee2 — tri-state result for a read-and-identify probe against a quarantine latch file's
 * on-disk content; `"unknown"` (a read failure other than ENOENT) is treated like `"occupant"`, never
 * `"none"`, by every caller below. See the decision record for the fail-open this replaces.
 */
type OccupantReadResult = { state: "occupant"; repoPath: string } | { state: "none" } | { state: "unknown" };

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
 * Used by {@link wouldOverwriteDifferentUnresolvableOccupant} (gates a WRITE — refuses it outright,
 * `protectResolvableToo: false`, unchanged) AND, since card `c9114934`, by {@link
 * protectDegradedOccupantBeforeDelete} (gates a CLEAR's own unconditional unlink — never refuses it, only
 * copies the occupant's own content aside first, right before the delete that would otherwise destroy it
 * as collateral). The two callers answer this SAME question for two different consequences — a write
 * that refuses outright vs. a delete that proceeds anyway and must not destroy the occupant's only copy —
 * never confuse one caller's semantics for the other's.
 *
 * @decision e1cb7d33 — see the decision record (the WRITE-side refusal; `protectResolvableToo` never
 * widens this side — a resolvable different occupant's leftover stays legitimately overwritable there).
 * @decision c9114934 (round 3, FAIL CLOSED) — this function's own result alone IS the clear-side
 * decision now — `protectDegradedOccupantBeforeDelete` protects every hit, unconditionally.
 * @decision d163aef5 (round 3) — `protectResolvableToo` (clear-side only, default false): a RESOLVABLE
 * entry's OWN file can end up backing an unresolvable winner's walked-up key, never rewritten there this
 * boot — clearing that winner must not destroy it either. See the decision record's "Round 3" repro.
 *
 * @decision 63e49ee2 — returns a tri-state {@link OccupantReadResult}: a read failure other than ENOENT
 * is `"unknown"`, never `"none"` — see the decision record for the fail-open this replaces.
 */
function differentUnresolvableOccupantRepoPathAt(final: string, ownIdentityRepoPath: string, protectResolvableToo = false): OccupantReadResult {
  let existingRaw: string;
  try {
    existingRaw = fs.readFileSync(final, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { state: "none" }; // missing — nothing to protect
    return { state: "unknown" }; // read failed for a reason other than missing
  }
  let existing: unknown;
  try {
    existing = JSON.parse(existingRaw);
  } catch {
    return { state: "none" }; // corrupt — nothing to protect
  }
  if (!isReadableLatchRecord(existing)) return { state: "none" }; // e.g. the bare literal `null`
  if (typeof existing.repoPath !== "string") return { state: "none" };
  if (directPathIdentity(existing.repoPath) === directPathIdentity(ownIdentityRepoPath)) return { state: "none" }; // same identity
  // "different but resolvable" is the write-side's own today's-behavior exclusion (e1cb7d33) — but the
  // clear-side (`protectResolvableToo: true`) must NOT share it; see this function's own doc for why.
  if (!protectResolvableToo && isRepoPathCurrentlyResolvable(existing.repoPath)) {
    // @decision 8db913e2 (Follow-up 0dc514dc) — "resolvable ⇒ safe" assumes the occupant's own backing lives at ITS OWN key —
    // false if an earlier graduation write there failed. Content-based, reusing THIS read (never a
    // second one): only a real token overlap with a surviving OTHER entry means this file is load-bearing.
    const { surviving } = readSurvivingOnDiskTokens(existing);
    if (survivingTokenHolderRepoPaths(surviving, directPathIdentity(ownIdentityRepoPath), final).length === 0) return { state: "none" };
    return { state: "occupant", repoPath: existing.repoPath };
  }
  return { state: "occupant", repoPath: existing.repoPath };
}

/**
 * The CLEAR-side twin of {@link differentUnresolvableOccupantRepoPathAt}, for when `clearedEntry`'s own
 * claim to this key could be a degraded, tautological walk-up that never actually wrote `final`.
 *
 * @decision d163aef5 (round 3) — token OVERLAP, never repoPath identity, discriminates a genuine union
 * (safe — already in `clearedEntry.tokens`) from a truly foreign raise (protect); a repoPath compare
 * false-positived on the former (merge-quarantine-unresolvable-path.mjs's UNION-KEYS repro).
 *
 * @decision d2582692 — `clearIdentity`, when given, is a second, independent skip: `final` genuinely
 * belonging to the CLEAR'S OWN REQUESTER (never to `clearedEntry`, the in-memory entry merely ARMED at
 * this key) is never foreign data to protect. See the decision record.
 *
 * @decision 63e49ee2 — returns a tri-state {@link OccupantReadResult}: a read failure other than ENOENT
 * is `"unknown"`, never `"none"` — see the decision record for the fail-open this replaces.
 */
function unincorporatedOccupantRepoPathAt(final: string, clearedEntry: MergeQuarantineEntry, clearIdentity?: string): OccupantReadResult {
  let existingRaw: string;
  try {
    existingRaw = fs.readFileSync(final, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { state: "none" }; // missing — nothing to protect
    return { state: "unknown" }; // read failed for a reason other than missing
  }
  let existing: unknown;
  try {
    existing = JSON.parse(existingRaw);
  } catch {
    return { state: "none" }; // corrupt — nothing to protect
  }
  if (!isReadableLatchRecord(existing)) return { state: "none" }; // e.g. the bare literal `null`
  if (typeof existing.repoPath !== "string") return { state: "none" };
  if (directPathIdentity(existing.repoPath) === directPathIdentity(clearedEntry.repoPath)) return { state: "none" }; // same identity
  if (clearIdentity && directPathIdentity(existing.repoPath) === clearIdentity) return { state: "none" }; // genuinely the clearer's own data
  // @decision 8db913e2 (Follow-up 25f6a7dc) — route through the SHARED reader, never a re-derived inline parser: skipping its
  // empty-array-falls-back-to-legacy-`token` fix here wrongly treats an already-incorporated legacy token
  // as foreign, minting a redundant protect copy-aside. See the decision record.
  const { raw: existingTokens } = readSurvivingOnDiskTokens(existing);
  if (existingTokens.length > 0 && existingTokens.some((t) => clearedEntry.tokens.includes(t))) return { state: "none" }; // already incorporated
  return { state: "occupant", repoPath: existing.repoPath };
}

/**
 * Boolean, write-side wrapper of {@link differentUnresolvableOccupantRepoPathAt} — logs its refusal ONCE
 * per `(final, occupant identity)` pair per process (see {@link loggedDegradedOccupantRefusals}), never
 * once per query — a refusal recurs on every subsequent query of the identity that triggered it, for the
 * lifetime of the process.
 *
 * @decision e1cb7d33 — see the decision record.
 *
 * @decision 63e49ee2 — an `"unknown"` read result (a non-ENOENT read failure) refuses the write exactly
 * like a confirmed occupant — never like `"none"`. See the decision record.
 */
function wouldOverwriteDifferentUnresolvableOccupant(final: string, entry: MergeQuarantineEntry): boolean {
  const result = differentUnresolvableOccupantRepoPathAt(final, entry.repoPath);
  if (result.state === "none") return false;
  const dedupeKey = result.state === "unknown" ? `${final}|unknown` : `${final}|${directPathIdentity(result.repoPath)}`;
  if (!loggedDegradedOccupantRefusals.has(dedupeKey)) {
    loggedDegradedOccupantRefusals.add(dedupeKey);
    if (result.state === "unknown") {
      // eslint-disable-next-line no-console
      console.error(`[merge-quarantine] refusing to write ${path.basename(final)} for ${entry.repoPath} — this key's own physical file could not be read (for a reason other than being missing) to confirm whether it holds a different, unresolvable entry's own exclusive backing; treating this as UNKNOWN and refusing to overwrite rather than risk destroying foreign content. ${entry.repoPath} stays enforced in-memory only for this process; a later boot (or this process successfully re-reading the file) can resolve it. (Logged once per key per process — this refusal recurs on every subsequent query.)`);
    } else {
      // eslint-disable-next-line no-console
      console.error(`[merge-quarantine] refusing to write ${path.basename(final)} for ${entry.repoPath} — this key's own physical file is a DIFFERENT, currently-unresolvable entry's own exclusive backing (${result.repoPath}); overwriting it would destroy that entry's only durable copy. ${entry.repoPath} stays enforced in-memory only for this process; a later boot (or this process re-reading the file) can still recover ${result.repoPath}'s own data untouched. (Logged once per key+occupant per process — this refusal recurs on every subsequent query.)`);
    }
  }
  return true;
}

/**
 * THE shared on-disk-token reader every caller that might resurrect a token from `final`'s own raw bytes
 * goes through — parses `parsed.tokens` (array form) with `parsed.token` (legacy singular) as a fallback,
 * then subtracts every {@link clearedTokens} token THIS PROCESS has already deliberately cleared. `raw`
 * is the on-disk array BEFORE that subtraction (empty when neither field parses) — a caller that needs to
 * know "every real on-disk token was already released" (never "there happened to be none at all") reads
 * `raw.length` itself rather than re-deriving it from `surviving.length === 0`, which is ambiguous between
 * the two. `surviving` is `raw` with every tombstoned token removed — this is what a resurrection union
 * must use.
 *
 * @decision 8db913e2 (Follow-up 7a7e041b) — route every on-disk-token read through this ONE reader; a caller that re-parses
 * `tokens`/`token` independently skips the subtraction and can resurrect an already-cleared token.
 *
 * @decision 8db913e2 (Follow-up 5b55149b) — an EMPTY `tokens` array also falls back to legacy `token`, never treated as a
 * valid (if empty) array. See the decision record's Follow-up section.
 */
function readSurvivingOnDiskTokens(parsed: { tokens?: unknown; token?: unknown }): { raw: string[]; surviving: string[] } {
  const raw = Array.isArray(parsed.tokens) && parsed.tokens.length > 0 && parsed.tokens.every((t): t is string => typeof t === "string")
    ? parsed.tokens
    : typeof parsed.token === "string" ? [parsed.token] : [];
  // @decision 8db913e2 (round 3) — never let a stale on-disk copy resurrect a token THIS PROCESS already
  // deliberately cleared; see clearedTokens' own doc comment for why subtracting it here is safe.
  return { raw, surviving: raw.filter((t) => !clearedTokens.has(t)) };
}

/**
 * `final`'s own on-disk SURVIVING tokens (via {@link readSurvivingOnDiskTokens}), or `[]` for ENOENT/
 * EISDIR (nothing real there), any other read failure, or corrupt/unparseable JSON — every one of those
 * is already governed by this module's OTHER, identity/reference-based protect checks; this helper feeds
 * ONLY the purely content-based {@link survivingTokenHolderRepoPaths} check below, which never needs to
 * (and must not) distinguish those cases itself.
 *
 * @decision 8db913e2 (Follow-up 0dc514dc) — see the decision record's Follow-up section.
 */
function readFinalOnDiskSurvivingTokens(final: string): string[] {
  let raw: string;
  try { raw = fs.readFileSync(final, "utf8"); } catch { return []; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!isReadableLatchRecord(parsed)) return []; // e.g. the bare literal `null`
  return readSurvivingOnDiskTokens(parsed).surviving;
}

/**
 * `true` iff `entry` has an INDEPENDENT, confirmed-on-disk backing for `token` at one of its OWN
 * `armedKeys` OTHER than `excludeFinalPath` — a real file exists there right now, names the SAME
 * identity, and still carries `token`. Never checks `excludeFinalPath` itself — that would
 * tautologically "confirm" a stale leftover using its own soon-to-be-destroyed/overwritten bytes.
 *
 * @decision 8db913e2 (Follow-up 0dc514dc, Round 2, CR 582ce5a9) — see the decision record's open-question follow-up: a
 * RESOLVABLE occupant's own content check must not flag a genuinely STALE leftover when that same
 * occupant is ALREADY durably, independently backed elsewhere (e.g. properly migrated to its own key).
 */
function confirmedDurableBackingElsewhere(entry: MergeQuarantineEntry, token: string, excludeFinalPath: string): boolean {
  for (const key of entry.armedKeys ?? []) {
    const candidateFinal = quarantinePathForKey(key);
    if (candidateFinal === excludeFinalPath) continue;
    let raw: string;
    try { raw = fs.readFileSync(candidateFinal, "utf8"); } catch { continue; }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { continue; }
    if (!isReadableLatchRecord(parsed)) continue; // e.g. the bare literal `null`
    if (typeof parsed.repoPath !== "string" || directPathIdentity(parsed.repoPath) !== directPathIdentity(entry.repoPath)) continue;
    if (readSurvivingOnDiskTokens(parsed).surviving.includes(token)) return true;
  }
  return false;
}

/**
 * repoPaths of every SURVIVING active or pending entry — other than `excludeIdentity` ({@link
 * directPathIdentity}) — that currently holds ANY of `tokens`. Purely CONTENT-based: unlike {@link
 * survivingSharedClaimRepoPaths}, this never looks at `orphanLatchFiles`/`sourceFile` references at all
 * (`9cabd143` bans a reference-based veto) — it answers "does some OTHER entry's own in-memory token set
 * still include one of these exact token strings", regardless of whether that entry has ever heard of
 * the physical file these tokens were just read from. Excluding by IDENTITY (never by object reference)
 * so every record sharing the raiser/clearer's own identity — an active entry and a pending twin alike —
 * is correctly treated as "the one being cleared or raised," never as a foreign survivor of itself.
 *
 * `excludeFinalPath`, when given, additionally excludes an ACTIVE entry whose every matched token is
 * ALREADY confirmed durably backed at one of its OWN other `armedKeys` (see {@link
 * confirmedDurableBackingElsewhere}) — optional, and every existing caller that omits it keeps today's
 * behavior byte-identical.
 *
 * @decision 8db913e2 (Follow-up 0dc514dc) — see the decision record. Must NOT fire when the only on-disk token is the clearer/
 * raiser's own (e.g. `95ea8d3f-r3-orphanref`, where `bToken` is held only by B, which is being cleared).
 */
function survivingTokenHolderRepoPaths(tokens: string[], excludeIdentity: string, excludeFinalPath?: string): string[] {
  if (tokens.length === 0) return [];
  const owners = new Set<string>();
  for (const entry of activeQuarantines.values()) {
    if (directPathIdentity(entry.repoPath) === excludeIdentity) continue;
    const matched = entry.tokens.filter((t) => tokens.includes(t));
    if (matched.length === 0) continue;
    if (excludeFinalPath && matched.every((t) => confirmedDurableBackingElsewhere(entry, t, excludeFinalPath))) continue;
    owners.add(entry.repoPath);
  }
  for (const p of pendingUnresolvedQuarantines) {
    if (directPathIdentity(p.entry.repoPath) === excludeIdentity) continue;
    if (p.entry.tokens.some((t) => tokens.includes(t))) owners.add(p.entry.repoPath);
  }
  return [...owners];
}

/**
 * THE chokepoint for a MARKED basename ({@link keptUnreadableLatchFiles}) about to be renamed over by
 * ANY call to {@link writeMergeQuarantineLatch} — a raise, a lazy-graduation, a sibling-consume, or a
 * partial-clear rewrite all funnel through this one check, so none of them can independently reintroduce
 * the shape this closes. The mark means SOME earlier read of `final` failed — a later caller's own
 * successful read (same identity, "none") proves only that read worked, never that nothing was lost from
 * memory in between — the same "same identity is not same content" lesson round 5 of `63e49ee2` already
 * learned, applied here at the write side instead of the read side.
 *
 * Returns `entry` unchanged when there is nothing to protect or carry forward (ENOENT, EISDIR, corrupt,
 * a different identity — the pre-existing write-side guard, or `enterMergeQuarantine`'s own divert
 * decision for a skipped-guard raise, already govern those cases); returns `entry` UNIONED with
 * `final`'s own on-disk tokens AND informative keys when a fresh read confirms the SAME identity
 * physically sitting there right now (closing the same-identity-overwrite-loses-tokens shape, at the one
 * place every writer goes through); returns the literal string `"unreadable"` when `final` is a
 * genuinely unreadable FILE (not a directory) RIGHT NOW — the caller decides what that means for its own
 * write (see {@link writeMergeQuarantineLatch}'s own call site).
 *
 * @decision 8db913e2 (round 2) — the chokepoint round 1 was missing: its union lived only inside
 * `enterMergeQuarantine`, so a DIFFERENT writer reaching the SAME marked basename (lazy graduation, via
 * {@link consumeMatchedPendingsIntoArmedEntry}) lost whatever only `final`'s own bytes still held.
 *
 * @decision 8db913e2 (Follow-up 150aed7b) — also folds the on-disk record's own
 * {@link informativeKeysFor}, not just `tokens`; dropping them here silently unblocked a dual-armed
 * entry's own secondary worktrees after the next reboot. See the decision record's own section.
 *
 * @decision 2dd97aaa (Follow-up 58957b1e) — `droppedTokens` (REQUIRED, same posture as
 * {@link writePendingDivertFile}'s own parameter): this union only consulted the global `clearedTokens`
 * tombstone before. See the decision record.
 */
function reconcileMarkedBasenameBeforeWrite(final: string, entry: MergeQuarantineEntry, droppedTokens: ReadonlySet<string>): MergeQuarantineEntry | "unreadable" {
  let raw: string;
  try {
    raw = fs.readFileSync(final, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // EISDIR: `final` is a DIRECTORY, which can never hold valid latch content in this module — this is
    // deliberately NOT treated the same as a genuinely unreadable file. Safe because boot's own recovery
    // only ever reads the top level of MERGE_QUARANTINE_DIR as plain files (never descends into a
    // directory entry there), and a rename can never replace an existing non-empty directory — so a
    // directory blocker can only ever be an obstruction, never a quarantine's own backing content, and
    // the pre-existing tmp-residue-on-failed-write mechanism already handles the obstruction case safely.
    if (code === "ENOENT" || code === "EISDIR") return entry;
    return "unreadable"; // a real file exists but cannot be read right now — never overwrite blind
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return entry; } // corrupt — nothing usable
  if (!isReadableLatchRecord(parsed)) return entry; // e.g. the bare literal `null` — nothing usable
  if (typeof parsed.repoPath !== "string") return entry;
  if (directPathIdentity(parsed.repoPath) !== directPathIdentity(entry.repoPath)) return entry; // a different identity — the pre-existing guard/protect rules already govern this
  // @decision 702b4241 (round 2) — when `entry` is itself card 702b4241's own UNREADABLE placeholder,
  // the generic token-only union below is the WRONG direction: RE-INGEST the on-disk record WHOLESALE
  // instead, or the placeholder's own synthetic branch/reason durably wins over genuine recovered data.
  if (isUnreadablePlaceholderEntry(entry) && !isPlaceholderEntryShape(parsed)
    && typeof parsed.branch === "string" && typeof parsed.reason === "string") {
    const reingested = latchEntryFromParsedRecord(parsed as Record<string, unknown> & { repoPath: string; branch: string; reason: string });
    const finalOwnHashForReingest = path.basename(final, ".json");
    // @decision db0a9db0 (round 4) — run the SAME detector every other re-parse site uses, on the
    // REINGESTED record (its own disk-sourced keys), before anything below overrides them — never force
    // `provenanceTracked: true` here; see db0a9db0's own "only writeMergeQuarantineLatch stamps it" rule.
    const reingestedUnknownProvenance = detectUnknownProvenance(reingested, finalOwnHashForReingest);
    const onDiskKeysForReingest = informativeKeysFor(reingested).filter((k) => quarantineHashForKey(k) !== finalOwnHashForReingest);
    // @decision 702b4241 (round 5) — union `entry`'s own tokens forward too, never drop them wholesale:
    // `entry` can ALREADY carry a REAL raiser's own token (unioned in via `divertRaiseEntry` before this
    // basename ever became readable), not just the placeholder's bare synthetic one — see "Round 5" below.
    // @decision 702b4241 (round 4) — but filter OUT every {@link unreadablePlaceholderTokens} member: that
    // specific synthetic token was never returned to a real caller and must never ride into the union,
    // even on the plain query-after-boot path where `entry.tokens` holds nothing else at all.
    return {
      ...reingested,
      // @decision 2dd97aaa (Follow-up 58957b1e) — filter `droppedTokens` AFTER the union, same posture
      // as writePendingDivertFile's own re-read-and-union branch.
      tokens: [...new Set([...entry.tokens.filter((t) => !unreadablePlaceholderTokens.has(t)), ...reingested.tokens])].filter((t) => !droppedTokens.has(t)),
      resolvedKey: entry.resolvedKey,
      resolvedKeys: onDiskKeysForReingest.length > 0
        ? unionResolvedKeysRetaining(entry.resolvedKeys, onDiskKeysForReingest, `reconcileMarkedBasenameBeforeWrite-reingest(${entry.repoPath})`)
        : entry.resolvedKeys,
      armedKeys: entry.armedKeys,
      // @decision 4913e721 — OR in `entry`'s own (caller's live) mark too, never disk-only: the old code
      // discarded it outright, the same drop class db0a9db0's "carry forward at EVERY copy site" forbids.
      provenanceUnknown: reingestedUnknownProvenance || entry.provenanceUnknown || reingested.provenanceUnknown ? true : undefined,
    };
  }
  const { surviving: resurrectable } = readSurvivingOnDiskTokens(parsed);
  // @decision 8db913e2 (Follow-up 150aed7b) — exclude the key `final`'s OWN basename hash names, never
  // a recomputed `canonicalRepoLockKey(entry.repoPath)` (82032b5c/97cff6db's own rule: this write may
  // target a SECONDARY key via `targetKey`, which can differ from entry's own repoPath-derived key).
  const finalOwnHash = path.basename(final, ".json");
  const onDiskKeys = informativeKeysFor({
    resolvedKey: typeof parsed.resolvedKey === "string" ? parsed.resolvedKey : undefined,
    resolvedKeys: parseResolvedKeysField(parsed),
  } as MergeQuarantineEntry).filter((k) => quarantineHashForKey(k) !== finalOwnHash);
  if (resurrectable.length === 0 && onDiskKeys.length === 0) return entry;
  // @decision 702b4241 (round 4) — the genuine on-disk record's identity wins when OLDER than `entry`'s
  // own (mirrors `unionQuarantineEntries`'s longest-outstanding-raise rule) — see "Round 4" below.
  const onDiskEnteredAt = typeof parsed.enteredAt === "number" ? parsed.enteredAt : undefined;
  const onDiskIdentity = onDiskEnteredAt !== undefined && onDiskEnteredAt < entry.enteredAt
    && typeof parsed.branch === "string" && typeof parsed.reason === "string"
    ? { branch: parsed.branch, reason: parsed.reason, enteredAt: onDiskEnteredAt, opId: typeof parsed.opId === "string" ? parsed.opId : undefined }
    : undefined;
  return {
    ...entry,
    ...onDiskIdentity,
    // @decision 2dd97aaa (Follow-up 58957b1e) — filter `droppedTokens` AFTER the union; see this
    // function's own doc comment.
    tokens: [...new Set([...resurrectable, ...entry.tokens])].filter((t) => !droppedTokens.has(t)),
    resolvedKeys: onDiskKeys.length > 0
      ? unionResolvedKeysRetaining(entry.resolvedKeys, onDiskKeys, `reconcileMarkedBasenameBeforeWrite(${entry.repoPath})`)
      : entry.resolvedKeys,
  };
}

/**
 * Convenience over {@link reconcileMarkedBasenameBeforeWrite}, called by every write-arming call site in
 * this module (never a parallel reimplementation — `MAKE IT CALL THE SHARED HELPER`, per the decision
 * record) so its OWN in-memory entry reflects the SAME reconciliation that will decide the durable bytes
 * — and so that reconciliation happens exactly ONCE per write, not once here and again, separately,
 * inside {@link writeMergeQuarantineLatch}'s own chokepoint (round 3, CR2 B2: two independent reads of
 * the SAME `final` for the SAME write could disagree on a transient read failure, letting memory and disk
 * diverge). Skips the read entirely when the basename isn't marked (the fast path every other caller of
 * the chokepoint already takes).
 *
 * Returns `"unreadable"` (never silently swallowed into `entry` unchanged, as round 2 did) when
 * `final` is a genuinely unreadable FILE right now — the caller decides what that means for ITS OWN
 * write: a raise must {@link divertRaiseEntry} rather than arm+write (e1cb7d33 still holds via the
 * divert); a non-raise caller (graduation/sibling-absorb) treats it exactly like a refused write (arm in
 * memory unchanged, never durably write to `final`), same as the pre-round-3 chokepoint behavior.
 *
 * The caller that gets back a reconciled `MergeQuarantineEntry` (not `"unreadable"`) MUST pass it into
 * {@link writeMergeQuarantineLatch} via `reconciledAlready:true` — that is what makes this the single
 * read, not merely an additional one.
 *
 * @decision 8db913e2 (round 2; round 3 — now a shared result, not a silent swallow)
 *
 * @decision 2dd97aaa (Follow-up 58957b1e) — `droppedTokens` (REQUIRED) is forwarded straight to
 * {@link reconcileMarkedBasenameBeforeWrite}; see that function's own doc.
 */
function foldInOnDiskTokensIfMarked(final: string, entry: MergeQuarantineEntry, droppedTokens: ReadonlySet<string>): MergeQuarantineEntry | "unreadable" {
  if (!keptUnreadableLatchFiles.has(path.basename(final))) return entry;
  return reconcileMarkedBasenameBeforeWrite(final, entry, droppedTokens);
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
 *
 * @decision 8db913e2 (round 2) — ALSO the ONE chokepoint for {@link reconcileMarkedBasenameBeforeWrite},
 * run for every caller right after the guard above. Its own doc comment has the full behavior; see that
 * instead of restating it here.
 *
 * @decision 8db913e2 (round 3) — `reconciledAlready`: the caller already ran
 * {@link foldInOnDiskTokensIfMarked} for this exact `entry`/`final` pair and is passing the SAME result
 * on, so this chokepoint must not re-read `final` a second, independent time for the same write (CR2 B2:
 * two separate reads of one file for one write can disagree on a transient failure). See that function's
 * own doc for who sets this and why.
 *
 * @decision 2dd97aaa (Follow-up 58957b1e) — `droppedTokens` (REQUIRED) forwards to the internal
 * {@link reconcileMarkedBasenameBeforeWrite} call below when `!reconciledAlready`. Every call site must
 * state what it narrows. See that function's own doc.
 */
function writeMergeQuarantineLatch(entry: MergeQuarantineEntry, droppedTokens: ReadonlySet<string>, sweepOtherTmpsOnSuccess = false, targetKey?: string, skipDegradedOccupantGuard = false, reconciledAlready = false): boolean {
  let fd: number | undefined;
  try {
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const final = targetKey ? quarantinePathForKey(targetKey) : quarantinePathFor(entry.repoPath);
    if (!skipDegradedOccupantGuard && wouldOverwriteDifferentUnresolvableOccupant(final, entry)) return false;
    if (!reconciledAlready && keptUnreadableLatchFiles.has(path.basename(final))) {
      const reconciled = reconcileMarkedBasenameBeforeWrite(final, entry, droppedTokens);
      if (reconciled === "unreadable") {
        if (!skipDegradedOccupantGuard) return false;
        // @decision 8db913e2 (round 3) — defensive fallback (every current raise call site already
        // pre-reconciles and diverts itself before reaching here): divert rather than overwrite blind,
        // so e1cb7d33 holds without destroying final's own genuinely-unreadable bytes.
        divertRaiseEntry(entry);
        return true;
      }
      entry = reconciled;
    }
    const tmp = `${final}.tmp-${process.pid}-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    fd = fs.openSync(tmp, "w");
    // `armedKeys` is IN-MEMORY bookkeeping only (see its own doc comment) — never persisted. A restart
    // rebuilds it fresh via arming, and a stale persisted value from a PRIOR process's keying would be
    // actively misleading to a human reading the raw file.
    const { armedKeys: _armedKeys, ...persistable } = entry;
    // @decision 8db913e2 (Follow-up 43cf3b26) — the retention formula (prior resolvedKeys UNION this
    // write's own fresh secondary armedKeys) — see the decision record's own "retention rule" section.
    const ownKeyForWrite = targetKey ?? canonicalRepoLockKey(entry.repoPath);
    const freshSecondaryKeys = (entry.armedKeys ?? []).filter((k) => k !== ownKeyForWrite);
    const retainedResolvedKeys = unionResolvedKeysRetaining(entry.resolvedKeys, freshSecondaryKeys, `writeMergeQuarantineLatch(${entry.repoPath})`);
    const resolvedKeys = retainedResolvedKeys.length > 0 ? retainedResolvedKeys : undefined;
    // Backward compat: an OLD reader only ever looks at the scalar — promote the first surviving
    // informative key into it if the in-memory scalar itself isn't already informative.
    const resolvedKey = isInformativeKey(persistable, ownKeyForWrite)
      ? persistable.resolvedKey
      : retainedResolvedKeys.find((k) => k !== ownKeyForWrite) ?? persistable.resolvedKey;
    // @decision db0a9db0 (round 2) — THE one chokepoint stamping `provenanceTracked: true` unconditionally;
    // see that field's own doc for why only this (never writeSafetyTmpResidueAtHash/writePendingDivertFile).
    fs.writeSync(fd, JSON.stringify({ ...persistable, resolvedKey, resolvedKeys, provenanceTracked: true }, null, 2) + "\n");
    fs.fsyncSync(fd); // round 6 — durable on disk BEFORE the rename makes it visible, not just buffered
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, final);
    // @decision 63e49ee2 (round 5) — this rename just durably overwrote `final` with KNOWN, fresh
    // content; any earlier read-failure mark on this exact basename no longer describes current reality.
    keptUnreadableLatchFiles.delete(path.basename(final));
    // @decision 92c645cc (item 2) — only AFTER this write's own rename has durably superseded whatever was
    // there before (bde5d1fe's rule: sweep/unlink only follows a successful superseding write) — and only
    // when the CALLER has asserted the superset property holds for this entry.
    //
    // @decision be79f4d5 (round 3) — "proven superset" is a claim about THIS entry's own history, never
    // about who else references a same-hash tmp — sweep reference-aware, never unconditional-by-hash.
    //
    // @decision 82032b5c — hash off `targetKey` when given, mirroring `final` above: recomputing from
    // `entry.repoPath` instead sweeps (or fails to sweep) at the wrong key whenever that repoPath is
    // itself unresolvable.
    // @decision 21ec39e5 — `entry.tokens` as `candidateTokens`: this write's own superset argument (see
    // the comment above) now PROVES, rather than assumes, that no older tmp for this key is destroyed.
    if (sweepOtherTmpsOnSuccess) sweepTmpResidueForHashIfUnreferenced(targetKey ? quarantineHashForKey(targetKey) : quarantineHashFor(entry.repoPath), { mode: "content-checked", candidateTokens: entry.tokens });
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
  // @decision 63e49ee2 (round 3) — defensive, same identity-less keep as every other unlink site here.
  if (keptUnreadableLatchFiles.has(sourceFile)) return true;
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
): { armed: MergeQuarantineEntry; matched: PendingUnresolvedQuarantine[]; writeSucceeded: boolean; diverted?: true } {
  const matched = indices.map((i) => pendingUnresolvedQuarantines[i] as PendingUnresolvedQuarantine);
  for (const i of [...indices].sort((a, b) => b - a)) pendingUnresolvedQuarantines.splice(i, 1); // descending so earlier indices stay valid
  const first = matched[0] as PendingUnresolvedQuarantine;
  let unioned = matched.slice(1).reduce((acc, p) => unionQuarantineEntries(acc, p.entry), first.entry);
  if (extra) unioned = unionQuarantineEntries(unioned, extra);
  // @decision 82032b5c (round 6, Follow-up b5c94cbe) — stamp every LOSING identity into
  // contributorRepoPaths here too (additive only, computed after both reduces above, against the FINAL
  // winner) — never refuses clear-by-id's own masked-hard-delete recurrence at this site otherwise.
  const contributingRepoPaths = extra ? [...matched.map((p) => p.entry.repoPath), extra.repoPath] : matched.map((p) => p.entry.repoPath);
  const losingRepoPaths = contributingRepoPaths.filter((p) => directPathIdentity(p) !== directPathIdentity(unioned.repoPath));
  if (losingRepoPaths.length > 0) {
    unioned = { ...unioned, contributorRepoPaths: [...new Set([...(unioned.contributorRepoPaths ?? []), ...losingRepoPaths])] };
  }
  const sourceFiles = matched.map((p) => p.sourceFile);
  const strippedOrphanLatchFiles = unioned.orphanLatchFiles?.filter((f) => !sourceFiles.includes(f));
  const armedKeys = [...new Set([...(unioned.armedKeys ?? []), key])];
  // @decision 500e307a — stamp provenanceTracked on the newly-armed in-memory entry too; never a
  // launder, since provenanceUnknown (if any) already arrived via unioned's own sticky OR and wins at
  // the next boot's parse regardless. See the decision record.
  //
  // @decision 8db913e2 (Follow-up 43cf3b26) — never self-stamp `resolvedKey` away from an already-
  // informative value; fold it into `resolvedKeys` too — see the decision record's own "silent loss" section.
  const resolvedKeysForArm = unionResolvedKeysRetaining(
    unioned.resolvedKeys,
    unioned.resolvedKey !== undefined ? [unioned.resolvedKey] : [],
    `consumeMatchedPendingsIntoArmedEntry(${unioned.repoPath})`,
  );
  let armed: MergeQuarantineEntry = {
    ...unioned,
    resolvedKey: isInformativeKey(unioned, key) ? unioned.resolvedKey : key,
    resolvedKeys: resolvedKeysForArm.length > 0 ? resolvedKeysForArm : undefined,
    armedKeys, orphanLatchFiles: strippedOrphanLatchFiles, provenanceTracked: true,
  };
  // @decision 8db913e2 (round 2; round 3 — now also the ONE read for the write below, per
  // foldInOnDiskTokensIfMarked's own doc) — fold on-disk tokens forward before arming, so every caller
  // here sets an in-memory record matching the durable bytes.
  // @decision 2dd97aaa (Follow-up 58957b1e) — this union only ever ADDS matched pendings' tokens, never
  // drops any — `droppedTokens` is empty.
  const folded = foldInOnDiskTokensIfMarked(quarantinePathForKey(key), armed, new Set());
  if (folded === "unreadable") {
    if (skipDegradedOccupantGuard) {
      // @decision 8db913e2 (Follow-up 6c04633d) — a divert union keeps the RAISER's own identity for the raiser's own tokens;
      // never fold one identity's tokens into a record keyed to a DIFFERENT identity — group matched
      // entries by identity and divert each identity separately (decision record, Follow-up 6c04633d).
      const raiserIdentity = directPathIdentity((extra ?? first.entry).repoPath);
      const ownGroup = matched.filter((p) => directPathIdentity(p.entry.repoPath) === raiserIdentity);
      const foreignGroups = new Map<string, PendingUnresolvedQuarantine[]>();
      for (const p of matched) {
        const id = directPathIdentity(p.entry.repoPath);
        if (id === raiserIdentity) continue;
        const group = foreignGroups.get(id);
        if (group) group.push(p); else foreignGroups.set(id, [p]);
      }
      let raiserUnion = ownGroup.reduce((acc, p) => unionQuarantineEntries(acc, p.entry), extra ?? (ownGroup[0] as PendingUnresolvedQuarantine).entry);
      // @decision 8db913e2 (Follow-up 6c04633d, M2) — PRESERVE the field set this function's own `armed` object always
      // stamped before a divert (resolvedKey/armedKeys/provenanceTracked, `500e307a`) — this card is
      // about identity partition, never about what a divert record carries. See the decision record.
      // @decision 8db913e2 (Follow-up 43cf3b26) — never self-stamp away an already-informative
      // `resolvedKey` here either — same `isInformativeKey` guard as this function's own main arm above.
      raiserUnion = {
        ...raiserUnion,
        resolvedKey: isInformativeKey(raiserUnion, key) ? raiserUnion.resolvedKey : key,
        armedKeys: [...new Set([...(raiserUnion.armedKeys ?? []), key])],
        provenanceTracked: true,
      };
      // @decision 8db913e2 (Follow-up 6c04633d, b) — fold EVERY own-group sourceFile in UNCONDITIONALLY, never excluding the
      // assumed fresh-divert filename — `divertRaiseEntry` may instead reuse an unmatched same-identity
      // pending's own `base.sourceFile`, leaving an excluded file untracked and fail-open at reboot.
      const ownSourceFiles = ownGroup.map((p) => p.sourceFile);
      if (ownSourceFiles.length > 0) {
        raiserUnion = { ...raiserUnion, orphanLatchFiles: [...new Set([...(raiserUnion.orphanLatchFiles ?? []), ...ownSourceFiles])] };
      }
      // @decision af948556 — an `ownGroup` member can already be an 883e29bc/64283e06 boot twin, armed
      // under a DIFFERENT key — re-point it (replacement only, never a union source, c9114934) before
      // diverting, or that slot is stranded holding a stale, pre-raise snapshot. See the decision record.
      for (const p of ownGroup) replaceEntryEverywhere(activeQuarantines, p.entry, raiserUnion);
      // Raise: divert this union rather than arm/write at `key`'s own final — e1cb7d33 still holds via
      // the divert. `key` itself is never armed here (this raise's own final goes through the divert,
      // never `activeQuarantines.set(key, ...)`) — see the `replaceEntryEverywhere` call just above for
      // why a DIFFERENT, pre-existing key can already hold this identity regardless.
      divertRaiseEntry(raiserUnion);
      // Every OTHER identity's own matched entries never touched the raiser's write at all — put each
      // group straight back under its OWN identity, merged only within itself (never across identities).
      for (const group of foreignGroups.values()) {
        if (group.length === 1) {
          // Content genuinely unchanged — re-insert the exact same object, never rewritten or re-pointed.
          pendingUnresolvedQuarantines.push(group[0] as PendingUnresolvedQuarantine);
          continue;
        }
        const base = group.reduce((a, b) => (a.entry.enteredAt <= b.entry.enteredAt ? a : b));
        const others = group.filter((p) => p !== base);
        let foreignUnion = others.reduce((acc, p) => unionQuarantineEntries(acc, p.entry), base.entry);
        const otherSourceFiles = others.map((p) => p.sourceFile);
        foreignUnion = { ...foreignUnion, orphanLatchFiles: [...new Set([...(foreignUnion.orphanLatchFiles ?? []), ...otherSourceFiles])] };
        // @decision 67136b71 — a foreign-group member can ALSO be an 883e29bc/64283e06 boot twin, armed
        // under a DIFFERENT key — re-point it (replacement only, never a union source, c9114934) before
        // re-inserting, or that slot is stranded holding a stale, pre-raise snapshot.
        for (const p of group) replaceEntryEverywhere(activeQuarantines, p.entry, foreignUnion);
        // @decision 702b4241 (round 3) — use whatever `writePendingDivertFile` ACTUALLY wrote to, never
        // `base.sourceFile` unconditionally: a marked basename redirects to a fresh record instead.
        // @decision 2dd97aaa (Follow-up 535fd69d) — `foreignUnion` only ever UNIONS this group's own members; it never drops
        // a token, so `droppedTokens` is empty.
        const written = writePendingDivertFile(base.sourceFile, foreignUnion, new Set());
        if (written) {
          if (written.entry !== foreignUnion) replaceEntryEverywhere(activeQuarantines, foreignUnion, written.entry);
          pendingUnresolvedQuarantines.push({ entry: written.entry, sourceFile: written.filename });
        } else {
          pendingUnresolvedQuarantines.push({ entry: foreignUnion, sourceFile: base.sourceFile });
          // eslint-disable-next-line no-console
          console.error(`[merge-quarantine] could not durably persist a merged sibling pending latch for ${foreignUnion.repoPath} at ${base.sourceFile} after an unrelated raise's own divert — the PRE-EXISTING durable state there is left UNTOUCHED (still enforced in THIS process).`);
        }
      }
      return { armed: raiserUnion, matched, writeSucceeded: true, diverted: true };
    }
    // Non-raise (graduation/sibling-absorb): arm `armed` unchanged (no union was possible) and treat the
    // write as refused, exactly like the pre-round-3 chokepoint already did for this same outcome — fall
    // through to the ordinary arm+refused-write bookkeeping below rather than calling the write at all.
  } else {
    armed = folded;
  }
  // @decision 96e6aa58 (round 2) — anchor set = extra (if any) + every matched pending entry's own object;
  // each is being consumed into this union, so re-pointing what it already owns is correct and matches
  // main. Gate non-anchor keys on ownership by ANY anchor, then replaceEntryEverywhere per anchor.
  const anchors: MergeQuarantineEntry[] = extra ? [extra, ...matched.map((p) => p.entry)] : matched.map((p) => p.entry);
  for (const k of armedKeys) {
    if (k === key) { activeQuarantines.set(k, armed); continue; }
    if (anchors.some((o) => entryStillOwnsKey(k, o))) activeQuarantines.set(k, armed);
  }
  for (const o of anchors) replaceEntryEverywhere(activeQuarantines, o, armed);
  // @decision 97cff6db (round 4) — pass `key` explicitly, never derived from `armed.repoPath` — same
  // "never trust entry.repoPath at a site that can see a degraded identity" rule as every boot write site.
  //
  // @decision 8db913e2 (round 3) — `writeSucceeded` is forced `false` without calling the write at all
  // when the fold above already determined "unreadable" for a non-raise caller — the chokepoint would
  // only re-read the SAME file and reach the SAME answer (ONE READ PER WRITE).
  // @decision 2dd97aaa (Follow-up 58957b1e) — `armed` is a union (above), never a narrowing — `droppedTokens` is empty.
  const writeSucceeded = folded === "unreadable" ? false : writeMergeQuarantineLatch(armed, new Set(), false, key, skipDegradedOccupantGuard, true);
  if (writeSucceeded) {
    const failedToDelete = sourceFiles.filter((sourceFile) => !deleteSourceLatchIfSuperseded(sourceFile, armed, key));
    if (failedToDelete.length > 0) {
      const updated: MergeQuarantineEntry = { ...armed, orphanLatchFiles: [...new Set([...(armed.orphanLatchFiles ?? []), ...failedToDelete])] };
      // @decision 96e6aa58 — same-identity rebuild of `armed` itself: route through replaceEntryEverywhere,
      // never a bare per-key `.set()` — safe here because every slot currently holding `armed` by
      // reference was already placed there correctly by the fix above (never a slot belonging to W).
      replaceEntryEverywhere(activeQuarantines, armed, updated);
      armed = updated;
      if (!writeMergeQuarantineLatch(armed, new Set(), false, key, skipDegradedOccupantGuard, true)) {
        // eslint-disable-next-line no-console
        console.error(`[merge-quarantine] graduated ${armed.repoPath} but could NOT re-persist it after ${failedToDelete.length} stale source file(s) (${failedToDelete.join(", ")}) failed to unlink — those file(s) stay on disk, UNTRACKED by this entry's own bookkeeping in THIS process; a restart may re-arm this quarantine from them (fail-closed, never open, but investigate the unlink failure).`);
      }
    }
  } else {
    // @decision 97cff6db (round 5) — key off `key`, never `armed.repoPath` — same rule as the write above.
    const freshWriteTarget = path.basename(quarantinePathForKey(key));
    const toFold = sourceFiles.filter((f) => f !== freshWriteTarget);
    if (toFold.length > 0) {
      const updated: MergeQuarantineEntry = { ...armed, orphanLatchFiles: [...new Set([...(armed.orphanLatchFiles ?? []), ...toFold])] };
      // @decision 96e6aa58 — same-identity rebuild, same reason as the success branch above.
      replaceEntryEverywhere(activeQuarantines, armed, updated);
      armed = updated;
    }
  }
  return { armed, matched, writeSucceeded };
}

/**
 * A fresh, successful read of `final` RIGHT NOW, proving every token physically there is already one of
 * `candidateTokens` — the tokens this clear is about to durably drop. ENOENT/EISDIR (nothing real there)
 * is trivially covered; any OTHER read failure, corrupt/unparsable JSON, or a real on-disk token not in
 * `candidateTokens`, cannot be proven safe.
 *
 * @decision 8db913e2 (Follow-up dd34da46, Item 1) — see the decision record for the stale-mark-outliving-a-transient-read-failure
 * shape this closes, and why this content-containment check differs from round 5 of `63e49ee2`'s
 * forbidden identity-only detector trust.
 *
 * @decision 8db913e2 (Follow-up 95ea8d3f, Round 2) — corrupt/unparsable content is NO LONGER trivially covered — a corrupt
 * latch can be a card-882d6cff shared backing for SEVERAL distinct claimants at once, and unparseable
 * content can never prove it holds nothing but `candidateTokens`' own tokens. See the decision record.
 *
 * @decision 8db913e2 (Follow-up 495fd320) — a bare scalar (number/string/boolean, never `null`) now ALSO counts as "cannot
 * prove coverage" rather than vacuously `true`, a strictly safer tightening. See the decision record.
 */
function markedFinalFullyCoveredByClear(final: string, candidateTokens: string[]): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(final, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "EISDIR";
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return false; } // corrupt — cannot prove coverage
  if (!isReadableLatchRecord(parsed)) return false; // e.g. the bare literal `null` — cannot prove coverage
  // @decision 8db913e2 (Follow-up 25f6a7dc) — tests the RAW on-disk tokens, each covered by being cleared NOW (candidateTokens)
  // or ALREADY tombstoned (clearedTokens) — never `.surviving` alone, which folds "already cleared"
  // silently into the array instead of deciding it here. See the decision record.
  const { raw: onDiskTokens } = readSurvivingOnDiskTokens(parsed);
  return onDiskTokens.every((t) => candidateTokens.includes(t) || clearedTokens.has(t));
}

/** Best-effort; a missing file is not an error. Never throws. Also sweeps any leftover `.json.tmp-<pid>`
 *  residue for KEY — a failed write DELIBERATELY leaves its tmp behind (round 2: it's the only durable
 *  record of an active quarantine until resolved) — HERE, at clear time, is where it gets swept.
 *
 * @decision 54054c01 — takes a raw KEY, never a repoPath: a clear must address BOTH a key an entry is
 * armed under, not just the one `canonicalRepoLockKey(repoPath)` recomputes fresh right now.
 *
 * @decision e1cb7d33 — an ordinary clear through this function is OUT OF SCOPE for the WRITE-side
 * degraded-occupant guard (never refused — `d4b25feb`/`e1cb7d33` already ruled the clear must proceed).
 *
 * @decision c9114934 — `clearingRepoPath`, when passed, durably copies a DIFFERENT degraded occupant's
 * content aside BEFORE the unconditional unlink below — see the decision record. The unlink itself is
 * unaffected either way: this never refuses, only protects.
 *
 * @decision d163aef5 (round 4) — supersedes round 3's resolvability gate: `clearIdentity` is a PRIMARY
 * ownership check; `clearedEntry`'s token-overlap protect is now an UNCONDITIONAL backstop. Neither
 * gates on resolvability. See the decision record's "Round 4" section.
 *
 * @decision d163aef5 (round 5) — a `foreignPending` claim can name THIS file even when its on-disk
 * content is genuinely the clearer's own (a prior eviction's inference, see
 * `armKeyUnlessDegradedCollision`); gate the protect on content identity, not the claim alone.
 *
 * @decision d2582692 — `clearedEntry`'s protect now also receives `clearIdentity`, and {@link
 * protectForeignTmpResidueBeforeSweep} protects a FOREIGN occupant's own tmp residue at this key before
 * the unconditional sweep below. See the decision record.
 *
 * @decision 4900c365 — a protect call that FAILS to durably write must not be followed by the unlink it
 * was guarding against: `final` is left on disk (never unlinked) whenever any protect call above
 * returns `false` — the failed tmp-residue case protects itself (see that function's own doc).
 *
 * @decision 63e49ee2 — `false` now also covers a read failure of UNKNOWN cause (no content was ever
 * parsed), for both `final` (this function's own unlink below) and a tmp residue (protected inside
 * {@link protectForeignTmpResidueBeforeSweep} itself). See the decision record.
 *
 * @decision 8db913e2 (Follow-up 95ea8d3f, Round 2, Critical) — returns the repoPaths of every SURVIVING structural shared
 * claimant ({@link survivingSharedClaimRepoPaths}) that kept `final` on disk (empty if none) — a check
 * that never yields to `provenCoverage`. See the decision record.
 */
function deleteMergeQuarantineLatchByKey(key: string, clearingRepoPath: string | undefined, clearedEntry: MergeQuarantineEntry | undefined, clearIdentity: string | undefined, liftedKeys: ReadonlySet<string>): { kept: Array<{ repoPath: string; sourceFile: string }>; relocated: Array<{ repoPath: string; sourceFile: string }>; unattributed?: true } {
  const final = quarantinePathForKey(key);
  // @decision 8db913e2 (Follow-up 4b06875f, Round 2/3) — every key THIS clear is itself touching, never
  // `key` alone — the caller computes it (via `ownedKeysIncluding`/`keysToLift`) and must pass it
  // explicitly; see the decision record's Follow-up 78fccd3f for why there is deliberately no default.
  // @decision 8db913e2 (Follow-up 0dc514dc) — ONLY when neither protect call below would read `final` at all (both
  // `clearingRepoPath`/`clearedEntry` absent) — a new read here otherwise steals an injected-failure
  // slot several tests key to a specific read NUMBER. See the decision record's Follow-up.
  const contentClaimants = clearIdentity && !clearingRepoPath && !clearedEntry
    ? survivingTokenHolderRepoPaths(readFinalOnDiskSurvivingTokens(final), clearIdentity)
    : [];
  let finalProtectOk = true;
  // @decision 182c01cc — collects every protect call's own already-computed `persisted`, never re-derived
  // — `sharedClaimants`/`contentClaimants` below are keyed on the OLD filename and can't see a co-occupant
  // a successful protect just moved OFF it. See the decision record.
  //
  // @decision 182c01cc (round 4, CR3 MAJOR) — split by `r.relocated`; a double-fault stays KEPT, never
  // relocated — see ProtectResult's own doc and the decision record's "Round 4" section.
  const persistedRelocated: Array<{ repoPath: string; sourceFile: string }> = [];
  const persistedKept: Array<{ repoPath: string; sourceFile: string }> = [];
  const collectPersisted = (r: ProtectResult) => { if (r.persisted) (r.relocated ? persistedRelocated : persistedKept).push(r.persisted); };
  if (clearingRepoPath) {
    // @decision 4913e721 — thread `clearedEntry` through as `knownOccupant`: this clear's own caller
    // already deleted that identity's live map slot before this read runs, so only this pre-delete
    // snapshot can still recover a memory-only `provenanceUnknown`.
    const r = protectDegradedOccupantBeforeDelete(final, clearingRepoPath, undefined, liftedKeys, clearedEntry);
    finalProtectOk = r.ok && finalProtectOk;
    collectPersisted(r);
  }
  if (clearIdentity) {
    const finalBasename = path.basename(final);
    const foreignPending = pendingUnresolvedQuarantines.find((p) => p.sourceFile === finalBasename && directPathIdentity(p.entry.repoPath) !== clearIdentity);
    if (foreignPending && quarantineFileRepoPathIdentity(final) !== clearIdentity) {
      const r = protectOccupantContentBeforeDelete(final, foreignPending.entry.repoPath, clearIdentity, liftedKeys);
      finalProtectOk = r.ok && finalProtectOk;
      collectPersisted(r);
    }
  }
  if (clearedEntry) {
    const r = protectUnincorporatedOccupantBeforeDelete(final, clearedEntry, clearIdentity, liftedKeys);
    finalProtectOk = r.ok && finalProtectOk;
    collectPersisted(r);
  }
  // @decision 63e49ee2 (round 5) — ALWAYS, unconditionally: a fresh read or a detector "none" never
  // overrides a mark — only a durable rename-over or copy-aside (both already removed it by this point).
  //
  // @decision 8db913e2 (Follow-up dd34da46, Item 1) — a THIRD way to settle a mark: a fresh content read
  // proving every token in `final` is one THIS clear is dropping, with the mark itself dropped only AFTER
  // the unlink below CONFIRMS removal. See the decision record for the N4 EPERM/EBUSY ordering fix.
  const finalBasename = path.basename(final);
  const marked = keptUnreadableLatchFiles.has(finalBasename);
  const provenCoverage = marked && finalProtectOk && !!clearedEntry && markedFinalFullyCoveredByClear(final, clearedEntry.tokens);
  if (marked && !provenCoverage) finalProtectOk = false;
  // @decision 8db913e2 (Follow-up 95ea8d3f, Round 2, Critical, CR c9af122d) — a SURVIVING structural shared claim on this
  // exact file is NEVER overridden by provenCoverage (or anything else above) — see this function's own
  // doc. Checked last, after every other signal, so it can only ever narrow `finalProtectOk` further.
  const sharedClaimants = survivingSharedClaimRepoPaths(finalBasename);
  if (sharedClaimants.length > 0) finalProtectOk = false;
  // @decision 8db913e2 (Follow-up 0dc514dc) — `contentClaimants` (computed at this function's own top, before any mutation
  // above) is NEVER overridden by `provenCoverage` either — same "checked last, only ever narrows"
  // posture as `sharedClaimants`, applied to a content-based rather than structural claim.
  if (contentClaimants.length > 0) finalProtectOk = false;
  const keptClaimants = [...new Set([...sharedClaimants, ...contentClaimants])];
  // @decision 702b4241 (round 2) — set ONLY in the bare "kept, no claimant to name" branch below — the
  // ONE shape this function's own return had no way to represent at all (card 702b4241's own basename-
  // only unreadable mark, with no foreign identity attached), silently losing the keep at every caller.
  let unattributedKept = false;
  if (finalProtectOk) {
    let unlinkConfirmed = true;
    try {
      fs.unlinkSync(final);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") unlinkConfirmed = false;
    }
    if (provenCoverage) {
      if (unlinkConfirmed) {
        keptUnreadableLatchFiles.delete(finalBasename);
      } else {
        // eslint-disable-next-line no-console
        console.error(`[merge-quarantine] ${finalBasename} could not be CONFIRMED removed (an EPERM/EBUSY-shaped unlink failure) even though its content was just proven fully covered by this clear — the mark stays set, fail-closed, until a later successful read or delete resolves it.`);
      }
    }
    // @decision 8db913e2 (round 4, CR3 BLOCKER 1) — NEVER tombstone here: `finalProtectOk` true also
    // covers "copied aside, still enforced". The caller's own top-level clear tombstones once, at its own
    // end, via `tombstoneIfNotSurviving` — the only place that knows the full outcome.
  } else if (keptClaimants.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`[merge-quarantine] keeping ${finalBasename} on disk — ${keptClaimants.length} other claimant(s) still depend on it (${keptClaimants.join(", ")}); never destroyed, even though this clear's own content coverage would otherwise be proven.`);
  } else {
    // eslint-disable-next-line no-console
    console.error(`[merge-quarantine] keeping ${path.basename(final)} on disk — a foreign occupant's content could not be durably protected (or could not be read) before this clear; see the error just above. It also stays marked kept in THIS PROCESS (a real self-owned record, or a basename-only read-failure mark), not only after a later boot.`);
    unattributedKept = true;
  }
  // @decision 182c01cc (round 2, finding 1) — fold this sweep's OWN relocations (and, round 4, its own
  // kept double-faults) in too; it used to discard them, so a clear whose only foreign content sat in a
  // tmp residue returned a bare success.
  if (clearIdentity) {
    const tmpResult = protectForeignTmpResidueBeforeSweep(key, clearIdentity, liftedKeys);
    persistedRelocated.push(...tmpResult.relocated);
    persistedKept.push(...tmpResult.kept);
  }
  // @decision be79f4d5 (round 3) — reference-aware, never the unconditional-by-hash sibling: a same-hash
  // tmp a DIFFERENT, surviving entry's own `orphanLatchFiles` still lists must not be destroyed just
  // because THIS key's own entry is being legitimately cleared.
  //
  // @decision 21ec39e5 (round 2) — `unconditional-owner-protected`: already content-protected above,
  // via `protectForeignTmpResidueBeforeSweep` — a second, redundant check here would only rot alone.
  sweepTmpResidueForHashIfUnreferenced(quarantineHashForKey(key), { mode: "unconditional-owner-protected" });
  // @decision 182c01cc (round 2/4) — two SEPARATE buckets, never merged: `kept` (never unlinked) and
  // `relocated` (moved to its own new sourceFile) are genuinely different physical outcomes.
  return {
    kept: [...keptClaimants.map((repoPath) => ({ repoPath, sourceFile: finalBasename })), ...persistedKept],
    relocated: persistedRelocated,
    ...(unattributedKept ? { unattributed: true as const } : {}),
  };
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
 * The trailing route clause of {@link UNCONFIRMED_KILL_WINDOWS_GUIDANCE} — derived by slicing the
 * constant itself at its own last `", then "` marker, never hand-duplicated, so a future wording edit to
 * the guidance can't silently desync this from what a real raise actually embeds via {@link
 * unconfirmedKillReason}.
 */
const UNCONFIRMED_KILL_ROUTE_CLAUSE = UNCONFIRMED_KILL_WINDOWS_GUIDANCE.slice(UNCONFIRMED_KILL_WINDOWS_GUIDANCE.lastIndexOf(", then "));

/**
 * Strip exactly {@link UNCONFIRMED_KILL_ROUTE_CLAUSE} — and nothing else — out of an embedded `reason`
 * string, for a render site that must never name `/clear` (an AMBIGUOUS refusal; see {@link
 * remediationTextFor}'s own doc for why). Every real unconfirmed-kill raise builds its `reason` via
 * {@link unconfirmedKillReason}, which unconditionally appends the full guidance — route clause included
 * — correct for an ORDINARY (non-ambiguous) raise, where naming `/clear` is right, but wrong the instant
 * that SAME reason string is embedded inside an ambiguous refusal (round 5 CR `14877941`: the ambiguous
 * branch of `assertRepoNotQuarantined` embeds `q.reason` verbatim, so a real unconfirmed-kill raise's own
 * guidance still named `/clear` right next to `remediationTextFor`'s own single-route text). Matched
 * literally against the guidance CONSTANT (never a hand-typed duplicate, and never a loose regex) — a
 * reason that never carried the clause (not an unconfirmed-kill raise, or a legacy latch whose stored
 * reason predates this guidance's wording) passes through byte-identical, so this is safe to call
 * unconditionally wherever an ambiguous refusal embeds a free-text reason.
 *
 * @decision 82032b5c (round 5) — never embed a free-text reason in remediation output without stripping
 * any route it names; a reason built elsewhere can carry a route this call site must not repeat.
 */
export function stripUnconfirmedKillRouteClause(reason: string): string {
  return reason.includes(UNCONFIRMED_KILL_ROUTE_CLAUSE) ? reason.split(UNCONFIRMED_KILL_ROUTE_CLAUSE).join("") : reason;
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

/** Matches {@link pendingDivertCollisionFilenameFor}'s own output — a fresh mint diverted to a distinct
 *  filename because {@link pendingDivertFilenameFor}'s own deterministic path was already occupied by a
 *  different, still-live (or unreadable) record at mint time. Exists ONLY so {@link pendingLatchIdFor} can
 *  hash the whole basename for it, same posture as {@link PENDING_DIVERT_RE}'s own branch below — never
 *  written to directly by anything other than {@link mintPendingDivert}.
 *
 *  @decision 8db913e2 (Follow-up 8a79dd31) */
const PENDING_DIVERT_COLLISION_RE = /^pending-[0-9a-f]{24}-collision-[0-9a-f]{8}\.json$/;

/** Matches a crash-left TORN-WRITE residue of {@link writePendingDivertFile}'s own write to a
 *  {@link pendingDivertCollisionFilenameFor} target — the SAME `.json.tmp-<pid>(-<hex>)?` shape
 *  {@link PENDING_DIVERT_TMP_RE} matches for an ORDINARY pending-divert file, just with the
 *  `-collision-<8hex>` infix inserted before `.json`. Already correctly RECOVERED by PASS 1b's own
 *  pre-existing, content-based "no resolvedKey, unresolvable" branch with zero code changes (same reason
 *  {@link PENDING_DIVERT_TMP_RE} needs no boot-side change either) — this regex exists ONLY so
 *  {@link pendingLatchIdFor} can also derive a valid id for it, rather than falling through to the generic
 *  `.json`-index cut (which recovers a non-24-hex basename `clearMergeQuarantineLatchFile` then rejects as
 *  an "invalid latch id").
 *
 *  @decision 8db913e2 (Follow-up 8a79dd31) */
const PENDING_DIVERT_COLLISION_TMP_RE = /^pending-[0-9a-f]{24}-collision-[0-9a-f]{8}\.json\.tmp-\d+(-[0-9a-f]+)?$/;

/** Deterministic, collision-proof filename for a repoPath's own pending-divert entry — hashes
 *  {@link directPathIdentity}, NEVER `canonicalRepoLockKey` (which is exactly the degraded, walked-up
 *  value this format exists to avoid writing under). Determinism is a convenience (the SAME identity
 *  raising twice while still unresolvable reuses one file rather than minting garbage) — correctness never
 *  depends on it, since every match against this file is by entry CONTENT (`directPathIdentity`), never by
 *  filename. */
function pendingDivertFilenameFor(repoPath: string): string {
  return `pending-${createHash("sha256").update(directPathIdentity(repoPath)).digest("hex").slice(0, 24)}.json`;
}

/** A collision-suffixed fallback filename for `repoPath`'s own pending-divert entry — used ONLY by
 *  {@link mintPendingDivert} when {@link pendingDivertFilenameFor}'s own deterministic path is occupied by
 *  a different, still-live record (or an unreadable/corrupt one) at mint time. The random suffix makes a
 *  SECOND collision vanishingly unlikely — the same residual-risk posture this module already accepts for
 *  every other PID/random-suffixed tmp name.
 *
 *  @decision 8db913e2 (Follow-up 8a79dd31) */
function pendingDivertCollisionFilenameFor(repoPath: string): string {
  const base = pendingDivertFilenameFor(repoPath).slice(0, -".json".length); // "pending-<24hex>"
  return `${base}-collision-${randomUUID().replace(/-/g, "").slice(0, 8)}.json`;
}

/**
 * Durable write primitive for a pending entry at its own `filename` — mirrors
 * {@link writeMergeQuarantineLatch}'s own open/write/fsync/close/rename discipline, but with no
 * degraded-occupant guard and no key/sweep logic. `filename` is NOT always a freshly-minted
 * `pending-<24hex>.json` name (that shape is ONLY what `enterMergeQuarantine`'s own brand-new-entry
 * divert branch mints) — {@link mergeTokenIntoPendingEntries} and {@link clearTokenFromPendingIndices}'s
 * own partial-clear branch both call this to rewrite an ALREADY-EXISTING pending entry's own `sourceFile` IN
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
 *
 * @decision 702b4241 (round 3) — REFUSES to rename over a `filename` still marked
 * {@link keptUnreadableLatchFiles}, diverting to a fresh record instead (see the decision record's
 * "Round 3" section). The caller MUST use the RETURNED `filename`/`entry`, never its own arguments.
 *
 * @decision 702b4241 (round 7) — a marked `filename` is RE-READ right here before redirecting: a stale
 * mark must not force a redirect once the content is readable again and genuinely this same identity.
 * See the decision record's "Round 7" section for the mechanism and why this is the one chokepoint fix.
 *
 * @decision 2dd97aaa (Follow-up 535fd69d) — `droppedTokens` is REQUIRED, never optional: every caller states explicitly
 * whether it narrows (`new Set()` when it does not), or the re-read-and-union above can resurrect a
 * caller's own just-dropped token. See the decision record.
 */
function writePendingDivertFile(filename: string, entry: MergeQuarantineEntry, droppedTokens: ReadonlySet<string>): { filename: string; entry: MergeQuarantineEntry } | false {
  let target = filename;
  let toWrite = entry;
  if (keptUnreadableLatchFiles.has(filename)) {
    const reread = readPendingDivertFileAt(path.join(MERGE_QUARANTINE_DIR, filename));
    if (reread.state === "entry" && directPathIdentity(reread.entry.repoPath) === directPathIdentity(entry.repoPath)) {
      // Proven safe, right now: the SAME identity already occupies `filename`, readably. Discharge the
      // stale mark by overwriting in place below, unioning the on-disk content forward — never dropped.
      //
      // @decision 2dd97aaa — EXCEPT for `droppedTokens`: a caller NARROWING `entry` (a reduce/partial
      // clear that has already decided these specific tokens are gone) must never have this on-disk
      // union silently resurrect them from a stale copy that predates the narrowing write.
      const unioned = unionIntoOnDiskPendingEntry(reread.entry, entry);
      toWrite = droppedTokens?.size ? { ...unioned, tokens: unioned.tokens.filter((t) => !droppedTokens.has(t)) } : unioned;
    } else if (reread.state === "enoent") {
      // Nothing real there any more — safe to write `entry` unchanged, in place (mirrors
      // reconcilePendingDivertTarget's own ENOENT branch).
    } else {
      // Still genuinely unreadable, corrupt, or a DIFFERENT identity entirely — never overwrite blind.
      target = pendingDivertCollisionFilenameFor(entry.repoPath);
      toWrite = { ...entry, orphanLatchFiles: [...new Set([...(entry.orphanLatchFiles ?? []), filename])] };
      // eslint-disable-next-line no-console
      console.error(`[merge-quarantine] refusing to rename over ${filename} — it is still marked UNREADABLE (never confirmed safe to overwrite); diverting ${entry.repoPath}'s own pending-divert record to ${target} instead and tracking ${filename} as an orphan reference.`);
    }
  }
  let fd: number | undefined;
  const final = path.join(MERGE_QUARANTINE_DIR, target);
  const tmp = `${final}.tmp-${process.pid}-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  try {
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    fd = fs.openSync(tmp, "w");
    const { armedKeys: _armedKeys, ...persistable } = toWrite;
    fs.writeSync(fd, JSON.stringify(persistable, null, 2) + "\n");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, final);
    // @decision 63e49ee2 (round 5) — same rule as writeMergeQuarantineLatch's own identical rename.
    keptUnreadableLatchFiles.delete(target);
    // @decision d4b25feb (round 2, MINOR) — this write is never batched the way boot's own safety-tmp
    // writes are (Phase 0 fsyncs the directory ONCE after the whole batch) — fsync the directory here,
    // per call, so the rename's own directory-entry visibility is durable too, not just the file's bytes.
    fsyncQuarantineDir();
    return { filename: target, entry: toWrite };
  } catch (e) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already broken; nothing more to close */ } }
    // eslint-disable-next-line no-console
    console.error(`[merge-quarantine] FAILED to durably persist the pending-divert latch for ${entry.repoPath} (branch '${entry.branch}'): ${(e as Error).message}`);
    return false;
  }
}

/**
 * @decision c9114934 — called right BEFORE `final` is unlinked by a clear for a DIFFERENT identity. Never
 * preemptively at boot — see the decision record for the double-report regression that caused.
 *
 * @decision c9114934 (round 3, Lead ruling — FAIL CLOSED) — protects EVERY `differentUnresolvableOccupantRepoPathAt`
 * hit, no further "is this really foreign" check: losing a foreign repo's quarantine is unrecoverable
 * where a stale-subdir re-block is not. `protectResolvableToo` (default false) is per call site below.
 *
 * @decision 4900c365 — `false` means a foreign occupant was found but its protective copy failed to
 * write; the caller must NOT unlink/sweep `final` on a `false`. See {@link deleteMergeQuarantineLatchByKey}.
 *
 * @decision 63e49ee2 — an `"unknown"` detector result also returns `false` (keep `final`, never unlink)
 * — there is no parsed content to copy aside, so this never reaches {@link protectOccupantContentBeforeDelete}.
 * See the decision record.
 */
/**
 * Shared return of every protect-before-delete wrapper (this one, {@link
 * protectUnincorporatedOccupantBeforeDelete}, and the chokepoint both delegate to, {@link
 * protectOccupantContentBeforeDelete}): whether the occupant survived safely, and — ONLY when a caller
 * can actually name it (a successful copy-aside, a union/re-point onto an existing same-identity slot, or
 * the in-memory-only double-fault fallback) — the exact `repoPath`/`sourceFile` it now lives under. Every
 * value here was already computed by the function returning it; a caller folds it straight into its own
 * "still blocked" report without a second lookup. `persisted` is deliberately absent on "nothing to
 * protect" (none/corrupt/unreadable) outcomes — there is no occupant to name there.
 *
 * @decision 182c01cc — introduced so `deleteMergeQuarantineLatchByKey` (and `clearMergeQuarantineByKey`
 * above it) can name a co-occupant a clear re-homed to a NEW pending id instead of returning bare `void`
 * — see the decision record for the repro this closes.
 */
// @decision 182c01cc (round 4, CR3 MAJOR) — `relocated:true` means a BRAND-NEW latch was actually
// minted/re-pointed; false/absent (the double-fault fallback) means the occupant stays at its OWN
// pre-existing file — a caller must bucket THAT as KEPT, never relocated. See the decision record.
type ProtectResult = { ok: boolean; persisted?: { repoPath: string; sourceFile: string }; relocated?: boolean };

/** A still-blocked co-occupant named in a clear's own result (card 182c01cc): its repoPath, plus both
 *  forms of the clear-by-path route — `{repoPath}` (always valid) and `{id}` (derived from the exact
 *  sourceFile it is currently filed under, via {@link pendingLatchIdFor}) — mirroring {@link
 *  stillQuarantinedReason}'s own route-naming pattern for the SAME "name it and how to clear it" job.
 *
 * @decision 182c01cc (round 3, M1) — `alsoClear` is set ONLY when the SAME repoPath is independently
 * found BOTH relocated (`route`, clear FIRST) and kept under its OLD name (clear SECOND) — the ONLY
 * durable ordering; see the decision record's "Round 3" section for the measured proof.
 *
 * @decision 182c01cc (round 5, MAJOR) — `route.id` is OPTIONAL: it is omitted rather than hand back a
 * known-non-working id (see {@link blockedCoOccupantForReferencer}). See the decision record's "Round 5".
 */
export type BlockedCoOccupant = {
  repoPath: string;
  route: { repoPath: string; id?: string };
  alsoClear?: { repoPath: string; id: string };
};

function blockedCoOccupant(repoPath: string, sourceFile: string): BlockedCoOccupant {
  return { repoPath, route: { repoPath, id: pendingLatchIdFor(sourceFile) } };
}

/**
 * The SAME "name it and how to clear it" job as {@link blockedCoOccupant}, for a `repoPath` reached via
 * one of {@link sweepOrphanLatchFileIfUnreferenced}/{@link sweepOwnLatchFileUnlessOwnedElsewhere}/
 * {@link sweepTmpResidueForHashIfUnreferenced}'s own `referencingRepoPaths`/`keptEntries` — a repoPath can
 * land there two structurally different ways, and only one of them makes `sourceFile`'s own id a WORKING
 * clear-by-id route for it.
 *
 * @decision 182c01cc (round 5, MAJOR) — a mere `orphanLatchFiles` cross-reference to `sourceFile` is NOT
 * physical ownership of it; using `sourceFile`'s own id for such an owner is a FIXED POINT that never
 * lifts it. See the decision record's "Round 5" section for the full case split and the measured repro.
 */
function blockedCoOccupantForReferencer(repoPath: string, sourceFile: string): BlockedCoOccupant {
  if (physicalOwnerRepoPaths(sourceFile).includes(repoPath)) return blockedCoOccupant(repoPath, sourceFile);
  const ownEntry = [...activeQuarantines.values()].find((e) => e.repoPath === repoPath)
    ?? pendingUnresolvedQuarantines.find((p) => p.entry.repoPath === repoPath)?.entry;
  if (!ownEntry) return { repoPath, route: { repoPath } };
  return { repoPath, route: { repoPath, id: quarantineLatchFileIdsFor(ownEntry)[0] } };
}

/** @decision 182c01cc (round 3, M1) — the SAME repoPath found both relocated (`relocatedSourceFile`,
 *  the PRIMARY route — clear it first) and kept under its old name (`keptSourceFile`, the SECOND,
 *  required route) in one clear. Never dedupe this down to one route — see this type's own doc.
 *
 * @decision 182c01cc (round 4, CR3 MAJOR) — a SAFETY NET on top of the real fix: `alsoClear` is set ONLY
 * when the two sourceFiles genuinely differ. See the decision record's "Round 4" section. */
function blockedCoOccupantBothRoutes(repoPath: string, relocatedSourceFile: string, keptSourceFile: string): BlockedCoOccupant {
  if (relocatedSourceFile === keptSourceFile) return blockedCoOccupant(repoPath, relocatedSourceFile);
  return {
    repoPath,
    route: { repoPath, id: pendingLatchIdFor(relocatedSourceFile) },
    alsoClear: { repoPath, id: pendingLatchIdFor(keptSourceFile) },
  };
}

/** The same combination as {@link blockedCoOccupantBothRoutes}, for a caller (clearMergeQuarantineByRecordedPath)
 *  that already holds two independently-built `BlockedCoOccupant` objects for the SAME repoPath (one
 *  pure-relocated, one pure-kept — e.g. found via two different matched active entries) rather than two
 *  bare sourceFile strings. `relocatedCo`'s own `alsoClear` (if any — an already-combined entry from a
 *  nested delegated call) is intentionally overwritten, never chained.
 *
 * @decision 182c01cc (round 4, CR3 MAJOR) — the SAME safety net as {@link blockedCoOccupantBothRoutes}:
 * two IDENTICAL route ids collapse to one route, never a nonsensical "clear id X FIRST, THEN id X". */
function mergeKeptAndRelocatedCoOccupant(relocatedCo: BlockedCoOccupant, keptCo: BlockedCoOccupant): BlockedCoOccupant {
  if (relocatedCo.route.id === keptCo.route.id) return { repoPath: relocatedCo.repoPath, route: relocatedCo.route };
  // @decision 182c01cc (round 5) — `keptCo.route.id` is undefined only on the structurally-unreachable
  // no-owner-entry fallback (see blockedCoOccupantForReferencer's own doc); there is no real second id to
  // offer, so fall back to the relocated route alone rather than a broken `alsoClear` with no id.
  if (keptCo.route.id === undefined) return { repoPath: relocatedCo.repoPath, route: relocatedCo.route };
  return { repoPath: relocatedCo.repoPath, route: relocatedCo.route, alsoClear: { repoPath: keptCo.route.repoPath, id: keptCo.route.id } };
}

/**
 * Splits a clearMergeQuarantineByKey-shaped result's own `stillBlockedCoOccupants` into the "kept"
 * subset (also named in `referencingRepoPaths` — its physical file literally survives on disk, under its
 * OLD name) and the "relocated" subset (everything NEEDING the relocated reason clause — a pure
 * relocation, or a combined kept+relocated entry; see below). Every caller that aggregates such a result
 * uses this, rather than assuming `stillBlockedCoOccupants` is uniformly "kept" — a relocation must never
 * be folded into `latchKept`/`referencingRepoPaths` (round 2, finding 2: the old file's physical absence
 * makes "stays on disk … clear by its 24-hex id" text false for a relocated entry).
 *
 * @decision 182c01cc (round 3, M1) — NOT mutually exclusive anymore: a combined entry (`alsoClear` set)
 * lands in BOTH buckets — see the decision record's "Round 3" section.
 */
function splitCoOccupants(coOccupants: BlockedCoOccupant[] | undefined, referencingRepoPaths: string[] | undefined): { kept: BlockedCoOccupant[]; relocated: BlockedCoOccupant[] } {
  const keptSet = new Set(referencingRepoPaths ?? []);
  const kept: BlockedCoOccupant[] = [];
  const relocated: BlockedCoOccupant[] = [];
  for (const co of coOccupants ?? []) {
    if (keptSet.has(co.repoPath)) kept.push(co);
    if (!keptSet.has(co.repoPath) || co.alsoClear) relocated.push(co);
  }
  return { kept, relocated };
}

/** The reason clause for a clear that durably RELOCATED one or more foreign co-occupants to their own
 *  new latch(es) — the physical file at the OLD name is genuinely gone (unlike the shared-latch "WILL
 *  RE-DIVERT" case, nothing stays on disk under the old name), so the wording must say so explicitly,
 *  never imply the old file "stays on disk".
 *
 * @decision 182c01cc (round 3, M1) — a co-occupant carrying `alsoClear` gets its OWN clause stating the
 * required two-step order explicitly — see BlockedCoOccupant's own doc for why neither id alone is
 * durable.
 */
function relocatedCoOccupantsReason(coOccupants: BlockedCoOccupant[]): string {
  // @decision 182c01cc (round 5, nit) — "a record of this same identity", never "this same record": the
  // old file can legitimately hold a DIFFERENT record (cd5a3cf9/c93e9e7a's stale-sourceFile gap).
  const names = coOccupants.map((c) => c.alsoClear
    ? `'${c.repoPath}' — clear id '${c.route.id}' FIRST (its new, relocated latch), THEN id '${c.alsoClear.id}' (its OLD file, which also still durably holds a record of this same identity) — clearing only one of the two leaves it re-quarantined on the next restart`
    : `'${c.repoPath}' (now filed under id '${c.route.id}')`).join(", ");
  return `this clear also found ${coOccupants.length} other, unrelated identit${coOccupants.length === 1 ? "y" : "ies"} whose own content was sitting at the same physical file this clear just removed — durably RELOCATED to its own new, independent latch before deletion, never lost (${names}). Still genuinely quarantined; clear it separately via POST /internal/merge-quarantine/clear-by-path with {id} (or {repoPath}).`;
}

/** Appends {@link relocatedCoOccupantsReason}'s own clause onto an existing (possibly absent) base
 *  reason — never silently drops the relocation just because there was nothing else to say. */
function composeReasonWithRelocated(baseReason: string | undefined, relocated: BlockedCoOccupant[]): string | undefined {
  if (relocated.length === 0) return baseReason;
  const relocatedText = relocatedCoOccupantsReason(relocated);
  return baseReason ? `${baseReason} ${relocatedText}` : relocatedText;
}

/** The reason text for a clear whose OWN identity is genuinely lifted, but a latch file it referenced is
 *  kept on disk for `refs`' own sake — shared by {@link clearMergeQuarantineByRecordedPath}'s own kept
 *  branch and {@link clearMergeQuarantineReporting}'s ByKey kept-only branch (round 5, nit) so the two
 *  never drift and neither silently omits a reason for a genuinely kept result.
 */
function keptOnlyReasonFor(refs: string[]): string {
  return `this identity's own quarantine is lifted and will NOT itself re-divert, but a latch file it referenced is still needed by ${refs.length} other claimant(s) that still structurally depend on it (${refs.join(", ")}) — it stays on disk, and every one of THOSE claimants still depending on it WILL RE-DIVERT on the next restart until EVERY one of them has been cleared too (note: a named claimant here can be OVER-reported due to a known, separately-tracked stale-sourceFile gap — it may already be resolved). If they share this exact degraded key, you can lift all of them durably right now by clearing the shared latch by its own 24-hex id instead (POST /internal/merge-quarantine/clear-by-path with {id}); otherwise, clear each one by its own repoPath or id (see stillBlockedCoOccupants).`;
}

/** The reason text for a clear whose OWN identity is genuinely lifted, but a latch file it referenced is
 *  kept on disk purely because its own CONTENT parsed to a different repoPath (no true in-memory
 *  referencer at all — see {@link keptOnlyReasonFor}'s own doc for that case instead). {@link
 *  keptOnlyReasonFor}'s wording assumes a true referencer and reads as a garbled "0 other claimant(s) …
 *  ()" when `refs` is empty — this is the DISTINCT clause for a content-only keep, so every content-only
 *  branch names a real reason instead of falling through to that broken text or to none at all.
 *
 * @decision 8db913e2 (Follow-up 0a783fb2, Code Review 47289f8d) — shared by every call site that can
 * report a content-only keep (clearMergeQuarantineReporting, clearMergeQuarantineByRecordedPath), so
 * neither drifts from the other.
 */
function contentKeptOnlyReasonFor(repoPaths: string[]): string {
  return `this identity's own quarantine is lifted, but a latch file it referenced holds ${repoPaths.length} other repo${repoPaths.length === 1 ? "'s" : "s'"} own outstanding token${repoPaths.length === 1 ? "" : "s"} (${repoPaths.join(", ")}, content-parsed — see contentKeptRepoPaths) and was kept rather than destroyed; it will re-divert on the next restart until a later successful clear resolves it.`;
}

/** The reason text for a clear whose OWN identity is genuinely lifted, but a kept latch file could be
 *  attributed to NEITHER a true referencer NOR a content-parsed repoPath (an unconfirmed EPERM/EBUSY
 *  unlink, or a marked-but-unprovable-coverage keep) — shared so this exact wording never drifts between
 *  every branch that can report it.
 *
 * @decision 8db913e2 (Follow-up 0a783fb2, Code Review 47289f8d) — factored out of
 * clearMergeQuarantineByRecordedPath's own inline literal so clearMergeQuarantineReporting's own
 * latchKept branch can share it instead of hand-rolling a second copy.
 */
function unattributedKeptReasonFor(): string {
  return "this identity's own quarantine is lifted, but a physical latch file it referenced is still on disk — its content could not be durably confirmed removed or fully covered, so no specific other claimant can be named; it will re-divert on the next restart until a later successful clear resolves it.";
}

/** @decision 4913e721 — `knownOccupant`, when given, is a pre-delete snapshot of whatever entry the
 *  caller already had armed at this key, passed through so a lost-from-the-live-maps `provenanceUnknown`
 *  can still be recovered — see {@link protectOccupantContentBeforeDelete}'s own doc. */
function protectDegradedOccupantBeforeDelete(final: string, clearingRepoPath: string, protectResolvableToo = false, liftedKeys: ReadonlySet<string> = new Set(), knownOccupant?: MergeQuarantineEntry): ProtectResult {
  const result = differentUnresolvableOccupantRepoPathAt(final, clearingRepoPath, protectResolvableToo);
  if (result.state === "none") return { ok: true };
  if (result.state === "unknown") {
    // @decision 63e49ee2 (round 3) — mark this basename kept via the identity-less ownership set so
    // every OTHER reference-aware sweep in this module also honours it. See {@link keptUnreadableLatchFiles}.
    keptUnreadableLatchFiles.add(path.basename(final));
    // eslint-disable-next-line no-console
    console.error(`[merge-quarantine] keeping ${path.basename(final)} on disk — its content could not be read (for a reason other than being missing) while clearing ${clearingRepoPath}, so it may genuinely be a different, unresolvable entry's own exclusive backing; treating this as UNKNOWN rather than assuming nothing to protect. It is marked kept in THIS PROCESS too (fail-closed, over-broad until a reboot or a later successful read resolves it), and it survives on disk for either to recover.`);
    return { ok: false };
  }
  return protectOccupantContentBeforeDelete(final, result.repoPath, clearingRepoPath, liftedKeys, knownOccupant);
}

/**
 * @decision d163aef5 (round 3) — the TOKEN-OVERLAP-gated twin of {@link protectDegradedOccupantBeforeDelete},
 * for when `clearedEntry`'s own claim to this key could be a tautological walk-up; see {@link
 * unincorporatedOccupantRepoPathAt}'s own doc for why this needs a different gate.
 *
 * @decision d2582692 — `clearIdentity` forwards to the SAME skip {@link unincorporatedOccupantRepoPathAt}
 * now carries — see that function's own doc.
 *
 * @decision 4900c365 — same `false`-only-on-a-failed-write contract as {@link protectDegradedOccupantBeforeDelete}.
 *
 * @decision 63e49ee2 — same `"unknown"`-returns-`false`-without-content contract as
 * {@link protectDegradedOccupantBeforeDelete}. See the decision record.
 */
function protectUnincorporatedOccupantBeforeDelete(final: string, clearedEntry: MergeQuarantineEntry, clearIdentity?: string, liftedKeys: ReadonlySet<string> = new Set()): ProtectResult {
  const result = unincorporatedOccupantRepoPathAt(final, clearedEntry, clearIdentity);
  if (result.state === "none") return { ok: true };
  if (result.state === "unknown") {
    // @decision 63e49ee2 (round 3) — same identity-less ownership set as
    // {@link protectDegradedOccupantBeforeDelete}'s own "unknown" branch.
    keptUnreadableLatchFiles.add(path.basename(final));
    // eslint-disable-next-line no-console
    console.error(`[merge-quarantine] keeping ${path.basename(final)} on disk — its content could not be read (for a reason other than being missing) while clearing ${clearedEntry.repoPath}, so it may genuinely belong to an unincorporated foreign occupant; treating this as UNKNOWN rather than assuming nothing to protect. It is marked kept in THIS PROCESS too, fail-closed and over-broad until a reboot or a later successful read resolves it.`);
    return { ok: false };
  }
  return protectOccupantContentBeforeDelete(final, result.repoPath, clearedEntry.repoPath, liftedKeys);
}

/**
 * THE single chokepoint deciding whether an occupant's own `resolvedKey` may ride along onto a
 * protective copy — called BOTH before any union (on the freshly-read `toPersist`) and again AFTER one
 * (on whatever `toWrite`/`kept` the union actually produced), so a union against an on-disk or in-memory
 * sibling can never reintroduce a key this call already excluded. Excludes on EITHER condition:
 * `resolvedKey` is a member of `liftedKeys` (every key the CURRENT clear/raise operation is itself
 * touching — see each call site's own `liftedKeys` computation), or it names the same key `final` is
 * physically filed under right now (the caller-independent fallback — safe even if some future call site
 * forgets to thread a complete `liftedKeys`).
 *
 * @decision 8db913e2 (Follow-up 4b06875f) — see the decision record's "Follow-up 4b06875f" (Round 2)
 * section for the two-finding repro this chokepoint closes and why a single shared helper, not two
 * independently-written checks, is required.
 */
function excludeLiftedResolvedKey(resolvedKey: string | undefined, final: string, liftedKeys: ReadonlySet<string>): string | undefined {
  if (resolvedKey === undefined) return undefined;
  if (liftedKeys.has(resolvedKey)) return undefined;
  const finalJsonIdx = path.basename(final).indexOf(".json");
  const finalOwnHash = finalJsonIdx === -1 ? path.basename(final) : path.basename(final).slice(0, finalJsonIdx);
  if (quarantineHashForKey(resolvedKey) === finalOwnHash) return undefined;
  return resolvedKey;
}

/** The plural counterpart of {@link excludeLiftedResolvedKey} — applies the SAME per-key exclusion to
 *  every member of a `resolvedKeys` array, so a protective copy made during a clear can never carry
 *  forward a key that clear is itself lifting.
 *
 *  @decision 8db913e2 (Follow-up 43cf3b26) — see the decision record's own "retention rule" section. */
function excludeLiftedResolvedKeys(keys: string[] | undefined, final: string, liftedKeys: ReadonlySet<string>): string[] | undefined {
  const filtered = (keys ?? []).filter((k): k is string => excludeLiftedResolvedKey(k, final, liftedKeys) !== undefined);
  return filtered.length > 0 ? filtered : undefined;
}

/** Shared tail for both protect-before-delete wrappers above — durably copies `final`'s own content
 *  aside (under `occupantRepoPath`'s own pending-divert filename) before the caller's own unconditional
 *  unlink proceeds. `describeClearer` is used only for the failure log's own wording.
 *
 * @decision 4900c365 — `false` ONLY when genuine foreign content existed and its durable write failed;
 * every other outcome (nothing to protect, or a successful write) is `true`. See the decision record.
 *
 * @decision 63e49ee2 — ALSO `false` on a non-ENOENT read failure of `final`: there is no parsed content
 * left to copy aside, so keeping `final` itself, unmodified, is the only remaining protection. See the
 * decision record.
 *
 * @decision 8db913e2 (Follow-up 7a7e041b) — reads on-disk tokens via {@link readSurvivingOnDiskTokens} (shared with
 * {@link reconcileMarkedBasenameBeforeWrite}) and skips the copy-aside when every real on-disk token is
 * already cleared — see the decision record for why that's safe.
 *
 * @decision 4913e721 — `provenanceUnknown` is OR'd with {@link inMemoryProvenanceUnknownFor}'s own live
 * scan AND (when its identity matches `occupantRepoPath`) `knownOccupant`'s own mark — never disk bytes
 * alone. See the decision record. */
function protectOccupantContentBeforeDelete(final: string, occupantRepoPath: string, describeClearer: string, liftedKeys: ReadonlySet<string> = new Set(), knownOccupant?: MergeQuarantineEntry): ProtectResult {
  let raw: string;
  try {
    raw = fs.readFileSync(final, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ok: true }; // missing — nothing to protect
    // @decision 63e49ee2 (round 3) — the caller already confirmed `occupantRepoPath` via an EARLIER
    // successful read; THIS read failing (a second, independent attempt) still needs the same
    // identity-less ownership mark as every other "unknown" branch, or no one ever marks this file kept.
    keptUnreadableLatchFiles.add(path.basename(final));
    // eslint-disable-next-line no-console
    console.error(`[merge-quarantine] could not read ${path.basename(final)} (for a reason other than being missing) while protecting it for ${occupantRepoPath} before clearing ${describeClearer} — treating this as UNKNOWN rather than nothing to protect; it is marked kept in THIS PROCESS too, and ${path.basename(final)} is kept on disk, unmodified, instead of being overwritten or deleted.`);
    return { ok: false };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { ok: true }; } // corrupt — nothing to protect
  if (!isReadableLatchRecord(parsed)) return { ok: true }; // e.g. the bare literal `null` — nothing to protect
  if (typeof parsed.repoPath !== "string" || typeof parsed.branch !== "string" || typeof parsed.reason !== "string") return { ok: true };
  const { raw: rawTokens, surviving: survivingTokens } = readSurvivingOnDiskTokens(parsed);
  // @decision 8db913e2 (Follow-up 7a7e041b) — every real on-disk token was already deliberately cleared by
  // THIS process — there is no owner left to protect, so skip the copy-aside entirely rather than persist
  // an empty or random-token record. See this function's own jsdoc above for why this is safe.
  if (rawTokens.length > 0 && survivingTokens.length === 0) return { ok: true };
  const tokens = survivingTokens.length > 0 ? survivingTokens : [randomUUID()];
  // @decision 8db913e2 (Follow-up 4b06875f) — carry the occupant's own on-disk `resolvedKey` onto
  // `toPersist` via the shared {@link excludeLiftedResolvedKey} chokepoint — see that function's own doc.
  const occupantResolvedKey = typeof parsed.resolvedKey === "string" ? parsed.resolvedKey : undefined;
  const resolvedKeyToCarry = excludeLiftedResolvedKey(occupantResolvedKey, final, liftedKeys);
  // @decision 8db913e2 (Follow-up 43cf3b26) — plural counterpart of the scalar carry-forward just above.
  const occupantResolvedKeys = Array.isArray(parsed.resolvedKeys) && parsed.resolvedKeys.every((s): s is string => typeof s === "string")
    ? parsed.resolvedKeys : undefined;
  const resolvedKeysToCarry = excludeLiftedResolvedKeys(occupantResolvedKeys, final, liftedKeys);
  const toPersist: MergeQuarantineEntry = {
    repoPath: parsed.repoPath, branch: parsed.branch, reason: parsed.reason,
    opId: typeof parsed.opId === "string" ? parsed.opId : undefined,
    enteredAt: typeof parsed.enteredAt === "number" ? parsed.enteredAt : Date.now(),
    tokens,
    orphanLatchFiles: Array.isArray(parsed.orphanLatchFiles) && parsed.orphanLatchFiles.every((s): s is string => typeof s === "string")
      ? parsed.orphanLatchFiles : undefined,
    // @decision 82032b5c — carry `contributorRepoPaths` forward too, or this protective copy silently
    // drops the runtime-union provenance the on-disk `final` was carrying, reopening clear-by-id ambiguity
    // for whatever survives via this copy.
    contributorRepoPaths: Array.isArray(parsed.contributorRepoPaths) && parsed.contributorRepoPaths.every((s): s is string => typeof s === "string")
      ? parsed.contributorRepoPaths : undefined,
    // @decision db0a9db0 — same carry-forward, same reason, for this explicit field whitelist.
    // @decision 4913e721 — see this function's own doc for the two in-memory sources OR'd in here too.
    provenanceUnknown: parsed.provenanceUnknown === true
      || inMemoryProvenanceUnknownFor(occupantRepoPath)
      || (knownOccupant !== undefined && directPathIdentity(knownOccupant.repoPath) === directPathIdentity(occupantRepoPath) && knownOccupant.provenanceUnknown === true)
      ? true : undefined,
    // @decision db0a9db0 (round 2) — same carry-forward for the precision-guard field.
    provenanceTracked: parsed.provenanceTracked === true ? true : undefined,
    // @decision 8db913e2 (Follow-up 4b06875f) — see the guard computed just above; `undefined` here is the pre-existing,
    // unchanged behavior for every self-consistently-filed (collision) occupant.
    resolvedKey: resolvedKeyToCarry,
    resolvedKeys: resolvedKeysToCarry,
  };
  const finalBasename = path.basename(final);
  // @decision 8db913e2 (Follow-up 6451a749) — route through the SAME chokepoint `mintPendingDivert`
  // uses, never an in-memory-only lookup: an on-disk occupant never scanned, or now living at a
  // `-collision-` file, must never be silently overwritten.
  const diskReconciled = reconcilePendingDivertTarget(toPersist);
  const { filename } = diskReconciled;
  const atFilenameIdx = pendingUnresolvedQuarantines.findIndex((p) => p.sourceFile === filename);
  const atFinalBasenameIdx = finalBasename === filename ? -1 : pendingUnresolvedQuarantines.findIndex((p) => p.sourceFile === finalBasename);
  // Capture BOTH indices' own current entries NOW, before anything below unions against them or mutates
  // the array — `oldAtFinalBasename` in particular must be read now, since branch 1 below splices that
  // slot away.
  const oldAtFilename = atFilenameIdx >= 0 ? pendingUnresolvedQuarantines[atFilenameIdx]!.entry : undefined;
  const oldAtFinalBasename = atFinalBasenameIdx >= 0 ? pendingUnresolvedQuarantines[atFinalBasenameIdx]!.entry : undefined;
  // @decision 8db913e2 (Follow-up cd5a3cf9) — a basename match is never proof of same identity; gate
  // every union/re-point use of `oldAtFilename`/`oldAtFinalBasename` below on a verified identity match
  // against `toPersist.repoPath`, captured here before any union or mutation. See the decision record.
  const occupantIdentity = directPathIdentity(toPersist.repoPath);
  const atFilenameSameIdentity = oldAtFilename !== undefined && directPathIdentity(oldAtFilename.repoPath) === occupantIdentity;
  const atFinalBasenameSameIdentity = oldAtFinalBasename !== undefined && directPathIdentity(oldAtFinalBasename.repoPath) === occupantIdentity;
  // @decision 8db913e2 (Follow-up 6451a749, Round 2) — ALSO union the in-memory record at
  // `atFilenameIdx` (never `atFinalBasenameIdx`) ON TOP of the disk read above — memory can legitimately
  // outrun disk (an earlier durable write for this identity already failed); see the decision record.
  // @decision 8db913e2 (card 050a4428) — ACCEPTED RESIDUAL: this entry's own `resolvedKey` can be a STALE,
  // never-filtered copy that resurrects an unrelated key a prior union already excluded (fail-closed only).
  // @decision 8db913e2 (Follow-up cd5a3cf9) — gated on `atFilenameSameIdentity`, never the bare index.
  const toWriteUnfiltered = atFilenameSameIdentity
    ? unionQuarantineEntries(diskReconciled.toWrite, oldAtFilename!, { explicitResolvedKeyRule: true })
    : diskReconciled.toWrite;
  // @decision 8db913e2 (Follow-up 4b06875f, Round 2) — re-apply the SAME exclusion to whatever either
  // union above produced — a union against an on-disk or in-memory sibling can reintroduce a key
  // `toPersist` already correctly excluded; never trust a union's own output unfiltered.
  // @decision 8db913e2 (Follow-up 43cf3b26) — plural counterpart of the re-filter just above.
  const toWrite: MergeQuarantineEntry = toWriteUnfiltered.resolvedKey === undefined && toWriteUnfiltered.resolvedKeys === undefined
    ? toWriteUnfiltered
    : {
      ...toWriteUnfiltered,
      resolvedKey: excludeLiftedResolvedKey(toWriteUnfiltered.resolvedKey, final, liftedKeys),
      resolvedKeys: excludeLiftedResolvedKeys(toWriteUnfiltered.resolvedKeys, final, liftedKeys),
    };
  // @decision 8db913e2 (Follow-up 4b06875f) — `toPersist`/`toWrite` carry `resolvedKey` ONLY as filtered by
  // `excludeLiftedResolvedKey` (never `armedKeys`) — including the in-memory entry a union below may
  // introduce; nothing here bypasses that filter. This keeps 82032b5c/c9114934's own invariant intact.
  // @decision 702b4241 (round 4) — use whatever `writePendingDivertFile` ACTUALLY wrote to below, never
  // `filename`/`toWrite` unconditionally — `filename` can itself be marked `keptUnreadableLatchFiles`
  // (see the decision record's "Round 4" section), in which case the write redirects elsewhere.
  // @decision 2dd97aaa (Follow-up 535fd69d) — `toWrite` is a copy-aside of `occupantRepoPath`'s own content (already filtered
  // through `clearedTokens` at READ time, via `readSurvivingOnDiskTokens`), never a narrowing of a token
  // set this call itself decided to drop; `droppedTokens` is empty.
  const written = writePendingDivertFile(filename, toWrite, new Set());
  if (!written) {
    // @decision 4900c365 (round 2) — re-establish an in-memory record that OWNS `final` at its OWN
    // current name (self-referenced in `orphanLatchFiles`): enforces in THIS process too, not only on a
    // later boot, and every reference-aware sweep in this module already honours this ownership shape.
    //
    // @decision 8db913e2 (Follow-up 6451a749, Round 2) — `orphanLatchFiles` comes from `toPersist`
    // ALONE, never `toWrite`: `toWrite` can carry a FOREIGN orphan reference (from `filename`'s own
    // record); `kept` lives at `finalBasename` and must never inherit one to wrongly sweep later.
    const kept: MergeQuarantineEntry = {
      ...toWrite,
      orphanLatchFiles: [...new Set([...(toPersist.orphanLatchFiles ?? []), finalBasename])],
    };
    // @decision 8db913e2 (Follow-up 37452ddd) — `oldAtFinalBasename` can ALSO be an 883e29bc twin armed
    // in `activeQuarantines`; re-point via `replaceEntryEverywhere` before overwriting this slot, or the
    // active side is left pointing at an object this double-fault branch is about to discard.
    // @decision 8db913e2 (Follow-up cd5a3cf9) — gated on `atFinalBasenameSameIdentity`, never the bare
    // index: a mismatched-identity slot is left completely untouched, not re-pointed or overwritten.
    if (atFinalBasenameSameIdentity) {
      replaceEntryEverywhere(activeQuarantines, oldAtFinalBasename!, kept);
      pendingUnresolvedQuarantines[atFinalBasenameIdx] = { entry: kept, sourceFile: finalBasename };
    } else {
      pendingUnresolvedQuarantines.push({ entry: kept, sourceFile: finalBasename });
    }
    // eslint-disable-next-line no-console
    console.error(`[merge-quarantine] could not durably write a fresh pending-divert copy for degraded occupant ${occupantRepoPath} before clearing ${describeClearer} — ${finalBasename} is kept on disk, as its OWN self-owned pending record, instead; ${occupantRepoPath} stays enforced in THIS PROCESS too (not only after a later boot).`);
    // @decision 182c01cc — even on this double-fault fallback, the occupant genuinely survives (in
    // memory, at its OWN old name) — name it, so a caller's "still blocked" report isn't silently blind
    // to this branch just because the durable write failed.
    //
    // @decision 182c01cc (round 4, CR3 MAJOR) — `relocated:false`: nothing new was minted, the occupant
    // stays at `finalBasename` — a caller must bucket this as KEPT, never relocated.
    return { ok: false, persisted: { repoPath: toPersist.repoPath, sourceFile: finalBasename }, relocated: false };
  }
  // @decision 63e49ee2 (round 5) — `final`'s own content is now durably copied aside (the write above
  // just succeeded) — a read-failure mark on `final`'s OWN basename (distinct from `filename`, already
  // cleared inside writePendingDivertFile) no longer needs to block deleting `final` itself.
  keptUnreadableLatchFiles.delete(finalBasename);
  // Commit the DURABLE (never the stale boot-time) content to memory too, so a later in-process query —
  // or a later protect call that finds this same ref via `atFilenameIdx` — never sees the contaminated
  // object again. Re-point any EXISTING pending reference to `final`'s own basename (e.g. its boot-time
  // degraded-divert push) onto the new, durable filename — never leave it dangling at the name about to
  // be deleted.
  //
  // @decision 8db913e2 (Follow-up 37452ddd) — EITHER index's own entry can be an 883e29bc twin, and the
  // two indices' entries can be TWO DIFFERENT objects (one armed, one pending-only) — re-point BOTH via
  // `replaceEntryEverywhere` before either slot is overwritten/discarded, or the active side goes stale.
  // @decision 8db913e2 (Follow-up cd5a3cf9) — every branch below is gated on `atFilenameSameIdentity`/
  // `atFinalBasenameSameIdentity`, never the bare index — a mismatched-identity slot is left completely
  // untouched (no union, no re-point, no splice) and falls through to the independent-mint `else` below.
  if (atFilenameSameIdentity) {
    replaceEntryEverywhere(activeQuarantines, oldAtFilename!, written.entry);
    if (atFinalBasenameSameIdentity) replaceEntryEverywhere(activeQuarantines, oldAtFinalBasename!, written.entry);
    pendingUnresolvedQuarantines[atFilenameIdx] = { entry: written.entry, sourceFile: written.filename };
    if (atFinalBasenameSameIdentity) pendingUnresolvedQuarantines.splice(atFinalBasenameIdx, 1);
  } else if (atFinalBasenameSameIdentity) {
    // @decision 8db913e2 (Follow-up 37452ddd) — re-point for the REPLACEMENT only, never as a union
    // source — `c9114934` still forbids unioning `atFinalBasenameIdx`'s own tokens into `toWrite`.
    replaceEntryEverywhere(activeQuarantines, oldAtFinalBasename!, written.entry);
    pendingUnresolvedQuarantines[atFinalBasenameIdx] = { entry: written.entry, sourceFile: written.filename };
  } else {
    // @decision 1922be3a (round 4) — ALWAYS mint an independent, durably-tracked pending record here;
    // never fold into a live entry's own `orphanLatchFiles` (round 2's now-removed
    // `liveEntrySupersettingTokens` branch resurrected a cleared token — see the decision record).
    pendingUnresolvedQuarantines.push({ entry: written.entry, sourceFile: written.filename });
  }
  // @decision 182c01cc — every branch above durably persists the occupant at `written.filename`; name it
  // once here rather than duplicating this at each branch. `toPersist.repoPath` (never toWrite's, which
  // can carry a union) is always this function's own occupant identity.
  //
  // @decision 182c01cc (round 4, CR3 MAJOR) — `relocated:true`: the write above just succeeded, so
  // `written.filename` genuinely names a new/re-pointed latch, distinct from `final`'s own basename.
  return { ok: true, persisted: { repoPath: toPersist.repoPath, sourceFile: written.filename }, relocated: true };
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
 * Built by hand, never via {@link unionQuarantineEntries} (its binary older/newer arbitration and
 * `explicitResolvedKeyRule` plumbing don't fit this function's own N-ary matched set) — `armedKeys`
 * itself is carried forward via the SAME shared {@link unionArmedKeys} helper {@link divertRaiseEntry}
 * uses, never hand-rolled a second time.
 * Keeps (and durably rewrites) the EARLIEST-`enteredAt` matched entry's own `sourceFile` — mirrors
 * `enterMergeQuarantine`'s own "existing" branch's "longest-outstanding raise wins the identity" rule —
 * folding every OTHER matched entry's own `sourceFile` into `orphanLatchFiles` (defensive: in production
 * this is expected to always be a single match, since the caller's own `siblingIndices` is always empty
 * while `repoPath` is unresolvable).
 *
 * @decision 64283e06 — a matched entry can be an 883e29bc boot-diverted TWIN (same reference ALSO armed
 * in `activeQuarantines`) — never rewrite only the pending side; route each through {@link
 * replaceEntryEverywhere} onto `merged`, or the active side goes stale.
 *
 * @decision 8db913e2 (Follow-up 3d27c045) — `merged` must ALSO carry that twin's own `armedKeys` forward (via {@link
 * unionArmedKeys}), not just get re-pointed to by `replaceEntryEverywhere` — see the decision record for
 * the post-reboot re-block this fixes.
 */
function mergeTokenIntoPendingEntries(indices: number[], token: string): string {
  const matched = indices.map((i) => pendingUnresolvedQuarantines[i] as PendingUnresolvedQuarantine);
  for (const i of [...indices].sort((a, b) => b - a)) pendingUnresolvedQuarantines.splice(i, 1); // descending so earlier indices stay valid
  const base = matched.reduce((a, b) => (a.entry.enteredAt <= b.entry.enteredAt ? a : b));
  const others = matched.filter((p) => p !== base);
  // @decision 702b4241 (round 7) — same filter as divertRaiseEntry's own identical union (and
  // reconcileMarkedBasenameBeforeWrite's reingest branch, round 4): a matched pending entry here can be a
  // boot-time UNREADABLE placeholder, whose bare synthetic token must never ride into a durable union.
  const tokens = [...new Set([...matched.flatMap((p) => p.entry.tokens).filter((t) => !unreadablePlaceholderTokens.has(t)), token])];
  const orphanLatchFiles = [...new Set([
    ...(base.entry.orphanLatchFiles ?? []),
    ...others.flatMap((p) => p.entry.orphanLatchFiles ?? []),
    ...others.map((p) => p.sourceFile).filter((f) => f !== base.sourceFile),
  ])];
  // @decision 82032b5c — carry `contributorRepoPaths` forward from every matched entry (all matched
  // entries share ONE identity here, by construction — see this function's own doc — so there is never
  // a new contributor to originate, only ones already recorded elsewhere to preserve).
  const contributorRepoPaths = [...new Set(matched.flatMap((p) => p.entry.contributorRepoPaths ?? []))];
  // @decision db0a9db0 — same cross-matched OR as contributorRepoPaths above: the bare `...base.entry`
  // spread below only carries BASE's own value — a non-base matched entry's own flag would be silently
  // dropped without this, the exact drop class 82032b5c's own field already guards against.
  const provenanceUnknown = matched.some((p) => p.entry.provenanceUnknown) ? true : undefined;
  // @decision db0a9db0 (round 2) — same cross-matched OR for the precision-guard field.
  const provenanceTracked = matched.some((p) => p.entry.provenanceTracked) ? true : undefined;
  // @decision 8db913e2 (Follow-up 00fd29d7) — union EVERY informative resolvedKey/resolvedKeys across all
  // matched entries, never spread only `base.entry`'s own (the SAME fail-open d524d1c4 fixed in
  // divertRaiseEntry) — see the shared helper's own doc.
  const { resolvedKey, resolvedKeys } = unionInformativeResolvedKeys(matched.map((p) => p.entry), `mergeTokenIntoPendingEntries(${base.entry.repoPath})`);
  // @decision 8db913e2 (Follow-up 3d27c045) — union EVERY matched entry's own `armedKeys` too, never spread only `base.entry`'s
  // own (the SAME fail-open d524d1c4/00fd29d7 fixed for resolvedKey/resolvedKeys) — see the shared
  // helper's own doc.
  const armedKeys = unionArmedKeys(matched.map((p) => p.entry));
  const merged: MergeQuarantineEntry = {
    ...base.entry, tokens, orphanLatchFiles: orphanLatchFiles.length > 0 ? orphanLatchFiles : undefined,
    contributorRepoPaths: contributorRepoPaths.length > 0 ? contributorRepoPaths : undefined,
    provenanceUnknown, provenanceTracked,
    resolvedKey, resolvedKeys, armedKeys,
  };
  for (const m of matched) replaceEntryEverywhere(activeQuarantines, m.entry, merged);
  // @decision 8db913e2 (Follow-up 0dc514dc) — a DIFFERENT surviving pending entry can structurally depend on this EXACT
  // sourceFile (882d6cff's shared-corrupt-latch shape); content can't discriminate (a placeholder's
  // tokens never appear on disk), so this reuses the clear path's own structural check instead.
  if (survivingSharedClaimRepoPaths(base.sourceFile).length > 0) {
    divertRaiseEntry(merged);
    return token;
  }
  // @decision 702b4241 (round 3) — use whatever `writePendingDivertFile` ACTUALLY wrote to, never
  // `base.sourceFile` unconditionally: a marked basename redirects to a fresh record instead.
  // @decision 2dd97aaa (Follow-up 535fd69d) — `merged` unions `matched` plus the new `token`; it never drops a token, so
  // `droppedTokens` is empty.
  const written = writePendingDivertFile(base.sourceFile, merged, new Set());
  if (written) {
    if (written.entry !== merged) replaceEntryEverywhere(activeQuarantines, merged, written.entry);
    pendingUnresolvedQuarantines.push({ entry: written.entry, sourceFile: written.filename });
  } else {
    pendingUnresolvedQuarantines.push({ entry: merged, sourceFile: base.sourceFile });
    // eslint-disable-next-line no-console
    console.error(`[merge-quarantine] canonical repo ${merged.repoPath} is quarantined IN THIS PROCESS ONLY right now (merged into its own still-unresolvable pending latch) — the durable pending-divert latch failed to re-write (see the error just above), so a daemon restart BEFORE that is fixed would silently LIFT this quarantine instead of re-arming it. Investigate (disk full? permissions on ${MERGE_QUARANTINE_DIR}?) immediately.`);
  }
  return token;
}

/**
 * Decides whether a RAISE's own write to `final` (`key`'s physical file, with the degraded-occupant guard
 * skipped per `e1cb7d33`) may proceed as-is or must be DIVERTED away from `final` entirely — NEVER
 * decides to carry forward on-disk tokens itself; that union is {@link reconcileMarkedBasenameBeforeWrite}'s
 * own job, run uniformly for every writer (raise or not) right at `writeMergeQuarantineLatch`'s own
 * chokepoint, so there is exactly one place that logic lives. `protectOk` is the return of whichever
 * protect call ({@link protectDegradedOccupantBeforeDelete} / {@link protectUnincorporatedOccupantBeforeDelete})
 * the caller already ran against `final` for `ownRepoPath` — this function never re-runs that call, only
 * reacts to its result and, when needed, re-reads `final` directly. `ownTokens` are the tokens the write
 * already carries forward (the existing-branch caller's own pre-token-overlap entry, or a brand-new
 * raise's own single fresh token) — used ONLY for the same "already incorporated" exemption
 * {@link unincorporatedOccupantRepoPathAt} itself already grants, so this never re-flags as foreign
 * content `entry`'s own protect call already correctly cleared via token overlap.
 *
 * @decision e0192ffb — re-derives that exemption rather than widening it; a different identity already
 * covered by token overlap is not foreign content to protect.
 *
 * `protectOk === false` (or `final`'s basename is marked {@link keptUnreadableLatchFiles}, which can be
 * STALE for OUR OWN identity — see below): this function re-reads `final` itself, directly, to decide
 * rather than trusting either boolean blindly. `ENOENT`/`EISDIR` ⇒ unchanged (proceed) — `final` is
 * either genuinely absent or a DIRECTORY, which can never hold valid latch content in this module (see
 * {@link reconcileMarkedBasenameBeforeWrite}'s own doc for why that carve-out is safe), so there is
 * nothing real to lose. Any OTHER read error (EACCES/EPERM/EMFILE/...) means a REAL file exists that
 * cannot be read right now — divert, never overwrite blind. A SUCCESSFUL read: same identity, or a
 * different identity already covered by token overlap (the existing-branch's own exemption, re-derived)
 * ⇒ proceed (the chokepoint still runs its own union for the same-identity case); a different,
 * still-unresolvable identity ⇒ durably protect it before this raise's own write proceeds, diverting
 * only if THAT protect call also fails; corrupt or a different-but-resolvable identity ⇒ proceed
 * (nothing to protect — today's existing, deliberately-unprotected case).
 *
 * @decision 8db913e2 — see the decision record.
 */
function resolveRaiseOverwrite(final: string, ownRepoPath: string, ownTokens: string[], protectOk: boolean, liftedKeys: ReadonlySet<string> = new Set()): boolean {
  if (protectOk && !keptUnreadableLatchFiles.has(path.basename(final))) return false; // proceed (not divert)
  let raw: string;
  try {
    raw = fs.readFileSync(final, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR") return false; // nothing real there — proceed
    return true; // a real file exists but is still unreadable — divert, never overwrite blind
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return false; } // corrupt — nothing usable, proceed
  if (!isReadableLatchRecord(parsed)) return false; // e.g. the bare literal `null` — nothing usable, proceed
  if (typeof parsed.repoPath !== "string") return false;
  if (directPathIdentity(parsed.repoPath) === directPathIdentity(ownRepoPath)) return false; // same identity — proceed; the chokepoint unions on-disk tokens forward
  if (isRepoPathCurrentlyResolvable(parsed.repoPath)) {
    // @decision 8db913e2 (Follow-up 0dc514dc, Round 2) — "resolvable ⇒ safe" is false on a double fault (this raise's own
    // protect-copy just failed to write); gated on `!protectOk` so a transient-duplicate copy never
    // reaches it. Reuses `parsed` — never a second read.
    if (protectOk) return false;
    const { surviving } = readSurvivingOnDiskTokens(parsed);
    if (survivingTokenHolderRepoPaths(surviving, directPathIdentity(ownRepoPath)).length === 0) return false;
    return true; // still held elsewhere — divert, never overwrite blind
  }
  // @decision 8db913e2 (Follow-up 25f6a7dc) — route through the SHARED reader, never a re-derived inline parser: see
  // `unincorporatedOccupantRepoPathAt`'s own matching fix for why skipping its empty-array fallback here
  // wrongly treats an already-incorporated legacy token as foreign. See the decision record.
  const { raw: onDiskTokens } = readSurvivingOnDiskTokens(parsed);
  // Already incorporated via token overlap — see this function's own doc comment above.
  if (onDiskTokens.length > 0 && onDiskTokens.some((t) => ownTokens.includes(t))) return false;
  // A different, still-unresolvable identity physically occupies `final` right now (confirmed by THIS
  // fresh read) — protect it durably before letting this raise's own write proceed; divert ONLY if that
  // protective copy itself fails.
  return !protectOccupantContentBeforeDelete(final, parsed.repoPath, ownRepoPath, liftedKeys).ok;
}

/**
 * Fallback for {@link divertRaiseEntry}'s own DOUBLE FAULT: the divert's own pending-divert write ALSO
 * failed (e.g. ENOSPC), so `entry` is enforced in THIS PROCESS ONLY and would otherwise be silently lost
 * on the next reboot. {@link writeSafetyTmpResidueAtHash}'s own output IS already recovered at boot
 * (`reenterMergeQuarantinesAtBoot`'s dedicated safety-tmp recovery pass, which recomputes
 * `canonicalRepoLockKey(entry.repoPath)` itself rather than trusting the hash embedded in the filename —
 * so the hash passed here need not be "correct" for ANY given degraded/collided shape, only distinct from
 * an unrelated final) — so a best-effort safety-tmp write here closes the reboot-survival gap the pending
 * write's own failure opened, without inventing any new boot-recovery machinery.
 *
 * Returns the tmp's own basename on success — the CALLER must re-point its own pending record's
 * `sourceFile` at it, and fold it into that entry's own `orphanLatchFiles` via `replaceEntryEverywhere`,
 * mirroring Phase 0's established pattern (`ef651188`, round 2, ~L4163) — this function only writes the
 * bytes (with `selfReference: true`, which bakes the self-reference into THOSE bytes alone), it never
 * touches the in-memory `pendingUnresolvedQuarantines`/`activeQuarantines` structures itself. Returns
 * `false` on failure (logs loudly either way).
 *
 * @decision 8db913e2 (Follow-up dd34da46, Item 3) — never throws. See the decision record's Round 2 note
 * for the BLOCKER this signature closes: a round-1 version wrote the tmp but never re-pointed the
 * pending record at it, leaving the write durably orphaned and the token lost on the next reboot anyway.
 */
function attemptDivertSafetyTmpFallback(entry: MergeQuarantineEntry): string | false {
  const safetyTmp = writeSafetyTmpResidueAtHash(quarantineHashFor(entry.repoPath), entry, true);
  if (safetyTmp) {
    const basename = path.basename(safetyTmp);
    // eslint-disable-next-line no-console
    console.error(`[merge-quarantine] canonical repo ${entry.repoPath} is quarantined IN THIS PROCESS ONLY right now (diverted raise, its own pending-divert latch ALSO failed to write) — a SAFETY-TMP residue (${basename}) was written instead and WILL be recovered at the next boot (reenterMergeQuarantinesAtBoot's own safety-tmp recovery pass); investigate the pending-divert write failure anyway.`);
    return basename;
  }
  // eslint-disable-next-line no-console
  console.error(`[merge-quarantine] canonical repo ${entry.repoPath} is quarantined IN THIS PROCESS ONLY right now (diverted raise, its own pending-divert latch ALSO failed to write) — the SAFETY-TMP fallback ALSO failed to write (see the error just above) — this quarantine will NOT survive a restart; investigate (disk full? permissions on ${MERGE_QUARANTINE_DIR}?) immediately.`);
  return false;
}

/**
 * Reads a pending-divert FILENAME's own CURRENT on-disk content, right now, and reconstructs a
 * {@link MergeQuarantineEntry} from it using the SAME explicit field whitelist this module already trusts
 * at every copy-aside/union site (`82032b5c`/`db0a9db0`) — never more of the parsed JSON than that.
 * Shared by both the primary-filename check and the existing-collision-file scan in
 * {@link reconcilePendingDivertTarget} below, so the two never drift on what counts as "readable,
 * trustworthy content" at this deterministic path shape.
 *
 * Returns `"enoent"` (nothing real there) or `"unsafe"` (a directory, a genuinely unreadable file right
 * now, corrupt JSON, a non-object/`null` parse, or no `repoPath` string — none of these can be proven
 * safe to trust) — the caller decides what either means for ITS OWN write; this function never does.
 *
 * @decision 8db913e2 (Follow-up 6451a749)
 */
function readPendingDivertFileAt(filePath: string): { state: "enoent" } | { state: "unsafe" } | { state: "entry"; entry: MergeQuarantineEntry } {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { state: "enoent" };
    return { state: "unsafe" }; // EISDIR, or any other unreadable-file code
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: "unsafe" }; // corrupt
  }
  if (!isReadableLatchRecord(parsed) || typeof parsed.repoPath !== "string") return { state: "unsafe" };
  const { surviving } = readSurvivingOnDiskTokens(parsed);
  const entry: MergeQuarantineEntry = {
    repoPath: parsed.repoPath,
    branch: typeof parsed.branch === "string" ? parsed.branch : "",
    reason: typeof parsed.reason === "string" ? parsed.reason : "",
    opId: typeof parsed.opId === "string" ? parsed.opId : undefined,
    enteredAt: typeof parsed.enteredAt === "number" ? parsed.enteredAt : Date.now(),
    tokens: surviving,
    // @decision 82032b5c / db0a9db0 — same explicit field carry-forward every other reader of a parsed
    // latch record in this module already does; never trust more of `parsed` than this whitelist.
    orphanLatchFiles: Array.isArray(parsed.orphanLatchFiles) && parsed.orphanLatchFiles.every((s): s is string => typeof s === "string")
      ? parsed.orphanLatchFiles : undefined,
    contributorRepoPaths: Array.isArray(parsed.contributorRepoPaths) && parsed.contributorRepoPaths.every((s): s is string => typeof s === "string")
      ? parsed.contributorRepoPaths : undefined,
    provenanceUnknown: parsed.provenanceUnknown === true ? true : undefined,
    provenanceTracked: parsed.provenanceTracked === true ? true : undefined,
    // @decision 8db913e2 (Follow-up 4b06875f, Round 2) — this reader used to drop `resolvedKey`
    // entirely, so a union against it always saw it as absent regardless of the file's real content.
    resolvedKey: typeof parsed.resolvedKey === "string" ? parsed.resolvedKey : undefined,
    resolvedKeys: parseResolvedKeysField(parsed),
  };
  return { state: "entry", entry };
}

/**
 * Unions an on-disk pending-divert occupant's own parsed record into a fresh `entry` targeting the SAME
 * identity — via {@link unionQuarantineEntries} itself (never a hand-rolled re-implementation), so tokens
 * AND `orphanLatchFiles`/`contributorRepoPaths`/`provenanceUnknown`/`provenanceTracked` all carry forward
 * together, exactly as {@link protectOccupantContentBeforeDelete}'s own PRE-EXISTING in-memory-match union
 * already did before this card — never silently narrowed to a token-only union.
 *
 * `unionQuarantineEntries` always stamps `armedKeys` as an array (never `undefined`) — normalized back to
 * `undefined` when empty here, mirroring {@link divertRaiseEntry}'s own "never a cosmetic `armedKeys: []`
 * on a record with nothing to carry there" rule; a pending-only record is never armed anywhere.
 *
 * @decision 8db913e2 (Follow-up 6451a749)
 */
function unionIntoOnDiskPendingEntry(onDisk: MergeQuarantineEntry, entry: MergeQuarantineEntry): MergeQuarantineEntry {
  const merged = unionQuarantineEntries(onDisk, entry, { explicitResolvedKeyRule: true });
  return merged.armedKeys && merged.armedKeys.length > 0 ? merged : { ...merged, armedKeys: undefined };
}

/**
 * Scans {@link MERGE_QUARANTINE_DIR} for an EXISTING `-collision-` file already minted for `repoPath`'s
 * own identity — the deterministic `pending-<24hex>` prefix {@link pendingDivertFilenameFor} derives,
 * shared by every collision file {@link pendingDivertCollisionFilenameFor} ever mints for that SAME
 * identity — and returns the first one that is both readable and genuinely the same identity. Without
 * this, a repeated collision against the same foreign primary occupant would mint an unbounded number of
 * fresh collision files for one identity instead of converging on one growing record. Never matches a
 * crash-left tmp residue ({@link PENDING_DIVERT_COLLISION_TMP_RE}'s own shape — a torn write, never a
 * live record) and never touches one that is unreadable or genuinely foreign — those are left
 * byte-untouched, exactly like the primary-slot rule.
 *
 * @decision 8db913e2 (Follow-up 6451a749)
 */
function findExistingSameIdentityCollisionFile(repoPath: string): { filename: string; entry: MergeQuarantineEntry } | undefined {
  const prefix = pendingDivertFilenameFor(repoPath).slice(0, -".json".length); // "pending-<24hex>"
  const collisionRe = new RegExp(`^${prefix}-collision-[0-9a-f]{8}\\.json$`);
  let names: string[];
  try {
    names = fs.readdirSync(MERGE_QUARANTINE_DIR);
  } catch {
    return undefined;
  }
  for (const name of names.filter((n) => collisionRe.test(n)).sort()) {
    const read = readPendingDivertFileAt(path.join(MERGE_QUARANTINE_DIR, name));
    if (read.state === "entry" && directPathIdentity(read.entry.repoPath) === directPathIdentity(repoPath)) {
      return { filename: name, entry: read.entry };
    }
  }
  return undefined;
}

/**
 * Reconciles ANY writer's own write target against whatever CURRENTLY occupies
 * {@link pendingDivertFilenameFor}'s own deterministic path for `entry`'s own identity, right before that
 * write happens — a blind overwrite here could destroy another live record's own latch with zero
 * in-memory signal. Shared by {@link mintPendingDivert} (a fresh mint) AND
 * {@link protectOccupantContentBeforeDelete} (copying a degraded/foreign occupant's content aside before
 * an unconditional unlink) — ONE occupant-aware chokepoint, never a second, independently-maintained copy.
 *
 * ENOENT -> nothing real there, write `entry` unchanged at the primary filename. The SAME identity already
 * occupies the PRIMARY filename -> union `entry` into it via {@link unionIntoOnDiskPendingEntry} (tokens
 * AND orphanLatchFiles/contributorRepoPaths/provenanceUnknown/provenanceTracked — never tokens alone),
 * still at the primary filename. A DIFFERENT identity, or an unreadable/corrupt/EISDIR/no-repoPath file at
 * the primary -> never overwrite it AND never move it (relocating it could break whatever else still
 * references its own path) -- look for an EXISTING `-collision-` file already minted for THIS SAME
 * identity ({@link findExistingSameIdentityCollisionFile}) and union into it if one qualifies, so repeated
 * collisions against the same primary occupant converge on one record instead of proliferating; mint a
 * brand-new {@link pendingDivertCollisionFilenameFor} filename only when none does.
 *
 * @decision 8db913e2 (Follow-up 8a79dd31) — the primary-vs-collision divert rule itself.
 * @decision 8db913e2 (Follow-up 6451a749) — generalized to a second caller that used to trust only an
 * in-memory lookup, and widened to union into an existing collision file rather than minting fresh ones.
 */
function reconcilePendingDivertTarget(entry: MergeQuarantineEntry): { filename: string; toWrite: MergeQuarantineEntry } {
  const primary = pendingDivertFilenameFor(entry.repoPath);
  const primaryRead = readPendingDivertFileAt(path.join(MERGE_QUARANTINE_DIR, primary));
  if (primaryRead.state === "enoent") return { filename: primary, toWrite: entry };
  if (primaryRead.state === "entry" && directPathIdentity(primaryRead.entry.repoPath) === directPathIdentity(entry.repoPath)) {
    return { filename: primary, toWrite: unionIntoOnDiskPendingEntry(primaryRead.entry, entry) };
  }
  // Primary is occupied by something we must never touch (a different identity, or unreadable/corrupt/
  // EISDIR/no-repoPath content) -- find-or-mint a collision record instead.
  const existing = findExistingSameIdentityCollisionFile(entry.repoPath);
  if (existing) {
    return { filename: existing.filename, toWrite: unionIntoOnDiskPendingEntry(existing.entry, entry) };
  }
  return { filename: pendingDivertCollisionFilenameFor(entry.repoPath), toWrite: entry };
}

/**
 * Mint a fresh pending-divert record for `entry` at its own deterministic filename — shared by
 * {@link divertRaiseEntry}'s own `indices.length === 0` branch and `enterMergeQuarantine`'s own direct
 * unresolvable brand-new-divert branch. ONE chokepoint, never two independently-maintained copies.
 *
 * @decision 8db913e2 (Follow-up 8a79dd31) — this consolidation also gives `enterMergeQuarantine`'s own call site the
 * double-fault safety-tmp fallback below, which its own prior inline copy never had.
 *
 * @decision 8db913e2 (Follow-up 8a79dd31) — reconciles against the primary filename's current occupant, via
 * {@link reconcilePendingDivertTarget}, before ever writing — see that function's own doc.
 *
 * @decision 8db913e2 (Follow-up dd34da46, Item 3) — on a double fault (the chosen write ALSO fails), falls
 * back to a safety-tmp residue via {@link attemptDivertSafetyTmpFallback} rather than losing the entry
 * outright across a reboot.
 */
function mintPendingDivert(entry: MergeQuarantineEntry): void {
  const { filename, toWrite } = reconcilePendingDivertTarget(entry);
  // Keep the caller's own in-memory placement (if any — e.g. enterMergeQuarantine's `existing` branch
  // already placed `entry` into `activeQuarantines` before calling this) in sync with the reconciled
  // object that is about to become the durable bytes.
  if (toWrite !== entry) replaceEntryEverywhere(activeQuarantines, entry, toWrite);
  // @decision 702b4241 (round 4) — use whatever `writePendingDivertFile` ACTUALLY wrote to, never
  // `filename` unconditionally: `filename` can itself be marked `keptUnreadableLatchFiles` (see the
  // decision record's "Round 4" section for why this reaches a `pending-` name too).
  // @decision 2dd97aaa (Follow-up 535fd69d) — `toWrite` is `reconcilePendingDivertTarget`'s own mint/union result; it never
  // drops a token, so `droppedTokens` is empty.
  const written = writePendingDivertFile(filename, toWrite, new Set());
  if (written) {
    if (written.entry !== toWrite) replaceEntryEverywhere(activeQuarantines, toWrite, written.entry);
    pendingUnresolvedQuarantines.push({ entry: written.entry, sourceFile: written.filename });
    return;
  }
  // eslint-disable-next-line no-console
  console.error(`[merge-quarantine] canonical repo ${toWrite.repoPath} is quarantined IN THIS PROCESS ONLY right now (diverted to a fresh pending-divert record) — the durable pending-divert latch failed to write; investigate (disk full? permissions on ${MERGE_QUARANTINE_DIR}?) immediately.`);
  // @decision 8db913e2 (Follow-up dd34da46, Item 3) — the double fault: a safety-tmp residue is a
  // recoverable fallback, but ONLY once this process's own pending record is re-pointed at it — never
  // left pointing at `filename`, the file that was never actually written.
  const safetyTmpBasename = attemptDivertSafetyTmpFallback(toWrite);
  if (safetyTmpBasename) {
    const secured: MergeQuarantineEntry = { ...toWrite, orphanLatchFiles: [...new Set([...(toWrite.orphanLatchFiles ?? []), safetyTmpBasename])] };
    replaceEntryEverywhere(activeQuarantines, toWrite, secured);
    pendingUnresolvedQuarantines.push({ entry: secured, sourceFile: safetyTmpBasename });
  } else {
    // Triple fault — nothing durable to re-point to; keep the pre-existing (accepted-residual) shape.
    pendingUnresolvedQuarantines.push({ entry: toWrite, sourceFile: filename });
  }
}

/**
 * Divert a VERIFIED raise's own write away from `final` — the raise still durably persists (`e1cb7d33`),
 * just not at its own canonical key's physical file right now. Unions `entry` into EVERY pending record
 * already sharing its own identity by {@link directPathIdentity} (never just the first match), durably
 * rewriting the earliest-`enteredAt` one's own `sourceFile` in place and folding every OTHER matched
 * record's own `sourceFile` into `orphanLatchFiles`; mints a brand-new `pending-<24hex>.json` record
 * (mirroring `enterMergeQuarantine`'s own `!verified` brand-new-divert branch) only when no such record
 * exists yet. Never touches `final` itself — whatever is physically there stays exactly as it was.
 *
 * Built by hand, never via {@link unionQuarantineEntries} — that helper always stamps `armedKeys` as an
 * array (never `undefined`), which would leave a cosmetic-but-needless `armedKeys: []` on a record with
 * nothing to carry there; `armedKeys` itself is still unioned, via the shared {@link unionArmedKeys}
 * helper {@link mergeTokenIntoPendingEntries} also uses, which already normalizes an empty union back to
 * `undefined`.
 *
 * @decision 8db913e2 (round 2, nitpick 4) — mirrors `188b145f`'s own "collect every identity-matching
 * index, never just the first" rule.
 */
function divertRaiseEntry(entry: MergeQuarantineEntry): void {
  const identity = directPathIdentity(entry.repoPath);
  const indices = collectPendingIndices((p) => directPathIdentity(p.entry.repoPath) === identity);
  if (indices.length === 0) {
    mintPendingDivert(entry);
    return;
  }
  const matched = indices.map((i) => pendingUnresolvedQuarantines[i] as PendingUnresolvedQuarantine);
  for (const i of [...indices].sort((a, b) => b - a)) pendingUnresolvedQuarantines.splice(i, 1); // descending so earlier indices stay valid
  const base = matched.reduce((a, b) => (a.entry.enteredAt <= b.entry.enteredAt ? a : b));
  const others = matched.filter((p) => p !== base);
  const all = [base.entry, ...others.map((p) => p.entry), entry];
  // @decision 702b4241 (round 7) — filter OUT every {@link unreadablePlaceholderTokens} member, same rule
  // as reconcileMarkedBasenameBeforeWrite's own reingest branch (round 4): a matched entry here can be a
  // boot-time UNREADABLE placeholder, and its bare synthetic token was never returned to a real caller.
  const tokens = [...new Set(all.flatMap((e) => e.tokens).filter((t) => !unreadablePlaceholderTokens.has(t)))];
  const orphanLatchFiles = [...new Set([
    ...all.flatMap((e) => e.orphanLatchFiles ?? []),
    ...others.map((p) => p.sourceFile).filter((f) => f !== base.sourceFile),
  ])];
  const contributorRepoPaths = [...new Set(all.flatMap((e) => e.contributorRepoPaths ?? []))];
  const provenanceUnknown = all.some((e) => e.provenanceUnknown) ? true : undefined;
  const provenanceTracked = all.some((e) => e.provenanceTracked) ? true : undefined;
  // @decision 8db913e2 — union EVERY informative resolvedKey/resolvedKeys across all of `all`, never
  // spread only `base.entry`'s own (a real post-reboot fail-open). Not `explicitResolvedKeyRule`, not
  // `excludeLiftedResolvedKey(s)` — see the decision record's own "Follow-up d524d1c4" for why neither applies here.
  const { resolvedKey, resolvedKeys } = unionInformativeResolvedKeys(all, `divertRaiseEntry(${base.entry.repoPath})`);
  const merged: MergeQuarantineEntry = {
    ...base.entry, tokens,
    orphanLatchFiles: orphanLatchFiles.length > 0 ? orphanLatchFiles : undefined,
    armedKeys: unionArmedKeys(all),
    contributorRepoPaths: contributorRepoPaths.length > 0 ? contributorRepoPaths : undefined,
    provenanceUnknown, provenanceTracked,
    resolvedKey, resolvedKeys,
  };
  for (const m of matched) replaceEntryEverywhere(activeQuarantines, m.entry, merged);
  replaceEntryEverywhere(activeQuarantines, entry, merged);
  // @decision 702b4241 (round 3) — use whatever `writePendingDivertFile` ACTUALLY wrote to, never
  // `base.sourceFile` unconditionally: `base.sourceFile` can BE the boot-time UNREADABLE placeholder's
  // own self-referenced final — the exact overwrite this round closes. See the decision record.
  // @decision 2dd97aaa (Follow-up 535fd69d) — `merged` unions `all` (every matched twin plus the raise's own `entry`); it
  // never drops a token, so `droppedTokens` is empty.
  const written = writePendingDivertFile(base.sourceFile, merged, new Set());
  if (written) {
    if (written.entry !== merged) replaceEntryEverywhere(activeQuarantines, merged, written.entry);
    pendingUnresolvedQuarantines.push({ entry: written.entry, sourceFile: written.filename });
    return;
  }
  // eslint-disable-next-line no-console
  console.error(`[merge-quarantine] canonical repo ${entry.repoPath} is quarantined IN THIS PROCESS ONLY right now (diverted raise, merged into an existing pending record) — the durable pending-divert latch ALSO failed to re-write; investigate immediately.`);
  // @decision 8db913e2 (Follow-up dd34da46, Item 3) — same re-pointed fallback as the fresh-divert branch
  // above, using `merged` (never the raw `entry`); `replaceEntryEverywhere` also reaches an ALREADY-ARMED
  // twin (the existing-branch divert's own `baseEntry`), not just the pending side.
  const safetyTmpBasename = attemptDivertSafetyTmpFallback(merged);
  if (safetyTmpBasename) {
    const secured: MergeQuarantineEntry = {
      ...merged,
      orphanLatchFiles: [...new Set([...(merged.orphanLatchFiles ?? []), safetyTmpBasename, base.sourceFile])],
    };
    replaceEntryEverywhere(activeQuarantines, merged, secured);
    pendingUnresolvedQuarantines.push({ entry: secured, sourceFile: safetyTmpBasename });
    // @decision 8db913e2 (Follow-up dd34da46, Round 2) — `base.sourceFile`'s own bytes are now STALE
    // (never rewritten, since this write failed) and fully superseded by the safety-tmp; sweep it so it
    // never survives as an untracked orphan a later boot could independently re-arm from (the P3g repro).
    sweepOwnLatchFileUnlessOwnedElsewhere(base.sourceFile);
  } else {
    // Triple fault — nothing durable to re-point to; keep the pre-existing (accepted-residual) shape.
    pendingUnresolvedQuarantines.push({ entry: merged, sourceFile: base.sourceFile });
  }
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
    // @decision 82032b5c — record a genuinely DIFFERENT raiser's identity folded in here, so clear-by-id
    // can fail closed later instead of guessing (canonicalSiblingsFor alone never sees this absorb).
    const contributorRepoPaths = directPathIdentity(repoPath) !== directPathIdentity(existing.repoPath)
      ? [...new Set([...(existing.contributorRepoPaths ?? []), repoPath])]
      : existing.contributorRepoPaths;
    // `existing` may be armed under a SECOND key too (its own resolvedKey) — update every one of those
    // slots to this rebuilt object, not just `key` (round 2 finding 2).
    //
    // @decision 6be6c9ff — derive via {@link liveArmedKeys}, never `existing.armedKeys` alone — the SAME
    // re-pointed multi-key-twin gap this card closes on the clear side; see the decision record.
    const armedKeysForEntry = liveArmedKeys(key, existing);
    const finalForKey = quarantinePathForKey(key);
    // @decision 8db913e2 (Follow-up 78fccd3f) — `liftedKeys` is `ownedKeysIncluding`, NEVER the raw
    // `armedKeysForEntry` — the write loop below already re-gates each secondary key itself. See record.
    const liftedKeys: ReadonlySet<string> = new Set(ownedKeysIncluding(key, existing));
    // @decision e0192ffb — protect a foreign, unincorporated occupant's sole physical copy at `key`'s own
    // final before this branch's two writes (both skip the degraded-occupant guard for `key` itself); must
    // run before `siblingIndices` is collected below. See the decision record.
    //
    // @decision 8db913e2 — thread that protect call's own return into a divert decision; the actual
    // token carry-forward is {@link reconcileMarkedBasenameBeforeWrite}'s own job, called here (via
    // {@link foldInOnDiskTokensIfMarked}) so THIS process's own in-memory entry reflects it too, never
    // only `writeMergeQuarantineLatch`'s own chokepoint.
    const protectOk = protectUnincorporatedOccupantBeforeDelete(finalForKey, existing, undefined, liftedKeys).ok;
    const mustDivert = resolveRaiseOverwrite(finalForKey, existing.repoPath, existing.tokens, protectOk, liftedKeys);
    // @decision 6be6c9ff — stamp the live-derived `armedKeysForEntry` onto the rebuilt object itself (not
    // just used transiently for the write loop below), so a LATER reader of this same object (e.g.
    // `writeMergeQuarantineLatch`'s own resolvedKeys-retention formula) also sees the complete set.
    const baseEntry: MergeQuarantineEntry = { ...existing, tokens: [...existing.tokens, token], contributorRepoPaths, armedKeys: armedKeysForEntry };
    if (mustDivert) {
      replaceEntryEverywhere(activeQuarantines, existing, baseEntry);
      // @decision 8db913e2 — `final` could not be safely protected; divert this raise's own write
      // rather than overwriting it. The raise still persists (e1cb7d33).
      divertRaiseEntry(baseEntry);
      return token;
    }
    // @decision 2dd97aaa (Follow-up 58957b1e) — `baseEntry` only ever APPENDS the fresh token; a raise
    // never drops a token, so `droppedTokens` is empty.
    const folded = foldInOnDiskTokensIfMarked(finalForKey, baseEntry, new Set());
    if (folded === "unreadable") {
      // @decision 8db913e2 (round 3) — a transient failure discovered HERE (after resolveRaiseOverwrite's
      // own earlier read said "proceed") is the CR2 B2 shape — divert now rather than let the later write
      // overwrite blind; the raise still persists (e1cb7d33).
      replaceEntryEverywhere(activeQuarantines, existing, baseEntry);
      divertRaiseEntry(baseEntry);
      return token;
    }
    const entry = folded;
    // @decision 82032b5c (round 2 CR, CRITICAL) — route through replaceEntryEverywhere, never a bare
    // per-key `.set()`: `existing` can ALSO be a PENDING 883e29bc boot-diverted twin's own reference,
    // left stale (and later durably re-written FROM) by a bare `.set()` — see the decision record.
    replaceEntryEverywhere(activeQuarantines, existing, entry);
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
    //
    // @decision 82032b5c — write to EVERY key in `armedKeysForEntry`, never `targetKey=undefined` (which
    // recomputed a FRESH, possibly-degraded `canonicalRepoLockKey(entry.repoPath)` instead of the key(s)
    // actually in `armedKeys`).
    //
    // @decision 82032b5c (round 2 CR, MAJOR) — skip the guard (e1cb7d33: a raise must persist) ONLY for
    // `key` itself, the raise's own freshly-VERIFIED key. A secondary armed key's CURRENT physical file
    // may belong to a wholly different, unresolvable identity — see the decision record.
    //
    // @decision 82032b5c (round 3 CR, MINOR A) — ALSO gate each secondary key on `entryStillOwnsKey`
    // first — the SAME predicate the clear loop uses — skipping a stale, no-longer-owned member outright
    // as belt-and-suspenders on top of the disk-based degraded-occupant guard below.
    let primaryWriteSucceeded = true;
    for (const k of armedKeysForEntry) {
      const isPrimaryKey = k === key;
      if (!isPrimaryKey && !entryStillOwnsKey(k, entry)) continue;
      // @decision 8db913e2 (round 3) — `reconciledAlready: isPrimaryKey`: `entry` was already reconciled
      // against `finalForKey` (== this key's own final) above — only the PRIMARY key's write reuses that
      // SAME read; a secondary key's final is a DIFFERENT physical file and still gets its own chokepoint read.
      // @decision 2dd97aaa (Follow-up 58957b1e) — `entry` only appends the fresh token (never drops) — `droppedTokens` is empty.
      const succeeded = writeMergeQuarantineLatch(entry, new Set(), true, k, isPrimaryKey, isPrimaryKey);
      if (isPrimaryKey) {
        primaryWriteSucceeded = succeeded;
      } else if (!succeeded) {
        // eslint-disable-next-line no-console
        console.warn(`[merge-quarantine] could not durably write ${repoPath}'s own SECONDARY armed key ${k} — the degraded-occupant guard refused it (a DIFFERENT, currently-unresolvable identity may physically own that key's file right now) or the write otherwise failed; the raise itself still persists via its own primary key ${key}.`);
      }
    }
    if (!primaryWriteSucceeded) {
      // eslint-disable-next-line no-console
      console.error(`[merge-quarantine] canonical repo ${repoPath} is quarantined IN THIS PROCESS ONLY right now — the durable latch failed to write (see the error just above), so a daemon restart BEFORE that is fixed would silently LIFT this quarantine instead of re-arming it. Investigate (disk full? permissions on ${MERGE_QUARANTINE_DIR}?) immediately.`);
    }
    return token;
  }
  // @decision 1922be3a (round 2, CRITICAL) — protect BEFORE collecting the pending indices below, never
  // after — the protect call can splice `pendingUnresolvedQuarantines`, corrupting indices collected
  // first. See the decision record.
  //
  // @decision 8db913e2 — thread that protect call's own return into a divert decision, at the SAME
  // point in the sequence, for the same splice-safety reason. See the decision record.
  if (verified) {
    // @decision 8db913e2 (Follow-up 4b06875f, Round 2) — nothing else is armed yet at this key (`verified`
    // means no `existing` was found) — the only key THIS raise's own write touches is its own.
    const liftedKeys: ReadonlySet<string> = new Set([key]);
    const protectOk = protectDegradedOccupantBeforeDelete(quarantinePathForKey(key), repoPath, undefined, liftedKeys).ok;
    const mustDivert = resolveRaiseOverwrite(quarantinePathForKey(key), repoPath, [token], protectOk, liftedKeys);
    if (mustDivert) {
      divertRaiseEntry({ repoPath, branch, reason, opId, enteredAt: Date.now(), tokens: [token] });
      return token;
    }
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
    //
    // @decision 8db913e2 (Follow-up 8a79dd31) — routes through the SAME chokepoint divertRaiseEntry's own `indices.length === 0`
    // branch uses, never a parallel inline copy — see mintPendingDivert's own doc comment.
    const fresh: MergeQuarantineEntry = { repoPath, branch, reason, opId, enteredAt: Date.now(), tokens: [token] };
    mintPendingDivert(fresh);
    return token;
  }
  // @decision 500e307a — stamp provenanceTracked on the in-memory entry at the instant it is CREATED,
  // not only on writeMergeQuarantineLatch's own serialized bytes — this is the brand-new, genuinely
  // fresh raise, so there is nothing legacy to launder: unconditionally true is correct here.
  //
  // @decision 8db913e2 — fold any on-disk tokens forward (same reason as the other two raise sites
  // above) before this entry is armed into `activeQuarantines`.
  const fresh: MergeQuarantineEntry = {
    repoPath, branch, reason, opId, enteredAt: Date.now(), tokens: [token],
    resolvedKey: key, armedKeys: [key], provenanceTracked: true,
  };
  // @decision 2dd97aaa (Follow-up 58957b1e) — a brand-new raise mints `fresh` with nothing to drop.
  const folded = foldInOnDiskTokensIfMarked(quarantinePathForKey(key), fresh, new Set());
  if (folded === "unreadable") {
    // @decision 8db913e2 (round 3) — same CR2 B2 TOCTOU as the existing-branch above: resolveRaiseOverwrite
    // said "proceed" earlier; this later, independent read disagrees — divert rather than overwrite blind.
    divertRaiseEntry(fresh);
    return token;
  }
  const entry = folded;
  activeQuarantines.set(key, entry);
  const persisted = writeMergeQuarantineLatch(entry, new Set(), false, undefined, true, true);
  if (!persisted) {
    // eslint-disable-next-line no-console
    console.error(`[merge-quarantine] canonical repo ${repoPath} is quarantined IN THIS PROCESS ONLY right now — the durable latch failed to write (see the error just above), so a daemon restart BEFORE that is fixed would silently LIFT this quarantine instead of re-arming it. Investigate (disk full? permissions on ${MERGE_QUARANTINE_DIR}?) immediately.`);
  }
  return token;
}

/**
 * `true` iff some entry OBJECT other than `updated` itself — active OR pending, of ANY identity,
 * including `updated`'s own — still physically depends on `filename` as its own current backing. A
 * stronger, OBJECT-reference-aware restatement of {@link physicalOwnerRepoPaths}'s own two loops (which
 * this subsumes: both of its match conditions are strict subsets of the ones here, each additionally
 * gated on `!== updated`). `physicalOwnerRepoPaths` answers "whose IDENTITY owns this filename," which
 * cannot distinguish "this is `updated`'s OWN file" from "this is a DIFFERENT, independent record that
 * merely SHARES `updated`'s identity" — `d4b25feb` round 2 established that one identity can legitimately
 * hold TWO disjoint-token records at once (one active-only, one pending-only). Layer (a) of
 * {@link orphanRewriteOwnershipConfirmed}'s fix.
 *
 * @decision 8db913e2 (Follow-up 29fe2372) — see the decision record for the repro this closes.
 */
function anotherLiveEntryOwnsFile(filename: string, updated: MergeQuarantineEntry): boolean {
  for (const [k, e] of activeQuarantines) {
    if (e === updated) continue;
    const isFreshWriteTarget = isRepoPathCurrentlyResolvable(e.repoPath) && path.basename(quarantinePathFor(e.repoPath)) === filename;
    if (`${quarantineHashForKey(k)}.json` === filename || isFreshWriteTarget) return true;
  }
  for (const p of pendingUnresolvedQuarantines) {
    if (p.entry === updated) continue;
    if (p.sourceFile === filename) return true;
  }
  return false;
}

/**
 * `true` iff every REAL token physically present in `orphanFile`'s own on-disk content right now is
 * already accounted for by `updated`'s own write — either still outstanding on `updated.tokens`, or
 * among the tokens THIS SAME partial clear just dropped (`droppedTokens` — the FULL overlap set this
 * one call is lifting from `updated`, never just one of several, or a file whose on-disk content still
 * names an overlap token this call hasn't yet accounted for would be left stale forever, one token at a
 * time, no matter how many times this is called — see `eedf16f5`) — so overwriting `orphanFile` with
 * `updated` can never durably destroy a token that belonged to anyone else. Layer (b) of
 * {@link orphanRewriteOwnershipConfirmed}'s fix, mirroring {@link markedFinalFullyCoveredByClear}'s own
 * content-containment pattern (`dd34da46`/`95ea8d3f`, which takes the same plural `candidateTokens: string[]`
 * shape) rather than inventing a parallel one. A read failure or corrupt/unparseable JSON can never be
 * proven safe (the caller already skips a genuinely MISSING file via its own `existsSync` check before
 * this is ever reached, so ENOENT/EISDIR need no special-casing here, unlike
 * `markedFinalFullyCoveredByClear`'s own).
 *
 * @decision 8db913e2 (Follow-up 29fe2372) — see the decision record.
 *
 * @decision 8db913e2 (Follow-up 495fd320) — a bare scalar (number/string/boolean, never `null`) now ALSO counts as "cannot
 * prove this" rather than vacuously `true`, a strictly safer tightening. See the decision record.
 *
 * @decision eedf16f5 — widened from a single `clearedToken` to the full overlap set this call drops, in
 * one call instead of one per token. Supersedes `64119847`'s "Do not widen this signature" bullet. See
 * the decision record.
 */
function orphanFileTokensAccountedForByUpdate(orphanFile: string, updated: MergeQuarantineEntry, droppedTokens: ReadonlySet<string>): boolean {
  let raw: string;
  try { raw = fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, orphanFile), "utf8"); } catch { return false; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return false; }
  if (!isReadableLatchRecord(parsed)) return false; // e.g. the bare literal `null`
  const { raw: onDiskTokens } = readSurvivingOnDiskTokens(parsed);
  // @decision eedf16f5 — `droppedTokens` (never named `clearedTokens`, the SEPARATE module-level global
  // tombstone set below) is the FULL overlap set THIS call drops — shadowing that global here would
  // silently disable its own fallback on the next line. See the decision record.
  const accountedFor = new Set([...updated.tokens, ...droppedTokens]);
  return onDiskTokens.every((t) => accountedFor.has(t) || clearedTokens.has(t));
}

/**
 * `true` iff `orphanFile` is CONFIRMED to be `updated`'s own physical content right now — never a guess
 * from a reference list, a bare identity match, or a content-identity match alone. A basename still
 * `keptUnreadableLatchFiles`-marked is refused outright (writing it here would bypass
 * `writeMergeQuarantineLatch`'s own marked-basename reconcile chokepoint, contradicting `8db913e2` Round 2
 * and `63e49ee2`). Otherwise confirmed by THREE layers, ALL required:
 * 1. the pre-existing structural check ({@link physicalOwnerRepoPaths}/{@link survivingSharedClaimRepoPaths})
 *    must never credit this file to a DIFFERENT identity;
 * 2. {@link anotherLiveEntryOwnsFile} must find no OTHER live entry object, active or pending, of ANY
 *    identity (including `updated`'s own), that still depends on this file as its own current backing —
 *    SAME IDENTITY IS NOT SAME ENTITY (`d4b25feb`), and layer 1 alone cannot tell them apart;
 * 3. {@link orphanFileTokensAccountedForByUpdate} — the file's own on-disk CONTENT must hold no token
 *    this write doesn't already account for, against the FULL set this one call is dropping (never just
 *    one of several — `eedf16f5`) ({@link quarantineFileRepoPathIdentity} resolving to the same
 *    identity is necessary but not sufficient — same identity is not same content, `63e49ee2` round 5).
 * Fail-closed on every branch: a file whose ownership cannot be positively confirmed as `updated`'s own,
 * by ALL three layers, is left untouched rather than risk destroying another entity's only durable copy.
 *
 * @decision 8db913e2 (Follow-up 6c04633d, B1, Code Review `e8c78d98`) — this closes a BLIND-WRITE reachability of the
 * `9cabd143` bug class (an orphan reference can name a file that is now ANOTHER live entry's own latch).
 * See the decision record.
 *
 * @decision 8db913e2 (Follow-up 29fe2372) — layers 2/3 close a FURTHER fail-open: a DIFFERENT, independent, same-identity
 * record's own file, silently destroyed by a partial clear of an unrelated record sharing only its
 * identity. See the decision record.
 */
function orphanRewriteOwnershipConfirmed(orphanFile: string, updated: MergeQuarantineEntry, droppedTokens: ReadonlySet<string>): boolean {
  if (keptUnreadableLatchFiles.has(orphanFile)) return false;
  const updatedIdentity = directPathIdentity(updated.repoPath);
  const structuralOwners = [...physicalOwnerRepoPaths(orphanFile), ...survivingSharedClaimRepoPaths(orphanFile)];
  if (structuralOwners.some((o) => directPathIdentity(o) !== updatedIdentity)) return false;
  if (anotherLiveEntryOwnsFile(orphanFile, updated)) return false;
  const contentIdentity = quarantineFileRepoPathIdentity(path.join(MERGE_QUARANTINE_DIR, orphanFile));
  if (contentIdentity !== updatedIdentity) return false;
  return orphanFileTokensAccountedForByUpdate(orphanFile, updated, droppedTokens);
}

/**
 * A PARTIAL by-token clear (not the last token) must keep every file `updated.orphanLatchFiles` still
 * names in sync with the reduced token set — otherwise that file's own STALE (pre-clear) bytes re-arm the
 * just-released token at the next boot. Generalizes the `ae79d492` dual-tracked-twin pattern (which only
 * ever rewrote ONE reference-tracked pending twin) to every folded orphan file this entry carries, but
 * (unlike that reference-equality-safe twin match) ONLY once {@link orphanRewriteOwnershipConfirmed}
 * positively confirms the file is genuinely this same entity's own — never a blind write by filename
 * alone. A skipped, left-stale file is an accepted, fail-CLOSED residual (a stale record keeps its own
 * repo quarantined; it can never un-quarantine anyone else as a side effect).
 *
 * @decision 8db913e2 (Follow-up 6c04633d, a) — a partial by-token clear of a record with folded `orphanLatchFiles` used to
 * leave those files' own stale (un-reduced) bytes untouched; they re-armed the released token on reboot.
 * See the decision record.
 *
 * @decision 8db913e2 (Follow-up 29fe2372) — `clearedToken` (the token THIS SAME partial clear just dropped from `updated`) is
 * threaded through to {@link orphanRewriteOwnershipConfirmed}'s own layer (b) — see the decision record.
 *
 * @decision eedf16f5 — `droppedTokens` is the FULL set this call drops, passed ONCE, never once per token.
 */
function rewriteOrphanLatchFilesAfterPartialClear(updated: MergeQuarantineEntry, skip: Set<string>, droppedTokens: ReadonlySet<string>): void {
  for (const orphanFile of updated.orphanLatchFiles ?? []) {
    if (skip.has(orphanFile)) continue;
    if (!fs.existsSync(path.join(MERGE_QUARANTINE_DIR, orphanFile))) continue;
    if (!orphanRewriteOwnershipConfirmed(orphanFile, updated, droppedTokens)) {
      // eslint-disable-next-line no-console
      console.error(`[merge-quarantine] keeping ${orphanFile} UNTOUCHED (left stale) after a partial clear of ${updated.repoPath} — its own ownership could not be positively confirmed as this same entity's (a different entity's live latch, an unreadable/unparsable read, a marked-kept basename, or a real on-disk token this write doesn't already account for); fail-closed rather than risk destroying a different entity's only durable copy.`);
      continue;
    }
    // @decision 2dd97aaa (Follow-up 535fd69d) — thread the caller's own `droppedTokens` through: this write narrows the
    // folded orphan file, and omitting it can resurrect the just-dropped tokens from a stale copy.
    if (!writePendingDivertFile(orphanFile, updated, droppedTokens)) {
      // eslint-disable-next-line no-console
      console.error(`[merge-quarantine] could not durably persist the reduced token set for ${updated.repoPath} into its own folded orphan latch file ${orphanFile} after a partial clear — that file's own PRE-EXISTING (un-reduced) bytes are left UNTOUCHED, so a restart before this is fixed may re-arm the just-cleared token from it.`);
    }
  }
}

/**
 * Shared per-index clear body for {@link clearMergeQuarantineByToken}'s own universal by-token sweep —
 * removes `token` from each of `indices`' own pending entries (SET semantics: a full lift when it was
 * the last token, a durable rewrite otherwise). The ONLY caller computes `indices` by TOKEN alone across
 * every identity (`6c04633d`) — this body itself is identity-agnostic; it never assumes `indices` shares
 * one repoPath.
 *
 * @decision d4b25feb (round 2, CRITICAL) — the LAST token lifts ONLY the matched pending entry/entries
 * directly — never via {@link clearMergeQuarantineByRecordedPath}, which clears EVERY entry sharing an
 * identity and would destroy a wholly separate, still-armed ACTIVE entry for the same repoPath.
 *
 * @decision 1922be3a (round 3) — generalized from a single `findIndex` to every matching index, applying
 * this same per-entry logic to each, in descending order. See the decision record.
 */
function clearTokenFromPendingIndices(indices: number[], token: string): void {
  // @decision 9c681680 — plan keyed by WRAPPER OBJECT, never by index: a protect call reached from this
  // same loop's own "remove" branch can splice an UNRELATED entry out of this array mid-loop, shifting a
  // not-yet-processed index onto a DIFFERENT wrapper (mirrors 07e3ad30's own fix for the identical hazard).
  //
  // @decision 8db913e2 (Follow-up c93e9e7a) — one plan per entry (reduce-or-remove plus owned keys),
  // computed ONCE before any delete, never re-derived against an already-mutated map or a second time
  // (round 2 CR item 3) — the mutating loop below reuses this exact plan. See the decision record.
  const planByEntry = new Map<PendingUnresolvedQuarantine, { action: "reduce" } | { action: "remove"; ownedArmedKeys: string[] }>();
  const L = new Set<string>();
  for (const idx of indices) {
    const pending = pendingUnresolvedQuarantines[idx] as PendingUnresolvedQuarantine;
    if (pending.entry.tokens.filter((t) => t !== token).length !== 0) { planByEntry.set(pending, { action: "reduce" }); continue; }
    const ownedArmedKeys = (pending.entry.armedKeys ?? []).filter((k) => entryStillOwnsKey(k, pending.entry));
    planByEntry.set(pending, { action: "remove", ownedArmedKeys });
    for (const k of ownedArmedKeys) L.add(k);
  }

  // @decision 9c681680 — snapshot the WRAPPER OBJECTS now, before any mutation; descending order is kept
  // only for log-ordering parity, never relied on for correctness — every write below resolves its own
  // current index (or avoids needing one) fresh, right before use.
  const targets = [...indices].sort((a, b) => b - a).map((idx) => pendingUnresolvedQuarantines[idx] as PendingUnresolvedQuarantine);

  for (const pending of targets) {
    const identity = directPathIdentity(pending.entry.repoPath);
    let live: PendingUnresolvedQuarantine = pending;
    let plan = planByEntry.get(pending)!;
    // @decision 3315b08a — a protect call an earlier target's own "remove" branch reaches can ASSIGN a
    // fresh wrapper into THIS exact slot (never a splice, so indexOf-fresh alone never catches it) — when
    // `pending` is no longer live, re-resolve by identity and re-derive the whole plan fresh, never trust.
    if (!pendingUnresolvedQuarantines.includes(pending)) {
      const liveMatches = pendingUnresolvedQuarantines.filter((p) => directPathIdentity(p.entry.repoPath) === identity);
      if (liveMatches.length !== 1) {
        // Not a silent skip — see 07e3ad30's own "Do not" for why this is surfaced loudly rather than
        // swallowed. A genuinely ambiguous (0 or >1) re-resolution IS still not expected to fire in
        // production; a future regression that does make it fire should be visible, not papered over.
        // eslint-disable-next-line no-console
        console.error(`[merge-quarantine] expected to find ${pending.entry.repoPath}'s own pending entry (${pending.sourceFile}) in pendingUnresolvedQuarantines during a token clear, but it was REPLACED (not spliced) by an earlier target's own protect call, and ${liveMatches.length} live same-identity candidate(s) could be unambiguously re-resolved (need exactly 1) — ${token} may be left stuck on whatever is currently live for this identity; investigate if seen.`);
        continue;
      }
      live = liveMatches[0]!;
      // @decision 0faffa95 — a re-resolved `live` can be an ACTIVE TWIN protect's both-indices branch
      // just re-pointed, but its own armedKeys never join `live.entry` (c9114934/cd5a3cf9 gate the union
      // to `atFilenameIdx` alone) — never derive an armedKeys-based plan here; defer to phase 2 instead.
      let liveIsActiveTwin = false;
      for (const v of activeQuarantines.values()) {
        if (v === live.entry) { liveIsActiveTwin = true; break; }
      }
      if (liveIsActiveTwin) {
        // eslint-disable-next-line no-console
        console.error(`[merge-quarantine] ${pending.entry.repoPath}'s own pending entry (${pending.sourceFile}) was REPLACED (not spliced) mid-clear by a protect call against a co-located occupant, and the live wrapper now at ${live.sourceFile} is ALSO an active twin (armed in activeQuarantines) — protectOccupantContentBeforeDelete's own both-indices branch re-points an armed twin's key onto the replacement without unioning the twin's own armedKeys, so deriving a remove/reduce plan here would leave that key's own durable latch unrewritten; deferring entirely to the active-entry clear pass (clearActiveEntryTokenAtKey), which walks activeQuarantines directly and also durably rewrites any pending slot sharing this same reference.`);
        continue;
      }
      const remainingLive = live.entry.tokens.filter((t) => t !== token);
      plan = remainingLive.length === 0
        ? { action: "remove", ownedArmedKeys: (live.entry.armedKeys ?? []).filter((k) => entryStillOwnsKey(k, live.entry)) }
        : { action: "reduce" };
      // eslint-disable-next-line no-console
      console.error(`[merge-quarantine] ${pending.entry.repoPath}'s own pending entry (${pending.sourceFile}) was REPLACED (not spliced) mid-clear by a protect call against a co-located occupant — re-resolved it fresh by identity (now at ${live.sourceFile}) and re-derived a '${plan.action}' plan from its CURRENT tokens, rather than trusting the stale pre-pass plan.`);
    }
    if (plan.action === "remove") {
      // @decision 9c681680 — resolve `live`'s own CURRENT index fresh, right now, never a precomputed
      // one — mirrors 07e3ad30's own rule for clearMergeQuarantineByKey's sibling pending loop.
      const idx = pendingUnresolvedQuarantines.indexOf(live);
      if (idx !== -1) {
        pendingUnresolvedQuarantines.splice(idx, 1);
      } else {
        // Not a silent skip — see 07e3ad30's own "Do not" for why this is surfaced loudly rather than
        // swallowed. `live` was just re-resolved (or confirmed live) immediately above this branch, so
        // this -1 is now genuinely unexpected either way — a future regression that does make it fire
        // should be visible, not papered over.
        // eslint-disable-next-line no-console
        console.error(`[merge-quarantine] expected to remove ${live.entry.repoPath}'s own pending entry (${live.sourceFile}) from pendingUnresolvedQuarantines during a token clear, but it was already absent from the live array by the time this ran — this was not expected; investigate if seen.`);
      }
      const orphanFilesToSweep = new Set(live.entry.orphanLatchFiles ?? []);
      // @decision 8db913e2 (Follow-up c93e9e7a) — `plan.ownedArmedKeys` was computed in the pre-pass
      // above, against the then-still-unmutated map — never recomputed here against a map an earlier
      // index's own removal in THIS SAME descending loop may have already mutated. A repeated
      // `deleteMergeQuarantineLatchByKey` on a key an earlier twin already deleted is intentional and
      // idempotent (its own `fs.unlinkSync` tolerates ENOENT; nothing else re-runs destructively).
      for (const k of plan.ownedArmedKeys) {
        activeQuarantines.delete(k);
        // @decision d163aef5 (round 4) — same ownership + token-overlap protection as clearMergeQuarantineByKey.
        const { relocated } = deleteMergeQuarantineLatchByKey(k, undefined, live.entry, identity, L);
        // @decision 182c01cc (round 2, item 4) — clearMergeQuarantineByToken has no human route to report
        // a relocation through; LOG it (disclosure-safe: repoPath + pending id, never content) rather than
        // silently discarding it, same as clearActiveEntryTokenAtKey's own full-lift call below.
        if (relocated.length > 0) {
          // eslint-disable-next-line no-console
          console.warn(`[merge-quarantine] partial token clear at key ${k} also relocated ${relocated.length} foreign co-occupant(s) to their own new latch (no human route reaches this path — logging only): ${relocated.map((r) => `'${r.repoPath}' -> id '${pendingLatchIdFor(r.sourceFile)}'`).join(", ")}`);
        }
      }
      // @decision 8db913e2 (round 4) — tombstone `token` HERE, after the splice/delete above already
      // removed every in-memory trace of this pending entry — see `tombstoneIfNotSurviving`'s own doc.
      tombstoneIfNotSurviving([token]);
      sweepOwnLatchFileUnlessOwnedElsewhere(live.sourceFile);
      // @decision 8db913e2 (Follow-up f2cc5f18) — `live.entry.tokens` captured via the `live` binding
      // resolved above, BEFORE the splice above — this branch only fires when it's the full set being lifted.
      //
      // @decision 8db913e2 (Follow-up 0a783fb2) — this path has NO human-facing return (clearMergeQuarantineByToken
      // is `void`), so fold only to LOG, same disclosure-safe convention as the warning just above.
      const orphanContentKept = new Map<string, string>();
      const orphanKeptRepoPaths: string[] = [];
      // @decision 8db913e2 (Follow-up 0a783fb2, Code Review 47289f8d) — exclude this entry's OWN identity,
      // same reason as every other orphan-sweep call site.
      const excludeOwnIdentity = new Set([identity]);
      let orphanUnattributed = false;
      for (const orphanFile of orphanFilesToSweep) {
        const folded = foldOrphanSweepResult(sweepOrphanLatchFileIfUnreferenced(orphanFile, live.entry.tokens, excludeOwnIdentity), orphanFile, orphanContentKept);
        orphanKeptRepoPaths.push(...folded.referencingRepoPaths);
        if (folded.unattributed) orphanUnattributed = true;
      }
      const orphanNamed = [...orphanKeptRepoPaths, ...orphanContentKept.keys()];
      // @decision 8db913e2 (Follow-up 0a783fb2, Code Review 47289f8d, NIT) — an unattributed keep (kept
      // but nothing nameable) must ALSO log, not just a named one, or it silently vanishes here.
      if (orphanNamed.length > 0 || orphanUnattributed) {
        // eslint-disable-next-line no-console
        console.warn(`[merge-quarantine] a token-clear's own full lift also kept ${orphanNamed.length} orphan file reference(s) alive${orphanUnattributed ? " (plus at least one more, unattributed)" : ""} (no human route reaches this path — logging only)${orphanNamed.length > 0 ? `: ${orphanNamed.map((rp) => `'${rp}'`).join(", ")}` : ""}.`);
      }
      continue;
    }
    const remaining = live.entry.tokens.filter((t) => t !== token);
    const updated: MergeQuarantineEntry = { ...live.entry, tokens: remaining };
    // @decision d4b25feb (round 3) — re-point EVERY in-memory reference to this entry (883e29bc's own
    // divert can make it the SAME object armed in activeQuarantines) before durably rewriting each owned key.
    //
    // @decision 64283e06 — ROUTED, DEFENSIVE (fd189d91's own posture): unreachable today ONLY because the
    // caller's own identity-scan already catches any active twin first — do not remove this routing on
    // that basis, or a future change to that scan silently reopens the bug class this call closes.
    replaceEntryEverywhere(activeQuarantines, live.entry, updated);
    // @decision 9c681680 — mutate `live` IN PLACE (never a stale-idx array reassignment) — mirrors
    // clearMergeQuarantineByKey's own reduce branch (64119847/b47cf261): no index lookup needed at all.
    live.entry = updated;
    // @decision 8db913e2 (round 4) — tombstone `token` HERE, before the write loop below, same reason
    // as `clearActiveEntryTokenAtKey`'s own identical placement.
    tombstoneIfNotSurviving([token]);
    const writtenBasenames = new Set<string>([live.sourceFile]);
    // @decision 2dd97aaa (Follow-up 58957b1e) — `updated` drops `token`; pass it as `droppedTokens`
    // (DEFENSIVE — `64283e06`'s own posture: unreachable today, see that record).
    for (const k of live.entry.armedKeys ?? []) {
      if (activeQuarantines.get(k) !== updated) continue; // no longer genuinely owned — do not write there
      writtenBasenames.add(`${quarantineHashForKey(k)}.json`);
      if (!writeMergeQuarantineLatch(updated, new Set([token]), false, k)) {
        // eslint-disable-next-line no-console
        console.error(`[merge-quarantine] could not durably persist the reduced token set for ${live.entry.repoPath}'s own armed copy at key ${k} after a partial clear — the PRE-EXISTING durable state there is left UNTOUCHED, so a restart before this is fixed may re-union the just-cleared token back in.`);
      }
    }
    // @decision 702b4241 (round 3) — use whatever `writePendingDivertFile` ACTUALLY wrote to, never
    // `live.sourceFile` unconditionally: a marked basename redirects to a fresh record instead.
    // @decision 2dd97aaa (Follow-up 535fd69d) — `updated` drops `token`; pass it as `droppedTokens` — `tombstoneIfNotSurviving`
    // above does not protect this write when `token` is still "surviving" on another in-memory record.
    const written = writePendingDivertFile(live.sourceFile, updated, new Set([token]));
    if (written) {
      if (written.entry !== updated) replaceEntryEverywhere(activeQuarantines, updated, written.entry);
      // @decision 9c681680 — same in-place mutation as above, no index lookup needed.
      live.entry = written.entry;
      live.sourceFile = written.filename;
      rewriteOrphanLatchFilesAfterPartialClear(written.entry, writtenBasenames, new Set([token]));
    } else {
      // eslint-disable-next-line no-console
      console.error(`[merge-quarantine] could not durably persist the reduced token set for ${live.entry.repoPath}'s own pending-divert latch after a partial clear — the PRE-EXISTING durable state is left UNTOUCHED, so a restart before this is fixed re-arms with the just-cleared token still counted as outstanding (delays the eventual full lift; never a false lift).`);
      rewriteOrphanLatchFilesAfterPartialClear(updated, writtenBasenames, new Set([token]));
    }
  }
}

/** TEST-ONLY: calls the private {@link clearTokenFromPendingIndices} directly, bypassing
 *  `clearMergeQuarantineByToken`'s own `collectPendingIndices` filtering — lets a test pass a hand-built
 *  (and, for the 0-live-candidate fail-closed branch, deliberately DUPLICATED) `indices` list that no
 *  real caller can ever produce (`collectPendingIndices` enumerates each index at most once). See
 *  `setActiveQuarantineTestOnly`'s own doc for the identical "state no real code path can produce"
 *  rationale, and card `0faffa95`'s own decision record for why a genuine 0-live-candidate state is
 *  provably unreachable via `protectOccupantContentBeforeDelete`'s own copy-aside mutations alone. Never imported
 *  by `index.ts` — the `TestOnly` suffix is load-bearing: `no-src-testonly-import-guard.mjs` matches
 *  `/TestOnly$/` specifically to catch a future import of this exact kind of seam into production code. */
export function clearTokenFromPendingIndicesTestOnly(indices: number[], token: string): void {
  clearTokenFromPendingIndices(indices, token);
}

/** TEST-ONLY: the CURRENT `pendingUnresolvedQuarantines` index whose entry shares `repoPath`'s own
 *  identity, or -1 if none — lets a test using {@link clearTokenFromPendingIndicesTestOnly} find its own
 *  target's real index without assuming a fixed position a boot-time scan's own leftover on-disk
 *  entries could otherwise shift. See `setActiveQuarantineTestOnly`'s own doc for the identical "state
 *  no real code path can produce" rationale (never imported by `index.ts`, same `TestOnly` guard). */
export function findPendingIndexByIdentityTestOnly(repoPath: string): number {
  const identity = directPathIdentity(repoPath);
  return pendingUnresolvedQuarantines.findIndex((p) => directPathIdentity(p.entry.repoPath) === identity);
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
 * Shared compare-and-clear body for every match {@link clearMergeQuarantineByToken}'s own identity scan
 * finds — the caller has ALREADY matched a specific `key`/`entry` pair known to hold `token`. Takes `key`
 * explicitly and never re-derives a write target from `entry.repoPath` (which may not currently resolve at
 * all when reached via the identity scan) — same rule as every other degraded-identity-aware write site
 * in this module.
 */
function clearActiveEntryTokenAtKey(key: string, entry: MergeQuarantineEntry, token: string): void {
  const remaining = entry.tokens.filter((t) => t !== token);
  if (remaining.length === 0) {
    // @decision 883e29bc — clear via the key/entry ALREADY matched (c0be9bf9's rule), never by
    // re-deriving from a repoPath again — `entry.repoPath` can be a DIFFERENT, longer-outstanding
    // raiser's own identity (enterMergeQuarantine's `existing` branch).
    //
    // @decision 8db913e2 (Follow-up d6efbc9b) — the delegated call's own touchedFinalBasenames-gated
    // tombstone can leave a RELEASED token un-tombstoned; tombstone it unconditionally here too.
    const result = clearMergeQuarantineByKey(key, entry.repoPath);
    // @decision 182c01cc (round 2, item 4) — same disclosure-safe logging as clearTokenFromPendingIndices
    // above; clearMergeQuarantineByToken has no human route to report a relocation through otherwise.
    const { relocated } = splitCoOccupants(result?.stillBlockedCoOccupants, result?.referencingRepoPaths);
    if (relocated.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(`[merge-quarantine] a token-clear's own full lift at key ${key} also relocated ${relocated.length} foreign co-occupant(s) to their own new latch (no human route reaches this path — logging only): ${relocated.map((r) => `'${r.repoPath}' -> id '${r.route.id}'`).join(", ")}`);
    }
    // @decision 8db913e2 (Follow-up 0a783fb2) — same no-human-route logging for a content-parsed orphan
    // keep this delegated call can now surface; previously discarded along with everything else here.
    if (result?.contentKeptRepoPaths?.length) {
      // eslint-disable-next-line no-console
      console.warn(`[merge-quarantine] a token-clear's own full lift at key ${key} also kept ${result.contentKeptRepoPaths.length} orphan file reference(s) alive, content-parsed as belonging to (no human route reaches this path — logging only): ${result.contentKeptRepoPaths.map((rp) => `'${rp}'`).join(", ")}`);
    }
    tombstoneIfNotSurviving([token]);
    return;
  }
  // @decision 6be6c9ff — derive via {@link liveArmedKeys}, before `updated` so it can be stamped onto it
  // directly; never `entry.armedKeys` alone — see the decision record.
  const armedKeysForEntry = liveArmedKeys(key, entry);
  const updated: MergeQuarantineEntry = { ...entry, tokens: remaining, armedKeys: armedKeysForEntry };
  // Update EVERY key `entry` is armed under, not just `key` — reference equality breaks the moment an
  // entry is REBUILT elsewhere (a union, an orphan merge), since the rebuilt object stops being `===` the
  // one still sitting at another of its own keys (round 2 finding 2). ALSO re-points any PENDING entry
  // sharing this exact reference (883e29bc's own boot-diverted twin — d4b25feb round 3).
  //
  // @decision 82032b5c (round 3 CR, MINOR A) — route through replaceEntryEverywhere, never a bare per-key
  // `.set()` — a stale `armedKeys` member can, by now, genuinely belong to a DIFFERENT entry, and a bare
  // `.set()` silently clobbered that OTHER entry's in-memory slot with `updated`.
  replaceEntryEverywhere(activeQuarantines, entry, updated);
  // @decision 8db913e2 (round 4) — tombstone `token` HERE: the in-memory update above already reflects
  // its removal, so the scan correctly finds nothing surviving. Doing this BEFORE the write loop below
  // lets that write's own chokepoint union correctly exclude `token` too (closes CR2's own B1 shape).
  tombstoneIfNotSurviving([token]);
  // @decision bde5d1fe (Code Review of eae23ebe) — a sweep may only run AFTER a durable write of the
  // state that supersedes it has succeeded, never before: sweeping THEN failing this write would leave
  // NOTHING durable for a repo whose only prior copy was this same tmp.
  // @decision 92c645cc — `updated.tokens` deliberately DROPS the cleared token, so this call does NOT
  // pass `writeMergeQuarantineLatch`'s own `sweepOtherTmpsOnSuccess` (not a superset write); the sweep
  // below is this call's OWN pre-existing, separate step, unaffected by that flag.
  //
  // @decision 82032b5c (round 2 CR, MAJOR) — write EVERY armed key, guarded by `entryStillOwnsKey`
  // (checks IDENTITY — same object OR same `directPathIdentity` — never bare `===` alone), now
  // meaningful since the in-memory update above is itself reference-scoped.
  // @decision ae79d492 (round 2, Code Review f80250c9, Minor 1) — track which armed-key finals the loop
  // below actually wrote, so the dual-tracked-twin loop after it never redundantly rewrites the SAME
  // physical file a moment later — see that loop's own doc.
  const writtenFinalBasenames = new Set<string>();
  // @decision 2dd97aaa (Follow-up 58957b1e) — `updated` drops `token`; pass it as `droppedTokens` — the
  // tombstone call above can fail to protect this write (an unrelated in-memory record still holding
  // `token` at this instant defeats `tombstoneIfNotSurviving`'s own "surviving anywhere" scan).
  for (const k of armedKeysForEntry) {
    if (!entryStillOwnsKey(k, updated)) continue;
    if (writeMergeQuarantineLatch(updated, new Set([token]), false, k)) {
      writtenFinalBasenames.add(`${quarantineHashForKey(k)}.json`);
      // @decision be79f4d5 (round 4) — reference-aware, same reason as the other two sites: a DIFFERENT,
      // surviving entry's own same-hash tmp must survive a partial clear here too.
      //
      // @decision 21ec39e5 — `updated.tokens` as `candidateTokens`: the reduced set this write just made
      // durable at key `k`; a same-hash tmp holding anything outside it is never blindly deleted.
      sweepTmpResidueForHashIfUnreferenced(quarantineHashForKey(k), { mode: "content-checked", candidateTokens: updated.tokens });
    } else {
      // eslint-disable-next-line no-console
      console.error(`[merge-quarantine] could not durably persist the reduced token set for ${entry.repoPath} at key ${k} after a partial clear — the PRE-EXISTING durable state (this repo's own latch file, final or tmp) is left UNTOUCHED there, so a restart before this is fixed may re-arm with the just-cleared token still counted as outstanding at THAT key (delays the eventual full lift; never a false lift).`);
    }
  }
  // @decision ae79d492 — an 883e29bc dual-tracked twin's own sourceFile is a SEPARATE physical file from
  // the armed key's final the loop above just wrote; never skip rewriting it too, or a reboot re-reads
  // its stale, un-reduced copy and re-unions the just-cleared token back in. See the decision record.
  //
  // @decision ae79d492 (round 2) — skip when the twin's sourceFile IS a final the loop above just wrote
  // (would drop provenanceTracked, db0a9db0) or no longer exists (its own tmp, just swept) — never when
  // genuinely stale. See the decision record's round 2 section.
  for (const idx of collectPendingIndices((p) => p.entry === updated)) {
    const pending = pendingUnresolvedQuarantines[idx] as PendingUnresolvedQuarantine;
    if (writtenFinalBasenames.has(pending.sourceFile)) continue;
    if (!fs.existsSync(path.join(MERGE_QUARANTINE_DIR, pending.sourceFile))) continue;
    writtenFinalBasenames.add(pending.sourceFile);
    // @decision 702b4241 (round 3) — use whatever `writePendingDivertFile` ACTUALLY wrote to for
    // THIS twin alone; never mutate the shared `updated` object other twins/the active key already used.
    // @decision 2dd97aaa (Follow-up 535fd69d) — `updated` drops `token`; pass it as `droppedTokens`, same reason as
    // `clearTokenFromPendingIndices`'s own identical write above.
    const written = writePendingDivertFile(pending.sourceFile, updated, new Set([token]));
    if (written) {
      pendingUnresolvedQuarantines[idx] = { entry: written.entry, sourceFile: written.filename };
    } else {
      // eslint-disable-next-line no-console
      console.error(`[merge-quarantine] could not durably persist the reduced token set for ${entry.repoPath}'s own dual-tracked pending twin at ${pending.sourceFile} after a partial clear — the PRE-EXISTING durable state there is left UNTOUCHED, so a restart before this is fixed may re-union the just-cleared token back in.`);
    }
  }
  rewriteOrphanLatchFilesAfterPartialClear(updated, writtenFinalBasenames, new Set([token]));
}

/**
 * `_repoPath` is UNUSED (kept only for call-site/signature stability): this clear is now PROCESS-WIDE BY
 * TOKEN ALONE — a token is a process-unique `randomUUID`, so a token match IS an exact identity of its
 * own holder, and the match no longer needs (or consults) the caller's own repoPath/identity/key at all.
 *
 * @decision 1922be3a (round 3, CRITICAL) — lifts `token` from EVERY matching record, active AND pending,
 * never stopping at the first match. See the decision record.
 *
 * @decision 8db913e2 (Follow-up 6c04633d) — generalized from "every record sharing the caller's own identity/key" to EVERY
 * record of ANY identity still holding `token` — see the decision record.
 *
 * @decision 8db913e2 (Follow-up 6c04633d) — every NON-TWIN pending match clears FIRST; a genuine `883e29bc` dual-tracked TWIN
 * (same object reference as an active entry) is EXCLUDED here — it stays `clearActiveEntryTokenAtKey`'s
 * own job, in its established `ae79d492` order. See the decision record.
 */
export function clearMergeQuarantineByToken(_repoPath: string, token: string): void {
  const activeMatches = new Set<MergeQuarantineEntry>();
  for (const [, entry] of activeQuarantines) {
    if (entry.tokens.includes(token)) activeMatches.add(entry);
  }
  const nonTwinPendingIndices = collectPendingIndices((p) => p.entry.tokens.includes(token) && !activeMatches.has(p.entry));
  clearTokenFromPendingIndices(nonTwinPendingIndices, token);
  const seen = new Set<MergeQuarantineEntry>();
  for (const [k, entry] of activeQuarantines) {
    if (seen.has(entry) || !entry.tokens.includes(token)) continue;
    // @decision 1922be3a (round 3) — mark `seen` only on an actual match, never on every key visited: an
    // entry armed under several keys can hit a NON-matching key first in Map iteration order — marking it
    // seen there would permanently hide the SAME entry's later, genuinely matching key.
    seen.add(entry);
    clearActiveEntryTokenAtKey(k, entry, token);
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

/**
 * repoPaths of every SURVIVING entry that STRUCTURALLY depends on `filename` — a GENUINE PLACEHOLDER
 * pending entry's own `sourceFile`, or a pending entry's own SELF-REFERENCING `orphanLatchFiles` (its own
 * `sourceFile` IS `filename`, which is ALSO folded into its own `orphanLatchFiles`) — independent of
 * `filename`'s own CONTENT. Deliberately narrower than, and never a substitute for,
 * {@link physicalOwnerRepoPaths} (which also covers an active entry's own armed-key/fresh-write-target
 * claim): this check exists specifically so a content-containment proof (e.g.
 * {@link markedFinalFullyCoveredByClear}) can safely bypass THAT aspirational-claim half, while NEVER
 * bypassing this one.
 *
 * @decision 8db913e2 (Follow-up 95ea8d3f, Round 2) — a corrupt/unparsable latch can be diverted ONCE PER CLAIMANT (card
 * 882d6cff); a prior round's own proven-coverage override skipped `physicalOwnerRepoPaths` entirely and
 * destroyed a sibling claimant's only backing as collateral. See the decision record.
 *
 * @decision 8db913e2 (Follow-up 95ea8d3f, Round 2, correction) — the `sourceFile` half is gated on `entry.placeholder`: an
 * EVICTED, non-placeholder entry's own `sourceFile` can be a purely DEFENSIVE INFERENCE (card d163aef5
 * round 3) with its REAL backing already verified safely elsewhere. See the decision record.
 *
 * @decision 8db913e2 (Follow-up 95ea8d3f, Round 3 — SUPERSEDES Round 2's "any orphanLatchFiles" wording) — an
 * `orphanLatchFiles` hit counts ONLY when that SAME entry's own `sourceFile` also equals `filename`
 * (self-reference) — never a DIFFERENT entry merely LISTING `filename` (`9cabd143`'s forbidden shape).
 */
function survivingSharedClaimRepoPaths(filename: string): string[] {
  const owners = new Set<string>();
  for (const p of pendingUnresolvedQuarantines) {
    if (p.sourceFile === filename && p.entry.placeholder) owners.add(p.entry.repoPath);
  }
  for (const p of pendingUnresolvedQuarantines) {
    if (p.sourceFile === filename && p.entry.orphanLatchFiles?.includes(filename)) owners.add(p.entry.repoPath);
  }
  return [...owners];
}

function unlinkLatchFile(filename: string): void {
  unlinkLatchFileConfirmed(filename);
}

/** {@link unlinkLatchFile}'s confirmed-outcome twin — `true` for a genuine success or ENOENT (nothing
 *  left to remove either way), `false` for any other error (an EPERM/EBUSY-shaped failure). */
function unlinkLatchFileConfirmed(filename: string): boolean {
  try {
    fs.unlinkSync(path.join(MERGE_QUARANTINE_DIR, filename));
    // eslint-disable-next-line no-console
    console.log(`[merge-quarantine] deleted orphan latch ${filename} — no remaining quarantine entry references it.`);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/**
 * `safe: true` iff `orphanFile`'s on-disk content holds no token this clear doesn't already account for.
 * DELIBERATELY diverges from {@link markedFinalFullyCoveredByClear}'s polarity on a read/parse failure:
 * that helper guards a `keptUnreadableLatchFiles`-marked file that might be a real foreign occupant's
 * precious content, so "cannot prove" there must mean keep. An orphan file reaching this check was never
 * marked that way — it is either genuinely corrupt debris PASS 2 defensively fanned into every registered
 * repo "in case it's theirs" (no `repoPath` can ever be parsed back out of it, so there is nothing real to
 * lose by deleting it), or a real, readable, FOREIGN record this process never raised and does not own.
 * Only the second case is gated on `candidateTokens`; the first stays trivially safe to delete, exactly as
 * before this check existed — tests (J)/(Z1)/(Z1-route) in merge-quarantine-clear-by-path.mjs depend on
 * corrupt, fully-unreferenced debris still being swept, and would regress under the other helper's polarity.
 *
 * A record carrying every field PASS 1 requires to arm it as a REAL quarantine (`repoPath`/`branch`/
 * `reason`, all strings — the same strict check PASS 1/1b/safety-tmp recovery use) is never trivially
 * safe to delete just because it currently holds ZERO tokens: `protectOccupantContentBeforeDelete`'s own
 * `rawTokens.length === 0` branch persists this exact shape with a placeholder rather than discarding it,
 * and {@link reenterMergeQuarantinesAtBootImpl}'s own PASS 1 would arm it as a real, enforced quarantine
 * on the very next boot — deleting it here would be fail-OPEN on a genuine, legacy-shaped quarantine.
 *
 * `parsedRepoPath` (set whenever the content parses with a string `repoPath`, regardless of `safe`) lets
 * a caller that KEEPS the file report WHO it's keeping it for, instead of a silent/unattributed keep.
 *
 * @decision 8db913e2 (Follow-up f2cc5f18) — see the decision record.
 */
// @decision 21ec39e5 (round 2) — `readFailed` is the ONLY reliable read-failure signal; never infer it
// from `!parsedRepoPath` alone (a readable record lacking a string `repoPath` also hits that case).
function orphanSweepSafeToDelete(orphanFile: string, candidateTokens: string[]): { safe: boolean; parsedRepoPath?: string; readFailed?: true } {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, orphanFile), "utf8");
  } catch (e) {
    // ENOENT: nothing to lose. Any other failure (EACCES/EBUSY/...): cannot prove — keep, and say so.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { safe: true };
    return { safe: false, readFailed: true };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { safe: true }; } // genuinely corrupt debris — nothing real to lose
  if (!isReadableLatchRecord(parsed)) return { safe: true }; // e.g. the bare literal `null` — same "nothing real" case
  const parsedRepoPath = typeof parsed.repoPath === "string" ? parsed.repoPath : undefined;
  const { raw: onDiskTokens } = readSurvivingOnDiskTokens(parsed);
  const armableByPass1 = parsedRepoPath !== undefined && typeof parsed.branch === "string" && typeof parsed.reason === "string";
  if (armableByPass1 && onDiskTokens.length === 0) return { safe: false, parsedRepoPath }; // genuine, legacy-shaped, PASS 1 would re-arm it — never delete
  const accountedFor = new Set(candidateTokens);
  const safe = onDiskTokens.every((t) => accountedFor.has(t) || clearedTokens.has(t));
  return { safe, parsedRepoPath };
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
 * see that function's own doc for why the two must never be conflated. `candidateTokens` must be every
 * token the CALLER's own clear is lifting right now, captured before any mutation — see {@link
 * orphanSweepSafeToDelete}.
 *
 * @decision 6237bef6 — shared by every orphan-latch sweep (active-entry clear AND every pending-entry
 * clear) so "still referenced" always means the same thing. See the decision record for the gap this
 * closes and why checking only one of active/pending is wrong.
 *
 * @decision 9cabd143 — never drop check (2): a filename's deterministic hash can be legitimately
 * reclaimed by its own rightful repo after being fanned out as someone else's orphan reference. See the
 * decision record for the fail-open repro this closes.
 *
 * @decision 8db913e2 (Follow-up f2cc5f18) — before this, deletion here never read the file's own content
 * at all: an unreferenced orphan holding a real, FOREIGN token nothing in memory currently owns was
 * destroyed unconditionally. See the decision record.
 */
/**
 * @decision 8db913e2 (Follow-up 0a783fb2, Code Review 47289f8d, MAJOR) — `excludeIdentities` drops any
 * candidate referencer sharing an identity with the clear CURRENTLY IN PROGRESS — a same-identity record
 * is never a "co-occupant"; see the decision record's own section for the self-reference bug this closes.
 */
function sweepOrphanLatchFileIfUnreferenced(filename: string, candidateTokens: string[], excludeIdentities?: ReadonlySet<string>): { kept: boolean; referencingRepoPaths: string[]; contentKeptRepoPath?: string } {
  // @decision 63e49ee2 (round 3) — a read-failure-kept file has no identity to attribute; keep it with
  // no referencing repoPath, never gated on `orphanLatchFiles`/`physicalOwnerRepoPaths` alone.
  if (keptUnreadableLatchFiles.has(filename)) return { kept: true, referencingRepoPaths: [] };
  const referencingRepoPaths = new Set<string>();
  for (const e of activeQuarantines.values()) {
    if (excludeIdentities?.has(directPathIdentity(e.repoPath))) continue;
    if (e.orphanLatchFiles?.includes(filename)) referencingRepoPaths.add(e.repoPath);
  }
  for (const p of pendingUnresolvedQuarantines) {
    if (excludeIdentities?.has(directPathIdentity(p.entry.repoPath))) continue;
    if (p.entry.orphanLatchFiles?.includes(filename)) referencingRepoPaths.add(p.entry.repoPath);
  }
  for (const rp of physicalOwnerRepoPaths(filename)) {
    if (excludeIdentities?.has(directPathIdentity(rp))) continue;
    referencingRepoPaths.add(rp);
  }
  if (referencingRepoPaths.size > 0) return { kept: true, referencingRepoPaths: [...referencingRepoPaths] };
  const safety = orphanSweepSafeToDelete(filename, candidateTokens);
  if (!safety.safe) {
    // @decision 2dd97aaa — a `parsedRepoPath` sharing `excludeIdentities`' own identity is the clearer's
    // OWN stale content, never a true foreign claimant — never report it as a content-kept claimant here,
    // not just exclude it from the referencer scan above.
    const ownContent = !!safety.parsedRepoPath && !!excludeIdentities?.has(directPathIdentity(safety.parsedRepoPath));
    // eslint-disable-next-line no-console
    console.error(`[merge-quarantine] keeping orphan latch ${filename} UNTOUCHED (left stale) — no surviving entry references it, but its own on-disk content could not be positively proven to hold only token(s) this clear already accounts for${!ownContent && safety.parsedRepoPath ? ` (its own parsed content names repoPath '${safety.parsedRepoPath}')` : ""}; fail-closed rather than risk destroying a foreign token nothing in memory currently owns or references.`);
    // @decision 8db913e2 (Follow-up f2cc5f18, Code Review 745c3736) — a caller must be able to SEE this
    // keep, never a silent `{kept:true, referencingRepoPaths:[]}` indistinguishable from "nothing to
    // report" — name the parsed foreign repoPath when the content gave us one.
    //
    // @decision 8db913e2 (Follow-up 0a783fb2) — a CONTENT-parsed repoPath never shares
    // `referencingRepoPaths` with a true in-memory referencer again — see `foldOrphanSweepResult`.
    return { kept: true, referencingRepoPaths: [], contentKeptRepoPath: ownContent ? undefined : safety.parsedRepoPath };
  }
  unlinkLatchFile(filename);
  return { kept: false, referencingRepoPaths: [] };
}

/**
 * Fold ONE {@link sweepOrphanLatchFileIfUnreferenced}-shaped result into a caller's own running kept
 * state — shared by every orphan-sweep call site.
 *
 * @decision 8db913e2 (Follow-up 0a783fb2) — one helper for every orphan-sweep call site, so a TRUE
 * in-memory referencer, a CONTENT-parsed repoPath (no live entry — never folds into
 * `stillBlockedCoOccupants`), and a fully UNATTRIBUTED keep can never again drift between sites.
 *
 * `referencingRepoPaths` are true referencers — fold them into whatever `stillBlockedCoOccupants`-
 * feeding map the caller already builds. `contentKept` is mutated in place (repoPath -> `sourceFile`).
 * `unattributed` is `true` iff `kept:true` with neither to name — OR it into `anyKeptUnattributed`.
 * Structurally accepts an `{kept, referencingRepoPaths}` result with no `contentKeptRepoPath` key at all
 * (e.g. {@link sweepOwnLatchFileUnlessOwnedElsewhere}'s own return — optional-property assignability).
 */
function foldOrphanSweepResult(
  result: { kept: boolean; referencingRepoPaths: string[]; contentKeptRepoPath?: string },
  sourceFile: string,
  contentKept: Map<string, string>,
): { referencingRepoPaths: string[]; unattributed: boolean } {
  if (!result.kept) return { referencingRepoPaths: [], unattributed: false };
  if (result.referencingRepoPaths.length > 0) return { referencingRepoPaths: result.referencingRepoPaths, unattributed: false };
  if (result.contentKeptRepoPath) {
    contentKept.set(result.contentKeptRepoPath, sourceFile);
    return { referencingRepoPaths: [], unattributed: false };
  }
  return { referencingRepoPaths: [], unattributed: true };
}

/**
 * Before {@link sweepTmpResidueForHashIfUnreferenced} unconditionally sweeps every `.tmp-<pid>` residue
 * matching `key`'s own hash, read each one's OWN on-disk content directly and durably protect it if it
 * belongs to a DIFFERENT, currently-UNRESOLVABLE identity than `clearIdentity` — mirrors
 * {@link protectDegradedOccupantBeforeDelete}'s content-aware protection for `final`, applied to tmp
 * residue instead. `sweepTmpResidueForHashIfUnreferenced`'s own ownership check only ever consults
 * `orphanLatchFiles`, never a tmp file's own on-disk identity — so an unresolvable occupant ARMED at
 * `key` (e.g. via its own tautological primary arm) WITHOUT ever having its content promoted/written
 * there (its `.tmp-<pid>` residue is its ONLY durable backing — {@link reenterMergeQuarantinesAtBootImpl}
 * never promotes a tmp residue for a repoPath that doesn't currently resolve) is otherwise destroyed as
 * pure collateral the instant a clear addressed at a wholly different identity sharing this exact key
 * runs its own, unrelated sweep.
 *
 * A currently-RESOLVABLE different occupant's leftover is deliberately EXCLUDED (today's existing,
 * legitimate stale-leftover-is-safe-to-overwrite case — mirrors {@link differentUnresolvableOccupantRepoPathAt}'s
 * own `protectResolvableToo: false` default), as is content that already names `clearIdentity` itself
 * (the clearer's own data, never foreign). A tmp file some SURVIVING entry's own `orphanLatchFiles`
 * already self-references is ALSO skipped — it is already exactly as protected as
 * {@link sweepTmpResidueForHashIfUnreferenced}'s own ownership check will honour, and re-protecting it
 * anyway would re-point that entry's own pending reference onto a brand-new filename for no reason,
 * silently changing its externally-visible latch id (card d2582692's own regression, caught by
 * `merge-quarantine-latch-id-collision.mjs` going red: clearing an unrelated sibling at the same key
 * changed Y's own already-correct clear-by-id).
 *
 * @decision d2582692 — see the decision record for the real repro this closes (a human REST clear of a
 * resolvable repo R whose own key is squatted, in-memory, by an unrelated unresolvable degraded occupant
 * D — clearing R used to silently destroy D's only durable copy as collateral).
 *
 * @decision 4900c365 (round 2) — a per-file FAILED protect no longer needs its own exclude-set plumbing:
 * {@link protectOccupantContentBeforeDelete} itself now self-owns a failed file via `orphanLatchFiles`,
 * which {@link sweepTmpResidueForHashIfUnreferenced}'s own EXISTING ownership check already honours.
 *
 * @decision 63e49ee2 (round 3) — a non-ENOENT READ failure here marks the basename in {@link
 * keptUnreadableLatchFiles} — never the round-1 exclude-set/`Set<string>` return, and never round 2's
 * identity-matchable pending stub. See the decision record.
 */
function protectForeignTmpResidueBeforeSweep(key: string, clearIdentity: string, liftedKeys: ReadonlySet<string> = new Set()): { kept: Array<{ repoPath: string; sourceFile: string }>; relocated: Array<{ repoPath: string; sourceFile: string }> } {
  // @decision 182c01cc (round 2, finding 1) — this loop's own protect call ALSO relocates a foreign
  // occupant; collect and return it, or a clear whose ONLY foreign content sat in a `.tmp-<pid>` residue
  // silently returns a bare success.
  //
  // @decision 182c01cc (round 4, CR3 MAJOR) — split {kept, relocated} like deleteMergeQuarantineLatchByKey's
  // own return — a double-fault here (the write-protecting-this-tmp-residue itself failed) means the tmp
  // residue SURVIVES at its OWN name, which is KEPT, never relocated.
  const relocated: Array<{ repoPath: string; sourceFile: string }> = [];
  const kept: Array<{ repoPath: string; sourceFile: string }> = [];
  const prefix = `${quarantineHashForKey(key)}.json.tmp-`;
  let files: string[];
  try { files = fs.readdirSync(MERGE_QUARANTINE_DIR); } catch { return { kept, relocated }; }
  for (const f of files) {
    if (!f.startsWith(prefix)) continue;
    // @decision 63e49ee2 (round 3) — also honour the identity-less ownership set, never only
    // `orphanLatchFiles` — see {@link keptUnreadableLatchFiles}.
    const alreadyOwned = [...activeQuarantines.values()].some((e) => e.orphanLatchFiles?.includes(f))
      || pendingUnresolvedQuarantines.some((p) => p.entry.orphanLatchFiles?.includes(f))
      || keptUnreadableLatchFiles.has(f);
    if (alreadyOwned) continue;
    const tmpPath = path.join(MERGE_QUARANTINE_DIR, f);
    let raw: string;
    try {
      raw = fs.readFileSync(tmpPath, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        keptUnreadableLatchFiles.add(f);
        // eslint-disable-next-line no-console
        console.error(`[merge-quarantine] could not read tmp residue ${f} (for a reason other than being missing) while clearing ${clearIdentity} — treating its ownership as UNKNOWN; it is marked kept in THIS PROCESS too, rather than assuming it is safe to delete.`);
      }
      continue; // gone (ENOENT), or unreadable but now marked kept above
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { continue; } // corrupt — nothing to protect
    if (!isReadableLatchRecord(parsed)) continue; // e.g. the bare literal `null`
    if (typeof parsed.repoPath !== "string") continue;
    if (directPathIdentity(parsed.repoPath) === clearIdentity) continue; // genuinely the clearer's own data
    if (isRepoPathCurrentlyResolvable(parsed.repoPath)) continue; // a resolvable leftover is safe to overwrite today
    const r = protectOccupantContentBeforeDelete(tmpPath, parsed.repoPath, clearIdentity, liftedKeys);
    if (r.persisted) (r.relocated ? relocated : kept).push(r.persisted);
  }
  return { kept, relocated };
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
 *
 * @decision 4900c365 (round 2) — this check, unmodified, is ALSO what keeps a FAILED {@link
 * protectOccupantContentBeforeDelete} copy alive — that function self-references a failed file into a
 * pending record's own `orphanLatchFiles`, so every call site finds it owned, not just the failing one.
 *
 * @decision 63e49ee2 (round 2) — a read-failure tmp residue is now protected by this function's own
 * EXISTING, unmodified ownership check (no `excludeFilenames` param needed). See the decision record.
 *
 * @decision 21ec39e5 (round 2) — `policy` is a REQUIRED discriminated union (an earlier optional-param
 * shape once silently widened an untouched call site). See the decision record for the full rationale.
 */
// @decision 182c01cc (round 4) — `keptEntries` ALSO names each kept repoPath's own EXACT tmp filename
// (additive; see the decision record's "Round 4" section for why `referencingRepoPaths` alone can't
// build a real `{id}` route).
type TmpSweepPolicy = { mode: "unconditional-owner-protected" } | { mode: "content-checked"; candidateTokens: string[] };
function sweepTmpResidueForHashIfUnreferenced(hash: string, policy: TmpSweepPolicy): { kept: boolean; referencingRepoPaths: string[]; keptEntries: Array<{ repoPath: string; sourceFile: string }>; contentKeptEntries: Array<{ repoPath: string; sourceFile: string }>; anyUnattributed: boolean } {
  const prefix = `${hash}.json.tmp-`;
  let files: string[];
  try { files = fs.readdirSync(MERGE_QUARANTINE_DIR); } catch { return { kept: false, referencingRepoPaths: [], keptEntries: [], contentKeptEntries: [], anyUnattributed: false }; }
  const referencingRepoPaths = new Set<string>();
  const keptEntries: Array<{ repoPath: string; sourceFile: string }> = [];
  const contentKeptEntries: Array<{ repoPath: string; sourceFile: string }> = [];
  // @decision 63e49ee2 (round 3) — tracked separately from `referencingRepoPaths`: a read-failure-kept
  // file has no identity to attribute, but it must still suppress this file's own unlink below.
  let anyUnattributed = false;
  for (const f of files) {
    if (!f.startsWith(prefix)) continue;
    if (keptUnreadableLatchFiles.has(f)) { anyUnattributed = true; continue; }
    const owners = new Set<string>();
    for (const e of activeQuarantines.values()) if (e.orphanLatchFiles?.includes(f)) owners.add(e.repoPath);
    for (const p of pendingUnresolvedQuarantines) if (p.entry.orphanLatchFiles?.includes(f)) owners.add(p.entry.repoPath);
    if (owners.size > 0) {
      for (const o of owners) { referencingRepoPaths.add(o); keptEntries.push({ repoPath: o, sourceFile: f }); }
      continue;
    }
    if (policy.mode === "unconditional-owner-protected") {
      try { fs.unlinkSync(path.join(MERGE_QUARANTINE_DIR, f)); } catch { /* best-effort */ }
      continue;
    }
    const safety = orphanSweepSafeToDelete(f, policy.candidateTokens);
    if (!safety.safe) {
      // @decision 21ec39e5 (round 2) — `readFailed` is the ONLY reliable "genuine read failure" signal;
      // a readable record that merely lacks a string `repoPath` is a real, attributable-by-name-only
      // keep, never mistaken for an unreadable file (round 1's own bug — see the decision record).
      if (safety.readFailed) {
        // Mark it so a LATER call on this same basename doesn't need to re-attempt the I/O, mirroring
        // protectForeignTmpResidueBeforeSweep's own identical mark.
        keptUnreadableLatchFiles.add(f);
        anyUnattributed = true;
      } else if (safety.parsedRepoPath) {
        contentKeptEntries.push({ repoPath: safety.parsedRepoPath, sourceFile: f });
      } else {
        anyUnattributed = true;
      }
      // eslint-disable-next-line no-console
      console.error(`[merge-quarantine] keeping tmp residue ${f} UNTOUCHED (left stale) — no surviving entry references it, but ${safety.readFailed ? "its own content could not be read" : safety.parsedRepoPath ? `its own parsed content names repoPath '${safety.parsedRepoPath}'` : "its own parsed content names no repoPath"}, and could not be positively proven to hold only token(s) this write/clear already accounts for; fail-closed rather than risk destroying a foreign token nothing in memory currently owns or references.`);
      continue;
    }
    try { fs.unlinkSync(path.join(MERGE_QUARANTINE_DIR, f)); } catch { /* best-effort */ }
  }
  return { kept: referencingRepoPaths.size > 0 || contentKeptEntries.length > 0 || anyUnattributed, referencingRepoPaths: [...referencingRepoPaths], keptEntries, contentKeptEntries, anyUnattributed };
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
function sweepOwnLatchFileUnlessOwnedElsewhere(filename: string, candidateTokens?: string[]): { kept: boolean; referencingRepoPaths: string[] } {
  // @decision 63e49ee2 (round 3) — same identity-less keep as {@link sweepOrphanLatchFileIfUnreferenced}.
  //
  // @decision 8db913e2 (Follow-up 95ea8d3f) — a stale mark must not outlive the resolved read failure that set it; see the
  // decision record for the pending-sweep-vs-deleteMergeQuarantineLatchByKey gap this closes. Omitting
  // `candidateTokens` (every pre-existing caller) keeps this byte-identical to before.
  if (keptUnreadableLatchFiles.has(filename)) {
    const provenCoverage = !!candidateTokens && markedFinalFullyCoveredByClear(path.join(MERGE_QUARANTINE_DIR, filename), candidateTokens);
    if (!provenCoverage) return { kept: true, referencingRepoPaths: [] };
    // @decision 8db913e2 (Follow-up 95ea8d3f, Round 2, Critical) — proven coverage may settle ONLY the active-armed-key/
    // fresh-write-target half of physicalOwnerRepoPaths below, NEVER a surviving pending entry's own
    // sourceFile or any entry's orphanLatchFiles naming this file. See the decision record.
    const sharedClaimants = survivingSharedClaimRepoPaths(filename);
    if (sharedClaimants.length > 0) return { kept: true, referencingRepoPaths: sharedClaimants };
    const unlinkConfirmed = unlinkLatchFileConfirmed(filename);
    if (unlinkConfirmed) keptUnreadableLatchFiles.delete(filename);
    // @decision 8db913e2 (Follow-up 95ea8d3f, Round 2, nitpick) — an unconfirmed unlink (EPERM/EBUSY) must be reported as
    // kept, never as plain success — the file is still physically there.
    return { kept: !unlinkConfirmed, referencingRepoPaths: [] };
  }
  const owners = physicalOwnerRepoPaths(filename);
  if (owners.length > 0) return { kept: true, referencingRepoPaths: owners };
  const unlinkConfirmed = unlinkLatchFileConfirmed(filename);
  return { kept: !unlinkConfirmed, referencingRepoPaths: [] };
}

/** `true` iff `key`'s CURRENT occupant in `activeQuarantines` is genuinely `entry` itself — either the
 *  exact same object (the ordinary, still-valid case) or, for a genuine REBUILD of the SAME logical
 *  entry (a union, an orphan merge, a re-point captured before {@link replaceEntryEverywhere} has synced
 *  this particular slot yet), a DIFFERENT object (`occupant`) sharing `entry`'s identity whose OWN token
 *  set is ENTIRELY CONTAINED in `entry`'s — `entry` is the CURRENT truth; `occupant` may be an older,
 *  smaller snapshot of it, never the other way round. `false` for anything else: nothing occupies `key`
 *  at all, a WHOLLY UNRELATED entry does, two independent same-identity records with
 *  overlapping-but-incomparable tokens (neither a subset of the other), or — card `f3c644ca`, a real,
 *  reproduced, DURABLE over-unblock — a DIFFERENT, INDEPENDENT record that merely shares `entry`'s
 *  identity with no token lineage at all.
 *
 *  @decision d4b25feb — identity alone is NEVER sufficient proof of "same logical entry": one identity
 *  can legitimately hold two INDEPENDENT records at once (e.g. a stale 883e29bc pending-divert twin whose
 *  own `armedKeys` still names a key a later, unrelated same-identity raise now genuinely owns).
 *
 *  @decision 8db913e2 (Follow-up f3c644ca, round 2 CR) — the direction is `occupant ⊆ entry` ONLY, never
 *  the reverse: the reverse direction reopened a DIFFERENT over-unblock via the automatic settle-time
 *  `clearMergeQuarantineByToken`. Never reintroduce it.
 *
 *  Round 2 CR found `entry ⊆ occupant` (this predicate's prior, round-1 shape) let a pending twin `P`
 *  sharing ONE of active `W`'s several outstanding tokens wrongly satisfy `P ⊆ W`, lifting W's ENTIRE map
 *  slot (and its physical latch) on P's own single-token clear — destroying W's OTHER, still-outstanding
 *  tokens. `occupant ⊆ entry` has no such hazard and is also the semantically safe direction at every
 *  WRITE-type caller. Code Review verified every real human/automatic clear route it could construct
 *  still lifts a genuine rebuild fully (W⊂entry, entry⊂W, overlapping-incomparable, disjoint, equal — each
 *  × every route, in memory and after reboot) — ONE hand-built exception stays FAIL-CLOSED, never
 *  fail-open: an entry armed at two keys (`armedKeys:[K,K2]`) whose own `K2` slot was never synced to a
 *  later, same-identity SUPERSET build sitting there can leave that K2 slot un-lifted by the resolvable
 *  `clearMergeQuarantine` route specifically (`clearMergeQuarantineByRecordedPath` still clears it); no
 *  real path to that unsynced state was found — {@link replaceEntryEverywhere} syncs every `===` slot.
 *
 *  Tokens are fresh `randomUUID()`s per raise, never reused across independent raises, so two genuinely
 *  independent records always have DISJOINT token sets (this correctly returns `false` for them). A
 *  genuinely overlapping-but-incomparable pair (sharing SOME tokens, neither a full subset of the other)
 *  also returns `false` here — verified (Code Review) to still resolve cleanly through every real clear
 *  route via OTHER mechanisms, never through this predicate claiming a false ownership. A key a fresh
 *  raise reused from a now-stale `armedKeys` snapshot (card 883e29bc round 3 finding 1 — the ORIGINAL,
 *  pending-only shape this predicate closed; card 82032b5c round 3 MINOR A generalized it to the ACTIVE
 *  side too) is exactly the disjoint-tokens case and still correctly returns `false`. Lifting/overwriting
 *  `key` when this is `false` would destroy an unrelated repo's own, genuine quarantine — gate every such
 *  write on this. */
function entryStillOwnsKey(key: string, entry: MergeQuarantineEntry): boolean {
  const occupant = activeQuarantines.get(key);
  if (!occupant) return false;
  if (occupant === entry) return true;
  if (directPathIdentity(occupant.repoPath) !== directPathIdentity(entry.repoPath)) return false;
  if (occupant.tokens.length === 0 || entry.tokens.length === 0) return false;
  return occupant.tokens.every((t) => entry.tokens.includes(t));
}

/** TEST-ONLY: directly arms `entry` at `key` in the REAL, module-global `activeQuarantines` map itself —
 *  UNLIKE {@link armQuarantineKeyTestOnly}, which writes into a `byRepoKey` map the CALLER supplies, this
 *  one has no caller-owned map to isolate into and mutates the live singleton directly. Bypasses every
 *  real arming invariant, including the "tokens is never empty" guarantee every real construction path
 *  maintains (every fresh-entry site seeds `tokens` with >=1 element; every on-disk parse falls back to a
 *  non-empty array; no clear path ever leaves a live zero-token record). Lets a test pin
 *  {@link entryStillOwnsKey}'s own defensive non-empty-tokens clause against a state no real code path
 *  can produce. Never imported by `index.ts` — the name's `TestOnly` suffix is load-bearing:
 *  `no-src-testonly-import-guard.mjs` matches `/TestOnly$/` specifically to catch a future import of
 *  this exact kind of live-map-mutating seam into production code. */
export function setActiveQuarantineTestOnly(key: string, entry: MergeQuarantineEntry): void {
  activeQuarantines.set(key, entry);
}

/** TEST-ONLY: directly marks `basename` in the REAL, module-global {@link keptUnreadableLatchFiles} set —
 *  lets a test construct the "a stale mark outlived the read failure that set it, and the file is now
 *  readable again" precondition {@link writePendingDivertFile}'s own round-7 re-read-and-union branch
 *  exists for, without needing to engineer a genuine, OS-level non-ENOENT read failure (EACCES is not
 *  portably reproducible across this module's own test matrix). Never imported by `index.ts` — see
 *  {@link setActiveQuarantineTestOnly}'s own doc for why the `TestOnly` suffix is load-bearing. */
export function markLatchFileUnreadableTestOnly(basename: string): void {
  keptUnreadableLatchFiles.add(basename);
}

/**
 * `entry`'s own (possibly stale or INCOMPLETE) `armedKeys`, UNIONED with a fresh scan of
 * `activeQuarantines` for every key `k` where `activeQuarantines.get(k) === entry` (reference equality —
 * the SAME discriminator {@link replaceEntryEverywhere} itself uses), UNIONED with `key` itself. Union
 * only — this can ADD a key `armedKeys` never recorded, but never DROPS one `armedKeys` already names,
 * even a stale one no longer actually owned (a caller's own {@link entryStillOwnsKey} gate is what
 * screens those out for an ACTING decision; this helper only answers "what might this entry be armed at
 * right now", never "what does it still genuinely own").
 *
 * Exists because `protectOccupantContentBeforeDelete`'s own both-indices re-point branch can re-point
 * EVERY `activeQuarantines` slot that pointed at a multi-key twin onto one freshly-written replacement
 * object (`written.entry`, via `replaceEntryEverywhere`) WITHOUT ever unioning the twin's own `armedKeys`
 * onto it — the `c9114934`/`cd5a3cf9` union gate restricts `written.entry`'s own `armedKeys` source to
 * `toPersist`/`oldAtFilename` alone — so the replacement can carry NO `armedKeys` of its own even though
 * `activeQuarantines` now genuinely maps MULTIPLE keys to it.
 *
 * @decision 8db913e2 ("armedKeys — left unfixed (Lead ruling)") — derive from LIVE occupancy, never trust
 * a cached list alone (and never copy a REPLACED object's own stale list forward uncritically) — this is
 * that ruling's own endorsed alternative, applied at each of this card's own consumption chokepoints.
 * @decision 6be6c9ff — the concrete gap this closes: a clear/lift/raise keyed off `entry.armedKeys` alone
 * only ever covers whichever ONE key resolved it, silently stranding a re-pointed multi-key twin's OTHER
 * key(s) — see the decision record.
 */
function liveArmedKeys(key: string, entry: MergeQuarantineEntry): string[] {
  const keys = new Set<string>(entry.armedKeys ?? []);
  for (const [k, v] of activeQuarantines) { if (v === entry) keys.add(k); }
  keys.add(key);
  return [...keys];
}

/**
 * `key` itself (unconditionally — the caller already freshly matched it) plus every OTHER member of
 * `entry`'s own `armedKeys` ALONE, gated through {@link entryStillOwnsKey}. `undefined` for `entry`
 * degrades to `[key]` alone.
 *
 * **NO LONGER the same shape as `clearMergeQuarantineByKey`'s own `keysToLift`** (card `6be6c9ff`
 * widened that one to `liveArmedKeys(key, entry).filter(...)`, a live-occupancy UNION) — this helper
 * deliberately keeps the NARROWER, `armedKeys`-only shape, because its one caller's `liftedKeys` must
 * stay conservative: over-including a key there is FAIL-OPEN (wrongly strips a resolvedKey from a
 * protective copy that should survive), the opposite of `keysToLift`'s own fail-closed-safe widening.
 * **Known under-inclusion (card `6be6c9ff`'s own audit, NOT fixed here — see card `c52b290e`):** when
 * `entry` is itself a re-pointed multi-key twin with an EMPTY `armedKeys` (the shape `6be6c9ff` closes
 * elsewhere), this helper still misses the twin's OTHER key(s) — fail-closed (over-protective), not
 * fail-open, so lower priority than the sites `6be6c9ff` actually fixed.
 *
 * Serves `enterMergeQuarantine`'s existing-branch raise, feeding its own `liftedKeys` set into
 * `excludeLiftedResolvedKey(s)` — never hand-roll a second, unfiltered `[key, ...entry.armedKeys]` at a
 * new call site.
 *
 * @decision 8db913e2 (Follow-up 78fccd3f) — extracted because the raise path built this UNFILTERED,
 * re-including a stale `armedKeys` member the entry no longer owns. See the decision record.
 */
export function ownedKeysIncluding(key: string, entry: MergeQuarantineEntry | undefined): string[] {
  if (!entry) return [key];
  return [key, ...(entry.armedKeys ?? []).filter((k) => k !== key && entryStillOwnsKey(k, entry))];
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
 * @decision e1cb7d33 — this clear is OUT OF SCOPE for the WRITE-side guard, never REFUSED — but since
 * `c9114934` it still durably PROTECTS a foreign degraded occupant's content before the unconditional
 * unlink destroys it; see `deleteMergeQuarantineLatchByKey`.
 */
export function clearMergeQuarantineByKey(key: string, identityRepoPath: string, externalLiftedKeys?: ReadonlySet<string>): { wasQuarantined: true; latchKept?: true; referencingRepoPaths?: string[]; contentKeptRepoPaths?: string[]; unattributed?: true; stillBlockedCoOccupants: BlockedCoOccupant[] } | void {
  const entry = activeQuarantines.get(key);
  // @decision 8db913e2 (round 4) — candidate tokens for the ONE tombstone call at the end of this
  // function (`tombstoneIfNotSurviving`) — never tombstoned here, at this bare lookup: `entry` can be a
  // FOREIGN occupant (d2582692's shape) this clear ends up PROTECTING, not destroying.
  const candidateTokens: string[] = [...(entry?.tokens ?? [])];

  // Lift EVERY key this entry is armed under (its own tracked set), never reference equality — a union or
  // an orphan merge REBUILDS the entry object, so a map slot holding an OLDER build of the "same" logical
  // entry is no longer `===` the one `key` resolves to (round 2 finding 2).
  //
  // @decision 8db913e2 (Follow-up 3152ec90) — gate every OTHER `armedKeys` member through
  // `entryStillOwnsKey` (never `key` itself, already freshly matched) — an unconditional lift here
  // deletes an unrelated raise's own live map slot once a boot-diverted twin's `armedKeys` goes stale.
  //
  // @decision 6be6c9ff — the candidate set itself is {@link liveArmedKeys}, never `entry.armedKeys`
  // alone — see the decision record for the re-pointed multi-key-twin gap this closes.
  const keysToLift = entry
    ? liveArmedKeys(key, entry).filter((k) => k === key || entryStillOwnsKey(k, entry))
    : [key];
  // @decision 8db913e2 (round 4) — every physical final this clear's own write path touches, for the
  // `tombstoneIfNotSurviving` call at the end — see that function's own doc, part (b).
  const touchedFinalBasenames = keysToLift.map((k) => path.basename(quarantinePathForKey(k)));
  // A pending (boot-unverifiable, no-resolvedKey) entry isn't keyed into activeQuarantines at all — see
  // reenterMergeQuarantinesAtBoot's PASS 1 and activeMergeQuarantineFor's lazy re-resolve. Match it by
  // DIRECT identity against `identityRepoPath` (never a fresh walking recompute — see this function's own
  // doc comment) so a clear issued while still unresolvable actually lifts it, and delete its OWN source
  // file too (round 2 finding 1), or it survives to resurrect the quarantine.
  const identity = directPathIdentity(identityRepoPath);

  // @decision 8db913e2 (Follow-up c93e9e7a) — compute the full lifted-key union `L` ONCE, before any
  // delete in this call, never per-entry against a map an earlier tied twin's processing already
  // mutated. See the decision record's own Follow-up c93e9e7a section for the full design.
  //
  // `pendingPlan` caches each tied pending entry's own reduce-or-remove decision and (for a to-be-removed
  // entry) its pre-delete-snapshot-owned armed keys, keyed by the entry's own stable wrapper object
  // (`.entry` can be reassigned in place by a reduce — see `replaceEntryEverywhere` — but the wrapper
  // object itself never is), so the real, mutating filter below reuses the exact same decision rather
  // than recomputing it. `externalLiftedKeys` lets a caller that delegates here per matched active entry
  // (`clearMergeQuarantineByRecordedPath`) thread its own, already-complete outer union in.
  const pendingPlan = new Map<PendingUnresolvedQuarantine, { action: "reduce" } | { action: "remove"; ownedArmedKeys: string[] }>();
  const L = new Set<string>([...keysToLift, ...(externalLiftedKeys ?? [])]);
  for (const p of pendingUnresolvedQuarantines) {
    // Same tie rules as the pre-existing filter below: the same object reference, a shared lifted
    // key/orphan-file reference (decisions d4b25feb round 2, 1922be3a round 5, 882d6cff multi-claimant),
    // or a proven token subset.
    if (directPathIdentity(p.entry.repoPath) !== identity) continue;
    const subsetOfClearedTokens = !!entry && p.entry.tokens.length > 0 && p.entry.tokens.every((t) => entry.tokens.includes(t));
    const tiedViaKeyOrOrphanRef = !!entry && (keysToLift.some((k) => p.entry.armedKeys?.includes(k)) || !!entry.orphanLatchFiles?.includes(p.sourceFile));
    const tiedToThisEntity = !entry || p.entry === entry || tiedViaKeyOrOrphanRef || subsetOfClearedTokens;
    if (!tiedToThisEntity) continue;
    // @decision 64119847 — a structural-only tie REDUCES rather than drops when P still holds a token
    // outside `entry.tokens`; a reduced twin keeps EVERY key it was armed on, so it contributes NOTHING
    // to `L` — see the decision record.
    if (entry && tiedViaKeyOrOrphanRef && p.entry !== entry && !subsetOfClearedTokens) {
      const remainingTokens = p.entry.tokens.filter((t) => !entry.tokens.includes(t));
      if (remainingTokens.length > 0) { pendingPlan.set(p, { action: "reduce" }); continue; }
    }
    // @decision 8db913e2 (Follow-up 4b06875f, Round 4, CR be296830) — ownership gated through
    // `entryStillOwnsKey`, never the whole `armedKeys` list — over-including is FAIL-OPEN. Read against
    // the still-unmutated live map; nothing in this function has deleted anything yet at this point.
    const ownedArmedKeys = (p.entry.armedKeys ?? []).filter((k) => entryStillOwnsKey(k, p.entry));
    pendingPlan.set(p, { action: "remove", ownedArmedKeys });
    for (const k of ownedArmedKeys) L.add(k);
  }

  for (const k of keysToLift) activeQuarantines.delete(k);
  // The entry's own physical latch file(s) may live at a DIFFERENT hash than `key`'s — e.g. never migrated
  // because the registered path was unresolvable at boot (PASS 1 never migrates on an unverifiable key).
  // Sweep every armed key's own latch path, or a stale file survives a "successful" clear and resurrects
  // the quarantine on the next boot.
  //
  // @decision c9114934 — gate on the in-memory `entry.repoPath` actually being cleared, never a bare
  // on-disk repoPath-string compare per key — UNION-KEYS' own second key can show a stale, pre-union
  // repoPath on disk for the SAME entity; see the decision record for why that must never "protect" it.
  const clearingRepoPath = entry && directPathIdentity(entry.repoPath) !== directPathIdentity(identityRepoPath)
    ? identityRepoPath : undefined;
  // @decision f5c42043 — CAPTURE and SURFACE every kept-file's own referencing repoPaths (previously
  // discarded for the deleteMergeQuarantineLatchByKey calls below) instead of a bare unqualified success.
  // @decision 182c01cc — two SEPARATE Maps (repoPath -> sourceFile): `keptReferencingRepoPaths` feeds
  // `latchKept` (file genuinely survives, unrelocated); `relocatedCoOccupants` never sets `latchKept`
  // (round 2, finding 2 — the old file is genuinely gone) but still lands in `stillBlockedCoOccupants`.
  const keptReferencingRepoPaths = new Map<string, string>();
  const relocatedCoOccupants = new Map<string, string>();
  // @decision 8db913e2 (Follow-up 0a783fb2) — SEPARATE from `keptReferencingRepoPaths`: an orphan-sweep
  // referencer is a cross-reference, so it builds via `blockedCoOccupantForReferencer`, never the bare
  // `blockedCoOccupant` below; `keptContentRepoPaths` never joins `stillBlockedCoOccupants` at all.
  const orphanReferencingRepoPaths = new Map<string, string>();
  const keptContentRepoPaths = new Map<string, string>();
  // @decision 8db913e2 (Follow-up 95ea8d3f, Round 2, nitpick) — see the matching note at this function's own sourceFilesToSweep loop below.
  let anyKeptUnattributed = false;
  // @decision d163aef5 (round 4) — neither protect pass below gates on resolvability anymore (round 3's
  // own gate let a RESOLVABLE eviction winner's clear destroy a foreign file at one of its OTHER armed
  // keys); the PRIMARY ownership check and the token-overlap BACKSTOP both run for every key, every clear.
  //
  // @decision 8db913e2 (Follow-up c93e9e7a) — pass `L` (computed above, before any delete in this call)
  // rather than a `keysToLift`-only set, so a key only a tied pending twin owns is still correctly
  // recognised as already lifted by this call (round-2 MAJOR 2 — this active loop used to miss it).
  for (const k of keysToLift) {
    const r = deleteMergeQuarantineLatchByKey(k, clearingRepoPath, entry, identity, L);
    for (const kc of r.kept) keptReferencingRepoPaths.set(kc.repoPath, kc.sourceFile);
    for (const rc of r.relocated) relocatedCoOccupants.set(rc.repoPath, rc.sourceFile);
    // @decision 702b4241 (round 2) — fold an UNATTRIBUTED keep (card 702b4241's own basename-only
    // unreadable mark, or any other claimant-less protect failure) into this function's own return —
    // previously lost entirely, so a kept file reported as a bare, unqualified success.
    if (r.unattributed) anyKeptUnattributed = true;
  }
  const orphanFilesToSweep = new Set<string>(entry?.orphanLatchFiles ?? []);
  const sourceFilesToSweep: string[] = [];
  // @decision 07e3ad30 — never reassign this array via `.filter(cb)` here: the "remove" branch's own
  // protect call can push a fresh entry onto it mid-callback, and `.filter`'s reassigned return value
  // silently drops anything pushed past its own length snapshot. See the decision record.
  for (const p of [...pendingUnresolvedQuarantines]) {
    const plan = pendingPlan.get(p);
    if (!plan) continue;

    if (plan.action === "reduce") {
      const overlapTokens = p.entry.tokens.filter((t) => entry!.tokens.includes(t));
      const remainingTokens = p.entry.tokens.filter((t) => !entry!.tokens.includes(t));
      const updated: MergeQuarantineEntry = { ...p.entry, tokens: remainingTokens };
      // @decision d4b25feb (round 3) — re-point every in-memory reference BEFORE any durable write.
      // @decision 64119847 — `p` IS `arr[idx]`; this call's own in-place `p.entry = newEntry` mutation
      // is what makes the kept slot reflect `updated` — see the decision record, never a reassignment.
      replaceEntryEverywhere(activeQuarantines, p.entry, updated);
      // @decision 64119847 — mirrors clearTokenFromPendingIndices's own durable-rewrite shape; only
      // `overlapTokens` feeds `candidateTokens` (never the full set), so this write always precedes this
      // function's one deferred tombstone call. See the decision record for the ordering argument.
      const writtenBasenames = new Set<string>([p.sourceFile]);
      // @decision 2dd97aaa (Follow-up 58957b1e) — pass the FULL `entry!.tokens` as `droppedTokens`, same
      // strict-superset reasoning (and same value) as this branch's own `writePendingDivertFile` call
      // below — this write runs BEFORE the function's one deferred tombstone call (line ~4472).
      for (const k of p.entry.armedKeys ?? []) {
        if (activeQuarantines.get(k) !== updated) continue;
        writtenBasenames.add(`${quarantineHashForKey(k)}.json`);
        if (!writeMergeQuarantineLatch(updated, new Set(entry!.tokens), false, k)) {
          // eslint-disable-next-line no-console
          console.error(`[merge-quarantine] could not durably persist the reduced token set for ${p.entry.repoPath}'s own tied pending twin's armed copy at key ${k} after this clear — the PRE-EXISTING durable state there is left UNTOUCHED, so a restart before this is fixed may re-union an already-cleared token back in.`);
        }
      }
      // @decision 702b4241 (round 3) — use whatever `writePendingDivertFile` ACTUALLY wrote to; mutate
      // `p` in place (never reassign `arr[idx]` — `64119847`'s own rule), as the ONLY pending entry this
      // redirect concerns.
      //
      // @decision 2dd97aaa — pass the FULL `entry!.tokens`, never just `overlapTokens`: a stale on-disk
      // copy of this twin can hold OTHER tokens of `entry` already dropped from `p.entry.tokens` in
      // memory by an earlier reduce whose write failed — a strict superset, always safe here.
      const writtenTwin = writePendingDivertFile(p.sourceFile, updated, new Set(entry!.tokens));
      if (writtenTwin) {
        // @decision b47cf261 — re-point every in-memory reference BEFORE the hand assignment below, or
        // activeQuarantines is left pointing at the now-stale `updated`, breaking 64283e06's twin invariant.
        if (writtenTwin.entry !== updated) replaceEntryEverywhere(activeQuarantines, updated, writtenTwin.entry);
        p.entry = writtenTwin.entry;
        p.sourceFile = writtenTwin.filename;
      } else {
        // eslint-disable-next-line no-console
        console.error(`[merge-quarantine] could not durably persist the reduced token set for ${p.entry.repoPath}'s own tied pending twin at ${p.sourceFile} after this clear — the PRE-EXISTING durable state is left UNTOUCHED, so a restart before this is fixed re-arms with an already-cleared token still counted as outstanding (delays the eventual full lift; never a false lift).`);
      }
      // @decision eedf16f5 — called ONCE with the FULL overlap set, never once per token, and only
      // when non-empty — a twin tied by key/orphan-ref alone, no shared token, makes ZERO calls here,
      // byte-identical to pre-fix; a non-empty overlap must never be split back into per-token calls.
      //
      // @decision 9c681680 — pass `writtenTwin.entry` when truthy, never the stale pre-union `updated`,
      // mirroring the sibling clearTokenFromPendingIndices's own equivalent call — else an orphan file
      // only `writtenTwin.entry`'s own disk-unioned `orphanLatchFiles` names is never narrowed.
      if (overlapTokens.length > 0) rewriteOrphanLatchFilesAfterPartialClear(writtenTwin ? writtenTwin.entry : updated, writtenBasenames, new Set(overlapTokens));
      candidateTokens.push(...overlapTokens);
      continue; // keep P, reduced — its armedKeys/activeQuarantines presence is untouched; nothing to splice
    }

    candidateTokens.push(...p.entry.tokens);
    for (const f of p.entry.orphanLatchFiles ?? []) orphanFilesToSweep.add(f);
    // @decision 883e29bc — a diverted-pending entry is also armed under resolvedKey; lift that too.
    // @decision 8db913e2 (Follow-up c93e9e7a) — `plan.ownedArmedKeys` was computed in the PRE-PASS above,
    // against the then-still-unmutated map — never recomputed here against a map an EARLIER tied twin's
    // own processing (in THIS SAME loop) may have already mutated.

    // A repeated deleteMergeQuarantineLatchByKey call on a key an earlier twin already deleted is
    // intentional and idempotent here: its own unlink tolerates ENOENT.
    for (const k of plan.ownedArmedKeys) {
      activeQuarantines.delete(k);
      touchedFinalBasenames.push(path.basename(quarantinePathForKey(k)));
      // @decision d163aef5 (round 4) — same ownership + token-overlap protection as clearMergeQuarantineByKey.
      const r = deleteMergeQuarantineLatchByKey(k, undefined, p.entry, identity, L);
      for (const kc of r.kept) keptReferencingRepoPaths.set(kc.repoPath, kc.sourceFile);
      for (const rc of r.relocated) relocatedCoOccupants.set(rc.repoPath, rc.sourceFile);
      // @decision 702b4241 (round 2) — same fold as the active loop above.
      if (r.unattributed) anyKeptUnattributed = true;
    }
    sourceFilesToSweep.push(p.sourceFile);
    // @decision 07e3ad30 — resolve `p`'s own CURRENT index fresh, right now, never a precomputed one —
    // a push from the protect calls above lands at the tail and must never be disturbed by this splice.
    // See the decision record for why `p`'s own wrapper is never itself replaced-by-index by this.
    const idx = pendingUnresolvedQuarantines.indexOf(p);
    if (idx !== -1) {
      pendingUnresolvedQuarantines.splice(idx, 1);
    } else {
      // Not a silent skip: `p` is already absent from the live array by some other path, so there is no
      // stale copy left behind to worry about — but per the invariant argued above this is NOT expected
      // to ever fire in production. Surfaced loudly rather than swallowed, so a future regression that
      // DOES make it fire is seen rather than silently papered over by a no-op.
      // eslint-disable-next-line no-console
      console.error(`[merge-quarantine] expected to remove ${p.entry.repoPath}'s own tied pending twin (${p.sourceFile}) from pendingUnresolvedQuarantines after lifting its armed keys, but it was already absent from the live array by the time this ran — nothing stale was left behind, but this was not expected; investigate if seen.`);
    }
  }
  // @decision 883e29bc (round 4) — sweep each removed entry's own sourceFile via
  // sweepOwnLatchFileUnlessOwnedElsewhere (never a bare unlink): it can be the SAME physical path a
  // different, surviving repo's fresh raise now owns (reusing the freed key).
  //
  // @decision f5c42043 — CAPTURE and SURFACE this sweep's `{kept, referencingRepoPaths}` (previously
  // discarded) instead of a bare unqualified success, mirroring clearMergeQuarantineByRecordedPath's own
  // `latchKept` reporting for the SAME "a sibling still needs this file" shape.
  //
  // @decision 8db913e2 (Follow-up 95ea8d3f, Round 2, nitpick) — `kept` with an EMPTY `referencingRepoPaths` (an unconfirmed
  // EPERM/EBUSY unlink, or a marked-but-unprovable-coverage keep) still means something was kept — track
  // it via `anyKeptUnattributed` so it surfaces as `latchKept:true` too, never as plain success.
  for (const f of sourceFilesToSweep) {
    const result = sweepOwnLatchFileUnlessOwnedElsewhere(f);
    if (result.kept) {
      if (result.referencingRepoPaths.length > 0) for (const rp of result.referencingRepoPaths) keptReferencingRepoPaths.set(rp, f);
      else anyKeptUnattributed = true;
    }
  }
  // @decision 8db913e2 (Follow-up f2cc5f18) — `candidateTokens` (captured at this function's own top,
  // before any deletes) already holds every token THIS clear is lifting — `tombstoneIfNotSurviving`
  // below hasn't run yet, so the GLOBAL `clearedTokens` tombstone set does not yet include them either.
  //
  // @decision 8db913e2 (Follow-up 0a783fb2) — this sweep's own result used to be discarded entirely
  // (console.error only, no response field) — fold it through the shared helper like every other site.
  // @decision 8db913e2 (Follow-up 0a783fb2, Code Review 47289f8d) — exclude this clear's OWN identity
  // from the orphan-sweep's own true-referencer check — see that function's own doc for why.
  const excludeOwnIdentity = new Set([identity]);
  for (const orphanFile of orphanFilesToSweep) {
    const folded = foldOrphanSweepResult(sweepOrphanLatchFileIfUnreferenced(orphanFile, candidateTokens, excludeOwnIdentity), orphanFile, keptContentRepoPaths);
    for (const rp of folded.referencingRepoPaths) orphanReferencingRepoPaths.set(rp, orphanFile);
    if (folded.unattributed) anyKeptUnattributed = true;
  }
  // @decision 8db913e2 (round 4) — THE ONE tombstone call for this clear, now that every mutation above
  // (deletes, the pending filter, every sweep) is done; see `tombstoneIfNotSurviving`'s own doc for why
  // this replaces round 3's own per-site, outcome-gated tombstone attempts (CR3 BLOCKER 1).
  tombstoneIfNotSurviving(candidateTokens, [...touchedFinalBasenames, ...sourceFilesToSweep]);
  // @decision 2dd97aaa — a content-kept claimant whose own file no longer exists BY THE TIME this clear
  // returns (e.g. swept by a later step of this same call) is a ghost, never a real claim — drop it here,
  // right before this function's own result is built, rather than report a keep nothing backs any more.
  for (const [rp, sourceFile] of [...keptContentRepoPaths]) {
    if (!fs.existsSync(path.join(MERGE_QUARANTINE_DIR, sourceFile))) keptContentRepoPaths.delete(rp);
  }
  // @decision 182c01cc (round 2, finding 1) — a RELOCATED co-occupant alone must still produce a
  // non-void result naming it: `latchKept` stays absent, but `stillBlockedCoOccupants` never is.
  const anyReferencing = keptReferencingRepoPaths.size > 0 || orphanReferencingRepoPaths.size > 0;
  if (anyReferencing || anyKeptUnattributed || relocatedCoOccupants.size > 0 || keptContentRepoPaths.size > 0) {
    return {
      wasQuarantined: true,
      // @decision 182c01cc — latchKept/referencingRepoPaths name ONLY the kept subset; a relocation never
      // sets either (round 2, finding 2).
      ...(anyReferencing || anyKeptUnattributed || keptContentRepoPaths.size > 0 ? { latchKept: true as const } : {}),
      ...(anyReferencing || anyKeptUnattributed
        ? { referencingRepoPaths: [...keptReferencingRepoPaths.keys(), ...orphanReferencingRepoPaths.keys()] } : {}),
      // @decision 8db913e2 (Follow-up 0a783fb2) — a content-parsed keep names no live entry to clear by
      // id, so it never joins `stillBlockedCoOccupants` below — only this field.
      ...(keptContentRepoPaths.size > 0 ? { contentKeptRepoPaths: [...keptContentRepoPaths.keys()] } : {}),
      // @decision 8db913e2 (Follow-up 0a783fb2, Code Review 47289f8d, MINOR) — an EXPLICIT flag, never
      // left for a caller to re-derive from an empty `referencingRepoPaths` (that misfires the instant
      // `latchKept` is true SOLELY because `contentKeptRepoPaths` fired).
      ...(anyKeptUnattributed ? { unattributed: true as const } : {}),
      // @decision 182c01cc (round 3, M1) — a repoPath BOTH kept and relocated is named ONCE, with BOTH
      // routes (never deduped down to one — see BlockedCoOccupant's own doc + the decision record).
      stillBlockedCoOccupants: [
        ...[...relocatedCoOccupants.entries()].map(([rp, sf]) => {
          const keptSf = keptReferencingRepoPaths.get(rp);
          return keptSf !== undefined ? blockedCoOccupantBothRoutes(rp, sf, keptSf) : blockedCoOccupant(rp, sf);
        }),
        ...[...keptReferencingRepoPaths.entries()].filter(([rp]) => !relocatedCoOccupants.has(rp)).map(([rp, sf]) => blockedCoOccupant(rp, sf)),
        ...[...orphanReferencingRepoPaths.entries()].map(([rp, sf]) => blockedCoOccupantForReferencer(rp, sf)),
      ],
    };
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

/**
 * Whether ANY in-memory record for `repoPath`'s own identity — active tier OR pending tier, every object
 * sharing the identity, never just the first match — carries `provenanceUnknown`. A fresh read of a
 * physical latch file (e.g. {@link protectOccupantContentBeforeDelete}'s own read of `final`) can be
 * durably STALE relative to this: {@link detectUnknownProvenance} is a pure in-memory boot-time inference
 * that becomes durable on disk only when SOME OTHER write happens to persist it that same boot — a
 * degraded occupant whose file is left "AS WRITTEN", or one already correctly filed at its own
 * ancestor-walked key with nothing to migrate, can carry `provenanceUnknown:true` in memory while the
 * physical bytes never reflect it (card `4913e721`).
 *
 * Deliberately NOT {@link ownIdentityEntryFor} — that returns the single FIRST match, right for "the one
 * entry a query should treat as its own blocker," but wrong for a STICKY OR: `d4b25feb`'s own "two
 * objects per identity" case (one active-only, one pending-only, disjoint tokens) means the mark can sit
 * on the object this function would NOT have returned.
 *
 * @decision 4913e721
 */
function inMemoryProvenanceUnknownFor(repoPath: string): boolean {
  const identity = directPathIdentity(repoPath);
  for (const entry of activeQuarantines.values()) {
    if (directPathIdentity(entry.repoPath) === identity && entry.provenanceUnknown) return true;
  }
  return pendingUnresolvedQuarantines.some((p) => directPathIdentity(p.entry.repoPath) === identity && p.entry.provenanceUnknown);
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
 * UNCONDITIONAL clear for `repoPath`. Called from exactly one place in this module: {@link
 * clearMergeQuarantineReporting} — itself the thin wrapper the human-only loopback REST route
 * (`POST /internal/merge-quarantine/clear`, gateway/server.ts) delegates to. A RESTORED quarantine
 * (re-entered at boot) can ONLY ever be cleared this way, since the original in-process promise chain(s)
 * that could auto-clear it are gone once the process(es) that held them have exited.
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
export function clearMergeQuarantine(repoPath: string): { wasQuarantined: boolean; reason?: string; latchKept?: true; referencingRepoPaths?: string[]; contentKeptRepoPaths?: string[]; stillBlockedCoOccupants: BlockedCoOccupant[] } | void {
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
export function clearMergeQuarantineByRecordedPath(repoPath: string): { wasQuarantined: boolean; reason?: string; latchKept?: true; referencingRepoPaths?: string[]; contentKeptRepoPaths?: string[]; stillBlockedCoOccupants: BlockedCoOccupant[] } {
  const identity = directPathIdentity(repoPath);
  const matched: Array<{ key: string; repoPath: string }> = [];
  const seen = new Set<MergeQuarantineEntry>();
  // @decision 8db913e2 (Follow-up 4b06875f, Round 3, CR be296830 finding 1) — every key this phase's own
  // matched-active clears will unconditionally lift, collected HERE (before any clear runs) so the
  // matchedPending loop below can union it into its own liftedKeysOverride — see the decision record.
  //
  // @decision 8db913e2 (Follow-up 3152ec90) — gated through `entryStillOwnsKey` (never `key` itself) —
  // same reason as `clearMergeQuarantineByKey`'s own `keysToLift`.
  const activeLiftedKeys = new Set<string>();
  for (const [key, entry] of activeQuarantines) {
    if (directPathIdentity(entry.repoPath) !== identity) continue;
    if (seen.has(entry)) continue; // same logical entry armed under >1 key (armedKeys) — clear it once
    seen.add(entry);
    matched.push({ key, repoPath: entry.repoPath });
    activeLiftedKeys.add(key);
    for (const k of entry.armedKeys ?? []) { if (entryStillOwnsKey(k, entry)) activeLiftedKeys.add(k); }
  }
  // @decision 8db913e2 (Follow-up c93e9e7a) — the full lifted-key union `L`, computed ONCE before any
  // delegated clear — this function's own pending sweep is unconditional, so every identity-matched
  // pending entry's owned keys belong in it from the start. See the decision record's own section.
  const pendingOwnedArmedKeys = new Map<PendingUnresolvedQuarantine, string[]>();
  const L = new Set<string>(activeLiftedKeys);
  for (const p of pendingUnresolvedQuarantines) {
    if (directPathIdentity(p.entry.repoPath) !== identity) continue;
    const ownedArmedKeys = (p.entry.armedKeys ?? []).filter((k) => entryStillOwnsKey(k, p.entry));
    pendingOwnedArmedKeys.set(p, ownedArmedKeys);
    for (const k of ownedArmedKeys) L.add(k);
  }
  // @decision 182c01cc — a Map (repoPath -> BlockedCoOccupant), never a bare Set<string>: every fold-in
  // site below already has (or can cheaply derive) the sourceFile a kept claimant is filed under, so this
  // function's own "latchKept" result can name each one's clear-by-path route, not just its repoPath.
  const keptReferencingRepoPaths = new Map<string, BlockedCoOccupant>();
  // @decision 182c01cc (round 2, finding 2) — a SEPARATE bucket for a co-occupant relocated to a new
  // latch (never folded into keptReferencingRepoPaths — that one must stay latchKept-eligible only).
  const relocatedCoOccupants = new Map<string, BlockedCoOccupant>();
  // @decision 8db913e2 (Follow-up 0a783fb2) — a content-parsed repoPath has no live entry behind it, so
  // it is tracked SEPARATELY, never folded into `keptReferencingRepoPaths`/`stillBlockedCoOccupants`.
  const keptContentRepoPaths = new Set<string>();
  // @decision 8db913e2 (Follow-up 95ea8d3f, Round 2, nitpick) — see the matching note at the matchedPending loop's own
  // sweepOwnLatchFileUnlessOwnedElsewhere call below: an unconfirmed EPERM/EBUSY unlink (or a
  // marked-but-unprovable-coverage keep) still means something was kept, with no repoPath to name.
  let anyKeptUnattributed = false;
  let wasQuarantined = false;
  if (matched.length > 0) {
    wasQuarantined = true;
    for (const m of matched) {
      const result = clearMergeQuarantineByKey(m.key, m.repoPath, L);
      // @decision 182c01cc (round 2) — split EVERY result's own stillBlockedCoOccupants by whether it's
      // also named in referencingRepoPaths (kept) or not (relocated) — never assume "has latchKept" means
      // "every entry here is kept"; a single delegated call can carry BOTH kinds at once.
      const { kept, relocated } = splitCoOccupants(result?.stillBlockedCoOccupants, result?.referencingRepoPaths);
      for (const co of kept) keptReferencingRepoPaths.set(co.repoPath, co);
      for (const co of relocated) relocatedCoOccupants.set(co.repoPath, co);
      // @decision 8db913e2 (Follow-up 0a783fb2, Code Review 47289f8d) — use ByKey's own EXPLICIT
      // `unattributed` flag, never infer it from an empty `referencingRepoPaths`: `latchKept` can ALSO be
      // true purely because `contentKeptRepoPaths` fired, which is NOT the unattributed case.
      if (result?.unattributed) anyKeptUnattributed = true;
      for (const rp of result?.contentKeptRepoPaths ?? []) keptContentRepoPaths.add(rp);
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
    // @decision 8db913e2 (round 4) — candidates + touched basenames for the ONE tombstone call below,
    // made after every mutation in this block is already applied — see `tombstoneIfNotSurviving`'s doc.
    const pendingCandidateTokens: string[] = [];
    const pendingTouchedBasenames: string[] = [];
    // @decision 882d6cff (round 4) — capture whether this claimant's own sourceFile survived because a
    // DIFFERENT, still-pending claimant shares it (never surfaced before this round) — see the decision
    // record for why this is expected, not a bug, and how to lift it durably.
    for (const p of matchedPending) {
      pendingCandidateTokens.push(...p.entry.tokens);
      for (const f of p.entry.orphanLatchFiles ?? []) orphanFilesToSweep.add(f);
      // @decision 8db913e2 (Follow-up c93e9e7a) — reuse `pendingOwnedArmedKeys`'s own pre-delegation
      // snapshot value, never a live recompute (a sibling delegated clear, or an earlier entry in THIS
      // loop, may have already mutated `activeQuarantines`). `L` is the complete, precomputed union.
      for (const k of pendingOwnedArmedKeys.get(p) ?? []) {
        activeQuarantines.delete(k);
        pendingTouchedBasenames.push(path.basename(quarantinePathForKey(k)));
        // @decision d163aef5 (round 4) — same ownership + token-overlap protection as clearMergeQuarantineByKey.
        const r = deleteMergeQuarantineLatchByKey(k, undefined, p.entry, identity, L);
        for (const kc of r.kept) keptReferencingRepoPaths.set(kc.repoPath, blockedCoOccupant(kc.repoPath, kc.sourceFile));
        for (const rc of r.relocated) relocatedCoOccupants.set(rc.repoPath, blockedCoOccupant(rc.repoPath, rc.sourceFile));
        // @decision 702b4241 (round 2) — same fold as clearMergeQuarantineByKey's own two loops.
        if (r.unattributed) anyKeptUnattributed = true;
      }
      pendingTouchedBasenames.push(p.sourceFile);
      // @decision 883e29bc (round 4) — never a bare unlink: `p` is already removed from
      // pendingUnresolvedQuarantines above, so this correctly checks whether a SURVIVING entry (e.g. a
      // fresh raise reusing the freed key) now physically owns this exact filename.
      //
      // @decision 8db913e2 (Follow-up 95ea8d3f) — `p.entry.tokens` as `candidateTokens`, so a stale keptUnreadableLatchFiles
      // mark set by an unrelated identity's own earlier read failure can't outlive it forever here either.
      const sweepResult = sweepOwnLatchFileUnlessOwnedElsewhere(p.sourceFile, p.entry.tokens);
      if (sweepResult.kept) {
        if (sweepResult.referencingRepoPaths.length > 0) for (const rp of sweepResult.referencingRepoPaths) keptReferencingRepoPaths.set(rp, blockedCoOccupant(rp, p.sourceFile));
        else anyKeptUnattributed = true;
      }
    }
    // @decision 8db913e2 (Follow-up f2cc5f18) — `pendingCandidateTokens` already holds every matched
    // pending entry's own tokens, captured as each is processed above, before `tombstoneIfNotSurviving`.
    //
    // @decision 8db913e2 (Follow-up 0a783fb2) — this sweep's own result used to be discarded entirely —
    // fold it through the shared helper, same as every other orphan-sweep call site.
    //
    // @decision 8db913e2 (Follow-up 0a783fb2, Code Review 47289f8d) — exclude this clear's OWN identity
    // (the MAJOR self-reference fix) — see sweepOrphanLatchFileIfUnreferenced's own doc for why.
    const excludeOwnIdentity = new Set([identity]);
    const orphanContentKept = new Map<string, string>();
    for (const orphanFile of orphanFilesToSweep) {
      const folded = foldOrphanSweepResult(sweepOrphanLatchFileIfUnreferenced(orphanFile, pendingCandidateTokens, excludeOwnIdentity), orphanFile, orphanContentKept);
      for (const rp of folded.referencingRepoPaths) keptReferencingRepoPaths.set(rp, blockedCoOccupantForReferencer(rp, orphanFile));
      if (folded.unattributed) anyKeptUnattributed = true;
    }
    for (const rp of orphanContentKept.keys()) keptContentRepoPaths.add(rp);
    tombstoneIfNotSurviving(pendingCandidateTokens, pendingTouchedBasenames);
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
      stillBlockedCoOccupants: [],
    };
  }
  const relocated = [...relocatedCoOccupants.values()];
  if (keptReferencingRepoPaths.size > 0) {
    const refs = [...keptReferencingRepoPaths.keys()];
    // @decision 8db913e2 (Follow-up 95ea8d3f, Round 3) — generalized from "sharing this exact degraded key" (true only for
    // the 882d6cff shared-corrupt-latch shape): a self-referencing protected-copy/safety-tmp keep
    // (4900c365/ef651188) is a DIFFERENT mechanism, and the old wording misdescribed its own keep cause.
    //
    // @decision 182c01cc — dropped "this (and every other) claimant": THIS identity is already fully
    // lifted and will NOT itself re-divert — only `refs` can. `refs` may still be OVER-reported (a known,
    // separately-tracked stale-sourceFile gap, cd5a3cf9/c93e9e7a) — over-warning stays the safe direction.
    const keptReason = keptOnlyReasonFor(refs);
    // @decision 182c01cc (round 3, M1) — a repoPath BOTH kept and relocated is named ONCE, with BOTH
    // routes, same fix as clearMergeQuarantineByKey's own dedupe — see the decision record.
    const relocatedSet = new Set(relocated.map((co) => co.repoPath));
    const combinedRelocated = relocated.map((co) => {
      const keptCo = keptReferencingRepoPaths.get(co.repoPath);
      return keptCo !== undefined && !co.alsoClear ? mergeKeptAndRelocatedCoOccupant(co, keptCo) : co;
    });
    return {
      wasQuarantined: true, latchKept: true, referencingRepoPaths: refs,
      // @decision 8db913e2 (Follow-up 0a783fb2) — a content-parsed keep names no live entry, so it never
      // joins `stillBlockedCoOccupants` above — only this field, alongside whatever TRUE referencer fired
      // this branch.
      ...(keptContentRepoPaths.size > 0 ? { contentKeptRepoPaths: [...keptContentRepoPaths] } : {}),
      stillBlockedCoOccupants: [...combinedRelocated, ...[...keptReferencingRepoPaths.values()].filter((co) => !relocatedSet.has(co.repoPath))],
      reason: composeReasonWithRelocated(keptReason, combinedRelocated),
    };
  }
  // @decision 8db913e2 (Follow-up 95ea8d3f, Round 2, nitpick) — kept for an UNATTRIBUTED reason (an unconfirmed EPERM/EBUSY
  // unlink, or a marked-but-unprovable-coverage keep) still reports latchKept:true, never plain success.
  if (anyKeptUnattributed) {
    return {
      wasQuarantined: true, latchKept: true, referencingRepoPaths: [],
      ...(keptContentRepoPaths.size > 0 ? { contentKeptRepoPaths: [...keptContentRepoPaths] } : {}),
      stillBlockedCoOccupants: relocated,
      reason: composeReasonWithRelocated(unattributedKeptReasonFor(), relocated),
    };
  }
  // @decision 182c01cc (round 2, finding 1) — a PURE relocation (nothing kept at all) must still report
  // it, never fall through to a plain, uninformative success.
  if (relocated.length > 0) {
    return {
      wasQuarantined: true, stillBlockedCoOccupants: relocated,
      // @decision 8db913e2 (Follow-up 0a783fb2, Code Review 47289f8d) — a content-only keep can ALSO
      // coexist with a pure relocation; compose its own clause on, never silently drop it.
      reason: keptContentRepoPaths.size > 0
        ? `${relocatedCoOccupantsReason(relocated)} ${contentKeptOnlyReasonFor([...keptContentRepoPaths])}`
        : relocatedCoOccupantsReason(relocated),
      ...(keptContentRepoPaths.size > 0 ? { latchKept: true as const, contentKeptRepoPaths: [...keptContentRepoPaths] } : {}),
    };
  }
  // @decision 8db913e2 (Follow-up 0a783fb2) — nothing referencing, unattributed, or relocated — but a
  // content-parsed keep can still be the ONLY thing this clear found; report it, with a real reason, rather
  // than a plain, uninformative success (Code Review 47289f8d: this branch gave no reason at all).
  if (keptContentRepoPaths.size > 0) {
    return {
      wasQuarantined: true, latchKept: true, contentKeptRepoPaths: [...keptContentRepoPaths], stillBlockedCoOccupants: [],
      reason: contentKeptOnlyReasonFor([...keptContentRepoPaths]),
    };
  }
  return { wasQuarantined: true, stillBlockedCoOccupants: [] };
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
/**
 * The shared tier chain `activeMergeQuarantineFor` uses to find a pending entry genuinely matching
 * `repoPath` (never a positional/first-hit guess — card `188b145f`): direct identity, ancestor-alias,
 * resolvable-and-freshly-keyed, then a still-unresolvable entry gated on its OWN trusted `resolvedKey`
 * (card `883e29bc`). Factored out so the `direct`-exists-but-unverified branch (card `d163aef5`) can
 * reuse the EXACT same matcher the no-`direct` branch already uses, rather than inventing a second one.
 */
function findPendingIndicesFor(repoPath: string, key: string): number[] {
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
    // @decision 8db913e2 (Follow-up 43cf3b26, CR 46c5c492) — gate on informativeKeysFor (scalar ∪
    // resolvedKeys), never the scalar alone, or a plural-only pending entry never matches here.
    indices = collectPendingIndices((p) => !isRepoPathCurrentlyResolvable(p.entry.repoPath) && informativeKeysFor(p.entry).length > 0 && canonicalRepoLockKey(p.entry.repoPath) === key);
  }
  return indices;
}

export function activeMergeQuarantineFor(repoPath: string): MergeQuarantineEntry | undefined {
  const key = canonicalRepoLockKey(repoPath);
  const direct = activeQuarantines.get(key);
  if (pendingUnresolvedQuarantines.length === 0) return direct;
  if (direct) {
    // @decision 8a1bc2ef (round 2, Code Review) — only absorb into `direct` when IT is genuinely
    // key-verified, never when it merely occupies `key` via PASS 1's degraded dual-arm fallback — see the
    // decision record for the nested-repo repro this guard closes.
    if (!isKeyVerifiedFor(direct.repoPath, key)) {
      // `direct` occupying `key` only via a SECOND/stale arm is not proof it's the right answer for THIS
      // repoPath — but ONLY when `repoPath` ITSELF is not currently resolvable: a resolvable `repoPath`
      // whose own fresh key genuinely IS `key` (e.g. a subdir of a real enclosing repo that `direct`
      // coincidentally also shares the key with) is EXACTLY the shape `direct-verified-guard`'s own test
      // requires `direct` to keep answering for, unsubstituted — that query's own resolvability, by
      // itself, says nothing about whether `direct`'s presence is legitimate. Restricting to an
      // UNRESOLVABLE `repoPath` is what makes this safe: only then can a genuinely-matching PENDING
      // entry (the SAME tier chain findPendingIndicesFor's own doc describes) answer more precisely.
      //
      // @decision d163aef5 — changes WHICH entry is returned, never WHETHER one is; no match (or a
      // resolvable `repoPath`) still returns `direct` exactly as before, and the verified-`direct`
      // branch below stays untouched.
      //
      // @decision 8db913e2 (Follow-up 43cf3b26, CR 46c5c492, CRITICAL) — skip the pending search entirely
      // when `direct` is ALREADY the query's own identity — tier 4 matches purely by KEY, so an unrelated
      // sibling sharing this key could otherwise shadow an already-correct `direct` with its own content.
      if (!isRepoPathCurrentlyResolvable(repoPath) && directPathIdentity(direct.repoPath) !== directPathIdentity(repoPath)) {
        const matchIndices = findPendingIndicesFor(repoPath, key);
        if (matchIndices.length > 0) {
          return (pendingUnresolvedQuarantines[matchIndices[0]!] as PendingUnresolvedQuarantine).entry;
        }
      }
      return direct;
    }
    // @decision 8a1bc2ef — a sibling pending entry (card 7673d096) can share this exact key without ever
    // matching the identity that originally armed `direct` — absorb it now, or this fast path never
    // looks at `pendingUnresolvedQuarantines` again for this key. See the decision record for the repro.
    const siblingIndices = collectCrossTierSiblingIndices(key, []);
    if (siblingIndices.length === 0) return direct;
    // @decision 8db913e2 (round 3) — this call's own `writeSucceeded` used to be discarded silently; log
    // the same way activeMergeQuarantineFor's OTHER consume call site (below) already does on a failure.
    const { armed, matched: consumed, writeSucceeded } = consumeMatchedPendingsIntoArmedEntry(siblingIndices, key, direct);
    if (!writeSucceeded) {
      // eslint-disable-next-line no-console
      console.error(`[merge-quarantine] absorbed ${consumed.length} sibling pending quarantine entr${consumed.length === 1 ? "y" : "ies"} into ${armed.repoPath}'s own already-armed key but could NOT durably persist the result — still enforced in THIS process, but the ORIGINAL sibling source file(s) (${consumed.map((p) => p.sourceFile).join(", ")}) are now tracked as owned by this entry's own orphanLatchFiles rather than deleted; a later boot can still recover it.`);
    }
    return armed;
  }
  const indices = findPendingIndicesFor(repoPath, key);
  if (indices.length === 0) return undefined;
  const matched = indices.map((i) => pendingUnresolvedQuarantines[i] as PendingUnresolvedQuarantine); // indices are verified hits above
  const first = matched[0] as PendingUnresolvedQuarantine;
  if (!isRepoPathCurrentlyResolvable(first.entry.repoPath)) {
    // STILL can't be verified — report it active for THIS query, but leave EVERY matched entry in
    // `pendingUnresolvedQuarantines` rather than pinning any of them to a key that may not hold once the
    // path genuinely resolves. Pinning here would reopen the exact bug this pending mechanism exists to
    // close: a LATER remount recomputes a DIFFERENT (real) key, and an already-graduated entry sitting
    // under the degraded key would miss it exactly like the original one-boot fail-open did, just later.
    // Tiers 1/2/4 (direct identity, ancestor-alias, resolvedKey) only ever match entries sharing
    // `first`'s identity, so its resolvability speaks for all of them. Tier 3 (cross-tier sibling) never
    // reaches this branch at all — its own predicate requires every match to already be resolvable.
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
 * "Active" here includes an 883e29bc boot-diverted TWIN (the same object ALSO present in
 * `pendingUnresolvedQuarantines` by reference) — see the `64283e06` decision below for why excluding it
 * was itself a bug, not an extra safeguard.
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
 *
 * @decision 64283e06 — a twin (active AND pending, by reference) must still count as the "active" side
 * of the 2-object rule — requiring it be pending-FREE wrongly rejected the real post-reboot shape.
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
      // @decision 64283e06 — a twin (active AND pending, by reference — 883e29bc's own boot-diverted
      // shape) still counts as the "active" side here; only the OTHER object must be pending-ONLY.
      const oneActiveOnePending = (aActive && bPending && !bActive) || (bActive && aPending && !aActive);
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
  //
  // @decision 8db913e2 (Follow-up 8a79dd31) — a collision-suffixed fresh mint (clean, OR its own
  // crash-left tmp residue) is the SAME shape: its own basename is not a valid 24-hex id either.
  if (
    PENDING_DIVERT_RE.test(sourceFile) || PENDING_DIVERT_TMP_RE.test(sourceFile)
    || PENDING_DIVERT_COLLISION_RE.test(sourceFile) || PENDING_DIVERT_COLLISION_TMP_RE.test(sourceFile)
  ) {
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
  // @decision 8db913e2 (Follow-up 3152ec90) — gate every member through `entryStillOwnsKey` first — a
  // stale `armedKeys` member would otherwise hand out a FOREIGN entry's own latch id as if it belonged
  // to `entry`.
  const ownedArmedKeys = entry.armedKeys?.filter((k) => entryStillOwnsKey(k, entry)) ?? [];
  if (ownedArmedKeys.length) {
    const ids = [...new Set(ownedArmedKeys.map(quarantineHashForKey))];
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

/**
 * The reason text for a clear that ran but left `after`'s own identity still quarantined — names WHICH
 * blocker remains (the SAME one `before` already was, or a DIFFERENT repo's own separate quarantine) and
 * the clear-by-path/clear-by-id remedy. Shared by {@link clearMergeQuarantineReporting} and {@link
 * clearMergeQuarantineLatchFile} so the two can never disagree about how this is worded.
 *
 * @decision 64283e06 — factored out of `clearMergeQuarantineReporting` so `clearMergeQuarantineLatchFile`
 * can report the SAME truthful "still quarantined" shape instead of claiming unqualified success while an
 * independent record (card d4b25feb's own "two independent raise-groups") still blocks.
 */
function stillQuarantinedReason(after: MergeQuarantineEntry, before: MergeQuarantineEntry | undefined): string {
  const latchId = quarantineLatchFileIdsFor(after)[0];
  // @decision 883e29bc — word by WHICH blocker remains: the SAME one `before` already was (never
  // touched), or a DIFFERENT repo's own separate quarantine (not residue of this clear).
  const sameAsBefore = !!before && directPathIdentity(before.repoPath) === directPathIdentity(after.repoPath);
  const reason = sameAsBefore
    ? `repoPath is still quarantined by its own recorded entry (repoPath '${after.repoPath}', latch id '${latchId}') — this clear did not lift it`
    : `repoPath is quarantined by ANOTHER repo's own, separate quarantine (repoPath '${after.repoPath}', latch id '${latchId}') that this clear never addressed`;
  // @decision 9a55fb90 — route the bare-id suggestion through the SAME collision check as
  // assertRepoNotQuarantined, never offer it unconditionally — a collision at this key makes it
  // ambiguous here too.
  const ambiguousIdentities = ambiguousIdentitiesForLatchId(after, latchId);
  const clearByIdSuggestion = totalAmbiguousCount(ambiguousIdentities) > 0 ? "" : ` or ${JSON.stringify({ id: latchId })}`;
  return `${reason} — use POST /internal/merge-quarantine/clear-by-path with ${JSON.stringify({ repoPath: after.repoPath })}${clearByIdSuggestion} to clear it directly.`;
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
export function clearMergeQuarantineReporting(repoPath: string): { wasQuarantined: boolean; reason?: string; latchKept?: true; referencingRepoPaths?: string[]; contentKeptRepoPaths?: string[]; stillBlockedCoOccupants: BlockedCoOccupant[] } {
  const before = resolveQuarantineFor(repoPath);
  const wasQuarantined = !!before;
  const clearResult = clearMergeQuarantine(repoPath);
  const after = resolveQuarantineFor(repoPath);
  // @decision 182c01cc (round 2, item 3) — field consistency: every branch below carries
  // stillBlockedCoOccupants (empty when none), never omits it just because this branch has nothing NEW
  // to say about it.
  const stillBlocked = clearResult?.stillBlockedCoOccupants ?? [];
  if (after) {
    // @decision 182c01cc (round 3, m4) — compose the relocated clause here too, consistent with
    // clearMergeQuarantineLatchFile's own still-quarantined branch — this used to drop it silently.
    return {
      wasQuarantined: true,
      reason: composeReasonWithRelocated(stillQuarantinedReason(after, before), splitCoOccupants(stillBlocked, clearResult?.referencingRepoPaths).relocated),
      stillBlockedCoOccupants: stillBlocked,
    };
  }
  if (clearResult && "latchKept" in clearResult && clearResult.latchKept) {
    return {
      wasQuarantined, latchKept: true, referencingRepoPaths: clearResult.referencingRepoPaths,
      // @decision 8db913e2 (Follow-up 0a783fb2) — forward the content-parsed keep too; it can be the
      // ONLY reason `latchKept` fired here (no true referencer at all).
      ...("contentKeptRepoPaths" in clearResult && clearResult.contentKeptRepoPaths ? { contentKeptRepoPaths: clearResult.contentKeptRepoPaths } : {}),
      stillBlockedCoOccupants: stillBlocked,
      // @decision 182c01cc (round 2) — `clearResult.reason` is undefined for the resolvable/key-addressed
      // path (clearMergeQuarantineByKey has no reason field of its own) — compose ONLY the relocated
      // clause in that case, never drop it just because there was no base reason to append it to.
      //
      // @decision 182c01cc (round 3, m3) — compose fresh ONLY when `clearResult.reason` is absent; when
      // it's already set (the ByRecordedPath/unresolvable dispatch), it ALREADY carries this exact
      // clause — composing again duplicated the text. Idempotent: compose at most once, ever.
      //
      // @decision 182c01cc (round 5, nit) — the base is a REAL reason, never `undefined`: a pure kept-only
      // ByKey result (no relocated co-occupant to compose a clause from either) used to return NO reason
      // text at all, unlike clearMergeQuarantineByRecordedPath's own equivalent branch.
      //
      // @decision 8db913e2 (Follow-up 0a783fb2, Code Review 47289f8d) — `keptOnlyReasonFor` assumes a TRUE
      // referencer and reads as a garbled "0 other claimant(s) … ()" when there is none — pick the base
      // reason by WHICH kind of keep actually fired, never `keptOnlyReasonFor` unconditionally.
      reason: clearResult.reason !== undefined
        ? clearResult.reason
        : composeReasonWithRelocated(
            (clearResult.referencingRepoPaths?.length ?? 0) > 0
              ? keptOnlyReasonFor(clearResult.referencingRepoPaths ?? [])
              : (clearResult.contentKeptRepoPaths?.length ?? 0) > 0
                ? contentKeptOnlyReasonFor(clearResult.contentKeptRepoPaths ?? [])
                : unattributedKeptReasonFor(),
            splitCoOccupants(stillBlocked, clearResult.referencingRepoPaths).relocated,
          ),
    };
  }
  if (stillBlocked.length > 0) {
    return { wasQuarantined, stillBlockedCoOccupants: stillBlocked, reason: relocatedCoOccupantsReason(stillBlocked) };
  }
  return { wasQuarantined, stillBlockedCoOccupants: [] };
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
 *
 * @decision 64283e06 — re-resolves the cleared entry's own identity after the clear; `liftedRepoPaths`
 * names only an identity actually freed, never one still blocked by its own independent (d4b25feb) record
 * — `stillQuarantined`/`reason` name that case instead of a silently-false success.
 */
export function clearMergeQuarantineLatchFile(id: string): { ok: true; wasQuarantined: boolean; liftedRepoPaths: string[]; stillQuarantined?: true; reason?: string; latchKept?: true; referencingRepoPaths?: string[]; contentKeptRepoPaths?: string[]; stillBlockedCoOccupants: BlockedCoOccupant[] } | { ok: false; reason: string } {
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
    // @decision 9a55fb90 — a bare id cannot tell "clear the entry armed here" apart from "clear by the
    // id a DIFFERENT, currently-resolvable canonical owner's own refusal happened to name" — both
    // produce this SAME id and the SAME refusal text. FAIL CLOSED: refuse rather than guess.
    // @decision 82032b5c — widened to ALSO cover a RUNTIME union (contributorRepoPaths): canonicalSiblingsFor
    // alone never sees a sibling absorbed directly into this ACTIVE entry via enterMergeQuarantine's own
    // `existing` branch, which is exactly the 9a55fb90 "known residual" this card closes.
    const ambiguousIdentities = ambiguousIdentitiesFor(activeMatch.key, activeMatch.entry);
    const ambiguousCount = totalAmbiguousCount(ambiguousIdentities);
    if (ambiguousCount > 0) {
      const namedIdentities = [...ambiguousIdentities.siblingRepoPaths, ...ambiguousIdentities.contributorRepoPaths];
      // @decision db0a9db0 — count only what this clause NAMES (`namedIdentities.length`, never
      // `ambiguousCount`, which now also counts `unknownProvenance`); see the decision record.
      const namedClause = namedIdentities.length > 0
        ? `${namedIdentities.length} other identit${namedIdentities.length === 1 ? "y" : "ies"} (${namedIdentities.map((p) => `'${p}'`).join(", ")}) ` +
          `also canonically collide with this exact key right now, or had their own raise folded into this union's token set at runtime`
        : "";
      const unknownClause = ambiguousIdentities.unknownProvenance
        ? "this union's own provenance is incomplete — it may fold together more than one repo's raise from before provenance tracking existed, and this daemon cannot rule that out"
        : "";
      const collisionClause = [namedClause, unknownClause].filter(Boolean).join("; and ");
      return {
        ok: false,
        reason: `latch id '${id}' is ambiguous: it is currently armed by '${activeMatch.entry.repoPath}', but ${collisionClause} — a bare id cannot tell which identity you mean to clear, and a refusal naming this id reads IDENTICALLY ` +
          `whichever one you're actually trying to resolve. Nothing was cleared. ${remediationTextFor([activeMatch.entry.repoPath], ambiguousIdentities)}.`,
      };
    }
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
    const activeClearResult = clearMergeQuarantineByKey(activeMatch.key, activeMatch.entry.repoPath);
    // @decision 64283e06 (CR 3439677b, item 3) — surface clearMergeQuarantineByKey's OWN latchKept/
    // referencingRepoPaths too, the same way the pending branch below already does, instead of discarding
    // the return value.
    // @decision 182c01cc (round 2, M12) — the OLD fields gated stillBlockedCoOccupants on `latchKept`,
    // silently dropping a pure relocation — split first, carry it unconditionally.
    const activeStillBlocked = activeClearResult?.stillBlockedCoOccupants ?? [];
    const { relocated: activeRelocated } = splitCoOccupants(activeStillBlocked, activeClearResult?.referencingRepoPaths);
    // @decision 8db913e2 (Follow-up 0a783fb2) — forward the content-parsed keep too; it can be the ONLY
    // reason `latchKept` fired here.
    const activeLatchKeptFields = activeClearResult && "latchKept" in activeClearResult && activeClearResult.latchKept
      ? {
          latchKept: true as const, referencingRepoPaths: activeClearResult.referencingRepoPaths,
          ...(activeClearResult.contentKeptRepoPaths ? { contentKeptRepoPaths: activeClearResult.contentKeptRepoPaths } : {}),
        }
      : {};
    const after = resolveQuarantineFor(activeMatch.entry.repoPath);
    const sameIdentityStillQuarantined = !!after && directPathIdentity(after.repoPath) === directPathIdentity(activeMatch.entry.repoPath);
    if (sameIdentityStillQuarantined) {
      return {
        ok: true, wasQuarantined: true, liftedRepoPaths: [], stillQuarantined: true,
        reason: composeReasonWithRelocated(stillQuarantinedReason(after, activeMatch.entry), activeRelocated),
        stillBlockedCoOccupants: activeStillBlocked, ...activeLatchKeptFields,
      };
    }
    return {
      ok: true, wasQuarantined: true, liftedRepoPaths: [activeMatch.entry.repoPath],
      stillBlockedCoOccupants: activeStillBlocked,
      ...(activeRelocated.length > 0 ? { reason: relocatedCoOccupantsReason(activeRelocated) } : {}),
      ...activeLatchKeptFields,
    };
  }
  if (matchedPending.length > 0) {
    // @decision 82032b5c (round 2 CR, Minor 5) — a PENDING entry can ALSO carry `contributorRepoPaths`
    // (e.g. carried forward by `protectDegradedOccupantBeforeDelete`) — fail closed here too, on the SAME
    // basis the active-match branch above already does (9a55fb90: text and action must never disagree).
    const pendingContributors = [...new Set(matchedPending.flatMap((p) => p.entry.contributorRepoPaths ?? []))];
    // @decision db0a9db0 — a pending entry can carry `provenanceUnknown` too (the 883e29bc twin shares
    // the SAME object, by reference, as whatever PASS 1/1b/safety-tmp recovery marks) — same fail-closed
    // basis as `pendingContributors` above.
    const pendingUnknownProvenance = matchedPending.some((p) => p.entry.provenanceUnknown);
    if (pendingContributors.length > 0 || pendingUnknownProvenance) {
      const matchedRepoPaths = [...new Set(matchedPending.map((p) => p.entry.repoPath))];
      // @decision db0a9db0 (Follow-up 150aed7b) — union EVERY flagged pending entry's own keys, never
      // just the first match's scalar; routinely `[]` for a protect-copy whitelist (strips both fields).
      const unknownKeyPaths = pendingUnknownProvenance
        ? [...new Set(matchedPending.filter((p) => p.entry.provenanceUnknown).flatMap((p) => unknownProvenanceKeyPathsFor(p.entry)))]
        : [];
      // @decision db0a9db0 — each clause is a full standalone "whose own ..." clause so joining them never
      // produces the broken "token set carries this entry's own provenance is incomplete" sentence a bare
      // noun-phrase splice did in round 1.
      const namedClause = pendingContributors.length > 0
        ? `whose own token set carries ${pendingContributors.length} other identit${pendingContributors.length === 1 ? "y" : "ies"} (${pendingContributors.map((p) => `'${p}'`).join(", ")}) folded in at runtime`
        : "";
      const unknownClause = pendingUnknownProvenance
        ? "whose own provenance is incomplete — it may fold together more than one repo's raise from before provenance tracking existed"
        : "";
      const collisionClause = [namedClause, unknownClause].filter(Boolean).join(", and ");
      return {
        ok: false,
        reason: `latch id '${id}' matches a PENDING entry ${collisionClause} — a bare id cannot tell which identity you mean to clear. Nothing was cleared. ` +
          `${remediationTextFor(matchedRepoPaths, { siblingRepoPaths: [], contributorRepoPaths: pendingContributors, unknownProvenance: pendingUnknownProvenance, unknownProvenanceKeyPaths: unknownKeyPaths })}.`,
      };
    }
    // A pending entry isn't armed into activeQuarantines under any key — drop ONLY these exact pending
    // entries and their own sourceFiles directly, never a recomputed-key delegation (which could drift
    // onto an unrelated repo's entry the same way the active-entry path used to — round 3).
    pendingUnresolvedQuarantines = pendingUnresolvedQuarantines.filter((p) => !matchedPending.includes(p));
    const orphanFilesToSweep = new Set<string>();
    const keptRepoPaths = new Set<string>();
    // @decision 182c01cc (round 4, CR3 finding 4) — a proper `{repoPath, sourceFile}` per kept occupant,
    // never just its repoPath, so `stillBlockedCoOccupants` can name a real `{id}` route — see the
    // decision record's "Round 4" section for why this branch used to hard-code `[]`.
    const keptCoOccupants = new Map<string, BlockedCoOccupant>();
    // @decision 8db913e2 (Follow-up 0a783fb2) — a content-parsed keep (no live entry) never joins
    // `keptCoOccupants`/`stillBlockedCoOccupants`; `anyKeptUnattributed` closes the gap this branch had —
    // none of ownSweep/finalSweep/tmpSweep tracked a kept-but-unattributed result before this card.
    const keptContentRepoPaths = new Set<string>();
    let anyKeptUnattributed = false;
    // @decision 8db913e2 (round 4) — candidates + touched basenames for the ONE tombstone call below,
    // made after every mutation in this block is already applied — see `tombstoneIfNotSurviving`'s doc.
    const pendingCandidateTokens: string[] = [];
    const pendingTouchedBasenames: string[] = [];
    // @decision 8db913e2 (Follow-up 0a783fb2, Code Review 47289f8d) — every identity THIS call is already
    // clearing (882d6cff's multi-claimant shape can span several) — excluded from the orphan-sweep's own
    // true-referencer check below, same reason as ByKey/ByRecordedPath's own single-identity exclusion.
    const matchedIdentities = new Set(matchedPending.map((p) => directPathIdentity(p.entry.repoPath)));
    // @decision 9cabd143 (round 2, item 1) — each pending entry's own sourceFile is OWNED by the entry
    // being cleared, never gated on check (1) — see sweepOwnLatchFileUnlessOwnedElsewhere's own doc.
    for (const pending of matchedPending) {
      pendingCandidateTokens.push(...pending.entry.tokens);
      pendingTouchedBasenames.push(pending.sourceFile);
      for (const f of pending.entry.orphanLatchFiles ?? []) orphanFilesToSweep.add(f);
      const ownFolded = foldOrphanSweepResult(sweepOwnLatchFileUnlessOwnedElsewhere(pending.sourceFile), pending.sourceFile, new Map());
      for (const rp of ownFolded.referencingRepoPaths) { keptRepoPaths.add(rp); keptCoOccupants.set(rp, blockedCoOccupant(rp, pending.sourceFile)); }
      if (ownFolded.unattributed) anyKeptUnattributed = true;
    }
    // @decision 8db913e2 (Follow-up f2cc5f18) — `pendingCandidateTokens` already holds every matched
    // pending entry's own tokens, captured as each is processed above, before `tombstoneIfNotSurviving`.
    //
    // @decision 8db913e2 (Follow-up 0a783fb2) — this sweep's own result used to be discarded entirely —
    // fold it through the shared helper, same as every other orphan-sweep call site.
    const orphanContentKept = new Map<string, string>();
    for (const orphanFile of orphanFilesToSweep) {
      const folded = foldOrphanSweepResult(sweepOrphanLatchFileIfUnreferenced(orphanFile, pendingCandidateTokens, matchedIdentities), orphanFile, orphanContentKept);
      for (const rp of folded.referencingRepoPaths) { keptRepoPaths.add(rp); keptCoOccupants.set(rp, blockedCoOccupantForReferencer(rp, orphanFile)); }
      if (folded.unattributed) anyKeptUnattributed = true;
    }
    for (const rp of orphanContentKept.keys()) keptContentRepoPaths.add(rp);
    tombstoneIfNotSurviving(pendingCandidateTokens, pendingTouchedBasenames);
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
      // @decision 8db913e2 (Follow-up f2cc5f18) — same `pendingCandidateTokens`, still in scope.
      : sweepOrphanLatchFileIfUnreferenced(`${id}.json`, pendingCandidateTokens, matchedIdentities);
    // @decision 182c01cc (round 5, MAJOR) — `blockedCoOccupantForReferencer`, never the bare
    // `blockedCoOccupant`: a repoPath here can be a mere `orphanLatchFiles` cross-reference to
    // `${id}.json`, for which that id is a fixed point, not a working route. See that function's own doc.
    const finalContentKept = new Map<string, string>();
    const finalFolded = foldOrphanSweepResult(finalSweep, `${id}.json`, finalContentKept);
    for (const rp of finalFolded.referencingRepoPaths) { keptRepoPaths.add(rp); keptCoOccupants.set(rp, blockedCoOccupantForReferencer(rp, `${id}.json`)); }
    if (finalFolded.unattributed) anyKeptUnattributed = true;
    for (const rp of finalContentKept.keys()) keptContentRepoPaths.add(rp);
    // @decision be79f4d5 — ownership-checked (never the unconditional sibling): a DIFFERENT, surviving
    // pending/active entry can own a `.tmp-<pid>` residue sharing THIS exact hash prefix (e.g. its own
    // stale graduation source) even though no entry actually matched/removed above claims it.
    //
    // @decision 21ec39e5 — `content-checked`, `pendingCandidateTokens` as `candidateTokens`, same as the
    // sibling `.json` sweep above.
    const tmpSweep = sweepTmpResidueForHashIfUnreferenced(id, { mode: "content-checked", candidateTokens: pendingCandidateTokens });
    // @decision 8db913e2 (Follow-up 0a783fb2, Code Review 47289f8d) — deliberately INLINE, never through
    // `foldOrphanSweepResult`: its multi-entry shape doesn't fit that helper's one-sourceFile-per-call form.
    if (tmpSweep.referencingRepoPaths.length > 0) for (const ke of tmpSweep.keptEntries) { keptRepoPaths.add(ke.repoPath); keptCoOccupants.set(ke.repoPath, blockedCoOccupantForReferencer(ke.repoPath, ke.sourceFile)); }
    // @decision 21ec39e5 — a content-parsed keep never joins `referencingRepoPaths`/`stillBlockedCoOccupants`
    // (no live entry backs it to clear by id) — only `keptContentRepoPaths`, mirroring the `.json` sweep.
    for (const ke of tmpSweep.contentKeptEntries) keptContentRepoPaths.add(ke.repoPath);
    if (tmpSweep.anyUnattributed) anyKeptUnattributed = true;
    // @decision 64283e06 — mirrors the active-match branch's truthful-liftedRepoPaths rule:
    // `matchedPending` can span MULTIPLE DISTINCT identities (882d6cff's multi-claimant shape) — re-resolve
    // EACH one; a repoPath still quarantined elsewhere is left OUT, never assumed fully freed.
    const matchedRepoPaths = [...new Set(matchedPending.map((p) => p.entry.repoPath))];
    const liftedRepoPaths: string[] = [];
    const stillBlockedReasons: string[] = [];
    for (const repoPath of matchedRepoPaths) {
      const before = matchedPending.find((p) => p.entry.repoPath === repoPath)?.entry;
      const after = resolveQuarantineFor(repoPath);
      const sameIdentityStillQuarantined = !!after && directPathIdentity(after.repoPath) === directPathIdentity(repoPath);
      if (sameIdentityStillQuarantined) stillBlockedReasons.push(stillQuarantinedReason(after, before));
      else liftedRepoPaths.push(repoPath);
    }
    // @decision 182c01cc (round 2/4) — this branch's own sweep mechanisms never relocate a foreign
    // occupant to a new latch — there is no relocated-co-occupant mechanism reachable here — but a kept
    // one is real (round 4 fix: `keptCoOccupants`, never a hard-coded `[]`).
    return {
      ok: true, wasQuarantined: true, liftedRepoPaths, stillBlockedCoOccupants: [...keptCoOccupants.values()],
      ...(stillBlockedReasons.length > 0 ? { stillQuarantined: true, reason: stillBlockedReasons.join(" ") } : {}),
      ...(keptRepoPaths.size > 0 || anyKeptUnattributed || keptContentRepoPaths.size > 0 ? { latchKept: true as const } : {}),
      ...(keptRepoPaths.size > 0 || anyKeptUnattributed ? { referencingRepoPaths: [...keptRepoPaths] } : {}),
      // @decision 8db913e2 (Follow-up 0a783fb2) — a content-parsed keep names no live entry, so it never
      // joins `stillBlockedCoOccupants` above — only this field.
      ...(keptContentRepoPaths.size > 0 ? { contentKeptRepoPaths: [...keptContentRepoPaths] } : {}),
    };
  }
  // No in-memory entry anywhere matches this id — a truly corrupt/unparsable latch (or its own tmp
  // residue) with no repoPath to delegate to. Routed through the shared helper (card 9cabd143 — see this
  // function's own doc), never a bare unlink: `<id>.json` can still be a SURVIVING entry's own reference
  // or physical latch even when nothing in-memory matches `id` itself.
  // @decision 8db913e2 (Follow-up f2cc5f18) — no in-memory entry matches `id` at all, so nothing is
  // being lifted here: `[]` is correct, never a guess — a real foreign token found on disk is kept.
  //
  // @decision 8db913e2 (Follow-up 0a783fb2) — a content-parsed repoPath now reports via
  // `contentKeptRepoPaths`, never folded into `referencingRepoPaths` alongside a true referencer.
  const ownContentKept = new Map<string, string>();
  const ownFolded = foldOrphanSweepResult(sweepOrphanLatchFileIfUnreferenced(`${id}.json`, []), `${id}.json`, ownContentKept);
  // @decision be79f4d5 — the tmp-residue twin of the `.json` sweep just above: ownership-checked, never
  // an unconditional-by-hash delete. `content-checked`, `[]` as `candidateTokens` (same as the sibling
  // `.json` sweep above) — nothing is being lifted here, so nothing is already accounted for.
  const tmpSweep = sweepTmpResidueForHashIfUnreferenced(id, { mode: "content-checked", candidateTokens: [] });
  const keptRepoPaths = new Set<string>([...ownFolded.referencingRepoPaths, ...tmpSweep.referencingRepoPaths]);
  // @decision 182c01cc (round 4, CR3 finding 4) — a real `BlockedCoOccupant[]`, never a hard-coded `[]`
  // — see the decision record's "Round 4" section.
  const keptCoOccupants = new Map<string, BlockedCoOccupant>();
  // @decision 182c01cc (round 5, MAJOR) — same fix as the active-match branch above: `${id}.json`'s own id
  // is not a working route for a mere `orphanLatchFiles` cross-referencer — see blockedCoOccupantForReferencer's own doc.
  for (const rp of ownFolded.referencingRepoPaths) keptCoOccupants.set(rp, blockedCoOccupantForReferencer(rp, `${id}.json`));
  for (const ke of tmpSweep.keptEntries) keptCoOccupants.set(ke.repoPath, blockedCoOccupantForReferencer(ke.repoPath, ke.sourceFile));
  // @decision 21ec39e5 — a content-parsed tmp keep never joins `keptCoOccupants` (no live entry backs it)
  // — fold it into the SAME `ownContentKept` map the `.json` sweep above already feeds.
  for (const ke of tmpSweep.contentKeptEntries) ownContentKept.set(ke.repoPath, ke.sourceFile);
  // @decision 8db913e2 (Follow-up f2cc5f18) — a KEPT sweep with no attributable repoPath must still
  // surface as `latchKept`, mirroring `clearMergeQuarantineByKey`'s own `anyKeptUnattributed`.
  const anyKeptUnattributed = ownFolded.unattributed || tmpSweep.anyUnattributed;
  // @decision 182c01cc (round 2/4) — this raw fallback's own sweeps never relocate anything, but a kept
  // one is real (round 4 fix).
  return {
    ok: true, wasQuarantined: false, liftedRepoPaths: [], stillBlockedCoOccupants: [...keptCoOccupants.values()],
    ...(keptRepoPaths.size > 0 || anyKeptUnattributed || ownContentKept.size > 0 ? { latchKept: true as const } : {}),
    ...(keptRepoPaths.size > 0 || anyKeptUnattributed ? { referencingRepoPaths: [...keptRepoPaths] } : {}),
    ...(ownContentKept.size > 0 ? { contentKeptRepoPaths: [...ownContentKept.keys()] } : {}),
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
  // @decision 9a55fb90 — a collision at this key makes the bare-id clear option ambiguous; name only
  // the repoPath route (which discriminates correctly) rather than a shortcut that reads equally valid.
  const ambiguousIdentities = ambiguousIdentitiesForLatchId(q, latchId);
  const ambiguousCount = totalAmbiguousCount(ambiguousIdentities);
  // @decision 82032b5c (round 4) — the project-resolved `/clear` route is named ONLY in the ORDINARY
  // (non-ambiguous) branch below, never alongside `remediationTextFor`'s own output — see that
  // function's own doc for why naming it in the ambiguous case too would reopen a text/action mismatch.
  const clearGuidance = ambiguousCount > 0
    ? (() => {
      const namedIdentities = [...ambiguousIdentities.siblingRepoPaths, ...ambiguousIdentities.contributorRepoPaths];
      // @decision db0a9db0 — same namedIdentities.length-not-ambiguousCount fix as clearMergeQuarantineLatchFile's
      // own active-match branch; see the decision record.
      const namedClause = namedIdentities.length > 0
        ? `${namedIdentities.length} other identit${namedIdentities.length === 1 ? "y" : "ies"} — ${namedIdentities.map((p) => `'${p}'`).join(", ")} — also canonically collide with this exact key, or had their own raise folded into this union at runtime`
        : "";
      const unknownClause = ambiguousIdentities.unknownProvenance
        ? "this union's own provenance is incomplete — it may fold together more than one repo's raise from before provenance tracking existed, and this daemon cannot rule that out"
        : "";
      const collisionClause = [namedClause, unknownClause].filter(Boolean).join("; and ");
      return `a human clears it: this latch id is ambiguous right now (${collisionClause}), so ${remediationTextFor([q.repoPath], ambiguousIdentities)}`;
    })()
    : `a human clears it: POST /internal/merge-quarantine/clear-by-path with ${JSON.stringify({ repoPath: q.repoPath })} or ${JSON.stringify({ id: latchId })} ` +
      `(the project-resolved POST /internal/merge-quarantine/clear works only if a registered project's repo resolves to this entry)`;
  // Round 5 MAJOR (blocking) — q.reason is embedded verbatim below, and every real unconfirmed-kill raise
  // builds it via unconfirmedKillReason(), which unconditionally names the single-identity `/clear` route.
  // That's correct in the ORDINARY branch above (nothing ambiguous to get wrong), but wrong here: naming
  // `/clear` right next to remediationTextFor's own single-route text reopens the exact text/action
  // mismatch round 4 closed. Strip ONLY in the ambiguous branch — see stripUnconfirmedKillRouteClause's
  // own doc.
  const embeddedReason = ambiguousCount > 0 ? stripUnconfirmedKillRouteClause(q.reason) : q.reason;
  return {
    ok: false,
    reason: `canonical repo is QUARANTINED after an earlier operation's git process tree could not be confirmed dead ` +
      `(blocking repo '${q.repoPath}', latch id '${latchId}', branch '${q.branch}'${q.opId ? `, op ${q.opId}` : ""}, entered ${new Date(q.enteredAt).toISOString()}): ${embeddedReason} — ` +
      `refusing further canonical-repo mutations here until that kill is confirmed dead (auto-clears, same process only) ` +
      `or ${clearGuidance}.`,
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
    // @decision 2dd97aaa (Follow-up 58957b1e) — a brand-new fail-closed placeholder mints a fresh
    // identity; nothing is ever dropped.
    if (!writeMergeQuarantineLatch(entry, new Set())) {
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
  /**
   * @decision 702b4241 — call ONLY for a genuinely UNREADABLE read (a real errno other than
   * ENOENT/EISDIR) — never for ENOENT/EISDIR or a JSON.parse/field-validation failure, which must keep
   * using the existing corrupt-latch cascade, unchanged.
   *
   * Diverts straight to `pendingUnresolvedQuarantines` (self-referencing `f`), never into
   * `deferredCorruptJsons`/`deferredCorruptTmps`/the safety-tmp `resolveAndArm` cascade. This still does
   * NOT make `f` structurally unwritable THIS boot — a SIBLING source (a tmp residue or a stale migrate
   * source) sharing `f`'s own key can ALSO put `f` into `allBootWriteTargets`, and Phase 0's own at-risk
   * protection re-points THIS divert's `sourceFile` off `f` onto a fresh safety-tmp the moment that
   * happens (closing a DIFFERENT gap, ef651188) — which is exactly what disarms the backstop refusal in
   * `bootWriteLatch` (`pendingUnresolvedQuarantines.some((p) => p.sourceFile === targetBasename)`) for
   * that sibling's own write. Confirmed via a real rename-tracing probe during this card's round-2 review
   * (Code Review `12c5623d`): `bootWriteLatch` DOES rename over `f` during the SAME boot in exactly this
   * shape. The ACTUAL protection is `keptUnreadableLatchFiles` plus TWO write-side mechanisms, every
   * writer that could reach a marked basename going through one or the other (round 3, Code Review
   * `b939aead`, closed a THIRD writer — `writePendingDivertFile` — that reached a marked basename through
   * neither): `writeMergeQuarantineLatch` (direct, and via `bootWriteLatch`'s own external pre-call) folds
   * (or, for a placeholder entry, wholesale re-ingests) `final`'s own on-disk content via
   * `reconcileMarkedBasenameBeforeWrite`/`foldInOnDiskTokensIfMarked` before ever writing; every diverting
   * caller of `writePendingDivertFile` — `divertRaiseEntry` foremost — instead REFUSES to rename over a
   * marked basename at all, diverting to a freshly-minted record with the marked file folded into that
   * record's own `orphanLatchFiles`, rather than reading and unioning `final`'s content directly (see that
   * function's own doc for why: the content there may belong to ANOTHER identity entirely, so folding it
   * forward would risk absorbing it). That first mechanism only holds end to end because of two further
   * fixes, also from round 2: `reconcileMarkedBasenameBeforeWrite` re-ingests the REAL record wholesale
   * when the entry being written is itself one of these synthetic placeholders (never just unions its own
   * fake branch/reason over recovered content), and `bootWriteLatch` syncs `byRepoKey` to the reconciled
   * result BEFORE writing (never leaves memory holding a stale, pre-reconcile object once the kept mark
   * clears on a successful write). The no-match fallback (ordinary orphan sweep) writes to each
   * REGISTERED repo's own key, never to `f` itself, so it carries no risk either way.
   */
  const divertUnreadableBootLatch = (f: string, hash: string, code: string, kindLabel: string): void => {
    keptUnreadableLatchFiles.add(f);
    // eslint-disable-next-line no-console
    console.error(`[merge-quarantine] boot-time ${kindLabel} ${f} is UNREADABLE (${code}), NOT corrupt — leaving it AS WRITTEN; never overwriting/migrating/deleting a file whose content could not be confirmed; retrying enforcement on a later boot.`);
    const matchedRepo = hashToRepo.get(hash);
    const claimants = matchedRepo ? undefined : unresolvedClaimantsByHash.get(hash);
    const ancestorClaimants = (!matchedRepo && !(claimants && claimants.length > 0)) ? ancestorHashToRepo().get(hash) : undefined;
    const owners = matchedRepo
      ? [matchedRepo]
      : (claimants && claimants.length > 0 ? claimants : (ancestorClaimants && ancestorClaimants.length > 0 ? ancestorClaimants : undefined));
    if (owners) {
      for (const owner of owners) {
        // @decision 702b4241 (round 4) — remember this exact synthetic token so a later reconcile can
        // filter it back out of any union, never carrying it forward as if it were a genuine raise.
        const syntheticToken = randomUUID();
        unreadablePlaceholderTokens.add(syntheticToken);
        pendingUnresolvedQuarantines.push({
          entry: {
            repoPath: owner, branch: PLACEHOLDER_BRANCH_UNREADABLE,
            reason: `boot found an UNREADABLE (${code}) quarantine ${kindLabel} (${f}) matching this repo's hash — fail-closed rather than risk discarding a real quarantine, but never overwriting/migrating/deleting this file since its content could not be confirmed`,
            enteredAt: Date.now(), tokens: [syntheticToken], placeholder: true,
          },
          sourceFile: f,
        });
      }
      return;
    }
    orphanFilenames.push(f);
    orphanReasonParts.push(`${f}: UNREADABLE (${code})`);
  };
  // @decision 92c645cc — PASS 1b's "stale tmp, safe to delete" branch must gate on a key having had a
  // CLEAN parse here, never on `byRepoKey.has(...)` alone (a corrupt-but-hash-matched placeholder also
  // lands in `byRepoKey`, even when its own self-heal write failed).
  const cleanlyParsedKeys = new Set<string>();
  // @decision d163aef5 (round 3) — each record carries the ENTRY OBJECT + its OWN sourceFile, captured
  // AT DIVERT TIME, never a `resolvedKey` re-read against `byRepoKey` at flush time (883e29bc's retired
  // design — see the decision record's "Round 3" section). Never read or mutated by eviction below.
  const degradedDivertsToFlush: { entry: MergeQuarantineEntry; sourceFile: string }[] = [];
  const flushDegradedDiverts = () => {
    for (const { entry, sourceFile } of degradedDivertsToFlush) {
      pendingUnresolvedQuarantines.push({ entry, sourceFile });
    }
    degradedDivertsToFlush.length = 0;
  };
  /**
   * Routes EVERY `armQuarantineKey` call in this function's read loops through here instead, never a
   * bare call — covering both a PRIMARY arm (`key` is `entry`'s own just-computed `currentKey` — pass
   * `entryClaimIsTautological: true`) and a SECONDARY arm (`key` is a persisted, trusted-but-unverified
   * `resolvedKey` — either side's — pass `false`).
   *
   * If `key` is unoccupied, occupied by the SAME identity, or occupied by an entry whose own
   * resolvability matches `entry`'s (both verified, or both degraded — the legitimate same-tier union
   * 883e29bc itself still allows, e.g. two degraded entries sharing a manufactured collision), this is a
   * plain pass-through to `armQuarantineKey`. A cross-identity, cross-resolvability collision is
   * special-cased UNLESS `key` is genuinely backed — by SOME `registeredRepoPaths` entry's own fresh,
   * current identity (checked via {@link isKeyVerifiedFor}, the SAME predicate `activeMergeQuarantineFor`'s
   * own `direct` fast-path guard already uses) — in which case it's `armQuarantineKey`'s own intended
   * same-toplevel-collapse union, unchanged (card `9a55fb90`'s own dual-armed shape: the real owner need
   * not be `prior` or `entry` themselves, so every registered path is checked, not just these two).
   *
   * When NOT backed: a PRIMARY arm's `entry` claim is tautological (the caller computed `key` FROM
   * `entry.repoPath` in this exact call, a fact no persisted field could misrepresent) — it always wins,
   * evicting `prior`. A SECONDARY arm has no such guarantee on EITHER side — whichever side is NOT
   * currently resolvable loses (its own trusted-but-unverifiable claim yields to the other's live one);
   * if that's `entry`, this returns `undefined` and the CALLER must divert `entry` to
   * `pendingUnresolvedQuarantines` itself and `continue` (only the caller knows the right warning text
   * and `sourceFile` for its own call site) — a primary arm never does this (always returns the armed
   * entry), since `entry` itself never loses there.
   *
   * Evicting `prior` removes it from ONLY `key` — not blindly every key in its own `armedKeys` — so a
   * `prior` that legitimately holds OTHER keys too (e.g. its own real primary key, while `key` here was
   * merely its own stale secondary one) keeps them untouched, via `replaceEntryEverywhere` (which also
   * re-points any EXISTING pending reference to `prior` onto the trimmed survivor). Only when `key` was
   * its LAST key is it diverted to `pendingUnresolvedQuarantines` as its own standalone entry — NEVER
   * discarded, degraded OR genuinely RESOLVABLE alike (round 3 ruling: three prior rounds each tried to
   * keep `degradedDivertsToFlush`'s own bookkeeping re-bound across an eviction instead, and each one
   * opened a new hole — see the decision record's "Round 3" section). Its real sourceFile is recovered
   * from an ALREADY-FLUSHED `pendingUnresolvedQuarantines` reference when one exists (by object
   * identity — this never reads or mutates `degradedDivertsToFlush` itself, which is flushed on its own
   * schedule regardless), else inferred deterministically via `quarantinePathForKey` (correct only when
   * `prior` reached `key` via its own self-consistent primary arm, degraded or resolvable). A push is
   * skipped only when the EXACT (entry, sourceFile) pair is already present — never on entry identity
   * alone, so a second, genuinely different sourceFile for the same entry is never silently swallowed.
   * A duplicate pending reference is an accepted, harmless outcome; a lost one is not.
   *
   * @decision d163aef5 — a degraded entry never unions into, nor overwrites, a key no registered repo's
   * own fresh identity backs; EITHER side of this eviction — degraded or genuinely resolvable — can
   * reach the zero-remaining-keys branch, and NEITHER is ever dropped. See the decision record.
   */
  const armKeyUnlessDegradedCollision = (
    key: string,
    entry: MergeQuarantineEntry,
    entryClaimIsTautological: boolean,
  ): MergeQuarantineEntry | undefined => {
    const prior = byRepoKey.get(key);
    if (prior && directPathIdentity(prior.repoPath) !== directPathIdentity(entry.repoPath)) {
      const priorResolvable = isRepoPathCurrentlyResolvable(prior.repoPath);
      const entryResolvable = isRepoPathCurrentlyResolvable(entry.repoPath);
      if (priorResolvable !== entryResolvable && !registeredRepoPaths.some((p) => isKeyVerifiedFor(p, key))) {
        if (!entryClaimIsTautological && !entryResolvable) return undefined; // `entry` is the losing side
        // `prior` loses `key` — evict it from THIS key only; it may still legitimately hold others.
        const remainingKeys = (prior.armedKeys ?? [key]).filter((k) => k !== key);
        if (remainingKeys.length > 0) {
          const trimmedPrior: MergeQuarantineEntry = { ...prior, armedKeys: remainingKeys };
          // replaceEntryEverywhere re-points EVERY existing byRepoKey/pendingUnresolvedQuarantines
          // reference to `prior` (including any pending twin an EARLIER flush already pushed) onto
          // `trimmedPrior` — so a prior already-pending entry stays correct without a separate step.
          replaceEntryEverywhere(byRepoKey, prior, trimmedPrior);
          byRepoKey.delete(key); // replaceEntryEverywhere re-points EVERY ref including this one; undo it
        } else {
          // `key` was prior's ONLY key — it's displaced entirely. NEVER discarded (card d163aef5, round
          // 3 ruling: three prior rounds each tried to keep this re-bound across an eviction instead, and
          // each opened a new hole) — always pushed to `pendingUnresolvedQuarantines`, degraded OR
          // genuinely resolvable alike. This never reads or mutates `degradedDivertsToFlush` — that
          // array is flushed on its own, independent schedule, and a duplicate push across the two is an
          // accepted, harmless outcome (a duplicate beats a loss).
          byRepoKey.delete(key);
          degradedOccupiedKeys.delete(key);
          // Recover `prior`'s own real sourceFile from an ALREADY-FLUSHED pending reference, by object
          // identity, before ever falling back to inference.
          const tracked = pendingUnresolvedQuarantines.find((p) => p.entry === prior);
          let priorSourceFile: string;
          if (tracked) {
            priorSourceFile = tracked.sourceFile;
          } else {
            // No tracked reference — `prior` reached `key` via its own self-consistent primary arm
            // (degraded or resolvable), so its real backing file, if it has one at all, is
            // deterministically `quarantinePathForKey(key)`'s own basename.
            priorSourceFile = path.basename(quarantinePathForKey(key));
            // eslint-disable-next-line no-console
            console.error(`[merge-quarantine] evicting ${prior.repoPath} from ${key} with no tracked pending reference of its own — inferring its real source file as ${priorSourceFile} (card d163aef5, round 3 ruling: never discarding it either way).`);
          }
          // Dedup on the EXACT (entry, sourceFile) pair only, never on entry identity alone — a second,
          // genuinely different sourceFile for the same entry must still get its own reference.
          if (!pendingUnresolvedQuarantines.some((p) => p.entry === prior && p.sourceFile === priorSourceFile)) {
            pendingUnresolvedQuarantines.push({ entry: prior, sourceFile: priorSourceFile });
          }
        }
        // else (backed by a registered repo): legitimate same-toplevel union, unchanged below.
      }
    }
    // `prior` genuinely still occupies `key` here (never evicted above — eviction already deleted it)
    // whenever we reach this point with it non-empty: a same-identity match, a same-tier union, or a
    // registered-backed collision all fall through without ever deleting it.
    const priorStillAtKey = prior && byRepoKey.get(key) === prior ? prior : undefined;
    const result = armQuarantineKey(byRepoKey, key, entry);
    // @decision d163aef5 (round 3) — rebind a degradedDivertsToFlush record still naming the PRE-union
    // object onto the fresh `result`, on a real union — else its later flush pushes a stale snapshot
    // alongside the real union (97cff6db round 4 minor 1's shape). Never fires for an evicted `prior`.
    if (priorStillAtKey && result !== priorStillAtKey) {
      for (const deferred of degradedDivertsToFlush) {
        if (deferred.entry === priorStillAtKey) deferred.entry = result;
      }
    }
    return result;
  };
  /** A PRIMARY arm (`key` freshly computed from `entry.repoPath` in this exact call) — `entry`'s own
   *  claim is tautological, so this never diverts `entry` itself; see {@link armKeyUnlessDegradedCollision}. */
  const armCurrentKeyUnlessDegradedCollision = (key: string, entry: MergeQuarantineEntry): MergeQuarantineEntry =>
    armKeyUnlessDegradedCollision(key, entry, true)!;
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
  // @decision 8db913e2 (Follow-up 8bff3cae) — collect-then-decide: ANY way this boot can independently
  // arm this stale key (clean parse, corrupt `.json`, or corrupt tmp) gets its own chance FIRST —
  // resolved once, below, only after every one of those has fully settled, never right after PASS 1.
  const staleKeyRetentionCandidates: { currentKey: string; staleKey: string }[] = [];

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
        resolvedKeys: parseResolvedKeysField(parsed),
        placeholder: parsedIsPlaceholder ? true : undefined,
        // @decision 82032b5c — carry a persisted `contributorRepoPaths` back in at boot, or clear-by-id's
        // refusal for a runtime-union entry silently stops working the moment the process restarts.
        contributorRepoPaths: Array.isArray(parsed.contributorRepoPaths) && parsed.contributorRepoPaths.every((s): s is string => typeof s === "string")
          ? parsed.contributorRepoPaths : undefined,
        // @decision db0a9db0 — same carry-forward, same reason: without this, a PERSISTED marker (written
        // by a partial clear's own rewrite) is silently dropped on the very next boot's PRIMARY parse,
        // falling back to re-derivation alone — which can miss it once `tokens.length` drops to 1.
        provenanceUnknown: parsed.provenanceUnknown === true ? true : undefined,
        // @decision db0a9db0 (round 2) — same carry-forward for the precision-guard field.
        provenanceTracked: parsed.provenanceTracked === true ? true : undefined,
      };
      // @decision db0a9db0 (round 2) — detect UNCONDITIONALLY, before any branch/mutation below (in
      // particular, before the migrate branch rewrites `resolvedKey`) — see the decision record's own
      // round-2 section for the fail-open this ordering closes.
      if (detectUnknownProvenance(entry, hash)) {
        entry = { ...entry, provenanceUnknown: true };
      }
      const currentKey = canonicalRepoLockKey(entry.repoPath);
      // A placeholder final must NEVER count as a clean parse for PASS 1b's stale-tmp gate — see that
      // Set's own doc comment and docs/decisions/92c645cc-fresh-tmp-name-and-conditional-sweep.md.
      if (!parsedIsPlaceholder) cleanlyParsedKeys.add(currentKey);
      const freshHash = createHash("sha256").update(currentKey).digest("hex").slice(0, 24);
      const resolvableNow = isRepoPathCurrentlyResolvable(entry.repoPath);
      // @decision 8db913e2 (Follow-up 43cf3b26, CR 46c5c492) — gate on informativeKeysFor (scalar ∪
      // resolvedKeys), never the scalar alone (CR 46c5c492's probe2: a plural-only record, no scalar at
      // all, was wrongly treated as a pre-upgrade no-key latch and never got its own resolvedKeys attempted).
      if (!resolvableNow && informativeKeysFor(entry).length === 0) {
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
          // @decision 8db913e2 (Follow-up 8bff3cae) — fold the scalar's OWN already-informative key
          // forward before it is overwritten below; a stale-but-still-live SIBLING key is handled
          // separately, deferred — see the decision record's own "Follow-up 8bff3cae" section.
          if (isInformativeKey(entry, currentKey)) {
            entry = { ...entry, resolvedKeys: unionResolvedKeysRetaining(entry.resolvedKeys, [entry.resolvedKey!], `PASS1-migrate(${entry.repoPath})`) };
          }
          // @decision 8db913e2 (Follow-up 8bff3cae) — queue `hash` for deferred retention (never fold it
          // in HERE) — see `staleKeyRetentionCandidates`'s own doc comment for why.
          const staleKeyStillOwnedBy = hashToRepo.get(hash);
          if (staleKeyStillOwnedBy !== undefined) {
            const staleKeyStillLive = canonicalRepoLockKey(staleKeyStillOwnedBy);
            // @decision 8db913e2 (Follow-up 8bff3cae, CR 0b975d2a) — never trust a LEGACY-tier
            // `hashToRepo` match without this check: it can recompute to an ANCESTOR's key that durably
            // blocks an unrelated repo, never `hash`'s own true owner.
            if (staleKeyStillLive !== currentKey && legacyMatchStillResolvesToHash(staleKeyStillLive, hash)) {
              staleKeyRetentionCandidates.push({ currentKey, staleKey: staleKeyStillLive });
            }
          }
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
          // informativeKeysFor(entry) is guaranteed non-empty here (the no-informative-key+unresolvable
          // case is handled, and `continue`d past, above) — never just the bare scalar `entry.resolvedKey`.
          //
          // @decision 883e29bc — never arm at the degraded walked-up `currentKey` directly, only at
          // resolvedKey(s); divert the degraded key's signal to pendingUnresolvedQuarantines instead.
          //
          // @decision d163aef5 — but never union at resolvedKey either, if that key is ALREADY occupied
          // by a different, currently-verified entry — see armKeyUnlessDegradedCollision's own doc.
          //
          // @decision 8db913e2 (Follow-up 43cf3b26) — generalized from ONE `entry.resolvedKey` attempt to
          // a loop over EVERY candidate in `entry.resolvedKeys` (falling back to the scalar) — see the
          // decision record's own "boot-time re-arm generalization" section.
          const secondaryCandidates = secondaryKeysToAttempt(entry, currentKey);
          let armedAtResolvedKey: MergeQuarantineEntry | undefined;
          for (const k of secondaryCandidates) {
            const attempt = armKeyUnlessDegradedCollision(k, armedAtResolvedKey ?? entry, false);
            if (attempt === undefined) {
              // eslint-disable-next-line no-console
              console.warn(`[merge-quarantine] boot-time latch ${f} for ${entry.repoPath} could NOT be verified against its current key, and one of its own recorded resolvedKeys (${k}) is ALREADY occupied by a different, currently-VERIFIED entry — never unioning a degraded entry into a verified sibling's slot (card d163aef5); that key is skipped, enforcement continues at every other candidate.`);
              continue;
            }
            armedAtResolvedKey = attempt;
          }
          // @decision 8db913e2 (Follow-up 43cf3b26, CR 46c5c492, MINOR) — reached only when every
          // candidate was attempted AND refused; wording no longer fires when there was nothing to try.
          if (secondaryCandidates.length > 0 && armedAtResolvedKey === undefined) {
            // eslint-disable-next-line no-console
            console.warn(`[merge-quarantine] boot-time latch ${f} for ${entry.repoPath} could NOT be verified against its current key, and every one of its own recorded resolvedKey(s) is ALREADY occupied by a different, currently-VERIFIED entry — never unioning a degraded entry into a verified sibling's slot (card d163aef5); leaving ${entry.repoPath} as a standalone, fail-closed pending entry instead.`);
            pendingUnresolvedQuarantines.push({ entry, sourceFile: f });
            continue;
          }
          // eslint-disable-next-line no-console
          console.warn(`[merge-quarantine] boot-time latch ${f} for ${entry.repoPath} could NOT be verified against its current key — ${entry.repoPath} does not currently resolve on disk (an unmounted drive? a not-yet-synced folder?) — leaving the latch file AS WRITTEN rather than risk migrating/deleting it on an unreliable reading; arming enforcement under its recorded original key(s) and deferring the degraded, walked-up key to a lazy re-resolve on first query.`);
          // @decision 4480b077 (round 2) — this entry's own backing file physically lives at
          // sha(resolvedKey); record EVERY successfully-armed key so no write pass below ever writes there.
          for (const k of armedAtResolvedKey?.armedKeys ?? []) {
            if (k === currentKey) continue;
            degradedOccupiedKeys.add(k);
          }
          // @decision 8db913e2 (Follow-up 43cf3b26, CR 46c5c492, CRITICAL) — ALWAYS divert, even when the
          // scalar happens to equal `currentKey` — see the decision record's own CR-46c5c492 section.
          degradedDivertsToFlush.push({ entry: armedAtResolvedKey ?? entry, sourceFile: f });
          continue;
        }
      }
      // Thread the return value through both arms — armQuarantineKey folds `key` into the result's
      // `armedKeys`, so the SECOND call must build on the FIRST's output, not the original `entry`, or the
      // first key's own slot ends up missing the second key from its armedKeys (see PASS 1/1b "Do not" in
      // docs/decisions/54054c01-clear-lifts-every-key-an-entry-was-armed-under.md, round 2 finding 2).
      // @decision d163aef5 — `entry` can ALSO be degraded here (self-consistently named at its own
      // degenerate key) — a primary arm's claim is tautological either way; see the helper's own doc.
      //
      // @decision 8db913e2 (Follow-up 43cf3b26) — generalized to a loop over every candidate secondary
      // key, threading the accumulator through each attempt exactly like the single-key case did.
      let armedEntry = armCurrentKeyUnlessDegradedCollision(currentKey, entry);
      for (const k of secondaryKeysToAttempt(armedEntry, currentKey)) {
        // `entry`/`armedEntry` can ALSO be degraded here — self-consistently NAMED (so the degraded-divert
        // branch above never ran) yet still carrying a STALE resolvedKey(s) that differ from its own
        // currentKey (the Code Review's own `X` repro). The helper itself is symmetric either way; this
        // is a plain secondary arm, never the tautological one.
        const secondArm = armKeyUnlessDegradedCollision(k, armedEntry, false);
        if (secondArm !== undefined) {
          armedEntry = secondArm;
          byRepoKey.set(currentKey, armedEntry);
        }
      }
    } catch (e) {
      // @decision 702b4241 — a genuine (non-ENOENT/EISDIR) read failure is UNREADABLE, never corrupt;
      // route it through the dedicated chokepoint BEFORE the corrupt-latch cascade below ever runs.
      const readErrorCode = (e as NodeJS.ErrnoException).code;
      if (readErrorCode && readErrorCode !== "ENOENT" && readErrorCode !== "EISDIR") {
        divertUnreadableBootLatch(f, hash, readErrorCode, "latch");
        continue;
      }
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
    const hash = f.slice(0, -".json".length);
    // @decision 4783df46 — a walked-up LEGACY match still arms at `key` (never diverts); it only gains
    // `provenanceUnknown` below. See `legacyMatchStillResolvesToHash`'s own doc and the decision record.
    const verified = legacyMatchStillResolvesToHash(key, hash);
    if (!verified) {
      // eslint-disable-next-line no-console
      console.warn(`[merge-quarantine] boot-time latch ${f} is CORRUPT/unparsable and matches registered repo ${matchedRepo}'s own LEGACY (direct-path) identity, but ${matchedRepo}'s current canonical key ${key} no longer hashes to this file (walked up, or a pre-7673d096 subdir binding) — fail-closed by arming ${key} anyway rather than risk discarding a real quarantine, but this is NOT a verified match for whatever currently owns ${key}; marking provenanceUnknown.`);
    }
    const entry: MergeQuarantineEntry = {
      repoPath: matchedRepo, branch: PLACEHOLDER_BRANCH_CORRUPT,
      reason: verified
        ? `boot found a CORRUPT/unparsable quarantine latch (${f}) matching this repo's hash — fail-closed rather than risk discarding a real quarantine`
        : `boot found a CORRUPT/unparsable quarantine latch (${f}) matched only by a legacy (direct-path) identity — ${matchedRepo}'s own direct-path identity matches this file's hash, but its current canonical key no longer does (walked up, or a pre-7673d096 subdir binding); fail-closed by arming its current key (${key}) anyway, but this is NOT a verified match for whatever currently owns it`,
      enteredAt: Date.now(), tokens: [randomUUID()], placeholder: true,
      provenanceUnknown: verified ? undefined : true,
    };
    // @decision d163aef5 — `matchedRepo` is resolvable (gated above), so this placeholder's own primary
    // arm is tautological too — never diverts `entry`, only ever evicts an illegitimate degraded prior.
    armCurrentKeyUnlessDegradedCollision(key, entry);
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
      // this tmp is USUALLY stale residue from an earlier interrupted write, safe to clean up immediately.
      //
      // @decision 97cff6db — investigated whether a safety-tmp residue landing HERE needs a union rather
      // than a blind delete. It does not (a safety-tmp is named disjointly and never reaches this branch).
      //
      // @decision 21ec39e5 — a renameSync failure after a successful fsync can strand the SUPERSEDING
      // write's own tmp, making `final` the stale side — never delete unless every on-disk token is
      // already in `final`'s own tokens; a non-subset falls through to the normal recovery union below.
      const alreadyAccountedFor = byRepoKey.get(canonicalRepoLockKey(matchedRepo))?.tokens ?? [];
      const staleTmpSafety = orphanSweepSafeToDelete(f, alreadyAccountedFor);
      if (staleTmpSafety.safe) {
        try { fs.unlinkSync(tmpPath); } catch { /* best-effort — a leftover tmp beside a good final write is harmless */ }
        continue;
      }
      // eslint-disable-next-line no-console
      console.warn(`[merge-quarantine] boot-time tmp latch ${f} sits beside an already-clean final for registered repo ${matchedRepo}, but its own on-disk content is NOT a provable subset of that final's tokens — this may be a torn write stranded by a renameSync failure, not genuinely stale residue; falling through to the standard tmp-recovery union instead of deleting it blind.`);
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
      let entry: MergeQuarantineEntry = {
        repoPath: parsed.repoPath, branch: parsed.branch, reason: parsed.reason,
        opId: typeof parsed.opId === "string" ? parsed.opId : undefined,
        enteredAt: typeof parsed.enteredAt === "number" ? parsed.enteredAt : Date.now(),
        tokens,
        orphanLatchFiles: Array.isArray(parsed.orphanLatchFiles) && parsed.orphanLatchFiles.every((s): s is string => typeof s === "string")
          ? parsed.orphanLatchFiles : undefined,
        resolvedKey: typeof parsed.resolvedKey === "string" ? parsed.resolvedKey : undefined,
        resolvedKeys: parseResolvedKeysField(parsed),
        placeholder: isPlaceholderEntryShape(parsed) ? true : undefined,
        // @decision 82032b5c — same carry-forward as PASS 1's own parse above, for a tmp-residue recovery.
        contributorRepoPaths: Array.isArray(parsed.contributorRepoPaths) && parsed.contributorRepoPaths.every((s): s is string => typeof s === "string")
          ? parsed.contributorRepoPaths : undefined,
        // @decision db0a9db0 — same carry-forward, same reason, for a tmp-residue recovery.
        provenanceUnknown: parsed.provenanceUnknown === true ? true : undefined,
        // @decision db0a9db0 (round 2) — same carry-forward for the precision-guard field.
        provenanceTracked: parsed.provenanceTracked === true ? true : undefined,
      };
      // @decision db0a9db0 (round 2) — detect UNCONDITIONALLY, before any branch below, mirroring PASS 1's
      // own ordering fix; see detectUnknownProvenance's own doc.
      if (detectUnknownProvenance(entry, hash)) {
        entry = { ...entry, provenanceUnknown: true };
      }
      const currentKey = canonicalRepoLockKey(entry.repoPath);
      // @decision 6237bef6 — mirror PASS 1's own unresolvable/no-resolvedKey gate (card 369b97be): defer
      // to pendingUnresolvedQuarantines here too, rather than arming a tmp-sourced entry under a possibly-
      // degraded key the way the rest of this loop otherwise would.
      // @decision 8db913e2 (Follow-up 43cf3b26, CR 46c5c492) — gate on informativeKeysFor, never the
      // scalar alone (mirrors PASS 1's own identical fix above).
      if (!isRepoPathCurrentlyResolvable(entry.repoPath) && informativeKeysFor(entry).length === 0) {
        // eslint-disable-next-line no-console
        console.warn(`[merge-quarantine] boot-time tmp latch ${f} for ${entry.repoPath} has no recorded resolvedKey and could NOT be verified against its current key — ${entry.repoPath} does not currently resolve on disk — leaving the tmp file AS WRITTEN and deferring enforcement to a lazy re-resolve on first query.`);
        pendingUnresolvedQuarantines.push({ entry, sourceFile: f });
        continue;
      }
      // @decision 8db913e2 (Follow-up 43cf3b26, CR 46c5c492, CRITICAL) — this branch's own ENTRY gate no
      // longer requires `entry.resolvedKey !== currentKey` to fire — a coincidental match used to skip
      // this branch entirely, arming currentKey directly instead. See the decision record's CR section.
      if (!isRepoPathCurrentlyResolvable(entry.repoPath)) {
        // @decision 883e29bc — mirror PASS 1's own fix above: never arm this tmp-sourced entry at its
        // degraded walked-up `currentKey`, only at resolvedKey(s); divert the degraded signal to pending.
        //
        // @decision d163aef5 — but never union at resolvedKey either, if that key is ALREADY occupied by
        // a different, currently-verified entry — mirrors PASS 1's own fix above.
        const secondaryCandidates = secondaryKeysToAttempt(entry, currentKey);
        let armedAtResolvedKey: MergeQuarantineEntry | undefined;
        for (const k of secondaryCandidates) {
          const attempt = armKeyUnlessDegradedCollision(k, armedAtResolvedKey ?? entry, false);
          if (attempt === undefined) {
            // eslint-disable-next-line no-console
            console.warn(`[merge-quarantine] boot-time tmp latch ${f} for ${entry.repoPath} could NOT be verified against its current key, and one of its own recorded resolvedKeys (${k}) is ALREADY occupied by a different, currently-VERIFIED entry — never unioning a degraded entry into a verified sibling's slot (card d163aef5); that key is skipped, enforcement continues at every other candidate.`);
            continue;
          }
          armedAtResolvedKey = attempt;
        }
        // Reached only when every candidate was attempted AND refused (never when there was nothing to try).
        if (secondaryCandidates.length > 0 && armedAtResolvedKey === undefined) {
          // eslint-disable-next-line no-console
          console.warn(`[merge-quarantine] boot-time tmp latch ${f} for ${entry.repoPath} could NOT be verified against its current key, and every one of its own recorded resolvedKey(s) is ALREADY occupied by a different, currently-VERIFIED entry — never unioning a degraded entry into a verified sibling's slot (card d163aef5); leaving ${entry.repoPath} as a standalone, fail-closed pending entry instead.`);
          pendingUnresolvedQuarantines.push({ entry, sourceFile: f });
          continue;
        }
        // eslint-disable-next-line no-console
        console.warn(`[merge-quarantine] boot-time tmp latch ${f} for ${entry.repoPath} could NOT be verified against its current key — ${entry.repoPath} does not currently resolve on disk (an unmounted drive? a not-yet-synced folder?) — leaving the tmp file AS WRITTEN rather than risk promoting/deleting it on an unreliable reading; arming enforcement under its recorded original key(s) and deferring the degraded, walked-up key to a lazy re-resolve on first query.`);
        // @decision 4480b077 (round 2) — same tracking as PASS 1's own degraded branch, shared across
        // both passes so EITHER one's degraded find protects BOTH write passes below.
        for (const k of armedAtResolvedKey?.armedKeys ?? []) {
          if (k === currentKey) continue;
          degradedOccupiedKeys.add(k);
        }
        // ALWAYS divert — see the CRITICAL note on this branch's own entry gate, above.
        degradedDivertsToFlush.push({ entry: armedAtResolvedKey ?? entry, sourceFile: f });
        continue;
      }
      // See PASS 1's identical threading note above — the second call must build on the first's result.
      // @decision d163aef5 — mirrors PASS 1's own primary arm: `entry` can be degraded here too (same
      // no-mismatch, self-consistent shape) — its claim is tautological either way.
      const priorAtCurrentKey = byRepoKey.get(currentKey);
      let armedTmpEntry = armCurrentKeyUnlessDegradedCollision(currentKey, entry);
      // @decision 8db913e2 (Follow-up 43cf3b26) — a collision HERE no longer drops either side (both
      // ride `resolvedKeys` now); downgraded to an info-level line — see the decision record.
      if (isInformativeKey(priorAtCurrentKey, currentKey) && isInformativeKey(entry, currentKey) && priorAtCurrentKey!.resolvedKey !== entry.resolvedKey) {
        const priorSourceList = tmpsToUnlinkByKey.get(currentKey);
        const priorSourceFile = priorSourceList?.find((p) => originalEntryBySource.get(path.basename(p))?.resolvedKey === priorAtCurrentKey!.resolvedKey);
        const priorSourceDisplay = priorSourceFile !== undefined ? path.basename(priorSourceFile) : path.basename(quarantinePathForKey(currentKey));
        // eslint-disable-next-line no-console
        console.log(`[merge-quarantine] boot found sibling latches for ${entry.repoPath} with DIFFERENT, equally informative resolvedKeys (${priorAtCurrentKey!.resolvedKey}, ${entry.resolvedKey}) — sources: ${path.basename(tmpPath)} and ${priorSourceDisplay} — both retained via resolvedKeys (card 43cf3b26); no enforcement is lost.`);
      }
      // @decision 8db913e2 (Follow-up 43cf3b26, CR 4c59172f round 2, MAJOR) — thread the accumulator like
      // PASS 1's own loop above: never reassigning broke the identity invariant with >=2 secondaries.
      for (const k of secondaryKeysToAttempt(armedTmpEntry, currentKey)) {
        // `entry` can ALSO be degraded here — mirrors PASS 1's own second-arm note above (a
        // self-consistently-named entry with a stale, diverging `resolvedKey`); the helper is symmetric.
        const dualArmed = armKeyUnlessDegradedCollision(k, armedTmpEntry, false);
        if (dualArmed !== undefined) {
          armedTmpEntry = dualArmed;
          byRepoKey.set(currentKey, armedTmpEntry);
        }
      }
      originalEntryBySource.set(path.basename(tmpPath), entry);
      // Collect this tmp for the single per-key write/unlink pass below, grouped by the entry's OWN
      // canonical key — the same key `writeMergeQuarantineLatch` physically writes to.
      const list = tmpsToUnlinkByKey.get(currentKey) ?? [];
      list.push(tmpPath);
      tmpsToUnlinkByKey.set(currentKey, list);
    } catch (e) {
      // @decision 702b4241 — a genuine (non-ENOENT/EISDIR) read failure is UNREADABLE, never corrupt;
      // route it through the dedicated chokepoint BEFORE the corrupt-tmp cascade below ever runs.
      const readErrorCode = (e as NodeJS.ErrnoException).code;
      if (readErrorCode && readErrorCode !== "ENOENT" && readErrorCode !== "EISDIR") {
        divertUnreadableBootLatch(f, hash, readErrorCode, "tmp latch");
        continue;
      }
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
    // @decision db0a9db0 (round 2) — feeds detectUnknownProvenance's signature check, called right after
    // parsing below, unconditionally (never gated on this loop's own resolvability branch).
    const hash = f.slice(0, f.indexOf(".json.tmp-safety-"));
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
        resolvedKeys: parseResolvedKeysField(parsed),
        // @decision 82032b5c — same carry-forward as PASS 1/1b's own parses, for a safety-tmp recovery.
        contributorRepoPaths: Array.isArray(parsed.contributorRepoPaths) && parsed.contributorRepoPaths.every((s): s is string => typeof s === "string")
          ? parsed.contributorRepoPaths : undefined,
        // @decision db0a9db0 — same carry-forward, same reason, for a safety-tmp recovery.
        provenanceUnknown: parsed.provenanceUnknown === true ? true : undefined,
        // @decision db0a9db0 (round 2) — same carry-forward for the precision-guard field.
        provenanceTracked: parsed.provenanceTracked === true ? true : undefined,
      };
      // @decision db0a9db0 (round 2) — detect UNCONDITIONALLY, before any branch below, mirroring PASS 1/
      // 1b's own ordering fix; see detectUnknownProvenance's own doc.
      if (detectUnknownProvenance(entry, hash)) {
        entry = { ...entry, provenanceUnknown: true };
      }
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
      // @decision d163aef5 — `entry` is always resolvable here (the unresolvable branch above always
      // `continue`s) — this primary arm's own claim is tautological anyway; only a degraded PRIOR
      // sharing `currentKey` only via some unrelated secondary claim could ever be evicted.
      let armedSafety = armCurrentKeyUnlessDegradedCollision(currentKey, entry);
      // @decision 8db913e2 (Follow-up 43cf3b26) — generalized to a loop, mirrors PASS 1/1b's own identical
      // generalization.
      for (const k of secondaryKeysToAttempt(armedSafety, currentKey)) {
        // This second arm can only decline-and-evict a DIFFERENT, degraded occupant at this stale key.
        const dualArmed = armKeyUnlessDegradedCollision(k, armedSafety, false);
        if (dualArmed !== undefined) {
          armedSafety = dualArmed;
          byRepoKey.set(currentKey, armedSafety);
        }
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
      // @decision 702b4241 — a genuine (non-ENOENT/EISDIR) read failure is UNREADABLE, never corrupt;
      // route it through the dedicated chokepoint BEFORE the corrupt-residue cascade below ever runs.
      const readErrorCode = (e as NodeJS.ErrnoException).code;
      if (readErrorCode && readErrorCode !== "ENOENT" && readErrorCode !== "EISDIR") {
        // `hash` below is block-scoped to this SAME catch (redeclared a few lines down) — recompute
        // from `f` directly rather than reference the identifier, which TDZs for the whole block.
        divertUnreadableBootLatch(f, f.slice(0, f.indexOf(".json.tmp-safety-")), readErrorCode, "SAFETY-TMP residue");
        continue;
      }
      // A corrupt safety-tmp should never normally happen (we write it ourselves) — leave it AS WRITTEN
      // rather than guess at its content; a human can investigate, same posture as any other unreadable
      // residue in this file.
      // eslint-disable-next-line no-console
      console.error(`[merge-quarantine] boot-time SAFETY-TMP residue ${f} is CORRUPT/unreadable (${(e as Error).message}) — leaving it AS WRITTEN; this is unexpected since Loom writes these itself.`);
      // @decision 97cff6db (round 3 minor 3; round 4 minor 2) — mirror deferredCorruptJsons'/
      // deferredCorruptTmps' FULL fallback cascade (hashToRepo, unresolvedClaimantsByHash,
      // ancestorHashToRepo, then orphanFilenames), not just the first tier.
      const hash = f.slice(0, f.indexOf(".json.tmp-safety-"));
      // @decision 4783df46 (card f118b475) — a walked-up LEGACY match still arms at `key`, never diverts
      // (divert only delays the same false positive via lazy graduation). The ancestor-only tier further
      // below is UNCHANGED (f5c42043) — always a pure pending-divert.
      const resolveAndArm = (matchedRepo: string) => {
        if (!isRepoPathCurrentlyResolvable(matchedRepo)) {
          const placeholder: MergeQuarantineEntry = {
            repoPath: matchedRepo, branch: PLACEHOLDER_BRANCH_CORRUPT,
            reason: `boot found a CORRUPT/unreadable SAFETY-TMP residue (${f}) matching this repo's hash, while ${matchedRepo} did not currently resolve — fail-closed rather than risk discarding a real quarantine, but not armed under any walked-up key`,
            enteredAt: Date.now(), tokens: [randomUUID()], placeholder: true,
          };
          pendingUnresolvedQuarantines.push({ entry: placeholder, sourceFile: f });
          return;
        }
        const key = canonicalRepoLockKey(matchedRepo);
        const verified = legacyMatchStillResolvesToHash(key, hash);
        if (!verified) {
          // eslint-disable-next-line no-console
          console.warn(`[merge-quarantine] boot-time SAFETY-TMP residue ${f} is CORRUPT/unreadable and matches registered repo ${matchedRepo}'s own LEGACY (direct-path) identity, but ${matchedRepo}'s current canonical key ${key} no longer hashes to this file (walked up, or a pre-7673d096 subdir binding) — fail-closed by arming ${key} anyway rather than risk discarding a real quarantine, but this is NOT a verified match for whatever currently owns ${key}; marking provenanceUnknown.`);
        }
        const placeholder: MergeQuarantineEntry = {
          repoPath: matchedRepo, branch: PLACEHOLDER_BRANCH_CORRUPT,
          reason: verified
            ? `boot found a CORRUPT/unreadable SAFETY-TMP residue (${f}) matching this repo's hash — fail-closed rather than risk discarding a real quarantine`
            : `boot found a CORRUPT/unreadable SAFETY-TMP residue (${f}) matched only by a legacy (direct-path) identity — ${matchedRepo}'s own direct-path identity matches this file's hash, but its current canonical key no longer does (walked up, or a pre-7673d096 subdir binding); fail-closed by arming its current key (${key}) anyway, but this is NOT a verified match for whatever currently owns it`,
          enteredAt: Date.now(), tokens: [randomUUID()], placeholder: true,
          provenanceUnknown: verified ? undefined : true,
        };
        // @decision d163aef5 — `matchedRepo` is resolvable (gated above), so this placeholder's own
        // primary arm is tautological too — never diverts `entry`, only ever evicts an illegitimate
        // degraded prior.
        armCurrentKeyUnlessDegradedCollision(key, placeholder);
        // @decision 97cff6db — track this key for the shared end-of-boot write/unlink pass below (never
        // a new inline write, 882d6cff). Keyed by `f`: multiple claimants sharing one `f` would keep
        // only the last resolvable one — unreachable today (unresolvable by construction) unless one turns resolvable mid-boot.
        safetyTmpRecoveryByFile.set(f, key);
        // @decision 97cff6db (round 3, finding E; card f118b475) — mirrors the clean-parse branch above:
        // a degraded-occupied key's own file is some OTHER entry's exclusive backing, so give `f` its
        // OWN self-referencing pending entry — or clearing that occupant durably unblocks `matchedRepo`.
        if (degradedOccupiedKeys.has(key)) {
          pendingUnresolvedQuarantines.push({
            entry: { ...placeholder, orphanLatchFiles: [...new Set([...(placeholder.orphanLatchFiles ?? []), f])] },
            sourceFile: f,
          });
        }
      };
      const matchedRepo = hashToRepo.get(hash);
      const claimants = matchedRepo ? undefined : unresolvedClaimantsByHash.get(hash);
      if (matchedRepo) {
        resolveAndArm(matchedRepo);
      } else if (claimants && claimants.length > 0) {
        for (const claimant of claimants) resolveAndArm(claimant);
      } else if ((ancestorHashToRepo().get(hash)?.length ?? 0) > 0) {
        // @decision f5c42043 — an ancestor-walk-only match is never proof of ownership: divert to
        // pending for EACH claimant, never arm/write at this hash for any of them. UNCHANGED by f118b475.
        for (const claimant of ancestorHashToRepo().get(hash)!) {
          const placeholder: MergeQuarantineEntry = {
            repoPath: claimant, branch: PLACEHOLDER_BRANCH_CORRUPT,
            reason: `boot found a CORRUPT/unreadable SAFETY-TMP residue (${f}) whose hash matches an ANCESTOR-walk key for registered repo ${claimant} — never a verified identity for ${claimant} itself, so it is NOT armed/written at any key`,
            enteredAt: Date.now(), tokens: [randomUUID()], placeholder: true,
          };
          pendingUnresolvedQuarantines.push({ entry: placeholder, sourceFile: f });
        }
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
    // @decision 97cff6db (Follow-up 38032559, item 2) — check degradedOccupiedKeys FIRST, ahead of
    // allBootWriteTargets: this refusal is UNCONDITIONAL, so ordering it first fixes the text at every
    // site without touching Phase 0's own inputs — mirrors ef651188 (nit 4)'s identical precedent.
    if (degradedOccupiedKeys.has(targetKey)) {
      // eslint-disable-next-line no-console
      console.error(`[merge-quarantine] refusing to write ${targetBasename} for ${entry.repoPath} — this key is occupied by a DIFFERENT, currently-unresolvable entry's own trusted resolvedKey; overwriting it would destroy that entry's only backing file. ${entry.repoPath} stays enforced in-memory only for this process.`);
      return false;
    }
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
    //
    // @decision 702b4241 (round 2) — reconcile a MARKED target HERE, externally, then sync `byRepoKey`
    // to match — writeMergeQuarantineLatch's own internal reconcile never propagates back to this
    // chokepoint's caller, so memory can otherwise go stale the instant the kept mark clears on success.
    let toWrite = entry;
    let reconciledAlready = false;
    // @decision 2dd97aaa (Follow-up 58957b1e) — a boot write only ever reconciles/arms; it never drops a
    // token on this entry's own behalf.
    if (keptUnreadableLatchFiles.has(targetBasename)) {
      const reconciled = foldInOnDiskTokensIfMarked(quarantinePathForKey(targetKey), entry, new Set());
      if (reconciled === "unreadable") {
        // eslint-disable-next-line no-console
        console.warn(`[merge-quarantine] refusing to write ${targetBasename} for ${entry.repoPath} — it is STILL unreadable right now; the kept mark and the in-memory entry both stay unchanged, to be retried on a later write/boot.`);
        return false;
      }
      if (reconciled !== entry) replaceEntryEverywhere(byRepoKey, entry, reconciled);
      toWrite = reconciled;
      reconciledAlready = true;
    }
    const ok = writeMergeQuarantineLatch(toWrite, new Set(), false, targetKey, true, reconciledAlready);
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
    const hash = f.slice(0, f.indexOf(".json.tmp-"));
    // @decision 4783df46 — a walked-up LEGACY match still arms at `key` (never diverts); it only gains
    // `provenanceUnknown` below. See `legacyMatchStillResolvesToHash`'s own doc and the decision record.
    const verified = legacyMatchStillResolvesToHash(key, hash);
    if (existing && !isPlaceholderEntryShape(existing)) {
      // Real data already covers this key — the corrupt tmp carries nothing recoverable and is not a
      // fail-closed risk. Fold it into the SAME unlink list so it's swept once that key's real union
      // write (below) durably succeeds — bde5d1fe's rule (a sweep follows a superseding write, never
      // precedes or replaces one) — rather than left behind as permanent, unexplained residue.
      // @decision 97cff6db (Follow-up 38032559, finding 1b) — never leave this residue's own
      // originalEntryBySource slot unset: Phase 2's degraded fold then falls back to the shared
      // occupant, whose identity can be a different, unrelated degraded key's own exclusive backing.
      if (!originalEntryBySource.has(path.basename(tmpPath))) {
        originalEntryBySource.set(path.basename(tmpPath), {
          repoPath: matchedRepo, branch: PLACEHOLDER_BRANCH_CORRUPT,
          reason: `boot found a CORRUPT/unparsable torn-write quarantine latch (${f}) matching this repo's hash, with real sibling data already covering the key — this is a standalone protective record for the residue itself, never armed under any key`,
          enteredAt: Date.now(), tokens: [randomUUID()], placeholder: true,
          provenanceUnknown: verified ? undefined : true,
        });
      }
      const list = tmpsToUnlinkByKey.get(key) ?? [];
      list.push(tmpPath);
      tmpsToUnlinkByKey.set(key, list);
      continue;
    }
    if (!verified) {
      // eslint-disable-next-line no-console
      console.warn(`[merge-quarantine] boot-time tmp latch ${f} is CORRUPT/unparsable and matches registered repo ${matchedRepo}'s own LEGACY (direct-path) identity, but ${matchedRepo}'s current canonical key ${key} no longer hashes to this file (walked up, or a pre-7673d096 subdir binding) — fail-closed by arming ${key} anyway rather than risk discarding a real quarantine, but this is NOT a verified match for whatever currently owns ${key}; marking provenanceUnknown.`);
    }
    const entry: MergeQuarantineEntry = {
      repoPath: matchedRepo, branch: PLACEHOLDER_BRANCH_CORRUPT,
      reason: verified
        ? `boot found a CORRUPT/unparsable torn-write quarantine latch (${f}) matching this repo's hash, with no real sibling data — fail-closed rather than risk discarding a real quarantine`
        : `boot found a CORRUPT/unparsable torn-write quarantine latch (${f}) matched only by a legacy (direct-path) identity — ${matchedRepo}'s own direct-path identity matches this file's hash, but its current canonical key no longer does (walked up, or a pre-7673d096 subdir binding); fail-closed by arming its current key (${key}) anyway, but this is NOT a verified match for whatever currently owns it`,
      enteredAt: Date.now(), tokens: [randomUUID()], placeholder: true,
      provenanceUnknown: verified ? undefined : true,
    };
    // @decision d163aef5 — `matchedRepo` is resolvable (gated above), so this placeholder's own primary
    // arm is tautological too — never diverts `entry`, only ever evicts an illegitimate degraded prior.
    const armed = armCurrentKeyUnlessDegradedCollision(key, entry);
    byRepoKey.set(key, armed);
    // @decision 97cff6db (Follow-up 38032559, finding 1) — mirrors resolveAndArm's own self-reference:
    // give `f` its OWN pending entry, built from the PRE-union `entry`, self-referencing `f` — or
    // clearing the degraded occupant durably unblocks `matchedRepo`. See the decision record.
    if (degradedOccupiedKeys.has(key)) {
      pendingUnresolvedQuarantines.push({
        entry: { ...entry, orphanLatchFiles: [...new Set([...(entry.orphanLatchFiles ?? []), f])] },
        sourceFile: f,
      });
    }
    // eslint-disable-next-line no-console
    console.error(`[merge-quarantine] boot-time tmp latch ${f} is CORRUPT/unparsable with no real sibling data recovered for registered repo ${matchedRepo} — quarantining THAT repo rather than risk discarding a real quarantine (bootWriteLatch may still refuse — see its own log line above/below for why).`);
    if (bootWriteLatch(key, armed)) {
      // @decision 4783df46 (CR MAJOR) — delete the now-superseded corrupt tmp `f` immediately, never
      // deferred (unlike the json site's stale source, `f`'s pid-suffixed name can't collide with
      // another key's write target this pass) — see the decision record for the leak this closes.
      if (!deleteSourceLatchIfSuperseded(f, armed, key)) {
        const folded: MergeQuarantineEntry = { ...armed, orphanLatchFiles: [...new Set([...(armed.orphanLatchFiles ?? []), f])] };
        replaceEntryEverywhere(byRepoKey, armed, folded);
        if (!bootWriteLatch(key, folded)) {
          // eslint-disable-next-line no-console
          console.error(`[merge-quarantine] could not re-persist ${folded.repoPath} after its own superseded corrupt tmp (${f}) failed to unlink — it stays on disk, UNTRACKED by this entry's own bookkeeping in THIS process; a restart may re-arm this quarantine from it.`);
        }
      }
    } else {
      // @decision 97cff6db (Follow-up 38032559, item 4) — degraded-occupied is NOT the "will not
      // survive" case: finding 1's self-reference means `f` re-derives enforcement next boot regardless.
      // eslint-disable-next-line no-console
      console.error(degradedOccupiedKeys.has(key)
        ? `[merge-quarantine] fail-closed quarantine for ${matchedRepo} (matched-corrupt tmp latch ${f}) could NOT be durably written this boot because its key is degraded-occupied — this is EXPECTED and recoverable: ${f} itself (left untouched, self-referenced) re-derives the same enforcement on the next boot without this process's own in-memory state.`
        : `[merge-quarantine] fail-closed quarantine for ${matchedRepo} (matched-corrupt tmp latch ${f}) could NOT be durably persisted this boot — it will NOT survive another restart until this is fixed.`);
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

  // @decision 8db913e2 (Follow-up 8bff3cae) — resolve every deferred stale-key candidate only NOW, with
  // every OTHER kind of arm already settled and before any migrate-pass write below — see the decision
  // record for why this exact point (an occupied key is left to its own owner; an unclaimed one is armed).
  for (const { currentKey, staleKey } of staleKeyRetentionCandidates) {
    if (byRepoKey.has(staleKey)) continue;
    const occupant = byRepoKey.get(currentKey);
    if (!occupant) continue;
    const armed = armKeyUnlessDegradedCollision(staleKey, occupant, false);
    if (armed !== undefined) byRepoKey.set(currentKey, armed);
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
            // @decision 97cff6db (Follow-up 38032559, finding 1b) — round 5's own rule, mirrored here:
            // self-reference `sourceFile` into orphanLatchFiles too — sweepTmpResidueForHashIfUnreferenced
            // reads only that field, never a bare pending `sourceFile`.
            const protectiveEntry = originalEntryBySource.get(sourceFile) ?? occupant;
            pendingUnresolvedQuarantines.push({
              entry: { ...protectiveEntry, orphanLatchFiles: [...new Set([...(protectiveEntry.orphanLatchFiles ?? []), sourceFile])] },
              sourceFile,
            });
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
    // @decision 8db913e2 (Follow-up 1e739f4a) — never overwrite an ALREADY-INFORMATIVE
    // `unionEntry.resolvedKey` with the self-referential promote key: that durably drops a genuine
    // cross-repo dual-arm the instant any tmp residue for this key is promoted, even when nothing was wrong.
    const armedForWrite: MergeQuarantineEntry = isInformativeKey(unionEntry, key) ? unionEntry : { ...unionEntry, resolvedKey: key };
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
      // @decision 4783df46 (card f118b475) — route through the same protected delete + fold-on-failure
      // the json/tmp sibling sites use (load-bearing per that record's own CR), not a bare best-effort
      // unlink — a genuine non-ENOENT failure must fold `f` into orphanLatchFiles or lose it silently.
      if (!deleteSourceLatchIfSuperseded(f, unionEntry, key)) {
        const folded: MergeQuarantineEntry = { ...unionEntry, orphanLatchFiles: [...new Set([...(unionEntry.orphanLatchFiles ?? []), f])] };
        replaceEntryEverywhere(byRepoKey, unionEntry, folded);
        if (!bootWriteLatch(key, folded)) {
          // eslint-disable-next-line no-console
          console.error(`[merge-quarantine] could not re-persist ${folded.repoPath} after its own superseded SAFETY-TMP residue (${f}) failed to unlink — it stays on disk, UNTRACKED by this entry's own bookkeeping in THIS process; a restart may re-arm/recover it.`);
        }
      }
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
