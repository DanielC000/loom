import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 59e758e5, CR round 2 (reviewer 6aee1d61), finding (2) — the "immediate unlink is safe"
// claim at the NARROWING clear sites (clearTokenFromPendingIndices, clearActiveEntryTokenAtKey, the
// clearMergeQuarantineByKey twin, rewriteOrphanLatchFilesAfterPartialClear, and the foreign-group union)
// was FALSE BY CONTENT whenever writePendingDivertFile's own `keptUnreadable` branch REDIRECTS the write
// to an unpredictable `-collision-<hex>` filename: the untouched ORIGINAL `filename` never held the
// narrowed tokens in the first place (it holds a DIFFERENT identity's content), so "the tmp is a strict
// subset of what's already durable at `filename`" is false — there is nothing durable at all once the
// redirected write's own tmp is unlinked. Reproduces the reviewer's own probe6.mjs construction exactly:
// with the unlink (pre-fix), the narrowed token is lost and the repo wrongly unblocks on reboot; without
// it (the fix), a later boot's own tmp-recovery pass re-arms it as a fail-closed duplicate.
//
// @decision 59e758e5 (round 3) — never unlink at any of the six non-raise sites: none of them can prove
// their own stranded tmp is a safe subset of durable state elsewhere. See the decision record.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-59e758e5-narrowing-redirect-tmp-loss.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq59e758-nrd-", { fresh: true });
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const mod = await import(mergeQuarantineModuleHref);
const { enterMergeQuarantine, clearMergeQuarantineByToken, assertRepoNotQuarantined, markLatchFileUnreadableTestOnly, listPendingMergeQuarantinesTestOnly, MERGE_QUARANTINE_DIR } = mod;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function readJsonIfExists(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

let bootReimportCounter = 0;
async function rebootSim() {
  bootReimportCounter++;
  const m = await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
  m.reenterMergeQuarantinesAtBoot([]);
  return m;
}

// Forces EVERY fs.renameSync call to fail (EPERM) — open/write/fsync all succeed first, so a genuine
// stranded tmp is created at whatever target the write was actually attempting (here, the unpredictable
// `-collision-<hex>` redirect target, never the original `filename`).
function injectRenameAlwaysFails(code = "EPERM") {
  const real = fs.renameSync;
  let hits = 0;
  fs.renameSync = () => { hits++; throw Object.assign(new Error(`${code}: simulated rename failure`), { code }); };
  return { restore: () => { fs.renameSync = real; }, hits: () => hits };
}

const d = path.join(os.tmpdir(), `loom-mq59e758nrd-d-never-exists-${freshSfx()}`);
const t1 = enterMergeQuarantine(d, "b1", "59e758e5-nrd: first raise (t1)");
const t2 = enterMergeQuarantine(d, "b2", "59e758e5-nrd: second raise (t2)");
const pf = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => readJsonIfExists(path.join(MERGE_QUARANTINE_DIR, f))?.repoPath === d);
check("(precondition) D's pending-divert file was minted, holding both t1 and t2", typeof pf === "string");
const pfPath = path.join(MERGE_QUARANTINE_DIR, pf);
check("(precondition) pf genuinely holds both tokens before the redirect is set up", (() => {
  const c = readJsonIfExists(pfPath);
  return !!c && c.tokens.includes(t1) && c.tokens.includes(t2);
})());

// Overwrite pf with a FOREIGN identity's content, then mark it unreadable — mirrors a prior read failure
// on pf that left it marked, never confirmed safe to overwrite, by the time a later clear targets it.
const foreignRepoPath = path.join(os.tmpdir(), `loom-mq59e758nrd-foreign-never-exists-${freshSfx()}`);
fs.writeFileSync(pfPath, JSON.stringify({
  repoPath: foreignRepoPath, branch: "foreign-branch", reason: "59e758e5-nrd: a different identity now occupies pf",
  enteredAt: Date.now(), tokens: ["59e758e5-nrd-foreign-tok"],
}, null, 2) + "\n");
markLatchFileUnreadableTestOnly(pf);

// Clear t1 — a narrowing write of D's own entry down to [t2]. writePendingDivertFile sees pf marked
// unreadable, re-reads it, finds a DIFFERENT identity there (never confirmed safe to overwrite), and
// REDIRECTS to a fresh `-collision-<hex>` filename. Force every rename to fail so that redirected
// write's own tmp is stranded — never the original pf (pf's own rename path is never reached at all).
const inject = injectRenameAlwaysFails();
try {
  clearMergeQuarantineByToken(d, t1);
} finally {
  inject.restore();
}
check("(precondition) the redirected write's own rename was forced to fail", inject.hits() >= 1);
check("(precondition) pf's own foreign content is untouched throughout (this clear never targets pf's own rename)",
  readJsonIfExists(pfPath)?.repoPath === foreignRepoPath);

const strandedTmps = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.includes(".json.tmp-") && !f.includes("-safety-"));
check("(precondition) a genuine stranded tmp exists — the redirected write's own, never pf's own", strandedTmps.length >= 1);

check("(in-process) D stays blocked by t2 right after the failed narrowing clear", !assertRepoNotQuarantined(d).ok);

const freshBoot = await rebootSim();
check("*** THE CLAIM *** t1 is correctly lifted — D is never blocked by t1 again",
  !freshBoot.listActiveMergeQuarantines().some((e) => (e.tokens ?? []).includes(t1)));
check("*** THE FIX *** t2 survives a fresh-process reboot — the narrowed-down tmp was kept, never unlinked, until something durable superseded it",
  freshBoot.listActiveMergeQuarantines().some((e) => (e.tokens ?? []).includes(t2)));
check("*** THE FIX *** D stays blocked after reboot (by t2) — never wrongly fully unblocked",
  !freshBoot.assertRepoNotQuarantined(d).ok);
check("(reboot, by content) pf's own on-disk bytes still name the foreign identity, never rewritten by this clear",
  readJsonIfExists(pfPath)?.repoPath === foreignRepoPath);

freshBoot.clearMergeQuarantineByToken(d, t2);
freshBoot.clearMergeQuarantineByToken(foreignRepoPath, "59e758e5-nrd-foreign-tok");

console.log(failures === 0
  ? "\n✅ ALL CHECKS PASS — a narrowing clear's own redirected write never unlinks its stranded tmp, so the narrowed-down token it was carrying is never lost, not even on reboot."
  : `\n❌ ${failures} CHECK(S) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
