import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card e7652e06, round 4 (Code Review e594e641, finding B1) — the round-3 marking predicate
// (`secondaryArmClaimsADifferentRegisteredIdentitysKey`) tests only the INCOMING `entry` at the moment of
// a union, never the STANDING `prior` — so it is itself order-dependent. A third, unregistered "ghost" Z
// (manufactured resolvedKey = kF) can poison the read order so that:
//   - Y's own secondary arm lands on an EMPTY kF (no prior yet -> no union -> nothing to mark);
//   - Z (unresolvable) unions into Y next (Z fails the predicate's own resolvability requirement);
//   - F's own primary arm unions in last (tautological -> fails the predicate's own freshness requirement).
// Every step individually passes the round-3 predicate; the union ends up UNMARKED, and clear-by-id(F)
// silently lifts Y too (and the reverse).
//
// Fix (round 4, @decision e7652e06 in merge-quarantine.ts): mark whenever EITHER the incoming entry OR
// the STANDING prior holds `key` via a non-fresh claim on a different registered identity
// (`priorHoldsKeyViaNonFreshClaimOnADifferentRegisteredIdentity`) — checked at every union, so a
// contamination already sitting as `prior` is caught the moment ANYONE later collides with it, and the
// mark is carried forward by `unionQuarantineEntries`'s own sticky OR through every later fold.
//
// This file exercises the reviewer's own probes (probe5.mjs/probe7.mjs, scratch e594e641), ported into a
// committed test: all 6 readdir orders over {Y, Z, F} x all 3 "oldest" ages, asserting the mark forms
// order-independently and that clear-by-id refuses symmetrically in both directions.
//
// Run: 1) build daemon (pnpm --filter @loom/daemon build), 2) node
// test/merge-quarantine-e7652e06-b1-ghost-order-independent-mark.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome, registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

useOwnLoomHome("loom-e7652e06b1-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  listActiveMergeQuarantines, assertRepoNotQuarantined, MERGE_QUARANTINE_DIR,
  reenterMergeQuarantinesAtBoot, clearMergeQuarantineLatchFile, quarantineLatchIdFor,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);
const GIT_ID = "-c user.email=e7652e06b1@loom -c user.name=e7652e06b1";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
// Mirrors the real module's own private quarantineHashForKey — same helper every sibling
// merge-quarantine*.mjs test file in this family carries under this exact name.
const hashKey = (key) => createHash("sha256").update(key).digest("hex").slice(0, 24);

function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-e7652e06b1-${tag}-${sfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo); // belt-and-suspenders exit-time backstop; each scenario also cleans up directly
  fs.writeFileSync(path.join(repo, "a"), "x");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

const ORDERS = ["YZF", "YFZ", "ZYF", "ZFY", "FYZ", "FZY"];
const AGES = ["Y", "F", "Z"];
// The two orders where F's own tautological primary arm reaches kF before, or evicts, Y's secondary arm
// WITHOUT the ghost ever reaching the collision — CASE 3's own pre-existing, unchanged resolution (no
// union forms at all). Every other order lets Z poison the collision per this file's own header.
const NO_UNION_ORDERS = new Set(["YFZ", "FYZ"]);

function runScenario(order, older) {
  const tag = `${order}-${older}`.toLowerCase();
  const wantYbeforeF = order.indexOf("Y") < order.indexOf("F");
  let F, Y, kF, kY;
  for (let i = 0; i < 50; i++) {
    const fCand = makeRepo(`${tag}-F-${i}`);
    const yCand = makeRepo(`${tag}-Y-${i}`);
    const kFCand = canonicalRepoLockKey(fCand);
    const kYCand = canonicalRepoLockKey(yCand);
    if ((hashKey(kYCand) < hashKey(kFCand)) === wantYbeforeF) {
      F = fCand; Y = yCand; kF = kFCand; kY = kYCand;
      break;
    }
    fs.rmSync(fCand, { recursive: true, force: true });
    fs.rmSync(yCand, { recursive: true, force: true });
  }
  if (!F) throw new Error(`${tag}: could not find an F/Y pair sorting as ${order} within 50 tries`);
  try {
    runScenarioBody(tag, order, older, F, Y, kF, kY);
  } finally {
    // *** CODE REVIEW fb1580b8, NIT *** — each scenario shares ONE LOOM_HOME/MERGE_QUARANTINE_DIR across
    // all 18 scenarios by design (cheap, matches this test family's own convention) — without this,
    // earlier scenarios' latches bleed into later boots and ~36 tmp repos leak per run. Clean up this
    // scenario's own repos and reset the quarantine dir before the next one starts.
    fs.rmSync(F, { recursive: true, force: true });
    fs.rmSync(Y, { recursive: true, force: true });
    fs.rmSync(MERGE_QUARANTINE_DIR, { recursive: true, force: true });
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  }
}

