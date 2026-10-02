import fs from "node:fs";
import path from "node:path";
import { LOOM_HOME } from "../paths.js";
import { realCodexHome } from "./codex-doctrine.js";

/**
 * Card `b8124a1f` bounds the otherwise-unbounded `~/.codex/sessions` corpus by MOVING old rollout
 * files out to a Loom-owned archive tree, byte-for-byte — never deleting, compressing, or
 * transforming content. The move is TRANSPARENT to every LOOM reader:
 * `codex-transcript.ts#resolveTranscriptFile` scans this archive root as a fallback after the live
 * `sessions/` tree, so an archived rollout is exactly as readable/resumable as a live one for
 * worker_transcript reads, exit-time `snapshotTranscript`, `sessions/scratch-gc.ts`'s resumability
 * check, and `sessions/liveness.ts`'s watcher's own re-check — all route through that one function (see
 * its own doc for the enumeration). That transparency is WHY this sweep does not need to prove a
 * candidate belongs to no live-or-resumable session before moving it: even a "wrong" move (a session
 * that turns out to still be resumable) keeps Loom's OWN view working identically, just via one extra
 * directory-tree scan location.
 *
 * ⚠️ CORRECTED (card `5172fe3a`, real-spawn-confirmed — this sentence used to claim the transparency
 * above "degrades NOTHING", full stop; that was FALSE): it covers Loom's own readers only. The REAL
 * `codex` CLI's own `resume <uuid>` lookup never goes through `resolveTranscriptFile` at all — it
 * resolves the rollout some other way (its error message on a real, confirmed-reproduced failure cited
 * the exact original absolute path, consistent with `~/.codex/thread_history_1.sqlite` being an index
 * over rollout files rather than a live directory re-scan). A real spawn against a relocated-but-intact
 * rollout file failed HARD: `thread/resume failed: no rollout found for thread id <uuid> (code -32600)`,
 * process exit code 1 — not a graceful fallback, not a silently-blank fresh conversation. See
 * `restoreArchivedCodexRollout` below, and its sole call site (`pty/host.ts#createCodexPty`, gated on
 * `buildCodexResumeArgs(opts).length > 0` — the one decision point for whether `resume <uuid>` can ever
 * appear in a codex spawn's argv) — every `codex resume <uuid>` is restored back to its EXACT original
 * live path immediately before that argv is built, closing exactly the gap this correction describes.
 *
 * @decision b8124a1f — archive, never delete (owner decision, request 15bd0464): old rollouts move
 * byte-for-byte to a Loom-owned tree, and every LOOM reader stays transparent via the fallback scan.
 *
 * ⚠️ WHAT THIS DELIBERATELY DOES NOT TOUCH: `snapshotExistingConversationIdsForSpawn` and
 * `findConversationIdForSpawn` (`codex-transcript.ts`) — the ACTUAL synchronous codex-spawn hot path —
 * both scan ONLY the live `sessions/` tree and are UNCHANGED by this file. Bounding the live tree's
 * file count is the entire point (the corpus those two hot-path functions walk shrinks, so a growing
 * host gets a bounded — not ever-increasing — per-spawn scan cost), not something to widen back out by
 * also teaching them the archive root.
 *
 * ## THE THRESHOLD, AND WHY IT CANNOT CATCH A LIVE-OR-RESUMABLE ROLLOUT
 * A candidate is selected by FILESYSTEM mtime age alone ({@link CODEX_ROLLOUT_ARCHIVE_AGE_MS}), never
 * by consulting Loom's own `sessions` DB — deliberately, for two independent reasons:
 *  1. A LIVE codex process appends to its rollout file as the conversation progresses (`session_meta`
 *     first, then every subsequent event/message — see `codex-transcript.ts`'s own header), so its
 *     mtime is refreshed well inside any plausible single-turn duration. The chosen age (3 days) is
 *     many orders of magnitude past that — a live session's file is never this stale while still live.
 *  2. A RESUMABLE-BUT-IDLE session (stopped, not live, but not yet garbage-collected — Loom keeps a
 *     stopped session resumable indefinitely; see project memory
 *     `stopped-sessions-auto-archive-off-the-live-rail`) has NO natural upper bound on how long it can
 *     sit idle before someone resumes it. An age threshold alone CANNOT rule this case out. This is
 *     exactly why correctness here rests on the transparent-fallback read path above, never on the
 *     threshold — the threshold's only job is bounding the LIVE tree's size (disk + hot-path-adjacent
 *     scan cost), never gatekeeping correctness.
 * Roughly 124-139 files/day on the two full days observed, consistent with `3795232e`'s "~135/day
 * full-span" figure and below its "~297/day recent-window" one. NEITHER of those two rates is treated
 * as stable here (that card's own caveat) — this constant instead keeps the LIVE tree at a small,
 * roughly-constant multiple of one day's growth regardless of which rate turns out to hold, rather
 * than being tuned to either figure.
 */
