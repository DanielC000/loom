import fs from "node:fs";
import path from "node:path";
import { LOOM_HOME } from "../paths.js";

/**
 * Card a16c580b — the gap `OUTPUT_TAIL_BYTES` (gate-runner.ts) leaves behind: `gate_status.outputTail` is
 * a bounded ~4KB (or content-selected ~16KB on a failure) RING, cut mid-line, with no second copy anywhere
 * — the daemon's own stdout log does NOT mirror gate-child output (verified: grepping `daemon-output.log`
 * for a supervisor-child marker returned 0 against a working positive control on the same file returning a
 * real hit count for the op's own id). This module is the "spill, don't widen" fix: every byte a gate step's
 * child process writes is ALSO streamed to a file here (see `runGateStep`'s own `spillFile` handling), so a
 * settled op's FULL output is recoverable by opId even after `outputTail` has truncated it — mirrors the
 * `spillTextIfLarge`/`spillMergePatch` precedent (spill.ts / sessions/service.ts) rather than inventing a
 * new mechanism, but deliberately does NOT reuse `spillTextIfLarge` itself: that primitive is keyed to a
 * SESSION's own scratch dir and is a one-shot in-memory-string write, whereas a gate's raw child output
 * must be streamed incrementally (a whole run's output is never buffered in daemon memory — see
 * `OUTPUT_TAIL_BYTES`'s own doc) and outlives any one session (a merge/deploy/batch gate has no single
 * "owning" session scratch dir the way a worker's own spill does — `gate_status(opId)` is read by whichever
 * session minted the op, sometimes long after that session's own scratch dir would have been the wrong
 * home for it). Kept in its own file (not gate-runner.ts, already large) alongside a `db-backup.ts`-style
 * count-based retention sweep.
 */

/** All full-output gate spills live directly under LOOM_HOME, one flat directory — `opId` is already a
 *  globally-unique v4 uuid (minted once per gate/merge/deploy/batch op, see `PendingGateOpVerdict`'s own
 *  doc), so there is no need to further namespace by project the way per-session scratch dirs do. */
export const GATE_SPILL_DIR = path.join(LOOM_HOME, "gate-output");

/** The full path a settled op's full-output spill lives (or would live) at. Pure derivation — never
 *  creates anything; `runGateStep` mkdir's the parent lazily on first actual write. */
export function gateSpillPath(opId: string): string {
  return path.join(GATE_SPILL_DIR, `${opId}.log`);
}

/**
 * Per-file ceiling on a SINGLE spill (bytes). This is NOT the same cliff as `OUTPUT_TAIL_BYTES` — it is
 * several orders of magnitude larger (this daemon's own ~668-file test suite output, even a verbose
 * failing run, comfortably fits in low single-digit MB) and exists ONLY to bound worst-case disk usage
 * against a genuinely pathological run (e.g. a test stuck in a tight print loop until its own
 * `gateCommandTimeoutMs` kill) — not to truncate an ordinary failure's diagnostic the way the inline tail
 * does. Once hit, `runGateStep` stops appending further bytes for the rest of that spill and the file ends
 * with an explicit marker line so a reader can tell "capped" from "the run's output actually ended here".
 */
export const GATE_SPILL_MAX_BYTES = 10 * 1024 * 1024;

/** How many settled ops' full-output spills to retain, across the WHOLE daemon (every project sharing it
 *  — gates run "constantly" per CLAUDE.md, so this is a global, not per-project, budget). Prune-on-write,
 *  oldest by mtime evicted first — the same `rotateBackups` (orchestration/db-backup.ts) shape this
 *  mirrors. Chosen so the worst case (every retained file at the `GATE_SPILL_MAX_BYTES` ceiling) stays a
 *  bounded, small multiple of that ceiling (100 * 10MB = 1GB worst case) rather than growing unboundedly
 *  as gates keep running — in practice most spills are far smaller than the ceiling, so real usage is
 *  much lower. A silent overwrite-in-place (reusing the newest N paths) was rejected: it would recreate
 *  the exact "which op's diagnostic survives" gap this card exists to close, just at a different N.
 */
export const GATE_SPILL_RETAIN_COUNT = 100;

/**
 * Keep the newest `keep` spill files under `dir`; prune older ones by mtime. ONLY ever touches `*.log`
 * files directly in `dir` — mirrors `rotateBackups`'s own scoping discipline (never touches an unrelated
 * file that happens to live alongside). Best-effort: a prune failure is logged and swallowed — losing an
 * old diagnostic to a failed prune is acceptable; losing gate execution to a prune bug is not.
 */
export function pruneGateSpills(dir: string = GATE_SPILL_DIR, keep: number = GATE_SPILL_RETAIN_COUNT): void {
  try {
    if (keep <= 0) return;
    if (!fs.existsSync(dir)) return;
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".log"))
      .map((e) => {
        const full = path.join(dir, e.name);
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch { /* unreadable → sorts oldest, pruned first */ }
        return { full, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime); // newest first
    for (const stale of entries.slice(keep)) {
      try { fs.rmSync(stale.full, { force: true }); } catch { /* best-effort */ }
    }
  } catch (err) {
    console.warn(`[gate-spill] rotation failed (continuing): ${(err as Error).message}`);
  }
}