function runScenarioBody(tag, order, older, F, Y, kF, kY) {
  const now = Date.now();
  const age = (n) => now + (older === n ? -100_000 : 0);
  const fTok = `${tag}-f-${sfx()}`;
  const yTok = `${tag}-y-${sfx()}`;
  const zTok = `${tag}-z-${sfx()}`;

  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashKey(kF)}.json`), JSON.stringify({
    repoPath: F, branch: "fb", reason: `e7652e06 b1 (${tag}): F's own genuine quarantine`,
    enteredAt: age("F"), tokens: [fTok], resolvedKey: kF, resolvedKeys: [kF],
  }, null, 2) + "\n");
  // Y's OWN on-disk latch, hand-written directly (never produced by a raise/clear/fold-in) — modeling a
  // pre-d69a6744 build's own historical contamination already sitting on a real user's disk.
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashKey(kY)}.json`), JSON.stringify({
    repoPath: Y, branch: "yb", reason: `e7652e06 b1 (${tag}): Y's own, pre-existing on-disk contamination`,
    enteredAt: age("Y"), tokens: [yTok], resolvedKey: kY, resolvedKeys: [kY, kF],
  }, null, 2) + "\n");

  // Z: an UNREGISTERED, permanently unresolvable ghost whose own manufactured resolvedKey is F's genuine
  // kF — never created on disk, so it can never freshly own anything. Named (per the reviewer's own
  // technique) so readdir places it exactly where `order` needs: before both, after both, or strictly
  // between the first and third real file.
  const Z = path.join(os.tmpdir(), `loom-e7652e06b1-${tag}-Zghost-${sfx()}`);
  const nameOf = { Y: `${hashKey(kY)}.json`, F: `${hashKey(kF)}.json` };
  let zName;
  if (order[0] === "Z") zName = "000000-ghost.json";
  else if (order[2] === "Z") zName = "zzzzzz-ghost.json";
  else zName = `${hashKey(order[0] === "Y" ? kY : kF)}g-ghost.json`;
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, zName), JSON.stringify({
    repoPath: Z, branch: "zb", reason: `e7652e06 b1 (${tag}): Z's own degraded, manufactured claim on F's key`,
    enteredAt: age("Z"), tokens: [zTok], resolvedKey: kF,
  }, null, 2) + "\n");

  const namesOnDisk = fs.readdirSync(MERGE_QUARANTINE_DIR);
  const actualOrder = [nameOf.Y, nameOf.F, zName]
    .filter((n) => namesOnDisk.includes(n))
    .sort((a, b) => namesOnDisk.indexOf(a) - namesOnDisk.indexOf(b))
    .map((n) => (n === nameOf.Y ? "Y" : n === nameOf.F ? "F" : "Z"))
    .join("");
  check(`(${tag}) readdir order is ${order} as intended`, actualOrder === order);

  reenterMergeQuarantinesAtBoot([F, Y]);

  const entries = listActiveMergeQuarantines();
  const fy = entries.find((e) => (e.tokens ?? []).includes(fTok) && (e.tokens ?? []).includes(yTok));

  if (NO_UNION_ORDERS.has(order)) {
    // CASE 3 (pre-existing, unchanged by round 4) — F's own tautological primary arm reaches kF before,
    // or evicts, Y's secondary arm without the ghost ever reaching the real collision. No union forms.
    check(`(${tag}) no F+Y union forms (CASE 3, unchanged)`, !fy);
    check(`(${tag}) F is blocked by its own identity only`, !assertRepoNotQuarantined(F).ok
      && !entries.some((e) => e.repoPath === F && (e.tokens ?? []).includes(yTok)));
    check(`(${tag}) Y is blocked by its own identity only`, !assertRepoNotQuarantined(Y).ok
      && !!entries.find((e) => e.repoPath === Y)?.tokens?.includes(yTok));
    return;
  }

  check(`(${tag}) F+Y union forms`, !!fy);
  check(`(${tag}) the union is marked provenanceUnknown (order-independent — B1 fix)`, !!fy?.provenanceUnknown);
  check(`(${tag}) Y is blocked pre-clear`, !assertRepoNotQuarantined(Y).ok);
  check(`(${tag}) F is blocked pre-clear`, !assertRepoNotQuarantined(F).ok);

  // clear-by-id(F) must REFUSE (ambiguous/incomplete provenance) — never silently lift Y.
  const rF = clearMergeQuarantineLatchFile(quarantineLatchIdFor(F));
  check(`(${tag}) clear-by-id(F) refuses`, rF.ok === false);
  check(`(${tag}) Y stays blocked after clear-by-id(F)'s refusal`, !assertRepoNotQuarantined(Y).ok);
  check(`(${tag}) F stays blocked after clear-by-id(F)'s own refusal (nothing silently lifted)`, !assertRepoNotQuarantined(F).ok);

  // The reverse: clear-by-id(Y) must ALSO refuse — never silently lift F. Safe to chain in the same boot
  // state: a refusal is a pure no-op (nothing was mutated by the attempt above).
  const rY = clearMergeQuarantineLatchFile(quarantineLatchIdFor(Y));
  check(`(${tag}) clear-by-id(Y) refuses`, rY.ok === false);
  check(`(${tag}) Y stays blocked after clear-by-id(Y)'s own refusal`, !assertRepoNotQuarantined(Y).ok);
  check(`(${tag}) F stays blocked after clear-by-id(Y)'s refusal`, !assertRepoNotQuarantined(F).ok);
}

for (const order of ORDERS) {
  for (const older of AGES) {
    console.log(`\n=== SCENARIO order=${order} older=${older} ===\n`);
    runScenario(order, older);
  }
}

console.log(`\n${failures === 0 ? "✅ ALL CHECKS PASSED" : `❌ ${failures} CHECK(S) FAILED`}\n`);
process.exit(failures > 0 ? 1 : 0);
