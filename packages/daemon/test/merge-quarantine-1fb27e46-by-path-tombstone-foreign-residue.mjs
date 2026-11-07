import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// The by-path clear (`clearMergeQuarantine` -> `clearMergeQuarantineByKey`) withheld P's durable tombstone
// when a foreign residue X sat under P, because X's content keep was classified as blocked by P BEFORE the
// pending loop dropped P. The keep is re-derived before the one push-time decision: retracted only if its
// sole blocker is the leaving identity, nothing of that identity survives, and the kept file holds none of
// the cleared tokens (fail-closed otherwise).
//
// @decision 1fb27e46
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq1fb-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);
const mod = await import(mergeQuarantineModuleHref);
const { enterMergeQuarantine } = mod;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const GIT_ID = "-c user.email=mq1fb@loom -c user.name=mq1fb";
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const hashOf = (key) => createHash("sha256").update(key).digest("hex").slice(0, 24);
const sortedTokens = (e) => (e ? JSON.stringify([...e.tokens].sort()) : undefined);

function initRepoAt(dir, tag) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), `# merge-quarantine-1fb27e46 (${tag})\n`);
  execSync(`git init -q && git config user.email mq1fb@loom && git config user.name mq1fb`, { cwd: dir });
  commitAll(dir, "init", GIT_ID);
}
function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mq1fb-repo-${tag}-${freshSfx()}`);
  initRepoAt(repo, tag);
  return repo;
}
function plantTmpResidue(key, repoPath, tokens, suffix) {
  fs.mkdirSync(mod.MERGE_QUARANTINE_DIR, { recursive: true });
  const tmpPath = path.join(mod.MERGE_QUARANTINE_DIR, `${hashOf(key)}.json.tmp-${suffix}`);
  fs.writeFileSync(tmpPath, JSON.stringify({ repoPath, branch: "loom/x-branch", reason: "X's stray tmp, misfiled onto R's hash", enteredAt: Date.now() - 1000, tokens }, null, 2) + "\n");
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
const sidecar = () => {
  const sp = path.join(process.env.LOOM_HOME, "merge-quarantine-cleared-tokens.dat");
  return fs.existsSync(sp) ? JSON.parse(fs.readFileSync(sp, "utf8")) : {};
};
const tombstoned = (tok) => Object.prototype.hasOwnProperty.call(sidecar(), tok);
let bootCounter = 0;
async function freshBootModule() {
  bootCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootCounter}`);
}
// A PENDING entry that is resolvable NOW: raised while its path does not exist, then the repo materialises.
function makeResolvablePending(tag) {
  const p = path.join(os.tmpdir(), `loom-mq1fb-p-${tag}-${freshSfx()}`);
  const tok = enterMergeQuarantine(p, "loom/p-branch", "p's own raise, while its path did not resolve");
  initRepoAt(p, tag);
  return { p, tok };
}
const directIdentityEq = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const quiet = (fn) => {
  const e = console.error, w = console.warn;
  console.error = () => {}; console.warn = () => {};
  try { return fn(); } finally { console.error = e; console.warn = w; }
};

