// Boot-not-blocked-on-worktree-GC test (perf card 460d3178). Owner-directed: boot was taking ~2 minutes
// because 8 dangling worktrees with stuck Windows dir handles each blocked reconcile's Pass A/B
// `removeWorktree` for the full GIT_OP_TIMEOUT_MS (15s), and reconcileOrchestrationOnBoot was `await`ed
// in index.ts BEFORE app.listen() — so the port stayed unbound for the whole serial span. The fix moves
// the call to a fire-and-forget kick AFTER app.listen(), keeping the removals serial (never parallelized
// — the threadpool-slot caveat) and the reconcile logic byte-unchanged.
//
// Two proofs, hermetic, no daemon, no real claude:
//   (1) STRUCTURAL — dist/index.js actually calls app.listen() before reconcileOrchestrationOnBoot, and
//       the call is NOT `await`ed (fire-and-forget), while the cheap reconcileRunsOnBoot (pure DB) stays
//       synchronous BEFORE listen; the background `.then`/`.catch` still logs the same summary/warn lines.
//   (2) BEHAVIORAL — reusing the SAME BoundedGitDeps.removeDir seam worktrees.mjs already proves bounded,
//       drive N never-resolving "stuck handle" removeWorktree calls SERIALLY through the exact
//       `void chain().then().catch()` idiom index.ts now uses, and prove the caller's next synchronous
//       statement (standing in for app.listen() returning) runs BEFORE any of the N removals settle, while
//       the background chain still completes all N, serially (elapsed ~= N * tinyMs, not ~= tinyMs).
// Run: 1) build daemon, 2) node test/boot-listen-not-blocked.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { removeWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
// See worktrees.mjs's TIMER_SLACK_MS: MONOTONIC performance.now() + slack for the bounded-timing floor,
// so a loaded CI runner can't flake a lower-bound assertion (v0.3.0 release-CI timing flake).
const TIMER_SLACK_MS = 50;

// ════════ (1) STRUCTURAL — the actual call-site ordering in the built daemon ════════
{
  const indexJs = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js"), "utf8");
  const listenIdx = indexJs.indexOf("app.listen(");
  const reconcileCallIdx = indexJs.indexOf("sessions.reconcileOrchestrationOnBoot(");
  const runsCallIdx = indexJs.indexOf("sessions.reconcileRunsOnBoot(");

  check("(1) built daemon calls app.listen(", listenIdx >= 0);
  check("(1) built daemon calls sessions.reconcileOrchestrationOnBoot(", reconcileCallIdx >= 0);
  check("(1) built daemon calls sessions.reconcileRunsOnBoot(", runsCallIdx >= 0);
  check("(1) reconcileOrchestrationOnBoot is called AFTER app.listen() (was before — the outage)",
    listenIdx >= 0 && reconcileCallIdx >= 0 && reconcileCallIdx > listenIdx);
  check("(1) reconcileRunsOnBoot (cheap, pure DB) STAYS synchronous BEFORE app.listen()",
    listenIdx >= 0 && runsCallIdx >= 0 && runsCallIdx < listenIdx);

  // Fire-and-forget: the reconcile call must NOT be directly `await`ed (that would re-introduce the
  // block). It must be a `void`-kicked promise chain instead.
  const beforeReconcile = reconcileCallIdx >= 0 ? indexJs.slice(Math.max(0, reconcileCallIdx - 20), reconcileCallIdx) : "";
  check("(1) reconcileOrchestrationOnBoot call is NOT directly awaited", !/await\s*$/.test(beforeReconcile));
  check("(1) reconcileOrchestrationOnBoot call is fire-and-forget (void-kicked)", /void\s*$/.test(beforeReconcile));

  // The background chain still completes the SAME summary log + warn — logic/observability unchanged.
  const region = indexJs.slice(reconcileCallIdx, reconcileCallIdx + 1500);
  check("(1) the backgrounded reconcile still logs its boot summary on success",
    /\[boot\] orchestration reconcile:/.test(region));
  check("(1) the backgrounded reconcile still warns (swallowed) on failure",
    /\[boot\] orchestration reconcile failed \(continuing boot\)/.test(region));
}

// ════════ (2) BEHAVIORAL — N never-resolving "stuck handle" removals don't block the caller ════════
{
  const N = 8; // mirrors the owner's reported 8-dangler outage
  const tinyMs = 120; // small but nonzero: distinguishes "returned instantly" from "waited ~the bound"
  const stubFastGit = () => ({ raw: async () => "" }); // git ops succeed fast → only the removal hangs
  const neverRemoveDir = () => new Promise(() => {}); // a stuck dir handle: this removal never settles
  const repoDummy = path.dirname(fileURLToPath(import.meta.url)); // never touched: git ops are stubbed

  // Mirrors reconcile's Pass B loop: SERIAL `await`ed removeWorktree calls (never parallelized — each
  // removal now runs in its own OS process, but Pass B still processes worktrees one at a time).
  async function serialPassB() {
    let processed = 0;
    for (let i = 0; i < N; i++) {
      await removeWorktree(repoDummy, path.join(repoDummy, `stuck-${i}`), { gitFactory: stubFastGit, removeDir: neverRemoveDir, timeoutMs: tinyMs });
      processed++;
    }
    return processed;
  }

  let reachedListen = false;
  const t0 = performance.now(); // MONOTONIC (see TIMER_SLACK_MS)
  const backgroundDone = new Promise((resolve) => {
    // The EXACT idiom index.ts now uses: void <call>().then(...).catch(...) — never awaited.
    void serialPassB().then((n) => resolve({ n, elapsed: performance.now() - t0 })).catch(() => resolve({ n: -1, elapsed: performance.now() - t0 }));
  });
  reachedListen = true; // stands in for "boot reaches app.listen()" — runs in the SAME synchronous tick

  check("(2) the caller's next statement (stand-in for app.listen()) runs BEFORE any removal settles",
    reachedListen === true && (performance.now() - t0) < tinyMs);

  const { n: processed, elapsed } = await backgroundDone;
  check(`(2) the background reconcile still processes all ${N} stuck worktrees (got ${processed})`, processed === N);
  check(`(2) removals ran SERIALLY, not parallelized — elapsed ${Math.round(elapsed)}ms ~= ${N}*${tinyMs}ms, not ~= ${tinyMs}ms`,
    elapsed >= N * tinyMs - TIMER_SLACK_MS);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the built daemon calls app.listen() BEFORE the fire-and-forget reconcileOrchestrationOnBoot kick (reconcileRunsOnBoot stays synchronous before listen); and N never-resolving stuck-handle removals (the BoundedGitDeps.rm seam) still let the caller's next statement run immediately while the background reconcile keeps processing them serially to completion."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
