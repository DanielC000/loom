import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card cee17efe — PURE logic for the automatic post-ungated-landing "which test files directly import a
// touched dist module" advisory (orchestration/dist-importer-check.ts). No git, no worktree, no child
// process — see dist-importer-direct-scan.mjs for the real AST scan, and dist-importer-check-glue.mjs for
// the service.ts wiring (worktree lifecycle, coalescing integration, the no-repo-guard admission shape).
//
//   (1) srcTsPathToDistPath / touchedDistPathsFor: maps changed packages/daemon/src/**/*.ts paths to their
//       dist/**/*.js counterparts; drops .d.ts, non-src, and dedupes.
//   (2) computeDistImporterCap: a corpus-RELATIVE 60% cap (SECOND LEAD ruling, 2026-10-09) — NOT a fixed
//       file count, and NEVER a skip. Proves the cap now covers fe1cdf10's own 820/1627=50.4% run-set
//       (which the ORIGINAL 50%-skip design would have dropped to zero coverage).
//   (2b) rankAndCapRunSet: ranks by touched-module-import COUNT descending (never mtime — a fresh
//       worktree gives every file the same checkout-time mtime), alphabetical tiebreak; proves a
//       2-touched-module file outranks a 1-touched-module file regardless of alphabetical order.
//   (3) enqueueLanding / drainFollowUp: the coalescing queue — two rapid landings fold into ONE follow-up
//       run covering the union of touched modules, never two concurrent runs.
//   (4) nudge text: pass/fail/mechanism-failure shapes all name the landed sha and state plainly that
//       this never affects the gate interval counter or gateOwed; the fail shape names the "candidate,
//       not a verdict" caveat (LEAD ruling C); a CAPPED pass/fail nudge says "ran N of M… not run".
const M = await import("../dist/orchestration/dist-importer-check.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// ── (1) src -> dist path mapping ──────────────────────────────────────────────────────────────────────
check("(1) a real src .ts path maps to its dist .js counterpart", M.srcTsPathToDistPath("packages/daemon/src/sessions/service.ts") === "packages/daemon/dist/sessions/service.js");
check("(1) a nested path maps correctly", M.srcTsPathToDistPath("packages/daemon/src/pty/host.ts") === "packages/daemon/dist/pty/host.js");
check("(1) a .d.ts file maps to null (no runtime .js)", M.srcTsPathToDistPath("packages/daemon/src/types.d.ts") === null);
check("(1) a non-src path maps to null", M.srcTsPathToDistPath("packages/web/src/App.tsx") === null);
check("(1) a test path maps to null", M.srcTsPathToDistPath("packages/daemon/test/foo.mjs") === null);
check("(1) a bare src/ with nothing after it maps to null", M.srcTsPathToDistPath("packages/daemon/src/.ts") === null);
{
  const touched = M.touchedDistPathsFor([
    "packages/daemon/src/sessions/service.ts",
    "packages/daemon/src/pty/host.ts",
    "packages/daemon/src/pty/host.ts", // duplicate — must dedupe
    "packages/shared/src/types.ts", // out of scope — dropped
    "packages/daemon/src/types.d.ts", // declaration-only — dropped
  ]);
  check("(1) touchedDistPathsFor dedupes and drops out-of-scope/declaration paths", touched.length === 2 && touched.includes("packages/daemon/dist/sessions/service.js") && touched.includes("packages/daemon/dist/pty/host.js"));
}

// ── (2) corpus-relative cap — NOT a fixed count, and never a skip ─────────────────────────────────────
check("(2) the cap is 60% of the corpus, floored", M.computeDistImporterCap(1627) === Math.floor(1627 * 0.6));
check("(2) the cap never zeroes out on a real corpus (min 1)", M.computeDistImporterCap(1) === 1);
check("(2) a degenerate zero-size corpus caps at 0 (nothing to run)", M.computeDistImporterCap(0) === 0);
// The historical-incident proof: fe1cdf10's own run-set (820/1627 = 50.4%) individually exceeded the
// ORIGINAL 50%-skip threshold, which would have dropped it to ZERO coverage — the exact gap that
// prompted this second ruling. Under the real 60% cap (976 of 1627), it now runs in FULL.
check("(2) fe1cdf10's own run-set (820/1627) is UNDER the real 60% cap (976) — runs in full, not capped", 820 <= M.computeDistImporterCap(1627));
check("(2) that SAME run-set would have exceeded the ORIGINAL 50% skip threshold — proves why it was replaced", 820 > Math.floor(1627 * 0.5));

// ── (2b) ranking: touched-module-import count beats alphabetical order ───────────────────────────────
{
  // "z.mjs" would win under pure alphabetical ordering if ranking were ignored — it must NOT win here.
  const candidates = [
    { path: "packages/daemon/test/a.mjs", touchedCount: 1 },
    { path: "packages/daemon/test/z.mjs", touchedCount: 2 },
  ];
  const { runSet, matchedSize } = M.rankAndCapRunSet(candidates, 1);
  check("(2b) a file importing 2 touched modules ranks ahead of one importing 1, REGARDLESS of alphabetical order", runSet.length === 1 && runSet[0] === "packages/daemon/test/z.mjs");
  check("(2b) matchedSize reports the TOTAL eligible count before capping", matchedSize === 2);
}
{
  // equal counts tie-break alphabetically.
  const candidates = [
    { path: "packages/daemon/test/b.mjs", touchedCount: 1 },
    { path: "packages/daemon/test/a.mjs", touchedCount: 1 },
  ];
  const { runSet } = M.rankAndCapRunSet(candidates, 1);
  check("(2b) equal touched-counts tie-break alphabetically", runSet.length === 1 && runSet[0] === "packages/daemon/test/a.mjs");
}
{
  // cap >= candidates.length runs everything, unordered-safe (full set, order doesn't matter to the caller).
  const candidates = [
    { path: "packages/daemon/test/b.mjs", touchedCount: 1 },
    { path: "packages/daemon/test/a.mjs", touchedCount: 2 },
  ];
  const { runSet, matchedSize } = M.rankAndCapRunSet(candidates, 5);
  check("(2b) a cap at or above the matched count runs everything", runSet.length === 2 && matchedSize === 2);
}

// ── (3) coalescing: two rapid landings fold into ONE follow-up run ────────────────────────────────────
{
  const q = M.newDistImporterCheckQueueState();
  const first = M.enqueueLanding(q, "sha1", ["packages/daemon/dist/sessions/service.js"]);
  check("(3) the first landing on an idle queue runs immediately", first.shouldRunNow === true && q.running === true);
  const second = M.enqueueLanding(q, "sha2", ["packages/daemon/dist/pty/host.js"]);
  check("(3) a second landing arriving WHILE the first is running is folded in, not run immediately", second.shouldRunNow === false);
  const third = M.enqueueLanding(q, "sha3", ["packages/daemon/dist/pty/host.js", "packages/daemon/dist/git/worktrees.js"]);
  check("(3) a third landing is folded into the SAME pending batch (still only one in-flight run)", third.shouldRunNow === false && q.pendingShas.length === 2);
  const followUp = M.drainFollowUp(q);
  check("(3) draining after the first run settles returns ONE follow-up batch at the NEWEST sha", followUp !== null && followUp.sha === "sha3");
  check("(3) the follow-up batch is the UNION of every touched module folded in WHILE RUNNING (2 distinct modules — sha2's host.js + sha3's host.js+worktrees.js, deduped; sha1's own service.js was already covered by the run that just settled, never folded into the pending batch)", followUp.touchedDistPaths.length === 2
    && followUp.touchedDistPaths.includes("packages/daemon/dist/pty/host.js")
    && followUp.touchedDistPaths.includes("packages/daemon/dist/git/worktrees.js")
    && !followUp.touchedDistPaths.includes("packages/daemon/dist/sessions/service.js"));
  check("(3) the queue is still marked running (the caller is about to kick the follow-up run)", q.running === true);
  const nothingPending = M.drainFollowUp(q);
  check("(3) draining again with nothing newly arrived returns null and marks the queue idle", nothingPending === null && q.running === false);
  const freshRun = M.enqueueLanding(q, "sha4", []);
  check("(3) a landing arriving after the queue went idle runs immediately again (not folded into a stale batch)", freshRun.shouldRunNow === true);
}

// ── (4) nudge text ─────────────────────────────────────────────────────────────────────────────────────
{
  const pass = M.formatDistImporterResultNudge({ landedSha: "abcdef1234567890", touchedDistPaths: ["packages/daemon/dist/sessions/service.js"], ranSize: 3, matchedSize: 3, passed: true });
  check("(4) an UNCAPPED passing nudge names the short landed sha, the run count, and the touched module", pass.includes("abcdef12") && pass.includes("3 test file") && pass.includes("sessions/service"));
  check("(4) an uncapped nudge never says 'ran N of M' (nothing was capped)", !pass.includes(" of "));
  check("(4) a passing nudge states it never touches the gate interval counter or gateOwed", pass.includes("gate interval counter") && pass.includes("gateOwed"));
  check("(4) a passing nudge never claims it ran 'the gate'", !pass.includes("ran the gate"));

  const capped = M.formatDistImporterResultNudge({ landedSha: "abcdef1234567890", touchedDistPaths: ["packages/daemon/dist/sessions/service.js"], ranSize: 976, matchedSize: 1200, passed: true });
  check("(4) a CAPPED passing nudge says 'ran N of M' and names what's left over + the cap", capped.includes("ran 976 of 1200") && capped.includes("224 not run") && capped.includes("cap 60% of corpus"));

  // @decision 2f0b2e57 — failingTest is a matching LINE, never a file (or file list); the nudge must say
  // so, and must say when it's an incomplete account (failingTestCount > 1).
  const fail = M.formatDistImporterResultNudge({ landedSha: "abcdef1234567890", touchedDistPaths: ["packages/daemon/dist/pty/host.js"], ranSize: 5, matchedSize: 5, passed: false, failingTest: "FAIL worker-lineage-scope.mjs", failingTestCount: 1 });
  check("(4) a failing nudge names the failing line and labels it a LINE, not a file", fail.includes("FAIL worker-lineage-scope.mjs") && fail.includes("matching LINE, not an attributed file"));
  check("(4) a complete-account (failingTestCount===1) nudge never adds the '1 of N' incomplete-account caveat", !fail.includes("1 of 1") && !fail.includes(" of "));
  check("(4) a failing nudge states a red here is a CANDIDATE, not a verdict, and tells the manager to re-run on main first", fail.includes("candidate, not a verdict") && fail.toLowerCase().includes("re-run"));
  check("(4) a failing nudge ALSO states it never touches the gate interval counter or gateOwed", fail.includes("gate interval counter") && fail.includes("gateOwed"));

  const failMulti = M.formatDistImporterResultNudge({ landedSha: "abcdef1234567890", touchedDistPaths: ["packages/daemon/dist/pty/host.js"], ranSize: 5, matchedSize: 5, passed: false, failingTest: "FAIL worker-lineage-scope.mjs", failingTestCount: 3 });
  check("(4) failingTestCount > 1: the nudge names the ONE line it has AND says it's only 1 of N, not a complete account", failMulti.includes("FAIL worker-lineage-scope.mjs") && failMulti.includes("1 of 3 matching lines") && failMulti.toLowerCase().includes("don't size a fix from this line alone"));

  const failUnnamed = M.formatDistImporterResultNudge({ landedSha: "abcdef1234567890", touchedDistPaths: ["packages/daemon/dist/pty/host.js"], ranSize: 5, matchedSize: 5, passed: false, failingTest: undefined, failingTestCount: undefined });
  check("(4) failingTest undefined: the nudge says (unnamed), never a blank/empty failure clause, and never claims a '1 of N' caveat with nothing to count", failUnnamed.includes("(unnamed") && !failUnnamed.includes("1 of"));

  const mech = M.formatDistImporterMechanismFailureNudge({ landedSha: "abcdef1234567890", reason: "could not build the isolated worktree" });
  check("(4) a mechanism-failure nudge is worded distinctly from a real test failure", mech.includes("mechanism failure, not a test result") && mech.includes("could not build the isolated worktree"));
}
check("(4) formatDistImporterOversizeSkipNudge was REMOVED (second LEAD ruling: never skip)", M.formatDistImporterOversizeSkipNudge === undefined && M.isRunSetOversize === undefined);

console.log(failures === 0
  ? "\n✅ ALL PASS — src->dist mapping, the corpus-relative oversize cap, the coalescing queue, and every nudge shape behave as the LEAD ruling specifies."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
