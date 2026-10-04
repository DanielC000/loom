import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 422a8c66 (found while fixing card 5b7884c4, the codex sibling of this exact bug): `resolvedPathCache`
// (pty/claude-transcript.ts) is a bounded Map used as an LRU, but a cache HIT (the `fs.existsSync(cachedHit)`
// true branch inside `resolveTranscriptFile`) used to return early without ever touching the Map — only a
// fresh insert (a miss, via the readdir fallback scan) called `rememberResolvedPath`'s delete+re-set. That
// degenerates the eviction policy into plain insertion-order FIFO: an engine session id resolved on EVERY
// call still ages out on schedule, evicted by unrelated new insertions, never because it actually went cold.
// Same shape as card 677379ad's fix to sessionMetaCache and card 5b7884c4's identical fix to codex-
// transcript.ts's own resolvedPathCache (test/codex-resolved-path-cache-lru.mjs), mirrored here.
//
// This test proves the fix mechanically by counting real tree-walks (`fs.readdirSync` calls scoped to our
// own sandboxed `.claude/projects` root), the ONE place a cache MISS does disk work that a cache HIT never
// does — directly through the SAME `fs` module object the compiled SUT calls through (a property call,
// `fs.readdirSync(...)`, not a destructured binding).
//
// Isolation: HOME/USERPROFILE are sandboxed to a throwaway temp dir BEFORE importing dist — CLAUDE_PROJECTS_ROOT
// (pty/claude-transcript.ts) is derived from os.homedir() once at module import, so this MUST happen before
// the import, not merely before each call (see real-homedir-transcript-leak-isolation.mjs's identical
// discipline for the sibling sessions/transcript.ts surface). This never touches the real ~/.claude/projects.
// Every engine session id minted below carries a globally-unique-shaped random suffix (card 7d70b27b's own
// rule for any hermetic test exercising this fallback scan).
//
// Run: 1) build (turbo builds shared first), 2) node test/claude-resolved-path-cache-lru.mjs
import fsMod from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const sandboxHome = mkdtempManaged("loom-claude-resolved-path-lru-home-");
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE

const { resolveTranscriptFile, RESOLVED_PATH_CACHE_MAX } = await import("../dist/pty/claude-transcript.js");

const CLAUDE_PROJECTS_ROOT = path.join(sandboxHome, ".claude", "projects");
// A single real on-disk project dir every fixture file lives under. The cwd passed to resolveTranscriptFile
// below is a DIFFERENT, per-id fake cwd whose own encoded dir never matches this literal name — so the
// "direct" computed-path check inside resolveTranscriptFile always misses and every lookup must go through
// the cache / fallback-scan path under test.
const PROJECT_DIR = path.join(CLAUDE_PROJECTS_ROOT, "fixed-project-dir");
fsMod.mkdirSync(PROJECT_DIR, { recursive: true });

const unique = `${Date.now()}-${process.pid}`;
const sessionId = (i) => `${unique}-${String(i).padStart(6, "0")}-aaaaaaaaaaaaaaaaaaaaaaaa`; // uuid-shaped-ish, globally unique
const fakeCwd = (i) => `/fake/claude-resolved-path-lru-test-${i}`;

