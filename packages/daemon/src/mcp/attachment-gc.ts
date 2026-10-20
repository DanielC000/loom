import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Db } from "../db.js";
import { ATTACHMENTS_DIR, questionAttachmentDir } from "../paths.js";
import { canonicalizeForContainment, isProperlyUnder } from "../projects/vault-path.js";
import { comparisonKey } from "../projects/repos.js";
import { killableRemoveDir, raceRemoval, type RemoveDirResult } from "../git/worktrees.js";

/**
 * Boot-only GC for `<LOOM_HOME>/attachments/<questionId>/…` (the copy-at-send store card 432765ab
 * landed; see that card's own `prepareQuestionAttachments` doc: "the orphan dir, if it survives, is the
 * ... GC card's concern" — this is that card). Wired alongside `runBootScratchGcSweep`/
 * `sweepOrphanedSettingsDirSecrets` at the SAME `reconcileRunsOnBoot` call site (`sessions/service.ts`).
 *
 * Eligibility is `Db.listAttachmentGcCandidateIds` — see that method's own doc for the full terminal-
 * state mapping. This module's job is purely the DISK side: for every id that query returns, safely
 * remove `questionAttachmentDir(id)` or leave it alone, never touching the DB row either way (the read
 * surface's `available` flag already reads disk state live — see `toQuestionAttachments` in db.ts).
 *
 * @decision 6f27469b — boot-only, no interval watcher; a long-uptime daemon only re-collects on its NEXT
 * restart, same posture as every other GC-style directory sweep in this codebase.
 */

/** A Loom question id is a `crypto.randomUUID()` v4 UUID (`questionTool.ts`'s `buildQuestionAsk`) —
 *  mirrors `sessions/scratch-gc.ts`'s own `V4_UUID_RE` shape check. The id is read straight off the DB
 *  row returned by `listAttachmentGcCandidateIds`, never from a glob or any user-controlled string; this
 *  check is defense in depth against a corrupt/tampered row, not the primary containment guard. */
const V4_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** `canonicalizeForContainment` with the same raw-string-or-realpath-fallback posture `mcp/attachments.ts`
 *  uses for its own `LOOM_HOME_CANON_KEY` — never throws, degrades to the lexically-resolved form on a
 *  canonicalization failure instead of crashing. */
function canonicalizeOrFallback(raw: string): string {
  const r = canonicalizeForContainment(raw);
  return r.ok ? r.value : path.resolve(raw);
}

/** Whole days to milliseconds, for `PlatformConfig.attachmentRetentionDays`. Extracted to its own named,
 *  exported, directly-tested function (card 6f27469b Code Review) — a silent unit slip here (e.g. hours
 *  instead of days) would reap 30-day attachments after ~12h with every OTHER test still green, since
 *  nothing else exercises the actual numeric conversion. */
export function attachmentRetentionMsFromDays(days: number): number {
  return days * 24 * 60 * 60 * 1000;
}

/** Per-removal timeout — mirrors `sessions/scratch-gc.ts`'s `SCRATCH_GC_REMOVE_TIMEOUT_MS` (same class of
 *  local, no-network directory removal). */
const ATTACHMENT_GC_REMOVE_TIMEOUT_MS = 15_000;

/** Bounded concurrency for the removal fan-out — mirrors `sessions/scratch-gc.ts`'s own reasoning
 *  (one OS removal process per candidate, unbounded `Promise.all` is a real host-starvation shape). A
 *  request's attachment store is bounded in COUNT far more tightly than scratch dirs ever are, but the
 *  bound costs nothing to keep anyway. */
export const ATTACHMENT_GC_CONCURRENCY = 4;

/** Injectable seam mirroring `sessions/scratch-gc.ts`'s `ScratchGcDeps` — lets a test simulate a wedged
 *  (never-settling) removal, freeze "now", or exercise the level-2 containment check in isolation, without
 *  touching the real `ATTACHMENTS_DIR`. Real callers (the boot hook) never pass any of these. */
export interface AttachmentGcDeps {
  removeDir?: (target: string, timeoutMs: number) => Promise<RemoveDirResult>;
  timeoutMs?: number;
  nowMs?: number;
  /**
   * TEST-ONLY. Substitutes the root level-2's `isProperlyUnder` check compares a candidate dir's
   * canonical path against — `questionAttachmentDir(id)` (and so level-1's `lstat` target) is UNCHANGED
   * and still rooted at the real `ATTACHMENTS_DIR`; only the COMPARISON root moves. In production this is
   * never set, so level-2 compares against the real root it always matches by construction — see
   * `sweepExpiredAttachments`'s own doc for why that makes level-2 unreachable in the ordinary case, and
   * what genuine hazard it still guards.
   */
  containmentRootOverride?: string;
}

