import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card d2592cd5. Confirmed pre-existing on main by probe in the e1572b69 Code Review (reviewer
// bc7d387f), built on 5332762e/e1572b69's own established fixtures.
//
// Repro (per the card): raise t1, t2, t3 for an unresolvable repo. Clear t1 with the primary rename
// failing (5332762e tracks the stranded tmp). Clear t2 with the orphan-tmp rewrite failing (e1572b69
// tracks the SECOND stranded tmp, leaving the ORIGINAL orphan tmp stale — still holding [t2,t3]). Reboot
// BEFORE clearing t3 (unlike 5332762e/e1572b69's own tests, which reboot only AFTER a full lift — this
// card's own "Do not" explicitly reserves the mid-sequence reboot for THIS card). Boot used to produce
// THREE independent records for the one identity (never unified), and the stale record's own [t2] token
// resurrected after clearing the only token the operator could see (t3) — permanently, with no further
// clear able to reach it.
//
// The fix: a durable, identity-scoped, token-level tombstone (merge-quarantine-cleared-tokens.dat, a
// sibling of MERGE_QUARANTINE_DIR under LOOM_HOME — never inside it), written ONLY when a clear's own
// narrowing write durably succeeds, seeded into the in-memory `clearedTokens` map at boot (before any
// latch file is read), and subtracted from every boot-time raw token read.
//
// @decision d2592cd5 — never write this durable tombstone unconditionally; gate it on the clear's own
// narrowing write having durably succeeded, never on the generic in-memory tombstone call alone.
//
// Per decision 59e758e5's own "Do not" list: never call a resolve-aware query (`activeMergeQuarantineFor`/
// `resolveQuarantineFor`) between an injected write failure/clear and a later durable assertion — that
// chokepoint's own "lazy re-resolve on first query" self-heal can mask the exact loss/resurrection this
// test exists to prove. Every check below reads either the quarantine dir's own on-disk CONTENT directly,
// or `listActiveMergeQuarantines()`/`stillBlockedEntryFor` (a pure peek, never self-healing).
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-d2592cd5-reboot-between-clears.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

const loomHome = useOwnLoomHome("loom-mqd2592cd5-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const mod = await import(mergeQuarantineModuleHref);
const {
  enterMergeQuarantine, clearMergeQuarantineByToken, clearMergeQuarantineByRecordedPath, clearMergeQuarantineByKey, clearMergeQuarantineLatchFile,
  setActiveQuarantineTestOnly, pushPendingQuarantineTestOnly,
  listActiveMergeQuarantines, stillBlockedEntryFor, directPathIdentity, MERGE_QUARANTINE_DIR,
} = mod;
const GIT_ID_D2592CD5 = "-c user.email=mqd2592cd5@loom -c user.name=mqd2592cd5";

// A REAL, resolvable git repo (unlike every other scenario's deliberately UNRESOLVABLE path) — needed so
// a raise ARMS directly into `activeQuarantines` (hits `clearActiveEntryTokenAtKey`/`clearMergeQuarantineByKey`
// on a clear) rather than staying pending-only.
function makeResolvableRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqd2592cd5-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), `# ${tag}\n`);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "mqd2592cd5@loom"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "mqd2592cd5"], { cwd: repo });
  commitAll(repo, "init", GIT_ID_D2592CD5);
  return repo;
}
const repoLockModuleHref = pathToFileURL(path.join(distGitDir, "repo-lock.js")).href;
const { literalRepoPathKey, canonicalRepoLockKey } = await import(repoLockModuleHref);
function quarantineHashForKeyTest(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}
function pendingLatchIdForTest(sourceFile) {
  return createHash("sha256").update(sourceFile).digest("hex").slice(0, 24);
}

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function injectRenameFaultAt(targetPath) {
  const realRename = fs.renameSync;
  let hits = 0;
  fs.renameSync = (a, b) => {
    if (b === targetPath) {
      hits++;
      throw Object.assign(new Error("EPERM: simulated rename failure"), { code: "EPERM" });
    }
    return realRename(a, b);
  };
  return { restore: () => { fs.renameSync = realRename; }, hits: () => hits };
}

// Faults every rename whose TARGET sits directly under LOOM_HOME (never inside MERGE_QUARANTINE_DIR,
// a subdirectory of it) — isolates the tombstone sidecar's own write-tmp-then-rename from every ordinary
// quarantine-latch rename, which all target MERGE_QUARANTINE_DIR itself.
function injectTombstoneWriteFault() {
  const realRename = fs.renameSync;
  let hits = 0;
  fs.renameSync = (a, b) => {
    if (path.dirname(b) === loomHome && path.basename(b) === "merge-quarantine-cleared-tokens.dat") {
      hits++;
      throw Object.assign(new Error("EPERM: simulated tombstone sidecar rename failure"), { code: "EPERM" });
    }
    return realRename(a, b);
  };
  return { restore: () => { fs.renameSync = realRename; }, hits: () => hits };
}

// Faults a single unlinkSync call whose target is exactly `targetPath` — used to force
// `sweepOwnLatchFileUnlessOwnedElsewhere`'s own unlink-confirmation check to fail, so a pending entry's
// own sourceFile is reported KEPT even though nothing else legitimately owns it.
function injectUnlinkFaultAt(targetPath) {
  const realUnlink = fs.unlinkSync;
  let hits = 0;
  fs.unlinkSync = (p) => {
    if (p === targetPath) {
      hits++;
      throw Object.assign(new Error("EPERM: simulated unlink failure"), { code: "EPERM" });
    }
    return realUnlink(p);
  };
  return { restore: () => { fs.unlinkSync = realUnlink; }, hits: () => hits };
}

// Faults every readFileSync call whose target is exactly `targetPath` — simulates a genuinely
// unreadable (EACCES) file for `identityHasAnyPhysicalRecordHoldingToken`'s / `identityHasAnyPhysicalRecordOnDisk`'s
// own disk re-scan, which must both treat an unreadable file as "might still hold the token" (fail-closed).
function injectReadFaultAt(targetPath) {
  const realReadFileSync = fs.readFileSync;
  let hits = 0;
  fs.readFileSync = (p, enc) => {
    if (p === targetPath) {
      hits++;
      throw Object.assign(new Error("EACCES: simulated unreadable file"), { code: "EACCES" });
    }
    return realReadFileSync(p, enc);
  };
  return { restore: () => { fs.readFileSync = realReadFileSync; }, hits: () => hits };
}

// Card 6bdd2e87 — faults every readdirSync call whose target is exactly `targetDir` (MERGE_QUARANTINE_DIR
// for both call sites below) — simulates a transient directory-listing failure (EMFILE) on
// `identityHasAnyPhysicalRecordHoldingToken`'s / `identityHasAnyPhysicalRecordOnDisk`'s own FIRST fs
// call (the readdir itself, before either function ever gets to look at a single file) — a different
// branch than Scenario M3/M2's per-file readFileSync EACCES above, which only fires once the readdir
// has already succeeded. Every OTHER `fs.readdirSync(MERGE_QUARANTINE_DIR)` call this module makes
// during a clear (the tmp-residue sweeps) already fails SOFT on its own catch (an empty/safe default,
// never a re-thrown error it would need to survive), so faulting the real `fs.readdirSync` for the
// whole clear call never breaks the clear's own writes.
function injectReaddirFaultAt(targetDir, code = "EMFILE") {
  const realReaddirSync = fs.readdirSync;
  let hits = 0;
  fs.readdirSync = (p, ...rest) => {
    if (p === targetDir) {
      hits++;
      throw Object.assign(new Error(`${code}: simulated readdir failure`), { code });
    }
    return realReaddirSync(p, ...rest);
  };
  return { restore: () => { fs.readdirSync = realReaddirSync; }, hits: () => hits };
}

function readTokensOnDisk(basename) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, basename), "utf8"));
    return Array.isArray(parsed.tokens) ? parsed.tokens : undefined;
  } catch {
    return undefined;
  }
}
const sameTokenSet = (a, b) => a !== undefined && b !== undefined && a.length === b.length && new Set(a).size === a.length && a.every((t) => b.includes(t));

