import fs from "node:fs";
import path from "node:path";
import { resolveConfig } from "@loom/shared";
import type { Db } from "../db.js";
import { resolveResumeDocPath } from "../sessions/resume-doc-notes.js";
import { isResumeDocFilename } from "../sessions/platform-lead-prompt.js";

/**
 * Best-effort, non-blocking snapshot of every project's resolved resume doc at daemon boot — before any
 * agent can spawn/resume and touch it — into a sibling `<name>.archive/auto-<ISO>.md`, bounded to the N
 * most recent auto-snapshots. Also covers the Platform Lead's own resume doc(s)
 * (`PLATFORM-LEAD-RESUME.md` / `PLATFORM-LEAD-RESUME-<lineageId>.md`) living in the reserved "Loom
 * Platform" project's vault dir, via its own lookup (`findPlatformLeadResumeDocs` below).
 *
 * @decision 14f14d92 — never overwrite/prune a real rotation archive (only its own `auto-`-prefixed
 * files), and never write an empty snapshot over a good one.
 */

/** How many most-recent `auto-` snapshots to retain per resume doc, pruning older ones.
 *
 *  This fires once per DAEMON BOOT (not periodically like `DbBackupWatcher`, whose own default `keep` of
 *  48 assumes an hourly-ish cadence) — boots are comparatively rare (a dev restart, a deploy), so 20
 *  auto-snapshots comfortably covers weeks-to-months of boot history for a seat that restarts a few times
 *  a week, while keeping the archive dir small (each snapshot is a small markdown file, not a DB dump). */
export const RESUME_DOC_SNAPSHOT_RETAIN = 20;

export interface ResumeDocSnapshotOutcome {
  /** The resolved absolute path of the resume doc this outcome is about. */
  docPath: string;
  outcome: "snapshotted" | "skipped-missing" | "skipped-empty" | "error";
  archivePath?: string;
  prunedCount?: number;
  error?: string;
}

/**
 * Snapshot ONE resume-doc absolute path into its sibling `<name>.archive/auto-<ISO-ts>.md`, then prune
 * old `auto-` snapshots down to `retain`. NEVER throws — every fs call is guarded, since this runs on the
 * boot path where a failure must degrade to a reportable outcome, never abort boot.
 *
 * Skips cleanly (no write at all) when: the doc doesn't exist, isn't a regular file, or is zero bytes —
 * writing an empty/partial snapshot over a good prior one would convert this fix into the very data loss
 * it exists to prevent (card 14f14d92 DoD-4).
 *
 * Copies (never moves) the doc — this is a passive snapshot, not a rotation; the active doc must be left
 * completely untouched. Only ever touches files it itself would have written (the `auto-` prefix) when
 * pruning, so it can never collide with, overwrite, or prune a real rotation archive an agent wrote.
 */
export function snapshotResumeDoc(docPath: string, now: Date = new Date(), retain: number = RESUME_DOC_SNAPSHOT_RETAIN): ResumeDocSnapshotOutcome {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(docPath);
  } catch {
    return { docPath, outcome: "skipped-missing" };
  }
  if (!stat.isFile()) return { docPath, outcome: "skipped-missing" };
  if (stat.size === 0) return { docPath, outcome: "skipped-empty" };

  const dir = path.dirname(docPath);
  const base = path.basename(docPath);
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  const archiveDir = path.join(dir, `${stem}.archive`);
  // ":" is illegal in Windows filenames (mirrors db-backup.ts's snapshotFilename).
  const ts = now.toISOString().replace(/:/g, "-");
  const archivePath = path.join(archiveDir, `auto-${ts}${ext}`);

  try {
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.copyFileSync(docPath, archivePath);
  } catch (err) {
    return { docPath, outcome: "error", error: (err as Error).message };
  }

  const prunedCount = pruneOldAutoSnapshots(archiveDir, retain);
  return { docPath, outcome: "snapshotted", archivePath, prunedCount };
}

/** Keep the newest `retain` `auto-*` files in `archiveDir` (ISO timestamps in the filename sort
 *  chronologically), prune older ones. ONLY ever touches `auto-`-prefixed files — never a real rotation
 *  archive an agent wrote. Best-effort: an unreadable dir or a failed unlink is silently skipped, never
 *  thrown — a prune failure must not fail the snapshot that already succeeded. */