export interface AttachmentGcResult {
  /** GC-eligible ids the DB query returned at all. */
  scanned: number;
  /** Question ids whose store dir was actually removed this sweep. */
  reaped: string[];
  /** Question ids whose removal was attempted but genuinely wedged (killed, left for the next sweep). */
  wedged: string[];
  /** Question ids refused WITHOUT attempting removal — a containment check failed, or the row's id
   *  didn't shape-check — each with its reason. Never a bug report by itself: most entries here are a
   *  planted hazard correctly caught, not a defect. */
  refused: { id: string; reason: string }[];
  /** Rows whose store dir was already gone (a prior sweep collected it, or it never existed) — expected
   *  steady state once a row has been collected once, since the DB row itself is never mutated. */
  alreadyGone: number;
}

async function withBoundedConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  async function lane(): Promise<void> {
    while (next < items.length) {
      const item = items[next++]!;
      await worker(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => lane()));
}

/**
 * Sweep every request past GC eligibility (`db.listAttachmentGcCandidateIds`) and remove its attachment
 * store dir. Best-effort and NEVER throws for an individual id — a wedged removal is simply left on disk
 * for the next boot's sweep (`killableRemoveDir` + `raceRemoval`, fail-SAFE, never a retrying `fs.rm`).
 *
 * Containment, in order:
 *  1. `lstat` the question dir ITSELF — the RAW path, never canonicalized first — and refuse outright if
 *     it is a symlink/junction, or exists but isn't a directory at all. A link planted AT
 *     `attachments/<id>` must never be followed even to be stat'd for its target's shape;
 *     canonicalize-then-compare alone would otherwise happily resolve THROUGH it first. This is the check
 *     that actually fires for every realistic planted-link shape.
 *  2. Canonicalize the (now confirmed-real-directory) path and check `isProperlyUnder` against a root —
 *     the real `ATTACHMENTS_DIR` in production, or `deps.containmentRootOverride` under test.
 *
 * @decision 6f27469b — level 2 is DEFENSE IN DEPTH only: a flat `ATTACHMENTS_DIR/<id>` layout makes it
 * unreachable via any per-id planted link once level 1 passes — only a TOCTOU swap of the ROOT itself
 * would fire it for real. Never claim it is exercised by the same fixture shape that proves level 1.
 *
 * A THIRD hazard — a symlink/junction planted *inside* an otherwise-legitimate question dir, pointing
 * outside the store — needs no special-case here: the OS-level bulk remove `killableRemoveDir` shells out
 * to (`rmdir /s /q` on win32, `rm -rf` on posix) removes the link ENTRY without recursing into its target.
 * Proven for this exact shape by `worktree-removal-never-reaches-repo.mjs`'s own junction case (E), and
 * re-proven for this specific dir shape by `attachment-gc.mjs`'s own junction case.
 */
