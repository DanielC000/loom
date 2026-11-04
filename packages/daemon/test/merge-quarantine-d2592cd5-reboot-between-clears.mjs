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
// this entry's full lift — `keptContentRepoPaths.size>0`. The durable tombstone must still be WITHHELD;
// the mutant would persist it anyway.
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

  rbM5.clearMergeQuarantineByToken(m5, t1);
  check("(m5 precondition) m5 reads fully unblocked right after the clear", rbM5.stillBlockedEntryFor(m5) === undefined);
  check("(m5 precondition, by content) the foreign orphan survives on disk (content-kept, never swept)", fs.existsSync(path.join(MERGE_QUARANTINE_DIR, orphanBasenameM5)));

  const sidecarPathM5 = path.join(loomHome, "merge-quarantine-cleared-tokens.dat");
  const sidecarM5 = JSON.parse(fs.readFileSync(sidecarPathM5, "utf8"));
  check("*** KILLS MUTANT 3 (clearMergeQuarantineByKey content-kept term) *** the sidecar never durably tombstones t1 while a foreign orphan was content-kept", sidecarM5[t1] === undefined);

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

console.log(failures === 0
  ? "\n✅ ALL CHECKS PASS — a reboot between clears no longer resurrects an already-cleared token for an unresolvable identity with multiple independent on-disk records, and the fix never fails open (a failed write, or a failed tombstone write, only ever over-blocks, exactly like the pre-existing, already-accepted posture)."
  : `\n❌ ${failures} CHECK(S) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
