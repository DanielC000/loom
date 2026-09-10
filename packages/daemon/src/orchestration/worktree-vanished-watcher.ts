import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db.js";
import type { OrchestrationControl } from "./control.js";

/** The slice of PtyHost the watcher needs (injectable so the tick logic unit-tests claude-free). */
export interface WorktreeVanishedPty {
  isAlive(sessionId: string): boolean;
  /** Nudge text into the session's busy-gated queue (waits if the target is mid-turn). */
  enqueueStdin(sessionId: string, text: string): { delivered: boolean; position?: number };
}

export interface WorktreeVanishedWatcherDeps {
  db: Db;
  pty: WorktreeVanishedPty;
  /** §17a pause registry — a human-paused worker or its manager is never surfaced (parity with IdleWatcher/BusyWorkerWatcher). */
  control: OrchestrationControl;
  /** Tick cadence; defaults to 5min. Injectable so a test drives tick() directly. */
  intervalMs?: number;
}

export type WorktreeVanishReason = "gone" | "git_file_missing" | "gitdir_target_missing";

/**
 * Three-way classification of a worktree's fs-observable state — the discriminating primitive behind
 * both {@link detectVanishedWorktree} (below, unchanged contract) and any OTHER caller that needs to
 * tell "confirmed intact" apart from "unclaimable shape" instead of collapsing both into the same
 * `null`.
 *
 * @decision ab8b2cc6 — a caller that folds "indeterminate" into "intact" repeats the exact mistake
 * this type exists to prevent; see the record for why.
 *
 *  - `{ status: "at-risk", reason }`: gone, or structurally broken, per the same three fs checks
 *    `detectVanishedWorktree` has always run (see its own doc for what each `reason` means).
 *  - `{ status: "intact" }`: `.git` parses as a real worktree-pointer whose target admin dir exists —
 *    the ONLY case that actually earns "looks fine."
 *  - `{ status: "indeterminate", detail }`: `worktreePath` itself is missing/empty, OR `.git` is a real
 *    directory (not a worktree-pointer shape), OR its content doesn't match the `gitdir:` pattern — none
 *    of these are a confirmed-broken state, but none of them are confirmed-intact either.
 */
export type WorktreeIntegrity =
  | { status: "at-risk"; reason: WorktreeVanishReason }
  | { status: "intact" }
  | { status: "indeterminate"; detail: "no-path" | "not-a-worktree-pointer" | "unrecognized-git-content" };

export function classifyWorktreeIntegrity(worktreePath: string | null | undefined): WorktreeIntegrity {
  if (!worktreePath) return { status: "indeterminate", detail: "no-path" };
  if (!fs.existsSync(worktreePath)) return { status: "at-risk", reason: "gone" };
  const gitFile = path.join(worktreePath, ".git");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(gitFile);
  } catch {
    return { status: "at-risk", reason: "git_file_missing" };
  }
  if (stat.isDirectory()) return { status: "indeterminate", detail: "not-a-worktree-pointer" };
  let content: string;
  try {
    content = fs.readFileSync(gitFile, "utf8");
  } catch {
    return { status: "at-risk", reason: "git_file_missing" };
  }
  const m = content.match(/^gitdir:\s*(.+?)\s*$/m);
  if (!m) return { status: "indeterminate", detail: "unrecognized-git-content" };
  const target = path.isAbsolute(m[1]!) ? m[1]! : path.resolve(worktreePath, m[1]!);
  return fs.existsSync(target) ? { status: "intact" } : { status: "at-risk", reason: "gitdir_target_missing" };
}

/**
 * Detects whether a worktree at `worktreePath` is gone or structurally broken, using fs calls ONLY — no
 * git subprocess.
 *
 * @decision 652d312f — priced a periodic full git sweep over every live worker as real host cost;
 * this needs neither. See the record for the pricing and for what "vanished" does and doesn't cover.
 *
 * Three states, in the order checked:
 *
 *  - "gone": the directory itself no longer exists.
 *  - "git_file_missing": the directory exists but its `.git` pointer file is gone. Covers a fully OR
 *    partially reaped tree — this is the originating incident's actual shape ("present, empty,
 *    git-deregistered, branch gone" — an emptied directory has no `.git` file either, since that's a
 *    file INSIDE the directory like any other).
 *  - "gitdir_target_missing": `.git` is present and parses as the `gitdir: <path>` pointer every real
 *    `git worktree add` checkout has (a worktree's `.git` is deliberately NEVER a real repo directory —
 *    only the pointer file), but the admin dir it points at (under the MAIN repo's own
 *    `.git/worktrees/<id>`) no longer exists. This directly catches "git-deregistered" — git itself
 *    would refuse to operate here — even when the worktree's own checked-out files are untouched, i.e.
 *    the ONE state a plain empty-directory check would miss. Still fs-only: reads one ~70-byte file and
 *    stats one path; no `git` process spawned.
 *
 * Returns null when the worktree looks intact, OR when `.git` isn't in the expected worktree-pointer
 * shape (a real directory, or content this can't parse) — deliberately not claiming a state this check
 * can't back (see memory `false-state-claim-guard-is-infeasible-and-why`). A caller that needs to tell
 * those two `null` cases apart (confirmed-intact vs. unclaimable) should call
 * {@link classifyWorktreeIntegrity} directly instead — this function's own null-collapsing return shape
 * is UNCHANGED (existing callers, incl. {@link WorktreeVanishedWatcher} below, depend on it).
 *
 * NOT covered, by design: a branch deleted while the tree is otherwise intact.
 * @decision 652d312f — why that state is out of scope here.
 */
