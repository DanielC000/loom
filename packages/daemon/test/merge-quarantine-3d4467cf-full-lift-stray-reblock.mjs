import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 3d4467cf. An ACCEPTED RESIDUAL of d2592cd5 (CR round 2, probe P4), boarded deliberately —
// see docs/decisions/d2592cd5-durable-cleared-tokens-tombstone.md's "Follow-up (card 3d4467cf)" section
// (and its own later "fix round" subsection, added by a subsequent Code Review of THIS card's fix).
//
// @decision d2592cd5 — read the record's "Follow-up (card 3d4467cf)" section for the full narrative,
// including why the original "no separate write/sweep-failure tracking is needed" claim there was later
// found incomplete (a tied pending twin's own reduce-write CAN fail invisibly) and fixed.
//
// Per `59e758e5`'s own "Do not": never call a resolve-aware query (`activeMergeQuarantineFor`/
// `resolveQuarantineFor`) between an injected clear and a later durable assertion — that chokepoint's
// own "lazy re-resolve on first query" self-heal can mask the exact loss/resurrection a scenario like this
// exists to prove. Every check below reads either the quarantine dir's own on-disk CONTENT directly, or
// `listActiveMergeQuarantines()`/`stillBlockedEntryFor` (pure peeks, never self-healing).
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-3d4467cf-full-lift-stray-reblock.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