function writeTranscript(i) {
  const file = path.join(PROJECT_DIR, `${sessionId(i)}.jsonl`);
  fsMod.writeFileSync(file, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");
  return file;
}

// --- instrumentation: count real tree-walk (readdirSync) calls, scoped to our own sandboxed root so an
//     unrelated real-host directory can never pollute the count -------------------------------------------
let readdirCalls = 0;
const realReaddirSync = fsMod.readdirSync;
fsMod.readdirSync = function patchedReaddirSync(p, ...rest) {
  if (typeof p === "string" && p.startsWith(sandboxHome)) readdirCalls++;
  return realReaddirSync.call(fsMod, p, ...rest);
};

try {
  // --- fill the cache to exactly its cap, oldest (session_0) first -----------------------------------
  const paths = [];
  for (let i = 0; i < RESOLVED_PATH_CACHE_MAX; i++) {
    const f = writeTranscript(i);
    paths.push(f);
    const before = readdirCalls;
    const resolved = resolveTranscriptFile(fakeCwd(i), sessionId(i));
    check(`session_${i} initial resolve finds its own file (fresh miss)`, resolved === f);
    check(`session_${i} initial resolve did a real tree-walk (fresh miss)`, readdirCalls > before);
  }

  // Sanity check on the instrument itself (not yet discriminating): a hit on a safely-cached middle entry
  // must NOT do a tree-walk, proving `readdirCalls` can register a real hit as zero extra walks rather than
  // the counter being broken in a way that always just mirrors the miss count.
  {
    const before = readdirCalls;
    resolveTranscriptFile(fakeCwd(2), sessionId(2));
    check("re-resolving a safely-cached middle entry (session_2) does not re-walk the tree", readdirCalls === before);
  }

  // --- the actual case under test: hit the CURRENT oldest entry (session_0), then push one more resolve
  //     past the cap. The hit must refresh session_0's recency so it survives the eviction that follows;
  //     without the fix, the hit is a no-op and session_0 — still the oldest by insertion order — is the
  //     one evicted instead. -----------------------------------------------------------------------------
  const beforeHit0 = readdirCalls;
  const hit0 = resolveTranscriptFile(fakeCwd(0), sessionId(0));
  check("hit on session_0 returns its path unchanged", hit0 === paths[0]);
  check("the hit on session_0 did not re-walk the tree", readdirCalls === beforeHit0);

  const overflowFile = writeTranscript(RESOLVED_PATH_CACHE_MAX);
  paths.push(overflowFile);
  const beforeOverflow = readdirCalls;
  const overflowResolved = resolveTranscriptFile(fakeCwd(RESOLVED_PATH_CACHE_MAX), sessionId(RESOLVED_PATH_CACHE_MAX));
  check("the overflow resolve (past the cap) itself finds its own file", overflowResolved === overflowFile);
  check("the overflow resolve did a real tree-walk (fresh miss)", readdirCalls > beforeOverflow);

  const beforeReread0 = readdirCalls;
  const reread0 = resolveTranscriptFile(fakeCwd(0), sessionId(0));
  check(
    "session_0 (hit right before the overflow insert) is STILL cached once the cap is exceeded — the hit's " +
    "recency refresh protected it from eviction; RED on the pre-fix code, which evicts it anyway",
    readdirCalls === beforeReread0 && reread0 === paths[0],
  );

  const beforeReread1 = readdirCalls;
  const reread1 = resolveTranscriptFile(fakeCwd(1), sessionId(1));
  check(
    "session_1 (never re-hit — the true oldest entry once session_0 moved to the back) IS the one evicted, " +
    "and re-resolving it still returns the correct path via a fresh tree-walk — the cap is still enforced, " +
    "not merely disabled",
    readdirCalls > beforeReread1 && reread1 === paths[1],
  );

  // --- unaffected existing behaviour: a cached path whose file genuinely vanished from disk must still be
  //     treated as stale and re-resolved, exactly as before the fix (mirrors transcript-fallback-cache-
  //     coherence.mjs's case (A)). Reuses session_2, still cached at this point (only session_1 has been
  //     evicted so far). session_2's underlying file is deleted outright with nothing replacing it, so the
  //     correct outcome is a fresh tree-walk that finds nothing, not a stale dangling path. ----------------
  fsMod.rmSync(paths[2], { force: true });
  const beforeStale = readdirCalls;
  const afterDelete = resolveTranscriptFile(fakeCwd(2), sessionId(2));
  check(
    "a cached path whose file genuinely vanished from disk is not served back stale (re-walks and finds null)",
    afterDelete === null && readdirCalls > beforeStale,
  );
} finally {
  fsMod.readdirSync = realReaddirSync;
  delete process.env.HOME;
  delete process.env.USERPROFILE;
}

await finishAndExit(failures === 0 ? 0 : 1);
