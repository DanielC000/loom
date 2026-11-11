import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// cdcd55c2's cross-hash residue arming, extended to EVERY other pending-tier clear route: by-path
// (clearMergeQuarantine, resolvable -> clearMergeQuarantineByKey's pending loop), by-recorded-path
// (tryClearMergeQuarantineByOwnIdentity's pending branch), the thin reporting wrapper, and the token route
// (clearTokenFromPendingIndices' remove branch). Each must leave the in-process verdict for a foreign tmp
// residue that collapses onto a key the cleared pending entry freed IDENTICAL to a fresh boot of the same bytes.
//
// @decision 7aa9c406
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq7aa9-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);
const mod = await import(mergeQuarantineModuleHref);
const { enterMergeQuarantine } = mod;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const GIT_ID = "-c user.email=mq7aa9@loom -c user.name=mq7aa9";
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const hashOf = (key) => createHash("sha256").update(key).digest("hex").slice(0, 24);
const sortedTokens = (e) => (e ? JSON.stringify([...e.tokens].sort()) : undefined);

function initRepoAt(dir, tag) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), `# merge-quarantine-7aa9c406 (${tag})\n`);
  execSync(`git init -q && git config user.email mq7aa9@loom && git config user.name mq7aa9`, { cwd: dir });
  commitAll(dir, "init", GIT_ID);
}
function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mq7aa9-repo-${tag}-${freshSfx()}`);
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

function snapshotDir(dir) {
  const snap = new Map();
  for (const f of fs.readdirSync(dir)) snap.set(f, fs.readFileSync(path.join(dir, f)));
  return snap;
}
function restoreDirSnapshot(dir, snap) {
  for (const f of fs.readdirSync(dir)) if (!snap.has(f)) fs.unlinkSync(path.join(dir, f));
  for (const [f, content] of snap) fs.writeFileSync(path.join(dir, f), content);
}

// The routes under test. `tok` is P's own token (the token route lifts exactly it).
const ROUTES = {
  path: (p) => mod.clearMergeQuarantine(p),
  recorded: (p) => mod.clearMergeQuarantineByRecordedPath(p),
  reporting: (p) => mod.clearMergeQuarantineReporting(p),
  token: (p, tok) => mod.clearMergeQuarantineByToken(p, tok),
};

// A PENDING entry that is resolvable NOW: raised while its path does not exist, then the repo materialises.
function makeResolvablePending(tag) {
  const p = path.join(os.tmpdir(), `loom-mq7aa9-p-${tag}-${freshSfx()}`);
  const tok = enterMergeQuarantine(p, "loom/p-branch", "p's own raise, while its path did not resolve");
  const pending = mod.listPendingMergeQuarantinesTestOnly().find((e) => e.repoPath === p);
  initRepoAt(p, tag);
  return { p, tok, pending };
}

try {
  for (const [route, clear] of Object.entries(ROUTES)) {
    // ═══ (MAIN) -- P pending + resolvable-now; X = P/ghost collapses onto P's key; X's armable tmp is filed
    // under unrelated R's hash. The clear must arm X in-process, matching a fresh boot of the same bytes.
    {
      const { p, tok, pending } = makeResolvablePending(`main-${route}`);
      check(`(${route} main precondition) P landed PENDING`, !!pending);
      const r = makeRepo(`main-r-${route}`);
      const keyR = canonicalRepoLockKey(r);
      const x = path.join(p, `ghost-main-${route}`);
      fs.mkdirSync(x, { recursive: true });
      check(`(${route} main precondition) X collapses onto P's canonical key`, canonicalRepoLockKey(x) === canonicalRepoLockKey(p));
      const xToken = randomUUID();
      const xTmp = plantTmpResidue(keyR, x, "loom/x-branch", "X's own stray tmp, misfiled onto R's hash", [xToken], `82${route.length}01-cafef701`);
      check(`(${route} main precondition) X is enforced via P's pending tier before the clear`, mod.stillBlockedEntryFor(x) !== undefined);

      const result = clear(p, tok);
      check(`(${route} main) P no longer pending`, !mod.listPendingMergeQuarantinesTestOnly().some((e) => e.repoPath === p));
      check(`(${route} main) X's residue at R's hash SURVIVES (never unlinked)`, fs.existsSync(xTmp));
      const dirSnapshot = snapshotDir(mod.MERGE_QUARANTINE_DIR);
      const inProcess = mod.stillBlockedEntryFor(x);
      check(`*** THE FIX (${route}) *** X is ARMED in-process right after the clear, with X's OWN tokens`, inProcess !== undefined && sortedTokens(inProcess) === JSON.stringify([xToken]));
      if (route === "token") {
        // The token route has no co-occupant report (1be24e71): it returns `{lifted, stillBlockedBy?}`, which names the armed X.
        check(`(${route} main) ...and the token result discloses P is still blocked, by X`, result?.lifted === true && result?.stillBlockedBy?.repoPath === x);
      } else {
        check(`(${route} main) ...and surfaced as a routable still-blocked co-occupant`, !!result.stillBlockedCoOccupants?.some((c) => c.repoPath === x));
      }
      restoreDirSnapshot(mod.MERGE_QUARANTINE_DIR, dirSnapshot);
      const fresh = await freshBootModule();
      fresh.reenterMergeQuarantinesAtBoot([p, r]);
      const reboot = fresh.stillBlockedEntryFor(x);
      check(`*** THE GOVERNING INVARIANT (${route}) *** in-process token set === post-reboot token set`, inProcess !== undefined && reboot !== undefined && sortedTokens(inProcess) === sortedTokens(reboot));
      restoreDirSnapshot(mod.MERGE_QUARANTINE_DIR, dirSnapshot);
    }

    // ═══ (R-OCCUPIED-NEG) -- R (where X's residue is misfiled) is ALSO independently quarantined: X still arms,
    // and R's own in-memory entry and on-disk latch are byte-for-byte unchanged.
    {
      const { p, tok } = makeResolvablePending(`rocc-${route}`);
      const r = makeRepo(`rocc-r-${route}`);
      const keyR = canonicalRepoLockKey(r);
      const x = path.join(p, `ghost-rocc-${route}`);
      fs.mkdirSync(x, { recursive: true });
      const rToken = enterMergeQuarantine(r, "loom/r-branch", "r's own real, UNRELATED, STILL-LIVE raise");
      const xToken = randomUUID();
      plantTmpResidue(keyR, x, "loom/x-branch", "X's stray tmp on R's hash", [xToken], `82${route.length}02-cafef702`);
      const rLatchPath = path.join(mod.MERGE_QUARANTINE_DIR, `${hashOf(keyR)}.json`);
      const rBytesBefore = fs.readFileSync(rLatchPath);
      const rTokensBefore = sortedTokens(mod.stillBlockedEntryFor(r));
      clear(p, tok);
      const inProcessX = mod.stillBlockedEntryFor(x);
      check(`*** THE FIX (${route} rocc) *** X armed in-process even with R occupying R's own hash`, inProcessX !== undefined && inProcessX.tokens.includes(xToken));
      check(`(${route} rocc) R's in-memory token set unchanged`, sortedTokens(mod.stillBlockedEntryFor(r)) === rTokensBefore && mod.stillBlockedEntryFor(r).tokens.includes(rToken));
      check(`(${route} rocc) R's on-disk latch BYTE-FOR-BYTE unchanged`, Buffer.compare(rBytesBefore, fs.readFileSync(rLatchPath)) === 0);
      mod.clearMergeQuarantine(r);
    }

    // ═══ (SCOPE-NEG) -- exact key match only. W = Z/ghost (Z independently quarantined) has residue misfiled
    // under R's hash; clearing an unrelated pending P must leave it untouched and Z's entry unmodified.
    {
      const { p, tok } = makeResolvablePending(`scope-${route}`);
      const z = makeRepo(`scope-z-${route}`);
      const r = makeRepo(`scope-r-${route}`);
      const keyR = canonicalRepoLockKey(r);
      const w = path.join(z, `ghost-scope-${route}`);
      fs.mkdirSync(w, { recursive: true });
      enterMergeQuarantine(z, "loom/z-branch", "z's own real raise");
      const zTokensBefore = sortedTokens(mod.stillBlockedEntryFor(z));
      const wTmp = plantTmpResidue(keyR, w, "loom/w-branch", "W's stray tmp on R's hash", [randomUUID()], `82${route.length}03-cafef703`);
      const wBytes = fs.readFileSync(wTmp);
      const res = clear(p, tok);
      check(`(${route} scope-neg) the clear does not name W or Z`, !res?.stillBlockedCoOccupants?.some((c) => c.repoPath === w || c.repoPath === z) && !res?.contentKeptRepoPaths?.includes(w));
      check(`(${route} scope-neg) W's residue untouched, byte-for-byte`, fs.existsSync(wTmp) && Buffer.compare(wBytes, fs.readFileSync(wTmp)) === 0);
      check(`(${route} scope-neg) Z's entry token set unchanged (W's residue never unioned in)`, sortedTokens(mod.stillBlockedEntryFor(z)) === zTokensBefore);
      mod.clearMergeQuarantine(z);
    }

    // ═══ (UNRESOLVABLE-NEG) -- P stays unresolvable with no informative keys: it frees no key, so an unrelated
    // misfiled residue is left completely untouched by its clear.
    {
      const p = path.join(os.tmpdir(), `loom-mq7aa9-p-unres-${route}-never-exists-${freshSfx()}`); // never created
      const tok = enterMergeQuarantine(p, "loom/p-branch", "p's raise (stays unresolvable)");
      const q = makeRepo(`unres-q-${route}`);
      const r = makeRepo(`unres-r-${route}`);
      const qTmp = plantTmpResidue(canonicalRepoLockKey(r), q, "loom/q-branch", "Q's stray tmp on R's hash", [randomUUID()], `82${route.length}04-cafef704`);
      clear(p, tok);
      check(`(${route} unres-neg) P lifted`, !mod.listPendingMergeQuarantinesTestOnly().some((e) => e.repoPath === p));
      check(`(${route} unres-neg) unrelated Q residue untouched and Q not armed`, fs.existsSync(qTmp) && mod.stillBlockedEntryFor(q) === undefined);
    }

    // ═══ (TIER4) -- P is UNRESOLVABLE with an informative resolvedKey K_r (repo C) that DIFFERS from its degraded
    // walked-up key K_d (repo B: P = B/ghost). A foreign residue X = B/ghost-x collapsing onto K_d must be armed on
    // P's clear and match a reboot; Y = C/ghost-y collapsing onto K_r must NOT be reported as freed.
    {
      const b = makeRepo(`t4-b-${route}`);
      const c = makeRepo(`t4-c-${route}`);
      const r = makeRepo(`t4-r-${route}`);
      const keyB = canonicalRepoLockKey(b);
      const keyC = canonicalRepoLockKey(c);
      const keyR = canonicalRepoLockKey(r);
      const pPath = path.join(b, `never-exists-ghost-p-${route}`);
      const x = path.join(b, `ghost-x-t4-${route}`);
      const y = path.join(c, `ghost-y-t4-${route}`);
      fs.mkdirSync(x, { recursive: true });
      fs.mkdirSync(y, { recursive: true });
      const pTok = randomUUID();
      const s = makeRepo(`t4-s-${route}`);
      const keyS = canonicalRepoLockKey(s);
      enterMergeQuarantine(s, "loom/s-branch", "S's own real raise, cleared to sweep P's residue into pending");
      const pTmp = path.join(mod.MERGE_QUARANTINE_DIR, `${hashOf(keyS)}.json.tmp-82${route.length}05-cafef705`);
      fs.writeFileSync(pTmp, JSON.stringify({ repoPath: pPath, branch: "loom/p-branch", reason: "P's raise", enteredAt: Date.now() - 2000, tokens: [pTok], resolvedKey: keyC }, null, 2) + "\n");
      mod.clearMergeQuarantine(s);
      const pEntry = mod.listPendingMergeQuarantinesTestOnly().find((e) => e.repoPath === pPath);
      check(`(${route} tier4 precondition) P is a PENDING entry with informative key K_r != K_d`, !!pEntry && keyC !== keyB && canonicalRepoLockKey(pPath) === keyB && !fs.existsSync(pPath));
      if (pEntry) {
        const xTok = randomUUID();
        const yTok = randomUUID();
        const xTmp = plantTmpResidue(keyR, x, "loom/x-branch", "X's stray tmp on R's hash", [xTok], `82${route.length}06-cafef706`);
        const yTmp = plantTmpResidue(keyR, y, "loom/y-branch", "Y's stray tmp on R's hash", [yTok], `82${route.length}07-cafef707`);
        check(`(${route} tier4 precondition) X is enforced via P's tier-4 match on K_d`, mod.stillBlockedEntryFor(x) !== undefined);
        const res = clear(pPath, pTok);
        check(`(${route} tier4) both residues survive on disk`, fs.existsSync(xTmp) && fs.existsSync(yTmp));
        const dirSnapshot = snapshotDir(mod.MERGE_QUARANTINE_DIR);
        const inProcessX = mod.stillBlockedEntryFor(x);
        check(`*** THE FIX (${route} tier4) *** X (collapsing onto K_d) is ARMED in-process after P's clear`, inProcessX !== undefined && inProcessX.tokens.includes(xTok));
        check(`(${route} tier4) Y (collapsing onto K_r) is NOT reported as freed by this clear`, !res?.stillBlockedCoOccupants?.some((cc) => cc.repoPath === y) && !res?.contentKeptRepoPaths?.includes(y));
        restoreDirSnapshot(mod.MERGE_QUARANTINE_DIR, dirSnapshot);
        const fresh = await freshBootModule();
        fresh.reenterMergeQuarantinesAtBoot([b, c, r]);
        const rebootX = fresh.stillBlockedEntryFor(x);
        check(`*** THE GOVERNING INVARIANT (${route} tier4) *** X blocked in-process === post-reboot, same tokens`, inProcessX !== undefined && rebootX !== undefined && sortedTokens(inProcessX) === sortedTokens(rebootX));
        restoreDirSnapshot(mod.MERGE_QUARANTINE_DIR, dirSnapshot);
      }
    }
  }

  // ═══ (ORDER) -- the cross-hash sweep runs AFTER the cleared entry's own tombstone, and its keep never
  // withholds that tombstone (by-id's ordering): (a) P's token IS durably tombstoned although the sweep armed
  // foreign X; (b) a foreign residue that ALSO holds P's just-cleared token is not armed with that token.
  const sidecar = () => {
    const sp = path.join(process.env.LOOM_HOME, "merge-quarantine-cleared-tokens.dat");
    return fs.existsSync(sp) ? JSON.parse(fs.readFileSync(sp, "utf8")) : {};
  };
  for (const route of ["path", "recorded", "token"]) {
    const clear = ROUTES[route];
    {
      const { p, tok } = makeResolvablePending(`ordA-${route}`);
      const r = makeRepo(`ordA-r-${route}`);
      const x = path.join(p, `ghost-orda-${route}`);
      fs.mkdirSync(x, { recursive: true });
      const xToken = randomUUID();
      plantTmpResidue(canonicalRepoLockKey(r), x, "loom/x-branch", "X stray", [xToken], `83${route.length}01-cafef801`);
      clear(p, tok);
      const armed = mod.stillBlockedEntryFor(x);
      check(`(${route} order-a) the sweep armed foreign X`, armed !== undefined && armed.tokens.includes(xToken));
      // The by-key route (`path`) used to withhold P's durable tombstone here (card 1fb27e46, fixed): its
      // content keep for X named the leaving P as blocker, and is now re-derived before the tombstone decision.
      check(`*** ORDER (${route} order-a) *** P's token IS durably tombstoned although the sweep armed X`, Object.prototype.hasOwnProperty.call(sidecar(), tok));
      const dirSnapshot = snapshotDir(mod.MERGE_QUARANTINE_DIR);
      const fresh = await freshBootModule();
      fresh.reenterMergeQuarantinesAtBoot([p, r]);
      const rebootX = fresh.stillBlockedEntryFor(x);
      check(`(${route} order-a) after a reboot X is still armed and P's token is not resurrected`, rebootX !== undefined && rebootX.tokens.includes(xToken) && !rebootX.tokens.includes(tok));
      restoreDirSnapshot(mod.MERGE_QUARANTINE_DIR, dirSnapshot);
    }
    {
      const { p, tok } = makeResolvablePending(`ordB-${route}`);
      const r = makeRepo(`ordB-r-${route}`);
      const x = path.join(p, `ghost-ordb-${route}`);
      fs.mkdirSync(x, { recursive: true });
      const xToken = randomUUID();
      plantTmpResidue(canonicalRepoLockKey(r), x, "loom/x-branch", "X stray holding one of P's tokens too", [xToken, tok], `83${route.length}02-cafef802`);
      clear(p, tok);
      const armed = mod.stillBlockedEntryFor(x);
      // X's residue genuinely still holds `tok` on disk, so `tombstoneIfNotSurviving` correctly keeps it (the
      // by-id route arms X with both tokens too, verified); the invariant is parity with a fresh boot.
      const dirSnapshot = snapshotDir(mod.MERGE_QUARANTINE_DIR);
      const fresh = await freshBootModule();
      fresh.reenterMergeQuarantinesAtBoot([p, r]);
      const rebootX = fresh.stillBlockedEntryFor(x);
      check(`*** ORDER (${route} order-b) *** X holding one of P's tokens: in-process token set === post-reboot token set`, armed !== undefined && rebootX !== undefined && sortedTokens(armed) === sortedTokens(rebootX) && armed.tokens.includes(xToken));
      restoreDirSnapshot(mod.MERGE_QUARANTINE_DIR, dirSnapshot);
    }
  }

  // ═══ (HASH-FALLBACK) -- a removed pending entry whose sourceFile basename does not match `<stem>.json[.tmp-*]`
  // (sourceFile is typed `string`, so "no sourceFile" means "unmatched basename") sweeps at the hash Loom would
  // write for its canonical key: a deletable same-hash tmp residue there must be removed.
  {
    const p = makeRepo("fallback-p");
    const tokP = randomUUID();
    mod.pushPendingQuarantineTestOnly({ repoPath: p, branch: "loom/p-branch", reason: "odd sourceFile", enteredAt: Date.now() - 5000, tokens: [tokP] }, "odd-unmatched-name.dat");
    const stale = plantTmpResidue(canonicalRepoLockKey(p), p, "loom/p-branch", "P's own stale tmp at its key hash", [tokP], "83901-cafef803");
    mod.clearMergeQuarantineByRecordedPath(p);
    check("(hash-fallback) P's pending entry is gone", !mod.listPendingMergeQuarantinesTestOnly().some((e) => e.repoPath === p));
    check("*** HASH-FALLBACK *** the same-hash tmp at quarantineHashForKey(canonicalKey(P)) was swept", !fs.existsSync(stale));
  }

  // ═══ (MULTI-ENTRY) -- two removed pending entries of one identity: both distinct own-latch hashes are swept
  // (each one's deletable tmp goes), a shared hash is swept without error, and foreign X is armed once with
  // exactly its own tokens. (Dedupe itself is not observable beyond this result equivalence.)
  for (const shared of [false, true]) {
    const { p, tok } = makeResolvablePending(`multi-${shared}`);
    const r = makeRepo(`multi-r-${shared}`);
    const x = path.join(p, `ghost-multi-${shared}`);
    fs.mkdirSync(x, { recursive: true });
    const xToken = randomUUID();
    plantTmpResidue(canonicalRepoLockKey(r), x, "loom/x-branch", "X stray", [xToken], `83${shared ? 3 : 2}01-cafef804`);
    // P's own original pending entry is cleared by the same call; add a SECOND same-identity pending entry.
    const tok2 = randomUUID();
    const stemA = createHash("sha256").update(`multi-a-${freshSfx()}`).digest("hex").slice(0, 24);
    const stemB = shared ? stemA : createHash("sha256").update(`multi-b-${freshSfx()}`).digest("hex").slice(0, 24);
    mod.pushPendingQuarantineTestOnly({ repoPath: p, branch: "loom/p-branch-2", reason: "second same-identity pending", enteredAt: Date.now() - 4000, tokens: [tok2] }, `${stemA}.json`);
    mod.pushPendingQuarantineTestOnly({ repoPath: p, branch: "loom/p-branch-3", reason: "third same-identity pending", enteredAt: Date.now() - 3000, tokens: [tok] }, `${stemB}.json`);
    const tA = path.join(mod.MERGE_QUARANTINE_DIR, `${stemA}.json.tmp-83901-cafef805`);
    fs.writeFileSync(tA, JSON.stringify({ repoPath: p, branch: "b", reason: "r", enteredAt: Date.now() - 1000, tokens: [tok2] }) + "\n");
    const tB = path.join(mod.MERGE_QUARANTINE_DIR, `${stemB}.json.tmp-83901-cafef806`);
    fs.writeFileSync(tB, JSON.stringify({ repoPath: p, branch: "b", reason: "r", enteredAt: Date.now() - 1000, tokens: [tok] }) + "\n");
    mod.clearMergeQuarantineByRecordedPath(p);
    check(`(multi ${shared ? "shared" : "distinct"} hash) every removed entry's same-hash tmp is swept`, !fs.existsSync(tA) && !fs.existsSync(tB));
    const armed = mod.stillBlockedEntryFor(x);
    check(`(multi ${shared ? "shared" : "distinct"} hash) foreign X armed once with exactly its own tokens`, armed !== undefined && sortedTokens(armed) === JSON.stringify([xToken]));
  }
} finally {
  process.exitCode = failures === 0 ? 0 : 1;
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
}
