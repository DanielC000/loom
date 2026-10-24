import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 1fc3a561 — the root cause `6be6c9ff`/`c52b290e` left open: `protectOccupantContentBeforeDelete`'s
// own re-point never stamps `written.entry.armedKeys`, so a re-pointed multi-key twin carries
// `armedKeys:[]` while it is still LIVE-armed by reference at its own other key(s). `c52b290e` widened
// FOUR consumers of that shape via `liveArmedKeysOf`/`liveArmedKeys`; this card widens the FIVE
// remaining ones (card body, line numbers as of 896271d6):
//   1+3. clearMergeQuarantineByKey's pendingPlan `ownedArmedKeys`, feeding the "remove" loop.
//   2.   the reduce-branch write loop.
//   4.   clearMergeQuarantineByRecordedPath's `pendingOwnedArmedKeys`.
//   5.   quarantineLatchFileIdsFor.
//
// SCENARIO A (sites 1+3): a pending twin `pEntry` — SAME identity as the clear target `entry`, a
// DIFFERENT object (never reference-equal), tied to the clear ONLY via `subsetOfClearedTokens`
// (pEntry.tokens is a full subset of entry.tokens — never via `tiedViaKeyOrOrphanRef`, never by
// reference) — `armedKeys:[]` (the re-point shape) but LIVE-armed by reference at kTwinA/kTwinB, with
// REAL on-disk latches. Pre-fix: `clearMergeQuarantineByKey` returned a clean, unqualified success
// while kTwinA/kTwinB stayed fully armed (physical latches intact) and the repo's identity stayed
// fail-closed quarantined — exactly the `3d27c045` stranding shape, one level up.
//
// SCENARIO B (site 2): a pending twin tied via `tiedViaKeyOrOrphanRef` (shares `entry.orphanLatchFiles`
// with its OWN `sourceFile`) holding a token OUTSIDE `entry.tokens` (forces "reduce", never "remove"),
// same `armedKeys:[]`-but-live-armed-at-two-keys shape. Pre-fix: the reduce-branch write loop iterated
// `p.entry.armedKeys ?? []` — EMPTY — so neither kTwinA NOR kTwinB ever got durably rewritten at all;
// both physical latches kept the cleared token, resurrecting the quarantine on a restart.
//
// SCENARIO C (site 5): `quarantineLatchFileIdsFor` on a re-pointed twin, isolated from the pending flow
// entirely (active-only — never present in `pendingUnresolvedQuarantines`) — a pure read-path probe.
// Pre-fix: `entry.armedKeys ?? []` was empty, so it fell through to a `quarantineHashFor(entry.repoPath)`
// fallback id naming NEITHER of the twin's own real live-armed latch files.
//
// Site 4 (clearMergeQuarantineByRecordedPath's `pendingOwnedArmedKeys`) has NO test here — see this
// card's own decision record for the structural non-reproducibility argument (closed non-reproducible,
// mirroring c52b290e's own "Site 2" closure): whenever a twin is genuinely dual-tracked by reference,
// `activeMatchesAndLiftedKeysFor`'s own identity-wide scan always finds it independently of this site,
// and the SAME already-fixed `clearMergeQuarantineByKey` delegation (Scenario A above) then recovers
// every one of its live-armed keys regardless of what this site's own (also widened, for consistency)
// computation produces.
//
// Fix: all four sites exercised here now derive their candidate key set via `liveArmedKeysOf`/
// `liveArmedKeys` — the SAME shared helper `6be6c9ff`/`c52b290e` already introduced — never
// `armedKeys` alone. See the decision record for the RED/GREEN proof (a logic-only revert of each site
// in turn, never an import TypeError) and the fail-open analysis for site 2's own ownership gate.
//
// Run: 1) build daemon (pnpm --filter @loom/daemon build), 2) node test/merge-quarantine-1fc3a561-residual-armedkeys-live-scan.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq1fc3a561-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  clearMergeQuarantineByKey, quarantineLatchFileIdsFor, listActiveMergeQuarantines, assertRepoNotQuarantined,
  MERGE_QUARANTINE_DIR, setActiveQuarantineTestOnly, reenterMergeQuarantinesAtBootTestOnly,
} = await import(mergeQuarantineModuleHref);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
// Mirrors the real module's own private quarantineHashForKey — same helper every sibling
// merge-quarantine*.mjs test file in this family carries under this exact name.
const hashKey = (key) => createHash("sha256").update(key).digest("hex").slice(0, 24);

fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

