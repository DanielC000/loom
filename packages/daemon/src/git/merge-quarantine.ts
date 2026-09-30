import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { LOOM_HOME } from "../paths.js";
import { canonicalRepoLockKey } from "./repo-lock.js";

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
  /** Boot-time filenames (not full paths) of the CORRUPT/orphan latch(es) that caused this entry —
   *  `undefined` for an ordinary (non-boot-fail-closed) quarantine. {@link clearMergeQuarantine} deletes an
   *  orphan named here once no OTHER active entry still references it.
   *
   *  @decision 24c0bdba (round 7, M2) — see the decision record for the fail-closed trap this closes (an
   *  orphan latch that nothing ever deleted re-quarantined every registered repo on every later boot). */
  orphanLatchFiles?: string[];
}

const activeQuarantines = new Map<string, MergeQuarantineEntry>();

export const MERGE_QUARANTINE_DIR = path.join(LOOM_HOME, "merge-quarantines");

/** The stable hash component of a quarantine latch's filename for `repoPath` — factored out of
 *  {@link quarantinePathFor} so boot-time re-entry can compute the SAME hash for every REGISTERED repo and
 *  match it against an unparsable latch's filename (round 6, BLOCKER 2) without reconstructing the path. */
function quarantineHashFor(repoPath: string): string {
  const key = canonicalRepoLockKey(repoPath);
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

function quarantinePathFor(repoPath: string): string {
  return path.join(MERGE_QUARANTINE_DIR, `${quarantineHashFor(repoPath)}.json`);
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
 */
function writeMergeQuarantineLatch(entry: MergeQuarantineEntry): boolean {
  let fd: number | undefined;
  try {
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const final = quarantinePathFor(entry.repoPath);
    const tmp = `${final}.tmp-${process.pid}`;
    fd = fs.openSync(tmp, "w");
    fs.writeSync(fd, JSON.stringify(entry, null, 2) + "\n");
    fs.fsyncSync(fd); // round 6 — durable on disk BEFORE the rename makes it visible, not just buffered
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, final);
    return true;
  } catch (e) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already broken; nothing more to close */ } }
    // eslint-disable-next-line no-console
    console.error(`[merge-quarantine] FAILED to durably persist the quarantine latch for ${entry.repoPath} (branch '${entry.branch}'): ${(e as Error).message}`);
    return false;
  }
}

/** Best-effort; a missing file is not an error. Never throws. */
function deleteMergeQuarantineLatch(repoPath: string): void {
  try { fs.unlinkSync(quarantinePathFor(repoPath)); } catch { /* ENOENT is the common case */ }
}

/**
 * Raise (or ADD ANOTHER outstanding raise to) the quarantine for `repoPath` — the canonical repo, ALWAYS
 * (see this module's own header doc for why a batch caller must resolve its canonical repoPath first,
 * never pass its own scratch worktree path). Round 7 (M1): if the repo is ALREADY quarantined, this APPENDS
 * a fresh token to the existing entry's `tokens` SET rather than overwriting it — the original
 * branch/reason/opId/enteredAt are kept (they describe the LONGEST-outstanding, still-unresolved raise),
 * so a second, unrelated raise never erases the first raise's own identity.
 *
 * Returns the fresh token — the caller MUST hold onto it and present it back to
 * {@link clearMergeQuarantineByToken} for its own in-process auto-clear; never guess or reconstruct one.
 */
export function enterMergeQuarantine(repoPath: string, branch: string, reason: string, opId?: string): string {
  const token = randomUUID();
  const key = canonicalRepoLockKey(repoPath);
  const existing = activeQuarantines.get(key);
  const entry: MergeQuarantineEntry = existing
    ? { ...existing, tokens: [...existing.tokens, token] }
    : { repoPath, branch, reason, opId, enteredAt: Date.now(), tokens: [token] };
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
  activeQuarantines.set(key, updated);
  if (!writeMergeQuarantineLatch(updated)) {
    // eslint-disable-next-line no-console
    console.error(`[merge-quarantine] could not durably persist the reduced token set for ${repoPath} after a partial clear — a restart before this is fixed would re-arm with the just-cleared token STILL counted as outstanding (harmless: it only delays the eventual full lift, never a false lift).`);
  }
}

/**
 * UNCONDITIONAL clear for `repoPath` — empties the WHOLE outstanding-token set at once (round 7, M1).
 * Called from exactly two places: (1) the human-only loopback REST route
 * (`POST /internal/merge-quarantine/clear`, gateway/server.ts), and (2) internally, once
 * {@link clearMergeQuarantineByToken} empties the token set itself. A RESTORED quarantine (re-entered at
 * boot) can ONLY ever be cleared this way, since the original in-process promise chain(s) that could
 * auto-clear it are gone once the process(es) that held them have exited. Idempotent; a clear on an
 * already-clear repo is a silent no-op.
 *
 * Round 7 (M2): also deletes any {@link MergeQuarantineEntry.orphanLatchFiles} this entry referenced,
 * PROVIDED no OTHER still-active entry references the same orphan filename — closing the trap where an
 * unmatched corrupt latch quarantined every registered repo and NOTHING ever deleted the orphan file
 * itself, so every later boot re-quarantined everything again even after a human cleared each repo by hand.
 */
