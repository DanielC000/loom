import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 59e758e5, CR round 2 (reviewer 6aee1d61), finding (1) — the "immediate unlink is safe"
// claim at protectOccupantContentBeforeDelete's own double-fault branch (toWrite's own write, `final`
// itself untouched) was FALSE BY CONTENT: `toWrite` unions the in-memory record at `atFilenameIdx`,
// which can hold a MEMORY-ONLY token (an earlier raise whose own primary write AND safety-tmp fallback
// both failed — a genuine triple fault). When THIS write's own rename also fails (open succeeds, bytes
// land, fsync runs — a real stranded tmp is created holding the full union), unlinking that tmp deletes
// the ONLY durable copy of the memory-only token before anything else can secure it. Reproduces the
// reviewer's own probe8.mjs construction exactly (two measured outcomes diverged only in whether the
// unlink ran): with the unlink (pre-fix), the memory-only token is lost on reboot; without it (the fix),
// a later boot's own tmp-recovery pass re-arms it as a fail-closed duplicate.
//
// @decision 59e758e5 (round 3) — never unlink at this site: not every non-raise caller's own stranded
// tmp is provably a safe subset of durable state elsewhere. See the decision record.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-59e758e5-protect-double-fault-tmp-loss.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq59e758-pdf-", { fresh: true });
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const mod = await import(mergeQuarantineModuleHref);
const { enterMergeQuarantine, activeMergeQuarantineFor, listActiveMergeQuarantines, assertRepoNotQuarantined, MERGE_QUARANTINE_DIR } = mod;
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const GIT_ID = "-c user.email=mq59e758pdf@loom -c user.name=mq59e758pdf";

function makeToplevelRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mq59e758pdf-repo-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), `# ${tag}\n`);
  execSync(`git init -q && git config user.email mq59e758pdf@loom && git config user.name mq59e758pdf`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

function readJsonIfExists(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function onDiskTokensForTest(repoPath) {
  const files = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => readJsonIfExists(path.join(MERGE_QUARANTINE_DIR, f))?.repoPath === repoPath);
  return new Set(files.flatMap((f) => readJsonIfExists(path.join(MERGE_QUARANTINE_DIR, f))?.tokens ?? []));
}

let bootReimportCounter = 0;
async function rebootSim() {
  bootReimportCounter++;
  const m = await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
  m.reenterMergeQuarantinesAtBoot([]);
  return m;
}

// Forces every open() under `prefix` (and `.tmp-safety-`) to fail — the TRIPLE fault that leaves D's
// own second token tracked IN-MEMORY ONLY, never reaching disk anywhere (mirrors probe8's own `failOpen`
// used for D's own triple-fault raise).
function injectOpenFailureForPrefixOrSafetyTmp(prefix, code = "ENOSPC") {
  const real = fs.openSync;
  fs.openSync = (p, ...rest) => {
    if (typeof p === "string" && (p.startsWith(prefix) || p.includes(".tmp-safety-"))) {
      throw Object.assign(new Error(`${code}: simulated disk-full`), { code });
    }
    return real(p, ...rest);
  };
  return { restore: () => { fs.openSync = real; } };
}

// Forces the RENAME of exactly `targetFinal` to fail (EPERM) — open/write/fsync all SUCCEED first, so a
// REAL stranded tmp file lands on disk, holding the union this write was trying to persist. This is the
// genuine data-at-risk shape finding (1) is about — unlike an open-failure injection, which never creates
// a real tmp to lose in the first place.
function injectRenameFailureForTarget(targetFinal, code = "EPERM") {
  const real = fs.renameSync;
  let hits = 0;
  fs.renameSync = (a, b) => {
    if (String(b) === targetFinal) { hits++; throw Object.assign(new Error(`${code}: simulated rename failure`), { code }); }
    return real(a, b);
  };
  return { restore: () => { fs.renameSync = real; }, hits: () => hits };
}

const d = path.join(os.tmpdir(), `loom-mq59e758pdf-d-never-exists-${freshSfx()}`);
const tD1 = enterMergeQuarantine(d, "d-branch-1", "59e758e5-pdf: D's first raise, mints a fresh pending-divert file");
const pf = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => readJsonIfExists(path.join(MERGE_QUARANTINE_DIR, f))?.repoPath === d);
check("(precondition) D's first pending-divert file was minted", typeof pf === "string");
const pendingPath = path.join(MERGE_QUARANTINE_DIR, pf);