let bootReimportCounter = 0;
async function rebootSim() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?bd2592cd5=${bootReimportCounter}`);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO A — the card's own exact sequence: raise t1,t2,t3; clear t1 (primary rename fails); clear t2
// (ONLY the orphan-rewrite fails, outer write succeeds); REBOOT BEFORE clearing t3; clear t3 through the
// rebooted module. *** THE CARD'S OWN REPRO, CLOSED: no resurrection. ***
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const d = path.join(os.tmpdir(), `loom-mqd2592cd5-a-never-exists-${freshSfx()}`);
  const t1 = enterMergeQuarantine(d, "loom/d2592cd5-a-1", "d2592cd5-a: raise 1 (t1)");
  const t2 = enterMergeQuarantine(d, "loom/d2592cd5-a-2", "d2592cd5-a: raise 2 (t2)");
  const t3 = enterMergeQuarantine(d, "loom/d2592cd5-a-3", "d2592cd5-a: raise 3 (t3)");

  const filesBefore = fs.readdirSync(MERGE_QUARANTINE_DIR);
  const sourceFile = filesBefore.find((f) => f.endsWith(".json") && sameTokenSet(readTokensOnDisk(f), [t1, t2, t3]));
  check("(precondition) found the primary pending-divert file on disk holding t1,t2,t3", typeof sourceFile === "string");
  const sourcePath = path.join(MERGE_QUARANTINE_DIR, sourceFile);

  const injectT1 = injectRenameFaultAt(sourcePath);
  try { clearMergeQuarantineByToken(d, t1); } finally { injectT1.restore(); }
  check("(precondition) the primary rename was forced to fail exactly once", injectT1.hits() === 1);

  const filesAfterT1 = fs.readdirSync(MERGE_QUARANTINE_DIR);
  const orphanTmp = filesAfterT1.find((f) => f !== sourceFile);
  check("(precondition) a tracked orphan tmp exists after t1's failed primary write", typeof orphanTmp === "string");

  const orphanPath = path.join(MERGE_QUARANTINE_DIR, orphanTmp);
  const injectT2 = injectRenameFaultAt(orphanPath);
  try { clearMergeQuarantineByToken(d, t2); } finally { injectT2.restore(); }
  check("(precondition) the orphan-rewrite's own rename was forced to fail exactly once", injectT2.hits() === 1);
  check("(precondition, by content) the primary's own OUTER write succeeded — durably narrowed to [t3]", sameTokenSet(readTokensOnDisk(sourceFile), [t3]));
  check("(precondition, by content) the ORIGINAL orphan tmp is untouched — still stale, holding [t2,t3]", sameTokenSet(readTokensOnDisk(orphanTmp), [t2, t3]));

  // Step 4: reboot BEFORE clearing t3 — the card's own distinguishing step.
  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([d]);

  const listedAfterBoot = rb.listActiveMergeQuarantines().filter((e) => e.repoPath === d);
  check("*** THE FIX *** every boot-time record for d now holds ONLY t3 — the durable tombstone subtracted the already-cleared t2 from the stale orphan copy", listedAfterBoot.length > 0 && listedAfterBoot.every((e) => sameTokenSet(e.tokens, [t3])));

  const stillBlockedRightAfterBoot = rb.stillBlockedEntryFor(d);
  check("(precondition) stillBlockedEntryFor(d) reads [t3] right after boot", stillBlockedRightAfterBoot !== undefined && sameTokenSet(stillBlockedRightAfterBoot.tokens, [t3]));

  rb.clearMergeQuarantineByToken(d, t3);

  const afterT3Clear = rb.stillBlockedEntryFor(d);
  check("*** THE CARD'S OWN REPRO, CLOSED *** d is genuinely unblocked after clearing t3 — t2 does NOT resurrect", afterT3Clear === undefined);
  const listedAfterT3Clear = rb.listActiveMergeQuarantines().filter((e) => e.repoPath === d);
  check("(by content) no record for d survives the full lift", listedAfterT3Clear.length === 0);
  const filesAfterFullLift = fs.readdirSync(MERGE_QUARANTINE_DIR);
  check("(by content) no latch file for d's own identity survives on disk either", !filesAfterFullLift.some((f) => sameTokenSet(readTokensOnDisk(f), [t2]) || sameTokenSet(readTokensOnDisk(f), [t3]) || sameTokenSet(readTokensOnDisk(f), [t2, t3])));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO B — reboot after step 2 ONLY (the primary rename itself failed; no durable tombstone was
// ever written for t1, since the gate requires the clear's OWN write to have durably succeeded). Proves
// the fix never UNDER-blocks: t1 must still read as outstanding after this reboot — over-blocking,
// exactly the pre-existing, already-accepted posture (5332762e), never a regression.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const d = path.join(os.tmpdir(), `loom-mqd2592cd5-b-never-exists-${freshSfx()}`);
  const t1 = enterMergeQuarantine(d, "loom/d2592cd5-b-1", "d2592cd5-b: raise 1 (t1)");
  const t2 = enterMergeQuarantine(d, "loom/d2592cd5-b-2", "d2592cd5-b: raise 2 (t2)");

  const sourceFile = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => f.endsWith(".json") && sameTokenSet(readTokensOnDisk(f), [t1, t2]));
  const sourcePath = path.join(MERGE_QUARANTINE_DIR, sourceFile);
  const injectT1 = injectRenameFaultAt(sourcePath);
  try { clearMergeQuarantineByToken(d, t1); } finally { injectT1.restore(); }
  check("(b precondition) the primary rename was forced to fail exactly once", injectT1.hits() === 1);
  check("(b precondition, by content) the primary file is untouched (still holds t1,t2 — rename never landed)", sameTokenSet(readTokensOnDisk(sourceFile), [t1, t2]));

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([d]);
  const after = rb.stillBlockedEntryFor(d);
  check("*** NEVER UNDER-BLOCKS *** d still reads blocked by t1 after this reboot — no durable tombstone was ever written for a write that itself failed", after !== undefined && after.tokens.includes(t1));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO C — the durable tombstone sidecar's OWN write fails (the clear's primary write still
// succeeds). Proves: (1) the clear itself never throws/crashes, (2) a later reboot gets NO new
// protection for that one token (over-blocks, never under-blocks — identical posture to Scenario B).
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const d = path.join(os.tmpdir(), `loom-mqd2592cd5-c-never-exists-${freshSfx()}`);
  const t1 = enterMergeQuarantine(d, "loom/d2592cd5-c-1", "d2592cd5-c: raise 1 (t1)");
  const t2 = enterMergeQuarantine(d, "loom/d2592cd5-c-2", "d2592cd5-c: raise 2 (t2)");

  const injectTombstone = injectTombstoneWriteFault();
  let threw;
  try { clearMergeQuarantineByToken(d, t1); } catch (e) { threw = e; } finally { injectTombstone.restore(); }
  check("(c precondition) the tombstone sidecar's own rename was forced to fail at least once", injectTombstone.hits() > 0);
  check("*** NEVER THROWS *** the clear itself completed without throwing despite the tombstone sidecar write failing", threw === undefined);
  check("(c precondition, by content) the clear's own narrowing write still succeeded durably — d now blocked by t2 alone", stillBlockedEntryFor(d) !== undefined && sameTokenSet(stillBlockedEntryFor(d).tokens, [t2]));

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([d]);
  const after = rb.stillBlockedEntryFor(d);
  check("(c, by content) the single surviving record for d holds only t2 — t1 was never durably resurrected (it was never durably present anywhere to begin with, since the narrowing write itself succeeded)", after !== undefined && sameTokenSet(after.tokens, [t2]));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO D — the FOLLOW-UP site: `tryClearMergeQuarantineByOwnIdentity`'s own PENDING-tier branch
// (reached via the exported, identity-wide `clearMergeQuarantineByRecordedPath` — the human clear-by-path
// route for an unresolvable repo) was never gated on a durable write-success signal at all; it called only
// the in-memory `tombstoneIfNotSurviving`. Wired this card's own `tombstoneDurablyIfConfirmed(!pendingAnyKept)`
// gate, mirroring `clearMergeQuarantineByKey`'s established pattern. Proves the durable write is genuinely
// load-bearing: a stray on-disk record for the SAME identity — never tracked by this clear's own
// `orphanLatchFiles` (e.g. independently written after the clear ran) — must not resurrect an
// already-cleared token on a LATER boot.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const d = path.join(os.tmpdir(), `loom-mqd2592cd5-d-never-exists-${freshSfx()}`);
  const t1 = enterMergeQuarantine(d, "loom/d2592cd5-d-1", "d2592cd5-d: raise 1 (t1)");

  const sourceFile = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => f.endsWith(".json") && sameTokenSet(readTokensOnDisk(f), [t1]));
  check("(d precondition) found the pending latch file on disk holding t1 alone", typeof sourceFile === "string");
  const rawShape = fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, sourceFile), "utf8");

  const clearResult = clearMergeQuarantineByRecordedPath(d);
  check("(d precondition) the broad identity-wide clear reports nothing kept", !clearResult.latchKept);
  check("(d precondition) d reads fully unblocked right after the clear", stillBlockedEntryFor(d) === undefined);

  // Plant a STRAY sibling for the SAME identity, under a filename this clear never knew about (never
  // named in anyone's `orphanLatchFiles`) — simulating an independent on-disk record that survives the
  // clear untouched, the exact shape `d2592cd5`'s own card describes for the active tier.
  const strayPath = path.join(MERGE_QUARANTINE_DIR, `stray-${freshSfx()}.json`);
  fs.writeFileSync(strayPath, rawShape, "utf8");
  check("(d precondition) the stray sibling is genuinely on disk, holding the already-cleared t1", sameTokenSet(readTokensOnDisk(path.basename(strayPath)), [t1]));

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([d]);

  const afterBoot = rb.stillBlockedEntryFor(d);
  check("*** THE FIX (pending-branch durable tombstone) *** d reads fully unblocked after boot even though a stray sibling still held t1 on disk", afterBoot === undefined);
  const listedAfterBoot = rb.listActiveMergeQuarantines().filter((e) => e.repoPath === d);
  check("(d, by content) no boot-time record for d carries the already-cleared t1", listedAfterBoot.every((e) => !e.tokens.includes(t1)));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO E — the SAME pending-branch gate, NEVER UNDER-BLOCKS: the clear's own sourceFile unlink is
// forced to fail (nothing else owns the file, so `sweepOwnLatchFileUnlessOwnedElsewhere` reports it
// `kept:true`), so `pendingAnyKept` is true and the durable tombstone must be SKIPPED. A later boot must
// still see the token as outstanding — over-blocking, never a false lift.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const d = path.join(os.tmpdir(), `loom-mqd2592cd5-e-never-exists-${freshSfx()}`);
  const t1 = enterMergeQuarantine(d, "loom/d2592cd5-e-1", "d2592cd5-e: raise 1 (t1)");

  const sourceFile = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => f.endsWith(".json") && sameTokenSet(readTokensOnDisk(f), [t1]));
  const sourcePath = path.join(MERGE_QUARANTINE_DIR, sourceFile);

  const injectUnlink = injectUnlinkFaultAt(sourcePath);
  let clearResult;
  try { clearResult = clearMergeQuarantineByRecordedPath(d); } finally { injectUnlink.restore(); }
  check("(e precondition) the sourceFile's own unlink was forced to fail exactly once", injectUnlink.hits() === 1);
  check("(e precondition) the clear reports the kept-but-unattributed file (latchKept, no referencingRepoPaths)", clearResult.latchKept === true && (clearResult.referencingRepoPaths ?? []).length === 0);
  check("(e precondition, by content) the file genuinely survives on disk, still holding t1", sameTokenSet(readTokensOnDisk(sourceFile), [t1]));

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([d]);
  const afterBoot = rb.stillBlockedEntryFor(d);
  check("*** NEVER UNDER-BLOCKS (pending-branch durable tombstone) *** d still reads blocked by t1 after boot — no durable tombstone was ever written for an unlink that itself failed", afterBoot !== undefined && afterBoot.tokens.includes(t1));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO F — CROSS-IDENTITY THROUGH A REBOOT: a durable tombstone for identity Fa's own token must
// never subtract from a wholly different identity Fb's own outstanding token, and the persisted sidecar
// must preserve 0d3b64c6/8bc779f0's own direct/literal dual-namespace attribution exactly (never flatten
// both identities' forms into one shared set).
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const fa = path.join(os.tmpdir(), `loom-mqd2592cd5-f-fa-never-exists-${freshSfx()}`);
  const fb = path.join(os.tmpdir(), `loom-mqd2592cd5-f-fb-never-exists-${freshSfx()}`);
  const tA = enterMergeQuarantine(fa, "loom/d2592cd5-f-a", "d2592cd5-f: raise Fa (tA)");
  const tB = enterMergeQuarantine(fb, "loom/d2592cd5-f-b", "d2592cd5-f: raise Fb (tB)");

  const clearResult = clearMergeQuarantineByRecordedPath(fa);
  check("(f precondition) clearing Fa alone reports nothing kept", !clearResult.latchKept);
  check("(f precondition) Fa reads fully unblocked right after its own clear", stillBlockedEntryFor(fa) === undefined);
  check("(f precondition) Fb is completely untouched — still blocked by tB", stillBlockedEntryFor(fb) !== undefined && stillBlockedEntryFor(fb).tokens.includes(tB));

  // Inspect the durable sidecar's own raw content: tA must be attributed to Fa's own direct/literal
  // forms ONLY — never to anything derived from Fb.
  const sidecarPath = path.join(loomHome, "merge-quarantine-cleared-tokens.dat");
  const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
  const faDirect = directPathIdentity(fa);
  const faLiteral = literalRepoPathKey(fa);
  const fbDirect = directPathIdentity(fb);
  const fbLiteral = literalRepoPathKey(fb);
  check("(f, by content) the sidecar durably attributes tA to Fa's own direct form", Array.isArray(sidecar[tA]?.direct) && sidecar[tA].direct.includes(faDirect));
  check("(f, by content) the sidecar durably attributes tA to Fa's own literal form", Array.isArray(sidecar[tA]?.literal) && sidecar[tA].literal.includes(faLiteral));
  check("(f, by content) the sidecar NEVER attributes tA to Fb's own direct form", !sidecar[tA]?.direct?.includes(fbDirect));
  check("(f, by content) the sidecar NEVER attributes tA to Fb's own literal form", !sidecar[tA]?.literal?.includes(fbLiteral));
  check("(f, by content) the sidecar holds no entry for tB at all (never cleared)", sidecar[tB] === undefined);

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([fa, fb]);
  check("*** CROSS-IDENTITY ISOLATION HOLDS THROUGH REBOOT *** Fa stays unblocked after reboot", rb.stillBlockedEntryFor(fa) === undefined);
  const afterBootFb = rb.stillBlockedEntryFor(fb);
  check("*** CROSS-IDENTITY ISOLATION HOLDS THROUGH REBOOT *** Fb's own tB survives the reboot untouched by Fa's own durable tombstone", afterBootFb !== undefined && afterBootFb.tokens.includes(tB));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO G — THE SIDECAR'S LOCATION IS STRUCTURALLY INVISIBLE TO EVERY BOOT SCAN. Plants the sidecar
// with real content, exercises every scan `reenterMergeQuarantinesAtBoot` runs (PASS 1's primary `.json`
// parse, PASS 1b's `.tmp-*` recovery, the orphan sweep that runs as part of a real clear just before
// boot) against a directory that ALSO holds genuine quarantine activity, then asserts the sidecar is
// byte-identical afterward and never once named in a parse/skip/orphan log line — pinning
// "unreachable by construction" rather than merely asserting it in prose.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const g = path.join(os.tmpdir(), `loom-mqd2592cd5-g-never-exists-${freshSfx()}`);
  const t1 = enterMergeQuarantine(g, "loom/d2592cd5-g-1", "d2592cd5-g: raise 1 (t1)");
  const t2 = enterMergeQuarantine(g, "loom/d2592cd5-g-2", "d2592cd5-g: raise 2 (t2)");

  const sourceFile = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => f.endsWith(".json") && sameTokenSet(readTokensOnDisk(f), [t1, t2]));
  const sourcePath = path.join(MERGE_QUARANTINE_DIR, sourceFile);
  const injectT1 = injectRenameFaultAt(sourcePath);
  try { clearMergeQuarantineByToken(g, t1); } finally { injectT1.restore(); }
  check("(g precondition) a real orphan tmp exists in MERGE_QUARANTINE_DIR, exercising PASS 1b on reboot", fs.readdirSync(MERGE_QUARANTINE_DIR).some((f) => f !== sourceFile));

  const sidecarPath = path.join(loomHome, "merge-quarantine-cleared-tokens.dat");
  check("(g precondition) the sidecar lives OUTSIDE MERGE_QUARANTINE_DIR — a sibling under LOOM_HOME, never nested inside it", path.dirname(sidecarPath) !== MERGE_QUARANTINE_DIR && !sidecarPath.startsWith(MERGE_QUARANTINE_DIR + path.sep));
  const beforeBootBytes = fs.readFileSync(sidecarPath);

  const errors = [];
  const realConsoleError = console.error;
  console.error = (...args) => { errors.push(args.join(" ")); realConsoleError(...args); };
  let rb;
  try {
    rb = await rebootSim();
    rb.reenterMergeQuarantinesAtBoot([g]);
  } finally {
    console.error = realConsoleError;
  }

  const afterBootBytes = fs.readFileSync(sidecarPath);
  check("*** THE SIDECAR SURVIVES BOOT BYTE-IDENTICAL *** no boot scan wrote to it", Buffer.compare(beforeBootBytes, afterBootBytes) === 0);
  check("(g, by content) MERGE_QUARANTINE_DIR's own listing never includes the sidecar basename", !fs.readdirSync(MERGE_QUARANTINE_DIR).includes(path.basename(sidecarPath)));
  check("*** NEVER PARSED *** no boot-time parse/skip/orphan log line names the sidecar's own basename", !errors.some((e) => e.includes(path.basename(sidecarPath))));
  check("(g, by content) no boot-time record anywhere names the sidecar's own absolute path as a repoPath", !rb.listActiveMergeQuarantines().some((e) => e.repoPath === sidecarPath));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO H (Follow-up, three-original-sites round) — `clearTokenFromPendingIndices`'s own REDUCE
// branch (a PENDING-only, unresolvable identity holding two tokens) was gated on `!writeFailed` alone —
// never a disk re-verification. Plants an AE-shaped UNTRACKED stray sibling for the SAME identity,
// holding the token about to be cleared, never named in anyone's `orphanLatchFiles`. The narrowing write
// to the TRACKED copy succeeds, but the durable tombstone must still be WITHHELD because the stray
// still, physically, holds it — never under-blocks on the next boot.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const h = path.join(os.tmpdir(), `loom-mqd2592cd5-h-never-exists-${freshSfx()}`);
  const t1 = enterMergeQuarantine(h, "loom/d2592cd5-h-1", "d2592cd5-h: raise 1 (t1)");
  const t2 = enterMergeQuarantine(h, "loom/d2592cd5-h-2", "d2592cd5-h: raise 2 (t2)");

  const sourceFile = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => f.endsWith(".json") && sameTokenSet(readTokensOnDisk(f), [t1, t2]));
  check("(h precondition) found the tracked pending latch file on disk holding t1+t2", typeof sourceFile === "string");

  const strayPath = path.join(MERGE_QUARANTINE_DIR, `stray-h-${freshSfx()}.json`);
  fs.writeFileSync(strayPath, JSON.stringify({
    repoPath: h, branch: "loom/d2592cd5-h-stray", reason: "AE-shaped untracked sibling (never in orphanLatchFiles)",
    enteredAt: Date.now(), tokens: [t1],
  }, null, 2) + "\n", "utf8");
  check("(h precondition) the untracked stray sibling genuinely holds t1 on disk", sameTokenSet(readTokensOnDisk(path.basename(strayPath)), [t1]));

  clearMergeQuarantineByToken(h, t1);
  check("(h precondition) the tracked copy durably narrowed to just t2", sameTokenSet(readTokensOnDisk(sourceFile), [t2]));
  check("(h precondition) h still reads blocked, by t2, right after the clear", stillBlockedEntryFor(h)?.tokens.includes(t2) === true);

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([h]);
  // `stillBlockedEntryFor`'s first-match read is not enough here: h's identity now has TWO independent
  // on-disk records (the tracked [t2] copy and the untracked [t1] stray) — union across every boot-time
  // record for h instead, mirroring Scenario A's own established pattern.
  const listedAfterBoot = rb.listActiveMergeQuarantines().filter((e) => directPathIdentity(e.repoPath) === directPathIdentity(h));
  check("*** THE FIX (clearTokenFromPendingIndices reduce, AE gate) *** some boot-time record for h still carries t1 — the untracked stray was never tombstoned away", listedAfterBoot.some((e) => e.tokens.includes(t1)));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO I (Follow-up, three-original-sites round) — the SAME AE gate, at `clearActiveEntryTokenAtKey`'s
// own REDUCE branch: a RESOLVABLE repo (so the raise ARMS directly into `activeQuarantines`), two tokens,
// an untracked stray sibling holding the one about to be cleared.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const i = makeResolvableRepo("i-repo");
  const t1 = enterMergeQuarantine(i, "loom/d2592cd5-i-1", "d2592cd5-i: raise 1 (t1)");
  const t2 = enterMergeQuarantine(i, "loom/d2592cd5-i-2", "d2592cd5-i: raise 2 (t2)");

  const sourceFile = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => f.endsWith(".json") && sameTokenSet(readTokensOnDisk(f), [t1, t2]));
  check("(i precondition) found the tracked ARMED latch file on disk holding t1+t2", typeof sourceFile === "string");

  const strayPath = path.join(MERGE_QUARANTINE_DIR, `stray-i-${freshSfx()}.json`);
  fs.writeFileSync(strayPath, JSON.stringify({
    repoPath: i, branch: "loom/d2592cd5-i-stray", reason: "AE-shaped untracked sibling (never in orphanLatchFiles)",
    enteredAt: Date.now(), tokens: [t1],
  }, null, 2) + "\n", "utf8");
  check("(i precondition) the untracked stray sibling genuinely holds t1 on disk", sameTokenSet(readTokensOnDisk(path.basename(strayPath)), [t1]));

  clearMergeQuarantineByToken(i, t1);
  check("(i precondition) the tracked copy durably narrowed to just t2", sameTokenSet(readTokensOnDisk(sourceFile), [t2]));
  check("(i precondition) i still reads blocked, by t2, right after the clear", stillBlockedEntryFor(i)?.tokens.includes(t2) === true);

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([i]);
  const afterBoot = rb.stillBlockedEntryFor(i);
  check("*** THE FIX (clearActiveEntryTokenAtKey reduce, AE gate) *** i still reads blocked by t1 after boot — the untracked stray was never tombstoned away", afterBoot !== undefined && afterBoot.tokens.includes(t1));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO J (Follow-up, three-original-sites round) — the SAME AE gate, at `clearMergeQuarantineByKey`'s
// own deferred tombstone call: a RESOLVABLE repo, a single token fully lifted (never a reduce), an
// untracked stray sibling holding that exact token. `clearMergeQuarantineByRecordedPath` here resolves
// through the ACTIVE branch of `tryClearMergeQuarantineByOwnIdentity`, which delegates the real lift to
// `clearMergeQuarantineByKey` — the function this round's three-original-sites fix touches directly.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const j = makeResolvableRepo("j-repo");
  const t1 = enterMergeQuarantine(j, "loom/d2592cd5-j-1", "d2592cd5-j: raise 1 (t1)");

  const sourceFile = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => f.endsWith(".json") && sameTokenSet(readTokensOnDisk(f), [t1]));
  check("(j precondition) found the tracked ARMED latch file on disk holding t1 alone", typeof sourceFile === "string");

  const strayPath = path.join(MERGE_QUARANTINE_DIR, `stray-j-${freshSfx()}.json`);
  fs.writeFileSync(strayPath, JSON.stringify({
    repoPath: j, branch: "loom/d2592cd5-j-stray", reason: "AE-shaped untracked sibling (never in orphanLatchFiles)",
    enteredAt: Date.now(), tokens: [t1],
  }, null, 2) + "\n", "utf8");
  check("(j precondition) the untracked stray sibling genuinely holds t1 on disk", sameTokenSet(readTokensOnDisk(path.basename(strayPath)), [t1]));

  const clearResult = clearMergeQuarantineByRecordedPath(j);
  check("(j precondition) the full-lift clear reports nothing kept", !clearResult.latchKept);
  check("(j precondition) j reads fully unblocked right after the clear", stillBlockedEntryFor(j) === undefined);

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([j]);
  const afterBoot = rb.stillBlockedEntryFor(j);
  check("*** THE FIX (clearMergeQuarantineByKey, AE gate) *** j reads BLOCKED again by t1 after boot — the untracked stray was never tombstoned away", afterBoot !== undefined && afterBoot.tokens.includes(t1));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO P1 (CRITICAL fix round) — `persistClearedTokensTombstoneFile` used to serialize the WHOLE
// in-memory `clearedTokens` map, so ANY later, unrelated, successful clear durably tombstoned every
// gated-off entry already sitting in that map too. Reproduces Scenario H's own setup (an AE-gated reduce
// that must NOT durably tombstone t1), then runs a SECOND, wholly unrelated identity's own legitimate,
// successful clear — which, before this fix, persisted the WHOLE map and durably tombstoned t1 as a side
// effect. Asserts the durable sidecar never holds t1, and h still carries t1 (via the AE stray) after a
// real reboot.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const h = path.join(os.tmpdir(), `loom-mqd2592cd5-p1-h-never-exists-${freshSfx()}`);
  const t1 = enterMergeQuarantine(h, "loom/d2592cd5-p1-h-1", "d2592cd5-p1: raise 1 (t1)");
  const t2 = enterMergeQuarantine(h, "loom/d2592cd5-p1-h-2", "d2592cd5-p1: raise 2 (t2)");

  const sourceFile = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => f.endsWith(".json") && sameTokenSet(readTokensOnDisk(f), [t1, t2]));
  check("(p1 precondition) found the tracked pending latch file on disk holding t1+t2", typeof sourceFile === "string");

  const strayPath = path.join(MERGE_QUARANTINE_DIR, `stray-p1-${freshSfx()}.json`);
  fs.writeFileSync(strayPath, JSON.stringify({
    repoPath: h, branch: "loom/d2592cd5-p1-stray", reason: "AE-shaped untracked sibling (never in orphanLatchFiles)",
    enteredAt: Date.now(), tokens: [t1],
  }, null, 2) + "\n", "utf8");
  check("(p1 precondition) the untracked stray sibling genuinely holds t1 on disk", sameTokenSet(readTokensOnDisk(path.basename(strayPath)), [t1]));

  clearMergeQuarantineByToken(h, t1);
  check("(p1 precondition) the tracked copy durably narrowed to just t2", sameTokenSet(readTokensOnDisk(sourceFile), [t2]));
  check("(p1 precondition) h still reads blocked, by t2, right after the clear", stillBlockedEntryFor(h)?.tokens.includes(t2) === true);

  // A SECOND, wholly unrelated identity's own legitimate clear — no faults, no stray, nothing shared
  // with h. This must durably confirm (its own narrowing write succeeds, no AE sibling exists for k).
  const k = path.join(os.tmpdir(), `loom-mqd2592cd5-p1-k-never-exists-${freshSfx()}`);
  const k1 = enterMergeQuarantine(k, "loom/d2592cd5-p1-k-1", "d2592cd5-p1: raise k1");
  const k2 = enterMergeQuarantine(k, "loom/d2592cd5-p1-k-2", "d2592cd5-p1: raise k2");
  clearMergeQuarantineByToken(k, k1);
  check("(p1 precondition) k's own unrelated clear durably confirmed (k still blocked by k2 alone)", stillBlockedEntryFor(k)?.tokens.includes(k2) === true);

  const sidecarPath = path.join(loomHome, "merge-quarantine-cleared-tokens.dat");
  const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
  check("*** THE CRITICAL FIX *** k's own unrelated, successful clear never durably tombstoned h's gated-off t1 via a bulk copy of the whole in-memory map", sidecar[t1] === undefined);
  check("(p1, by content) the sidecar DOES durably hold k's own legitimately-confirmed k1", sidecar[k1] !== undefined);

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([h, k]);
  const listedAfterBoot = rb.listActiveMergeQuarantines().filter((e) => directPathIdentity(e.repoPath) === directPathIdentity(h));
  check("*** THE CRITICAL FIX (across a real reboot) *** some boot-time record for h still carries t1 — an unrelated identity's own successful clear never durably resurrected-away the AE-gated token", listedAfterBoot.some((e) => e.tokens.includes(t1)));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO P2 (CRITICAL fix round) — the SAME bug, at Scenario B's own faulted-primary-rename shape: b's
// own primary write FAILS (never durably confirmed — `tombstoneIfNotSurviving` still adds t1 to the
// in-memory `clearedTokens` map, by design, even though the write itself failed), then a SECOND, wholly
// unrelated identity's own legitimate, successful clear runs. Before this fix, that second clear's own
// `persistClearedTokensTombstoneFile` call copied the WHOLE in-memory map — including b's gated-off t1 —
// durably tombstoning a token nothing durable ever actually removed. Asserts b still carries t1 after a
// real reboot (never under-blocks).
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const b = path.join(os.tmpdir(), `loom-mqd2592cd5-p2-b-never-exists-${freshSfx()}`);
  const t1 = enterMergeQuarantine(b, "loom/d2592cd5-p2-b-1", "d2592cd5-p2: raise 1 (t1)");
  const t2 = enterMergeQuarantine(b, "loom/d2592cd5-p2-b-2", "d2592cd5-p2: raise 2 (t2)");

  const sourceFile = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => f.endsWith(".json") && sameTokenSet(readTokensOnDisk(f), [t1, t2]));
  const sourcePath = path.join(MERGE_QUARANTINE_DIR, sourceFile);
  const injectT1 = injectRenameFaultAt(sourcePath);
  try { clearMergeQuarantineByToken(b, t1); } finally { injectT1.restore(); }
  check("(p2 precondition) the primary rename was forced to fail exactly once", injectT1.hits() === 1);
  check("(p2 precondition, by content) the primary file is untouched (still holds t1,t2 — rename never landed)", sameTokenSet(readTokensOnDisk(sourceFile), [t1, t2]));

  // A SECOND, wholly unrelated identity's own legitimate clear — no faults, no overlap with b.
  const k = path.join(os.tmpdir(), `loom-mqd2592cd5-p2-k-never-exists-${freshSfx()}`);
  const k1 = enterMergeQuarantine(k, "loom/d2592cd5-p2-k-1", "d2592cd5-p2: raise k1");
  const k2 = enterMergeQuarantine(k, "loom/d2592cd5-p2-k-2", "d2592cd5-p2: raise k2");
  clearMergeQuarantineByToken(k, k1);
  check("(p2 precondition) k's own unrelated clear durably confirmed (k still blocked by k2 alone)", stillBlockedEntryFor(k)?.tokens.includes(k2) === true);

  const sidecarPath = path.join(loomHome, "merge-quarantine-cleared-tokens.dat");
  const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
  check("*** THE CRITICAL FIX *** k's own unrelated, successful clear never durably tombstoned b's write-failed t1 via a bulk copy of the whole in-memory map", sidecar[t1] === undefined);

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([b, k]);
  const after = rb.stillBlockedEntryFor(b);
  check("*** THE CRITICAL FIX (across a real reboot) *** b still reads blocked by t1 after this reboot — an unrelated identity's own successful clear never durably resurrected-away a token whose own write had failed", after !== undefined && after.tokens.includes(t1));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO M1 (MAJOR, mutant-kill) — kills the mutant that removes `!writeFailed` from
// `clearActiveEntryTokenAtKey`'s own REDUCE-branch `tombstoneDurablyIfConfirmed` gate. A RESOLVABLE
// repo, two tokens (ARMED), with the armed key's own narrowing rewrite forced to fail — NO AE stray at
// all, so `identityHasAnyPhysicalRecordHoldingToken` alone would already return false. The durable
// tombstone must still be WITHHELD because the write itself failed. Checked directly against the
// sidecar's own content (no reboot needed): the mutant would persist t1 anyway; the real code never does.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const m1 = makeResolvableRepo("m1-repo");
  const t1 = enterMergeQuarantine(m1, "loom/d2592cd5-m1-1", "d2592cd5-m1: raise 1 (t1)");
  const t2 = enterMergeQuarantine(m1, "loom/d2592cd5-m1-2", "d2592cd5-m1: raise 2 (t2)");

  const sourceFile = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => f.endsWith(".json") && sameTokenSet(readTokensOnDisk(f), [t1, t2]));
  check("(m1 precondition) found the tracked ARMED latch file on disk holding t1+t2", typeof sourceFile === "string");
  const sourcePath = path.join(MERGE_QUARANTINE_DIR, sourceFile);

  const injectM1 = injectRenameFaultAt(sourcePath);
  try { clearMergeQuarantineByToken(m1, t1); } finally { injectM1.restore(); }
  check("(m1 precondition) the armed key's own narrowing rename was forced to fail exactly once", injectM1.hits() === 1);
  check("(m1 precondition, by content) the armed file is untouched (still holds t1,t2 — rename never landed)", sameTokenSet(readTokensOnDisk(sourceFile), [t1, t2]));

  const sidecarPath = path.join(loomHome, "merge-quarantine-cleared-tokens.dat");
  const sidecarM1 = fs.existsSync(sidecarPath) ? JSON.parse(fs.readFileSync(sidecarPath, "utf8")) : {};
  check("*** KILLS MUTANT 1 (clearActiveEntryTokenAtKey !writeFailed) *** the sidecar never durably tombstones t1 — its own narrowing write failed, with no AE stray needed to withhold it", sidecarM1[t1] === undefined);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO M2 (MAJOR, mutant-kill) — kills the mutant that changes `identityHasAnyPhysicalRecordOnDisk`'s
// own unreadable-file branch from `return true` (fail-closed) to `continue`. Plants an UNRELATED,
// genuinely unreadable (EACCES) stray file in MERGE_QUARANTINE_DIR during a full identity-wide pending
// clear (`clearMergeQuarantineByRecordedPath` -> `tryClearMergeQuarantineByOwnIdentity`'s own pending-
// sweep branch). The real code must treat the unreadable file as "might still be there" and withhold
// the durable tombstone; the mutant would skip it and wrongly tombstone.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const m2 = path.join(os.tmpdir(), `loom-mqd2592cd5-m2-never-exists-${freshSfx()}`);
  const t1 = enterMergeQuarantine(m2, "loom/d2592cd5-m2-1", "d2592cd5-m2: raise 1 (t1)");

  const unreadablePath = path.join(MERGE_QUARANTINE_DIR, `unreadable-m2-${freshSfx()}.json`);
  fs.writeFileSync(unreadablePath, JSON.stringify({ repoPath: "loom-mqd2592cd5-m2-unrelated", tokens: ["00000000-0000-4000-8000-000000000000"] }), "utf8");

  const injectRead = injectReadFaultAt(unreadablePath);
  try { clearMergeQuarantineByRecordedPath(m2); } finally { injectRead.restore(); }
  check("(m2 precondition) the unrelated stray's own read was forced to fail at least once", injectRead.hits() > 0);
  check("(m2 precondition) m2 reads fully unblocked right after the clear (its own real work succeeded)", stillBlockedEntryFor(m2) === undefined);

  const sidecarPathM2 = path.join(loomHome, "merge-quarantine-cleared-tokens.dat");
  const sidecarM2 = JSON.parse(fs.readFileSync(sidecarPathM2, "utf8"));
  check("*** KILLS MUTANT 6 (identityHasAnyPhysicalRecordOnDisk EACCES fail-closed) *** the sidecar never durably tombstones t1 while an unrelated file in the directory could not be read", sidecarM2[t1] === undefined);

  fs.rmSync(unreadablePath, { force: true });
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO M3 (MAJOR, mutant-kill) — kills the mutant that changes `identityHasAnyPhysicalRecordHoldingToken`'s
// own unreadable-file branch from `return true` (fail-closed) to `continue`. Same AE shape as Scenario H,
// but the stray sibling is genuinely UNREADABLE (EACCES) rather than readable — the real code must still
// treat it as "might still hold the token" and withhold the durable tombstone.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const m3 = path.join(os.tmpdir(), `loom-mqd2592cd5-m3-never-exists-${freshSfx()}`);
  const t1 = enterMergeQuarantine(m3, "loom/d2592cd5-m3-1", "d2592cd5-m3: raise 1 (t1)");
  const t2 = enterMergeQuarantine(m3, "loom/d2592cd5-m3-2", "d2592cd5-m3: raise 2 (t2)");

  const sourceFile = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => f.endsWith(".json") && sameTokenSet(readTokensOnDisk(f), [t1, t2]));
  check("(m3 precondition) found the tracked pending latch file on disk holding t1+t2", typeof sourceFile === "string");

  const strayPath = path.join(MERGE_QUARANTINE_DIR, `stray-m3-${freshSfx()}.json`);
  fs.writeFileSync(strayPath, JSON.stringify({
    repoPath: m3, branch: "loom/d2592cd5-m3-stray", reason: "unreadable AE sibling (never in orphanLatchFiles)",
    enteredAt: Date.now(), tokens: [t1],
  }, null, 2) + "\n", "utf8");

  const injectRead = injectReadFaultAt(strayPath);
  try { clearMergeQuarantineByToken(m3, t1); } finally { injectRead.restore(); }
  check("(m3 precondition) the stray sibling's own read was forced to fail at least once", injectRead.hits() > 0);
  check("(m3 precondition) the tracked copy durably narrowed to just t2", sameTokenSet(readTokensOnDisk(sourceFile), [t2]));

  const sidecarPathM3 = path.join(loomHome, "merge-quarantine-cleared-tokens.dat");
  const sidecarM3 = JSON.parse(fs.readFileSync(sidecarPathM3, "utf8"));
  check("*** KILLS MUTANT 5 (identityHasAnyPhysicalRecordHoldingToken EACCES fail-closed) *** the sidecar never durably tombstones t1 while the AE stray's own content could not be read", sidecarM3[t1] === undefined);

  fs.rmSync(strayPath, { force: true });
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO M4 (MAJOR, mutant-kill) — kills the mutant that removes `!anyWriteFailed` from
// `clearMergeQuarantineByKey`'s own `tombstoneDurablyIfConfirmed` gate. A structurally-tied pending twin
// P (shares W's own identity+armedKey, holding W's own token s plus its own private token v, card
// 64119847's own precondition shape) whose own reduce-write fails during W's full lift —
// `anyWriteFailed` becomes true. The durable tombstone must still be WITHHELD for s; the mutant would
// persist it anyway (recipe adapted from merge-quarantine-444cd8e2-twin-write-tracking.mjs's own Site B).
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const w = makeResolvableRepo("m4-w");
  const Kw = canonicalRepoLockKey(w);
  const s = "tok-d2592cd5-m4-s";
  const v = "tok-d2592cd5-m4-v";
  const wEntry = { repoPath: w, branch: "w-branch", reason: "d2592cd5-m4 — W", enteredAt: Date.now(), tokens: [s], resolvedKey: Kw, armedKeys: [Kw] };
  setActiveQuarantineTestOnly(Kw, wEntry);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${quarantineHashForKeyTest(Kw)}.json`), JSON.stringify({ repoPath: w, branch: wEntry.branch, reason: wEntry.reason, tokens: wEntry.tokens, enteredAt: wEntry.enteredAt }, null, 2) + "\n");

  const pSourceFile = `pending-d2592cd5-m4-twin-${freshSfx()}.json`;
  const pEntry = { repoPath: w, branch: "p-branch", reason: "d2592cd5-m4 — P (tied via armedKeys)", enteredAt: Date.now(), tokens: [s, v], armedKeys: [Kw] };
  pushPendingQuarantineTestOnly(pEntry, pSourceFile);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, pSourceFile), JSON.stringify({ repoPath: w, branch: pEntry.branch, reason: pEntry.reason, tokens: pEntry.tokens, enteredAt: pEntry.enteredAt }, null, 2) + "\n");

  const injectM4 = injectRenameFaultAt(path.join(MERGE_QUARANTINE_DIR, pSourceFile));
  try { clearMergeQuarantineByKey(Kw, w, undefined, true); } finally { injectM4.restore(); }
  check("(m4 precondition) P's own twin rename was forced to fail at least once", injectM4.hits() >= 1);
  check("(m4 precondition, by content) P's own sourceFile is untouched (still holds s,v — rename never landed)", sameTokenSet(readTokensOnDisk(pSourceFile), [s, v]));

  const sidecarPathM4 = path.join(loomHome, "merge-quarantine-cleared-tokens.dat");
  const sidecarM4 = JSON.parse(fs.readFileSync(sidecarPathM4, "utf8"));
  check("*** KILLS MUTANT 2 (clearMergeQuarantineByKey !anyWriteFailed) *** the sidecar never durably tombstones s — the tied twin's own reduce-write failed", sidecarM4[s] === undefined);

  fs.rmSync(path.join(MERGE_QUARANTINE_DIR, pSourceFile), { force: true });
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO M5 (MAJOR, mutant-kill) — kills the mutant that removes the
// `!anyReferencing && !anyKeptUnattributed && keptContentRepoPaths.size===0` term from
// `clearMergeQuarantineByKey`'s own `tombstoneDurablyIfConfirmed` gate. A content-kept FOREIGN orphan
// (named in this entry's own `orphanLatchFiles`, but itself naming a wholly DIFFERENT repoPath) survives
// this entry's full lift — `keptContentRepoPaths.size>0`. The durable tombstone must still be WITHHELD
// AT THIS GATE; the mutant would persist it anyway.
//
// @decision d2592cd5 (fix round, card 3d4467cf) — calls `clearMergeQuarantineByRecordedPath` (identity-
// wide `true`, like Scenario J): production's only `false` caller overrides this withhold right after (G1).
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const m5 = makeResolvableRepo("m5-repo");
  const t1 = enterMergeQuarantine(m5, "loom/d2592cd5-m5-1", "d2592cd5-m5: raise 1 (t1)");

  const m5Final = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => f.endsWith(".json") && sameTokenSet(readTokensOnDisk(f), [t1]));
  check("(m5 precondition) found the tracked ARMED latch file on disk holding t1 alone", typeof m5Final === "string");
  const orphanBasenameM5 = `${randomBytes(12).toString("hex")}.json`;
  const recM5 = JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, m5Final), "utf8"));
  recM5.orphanLatchFiles = [orphanBasenameM5];
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, m5Final), JSON.stringify(recM5));

  const rbM5 = await rebootSim();
  rbM5.reenterMergeQuarantinesAtBoot([m5]);

  const foreignRepoM5 = makeResolvableRepo("m5-foreign");
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, orphanBasenameM5), JSON.stringify({
    repoPath: foreignRepoM5, branch: "loom/d2592cd5-m5-foreign", reason: "foreign content-kept orphan",
    enteredAt: Date.now(), tokens: [randomUUID()],
  }));

  const clearResultM5 = rbM5.clearMergeQuarantineByRecordedPath(m5);
  check("(m5 precondition) the identity-wide clear reports the content-kept orphan", !!clearResultM5.latchKept);
  check("(m5 precondition) m5 reads fully unblocked right after the clear", rbM5.stillBlockedEntryFor(m5) === undefined);
  check("(m5 precondition, by content) the foreign orphan survives on disk (content-kept, never swept)", fs.existsSync(path.join(MERGE_QUARANTINE_DIR, orphanBasenameM5)));

  const sidecarPathM5 = path.join(loomHome, "merge-quarantine-cleared-tokens.dat");
  const sidecarM5 = JSON.parse(fs.readFileSync(sidecarPathM5, "utf8"));
  check("*** KILLS MUTANT 3 (clearMergeQuarantineByKey content-kept term), FINAL — never overridden by any backstop at this identity-wide route *** the sidecar never durably tombstones t1 while a foreign orphan was content-kept", sidecarM5[t1] === undefined);

  fs.rmSync(path.join(MERGE_QUARANTINE_DIR, orphanBasenameM5), { force: true });
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO M6 (MAJOR, mutant-kill) — kills the mutant that removes `!pendingAnyKept` from BOTH pending-
// tier full-identity-wide clear sites (`tryClearMergeQuarantineByOwnIdentity`'s pending-sweep branch,
// reached via `clearMergeQuarantineByRecordedPath`; and `clearMergeQuarantineLatchFile`'s matched-pending
// branch). A content-kept FOREIGN orphan (named in this entry's own `orphanLatchFiles`, but itself naming
// a DIFFERENT repoPath) makes `pendingAnyKept` true while `identityHasAnyPhysicalRecordOnDisk` (bare,
// identity-only) returns FALSE — a genuinely discriminating shape (unlike Scenario E's own kept-file,
// which still names the SAME identity, so both clauses agree there and the mutant survives unnoticed).
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const n6a = path.join(os.tmpdir(), `loom-mqd2592cd5-m6a-never-exists-${freshSfx()}`);
  const t1a = enterMergeQuarantine(n6a, "loom/d2592cd5-m6a-1", "d2592cd5-m6a: raise 1 (t1)");

  const n6aFile = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => f.endsWith(".json") && sameTokenSet(readTokensOnDisk(f), [t1a]));
  check("(m6a precondition) found the tracked pending latch file on disk holding t1 alone", typeof n6aFile === "string");
  const orphanBasenameM6a = `${randomBytes(12).toString("hex")}.json`;
  const recM6a = JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, n6aFile), "utf8"));
  recM6a.orphanLatchFiles = [orphanBasenameM6a];
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, n6aFile), JSON.stringify(recM6a));

  const rbM6a = await rebootSim();
  rbM6a.reenterMergeQuarantinesAtBoot([n6a]);

  const foreignRepoM6a = makeResolvableRepo("m6a-foreign");
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, orphanBasenameM6a), JSON.stringify({
    repoPath: foreignRepoM6a, branch: "loom/d2592cd5-m6a-foreign", reason: "foreign content-kept orphan (pending tier, by-recorded-path)",
    enteredAt: Date.now(), tokens: [randomUUID()],
  }));

  rbM6a.clearMergeQuarantineByRecordedPath(n6a);
  check("(m6a precondition) n6a reads fully unblocked right after the clear", rbM6a.stillBlockedEntryFor(n6a) === undefined);
  check("(m6a precondition, by content) the foreign orphan survives on disk (content-kept, never swept)", fs.existsSync(path.join(MERGE_QUARANTINE_DIR, orphanBasenameM6a)));

  const sidecarPathM6a = path.join(loomHome, "merge-quarantine-cleared-tokens.dat");
  const sidecarM6a = JSON.parse(fs.readFileSync(sidecarPathM6a, "utf8"));
  check("*** KILLS MUTANT 4a (tryClearMergeQuarantineByOwnIdentity pending-sweep !pendingAnyKept) *** the sidecar never durably tombstones t1 while a foreign orphan was content-kept", sidecarM6a[t1a] === undefined);

  fs.rmSync(path.join(MERGE_QUARANTINE_DIR, orphanBasenameM6a), { force: true });
}
{
  const n6b = path.join(os.tmpdir(), `loom-mqd2592cd5-m6b-never-exists-${freshSfx()}`);
  const t1b = enterMergeQuarantine(n6b, "loom/d2592cd5-m6b-1", "d2592cd5-m6b: raise 1 (t1)");

  const n6bFile = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => f.endsWith(".json") && sameTokenSet(readTokensOnDisk(f), [t1b]));
  check("(m6b precondition) found the tracked pending latch file on disk holding t1 alone", typeof n6bFile === "string");
  const orphanBasenameM6b = `${randomBytes(12).toString("hex")}.json`;
  const recM6b = JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, n6bFile), "utf8"));
  recM6b.orphanLatchFiles = [orphanBasenameM6b];
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, n6bFile), JSON.stringify(recM6b));

  const rbM6b = await rebootSim();
  rbM6b.reenterMergeQuarantinesAtBoot([n6b]);

  const foreignRepoM6b = makeResolvableRepo("m6b-foreign");
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, orphanBasenameM6b), JSON.stringify({
    repoPath: foreignRepoM6b, branch: "loom/d2592cd5-m6b-foreign", reason: "foreign content-kept orphan (pending tier, by-latch-id)",
    enteredAt: Date.now(), tokens: [randomUUID()],
  }));

  const id6b = pendingLatchIdForTest(n6bFile);
  const clearResultM6b = rbM6b.clearMergeQuarantineLatchFile(id6b);
  check("(m6b precondition) the clear-by-id route reports ok", clearResultM6b.ok === true);
  check("(m6b precondition) n6b reads fully unblocked right after the clear", rbM6b.stillBlockedEntryFor(n6b) === undefined);
  check("(m6b precondition, by content) the foreign orphan survives on disk (content-kept, never swept)", fs.existsSync(path.join(MERGE_QUARANTINE_DIR, orphanBasenameM6b)));

  const sidecarPathM6b = path.join(loomHome, "merge-quarantine-cleared-tokens.dat");
  const sidecarM6b = JSON.parse(fs.readFileSync(sidecarPathM6b, "utf8"));
  check("*** KILLS MUTANT 4b (clearMergeQuarantineLatchFile matched-pending !pendingAnyKept) *** the sidecar never durably tombstones t1 while a foreign orphan was content-kept", sidecarM6b[t1b] === undefined);

  fs.rmSync(path.join(MERGE_QUARANTINE_DIR, orphanBasenameM6b), { force: true });
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO K (card 6bdd2e87) — `identityHasAnyPhysicalRecordHoldingToken`'s own READDIR-failure branch
// (`catch { return true; }` on the function's FIRST fs call, before any per-file read even runs — a
// different branch than Scenario M3's per-file-read EACCES, which only fires once the readdir itself
// has already succeeded). Same AE shape as Scenario H (`clearTokenFromPendingIndices`'s reduce branch,
// a PENDING-only, unresolvable identity holding two tokens, an untracked stray sibling holding the
// token about to be cleared) — but this time `fs.readdirSync(MERGE_QUARANTINE_DIR)` itself throws
// (EMFILE) during the clear, so the gate never even gets to look at the stray's content. The real,
// fail-closed code must still withhold the durable tombstone (treat "could not check" as "might still
// be there"); an API-keeping mutant that turns the catch into `return false` would wrongly durably
// tombstone t1 even though the untracked stray still holds it.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const k = path.join(os.tmpdir(), `loom-mqd2592cd5-k-never-exists-${freshSfx()}`);
  const t1 = enterMergeQuarantine(k, "loom/6bdd2e87-k-1", "6bdd2e87-k: raise 1 (t1)");
  const t2 = enterMergeQuarantine(k, "loom/6bdd2e87-k-2", "6bdd2e87-k: raise 2 (t2)");

  const sourceFile = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => f.endsWith(".json") && sameTokenSet(readTokensOnDisk(f), [t1, t2]));
  check("(k precondition) found the tracked pending latch file on disk holding t1+t2", typeof sourceFile === "string");

  const strayPath = path.join(MERGE_QUARANTINE_DIR, `stray-k-${freshSfx()}.json`);
  fs.writeFileSync(strayPath, JSON.stringify({
    repoPath: k, branch: "loom/6bdd2e87-k-stray", reason: "AE-shaped untracked sibling (never in orphanLatchFiles)",
    enteredAt: Date.now(), tokens: [t1],
  }, null, 2) + "\n", "utf8");
  check("(k precondition) the untracked stray sibling genuinely holds t1 on disk", sameTokenSet(readTokensOnDisk(path.basename(strayPath)), [t1]));

  const injectReaddirK = injectReaddirFaultAt(MERGE_QUARANTINE_DIR);
  try { clearMergeQuarantineByToken(k, t1); } finally { injectReaddirK.restore(); }
  check("(k precondition) MERGE_QUARANTINE_DIR's own readdir was forced to fail at least once during the clear", injectReaddirK.hits() > 0);
  check("(k precondition) the tracked copy durably narrowed to just t2 — the clear's own write still succeeded under the readdir fault", sameTokenSet(readTokensOnDisk(sourceFile), [t2]));
  check("(k precondition) k still reads blocked, by t2, right after the clear", stillBlockedEntryFor(k)?.tokens.includes(t2) === true);

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([k]);
  // `stillBlockedEntryFor`'s first-match read is not enough here — mirrors Scenario H's own reasoning:
  // k's identity now has TWO independent on-disk records (the tracked [t2] copy and the untracked [t1]
  // stray) — union across every boot-time record for k instead.
  const listedAfterBootK = rb.listActiveMergeQuarantines().filter((e) => directPathIdentity(e.repoPath) === directPathIdentity(k));
  check("*** THE FIX (identityHasAnyPhysicalRecordHoldingToken readdir-failure fail-closed) *** some boot-time record for k still carries t1 — the untracked stray was never tombstoned away despite the readdir fault", listedAfterBootK.some((e) => e.tokens.includes(t1)));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO L (card 6bdd2e87) — `identityHasAnyPhysicalRecordOnDisk`'s own READDIR-failure branch
