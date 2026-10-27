import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision 8bc779f0 (round 3) — clearedTokens is now identity-scoped (token -> clearing identities):
// a cross-identity bleed (398f476c/f575cebf) no longer lets one identity's clear wrongly tombstone
// another's still-outstanding token. See the decision record's round-3 section.
//
// Production mints a card-702b4241 UNREADABLE placeholder ONLY at boot (reenterMergeQuarantinesAtBootImpl,
// :7591-9287 as of this card). Within ONE process (no reboot — clearedTokens is in-memory only), the
// realistic route to "a cleared token still sits in a readable record" is therefore a SIBLING record's
// own clear (the bleed class), never this record's own staleness. Every scenario below ENGINEERS the
// placeholder/marked end-state directly via the same test-only hooks this corpus already uses — but every
// function call exercised AFTER that point (the raise, the clear, the reconcile) is the real, unmodified
// production code path.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-8bc779f0-round3-identity-scoped-tombstone.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome, registerForCleanup } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq8bc77r3-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  MERGE_QUARANTINE_DIR, enterMergeQuarantine, clearMergeQuarantineByToken,
  setActiveQuarantineTestOnly, markLatchFileUnreadableTestOnly, listActiveMergeQuarantines,
  PLACEHOLDER_BRANCH_UNREADABLE, clearMergeQuarantineReporting, clearMergeQuarantineLatchFile,
  activeMergeQuarantineFor, pushPendingQuarantineTestOnly, directPathIdentity,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const note = (label) => console.log(`NOTE  ${label}`);
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const hashForKey = (k) => createHash("sha256").update(k).digest("hex").slice(0, 24);

fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

function freshRepo(tag) {
  const p = path.join(os.tmpdir(), `loom-mq8bc77r3-${tag}-${freshSfx()}`);
  fs.mkdirSync(p, { recursive: true });
  registerForCleanup(p);
  return p;
}