export function clearMergeQuarantine(repoPath: string): void {
  const key = canonicalRepoLockKey(repoPath);
  const entry = activeQuarantines.get(key);
  activeQuarantines.delete(key);
  deleteMergeQuarantineLatch(repoPath);
  if (!entry?.orphanLatchFiles?.length) return;
  for (const orphanFile of entry.orphanLatchFiles) {
    const stillReferenced = [...activeQuarantines.values()].some((e) => e.orphanLatchFiles?.includes(orphanFile));
    if (stillReferenced) continue;
    try {
      fs.unlinkSync(path.join(MERGE_QUARANTINE_DIR, orphanFile));
      // eslint-disable-next-line no-console
      console.log(`[merge-quarantine] deleted orphan latch ${orphanFile} — no remaining quarantine entry references it.`);
    } catch { /* already gone, or never existed under that exact name — either way, nothing left to do */ }
  }
}

export function activeMergeQuarantineFor(repoPath: string): MergeQuarantineEntry | undefined {
  return activeQuarantines.get(canonicalRepoLockKey(repoPath));
}

/** Diagnostic snapshot only (e.g. a status endpoint) — never used to decide anything itself. */
export function listActiveMergeQuarantines(): MergeQuarantineEntry[] {
  return [...activeQuarantines.values()];
}

/**
 * THE one shared refusal check every canonical-mutating entry point on the merge/batch path calls — never
 * re-derive this by hand at a call site. Read-only; raising/clearing a quarantine is always a SEPARATE,
 * explicit call (this never mutates state itself).
 */