function scenarioA_removeSitesOneAndThree() {
  const sfx = freshSfx();
  const T = path.join(os.tmpdir(), `loom-mq1fc3a561-A-T-never-${sfx}`);
  const kMain = `mq1fc3a561-A-kMain-${sfx}`;
  const kTwinA = `mq1fc3a561-A-kTwinA-${sfx}`;
  const kTwinB = `mq1fc3a561-A-kTwinB-${sfx}`;
  const tokenShared = `token-shared-${sfx}`;

  // The real clear-target active entry, armed at kMain only.
  const entry = { repoPath: T, branch: "main-branch", reason: "1fc3a561 A: clear target at kMain", enteredAt: Date.now(), tokens: [tokenShared] };

  // The dual-tracked, re-pointed twin: SAME identity (T), a DIFFERENT object (never reference-equal to
  // `entry`), armedKeys:[] (the protectOccupantContentBeforeDelete re-point shape — c9114934/cd5a3cf9),
  // but LIVE-armed BY REFERENCE at kTwinA/kTwinB, and ALSO present in pendingUnresolvedQuarantines.
  const pEntry = {
    repoPath: T, branch: "twin-branch", reason: "1fc3a561 A: dual-tracked twin, re-pointed (armedKeys:[])",
    enteredAt: Date.now(), tokens: [tokenShared], armedKeys: [],
  };

  // Inject pEntry into pendingUnresolvedQuarantines via the boot test-only seam (registeredRepoPaths=[]
  // so nothing is resolved/migrated/mutated — the SAME object reference survives, mirroring the
  // 6be6c9ff test's own established pattern).
  reenterMergeQuarantinesAtBootTestOnly([], [
    { entry: pEntry, sourceFile: `pending-mq1fc3a561-A-${sfx}.json` },
  ]);

  // Arm entry + pEntry's keys directly, post-boot (mirrors 6be6c9ff's own ordering).
  setActiveQuarantineTestOnly(kMain, entry);
  setActiveQuarantineTestOnly(kTwinA, pEntry);
  setActiveQuarantineTestOnly(kTwinB, pEntry);

  // Real on-disk physical latch files for all three keys.
  for (const [k, branch] of [[kMain, "main-branch"], [kTwinA, "twin-branch"], [kTwinB, "twin-branch"]]) {
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashKey(k)}.json`), JSON.stringify({
      repoPath: T, branch, reason: "1fc3a561 A fixture", enteredAt: Date.now(), tokens: [tokenShared],
    }, null, 2) + "\n");
  }

  check("(A precondition) T is blocked before the clear", !assertRepoNotQuarantined(T).ok);
  const kTwinALatchPath = path.join(MERGE_QUARANTINE_DIR, `${hashKey(kTwinA)}.json`);
  const kTwinBLatchPath = path.join(MERGE_QUARANTINE_DIR, `${hashKey(kTwinB)}.json`);
  check("(A precondition) kTwinA's own physical latch exists", fs.existsSync(kTwinALatchPath));
  check("(A precondition) kTwinB's own physical latch exists", fs.existsSync(kTwinBLatchPath));

  // THE CLEAR UNDER TEST — the real exported clearMergeQuarantineByKey, addressing the ACTIVE entry at
  // kMain. pEntry is tied to this clear ONLY via subsetOfClearedTokens (pEntry.tokens === entry.tokens,
  // a full subset) — NEVER by reference (p.entry !== entry) and NEVER via tiedViaKeyOrOrphanRef.
  const result = clearMergeQuarantineByKey(kMain, T);

  // The five things this scenario asserts (per the Lead's own ruling on this card):
  const stillBlocked = !assertRepoNotQuarantined(T).ok;
  const activeAfter = listActiveMergeQuarantines();
  const tEntriesAfter = activeAfter.filter((e) => e.repoPath === T);
  check("*** A *** kTwinA's own physical latch was lifted (twin fully lifted)", !fs.existsSync(kTwinALatchPath));
  check("*** A *** kTwinB's own physical latch was lifted (twin fully lifted)", !fs.existsSync(kTwinBLatchPath));
  check("*** A *** T is FULLY unquarantined after the clear", !stillBlocked);
  // @decision 4b6c8d24 — clearMergeQuarantineByKey no longer returns void on a clean success (it always
  // discloses liftedRepoPaths now); a clean success is `latchKept` absent + an empty
  // stillBlockedCoOccupants, never a bare falsy return.
  check("*** A *** the return value is a CLEAN success (no stillBlockedCoOccupants/latchKept)", !!result && !result.latchKept && (result.stillBlockedCoOccupants ?? []).length === 0);
  check("*** A *** no remaining in-memory T entry still carries tokenShared", !tEntriesAfter.some((e) => e.tokens.includes(tokenShared)));
}

function scenarioB_reduceSiteTwo() {
  const sfx = freshSfx();
  const T = path.join(os.tmpdir(), `loom-mq1fc3a561-B-T-never-${sfx}`);
  const kMain = `mq1fc3a561-B-kMain-${sfx}`;
  const kTwinA = `mq1fc3a561-B-kTwinA-${sfx}`;
  const kTwinB = `mq1fc3a561-B-kTwinB-${sfx}`;
  const sharedToken = `token-shared-${sfx}`;
  const privateToken = `token-private-${sfx}`; // outside entry.tokens -> forces "reduce", not "remove"

  const entry = { repoPath: T, branch: "main-branch", reason: "1fc3a561 B: clear target", enteredAt: Date.now(), tokens: [sharedToken] };

  // Tied via tiedViaKeyOrOrphanRef — `entry.orphanLatchFiles` names pEntry's OWN sourceFile exactly
  // (the real tie condition: `entry.orphanLatchFiles?.includes(p.sourceFile)`). privateToken survives
  // the clear, forcing the "reduce" branch (never "remove"). armedKeys:[] — the re-point shape — but
  // LIVE-armed by reference at kTwinA AND kTwinB.
  const pSourceFile = `pending-mq1fc3a561-B-${sfx}.json`;
  entry.orphanLatchFiles = [pSourceFile];
  const pEntry = {
    repoPath: T, branch: "twin-branch", reason: "1fc3a561 B: tiedViaKeyOrOrphanRef reduce twin",
    enteredAt: Date.now(), tokens: [sharedToken, privateToken], armedKeys: [],
  };

  reenterMergeQuarantinesAtBootTestOnly([], [{ entry: pEntry, sourceFile: pSourceFile }]);
  setActiveQuarantineTestOnly(kMain, entry);
  setActiveQuarantineTestOnly(kTwinA, pEntry);
  setActiveQuarantineTestOnly(kTwinB, pEntry);

  for (const [k, branch, tokens] of [
    [kMain, "main-branch", [sharedToken]],
    [kTwinA, "twin-branch", [sharedToken, privateToken]],
    [kTwinB, "twin-branch", [sharedToken, privateToken]],
  ]) {
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashKey(k)}.json`), JSON.stringify({
      repoPath: T, branch, reason: "1fc3a561 B fixture", enteredAt: Date.now(), tokens,
    }, null, 2) + "\n");
  }

  check("(B precondition) T is blocked before the clear", !assertRepoNotQuarantined(T).ok);
  const kTwinALatchPath = path.join(MERGE_QUARANTINE_DIR, `${hashKey(kTwinA)}.json`);
  const kTwinBLatchPath = path.join(MERGE_QUARANTINE_DIR, `${hashKey(kTwinB)}.json`);

  clearMergeQuarantineByKey(kMain, T);

  const kTwinAAfter = JSON.parse(fs.readFileSync(kTwinALatchPath, "utf8"));
  const kTwinBAfter = JSON.parse(fs.readFileSync(kTwinBLatchPath, "utf8"));
  check("*** B *** T is still correctly blocked (privateToken genuinely outstanding)", !assertRepoNotQuarantined(T).ok);
  check("*** B *** kTwinA's own PHYSICAL latch no longer carries sharedToken", !(kTwinAAfter.tokens ?? []).includes(sharedToken));
  check("*** B *** kTwinA's own PHYSICAL latch still carries privateToken", (kTwinAAfter.tokens ?? []).includes(privateToken));
  check("*** B *** kTwinB's own PHYSICAL latch no longer carries sharedToken (card 1fc3a561's own site 2 gap)", !(kTwinBAfter.tokens ?? []).includes(sharedToken));
  check("*** B *** kTwinB's own PHYSICAL latch still carries privateToken", (kTwinBAfter.tokens ?? []).includes(privateToken));
}