// (`catch { return true; }` on the function's FIRST fs call) — the FULL identity-wide twin of Scenario
// K, at `tryClearMergeQuarantineByOwnIdentity`'s own pending-sweep branch (reached via the exported,
// identity-wide `clearMergeQuarantineByRecordedPath`, same site as Scenario D/M2/M6a). An untracked
// stray sibling for the SAME identity, holding the only outstanding token, sits on disk BEFORE the
// clear runs; `fs.readdirSync(MERGE_QUARANTINE_DIR)` itself throws (EMFILE) during the clear, so the
// gate can never discover it by content. The real code must still withhold the durable tombstone; an
// API-keeping mutant (`return false`) would wrongly write it even though the stray still holds t1.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const l = path.join(os.tmpdir(), `loom-mqd2592cd5-l-never-exists-${freshSfx()}`);
  const t1 = enterMergeQuarantine(l, "loom/6bdd2e87-l-1", "6bdd2e87-l: raise 1 (t1)");

  const sourceFile = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => f.endsWith(".json") && sameTokenSet(readTokensOnDisk(f), [t1]));
  check("(l precondition) found the pending latch file on disk holding t1 alone", typeof sourceFile === "string");

  const strayPath = path.join(MERGE_QUARANTINE_DIR, `stray-l-${freshSfx()}.json`);
  fs.writeFileSync(strayPath, JSON.stringify({
    repoPath: l, branch: "loom/6bdd2e87-l-stray", reason: "AE-shaped untracked sibling (never in orphanLatchFiles)",
    enteredAt: Date.now(), tokens: [t1],
  }, null, 2) + "\n", "utf8");
  check("(l precondition) the untracked stray sibling genuinely holds t1 on disk", sameTokenSet(readTokensOnDisk(path.basename(strayPath)), [t1]));

  const injectReaddirL = injectReaddirFaultAt(MERGE_QUARANTINE_DIR);
  let clearResultL;
  try { clearResultL = clearMergeQuarantineByRecordedPath(l); } finally { injectReaddirL.restore(); }
  check("(l precondition) MERGE_QUARANTINE_DIR's own readdir was forced to fail at least once during the clear", injectReaddirL.hits() > 0);
  check("(l precondition) the broad identity-wide clear reports nothing kept — its own write still succeeded under the readdir fault", !clearResultL.latchKept);
  check("(l precondition) l reads fully unblocked right after the clear (in-memory)", stillBlockedEntryFor(l) === undefined);

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([l]);
  const listedAfterBootL = rb.listActiveMergeQuarantines().filter((e) => directPathIdentity(e.repoPath) === directPathIdentity(l));
  check("*** THE FIX (identityHasAnyPhysicalRecordOnDisk readdir-failure fail-closed) *** some boot-time record for l still carries t1 — the untracked stray was never tombstoned away despite the readdir fault", listedAfterBootL.some((e) => e.tokens.includes(t1)));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO M7 (BLOCKING fix round, Code Review of card 3d4467cf) — the SAME shape as Scenario M4, but
