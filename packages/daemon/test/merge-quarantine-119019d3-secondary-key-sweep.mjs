import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Regression pin: a clear that frees an entry's SECONDARY armed keys arms a foreign cross-hash tmp residue
// whose content canonicalises onto a secondary key, in-process, exactly as a fresh boot would.
// `deleteMergeQuarantineLatchByKey` passes only `new Set([key])` to its trailing sweep; this pins that every
// caller loops it once per freed key, so the secondary keys are each swept with themselves as the freed key.
//
// @decision 119019d3
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq119-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);
const mod = await import(mergeQuarantineModuleHref);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const GIT_ID = "-c user.email=mq119@loom -c user.name=mq119";
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const hashOf = (key) => createHash("sha256").update(key).digest("hex").slice(0, 24);
const sortedTokens = (e) => (e ? JSON.stringify([...e.tokens].sort()) : undefined);

function makeRepo(tag) {
  const dir = path.join(os.tmpdir(), `loom-mq119-repo-${tag}-${freshSfx()}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), `# merge-quarantine-119019d3 (${tag})\n`);
  execSync(`git init -q && git config user.email mq119@loom && git config user.name mq119`, { cwd: dir });
  commitAll(dir, "init", GIT_ID);
  return dir;
}
const neverPath = (tag) => path.join(os.tmpdir(), `loom-mq119-${tag}-never-${freshSfx()}`);

let bootReimportCounter = 0;
async function freshBootModule() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}
function writeTmp(hash, suffix, record) {
  fs.mkdirSync(mod.MERGE_QUARANTINE_DIR, { recursive: true });
  const p = path.join(mod.MERGE_QUARANTINE_DIR, `${hash}.json.tmp-${suffix}`);
  fs.writeFileSync(p, JSON.stringify(record, null, 2) + "\n");
  return p;
}
function snapshotDir(dir) {
  const snap = new Map();
  for (const f of fs.readdirSync(dir)) snap.set(f, fs.readFileSync(path.join(dir, f)));
  return snap;
}
function restoreDirSnapshot(dir, snap) {
  for (const f of fs.readdirSync(dir)) if (!snap.has(f)) fs.unlinkSync(path.join(dir, f));
  for (const [f, content] of snap) fs.writeFileSync(path.join(dir, f), content);
}

// Y is a real repo whose latch is dual-armed (primary ky + secondary k1 + secondary k2) by a boot that
// collides two tmps at Y's own hash, each naming a different never-resolvable resolvedKey. Then a foreign
// residue X (a never-resolvable path whose canonical key IS k2) is planted under a THIRD hash (R's).
async function dualArmedFixture(tag) {
  fs.mkdirSync(mod.MERGE_QUARANTINE_DIR, { recursive: true });
  const y = makeRepo(`y-${tag}`);
  const r = makeRepo(`r-${tag}`);
  const ky = canonicalRepoLockKey(y);
  const w1 = neverPath(`w1-${tag}`);
  const w2 = neverPath(`w2-${tag}`);
  const k1 = canonicalRepoLockKey(w1);
  const k2 = canonicalRepoLockKey(w2);
  writeTmp(hashOf(ky), "111111", { repoPath: y, branch: "b", reason: "r1-older", enteredAt: Date.now() - 2000, tokens: [randomUUID()], resolvedKey: k1 });
  writeTmp(hashOf(ky), "222222", { repoPath: y, branch: "b", reason: "r2-newer", enteredAt: Date.now() - 1000, tokens: [randomUUID()], resolvedKey: k2 });
  mod.reenterMergeQuarantinesAtBoot([y, r]);
  const x = w2; // canonicalises onto k2 (a SECONDARY key of Y's entry)
  const xToken = randomUUID();
  const xTmp = writeTmp(hashOf(canonicalRepoLockKey(r)), "91901-cafef119", { repoPath: x, branch: "loom/x-branch", reason: "X's stray tmp, misfiled onto R's hash", enteredAt: Date.now() - 500, tokens: [xToken] });
  return { y, r, ky, k1, k2, x, xToken, xTmp };
}

