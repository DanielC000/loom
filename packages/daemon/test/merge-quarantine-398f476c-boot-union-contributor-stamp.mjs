import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 398f476c — a boot-time CROSS-IDENTITY union (armQuarantineKey) used to leave NO record of the
// losing identity, so when the RESOLVABLE identity S won the union (S older than a degraded, unresolvable X
// that occupies the same key Kp), a human clear of S silently lifted X's token too: X was not queryable or
// clearable by its own path (activeMergeQuarantineFor(X) undefined, clear(X) NOT FOUND, no latch id).
//
// The fix stamps every LOSING identity into the union's `contributorRepoPaths` at armQuarantineKey. The stamp
// is RE-DERIVED each boot (boot never writes the union at a degraded-occupied key — X's own file and S's
// stale file both stay on disk), so the existing contributor machinery (clear-by-path refusal, clear-by-id
// refusal, clearBroadUnion) takes over. See docs/decisions/398f476c-*.md.
//
// Fixture = the e1cb7d33 fixture (merge-quarantine-degraded-occupant-guard.mjs): ghost X (never exists) with its
// final latch at sha(Kp).json and resolvedKey=Kp; teamA (a subdir of the registered repo, so it collapses onto
// Kp) with its own legacy-named stale latch that boot migrates into Kp.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-398f476c-boot-union-contributor-stamp.mjs
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
  "s-older-clear-s-refused-3-boots",
  "s-older-broad-union-lifts-both",
  "x-older-control-unchanged",
  "x-older-clear-x-first-control-unchanged",
  "x-pure-pending-control-unchanged",
  "same-identity-union-never-stamps",
  "stamp-is-rederived-not-persisted",
  "modern-s-clear-refused-3-boots",
  "modern-x-older-clear-x-first-unchanged",
  "provenance-unknown-stamped-union-falls-back-to-disclosed-lift",
  "both-unresolvable-no-stamp",
  "benign-ref-benign-control",
  "benign-ref-narrowing-private-token",
  "benign-ref-narrowing-contributor",
  "benign-ref-narrowing-provenance-unknown",
  "legacy-named-x-no-boot-write-disclosed-lift",
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
    ? "\n✅ ALL SCENARIOS PASS — a boot cross-identity union stamps its losing identity, so clearing the winner never silently lifts it."
    : `\n❌ ${failedScenarios} SCENARIO(S) FAILED — reproduces board card 398f476c.`);
  process.exit(failedScenarios === 0 ? 0 : 1);
}

const scenarioName = scenarioArg.slice("--scenario=".length);
useOwnLoomHome(`loom-mq398-${scenarioName}-`);
requireHermeticEnv();

