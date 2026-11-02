import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 7845ae33 (polarity test for the combined 59e758e5 + 7845ae33 change, manager gen 458).
//
// @decision 59e758e5 — a relocated safety-tmp record meeting a split-off record (card 4be98ac8) is never
// a lost token: clearing one record's tokens must still leave the identity blocked while the OTHER holds
// one. Read every record BY CONTENT — a single-match view can hide exactly this split.
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

// Builds the split shape this card's own decision record documents: a relocated-via-safety-tmp record
// (tokens dT1,dT2) plus a hand-crafted degraded-occupant record written directly at a THIRD repo's own
// canonical-key final (token dOccupantToken) that a later raise of that third repo discovers and, since
// protectOccupantContentBeforeDelete's matching can't find the relocated record, mints as a SECOND,
// independent pending record rather than unioning into the first.
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
// SCENARIO A ("7845ae33-pol-inproc") — in-process leg: build the split, confirm no token is lost (by
// content), confirm it is genuinely a split (two distinct files), then the polarity claim itself —
// clearing the relocated record's own tokens must still leave `d` blocked by the split-off record, and
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
  check(`(${tag}) this is a SPLIT, not a merge — exactly TWO distinct on-disk records exist for d (never one, never three)`, after.files.length === 2);

  const relocatedFile = after.files.find((f) => (readJsonSafe(path.join(MERGE_QUARANTINE_DIR, f))?.tokens ?? []).includes(dT1));
  const splitFile = after.files.find((f) => (readJsonSafe(path.join(MERGE_QUARANTINE_DIR, f))?.tokens ?? []).includes(dOccupantToken));
  check(`(${tag}) the relocated-safety-tmp record and the split-off record are two DIFFERENT physical files`,
    relocatedFile !== undefined && splitFile !== undefined && relocatedFile !== splitFile);

  check(`(${tag}) (precondition) d is quarantined before any clear`, mod.resolveQuarantineForTestOnly(d));
  check(`(${tag}) (precondition, pure peek) stillBlockedEntryFor/resolveQuarantineFor agree before any clear`,
    (mod.stillBlockedEntryFor(d) !== undefined) === mod.resolveQuarantineForTestOnly(d));

  // @decision 59e758e5 (B5) — clear r's own token FIRST: r's own ACTIVE quarantine shares d's own
  // walked-up degraded key, so leaving it outstanding makes a "d still blocked" check vacuous — it
  // cannot fail, since r alone keeps d reading blocked no matter what happens to d's own records below.
  mod.clearMergeQuarantineByToken(r, rToken);

  // *** THE POLARITY CHECK *** — clear EVERY token the relocated (first-raised) record holds. `d` must
  // remain blocked because the split-off record still holds dOccupantToken. A regression here would mean
  // clearing one record silently released the whole identity — exactly the "unenforced" failure this test
  // exists to catch; a split is acceptable, a loss of enforcement is not.
  mod.clearMergeQuarantineByToken(d, dT1);
  mod.clearMergeQuarantineByToken(d, dT2);
  check(`(${tag}) *** THE POLARITY CLAIM *** after clearing the relocated record's own tokens (dT1, dT2) AND r's own unrelated token, d is STILL blocked — the split-off record (dOccupantToken) ALONE still enforces it`,
    mod.resolveQuarantineForTestOnly(d));
  const afterPartialClear = onDiskTokensFor(d);
  check(`(${tag}) by content: only dOccupantToken survives on disk after the partial clear`,
    afterPartialClear.tokens.has(dOccupantToken) && !afterPartialClear.tokens.has(dT1) && !afterPartialClear.tokens.has(dT2));

  // Full release: clearing the LAST remaining token (the split-off record's own) actually lifts the
  // identity — proves it is a genuine, fully-functional record, not a permanently-stuck leftover.
  mod.clearMergeQuarantineByToken(d, dOccupantToken);
  check(`(${tag}) *** FULL RELEASE *** once the split-off record's own last token is cleared too, d is NO LONGER blocked`,
    !mod.resolveQuarantineForTestOnly(d));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO B ("7845ae33-pol-reboot") — the SAME split shape, surviving a fresh-process reboot: every
// token still present (by content, read directly off disk) after reenterMergeQuarantinesAtBoot, and the
// SAME polarity claim against the freshly-booted module instance.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const tag = "7845ae33-pol-reboot";
  const { r, d, dT1, dT2, dOccupantToken, rToken } = buildSplit(tag, mod);

  const beforeReboot = onDiskTokensFor(d);
  check(`(${tag}) (precondition) before reboot, exactly two on-disk records for d, together holding all three tokens`,
    beforeReboot.files.length === 2 && beforeReboot.tokens.has(dT1) && beforeReboot.tokens.has(dT2) && beforeReboot.tokens.has(dOccupantToken));

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
  check(`(${tag}) *** THE POLARITY CLAIM (reboot) *** after a reboot, clearing the relocated record's own tokens AND r's own unrelated token, d is STILL blocked by the split-off record ALONE`,
    rb.resolveQuarantineForTestOnly(d));
  const afterPartialClearReboot = onDiskTokensFor(d);
  check(`(${tag}) by content (post-reboot): only dOccupantToken survives on disk after the partial clear`,
    afterPartialClearReboot.tokens.has(dOccupantToken) && !afterPartialClearReboot.tokens.has(dT1) && !afterPartialClearReboot.tokens.has(dT2));

  rb.clearMergeQuarantineByToken(d, dOccupantToken);
  check(`(${tag}) *** FULL RELEASE (reboot) *** once the split-off record's own last token is cleared too, d is no longer blocked`,
    !rb.resolveQuarantineForTestOnly(d));
}

console.log(failures === 0
  ? "\n✅ ALL CHECKS PASS — the combined 59e758e5+7845ae33 change never loses a token: a relocated safety-tmp record meeting a split-off degraded-occupant record stays fully enforced (a split, not a loss), in-process and across a reboot, read by content throughout."
  : `\n❌ ${failures} CHECK(S) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