function placeholderize(key, finalPath, repoPath, memTokens, diskTokens, diskBranch) {
  const synth = `8bc77r3-synthetic-${freshSfx()}`;
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath, branch: diskBranch, reason: "8bc779f0 round3: stale pre-clear snapshot",
    enteredAt: Date.now() - 60_000, tokens: diskTokens,
  }, null, 2) + "\n");
  setActiveQuarantineTestOnly(key, {
    repoPath, branch: PLACEHOLDER_BRANCH_UNREADABLE, reason: "8bc779f0 round3: boot-minted placeholder",
    enteredAt: Date.now() - 120_000, tokens: [synth, ...memTokens], placeholder: true, armedKeys: [key],
  });
  markLatchFileUnreadableTestOnly(path.basename(finalPath));
  return synth;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 3 (Q1 regression pin, CR's own fixture A) — a genuine durable-write FAILURE during a
// partial clear must still keep the cleared token out once the SAME identity's own record reconciles,
// and the repo must still fully lift once every owner's own token is cleared. Must stay green under the
// round-3 identity-scoped redesign exactly as it did before.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const y = freshRepo("s3-y");
  const k = canonicalRepoLockKey(y);
  const fin = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(k)}.json`);
  const t1 = enterMergeQuarantine(y, "s3-b1", "s3-r1");
  const t2 = enterMergeQuarantine(y, "s3-b2", "s3-r2");

  const realOpenSync = fs.openSync;
  let injectedFailures = 0;
  fs.openSync = (p, ...rest) => {
    if (typeof p === "string" && p.startsWith(fin)) { injectedFailures++; throw Object.assign(new Error("ENOSPC: simulated"), { code: "ENOSPC" }); }
    return realOpenSync(p, ...rest);
  };
  clearMergeQuarantineByToken(y, t1);
  fs.openSync = realOpenSync;
  note(`(s3) injected ${injectedFailures} open failure(s) during the partial clear`);
  check("(s3 precondition) the write failure fired at least once", injectedFailures > 0);
  check("(s3 precondition) disk still shows t1 (the durable write failed)", (JSON.parse(fs.readFileSync(fin, "utf8")).tokens ?? []).includes(t1));
  check("(s3 precondition) in-memory already dropped t1 (enforcement is authoritative regardless of durable write success)", !(listActiveMergeQuarantines().find((e) => e.repoPath === y)?.tokens ?? []).includes(t1));

  // Force the reingest branch over the genuinely-stale bytes the failed write left behind.
  const synth = placeholderize(k, fin, y, [t2], JSON.parse(fs.readFileSync(fin, "utf8")).tokens, "s3-stale-branch");
  const t3 = enterMergeQuarantine(y, "s3-b3", "s3-r3");
  const memAfter = listActiveMergeQuarantines().find((e) => e.repoPath === y);
  note(`(s3) in-memory y after reingest: ${JSON.stringify(memAfter?.tokens)}`);
  check("*** Q1 HOLDS *** t1 stays out after the reingest (same identity, correctly tombstoned)", !!memAfter && !memAfter.tokens.includes(t1));
  check("(s3 sanity) t2/t3 survive the reingest", !!memAfter && memAfter.tokens.includes(t2) && memAfter.tokens.includes(t3));

  clearMergeQuarantineByToken(y, t2);
  clearMergeQuarantineByToken(y, t3);
  clearMergeQuarantineByToken(y, synth);
  check("*** Q1 HOLDS *** y fully lifts once every genuinely-outstanding owner clears", !activeMergeQuarantineFor(y));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 4 (S1, CR's own fixture B, ported) — a human clear of Y must never tombstone X's own,
// still-outstanding token just because it bled into Y's own record (398f476c/f575cebf). RED on
// pre-round-3 code (X wrongly lifts); GREEN after.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const x = freshRepo("s4-x");
  const kx = canonicalRepoLockKey(x);
  const finX = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kx)}.json`);
  const yy = freshRepo("s4-yy");
  const ky = canonicalRepoLockKey(yy);
  const finY = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ky)}.json`);
  const xTok = `s4-xtok-${freshSfx()}`;
  const yTok = `s4-ytok-${freshSfx()}`;

  fs.writeFileSync(finX, JSON.stringify({ repoPath: x, branch: "s4-xb", reason: "s4: x prior-process raise", enteredAt: Date.now() - 1e5, tokens: [xTok] }, null, 2) + "\n");
  fs.writeFileSync(finY, JSON.stringify({ repoPath: yy, branch: "s4-yb", reason: "s4: y prior raise (contaminated)", enteredAt: Date.now() - 1e5, tokens: [yTok, xTok] }, null, 2) + "\n");
  setActiveQuarantineTestOnly(ky, { repoPath: yy, branch: "s4-yb", reason: "s4-y", enteredAt: Date.now() - 1e5, tokens: [yTok, xTok], armedKeys: [ky] });
  setActiveQuarantineTestOnly(kx, { repoPath: x, branch: PLACEHOLDER_BRANCH_UNREADABLE, reason: "s4-ph", enteredAt: Date.now(), tokens: [`s4-synth-${freshSfx()}`], placeholder: true, armedKeys: [kx] });
  markLatchFileUnreadableTestOnly(path.basename(finX));

  const r = clearMergeQuarantineReporting(yy);
  note(`(s4) human-clear-Y => wasQuarantined=${r.wasQuarantined} lifted=${JSON.stringify(r.liftedRepoPaths)}`);
  check("(s4 precondition) Y's clear reports wasQuarantined", r.wasQuarantined === true);
  check("(s4 precondition) X is still blocked immediately after Y's clear", !!activeMergeQuarantineFor(x));

  const f = enterMergeQuarantine(x, "s4-xb2", "s4: fresh x raise after Y's clear");
  const memX = listActiveMergeQuarantines().find((e) => e.repoPath === x);
  note(`(s4) X after reingest: ${JSON.stringify(memX?.tokens)}`);
  check("*** THE FIX (S1) *** X's own genuinely-outstanding xTok does NOT resurrect-then-vanish — it SURVIVES Y's unrelated clear", !!memX && memX.tokens.includes(xTok));

  clearMergeQuarantineByToken(x, f);
  const stillQuarantinedAfterOwnerClearsOnlyFreshToken = !!activeMergeQuarantineFor(x);
  note(`(s4) X after clearing only the fresh raiser's own token f: still-quarantined=${stillQuarantinedAfterOwnerClearsOnlyFreshToken}`);
  check("*** THE FIX (S1) *** X stays quarantined — xTok's own real owner never cleared it", stillQuarantinedAfterOwnerClearsOnlyFreshToken);
  check("(s4 sanity) X's own disk file still exists (never wrongly lifted/deleted)", fs.existsSync(finX));

  clearMergeQuarantineByToken(x, xTok);
  for (const t of [...(listActiveMergeQuarantines().find((e) => e.repoPath === x)?.tokens ?? [])].filter((t) => t.startsWith("s4-synth-"))) clearMergeQuarantineByToken(x, t);
  check("(s4 sanity) X finally lifts once every genuinely-outstanding token (xTok + the leftover synthetic) is cleared", !activeMergeQuarantineFor(x));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 5 (condition 1) — the CLEARING identity and the RECORD identity differ only in case/
