import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card c52b290e, Site 3 — ownedKeysIncluding (merge-quarantine.ts) fed `enterMergeQuarantine`'s
// existing-branch raise's own `liftedKeys` set from `entry.armedKeys` ALONE, never a live-occupancy scan
// — so a re-pointed multi-key twin (armedKeys EMPTY, LIVE-armed at >1 key by reference, the
// `protectOccupantContentBeforeDelete` re-point shape @decision 6be6c9ff's own decision record proves
// production-reachable) left its OTHER live key permanently invisible to this helper.
//
// PART A — direct RED/GREEN: ownedKeysIncluding now includes a live multi-key twin's OTHER key, via the
// SAME widened formula `clearMergeQuarantineByKey`'s own `keysToLift` already uses
// (`liveArmedKeys(key, entry).filter(k => k === key || entryStillOwnsKey(k, entry))`), plus a negative
// control proving the pre-existing `78fccd3f` fail-open guard (a stale armedKeys member no longer truly
// owned) still correctly excludes that member.
//
// PART B — the `78fccd3f` FILTER's own negative control (NOT a proof the widening is safe): a STALE
// armedKeys member now occupied by a DIFFERENT object was ALREADY excluded by the pre-widening code too
// (`entryStillOwnsKey`'s identity-mismatch branch rejects it regardless of which candidate set it was
// drawn from) — this guards that the `78fccd3f` filter itself still runs unmodified, not that the NEW
// live-scan addition is safe. Driven through the REAL `enterMergeQuarantine` raise path end-to-end,
// asserting the foreign occupant's protective copy still KEEPS its own `resolvedKey` (never wrongly
// stripped).
//
// PART C — THE REVIEWER'S EQUIVALENCE CHECK (manager-directed): the thing that actually makes the
// widening safe is that `liveArmedKeys`'s only ADDITION beyond `entry.armedKeys` is a live
// `activeQuarantines` scan for `v === entry` — a key the entry GENUINELY, CURRENTLY occupies by
// reference, which `entryStillOwnsKey`'s own reference-equality branch admits exactly as it would if
// that same key had been correctly, fully listed in `armedKeys` from the start. Proves this directly:
// the SAME end-to-end raise, with `existing` live-armed (by reference) at BOTH `key` and `K2`, run twice
// — once with `armedKeys:[]` (the re-pointed-twin shape this card's own fix targets) and once with
// `armedKeys:[key,K2]` (the ordinary, fully-populated shape) — asserting the foreign occupant's own
// outcome is IDENTICAL in both.
//
// Run: 1) build daemon (pnpm --filter @loom/daemon build), 2) node test/merge-quarantine-c52b290e-owned-keys-including.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

useOwnLoomHome("loom-mqc52b290e-s3-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  ownedKeysIncluding, setActiveQuarantineTestOnly, enterMergeQuarantine, findPendingIndexByIdentityTestOnly,
  directPathIdentity, MERGE_QUARANTINE_DIR,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);
const GIT_ID = "-c user.email=mqc52b290e@loom -c user.name=mqc52b290e";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const hashKey = (key) => createHash("sha256").update(key).digest("hex").slice(0, 24);
const pendingDivertFilenameFor = (repoPath) => `pending-${createHash("sha256").update(directPathIdentity(repoPath)).digest("hex").slice(0, 24)}.json`;

fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

function makeToplevelRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqc52b290e-s3-repo-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), `# c52b290e site-3 fixture (${tag})\n`);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

console.log("\n=== PART A — direct RED/GREEN ===\n");
{
  const sfx = freshSfx();
  const X = `c52b290e-s3-repo-never-${sfx}`;
  const K = `mqc52b290e-s3-K-${sfx}`;
  const K2 = `mqc52b290e-s3-K2-${sfx}`;

  // *** THE CARD'S OWN SHAPE *** — re-pointed multi-key twin: LIVE-armed at BOTH K and K2 by reference,
  // armedKeys EMPTY.
  const entry = { repoPath: X, branch: "b", reason: "twin", enteredAt: Date.now(), tokens: ["tok"], armedKeys: [] };
  setActiveQuarantineTestOnly(K, entry);
  setActiveQuarantineTestOnly(K2, entry);

  const result = ownedKeysIncluding(K, entry);
  check("*** SITE 3 *** ownedKeysIncluding INCLUDES K2 (the twin's other LIVE key)", result.includes(K2));
  check("*** SITE 3 *** ownedKeysIncluding includes K itself", result.includes(K));
  check("*** SITE 3 *** ownedKeysIncluding returns exactly {K, K2}, nothing extra", result.length === 2);
}