// D's SECOND raise: triple fault (primary write AND the safety-tmp fallback's own write both fail) —
// t2 ends up tracked IN-PROCESS ONLY, at pendingPath, while pendingPath's own on-disk bytes still hold
// just tD1.
const injectD = injectOpenFailureForPrefixOrSafetyTmp(pendingPath);
let tD2;
try {
  tD2 = enterMergeQuarantine(d, "d-branch-2", "59e758e5-pdf: D's second raise, triple fault — t2 is memory-only");
} finally {
  injectD.restore();
}
check("(precondition) D's second token is tracked in-process alongside the first",
  (activeMergeQuarantineFor(d)?.tokens ?? []).includes(tD1) && (activeMergeQuarantineFor(d)?.tokens ?? []).includes(tD2));
check("(precondition) D's second token did NOT reach disk at pendingPath — genuinely memory-only",
  !(fs.readFileSync(pendingPath, "utf8")).includes(tD2));

// R's OWN canonical key file is hand-crafted as D's EARLIER degraded-occupant record, holding a THIRD,
// independent token ("cur") — simulating an entry filed there by an earlier process/session.
const r = makeToplevelRepo("59e758e5-pdf-r");
const Kr = canonicalRepoLockKey(r);
const finalPath = path.join(MERGE_QUARANTINE_DIR, `${createHash("sha256").update(Kr).digest("hex").slice(0, 24)}.json`);
fs.writeFileSync(finalPath, JSON.stringify({
  repoPath: d, branch: "d-earlier-branch", reason: "59e758e5-pdf: D's own earlier degraded entry, walked up to R's own real key",
  enteredAt: Date.now() - 300000, tokens: ["59e758e5-pdf-cur"],
}, null, 2) + "\n");

// R raises. This triggers protectDegradedOccupantBeforeDelete(finalPath, d, ...) ->
// protectOccupantContentBeforeDelete, which unions `finalPath`'s own on-disk "cur" token with D's
// in-memory record (tD1+tD2) and tries to durably persist the union AT `pendingPath` (D's own,
// identity-matched pending file). Force THAT rename to fail — open/write/fsync succeed, so a genuine
// stranded tmp is created holding {cur, tD1, tD2} — the double fault this finding is about.
const injectR = injectRenameFailureForTarget(pendingPath);
let rToken;
try {
  rToken = enterMergeQuarantine(r, "r-branch", "59e758e5-pdf: r raises, protect's own chosen write (double fault) fails");
} finally {
  injectR.restore();
}
check("(precondition) the double-fault rename was actually forced to fail", injectR.hits() >= 1);
check("(precondition) finalPath's own bytes are untouched throughout (this double-fault branch never rewrites `final` itself)",
  (fs.readFileSync(finalPath, "utf8")).includes("59e758e5-pdf-cur") && !(fs.readFileSync(finalPath, "utf8")).includes(tD2));

check("(in-process) D's second token (memory-only before this raise) is STILL tracked in-process after the double fault",
  (activeMergeQuarantineFor(d)?.tokens ?? []).includes(tD2));
check("(in-process) R's own raise persists despite the double fault",
  new Set(listActiveMergeQuarantines().flatMap((e) => e.tokens ?? [])).has(rToken));

const freshBoot = await rebootSim();
const tokensAfterReboot = new Set(freshBoot.listActiveMergeQuarantines().flatMap((e) => e.tokens ?? []));
check("*** THE CLAIM *** D's first token survives a fresh-process reboot", tokensAfterReboot.has(tD1));
check("*** THE FIX *** D's second token (memory-only, carried by the now-kept stranded tmp) ALSO survives a fresh-process reboot — never silently dropped",
  tokensAfterReboot.has(tD2));
check("(reboot) the earlier-discovered current token and R's own token also survive",
  tokensAfterReboot.has("59e758e5-pdf-cur") && tokensAfterReboot.has(rToken));
check("(reboot, by-content cross-check) every one of D's own tokens is found SOMEWHERE across every file naming D's repoPath",
  (() => { const s = onDiskTokensForTest(d); return s.has(tD1) && s.has(tD2) && s.has("59e758e5-pdf-cur"); })());
check("(reboot) D stays blocked", !freshBoot.assertRepoNotQuarantined(d).ok);

freshBoot.clearMergeQuarantineByToken(d, tD1);
freshBoot.clearMergeQuarantineByToken(d, tD2);
freshBoot.clearMergeQuarantineByToken(d, "59e758e5-pdf-cur");
freshBoot.clearMergeQuarantineByToken(r, rToken);

console.log(failures === 0
  ? "\n✅ ALL CHECKS PASS — protectOccupantContentBeforeDelete's own double-fault branch never unlinks its stranded tmp, so a memory-only token it was carrying is never lost, not even on reboot."
  : `\n❌ ${failures} CHECK(S) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
