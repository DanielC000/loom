import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 7845ae33 (polarity test for the combined 59e758e5 + 7845ae33 change, manager gen 458).
//
// @decision 59e758e5 — a relocated safety-tmp record meeting a degraded occupant (now MERGED, 4be98ac8)
// never loses a token; the identity stays blocked until the LAST one clears. Read records BY CONTENT.
//
// Scenarios E-H (4be98ac8 review round) pin each guard of the fold: kept-means-tracked, take-all,
// identity gate, and armed-twin re-point.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-7845ae33-relocated-record-polarity.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq7845-pol-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const repoLockModuleHref = pathToFileURL(path.join(distGitDir, "repo-lock.js")).href;
const mod = await import(mergeQuarantineModuleHref);
const { MERGE_QUARANTINE_DIR } = mod;
const { canonicalRepoLockKey } = await import(repoLockModuleHref);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mq7845pol@loom -c user.name=mq7845pol";
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const hashForKey = (k) => createHash("sha256").update(k).digest("hex").slice(0, 24);

function makeToplevelRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mq7845pol-repo-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), `# ${tag}\n`);
  execSync(`git init -q && git config user.email mq7845pol@loom && git config user.name mq7845pol`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

function listDirFiles() { return fs.readdirSync(MERGE_QUARANTINE_DIR); }
function readJsonSafe(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }
function readTextSafe(p) { try { return fs.readFileSync(p, "utf8"); } catch { return null; } }

// Reads EVERY file in MERGE_QUARANTINE_DIR whose parsed content names `repoPath`, BY CONTENT — never a
// single in-memory lookup — and unions their own on-disk `tokens`. The content-level ground truth this
// whole test's polarity claim rests on.
function onDiskTokensFor(repoPath) {
  const files = listDirFiles().filter((f) => readJsonSafe(path.join(MERGE_QUARANTINE_DIR, f))?.repoPath === repoPath);
  return { files, tokens: new Set(files.flatMap((f) => readJsonSafe(path.join(MERGE_QUARANTINE_DIR, f))?.tokens ?? [])) };
}

function injectOneShotRenameFailure(targetPath) {
  const real = fs.renameSync;
  let tripped = false;
  fs.renameSync = (src, dest) => {
    if (!tripped && dest === targetPath) { tripped = true; fs.renameSync = real; throw Object.assign(new Error("EPERM: simulated"), { code: "EPERM" }); }
    return real(src, dest);
  };
  return { restore: () => { fs.renameSync = real; }, tripped: () => tripped };
}

let bootReimportCounter = 0;
async function rebootSim() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

// Builds the shape card 4be98ac8's decision record documents: a relocated-via-safety-tmp record
// (tokens dT1,dT2) plus a hand-crafted degraded-occupant record written directly at a THIRD repo's own
// canonical-key final (token dOccupantToken) that a later raise of that third repo discovers; protect
// finds the relocated record and MERGES both into ONE pending record (no split).
function buildSplit(tag, m) {
  const r = makeToplevelRepo(`${tag}-r`);
  const Kr = canonicalRepoLockKey(r);
  const d = path.join(r, `gone-subdir-${tag}`);

  const dT1 = m.enterMergeQuarantine(d, `loom/${tag}-d1`, `${tag}: first raise of d (dT1)`);
  const filesAfterD1 = listDirFiles().filter((f) => readJsonSafe(path.join(MERGE_QUARANTINE_DIR, f))?.repoPath === d);
  if (filesAfterD1.length !== 1) throw new Error(`${tag}: expected exactly one pending file for d after the first raise, got ${filesAfterD1.length}`);
  const basePath = path.join(MERGE_QUARANTINE_DIR, filesAfterD1[0]);

  const inject = injectOneShotRenameFailure(basePath);
  let dT2;
  try {
    dT2 = m.enterMergeQuarantine(d, `loom/${tag}-d2`, `${tag}: second raise of d (dT2), rename forced to fail`);
  } finally {
    inject.restore();
  }
  if (!inject.tripped()) throw new Error(`${tag}: injected rename failure on d's own second raise never tripped`);
  if (fs.existsSync(basePath)) throw new Error(`${tag}: d's own original pending file was expected to be swept after the safety-tmp fallback`);

  // Hand-craft D's own EARLIER, independent degraded entry directly at R's own canonical-key final —
  // standing in for a prior raise of D's that happened to arm at R's own key before R itself was ever
  // raised (same construction `merge-quarantine-raise-protect-failure.mjs`'s own "6451a749-never-scanned"
  // scenario uses for the identical "degraded occupant physically sitting at a third repo's final" shape;
  // not reachable via a live raise alone).
  const KrHash = hashForKey(Kr);
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${KrHash}.json`);
  const dOccupantToken = `${tag}-docc-${freshSfx()}`;
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d, branch: `${tag}-d-earlier-branch`, reason: `${tag}: D's own degraded entry, walked up to R's own real key`,
    enteredAt: Date.now() - 100000, tokens: [dOccupantToken],
  }, null, 2) + "\n");

  const rToken = m.enterMergeQuarantine(r, `loom/${tag}-r`, `${tag}: r raises, discovering D as a foreign degraded occupant at its own final`);

  return { r, d, dT1, dT2, dOccupantToken, rToken, finalPath };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO A ("7845ae33-pol-inproc") — in-process leg: build the relocated + occupant shape, confirm no
// token is lost (by content) and the two merged into ONE record, then the polarity claim itself —
// clearing the relocated tokens (dT1, dT2) must still leave `d` blocked by the occupant's token, and
// only clearing THAT one too actually releases it.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const tag = "7845ae33-pol-inproc";
  const { r, d, dT1, dT2, dOccupantToken, rToken, finalPath } = buildSplit(tag, mod);

  check(`(${tag}) r's own raise lands directly at its own final (the existing, legitimate-overwrite path, unaffected by this card)`,
    (readTextSafe(finalPath) ?? "").includes(rToken));

  const after = onDiskTokensFor(d);
  console.log(`(diagnostic ${tag}) files on disk for d: ${JSON.stringify(after.files)}`);
  check(`(${tag}) *** THE CLAIM *** no token is ever lost — dT1, dT2, AND dOccupantToken are ALL held by SOME on-disk record, read by content`,
    after.tokens.has(dT1) && after.tokens.has(dT2) && after.tokens.has(dOccupantToken));
  // @decision 4be98ac8 — protect now FINDS the relocated safety-tmp record: ONE merged record, no split.
  check(`(${tag}) *** card 4be98ac8 *** exactly ONE on-disk record for d now (merged), not a split`, after.files.length === 1);
  check(`(${tag}) the one record is the deterministic pending-<hash>.json and the relocated safety-tmp file is swept`,
    after.files.length === 1 && /^pending-[0-9a-f]{24}\.json$/.test(after.files[0]));

  check(`(${tag}) (precondition) d is quarantined before any clear`, mod.resolveQuarantineForTestOnly(d));
  check(`(${tag}) (precondition, pure peek) stillBlockedEntryFor/resolveQuarantineFor agree before any clear`,
    (mod.stillBlockedEntryFor(d) !== undefined) === mod.resolveQuarantineForTestOnly(d));

  // @decision 59e758e5 (B5) — clear r's own token FIRST: r's own ACTIVE quarantine shares d's own
  // walked-up degraded key, so leaving it outstanding makes a "d still blocked" check vacuous — it
  // cannot fail, since r alone keeps d reading blocked no matter what happens to d's own records below.
  mod.clearMergeQuarantineByToken(r, rToken);

  // *** THE POLARITY CHECK *** — clear EVERY token the relocated (first-raised) record holds. `d` must
  // remain blocked because the merged record still holds dOccupantToken. A regression here would mean
  // clearing some tokens silently released the whole identity — exactly the "unenforced" failure this test
  // exists to catch.
  mod.clearMergeQuarantineByToken(d, dT1);
  mod.clearMergeQuarantineByToken(d, dT2);
  check(`(${tag}) *** THE POLARITY CLAIM *** after clearing the relocated record's own tokens (dT1, dT2) AND r's own unrelated token, d is STILL blocked — the merged record's dOccupantToken ALONE still enforces it`,
    mod.resolveQuarantineForTestOnly(d));
  const afterPartialClear = onDiskTokensFor(d);
  check(`(${tag}) by content: only dOccupantToken survives on disk after the partial clear`,
    afterPartialClear.tokens.has(dOccupantToken) && !afterPartialClear.tokens.has(dT1) && !afterPartialClear.tokens.has(dT2));

  // Full release: clearing the LAST remaining token (the occupant's) actually lifts the identity —
  // proves the merged record is fully functional, not a permanently-stuck leftover.
  mod.clearMergeQuarantineByToken(d, dOccupantToken);
  check(`(${tag}) *** FULL RELEASE *** once the last token (dOccupantToken) is cleared too, d is NO LONGER blocked`,
    !mod.resolveQuarantineForTestOnly(d));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO B ("7845ae33-pol-reboot") — the SAME merged shape, surviving a fresh-process reboot: every
// token still present (by content, read directly off disk) after reenterMergeQuarantinesAtBoot, and the
// SAME polarity claim against the freshly-booted module instance.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const tag = "7845ae33-pol-reboot";
  const { r, d, dT1, dT2, dOccupantToken, rToken } = buildSplit(tag, mod);

  const beforeReboot = onDiskTokensFor(d);
  check(`(${tag}) (precondition) before reboot, exactly ONE on-disk record for d (card 4be98ac8), holding all three tokens`,
    beforeReboot.files.length === 1 &&beforeReboot.tokens.has(dT1) && beforeReboot.tokens.has(dT2) && beforeReboot.tokens.has(dOccupantToken));

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([]);

  const afterReboot = onDiskTokensFor(d);
  console.log(`(diagnostic ${tag}) files on disk for d after reboot: ${JSON.stringify(afterReboot.files)}`);
  check(`(${tag}) *** THE CLAIM (reboot) *** no token is lost across a reboot — dT1, dT2, AND dOccupantToken all survive, read by content directly off disk`,
    afterReboot.tokens.has(dT1) && afterReboot.tokens.has(dT2) && afterReboot.tokens.has(dOccupantToken));

  check(`(${tag}) (precondition, post-reboot) d is quarantined`, rb.resolveQuarantineForTestOnly(d));
  check(`(${tag}) (precondition, post-reboot, pure peek) stillBlockedEntryFor/resolveQuarantineFor agree`,
    (rb.stillBlockedEntryFor(d) !== undefined) === rb.resolveQuarantineForTestOnly(d));

  // @decision 59e758e5 (B5) — clear r's own token FIRST, same reason as the in-process scenario above:
  // leaving it outstanding makes the "d still blocked" check below vacuous (r alone keeps it blocked).
  rb.clearMergeQuarantineByToken(r, rToken);

  rb.clearMergeQuarantineByToken(d, dT1);
  rb.clearMergeQuarantineByToken(d, dT2);
  check(`(${tag}) *** THE POLARITY CLAIM (reboot) *** after a reboot, clearing the relocated record's own tokens AND r's own unrelated token, d is STILL blocked by dOccupantToken ALONE`,
    rb.resolveQuarantineForTestOnly(d));
  const afterPartialClearReboot = onDiskTokensFor(d);
  check(`(${tag}) by content (post-reboot): only dOccupantToken survives on disk after the partial clear`,
    afterPartialClearReboot.tokens.has(dOccupantToken) && !afterPartialClearReboot.tokens.has(dT1) && !afterPartialClearReboot.tokens.has(dT2));

  rb.clearMergeQuarantineByToken(d, dOccupantToken);
  check(`(${tag}) *** FULL RELEASE (reboot) *** once the last token (dOccupantToken) is cleared too, d is no longer blocked`,
    !rb.resolveQuarantineForTestOnly(d));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO C ("4be98ac8-writefail") — the merged write FAILS: the relocated safety-tmp record must stay
// untouched (not swept, tokens intact), d stays blocked, and no token is lost by content.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const tag = "4be98ac8-writefail";
  const real = fs.renameSync;
  let failedPendingWrites = 0;
  // Fail every rename INTO a deterministic pending-<24hex>.json (the merged write's target); other renames pass.
  fs.renameSync = (src, dest) => {
    if (/[\\/]pending-[0-9a-f]{24}\.json$/.test(String(dest))) { failedPendingWrites++; throw Object.assign(new Error("EPERM: simulated"), { code: "EPERM" }); }
    return real(src, dest);
  };
  let built;
  try {
    // buildSplit's own first raise of d needs a pending-<hash>.json write to SUCCEED, so build the relocation first
    // with the patch disarmed, then arm it only for r's raise.
    fs.renameSync = real;
    const r = makeToplevelRepo(`${tag}-r`);
    const Kr = canonicalRepoLockKey(r);
    const d = path.join(r, `gone-subdir-${tag}`);
    const dT1 = mod.enterMergeQuarantine(d, `loom/${tag}-d1`, `${tag}: first raise of d`);
    const basePath = path.join(MERGE_QUARANTINE_DIR, listDirFiles().find((f) => readJsonSafe(path.join(MERGE_QUARANTINE_DIR, f))?.repoPath === d));
    const inject = injectOneShotRenameFailure(basePath);
    let dT2;
    try { dT2 = mod.enterMergeQuarantine(d, `loom/${tag}-d2`, `${tag}: second raise of d, rename forced to fail`); } finally { inject.restore(); }
    const relocatedBefore = onDiskTokensFor(d).files.filter((f) => /\.json\.tmp-safety-/.test(f));
    check(`(${tag}) (precondition) d's record is relocated to a safety-tmp name`, relocatedBefore.length === 1);
    const finalPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(Kr)}.json`);
    const dOccupantToken = `${tag}-docc-${freshSfx()}`;
    fs.writeFileSync(finalPath, JSON.stringify({ repoPath: d, branch: `${tag}-earlier`, reason: `${tag}: degraded occupant`, enteredAt: Date.now() - 100000, tokens: [dOccupantToken] }, null, 2) + "\n");
    fs.renameSync = (src, dest) => {
      if (/[\\/]pending-[0-9a-f]{24}\.json$/.test(String(dest))) { failedPendingWrites++; throw Object.assign(new Error("EPERM: simulated"), { code: "EPERM" }); }
      return real(src, dest);
    };
    const rToken = mod.enterMergeQuarantine(r, `loom/${tag}-r`, `${tag}: r raises over the degraded occupant`);
    built = { r, d, dT1, dT2, dOccupantToken, rToken, relocatedFile: relocatedBefore[0] };
  } finally {
    fs.renameSync = real;
  }
  const { r, d, dT1, dT2, dOccupantToken, rToken, relocatedFile } = built;
  check(`(${tag}) (precondition) the merged pending write was actually attempted and failed`, failedPendingWrites > 0);
  const relocatedAfter = readJsonSafe(path.join(MERGE_QUARANTINE_DIR, relocatedFile));
  check(`(${tag}) *** FAIL CLOSED *** the relocated record is NOT swept and still holds dT1 + dT2`,
    relocatedAfter !== null && relocatedAfter.tokens.includes(dT1) && relocatedAfter.tokens.includes(dT2));
  const afterC = onDiskTokensFor(d);
  check(`(${tag}) no token lost by content (dT1, dT2, occupant token all still on disk)`,
    afterC.tokens.has(dT1) && afterC.tokens.has(dT2) && afterC.tokens.has(dOccupantToken));
  mod.clearMergeQuarantineByToken(r, rToken);
  check(`(${tag}) d is still blocked`, mod.resolveQuarantineForTestOnly(d));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO D ("4be98ac8-r2-ordinary-names") — d4b25feb R2: one identity may legitimately hold TWO
// independent ordinary-named records. The new tier must match ONLY the exact safety-tmp relocation
// shape; an ordinary-named `-collision-` sibling is never merged or swept.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const tag = "4be98ac8-r2";
  const r = makeToplevelRepo(`${tag}-r`);
  const Kr = canonicalRepoLockKey(r);
  const d = path.join(r, `gone-subdir-${tag}`);
  const dT1 = mod.enterMergeQuarantine(d, `loom/${tag}-d1`, `${tag}: first raise of d`);
  const primary = listDirFiles().find((f) => readJsonSafe(path.join(MERGE_QUARANTINE_DIR, f))?.repoPath === d);
  const collisionName = primary.replace(/\.json$/, "-collision-deadbeef.json");
  const cT = `${tag}-ctok-${freshSfx()}`;
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, collisionName), JSON.stringify({ repoPath: d, branch: `${tag}-c`, reason: `${tag}: independent ordinary sibling`, enteredAt: Date.now() - 50000, tokens: [cT] }, null, 2) + "\n");
  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([]);
  const pre = onDiskTokensFor(d);
  check(`(${tag}) (precondition) after reboot d still has two ordinary-named records with disjoint tokens`,
    pre.files.length === 2 && pre.files.includes(collisionName) && pre.tokens.has(dT1) && pre.tokens.has(cT));
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(Kr)}.json`);
  const dOccupantToken = `${tag}-docc-${freshSfx()}`;
  fs.writeFileSync(finalPath, JSON.stringify({ repoPath: d, branch: `${tag}-earlier`, reason: `${tag}: degraded occupant`, enteredAt: Date.now() - 100000, tokens: [dOccupantToken] }, null, 2) + "\n");
  rb.enterMergeQuarantine(r, `loom/${tag}-r`, `${tag}: r raises over the degraded occupant`);
  const collisionAfter = readJsonSafe(path.join(MERGE_QUARANTINE_DIR, collisionName));
  check(`(${tag}) *** R2 *** the ordinary-named collision sibling is untouched (still on disk, still exactly its own token)`,
    collisionAfter !== null && collisionAfter.tokens.length === 1 && collisionAfter.tokens[0] === cT);
  const post = onDiskTokensFor(d);
  check(`(${tag}) no token lost (dT1, cT, occupant token all held by some record)`, post.tokens.has(dT1) && post.tokens.has(cT) && post.tokens.has(dOccupantToken));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIOS E-H (4be98ac8 review round) — negative-coverage pins, one per guard of the fold. Each