export const CODEX_ROLLOUT_ARCHIVE_AGE_MS =
  Number(process.env.LOOM_CODEX_ROLLOUT_ARCHIVE_AGE_MS) || 3 * 24 * 60 * 60 * 1000; // 3 days

/** Computed fresh on every call, never cached at module load — mirrors `codex-transcript.ts#codexSessionsRoot`'s
 *  own reasoning (a test setting `CODEX_HOME` before calling gets genuine isolation). */
const codexSessionsRoot = () => path.join(realCodexHome(), "sessions");

/**
 * Root of Loom's own codex-rollout archive — mirrors the live tree's own `YYYY/MM/DD/<file>.jsonl`
 * layout exactly, so a move here is a PURE relocation (no rename, no re-encoding): restoring a
 * specific archived rollout is moving `<archiveRoot>/YYYY/MM/DD/<file>` back to
 * `<sessionsRoot>/YYYY/MM/DD/<file>`, byte-identical to the original. Computed fresh on every call
 * (never cached at module load), same test-isolation reasoning as {@link codexSessionsRoot}.
 */
export function codexRolloutArchiveRoot(): string {
  return path.join(LOOM_HOME, "codex-rollout-archive");
}

export interface CodexRolloutArchiveResult {
  /** `.jsonl` files considered under the live `sessions/` tree. */
  scanned: number;
  /** Relative `YYYY/MM/DD/<file>` paths actually moved to the archive root. */
  archived: string[];
  /** Relative `YYYY/MM/DD/<file>` paths whose move failed (left in place — never partially moved; see
   *  {@link moveFile}'s own doc). */
  failed: string[];
}

/** Injectable seam for tests — mirrors `ScratchGcDeps`'s own convention (`sessions/scratch-gc.ts`).
 *  Real callers (the boot wiring in `index.ts`) never pass any of these. */
export interface CodexRolloutArchiveDeps {
  nowMs?: number;
  ageMs?: number;
  sessionsRoot?: string;
  archiveRoot?: string;
}

/**
 * Move one rollout file, tolerating a CROSS-DEVICE archive root (`LOOM_HOME` and `CODEX_HOME` are
 * independently configurable and may live on different volumes) — `fs.renameSync` fails `EXDEV` in
 * that case, so fall back to copy-then-delete via a same-directory temp file + atomic rename into
 * place (mirrors `codex-transcript.ts#snapshotTranscript`'s own atomic-publish dance). The source is
 * removed ONLY as the last step, after the copy is durably in place at `dest` — a mid-copy failure
 * throws before `fs.unlinkSync` ever runs, leaving the original untouched rather than orphaned, and
 * `dest` is never left partially written (the temp-then-rename step either fully succeeds or `dest` is
 * never created).
 */
function moveFile(src: string, dest: string): void {
  try {
    fs.renameSync(src, dest);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "EXDEV") throw err;
  }
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  fs.copyFileSync(src, tmp);
  fs.renameSync(tmp, dest);
  fs.unlinkSync(src);
}

/**
 * Boot-only, best-effort sweep of `~/.codex/sessions` — move any rollout `.jsonl` file whose mtime is
 * older than {@link CODEX_ROLLOUT_ARCHIVE_AGE_MS} into {@link codexRolloutArchiveRoot}, preserving its
 * `YYYY/MM/DD` position exactly. See this file's header doc for why this never needs to prove a
 * candidate is safe against a live-or-resumable session before moving it. Never throws for an
 * individual file (a failed move is recorded in `failed` and the source is left exactly as it was — an
 * archive attempt can never destroy or corrupt a rollout); a missing `sessions/` root (no codex use
 * yet on this host) is the expected, silent zero-result case.
 *
 * @decision 5172fe3a — this sweep cannot race {@link restoreArchivedCodexRollout}: its one call site
 * (index.ts boot) runs synchronously, strictly before the gateway listener opens, and every restore path
 * requires that listener. Proven structurally by test/codex-archive-sweep-precedes-listen.mjs.
 */
export function archiveOldCodexRollouts(deps: CodexRolloutArchiveDeps = {}): CodexRolloutArchiveResult {
  const result: CodexRolloutArchiveResult = { scanned: 0, archived: [], failed: [] };
  const nowMs = deps.nowMs ?? Date.now();
  const ageMs = deps.ageMs ?? CODEX_ROLLOUT_ARCHIVE_AGE_MS;
  const sessionsRoot = deps.sessionsRoot ?? codexSessionsRoot();
  const archiveRoot = deps.archiveRoot ?? codexRolloutArchiveRoot();

  let years: string[];
  try {
    years = fs.readdirSync(sessionsRoot);
  } catch {
    return result; // no sessions root yet — nothing to archive
  }
  for (const year of years) {
    const yearDir = path.join(sessionsRoot, year);
    let months: string[];
    try { months = fs.readdirSync(yearDir); } catch { continue; }
    for (const month of months) {
      const monthDir = path.join(yearDir, month);
      let days: string[];
      try { days = fs.readdirSync(monthDir); } catch { continue; }
      for (const day of days) {
        const dayDir = path.join(monthDir, day);
        let files: string[];
        try { files = fs.readdirSync(dayDir); } catch { continue; }
        for (const f of files) {
          if (!f.endsWith(".jsonl")) continue;
          result.scanned++;
          const src = path.join(dayDir, f);
          const rel = path.join(year, month, day, f);
          let mtimeMs: number;
          try { mtimeMs = fs.statSync(src).mtimeMs; } catch { continue; } // vanished mid-scan — skip
          if (nowMs - mtimeMs < ageMs) continue; // still within the live window
          const dest = path.join(archiveRoot, year, month, day, f);
          try {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            moveFile(src, dest);
            result.archived.push(rel);
          } catch (err) {
            result.failed.push(rel);
            // eslint-disable-next-line no-console
            console.warn(`[codex-rollout-archive] failed to archive ${src}: ${(err as Error)?.message ?? String(err)}`);
          }
        }
      }
    }
  }
  return result;
}

