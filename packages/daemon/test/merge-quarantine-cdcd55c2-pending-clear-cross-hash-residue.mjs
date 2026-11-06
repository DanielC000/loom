import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// A clear-by-id of a PENDING-tier entry arms a foreign tmp residue (filed under a DIFFERENT hash) whose
// content canonicalises onto a key that entry occupied -- the in-process twin of what boot derives.
//
// @decision cdcd55c2
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mqcd55-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);
const mod = await import(mergeQuarantineModuleHref);
const { enterMergeQuarantine } = mod;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const GIT_ID = "-c user.email=mqcd55@loom -c user.name=mqcd55";
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const hashOf = (key) => createHash("sha256").update(key).digest("hex").slice(0, 24);
const sortedTokens = (e) => (e ? JSON.stringify([...e.tokens].sort()) : undefined);

function initRepoAt(dir, tag) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), `# merge-quarantine-cdcd55c2 (${tag})\n`);
  execSync(`git init -q && git config user.email mqcd55@loom && git config user.name mqcd55`, { cwd: dir });
  commitAll(dir, "init", GIT_ID);
}
function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqcd55-repo-${tag}-${freshSfx()}`);
  initRepoAt(repo, tag);
  return repo;
}

let bootReimportCounter = 0;
async function freshBootModule() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

function plantTmpResidue(key, repoPath, branch, reason, tokens, suffix) {
  fs.mkdirSync(mod.MERGE_QUARANTINE_DIR, { recursive: true });
  const tmpPath = path.join(mod.MERGE_QUARANTINE_DIR, `${hashOf(key)}.json.tmp-${suffix}`);
  fs.writeFileSync(tmpPath, JSON.stringify({ repoPath, branch, reason, enteredAt: Date.now() - 1000, tokens }, null, 2) + "\n");
  return tmpPath;
}

// Snapshot right after the clear's own mutations land, BEFORE any further in-process verdict query
// (stillBlockedEntryFor is pure, but assertRepoNotQuarantined can mutate); restore before the reboot leg.
function snapshotDir(dir) {
  const snap = new Map();
  for (const f of fs.readdirSync(dir)) snap.set(f, fs.readFileSync(path.join(dir, f)));
  return snap;
}
function restoreDirSnapshot(dir, snap) {
  for (const f of fs.readdirSync(dir)) if (!snap.has(f)) fs.unlinkSync(path.join(dir, f));
  for (const [f, content] of snap) fs.writeFileSync(path.join(dir, f), content);
}

// A PENDING entry that is resolvable NOW: raised while its path does not exist (lands pending), then the
// repo materialises. Returns { p, pId } where pId is the clear-by-id route id.
function makeResolvablePending(tag) {
  const p = path.join(os.tmpdir(), `loom-mqcd55-p-${tag}-${freshSfx()}`);
  enterMergeQuarantine(p, "loom/p-branch", "p's own raise, while its path did not resolve");
  const pending = mod.listPendingMergeQuarantinesTestOnly().find((e) => e.repoPath === p);
  initRepoAt(p, tag);
  const pId = createHash("sha256").update(pending.sourceFile).digest("hex").slice(0, 24);
  return { p, pId, pending };
}

try {
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (MAIN) -- P pending + resolvable-now; X = P/ghost (key collapses onto P's). X's armable tmp is filed
  // under unrelated R's hash. Clear-by-id of P must arm X in-process, matching a fresh boot of the same bytes.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const { p, pId, pending } = makeResolvablePending("main");
    check("(main precondition) P landed PENDING", !!pending);
    const r = makeRepo("main-r");
    const keyR = canonicalRepoLockKey(r);
    const x = path.join(p, "ghost-subdir-main");
    fs.mkdirSync(x, { recursive: true });
    check("(main precondition) X collapses onto P's canonical key", canonicalRepoLockKey(x) === canonicalRepoLockKey(p));
    const xToken = randomUUID();
    const xTmpAtRsHash = plantTmpResidue(keyR, x, "loom/x-branch", "X's own stray tmp, misfiled onto R's hash", [xToken], "81001-cafef101");
    check("(main precondition) X is enforced via P's pending tier before the clear", mod.stillBlockedEntryFor(x) !== undefined);

    const clearResult = mod.clearMergeQuarantineLatchFile(pId);
    check("(main) clear-by-id ok", clearResult.ok === true);
    check("(main) X's residue at R's hash SURVIVES (never unlinked)", fs.existsSync(xTmpAtRsHash));
    const dirSnapshot = snapshotDir(mod.MERGE_QUARANTINE_DIR);

    const inProcessEntry = mod.stillBlockedEntryFor(x);
    check("*** THE FIX (main) *** X is ARMED in-process right after P's clear-by-id", inProcessEntry !== undefined);
    check("(main) ...carrying X's OWN token set", sortedTokens(inProcessEntry) === JSON.stringify([xToken]));
    check("(main) ...and surfaced as a routable still-blocked co-occupant", !!clearResult.stillBlockedCoOccupants?.some((c) => c.repoPath === x && c.route?.id));

    restoreDirSnapshot(mod.MERGE_QUARANTINE_DIR, dirSnapshot);
    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([p, r]);
    const rebootEntry = fresh.stillBlockedEntryFor(x);
    check("*** THE GOVERNING INVARIANT (main) *** in-process token set === post-reboot token set", inProcessEntry !== undefined && rebootEntry !== undefined && sortedTokens(inProcessEntry) === sortedTokens(rebootEntry));
    check("(main) in-process blocked === post-reboot blocked (never a split)", (inProcessEntry !== undefined) === (rebootEntry !== undefined));
    // The reboot module wrote to the same dir; put the in-process module's view back for later scenarios.
    restoreDirSnapshot(mod.MERGE_QUARANTINE_DIR, dirSnapshot);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (R-OCCUPIED-NEG) -- R (where X's residue is misfiled) is ALSO independently quarantined. P's clear still
  // arms X, and R's own in-memory entry and on-disk latch are byte-for-byte unchanged.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const { p, pId } = makeResolvablePending("rocc");
    const r = makeRepo("rocc-r");
    const keyR = canonicalRepoLockKey(r);
    const x = path.join(p, "ghost-subdir-rocc");
    fs.mkdirSync(x, { recursive: true });
    const rToken = enterMergeQuarantine(r, "loom/r-branch", "r's own real, UNRELATED, STILL-LIVE raise");
    const xToken = randomUUID();
    plantTmpResidue(keyR, x, "loom/x-branch", "X's stray tmp on R's hash", [xToken], "81002-cafef102");
    const rLatchPath = path.join(mod.MERGE_QUARANTINE_DIR, `${hashOf(keyR)}.json`);
    const rBytesBefore = fs.readFileSync(rLatchPath);
    const rTokensBefore = sortedTokens(mod.stillBlockedEntryFor(r));

    mod.clearMergeQuarantineLatchFile(pId);
    const inProcessX = mod.stillBlockedEntryFor(x);
    check("*** THE FIX (rocc) *** X armed in-process even with R occupying R's own hash", inProcessX !== undefined && inProcessX.tokens.includes(xToken));
    check("(rocc) R's in-memory token set unchanged", sortedTokens(mod.stillBlockedEntryFor(r)) === rTokensBefore && mod.stillBlockedEntryFor(r).tokens.includes(rToken));
    check("(rocc) R's on-disk latch BYTE-FOR-BYTE unchanged", Buffer.compare(rBytesBefore, fs.readFileSync(rLatchPath)) === 0);
    mod.clearMergeQuarantine(r);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (SCOPE-NEG) -- exact key match only. W = Z/ghost (Z independently quarantined) has residue misfiled
  // under R's hash; clearing an unrelated pending P must leave it untouched and Z's entry unmodified.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const { pId } = makeResolvablePending("scope");
    const z = makeRepo("scope-z");
    const r = makeRepo("scope-r");
    const keyR = canonicalRepoLockKey(r);
    const w = path.join(z, "ghost-subdir-scope");
    fs.mkdirSync(w, { recursive: true });
    enterMergeQuarantine(z, "loom/z-branch", "z's own real raise");
    const zTokensBefore = sortedTokens(mod.stillBlockedEntryFor(z));
    const wTmp = plantTmpResidue(keyR, w, "loom/w-branch", "W's stray tmp on R's hash", [randomUUID()], "81003-cafef103");
    const wBytes = fs.readFileSync(wTmp);

    const res = mod.clearMergeQuarantineLatchFile(pId);
    check("(scope-neg) P's clear ok and does not name W or Z", res.ok === true && !res.stillBlockedCoOccupants?.some((c) => c.repoPath === w || c.repoPath === z) && !res.contentKeptRepoPaths?.includes(w));
    check("(scope-neg) W's residue untouched, byte-for-byte", fs.existsSync(wTmp) && Buffer.compare(wBytes, fs.readFileSync(wTmp)) === 0);
    check("(scope-neg) Z's entry token set unchanged (W's residue never unioned in)", sortedTokens(mod.stillBlockedEntryFor(z)) === zTokensBefore);
    mod.clearMergeQuarantine(z);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (UNRESOLVABLE-NEG) -- P stays unresolvable with no informative keys: it frees no key, so an unrelated
  // misfiled residue is left completely untouched by its clear.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const p = path.join(os.tmpdir(), `loom-mqcd55-p-unres-never-exists-${freshSfx()}`); // never created
    enterMergeQuarantine(p, "loom/p-branch", "p's raise (stays unresolvable)");
    const pending = mod.listPendingMergeQuarantinesTestOnly().find((e) => e.repoPath === p);
    const pId = createHash("sha256").update(pending.sourceFile).digest("hex").slice(0, 24);
    const q = makeRepo("unres-q");
    const r = makeRepo("unres-r");
    const qTmp = plantTmpResidue(canonicalRepoLockKey(r), q, "loom/q-branch", "Q's stray tmp on R's hash", [randomUUID()], "81004-cafef104");

    const res = mod.clearMergeQuarantineLatchFile(pId);
    check("(unres-neg) clear ok, P lifted", res.ok === true && res.liftedRepoPaths?.includes(p));
    check("(unres-neg) unrelated Q residue untouched and Q not armed", fs.existsSync(qTmp) && mod.stillBlockedEntryFor(q) === undefined);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (TIER4) -- P is UNRESOLVABLE with an informative resolvedKey K_r (repo C) that DIFFERS from its degraded
  // walked-up key K_d (repo B: P = B/ghost). `findPendingIndicesFor` tier 4 blocks K_d (canonical key of P's
  // path), never K_r. A foreign residue X = B/ghost-x collapses onto K_d: it must be armed on P's clear and
  // match a reboot. A residue Y = C/ghost-y collapsing onto K_r must NOT be reported as freed by this clear.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const b = makeRepo("t4-b");
    const c = makeRepo("t4-c");
    const r = makeRepo("t4-r");
    const keyB = canonicalRepoLockKey(b);
    const keyC = canonicalRepoLockKey(c);
    const keyR = canonicalRepoLockKey(r);
    const pPath = path.join(b, "never-exists-ghost-p");
    const x = path.join(b, "ghost-x-t4");
    const y = path.join(c, "ghost-y-t4");
    fs.mkdirSync(x, { recursive: true });
    fs.mkdirSync(y, { recursive: true });
    const pTok = randomUUID();
    // P is armed as a PENDING entry (carrying resolvedKey K_r) the way 25d0d45b arms a foreign tmp residue:
    // a stray tmp at S's hash names P's path + resolvedKey, and clearing S sweeps it into pending in-process.
    // Its sourceFile is that tmp, so its clear-by-id id is S's hash — no armed key shares it, so the
    // id-addressed clear takes the matchedPending branch.
    const s = makeRepo("t4-s");
    const keyS = canonicalRepoLockKey(s);
    enterMergeQuarantine(s, "loom/s-branch", "S's own real raise, cleared to sweep P's residue into pending");
    const pTmp = path.join(mod.MERGE_QUARANTINE_DIR, `${hashOf(keyS)}.json.tmp-81005-cafef105`);
    fs.writeFileSync(pTmp, JSON.stringify({ repoPath: pPath, branch: "loom/p-branch", reason: "P's raise", enteredAt: Date.now() - 2000, tokens: [pTok], resolvedKey: keyC }, null, 2) + "\n");
    mod.clearMergeQuarantine(s);
    const booted = mod;
    const pEntry = booted.listPendingMergeQuarantinesTestOnly().find((e) => e.repoPath === pPath);
    check("(tier4 precondition) P is a PENDING entry with informative key K_r != K_d", !!pEntry && keyC !== keyB && canonicalRepoLockKey(pPath) === keyB && !fs.existsSync(pPath));
    if (pEntry) {
      // listPendingMergeQuarantinesTestOnly returns only {repoPath, sourceFile}; listActiveMergeQuarantines
      // includes pending entries and carries the full record.
      const pFull = booted.listActiveMergeQuarantines().find((e) => e.repoPath === pPath);
      const pInformative = [...new Set([...(pFull?.resolvedKey !== undefined ? [pFull.resolvedKey] : []), ...(pFull?.resolvedKeys ?? [])])];
      check("(tier4 precondition) P carries informative key(s) == [K_r], and K_d is not among them", JSON.stringify(pInformative) === JSON.stringify([keyC]));
      // P was diverted to a standalone `pending-<hex>.json`; pendingLatchIdFor hashes the FULL basename.
      const pId = createHash("sha256").update(pEntry.sourceFile).digest("hex").slice(0, 24);
      check("(tier4 precondition) P is a standalone pending-divert latch (clear-by-id takes the matchedPending branch)", /^pending-[0-9a-f]{24}\.json$/.test(pEntry.sourceFile));
      const xTok = randomUUID();
      const yTok = randomUUID();
      const xTmp = plantTmpResidue(keyR, x, "loom/x-branch", "X's stray tmp on R's hash", [xTok], "81006-cafef106");
      const yTmp = plantTmpResidue(keyR, y, "loom/y-branch", "Y's stray tmp on R's hash", [yTok], "81007-cafef107");
      check("(tier4 precondition) X is enforced via P's tier-4 match on K_d", booted.stillBlockedEntryFor(x) !== undefined);

      const clearResult = booted.clearMergeQuarantineLatchFile(pId);
      check("(tier4) clear-by-id ok", clearResult.ok === true);
      check("(tier4) both residues survive on disk", fs.existsSync(xTmp) && fs.existsSync(yTmp));
      const dirSnapshot = snapshotDir(mod.MERGE_QUARANTINE_DIR);
      const inProcessX = booted.stillBlockedEntryFor(x);
      check("*** THE FIX (tier4) *** X (collapsing onto K_d) is ARMED in-process after P's clear", inProcessX !== undefined && inProcessX.tokens.includes(xTok));
      check("(tier4) Y (collapsing onto K_r) is NOT reported as freed by this clear", !clearResult.stillBlockedCoOccupants?.some((cc) => cc.repoPath === y) && !clearResult.contentKeptRepoPaths?.includes(y));
      restoreDirSnapshot(mod.MERGE_QUARANTINE_DIR, dirSnapshot);
      const fresh = await freshBootModule();
      fresh.reenterMergeQuarantinesAtBoot([b, c, r]);
      const rebootX = fresh.stillBlockedEntryFor(x);
      check("*** THE GOVERNING INVARIANT (tier4) *** X blocked in-process === post-reboot, same tokens", inProcessX !== undefined && rebootX !== undefined && sortedTokens(inProcessX) === sortedTokens(rebootX));
    }
  }
} finally {
  process.exitCode = failures === 0 ? 0 : 1;
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
}
