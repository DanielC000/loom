import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 103405e0 — two wholly-UNRESOLVABLE identities, each backed by a `.json` final, union at boot under a
// shared key. clear(winner) lifts the WHOLE union (the loser's token and file included). That lift is
// pre-existing and deliberately NOT refused (a stamp on an unresolvable winner would break the d2582692 L1/L2
// keep-loser-pending pin); this card only DISCLOSES it: the loser is named in `liftedRepoPaths`/`releasedRepoPaths`
// once its files are really gone. A loser that survives (kept/protected as pending) is never named.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-103405e0-two-ghost-union-lift-disclosed.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCENARIOS = [
  "json-json-x-older-clear-winner-names-loser",
  "json-json-y-older-clear-winner-names-loser",
  "json-json-route-by-id",
  "json-json-route-by-recorded-path",
  "json-json-route-by-key",
  "unlink-fail-by-path-x-older",
  "unlink-fail-by-path-y-older",
  "unlink-fail-by-id-x-older",
  "unlink-fail-by-id-y-older",
  "json-json-clear-loser-still-not-found",
  "single-ghost-no-loser-names-only-winner",
  "mixed-json-winner-tmp-loser",
  "mixed-tmp-winner-json-loser",
  "d2582692-tmp-tmp-control-survivor-not-named",
  "resolvable-winner-398f476c-control-refusal-unchanged",
];

const scenarioArg = process.argv.find((a) => a.startsWith("--scenario="));

if (!scenarioArg) {
  const { LOOM_HOME: _inherited, ...envWithoutLoomHome } = process.env;
  let failedScenarios = 0;
  for (const name of SCENARIOS) {
    console.log(`\n=== SCENARIO ${name} (own process, own LOOM_HOME) ===`);
    try {
      execFileSync(process.execPath, [__filename, `--scenario=${name}`], { env: envWithoutLoomHome, stdio: "inherit" });
      console.log(`--- ${name}: PASS ---`);
    } catch {
      console.log(`--- ${name}: FAIL ---`);
      failedScenarios++;
    }
  }
  console.log(failedScenarios === 0
    ? "\nALL SCENARIOS PASS — a two-ghost boot union's winner clear discloses the loser it lifts."
    : `\n${failedScenarios} SCENARIO(S) FAILED — reproduces board card 103405e0.`);
  process.exit(failedScenarios === 0 ? 0 : 1);
}

const scenarioName = scenarioArg.slice("--scenario=".length);
useOwnLoomHome(`loom-mq103-${SCENARIOS.indexOf(scenarioName)}-`);
requireHermeticEnv();

const distGitDir = path.join(__dirname, "..", "dist", "git");
const mqHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
let M = await import(mqHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mq103@loom -c user.name=mq103";
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const hashForKey = (key) => createHash("sha256").update(key).digest("hex").slice(0, 24);
let bootN = 0;
async function reboot(regs) {
  bootN++;
  M = await import(`${mqHref}?b=${bootN}`);
  M.reenterMergeQuarantinesAtBoot(regs);
}
const writeJson = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2) + "\n");
const lsDir = () => fs.readdirSync(M.MERGE_QUARANTINE_DIR);
const allTokens = () => new Set(M.listActiveMergeQuarantines().flatMap((e) => e.tokens ?? []));
const sameSet = (a, b) => a.length === b.length && b.every((x) => a.includes(x));

function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mq103-repo-${tag}-${freshSfx()}`);
  const teamA = path.join(repo, "teamA");
  fs.mkdirSync(teamA, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), `# ${tag}\n`);
  execSync(`git init -q && git config user.email mq103@loom && git config user.name mq103`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  fs.mkdirSync(M.MERGE_QUARANTINE_DIR, { recursive: true });
  return { repo, teamA, kp: canonicalRepoLockKey(repo) };
}
const ghost = (n) => path.join(os.tmpdir(), `loom-mq103-${n}-ghost-${freshSfx()}`); // NEVER created
const rec = (repoPath, token, ageMs, kp) => ({ repoPath, branch: `${token}-b`, reason: `${token}-r`, enteredAt: Date.now() - ageMs, tokens: [token], resolvedKey: kp });

