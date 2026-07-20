import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 9983eed6 — Code Reviewer follow-up (BLOCKING Major): the cold-cache stampede fix for
// getMergedCommitMapCached (git/worktrees.ts). The bug: the map cache stored only the RESOLVED entry, no
// in-flight-promise memoization — so on a COLD cache, N concurrent getTaskMergedInfo callers for the SAME
// repo (exactly what listProjectTasks's Promise.all fan-out over a project's tasks does, and what
// list_all_tasks does across projects, and what a companion + a manager reading concurrently does) would
// ALL pass the cache-miss check before any of them finished scanning (readHeadSha's fs read resolves far
// faster than the `git log -n 5000` subprocess), each spawning its OWN full scan. The killer: the cache
// invalidates on every HEAD move, i.e. every MERGE — exactly when a board read is likely to happen.
//
// FAKE gitFactory (the same injectable BoundedGitDeps seam other hermetic tests use — see
// worktrees.mjs/boot-reconcile*.mjs) counts every "git log" invocation and returns a canned empty log
// after a tick (so overlapping callers have a real window to race in), proving dedup STRUCTURALLY — by
// counting actual subprocess-equivalent calls — rather than by timing a real git binary.
//
// Proves:
//   (1) N concurrent getTaskMergedInfo calls on a COLD cache for the SAME repo trigger exactly ONE scan.
//   (2) a subsequent call against the now-WARM cache triggers ZERO additional scans.
//   (3) a DIFFERENT repo gets its OWN scan — dedup is per-repo, not a global over-collapse.
//
// Run: 1) build (turbo builds shared first), 2) node test/task-merged-state-concurrency.mjs
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { getTaskMergedInfo, __resetMergedCommitMapCacheForTest } = await import("../dist/git/worktrees.js");

/** A fake BoundedGitDeps.gitFactory that counts "git log" calls and returns an empty log after a tick
 *  (simulating real subprocess latency) — never touches the real simple-git/git binary. */
function makeSpyFactory() {
  let logCalls = 0;
  const gitFactory = () => ({
    raw: async (args) => {
      if (args[0] === "log") {
        logCalls++;
        await new Promise((r) => setTimeout(r, 20)); // give overlapping callers a window to race in
        return ""; // empty log -> empty merged map -> every lookup below misses (no ancestry-guard calls)
      }
      return ""; // "branch --list" / "merge-base" — unreached here since the map stays empty
    },
  });
  return { gitFactory, count: () => logCalls };
}

__resetMergedCommitMapCacheForTest();

try {
  // (1) N concurrent callers, COLD cache, SAME (fake) repo — must collapse to ONE scan.
  const REPO_A = "C:/fake-repo-a-for-merged-concurrency-test";
  const spyA = makeSpyFactory();
  const N = 12;
  const taskIds = Array.from({ length: N }, (_, i) => `task-${i}`);
  const results = await Promise.all(taskIds.map((id) => getTaskMergedInfo(REPO_A, id, { gitFactory: spyA.gitFactory })));
  check("(1) all N concurrent calls resolve (empty scan -> no matching branch -> null)", results.every((r) => r === null));
  check(`(1) cold-cache stampede fix: ${N} concurrent callers on one repo triggered exactly ONE git-log scan (got ${spyA.count()})`, spyA.count() === 1);

  // (2) a further call against the now-WARM cache (same repo, same fake HEAD) triggers NO new scan.
  await getTaskMergedInfo(REPO_A, "task-warm-check", { gitFactory: spyA.gitFactory });
  check("(2) a subsequent call against the warm cache triggers ZERO additional scans", spyA.count() === 1);

  // (3) a DIFFERENT repo gets its OWN scan — dedup is per-repo, never a global over-collapse across repos.
  const REPO_B = "C:/fake-repo-b-for-merged-concurrency-test";
  const spyB = makeSpyFactory();
  const resultsB = await Promise.all(taskIds.map((id) => getTaskMergedInfo(REPO_B, id, { gitFactory: spyB.gitFactory })));
  check("(3) the second repo's concurrent calls also all resolve null", resultsB.every((r) => r === null));
  check(`(3) the second repo triggers its OWN single scan (got ${spyB.count()}), not reusing repo A's`, spyB.count() === 1);
  check("(3) repo A's count is UNCHANGED by repo B's scan (per-repo isolation)", spyA.count() === 1);
} finally {
  __resetMergedCommitMapCacheForTest();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — getMergedCommitMapCached's in-flight-promise dedup collapses N concurrent cold-cache callers on the SAME repo into exactly ONE git-log scan (not N concurrent git-log-5000 subprocesses), serves a subsequent warm-cache read from cache with zero new scans, and keeps dedup strictly per-repo."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
