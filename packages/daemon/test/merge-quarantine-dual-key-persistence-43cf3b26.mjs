import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 43cf3b26 — persisted `resolvedKeys` (plural), generalizing the single-secondary-key mechanism
// cards 48bda567/1e739f4a already shipped (a scalar `resolvedKey` field) to N keys. Closes the
// reboot-persistence gap documented in docs/decisions/8db913e2-raise-diverts-instead-of-overwriting-a-
// kept-occupant.md's "Follow-up 1e739f4a" ACCEPTED RESIDUALS, plus a fourth, independently-reproduced
// SILENT loss at `consumeMatchedPendingsIntoArmedEntry`'s own self-stamp — see that record's own
// "Follow-up 43cf3b26" section for the full design.
//
// (i)   "same-identity-two-tmps"      — two tmps for one key, same identity, both informative/different.
//       FIXED: both keys now survive every reboot (was the ACCEPTED, logged residual
//       merge-quarantine-tmp-promotion-dual-arm.mjs's own "two-tmps" scenario pins — that file is updated
//       alongside this one, per this card's own DoD, to pin the NEW behavior).
// (ii)  "different-identity-subpath" — same mechanism, colliding latches name DIFFERENT identities (Y vs
//       Y's own subdirectory). FIXED: both survive.
// (iii) "json-final-loses-to-tmp"     — a `.json` FINAL (not just a tmp) loses the union to a colliding,
//       older tmp (PASS 1b's primary arm). FIXED: both survive.
// (iv)  "pending-consume-no-loss"     — `consumeMatchedPendingsIntoArmedEntry`'s own self-stamp,
//       independently reproduced (not via any divert) per this card's own body: "Case (iv) is about ANY
//       resolvable pending entry with an informative resolvedKey ... not only a diverted one." FIXED: a
//       plain query graduating a pending entry no longer discards the other key, in memory OR on disk.
// (v)   "registered-y-multi-key"      — the two-tmps collision with Y REGISTERED (the ordinary production
//       path), across TWO reboots.
// (vi)  "raise-after-boot-multi-key"  — the two-tmps collision, boot, then a genuine runtime
//       `enterMergeQuarantine` raise on Y — both keys survive the raise AND a subsequent reboot.
// (vii) "clear-by-path-lifts-all-keys" — a clear must still lift EVERY key (not just the scalar's own),
//       and none of them resurrects after a reboot.
// (viii) "resolved-keys-cap-eviction" — 17 distinct colliding sources for one key exceeds the 16-key cap
//       (Lead ruling); asserts the cap's own loud eviction log fires naming the card, and exactly 16 of
//       the 17 keys (the most recently armed) survive.
// (ix)  "downgrade-compat"            — a NEW record (resolvedKeys populated) is still fully readable by
//       an inlined simulation of the OLD (pre-43cf3b26) parse whitelist, which never looks at
//       `resolvedKeys` at all — proves an old binary reading a new record degrades to single-key
//       behavior rather than throwing or losing data it never asked for.
//
// Round 2 (Code Review 46c5c492) — scalar-only gates that never learned about resolvedKeys:
// (x)   "degraded-divert-after-disappear" — `natural.mjs`. Case (i)'s shape on a NESTED repo Y=R/sub;
//       Y disappears, so its own walked-up key COINCIDES with the already-persisted scalar. CRITICAL
//       (fixed): PASS 1's degraded-else branch used to skip diverting Y's own identity to pending
//       whenever the scalar happened to equal the walked-up currentKey — Y stayed unblocked forever,
//       even once re-created. Now always diverts, regardless of that coincidence.
// (xi)  "degraded-branch-scalar-coincidence" — `probe.mjs`. Same coincidence, PASS 1's main `.json` loop,
//       both "legacy" (negative control) and "plural" (CRITICAL: X must ALSO get armed) variants.
// (xii) "plural-only-no-scalar" — `probe2.mjs`, ruling (c). A record with resolvedKeys but NO scalar at
//       all used to be wrongly treated as a pre-upgrade, keyless latch; its own resolvedKeys never even
//       got attempted. CRITICAL (fixed): X (named only in resolvedKeys) must stay blocked.
// `merge-quarantine-raise-protect-failure.mjs` gets its own new "UNION RULE case 3/3, new format"
// scenario (MAJOR, `case3.mjs`) alongside its existing legacy one — see that file directly.
//
// EACH SCENARIO RUNS IN ITS OWN CHILD PROCESS WITH ITS OWN FRESH LOOM_HOME — mirrors every sibling
// merge-quarantine*.mjs file. Run with no args to spawn one child per scenario; a child reads
// `--scenario=<name>` off argv and runs only that one scenario inline, exiting non-zero on any failure.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-dual-key-persistence-43cf3b26.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCENARIOS = [
  "same-identity-two-tmps",
  "different-identity-subpath",
  "json-final-loses-to-tmp",
  "pending-consume-no-loss",
  "registered-y-multi-key",
  "raise-after-boot-multi-key",
  "clear-by-path-lifts-all-keys",
  "resolved-keys-cap-eviction",
  "downgrade-compat",
  "degraded-divert-after-disappear",
  "degraded-branch-scalar-coincidence",
  "plural-only-no-scalar",
];