export function detectVanishedWorktree(worktreePath: string): WorktreeVanishReason | null {
  const c = classifyWorktreeIntegrity(worktreePath);
  return c.status === "at-risk" ? c.reason : null;
}

/**
 * DETECT-AND-SURFACE ONLY — structural twin of BusyWorkerWatcher, for a different silent failure: a
 * live worker whose worktree has vanished or gone git-broken out from under it. This watcher covers
 * every route to that silent state OTHER than the one already fixed at its cause.
 * @decision 652d312f — the incident this watcher exists to close, and why detection stops at
 * surfacing rather than auto-recovering.
 * @decision 40b63f1c — the causal fix already landed (commit 163877b5); see the record for the
 * two-pass cascade it closed.
 *
 * Detection is keyed on EACH live session's OWN `worktreePath` field, never re-derived from taskId — so
 * this can never confuse one session row's state with a sibling row's that happens to share a path
 * (multiple session rows routinely share one deterministic `worktreePath`, see worktrees.ts `taskKey`).
 * @decision 40b63f1c — the exact row-vs-path aliasing shape this keying avoids.
 *
 * Fires AT MOST ONCE per live session id (not per turn/episode — a vanished worktree doesn't self-heal
 * the way a long turn resolves on its own, so there is no "progress advanced past it" reset to watch
 * for; a recycle mints a fresh session id, which gets its own fresh chance to fire if still broken).
 * Persisted via a `worktree_vanished` orchestration event, mirroring `worker_stuck`'s survive-a-restart
 * convention.
 *
 * NEVER a hard kill, never auto-recovered — surfaces to BOTH the worker itself ("stop and report
 * blocked, you likely cannot commit here") and its owning manager ("check worker_status, then recycle
 * or re-dispatch"); the manager decides. Skips silently when: the worktree looks intact; the worker's
 * pty isn't actually alive (db says live but pty is gone — nothing to notify); the owning manager is
 * missing/not-live (orphans are boot-reconcile's job, not this watcher's); the worker or its manager is
 * human-paused (parity with IdleWatcher/BusyWorkerWatcher); or this session id already got flagged.
 */
export class WorktreeVanishedWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private deps: WorktreeVanishedWatcherDeps) {}

  tick(now: Date = new Date()): void {
    const { db, pty, control } = this.deps;
    const nowIso = now.toISOString();

    for (const w of db.listLiveWorkers()) {
      if (!w.worktreePath) continue;      // no worktree bound to this session → nothing to check
      if (!pty.isAlive(w.id)) continue;   // db says live but pty is gone → skip

      const reason = detectVanishedWorktree(w.worktreePath);
      if (!reason) continue;              // looks intact (or an unclaimable shape) → nothing to surface

      const managerId = w.parentSessionId;
      if (!managerId) continue;           // no owner to surface to (shouldn't happen for a worker)
      const manager = db.getSession(managerId);
      if (!manager || manager.processState !== "live") continue; // orphaned → boot-reconcile's concern, not ours

      // Human-paused (worker's own scope, the manager's scope, or global) → don't surface (parity with IdleWatcher/BusyWorkerWatcher).
      if (control.isPaused(w.id) || control.isPaused(managerId)) continue;

      // Once per LIVE SESSION ID — never re-derived from taskId/path, so this can't confuse a sibling
      // row that happens to share a worktreePath (see class doc).
      const already = db.listEventsForWorker(w.id).some((e) => e.kind === "worktree_vanished");
      if (already) continue;

      db.appendEvent({
        id: randomUUID(), ts: nowIso, managerSessionId: managerId, workerSessionId: w.id,
        taskId: w.taskId ?? null, kind: "worktree_vanished",
        detail: { reason, worktreePath: w.worktreePath },
      });

      const shortId = w.id.slice(0, 8);
      const taskPart = w.taskId ? ` (task ${w.taskId.slice(0, 8)})` : "";
      const workerMsg =
        `[loom:worktree-vanished] Your worktree at ${w.worktreePath} appears gone or broken (${reason}). ` +
        `You likely cannot commit or run git here. Stop and worker_report({status:"blocked"}) now.`;
      const managerMsg =
        `[loom:worktree-vanished] worker ${shortId}${taskPart}'s worktree appears gone or broken (${reason}) ` +
        `at ${w.worktreePath}. It probably cannot commit or merge. Check worker_status, then worker_recycle ` +
        `or re-dispatch the task. (Informational — Loom does not auto-recover.)`;
      try { pty.enqueueStdin(w.id, workerMsg); } catch { /* worker not live */ }
      try { pty.enqueueStdin(managerId, managerMsg); } catch { /* manager not live */ }
      // eslint-disable-next-line no-console
      console.log(`[worktree-vanished-watcher] worker ${w.id} worktree ${reason} → notice to worker + manager ${managerId}`);
    }
  }

  start(): void {
    this.timer = setInterval(() => { try { this.tick(); } catch { /* never let a bad tick kill the loop */ } }, this.deps.intervalMs ?? 300_000);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