/** Walk one `YYYY/MM/DD`-shaped root looking for a `.jsonl` file whose name contains `conversationId`.
 *  Duplicates `codex-transcript.ts#scanForConversationId`'s own tree-walk shape rather than importing it
 *  — that file already imports {@link codexRolloutArchiveRoot} from here, so the reverse import would be
 *  circular. Returns both the absolute path and its `YYYY/MM/DD/<file>` path relative to `root`, since
 *  {@link restoreArchivedCodexRollout} needs the latter to reconstruct the EXACT original live path. */
function findRolloutByConversationId(root: string, conversationId: string): { full: string; rel: string } | null {
  try {
    for (const year of fs.readdirSync(root)) {
      const yearDir = path.join(root, year);
      let months: string[];
      try { months = fs.readdirSync(yearDir); } catch { continue; }
      for (const month of months) {
        const monthDir = path.join(yearDir, month);
        let days: string[];
        try { days = fs.readdirSync(monthDir); } catch { continue; }
        for (const day of days) {
          const dayDir = path.join(monthDir, day);
          let files: string[];
          try { files = fs.readdirSync(dayDir); } catch { continue; }
          const hit = files.find((f) => f.endsWith(".jsonl") && f.includes(conversationId));
          if (hit) return { full: path.join(dayDir, hit), rel: path.join(year, month, day, hit) };
        }
      }
    }
  } catch { /* root missing — nothing to find */ }
  return null;
}

export interface RestoreArchivedCodexRolloutResult {
  /** true iff a rollout for this conversation id now sits at its live path — either moved there by this
   *  call, or already present before it (see `alreadyLive`). false iff no archived copy exists for this
   *  id at all (nothing to restore — the caller proceeds exactly as before this card). */
  restored: boolean;
  /** true iff the LIVE path already held a rollout for this id BEFORE this call. The archive (if a copy
   *  also exists there) is left completely untouched in that case — never overwritten, never deleted —
   *  per the "don't clobber a live file" rule (card 5172fe3a). */
  alreadyLive: boolean;
}

/**
 * The inverse of {@link archiveOldCodexRollouts}, for exactly ONE conversation: move its rollout file
 * back from {@link codexRolloutArchiveRoot} to its EXACT original `YYYY/MM/DD/<file>` path under the
 * live `sessions/` root — byte-identical (same {@link moveFile}), never a reconstruction. Called from
 * `pty/host.ts#createCodexPty`, the sole chokepoint for every `codex resume <uuid>` spawn (see this
 * file's header doc) — a real spawn proved the codex CLI cannot resume an archived rollout on its own.
 *
 * Never overwrites a live file: if a rollout for this id is already at the live path, this is a pure
 * no-op (`alreadyLive: true`) — the archived copy, if one exists, is left exactly as it was. If a move
 * genuinely fails (I/O error), this THROWS rather than swallowing — the caller must fail the resume
 * loudly rather than spawn codex into a guaranteed "no rollout found" crash with a far more confusing
 * error. See `docs/decisions/5172fe3a-codex-rollout-archiver-cannot-race-a-restore.md` for why the
 * {@link archiveOldCodexRollouts} boot sweep can never race this call.
 */
export function restoreArchivedCodexRollout(conversationId: string, deps: CodexRolloutArchiveDeps = {}): RestoreArchivedCodexRolloutResult {
  const sessionsRoot = deps.sessionsRoot ?? codexSessionsRoot();
  const archiveRoot = deps.archiveRoot ?? codexRolloutArchiveRoot();

  if (findRolloutByConversationId(sessionsRoot, conversationId)) {
    return { restored: true, alreadyLive: true };
  }
  const archivedHit = findRolloutByConversationId(archiveRoot, conversationId);
  if (!archivedHit) {
    return { restored: false, alreadyLive: false };
  }
  const dest = path.join(sessionsRoot, archivedHit.rel);
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    moveFile(archivedHit.full, dest);
  } catch (err) {
    throw new Error(`failed to restore archived codex rollout ${archivedHit.full} back to ${dest}: ${(err as Error)?.message ?? String(err)}`);
  }
  return { restored: true, alreadyLive: false };
}