export async function sweepExpiredAttachments(
  db: Db, retentionMs: number, deps: AttachmentGcDeps = {},
): Promise<AttachmentGcResult> {
  const result: AttachmentGcResult = { scanned: 0, reaped: [], wedged: [], refused: [], alreadyGone: 0 };
  const nowMs = deps.nowMs ?? Date.now();
  const cutoffIso = new Date(nowMs - retentionMs).toISOString();
  const timeoutMs = deps.timeoutMs ?? ATTACHMENT_GC_REMOVE_TIMEOUT_MS;
  const removeDir = deps.removeDir ?? ((p: string, ms: number) => killableRemoveDir(p, ms));
  const containmentRootCanonKey = comparisonKey(canonicalizeOrFallback(deps.containmentRootOverride ?? ATTACHMENTS_DIR));

  const ids = db.listAttachmentGcCandidateIds(cutoffIso);
  const targets: { id: string; dir: string }[] = [];
  for (const id of ids) {
    result.scanned++;
    if (!V4_UUID_RE.test(id)) {
      result.refused.push({ id, reason: "question id is not a v4-UUID shape" });
      continue;
    }
    const dir = questionAttachmentDir(id);

    // Level 1 — lstat the RAW path; a symlink/junction AT this exact location is refused, never followed.
    let st: fs.Stats;
    try {
      st = await fsp.lstat(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") { result.alreadyGone++; continue; }
      result.refused.push({ id, reason: `lstat failed: ${(err as Error).message}` });
      continue;
    }
    if (st.isSymbolicLink()) {
      result.refused.push({ id, reason: "attachment store dir is itself a symlink/junction — refused, never followed" });
      continue;
    }
    if (!st.isDirectory()) {
      result.refused.push({ id, reason: "attachment store path exists but is not a directory" });
      continue;
    }

    // Level 2 — canonicalize + isProperlyUnder against the containment root (see this function's own doc
    // on why this is defense-in-depth rather than independently reachable in production).
    const canon = canonicalizeForContainment(dir);
    if (!canon.ok) { result.refused.push({ id, reason: canon.error }); continue; }
    const key = comparisonKey(canon.value);
    if (!isProperlyUnder(key, containmentRootCanonKey)) {
      result.refused.push({ id, reason: "attachment store dir resolves outside the attachments root" });
      continue;
    }

    targets.push({ id, dir });
  }

  await withBoundedConcurrency(targets, ATTACHMENT_GC_CONCURRENCY, async ({ id, dir }) => {
    const raceOutcome = await raceRemoval(removeDir(dir, timeoutMs), timeoutMs);
    const removed = raceOutcome.kind === "result" && raceOutcome.result.removed;
    if (removed) {
      result.reaped.push(id);
    } else {
      result.wedged.push(id);
      const reason = raceOutcome.kind === "rejected"
        ? `removal failed to start: ${raceOutcome.message}`
        : (raceOutcome.kind === "timeout" || raceOutcome.result.killed) ? "genuinely wedged" : "clean failure";
      // eslint-disable-next-line no-console
      console.warn(`[attachment-gc] boot sweep could not remove ${dir} (${reason}; left for the next boot sweep)`);
    }
  });

  return result;
}

/**
 * Card 6f27469b Code Review — the boot sweep's own OUTCOME, made readable in-process (mirrors
 * `sessions/scratch-gc.ts`'s `ScratchGcSweepOutcome`/`getBootScratchGcSweepOutcome`; not yet wired onto
 * `served_status` — that remains optional future work, not this fix). A sweep that scanned N ids and
 * reaped 0 used to be byte-identical, on every observable surface, to one that threw on its first
 * statement and was swallowed, or one that never ran at all. This closes that gap.
 */
export type AttachmentGcSweepOutcome =
  | { state: "not-started" }
  | { state: "in-progress"; startedAt: string }
  | {
      state: "completed"; startedAt: string; completedAt: string;
      scanned: number; reaped: number; wedged: number; refused: number; alreadyGone: number;
    }
  | { state: "failed"; startedAt: string; failedAt: string; error: string };

let bootAttachmentGcSweepOutcome: AttachmentGcSweepOutcome = { state: "not-started" };

/** Fresh read — same "read whatever the module currently holds" discipline as `scratch-gc.ts`'s own
 *  sibling function. */
export function getBootAttachmentGcSweepOutcome(): AttachmentGcSweepOutcome {
  return bootAttachmentGcSweepOutcome;
}

/** TEST SEAM — mirrors `scratch-gc.ts`'s `__resetScratchGcSweepOutcomeForTest`. Production code never
 *  calls this. */
export function __resetAttachmentGcSweepOutcomeForTest(): void {
  bootAttachmentGcSweepOutcome = { state: "not-started" };
}

/**
 * Boot-only wrapper around {@link sweepExpiredAttachments} — call this from `reconcileRunsOnBoot` instead
 * of a bare fire-and-forget call, mirroring `runBootScratchGcSweep`'s shape. `retentionMs` is resolved by
 * the caller via {@link attachmentRetentionMsFromDays} since this module has no config access of its own.
 *
 * Every refusal is logged individually with its reason (a planted hazard correctly caught, a corrupt id,
 * or every row refusing under a misconfigured/UNC `LOOM_HOME` are each distinguishable this way instead
 * of leaving no trace at all), plus one summary line per sweep and the outcome record above.
 */
export function runBootAttachmentGcSweep(db: Db, retentionMs: number, deps: AttachmentGcDeps = {}): void {
  const startedAt = new Date().toISOString();
  bootAttachmentGcSweepOutcome = { state: "in-progress", startedAt };
  void sweepExpiredAttachments(db, retentionMs, deps)
    .then((result) => {
      for (const r of result.refused) {
        // eslint-disable-next-line no-console
        console.warn(`[attachment-gc] refused ${r.id}: ${r.reason}`);
      }
      // eslint-disable-next-line no-console
      console.log(
        `[attachment-gc] boot sweep: scanned ${result.scanned}, reaped ${result.reaped.length}, ` +
        `refused ${result.refused.length}, wedged ${result.wedged.length}, alreadyGone ${result.alreadyGone}`,
      );
      bootAttachmentGcSweepOutcome = {
        state: "completed", startedAt, completedAt: new Date().toISOString(),
        scanned: result.scanned, reaped: result.reaped.length, wedged: result.wedged.length,
        refused: result.refused.length, alreadyGone: result.alreadyGone,
      };
    })
    .catch((e) => {
      bootAttachmentGcSweepOutcome = {
        state: "failed", startedAt, failedAt: new Date().toISOString(), error: (e as Error).message,
      };
      // eslint-disable-next-line no-console
      console.warn(`[boot] attachment GC sweep failed: ${(e as Error).message}`);
    });
}
