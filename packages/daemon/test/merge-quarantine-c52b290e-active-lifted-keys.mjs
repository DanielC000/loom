import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card c52b290e, Site 4 — clearMergeQuarantineByRecordedPath's own `activeLiftedKeys` computation
// (extracted into `activeMatchesAndLiftedKeysFor`) under-included a re-pointed multi-key twin's SECOND
// (and later) live-armed key: `seen.has(entry)` fired on that key's own Map-iteration visit BEFORE
// `activeLiftedKeys.add(key)` ever ran, since `seen` was already populated by the twin's FIRST key.
//
// Investigation (card c52b290e) found this did NOT reproduce as an END-USER-OBSERVABLE defect: the
// delegated `clearMergeQuarantineByKey` call independently recomputes its own `keysToLift` via
// `liveArmedKeys`, which already recovers the twin's other key regardless of what this caller passed as
// `externalLiftedKeys`. This test asserts the LOCAL fix directly — `activeLiftedKeys` itself now contains
// every live-armed key of a multi-key twin — as a narrow regression guard for the actual code change,
// independent of whether today's one observable consumption path happens to mask it.
//
// Run: 1) build daemon (pnpm --filter @loom/daemon build), 2) node test/merge-quarantine-c52b290e-active-lifted-keys.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mqc52b290e-s4-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const { activeMatchesAndLiftedKeysFor, setActiveQuarantineTestOnly, directPathIdentity, MERGE_QUARANTINE_DIR } = await import(mergeQuarantineModuleHref);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

{
  const sfx = freshSfx();
  const X = `C:\\mqc52b290e-s4-${sfx}-never`;
  const K = `mqc52b290e-s4-K-${sfx}`;
  const K2 = `mqc52b290e-s4-K2-${sfx}`;

  // Re-pointed multi-key twin: LIVE-armed (by reference) at BOTH K and K2, armedKeys EMPTY — so K2 is
  // recoverable ONLY via this loop's own live Map iteration, never via entry.armedKeys.
  const entry = { repoPath: X, branch: "b", reason: "twin", enteredAt: Date.now(), tokens: ["tok"], armedKeys: [] };
  setActiveQuarantineTestOnly(K, entry);
  setActiveQuarantineTestOnly(K2, entry);

  const identity = directPathIdentity(X);
  const { matched, activeLiftedKeys } = activeMatchesAndLiftedKeysFor(identity);

  check("*** SITE 4 *** activeLiftedKeys contains K", activeLiftedKeys.has(K));
  check("*** SITE 4 *** activeLiftedKeys contains K2 (CARD c52b290e'S OWN GAP — the twin's second live key)", activeLiftedKeys.has(K2));
  check("*** SITE 4 *** matched de-dups the twin to exactly ONE entry (not two)", matched.length === 1);
}

{
  // NEGATIVE CONTROL — a SINGLE-key entry (the ordinary, non-twin shape) still matches exactly as before:
  // activeLiftedKeys contains only its own key, matched has exactly one row. Proves the fix did not widen
  // the ordinary case.
  const sfx = freshSfx();
  const X = `C:\\mqc52b290e-s4-${sfx}-never`;
  const K = `mqc52b290e-s4-K-${sfx}`;
  const entry = { repoPath: X, branch: "b", reason: "single", enteredAt: Date.now(), tokens: ["tok"], armedKeys: [K] };
  setActiveQuarantineTestOnly(K, entry);

  const identity = directPathIdentity(X);
  const { matched, activeLiftedKeys } = activeMatchesAndLiftedKeysFor(identity);

  check("*** SITE 4 *** (negative control) single-key entry: activeLiftedKeys is exactly {K}", activeLiftedKeys.size === 1 && activeLiftedKeys.has(K));
  check("*** SITE 4 *** (negative control) single-key entry: matched has exactly one row", matched.length === 1);
}

{
  // NEGATIVE CONTROL — a DIFFERENT identity's own multi-key twin must never leak into this identity's
  // own activeLiftedKeys.
  const sfx = freshSfx();
  const X = `C:\\mqc52b290e-s4-${sfx}-never`;
  const Foreign = `C:\\mqc52b290e-s4-${sfx}-foreign-never`;
  const K = `mqc52b290e-s4-K-${sfx}`;
  const KF = `mqc52b290e-s4-KF-${sfx}`;
  const KF2 = `mqc52b290e-s4-KF2-${sfx}`;
  setActiveQuarantineTestOnly(K, { repoPath: X, branch: "b", reason: "x", enteredAt: Date.now(), tokens: ["tok"], armedKeys: [K] });
  const foreignTwin = { repoPath: Foreign, branch: "b", reason: "foreign-twin", enteredAt: Date.now(), tokens: ["ftok"], armedKeys: [] };
  setActiveQuarantineTestOnly(KF, foreignTwin);
  setActiveQuarantineTestOnly(KF2, foreignTwin);

  const identity = directPathIdentity(X);
  const { matched, activeLiftedKeys } = activeMatchesAndLiftedKeysFor(identity);

  check("*** SITE 4 *** (negative control) a foreign identity's own multi-key twin never leaks in", !activeLiftedKeys.has(KF) && !activeLiftedKeys.has(KF2));
  check("*** SITE 4 *** (negative control) matched never includes the foreign identity", !matched.some((m) => m.repoPath === Foreign));
}

console.log(failures === 0
  ? "\n✅ ALL CHECKS PASS — activeMatchesAndLiftedKeysFor now includes every live-armed key of a "
    + "multi-key twin, not just the first Map-iteration visit's own."
  : `\n❌ ${failures} CHECK(S) FAILED — reproduces board card c52b290e's Site 4 hazard.`);
process.exit(failures === 0 ? 0 : 1);