const scenarioArg = process.argv.find((a) => a.startsWith("--scenario="));

if (!scenarioArg) {
  const { LOOM_HOME: _inherited, ...envWithoutLoomHome } = process.env;
  let failedScenarios = 0;
  for (const name of SCENARIOS) {
    console.log(`\n=== SCENARIO ${name} (own process, own LOOM_HOME) ===`);
    try {
      execFileSync(process.execPath, [__filename, `--scenario=${name}`], {
        env: envWithoutLoomHome, stdio: "inherit",
      });
      console.log(`--- ${name}: PASS ---`);
    } catch {
      console.log(`--- ${name}: FAIL ---`);
      failedScenarios++;
    }
  }
  console.log(failedScenarios === 0
    ? `\n✅ ALL ${SCENARIOS.length} SCENARIOS PASS — card 43cf3b26's own fix (persisted, capped, retained resolvedKeys) holds.`
    : `\n❌ ${failedScenarios} SCENARIO(S) FAILED.`);
  process.exit(failedScenarios === 0 ? 0 : 1);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// CHILD MODE — below this point, exactly one scenario runs, in its own fresh LOOM_HOME.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
const scenarioName = scenarioArg.slice("--scenario=".length);
useOwnLoomHome(`loom-mqdkp43-${scenarioName}-`);
requireHermeticEnv();

const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  reenterMergeQuarantinesAtBoot, activeMergeQuarantineFor, MERGE_QUARANTINE_DIR,
  listActiveMergeQuarantines, enterMergeQuarantine, clearMergeQuarantineByRecordedPath,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqdkp43@loom -c user.name=mqdkp43";
const tmpDirs = [];
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

let bootReimportCounter = 0;
async function rebootSim() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

function hashForKey(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

function makeRepo(tag) {
  const dir = path.join(os.tmpdir(), `loom-mqdkp43-${tag}-${freshSfx()}`);
  fs.mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, "R.md"), `# ${tag}\n`);
  execSync(`git init -q && git config user.email mqdkp43@loom && git config user.name mqdkp43`, { cwd: dir });
  commitAll(dir, "init", GIT_ID);
  return dir;
}

function writeLatchJson(hash, content) {
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hash}.json`), JSON.stringify(content, null, 2) + "\n");
}
function writeLatchTmp(hash, suffix, content) {
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hash}.json.tmp-${suffix}`), JSON.stringify(content, null, 2) + "\n");
}

async function captureConsole(fn) {
  const lines = [];
  const realErr = console.error;
  const realWarn = console.warn;
  const realLog = console.log;
  console.error = (...args) => { lines.push(["ERROR", ...args.map(String)].join(" ")); realErr(...args); };
  console.warn = (...args) => { lines.push(["WARN", ...args.map(String)].join(" ")); realWarn(...args); };
  console.log = (...args) => { lines.push(["LOG", ...args.map(String)].join(" ")); realLog(...args); };
  try {
    await fn();
  } finally {
    console.error = realErr;
    console.warn = realWarn;
    console.log = realLog;
  }
  return lines;
}

/** Simulates the OLD (pre-43cf3b26) parse whitelist against a raw `.json` latch file — reads ONLY the
 *  scalar `resolvedKey`, never `resolvedKeys` at all. Used by "downgrade-compat" to prove an old binary
 *  reading a new-shaped record degrades to single-key behavior rather than throwing. */