export function assertRepoNotQuarantined(repoPath: string): { ok: true } | { ok: false; reason: string } {
  const q = activeMergeQuarantineFor(repoPath);
  if (!q) return { ok: true };
  return {
    ok: false,
    reason: `canonical repo is QUARANTINED after an earlier merge's git process tree could not be confirmed dead ` +
      `(branch '${q.branch}'${q.opId ? `, op ${q.opId}` : ""}, entered ${new Date(q.enteredAt).toISOString()}): ${q.reason} — ` +
      `refusing further canonical-repo mutations here until that kill is confirmed dead (auto-clears, same process only) ` +
      `or a human clears it: POST /internal/merge-quarantine/clear`,
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
    const entry: MergeQuarantineEntry = {
      repoPath, branch: "(unknown — boot could not resolve which repo/branch this protects)",
      reason, enteredAt: Date.now(), tokens: [randomUUID()],
    };
    activeQuarantines.set(canonicalRepoLockKey(repoPath), entry);
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
  const hashToRepo = new Map<string, string>();
  for (const p of registeredRepoPaths) hashToRepo.set(quarantineHashFor(p), p);

  let files: string[];
  // @decision bde5d1fe (item 5) — a leftover `.json.tmp-<pid>` is a write whose fsync completed but whose
  // rename never ran (a crash in that ms window) — collected below and recovered, not silently dropped.
  let tmpFiles: string[];
  try {
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const all = fs.readdirSync(MERGE_QUARANTINE_DIR);
    files = all.filter((f) => f.endsWith(".json"));
    tmpFiles = all.filter((f) => /\.json\.tmp-\d+$/.test(f));
  } catch (e) {
    return quarantineAllRegisteredFailClosed(
      registeredRepoPaths,
      `boot-time quarantine-latch directory scan failed (${(e as Error).message}) — cannot rule out a real quarantine we simply couldn't read`,
    );
  }

  const byRepoKey = new Map<string, MergeQuarantineEntry>();
  const orphanFilenames: string[] = [];
  const orphanReasonParts: string[] = [];

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
      const entry: MergeQuarantineEntry = {
        repoPath: parsed.repoPath, branch: parsed.branch, reason: parsed.reason,
        opId: typeof parsed.opId === "string" ? parsed.opId : undefined,
        enteredAt: typeof parsed.enteredAt === "number" ? parsed.enteredAt : Date.now(),
        tokens,
        orphanLatchFiles: Array.isArray(parsed.orphanLatchFiles) && parsed.orphanLatchFiles.every((s): s is string => typeof s === "string")
          ? parsed.orphanLatchFiles : undefined,
      };
      byRepoKey.set(canonicalRepoLockKey(entry.repoPath), entry);
    } catch (e) {
      // BLOCKER 2 fix: an unparsable/corrupt latch must never fail OPEN (a 0-byte file at boot used to
      // re-arm nothing at all).
      const matchedRepo = hashToRepo.get(hash);
      if (matchedRepo) {
        // eslint-disable-next-line no-console
        console.error(`[merge-quarantine] boot-time latch ${f} is CORRUPT/unparsable (${(e as Error).message}) but its filename hash matches registered repo ${matchedRepo} — quarantining THAT repo rather than risk discarding a real quarantine.`);
        const entry: MergeQuarantineEntry = {
          repoPath: matchedRepo, branch: "(unknown — corrupt boot-time latch)",
          reason: `boot found a CORRUPT/unparsable quarantine latch (${f}: ${(e as Error).message}) matching this repo's hash — fail-closed rather than risk discarding a real quarantine`,
          enteredAt: Date.now(), tokens: [randomUUID()],
        };
        byRepoKey.set(canonicalRepoLockKey(matchedRepo), entry);
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
  for (const f of tmpFiles) {
    const hash = f.slice(0, f.indexOf(".json.tmp-"));
    const tmpPath = path.join(MERGE_QUARANTINE_DIR, f);
    const matchedRepo = hashToRepo.get(hash);
    if (matchedRepo && byRepoKey.has(canonicalRepoLockKey(matchedRepo))) {
      // A proper final `.json` for this repo already loaded cleanly in PASS 1 — this tmp is stale residue
      // from an earlier interrupted write (crash, then a LATER write succeeded); best-effort clean it up.
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
      };
      byRepoKey.set(canonicalRepoLockKey(entry.repoPath), entry);
      // SELF-HEALING: the content was durable (fsync'd) before the crash — promote it to its proper final
      // name, then drop the tmp. A failed promote still leaves the recovered entry ACTIVE in-process.
      if (!writeMergeQuarantineLatch(entry)) {
        // eslint-disable-next-line no-console
        console.error(`[merge-quarantine] recovered a torn-write latch (${f}) for ${entry.repoPath} but could NOT durably re-persist it under its final name — it will NOT survive another restart until this is fixed.`);
      }
      try { fs.unlinkSync(tmpPath); } catch { /* best-effort — a leftover tmp beside a good final write is harmless */ }
      // eslint-disable-next-line no-console
      console.log(`[merge-quarantine] recovered a torn-write quarantine latch (${f}) for ${entry.repoPath} at boot — the crash landed between its fsync and its rename; re-armed under its final name.`);
    } catch (e) {
      // Genuinely unreadable/unparsable tmp content (a crash mid-write, before fsync even completed) —
      // same fail-closed treatment as a corrupt `.json` file: matched hash quarantines that repo, unmatched
      // joins the orphan sweep below.
      if (matchedRepo) {
        // eslint-disable-next-line no-console
        console.error(`[merge-quarantine] boot-time tmp latch ${f} is CORRUPT/unparsable (${(e as Error).message}) but its filename hash matches registered repo ${matchedRepo} — quarantining THAT repo rather than risk discarding a real quarantine.`);
        const entry: MergeQuarantineEntry = {
          repoPath: matchedRepo, branch: "(unknown — corrupt boot-time latch)",
          reason: `boot found a CORRUPT/unparsable torn-write quarantine latch (${f}: ${(e as Error).message}) matching this repo's hash — fail-closed rather than risk discarding a real quarantine`,
          enteredAt: Date.now(), tokens: [randomUUID()],
        };
        byRepoKey.set(canonicalRepoLockKey(matchedRepo), entry);
        if (!writeMergeQuarantineLatch(entry)) {
          // eslint-disable-next-line no-console
          console.error(`[merge-quarantine] fail-closed quarantine for ${matchedRepo} (matched-corrupt tmp latch ${f}) could NOT be durably persisted — it will NOT survive another restart until this is fixed.`);
        }
      } else {
        orphanFilenames.push(f);
        orphanReasonParts.push(`${f}: ${(e as Error).message}`);
      }
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
        byRepoKey.set(key, updated);
        if (!writeMergeQuarantineLatch(updated)) {
          // eslint-disable-next-line no-console
          console.error(`[merge-quarantine] could not durably persist the orphan-file reference on ${repoPath}'s existing quarantine — it will NOT survive another restart until this is fixed.`);
        }
        continue;
      }
      const entry: MergeQuarantineEntry = {
        repoPath, branch: "(unknown — boot could not resolve which repo/branch this protects)",
        reason, enteredAt: Date.now(), tokens: [randomUUID()], orphanLatchFiles: [...orphanFilenames],
      };
      byRepoKey.set(key, entry);
      if (!writeMergeQuarantineLatch(entry)) {
        // eslint-disable-next-line no-console
        console.error(`[merge-quarantine] fail-closed quarantine for ${repoPath} (orphan latch(es) ${orphanFilenames.join(", ")}) could NOT be durably persisted — it will NOT survive another restart until this is fixed.`);
      }
    }
  }

  const out: MergeQuarantineEntry[] = [];
  for (const [key, entry] of byRepoKey) {
    activeQuarantines.set(key, entry);
    out.push(entry);
  }
  return out;
}
