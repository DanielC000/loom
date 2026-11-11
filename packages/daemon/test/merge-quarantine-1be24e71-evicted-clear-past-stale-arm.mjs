import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 1be24e71 — an EVICTED quarantine entry D (diverted to pending because winner Z holds a stale secondary
// arm at D's own key K2) must clear past that stale arm, durably, while Z stays quarantined; and the token
// route must say so honestly instead of returning void.
//
// Fixture = the d163aef5 round-4 P1 shape (merge-quarantine-pass1-degraded-union-guard.mjs, scenario
// round4-p1-...): D never exists, its own file sits at hash(K2) with resolvedKey K2; Z is a real repo at K1 whose
// file carries a STALE secondary resolvedKey K2. D sorts before Z, so boot evicts D to pending and arms Z at [K1,K2].
//
// WHAT LIFTS D (measured with negative-control --mutant, see docs/decisions/1be24e71-*.md): TWO independent
// mechanisms, each sufficient. (A) `physicalOwnerRepoPaths` withholds Z's claim when the file's confirmed occupant is
// a different, unresolvable D (838520c4); (B) 05a3b6ad's `activeOwnerClaimIsSettledByCoverage` settles it by proven
// content coverage. Disabling only (B) leaves every scenario GREEN, disabling only (A) too; disabling BOTH turns the
// `lift-*` scenarios RED (9 failing assertions). The result checks are RED on the pre-1be24e71 void-returning token route.
//
// Not covered: `clearMergeQuarantineByToken`'s pre-clear refusal result (`refusedBeforeClear`), which needs a
// foreign-key stamp write failure; the by-id route's refusal text is pinned only by outcome (nothing cleared).
//
// Each scenario runs in its own child process with its own fresh LOOM_HOME. Run: node test/merge-quarantine-1be24e71-evicted-clear-past-stale-arm.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCENARIOS = [
  "lift-token", "lift-path", "lift-reporting", "by-id-offer-and-outcome",
  "control-uncovered-token", "control-clear-winner-keeps-loser", "no-op-token", "durable-false-write-failure",
];
const scenarioArg = process.argv.find((a) => a.startsWith("--scenario="));

