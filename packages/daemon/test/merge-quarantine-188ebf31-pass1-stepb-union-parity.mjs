import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision 188ebf31 — PARITY, not a defect, for the same bytes/order — see the decision record for the
// reachability argument, its one assumption (re-open this if a runtime path is ever found that breaks
// it), and scenario 4's own separate, already-accepted divergence.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

// Compares the two legs' own merged objects on the fields this card's own question is about.
function compareLegs(inProcessMerged, rebootMerged) {
  if (rebootMerged === undefined) return { agree: false, reason: "reboot found no entry" };
  if (inProcessMerged.repoPath !== rebootMerged.repoPath) return { agree: false, reason: "repoPath differs" };
  if (inProcessMerged.resolvedKey !== rebootMerged.resolvedKey) return { agree: false, reason: "resolvedKey differs" };
  const a = new Set(inProcessMerged.armedKeys ?? []);
  const b = new Set(rebootMerged.armedKeys ?? []);
  if (a.size !== b.size || ![...a].every((k) => b.has(k))) return { agree: false, reason: "armedKeys differ" };
  return { agree: true, reason: undefined };
}

try {
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIOS 1/2 — dual-arm parity, T-older and U-older. U is dual-armed at [KEY_U, KEY_V] — but that
  // dual-arm is derived from a REAL reenterMergeQuarantinesAtBoot read-back (instance A), never a
  // hand-set armedKeys field (confirmed below: U's raw on-disk JSON carries no armedKeys at all — it is
  // a purely derived/runtime field). T is an unresolvable ghost whose orphan content names KEY_U (U's
  // own primary key) as a self-referential (uninformative) secondary key — the exact shape 6b327712
  // item 3 traced the worried divergence to.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  const REPO_U = makeRepo("U");
  const REPO_V = makeRepo("V");
  const KEY_U = canonicalRepoLockKey(REPO_U);
  const KEY_V = canonicalRepoLockKey(REPO_V);
  check("precondition: KEY_U !== KEY_V", KEY_U !== KEY_V);
  const T_GHOST = path.join(os.tmpdir(), `loom-mq188e-ghost-T-${freshSfx()}`); // never created — unresolvable

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

    // IN-PROCESS leg, part 1: a GENUINE PASS 1 boot of ONLY U's file (T absent) — U's real dual-arm at
    // [KEY_U, KEY_V] comes from this, never asserted.
    const instanceA = await freshModule();
    instanceA.reenterMergeQuarantinesAtBoot([REPO_U, REPO_V]);
    const uRealPostBoot = instanceA.stillBlockedEntryFor(REPO_U);
    check(`${label}: PASS 1 itself genuinely dual-arms U at both KEY_U and KEY_V (not asserted here)`, uRealPostBoot !== undefined && new Set(uRealPostBoot.armedKeys ?? []).size === 2 && (uRealPostBoot.armedKeys ?? []).includes(KEY_U) && (uRealPostBoot.armedKeys ?? []).includes(KEY_V));

    // IN-PROCESS leg, part 2: T's orphan content + the Step B simulation — a standalone map seeded ONLY
    // from uRealPostBoot's own fields (armedKeys read FROM the object, never hardcoded).
    const tT = "tok-T-" + freshSfx();
    const tEnteredAt = tOlder ? 1 : (Date.now() + 10_000_000);
    const tEntry = { repoPath: T_GHOST, branch: "loom/t-branch", reason: `merge in progress for T (${label})`, enteredAt: tEnteredAt, tokens: [tT], resolvedKey: KEY_U };
    const byRepoKey = new Map();
    for (const k of uRealPostBoot.armedKeys ?? [KEY_U]) byRepoKey.set(k, uRealPostBoot);
    const inProcessMerged = instanceA.armQuarantineKeyTestOnly(byRepoKey, KEY_U, { ...tEntry });

    // REBOOT leg: T's orphan written to the SAME directory (now holding whatever instance A's own boot
    // left for U on disk), then a WHOLLY FRESH, independent module instance boots BOTH files.
    fs.writeFileSync(path.join(quarantineDir, `mq188e-T-orphan-${freshSfx()}.json`), JSON.stringify(tEntry));
    const instanceC = await freshModule();
    instanceC.reenterMergeQuarantinesAtBoot([REPO_U, REPO_V]);
    const rebootMerged = instanceC.stillBlockedEntryFor(REPO_U);

    const cmp = compareLegs(inProcessMerged, rebootMerged);
    check(`${label}: in-process vs reboot AGREE on repoPath/resolvedKey/armedKeys (reason if not: ${cmp.reason})`, cmp.agree);
    check(`${label}: both tokens present on reboot`, rebootMerged !== undefined && rebootMerged.tokens.includes(tU) && rebootMerged.tokens.includes(tT));

    return { inProcessMerged, uRealPostBoot, KEY_U, KEY_V };
  }

  const tOlderResult = await dualArmScenario("SCENARIO1-T-OLDER", true);
  await dualArmScenario("SCENARIO2-U-OLDER", false);

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
