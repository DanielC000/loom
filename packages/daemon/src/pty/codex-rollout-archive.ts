import fs from "node:fs";
import path from "node:path";
import { LOOM_HOME } from "../paths.js";
import { realCodexHome } from "./codex-doctrine.js";

/**
 * Card b8124a1f (owner decision, request `15bd0464`: "Archive-not-delete: Loom compresses/moves old
 * rollouts out of sessions/, never deletes."): bounds the otherwise-unbounded `~/.codex/sessions`
 * corpus (card `3795232e` found NO vendor retention knob for it) by MOVING old rollout files out to a
 * Loom-owned archive tree, byte-for-byte — never deleting, compressing, or transforming content. The
 * move is TRANSPARENT to every reader: `codex-transcript.ts#resolveTranscriptFile` scans this archive
 * root as a fallback after the live `sessions/` tree, so an archived rollout is exactly as readable/
 * resumable as a live one — worker_transcript reads, exit-time `snapshotTranscript`,
 * `sessions/scratch-gc.ts`'s resumability check, and `sessions/liveness.ts`'s watcher's own re-check
 * all route through that one function (see its own doc for the enumeration). That transparency is WHY
 * this sweep does not need to prove a candidate belongs to no live-or-resumable session before moving
 * it: even a "wrong" move (a session that turns out to still be resumable) keeps working identically,
 * just via one extra directory-tree scan location — it degrades NOTHING.
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
 * MEASURED on this host 2026-09-09 (re-measured per the card's own instruction — the corpus has grown
 * since card `3795232e`'s original measurement): 312 files, 18.6MB, spanning 2026-09-06 through
 * 2026-09-09 (the corpus's full lifetime on this host, ~2.5 days) — roughly 124-139 files/day on the
 * two full days observed, consistent with `3795232e`'s "~135/day full-span" figure and below its
 * "~297/day recent-window" one. NEITHER of those two rates is treated as stable here (that card's own
 * caveat) — this constant instead keeps the LIVE tree at a small, roughly-constant multiple of one
 * day's growth regardless of which rate turns out to hold, rather than being tuned to either figure.
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
