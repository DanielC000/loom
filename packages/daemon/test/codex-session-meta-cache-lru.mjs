import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 677379ad: `sessionMetaCache` (codex-transcript.ts) is a bounded Map used as an LRU, but a cache
// HIT used to return early without ever touching the Map — only a fresh insert (a miss) called
// `rememberSessionMeta`'s delete+re-set. That degenerates the eviction policy into plain insertion-order
// FIFO: an entry read on EVERY call (e.g. via `snapshotExistingConversationIdsForSpawn`'s unconditional
// full-corpus walk, called on every fresh codex spawn) still ages out on schedule, evicted by unrelated
// new insertions, never because it actually went cold.
//
// This test proves the fix mechanically, without depending on filesystem mtime-precision round-tripping
// (an exact-equality trap the sibling mtime-skew test had to work around with tolerances): it monkeypatches
// `fs.openSync` — the ONE place `readSessionMeta`'s content read (`readFirstLine`) actually touches disk —
// to count real re-reads per path, directly through the SAME `fs` module object the compiled SUT calls
// through (a property call, `fs.openSync(...)`, not a destructured binding — confirmed in dist).
//
// Run: 1) build (turbo builds shared first), 2) node test/codex-session-meta-cache-lru.mjs
import fsMod from "node:fs";
import path from "node:path";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { readSessionMeta, SESSION_META_CACHE_MAX } = await import("../dist/pty/codex-transcript.js");

const dir = mkdtempManaged("loom-codex-session-meta-lru-");
const CWD = "/fake/lru-test";
const origId = (i) => `orig-${String(i).padStart(6, "0")}`;

function writeMeta(i) {
  const file = path.join(dir, `rollout-${i}.jsonl`);
  const line = JSON.stringify({ type: "session_meta", payload: { session_id: origId(i), cwd: CWD } });
  fsMod.writeFileSync(file, line + "\n");
  return file;
}

// --- instrumentation: count real content-opens per absolute path -----------------------------------
const opens = new Map();
const realOpenSync = fsMod.openSync;
fsMod.openSync = function patchedOpenSync(p, ...rest) {
  if (typeof p === "string") opens.set(p, (opens.get(p) ?? 0) + 1);
  return realOpenSync.call(fsMod, p, ...rest);
};
const openCount = (file) => opens.get(file) ?? 0;

try {
  // --- fill the cache to exactly its cap, oldest (file_0) first -------------------------------------
  const files = [];
  for (let i = 0; i < SESSION_META_CACHE_MAX; i++) {
    const f = writeMeta(i);
    files.push(f);
    const meta = readSessionMeta(f);
    if (meta?.sessionId !== origId(i)) { check(`file_${i} initial read returns its own session id`, false); }
  }
  check(
    `all ${SESSION_META_CACHE_MAX} fill-phase files were opened exactly once each (fresh misses)`,
    files.every((f) => openCount(f) === 1),
  );

  // Sanity check on the instrument itself (not yet discriminating): a hit on a safely-cached middle
  // entry must not re-open it, proving `openCount` can register a real hit as 0 extra opens rather than
  // the counter being broken in a way that always just mirrors the miss count.
  readSessionMeta(files[2]);
  check(
    "re-reading a safely-cached middle entry (file_2) does not re-open it",
    openCount(files[2]) === 1,
  );

  // --- the actual case under test: hit the CURRENT oldest entry (file_0), then push one more insert
  //     past the cap. The hit must refresh file_0's recency so it survives the eviction that follows;
  //     without the fix, the hit is a no-op and file_0 — still the oldest by insertion order — is the one
  //     evicted instead. ------------------------------------------------------------------------------
  const hit0 = readSessionMeta(files[0]);
  check("hit on file_0 returns its session id unchanged", hit0?.sessionId === origId(0));
  check("the hit on file_0 did not re-open it", openCount(files[0]) === 1);

  const overflow = writeMeta(SESSION_META_CACHE_MAX);
  files.push(overflow);
  const overflowMeta = readSessionMeta(overflow);
  check("the overflow insert (past the cap) itself reads correctly", overflowMeta?.sessionId === origId(SESSION_META_CACHE_MAX));

  const reread0 = readSessionMeta(files[0]);
  check(
    "file_0 (hit right before the overflow insert) is STILL cached once the cap is exceeded — the hit's " +
    "recency refresh protected it from eviction; RED on the pre-fix code, which evicts it anyway",
    openCount(files[0]) === 1 && reread0?.sessionId === origId(0),
  );

  const reread1 = readSessionMeta(files[1]);
  check(
    "file_1 (never re-hit — the true oldest entry once file_0 moved to the back) IS the one evicted, and " +
    "a re-read of it still returns the correct, freshly re-parsed value — the cap is still enforced, not " +
    "merely disabled",
    openCount(files[1]) === 2 && reread1?.sessionId === origId(1),
  );

  // --- unaffected existing behaviour: a genuine on-disk change (mtime AND size) must still invalidate
  //     the cache exactly as before the fix. Reuses file_2, which is still cached at this point (only one
  //     eviction — file_1 — has happened so far), so this really exercises the staleness-detection branch,
  //     not just a plain cold miss. ----------------------------------------------------------------------
  const changedFile = files[2];
  const opensBefore = openCount(changedFile);
  const newLine = JSON.stringify({ type: "session_meta", payload: { session_id: "changed-session-id", cwd: CWD } });
  fsMod.writeFileSync(changedFile, newLine + "\n"); // different length + a fresh mtime: a real on-disk change
  const afterChange = readSessionMeta(changedFile);
  check(
    "a cached file whose content (and therefore mtime/size) genuinely changed on disk is still re-read, " +
    "never served stale — the fix does not touch this invalidation path",
    afterChange?.sessionId === "changed-session-id" && openCount(changedFile) === opensBefore + 1,
  );
} finally {
  fsMod.openSync = realOpenSync;
}

await finishAndExit(failures === 0 ? 0 : 1);