{
  // NEGATIVE CONTROL — the pre-existing `78fccd3f` fail-open guard: a STALE armedKeys member now occupied
  // by a DIFFERENT object (a different identity entirely) must still be EXCLUDED under the widened
  // formula, exactly as it was before this card.
  const sfx = freshSfx();
  const X = `c52b290e-s3-repo-never-${sfx}`;
  const Z = `c52b290e-s3-foreign-never-${sfx}`;
  const K = `mqc52b290e-s3-K-${sfx}`;
  const kStale = `mqc52b290e-s3-kStale-${sfx}`;

  const entry = { repoPath: X, branch: "b", reason: "x", enteredAt: Date.now(), tokens: ["xTok"], armedKeys: [K, kStale] };
  setActiveQuarantineTestOnly(K, entry);
  setActiveQuarantineTestOnly(kStale, { repoPath: Z, branch: "b", reason: "z", enteredAt: Date.now(), tokens: ["zTok"], armedKeys: [] });

  const result = ownedKeysIncluding(K, entry);
  check("*** SITE 3 *** (negative control, 78fccd3f shape) a stale armedKeys member now owned by a DIFFERENT object is EXCLUDED", !result.includes(kStale));
  check("*** SITE 3 *** (negative control) K itself is still included", result.includes(K) && result.length === 1);
}

console.log("\n=== PART B — adversarial no-fail-open (manager-directed) ===\n");
{
  const sfx = freshSfx();
  const R = makeToplevelRepo("raise");
  const key = canonicalRepoLockKey(R);
  const kStale = `mqc52b290e-s3-adv-kStale-${sfx}`;
  const Z = `c52b290e-s3-adv-foreign-occupant-never-${sfx}`; // occupies kStale NOW — unrelated to R
  const F = `c52b290e-s3-adv-primary-final-occupant-never-${sfx}`; // sits at R's own primary final

  // `existing`: R's own entry, armed at `key` by reference, with a STALE armedKeys member `kStale` —
  // claimed in the field, but NOW genuinely occupied by a DIFFERENT object (Z, unrelated identity).
  const existing = {
    repoPath: R, branch: "pre-raise", reason: "c52b290e PART B: R's own entry, armedKeys stale-lists kStale",
    enteredAt: Date.now(), tokens: ["existing-tok"], armedKeys: [key, kStale],
  };
  setActiveQuarantineTestOnly(key, existing);
  // kStale is CURRENTLY occupied by a totally different, unrelated entry (Z) — never existing, never a
  // token-subset of it either, so entryStillOwnsKey(kStale, existing) must be false.
  setActiveQuarantineTestOnly(kStale, { repoPath: Z, branch: "b", reason: "z", enteredAt: Date.now(), tokens: ["zTok"], armedKeys: [] });

  // F: a FOREIGN, unincorporated occupant physically sitting at R's own primary final (key's own
  // physical file) — disjoint tokens from `existing` (so unincorporatedOccupantRepoPathAt treats it as a
  // genuine occupant, not "already incorporated") — whose own on-disk `resolvedKey` COLLIDES with kStale.
  const finalForKey = path.join(MERGE_QUARANTINE_DIR, `${hashKey(key)}.json`);
  fs.writeFileSync(finalForKey, JSON.stringify({
    repoPath: F, branch: "f-branch", reason: "c52b290e PART B: foreign occupant, resolvedKey collides with kStale",
    enteredAt: Date.now(), tokens: ["f-tok"], resolvedKey: kStale,
  }, null, 2) + "\n");

  // Sanity precondition: ownedKeysIncluding (under test) must exclude kStale here — if this ever starts
  // including it, the rest of this scenario's own expectation (resolvedKey SURVIVES) would need
  // inverting, so assert it explicitly rather than silently assume it.
  const liftedKeysPrecheck = ownedKeysIncluding(key, existing);
  check("*** SITE 3 PART B *** (precondition) ownedKeysIncluding excludes kStale here (still owned by Z)", !liftedKeysPrecheck.includes(kStale));

  // THE RAISE under test — a REAL enterMergeQuarantine call, hitting the `existing` branch (key resolves).
  enterMergeQuarantine(R, "raise-branch", "c52b290e PART B: raise onto existing, with a colliding foreign occupant at the primary final");

  // F's own content should have been durably copied aside to its own pending-divert file — read it
  // directly off disk (never re-derived from memory) and confirm `resolvedKey` SURVIVED (was NOT wrongly
  // stripped as if kStale were one of this raise's own lifted keys).
  const fPendingPath = path.join(MERGE_QUARANTINE_DIR, pendingDivertFilenameFor(F));
  let fPending = null;
  try { fPending = JSON.parse(fs.readFileSync(fPendingPath, "utf8")); } catch { /* not found or unreadable */ }

  check("*** SITE 3 PART B *** F's own protective copy was durably written", fPending !== null);
  check("*** SITE 3 PART B *** F's own protective copy KEEPS resolvedKey===kStale (NOT fail-open — stays GREEN under the fix)",
    !!fPending && fPending.resolvedKey === kStale);
  check("*** SITE 3 PART B *** F's own protective copy still carries its own token", !!fPending && (fPending.tokens ?? []).includes("f-tok"));

  // Idx-found sanity: F is genuinely tracked as a pending entry now (not silently dropped).
  const fPendingIdx = findPendingIndexByIdentityTestOnly(F);
  check("*** SITE 3 PART B *** F is tracked as a pending entry (not silently dropped)", fPendingIdx !== -1);
}