function pruneOldAutoSnapshots(archiveDir: string, retain: number): number {
  if (retain <= 0) return 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(archiveDir);
  } catch {
    return 0;
  }
  const autoFiles = entries.filter((e) => e.startsWith("auto-")).sort();
  const toDelete = autoFiles.length > retain ? autoFiles.slice(0, autoFiles.length - retain) : [];
  let pruned = 0;
  for (const f of toDelete) {
    try {
      fs.unlinkSync(path.join(archiveDir, f));
      pruned++;
    } catch {
      /* best-effort prune */
    }
  }
  return pruned;
}

export interface ResumeDocBootSnapshotSummary {
  projectsChecked: number;
  snapshotted: number;
  skipped: number;
  errors: number;
  outcomes: ResumeDocSnapshotOutcome[];
}

/** Enumerate every Platform Lead resume doc (`PLATFORM-LEAD-RESUME.md` + any per-lineage sibling) living
 *  directly in `homePath`, via the SAME `isResumeDocFilename` pattern `platform-lead-prompt.ts` already
 *  uses for staleness detection — not a second hand-rolled regex that could drift from it. This is what
 *  makes the boot sweep below also cover the reserved "Loom Platform" project's home (`vaultPath ===
 *  LOOM_HOME`, LOOM_DEV-gated) — the EXACT file the 2026-09-05 incident that motivated card 14f14d92 was
 *  about, which the default `Orchestrator Log.md` resolution alone would never match. A no-op (empty
 *  list) for every ordinary project, since none of them contain a file matching this pattern. Never
 *  throws: an unreadable/missing `homePath` is an empty list, not an error.
 */
function findPlatformLeadResumeDocs(homePath: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(homePath);
  } catch {
    return [];
  }
  return entries.filter(isResumeDocFilename).map((name) => path.join(homePath, name));
}

/**
 * Boot-time entry point: snapshot every project's resolved resume doc. Resolves each project's PRIMARY
 * doc via the SAME `resolveResumeDocPath` that `composeManagerStartupPrompt`/`ResumeDocWatcher` use, so
 * this can never snapshot a different file than the one a manager is actually told about — plus any
 * Platform Lead resume doc(s) in that project's vault dir (`findPlatformLeadResumeDocs` above).
 *
 * Best-effort + non-blocking at every layer: one project's failure (a bad config, an unreadable vault
 * dir) degrades to a reported outcome here rather than aborting the sweep; callers still wrap it (see
 * index.ts) as defense-in-depth. It does no more than a handful of small, synchronous fs calls on tiny
 * markdown files, so it adds no meaningful boot latency.
 *
 * @decision 14f14d92 — this function itself never throws; boot correctness outranks this feature
 * absolutely.
 */
export function snapshotAllResumeDocsAtBoot(db: Db, now: Date = new Date()): ResumeDocBootSnapshotSummary {
  const outcomes: ResumeDocSnapshotOutcome[] = [];
  let projectsChecked = 0;
  for (const project of db.listAllProjects()) {
    try {
      if (!project.vaultPath) continue; // no vault bound — mirrors ResumeDocWatcher/startVaultVersioners
      projectsChecked++;
      const docPath = resolveResumeDocPath(project.vaultPath, resolveConfig(project.config).orchestration.resumeDocFilename);
      if (docPath) outcomes.push(snapshotResumeDoc(docPath, now));
      for (const leadDoc of findPlatformLeadResumeDocs(project.vaultPath)) {
        if (leadDoc === docPath) continue; // never double-snapshot the same file under two names
        outcomes.push(snapshotResumeDoc(leadDoc, now));
      }
    } catch (err) {
      outcomes.push({ docPath: `(project ${project.id})`, outcome: "error", error: (err as Error).message });
    }
  }
  const snapshotted = outcomes.filter((o) => o.outcome === "snapshotted").length;
  const errors = outcomes.filter((o) => o.outcome === "error").length;
  const skipped = outcomes.length - snapshotted - errors;
  return { projectsChecked, snapshotted, skipped, errors, outcomes };
}
