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
 *
 *  Card f55b64af: this is now the ORDINARY pool's own count cap — see {@link GATE_SPILL_PROTECTED_RETAIN_COUNT}
 *  for the smaller, independent cap a PROTECTED (non-clean) spill is counted against instead.
 */
export const GATE_SPILL_RETAIN_COUNT = 100;

/**
 * Card f55b64af: the PROTECTED pool's own, smaller count cap — a FAIL, an ERROR, or a "weaker pass" (a
 * PASS that only landed after a retry) spill is counted against THIS cap, never {@link GATE_SPILL_RETAIN_COUNT},
 * so a run of ordinary clean passes can never evict an older non-clean diagnostic a manager may still be
 * hand-rescuing (the defect this card's own DoD names). A first sizing, not a measured bound — 25 is a
 * quarter of the ordinary pool's cap, judged generous enough for the non-clean spills a project normally
 * accumulates between reviews without letting the protected pool itself become an unbounded liability;
 * revisit if real usage shows otherwise. Count-only, deliberately no separate age limit — one axis, mirroring
 * the ordinary pool's own count-based design, rather than introducing a second, independently-tunable knob
 * for a bound nothing has yet shown is needed.
 */
export const GATE_SPILL_PROTECTED_RETAIN_COUNT = 25;

/**
 * Card f55b64af: every `.log` file directly under `dir`, as its opId (the filename stem — see
 * `gateSpillPath`'s own "filename IS the opId" convention). Pure `fs` listing, no classification — a
 * caller (`sessions/service.ts`, which alone holds a `Db` handle) uses this to know WHICH opIds to look
 * up in `pending_gate_ops` before classifying each as protected/ordinary; classification itself
 * deliberately stays OUT of this file (see `pruneGateSpills`'s own "two-pool" doc for why). Best-effort:
 * a missing/unreadable `dir` is an empty list, never a throw.
 */
export function listGateSpillOpIds(dir: string = GATE_SPILL_DIR): string[] {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".log"))
      .map((e) => e.name.slice(0, -".log".length));
  } catch {
    return [];
  }
}

/**
 * Keep the newest spill files under `dir` — oldest by mtime evicted first. ONLY ever touches `*.log` files
 * directly in `dir` — mirrors `rotateBackups`'s own scoping discipline (never touches an unrelated file
 * that happens to live alongside). Best-effort: a prune failure is logged and swallowed — losing an old
 * diagnostic to a failed prune is acceptable; losing gate execution to a prune bug is not.
 *
 * Card f55b64af — TWO-POOL POLICY, replacing the old single-pool "no gaps" rule:
 *   1. COUNT trim runs PER POOL, independently. Every `.log` file whose opId is in `protectedOpIds` is the
 *      PROTECTED pool, trimmed to `protectedKeep`; every other file is the ORDINARY pool, trimmed to `keep`
 *      — an ordinary clean pass can never evict a protected FAIL/ERROR/weaker-pass spill just by being
 *      newer, and vice versa. Within EACH pool this trim is still the old monotonic newest-first cutoff (no
 *      gaps WITHIN a pool).
 *   2. BYTE trim runs SECOND, GLOBALLY, across the UNION of both pools' count-trim survivors, newest-first,
 *      ignoring which pool an entry belongs to — the byte ceiling stays absolute across everything (the
 *      card's own requirement), so a protected spill is exempt ONLY from step 1's count trim, never from
 *      this step; a tight byte budget can still evict a protected file, and correctly so.
 *   `protectedOpIds` defaults to empty, so every existing caller (and every pre-card test) is byte-identical
 *   to the old single-pool behavior — with no protected entries, step 1 degrades to exactly the old
 *   newest-first count cutoff, and step 2 degrades to exactly the old newest-first byte cutoff over what's
 *   left, in the same order.
 */
export function pruneGateSpills(
  dir: string = GATE_SPILL_DIR,
  keep: number = GATE_SPILL_RETAIN_COUNT,
  maxTotalBytes: number = GATE_SPILL_MAX_TOTAL_BYTES,
  protectedOpIds: ReadonlySet<string> = EMPTY_PROTECTED_OP_IDS,
  protectedKeep: number = GATE_SPILL_PROTECTED_RETAIN_COUNT,
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
        const opId = e.name.slice(0, -".log".length);
        return { full, mtime, size, protected: protectedOpIds.has(opId) };
      })
      .sort((a, b) => b.mtime - a.mtime); // newest first

    // STEP 1 — per-pool COUNT trim (see this function's own "TWO-POOL POLICY" doc above). An opId with no
    // matching pending_gate_ops row was never added to `protectedOpIds` by the caller, so it lands in the
    // ORDINARY pool here — unknown/unclassifiable fails toward evictable, never toward protected.
    const ordinary = entries.filter((e) => !e.protected);
    const protectedEntries = entries.filter((e) => e.protected);
    const countSurvivors = new Set<string>();
    ordinary.slice(0, keep).forEach((e) => countSurvivors.add(e.full));
    protectedEntries.slice(0, protectedKeep).forEach((e) => countSurvivors.add(e.full));

    // STEP 2 — global BYTE trim across the union of step 1's survivors, newest-first, pool-blind. Iterating
    // `entries` (still newest-first) in original order: every survivor of step 1 appears before every entry
    // step 1 already evicted (each pool's own slice keeps a newest-first prefix), so this single pass both
    // (a) deletes step 1's losers outright and (b) applies the SAME monotonic newest-first byte cutoff to
    // step 1's survivors the old single-pool code applied to everyone — once the running total would exceed
    // `maxTotalBytes`, that entry and every remaining (older) survivor are evicted too, no gaps within the
    // surviving set.
    let runningBytes = 0;
    let cutoffReached = false;
    for (const entry of entries) {
      if (!countSurvivors.has(entry.full)) {
        try { fs.rmSync(entry.full, { force: true }); } catch { /* best-effort */ }
        continue;
      }
      if (!cutoffReached) {
        const wouldExceedBytes = maxTotalBytes > 0 && runningBytes + entry.size > maxTotalBytes;
        if (wouldExceedBytes) cutoffReached = true;
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

/** Shared empty-set default for `pruneGateSpills`'s `protectedOpIds` param — one frozen instance rather
 *  than allocating a fresh `new Set()` on every no-protected-ids call. */
const EMPTY_PROTECTED_OP_IDS: ReadonlySet<string> = new Set();