// separators (Windows): directPathIdentity must still collapse them to the SAME key, or normalizing at
// one site but not the other swaps a fail-open for a forever-stuck (a genuinely-cleared token that can
// never again be recognized as cleared against its own record).
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const y = freshRepo("s5-y");
  const k = canonicalRepoLockKey(y);
  const fin = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(k)}.json`);
  const t1 = enterMergeQuarantine(y, "s5-b1", "s5-r1"); // clearingIdentity will be entry.repoPath = y, original spelling
  const t2 = enterMergeQuarantine(y, "s5-b2", "s5-r2");
  clearMergeQuarantineByToken(y, t1);

  // The record's OWN declared repoPath differs from `y` only in case and separator direction.
  const yAltSpelling = y.toUpperCase().replace(/\\/g, "/");
  check("(s5 precondition) the alt spelling really is textually different from the original", yAltSpelling !== y);
  const diskOnly = `s5-disk-only-${freshSfx()}`;
  fs.writeFileSync(fin, JSON.stringify({ repoPath: yAltSpelling, branch: "s5-GENUINE", reason: "s5: stale, alt-spelled repoPath", enteredAt: Date.now() - 60_000, tokens: [t1, t2, diskOnly] }, null, 2) + "\n");
  const synth = `s5-synthetic-${freshSfx()}`;
  setActiveQuarantineTestOnly(k, { repoPath: y, branch: PLACEHOLDER_BRANCH_UNREADABLE, reason: "s5-ph", enteredAt: Date.now() - 120_000, tokens: [synth, t2], placeholder: true, armedKeys: [k] });
  markLatchFileUnreadableTestOnly(path.basename(fin));

  const t3 = enterMergeQuarantine(y, "s5-b3", "s5-r3");
  // The reingest can ADOPT the disk record's own (alt-spelled) repoPath verbatim (latchEntryFromParsedRecord
  // copies the raw string) — match by NORMALIZED identity, never exact string equality, to find it either way.
  const yIdentity = directPathIdentity(y);
  const memAfter = listActiveMergeQuarantines().find((e) => directPathIdentity(e.repoPath) === yIdentity);
  note(`(s5) in-memory y after reingest over an alt-spelled record: ${JSON.stringify(memAfter?.tokens)}`);
  check("*** NORMALIZATION HOLDS *** t1 stays filtered even though the record's own repoPath is spelled differently", !!memAfter && !memAfter.tokens.includes(t1));
  check("(s5 sanity) t2/diskOnly/t3 all survive", !!memAfter && [t2, diskOnly, t3].every((t) => memAfter.tokens.includes(t)));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 6 — the ONE genuinely plural-identity tombstone call site (clearMergeQuarantineLatchFile's
// own pending branch, ~:7366): two UNRELATED identities' pending entries sharing one physical latch
// file (and so one bare id) are cleared together in a single call — each one's own token must be
// tombstoned under ITS OWN identity, never a flat set attributed to one arbitrary identity.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const x1 = freshRepo("s6-x1");
  const x2 = freshRepo("s6-x2");
  const sharedSourceFile = `${hashForKey(`s6-shared-${freshSfx()}`)}.json`;
  const x1Tok = `s6-x1tok-${freshSfx()}`;
  const x2Tok = `s6-x2tok-${freshSfx()}`;
  pushPendingQuarantineTestOnly({ repoPath: x1, branch: "s6-x1b", reason: "s6-x1r", enteredAt: Date.now(), tokens: [x1Tok] }, sharedSourceFile);
  pushPendingQuarantineTestOnly({ repoPath: x2, branch: "s6-x2b", reason: "s6-x2r", enteredAt: Date.now(), tokens: [x2Tok] }, sharedSourceFile);

  const id = sharedSourceFile.slice(0, -".json".length);
  const clearResult = clearMergeQuarantineLatchFile(id);
  note(`(s6) plural-identity clear-by-id => ${JSON.stringify(clearResult)}`);
  check("(s6 precondition) the id-addressed clear reports wasQuarantined", clearResult.wasQuarantined === true);

  // Each identity's OWN separate, genuine physical record (never the shared pending file above) still
  // carries its own token — confirm each one's tombstone landed under ITS OWN identity, never the
  // other's or a single arbitrary one.
  for (const [identityPath, tok] of [[x1, x1Tok], [x2, x2Tok]]) {
    const key = canonicalRepoLockKey(identityPath);
    const finalPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(key)}.json`);
    const diskOnly = `s6-disk-only-${freshSfx()}`;
    fs.writeFileSync(finalPath, JSON.stringify({ repoPath: identityPath, branch: "s6-GENUINE", reason: "s6: own stale record", enteredAt: Date.now() - 60_000, tokens: [tok, diskOnly] }, null, 2) + "\n");
    const synth = `s6-synthetic-${freshSfx()}`;
    setActiveQuarantineTestOnly(key, { repoPath: identityPath, branch: PLACEHOLDER_BRANCH_UNREADABLE, reason: "s6-ph", enteredAt: Date.now() - 120_000, tokens: [synth], placeholder: true, armedKeys: [key] });
    markLatchFileUnreadableTestOnly(path.basename(finalPath));
    enterMergeQuarantine(identityPath, "s6-fresh", "s6: fresh raise after the plural clear");
    const memAfter = listActiveMergeQuarantines().find((e) => e.repoPath === identityPath);
    note(`(s6) ${path.basename(identityPath)} after reingest: ${JSON.stringify(memAfter?.tokens)}`);
    check(`*** THE FIX (plural) *** ${path.basename(identityPath)}'s own token stays tombstoned under ITS OWN identity`, !!memAfter && !memAfter.tokens.includes(tok));
    check(`(s6 sanity) ${path.basename(identityPath)}'s own disk-only token survives`, !!memAfter && memAfter.tokens.includes(diskOnly));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 7 (condition 3) — a cross-identity case on a COVERAGE READER (orphanSweepSafeToDelete):