const distGitDir = path.join(__dirname, "..", "dist", "git");
const mqHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
let M = await import(mqHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mq398@loom -c user.name=mq398";
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const hashForKey = (key) => createHash("sha256").update(key).digest("hex").slice(0, 24);
let bootN = 0;
async function reboot(regs) {
  bootN++;
  M = await import(`${mqHref}?b=${bootN}`);
  M.reenterMergeQuarantinesAtBoot(regs);
}

function makeFixture(tag) {
  const repo = path.join(os.tmpdir(), `loom-mq398-repo-${tag}-${freshSfx()}`);
  const teamA = path.join(repo, "teamA");
  fs.mkdirSync(teamA, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), `# ${tag}\n`);
  execSync(`git init -q && git config user.email mq398@loom && git config user.name mq398`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  const kp = canonicalRepoLockKey(repo);
  const x = path.join(os.tmpdir(), `loom-mq398-x-ghost-${tag}-${freshSfx()}`); // NEVER created
  check(`(precondition, ${tag}) X never exists on disk`, !fs.existsSync(x));
  fs.mkdirSync(M.MERGE_QUARANTINE_DIR, { recursive: true });
  return { repo, teamA, kp, x, xFile: path.join(M.MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`) };
}
const writeJson = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2) + "\n");
const writeX = (f, kp, x, ageMs, withResolvedKey = true) => writeJson(f, {
  repoPath: x, branch: "x-branch", reason: "X's real reason", enteredAt: Date.now() - ageMs, tokens: ["token-x-398"],
  ...(withResolvedKey ? { resolvedKey: kp } : {}),
});
const writeS = (teamA, ageMs, extra = {}) => {
  const p = path.join(M.MERGE_QUARANTINE_DIR, `!stale-teamA-398-${freshSfx()}.json`);
  writeJson(p, { repoPath: teamA, branch: "teamA-branch", reason: "teamA's real reason", enteredAt: Date.now() - ageMs, tokens: ["token-teamA-398"], ...extra });
  return p;
};
// A MODERN S record: raised while it owned the union key itself (identityAtRaise === key), no genuine
// contributor recorded (genuineContributorKeys: []) — the shape the legacy/nested refusal arms never fire for.
const modernS = (kp) => ({ identityAtRaise: kp, genuineContributorKeys: [] });
const entryFor = (p) => M.listActiveMergeQuarantines().find((e) => e.repoPath === p);
const tokensOf = (p) => entryFor(p)?.tokens ?? [];
const xFileHasOwnBytes = (f) => { try { const j = JSON.parse(fs.readFileSync(f, "utf8")); return j.repoPath !== undefined && (j.tokens ?? []).includes("token-x-398"); } catch { return false; } };

try {
  if (scenarioName === "s-older-clear-s-refused-3-boots") {
    // The card's M-2 repro (S OLDER than X => S wins the union). THREE boots, acting after each.
    const { repo, teamA, x, xFile } = makeFixture("s-older");
    const regs = [repo, teamA, x];
    const staleS = writeS(teamA, 120_000);
    const kp = canonicalRepoLockKey(repo);
    writeX(xFile, kp, x, 60_000);
    M.reenterMergeQuarantinesAtBoot(regs);
    for (let boot = 1; boot <= 3; boot++) {
      if (boot > 1) await reboot(regs);
      const label = `boot ${boot}`;
      const e = entryFor(teamA);
      check(`(${label}) the union is S's identity carrying BOTH tokens`, !!e && e.tokens.includes("token-teamA-398") && e.tokens.includes("token-x-398"));
      check(`(${label}) *** THE FIX *** the losing identity X is stamped as a contributor`, (e?.contributorRepoPaths ?? []).includes(x));
      check(`(${label}) X's own file is untouched`, xFileHasOwnBytes(xFile));
      check(`(${label}) S's stale source survives`, fs.existsSync(staleS));
      const cs = M.clearMergeQuarantine(teamA);
      check(`(${label}) *** THE FIX *** clear(S) is REFUSED, nothing lifted`, cs.refusedBeforeClear === true && cs.liftedRepoPaths.length === 0);
      check(`(${label}) the refusal NAMES X`, typeof cs.reason === "string" && cs.reason.includes(x));
      check(`(${label}) the refusal points at the clear-broad-union route`, typeof cs.reason === "string" && cs.reason.includes("clear-broad-union"));
      check(`(${label}) the refusal never leaks a token value`, !cs.reason.includes("token-x-398") && !cs.reason.includes("token-teamA-398"));
      check(`(${label}) the refusal is not the generic raise-time-identity wording`, !cs.reason.includes("raised before Loom recorded a raise-time identity"));
      check(`(${label}) the repo is STILL blocked after the refused clear`, M.assertRepoNotQuarantined(repo).ok === false && M.assertRepoNotQuarantined(teamA).ok === false);
      check(`(${label}) both tokens STILL enforced after the refused clear`, tokensOf(teamA).includes("token-x-398") && tokensOf(teamA).includes("token-teamA-398"));
      const cx = M.clearMergeQuarantine(x);
      check(`(${label}) clear(X) by its own path lifts nothing`, cx.liftedRepoPaths.length === 0);
      check(`(${label}) still blocked after clear(X)`, M.assertRepoNotQuarantined(repo).ok === false);
      check(`(${label}) X's file STILL intact on disk after both clears`, xFileHasOwnBytes(xFile));
    }
  } else if (scenarioName === "s-older-broad-union-lifts-both") {
    // The supported human escape: clearBroadUnion names X as a victim and lifts BOTH only on exact confirm.
    const { repo, teamA, x, xFile } = makeFixture("broad");
    const kp = canonicalRepoLockKey(repo);
    const regs = [repo, teamA, x];
    writeS(teamA, 120_000);
    writeX(xFile, kp, x, 60_000);
    M.reenterMergeQuarantinesAtBoot(regs);
    const dry = M.clearBroadUnion(teamA, [], true);
    check("(dry run) accepted", dry.ok === true);
    check("(dry run) the victim set names BOTH S and X", dry.ok === true && dry.victimPaths.includes(M.directPathIdentity(teamA)) && dry.victimPaths.includes(M.directPathIdentity(x)));
    const wrong = M.clearBroadUnion(teamA, [teamA], false);
    check("(real, wrong confirm) refused, nothing cleared", wrong.ok === false && M.assertRepoNotQuarantined(repo).ok === false);
    const real = M.clearBroadUnion(teamA, dry.victimPaths, false);
    check("(real, exact confirm) lifts the union", real.wasQuarantined === true && M.assertRepoNotQuarantined(repo).ok === true);
    await reboot(regs);
    check("(after reboot) stays clear: no resurrection from X's file or S's stale file", M.assertRepoNotQuarantined(repo).ok === true && M.assertRepoNotQuarantined(teamA).ok === true);
  } else if (scenarioName === "x-older-control-unchanged") {
    // X OLDER => X wins the union. Outcome must be byte-identical to pre-fix behaviour.
    const { repo, teamA, x, xFile } = makeFixture("x-older");
    const kp = canonicalRepoLockKey(repo);
    const regs = [repo, teamA, x];
    writeS(teamA, 60_000);
    writeX(xFile, kp, x, 120_000);
    M.reenterMergeQuarantinesAtBoot(regs);
    for (let boot = 1; boot <= 3; boot++) {
      if (boot > 1) await reboot(regs);
      const label = `x-older boot ${boot}`;
      check(`(${label}) X's identity answers the union with both tokens`, tokensOf(x).includes("token-x-398") && tokensOf(x).includes("token-teamA-398"));
      const cs = M.clearMergeQuarantine(teamA);
      // Baseline measured with the stamp DISABLED (identical outcome with it enabled): the first clear(S) reports
      // still-quarantined; a repeat after a reboot is a no-op that lifts nothing. Nothing is ever lifted.
      check(`(${label}) clear(S) lifts nothing`, cs.liftedRepoPaths.length === 0 && (boot > 1 || cs.stillQuarantined === true));
      check(`(${label}) still blocked after clear(S)`, M.assertRepoNotQuarantined(repo).ok === false);
      check(`(${label}) both tokens still enforced`, tokensOf(x).includes("token-x-398") && tokensOf(x).includes("token-teamA-398"));
    }
    const cx = M.clearMergeQuarantine(x);
    // Baseline (stamp disabled, identical with it enabled): X owns the key, so clear(x) lifts the whole union.
    check("(x-older) clear(x) lifts x", cx.liftedRepoPaths.includes(x));
    check("(x-older) nothing remains: unblocked, no tokens, no latch files", M.assertRepoNotQuarantined(repo).ok === true && tokensOf(x).length === 0 && fs.readdirSync(M.MERGE_QUARANTINE_DIR).length === 0);
    await reboot(regs);
    check("(x-older, reboot after clear(x)) stays clear", M.assertRepoNotQuarantined(repo).ok === true && fs.readdirSync(M.MERGE_QUARANTINE_DIR).length === 0);
  } else if (scenarioName === "x-older-clear-x-first-control-unchanged") {
    // Same fixture, but the FIRST clear is clear(x) (no prior clear(S)). Baseline measured on the pre-stamp
    // build in the 398f476c investigation: clear(x) lifts only x; S's own token survives as its own pending
    // latch and the repo stays blocked. Asserted here with the stamp enabled.
    const { repo, teamA, x, xFile } = makeFixture("x-older-first");
    const kp = canonicalRepoLockKey(repo);
    const regs = [repo, teamA, x];
    writeS(teamA, 60_000);
    writeX(xFile, kp, x, 120_000);
    M.reenterMergeQuarantinesAtBoot(regs);
    M.activeMergeQuarantineFor(teamA);
    const cx = M.clearMergeQuarantine(x);
    check("(x-older, clear(x) first) lifts x",cx.liftedRepoPaths.includes(x));
    check("(x-older, clear(x) first) S's token survives and the repo stays blocked", tokensOf(teamA).includes("token-teamA-398") && !tokensOf(teamA).includes("token-x-398") && M.assertRepoNotQuarantined(repo).ok === false);
    await reboot(regs);
    check("(x-older, clear(x) first, reboot) S's token still survives, x's is gone", tokensOf(teamA).includes("token-teamA-398") && !tokensOf(teamA).includes("token-x-398") && M.assertRepoNotQuarantined(repo).ok === false);
    const cs = M.clearMergeQuarantine(teamA);
    check("(x-older, clear(x) first) clear(S) then lifts S and frees the repo", cs.liftedRepoPaths.includes(teamA) && M.assertRepoNotQuarantined(repo).ok === true);
  } else if (scenarioName === "x-pure-pending-control-unchanged") {
    // X pure pending (no resolvedKey): clear(S) lifts S only, X survives as its own pending latch.
    const { repo, teamA, x, xFile } = makeFixture("pending");
    const kp = canonicalRepoLockKey(repo);
    const regs = [repo, teamA, x];
    writeS(teamA, 120_000);
    writeX(xFile, kp, x, 60_000, false);
    M.reenterMergeQuarantinesAtBoot(regs);
    M.activeMergeQuarantineFor(teamA);
    const cs = M.clearMergeQuarantine(teamA);
    check("(pending) clear(S) lifts S", cs.liftedRepoPaths.includes(teamA));
    check("(pending) X survives as its own quarantine (queryable by its own path)", !!M.activeMergeQuarantineFor(x) && tokensOf(x).includes("token-x-398"));
    await reboot(regs);
    check("(pending, reboot) X still survives", tokensOf(x).includes("token-x-398"));
    const cx = M.clearMergeQuarantine(x);
    check("(pending) clear(x) lifts x and nothing remains", cx.liftedRepoPaths.includes(x) && M.assertRepoNotQuarantined(repo).ok === true);
  } else if (scenarioName === "same-identity-union-never-stamps") {
    // armQuarantineKey's stamp must never fire for a SAME directPathIdentity union (twins / aliases), and
    // must fire for a genuinely different identity.
    const { repo } = makeFixture("same");
    const key = canonicalRepoLockKey(repo);
    const mk = (repoPath, tok) => ({ repoPath, branch: "b", reason: "r", enteredAt: Date.now(), tokens: [tok] });
    const alias = process.platform === "win32" ? repo.toUpperCase() : repo + path.sep + ".";
    check("(precondition) the alias is a different string with the same identity", alias !== repo && M.directPathIdentity(alias) === M.directPathIdentity(repo));
    const m1 = new Map();
    M.armQuarantineKeyTestOnly(m1, key, mk(repo, "t1"));
    const same = M.armQuarantineKeyTestOnly(m1, key, mk(alias, "t2"));
    check("(same identity, alias spelling) tokens unioned", same.tokens.includes("t1") && same.tokens.includes("t2"));
    check("(same identity) *** NO stamp ***", (same.contributorRepoPaths ?? []).length === 0);
    const m2 = new Map();
    M.armQuarantineKeyTestOnly(m2, key, mk(repo, "t1"));
    const same2 = M.armQuarantineKeyTestOnly(m2, key, mk(repo, "t3"));
    check("(same identity, identical spelling) NO stamp", (same2.contributorRepoPaths ?? []).length === 0);
    const other = path.join(os.tmpdir(), `loom-mq398-other-${freshSfx()}`);
    const m3 = new Map();
    M.armQuarantineKeyTestOnly(m3, key, mk(repo, "t1"));
    const diff = M.armQuarantineKeyTestOnly(m3, key, mk(other, "t4"));
    check("(different identity) the union stamps the loser, whichever side won", (diff.contributorRepoPaths ?? []).length === 1 && diff.repoPath !== diff.contributorRepoPaths[0]);
    check("(different identity) winner is never its own contributor", !(diff.contributorRepoPaths ?? []).some((c) => M.directPathIdentity(c) === M.directPathIdentity(diff.repoPath)));
  } else if (scenarioName === "stamp-is-rederived-not-persisted") {
    // RESIDUAL pin (checkpoint design): at a degraded-occupied key boot never writes the union, so the stamp
    // lives only in memory and X's file carries none; yet every boot re-derives it from the two source files.
    const { repo, teamA, x, xFile } = makeFixture("derive");
    const kp = canonicalRepoLockKey(repo);
    const regs = [repo, teamA, x];
    writeS(teamA, 120_000);
    writeX(xFile, kp, x, 60_000);
    M.reenterMergeQuarantinesAtBoot(regs);
    M.activeMergeQuarantineFor(teamA); // the runtime query that used to clobber X's file
    const onDisk = JSON.parse(fs.readFileSync(xFile, "utf8"));
    check("X's file carries NO persisted contributorRepoPaths (the stamp is in-memory only here)", onDisk.contributorRepoPaths === undefined);
    check("...yet the in-memory union carries the stamp", (entryFor(teamA)?.contributorRepoPaths ?? []).includes(x));
    await reboot(regs);
    check("a fresh boot RE-DERIVES the stamp from the two source files", (entryFor(teamA)?.contributorRepoPaths ?? []).includes(x));
    const cs = M.clearMergeQuarantine(teamA);
    check("and the refusal holds after that reboot", cs.refusedBeforeClear === true && M.assertRepoNotQuarantined(repo).ok === false);
  } else if (scenarioName === "modern-s-clear-refused-3-boots") {
    // CR SHOULD-1: a MODERN S (identityAtRaise === the union key, genuineContributorKeys: []) must be refused
    // exactly like the legacy S — the refusal fires from the contributor-occupant arm of
    // selfClearRefusesForStaleKeyContributors (no genuineContributorKeys is stamped).
    const { repo, teamA, x, xFile } = makeFixture("modern");
    const kp = canonicalRepoLockKey(repo);
    const regs = [repo, teamA, x];
    const staleS = writeS(teamA, 120_000, modernS(kp));
    writeX(xFile, kp, x, 60_000);
    M.reenterMergeQuarantinesAtBoot(regs);
    for (let boot = 1; boot <= 3; boot++) {
      if (boot > 1) await reboot(regs);
      const label = `modern boot ${boot}`;
      const e = entryFor(teamA);
      check(`(${label}) S is the union winner and is MODERN (identityAtRaise === key)`, !!e && e.identityAtRaise === kp);
      const cs = M.clearMergeQuarantine(teamA);
      check(`(${label}) *** SHOULD-1 *** clear(S) is REFUSED, nothing lifted`, cs.refusedBeforeClear === true && cs.liftedRepoPaths.length === 0);
      check(`(${label}) the refusal names X and the clear-broad-union route`, typeof cs.reason === "string" && cs.reason.includes(x) && cs.reason.includes("clear-broad-union"));
      check(`(${label}) both tokens still enforced, repo blocked`, tokensOf(teamA).includes("token-x-398") && tokensOf(teamA).includes("token-teamA-398") && M.assertRepoNotQuarantined(repo).ok === false);
      check(`(${label}) X's file and S's stale file are intact`, xFileHasOwnBytes(xFile) && fs.existsSync(staleS));
      const cx = M.clearMergeQuarantine(x);
      check(`(${label}) clear(x) lifts nothing`, cx.liftedRepoPaths.length === 0 && M.assertRepoNotQuarantined(repo).ok === false);
    }
    const dry = M.clearBroadUnion(teamA, [], true);
    check("(modern) clear-broad-union MATCHES the union (not 'does not match any union') and names S and X", dry.ok === true && dry.victimPaths.includes(M.directPathIdentity(teamA)) && dry.victimPaths.includes(M.directPathIdentity(x)));
    const real = dry.ok === true ? M.clearBroadUnion(teamA, dry.victimPaths, false) : { wasQuarantined: false };
    check("(modern) an exact confirm lifts both", real.wasQuarantined === true && M.assertRepoNotQuarantined(repo).ok === true);
    await reboot(regs);
    check("(modern, reboot) stays clear: nothing stranded or resurrected", M.assertRepoNotQuarantined(repo).ok === true && fs.readdirSync(M.MERGE_QUARANTINE_DIR).length === 0);
  } else if (scenarioName === "provenance-unknown-stamped-union-falls-back-to-disclosed-lift") {
    // A stamped S∪X later marked provenanceUnknown (e.g. unioned with a PU side): the occupant arm must NOT fire,
    // else clear-by-path AND clear-broad-union would both refuse (the latter refuses for unknown provenance) and
    // only a manual delete would remain. It falls back to the disclosed lift (X named in liftedRepoPaths).
    const { repo, teamA, x, xFile } = makeFixture("pu");
    const kp = canonicalRepoLockKey(repo);
    const regs = [repo, teamA, x];
    writeS(teamA, 120_000, modernS(kp));
    writeX(xFile, kp, x, 60_000);
    M.reenterMergeQuarantinesAtBoot(regs);
    const live = entryFor(teamA);
    check("(precondition) the union is stamped with X", (live?.contributorRepoPaths ?? []).includes(x));
    live.provenanceUnknown = true; // the live shared object, as the f00e9de8 scenarios do
    const cs = M.clearMergeQuarantine(teamA);
    check("*** GATE *** clear(S) is NOT refused for a provenanceUnknown union", cs.refusedBeforeClear !== true);
    check("*** GATE *** the lift is disclosed: X is named in liftedRepoPaths", cs.liftedRepoPaths.includes(teamA) && cs.liftedRepoPaths.includes(x));
    check("nothing is stranded: unblocked", M.assertRepoNotQuarantined(repo).ok === true);
  } else if (scenarioName === "modern-x-older-clear-x-first-unchanged") {
    // The x-older order with a MODERN S: the stamp must not fire (unresolvable winner / resolvable loser).
    const { repo, teamA, x, xFile } = makeFixture("modern-x-older");
    const kp = canonicalRepoLockKey(repo);
    const regs = [repo, teamA, x];
    writeS(teamA, 60_000, modernS(kp));
    writeX(xFile, kp, x, 120_000);
    M.reenterMergeQuarantinesAtBoot(regs);
    M.activeMergeQuarantineFor(teamA);
    check("(modern x-older) nothing stamped", (entryFor(x)?.contributorRepoPaths ?? []).length === 0);
    const cx = M.clearMergeQuarantine(x);
    check("(modern x-older, clear(x) first) lifts x and keeps S's token blocking", cx.liftedRepoPaths.includes(x) && tokensOf(teamA).includes("token-teamA-398") && M.assertRepoNotQuarantined(repo).ok === false);
    await reboot(regs);
    check("(modern x-older, reboot) S's token still survives, x's is gone", tokensOf(teamA).includes("token-teamA-398") && !tokensOf(teamA).includes("token-x-398") && M.assertRepoNotQuarantined(repo).ok === false);
  } else if (scenarioName === "both-unresolvable-no-stamp") {
    // CR SHOULD-2: unresolvable winner AND unresolvable loser (card d2582692's "MAJOR #3" pair). The winner guard
    // keeps the stamp off: clearing the winner lifts only the winner and the loser survives as its own pending.
    const { repo, x, xFile } = makeFixture("both-unres");
    const kp = canonicalRepoLockKey(repo);
    const y = path.join(os.tmpdir(), `loom-mq398-y-ghost-${freshSfx()}`);
    const regs = [repo, x, y];
    writeX(xFile, kp, x, 60_000);
    const yFile = path.join(M.MERGE_QUARANTINE_DIR, `!stale-y-398-${freshSfx()}.json`);
    writeJson(yFile, { repoPath: y, branch: "y-branch", reason: "Y's reason", enteredAt: Date.now() - 120_000, tokens: ["token-y-398"], resolvedKey: kp });
    M.reenterMergeQuarantinesAtBoot(regs);
    const u = entryFor(y) ?? entryFor(x);
    check("(both unresolvable) the union carries both tokens", !!u && u.tokens.includes("token-x-398") && u.tokens.includes("token-y-398"));
    check("(both unresolvable) *** NO stamp *** on the union", (u?.contributorRepoPaths ?? []).length === 0);
    const winner = u?.repoPath;
    const loser = winner === x ? y : x;
    const cw = M.clearMergeQuarantine(winner);
    // Baseline measured with the winner guard in place (and unchanged by the stamp, which does not fire here):
    // clear(winner) is NOT refused and lifts the whole two-ghost union. That whole-union lift is PRE-EXISTING for
    // this .json/.json pair (a residual, see the decision record); what this scenario pins is that the stamp stays
    // off, because stamping an unresolvable winner turns this into a refusal that breaks the pinned
    // d2582692-clearing-union-winner-keeps-loser-pending behaviour (measured with the guard removed).
    check("(both unresolvable) clear(winner) is NOT refused and lifts the winner", cw.refusedBeforeClear !== true && cw.liftedRepoPaths.includes(winner));
    check("(both unresolvable) nothing remains (the pre-existing whole-union lift)", M.assertRepoNotQuarantined(repo).ok === true && fs.readdirSync(M.MERGE_QUARANTINE_DIR).length === 0);
    await reboot(regs);
    check("(both unresolvable, reboot) stays clear", M.assertRepoNotQuarantined(repo).ok === true);
  } else if (scenarioName === "benign-ref-narrowing-private-token" || scenarioName === "benign-ref-narrowing-contributor" || scenarioName === "benign-ref-narrowing-provenance-unknown" || scenarioName === "benign-ref-benign-control") {
    // CR SHOULD-3: isBenignMigratedSourceReference exempts ONLY a ref that adds nothing. A same-identity pending ref
    // at one of the union's orphanLatchFiles basenames that carries (i) a private token, (ii) its own contributor
    // or (iii) a provenance gap must still make clear-broad-union refuse; the control (nothing extra) accepts.
    const { repo, teamA, x, xFile } = makeFixture(scenarioName);
    const kp = canonicalRepoLockKey(repo);
    const regs = [repo, teamA, x];
    const staleS = writeS(teamA, 120_000);
    writeX(xFile, kp, x, 60_000);
    M.reenterMergeQuarantinesAtBoot(regs);
    const union = entryFor(teamA);
    check("(precondition) the stale file basename is one of the union's orphanLatchFiles", (union?.orphanLatchFiles ?? []).includes(path.basename(staleS)));
    check("(precondition) the clean union is accepted by clear-broad-union before the extra ref", M.clearBroadUnion(teamA, [], true).ok === true);
    const base = { repoPath: teamA, branch: "teamA-branch", reason: "extra same-identity ref", enteredAt: Date.now() };
    if (scenarioName === "benign-ref-narrowing-private-token") M.pushPendingQuarantineTestOnly({ ...base, tokens: ["token-private-398"] }, path.basename(staleS));
    if (scenarioName === "benign-ref-narrowing-contributor") M.pushPendingQuarantineTestOnly({ ...base, tokens: ["token-teamA-398"], contributorRepoPaths: [x] }, path.basename(staleS));
    if (scenarioName === "benign-ref-narrowing-provenance-unknown") M.pushPendingQuarantineTestOnly({ ...base, tokens: ["token-teamA-398"], provenanceUnknown: true }, path.basename(staleS));
    const dry = M.clearBroadUnion(teamA, [], true);
    if (scenarioName === "benign-ref-benign-control") {
      check("(control) a ref adding nothing is still exempt: clear-broad-union accepts", dry.ok === true);
    } else {
      check("*** NARROWING *** the extra ref is NOT exempt: clear-broad-union REFUSES", dry.ok === false);
      check("*** NARROWING *** and the refusal is the tied-pending-record one", dry.ok === false && dry.reason.includes("PENDING"));
    }
  } else if (scenarioName === "legacy-named-x-no-boot-write-disclosed-lift") {
    // CR NIT-4, as measured: X's latch under a LEGACY name (nothing physically at sha(Kp)) with resolvedKey Kp. Boot
    // still does NOT write the union at Kp (X is a degraded occupant of Kp by its own resolvedKey), so no boot-written
    // sha(Kp).json carrying the stamp exists in this shape; the stamp is in memory and re-derived. Here the clear is
    // not refused (X's own latch is not at a live key) but it DISCLOSES X in liftedRepoPaths, unlike the silent
    // occupant shape.
    const { repo, teamA, x } = makeFixture("written");
    const kp = canonicalRepoLockKey(repo);
    const regs = [repo, teamA, x];
    const legacyX = path.join(M.MERGE_QUARANTINE_DIR, `!legacy-x-398-${freshSfx()}.json`);
    writeJson(legacyX, { repoPath: x, branch: "x-branch", reason: "X's real reason", enteredAt: Date.now() - 60_000, tokens: ["token-x-398"], resolvedKey: kp });
    const staleS = writeS(teamA, 120_000, modernS(kp));
    M.reenterMergeQuarantinesAtBoot(regs);
    const kpFile = path.join(M.MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`);
    check("(boot) nothing was written at sha(Kp).json", !fs.existsSync(kpFile));
    check("(boot) both source files are intact", fs.existsSync(legacyX) && fs.existsSync(staleS));
    check("(boot) the in-memory union carries the stamp", (entryFor(teamA)?.contributorRepoPaths ?? []).includes(x));
    const cs = M.clearMergeQuarantine(teamA);
    check("(clear S) lifts S and DISCLOSES X in liftedRepoPaths (never silent)", cs.liftedRepoPaths.includes(teamA) && cs.liftedRepoPaths.includes(x));
    check("(clear S) nothing remains", M.assertRepoNotQuarantined(repo).ok === true && tokensOf(x).length === 0);
  } else {
    throw new Error(`unknown scenario ${scenarioName}`);
  }
} catch (err) {
  console.log(`FAIL  scenario threw: ${err?.stack ?? err}`);
  failures++;
}
console.log(failures === 0 ? "\nOK" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