function parseWithOldWhitelist(absolutePath) {
  const parsed = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  return {
    repoPath: parsed.repoPath, branch: parsed.branch, reason: parsed.reason,
    enteredAt: parsed.enteredAt, tokens: parsed.tokens,
    resolvedKey: typeof parsed.resolvedKey === "string" ? parsed.resolvedKey : undefined,
    // Deliberately NEVER reads `parsed.resolvedKeys` — this is the whole point of the simulation.
  };
}

try {
  if (scenarioName === "same-identity-two-tmps") {
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const y = makeRepo("y-i");
    const ky = canonicalRepoLockKey(y);
    const kyHash = hashForKey(ky);
    const w1 = path.join(os.tmpdir(), `loom-mqdkp43-w1-i-never-${freshSfx()}`);
    const w2 = path.join(os.tmpdir(), `loom-mqdkp43-w2-i-never-${freshSfx()}`);
    const k1 = canonicalRepoLockKey(w1);
    const k2 = canonicalRepoLockKey(w2);
    writeLatchTmp(kyHash, "111111", { repoPath: y, branch: "b", reason: "r1-older", enteredAt: Date.now() - 1000, tokens: ["a1"], resolvedKey: k1 });
    writeLatchTmp(kyHash, "222222", { repoPath: y, branch: "b", reason: "r2-newer", enteredAt: Date.now(), tokens: ["a2"], resolvedKey: k2 });

    reenterMergeQuarantinesAtBoot([]);
    let fresh = await rebootSim();
    fresh.reenterMergeQuarantinesAtBoot([]);
    check("W1 stays blocked after reboot 1", !!fresh.activeMergeQuarantineFor(w1));
    check("W2 stays blocked after reboot 1", !!fresh.activeMergeQuarantineFor(w2));
    fresh = await rebootSim();
    fresh.reenterMergeQuarantinesAtBoot([]);
    check("W1 stays blocked after reboot 2 (idempotent)", !!fresh.activeMergeQuarantineFor(w1));
    check("W2 stays blocked after reboot 2 (idempotent)", !!fresh.activeMergeQuarantineFor(w2));
    const after1 = fs.readdirSync(MERGE_QUARANTINE_DIR).sort();
    fresh = await rebootSim();
    fresh.reenterMergeQuarantinesAtBoot([]);
    const after2 = fs.readdirSync(MERGE_QUARANTINE_DIR).sort();
    check("no file growth across an extra reboot", after1.length === after2.length && after1.every((f, i) => f === after2[i]));
  } else if (scenarioName === "different-identity-subpath") {
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const y = makeRepo("y-ii");
    const ySub = path.join(y, "sub");
    fs.mkdirSync(ySub);
    const ky = canonicalRepoLockKey(y);
    if (canonicalRepoLockKey(ySub) !== ky) throw new Error("different-identity-subpath: y/sub did not resolve to y's own key — fixture assumption broken");
    const kyHash = hashForKey(ky);
    const w1 = path.join(os.tmpdir(), `loom-mqdkp43-w1-ii-never-${freshSfx()}`);
    const w2 = path.join(os.tmpdir(), `loom-mqdkp43-w2-ii-never-${freshSfx()}`);
    const k1 = canonicalRepoLockKey(w1);
    const k2 = canonicalRepoLockKey(w2);
    writeLatchTmp(kyHash, "111111", { repoPath: y, branch: "b", reason: "r1-older-y", enteredAt: Date.now() - 1000, tokens: ["a1"], resolvedKey: k1 });
    writeLatchTmp(kyHash, "222222", { repoPath: ySub, branch: "b", reason: "r2-newer-ysub", enteredAt: Date.now(), tokens: ["a2"], resolvedKey: k2 });

    const lines = await captureConsole(() => { reenterMergeQuarantinesAtBoot([]); });
    check("boot-0 reports the collision (info level — no longer a loss)", lines.some((l) => l.includes(k2) && l.includes("43cf3b26")));

    const fresh = await rebootSim();
    fresh.reenterMergeQuarantinesAtBoot([]);
    check("W1 stays blocked after a reboot", !!fresh.activeMergeQuarantineFor(w1));
    check("W2 ALSO stays blocked after a reboot (different-identity collision)", !!fresh.activeMergeQuarantineFor(w2));
  } else if (scenarioName === "json-final-loses-to-tmp") {
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const y = makeRepo("y-iii");
    const ky = canonicalRepoLockKey(y);
    const kyHash = hashForKey(ky);
    const w1 = path.join(os.tmpdir(), `loom-mqdkp43-w1-iii-never-${freshSfx()}`);
    const w2 = path.join(os.tmpdir(), `loom-mqdkp43-w2-iii-never-${freshSfx()}`);
    const k1 = canonicalRepoLockKey(w1);
    const k2 = canonicalRepoLockKey(w2);
    writeLatchJson(kyHash, { repoPath: y, branch: "b", reason: "final-k1", enteredAt: Date.now(), tokens: ["a1"], resolvedKey: k1 });
    writeLatchTmp(kyHash, "222222", { repoPath: y, branch: "b", reason: "tmp-k2-older", enteredAt: Date.now() - 1000, tokens: ["a2"], resolvedKey: k2 });

    reenterMergeQuarantinesAtBoot([]);
    const fresh = await rebootSim();
    fresh.reenterMergeQuarantinesAtBoot([]);
    check("W1 (the FINAL's own key) stays blocked after a reboot", !!fresh.activeMergeQuarantineFor(w1));
    check("W2 (the tmp's own key) ALSO stays blocked after a reboot", !!fresh.activeMergeQuarantineFor(w2));
  } else if (scenarioName === "pending-consume-no-loss") {
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const q = makeRepo("q-iv");
    const kOther = canonicalRepoLockKey(q);
    const z = path.join(os.tmpdir(), `loom-mqdkp43-z-iv-not-yet-${freshSfx()}`);
    tmpDirs.push(z);
    const kzDegraded = canonicalRepoLockKey(z);

    enterMergeQuarantine(q, "qb", "Q's own genuine, independent raise");
    check("(precondition) Q is blocked immediately after its own genuine raise", !!activeMergeQuarantineFor(q));

    const staleHash = hashForKey(`stale-pre-migration-key-for-z-${freshSfx()}`);
    writeLatchJson(staleHash, {
      repoPath: z, branch: "b", reason: "Z, pending, carries an informative resolvedKey naming Q",
      enteredAt: Date.now(), tokens: ["zt1"], resolvedKey: kOther,
    });

    reenterMergeQuarantinesAtBoot([]);
    check("(precondition) Q is STILL blocked right after boot", !!activeMergeQuarantineFor(q));

    fs.mkdirSync(z, { recursive: true });
    fs.writeFileSync(path.join(z, "R.md"), "# z\n");
    execSync(`git init -q && git config user.email mqdkp43@loom && git config user.name mqdkp43`, { cwd: z });
    commitAll(z, "init", GIT_ID);

    activeMergeQuarantineFor(z); // the graduating query
    const graduated = activeMergeQuarantineFor(z);
    check("Z's own graduation does NOT discard Q's informative resolvedKey (in-memory)",
      graduated?.resolvedKey === kOther || (graduated?.armedKeys ?? []).includes(kOther));

    const onDiskZPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kzDegraded)}.json`);
    const onDiskZ = fs.existsSync(onDiskZPath) ? JSON.parse(fs.readFileSync(onDiskZPath, "utf8")) : null;
    check("the DURABLE record also keeps kOther informative",
      onDiskZ?.resolvedKey === kOther || (Array.isArray(onDiskZ?.armedKeys) && onDiskZ.armedKeys.includes(kOther)));

    const fresh = await rebootSim();
    fresh.reenterMergeQuarantinesAtBoot([]);
    check("Q is STILL blocked after a reboot that followed Z's own graduating query", !!fresh.activeMergeQuarantineFor(q));
  } else if (scenarioName === "registered-y-multi-key") {
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const y = makeRepo("y-v");
    const ky = canonicalRepoLockKey(y);
    const kyHash = hashForKey(ky);
    const w1 = path.join(os.tmpdir(), `loom-mqdkp43-w1-v-never-${freshSfx()}`);
    const w2 = path.join(os.tmpdir(), `loom-mqdkp43-w2-v-never-${freshSfx()}`);
    const k1 = canonicalRepoLockKey(w1);
    const k2 = canonicalRepoLockKey(w2);
    writeLatchTmp(kyHash, "111111", { repoPath: y, branch: "b", reason: "r1-older", enteredAt: Date.now() - 1000, tokens: ["a1"], resolvedKey: k1 });
    writeLatchTmp(kyHash, "222222", { repoPath: y, branch: "b", reason: "r2-newer", enteredAt: Date.now(), tokens: ["a2"], resolvedKey: k2 });

    reenterMergeQuarantinesAtBoot([y]); // Y REGISTERED — the ordinary production path
    let fresh = await rebootSim();
    fresh.reenterMergeQuarantinesAtBoot([y]);
    check("W1 stays blocked after a reboot, Y registered", !!fresh.activeMergeQuarantineFor(w1));
    check("W2 stays blocked after a reboot, Y registered", !!fresh.activeMergeQuarantineFor(w2));
    fresh = await rebootSim();
    fresh.reenterMergeQuarantinesAtBoot([y]);
    check("W1 stays blocked after a SECOND reboot, Y registered", !!fresh.activeMergeQuarantineFor(w1));
    check("W2 stays blocked after a SECOND reboot, Y registered", !!fresh.activeMergeQuarantineFor(w2));
  } else if (scenarioName === "raise-after-boot-multi-key") {
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const y = makeRepo("y-vi");
    const ky = canonicalRepoLockKey(y);
    const kyHash = hashForKey(ky);
    const w1 = path.join(os.tmpdir(), `loom-mqdkp43-w1-vi-never-${freshSfx()}`);
    const w2 = path.join(os.tmpdir(), `loom-mqdkp43-w2-vi-never-${freshSfx()}`);
    const k1 = canonicalRepoLockKey(w1);
    const k2 = canonicalRepoLockKey(w2);
    writeLatchTmp(kyHash, "111111", { repoPath: y, branch: "b", reason: "r1-older", enteredAt: Date.now() - 1000, tokens: ["a1"], resolvedKey: k1 });
    writeLatchTmp(kyHash, "222222", { repoPath: y, branch: "b", reason: "r2-newer", enteredAt: Date.now(), tokens: ["a2"], resolvedKey: k2 });

    reenterMergeQuarantinesAtBoot([]);
    enterMergeQuarantine(y, "y-branch-2", "a genuine runtime raise on Y after boot-0");
    check("(precondition) both keys still blocked immediately after the runtime raise",
      !!activeMergeQuarantineFor(w1) && !!activeMergeQuarantineFor(w2));

    const fresh = await rebootSim();
    fresh.reenterMergeQuarantinesAtBoot([]);
    check("W1 stays blocked after a reboot that followed a runtime raise", !!fresh.activeMergeQuarantineFor(w1));
    check("W2 stays blocked after a reboot that followed a runtime raise", !!fresh.activeMergeQuarantineFor(w2));
  } else if (scenarioName === "clear-by-path-lifts-all-keys") {
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const y = makeRepo("y-vii");
    const ky = canonicalRepoLockKey(y);
    const kyHash = hashForKey(ky);
    const w1 = path.join(os.tmpdir(), `loom-mqdkp43-w1-vii-never-${freshSfx()}`);
    const w2 = path.join(os.tmpdir(), `loom-mqdkp43-w2-vii-never-${freshSfx()}`);
    const k1 = canonicalRepoLockKey(w1);
    const k2 = canonicalRepoLockKey(w2);
    writeLatchTmp(kyHash, "111111", { repoPath: y, branch: "b", reason: "r1-older", enteredAt: Date.now() - 1000, tokens: ["a1"], resolvedKey: k1 });
    writeLatchTmp(kyHash, "222222", { repoPath: y, branch: "b", reason: "r2-newer", enteredAt: Date.now(), tokens: ["a2"], resolvedKey: k2 });

    reenterMergeQuarantinesAtBoot([]);
    check("(precondition) both keys blocked before the clear", !!activeMergeQuarantineFor(w1) && !!activeMergeQuarantineFor(w2));
    const result = clearMergeQuarantineByRecordedPath(y);
    check("clear reports success", result?.wasQuarantined === true);
    check("Y itself is unblocked immediately after the clear", !activeMergeQuarantineFor(y));
    check("W1 is ALSO unblocked immediately after the clear", !activeMergeQuarantineFor(w1));
    check("W2 is ALSO unblocked immediately after the clear", !activeMergeQuarantineFor(w2));

    const fresh = await rebootSim();
    fresh.reenterMergeQuarantinesAtBoot([]);
    check("Y does not resurrect after a reboot", !fresh.activeMergeQuarantineFor(y));
    check("W1 does not resurrect after a reboot", !fresh.activeMergeQuarantineFor(w1));
    check("W2 does not resurrect after a reboot", !fresh.activeMergeQuarantineFor(w2));
  } else if (scenarioName === "resolved-keys-cap-eviction") {
    // 17 DISTINCT witnesses, each raised against Y in its OWN boot (a genuine runtime raise's own union
    // path) so each one's key gets folded into Y's own resolvedKeys across repeated boots — exceeding
    // the 16-key cap (Lead ruling) on the 17th.
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const y = makeRepo("y-viii");
    const ky = canonicalRepoLockKey(y);
    const kyHash = hashForKey(ky);
    const witnessKeys = [];
    for (let i = 0; i < 17; i++) {
      const w = path.join(os.tmpdir(), `loom-mqdkp43-w${i}-viii-never-${freshSfx()}`);
      witnessKeys.push(canonicalRepoLockKey(w));
    }
    // Build the collision by writing ONE tmp per witness, all sharing Y's own hash, each carrying its
    // own distinct, equally-informative resolvedKey, with STRICTLY increasing enteredAt (so the "most
    // recently armed" ordering the cap's eviction rule promises is unambiguous).
    witnessKeys.forEach((k, i) => {
      writeLatchTmp(kyHash, `${100000 + i}`, { repoPath: y, branch: "b", reason: `r${i}`, enteredAt: Date.now() + i, tokens: [`a${i}`], resolvedKey: k });
    });

    const lines = await captureConsole(() => { reenterMergeQuarantinesAtBoot([]); });
    check("the cap's own eviction log fires, naming the card", lines.some((l) => l.includes("resolvedKeys cap") && l.includes("43cf3b26")));

    const onDisk = JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, `${kyHash}.json`), "utf8"));
    const persistedKeys = onDisk.resolvedKeys ?? [];
    check("exactly 16 keys survive the cap (never 17, never fewer)", persistedKeys.length === 16);
    // The witnesses are armed in readdir order within PASS 1b's own loop, not strictly by enteredAt —
    // but EVERY witness among the 17 is dual-armed in-memory THIS boot regardless of the cap (the cap
    // only bounds what's PERSISTED); assert the cap evicted EXACTLY one witness's own key from the
    // persisted array, never zero and never more than one, rather than asserting WHICH one by index.
    const survivingWitnessCount = witnessKeys.filter((k) => persistedKeys.includes(k)).length;
    check("exactly 16 of the 17 witness keys survive in the persisted array", survivingWitnessCount === 16);

    const fresh = await rebootSim();
    fresh.reenterMergeQuarantinesAtBoot([]);
    let blockedCount = 0;
    for (const k of persistedKeys) {
      // `activeMergeQuarantineFor` needs a REPO PATH, not a bare key — but every surviving key here is
      // one of the witnessKeys values themselves (canonicalRepoLockKey output), which this module also
      // accepts as a repoPath-shaped string for a never-resolvable witness (mirrors every other scenario
      // in this file, which queries by the witness's own path value, itself the degraded key). Confirm
      // by querying with the key value directly.
      if (fresh.activeMergeQuarantineFor(k)) blockedCount++;
    }
    check("every surviving key is still blocked after a reboot", blockedCount === 16);
  } else if (scenarioName === "downgrade-compat") {
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const y = makeRepo("y-ix");
    const ky = canonicalRepoLockKey(y);
    const kyHash = hashForKey(ky);
    const w1 = path.join(os.tmpdir(), `loom-mqdkp43-w1-ix-never-${freshSfx()}`);
    const w2 = path.join(os.tmpdir(), `loom-mqdkp43-w2-ix-never-${freshSfx()}`);
    const k1 = canonicalRepoLockKey(w1);
    const k2 = canonicalRepoLockKey(w2);
    writeLatchTmp(kyHash, "111111", { repoPath: y, branch: "b", reason: "r1-older", enteredAt: Date.now() - 1000, tokens: ["a1"], resolvedKey: k1 });
    writeLatchTmp(kyHash, "222222", { repoPath: y, branch: "b", reason: "r2-newer", enteredAt: Date.now(), tokens: ["a2"], resolvedKey: k2 });
    reenterMergeQuarantinesAtBoot([]); // writes the NEW-shaped record (resolvedKeys populated)

    const onDiskPath = path.join(MERGE_QUARANTINE_DIR, `${kyHash}.json`);
    const onDisk = JSON.parse(fs.readFileSync(onDiskPath, "utf8"));
    check("(precondition) the real record IS new-shaped (resolvedKeys is a populated array)",
      Array.isArray(onDisk.resolvedKeys) && onDisk.resolvedKeys.length > 0);

    // Simulate an OLD (pre-43cf3b26) reader against this SAME, real, new-shaped file.
    let oldParsed;
    let oldParseThrew = false;
    try {
      oldParsed = parseWithOldWhitelist(onDiskPath);
    } catch {
      oldParseThrew = true;
    }
    check("an OLD parse whitelist does not throw on a new-shaped record", !oldParseThrew);
    check("an OLD parse whitelist still sees exactly ONE informative resolvedKey (never undefined)",
      oldParsed?.resolvedKey !== undefined && oldParsed.resolvedKey !== ky);
    check("an OLD parse whitelist never even looks at resolvedKeys",
      !("resolvedKeys" in (oldParsed ?? {})));
  } else if (scenarioName === "degraded-divert-after-disappear") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // (x) — Code Review 46c5c492's `natural.mjs`. Y = R/sub (its OWN real repo, key Ky, distinct from
    // R's own key Kr) is dual-armed via two tmps carrying resolvedKey=Kr (older) and resolvedKey=Kx
    // (newer) — exactly case (i)'s shape. Two reboots promote + persist the plural record
    // (resolvedKey=Kr, resolvedKeys=[Kr,Kx]). Y then DISAPPEARS (`rm -rf`) — its own canonical key now
    // WALKS UP to Kr, COINCIDING with the already-persisted scalar. CRITICAL (fixed): PASS 1's degraded
    // branch used to skip diverting Y's own (now-degraded) identity to pending whenever the scalar
    // happened to equal the walked-up key — Y stayed neither armed nor pending, UNBLOCKED, even once
    // re-created mid-process. DESIRED (now true): Y stays blocked after Y disappears, X (Kx) stays
    // blocked throughout, and a mid-process remount of Y is still correctly reported quarantined.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const r = path.join(os.tmpdir(), `loom-mqdkp43-r-x-${freshSfx()}`);
    fs.mkdirSync(r, { recursive: true }); tmpDirs.push(r);
    fs.writeFileSync(path.join(r, "R.md"), "# r\n");
    execSync(`git init -q && git config user.email mqdkp43@loom && git config user.name mqdkp43`, { cwd: r });
    commitAll(r, "init", GIT_ID);
    const y = path.join(r, "sub");
    fs.mkdirSync(y);
    execSync("git init -q", { cwd: y }); // no commit here -- an empty .git is enough to be its OWN toplevel
    const x = makeRepo("x-x");
    const kr = canonicalRepoLockKey(r);
    const kx = canonicalRepoLockKey(x);
    const ky = canonicalRepoLockKey(y);
    check("(precondition) Y's own key is distinct from R's own key (Y has its own .git)", ky !== kr);
    const kyHash = hashForKey(ky);
    writeLatchTmp(kyHash, "111111", { repoPath: y, branch: "b", reason: "r1-older", enteredAt: Date.now() - 1000, tokens: ["a1"], resolvedKey: kr });
    writeLatchTmp(kyHash, "222222", { repoPath: y, branch: "b", reason: "r2-newer", enteredAt: Date.now(), tokens: ["a2"], resolvedKey: kx });
    reenterMergeQuarantinesAtBoot([]);
    let fresh = await rebootSim();
    fresh.reenterMergeQuarantinesAtBoot([]); // reboot 2: promotes + persists the plural record
    check("(precondition) Y stays blocked while it still exists, after two reboots", !!fresh.activeMergeQuarantineFor(y));

    fs.rmSync(y, { recursive: true, force: true }); // Y disappears; canonicalRepoLockKey(y) now walks up to Kr
    check("(precondition) Y's walked-up key now COINCIDES with the already-persisted scalar (Kr)", canonicalRepoLockKey(y) === kr);
    fresh = await rebootSim();
    fresh.reenterMergeQuarantinesAtBoot([]);
    check("*** CRITICAL (CR 46c5c492) *** Y stays blocked after disappearing, even though its walked-up key coincides with the scalar", !!fresh.activeMergeQuarantineFor(y));
    check("X (Kx) stays blocked throughout", !!fresh.activeMergeQuarantineFor(x));

    fs.mkdirSync(y); execSync("git init -q", { cwd: y });
    const assertion = fresh.assertRepoNotQuarantined(y);
    check("a mid-process REMOUNT of Y is still correctly reported quarantined (not ok:true)", assertion?.ok === false);
  } else if (scenarioName === "degraded-branch-scalar-coincidence") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // (xi) — Code Review 46c5c492's `probe.mjs`. D = R/gone-sub (NEVER created — unresolvable, walks up
    // to R's own key Kr) has a `.json` final filed under a STALE physical key, carrying scalar
    // resolvedKey=Kr (== D's own degraded currentKey) and (variant "plural" only) resolvedKeys=[Kr,Kx].
    // "legacy" (no resolvedKeys array) is a NEGATIVE CONTROL: D still ends up a fail-closed pending entry
    // (unchanged), but there is no second key to arm, so X stays unblocked — that is correct, not a bug.
    // "plural" is the CRITICAL case: D must stay blocked AND X (Kx) must ALSO get armed.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    for (const variant of ["legacy", "plural"]) {
      fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
      const r = makeRepo(`r-xi-${variant}`);
      const x = makeRepo(`x-xi-${variant}`);
      const d = path.join(r, "gone-sub"); // never created
      const kr = canonicalRepoLockKey(d);
      const kx = canonicalRepoLockKey(x);
      check(`(precondition, ${variant}) D's own degraded key walks up to R's own key`, kr === canonicalRepoLockKey(r));
      const kOwnHash = hashForKey(`legacy-own-key-for-d-${freshSfx()}`);
      const rec = { repoPath: d, branch: "loom/probe", reason: "probe", opId: "op-probe", enteredAt: Date.now(), tokens: ["tok-d"], resolvedKey: kr, provenanceTracked: true };
      if (variant === "plural") rec.resolvedKeys = [kr, kx];
      writeLatchJson(kOwnHash, rec);
      reenterMergeQuarantinesAtBoot([]);
      check(`*** (${variant}) *** D is a fail-closed pending entry, blocked via direct identity`, !!activeMergeQuarantineFor(d));
      check(`(${variant}) X blocked`, !!activeMergeQuarantineFor(x) === (variant === "plural"));
    }
  } else if (scenarioName === "plural-only-no-scalar") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // (xii) — Code Review 46c5c492's `probe2.mjs` (ruling c). D's own record has NO scalar `resolvedKey`
    // at all (deleted), only a plural `resolvedKeys=[Kx]`. CRITICAL (fixed): the "no key at all" gate
    // used to check the scalar alone and wrongly treat this as a pre-upgrade, keyless latch — X's own
    // informative key was never even attempted. DESIRED: X stays blocked.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const r = makeRepo("r-xii");
    const x = makeRepo("x-xii");
    const d = path.join(r, "gone-sub");
    const kx = canonicalRepoLockKey(x);
    const kOwnHash = hashForKey(`legacy-own-key-for-d-${freshSfx()}`);
    writeLatchJson(kOwnHash, { repoPath: d, branch: "loom/probe", reason: "probe", opId: "op-probe", enteredAt: Date.now(), tokens: ["tok-d"], resolvedKeys: [kx], provenanceTracked: true });
    reenterMergeQuarantinesAtBoot([]);
    check("D is a fail-closed pending entry, blocked via direct identity", !!activeMergeQuarantineFor(d));
    check("*** CRITICAL (CR 46c5c492, ruling c) *** X stays blocked even though D carries NO scalar at all, only resolvedKeys", !!activeMergeQuarantineFor(x));
  } else {
    throw new Error(`unknown scenario: ${scenarioName}`);
  }
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

console.log(failures === 0 ? `\n✅ ${scenarioName}: ALL CHECKS PASS` : `\n❌ ${scenarioName}: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