try {
  // ═══ (A) order-a -- X's residue holds only X's own token: P's token IS durably tombstoned, X is armed
  // in-process, is reported ONCE (a co-occupant, never also a content keep blocked by the released P), and a
  // fresh boot of the same bytes agrees.
  {
    const { p, tok } = makeResolvablePending("a");
    const r = makeRepo("a-r");
    const x = path.join(p, "ghost-a");
    fs.mkdirSync(x, { recursive: true });
    const xToken = randomUUID();
    plantTmpResidue(canonicalRepoLockKey(r), x, [xToken], "9101-cafe1fb1");
    check("(A precondition) X is enforced via P's pending tier before the clear", mod.stillBlockedEntryFor(x) !== undefined);
    const res = quiet(() => mod.clearMergeQuarantine(p));
    const armed = mod.stillBlockedEntryFor(x);
    check("*** THE FIX (A) *** P's token IS durably tombstoned although X sat under P", tombstoned(tok));
    check("(A) X armed in-process with exactly its own token", armed !== undefined && sortedTokens(armed) === JSON.stringify([xToken]));
    check("(A) X is a still-blocked co-occupant", !!res.stillBlockedCoOccupants?.some((c) => c.repoPath === x));
    check("*** RESULT SHAPE (A) *** X is NOT also listed as a content keep blocked by the released P", !res.contentKeptRepoPaths?.includes(x) && !res.contentKeptBlockedBy?.some((b) => b.repoPath === x));
    const dirSnapshot = snapshotDir(mod.MERGE_QUARANTINE_DIR);
    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([p, r]);
    const rebootX = fresh.stillBlockedEntryFor(x);
    check("(A) after a reboot X is armed with the same tokens and P's token is not resurrected", rebootX !== undefined && sortedTokens(rebootX) === sortedTokens(armed) && !rebootX.tokens.includes(tok));
    restoreDirSnapshot(mod.MERGE_QUARANTINE_DIR, dirSnapshot);
  }

  // ═══ (B) clause (c) -- X's residue ALSO holds P's cleared token: the keep must keep withholding the tombstone.
  {
    const { p, tok } = makeResolvablePending("b");
    const r = makeRepo("b-r");
    const x = path.join(p, "ghost-b");
    fs.mkdirSync(x, { recursive: true });
    const xToken = randomUUID();
    plantTmpResidue(canonicalRepoLockKey(r), x, [xToken, tok], "9102-cafe1fb2");
    const res = quiet(() => mod.clearMergeQuarantine(p));
    const armed = mod.stillBlockedEntryFor(x);
    check("*** CLAUSE (c) (B) *** P's token is NOT tombstoned while X's residue still holds it", !tombstoned(tok));
    check("(B) X armed (holding both tokens, as at HEAD)", armed !== undefined && armed.tokens.includes(xToken) && armed.tokens.includes(tok));
    check("(B) the result still discloses X", !!res.stillBlockedCoOccupants?.some((c) => c.repoPath === x) || !!res.contentKeptRepoPaths?.includes(x));
  }

  // ═══ (B2) clause (c), X already ARMED and tracked before the clear (armed by an earlier clear of a sibling
  // pending entry P1 on the same key), its residue holding P's token: still withheld.
  {
    const p = path.join(os.tmpdir(), `loom-mq1fb-p-b2-${freshSfx()}`);
    const tok = enterMergeQuarantine(p, "loom/p-branch", "p's own raise, while its path did not resolve");
    const p1 = path.join(p, "sibling-pending");
    enterMergeQuarantine(p1, "loom/p1-branch", "a same-key sibling's raise, pending too");
    initRepoAt(p, "b2");
    const r = makeRepo("b2-r");
    const x = path.join(p, "ghost-b2");
    fs.mkdirSync(x, { recursive: true });
    const xToken = randomUUID();
    plantTmpResidue(canonicalRepoLockKey(r), x, [xToken, tok], "9103-cafe1fb3");
    // Arm X first through the recorded-path route of an unrelated same-key pending sibling.
    quiet(() => mod.clearMergeQuarantineByRecordedPath(p1));
    const armedBefore = mod.stillBlockedEntryFor(x);
    check("(B2 precondition) X was armed by the sibling's clear, with its residue holding P's token, and P is still pending", armedBefore !== undefined && armedBefore.tokens.includes(tok) && mod.listPendingMergeQuarantinesTestOnly().some((e) => e.repoPath === p));
    quiet(() => mod.clearMergeQuarantine(p));
    check("*** CLAUSE (c) (B2) *** with X pre-armed/tracked and holding P's token, P's token is NOT tombstoned", !tombstoned(tok));
  }

  // ═══ (C) clause (b) -- a same-identity pending TWIN survives the clear (reduced), so the leaving-identity
  // exemption must NOT fire: neither token is tombstoned and the twin survives (unchanged from HEAD).
  {
    const p = path.join(os.tmpdir(), `loom-mq1fb-p-c-${freshSfx()}`);
    initRepoAt(p, "c");
    const t1 = enterMergeQuarantine(p, "loom/p1", "raise 1 (resolvable -> active)");
    const key = canonicalRepoLockKey(p);
    const t3 = randomUUID();
    mod.pushPendingQuarantineTestOnly({ repoPath: p, branch: "loom/p3", reason: "twin", enteredAt: Date.now() - 5000, tokens: [t3], armedKeys: [key] }, `${hashOf(`twin-${freshSfx()}`)}.json`);
    const r = makeRepo("c-r");
    const x = path.join(p, "ghost-c");
    fs.mkdirSync(x, { recursive: true });
    plantTmpResidue(canonicalRepoLockKey(r), x, [randomUUID()], "9104-cafe1fb4");
    const twinsBefore = mod.listPendingMergeQuarantinesTestOnly().filter((e) => e.repoPath === p).length;
    const res = quiet(() => mod.clearMergeQuarantine(p));
    const twinsAfter = mod.listPendingMergeQuarantinesTestOnly().filter((e) => e.repoPath === p).length;
    check("(C precondition) the twin existed and SURVIVES the by-path clear", twinsBefore === 1 && twinsAfter === 1);
    check("*** CLAUSE (b) (C) *** X is STILL disclosed as a content keep blocked by P's surviving twin (never silently dropped)", !!res.contentKeptRepoPaths?.includes(x) && (res.contentKeptBlockedBy ?? []).some((b) => b.repoPath === x && directIdentityEq(b.blockedBy.repoPath, p)));
    // Characterization of current behaviour (not a requirement): the surviving twin keeps both tokens untombstoned.
    check("(C, characterization) neither token is tombstoned while the twin survives", !tombstoned(t1) && !tombstoned(t3));
  }

  // ═══ (D) the RE-ADD path -- the keep is retracted (P is the sole blocker named), but the sweep cannot arm X
  // because a SURVIVING pending W (= P/mid) still encloses it. X must still be disclosed, exactly once, now
  // blocked by W, while P's token is tombstoned.
  {
    const p = path.join(os.tmpdir(), `loom-mq1fb-p-d-${freshSfx()}`);
    const tok = enterMergeQuarantine(p, "loom/p-branch", "p's own raise");
    const w = path.join(p, "mid");
    enterMergeQuarantine(w, "loom/w-branch", "W's raise, pending, sits under P");
    initRepoAt(p, "d");
    const r = makeRepo("d-r");
    const x = path.join(w, "ghost-d");
    fs.mkdirSync(x, { recursive: true });
    plantTmpResidue(canonicalRepoLockKey(r), x, [randomUUID()], "9105-cafe1fb5");
    const res = quiet(() => mod.clearMergeQuarantine(p));
    check("(D) P's token IS durably tombstoned", tombstoned(tok));
    check("(D) W still blocks (it survives P's clear)", mod.stillBlockedEntryFor(w) !== undefined);
    const keptOnce = (res.contentKeptRepoPaths ?? []).filter((rp) => rp === x).length;
    check("*** RE-ADD (D) *** X is still disclosed as a content keep EXACTLY once", keptOnce === 1);
    const by = (res.contentKeptBlockedBy ?? []).filter((b) => b.repoPath === x);
    check("(D) ...blocked by W (the survivor), never by the released P", by.length === 1 && by[0].blockedBy.repoPath === w);
    check("(D) ...and not also reported as a still-blocked co-occupant", !(res.stillBlockedCoOccupants ?? []).some((c) => c.repoPath === x));
  }
} finally {
  process.exitCode = failures === 0 ? 0 : 1;
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
}