if (!scenarioArg) {
  const { LOOM_HOME: _inherited, ...envWithoutLoomHome } = process.env;
  let failed = 0;
  for (const name of SCENARIOS) {
    console.log(`\n=== SCENARIO ${name} ===`);
    try {
      execFileSync(process.execPath, [__filename, `--scenario=${name}`], { env: envWithoutLoomHome, stdio: "inherit" });
      console.log(`--- ${name}: PASS ---`);
    } catch { console.log(`--- ${name}: FAIL ---`); failed++; }
  }
  console.log(failed === 0 ? "\nALL SCENARIOS PASS" : `\n${failed} SCENARIO(S) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

const scenarioName = scenarioArg.slice("--scenario=".length);
useOwnLoomHome(`loom-mq1be-${scenarioName}-`);
requireHermeticEnv();

const distGitDir = path.join(__dirname, "..", "dist", "git");
const href = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const mq = await import(href);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const h24 = (k) => createHash("sha256").update(k).digest("hex").slice(0, 24);
const tmpDirs = [];
let reboots = 0;
const freshBoot = async () => import(`${href}?b=${++reboots}`);

/** Build the round-4 P1 fixture and boot it. `dTokens` are the tokens D's own file carries. */
function buildFixture(dTokens = ["d-token"]) {
  const z = path.join(os.tmpdir(), `mq1be-z-${sfx()}`);
  fs.mkdirSync(z, { recursive: true });
  tmpDirs.push(z);
  fs.writeFileSync(path.join(z, "README.md"), "# 1be24e71\n");
  execSync(`git init -q && git config user.email mq1be@loom && git config user.name mq1be && git add -A && git -c core.autocrlf=false commit -q -m init`, { cwd: z, stdio: "pipe" });
  const K1h = h24(canonicalRepoLockKey(z));
  let d, K2, K2h;
  for (let attempt = 0; ; attempt++) {
    d = path.join(os.tmpdir(), `mq1be-d-never-exists-${sfx()}`);
    K2 = canonicalRepoLockKey(d);
    K2h = h24(K2);
    if (K2h < K1h) break; // D must be read (and armed) before Z, so Z's stale secondary arm EVICTS it
    if (attempt > 200_000) throw new Error("could not force D before Z");
  }
  fs.mkdirSync(mq.MERGE_QUARANTINE_DIR, { recursive: true });
  const dFile = path.join(mq.MERGE_QUARANTINE_DIR, `${K2h}.json`);
  fs.writeFileSync(dFile, JSON.stringify({ repoPath: d, branch: "d-branch", reason: "D's own raise", enteredAt: Date.now() - 10_000, tokens: dTokens, resolvedKey: K2 }, null, 2) + "\n");
  const zFile = path.join(mq.MERGE_QUARANTINE_DIR, `${K1h}.json`);
  fs.writeFileSync(zFile, JSON.stringify({ repoPath: z, branch: "z-branch", reason: "Z's own raise", enteredAt: Date.now(), tokens: ["z-token"], resolvedKey: K2 }, null, 2) + "\n");
  mq.reenterMergeQuarantinesAtBoot([z, d]);
  return { z, d, K2h, dFile, zFile };
}

const tokensOf = (m, z, d) => { m.reenterMergeQuarantinesAtBoot([z, d]); return new Set(m.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])); };

try {
  const f = buildFixture(scenarioName === "control-uncovered-token" || scenarioName === "durable-false-write-failure" ? ["d-token", "d2-token"] : ["d-token"]);
  const { z, d, K2h, dFile } = f;
  check("(sanity) D reads quarantined after boot", !!mq.activeMergeQuarantineFor(d));
  check("(sanity) Z reads quarantined after boot", !!mq.activeMergeQuarantineFor(z));
  check("(sanity) D's own file is at hash(K2) before the clear", fs.existsSync(dFile));

  if (scenarioName === "lift-token") {
    const res = mq.clearMergeQuarantineByToken(d, "d-token");
    check("*** result: token route returns an object, never void ***", !!res && typeof res === "object");
    check("result: lifted is true (no entry holds d-token any more)", res?.lifted === true && res?.matched === true);
    check("result: a durable lift carries no durable:false", res?.durable === undefined);
    check("*** result: names Z's stale arm as what STILL blocks D ***", res?.stillBlockedBy?.repoPath === z);
    check("result: stillBlockedBy carries a non-empty reason", typeof res?.stillBlockedBy?.reason === "string" && res.stillBlockedBy.reason.length > 0);
    check("*** D's own file is unlinked ***", !fs.existsSync(dFile));
    const fresh = await freshBoot();
    const toks = tokensOf(fresh, z, d);
    check("*** D's token is gone after a reboot ***", !toks.has("d-token"));
    check("*** Z stays quarantined after a reboot ***", toks.has("z-token"));
  } else if (scenarioName === "lift-path" || scenarioName === "lift-reporting") {
    const res = scenarioName === "lift-path" ? mq.clearMergeQuarantineByRecordedPath(d) : mq.clearMergeQuarantineReporting(d);
    check("D's own file is unlinked", !fs.existsSync(dFile));
    // clearMergeQuarantineReporting never carries `stillQuarantined` (3be11be4: its refusal rides in `reason` alone).
    check("the reply discloses D is still blocked: " + (scenarioName === "lift-path" ? "stillQuarantined AND " : "") + "a reason naming Z",
      (scenarioName === "lift-reporting" || res.stillQuarantined === true) && typeof res.reason === "string" && res.reason.includes(z));
    check("the reply does not name D as lifted while still blocked", !(res.liftedRepoPaths ?? []).includes(d));
    const fresh = await freshBoot();
    const toks = tokensOf(fresh, z, d);
    check("*** D's token is gone after a reboot ***", !toks.has("d-token"));
    check("*** Z stays quarantined after a reboot ***", toks.has("z-token"));
  } else if (scenarioName === "by-id-offer-and-outcome") {
    const dEntry = mq.activeMergeQuarantineFor(d);
    const offered = mq.quarantineLatchFileIdsFor(dEntry);
    check("(raw helper) quarantineLatchFileIdsFor(D) names hash(K2): a listing id, not a followable route", offered[0] === K2h);
    const blocked = mq.assertRepoNotQuarantined(d);
    check("assertRepoNotQuarantined(d) is blocked", blocked.ok === false);
    check("*** its clear remedy names the repoPath route, not the dead bare id ***", /clear-by-path with \{"repoPath"/.test(blocked.reason ?? "") && !/\{"id"/.test(blocked.reason ?? ""));
    const res = mq.clearMergeQuarantineLatchFile(K2h);
    check("*** the by-id clear refuses the ambiguous id ***", res.ok === false && /matches BOTH/.test(res.reason ?? ""));
    check("nothing was cleared by the refused id", fs.existsSync(dFile));
    const fresh = await freshBoot();
    const toks = tokensOf(fresh, z, d);
    check("both tokens survive a reboot after the refusal", toks.has("d-token") && toks.has("z-token"));
  } else if (scenarioName === "control-uncovered-token") {
    // D's file holds TWO tokens; clearing one is NOT full coverage, so the file must be KEPT for the other.
    const res = mq.clearMergeQuarantineByToken(d, "d-token");
    check("result: d-token is lifted", res?.lifted === true);
    check("*** result: still blocked by D's own surviving d2-token record ***", res?.stillBlockedBy?.repoPath === d);
    check("*** the uncovered file is KEPT (it still backs d2-token) ***", fs.existsSync(dFile));
    const fresh = await freshBoot();
    const toks = tokensOf(fresh, z, d);
    check("*** d2-token survives a reboot ***", toks.has("d2-token"));
    check("d-token is gone after a reboot", !toks.has("d-token"));
    check("Z stays quarantined", toks.has("z-token"));
  } else if (scenarioName === "control-clear-winner-keeps-loser") {
    // Clearing the WINNER Z (the d163aef5 round-4 P1 direction) must keep D's file, and Z is no longer blocked.
    const res = mq.clearMergeQuarantineByToken(z, "z-token");
    check("result: z-token is lifted", res?.lifted === true);
    check("result: a clean clear reports NO stillBlockedBy", res?.stillBlockedBy === undefined);
    // (D's backing may be relocated rather than left at hash(K2); durability is asserted by the reboot below.)
    const fresh = await freshBoot();
    const toks = tokensOf(fresh, z, d);
    check("D's token survives a reboot", toks.has("d-token"));
    check("Z's token is gone", !toks.has("z-token"));
  } else if (scenarioName === "no-op-token") {
    // A token no entry holds: nothing to clear, and the result must NOT read like a lift.
    const res = mq.clearMergeQuarantineByToken(d, "no-such-token-ever-issued");
    check("*** a no-op reports matched:false, lifted:false ***", res?.matched === false && res?.lifted === false);
    check("a no-op on a still-blocked repo still discloses the blocker (D's own record)", res?.stillBlockedBy?.repoPath === d);
    check("nothing was cleared: D's file is intact", fs.existsSync(dFile));
    const real = mq.clearMergeQuarantineByToken(d, "d-token");
    check("the same call with a REAL token reports matched:true, lifted:true", real?.matched === true && real?.lifted === true);
  } else if (scenarioName === "durable-false-write-failure") {
    // D's file holds two tokens, so clearing one REWRITES it. Fail that durable write: the token leaves memory
    // (lifted:true) but a reboot may re-arm it, so the result must say durable:false.
    const realOpen = fs.openSync;
    let fired = 0;
    fs.openSync = (p, ...rest) => {
      if (typeof p === "string" && p.startsWith(dFile.slice(0, -".json".length))) { fired++; throw Object.assign(new Error("ENOSPC: simulated disk-full"), { code: "ENOSPC" }); }
      return realOpen(p, ...rest);
    };
    let res;
    try { res = mq.clearMergeQuarantineByToken(d, "d-token"); } finally { fs.openSync = realOpen; }
    check("(precondition) the injected write failure fired", fired > 0);
    check("*** the result says lifted:true but durable:false ***", res?.lifted === true && res?.durable === false);
    const fresh = await freshBoot();
    const toks = tokensOf(fresh, z, d);
    check("*** (why it matters) the un-persisted token is re-armed by a reboot ***", toks.has("d-token"));
  }
} finally {
  for (const t of tmpDirs) { try { fs.rmSync(t, { recursive: true, force: true }); } catch { /* best effort */ } }
}
console.log(failures === 0 ? `PASS: ${scenarioName}` : `FAIL: ${scenarioName} (${failures} failed)`);
process.exit(failures === 0 ? 0 : 1);
