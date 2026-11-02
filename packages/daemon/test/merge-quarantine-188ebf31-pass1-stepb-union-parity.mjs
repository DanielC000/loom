import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision 188ebf31 — PARITY, not a defect, for the same bytes/order — see the decision record for the
// reachability argument, its one assumption (re-open this if a runtime path is ever found that breaks
// it), and scenario 4's own separate, already-accepted divergence.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome, registerForCleanup } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq188e-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);
const baseMod = await import(mergeQuarantineModuleHref);
const quarantineDir = baseMod.MERGE_QUARANTINE_DIR;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mq188e@loom -c user.name=mq188e";
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Registers every repo it creates for the SAME guaranteed cleanup useOwnLoomHome's own LOOM_HOME uses.
function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mq188e-repo-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# merge-quarantine-188ebf31 (${tag})\n`);
  execSync(`git init -q && git config user.email mq188e@loom && git config user.name mq188e`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

let importCounter = 0;
const freshModule = () => import(`${mergeQuarantineModuleHref}?mq188e=${++importCounter}-${freshSfx()}`);

const clearQuarantineDir = () => {
  fs.mkdirSync(quarantineDir, { recursive: true });
  for (const f of fs.readdirSync(quarantineDir)) fs.rmSync(path.join(quarantineDir, f), { force: true });
};

// Same technique as 1de37538's own step-b-provider-seam test: fold `orphanBasename` into `repoPath`'s own
// on-disk final JSON BEFORE `orphanBasename` itself exists, then write that basename's own content
// separately — this is what makes a later clear's orphan sweep discover genuinely foreign content and
// drive the REAL Step B arm (armForeignOrphanContentInMemoryIfUnenforced), never a hand-built map.
function foldOrphanRefIntoOwnFinal(repoPath) {
  const files = fs.readdirSync(quarantineDir).filter((f) => f.endsWith(".json") && (() => {
    try { return JSON.parse(fs.readFileSync(path.join(quarantineDir, f), "utf8")).repoPath === repoPath; } catch { return false; }
  })());
  const finalPath = path.join(quarantineDir, files[0]);
  const orphanBasename = `${createHash("sha256").update(`${repoPath}-${freshSfx()}`).digest("hex").slice(0, 24)}.json`;
  const record = JSON.parse(fs.readFileSync(finalPath, "utf8"));
  record.orphanLatchFiles = [orphanBasename];
  fs.writeFileSync(finalPath, JSON.stringify(record));
  return orphanBasename;
}

function writeOrphanContent(orphanBasename, repoPath, branch, reason, tokens, extra = {}) {
  fs.mkdirSync(quarantineDir, { recursive: true });
  const orphanPath = path.join(quarantineDir, orphanBasename);
  fs.writeFileSync(orphanPath, JSON.stringify({ repoPath, branch, reason, enteredAt: Date.now(), tokens, ...extra }));
  return orphanPath;
}

// Compares the two legs' own merged objects on the fields this card's own question is about.
function compareLegs(inProcessMerged, rebootMerged) {
  if (rebootMerged === undefined) return { agree: false, reason: "reboot found no entry" };
  if (inProcessMerged.repoPath !== rebootMerged.repoPath) return { agree: false, reason: "repoPath differs" };
  if (inProcessMerged.resolvedKey !== rebootMerged.resolvedKey) return { agree: false, reason: "resolvedKey differs" };
  const a = new Set(inProcessMerged.armedKeys ?? []);
  const b = new Set(rebootMerged.armedKeys ?? []);
  if (a.size !== b.size || ![...a].every((k) => b.has(k))) return { agree: false, reason: "armedKeys differ" };
  if (!!inProcessMerged.provenanceUnknown !== !!rebootMerged.provenanceUnknown) return { agree: false, reason: "provenanceUnknown differs" };
  return { agree: true, reason: undefined };
}

try {
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIOS 1/2 — dual-arm parity, T-older and U-older. U is dual-armed at [KEY_U, KEY_V] — but that
  // dual-arm is derived from a REAL reenterMergeQuarantinesAtBoot read-back (instance A), never a
  // hand-set armedKeys field (confirmed below: U's raw on-disk JSON carries no armedKeys at all — it is
  // a purely derived/runtime field). T is an unresolvable ghost whose orphan content names KEY_U (U's
  // own primary key) as a self-referential (uninformative) secondary key — the exact shape 6b327712
  // item 3 traced the worried divergence to. Since card 6b51e70e, T's own union is driven through the
  // REAL Step B arm (armForeignOrphanContentInMemoryIfUnenforced) via a genuine clear of a third repo A
  // that sweeps T's own orphan content — never the armQuarantineKeyTestOnly simulation this file used to
  // use — with the SAME registered-repo-paths provider (1de37538) a real boot's own PASS 1 always gets
  // explicitly. compareLegs now also asserts provenanceUnknown parity — FALSE on both legs for THIS
  // shape (T collides at U's own PRIMARY key, which neither Step B's nor PASS 1's own predicate can mark
  // regardless of the provider); see the PROVENANCE-UNKNOWN PARITY scenario below for the shape that
  // actually exercises the field, including a RED proof with the seam left unset.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  const REPO_U = makeRepo("U");
  const REPO_V = makeRepo("V");
  const REPO_A = makeRepo("A"); // the clearer whose own orphan sweep drives T's union through REAL Step B
  const KEY_U = canonicalRepoLockKey(REPO_U);
  const KEY_V = canonicalRepoLockKey(REPO_V);
  check("precondition: KEY_U !== KEY_V", KEY_U !== KEY_V);
  const T_GHOST = path.join(os.tmpdir(), `loom-mq188e-ghost-T-${freshSfx()}`); // never created — unresolvable
  const REGISTERED_ROSTER = [REPO_U, REPO_V, REPO_A];

  async function dualArmScenario(label, tOlder) {
    clearQuarantineDir();

    // Raise U for real; hand-edit only its own recorded fields (resolvedKey, enteredAt) — never a
    // derived/runtime field like armedKeys.
    const raiser = await freshModule();
    const tU = raiser.enterMergeQuarantine(REPO_U, "loom/u-branch", `merge in progress for U (${label})`);
    const uFiles = fs.readdirSync(quarantineDir).filter((f) => f.endsWith(".json"));
    check(`${label}: exactly one latch file after raising U`, uFiles.length === 1);
    const uFilePath = path.join(quarantineDir, uFiles[0]);
    const uRawBeforeEdit = JSON.parse(fs.readFileSync(uFilePath, "utf8"));
    check(`${label}: raw on-disk JSON carries NO armedKeys field (confirms it is derived/runtime-only, never hand-set here)`, !("armedKeys" in uRawBeforeEdit));
    const uEnteredAt = tOlder ? (Date.now() + 10_000_000) : 1;
    fs.writeFileSync(uFilePath, JSON.stringify({ ...uRawBeforeEdit, resolvedKey: KEY_V, enteredAt: uEnteredAt }));

    // IN-PROCESS leg, part 1: a GENUINE PASS 1 boot of ONLY U's file (T, A absent) — U's real dual-arm at
    // [KEY_U, KEY_V] comes from this, never asserted. The provider is wired to the SAME roster the
    // reboot leg below is passed explicitly (1de37538) — see the PROVENANCE-UNKNOWN PARITY scenario
    // further down for why THIS shape's own provenanceUnknown stays FALSE on both legs regardless (T
    // collides at U's own PRIMARY key, never a secondary/non-fresh claim — the one shape the provider
    // seam can actually move) and for the dedicated RED-with-seam-unset proof.
    const instanceA = await freshModule();
    instanceA.setRegisteredRepoPathsProvider(() => REGISTERED_ROSTER);
    instanceA.reenterMergeQuarantinesAtBoot(REGISTERED_ROSTER);
    const uRealPostBoot = instanceA.stillBlockedEntryFor(REPO_U);
    check(`${label}: PASS 1 itself genuinely dual-arms U at both KEY_U and KEY_V (not asserted here)`, uRealPostBoot !== undefined && new Set(uRealPostBoot.armedKeys ?? []).size === 2 && (uRealPostBoot.armedKeys ?? []).includes(KEY_U) && (uRealPostBoot.armedKeys ?? []).includes(KEY_V));

    // IN-PROCESS leg, part 2: drive T's union through the REAL Step B arm
    // (armForeignOrphanContentInMemoryIfUnenforced) via a genuine clear that sweeps an orphan — never a
    // hand-built byRepoKey map and never armQuarantineKeyTestOnly. A is the clearer: raise it, fold an
    // orphan reference into ITS OWN on-disk final JSON (same technique as 1de37538's own
    // step-b-provider-seam test), then — per that test file's own documented gotcha — REBOOT again
    // before writing T's content and clearing, or Step B never fires (a clearer's in-memory entry needs
    // a real read-from-disk cycle to pick up the orphanLatchFiles edit written directly to disk).
    const tA = instanceA.enterMergeQuarantine(REPO_A, "loom/a-branch", `merge in progress for A (${label})`);
    const orphanBasename = foldOrphanRefIntoOwnFinal(REPO_A);

    const instanceB = await freshModule();
    instanceB.setRegisteredRepoPathsProvider(() => REGISTERED_ROSTER);
    instanceB.reenterMergeQuarantinesAtBoot(REGISTERED_ROSTER);

    const tT = "tok-T-" + freshSfx();
    const tEnteredAt = tOlder ? 1 : (Date.now() + 10_000_000);
    writeOrphanContent(orphanBasename, T_GHOST, "loom/t-branch", `merge in progress for T (${label})`, [tT], { resolvedKey: KEY_U, enteredAt: tEnteredAt });
    instanceB.clearMergeQuarantineByToken(REPO_A, tA);

    const inProcessMerged = instanceB.stillBlockedEntryFor(REPO_U);
    check(`${label}: real Step B's own union actually happened — U's entry carries both tokens in-process`, !!inProcessMerged && inProcessMerged.tokens.includes(tU) && inProcessMerged.tokens.includes(tT));

    // REBOOT leg: the SAME on-disk directory instanceB's own clear just left behind (U's latch + T's
    // kept-but-untouched orphan content file — A's own latch is gone, cleared) — a WHOLLY FRESH,
    // independent module instance boots it. A real reboot's own PASS 1 is passed registeredRepoPaths
    // EXPLICITLY, independent of any provider — so this leg is unaffected by `wireProvider`.
    const instanceC = await freshModule();
    instanceC.reenterMergeQuarantinesAtBoot(REGISTERED_ROSTER);
    const rebootMerged = instanceC.stillBlockedEntryFor(REPO_U);

    const cmp = compareLegs(inProcessMerged, rebootMerged);
    check(`${label}: in-process vs reboot AGREE on repoPath/resolvedKey/armedKeys/provenanceUnknown (reason if not: ${cmp.reason})`, cmp.agree);
    check(`${label}: both tokens present on reboot`, rebootMerged !== undefined && rebootMerged.tokens.includes(tU) && rebootMerged.tokens.includes(tT));
    check(`${label}: provenanceUnknown is FALSE on both legs — T collides at U's own PRIMARY key here, never a secondary/non-fresh claim, so neither Step B's nor PASS 1's own predicate can fire regardless of the provider (see the PROVENANCE-UNKNOWN PARITY scenario below for the shape that DOES move this field)`, !inProcessMerged?.provenanceUnknown && !rebootMerged?.provenanceUnknown);

    return { inProcessMerged, uRealPostBoot, KEY_U, KEY_V };
  }

  const tOlderResult = await dualArmScenario("SCENARIO1-T-OLDER", true);
  await dualArmScenario("SCENARIO2-U-OLDER", false);

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // PROVENANCE-UNKNOWN PARITY — a SEPARATE shape from scenarios 1/2: T collides at KEY_V, U's own
  // SECONDARY (non-fresh) claim, with V a registered-but-never-raised repo — exactly 1de37538's own
  // step-b-provider-seam test's shape, never scenario 1/2's "T at U's own primary key" shape (which
  // structurally can never move this field — see the predicates: `secondaryArmClaimsADifferentRegistered
  // IdentitysKey` requires the UNRESOLVABLE T itself to be resolvable, so it can never fire here;
  // `priorHoldsKeyViaNonFreshClaimOnADifferentRegisteredIdentity` needs `prior` (U) to hold the key via a
  // NON-fresh claim, true only at U's SECONDARY key KEY_V, never at U's own primary KEY_U). WIRED proves
  // real parity (both TRUE); UNSET is the card's own required RED proof — showing compareLegs' new
  // provenanceUnknown check can actually fail: without the provider, REAL Step B has no access to the
  // registered list (1de37538's own pre-fix behavior) and stays FALSE, while a reboot against the
  // IDENTICAL on-disk bytes — passed registeredRepoPaths explicitly, independent of any provider — still
  // computes TRUE.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  async function provenanceUnknownScenario(label, wireProvider) {
    clearQuarantineDir();

    const raiser = await freshModule();
    const tU = raiser.enterMergeQuarantine(REPO_U, "loom/u-branch", `merge in progress for U (${label})`);
    const uFiles = fs.readdirSync(quarantineDir).filter((f) => f.endsWith(".json"));
    check(`${label}: exactly one latch file after raising U`, uFiles.length === 1);
    const uFilePath = path.join(quarantineDir, uFiles[0]);
    const uRawBeforeEdit = JSON.parse(fs.readFileSync(uFilePath, "utf8"));
    fs.writeFileSync(uFilePath, JSON.stringify({ ...uRawBeforeEdit, resolvedKey: KEY_V }));

    const instanceA = await freshModule();
    if (wireProvider) instanceA.setRegisteredRepoPathsProvider(() => REGISTERED_ROSTER);
    instanceA.reenterMergeQuarantinesAtBoot(REGISTERED_ROSTER);
    check(`${label}: U's secondary arm at KEY_V landed at boot — V's own key occupied before T ever appears`, instanceA.stillBlockedEntryFor(REPO_V)?.repoPath === REPO_U);

    const tA = instanceA.enterMergeQuarantine(REPO_A, "loom/a-branch", `merge in progress for A (${label})`);
    const orphanBasename = foldOrphanRefIntoOwnFinal(REPO_A);

    // CRITICAL GOTCHA (1de37538's own test file): a clearer's in-memory entry needs a real
    // read-from-disk cycle to pick up the orphanLatchFiles edit written directly to disk, or Step B
    // silently never fires. Reboot again before writing T's content and clearing.
    const instanceB = await freshModule();
    if (wireProvider) instanceB.setRegisteredRepoPathsProvider(() => REGISTERED_ROSTER);
    instanceB.reenterMergeQuarantinesAtBoot(REGISTERED_ROSTER);

    const tT = "tok-T-pu-" + freshSfx();
    writeOrphanContent(orphanBasename, T_GHOST, "loom/t-branch", `merge in progress for T (${label}, unresolvable ghost colliding with U's secondary claim at keyV)`, [tT], { resolvedKey: KEY_V });
    instanceB.clearMergeQuarantineByToken(REPO_A, tA);

    const inProcessMerged = instanceB.stillBlockedEntryFor(REPO_V);
    check(`${label}: occupant at keyV carries both U's own token and T's foreign token in-process (the union actually happened)`, !!inProcessMerged && inProcessMerged.tokens.includes(tU) && inProcessMerged.tokens.includes(tT));

    const instanceC = await freshModule();
    instanceC.reenterMergeQuarantinesAtBoot(REGISTERED_ROSTER);
    const rebootMerged = instanceC.stillBlockedEntryFor(REPO_V);
    check(`${label}: reboot occupant at keyV carries both tokens too`, !!rebootMerged && rebootMerged.tokens.includes(tU) && rebootMerged.tokens.includes(tT));

    return { inProcessMerged, rebootMerged };
  }

  {
    const { inProcessMerged, rebootMerged } = await provenanceUnknownScenario("PU-WIRED", true);
    const inProcessValue = !!inProcessMerged?.provenanceUnknown;
    const rebootValue = !!rebootMerged?.provenanceUnknown;
    console.log(`PU-WIRED: in-process=${inProcessValue} reboot=${rebootValue}`);
    check("PU-WIRED: in-process provenanceUnknown is TRUE", inProcessValue === true);
    check("PU-WIRED: *** PARITY *** in-process === reboot (both TRUE) — the SAME shared predicates, fed by the LIVE provider, agree with a real reboot's own explicit registeredRepoPaths", inProcessValue === rebootValue && rebootValue === true);
    const cmpWired = compareLegs(inProcessMerged, rebootMerged);
    check("PU-WIRED: compareLegs itself reports AGREE (the new provenanceUnknown check does not false-positive when the two legs genuinely agree)", cmpWired.agree === true);
  }
  {
    const { inProcessMerged, rebootMerged } = await provenanceUnknownScenario("PU-SEAM-UNSET", false);
    const inProcessValue = !!inProcessMerged?.provenanceUnknown;
    const rebootValue = !!rebootMerged?.provenanceUnknown;
    console.log(`PU-SEAM-UNSET: in-process=${inProcessValue} reboot=${rebootValue}`);
    check("PU-SEAM-UNSET: in-process provenanceUnknown stays FALSE without the provider — 1de37538's own pre-fix behavior", inProcessValue === false);
    check("PU-SEAM-UNSET: reboot is STILL TRUE for the identical on-disk bytes (registeredRepoPaths passed explicitly, independent of any provider) — the divergence is real, not a reboot-side artifact", rebootValue === true);
    // *** THE CARD'S OWN REQUIRED RED PROOF *** — call the SAME compareLegs this file's own scenarios 1/2
    // rely on, directly, on these two genuinely-diverging legs: it must report the mismatch, proving the
    // new provenanceUnknown check this card added is not vacuous — it WOULD have caught exactly this
    // regression had scenarios 1/2's own shape been able to reach it.
    const cmpUnset = compareLegs(inProcessMerged, rebootMerged);
    check("PU-SEAM-UNSET: *** RED PROOF *** compareLegs reports a MISMATCH (agree:false, reason:\"provenanceUnknown differs\") for these two genuinely-diverging legs", cmpUnset.agree === false && cmpUnset.reason === "provenanceUnknown differs");
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 3 — POSITIVE CONTROL: perturb the in-process seed to the repro4 shape (armedKeys=[KEY_U]
  // only, U missing from the map at KEY_V) and assert compareLegs DETECTS the mismatch — proves this
  // file's own comparison can fail, so scenarios 1/2's PASS is not vacuous.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const { KEY_U, KEY_V } = tOlderResult;
    const brokenByRepoKey = new Map();
    brokenByRepoKey.set(KEY_U, { ...tOlderResult.uRealPostBoot, armedKeys: [KEY_U] }); // deliberately missing KEY_V
    const brokenSeedMerged = baseMod.armQuarantineKeyTestOnly(brokenByRepoKey, KEY_U, { repoPath: "T-control", branch: "b", reason: "r", enteredAt: 1, tokens: ["tok-control"], resolvedKey: KEY_U });
    const cmp = compareLegs(brokenSeedMerged, { repoPath: brokenSeedMerged.repoPath, resolvedKey: brokenSeedMerged.resolvedKey, armedKeys: [KEY_U, KEY_V], tokens: brokenSeedMerged.tokens });
    check("POSITIVE CONTROL: a deliberately under-seeded map (armedKeys=[KEY_U] only) IS detected as a mismatch by compareLegs — the comparison is not vacuous", cmp.agree === false && cmp.reason === "armedKeys differ");
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 4 — EXPLICIT ASSERTED DIVERGENCE (not parity): occupant U2 is resolvable but NOT a
  // currently-registered project. Step B's own unconditional union (unresolvable branch) unions T2's
  // token into U2 regardless; a reboot's PASS 1, for this same resolvability-mismatch shape with no
  // registered backing, DECLINES the secondary claim and keeps T2 standalone pending instead. 5d0820c7's
  // own record already names and rules this "stricter, never weaker" and safe for the unresolvable case.
  // Asserted here so a polarity change (either side starts behaving like the other) fails loudly.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    clearQuarantineDir();
    const REPO_U2 = makeRepo("U2-unregistered");
    const KEY_U2 = canonicalRepoLockKey(REPO_U2);
    const T2_GHOST = path.join(os.tmpdir(), `loom-mq188e-ghost-T2-${freshSfx()}`);

    const raiser = await freshModule();
    const tU2 = raiser.enterMergeQuarantine(REPO_U2, "loom/u2-branch", "merge in progress for U2 (SCENARIO4)");
    const uOnDisk = raiser.stillBlockedEntryFor(REPO_U2);

    const tT2 = "tok-T2-" + freshSfx();
    const t2Entry = { repoPath: T2_GHOST, branch: "loom/t2-branch", reason: "merge in progress for T2 (SCENARIO4)", enteredAt: Date.now() + 5_000_000, tokens: [tT2], resolvedKey: KEY_U2 };
    fs.writeFileSync(path.join(quarantineDir, `mq188e-T2-orphan-${freshSfx()}.json`), JSON.stringify(t2Entry));

    // IN-PROCESS leg: Step B's own unconditional secondary-key arm — unions regardless of registration.
    const byRepoKey = new Map();
    byRepoKey.set(KEY_U2, { ...uOnDisk });
    const inProcessMerged = raiser.armQuarantineKeyTestOnly(byRepoKey, KEY_U2, { ...t2Entry });
    check("SCENARIO4 (asserted divergence): IN-PROCESS Step B unions T2's token into U2 regardless of registration", inProcessMerged.tokens.includes(tT2) && inProcessMerged.tokens.includes(tU2));

    // REBOOT leg: U2 passed as UNREGISTERED — PASS 1 should DECLINE the union (card d163aef5).
    const booted = await freshModule();
    booted.reenterMergeQuarantinesAtBoot([]); // U2 deliberately NOT registered
    const rebootU2 = booted.stillBlockedEntryFor(REPO_U2);
    const rebootT2Pending = booted.listPendingMergeQuarantinesTestOnly().some((p) => p.repoPath === T2_GHOST);
    check("SCENARIO4 (asserted divergence): REBOOT declines the union — U2's own entry keeps only its own token", rebootU2 !== undefined && rebootU2.tokens.includes(tU2) && !rebootU2.tokens.includes(tT2));
    check("SCENARIO4 (asserted divergence): REBOOT leaves T2 as its own standalone pending entry instead of unioning it away", rebootT2Pending);
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.error(e);
  process.exit(1);
}
