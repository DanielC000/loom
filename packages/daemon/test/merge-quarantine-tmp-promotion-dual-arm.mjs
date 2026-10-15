import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 1e739f4a — PASS 1b's own tmp-PROMOTION write (PHASE 2, merge-quarantine.ts, search
// `const armedForWrite: MergeQuarantineEntry = isInformativeKey(unionEntry, key) ? unionEntry : ...`)
// used to HARD-OVERWRITE `resolvedKey` with the promote key, unconditionally, regardless of what
// `unionEntry.resolvedKey` already carried. When a key's own union is genuinely DUAL-ARMED (a real
// secondary key — the shape cards 4b06875f/48bda567 established as load-bearing for `armQuarantineKey`'s
// own boot-time union, NOT a disposable "this repo used to be filed under a different hash of itself"
// migration marker), that stamp destroyed the secondary key the instant ANY tmp residue for the same key
// was recovered/promoted at boot — even when the dual-arm came from an already-clean, untouched `.json`
// final sharing the key, and even though `armedKeys` stayed correctly dual-armed IN MEMORY that exact
// boot (the bug was purely a PERSISTENCE loss, never an in-process enforcement gap). FIXED below (Fix 1).
//
// Discovered from Code Review 31ba43b4 of card 48bda567 (round 3) — see that card's own "Do not" bullet
// (48bda567-no-fire-both-sides-informative-and-different) and
// docs/decisions/8db913e2-raise-diverts-instead-of-overwriting-a-kept-occupant.md's "Follow-up 1e739f4a"
// section for the full history, including a ROUND-2 Code Review (cd9b1e3e) that found an initially-shipped
// divert (attempting to also PRESERVE the losing side of a two-informative-keys collision) unsound and
// had it reverted — see that section for why, and for card 43cf3b26, which owns the real fix.
//
// Origin of the self-stamp: commit a1401880 (card 92c645cc, round 2). That card's own decision record
// (docs/decisions/92c645cc-fresh-tmp-name-and-conditional-sweep.md, "PASS 1b's one-boot dual-arm vs
// PASS 1's immediate single-arm") explicitly reasoned the loss was HARMLESS ("the only thing a stale
// key's continued presence... ever enabled was a human `/clear-by-path {id}` convenience... nothing is
// ever LESS enforced either way") — a reasoning that holds for a MIGRATE-sourced self-referential
// `resolvedKey` (disposable), but is FALSE for a genuinely cross-repo dual-arm `resolvedKey` (load-
// bearing enforcement of a SECOND, different repo) — a distinction 92c645cc's own round never
// considered, because PASS 1b's tmp loop at the time never dual-armed across a PRE-EXISTING `.json`
// final sharing the key the way 1e739f4a's fixtures below do.
//
// THIS FILE — the repro matrix from the card's own body, as COMMITTED scenarios:
//   "one-json-control"        — Ky.json alone (RK=k1, no tmp at all). NOT expected to reproduce the bug
//                                (included as the negative control — this shape never reaches PHASE 2).
//   "one-tmp"                 — Ky.json.tmp-<pid> alone (RK=k1, no final at all). FIXED: W1 stays blocked
//                                after a reboot.
//   "registered-y"            — same shape as "one-tmp", but Y IS registered at boot (the normal
//                                production case) — proves Fix 1 holds under the registered path too,
//                                not just the deliberately-unregistered fixtures above.
//   "raise-y-after-boot0"     — two colliding tmps (see "two-tmps" below), boot-0, then a genuine runtime
//                                `enterMergeQuarantine(y, ...)` raise — proves the KEPT key (K1) survives
//                                a raise + reboot too, not just a plain reboot.
//   "two-tmps"                — two sibling tmps for one key (RK=k1 older, RK=k2 newer, per 92c645cc
//                                round 2's own "a key can carry MORE THAN ONE tmp"). FIXED by card
//                                43cf3b26's own persisted, plural `resolvedKeys`: BOTH W1 (K1) and W2 (K2)
//                                now stay blocked across TWO reboots — the former ACCEPTED RESIDUAL ("K2
//                                is unblocked after a reboot") is retired. Boot-0 still reports the
//                                collision, now at INFO level (no longer a loss to flag loudly).
//   "json-plus-tmp"           — a clean, already-correct Ky.json (RK=k1) PLUS an unrelated, harmless
//                                stale tmp sharing Ky's hash (no resolvedKey of its own — not a
//                                two-informative-keys collision at all). FIXED: W1 stays blocked after a
//                                reboot, even though the real final was never wrong.
//   "json-plus-tmp-subpath"   — same as above, but the accompanying tmp's own content names Y's
//                                SUBDIRECTORY (so it reaches PHASE 2 via the SAME currentKey, never a
//                                registered-repo early-delete shortcut). FIXED: W1 stays blocked.
//
// Every scenario except "registered-y" calls `reenterMergeQuarantinesAtBoot([])` (repos deliberately
// UNREGISTERED), mirroring `48bda567-migrate-union-drops-dual-arm-b-older`'s own posture — this is
// deliberate: a REGISTERED repo's own tmp residue that shares a hash with an already-cleanly-parsed
// `.json` final is swept as harmless residue BEFORE ever reaching the promotion code this card is about
// (see PASS 1b's own `matchedRepo && isRepoPathCurrentlyResolvable(matchedRepo) &&
// cleanlyParsedKeys.has(...)` early-delete gate) — staying unregistered is what forces every tmp through
// the FULL parse+arm+promote path instead. "registered-y" deliberately registers Y to prove Fix 1 also
// holds on the ordinary, registered path (its own single tmp never triggers that early-delete gate
// anyway, since no `.json` final exists for PASS 1 to have cleanly parsed first).
//
// EACH SCENARIO RUNS IN ITS OWN CHILD PROCESS WITH ITS OWN FRESH LOOM_HOME — mirrors every sibling
// merge-quarantine*.mjs file. Run with no args to spawn one child per scenario; a child reads
// `--scenario=<name>` off argv and runs only that one scenario inline, exiting non-zero on any failure.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-tmp-promotion-dual-arm.mjs
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
  "one-json-control",
  "one-tmp",
  "registered-y",
  "raise-y-after-boot0",
  "two-tmps",
  "json-plus-tmp",
  "json-plus-tmp-subpath",
  "identity-invariant-two-secondaries",
  "identity-invariant-two-secondaries-remount",
];