function scenarioC_readPathSiteFive() {
  const sfx = freshSfx();
  const T = path.join(os.tmpdir(), `loom-mq1fc3a561-C-T-never-${sfx}`);
  const kTwinA = `mq1fc3a561-C-kTwinA-${sfx}`;
  const kTwinB = `mq1fc3a561-C-kTwinB-${sfx}`;

  // A re-pointed twin — armedKeys:[], live-armed by reference at kTwinA and kTwinB (not pending at
  // all, isolating this consumer's own read logic from the pending-splice flow entirely).
  const pEntry = { repoPath: T, branch: "twin-branch", reason: "1fc3a561 C probe", enteredAt: Date.now(), tokens: ["t"], armedKeys: [] };
  setActiveQuarantineTestOnly(kTwinA, pEntry);
  setActiveQuarantineTestOnly(kTwinB, pEntry);

  for (const k of [kTwinA, kTwinB]) {
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashKey(k)}.json`), JSON.stringify({
      repoPath: T, branch: "twin-branch", reason: "1fc3a561 C fixture", enteredAt: Date.now(), tokens: ["t"],
    }, null, 2) + "\n");
  }

  const ids = quarantineLatchFileIdsFor(pEntry);
  check("*** C *** reports kTwinA's own real hash id", ids.includes(hashKey(kTwinA)));
  check("*** C *** reports kTwinB's own real hash id", ids.includes(hashKey(kTwinB)));
  check("*** C *** reports exactly these two ids, nothing else (no fallback id)", ids.length === 2);
}

scenarioA_removeSitesOneAndThree();
scenarioB_reduceSiteTwo();
scenarioC_readPathSiteFive();

console.log(failures === 0
  ? "\n✅ ALL CHECKS PASS — every remaining armedKeys-only consumer named on card 1fc3a561 now derives its "
    + "candidate key set from liveArmedKeysOf/liveArmedKeys, never armedKeys alone."
  : `\n❌ ${failures} CHECK(S) FAILED — reproduces board card 1fc3a561's residual stranding hazard.`);
process.exit(failures === 0 ? 0 : 1);