// driven through the PUBLIC dispatcher `clearMergeQuarantineByToken(w, s)` instead of calling
// `clearMergeQuarantineByKey` directly. `clearActiveEntryTokenAtKey`'s own full-lift SECOND call
// (`remaining.length===0` branch, after the delegated `clearMergeQuarantineByKey` call returns) used to
// re-decide the durable tombstone from a BARE disk re-scan, with no knowledge of the delegated call's
// own `anyWriteFailed` — P's own failed reduce-write stayed invisible to that scan (P still reads
// "tracked"), so this SECOND call durably tombstoned s anyway. Threading `result.anyWriteFailed` into
// this gate (see `clearActiveEntryTokenAtKey`'s own doc) closes it.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const w = makeResolvableRepo("m7-w");
  const Kw = canonicalRepoLockKey(w);
  const s = "tok-d2592cd5-m7-s";
  const v = "tok-d2592cd5-m7-v";
  const wEntry = { repoPath: w, branch: "w-branch", reason: "d2592cd5-m7 — W", enteredAt: Date.now(), tokens: [s], resolvedKey: Kw, armedKeys: [Kw] };
  setActiveQuarantineTestOnly(Kw, wEntry);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${quarantineHashForKeyTest(Kw)}.json`), JSON.stringify({ repoPath: w, branch: wEntry.branch, reason: wEntry.reason, tokens: wEntry.tokens, enteredAt: wEntry.enteredAt }, null, 2) + "\n");

  const pSourceFile = `pending-d2592cd5-m7-twin-${freshSfx()}.json`;
  const pEntry = { repoPath: w, branch: "p-branch", reason: "d2592cd5-m7 — P (tied via armedKeys)", enteredAt: Date.now(), tokens: [s, v], armedKeys: [Kw] };
  pushPendingQuarantineTestOnly(pEntry, pSourceFile);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, pSourceFile), JSON.stringify({ repoPath: w, branch: pEntry.branch, reason: pEntry.reason, tokens: pEntry.tokens, enteredAt: pEntry.enteredAt }, null, 2) + "\n");

  const injectM7 = injectRenameFaultAt(path.join(MERGE_QUARANTINE_DIR, pSourceFile));
  try { clearMergeQuarantineByToken(w, s); } finally { injectM7.restore(); }
  check("(m7 precondition) P's own twin rename was forced to fail at least once", injectM7.hits() >= 1);
  check("(m7 precondition, by content) P's own sourceFile is untouched (still holds s,v — rename never landed)", sameTokenSet(readTokensOnDisk(pSourceFile), [s, v]));
  check("(m7 precondition) w still reads blocked, by v alone — P's own IN-MEMORY entry already narrowed off s regardless of the write failure", stillBlockedEntryFor(w)?.tokens.includes(v) === true && !stillBlockedEntryFor(w)?.tokens.includes(s));

  const sidecarPathM7 = path.join(loomHome, "merge-quarantine-cleared-tokens.dat");
  const sidecarM7 = JSON.parse(fs.readFileSync(sidecarPathM7, "utf8"));
  check("*** THE BLOCKING FIX, BY CONTENT — RED ON PRE-FIX CODE *** the sidecar never durably tombstones s via the dispatcher's own full-lift backstop — P's own reduce-write failed", sidecarM7[s] === undefined);

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([w]);
  const listedAfterBootM7 = rb.listActiveMergeQuarantines().filter((e) => directPathIdentity(e.repoPath) === directPathIdentity(w));
  check("*** NEVER FAIL-OPEN, ACROSS A REAL REBOOT *** some boot-time record for w still carries s — P's own stale copy was never falsely tombstoned away", listedAfterBootM7.some((e) => e.tokens.includes(s)));

  fs.rmSync(path.join(MERGE_QUARANTINE_DIR, pSourceFile), { force: true });
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO M8 (BLOCKING fix round, Code Review of card 3d4467cf — "do the same audit at the PENDING-site
// backstop") — the IDENTICAL cross-target blind spot, at `clearTokenFromPendingIndices`'s own REMOVE
// (full-lift) branch, for TWO INDEPENDENT pending wrappers sharing one identity (this card's own root-
// cause shape): R (the real raise, tok ALONE — full lift) and Q (a manually-planted second on-disk
// record for the SAME identity, tok+other — a reduce). Both are matched by `collectPendingIndices` into
// ONE `clearTokenFromPendingIndices([idxR, idxQ], tok)` call. Q's own narrowing write is forced to fail.
// R's remove-branch tombstone decision used to be decided INLINE, scanning disk with Q's own sourceFile
// excluded as "tracked" regardless of Q's write outcome — wrongly tombstoning tok even though Q's own
// on-disk copy still genuinely holds it. Deferring R's decision past the whole batch, ANDed against
// `reduceWriteFailedForIdentity`, closes it.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const identityPathM8 = path.join(os.tmpdir(), `loom-mqd2592cd5-m8-never-exists-${freshSfx()}`);
  const tok = enterMergeQuarantine(identityPathM8, "loom/d2592cd5-m8-1", "d2592cd5-m8: raise 1 (tok)");
  const other = "tok-d2592cd5-m8-other";

  const qSourceFile = `pending-d2592cd5-m8-twin-${freshSfx()}.json`;
  const qEntry = { repoPath: identityPathM8, branch: "q-branch", reason: "d2592cd5-m8 — Q (independent on-disk twin)", enteredAt: Date.now(), tokens: [tok, other] };
  pushPendingQuarantineTestOnly(qEntry, qSourceFile);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, qSourceFile), JSON.stringify({ repoPath: identityPathM8, branch: qEntry.branch, reason: qEntry.reason, tokens: qEntry.tokens, enteredAt: qEntry.enteredAt }, null, 2) + "\n");

  const injectM8 = injectRenameFaultAt(path.join(MERGE_QUARANTINE_DIR, qSourceFile));
  try { clearMergeQuarantineByToken(identityPathM8, tok); } finally { injectM8.restore(); }
  check("(m8 precondition) Q's own narrowing rename was forced to fail at least once", injectM8.hits() >= 1);
  check("(m8 precondition, by content) Q's own sourceFile is untouched (still holds tok,other — rename never landed)", sameTokenSet(readTokensOnDisk(qSourceFile), [tok, other]));
  check("(m8 precondition) identityPathM8 still reads blocked, by other alone — Q's own IN-MEMORY entry already narrowed off tok regardless of the write failure", stillBlockedEntryFor(identityPathM8)?.tokens.includes(other) === true && !stillBlockedEntryFor(identityPathM8)?.tokens.includes(tok));

  const sidecarPathM8 = path.join(loomHome, "merge-quarantine-cleared-tokens.dat");
  const sidecarM8 = JSON.parse(fs.readFileSync(sidecarPathM8, "utf8"));
  check("*** THE BLOCKING FIX (PENDING-site audit), BY CONTENT — RED ON PRE-FIX CODE *** the sidecar never durably tombstones tok via R's own deferred remove decision — Q's own reduce-write failed", sidecarM8[tok] === undefined);

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([identityPathM8]);
  const listedAfterBootM8 = rb.listActiveMergeQuarantines().filter((e) => directPathIdentity(e.repoPath) === directPathIdentity(identityPathM8));
  check("*** NEVER FAIL-OPEN, ACROSS A REAL REBOOT *** some boot-time record for identityPathM8 still carries tok — Q's own stale copy was never falsely tombstoned away", listedAfterBootM8.some((e) => e.tokens.includes(tok)));

  fs.rmSync(path.join(MERGE_QUARANTINE_DIR, qSourceFile), { force: true });
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO P2 (2nd Code Review of card 3d4467cf, BLOCKING) — M7's own fix (threading the delegate's
// `anyWriteFailed` into the full-lift backstop) only covers a TIED twin (shares armedKeys with W, so
// `clearMergeQuarantineByKey`'s own pendingPlan ties it and folds its failure into `result.anyWriteFailed`).
// A NON-TWIN pending P sharing the SAME identity — no armedKeys, a wholly separate object, reduced
// EARLIER in this same `clearMergeQuarantineByToken` call's own pre-pass — is invisible to the delegate
// call entirely (P is not in its pendingPlan), so `result.anyWriteFailed` stays false and the backstop's
// bare disk re-scan excludes P's basename as "tracked" (still a live pending entry) regardless of P's
// own write having failed. Closed by ANDing the CALL-SCOPED `writeFailedIdentitiesThisCall` into the
// backstop too — see `clearActiveEntryTokenAtKey`'s own doc.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const w = makeResolvableRepo("p2-w");
  const Kw = canonicalRepoLockKey(w);
  const s = "tok-d2592cd5-p2-s";
  const v = "tok-d2592cd5-p2-v";
  const wEntry = { repoPath: w, branch: "w-branch", reason: "d2592cd5-p2 — W", enteredAt: Date.now(), tokens: [s], resolvedKey: Kw, armedKeys: [Kw] };
  setActiveQuarantineTestOnly(Kw, wEntry);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${quarantineHashForKeyTest(Kw)}.json`), JSON.stringify({ repoPath: w, branch: wEntry.branch, reason: wEntry.reason, tokens: wEntry.tokens, enteredAt: wEntry.enteredAt }, null, 2) + "\n");

  // P: a wholly separate, NON-TWIN pending record for the SAME identity — no armedKeys, never unioned
  // with W in any way (the 535fd69d shape: an unrelated, independently-raised record).
  const pSourceFile = `pending-d2592cd5-p2-nontwin-${freshSfx()}.json`;
  const pEntry = { repoPath: w, branch: "p-branch", reason: "d2592cd5-p2 — P (non-twin, same identity)", enteredAt: Date.now(), tokens: [s, v] };
  pushPendingQuarantineTestOnly(pEntry, pSourceFile);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, pSourceFile), JSON.stringify({ repoPath: w, branch: pEntry.branch, reason: pEntry.reason, tokens: pEntry.tokens, enteredAt: pEntry.enteredAt }, null, 2) + "\n");

  const injectP2 = injectRenameFaultAt(path.join(MERGE_QUARANTINE_DIR, pSourceFile));
  try { clearMergeQuarantineByToken(w, s); } finally { injectP2.restore(); }
  check("(p2 precondition) P's own narrowing rename was forced to fail at least once", injectP2.hits() >= 1);
  check("(p2 precondition, by content) P's own sourceFile is untouched (still holds s,v — rename never landed)", sameTokenSet(readTokensOnDisk(pSourceFile), [s, v]));
  check("(p2 precondition) w still reads blocked, by v alone — P's own IN-MEMORY entry already narrowed off s regardless of the write failure", stillBlockedEntryFor(w)?.tokens.includes(v) === true && !stillBlockedEntryFor(w)?.tokens.includes(s));

  const sidecarPathP2 = path.join(loomHome, "merge-quarantine-cleared-tokens.dat");
  const sidecarP2 = JSON.parse(fs.readFileSync(sidecarPathP2, "utf8"));
  check("*** THE BLOCKING FIX, BY CONTENT — RED ON PRE-FIX CODE *** the sidecar never durably tombstones s via the dispatcher's own full-lift backstop — a NON-TWIN sibling P's own reduce-write (from this SAME call's pre-pass) failed", sidecarP2[s] === undefined);

  const rbP2 = await rebootSim();
  rbP2.reenterMergeQuarantinesAtBoot([w]);
  const listedAfterBootP2 = rbP2.listActiveMergeQuarantines().filter((e) => directPathIdentity(e.repoPath) === directPathIdentity(w));
  check("*** NEVER FAIL-OPEN, ACROSS A REAL REBOOT *** some boot-time record for w still carries s — P's own stale copy was never falsely tombstoned away", listedAfterBootP2.some((e) => e.tokens.includes(s)));

  fs.rmSync(path.join(MERGE_QUARANTINE_DIR, pSourceFile), { force: true });
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO P1a (2nd Code Review of card 3d4467cf, MAJOR, pre-existing) — clearTokenFromPendingIndices's
// own REDUCE branch used to decide its durable tombstone INLINE, at the moment each target is visited —
// unlike the "remove" branch, which card 3d4467cf's first fix round already deferred. Two independent
// pending REDUCE targets Q1 [tok,a] and Q2 [tok,b] sharing one identity, in ONE clearMergeQuarantineByToken
// call: whichever one's own narrowing write fails, the SUCCEEDING sibling's own inline decision scans disk
// with the FAILED sibling's basename excluded as "tracked" (a live pending entry, regardless of its own
// write outcome) and wrongly durably tombstones tok anyway. RED in BOTH iteration orders — deferring
// EVERY reduce target's decision to a pass that runs after the whole batch, ANDed against the SAME
// call-scoped `writeFailedIdentitiesThisCall` the remove branch already uses, closes both. Q1 pushed
// first (lower index) -> processed SECOND in descending order; Q2 pushed second (higher index) ->
// processed FIRST. This scenario faults Q1 (the one processed SECOND, after Q2 already succeeded).
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const identityP1a = path.join(os.tmpdir(), `loom-mqd2592cd5-p1a-never-exists-${freshSfx()}`);
  const tok = "tok-d2592cd5-p1a-tok";
  const a = "tok-d2592cd5-p1a-a";
  const b = "tok-d2592cd5-p1a-b";

  const q1SourceFile = `pending-d2592cd5-p1a-q1-${freshSfx()}.json`;
  const q1Entry = { repoPath: identityP1a, branch: "q1-branch", reason: "d2592cd5-p1a — Q1", enteredAt: Date.now(), tokens: [tok, a] };
  pushPendingQuarantineTestOnly(q1Entry, q1SourceFile);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, q1SourceFile), JSON.stringify({ repoPath: identityP1a, branch: q1Entry.branch, reason: q1Entry.reason, tokens: q1Entry.tokens, enteredAt: q1Entry.enteredAt }, null, 2) + "\n");

  const q2SourceFile = `pending-d2592cd5-p1a-q2-${freshSfx()}.json`;
  const q2Entry = { repoPath: identityP1a, branch: "q2-branch", reason: "d2592cd5-p1a — Q2", enteredAt: Date.now(), tokens: [tok, b] };
  pushPendingQuarantineTestOnly(q2Entry, q2SourceFile);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, q2SourceFile), JSON.stringify({ repoPath: identityP1a, branch: q2Entry.branch, reason: q2Entry.reason, tokens: q2Entry.tokens, enteredAt: q2Entry.enteredAt }, null, 2) + "\n");

  const injectP1a = injectRenameFaultAt(path.join(MERGE_QUARANTINE_DIR, q1SourceFile));
  try { clearMergeQuarantineByToken(identityP1a, tok); } finally { injectP1a.restore(); }
  check("(p1a precondition) Q1's own narrowing rename was forced to fail at least once", injectP1a.hits() >= 1);
  check("(p1a precondition, by content) Q1's own sourceFile is untouched (still holds tok,a — rename never landed)", sameTokenSet(readTokensOnDisk(q1SourceFile), [tok, a]));

  const sidecarPathP1a = path.join(loomHome, "merge-quarantine-cleared-tokens.dat");
  const sidecarP1a = JSON.parse(fs.readFileSync(sidecarPathP1a, "utf8"));
  check("*** THE MAJOR FIX (pre-existing), BY CONTENT — RED ON PRE-FIX CODE *** the sidecar never durably tombstones tok via Q2's own succeeding, inline reduce decision — its SIBLING Q1's own reduce-write (in the SAME batch) failed", sidecarP1a[tok] === undefined);

  const rbP1a = await rebootSim();
  rbP1a.reenterMergeQuarantinesAtBoot([identityP1a]);
  const listedAfterBootP1a = rbP1a.listActiveMergeQuarantines().filter((e) => directPathIdentity(e.repoPath) === directPathIdentity(identityP1a));
  check("*** NEVER FAIL-OPEN, ACROSS A REAL REBOOT (p1a) *** some boot-time record for identityP1a still carries tok", listedAfterBootP1a.some((e) => e.tokens.includes(tok)));

  fs.rmSync(path.join(MERGE_QUARANTINE_DIR, q1SourceFile), { force: true });
  fs.rmSync(path.join(MERGE_QUARANTINE_DIR, q2SourceFile), { force: true });
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO P1b — the SAME shape as P1a, with the OPPOSITE fault: Q2 (processed FIRST) fails this time;
// Q1 (processed SECOND) succeeds. Proves P1a's fix is order-independent, not an artifact of which
// sibling happens to fail.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const identityP1b = path.join(os.tmpdir(), `loom-mqd2592cd5-p1b-never-exists-${freshSfx()}`);
  const tok = "tok-d2592cd5-p1b-tok";
  const a = "tok-d2592cd5-p1b-a";
  const b = "tok-d2592cd5-p1b-b";

  const q1SourceFile = `pending-d2592cd5-p1b-q1-${freshSfx()}.json`;
  const q1Entry = { repoPath: identityP1b, branch: "q1-branch", reason: "d2592cd5-p1b — Q1", enteredAt: Date.now(), tokens: [tok, a] };
  pushPendingQuarantineTestOnly(q1Entry, q1SourceFile);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, q1SourceFile), JSON.stringify({ repoPath: identityP1b, branch: q1Entry.branch, reason: q1Entry.reason, tokens: q1Entry.tokens, enteredAt: q1Entry.enteredAt }, null, 2) + "\n");

  const q2SourceFile = `pending-d2592cd5-p1b-q2-${freshSfx()}.json`;
  const q2Entry = { repoPath: identityP1b, branch: "q2-branch", reason: "d2592cd5-p1b — Q2", enteredAt: Date.now(), tokens: [tok, b] };
  pushPendingQuarantineTestOnly(q2Entry, q2SourceFile);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, q2SourceFile), JSON.stringify({ repoPath: identityP1b, branch: q2Entry.branch, reason: q2Entry.reason, tokens: q2Entry.tokens, enteredAt: q2Entry.enteredAt }, null, 2) + "\n");

  const injectP1b = injectRenameFaultAt(path.join(MERGE_QUARANTINE_DIR, q2SourceFile));
  try { clearMergeQuarantineByToken(identityP1b, tok); } finally { injectP1b.restore(); }
  check("(p1b precondition) Q2's own narrowing rename was forced to fail at least once", injectP1b.hits() >= 1);
  check("(p1b precondition, by content) Q2's own sourceFile is untouched (still holds tok,b — rename never landed)", sameTokenSet(readTokensOnDisk(q2SourceFile), [tok, b]));

  const sidecarPathP1b = path.join(loomHome, "merge-quarantine-cleared-tokens.dat");
  const sidecarP1b = JSON.parse(fs.readFileSync(sidecarPathP1b, "utf8"));
  check("*** THE MAJOR FIX (pre-existing), BY CONTENT — RED ON PRE-FIX CODE, OPPOSITE ORDER *** the sidecar never durably tombstones tok via Q1's own succeeding, inline reduce decision — its SIBLING Q2's own reduce-write (in the SAME batch) failed", sidecarP1b[tok] === undefined);

  const rbP1b = await rebootSim();
  rbP1b.reenterMergeQuarantinesAtBoot([identityP1b]);
  const listedAfterBootP1b = rbP1b.listActiveMergeQuarantines().filter((e) => directPathIdentity(e.repoPath) === directPathIdentity(identityP1b));
  check("*** NEVER FAIL-OPEN, ACROSS A REAL REBOOT (p1b) *** some boot-time record for identityP1b still carries tok", listedAfterBootP1b.some((e) => e.tokens.includes(tok)));

  fs.rmSync(path.join(MERGE_QUARANTINE_DIR, q1SourceFile), { force: true });
  fs.rmSync(path.join(MERGE_QUARANTINE_DIR, q2SourceFile), { force: true });
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO M8B (2nd Code Review of card 3d4467cf, Minor (a)) — M8 above only exercises the
// Q-processed-before-R order (Q pushed AFTER R, so Q has the HIGHER index and is processed FIRST in
// descending order — its own failure is already recorded by the time R's deferred decision runs). This
// mirror, with Q at the LOWER index (pushed before R, so Q is processed SECOND, AFTER R), additionally
// proves R's own decision is genuinely deferred past the WHOLE batch — not merely order-sensitive. Both
// R and Q are constructed directly (never via enterMergeQuarantine) so each can hold a self-chosen token
// regardless of push order.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const identityPathM8b = path.join(os.tmpdir(), `loom-mqd2592cd5-m8b-never-exists-${freshSfx()}`);
  const tok = "tok-d2592cd5-m8b-tok";
  const other = "tok-d2592cd5-m8b-other";

  // Q pushed FIRST (lower index) -> processed SECOND, AFTER R.
  const qSourceFileM8b = `pending-d2592cd5-m8b-q-${freshSfx()}.json`;
  const qEntryM8b = { repoPath: identityPathM8b, branch: "q-branch", reason: "d2592cd5-m8b — Q (reduce, lower index)", enteredAt: Date.now(), tokens: [tok, other] };
  pushPendingQuarantineTestOnly(qEntryM8b, qSourceFileM8b);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, qSourceFileM8b), JSON.stringify({ repoPath: identityPathM8b, branch: qEntryM8b.branch, reason: qEntryM8b.reason, tokens: qEntryM8b.tokens, enteredAt: qEntryM8b.enteredAt }, null, 2) + "\n");

  // R pushed SECOND (higher index) -> processed FIRST, the real full-lift (remove) target.
  const rSourceFileM8b = `pending-d2592cd5-m8b-r-${freshSfx()}.json`;
  const rEntryM8b = { repoPath: identityPathM8b, branch: "r-branch", reason: "d2592cd5-m8b — R (remove, higher index)", enteredAt: Date.now(), tokens: [tok] };
  pushPendingQuarantineTestOnly(rEntryM8b, rSourceFileM8b);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, rSourceFileM8b), JSON.stringify({ repoPath: identityPathM8b, branch: rEntryM8b.branch, reason: rEntryM8b.reason, tokens: rEntryM8b.tokens, enteredAt: rEntryM8b.enteredAt }, null, 2) + "\n");

  const injectM8b = injectRenameFaultAt(path.join(MERGE_QUARANTINE_DIR, qSourceFileM8b));
  try { clearMergeQuarantineByToken(identityPathM8b, tok); } finally { injectM8b.restore(); }
  check("(m8b precondition) Q's own narrowing rename was forced to fail at least once", injectM8b.hits() >= 1);
  check("(m8b precondition, by content) Q's own sourceFile is untouched (still holds tok,other — rename never landed)", sameTokenSet(readTokensOnDisk(qSourceFileM8b), [tok, other]));

  const sidecarPathM8b = path.join(loomHome, "merge-quarantine-cleared-tokens.dat");
  const sidecarM8b = JSON.parse(fs.readFileSync(sidecarPathM8b, "utf8"));
  check("*** THE FIX, ORDER-INDEPENDENT (Minor a) *** the sidecar never durably tombstones tok via R's own deferred remove decision — Q's own reduce-write (processed AFTER R this time) failed", sidecarM8b[tok] === undefined);

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([identityPathM8b]);
  const listedAfterBootM8b = rb.listActiveMergeQuarantines().filter((e) => directPathIdentity(e.repoPath) === directPathIdentity(identityPathM8b));
  check("*** NEVER FAIL-OPEN, ACROSS A REAL REBOOT (m8b) *** some boot-time record for identityPathM8b still carries tok", listedAfterBootM8b.some((e) => e.tokens.includes(tok)));

  fs.rmSync(path.join(MERGE_QUARANTINE_DIR, qSourceFileM8b), { force: true });
  fs.rmSync(path.join(MERGE_QUARANTINE_DIR, rSourceFileM8b), { force: true });
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO M4-AWF (2nd Code Review of card 3d4467cf, Minor (b)) — pins `clearMergeQuarantineByKey`'s own
// `anyWriteFailed` field on its CLEAN return path (no `latchKept` at all) — mutant Md2 (clearing
// `anyWriteFailed` on that return branch alone) survived the full corpus. SAME construction as Scenario
// M4 (a structurally-tied pending twin's own reduce-write fails during a full lift): that write failure
// never sets `anyReferencing`/`anyKeptUnattributed`/`keptContentRepoPaths`, so this result reaches the
// clean-return branch with `anyWriteFailed:true`.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const w = makeResolvableRepo("m4awf-w");
  const Kw = canonicalRepoLockKey(w);
  const s = "tok-d2592cd5-m4awf-s";
  const v = "tok-d2592cd5-m4awf-v";
  const wEntry = { repoPath: w, branch: "w-branch", reason: "d2592cd5-m4awf — W", enteredAt: Date.now(), tokens: [s], resolvedKey: Kw, armedKeys: [Kw] };
  setActiveQuarantineTestOnly(Kw, wEntry);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${quarantineHashForKeyTest(Kw)}.json`), JSON.stringify({ repoPath: w, branch: wEntry.branch, reason: wEntry.reason, tokens: wEntry.tokens, enteredAt: wEntry.enteredAt }, null, 2) + "\n");

  const pSourceFile = `pending-d2592cd5-m4awf-twin-${freshSfx()}.json`;
  const pEntry = { repoPath: w, branch: "p-branch", reason: "d2592cd5-m4awf — P (tied via armedKeys)", enteredAt: Date.now(), tokens: [s, v], armedKeys: [Kw] };
  pushPendingQuarantineTestOnly(pEntry, pSourceFile);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, pSourceFile), JSON.stringify({ repoPath: w, branch: pEntry.branch, reason: pEntry.reason, tokens: pEntry.tokens, enteredAt: pEntry.enteredAt }, null, 2) + "\n");

  const injectM4awf = injectRenameFaultAt(path.join(MERGE_QUARANTINE_DIR, pSourceFile));
  let resultM4awf;
  try { resultM4awf = clearMergeQuarantineByKey(Kw, w, undefined, true); } finally { injectM4awf.restore(); }
  check("(m4awf precondition) P's own twin rename was forced to fail at least once", injectM4awf.hits() >= 1);
  check("*** PINS THE CLEAN-RETURN SHAPE (Minor b) *** this result carries no latchKept at all (the clean-return branch, never the kept/referencing branch)", resultM4awf.latchKept === undefined);
  check("*** KILLS MUTANT Md2 (clearMergeQuarantineByKey's own CLEAN-return anyWriteFailed) *** anyWriteFailed is true on the clean-return path", resultM4awf.anyWriteFailed === true);

  fs.rmSync(path.join(MERGE_QUARANTINE_DIR, pSourceFile), { force: true });
}

// ═════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO P3 (3rd Code Review of card 3d4467cf, BLOCKING finding 1) — the SAME P2 shape, but P's own
// narrowing write is faulted at `fs.openSync` (before any tmp is ever created) rather than at the rename
// (which leaves a real stranded tmp on disk). P2 above passed only incidentally, via the delegate's own
// disk-based orphan/tmp-residue classification happening to notice the stranded tmp — never via the
// write-failure-awareness this card's fix actually provides. With NOTHING stranded, that incidental cover
// is gone: `clearMergeQuarantineByKey`'s own internal durable-tombstone decision (never seeing
// `writeFailedIdentitiesThisCall` at all, pre-fix) wrongly tombstones `s` anyway.
// ═════════════════════════════════════════════════════════════════════════════════════════
function injectOpenFaultForTmpOf(sourceFile) {
  const prefix = `${path.join(MERGE_QUARANTINE_DIR, sourceFile)}.tmp-`;
  const realOpen = fs.openSync;
  let hits = 0;
  fs.openSync = (p, ...rest) => {
    if (typeof p === "string" && p.startsWith(prefix)) {
      hits++;
      throw Object.assign(new Error("EMFILE: simulated open failure"), { code: "EMFILE" });
    }
    return realOpen(p, ...rest);
  };
  return { restore: () => { fs.openSync = realOpen; }, hits: () => hits };
}
{
  const w = makeResolvableRepo("p3-w");
  const Kw = canonicalRepoLockKey(w);
  const s = "tok-d2592cd5-p3-s";
  const v = "tok-d2592cd5-p3-v";
  const wEntry = { repoPath: w, branch: "w-branch", reason: "d2592cd5-p3 — W", enteredAt: Date.now(), tokens: [s], resolvedKey: Kw, armedKeys: [Kw] };
  setActiveQuarantineTestOnly(Kw, wEntry);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${quarantineHashForKeyTest(Kw)}.json`), JSON.stringify({ repoPath: w, branch: wEntry.branch, reason: wEntry.reason, tokens: wEntry.tokens, enteredAt: wEntry.enteredAt }, null, 2) + "\n");

  const pSourceFile = `pending-d2592cd5-p3-nontwin-${freshSfx()}.json`;
  const pEntry = { repoPath: w, branch: "p-branch", reason: "d2592cd5-p3 — P (non-twin, same identity)", enteredAt: Date.now(), tokens: [s, v] };
  pushPendingQuarantineTestOnly(pEntry, pSourceFile);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, pSourceFile), JSON.stringify({ repoPath: w, branch: pEntry.branch, reason: pEntry.reason, tokens: pEntry.tokens, enteredAt: pEntry.enteredAt }, null, 2) + "\n");

  const injectP3 = injectOpenFaultForTmpOf(pSourceFile);
  try { clearMergeQuarantineByToken(w, s); } finally { injectP3.restore(); }
  check("(p3 precondition) P's own tmp open was forced to fail at least once", injectP3.hits() >= 1);
  check("(p3 precondition, by content) P's own sourceFile is untouched (still holds s,v)", sameTokenSet(readTokensOnDisk(pSourceFile), [s, v]));
  check("(p3 precondition) nothing stranded — no tmp residue for P's own sourceFile exists on disk", fs.readdirSync(MERGE_QUARANTINE_DIR).every((f) => !f.startsWith(`${pSourceFile}.tmp-`)));
  check("(p3 precondition) w still reads blocked, by v alone", stillBlockedEntryFor(w)?.tokens.includes(v) === true && !stillBlockedEntryFor(w)?.tokens.includes(s));

  const sidecarPathP3 = path.join(loomHome, "merge-quarantine-cleared-tokens.dat");
  const sidecarP3 = JSON.parse(fs.readFileSync(sidecarPathP3, "utf8"));
  check("*** THE FIX, BY CONTENT — RED ON PRE-FIX CODE (dbaa253d) *** the sidecar never durably tombstones s via the delegate's own internal decision — P's own write failed with NOTHING stranded", sidecarP3[s] === undefined);

  const rbP3 = await rebootSim();
  rbP3.reenterMergeQuarantinesAtBoot([w]);
  const listedAfterBootP3 = rbP3.listActiveMergeQuarantines().filter((e) => directPathIdentity(e.repoPath) === directPathIdentity(w));
  check("*** NEVER FAIL-OPEN, ACROSS A REAL REBOOT (p3) *** some boot-time record for w still carries s", listedAfterBootP3.some((e) => e.tokens.includes(s)));

  fs.rmSync(path.join(MERGE_QUARANTINE_DIR, pSourceFile), { force: true });
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// SCENARIO P4 (3rd Code Review of card 3d4467cf, BLOCKING finding 2) — REVERSE cross-phase order: a
// non-twin pending P (holding ONLY `s`) is fully removed in the PRE-PASS (succeeds cleanly, decided
// EARLY) — but the active entry W (holding [s,v], a REDUCE) fails its OWN write LATER, in the active
// loop. Pre-fix, P's own pre-pass decision was decided AND WRITTEN before W's later failure could ever
// be known; post-fix, both decisions are deferred to the end of the whole public call, so W's later
// failure correctly withholds P's earlier-queued job too.
// ═══════════════════════════════════════════════════════════════════════════
{
  const w = makeResolvableRepo("p4-w");
  const Kw = canonicalRepoLockKey(w);
  const s = "tok-d2592cd5-p4-s";
  const v = "tok-d2592cd5-p4-v";
  const wEntry = { repoPath: w, branch: "w-branch", reason: "d2592cd5-p4 — W (reduce, fails LATER)", enteredAt: Date.now(), tokens: [s, v], resolvedKey: Kw, armedKeys: [Kw] };
  setActiveQuarantineTestOnly(Kw, wEntry);
  const wFinalP4 = path.join(MERGE_QUARANTINE_DIR, `${quarantineHashForKeyTest(Kw)}.json`);
  fs.writeFileSync(wFinalP4, JSON.stringify({ repoPath: w, branch: wEntry.branch, reason: wEntry.reason, tokens: wEntry.tokens, enteredAt: wEntry.enteredAt }, null, 2) + "\n");

  const pSourceFile = `pending-d2592cd5-p4-nontwin-${freshSfx()}.json`;
  const pEntry = { repoPath: w, branch: "p-branch", reason: "d2592cd5-p4 — P (non-twin, full-lift, succeeds EARLY)", enteredAt: Date.now(), tokens: [s] };
  pushPendingQuarantineTestOnly(pEntry, pSourceFile);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, pSourceFile), JSON.stringify({ repoPath: w, branch: pEntry.branch, reason: pEntry.reason, tokens: pEntry.tokens, enteredAt: pEntry.enteredAt }, null, 2) + "\n");

  const injectP4 = injectRenameFaultAt(wFinalP4);
  try { clearMergeQuarantineByToken(w, s); } finally { injectP4.restore(); }
  check("(p4 precondition) W's own final rename was forced to fail at least once", injectP4.hits() >= 1);
  check("(p4 precondition) P's own sourceFile was removed (pre-pass full lift succeeded cleanly)", !fs.existsSync(path.join(MERGE_QUARANTINE_DIR, pSourceFile)));
  check("(p4 precondition, by content) W's own final is untouched (still holds s,v — rename never landed)", sameTokenSet(readTokensOnDisk(path.basename(wFinalP4)), [s, v]));
  check("(p4 precondition) w still reads blocked, by v alone — in-memory already narrowed", stillBlockedEntryFor(w)?.tokens.includes(v) === true && !stillBlockedEntryFor(w)?.tokens.includes(s));

  const sidecarPathP4 = path.join(loomHome, "merge-quarantine-cleared-tokens.dat");
  const sidecarP4 = JSON.parse(fs.readFileSync(sidecarPathP4, "utf8"));
  check("*** THE FIX, BY CONTENT — RED ON PRE-FIX CODE (dbaa253d) *** the sidecar never durably tombstones s via P's own EARLY pre-pass decision — W's own LATER active-reduce write failed, for the SAME identity, in a LATER phase of this SAME call", sidecarP4[s] === undefined);

  const rbP4 = await rebootSim();
  rbP4.reenterMergeQuarantinesAtBoot([w]);
  const listedAfterBootP4 = rbP4.listActiveMergeQuarantines().filter((e) => directPathIdentity(e.repoPath) === directPathIdentity(w));
  check("*** NEVER FAIL-OPEN, ACROSS A REAL REBOOT (p4, reverse order) *** some boot-time record for w still carries s", listedAfterBootP4.some((e) => e.tokens.includes(s)));
}