const scenarioArg = process.argv.find((a) => a.startsWith("--scenario="));

if (!scenarioArg) {
  // DRIVER MODE — spawn one child per scenario, each with LOOM_HOME stripped from its env so
  // `useOwnLoomHome` (called inside the child) mints a genuinely fresh one.
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
    ? "\n✅ ALL SCENARIOS PASS — PASS 1b's tmp-promotion write preserves a genuinely dual-armed key's own "
      + "secondary resolvedKey (Fix 1, card 1e739f4a); the two-informative-keys collision is now FULLY "
      + "FIXED (card 43cf3b26's own persisted, plural resolvedKeys), pinned by 'two-tmps'."
    : `\n❌ ${failedScenarios} SCENARIO(S) FAILED.`);
  process.exit(failedScenarios === 0 ? 0 : 1);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// CHILD MODE — below this point, exactly one scenario runs, in its own fresh LOOM_HOME.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
const scenarioName = scenarioArg.slice("--scenario=".length);
useOwnLoomHome(`loom-mqtpda-${scenarioName}-`);
requireHermeticEnv();

const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  reenterMergeQuarantinesAtBoot, activeMergeQuarantineFor, assertRepoNotQuarantined, MERGE_QUARANTINE_DIR,
  listActiveMergeQuarantines, enterMergeQuarantine, assertQuarantineIdentityInvariantTestOnly,
  clearMergeQuarantine,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqtpda@loom -c user.name=mqtpda";
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

// Captures everything written to `console.error`/`console.log` while `fn` runs (synchronous or async),
// restoring the real functions afterward even on throw — used to assert card 43cf3b26's own fix reports
// the collision at info level (no longer a loss) rather than silently.
async function captureConsole(fn) {
  const lines = [];
  const realErr = console.error;
  const realLog = console.log;
  console.error = (...args) => { lines.push(args.map(String).join(" ")); realErr(...args); };
  console.log = (...args) => { lines.push(args.map(String).join(" ")); realLog(...args); };
  try {
    await fn();
  } finally {
    console.error = realErr;
    console.log = realLog;
  }
  return lines;
}