try {
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (BY-KEY) -- clearMergeQuarantineReporting(Y) -> clearMergeQuarantineByKey, `for k of keysToLift`.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const f = await dualArmedFixture("bykey");
    check("(bykey precondition) k2 is a SECONDARY key (differs from Y's primary and from k1)", f.k2 !== f.ky && f.k2 !== f.k1);
    check("(bykey precondition) Y's entry is armed at the secondary key k2 (X is blocked via Y's entry)", mod.stillBlockedEntryFor(f.x) !== undefined);
    const res = mod.clearMergeQuarantineReporting(f.y);
    check("(bykey) clear ok", res.wasQuarantined === true);
    check("(bykey) X's residue SURVIVES on disk (never unlinked)", fs.existsSync(f.xTmp));
    const snap = snapshotDir(mod.MERGE_QUARANTINE_DIR);
    const inProcess = mod.stillBlockedEntryFor(f.x);
    check("*** THE PIN (bykey) *** X is ARMED in-process after the clear freed secondary key k2", inProcess !== undefined && inProcess.tokens.includes(f.xToken));
    restoreDirSnapshot(mod.MERGE_QUARANTINE_DIR, snap);
    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([f.y, f.r]);
    const reboot = fresh.stillBlockedEntryFor(f.x);
    check("*** THE GOVERNING INVARIANT (bykey) *** X blocked on BOTH sides, same token set", inProcess !== undefined && reboot !== undefined && sortedTokens(inProcess) === sortedTokens(reboot));
    restoreDirSnapshot(mod.MERGE_QUARANTINE_DIR, snap);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (PENDING-TWIN) -- clearMergeQuarantineByKey's pending-twin "remove" loop, `for k of plan.ownedArmedKeys`
  // (sibling of the token-removal and recorded-path pending loops, which share the same per-key shape). A
  // same-identity pending twin tied only by token subset is live-armed at TWO secondary keys kTwinA/kTwinB;
  // a residue canonicalising onto kTwinB is filed under a third hash.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    for (const f of fs.readdirSync(mod.MERGE_QUARANTINE_DIR)) fs.unlinkSync(path.join(mod.MERGE_QUARANTINE_DIR, f));
    const m = await freshBootModule();
    const sfx = freshSfx();
    const t = neverPath("t-twin");
    const wA = neverPath("twa");
    const wB = neverPath("twb");
    const kMain = `mq119-kMain-${sfx}`;
    const kTwinA = canonicalRepoLockKey(wA);
    const kTwinB = canonicalRepoLockKey(wB);
    const r = makeRepo("r-twin");
    const shared = `token-shared-${sfx}`;
    const entry = { repoPath: t, branch: "main-branch", reason: "119019d3: clear target", enteredAt: Date.now(), tokens: [shared] };
    const pEntry = { repoPath: t, branch: "twin-branch", reason: "119019d3: pending twin", enteredAt: Date.now(), tokens: [shared], armedKeys: [kTwinA, kTwinB] };
    m.reenterMergeQuarantinesAtBootTestOnly([], [{ entry: pEntry, sourceFile: `pending-mq119-${sfx}.json` }]);
    m.setActiveQuarantineTestOnly(kMain, entry);
    m.setActiveQuarantineTestOnly(kTwinA, pEntry);
    m.setActiveQuarantineTestOnly(kTwinB, pEntry);
    for (const k of [kMain, kTwinA, kTwinB]) {
      fs.writeFileSync(path.join(m.MERGE_QUARANTINE_DIR, `${hashOf(k)}.json`), JSON.stringify({ repoPath: t, branch: "b", reason: "119019d3 fixture", enteredAt: Date.now(), tokens: [shared] }, null, 2) + "\n");
    }
    const x = wB; // canonicalises onto kTwinB
    const xToken = randomUUID();
    const xTmp = writeTmp(hashOf(canonicalRepoLockKey(r)), "91902-cafef119", { repoPath: x, branch: "loom/x-branch", reason: "X's stray tmp, misfiled onto R's hash", enteredAt: Date.now() - 500, tokens: [xToken] });
    check("(twin precondition) kTwinB is a secondary key distinct from kTwinA", kTwinA !== kTwinB && kTwinA !== kMain);
    check("(twin precondition) X is blocked via the twin's armed key kTwinB", m.stillBlockedEntryFor(x) !== undefined);
    const res = m.clearMergeQuarantineByKey(kMain, t);
    check("(twin) clear ok, twin's own latches lifted", !!res && !fs.existsSync(path.join(m.MERGE_QUARANTINE_DIR, `${hashOf(kTwinB)}.json`)) && !fs.existsSync(path.join(m.MERGE_QUARANTINE_DIR, `${hashOf(kTwinA)}.json`)));
    check("(twin) X's residue SURVIVES on disk", fs.existsSync(xTmp));
    const snap = snapshotDir(m.MERGE_QUARANTINE_DIR);
    const inProcess = m.stillBlockedEntryFor(x);
    check("*** THE PIN (twin) *** X is ARMED in-process after the pending-twin loop freed secondary key kTwinB", inProcess !== undefined && inProcess.tokens.includes(xToken));
    restoreDirSnapshot(m.MERGE_QUARANTINE_DIR, snap);
    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([r]);
    const reboot = fresh.stillBlockedEntryFor(x);
    check("*** THE GOVERNING INVARIANT (twin) *** X blocked on BOTH sides, same token set", inProcess !== undefined && reboot !== undefined && sortedTokens(inProcess) === sortedTokens(reboot));
  }
} finally {
  process.exitCode = failures === 0 ? 0 : 1;
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
}