// ═════════════════════════════════════════════════════════════════════════════
// SCENARIO P5 (3rd Code Review of card 3d4467cf, test 3c — post-arm second-pass failure) — W (active,
// full lift, succeeds cleanly) is decided EARLY, in the active loop. A SECOND pending record Y, for the
// SAME identity, is injected mid-call (as a side effect of W's own final file being unlinked — the exact
// moment the active loop processes W) and did NOT exist (so never held `s`) at call start — Y is
// therefore invisible to the pre-pass and to `identitiesPendingBeforeCall`, and is picked up ONLY by the
// POST-ARM second pending pass, which runs LAST. Y's own narrowing write fails THERE. Pre-fix, W's early
// decision was already durably written long before the post-arm pass even ran; post-fix, both are
// deferred to the end, so the post-arm failure correctly withholds W's earlier-queued job too.
// ═════════════════════════════════════════════════════════════════════════════
function injectOnFirstUnlink(targetPath, sideEffect) {
  const real = fs.unlinkSync;
  let fired = false;
  fs.unlinkSync = (p) => {
    if (!fired && p === targetPath) {
      fired = true;
      sideEffect();
    }
    return real(p);
  };
  return { restore: () => { fs.unlinkSync = real; }, fired: () => fired };
}
{
  const w = makeResolvableRepo("p5-w");
  const Kw = canonicalRepoLockKey(w);
  const s = "tok-d2592cd5-p5-s";
  const x = "tok-d2592cd5-p5-x";
  const wEntry = { repoPath: w, branch: "w-branch", reason: "d2592cd5-p5 — W (full lift, succeeds EARLY)", enteredAt: Date.now(), tokens: [s], resolvedKey: Kw, armedKeys: [Kw] };
  setActiveQuarantineTestOnly(Kw, wEntry);
  const wFinalP5 = path.join(MERGE_QUARANTINE_DIR, `${quarantineHashForKeyTest(Kw)}.json`);
  fs.writeFileSync(wFinalP5, JSON.stringify({ repoPath: w, branch: wEntry.branch, reason: wEntry.reason, tokens: wEntry.tokens, enteredAt: wEntry.enteredAt }, null, 2) + "\n");

  const ySourceFile = `pending-d2592cd5-p5-y-${freshSfx()}.json`;
  const injectY = injectOnFirstUnlink(wFinalP5, () => {
    const yEntry = { repoPath: w, branch: "y-branch", reason: "d2592cd5-p5 — Y (armed mid-call, post-arm reduce target)", enteredAt: Date.now(), tokens: [s, x] };
    pushPendingQuarantineTestOnly(yEntry, ySourceFile);
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, ySourceFile), JSON.stringify({ repoPath: w, branch: yEntry.branch, reason: yEntry.reason, tokens: yEntry.tokens, enteredAt: yEntry.enteredAt }, null, 2) + "\n");
  });
  const injectYFault = injectRenameFaultAt(path.join(MERGE_QUARANTINE_DIR, ySourceFile));
  try { clearMergeQuarantineByToken(w, s); } finally { injectY.restore(); injectYFault.restore(); }
  check("(p5 precondition) Y was injected mid-call, as a side effect of W's own final unlink", injectY.fired());
  check("(p5 precondition) Y's own narrowing write was forced to fail at least once", injectYFault.hits() >= 1);
  check("(p5 precondition, by content) Y's own sourceFile is untouched (still holds s,x — rename never landed)", sameTokenSet(readTokensOnDisk(ySourceFile), [s, x]));

  const sidecarPathP5 = path.join(loomHome, "merge-quarantine-cleared-tokens.dat");
  const sidecarP5 = JSON.parse(fs.readFileSync(sidecarPathP5, "utf8"));
  check("*** THE FIX, BY CONTENT — RED ON PRE-FIX CODE (dbaa253d) *** the sidecar never durably tombstones s via W's own EARLY full-lift decision — Y's own LATER post-arm reduce write failed, for the SAME identity, in the LAST phase of this SAME call", sidecarP5[s] === undefined);

  const rbP5 = await rebootSim();
  rbP5.reenterMergeQuarantinesAtBoot([w]);
  const listedAfterBootP5 = rbP5.listActiveMergeQuarantines().filter((e) => directPathIdentity(e.repoPath) === directPathIdentity(w));
  check("*** NEVER FAIL-OPEN, ACROSS A REAL REBOOT (p5, post-arm failure) *** some boot-time record for w still carries s", listedAfterBootP5.some((e) => e.tokens.includes(s)));

  fs.rmSync(path.join(MERGE_QUARANTINE_DIR, ySourceFile), { force: true });
}