// builds the real relocation (d's second raise, rename forced to fail), then hand-places extra
// safety-tmp-shaped files/records, then raises r over a degraded occupant of d at r's own final.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
function buildRelocatedD(tag) {
  const r = makeToplevelRepo(`${tag}-r`);
  const Kr = canonicalRepoLockKey(r);
  const d = path.join(r, `gone-subdir-${tag}`);
  const dT1 = mod.enterMergeQuarantine(d, `loom/${tag}-d1`, `${tag}: first raise of d`);
  const basePath = path.join(MERGE_QUARANTINE_DIR, listDirFiles().find((f) => readJsonSafe(path.join(MERGE_QUARANTINE_DIR, f))?.repoPath === d));
  const inject = injectOneShotRenameFailure(basePath);
  let dT2;
  try { dT2 = mod.enterMergeQuarantine(d, `loom/${tag}-d2`, `${tag}: second raise of d, rename forced to fail`); } finally { inject.restore(); }
  const reloc = listDirFiles().filter((f) => /^[0-9a-f]{24}\.json\.tmp-safety-/.test(f) && readJsonSafe(path.join(MERGE_QUARANTINE_DIR, f))?.repoPath === d);
  if (reloc.length !== 1) throw new Error(`${tag}: expected exactly one relocated safety-tmp for d, got ${JSON.stringify(reloc)}`);
  return { r, Kr, d, dT1, dT2, relocName: reloc[0] };
}
// Hand-place a safety-tmp-shaped record for `repoPath` (file on disk + pending slot); returns its entry object.
function placeSafetyTmp(repoPath, seed, tokens) {
  const name = `${createHash("sha256").update(seed).digest("hex").slice(0, 24)}.json.tmp-safety-1-${seed.length.toString(16)}ab`;
  const entry = { repoPath, branch: `${seed}-b`, reason: `${seed}: hand-placed safety-tmp`, enteredAt: Date.now() - 60000, tokens };
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, name), JSON.stringify(entry, null, 2) + "\n");
  mod.pushPendingQuarantineTestOnly(entry, name);
  return { name, entry };
}
function raiseROverOccupant(ctx, tag) {
  const dOccupantToken = `${tag}-docc-${freshSfx()}`;
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ctx.Kr)}.json`), JSON.stringify({
    repoPath: ctx.d, branch: `${tag}-earlier`, reason: `${tag}: degraded occupant`, enteredAt: Date.now() - 100000, tokens: [dOccupantToken],
  }, null, 2) + "\n");
  const rToken = mod.enterMergeQuarantine(ctx.r, `loom/${tag}-r`, `${tag}: r raises over the degraded occupant`);
  return { dOccupantToken, rToken };
}
const pendingNamesFor = (repoPath) => mod.listPendingMergeQuarantinesTestOnly().filter((p) => p.repoPath === repoPath).map((p) => p.sourceFile);

// E — KEPT means TRACKED (and mutant (c): dropping the every(t in written) coverage guard). The relocated
// file carries an on-disk token X the in-memory record never saw, so it is not covered and must be kept.
{
  const tag = "4be98ac8-kept";
  const ctx = buildRelocatedD(tag);
  const X = `${tag}-x-${freshSfx()}`;
  const relocPath = path.join(MERGE_QUARANTINE_DIR, ctx.relocName);
  const relocJson = readJsonSafe(relocPath);
  fs.writeFileSync(relocPath, JSON.stringify({ ...relocJson, tokens: [...relocJson.tokens, X] }, null, 2) + "\n");
  const { rToken } = raiseROverOccupant(ctx, tag);
  mod.clearMergeQuarantineByToken(ctx.r, rToken);
  check(`(${tag}) *** (c) *** the relocated file holding the uncovered on-disk token X is KEPT on disk, X intact`,
    (readJsonSafe(relocPath)?.tokens ?? []).includes(X));
  check(`(${tag}) *** kept means TRACKED *** the kept file's name is still referenced in memory (own pending slot)`,
    pendingNamesFor(ctx.d).includes(ctx.relocName));
  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([]);
  check(`(${tag}) after a reboot, d is still blocked and X is still held by some on-disk record`,
    rb.resolveQuarantineForTestOnly(ctx.d) && onDiskTokensFor(ctx.d).tokens.has(X));
}

