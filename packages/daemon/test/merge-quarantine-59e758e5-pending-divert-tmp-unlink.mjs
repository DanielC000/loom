import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 59e758e5 — writePendingDivertFile's catch path must best-effort unlink the tmp it just minted
// when the final rename fails, so a stranded tmp can't be mistaken by a later boot for real residue.
// LANDED TOGETHER WITH card 7845ae33 (same branch): mergeTokenIntoPendingEntries's own write-failure
// branch now ALSO falls back to a tracked, self-referenced safety-tmp (the same shape divertRaiseEntry
// already had), so the original on-disk record is relocated, not merely left stale — see the updated
// assertions below.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq59e758-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const mod = await import(mergeQuarantineModuleHref);
const { enterMergeQuarantine } = mod;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

let bootReimportCounter = 0;
async function freshBootModule() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

// Same technique as 2dd97aaa's / 028837ad's own tests (merge-quarantine-2dd97aaa-item3-pending-divert-safety-tmp.mjs,
// merge-quarantine-028837ad-pending-arm-mid-clearbytoken.mjs): monkeypatch fs.renameSync to throw EPERM
// for exactly ONE target path, then restore itself on that one trip — deterministic and cross-platform,
// unlike relying on a real read-only file attribute.
function injectOneShotRenameFailure(targetPath) {
  const real = fs.renameSync;
  let tripped = false;
  fs.renameSync = (src, dest) => {
    if (!tripped && dest === targetPath) {
      tripped = true;
      fs.renameSync = real;
      throw Object.assign(new Error("EPERM: simulated rename failure"), { code: "EPERM" });
    }
    return real(src, dest);
  };
  return { restore: () => { fs.renameSync = real; }, tripped: () => tripped };
}

try {
  const T = path.join(os.tmpdir(), `loom-mq59e758-pending-t-never-exists-${freshSfx()}`);
  const t1 = enterMergeQuarantine(T, "loom/t-branch", "merge in progress for T (59e758e5, first raise)");
  const afterFirst = mod.activeMergeQuarantineFor(T);
  check("precondition: T lands PENDING (unresolvable) after its first raise, with exactly [t1]", !!afterFirst && afterFirst.tokens.length === 1 && afterFirst.tokens[0] === t1);
  const sourceFile = mod.listPendingMergeQuarantinesTestOnly().find((p) => p.repoPath === T)?.sourceFile;
  check("precondition: T's pending record has a sourceFile", !!sourceFile);
  const sourcePath = path.join(mod.MERGE_QUARANTINE_DIR, sourceFile);

  const inject = injectOneShotRenameFailure(sourcePath);
  let t2;
  try {
    t2 = enterMergeQuarantine(T, "loom/t-branch", "merge in progress for T (59e758e5, second raise, EPERM)");
  } finally {
    inject.restore();
  }
  check("precondition: the injected rename failure actually tripped", inject.tripped());

  // *** THE FIX *** — no `${sourceFile}.tmp-...` residue survives the failed rename.
  const strandedTmps = fs.readdirSync(mod.MERGE_QUARANTINE_DIR).filter((f) => f.startsWith(`${sourceFile}.tmp-`));
  check("*** FIX *** no stranded tmp is left behind by the failed rename (card 59e758e5)", strandedTmps.length === 0);

  // UPDATED (card 7845ae33, same branch): the ORIGINAL on-disk record is now SWEPT (relocated via the
  // safety-tmp fallback), not left stale — re-resolve the CURRENT sourceFile rather than reuse the
  // pre-relocation one, and confirm the relocated record already holds BOTH tokens unioned.
  check("the original on-disk record is SWEPT (relocated via the safety-tmp fallback), not left stale", !fs.existsSync(sourcePath));
  const relocatedSourceFile = mod.listPendingMergeQuarantinesTestOnly().find((p) => p.repoPath === T)?.sourceFile;
  check("T's pending record relocated to a DIFFERENT (safety-tmp) sourceFile", !!relocatedSourceFile && relocatedSourceFile !== sourceFile);
  const onDiskAfterEperm = JSON.parse(fs.readFileSync(path.join(mod.MERGE_QUARANTINE_DIR, relocatedSourceFile), "utf8"));
  check("the RELOCATED record already holds BOTH tokens unioned — [t1, t2], not just [t1]", JSON.stringify(onDiskAfterEperm.tokens.slice().sort()) === JSON.stringify([t1, t2].slice().sort()));

  // In-memory, t2 is still outstanding — the durable write failing doesn't drop it from the live arm.
  const afterSecond = mod.activeMergeQuarantineFor(T);
  check("t2 is outstanding in-memory despite the durable write failing", !!afterSecond && afterSecond.tokens.includes(t1) && afterSecond.tokens.includes(t2));

  // *** FIX, DURABILITY *** — a reboot sees NO extra/foreign pending record for T armed from tmp residue,
  // and no stray tmp of any kind survives into the next boot.
  const freshMod = await freshBootModule();
  freshMod.reenterMergeQuarantinesAtBoot([]); // T is never a registered repo either way
  const pendingForTPostBoot = freshMod.listPendingMergeQuarantinesTestOnly().filter((p) => p.repoPath === T);
  check("*** FIX, DURABILITY *** a reboot sees EXACTLY ONE pending record for T, never a second one armed from tmp residue", pendingForTPostBoot.length === 1);
  // UPDATED (card 7845ae33, same branch): the deliberate SAFETY-TMP residue (`.tmp-safety-...json`) is
  // left AS WRITTEN at boot by design (same as divertRaiseEntry's own already-shipped fallback — see its
  // sibling test, -divert-double-fault.mjs) and is expected to still be there; only an ORDINARY stranded
  // tmp (the shape THIS card's own unlink fix targets) must never survive.
  const allTmpsPostBoot = fs.readdirSync(mod.MERGE_QUARANTINE_DIR).filter((f) => f.includes(".json.tmp-") && !f.includes("-safety-"));
  check("*** FIX, DURABILITY *** no ORDINARY stranded tmp survives into the next boot (the deliberate safety-tmp residue is expected to persist, AS WRITTEN, by design)", allTmpsPostBoot.length === 0);

  console.log(failures === 0
    ? "\n✅ All checks passed — writePendingDivertFile's own catch path cleans up its own tmp on a failed rename (card 59e758e5)."
    : `\n❌ ${failures} CHECK(S) FAILED — reproduces (or regresses the fix for) board card 59e758e5.`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (e) {
  console.error(e);
  process.exitCode = 1;
}