// ═════════════════════════════════════════════════════════════════════════════
// SCENARIO P6 (3rd Code Review of card 3d4467cf, test 3d — CR's Minor #3) — the OPPOSITE direction from
// P4: a non-twin pending P (holding [s,y], a REDUCE) fails its OWN write EARLY, in the pre-pass. The
// active entry W (holding [s,z], ALSO a reduce — never a full lift) succeeds cleanly LATER, in the active
// loop, hitting `clearActiveEntryTokenAtKey`'s own reduce-branch backstop. Pre-fix, that backstop decided
// and wrote immediately, unaware of P's earlier pre-pass failure for the SAME identity; post-fix, it is
// deferred and withheld by the call-scoped set.
// ═════════════════════════════════════════════════════════════════════════════
{
  const w = makeResolvableRepo("p6-w");
  const Kw = canonicalRepoLockKey(w);
  const s = "tok-d2592cd5-p6-s";
  const y = "tok-d2592cd5-p6-y";
  const z = "tok-d2592cd5-p6-z";
  const wEntry = { repoPath: w, branch: "w-branch", reason: "d2592cd5-p6 — W (reduce, succeeds LATER)", enteredAt: Date.now(), tokens: [s, z], resolvedKey: Kw, armedKeys: [Kw] };
  setActiveQuarantineTestOnly(Kw, wEntry);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${quarantineHashForKeyTest(Kw)}.json`), JSON.stringify({ repoPath: w, branch: wEntry.branch, reason: wEntry.reason, tokens: wEntry.tokens, enteredAt: wEntry.enteredAt }, null, 2) + "\n");

  const pSourceFile = `pending-d2592cd5-p6-nontwin-${freshSfx()}.json`;
  const pEntry = { repoPath: w, branch: "p-branch", reason: "d2592cd5-p6 — P (non-twin, reduce, fails EARLY)", enteredAt: Date.now(), tokens: [s, y] };
  pushPendingQuarantineTestOnly(pEntry, pSourceFile);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, pSourceFile), JSON.stringify({ repoPath: w, branch: pEntry.branch, reason: pEntry.reason, tokens: pEntry.tokens, enteredAt: pEntry.enteredAt }, null, 2) + "\n");

  const injectP6 = injectRenameFaultAt(path.join(MERGE_QUARANTINE_DIR, pSourceFile));
  try { clearMergeQuarantineByToken(w, s); } finally { injectP6.restore(); }
  check("(p6 precondition) P's own narrowing rename was forced to fail at least once", injectP6.hits() >= 1);
  check("(p6 precondition, by content) P's own sourceFile is untouched (still holds s,y — rename never landed)", sameTokenSet(readTokensOnDisk(pSourceFile), [s, y]));
  check("(p6 precondition) w still reads blocked, by z alone — W's own in-memory write succeeded cleanly", stillBlockedEntryFor(w)?.tokens.includes(z) === true && !stillBlockedEntryFor(w)?.tokens.includes(s));

  const sidecarPathP6 = path.join(loomHome, "merge-quarantine-cleared-tokens.dat");
  const sidecarP6 = JSON.parse(fs.readFileSync(sidecarPathP6, "utf8"));
  // NOTE: this direction (failure chronologically BEFORE the decision) was already correctly handled on
  // dbaa253d — the pre-pass unconditionally runs to completion, and folds its own failure into the
  // SHARED `writeFailedIdentitiesThisCall` set, before the active loop's own backstop ever reads it. This
  // scenario is therefore a COVERAGE PIN for the ~:5722 decision point (mirrors M8B/M4-AWF above, not a
  // live dbaa253d bug) — verified mutant-provable, not RED-on-dbaa253d: see Mutant (iii) in the record.
  check("*** THE FIX, BY CONTENT *** the sidecar never durably tombstones s via W's own LATER, successful active-reduce decision — P's own EARLIER pre-pass write failed, for the SAME identity", sidecarP6[s] === undefined);

  const rbP6 = await rebootSim();
  rbP6.reenterMergeQuarantinesAtBoot([w]);
  const listedAfterBootP6 = rbP6.listActiveMergeQuarantines().filter((e) => directPathIdentity(e.repoPath) === directPathIdentity(w));
  check("*** NEVER FAIL-OPEN, ACROSS A REAL REBOOT (p6, pre-pass withholds active-reduce) *** some boot-time record for w still carries s", listedAfterBootP6.some((e) => e.tokens.includes(s)));

  fs.rmSync(path.join(MERGE_QUARANTINE_DIR, pSourceFile), { force: true });
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO P7 (4th Code Review of card 3d4467cf, CRITICAL, reproduced via a scratch probe) — W is ACTIVE,
// holding [s] alone, undergoing a FULL LIFT. A non-twin pending P, SAME identity, also holds [s] alone —
// its own job is pushed in the PRE-PASS, with push-time `nonFailureOk:true` (W's own final was still
// "tracked" — a live activeQuarantines entry — at that moment, so the push-time disk scan excluded it).
// W's own full-lift happens LATER, in the active loop: its own final unlink fails (EPERM). Pre-fix,
// `deleteMergeQuarantineLatchByKey` swallowed this failure entirely — neither `anyWriteFailed` nor
// `writeFailedIdentitiesThisCall` ever learned of it — so P's own stale push-time verdict sailed through
// unchallenged at decide time, and `s` got durably tombstoned even though W's own final still physically
// held it. After a reboot, boot deleted W's kept final as "covered by the tombstone", and the quarantine
// failed open. Fixed by BOTH Lead rulings together: (1) the unlink failure now surfaces into `writeFailed`/
// `anyWriteFailed`; (2) `decideDeferredTombstones` ALSO re-derives the physical-holder scan fresh, at
// decide time, for every job.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const w = makeResolvableRepo("p7-w");
  const Kw = canonicalRepoLockKey(w);
  const s = "tok-d2592cd5-p7-s";
  const wEntry = { repoPath: w, branch: "w-branch", reason: "d2592cd5-p7 — W (full lift, fails LATE via unlink)", enteredAt: Date.now(), tokens: [s], resolvedKey: Kw, armedKeys: [Kw] };
  setActiveQuarantineTestOnly(Kw, wEntry);
  const wFinalP7 = path.join(MERGE_QUARANTINE_DIR, `${quarantineHashForKeyTest(Kw)}.json`);
  fs.writeFileSync(wFinalP7, JSON.stringify({ repoPath: w, branch: wEntry.branch, reason: wEntry.reason, tokens: wEntry.tokens, enteredAt: wEntry.enteredAt }, null, 2) + "\n");

  const pSourceFileP7 = `pending-d2592cd5-p7-nontwin-${freshSfx()}.json`;
  const pEntryP7 = { repoPath: w, branch: "p-branch", reason: "d2592cd5-p7 — P (non-twin, full-lift, succeeds EARLY)", enteredAt: Date.now(), tokens: [s] };
  pushPendingQuarantineTestOnly(pEntryP7, pSourceFileP7);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, pSourceFileP7), JSON.stringify({ repoPath: w, branch: pEntryP7.branch, reason: pEntryP7.reason, tokens: pEntryP7.tokens, enteredAt: pEntryP7.enteredAt }, null, 2) + "\n");

  const injectP7 = injectUnlinkFaultAt(wFinalP7);
  try { clearMergeQuarantineByToken(w, s); } finally { injectP7.restore(); }
  check("(p7 precondition) W's own final unlink was forced to fail exactly once", injectP7.hits() === 1);
  check("(p7 precondition) P's own sourceFile was removed (pre-pass full lift succeeded cleanly)", !fs.existsSync(path.join(MERGE_QUARANTINE_DIR, pSourceFileP7)));
  check("(p7 precondition, by content) W's own final is untouched — still holds s, unlink never landed", sameTokenSet(readTokensOnDisk(path.basename(wFinalP7)), [s]));
  check("(p7 precondition) w reads fully unblocked IN-PROCESS — both W's in-memory arm and P were removed from live tracking regardless of the unlink's own outcome (the card's own original 'in-process unblocked, reboot re-blocks' symptom)", stillBlockedEntryFor(w) === undefined);

  const sidecarPathP7 = path.join(loomHome, "merge-quarantine-cleared-tokens.dat");
  const sidecarP7 = fs.existsSync(sidecarPathP7) ? JSON.parse(fs.readFileSync(sidecarPathP7, "utf8")) : {};
  check("*** THE FIX, BY CONTENT — RED ON PRE-FIX CODE *** the sidecar never durably tombstones s via P's own early, now-stale push-time verdict — W's own final unlink failed LATER, in the active loop", sidecarP7[s] === undefined);

  const rbP7 = await rebootSim();
  rbP7.reenterMergeQuarantinesAtBoot([w]);
  const listedAfterBootP7 = rbP7.listActiveMergeQuarantines().filter((e) => directPathIdentity(e.repoPath) === directPathIdentity(w));
  check("*** NEVER FAIL-OPEN, ACROSS A REAL REBOOT (p7) *** some boot-time record for w still carries s", listedAfterBootP7.some((e) => e.tokens.includes(s)));
  check("*** NEVER FAIL-OPEN (p7) *** w still reads blocked by s after the reboot", rbP7.stillBlockedEntryFor(w)?.tokens.includes(s) === true);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO P8 (card 3d4467cf round 4, `removeWriteFailed` in clearTokenFromPendingIndices's "remove" branch)
// — the KEY-DRIFT shape (entryStillOwnsKey's third branch): pending P holds [s] alone and names Kw in its
// armedKeys, but a DIFFERENT object Q (same identity, tokens a SUBSET of P's) occupies Kw in
// activeQuarantines. P's plan is therefore "remove" with ownedArmedKeys=[Kw]; the remove branch unlinks
// Kw's final, and that unlink FAILS (EPERM) — the final still physically holds s. The call must NEVER
// durably tombstone s. NOTE (documented in the decision record): THREE independent masks withhold this exact
// shape — `removeWriteFailed`, `decideDeferredTombstones`'s decide-time physical re-scan (ruling 2), and the
// remove branch's push-time `nonFailureOk` — so a mutant must turn ALL THREE off to flip it.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const w = makeResolvableRepo("p8-w");
  const Kw = canonicalRepoLockKey(w);
  const s = "tok-d2592cd5-p8-s";
  const qEntry = { repoPath: w, branch: "q-branch", reason: "d2592cd5-p8 — Q (drifted occupant of Kw)", enteredAt: Date.now(), tokens: [s], resolvedKey: Kw, armedKeys: [Kw] };
  setActiveQuarantineTestOnly(Kw, qEntry);
  const kwFinalP8 = path.join(MERGE_QUARANTINE_DIR, `${quarantineHashForKeyTest(Kw)}.json`);
  fs.writeFileSync(kwFinalP8, JSON.stringify({ repoPath: w, branch: qEntry.branch, reason: qEntry.reason, tokens: qEntry.tokens, enteredAt: qEntry.enteredAt }, null, 2) + "\n");

  const pSourceFileP8 = `pending-d2592cd5-p8-${freshSfx()}.json`;
  const pEntryP8 = { repoPath: w, branch: "p-branch", reason: "d2592cd5-p8 — P (pending, names Kw, a DIFFERENT object holds it)", enteredAt: Date.now(), tokens: [s], armedKeys: [Kw] };
  pushPendingQuarantineTestOnly(pEntryP8, pSourceFileP8);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, pSourceFileP8), JSON.stringify({ repoPath: w, branch: pEntryP8.branch, reason: pEntryP8.reason, tokens: pEntryP8.tokens, enteredAt: pEntryP8.enteredAt }, null, 2) + "\n");

  const idxP8 = mod.findPendingIndexByIdentityTestOnly(w);
  check("(p8 precondition) P is a pending entry and Q (a different object) occupies Kw", idxP8 !== -1 && listActiveMergeQuarantines().some((e) => e === qEntry || (directPathIdentity(e.repoPath) === directPathIdentity(w) && e.branch === "q-branch")));

  const injectP8 = injectUnlinkFaultAt(kwFinalP8);
  try { mod.clearTokenFromPendingIndicesTestOnly([idxP8], s); } finally { injectP8.restore(); }
  check("(p8 precondition) Kw's final unlink was forced to fail exactly once (the remove branch reached deleteMergeQuarantineLatchByKey)", injectP8.hits() === 1);
  check("(p8 precondition, by content) Kw's final is untouched — still holds s, the unlink never landed", sameTokenSet(readTokensOnDisk(path.basename(kwFinalP8)), [s]));

  const sidecarPathP8 = path.join(loomHome, "merge-quarantine-cleared-tokens.dat");
  const sidecarP8 = fs.existsSync(sidecarPathP8) ? JSON.parse(fs.readFileSync(sidecarPathP8, "utf8")) : {};
  check("*** THE FIX, BY CONTENT *** the sidecar never durably tombstones s — Kw's final unlink failed inside the remove branch", sidecarP8[s] === undefined);

  const rbP8 = await rebootSim();
  rbP8.reenterMergeQuarantinesAtBoot([w]);
  check("*** NEVER FAIL-OPEN, ACROSS A REAL REBOOT (p8) *** w still reads blocked by s after the reboot", rbP8.stillBlockedEntryFor(w)?.tokens.includes(s) === true);
}

console.log(failures === 0
  ? "\n✅ ALL CHECKS PASS — a reboot between clears no longer resurrects an already-cleared token for an unresolvable identity with multiple independent on-disk records, and the fix never fails open (a failed write, or a failed tombstone write, only ever over-blocks, exactly like the pre-existing, already-accepted posture)."
  : `\n❌ ${failures} CHECK(S) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