// Y's clear tombstones a token that X's OWN, genuinely-unrelated orphan file also carries — X's file
// must NOT be judged safe to delete. Reached through the real orphanLatchFiles sweep every identity-wide
// clear runs (clearMergeQuarantineByKey -> sweepOrphanLatchFileIfUnreferenced -> orphanSweepSafeToDelete).
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const z = freshRepo("s7-z");
  const kz = canonicalRepoLockKey(z);
  const finZ = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kz)}.json`);
  const zTok = `s7-ztok-${freshSfx()}`;
  const x = freshRepo("s7-x");
  const xTok = `s7-xtok-${freshSfx()}`;
  // X's OWN genuine, still-outstanding content — deliberately at an ARBITRARY filename, never X's own
  // current canonical key, so it is a genuine "orphan reference" (a stale/migrated-away backing), not a
  // live final `physicalOwnerRepoPaths` would protect structurally regardless of content.
  const orphanFile = `${hashForKey(`s7-orphan-${freshSfx()}`)}.json`;
  const orphanPath = path.join(MERGE_QUARANTINE_DIR, orphanFile);
  fs.writeFileSync(orphanPath, JSON.stringify({ repoPath: x, branch: "s7-xb", reason: "s7: x's own genuine, still-outstanding raise", enteredAt: Date.now() - 1e5, tokens: [xTok] }, null, 2) + "\n");

  // Z's own record is CONTAMINATED (bled) with xTok — the same pre-existing 398f476c/f575cebf shape
  // fixture B (Scenario 4) drives through a different route.
  fs.writeFileSync(finZ, JSON.stringify({ repoPath: z, branch: "s7-zb", reason: "s7: z's own raise, contaminated", enteredAt: Date.now() - 1e5, tokens: [zTok, xTok] }, null, 2) + "\n");
  setActiveQuarantineTestOnly(kz, { repoPath: z, branch: "s7-zb", reason: "s7-z", enteredAt: Date.now() - 1e5, tokens: [zTok, xTok], armedKeys: [kz] });
  clearMergeQuarantineByToken(z, xTok); // ordinary partial clear -> tombstones xTok under Z's OWN identity

  const yy = freshRepo("s7-yy");
  const ky = canonicalRepoLockKey(yy);
  const yTok = `s7-ytok-${freshSfx()}`;
  // Y's own entry references the orphan file — a completely ordinary, real shape (a tracked stale
  // reference), constructed directly so this test doesn't need to re-derive how one gets created.
  setActiveQuarantineTestOnly(ky, { repoPath: yy, branch: "s7-yb", reason: "s7-y", enteredAt: Date.now(), tokens: [yTok], armedKeys: [ky], orphanLatchFiles: [orphanFile] });

  const r = clearMergeQuarantineReporting(yy);
  note(`(s7) human-clear-Y => wasQuarantined=${r.wasQuarantined}`);
  check("(s7 precondition) Y's clear reports wasQuarantined", r.wasQuarantined === true);

  const orphanSurvives = fs.existsSync(orphanPath);
  note(`(s7) X's own orphan file survives Y's unrelated clear: ${orphanSurvives}`);
  check("*** THE FIX (coverage reader) *** X's own genuine orphan file is NOT deleted as a side effect of Y's unrelated clear", orphanSurvives);
  if (orphanSurvives) {
    const stillHasXTok = (JSON.parse(fs.readFileSync(orphanPath, "utf8")).tokens ?? []).includes(xTok);
    check("(s7 sanity) the surviving file still genuinely carries xTok", stillHasXTok);
  }
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