try {
  if (scenarioName === "json-json-x-older-clear-winner-names-loser" || scenarioName === "json-json-y-older-clear-winner-names-loser") {
    // X's final sits at sha(Kp).json; Y's at a stale name; both unresolvable with resolvedKey Kp. Both age orders.
    const xOlder = scenarioName.startsWith("json-json-x-older");
    const { repo, kp } = makeRepo(scenarioName);
    const x = ghost("x"), y = ghost("y");
    const regs = [repo, x, y];
    const xFile = path.join(M.MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`);
    const yFile = path.join(M.MERGE_QUARANTINE_DIR, `!stale-y-103-${freshSfx()}.json`);
    writeJson(xFile, rec(x, "token-x-103", xOlder ? 120_000 : 60_000, kp));
    writeJson(yFile, rec(y, "token-y-103", xOlder ? 60_000 : 120_000, kp));
    M.reenterMergeQuarantinesAtBoot(regs);
    const u = M.listActiveMergeQuarantines().find((e) => e.repoPath === x || e.repoPath === y);
    check("(precondition) one union carries both tokens", !!u && u.tokens.includes("token-x-103") && u.tokens.includes("token-y-103"));
    check("(precondition) the union has no contributors (no stamp: that is the d2582692-pin-safe baseline)", (u?.contributorRepoPaths ?? []).length === 0);
    const winner = u.repoPath, loser = winner === x ? y : x;
    console.log(`INFO  union: orphanLatchFiles=${JSON.stringify(u.orphanLatchFiles)} armedKeys=${JSON.stringify(u.armedKeys)} files=${JSON.stringify(lsDir())}`);
    check(`(precondition) the older record wins (${xOlder ? "X" : "Y"})`, winner === (xOlder ? x : y));
    check("(precondition) the loser has no queryable record of its own", M.activeMergeQuarantineFor(loser) === undefined);
    const r = M.clearMergeQuarantineReporting(winner);
    check("*** THE FIX *** liftedRepoPaths NAMES the loser it lifted", r.liftedRepoPaths.includes(loser));
    check("liftedRepoPaths still names the winner, and nothing else", sameSet(r.liftedRepoPaths, [winner, loser]));
    check("releasedRepoPaths carries the same set", sameSet(r.releasedRepoPaths, [winner, loser]));
    check("(unchanged) not refused, nothing still blocked", r.stillQuarantined !== true && r.refusedBeforeClear !== true && r.releasedStillBlockedRepoPaths.length === 0);
    check("(unchanged) the whole union is gone: repo unblocked, both tokens gone, directory empty", M.assertRepoNotQuarantined(repo).ok === true && allTokens().size === 0 && lsDir().length === 0);
    await reboot(regs);
    check("(unchanged, reboot) stays clear: no loser resurrected", M.assertRepoNotQuarantined(repo).ok === true && allTokens().size === 0 && M.assertRepoNotQuarantined(loser).ok === true);
  } else if (scenarioName.startsWith("unlink-fail-")) {
    // The "every file gone" guard: the clear's unlink of the LOSER's file fails (EPERM, the 59f4ebe8 pattern), so the
    // file survives. The loser must NOT be named as lifted, the result must say latchKept, and a reboot must re-arm
    // the loser from the surviving file. Both routes, both age orders.
    // Scenario names: unlink-fail-<by-path|by-id>-<x|y>-older — read by the two predicates below, never positionally.
    const byId = scenarioName.includes("-by-id-");
    const xOlder = scenarioName.endsWith("x-older");
    const { repo, kp } = makeRepo(scenarioName);
    const x = ghost("x"), y = ghost("y");
    const regs = [repo, x, y];
    const xFile = path.join(M.MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`);
    const yFile = path.join(M.MERGE_QUARANTINE_DIR, `!stale-y-103-${freshSfx()}.json`);
    writeJson(xFile, rec(x, "token-x-103", xOlder ? 120_000 : 60_000, kp));
    writeJson(yFile, rec(y, "token-y-103", xOlder ? 60_000 : 120_000, kp));
    M.reenterMergeQuarantinesAtBoot(regs);
    const u = M.listActiveMergeQuarantines().find((e) => e.repoPath === x || e.repoPath === y);
    const winner = u.repoPath, loser = winner === x ? y : x;
    const loserFile = loser === x ? xFile : yFile;
    const loserToken = loser === x ? "token-x-103" : "token-y-103";
    check("(precondition) the older record wins", winner === (xOlder ? x : y));
    const realUnlink = fs.unlinkSync;
    let hits = 0;
    fs.unlinkSync = (p, ...rest) => {
      if (p === loserFile) { hits++; throw Object.assign(new Error("EPERM: simulated unlink failure"), { code: "EPERM" }); }
      return realUnlink(p, ...rest);
    };
    let r;
    try {
      r = byId ? M.clearMergeQuarantineLatchFile(hashForKey(kp)) : M.clearMergeQuarantineReporting(winner);
    } finally { fs.unlinkSync = realUnlink; }
    console.log(`INFO  ${scenarioName}: hits=${hits} lifted=${JSON.stringify(r.liftedRepoPaths.map((p) => (p === x ? "X" : p === y ? "Y" : p)))} latchKept=${r.latchKept} loserFileExists=${fs.existsSync(loserFile)} tokenInMemory=${allTokens().has(loserToken)}`);
    check("(control) the injected unlink fault actually fired on the loser's file", hits > 0 && fs.existsSync(loserFile));
    check("*** GUARD *** the loser is NOT named as lifted (its file survived)", !r.liftedRepoPaths.includes(loser));
    check("(unchanged) the winner is still named", r.liftedRepoPaths.includes(winner));
    check("*** GUARD *** latchKept is true", r.latchKept === true);
    await reboot(regs);
    check("*** GUARD *** the loser IS re-armed on reboot from the surviving file", allTokens().has(loserToken) && M.assertRepoNotQuarantined(repo).ok === false);
  } else if (scenarioName.startsWith("json-json-route-")) {
    // The other clear routes reach the same union: by-id (winner's latch id), by-recorded-path, by-key.
    const route = scenarioName.slice("json-json-route-".length);
    const { repo, kp } = makeRepo(scenarioName);
    const x = ghost("x"), y = ghost("y");
    const regs = [repo, x, y];
    writeJson(path.join(M.MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`), rec(x, "token-x-103", 120_000, kp));
    writeJson(path.join(M.MERGE_QUARANTINE_DIR, `!stale-y-103-${freshSfx()}.json`), rec(y, "token-y-103", 60_000, kp));
    M.reenterMergeQuarantinesAtBoot(regs);
    const r = route === "by-id" ? M.clearMergeQuarantineLatchFile(hashForKey(kp))
      : route === "by-recorded-path" ? M.clearMergeQuarantineByRecordedPath(x)
      : M.clearMergeQuarantineByKey(kp, x, undefined, true);
    console.log(`INFO  route=${route} lifted=${JSON.stringify(r.liftedRepoPaths.map((p) => (p === x ? "X" : p === y ? "Y" : p)))} refused=${r.refusedBeforeClear} ok=${r.ok}`);
    check(`(${route}) *** THE FIX *** the winner AND the loser are named`, sameSet(r.liftedRepoPaths, [x, y]));
    check(`(${route}) (unchanged) not refused; the whole union is gone`, r.refusedBeforeClear !== true && M.assertRepoNotQuarantined(repo).ok === true && allTokens().size === 0 && lsDir().length === 0);
  } else if (scenarioName === "json-json-clear-loser-still-not-found") {
    // Disclosure adds no route and no lift: addressing the (invisible) loser stays NOT FOUND and touches nothing.
    const { repo, kp } = makeRepo("loserclear");
    const x = ghost("x"), y = ghost("y");
    const regs = [repo, x, y];
    writeJson(path.join(M.MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`), rec(x, "token-x-103", 120_000, kp));
    writeJson(path.join(M.MERGE_QUARANTINE_DIR, `!stale-y-103-${freshSfx()}.json`), rec(y, "token-y-103", 60_000, kp));
    M.reenterMergeQuarantinesAtBoot(regs);
    const before = lsDir().sort();
    const r = M.clearMergeQuarantine(y);
    check("(unchanged) clear(loser) lifts nothing and is not a quarantine hit", r.liftedRepoPaths.length === 0 && r.wasQuarantined === false);
    check("(unchanged) union and both files survive", M.assertRepoNotQuarantined(repo).ok === false && allTokens().has("token-y-103") && sameSet(lsDir().sort(), before));
  } else if (scenarioName === "single-ghost-no-loser-names-only-winner") {
    const { repo, kp } = makeRepo("single");
    const x = ghost("x");
    writeJson(path.join(M.MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`), rec(x, "token-x-103", 60_000, kp));
    M.reenterMergeQuarantinesAtBoot([repo, x]);
    const r = M.clearMergeQuarantineReporting(x);
    check("(control) a lone ghost names exactly itself", sameSet(r.liftedRepoPaths, [x]));
  } else if (scenarioName === "mixed-json-winner-tmp-loser" || scenarioName === "mixed-tmp-winner-json-loser") {
    // MIXED shape: one identity is a `.json` final, the other a `<hash>.json.tmp-<pid>` residue. Measured honestly
    // (see the check labels): the d2582692 tmp-residue protection fires for the tmp identity, so it survives as its
    // own pending entry and is therefore NOT named as lifted - disclosure never claims a lift that did not happen.
    const jsonWins = scenarioName === "mixed-json-winner-tmp-loser";
    const { repo, kp } = makeRepo(scenarioName);
    const x = ghost("x"), y = ghost("y"); // x = .json identity, y = .tmp identity
    const regs = [repo, x, y];
    writeJson(path.join(M.MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`), rec(x, "token-x-103", jsonWins ? 120_000 : 30_000, kp));
    writeJson(path.join(M.MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json.tmp-22222`), rec(y, "token-y-103", jsonWins ? 30_000 : 120_000, kp));
    M.reenterMergeQuarantinesAtBoot(regs);
    const u = M.listActiveMergeQuarantines().find((e) => e.repoPath === x || e.repoPath === y);
    check("(precondition) both tokens are enforced after boot", allTokens().has("token-x-103") && allTokens().has("token-y-103"));
    const winner = u?.repoPath;
    const loser = winner === x ? y : x;
    const r = M.clearMergeQuarantineReporting(winner);
    const loserTokenSurvives = allTokens().has(winner === x ? "token-y-103" : "token-x-103");
    console.log(`INFO  measured: winner=${winner === x ? "X(.json)" : "Y(.tmp)"} lifted=${JSON.stringify(r.liftedRepoPaths.map((p) => (p === x ? "X" : p === y ? "Y" : p)))} loserTokenSurvives=${loserTokenSurvives} files=${JSON.stringify(lsDir())}`);
    check("(pinned) the winner is named as lifted", r.liftedRepoPaths.includes(winner));
    if (loserTokenSurvives) {
      check("(pinned) the loser SURVIVED the clear, so it is NOT named as lifted", !r.liftedRepoPaths.includes(loser));
      check("(pinned) and it still blocks across a reboot", (await reboot(regs), allTokens().has(winner === x ? "token-y-103" : "token-x-103")));
    } else {
      check("(pinned) the loser's token was really lifted, so it IS named", r.liftedRepoPaths.includes(loser));
      await reboot(regs);
      check("(pinned, reboot) nothing resurrected", allTokens().size === 0);
    }
  } else if (scenarioName === "d2582692-tmp-tmp-control-survivor-not-named") {
    // The d2582692 L1/L2 pin's own fixture: both identities are `.tmp` residues at a manufactured shared key. Clearing
    // the winner L1 keeps L2 blocked as its own pending entry, so L2 must NOT be named as lifted.
    const l1 = ghost("l1"), l2 = ghost("l2");
    const KS = `/synthetic/103405e0-shared-key-${freshSfx()}`;
    const KShash = hashForKey(KS);
    fs.mkdirSync(M.MERGE_QUARANTINE_DIR, { recursive: true });
    fs.writeFileSync(path.join(M.MERGE_QUARANTINE_DIR, `${KShash}.json.tmp-11111`), JSON.stringify(rec(l1, "l1-token", 60_000, KS), null, 2) + "\n");
    fs.writeFileSync(path.join(M.MERGE_QUARANTINE_DIR, `${KShash}.json.tmp-22222`), JSON.stringify(rec(l2, "l2-token", 30_000, KS), null, 2) + "\n");
    M.reenterMergeQuarantinesAtBoot([]);
    check("(precondition) the union's winner is L1 and both tokens are active", M.activeMergeQuarantineFor(l1)?.repoPath === l1 && allTokens().has("l1-token") && allTokens().has("l2-token"));
    const r = M.clearMergeQuarantineReporting(l1);
    check("*** CONTROL *** liftedRepoPaths names L1", r.liftedRepoPaths.includes(l1));
    check("*** CONTROL *** liftedRepoPaths does NOT name L2 (it survives as pending)", !r.liftedRepoPaths.includes(l2));
    check("(pinned d2582692) L2's token survives and L2 still blocks", allTokens().has("l2-token") && M.assertRepoNotQuarantined(l2).ok === false);
    await reboot([]);
    check("(pinned d2582692, reboot) L2 still blocks after a reboot", allTokens().has("l2-token") && !allTokens().has("l1-token"));
  } else if (scenarioName === "resolvable-winner-398f476c-control-refusal-unchanged") {
    // 398f476c's shape: resolvable S (older) wins a union with unresolvable X. clear(S) is REFUSED, nothing lifted.
    const { repo, teamA, kp } = makeRepo("resolvable");
    const x = ghost("x");
    const regs = [repo, teamA, x];
    writeJson(path.join(M.MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`), rec(x, "token-x-103", 60_000, kp));
    writeJson(path.join(M.MERGE_QUARANTINE_DIR, `!stale-teamA-103-${freshSfx()}.json`), { repoPath: teamA, branch: "teamA-b", reason: "teamA-r", enteredAt: Date.now() - 120_000, tokens: ["token-teamA-103"] });
    M.reenterMergeQuarantinesAtBoot(regs);
    const r = M.clearMergeQuarantine(teamA);
    check("*** CONTROL *** clear(S) is still REFUSED with nothing lifted", r.refusedBeforeClear === true && r.liftedRepoPaths.length === 0);
    check("(unchanged) the refusal names X and both tokens still block", typeof r.reason === "string" && r.reason.includes(x) && allTokens().has("token-x-103") && allTokens().has("token-teamA-103"));
  } else {
    throw new Error(`unknown scenario ${scenarioName}`);
  }
} catch (err) {
  console.log(`FAIL  scenario threw: ${err?.stack ?? err}`);
  failures++;
}
console.log(failures === 0 ? "\nOK" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
