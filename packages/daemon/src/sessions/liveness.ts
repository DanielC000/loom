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
    .on("unlink", (f) => { if (f.endsWith(".jsonl")) schedule(); });
}
