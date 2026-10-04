import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 5b7884c4: `resolvedPathCache` (codex-transcript.ts) is a bounded Map used as an LRU, but a cache
// HIT (the `fs.existsSync(cachedHit)` true branch inside `resolveTranscriptFile`) used to return early
// without ever touching the Map — only a fresh insert (a miss, via the tree-walk fallback) called
// `rememberResolvedPath`'s delete+re-set. That degenerates the eviction policy into plain insertion-order
// FIFO: a conversation id resolved on EVERY call still ages out on schedule, evicted by unrelated new
// insertions, never because it actually went cold. Same shape as card 677379ad's identical fix to the
// sibling `sessionMetaCache` (test/codex-session-meta-cache-lru.mjs), mirrored here.
//
// This test proves the fix mechanically by counting real tree-walks (`fs.readdirSync` calls), the ONE
// place a cache MISS does disk work that a cache HIT never does — directly through the SAME `fs` module
// object the compiled SUT calls through (a property call, `fs.readdirSync(...)`, not a destructured
// binding — mirrors the sibling test's `fs.openSync` instrumentation).
//
// Isolation: `codexSessionsRoot()` reads `CODEX_HOME` fresh on every call (never cached at module load —
// see that function's own doc comment), so setting `process.env.CODEX_HOME` to a throwaway temp dir
// before calling into this module gives genuine isolation from any real `~/.codex/sessions` corpus on
// this host. Every conversation id minted below is a globally-unique-shaped random suffix, so even the
// (unrelated, LOOM_HOME-rooted) archive-root fallback scan can never collide with real on-host data.
//
// Run: 1) build (turbo builds shared first), 2) node test/codex-resolved-path-cache-lru.mjs
import fsMod from "node:fs";
import path from "node:path";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const dir = mkdtempManaged("loom-codex-resolved-path-lru-");
process.env.CODEX_HOME = dir; // read fresh per-call by codexSessionsRoot() — set before any call below

const { resolveTranscriptFile, RESOLVED_PATH_CACHE_MAX } = await import("../dist/pty/codex-transcript.js");

const CWD = "/fake/resolved-path-lru-test";
const unique = `${Date.now()}-${process.pid}`;
const convId = (i) => `conv-${unique}-${String(i).padStart(6, "0")}`;

const dayDir = path.join(dir, "sessions", "2026", "10", "03");
fsMod.mkdirSync(dayDir, { recursive: true });

function writeRollout(i) {
  const file = path.join(dayDir, `rollout-2026-10-03T00-00-00-${convId(i)}.jsonl`);
  fsMod.writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { cwd: CWD } }) + "\n");
  return file;
}

// --- instrumentation: count real tree-walk (readdirSync) calls, scoped to our own temp root so an
//     unrelated real-host directory (e.g. a genuine codex-rollout-archive) can never pollute the count --
let readdirCalls = 0;
const realReaddirSync = fsMod.readdirSync;
fsMod.readdirSync = function patchedReaddirSync(p, ...rest) {
  if (typeof p === "string" && p.startsWith(dir)) readdirCalls++;
  return realReaddirSync.call(fsMod, p, ...rest);
};

try {
  // --- fill the cache to exactly its cap, oldest (conv_0) first -------------------------------------
  const paths = [];
  for (let i = 0; i < RESOLVED_PATH_CACHE_MAX; i++) {
    const f = writeRollout(i);
    paths.push(f);
    const before = readdirCalls;
    const resolved = resolveTranscriptFile(CWD, convId(i));
    check(`conv_${i} initial resolve finds its own file (fresh miss)`, resolved === f);
    check(`conv_${i} initial resolve did a real tree-walk (fresh miss)`, readdirCalls > before);
  }

  // Sanity check on the instrument itself (not yet discriminating): a hit on a safely-cached middle
  // entry must NOT do a tree-walk, proving `readdirCalls` can register a real hit as zero extra walks
  // rather than the counter being broken in a way that always just mirrors the miss count.
  {
    const before = readdirCalls;
    resolveTranscriptFile(CWD, convId(2));
    check("re-resolving a safely-cached middle entry (conv_2) does not re-walk the tree", readdirCalls === before);
  }

  // --- the actual case under test: hit the CURRENT oldest entry (conv_0), then push one more resolve
  //     past the cap. The hit must refresh conv_0's recency so it survives the eviction that follows;
  //     without the fix, the hit is a no-op and conv_0 — still the oldest by insertion order — is the
  //     one evicted instead. ------------------------------------------------------------------------
  const beforeHit0 = readdirCalls;
  const hit0 = resolveTranscriptFile(CWD, convId(0));
  check("hit on conv_0 returns its path unchanged", hit0 === paths[0]);
  check("the hit on conv_0 did not re-walk the tree", readdirCalls === beforeHit0);

  const overflowFile = writeRollout(RESOLVED_PATH_CACHE_MAX);
  paths.push(overflowFile);
  const beforeOverflow = readdirCalls;
  const overflowResolved = resolveTranscriptFile(CWD, convId(RESOLVED_PATH_CACHE_MAX));
  check("the overflow resolve (past the cap) itself finds its own file", overflowResolved === overflowFile);
  check("the overflow resolve did a real tree-walk (fresh miss)", readdirCalls > beforeOverflow);

  const beforeReread0 = readdirCalls;
  const reread0 = resolveTranscriptFile(CWD, convId(0));
  check(
    "conv_0 (hit right before the overflow insert) is STILL cached once the cap is exceeded — the hit's " +
    "recency refresh protected it from eviction; RED on the pre-fix code, which evicts it anyway",
    readdirCalls === beforeReread0 && reread0 === paths[0],
  );

  const beforeReread1 = readdirCalls;
  const reread1 = resolveTranscriptFile(CWD, convId(1));
  check(
    "conv_1 (never re-hit — the true oldest entry once conv_0 moved to the back) IS the one evicted, and " +
    "re-resolving it still returns the correct path via a fresh tree-walk — the cap is still enforced, " +
    "not merely disabled",
    readdirCalls > beforeReread1 && reread1 === paths[1],
  );

  // --- unaffected existing behaviour: a cached path whose file genuinely vanished from disk must still
  //     be treated as stale and re-resolved, exactly as before the fix. Reuses conv_2, which is still
  //     cached at this point (only one eviction — conv_1 — has happened so far). ---------------------
  const relocated = path.join(dayDir, `rollout-2026-10-03T00-00-01-${convId(2)}.jsonl`);
  fsMod.renameSync(paths[2], relocated);
  paths[2] = relocated;
  const beforeStale = readdirCalls;
  const afterMove = resolveTranscriptFile(CWD, convId(2));
  check(
    "a cached path whose file genuinely moved on disk is still re-resolved via a fresh tree-walk, never " +
    "served a dangling stale path — the fix does not touch this invalidation path",
    afterMove === relocated && readdirCalls > beforeStale,
  );
} finally {
  fsMod.readdirSync = realReaddirSync;
  delete process.env.CODEX_HOME;
}

await finishAndExit(failures === 0 ? 0 : 1);