console.log("\n=== PART C — the reviewer's equivalence check (manager-directed) ===\n");
async function runEquivalenceScenario(shape) {
  // shape: "empty" | "full" — the ONLY thing that varies between the two calls.
  const sfx = freshSfx();
  const R = makeToplevelRepo(`equiv-${shape}`);
  const key = canonicalRepoLockKey(R);
  const K2 = `mqc52b290e-s3-equiv-K2-${shape}-${sfx}`;
  const F = `c52b290e-s3-equiv-foreign-${shape}-never-${sfx}`;

  // `existing` is LIVE-armed (by reference) at BOTH `key` and `K2` in EITHER shape — only the `armedKeys`
  // FIELD's own content differs.
  const existing = {
    repoPath: R, branch: "pre-raise", reason: `c52b290e PART C (${shape}): existing live-armed at key+K2`,
    enteredAt: Date.now(), tokens: ["existing-tok"],
    armedKeys: shape === "empty" ? [] : [key, K2],
  };
  setActiveQuarantineTestOnly(key, existing);
  setActiveQuarantineTestOnly(K2, existing);

  // F: a foreign, unincorporated occupant at R's own primary final, whose own on-disk `resolvedKey` is
  // K2 — a key `existing` genuinely, currently owns (by reference) in BOTH shapes.
  const finalForKey = path.join(MERGE_QUARANTINE_DIR, `${hashKey(key)}.json`);
  fs.writeFileSync(finalForKey, JSON.stringify({
    repoPath: F, branch: "f-branch", reason: `c52b290e PART C (${shape}): foreign occupant, resolvedKey=K2`,
    enteredAt: Date.now(), tokens: ["f-tok"], resolvedKey: K2,
  }, null, 2) + "\n");

  const precheckIncludesK2 = ownedKeysIncluding(key, existing).includes(K2);

  enterMergeQuarantine(R, "raise-branch", `c52b290e PART C (${shape}): raise onto existing, K2-colliding foreign occupant`);

  const fPendingPath = path.join(MERGE_QUARANTINE_DIR, pendingDivertFilenameFor(F));
  let fPending = null;
  try { fPending = JSON.parse(fs.readFileSync(fPendingPath, "utf8")); } catch { /* not found or unreadable */ }

  return {
    precheckIncludesK2,
    fPendingFound: fPending !== null,
    // K2 is genuinely, live-owned by `existing` in BOTH shapes, so the CORRECT outcome is that F's own
    // claimed resolvedKey gets STRIPPED either way — it belongs to `existing`'s own live arming, not F.
    resolvedKeyStripped: !!fPending && fPending.resolvedKey === undefined,
    tokensPreserved: !!fPending && (fPending.tokens ?? []).includes("f-tok"),
  };
}

{
  const resultEmpty = await runEquivalenceScenario("empty");
  const resultFull = await runEquivalenceScenario("full");

  check("*** SITE 3 PART C *** (empty armedKeys) ownedKeysIncluding includes K2 via the live-reference scan", resultEmpty.precheckIncludesK2 === true);
  check("*** SITE 3 PART C *** (full armedKeys) ownedKeysIncluding includes K2 (the field already lists it)", resultFull.precheckIncludesK2 === true);
  check("*** SITE 3 PART C *** F's protective copy was durably written in BOTH shapes", resultEmpty.fPendingFound && resultFull.fPendingFound);
  check("*** SITE 3 PART C *** F's resolvedKey is correctly STRIPPED in BOTH shapes (K2 is genuinely live-owned by existing either way)",
    resultEmpty.resolvedKeyStripped && resultFull.resolvedKeyStripped);
  check("*** SITE 3 PART C *** F's own token is preserved in BOTH shapes", resultEmpty.tokensPreserved && resultFull.tokensPreserved);
  check("*** SITE 3 PART C *** THE EQUIVALENCE — the empty-armedKeys outcome is IDENTICAL to the full-armedKeys outcome",
    JSON.stringify({ fPendingFound: resultEmpty.fPendingFound, resolvedKeyStripped: resultEmpty.resolvedKeyStripped, tokensPreserved: resultEmpty.tokensPreserved })
    === JSON.stringify({ fPendingFound: resultFull.fPendingFound, resolvedKeyStripped: resultFull.resolvedKeyStripped, tokensPreserved: resultFull.tokensPreserved }));
}

console.log(failures === 0
  ? "\n✅ ALL CHECKS PASS — ownedKeysIncluding now includes a live multi-key twin's other key, and the "
    + "widening is EQUIVALENT to a fully-populated armedKeys for any key the entry genuinely, live-owns."
  : `\n❌ ${failures} CHECK(S) FAILED — reproduces board card c52b290e's Site 3 hazard, or a regression of 78fccd3f.`);
process.exit(failures === 0 ? 0 : 1);