// Builds Y (a real, resolvable repo) plus W1 (and, if `twoWitnesses`, W2) — paths that never exist on
// disk, used ONLY to mint a degraded "walked-up" canonical key via `canonicalRepoLockKey`, the SAME
// technique `buildDualArmFixture`/`buildRuntimeUnionFixture` already use in
// merge-quarantine-runtime-union-provenance.mjs for an unresolvable secondary identity.
function buildYAndWitnesses(tag, { twoWitnesses } = {}) {
  const y = path.join(os.tmpdir(), `loom-mqtpda-y-${tag}-${freshSfx()}`);
  fs.mkdirSync(y, { recursive: true });
  tmpDirs.push(y);
  fs.writeFileSync(path.join(y, "README.md"), `# ${tag}\n`);
  execSync(`git init -q && git config user.email mqtpda@loom && git config user.name mqtpda`, { cwd: y });
  commitAll(y, "init", GIT_ID);
  const ky = canonicalRepoLockKey(y);
  const kyHash = hashForKey(ky);

  const w1 = path.join(os.tmpdir(), `loom-mqtpda-w1-${tag}-never-exists-${freshSfx()}`);
  const k1 = canonicalRepoLockKey(w1);
  if (hashForKey(k1) === kyHash) throw new Error(`${tag}: k1 collided with ky — re-run`);

  if (!twoWitnesses) {
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    return { y, ky, kyHash, w1, k1 };
  }

  let w2, k2;
  for (let attempt = 0; ; attempt++) {
    w2 = path.join(os.tmpdir(), `loom-mqtpda-w2-${tag}-never-exists-${freshSfx()}`);
    k2 = canonicalRepoLockKey(w2);
    if (hashForKey(k2) !== kyHash && k2 !== k1) break;
    if (attempt > 200_000) throw new Error(`${tag}: could not mint a distinct k2 after 200,000 attempts`);
  }
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  return { y, ky, kyHash, w1, k1, w2, k2 };
}

function writeLatchJson(hash, content) {
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hash}.json`), JSON.stringify(content, null, 2) + "\n");
}
function writeLatchTmp(hash, suffix, content) {
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hash}.json.tmp-${suffix}`), JSON.stringify(content, null, 2) + "\n");
}

