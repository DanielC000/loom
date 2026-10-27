import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision 69635a8d — never trust an unverified foreignPending claim: a boot-time degraded-eviction
// inference can mis-associate it with the WRONG physical file, relocating an unrelated union's own
// genuine record instead of cleanly lifting it. This file proves the fix, both readdir orders, plus (c)/(d).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq69635a8d-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleUrl = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const repoLockModuleUrl = pathToFileURL(path.join(distGitDir, "repo-lock.js")).href;
const { canonicalRepoLockKey } = await import(repoLockModuleUrl); // pure functions, no module-level state to isolate

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// `listPendingMergeQuarantinesTestOnly` is itself part of this card's own fix (it did not exist on
// pre-fix dist) — a bare `mq.listPendingMergeQuarantinesTestOnly()` call would THROW and abort the whole
// process on a pre-fix negative-control run, before scenarios (SD)/(C)/(D) ever get a chance to run at
// all. Feature-detect instead: fall back to `[]` (every dependent check then fails loudly and correctly,
// never silently passes) so a pre-fix run actually executes every scenario and the real RED set is visible.
function pendingSnapshot(mq) {
  if (typeof mq.listPendingMergeQuarantinesTestOnly !== "function") {
    console.log("NOTE  mq.listPendingMergeQuarantinesTestOnly is not a function on this build (pre-fix dist) — treating the pending snapshot as empty; every check that depends on it below fails for real, not vacuously.");
    return [];
  }
  return mq.listPendingMergeQuarantinesTestOnly();
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
let n = 0;
function freshDir(tag) {
  n++;
  const d = path.join(os.tmpdir(), `loom-mq69635a8d-${tag}-${sfx}-${n}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function realRepo(tag) {
  const d = freshDir(tag);
  fs.writeFileSync(path.join(d, "a"), "a");
  execSync("git init -q && git -c user.email=a@b -c user.name=a add . && git -c user.email=a@b -c user.name=a commit -qm i", { cwd: d });
  return d;
}
function hashKey(key) { return createHash("sha256").update(key).digest("hex").slice(0, 24); }

// @decision d163aef5 — never share module-level activeQuarantines/pendingUnresolvedQuarantines state
// across independent scenarios. A fresh LOOM_HOME alone does not reset them (module-level, fixed at
// import time); a fresh, cache-busted import does, and also gives a fresh MERGE_QUARANTINE_DIR.
let scenarioCounter = 0;
async function freshScenario(tag) {
  scenarioCounter++;
  useOwnLoomHome(`loom-mq69635a8d-${tag}-`, { fresh: true });
  return import(`${mergeQuarantineModuleUrl}?s69635a8d=${scenarioCounter}`);
}

// ===================== (DS) MAIN REPRO — readdir order D,S: the card's own exact shape =====================
{
  const mq = await freshScenario("ds");
  const s = realRepo("ds-s"), r = realRepo("ds-r");
  const ks = canonicalRepoLockKey(s), kr = canonicalRepoLockKey(r);
  const d = path.join(os.tmpdir(), `loom-mq69635a8d-ds-d-never-${sfx}`); // never created — permanently unresolvable

  fs.mkdirSync(mq.MERGE_QUARANTINE_DIR, { recursive: true });
  // S: LEGACY (no identityAtRaise), dual-armed [Ks,Kr] via a stale resolvedKey=Kr — physically filed at
  // its own real key's hash, exactly as a real pre-upgrade latch would be.
  fs.writeFileSync(path.join(mq.MERGE_QUARANTINE_DIR, `${hashKey(ks)}.json`), JSON.stringify({
    repoPath: s, branch: "sb", reason: "S stale resolvedKey=Kr", enteredAt: Date.now() - 90000, tokens: ["tok-s"], resolvedKey: kr,
  }));
  // D: a degraded occupant whose own resolvedKey (Ks) differs from both its own physical filename AND its
  // own walked-up canonical key — forced to sort FIRST (alphabetically "0" < any real sha256 hex digit),
  // deterministically producing readdir order D,S regardless of what S's/r's own real hashes happen to be.
  const dFilename = "000000000000000000000000.json";
  fs.writeFileSync(path.join(mq.MERGE_QUARANTINE_DIR, dFilename), JSON.stringify({
    repoPath: d, branch: "db", reason: "D at Kr, resolvedKey=Ks", enteredAt: Date.now() - 60000, tokens: ["tok-d"], resolvedKey: ks,
  }));
  check("(DS precondition) readdir order is D,S", fs.readdirSync(mq.MERGE_QUARANTINE_DIR).sort()[0] === dFilename);

  mq.reenterMergeQuarantinesAtBoot([]); // boot with no registered repos, per the card
  mq.enterMergeQuarantine(r, "rb", "r raises");

  const pre = mq.activeMergeQuarantineFor(s);
  check("(DS precondition) S is dual-armed [Ks,Kr]", pre?.armedKeys?.length === 2);
  check("(DS precondition) r is folded in as a contributor", !!pre?.contributorRepoPaths?.some((c) => mq.directPathIdentity(c) === mq.directPathIdentity(r)));

  const result = mq.clearMergeQuarantineReporting(r);
  console.log(`(DS) /clear(r) -> ${JSON.stringify(result)}`);

  check("*** THE FIX (DS) *** /clear(r) fully releases s — no longer stuck", mq.assertRepoNotQuarantined(s).ok === true);
  check("*** THE FIX (DS) *** /clear(r) fully releases r too", mq.assertRepoNotQuarantined(r).ok === true);
  check("(DS) a SECOND /clear(s) is a genuine no-op (already clear)", mq.assertRepoNotQuarantined(s).ok === true);

  const pending = pendingSnapshot(mq);
  const dPending = pending.filter((p) => mq.directPathIdentity(p.repoPath) === mq.directPathIdentity(d));
  check("*** THE FIX (DS) *** exactly ONE pending entry for D survives (the stale (D,h(Ks)) pair is gone)", dPending.length === 1);
  check("*** THE FIX (DS) *** D's surviving pending entry names its OWN correct sourceFile", dPending[0]?.sourceFile === dFilename);
  check("(DS) D itself is untouched and still genuinely quarantined", mq.assertRepoNotQuarantined(d).ok === false);
}

// ===================== (SD) CONTROL — readdir order S,D: already worked; must keep working =====================
{
  const mq = await freshScenario("sd");
  const s = realRepo("sd-s"), r = realRepo("sd-r");
  const ks = canonicalRepoLockKey(s), kr = canonicalRepoLockKey(r);
  const d = path.join(os.tmpdir(), `loom-mq69635a8d-sd-d-never-${sfx}`);

  fs.mkdirSync(mq.MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(path.join(mq.MERGE_QUARANTINE_DIR, `${hashKey(ks)}.json`), JSON.stringify({
    repoPath: s, branch: "sb", reason: "S stale resolvedKey=Kr", enteredAt: Date.now() - 90000, tokens: ["tok-s"], resolvedKey: kr,
  }));
  // Forced to sort LAST ("f" > any real sha256 hex digit) — deterministically producing order S,D.
  const dFilename = "ffffffffffffffffffffffff.json";
  fs.writeFileSync(path.join(mq.MERGE_QUARANTINE_DIR, dFilename), JSON.stringify({
    repoPath: d, branch: "db", reason: "D at Kr, resolvedKey=Ks", enteredAt: Date.now() - 60000, tokens: ["tok-d"], resolvedKey: ks,
  }));
  check("(SD precondition) readdir order is S,D", fs.readdirSync(mq.MERGE_QUARANTINE_DIR).sort()[0] !== dFilename);

  mq.reenterMergeQuarantinesAtBoot([]);
  mq.enterMergeQuarantine(r, "rb", "r raises");

  const result = mq.clearMergeQuarantineReporting(r);
  console.log(`(SD) /clear(r) -> ${JSON.stringify(result)}`);

  check("*** CONTROL (SD) *** /clear(r) fully releases s (never broken in this order)", mq.assertRepoNotQuarantined(s).ok === true);
  check("*** CONTROL (SD) *** /clear(r) fully releases r too", mq.assertRepoNotQuarantined(r).ok === true);

  const pending = pendingSnapshot(mq);
  const dPending = pending.filter((p) => mq.directPathIdentity(p.repoPath) === mq.directPathIdentity(d));
  check("(SD) exactly ONE pending entry for D (never duplicated in this order either)", dPending.length === 1);
  check("(SD) D's pending entry names its OWN correct sourceFile", dPending[0]?.sourceFile === dFilename);
  check("(SD) D itself is untouched and still genuinely quarantined", mq.assertRepoNotQuarantined(d).ok === false);
}

// ===================== (C) CASE (c) — the foreignPending match's claim is wrong AND a THIRD identity =====================
{
  const mq = await freshScenario("c");
  const owner = realRepo("c-owner");
  const ownerKey = canonicalRepoLockKey(owner);
  const finalPath = path.join(mq.MERGE_QUARANTINE_DIR, `${hashKey(ownerKey)}.json`);
  const wrongClaim = freshDir("c-wrongclaim"); // never resolves — the pending entry's own (false) claim
  const thirdParty = freshDir("c-thirdparty"); // never resolves — what the file's REAL content actually names

  mq.enterMergeQuarantine(owner, "cb", "owner raises"); // writes owner's own genuine content to finalPath
  check("(C precondition) owner's own latch file exists before the mismatch is engineered", fs.existsSync(finalPath));

  // Engineer the mismatch this card's own case (c) covers: the file's REAL bytes name a THIRD party —
  // never the owner (still armed correctly in-memory) and never the pending claim below.
  fs.writeFileSync(finalPath, JSON.stringify({ repoPath: thirdParty, branch: "tb", reason: "third party's own real content", enteredAt: Date.now(), tokens: ["third-tok"] }));
  mq.pushPendingQuarantineTestOnly(
    { repoPath: wrongClaim, branch: "wb", reason: "a wrong, pre-existing pending claim on this exact file", enteredAt: Date.now(), tokens: ["wrong-tok"] },
    path.basename(finalPath),
  );

  const result = mq.clearMergeQuarantineReporting(owner);
  console.log(`(C) /clear(owner) -> ${JSON.stringify(result)}`);

  check("*** THE FIX (C) *** owner's own clear still succeeds", mq.assertRepoNotQuarantined(owner).ok === true);
  check("*** THE FIX (C) *** the THIRD party's real content survives, protected under ITS OWN identity", mq.assertRepoNotQuarantined(thirdParty).ok === false);
  const thirdActive = mq.listActiveMergeQuarantines().find((e) => mq.directPathIdentity(e.repoPath) === mq.directPathIdentity(thirdParty));
  check("(C) the surviving third-party record carries the third party's OWN real token", !!thirdActive?.tokens?.includes("third-tok"));
  check("*** THE FIX (C) *** NEVER protected under the stale pending label", !mq.listActiveMergeQuarantines().some((e) => mq.directPathIdentity(e.repoPath) === mq.directPathIdentity(wrongClaim) && e.tokens?.includes("third-tok")));
  const wrongPending = pendingSnapshot(mq).filter((p) => mq.directPathIdentity(p.repoPath) === mq.directPathIdentity(wrongClaim));
  check("(C) the wrong pending claim's own (unrelated) entry is left exactly as it was — case (c) never touches it", wrongPending.length === 1);
}

// ===================== (C-provenance) CASE (c) variant — the occupantRepoPath LABEL's one real effect =====================
// (C) alone is NOT RED pre-fix: `toPersist` (the content actually persisted) comes from `final`'s own real
// bytes either way, label or no label — so the basic third-party-survives assertions above pass whether or
// not the label is correct. The label's ONLY observable behavioral effect is `protectOccupantContentBeforeDelete`'s
// own `inMemoryProvenanceUnknownFor(occupantRepoPath)` read (~:3044): pre-fix, that label is the WRONG
// pending claim's own identity, so a provenanceUnknown mark sitting on THAT claimant's own in-memory record
// leaks onto the THIRD party's divert, which never carried it. Post-fix the label is the content's own
// (correct) identity, so nothing leaks.
{
  const mq = await freshScenario("cprov");
  const owner = realRepo("cprov-owner");
  const ownerKey = canonicalRepoLockKey(owner);
  const finalPath = path.join(mq.MERGE_QUARANTINE_DIR, `${hashKey(ownerKey)}.json`);
  const wrongClaim = freshDir("cprov-wrongclaim");
  const thirdParty = freshDir("cprov-thirdparty");

  mq.enterMergeQuarantine(owner, "cpb", "owner raises");
  fs.writeFileSync(finalPath, JSON.stringify({ repoPath: thirdParty, branch: "tb", reason: "third party's own real content — NOT provenanceUnknown itself", enteredAt: Date.now(), tokens: ["third-tok-prov"] }));
  // The WRONG claimant's own in-memory record carries provenanceUnknown:true — this, and only this, is
  // what a mislabeled occupantRepoPath can leak onto an unrelated party's own divert.
  mq.pushPendingQuarantineTestOnly(
    { repoPath: wrongClaim, branch: "wb", reason: "a wrong pending claim that is itself provenanceUnknown", enteredAt: Date.now(), tokens: ["wrong-tok-prov"], provenanceUnknown: true },
    path.basename(finalPath),
  );

  const result = mq.clearMergeQuarantineReporting(owner);
  console.log(`(C-provenance) /clear(owner) -> ${JSON.stringify(result)}`);

  check("(C-provenance) owner's own clear still succeeds", mq.assertRepoNotQuarantined(owner).ok === true);
  const thirdActive = mq.listActiveMergeQuarantines().find((e) => mq.directPathIdentity(e.repoPath) === mq.directPathIdentity(thirdParty));
  check("(C-provenance) the third party's divert exists and carries its own real token", !!thirdActive?.tokens?.includes("third-tok-prov"));
  check("*** THE FIX (C-provenance) *** the third party's divert does NOT inherit the WRONG claimant's provenanceUnknown", thirdActive?.provenanceUnknown !== true);
}

// ===================== (D) CASE (d) — final's own content is unreadable/unparseable =====================
{
  const mq = await freshScenario("d");
  const owner = realRepo("d-owner");
  const ownerKey = canonicalRepoLockKey(owner);
  const finalPath = path.join(mq.MERGE_QUARANTINE_DIR, `${hashKey(ownerKey)}.json`);
  const wrongClaim = freshDir("d-wrongclaim");

  mq.enterMergeQuarantine(owner, "db2", "owner raises");
  check("(D precondition) owner's own latch file exists before it is corrupted", fs.existsSync(finalPath));

  fs.writeFileSync(finalPath, "not valid json {{{"); // genuinely unparseable — quarantineFileRepoPathIdentity -> undefined
  mq.pushPendingQuarantineTestOnly(
    { repoPath: wrongClaim, branch: "wb2", reason: "a wrong, pre-existing pending claim on this exact (now-corrupt) file", enteredAt: Date.now(), tokens: ["wrong-tok2"] },
    path.basename(finalPath),
  );

  const result = mq.clearMergeQuarantineReporting(owner);
  console.log(`(D) /clear(owner) -> ${JSON.stringify(result)}`);

  check("*** CASE (d) *** owner's own clear still succeeds — unchanged, fail-closed exactly as before this card", mq.assertRepoNotQuarantined(owner).ok === true);
  const wrongPending = pendingSnapshot(mq).filter((p) => mq.directPathIdentity(p.repoPath) === mq.directPathIdentity(wrongClaim));
  check("(D) the wrong pending claim is never dropped on an unreadable read — only case (b) drops anything", wrongPending.length === 1);
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
