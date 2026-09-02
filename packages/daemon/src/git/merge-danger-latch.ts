import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { LOOM_HOME } from "../paths.js";
import { canonicalRepoLockKey } from "./repo-lock.js";

/**
 * DURABLE counterpart to the in-memory tracker in merge-danger-window.ts (board card 5a7692a4). The
 * in-memory tracker answers a LIVE-PROCESS question ("is a merge in my danger window right now") for
 * `gracefulShutdown`'s own bounded wait; it is wiped by a hard death (SIGKILL, power loss, a crash that
 * never reaches any handler) — exactly the case this module exists for.
 *
 * `scanCanonicalReposForMergeResidue` (git/worktrees.ts) already answers a STATE question at every boot —
 * "is the canonical tree dirty right now" — unconditionally, regardless of how the prior process died. It
 * is NOT superseded by this module; this module answers a DIFFERENT, EVENT question it structurally
 * cannot: "did THIS process die inside a merge squash" — which is what lets a boot-time report (1) name
 * the specific repo/branch/op instead of an unattributed dirty tree, indistinguishable from ordinary human
 * WIP (see that scan's own doc: "can't tell a dead squash's leftover stage apart from a human's own WIP"),
 * and (2) say something at all when the tree came back CLEAN — a mid-window death that happened to leave
 * no residue is invisible to a state probe (`status === ""` ⇒ nothing reported) but is still exactly the
 * event a human deserves to hear about ("we exited inside a merge window; tree looks clean").
 *
 * One JSON file per canonical repo path (keyed by a hash of {@link canonicalRepoLockKey}, since a daemon
 * can have several repos each independently mid-squash at once — the per-repo mutex only serializes
 * within one repo), under LOOM_HOME alongside the other daemon-stop classifiers (`last-shutdown.json`,
 * `crash.log`, `restart-intent.json`). Written/removed SYNCHRONOUSLY and NEVER throws — same discipline as
 * shutdown-marker.ts's `writeShutdownMarker`, for the same reason: the write happens on the hot path right
 * before `git merge --squash` (NOT literally the attempt's first mutating git call — see
 * merge-danger-window.ts's own doc on `enterMergeDangerWindow` for why), inside the per-repo mutex, so it
 * must never itself become a reason a merge fails, and it must complete before a signal can kill the
 * process (a synchronous write, not queued behind the event loop, is what makes that true).
 */
export const MERGE_DANGER_LATCH_DIR = path.join(LOOM_HOME, "merge-danger-latches");

function latchPathFor(repoPath: string): string {
  const key = canonicalRepoLockKey(repoPath);
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 24);
  return path.join(MERGE_DANGER_LATCH_DIR, `${hash}.json`);
}

export interface MergeDangerLatchRecord {
  repoPath: string;
  branch: string;
  opId?: string;
  /** ISO timestamp; best-effort — an empty string if `Date` construction itself somehow fails. */
  enteredAt: string;
}

/**
 * Write the latch for `repoPath`, ATOMICALLY (tmp-write + rename, so a kill mid-write leaves either the
 * OLD state or the fully-written NEW one, never a half-written file a later JSON.parse could choke on) —
 * called right before entering the danger region. Overwrites any prior latch for this repo (there should
 * never be one; the per-repo mutex `withCanonicalIndexLock` guarantees only one op is ever inside
 * `mergeBranchLocked` for a given repo at a time). Never throws.
 */
