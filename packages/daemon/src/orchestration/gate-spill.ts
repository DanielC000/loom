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

/**
 * PRIMARY retention bound — a DIRECT ceiling on the metric that actually matters (real disk bytes under
 * `LOOM_HOME`, on a shipped end-user machine, not just this daemon's own dev box). Manager review, card
 * a16c580b follow-up: the first cut of this file bounded retention by COUNT alone (`GATE_SPILL_RETAIN_COUNT`
 * below) and argued the worst case — every one of 100 retained files sitting at the 10MB `GATE_SPILL_MAX_BYTES`
 * ceiling — was acceptable because real spills are "far smaller in practice". That argument is exactly the
 * one every unbounded-growth incident starts with: it makes the worst case a PRODUCT of two independent
 * maximums (count × per-file cap) that must both be hit simultaneously to manifest, rather than a bound on
 * the thing itself. This constant removes that gap structurally: `pruneGateSpills` now also sums real bytes
 * newest-first and stops retaining the moment the running total would exceed this, so 1GB (100 * 10MB) is no
 * longer merely unlikely — it is unreachable. 200MB is a deliberately generous but genuinely bounded ceiling
 * for a local dev-tool diagnostic cache (comparable in order of magnitude to a browser/IDE cache budget), and
 * is the number to defend or shrink going forward — `GATE_SPILL_RETAIN_COUNT` is now a SECONDARY bound only
 * (guards against a large NUMBER of small files, a shape this byte cap alone wouldn't catch).
 */
export const GATE_SPILL_MAX_TOTAL_BYTES = 200 * 1024 * 1024;

/** SECONDARY retention bound (see {@link GATE_SPILL_MAX_TOTAL_BYTES}'s own doc for why it, not this, is now
 *  primary) — caps the raw FILE COUNT, independent of size, so a very large number of small spills can't
 *  accumulate indefinitely just because their combined bytes stay under the primary cap. Prune-on-write,
 *  oldest by mtime evicted first — the same `rotateBackups` (orchestration/db-backup.ts) shape this mirrors.
 *  A silent overwrite-in-place (reusing the newest N paths) was rejected: it would recreate the exact "which
 *  op's diagnostic survives" gap this card exists to close, just at a different N.
 */
export const GATE_SPILL_RETAIN_COUNT = 100;

/**
 * Keep the newest spill files under `dir` — oldest by mtime evicted first — until BOTH the file-count
 * (`keep`) and total-bytes (`maxTotalBytes`) budgets are satisfied; whichever bound is hit FIRST determines
 * how many survive. ONLY ever touches `*.log` files directly in `dir` — mirrors `rotateBackups`'s own
 * scoping discipline (never touches an unrelated file that happens to live alongside). Best-effort: a prune
 * failure is logged and swallowed — losing an old diagnostic to a failed prune is acceptable; losing gate
 * execution to a prune bug is not.
 */
export function pruneGateSpills(
  dir: string = GATE_SPILL_DIR,
  keep: number = GATE_SPILL_RETAIN_COUNT,
  maxTotalBytes: number = GATE_SPILL_MAX_TOTAL_BYTES,
): void {
  try {
    if (keep <= 0) return;
    if (!fs.existsSync(dir)) return;
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".log"))
      .map((e) => {
        const full = path.join(dir, e.name);
        let mtime = 0;
        let size = 0;
        try {
          const st = fs.statSync(full);
          mtime = st.mtimeMs;
          size = st.size;
        } catch { /* unreadable → sorts oldest, pruned first; size 0 never falsely trips the byte cap for it */ }
        return { full, mtime, size };
      })
      .sort((a, b) => b.mtime - a.mtime); // newest first
    // Once EITHER bound trips, every OLDER entry from that point on is pruned too — never selectively kept
    // because an individual older file happens to be small enough to "fit" a remaining byte budget. Newest-
    // first eviction must stay monotonic (no gaps), matching `rotateBackups`'s own `entries.slice(keep)`
    // shape; a "best fit" policy would let an older file outlive a newer one, which is never the intent.
    let runningBytes = 0;
    let cutoffReached = false;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      if (!cutoffReached) {
        const wouldExceedCount = i >= keep;
        const wouldExceedBytes = maxTotalBytes > 0 && runningBytes + entry.size > maxTotalBytes;
        if (wouldExceedCount || wouldExceedBytes) cutoffReached = true;
      }
      if (cutoffReached) {
        try { fs.rmSync(entry.full, { force: true }); } catch { /* best-effort */ }
      } else {
        runningBytes += entry.size;
      }
    }
  } catch (err) {
    console.warn(`[gate-spill] rotation failed (continuing): ${(err as Error).message}`);
  }
}