// F — mutant (a): taking only the FIRST relocated hit. TWO relocated records for one identity.
{
  const tag = "4be98ac8-two";
  const ctx = buildRelocatedD(tag);
  const S = `${tag}-s-${freshSfx()}`;
  const second = placeSafetyTmp(ctx.d, `${tag}-second`, [S]);
  const { dOccupantToken } = raiseROverOccupant(ctx, tag);
  const merged = onDiskTokensFor(ctx.d);
  check(`(${tag}) *** (a) *** BOTH relocated files are folded and swept (neither remains on disk)`,
    !fs.existsSync(path.join(MERGE_QUARANTINE_DIR, ctx.relocName)) && !fs.existsSync(path.join(MERGE_QUARANTINE_DIR, second.name)));
  check(`(${tag}) the merged record holds dT1, dT2, the second record's token AND the occupant token`,
    [ctx.dT1, ctx.dT2, S, dOccupantToken].every((t) => merged.tokens.has(t)));
  check(`(${tag}) no pending slot still names either relocated file`,
    !pendingNamesFor(ctx.d).includes(ctx.relocName) && !pendingNamesFor(ctx.d).includes(second.name));
}

// G — mutant (b): dropping the directPathIdentity clause. A DIFFERENT identity's safety-tmp sibling.
{
  const tag = "4be98ac8-ident";
  const ctx = buildRelocatedD(tag);
  const other = path.join(ctx.r, `other-subdir-${tag}`);
  const O = `${tag}-o-${freshSfx()}`;
  const foreign = placeSafetyTmp(other, `${tag}-foreign`, [O]);
  const { dOccupantToken } = raiseROverOccupant(ctx, tag);
  check(`(${tag}) *** (b) *** the different-identity safety-tmp file is untouched (still on disk, exactly its own token)`,
    JSON.stringify(readJsonSafe(path.join(MERGE_QUARANTINE_DIR, foreign.name))?.tokens) === JSON.stringify([O]));
  check(`(${tag}) the different-identity record keeps its pending slot`, pendingNamesFor(other).includes(foreign.name));
  check(`(${tag}) d's merged record holds dT1, dT2, the occupant token, and NOT the foreign token`,
    [ctx.dT1, ctx.dT2, dOccupantToken].every((t) => onDiskTokensFor(ctx.d).tokens.has(t)) && !onDiskTokensFor(ctx.d).tokens.has(O));
}

