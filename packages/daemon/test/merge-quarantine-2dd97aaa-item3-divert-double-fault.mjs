import "./_guard.mjs";
// Board card 2dd97aaa item 3, second construction — forces divertRaiseEntry's own "union into an
// EXISTING pending record" branch (not mergeTokenIntoPendingEntries, which item3's first construction
// already showed recovers fine via the stranded tmp alone) through a genuine double fault: raise 1
// diverts to a fresh pending record (a transient read failure on the key's own final forces
// mustDivert=true); raise 2, same identity, is ALSO forced to divert, finds raise 1's own pending
// record via collectPendingIndices, and its own writePendingDivertFile rename is forced to fail AFTER
// its tmp is durably written — triggering attemptDivertSafetyTmpFallback's real safety-tmp path. Checks
// whether a fresh boot recovers BOTH tokens from the resulting safety-tmp + stranded-tmp combination.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq2dd97aaa-i3b-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const repoLockModuleHref = pathToFileURL(path.join(distGitDir, "repo-lock.js")).href;
const mod = await import(mergeQuarantineModuleHref);
const { enterMergeQuarantine, listActiveMergeQuarantines, MERGE_QUARANTINE_DIR } = mod;
const { canonicalRepoLockKey } = await import(repoLockModuleHref);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
// @decision 2dd97aaa (round 2, CR Minor 3) — an implementation-detail observation (which on-disk file
// shape a recovery path happened to leave behind) is NOT the card's own claim under test (whether a
// token is lost) and must never fail the suite on its own; log it informationally only.
const diagnose = (label, cond) => { console.log(`${cond ? "DIAG-TRUE " : "DIAG-FALSE"}  ${label}`); };
const GIT_ID = "-c user.email=mq2dd97i3b@loom -c user.name=mq2dd97i3b";
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const hashForKey = (k) => createHash("sha256").update(k).digest("hex").slice(0, 24);

function makeToplevelRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mq2dd97i3b-repo-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), `# ${tag}\n`);
  execSync(`git init -q && git config user.email mq2dd97i3b@loom && git config user.name mq2dd97i3b`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

let bootReimportCounter = 0;
async function rebootSim() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

function listDirFiles() { return fs.readdirSync(MERGE_QUARANTINE_DIR); }
function readJsonSafe(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }

function withPersistentReadFailure(targetPath, fn) {
  const real = fs.readFileSync;
  fs.readFileSync = (p, ...rest) => {
    if (typeof p === "string" && p === targetPath) throw Object.assign(new Error("EACCES: simulated"), { code: "EACCES" });
    return real(p, ...rest);
  };
  try { return fn(); } finally { fs.readFileSync = real; }
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

{
  const y = makeToplevelRepo("i3b-s1");
  const k = canonicalRepoLockKey(y);
  const yFinalPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(k)}.json`);

  // Raise 1: force mustDivert=true via a transient read failure on y's own key-final path (nothing is
  // there yet, so the failure is purely to force resolveRaiseOverwrite's divert branch).
  const t1 = withPersistentReadFailure(yFinalPath, () => enterMergeQuarantine(y, "loom/i3b-1", "2dd97aaa-i3b: first raise, forced divert"));
  check("(precondition) y's own key-final was never actually written (diverted instead)", !fs.existsSync(yFinalPath));
  const pendingFilesAfterT1 = listDirFiles().filter((f) => readJsonSafe(path.join(MERGE_QUARANTINE_DIR, f))?.repoPath === y);
  console.log(`(diagnostic) after raise 1 (forced divert): ${JSON.stringify(pendingFilesAfterT1)}`);
  check("(precondition) raise 1 produced exactly one pending-divert record holding {t1}", pendingFilesAfterT1.length === 1 && JSON.stringify(readJsonSafe(path.join(MERGE_QUARANTINE_DIR, pendingFilesAfterT1[0])).tokens) === JSON.stringify([t1]));
  const base1 = pendingFilesAfterT1[0];
  const base1Path = path.join(MERGE_QUARANTINE_DIR, base1);

  // Raise 2: SAME identity, ALSO forced to divert (same injected read failure on the key-final — still
  // nothing there) — reaches divertRaiseEntry's own `indices.length>0` branch since raise 1's pending
  // record now exists for this identity. Its own writePendingDivertFile(base1, merged) rename is ALSO
  // forced to fail, AFTER its tmp is durably written, triggering the real safety-tmp fallback.
  const renameInject = injectOneShotRenameFailure(base1Path);
  let t2;
  try {
    t2 = withPersistentReadFailure(yFinalPath, () => enterMergeQuarantine(y, "loom/i3b-2", "2dd97aaa-i3b: second raise, forced divert + forced rename failure"));
  } finally {
    renameInject.restore();
  }
  check("(precondition) the injected rename failure on raise 2's own union-write actually tripped", renameInject.tripped());
  check("(precondition) y is tracked in-memory with BOTH tokens right now", listActiveMergeQuarantines().some((e) => e.tokens.includes(t1) && e.tokens.includes(t2)));

  const filesAfterT2 = listDirFiles();
  const yFilesAfterT2 = filesAfterT2.filter((f) => readJsonSafe(path.join(MERGE_QUARANTINE_DIR, f))?.repoPath === y);
  console.log(`(diagnostic) ALL files in MERGE_QUARANTINE_DIR after raise 2's forced double-fault: ${JSON.stringify(filesAfterT2)}`);
  for (const f of filesAfterT2) {
    const parsed = readJsonSafe(path.join(MERGE_QUARANTINE_DIR, f));
    console.log(`(diagnostic)   ${f} -> ${parsed ? JSON.stringify({ repoPath: parsed.repoPath, tokens: parsed.tokens }) : "(unparsable/not JSON/corrupt)"}`);
  }
  diagnose("base1's own original file was swept after the safety-tmp fallback secured its content elsewhere — informational only, not the item-3 claim under test", !fs.existsSync(base1Path));
  diagnose("a genuine safety-tmp (.tmp-safety- shaped) now exists, holding BOTH tokens — informational only, not the item-3 claim under test", filesAfterT2.some((f) => f.includes(".tmp-safety-") && JSON.stringify(readJsonSafe(path.join(MERGE_QUARANTINE_DIR, f))?.tokens?.slice().sort()) === JSON.stringify([t1, t2].sort())));
  diagnose("base1's own STRANDED ordinary tmp residue (from the forced rename failure) also exists, holding BOTH tokens — informational only, not the item-3 claim under test", filesAfterT2.some((f) => f.startsWith(base1) && f !== base1 && !f.includes("-safety-") && JSON.stringify(readJsonSafe(path.join(MERGE_QUARANTINE_DIR, f))?.tokens?.slice().sort()) === JSON.stringify([t1, t2].sort())));

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([y]);
  const yAfterReboot = rb.listActiveMergeQuarantines().filter((e) => e.repoPath === y);
  console.log(`(diagnostic) y's entries after reboot: ${JSON.stringify(yAfterReboot.map((e) => ({ repoPath: e.repoPath, tokens: e.tokens })))}`);

  check("*** THE CLAIM *** t1 survives the reboot", rb.listActiveMergeQuarantines().some((e) => e.tokens.includes(t1)));
  check("*** THE CLAIM *** t2 ALSO survives the reboot (this is what item 3 claims can be lost)", rb.listActiveMergeQuarantines().some((e) => e.tokens.includes(t2)));
}

console.log(failures === 0
  ? "\n✅ ALL CHECKS PASS — both tokens survive the double-fault safety-tmp/stranded-tmp combination through a reboot; item 3's premise does NOT reproduce in this construction either."
  : `\n❌ ${failures} CHECK(S) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