export function writeMergeDangerLatch(repoPath: string, branch: string, opId?: string): void {
  try {
    fs.mkdirSync(MERGE_DANGER_LATCH_DIR, { recursive: true });
    let enteredAt: string;
    try { enteredAt = new Date().toISOString(); } catch { enteredAt = ""; }
    const record: MergeDangerLatchRecord = { repoPath, branch, opId, enteredAt };
    const final = latchPathFor(repoPath);
    const tmp = `${final}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n");
    fs.renameSync(tmp, final);
  } catch {
    /* the latch write must NEVER throw or block a real merge — mirrors writeShutdownMarker's own swallow-
       all discipline. A failed write just means this ONE op gets no durable crash coverage; the merge
       itself, and every other safeguard (the mutex, the entry/staged checks, the boot residue scan), is
       completely unaffected. */
  }
}

/**
 * Remove the latch for `repoPath` — called on EVERY exit from the danger region (success or a handled
 * failure, after that failure's own cleanup has itself settled — see merge-danger-window.ts's `finally`
 * placement, which this rides alongside). Best-effort; a missing file (the common case: nothing to clear
 * yet, or already cleared) is not an error. Never throws.
 */
export function clearMergeDangerLatch(repoPath: string): void {
  try {
    fs.unlinkSync(latchPathFor(repoPath));
  } catch {
    /* ENOENT is the expected common case; any other failure just leaves a stale latch behind, which the
       boot-time read below fails toward VISIBLE on rather than silently, so nothing is lost. */
  }
}

/**
 * Boot-time, CONSUME-ON-READ (read every latch file present, then delete it) — same pattern as
 * shutdown-marker.ts's `readAndClearShutdownMarker`, for the same reason: a latch must never outlive the
 * boot it was meant to be reported on, or a stale leftover could mislabel a LATER, unrelated stop. Called
 * ONCE per boot. Corrupt/unreadable entries are skipped (and still removed) rather than crashing boot.
 * Never throws.
 */
export function readAndClearMergeDangerLatches(): MergeDangerLatchRecord[] {
  try {
    fs.mkdirSync(MERGE_DANGER_LATCH_DIR, { recursive: true });
    const files = fs.readdirSync(MERGE_DANGER_LATCH_DIR).filter((f) => f.endsWith(".json"));
    const out: MergeDangerLatchRecord[] = [];
    for (const f of files) {
      const full = path.join(MERGE_DANGER_LATCH_DIR, f);
      try {
        const raw = fs.readFileSync(full, "utf8");
        const parsed = JSON.parse(raw) as Partial<MergeDangerLatchRecord>;
        if (typeof parsed.repoPath === "string" && typeof parsed.branch === "string") {
          out.push({
            repoPath: parsed.repoPath,
            branch: parsed.branch,
            opId: typeof parsed.opId === "string" ? parsed.opId : undefined,
            enteredAt: typeof parsed.enteredAt === "string" ? parsed.enteredAt : "",
          });
        }
      } catch {
        /* corrupt/unreadable entry — skip it, still remove it below rather than let it linger forever */
      }
      try { fs.unlinkSync(full); } catch { /* best-effort delete */ }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * PURE classification — a latch found at boot, cross-referenced against `scanCanonicalReposForMergeResidue`'s
 * own result (`dirty`, already resolved by the caller — see index.ts's boot sequence, which calls this
 * from inside that scan's own `.then()`), AND against the actual set of repo paths that scan was asked to
 * cover (`scannedRepoPaths`, card b272d215) — `dirty` alone can't distinguish "this repo was scanned and
 * came back clean" from "this repo was never in the scanned set at all" (a project's SECONDARY registry
 * repo omitted from the caller's input list, say), and those two cases must never share a message: the
 * first is a genuine all-clear, the second is a repo nobody actually checked. Extracted as its own function
 * (rather than inlined at the one call site) so it is independently testable without needing to drive the
 * whole daemon boot sequence — see test/merge-danger-latch.mjs. Never throws (pure string formatting over
 * already-validated inputs).
 *
 * Both comparisons key through `canonicalRepoLockKey` rather than raw string equality (card b272d215 DoD-4)
 * — the latch and a `dirty`/`scannedRepoPaths` entry can each name the SAME physical directory with a
 * different case or separator spelling (notably on Windows), and a raw `===` would then silently take the
 * "not this repo" branch for what is actually the same repo.
 *
 * Three branches, matching DoD-2/DoD-3/DoD-2.5:
 *  - The scan found THIS repo STAGED-dirty ⇒ attribute it: this is very likely the dead squash the latch
 *    recorded, not unrelated human WIP — a distinction the scan alone cannot make.
 *  - The repo was never in the scanned set at all ⇒ say so explicitly, rather than falling through to the
 *    clean-tree wording below: "absent from input" and "absent because clean" must not collapse into one
 *    message — a human should still check this repo by hand.
 *  - The repo WAS scanned and came back clean (or unstaged-only) ⇒ DoD-2.5's required sentence: a
 *    mid-window death that happened to leave no residue is still worth reporting, and today (latch-free)
 *    that case is completely silent — `status === ""` from the scan gives it nothing to print.
 */
export function describeMergeDangerLatchAtBoot(
  latch: MergeDangerLatchRecord,
  dirty: Array<{ repoPath: string; staged: boolean }>,
  scannedRepoPaths: Iterable<string>,
): string {
  const enteredMs = Date.parse(latch.enteredAt);
  const ageText = Number.isFinite(enteredMs) ? ` (entered ${Math.round((Date.now() - enteredMs) / 1000)}s before this boot)` : "";
  const opText = latch.opId ? `, op ${latch.opId}` : "";
  const latchKey = canonicalRepoLockKey(latch.repoPath);
  const stagedMatch = dirty.some((d) => canonicalRepoLockKey(d.repoPath) === latchKey && d.staged);
  if (stagedMatch) {
    return `[boot] we exited inside a merge squash on ${latch.repoPath} (branch '${latch.branch}'${opText})${ageText} — this staged residue is VERY LIKELY that dead squash, not WIP; it WILL refuse the next merge attempt until a human resolves it by hand.`;
  }
  const wasScanned = [...scannedRepoPaths].some((p) => canonicalRepoLockKey(p) === latchKey);
  if (!wasScanned) {
    return `[boot] we exited inside a merge window on ${latch.repoPath} (branch '${latch.branch}'${opText})${ageText} — this repo was NOT scanned for residue (absent from the registered canonical repo list), so its tree state is UNKNOWN; a human should check \`git status\`/\`git diff --cached\` there by hand rather than assume it's clean.`;
  }
  return `[boot] we exited inside a merge window on ${latch.repoPath} (branch '${latch.branch}'${opText})${ageText}; tree looks clean — no action needed.`;
}