try {
  if (scenarioName === "one-json-control") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // CONTROL — a plain `.json` final, dual-armed via the legacy stale-resolvedKey shape (NO tmp at
    // all, so PASS 1b's tmp-promotion code is never reached). Must stay blocked after a reboot — this
    // scenario exists to prove the matrix isn't vacuously red/green everywhere.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { y, kyHash, w1, k1 } = buildYAndWitnesses("one-json-control");
    writeLatchJson(kyHash, {
      repoPath: y, branch: "y-branch", reason: "Y dual-armed via a legacy stale resolvedKey=K1 (control, no tmp)",
      enteredAt: Date.now(), tokens: ["a1"], resolvedKey: k1,
    });

    reenterMergeQuarantinesAtBoot([]); // boot-0, deliberately unregistered
    check("(precondition) boot-0 dual-arms Y at both Ky and K1", (() => {
      const yEntry = listActiveMergeQuarantines().find((e) => (e.armedKeys ?? []).includes(k1));
      return !!yEntry;
    })());

    const fresh = await rebootSim();
    fresh.reenterMergeQuarantinesAtBoot([]);
    const w1EntryAfterReboot = fresh.activeMergeQuarantineFor(w1);
    check("*** CONTROL *** W1 stays blocked after a plain reboot — no tmp was ever involved",
      !!w1EntryAfterReboot && (w1EntryAfterReboot.armedKeys ?? []).includes(k1));
  } else if (scenarioName === "one-tmp") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // ONE-TMP — Y's own dual-arm exists ONLY as a `.json.tmp-<pid>` residue (no final at all — a crash
    // landed between fsync and rename). PASS 1b recovers + promotes it; FIXED: the promote site now
    // preserves K1 instead of self-stamping over it.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { y, kyHash, w1, k1 } = buildYAndWitnesses("one-tmp");
    writeLatchTmp(kyHash, "111111", {
      repoPath: y, branch: "y-branch", reason: "Y dual-armed via a legacy stale resolvedKey=K1 (torn-write tmp only)",
      enteredAt: Date.now(), tokens: ["a1"], resolvedKey: k1,
    });

    reenterMergeQuarantinesAtBoot([]); // boot-0, deliberately unregistered
    check("(precondition) boot-0 dual-arms Y at both Ky and K1 IN MEMORY — the bug is not here", (() => {
      const yEntry = listActiveMergeQuarantines().find((e) => (e.armedKeys ?? []).includes(k1));
      return !!yEntry;
    })());
    const promotedPath = path.join(MERGE_QUARANTINE_DIR, `${kyHash}.json`);
    check("(precondition) the tmp was promoted to a real final this boot", fs.existsSync(promotedPath));
    const onDisk = JSON.parse(fs.readFileSync(promotedPath, "utf8"));
    check("*** FIX 1 *** the promoted final's own on-disk resolvedKey IS K1 (never self-referential Ky)",
      onDisk.resolvedKey === k1);

    const fresh = await rebootSim();
    fresh.reenterMergeQuarantinesAtBoot([]);
    const w1EntryAfterReboot = fresh.activeMergeQuarantineFor(w1);
    check("*** CARD 1e739f4a (Fix 1) *** W1 stays blocked after a reboot",
      !!w1EntryAfterReboot && (w1EntryAfterReboot.armedKeys ?? []).includes(k1));
  } else if (scenarioName === "registered-y") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // REGISTERED-Y — same shape as ONE-TMP, but Y IS passed to `reenterMergeQuarantinesAtBoot` (the
    // ordinary, registered production path) across TWO reboots. A single informative tmp never trips
    // PASS 1b's own early-delete-as-stale-residue gate (that gate requires a `.json` final to have
    // ALREADY parsed cleanly this boot, which never happens here — there is no final at all until this
    // tmp is itself promoted into one), so registering Y changes nothing about Fix 1's own correctness;
    // this scenario exists to prove that directly rather than infer it.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { y, kyHash, w1, k1 } = buildYAndWitnesses("registered-y");
    writeLatchTmp(kyHash, "111111", {
      repoPath: y, branch: "y-branch", reason: "Y dual-armed via a legacy stale resolvedKey=K1 (torn-write tmp only, Y registered)",
      enteredAt: Date.now(), tokens: ["a1"], resolvedKey: k1,
    });

    reenterMergeQuarantinesAtBoot([y]); // boot-0, Y REGISTERED
    check("(precondition) boot-0 dual-arms Y at both Ky and K1 IN MEMORY", (() => {
      const yEntry = listActiveMergeQuarantines().find((e) => (e.armedKeys ?? []).includes(k1));
      return !!yEntry;
    })());

    const fresh = await rebootSim();
    fresh.reenterMergeQuarantinesAtBoot([y]);
    const w1EntryAfterReboot = fresh.activeMergeQuarantineFor(w1);
    check("*** FIX 1, Y REGISTERED *** W1 stays blocked after a reboot",
      !!w1EntryAfterReboot && (w1EntryAfterReboot.armedKeys ?? []).includes(k1));

    const fresh2 = await rebootSim();
    fresh2.reenterMergeQuarantinesAtBoot([y]);
    const w1EntryAfterReboot2 = fresh2.activeMergeQuarantineFor(w1);
    check("*** FIX 1, Y REGISTERED *** W1 stays blocked after a SECOND reboot",
      !!w1EntryAfterReboot2 && (w1EntryAfterReboot2.armedKeys ?? []).includes(k1));
  } else if (scenarioName === "raise-y-after-boot0") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // RAISE-Y-AFTER-BOOT0 — the TWO-TMPS collision fixture (see below), boot-0, then a genuine RUNTIME
    // raise on Y (`enterMergeQuarantine`, the SAME call a real unconfirmed-kill path uses) — proves the
    // KEPT key (K1) survives a raise + reboot too, not just a plain reboot. `pendingUnresolvedQuarantines`
    // stays empty throughout this scenario (no divert exists any more — see the file header), so
    // `enterMergeQuarantine`'s own cross-tier-sibling-absorb path (which this card does NOT touch; see
    // `consumeMatchedPendingsIntoArmedEntry`, carded separately as card 43cf3b26's own scope) is never
    // even reached here — this scenario is about the SIMPLE existing-branch raise, not that mechanism.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { y, kyHash, w1, k1, w2, k2 } = buildYAndWitnesses("raise-y-after-boot0", { twoWitnesses: true });
    writeLatchTmp(kyHash, "111111", {
      repoPath: y, branch: "y-branch", reason: "Y dual-armed via a legacy stale resolvedKey=K1 (tmp #1, older/kept)",
      enteredAt: Date.now() - 1000, tokens: ["a1"], resolvedKey: k1,
    });
    writeLatchTmp(kyHash, "222222", {
      repoPath: y, branch: "y-branch", reason: "Y dual-armed via a legacy stale resolvedKey=K2 (tmp #2, newer/dropped)",
      enteredAt: Date.now(), tokens: ["a2"], resolvedKey: k2,
    });

    reenterMergeQuarantinesAtBoot([]); // boot-0, deliberately unregistered
    check("(precondition) boot-0 keeps K1 (the older side) blocked for W1", (() => {
      const w1Entry = activeMergeQuarantineFor(w1);
      return !!w1Entry && (w1Entry.armedKeys ?? []).includes(k1);
    })());

    enterMergeQuarantine(y, "y-branch-2", "a genuine runtime raise on Y after boot-0");
    const w1AfterRaise = activeMergeQuarantineFor(w1);
    check("(precondition) W1 (K1) is still blocked immediately after the runtime raise",
      !!w1AfterRaise && (w1AfterRaise.armedKeys ?? []).includes(k1));

    const fresh = await rebootSim();
    fresh.reenterMergeQuarantinesAtBoot([]);
    const w1EntryAfterReboot = fresh.activeMergeQuarantineFor(w1);
    check("*** CARD 1e739f4a (Fix 1) *** W1 (K1) stays blocked after a reboot that followed a runtime raise",
      !!w1EntryAfterReboot && (w1EntryAfterReboot.armedKeys ?? []).includes(k1));
  } else if (scenarioName === "two-tmps") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // TWO-TMPS — FIXED by card 43cf3b26's own persisted, plural `resolvedKeys` (generalizing THIS card's
    // own single-scalar `resolvedKey` mechanism) — see docs/decisions/8db913e2-*.md's "Follow-up
    // 43cf3b26" section. Two sibling tmps for the SAME key, each carrying its OWN, DIFFERENT, genuinely
    // informative resolvedKey (K1 older, K2 newer). The scalar `resolvedKey` field still only ever keeps
    // ONE (K1, for backward compat with an old reader) — but BOTH now survive via `resolvedKeys`, so BOTH
    // W1 (K1) and W2 (K2) stay blocked across TWO reboots. The former ACCEPTED RESIDUAL ("W2 unblocked
    // after a reboot") is RETIRED by this card; boot-0's own collision report moved from `console.error`
    // (an unrecoverable-loss signal) to `console.log` (informational — nothing is lost any more).
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { y, kyHash, w1, k1, w2, k2 } = buildYAndWitnesses("two-tmps", { twoWitnesses: true });
    writeLatchTmp(kyHash, "111111", {
      repoPath: y, branch: "y-branch", reason: "Y dual-armed via a legacy stale resolvedKey=K1 (tmp #1, older/kept)",
      enteredAt: Date.now() - 1000, tokens: ["a1"], resolvedKey: k1,
    });
    writeLatchTmp(kyHash, "222222", {
      repoPath: y, branch: "y-branch", reason: "Y dual-armed via a legacy stale resolvedKey=K2 (tmp #2, newer/dropped)",
      enteredAt: Date.now(), tokens: ["a2"], resolvedKey: k2,
    });

    const consoleLines = await captureConsole(() => { reenterMergeQuarantinesAtBoot([]); }); // boot-0, deliberately unregistered
    check("(precondition) boot-0 keeps K1 (the kept side) armed in memory", (() => {
      const yEntry = listActiveMergeQuarantines().find((e) => (e.armedKeys ?? []).includes(k1));
      return !!yEntry;
    })());
    check("*** CARD 43cf3b26 *** boot-0 reports the collision at INFO level, naming K2 and the card (no longer a loss)",
      consoleLines.some((l) => l.includes(k2) && l.includes("43cf3b26")));

    const filesAfterBoot0 = fs.readdirSync(MERGE_QUARANTINE_DIR).sort();

    const fresh = await rebootSim();
    fresh.reenterMergeQuarantinesAtBoot([]);
    const w1EntryAfterReboot = fresh.activeMergeQuarantineFor(w1);
    const w2EntryAfterReboot = fresh.activeMergeQuarantineFor(w2);
    check("*** FIX 1 (1e739f4a) *** W1 (K1, the legacy-kept key) stays blocked after a reboot",
      !!w1EntryAfterReboot && (w1EntryAfterReboot.armedKeys ?? []).includes(k1));
    check("*** CARD 43cf3b26 *** W2 (K2) ALSO stays blocked after a reboot — the former residual is FIXED",
      !!w2EntryAfterReboot && (w2EntryAfterReboot.armedKeys ?? []).includes(k2));
    const filesAfterBoot1 = fs.readdirSync(MERGE_QUARANTINE_DIR).sort();
    check("(sanity) no new/duplicated latch files appeared after boot 1 (file set unchanged)",
      filesAfterBoot1.length === filesAfterBoot0.length && filesAfterBoot1.every((f, i) => f === filesAfterBoot0[i]));

    // A SECOND reboot — BOTH must STILL be blocked (the fix is durable and idempotent, not a one-boot
    // fluke), and the on-disk file set must not grow across repeated boots.
    const fresh2 = await rebootSim();
    fresh2.reenterMergeQuarantinesAtBoot([]);
    const w1EntryAfterReboot2 = fresh2.activeMergeQuarantineFor(w1);
    const w2EntryAfterReboot2 = fresh2.activeMergeQuarantineFor(w2);
    check("*** FIX 1 (1e739f4a) *** W1 (K1) stays blocked after a SECOND reboot",
      !!w1EntryAfterReboot2 && (w1EntryAfterReboot2.armedKeys ?? []).includes(k1));
    check("*** CARD 43cf3b26 *** W2 (K2) ALSO stays blocked after a SECOND reboot (idempotent)",
      !!w2EntryAfterReboot2 && (w2EntryAfterReboot2.armedKeys ?? []).includes(k2));
    const filesAfterBoot2 = fs.readdirSync(MERGE_QUARANTINE_DIR).sort();
    check("(sanity) no new/duplicated latch files appeared after a SECOND reboot either",
      filesAfterBoot2.length === filesAfterBoot1.length && filesAfterBoot2.every((f, i) => f === filesAfterBoot1[i]));
  } else if (scenarioName === "json-plus-tmp") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // JSON-PLUS-TMP — Y's own dual-arm is ALREADY correctly recorded in a clean `.json` final (RK=K1,
    // never touched by any migrate/promote write this boot). An UNRELATED, harmless stale tmp sharing
    // Ky's own hash (no resolvedKey of its own — pure leftover residue, NOT a two-informative-keys
    // collision) is also present. Because the fixture stays UNREGISTERED, PASS 1b's own
    // early-delete-as-stale-residue shortcut never fires (it requires a REGISTERED matchedRepo), so this
    // harmless tmp is still fully parsed, armed, and promoted — FIXED: the promote site no longer
    // destroys K1 even though nothing about the real final needed to change at all.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { y, kyHash, w1, k1 } = buildYAndWitnesses("json-plus-tmp");
    // The REAL final must be OLDER than the harmless tmp — `unionQuarantineEntries`'s own legacy
    // `{...older}` rule keeps the OLDER side's `resolvedKey`, and this scenario is about the real
    // final's own already-informative K1 surviving THAT union, not about which side happens to win it.
    writeLatchJson(kyHash, {
      repoPath: y, branch: "y-branch", reason: "Y dual-armed via a legacy stale resolvedKey=K1 (the real, already-correct final)",
      enteredAt: Date.now() - 120_000, tokens: ["a1"], resolvedKey: k1,
    });
    writeLatchTmp(kyHash, "333333", {
      repoPath: y, branch: "y-branch-STALE", reason: "harmless leftover residue, no resolvedKey of its own",
      enteredAt: Date.now() - 60_000, tokens: ["stale-token"],
    });

    reenterMergeQuarantinesAtBoot([]); // boot-0, deliberately unregistered
    check("(precondition) boot-0 dual-arms Y at both Ky and K1 in memory — the bug is not here", (() => {
      const yEntry = listActiveMergeQuarantines().find((e) => (e.armedKeys ?? []).includes(k1));
      return !!yEntry;
    })());

    const fresh = await rebootSim();
    fresh.reenterMergeQuarantinesAtBoot([]);
    const w1EntryAfterReboot = fresh.activeMergeQuarantineFor(w1);
    check("*** CARD 1e739f4a (Fix 1) *** W1 stays blocked after a reboot, even though the real final was NEVER wrong — promotion of an unrelated, harmless tmp must never destroy it",
      !!w1EntryAfterReboot && (w1EntryAfterReboot.armedKeys ?? []).includes(k1));
  } else if (scenarioName === "json-plus-tmp-subpath") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // JSON-PLUS-TMP-SUBPATH — same shape as JSON-PLUS-TMP, except the accompanying tmp's own CONTENT
    // names Y's own SUBDIRECTORY (`repoPath: y/sub`) rather than Y itself — `canonicalRepoLockKey` walks
    // it up to the SAME Ky, so it reaches PASS 1b's own tmpsToUnlinkByKey[ky] bucket exactly like the
    // plain case above, mirroring 48bda567's own "the tmp is Y/sub" fixture shape for the migrate union.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { y, kyHash, w1, k1 } = buildYAndWitnesses("json-plus-tmp-subpath");
    // Same ordering note as JSON-PLUS-TMP above — the real final must be OLDER than the accompanying
    // subpath tmp so the legacy union's own `{...older}` rule keeps K1.
    writeLatchJson(kyHash, {
      repoPath: y, branch: "y-branch", reason: "Y dual-armed via a legacy stale resolvedKey=K1 (the real, already-correct final)",
      enteredAt: Date.now() - 120_000, tokens: ["a1"], resolvedKey: k1,
    });
    const ySub = path.join(y, "sub");
    fs.mkdirSync(ySub, { recursive: true });
    if (canonicalRepoLockKey(ySub) !== canonicalRepoLockKey(y)) {
      throw new Error("json-plus-tmp-subpath: y's own subdirectory did not resolve to y's own key — fixture assumption broken");
    }
    const koldHash = hashForKey(`stale-pre-migration-key-${freshSfx()}`);
    writeLatchTmp(koldHash, "444444", {
      repoPath: ySub, branch: "b-branch-STALE", reason: "a pre-rename latch for y's own subdirectory, filed under a stale key",
      enteredAt: Date.now() - 60_000, tokens: ["stale-sub-token"],
    });

    reenterMergeQuarantinesAtBoot([]); // boot-0, deliberately unregistered
    check("(precondition) boot-0 dual-arms Y at both Ky and K1 in memory — the bug is not here", (() => {
      const yEntry = listActiveMergeQuarantines().find((e) => (e.armedKeys ?? []).includes(k1));
      return !!yEntry;
    })());

    const fresh = await rebootSim();
    fresh.reenterMergeQuarantinesAtBoot([]);
    const w1EntryAfterReboot = fresh.activeMergeQuarantineFor(w1);
    check("*** CARD 1e739f4a (Fix 1) *** W1 stays blocked after a reboot, even though the real final was NEVER wrong",
      !!w1EntryAfterReboot && (w1EntryAfterReboot.armedKeys ?? []).includes(k1));
  } else if (scenarioName === "identity-invariant-two-secondaries") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // IDENTITY-INVARIANT-TWO-SECONDARIES — card 43cf3b26, round 3 (Code Review 4c59172f, MAJOR,
    // two-path asymmetry). Y is MOUNTED (a real, resolvable repo) throughout, so this exercises PASS 1b's
    // own RESOLVABLE secondary-arm loop, never the degraded branch (which already threaded correctly). A
    // SINGLE tmp residue carries TWO secondary keys (K1, K2) at once — the shape that actually trips the
    // bug: with only one secondary, a stale (never-reassigned) accumulator is invisible, since nothing
    // ever reads it again. FIXED: the loop now threads its own accumulator forward exactly like PASS 1's
    // own primary-arm loop, so Y/K1/K2 all end up pointing at ONE shared object — never three keys
    // split across two distinct, silently-diverging objects for the same identity.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { y, kyHash, w1, k1, w2, k2 } = buildYAndWitnesses("identity-invariant-two-secondaries", { twoWitnesses: true });
    writeLatchTmp(kyHash, "111111", {
      repoPath: y, branch: "y-branch", reason: "Y dual-armed via TWO secondary keys K1,K2 in one PASS 1b tmp",
      enteredAt: Date.now(), tokens: ["a1"], resolvedKey: k1, resolvedKeys: [k1, k2],
    });

    reenterMergeQuarantinesAtBoot([]); // boot-0, deliberately unregistered — Y is resolvable throughout
    check("*** CARD 43cf3b26 (round 3) *** the identity invariant holds right after boot-0 — Y/K1/K2 share ONE object",
      assertQuarantineIdentityInvariantTestOnly().ok);
    check("(precondition) W1 (K1) is blocked", !!activeMergeQuarantineFor(w1));
    check("(precondition) W2 (K2) is blocked", !!activeMergeQuarantineFor(w2));

    clearMergeQuarantine(y);
    check("*** CARD 43cf3b26 (round 3) *** assertRepoNotQuarantined(w1) succeeds — before the fix, K1 (armed FIRST) was ORPHANED at a stale object: the LATER K2 arm call re-points the anchor Ky's own slot (plus K2) onto a fresh object, leaving K1 behind pointing at the pre-loop one the clear via Ky never reaches",
      assertRepoNotQuarantined(w1).ok === true);
    check("*** CARD 43cf3b26 (round 3) *** assertRepoNotQuarantined(w2) succeeds — K2 (armed LAST) always shared the anchor's own final object even pre-fix in this exact two-iteration case, so this is the non-discriminating sibling of the W1 check above",
      assertRepoNotQuarantined(w2).ok === true);
    check("(sanity) Y itself is unblocked too", !activeMergeQuarantineFor(y));
  } else if (scenarioName === "identity-invariant-two-secondaries-remount") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // IDENTITY-INVARIANT-TWO-SECONDARIES-REMOUNT — the SAME shape, but Y is UNRESOLVABLE at boot-0 (the
    // tmp is processed via the degraded branch instead, diverting to pending — unaffected by this round's
    // fix) and only becomes resolvable on a LATER boot, exercising the FIXED resolvable loop on a SECOND
    // pass over the SAME on-disk tmp file (never deleted/promoted while degraded).
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const tag = "identity-invariant-two-secondaries-remount";
    const y = path.join(os.tmpdir(), `loom-mqtpda-y-${tag}-never-yet-${freshSfx()}`); // NOT created yet
    const ky = canonicalRepoLockKey(y);
    const kyHash = hashForKey(ky);
    const w1 = path.join(os.tmpdir(), `loom-mqtpda-w1-${tag}-never-exists-${freshSfx()}`);
    const k1 = canonicalRepoLockKey(w1);
    if (hashForKey(k1) === kyHash) throw new Error(`${tag}: k1 collided with ky — re-run`);
    let w2, k2;
    for (let attempt = 0; ; attempt++) {
      w2 = path.join(os.tmpdir(), `loom-mqtpda-w2-${tag}-never-exists-${freshSfx()}`);
      k2 = canonicalRepoLockKey(w2);
      if (hashForKey(k2) !== kyHash && k2 !== k1) break;
      if (attempt > 200_000) throw new Error(`${tag}: could not mint distinct keys after 200,000 attempts`);
    }
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    writeLatchTmp(kyHash, "222222", {
      repoPath: y, branch: "y-branch", reason: "Y (not yet mounted) dual-armed via TWO secondary keys K1,K2",
      enteredAt: Date.now(), tokens: ["a1"], resolvedKey: k1, resolvedKeys: [k1, k2],
    });

    reenterMergeQuarantinesAtBoot([]); // boot-0 — Y does NOT exist yet; the degraded branch (already
    // correct, unaffected by this round's fix) still arms each secondary key directly and diverts only
    // Y's OWN degraded, walked-up signal to pending.
    check("(precondition) boot-0 still arms W1 (K1) via the (already-correct) degraded branch",
      !!activeMergeQuarantineFor(w1));
    check("(precondition) boot-0 still arms W2 (K2) too", !!activeMergeQuarantineFor(w2));

    // Remount: Y now exists as a real repo — canonicalRepoLockKey(y) must still equal `ky` (it does, since
    // it's computed purely from the path string's own toplevel walk, unaffected by mkdir/git init order).
    fs.mkdirSync(y, { recursive: true });
    tmpDirs.push(y);
    fs.writeFileSync(path.join(y, "README.md"), `# ${tag}\n`);
    execSync(`git init -q && git config user.email mqtpda@loom && git config user.name mqtpda`, { cwd: y });
    commitAll(y, "init", GIT_ID);
    if (canonicalRepoLockKey(y) !== ky) throw new Error(`${tag}: Y's own key drifted after mkdir+git init — fixture assumption broken`);

    const fresh = await rebootSim();
    fresh.reenterMergeQuarantinesAtBoot([]); // boot-1 — Y is NOW resolvable; the SAME tmp re-processes via the FIXED loop
    check("*** CARD 43cf3b26 (round 3) *** the identity invariant holds after the remount boot",
      fresh.assertQuarantineIdentityInvariantTestOnly().ok);
    check("(precondition) W1 (K1) is blocked after remount", !!fresh.activeMergeQuarantineFor(w1));
    check("(precondition) W2 (K2) is blocked after remount", !!fresh.activeMergeQuarantineFor(w2));

    fresh.clearMergeQuarantine(y);
    check("*** CARD 43cf3b26 (round 3) *** assertRepoNotQuarantined(w1) succeeds after remount — K1 (armed FIRST) was the one left ORPHANED pre-fix, at a stale object the LATER K2 arm's re-point of the anchor Ky never reaches",
      fresh.assertRepoNotQuarantined(w1).ok === true);
    check("*** CARD 43cf3b26 (round 3) *** assertRepoNotQuarantined(w2) succeeds after remount — K2 (armed LAST) always shared the anchor's own final object, non-discriminating sibling of the W1 check above",
      fresh.assertRepoNotQuarantined(w2).ok === true);
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
