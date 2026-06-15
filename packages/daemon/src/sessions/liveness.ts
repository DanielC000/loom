import chokidar, { type FSWatcher } from "chokidar";
import os from "node:os";
import path from "node:path";
import type { Db } from "../db.js";
import { engineTranscriptExists } from "./transcript.js";

const CLAUDE_PROJECTS = path.join(os.homedir(), ".claude", "projects");

/**
 * Dead-ID detection (§12-Q5). A stored session is unresumable once its engine transcript
 * JSONL disappears from ~/.claude/projects. Proactively mark such sessions dead so the UI
 * greys them out BEFORE the user clicks resume — file-existence is the primary trigger
 * (resume-failure is only a backstop, in SessionService.resume).
 */
export function sweepDeadSessions(db: Db): number {
  let marked = 0;
  for (const s of db.listResumeCandidates()) {
    if (s.engineSessionId && !engineTranscriptExists(s.cwd, s.engineSessionId)) {
      db.setResumability(s.id, "dead");
      marked++;
    }
  }
  return marked;
}

/** Watch ~/.claude/projects; re-sweep when a transcript is removed (debounced). */
export function watchClaudeProjects(db: Db, onChange?: (marked: number) => void): FSWatcher {
  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { const n = sweepDeadSessions(db); if (n > 0) onChange?.(n); }, 1500);
  };
  return chokidar
    .watch(CLAUDE_PROJECTS, { ignoreInitial: true, depth: 2 })
    .on("unlink", (f) => { if (f.endsWith(".jsonl")) schedule(); })
    // A watched project dir can vanish mid-stat — e.g. a short-lived temp run cwd (loom-mgmt-cwd-*)
    // whose transcript is cleaned up — which on Windows surfaces as EPERM/ENOENT/EBUSY. chokidar emits
    // these on the 'error' event; with NO listener that unhandled event would CRASH the whole daemon
    // (it took the daemon down on 2026-06-16). Swallow it (log only): the watcher keeps running and the
    // next debounced sweep self-heals. NEVER rethrow here — a transient FS race must not kill the daemon.
    .on("error", (err) => {
      const e = err as NodeJS.ErrnoException;
      console.warn(`[liveness] claude-projects watcher error (ignored, watcher continues): ${e?.code ?? ""} ${e?.message ?? String(err)}`);
    });
}
