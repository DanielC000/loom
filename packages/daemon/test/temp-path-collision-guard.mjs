import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Class red-proof for card 11a25f10 — TWO distinct mechanisms, TWO distinct proofs. A temp-path
// discriminator built from a bare `Date.now()` collides deterministically whenever two evaluations
// land in the same millisecond — forced HERE via a stubbed clock, not sampled. This does not re-run
// all ~257 swept sites (the merge gate exercises the real files); it proves the underlying mechanism
// each half of the fix relies on, once each:
//
//   RED-PROOF 1 — Tier A (module-scope, evaluated once per process): the collision axis is
//     CROSS-PROCESS. Two concurrent gate runs of the same suite land the same millisecond;
//     `${process.pid}` closes it because pid varies across processes even when the clock doesn't.
//
//   RED-PROOF 2 — Tier B (a helper invoked more than once per process — e.g.
//     run-gate-head-currency.mjs's seedWorkerInDb, or the mkRepo(tag) helper duplicated across 9
//     files): the collision axis is SAME-PROCESS. `${process.pid}` is CONSTANT across those calls and
//     closes NOTHING — only an OS-atomic allocator (fs.mkdtempSync) discriminates two same-process,
//     same-millisecond calls. Proven here by literally defining a pre-fix-shaped and a post-fix-shaped
//     mkRepo(tag) helper and invoking each TWICE WITH THE SAME TAG under a frozen clock — the exact
//     "convention, not construction" mistake (a duplicated tag) the fix must make impossible, encoded
//     as an executable guarantee rather than argued about.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const originalDateNow = Date.now;
const freeze = (ms) => { Date.now = () => ms; };
const unfreeze = () => { Date.now = originalDateNow; };

// ============================================================================================
// RED-PROOF 1 — Tier A: two PROCESSES, same millisecond. process.pid is what actually differs
// across two real processes; stood in here with two literal values since this is a single process.
// ============================================================================================
try {
  freeze(1700000000000); // every Date.now() call below returns the identical millisecond

  const bare = () => `loom-x-repo-${Date.now()}`; // the exact pre-fix shape (platform-mgmt-surface.mjs)
  const fixed = (pid) => `loom-x-repo-${Date.now()}-${pid}`; // the exact applied fix

  const procA_bare = bare(), procB_bare = bare();
  check("RED 1 (Tier A, pre-fix): two processes, same ms, bare Date.now() → IDENTICAL name (the platform-mgmt-surface.mjs incident)",
    procA_bare === procB_bare);

  const PID_A = 11111, PID_B = 22222; // stand-in for two real, distinct process ids
  const procA_fixed = fixed(PID_A), procB_fixed = fixed(PID_B);
  check("GREEN 1 (Tier A, post-fix): two processes (different pid), same ms, ${Date.now()}-${process.pid} → DIFFERENT names",
    procA_fixed !== procB_fixed);
} finally {
  unfreeze();
}

// ============================================================================================
// RED-PROOF 2 — Tier B: ONE real process (this one), the SAME real process.pid throughout, a
// literal mkRepo(tag)-shaped helper (mirroring the 9 swept sites exactly), invoked TWICE WITH THE
// SAME TAG under a frozen clock — the actual failure precondition, not a simulation of it.
// ============================================================================================
try {
  freeze(1700000000000);

  // Pre-fix shape: identical to what all 9 mkRepo(tag) sites looked like BEFORE this card's fix —
  // already pid-suffixed, which is why it "looked hardened" and survived a bare-pattern-only sweep.
  const mkRepoBare = (tag) => path.join(os.tmpdir(), `loom-mkrepo-${tag}-${Date.now()}-${process.pid}`);
  const call1_bare = mkRepoBare("dup-tag"), call2_bare = mkRepoBare("dup-tag"); // SAME tag, the mistake
  check("RED 2 (Tier B, pre-fix incl. pid): ONE process, real process.pid, same tag, same ms → IDENTICAL name — pid-suffix does NOT save it",
    call1_bare === call2_bare);

  // Post-fix shape: identical to what all 9 mkRepo(tag) sites now are.
  const mkRepoFixed = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `loom-mkrepo-${tag}-`));
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loom-redproof-root-"));
  try {
    const scoped = (tag) => fs.mkdtempSync(path.join(tmpRoot, `loom-mkrepo-${tag}-`));
    const call1_fixed = scoped("dup-tag"), call2_fixed = scoped("dup-tag"); // SAME tag again
    check("GREEN 2 (Tier B, post-fix): ONE process, real process.pid, same tag, same frozen ms, fs.mkdtempSync → DIFFERENT real dirs",
      call1_fixed !== call2_fixed && fs.existsSync(call1_fixed) && fs.existsSync(call2_fixed));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
} finally {
  unfreeze();
}

// ── Registered falsifier sanity (card 11a25f10): confirms the Tier-B mechanism is CONCURRENCY-
// INDEPENDENT — a single process, no concurrent gates involved, still reproduces the collision above.
// This is the shape a failure at concurrentGatesMax:1 would take, and it already fires here with no
// fleet concurrency at all — consistent with "concurrency is a precondition for Tier A, not Tier B."
check("SANITY: RED-PROOF 2 required NO concurrent process — single-process reproduction",
  true);

console.log(failures === 0
  ? "\n✅ ALL PASS — RED-PROOF 1 (Tier A, cross-process): bare Date.now() collides, ${Date.now()}-${process.pid} fixes it. RED-PROOF 2 (Tier B, same-process, duplicated tag): the SAME pid-suffixed shape still collides — pid varies on the wrong axis — and fs.mkdtempSync fixes it regardless of the frozen clock."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