// H — mutant (d): dropping replaceEntryEverywhere for an ARMED relocated record. An armed twin (same
// object also in activeQuarantines) must be re-pointed onto the merged entry, not left stale.
{
  const tag = "4be98ac8-armed";
  const ctx = buildRelocatedD(tag);
  const S = `${tag}-s-${freshSfx()}`;
  const twin = placeSafetyTmp(ctx.d, `${tag}-twin`, [S]);
  mod.setActiveQuarantineTestOnly(`${tag}-armed-key`, twin.entry);
  raiseROverOccupant(ctx, tag);
  check(`(${tag}) *** (d) *** the armed twin's old object is no longer reachable in memory (re-pointed onto the merged entry)`,
    !mod.listActiveMergeQuarantines().includes(twin.entry));
  check(`(${tag}) exactly ONE in-memory object represents d afterwards`,
    mod.listActiveMergeQuarantines().filter((e) => e.repoPath === ctx.d).length === 1);
}

console.log(failures === 0
  ? "\n✅ ALL CHECKS PASS — a relocated safety-tmp record meeting a degraded-occupant record is MERGED into one record (card 4be98ac8), no token is lost, d stays fail-closed (in-process, across a reboot, and when the merged write fails); a kept file stays tracked; ordinary-named and different-identity siblings are never merged."
  : `\n❌ ${failures} CHECK(S) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
