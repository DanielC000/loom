import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { LOOM_HOME } from "../paths.js";
import { canonicalRepoLockKey } from "./repo-lock.js";

/**
 * @decision 5a7692a4 — DURABLE counterpart to the in-memory tracker in merge-danger-window.ts, which a
 * hard death wipes; one hash-keyed file per repo. The boot residue scan answers a STATE question (is
 * the tree dirty now), never this file's EVENT question (did THIS process die mid-squash) — it can't substitute.
 *
 * Written/removed SYNCHRONOUSLY and NEVER throws (same discipline as shutdown-marker.ts's
 * `writeShutdownMarker`) — the write lands on the hot path right before `git merge --squash` (NOT
 * literally the attempt's first mutating git call — see merge-danger-window.ts's own doc), inside the
 * per-repo mutex, and must complete before a signal can kill the process; it must never itself fail a merge.
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
 * @decision b272d215 — PURE classification of a latch against `dirty`/`scannedRepoPaths`: `dirty` alone
 * can't tell "scanned and clean" from "never scanned at all" — those two must never share one message;
 * a repo absent from `scannedRepoPaths` gets its own "tree state UNKNOWN" wording, never the clean-tree one.
 * Extracted as its own function so it is independently testable without driving the whole boot
 * sequence — see test/merge-danger-latch.mjs. Never throws (pure string formatting).
 *
 * @decision b272d215 — both comparisons key through `canonicalRepoLockKey`, not raw string equality:
 * the latch and a `dirty`/`scannedRepoPaths` entry can name the SAME directory with a different case
 * or separator spelling (notably on Windows) — a raw `===` would wrongly take the "different repo" branch.
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
