// WorktreeGc test (board card bd9fc808 — the ROOT-CAUSE follow-up to 460d3178). Proves the in-session
// background retry queue that finalizeMerge/boot-reconcile Pass B now enqueue into when removeWorktree's
// filesystem backstop swallows a stuck Windows directory handle: a dir "stuck" for the first K retries
// (the injected `rm` seam rejects, simulating an OS indexer/Defender scan still holding the handle) is
// GC'd by the background sweep once it "releases" (the injected rm starts succeeding) — no daemon
// restart needed, and no reliance on the next boot's Pass B. Also proves the bounded give-up, the
// idempotent enqueue, and the self-arm/disarm of the sweep timer.
//
// HERMETIC: no real git ops (git is stubbed fast, mirroring worktrees.mjs's own bounded-fs-backstop
// tests) — only plain fs dirs + an injected `rm` that simulates the stuck-then-released handle. LOOM_HOME
// is set before importing dist/* per the repo's test convention, though this module reads no daemon paths.
// Run: 1) pnpm build, 2) node packages/daemon/test/worktree-gc.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-wtgc-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { WorktreeGc } = await import("../dist/git/worktree-gc.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Isolate the fs backstop — mirrors worktrees.mjs's own bounded-removal tests: a fast stub git means only
// the injected `rm` seam drives what happens to the directory on disk.
const stubFastGit = (_p, _ms) => ({ raw: async () => "" });

try {
  // (a) THE CORE PROOF: a handle stuck for the first K sweeps, then releasing — GC'd by the background
  //     sweep across MULTIPLE sweepOnce() calls (standing in for the real timer), no daemon restart.
  {
    const dir = path.join(process.env.LOOM_HOME, `stuck-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "marker.txt"), "x");
    const STUCK_ATTEMPTS = 3;
    let calls = 0;
    const rm = async (target) => {
      calls++;
      if (calls <= STUCK_ATTEMPTS) throw new Error("stuck directory handle (simulated OS indexer/Defender scan)");
      await fs.promises.rm(target, { recursive: true, force: true }); // the handle "released" — real removal
    };
    const gc = new WorktreeGc({ gitFactory: stubFastGit, rm, intervalMs: 1_000_000 }); // driven manually below
    gc.enqueue("repo-irrelevant", dir);
    check("(a) enqueue tracks one pending entry", gc.pending === 1);

    for (let i = 0; i < STUCK_ATTEMPTS; i++) {
      await gc.sweepOnce();
      check(`(a) still queued + on disk after stuck attempt ${i + 1}`, gc.pending === 1 && fs.existsSync(dir));
    }
    await gc.sweepOnce(); // the (STUCK_ATTEMPTS+1)-th attempt — the handle has "released"
    check("(a) dir removed once the handle releases (no daemon restart)", !fs.existsSync(dir));
    check("(a) queue drains once removed", gc.pending === 0);
    check(`(a) exactly ${STUCK_ATTEMPTS + 1} remove attempts were made (retried, not re-derived/duplicated)`, calls === STUCK_ATTEMPTS + 1);
    gc.stop();
  }

  // (b) BOUNDED give-up: an entry that never releases is retried up to maxAttempts, then dropped — left
  //     on disk for the next boot's Pass B, exactly the PRE-EXISTING fallback (never worse than before).
  {
    const dir = path.join(process.env.LOOM_HOME, `neverreleases-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    const rm = async () => { throw new Error("handle never releases (simulated)"); };
    const gc = new WorktreeGc({ gitFactory: stubFastGit, rm, maxAttempts: 2, intervalMs: 1_000_000 });
    gc.enqueue("repo-irrelevant", dir);
    await gc.sweepOnce(); // attempt 1 of 2
    check("(b) still queued after attempt 1 of 2", gc.pending === 1);
    await gc.sweepOnce(); // attempt 2 of 2
    check("(b) still queued after attempt 2 of 2 (bound is checked at the START of the next sweep)", gc.pending === 1);
    await gc.sweepOnce(); // bound already met → gives up WITHOUT a 3rd attempt
    check("(b) gives up past maxAttempts — queue drains, dir left on disk (unchanged fallback)", gc.pending === 0 && fs.existsSync(dir));
    gc.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // (c) enqueue is IDEMPOTENT per worktreePath — a repeated swallow of the SAME dir (e.g. re-observed by
  //     both finalizeMerge and a later Pass B pass) must not double-queue/double-retry it.
  {
    const dir = path.join(process.env.LOOM_HOME, `dup-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    const gc = new WorktreeGc({ gitFactory: stubFastGit, rm: async () => { throw new Error("busy"); }, intervalMs: 1_000_000 });
    gc.enqueue("repo-a", dir);
    gc.enqueue("repo-a", dir);
    gc.enqueue("repo-a", dir);
    check("(c) enqueue is idempotent per worktreePath (still just 1 pending)", gc.pending === 1);
    gc.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // (d) the sweep timer SELF-ARMS on first enqueue and SELF-DISARMS once the queue drains — an idle GC
  //     (the common case: most removals succeed on the first try) never pays for a standing timer.
  {
    const dir = path.join(process.env.LOOM_HOME, `timer-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    const rm = async (target) => { await fs.promises.rm(target, { recursive: true, force: true }); }; // succeeds first try
    const gc = new WorktreeGc({ gitFactory: stubFastGit, rm, intervalMs: 1_000_000 });
    check("(d) no timer armed before anything is enqueued", gc.timer === null);
    gc.enqueue("repo-a", dir);
    check("(d) timer armed once something is enqueued", gc.timer !== null);
    await gc.sweepOnce(); // removes immediately (rm succeeds on the first attempt)
    check("(d) queue drained", gc.pending === 0);
    check("(d) timer disarmed once the queue drains", gc.timer === null);
  }

  // (e) a target that's already gone by the time it's swept (removed some other way) is dropped without
  //     ever calling the injected rm again.
  {
    const dir = path.join(process.env.LOOM_HOME, `already-gone-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    let rmCalls = 0;
    const gc = new WorktreeGc({ gitFactory: stubFastGit, rm: async () => { rmCalls++; }, intervalMs: 1_000_000 });
    gc.enqueue("repo-a", dir);
    fs.rmSync(dir, { recursive: true, force: true }); // removed out-of-band before the sweep runs
    await gc.sweepOnce();
    check("(e) an already-gone dir is dropped from the queue without retrying", gc.pending === 0 && rmCalls === 0);
    gc.stop();
  }
} finally {
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — WorktreeGc retries a stuck worktree removal in-session across multiple sweeps until the handle releases (no daemon restart), bounds the retry count/keeps the pre-existing give-up fallback, is idempotent per path, and self-arms/disarms its sweep timer."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