const loomHome = useOwnLoomHome("loom-mq3d4467cf-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const mod = await import(mergeQuarantineModuleHref);
const {
  enterMergeQuarantine, clearMergeQuarantineByToken,
  listActiveMergeQuarantines, stillBlockedEntryFor, directPathIdentity, MERGE_QUARANTINE_DIR,
  pushPendingQuarantineTestOnly, setActiveQuarantineTestOnly,
} = mod;
const repoLockModuleHref = pathToFileURL(path.join(distGitDir, "repo-lock.js")).href;
const { canonicalRepoLockKey } = await import(repoLockModuleHref);
const GIT_ID = "-c user.email=mq3d4467cf@loom -c user.name=mq3d4467cf";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function makeResolvableRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mq3d4467cf-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), `# ${tag}\n`);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "mq3d4467cf@loom"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "mq3d4467cf"], { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

function quarantineHashForKeyTest(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}
function quarantinePathForKeyTest(key) {
  return path.join(MERGE_QUARANTINE_DIR, `${quarantineHashForKeyTest(key)}.json`);
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

let bootReimportCounter = 0;
async function rebootSim() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b3d4467cf=${bootReimportCounter}`);
}

function sidecarContents() {
  const sidecarPath = path.join(loomHome, "merge-quarantine-cleared-tokens.dat");
  return fs.existsSync(sidecarPath) ? JSON.parse(fs.readFileSync(sidecarPath, "utf8")) : {};
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO A (REVISED — FAIL-CLOSED PROOF, never a "bug fixed" proof) — the card's own exact sequence,
// at `clearTokenFromPendingIndices`'s own REMOVE (full-lift) branch (a PENDING-only, unresolvable
// identity): raise t1,t2; an untracked stray holds t2 ONLY; clear t1 (reduce — durably tombstoned, since
// the stray never held t1); clear t2 (full lift). A GENUINE stray still physically holding t2 means the
// new gate MUST, correctly, withhold the durable tombstone — so the repo correctly STAYS BLOCKED after a
// real reboot. This is the required safety property, unchanged by this card's own fix (never fail open).
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const a = path.join(os.tmpdir(), `loom-mq3d4467cf-a-never-exists-${freshSfx()}`);
  const t1 = enterMergeQuarantine(a, "loom/3d4467cf-a-1", "3d4467cf-a: raise 1 (t1)");
  const t2 = enterMergeQuarantine(a, "loom/3d4467cf-a-2", "3d4467cf-a: raise 2 (t2)");

  const sourceFile = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => f.endsWith(".json") && sameTokenSet(readTokensOnDisk(f), [t1, t2]));
  check("(precondition) found the tracked pending latch file on disk holding t1+t2", typeof sourceFile === "string");

  // An AE-shaped UNTRACKED stray, never named in anyone's `orphanLatchFiles` — holds t2 ONLY (never t1),
  // mirroring d2592cd5's own established Scenario H/I/J planting pattern.
  const strayPath = path.join(MERGE_QUARANTINE_DIR, `stray-3d4467cf-a-${freshSfx()}.json`);
  fs.writeFileSync(strayPath, JSON.stringify({
    repoPath: a, branch: "loom/3d4467cf-a-stray", reason: "AE-shaped untracked sibling (never in orphanLatchFiles)",
    enteredAt: Date.now(), tokens: [t2],
  }, null, 2) + "\n", "utf8");
  check("(precondition) the untracked stray sibling genuinely holds t2 on disk", sameTokenSet(readTokensOnDisk(path.basename(strayPath)), [t2]));

  clearMergeQuarantineByToken(a, t1);
  check("(precondition) the tracked copy durably narrowed to just t2", sameTokenSet(readTokensOnDisk(sourceFile), [t2]));
  check("(precondition) a still reads blocked, by t2, right after clearing t1", stillBlockedEntryFor(a)?.tokens.includes(t2) === true);
  check("(precondition) t1 WAS durably tombstoned (no AE stray ever held it)", sidecarContents()[t1] !== undefined);

  clearMergeQuarantineByToken(a, t2);
  check("(precondition) a reads fully unblocked IN-PROCESS right after the full lift of t2", stillBlockedEntryFor(a) === undefined);
  check("*** FAIL-CLOSED, BY CONTENT *** the new gate correctly WITHHOLDS the durable tombstone for t2 — the untracked stray still physically holds it", sidecarContents()[t2] === undefined);

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([a]);

  const afterBoot = rb.stillBlockedEntryFor(a);
  check("*** NEVER FAIL-OPEN, ACROSS A REAL REBOOT *** a correctly STAYS BLOCKED after a reboot — t2 must never resurrect-away a token a genuine on-disk sibling still holds", afterBoot !== undefined && afterBoot.tokens.includes(t2));
  const listedAfterBoot = rb.listActiveMergeQuarantines().filter((e) => directPathIdentity(e.repoPath) === directPathIdentity(a));
  check("(by content) some boot-time record for a still carries t2, via the untracked stray", listedAfterBoot.some((e) => e.tokens.includes(t2)));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO B — THE FIX'S ACTUAL VALUE (ordinary case, no contention): raise t1,t2 for an unresolvable
// identity; NO stray anywhere. Clear t1 (reduce, durably tombstoned). Clear t2 (full lift) — nothing
// physically contends it, so the new gate's disk scan finds nothing and the durable tombstone now fires.
// *** RED ON PRE-FIX CODE *** (the full-lift branch never called `tombstoneDurablyIfConfirmed` at all,
// so t2 was NEVER durably recorded even though nothing needed protecting) — GREEN after this fix.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const b = path.join(os.tmpdir(), `loom-mq3d4467cf-b-never-exists-${freshSfx()}`);
  const t1 = enterMergeQuarantine(b, "loom/3d4467cf-b-1", "3d4467cf-b: raise 1 (t1)");
  const t2 = enterMergeQuarantine(b, "loom/3d4467cf-b-2", "3d4467cf-b: raise 2 (t2)");

  clearMergeQuarantineByToken(b, t1);
  check("(precondition) b still reads blocked, by t2, right after clearing t1", stillBlockedEntryFor(b)?.tokens.includes(t2) === true);
  check("(precondition) t1 WAS durably tombstoned", sidecarContents()[t1] !== undefined);

  clearMergeQuarantineByToken(b, t2);
  check("(precondition) b reads fully unblocked right after the full lift of t2", stillBlockedEntryFor(b) === undefined);
  check("(precondition, by content) nothing on disk anywhere still names b's own identity", !fs.readdirSync(MERGE_QUARANTINE_DIR).some((f) => { try { return JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f), "utf8")).repoPath === b; } catch { return false; } }));

  check("*** THE FIX, BY CONTENT — RED ON PRE-FIX CODE *** t2 IS now durably tombstoned (nothing contended it)", sidecarContents()[t2] !== undefined);

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([b]);
  check("(sanity) b stays unblocked after a reboot either way, since nothing physically survives for it regardless of this fix", rb.stillBlockedEntryFor(b) === undefined);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO C — manager item 2(i): an INDUCED delete/unlink failure on the record's own file during the
// full-lift (never a pre-existing stray this time) ⇒ NO durable tombstone, and the identity correctly
// STAYS BLOCKED after a real reboot. Same fail-closed property as Scenario A, via a DIFFERENT mechanism
// (a write/unlink failure, not an untracked sibling) — the new gate's post-mutation disk scan catches
// BOTH shapes the same way, with no separate write/sweep-failure tracking needed.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const c = path.join(os.tmpdir(), `loom-mq3d4467cf-c-never-exists-${freshSfx()}`);
  const t1 = enterMergeQuarantine(c, "loom/3d4467cf-c-1", "3d4467cf-c: raise 1 (t1)");

  const sourceFile = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => f.endsWith(".json") && sameTokenSet(readTokensOnDisk(f), [t1]));
  check("(precondition) found the tracked pending latch file on disk holding t1 alone", typeof sourceFile === "string");
  const sourcePath = path.join(MERGE_QUARANTINE_DIR, sourceFile);

  const injectUnlink = injectUnlinkFaultAt(sourcePath);
  try { clearMergeQuarantineByToken(c, t1); } finally { injectUnlink.restore(); }
  check("(precondition) the record's own unlink was forced to fail at least once", injectUnlink.hits() > 0);
  check("(precondition, by content) the file genuinely survives on disk, still holding t1 (the unlink never landed)", sameTokenSet(readTokensOnDisk(sourceFile), [t1]));
  check("(precondition) c reads fully unblocked IN-PROCESS right after the clear (in-memory lift still proceeds)", stillBlockedEntryFor(c) === undefined);

  check("*** FAIL-CLOSED, BY CONTENT (induced unlink failure) *** the new gate correctly WITHHOLDS the durable tombstone for t1 — the file's own unlink never confirmed", sidecarContents()[t1] === undefined);

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([c]);
  const afterBoot = rb.stillBlockedEntryFor(c);
  check("*** NEVER FAIL-OPEN, ACROSS A REAL REBOOT (induced unlink failure) *** c correctly STAYS BLOCKED after a reboot", afterBoot !== undefined && afterBoot.tokens.includes(t1));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO G1 — manager item 1: the `clearActiveEntryTokenAtKey` `remaining.length===0` SECOND-CALL
// shape. The delegated `clearMergeQuarantineByKey` call withholds ITS OWN durable tombstone for an
// UNRELATED reason (a genuinely foreign, uncovered orphan file it content-keeps) — even though `token`
// itself (g1's own t1) is NOT physically contended anywhere. The new gate at the SECOND call checks
// `token` alone, independent of that unrelated batch-level decision, and correctly durably tombstones it
// anyway. *** RED ON PRE-FIX CODE *** (sidecar never gains t1, by content) — GREEN after this fix.
// Nothing physically survives for g1's own identity either way (its own file IS fully deleted), so — same
// as Scenario B — there is no reboot-visible resurrection to prevent here; the observable difference is
// the durable sidecar's own content, checked directly.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const g1 = makeResolvableRepo("g1-repo");
  const key = canonicalRepoLockKey(g1);
  const t1 = enterMergeQuarantine(g1, "loom/3d4467cf-g1-1", "3d4467cf-g1: raise 1 (t1)");

  const sourceFile = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => f.endsWith(".json") && sameTokenSet(readTokensOnDisk(f), [t1]));
  check("(precondition) found the tracked ARMED latch file on disk holding t1 alone", typeof sourceFile === "string");

  // Plant a genuinely foreign, UNRESOLVABLE orphan file and track it in g1's own `orphanLatchFiles` — a
  // pre-existing, legitimate shape (e.g. a prior clear's own tmp-residue sweep tracked it there). It
  // names a DIFFERENT identity (zOrphan) holding a DIFFERENT, disjoint, uncovered token — genuinely
  // foreign content the orphan-sweep must content-keep, never destroy blind.
  const zOrphan = path.join(os.tmpdir(), `loom-mq3d4467cf-g1-zorphan-never-exists-${freshSfx()}`);
  const tZ = "zorphan-disjoint-token-0001";
  const orphanBasename = `orphan-g1-${freshSfx()}.json`;
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, orphanBasename), JSON.stringify({
    repoPath: zOrphan, branch: "z-branch", reason: "a genuinely foreign, unresolvable orphan (pre-existing, tracked)",
    enteredAt: Date.now() - 1000, tokens: [tZ],
  }, null, 2) + "\n", "utf8");

  const liveEntries = listActiveMergeQuarantines().filter((e) => e.repoPath === g1);
  check("(precondition) exactly one live entry for g1 before the orphan-file injection", liveEntries.length === 1);
  setActiveQuarantineTestOnly(key, { ...liveEntries[0], orphanLatchFiles: [orphanBasename] });
  check("(precondition) g1's own live entry now tracks the foreign orphan file", listActiveMergeQuarantines().find((e) => e.repoPath === g1)?.orphanLatchFiles?.includes(orphanBasename) === true);

  clearMergeQuarantineByToken(g1, t1);
  check("(precondition) g1 reads fully unblocked right after the full lift of t1", stillBlockedEntryFor(g1) === undefined);
  check("(precondition, by content) g1's own tracked latch file is genuinely gone", !fs.existsSync(path.join(MERGE_QUARANTINE_DIR, sourceFile)));
  check("(precondition, by content) the foreign orphan file SURVIVES, content-kept — never destroyed blind", fs.existsSync(path.join(MERGE_QUARANTINE_DIR, orphanBasename)) && sameTokenSet(readTokensOnDisk(orphanBasename), [tZ]));

  check("*** THE FIX, BY CONTENT — RED ON PRE-FIX CODE *** t1 IS durably tombstoned despite the delegated call withholding its OWN tombstone for the unrelated foreign orphan", sidecarContents()[t1] !== undefined);

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([g1]);
  check("(sanity) g1 stays unblocked after a reboot (nothing of its own survives on disk either way)", rb.stillBlockedEntryFor(g1) === undefined);
  check("(sanity) the foreign orphan's own identity is unaffected and still reads blocked by tZ after the reboot", rb.stillBlockedEntryFor(zOrphan)?.tokens.includes(tZ) === true);

  try { fs.unlinkSync(path.join(MERGE_QUARANTINE_DIR, orphanBasename)); } catch { /* best-effort cleanup */ }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO G2 — FAIL-CLOSED companion to G1: the SAME unrelated-foreign-orphan shape, PLUS a genuine AE
// stray that ALSO, separately, still physically holds g2's own t1. The new gate at the second call must
// correctly WITHHOLD — never fail open just because the delegated call's own withhold was for an
// unrelated reason. Proves the new gate's own disk re-verification is load-bearing here, independent of
// (and not fooled by) the unrelated co-occupant complication.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const g2 = makeResolvableRepo("g2-repo");
  const key = canonicalRepoLockKey(g2);
  const t1 = enterMergeQuarantine(g2, "loom/3d4467cf-g2-1", "3d4467cf-g2: raise 1 (t1)");

  const sourceFile = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => f.endsWith(".json") && sameTokenSet(readTokensOnDisk(f), [t1]));

  const zOrphan = path.join(os.tmpdir(), `loom-mq3d4467cf-g2-zorphan-never-exists-${freshSfx()}`);
  const tZ = "zorphan-disjoint-token-0002";
  const orphanBasename = `orphan-g2-${freshSfx()}.json`;
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, orphanBasename), JSON.stringify({
    repoPath: zOrphan, branch: "z-branch", reason: "a genuinely foreign, unresolvable orphan (pre-existing, tracked)",
    enteredAt: Date.now() - 1000, tokens: [tZ],
  }, null, 2) + "\n", "utf8");
  const liveEntries = listActiveMergeQuarantines().filter((e) => e.repoPath === g2);
  setActiveQuarantineTestOnly(key, { ...liveEntries[0], orphanLatchFiles: [orphanBasename] });

  // ALSO plant a genuine, untracked AE stray for g2's OWN identity, holding t1 — this is the shape that
  // must independently defeat the new gate, regardless of the unrelated orphan complication above.
  const strayPath = path.join(MERGE_QUARANTINE_DIR, `stray-g2-${freshSfx()}.json`);
  fs.writeFileSync(strayPath, JSON.stringify({
    repoPath: g2, branch: "loom/3d4467cf-g2-stray", reason: "AE-shaped untracked sibling (never in orphanLatchFiles)",
    enteredAt: Date.now(), tokens: [t1],
  }, null, 2) + "\n", "utf8");

  clearMergeQuarantineByToken(g2, t1);
  check("(precondition) g2 reads fully unblocked IN-PROCESS right after the full lift of t1", stillBlockedEntryFor(g2) === undefined);
  check("(precondition, by content) the untracked AE stray for g2 survives, still holding t1", sameTokenSet(readTokensOnDisk(path.basename(strayPath)), [t1]));

  check("*** NEVER FAIL-OPEN, BY CONTENT *** the new gate correctly WITHHOLDS the durable tombstone for t1 — a genuine AE stray for g2's own identity still holds it", sidecarContents()[t1] === undefined);

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([g2]);
  const afterBoot = rb.stillBlockedEntryFor(g2);
  check("*** NEVER FAIL-OPEN, ACROSS A REAL REBOOT *** g2 correctly STAYS BLOCKED after a reboot, via the untracked stray", afterBoot !== undefined && afterBoot.tokens.includes(t1));

  try { fs.unlinkSync(path.join(MERGE_QUARANTINE_DIR, orphanBasename)); } catch { /* best-effort cleanup */ }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO D — manager item 2(ii): `deleteMergeQuarantineLatchByKey`'s own `protectUnincorporatedOccupantBeforeDelete`
// sub-path (wrapping the shared `protectOccupantContentBeforeDelete` tail), REACHABLE from a full-lift
// (`clearActiveEntryTokenAtKey`'s delegated `clearMergeQuarantineByKey` call, `keysToLift` loop): d's own
// physical latch file is overwritten with a GENUINELY FOREIGN, unresolvable occupant's content (zUnincorp)
// before the clear — a legitimate "physical bytes drifted from the in-memory record" shape this module's
// own design already accepts (e.g. a shared-key collision). Proves: (1) the protect path actually FIRES
// (zUnincorp's content survives, relocated to its own new file, never destroyed blind); (2) d's own t1 —
// genuinely unrelated to zUnincorp — still gets correctly, durably tombstoned; (3) the relocated foreign
// content is never misattributed to d's own identity (it carries zUnincorp's own repoPath throughout, so
// `identityHasAnyPhysicalRecordHoldingToken(identity(d), ...)` structurally cannot mistake it for d's own).
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const d = makeResolvableRepo("d-repo");
  const key = canonicalRepoLockKey(d);
  const t1 = enterMergeQuarantine(d, "loom/3d4467cf-d-1", "3d4467cf-d: raise 1 (t1)");
  const finalPath = quarantinePathForKeyTest(key);
  check("(precondition) d's own armed latch physically exists at its own key", fs.existsSync(finalPath));

  const zUnincorp = path.join(os.tmpdir(), `loom-mq3d4467cf-d-zunincorp-never-exists-${freshSfx()}`);
  const tZu = "zunincorp-disjoint-token-0001";
  // Overwrite d's own physical file directly — simulates the physical bytes at this exact key having
  // drifted to a genuinely foreign, unresolvable occupant's content (never d's own).
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: zUnincorp, branch: "zu-branch", reason: "a genuinely foreign occupant physically at d's own key",
    enteredAt: Date.now() - 1000, tokens: [tZu],
  }, null, 2) + "\n", "utf8");

  const filesBefore = new Set(fs.readdirSync(MERGE_QUARANTINE_DIR));
  clearMergeQuarantineByToken(d, t1);
  check("(precondition) d reads fully unblocked right after the full lift of t1", stillBlockedEntryFor(d) === undefined);
  check("(precondition, by content) d's own physical key file is genuinely gone (unlinked)", !fs.existsSync(finalPath));

  const filesAfter = fs.readdirSync(MERGE_QUARANTINE_DIR);
  const relocatedFile = filesAfter.find((f) => !filesBefore.has(f) && readTokensOnDisk(f)?.includes(tZu));
  check("*** PROTECT PATH FIRED (protectUnincorporatedOccupantBeforeDelete) *** zUnincorp's own foreign content SURVIVES, relocated to a fresh file — never destroyed blind", typeof relocatedFile === "string");

  check("*** REGRESSION CHECK (delegate/protect-path), NOT evidence for the new write-failure gate — passes under all four gate mutants *** d's own t1 is still correctly, durably tombstoned despite the foreign-content protect path firing at the exact same key", sidecarContents()[t1] !== undefined);

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([d, zUnincorp]);
  check("(sanity) d stays unblocked after a reboot", rb.stillBlockedEntryFor(d) === undefined);
  check("*** NEVER MISATTRIBUTED *** zUnincorp's own identity still reads blocked by tZu after the reboot — its relocated content was never folded into d's own", rb.stillBlockedEntryFor(zUnincorp)?.tokens.includes(tZu) === true);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO E — manager item 2(ii): `deleteMergeQuarantineLatchByKey`'s own `protectForeignTmpResidueBeforeSweep`
// sub-path, REACHABLE from the SAME full-lift loop (it runs unconditionally whenever `clearIdentity` is
// truthy, right after the main unlink). A genuinely foreign, unresolvable tmp residue (zTmp) shares e's
// own key's hash prefix. Proves the same three properties as Scenario D, for this DIFFERENT sub-path.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const e = makeResolvableRepo("e-repo");
  const key = canonicalRepoLockKey(e);
  const t1 = enterMergeQuarantine(e, "loom/3d4467cf-e-1", "3d4467cf-e: raise 1 (t1)");

  const zTmp = path.join(os.tmpdir(), `loom-mq3d4467cf-e-ztmp-never-exists-${freshSfx()}`);
  const tZt = "ztmp-disjoint-token-0001";
  const tmpPath = path.join(MERGE_QUARANTINE_DIR, `${quarantineHashForKeyTest(key)}.json.tmp-${Date.now()}-${(Math.random().toString(16) + "000000").slice(2, 8)}`); // boot's strict `.tmp-<pid>-<hex>` shape (base36 freshSfx would not match it)
  fs.writeFileSync(tmpPath, JSON.stringify({
    repoPath: zTmp, branch: "zt-branch", reason: "a genuinely foreign, unresolvable tmp residue sharing e's own key hash",
    enteredAt: Date.now() - 1000, tokens: [tZt],
  }, null, 2) + "\n", "utf8");
  check("(precondition) the foreign tmp residue genuinely exists before the clear", fs.existsSync(tmpPath));

  const filesBefore = new Set(fs.readdirSync(MERGE_QUARANTINE_DIR));
  clearMergeQuarantineByToken(e, t1);
  check("(precondition) e reads fully unblocked right after the full lift of t1", stillBlockedEntryFor(e) === undefined);

  const filesAfter = fs.readdirSync(MERGE_QUARANTINE_DIR);
  const survivingZt = filesAfter.find((f) => readTokensOnDisk(f)?.includes(tZt));
  check("*** PROTECT PATH FIRED (protectForeignTmpResidueBeforeSweep) *** zTmp's own foreign content SURVIVES somewhere on disk — never destroyed blind", typeof survivingZt === "string");
  check("(by content) the original tmp residue is gone (relocated) or, if kept, is the SAME surviving file", !fs.existsSync(tmpPath) || survivingZt === path.basename(tmpPath));

  check("*** REGRESSION CHECK (delegate/protect-path), NOT evidence for the new write-failure gate — passes under all four gate mutants *** e's own t1 is still correctly, durably tombstoned despite the foreign tmp-residue protect path firing at the same key hash", sidecarContents()[t1] !== undefined);

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([e, zTmp]);
  check("(sanity) e stays unblocked after a reboot", rb.stillBlockedEntryFor(e) === undefined);
  check("*** NEVER MISATTRIBUTED *** zTmp's own identity still reads blocked by tZt after the reboot", rb.stillBlockedEntryFor(zTmp)?.tokens.includes(tZt) === true);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO F — manager item 2(ii): `deleteMergeQuarantineLatchByKey`'s own DIRECT `protectOccupantContentBeforeDelete`
// call (the `foreignPending` branch, lines ~3206-3243 — distinct from `protectUnincorporatedOccupantBeforeDelete`'s
// own wrapper, exercised by Scenario D) — reachable ONLY via an 883e29bc-style dual-tracked-twin: a
// pending wrapper for f's OWN identity, independently also armed, whose `armedKeys` names a key that a
// SEPARATE, genuinely foreign pending wrapper's own `sourceFile` ALSO names. Constructed directly via the
// test-only setters (this exact collision is real but rare in production — an on-disk hash coincidence
// at a physically shared key between two unrelated identities' own pending records is not independently
// reachable through the public API without reproducing 883e29bc's own boot-divert mechanism, which this
// construction deliberately stands in for). Proves the SAME three properties as Scenario D, pinning that
// THIS specific branch — not just its sibling wrapper — never relocates/protects f's OWN content.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const f = makeResolvableRepo("f-repo");
  const key = canonicalRepoLockKey(f);
  const t1 = enterMergeQuarantine(f, "loom/3d4467cf-f-1", "3d4467cf-f: raise 1 (t1)");
  const finalPath = quarantinePathForKeyTest(key);
  const finalBasename = path.basename(finalPath);

  const zForeign = path.join(os.tmpdir(), `loom-mq3d4467cf-f-zforeign-never-exists-${freshSfx()}`);
  const tZf = "zforeign-disjoint-token-0001";

  // A genuinely foreign pending wrapper claiming f's OWN physical final basename — the `foreignPending`
  // shape `deleteMergeQuarantineLatchByKey` checks for directly.
  pushPendingQuarantineTestOnly({
    repoPath: zForeign, branch: "zf-branch", reason: "a genuinely foreign pending twin sharing f's own key basename",
    enteredAt: Date.now() - 1000, tokens: [tZf],
  }, finalBasename);
  // The physical bytes at f's own key now genuinely show zForeign's content too (confirms the pending
  // claim — case (a) in `deleteMergeQuarantineLatchByKey`'s own foreignPending branch).
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: zForeign, branch: "zf-branch", reason: "a genuinely foreign pending twin sharing f's own key basename",
    enteredAt: Date.now() - 1000, tokens: [tZf],
  }, null, 2) + "\n", "utf8");

  // f's OWN dual-tracked twin: a SEPARATE pending wrapper (own identity f, own token t1, armedKeys:[key])
  // at its OWN, unrelated sourceFile — `clearMergeQuarantineByToken`'s own `nonTwinPendingIndices` filter
  // only excludes a pending wrapper that is REFERENCE-equal to something already in `activeQuarantines`,
  // so this distinct object is included and routed through `clearTokenFromPendingIndices`.
  const twinSourceFile = `twin-f-${freshSfx()}.json`;
  pushPendingQuarantineTestOnly({
    repoPath: f, branch: "loom/3d4467cf-f-1", reason: "f's own dual-tracked twin",
    enteredAt: Date.now(), tokens: [t1], armedKeys: [key],
  }, twinSourceFile);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, twinSourceFile), JSON.stringify({
    repoPath: f, branch: "loom/3d4467cf-f-1", reason: "f's own dual-tracked twin", enteredAt: Date.now(), tokens: [t1],
  }, null, 2) + "\n", "utf8");

  clearMergeQuarantineByToken(f, t1);
  check("(precondition) f reads fully unblocked right after the full lift of t1", stillBlockedEntryFor(f) === undefined);
  check("(precondition, by content) f's own key file is genuinely gone (unlinked)", !fs.existsSync(finalPath));
  check("(precondition, by content) f's own twin sourceFile is genuinely gone (unlinked)", !fs.existsSync(path.join(MERGE_QUARANTINE_DIR, twinSourceFile)));

  const survivingZf = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f2) => readTokensOnDisk(f2)?.includes(tZf));
  check("*** PROTECT PATH FIRED (protectOccupantContentBeforeDelete, direct foreignPending branch) *** zForeign's own content SURVIVES somewhere on disk — never destroyed blind", typeof survivingZf === "string");

  check("*** SAFE, BY CONTENT *** f's own t1 is still correctly, durably tombstoned despite the direct foreignPending protect branch firing at the exact same key", sidecarContents()[t1] !== undefined);

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([f, zForeign]);
  check("(sanity) f stays unblocked after a reboot", rb.stillBlockedEntryFor(f) === undefined);
  check("*** NEVER MISATTRIBUTED *** zForeign's own identity still reads blocked by tZf after the reboot", rb.stillBlockedEntryFor(zForeign)?.tokens.includes(tZf) === true);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
