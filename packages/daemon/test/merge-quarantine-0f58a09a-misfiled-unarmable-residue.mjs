import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// RUN RED (investigate-first): X's UNARMABLE tmp residue (parses as JSON, names X's repoPath, but lacks
// `branch`) is misfiled under an INNOCENT repo R's hash. In-process nothing ever read the file, so R is
// open; a REBOOT over the same bytes buckets the file by its FILENAME hash (R) and fail-closed quarantines R.
//
// @decision 0f58a09a
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq0f58-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);
const mod = await import(mergeQuarantineModuleHref);
const { enterMergeQuarantine } = mod;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const GIT_ID = "-c user.email=mq0f58@loom -c user.name=mq0f58";
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const hashOf = (key) => createHash("sha256").update(key).digest("hex").slice(0, 24);
const sortedTokens = (e) => (e ? JSON.stringify([...e.tokens].sort()) : undefined);

function makeRepo(tag) {
  const dir = path.join(os.tmpdir(), `loom-mq0f58-repo-${tag}-${freshSfx()}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), `# merge-quarantine-0f58a09a (${tag})\n`);
  execSync(`git init -q && git config user.email mq0f58@loom && git config user.name mq0f58`, { cwd: dir });
  commitAll(dir, "init", GIT_ID);
  return dir;
}

let bootReimportCounter = 0;
async function freshBootModule() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

// `record` is the raw JSON object written; the caller controls which fields are present.
function plantTmp(hashKey, record, suffix) {
  fs.mkdirSync(mod.MERGE_QUARANTINE_DIR, { recursive: true });
  const tmpPath = path.join(mod.MERGE_QUARANTINE_DIR, `${hashOf(hashKey)}.json.tmp-${suffix}`);
  fs.writeFileSync(tmpPath, JSON.stringify(record, null, 2) + "\n");
  return tmpPath;
}

try {
  // (MAIN) X's unarmable residue (no `branch`) misfiled under R's hash. R and X both registered + resolvable.
  {
    const r = makeRepo("main-r");
    const x = makeRepo("main-x");
    const xTok = "11111111-1111-4111-8111-111111111111";
    const tmp = plantTmp(canonicalRepoLockKey(r), { repoPath: x, reason: "X's raise, branch field lost", enteredAt: Date.now() - 1000, tokens: [xTok] }, "91001-cafe0001");
    const bytes = fs.readFileSync(tmp);

    // The "in-process" verdict: this module never read the planted file, so neither repo is blocked.
    check("(main) in-process verdict: R open", mod.stillBlockedEntryFor(r) === undefined);

    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([r, x]);
    const rEntry = fresh.stillBlockedEntryFor(r);
    const xEntry = fresh.stillBlockedEntryFor(x);
    check("*** THE FIX (main) *** reboot does NOT quarantine innocent R", rEntry === undefined);
    // No token salvage (decision 0f58a09a): X gets a fresh placeholder token, never R's and never xTok.
    check("*** THE FIX (main) *** reboot fail-closes X (the content's own identity) with a placeholder of its own", xEntry !== undefined && xEntry.placeholder === true && xEntry.repoPath === x
      && (rEntry === undefined || sortedTokens(rEntry) !== sortedTokens(xEntry)));
    console.log(`      R tokens=${sortedTokens(rEntry)} X tokens=${sortedTokens(xEntry)}`);
    check("(main) X's reason says the file sat at ANOTHER repo's hash (truly misfiled)", /another repo's hash/.test(xEntry?.reason ?? ""));
    check("(main) X carries no spurious provenanceUnknown (content-verified)", xEntry !== undefined && xEntry.provenanceUnknown !== true);
    // Ordering: the tmp may be gone only because X's placeholder was durably written (X's own latch on disk).
    const xLatch = path.join(fresh.MERGE_QUARANTINE_DIR, `${hashOf(canonicalRepoLockKey(x))}.json`);
    check("(main) X's own latch is durably on disk", fs.existsSync(xLatch) && JSON.parse(fs.readFileSync(xLatch, "utf8")).repoPath === x);
    check("(main) the tmp is deleted only AFTER that write, and nothing references it", !fs.existsSync(tmp)
      && !(xEntry?.orphanLatchFiles ?? []).includes(path.basename(tmp))
      && !fresh.listActiveMergeQuarantines().some((e) => (e.orphanLatchFiles ?? []).includes(path.basename(tmp))));
    check("(main) R has no latch of its own on disk", !fs.existsSync(path.join(fresh.MERGE_QUARANTINE_DIR, `${hashOf(canonicalRepoLockKey(r))}.json`)));
    void bytes;
    for (const f of fs.readdirSync(mod.MERGE_QUARANTINE_DIR)) fs.unlinkSync(path.join(mod.MERGE_QUARANTINE_DIR, f));
  }

  // (S1: TOKENLESS beside a clean final) R holds its own CLEAN final; X's tokenless unarmable record is
  // misfiled at R's hash. It trivially passes the "subset of final's tokens" stale test, so it used to be
  // unlinked and X failed OPEN. Now: X blocked, R keeps exactly its own tokens, tmp gone only after X armed.
  {
    const r = makeRepo("s1-r");
    const x = makeRepo("s1-x");
    enterMergeQuarantine(r, "loom/r-branch", "R's own real raise (clean final)");
    const rTokensBefore = sortedTokens(mod.stillBlockedEntryFor(r));
    const rLatch = path.join(mod.MERGE_QUARANTINE_DIR, `${hashOf(canonicalRepoLockKey(r))}.json`);
    check("(s1 precondition) R has a clean final on disk", fs.existsSync(rLatch));
    const tmp = plantTmp(canonicalRepoLockKey(r), { repoPath: x, reason: "X's raise, tokenless and branchless", enteredAt: Date.now() - 1000 }, "91006-cafe0006");
    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([r, x]);
    const xEntry = fresh.stillBlockedEntryFor(x);
    check("*** THE FIX (s1) *** X is blocked (not failed open)", xEntry !== undefined && xEntry.repoPath === x);
    check("(s1) R keeps exactly its own token set (nothing of X unioned in)", sortedTokens(fresh.stillBlockedEntryFor(r)) === rTokensBefore);
    const xLatch = path.join(fresh.MERGE_QUARANTINE_DIR, `${hashOf(canonicalRepoLockKey(x))}.json`);
    check("(s1) tmp gone only because X's own latch is durably on disk", !fs.existsSync(tmp) && fs.existsSync(xLatch));
    fresh.clearMergeQuarantine(x);
    fresh.clearMergeQuarantine(r);
    for (const f of fs.readdirSync(mod.MERGE_QUARANTINE_DIR)) fs.unlinkSync(path.join(mod.MERGE_QUARANTINE_DIR, f));
    mod.clearMergeQuarantine(r);
  }

  // (WRITE-FAILURE) X's placeholder cannot be durably written: the misfiled tmp must be KEPT (never unlinked
  // before the superseding write succeeds) and X stays blocked in memory.
  {
    const r = makeRepo("wf-r");
    const x = makeRepo("wf-x");
    const tmp = plantTmp(canonicalRepoLockKey(r), { repoPath: x, reason: "X's raise, branch lost", enteredAt: Date.now() - 1000, tokens: ["55555555-5555-4555-8555-555555555555"] }, "91007-cafe0007");
    const xLatchBase = `${hashOf(canonicalRepoLockKey(x))}.json`;
    const realRename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (path.basename(String(to)) === xLatchBase) { const e = new Error("injected EPERM"); e.code = "EPERM"; throw e; }
      return realRename(from, to);
    };
    let fresh;
    try {
      fresh = await freshBootModule();
      fresh.reenterMergeQuarantinesAtBoot([r, x]);
    } finally { fs.renameSync = realRename; }
    check("(write-failure) the misfiled tmp is KEPT when X's write fails", fs.existsSync(tmp));
    check("(write-failure) X is still blocked in memory and R stays open", fresh.stillBlockedEntryFor(x) !== undefined && fresh.stillBlockedEntryFor(r) === undefined);
    for (const f of fs.readdirSync(mod.MERGE_QUARANTINE_DIR)) fs.unlinkSync(path.join(mod.MERGE_QUARANTINE_DIR, f));
  }

  // (X-HAS-REAL-LATCH) X already holds a real latch: the misfiled unarmable tmp folds into key(X), swept after
  // X's union write; X keeps its real tokens, R stays open.
  {
    const r = makeRepo("xr-r");
    const x = makeRepo("xr-x");
    enterMergeQuarantine(x, "loom/x-branch", "X's own real raise");
    const xTokensBefore = sortedTokens(mod.stillBlockedEntryFor(x));
    const tmp = plantTmp(canonicalRepoLockKey(r), { repoPath: x, reason: "X's second raise, branch lost", enteredAt: Date.now() - 1000, tokens: ["66666666-6666-4666-8666-666666666666"] }, "91008-cafe0008");
    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([r, x]);
    const xEntry = fresh.stillBlockedEntryFor(x);
    check("(x-real) X keeps its real (non-placeholder) record and token set", xEntry !== undefined && xEntry.placeholder !== true && sortedTokens(xEntry) === xTokensBefore);
    check("(x-real) R stays open", fresh.stillBlockedEntryFor(r) === undefined);
    check("(x-real) the tmp is swept after X's write", !fs.existsSync(tmp));
    fresh.clearMergeQuarantine(x);
    for (const f of fs.readdirSync(mod.MERGE_QUARANTINE_DIR)) fs.unlinkSync(path.join(mod.MERGE_QUARANTINE_DIR, f));
    mod.clearMergeQuarantine(x);
  }

  // (UNRESOLVABLE-X) X is not a registered, resolvable repo: pending entry for X, tmp kept as written, R OPEN.
  {
    const r = makeRepo("unres-r");
    const x = path.join(os.tmpdir(), `loom-mq0f58-never-exists-${freshSfx()}`);
    const tmp = plantTmp(canonicalRepoLockKey(r), { repoPath: x, reason: "X (unresolvable) raise, branch lost", enteredAt: Date.now() - 1000, tokens: ["33333333-3333-4333-8333-333333333333"] }, "91004-cafe0004");
    const bytes = fs.readFileSync(tmp);
    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([r]);
    check("*** THE FIX (unres) *** R stays OPEN", fresh.stillBlockedEntryFor(r) === undefined);
    check("(unres) X lands as a PENDING entry sourced from the misfiled tmp", fresh.listPendingMergeQuarantinesTestOnly().some((p) => p.repoPath === x && p.sourceFile === path.basename(tmp)));
    check("(unres) the tmp is kept byte-for-byte", fs.existsSync(tmp) && Buffer.compare(bytes, fs.readFileSync(tmp)) === 0);
    for (const f of fs.readdirSync(mod.MERGE_QUARANTINE_DIR)) fs.unlinkSync(path.join(mod.MERGE_QUARANTINE_DIR, f));
  }

  // (RELATIVE-PATH control) a non-absolute repoPath is NOT a content identity: falls back to the filename claimant.
  {
    const r = makeRepo("rel-r");
    plantTmp(canonicalRepoLockKey(r), { repoPath: "relative/not-absolute", reason: "garbage identity", enteredAt: Date.now() - 1000, tokens: ["44444444-4444-4444-8444-444444444444"] }, "91005-cafe0005");
    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([r]);
    check("(relative control) a relative repoPath at R's hash STILL fail-closes R", fresh.stillBlockedEntryFor(r) !== undefined);
    for (const f of fs.readdirSync(mod.MERGE_QUARANTINE_DIR)) fs.unlinkSync(path.join(mod.MERGE_QUARANTINE_DIR, f));
  }

  // (TRULY-CORRUPT control) not-JSON at R's hash carries NO content identity: R must stay fail-closed.
  {
    const r = makeRepo("corrupt-r");
    fs.mkdirSync(mod.MERGE_QUARANTINE_DIR, { recursive: true });
    fs.writeFileSync(path.join(mod.MERGE_QUARANTINE_DIR, `${hashOf(canonicalRepoLockKey(r))}.json.tmp-91002-cafe0002`), "{ not json");
    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([r]);
    check("(corrupt control) unparsable bytes at R's own hash STILL fail-close R", fresh.stillBlockedEntryFor(r) !== undefined);
    for (const f of fs.readdirSync(mod.MERGE_QUARANTINE_DIR)) fs.unlinkSync(path.join(mod.MERGE_QUARANTINE_DIR, f));
  }

  // (SELF control) unarmable residue at R's OWN hash naming R: R stays fail-closed (content identity == filename identity).
  {
    const r = makeRepo("self-r");
    plantTmp(canonicalRepoLockKey(r), { repoPath: r, reason: "R's own raise, branch lost", enteredAt: Date.now() - 1000, tokens: ["22222222-2222-4222-8222-222222222222"] }, "91003-cafe0003");
    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([r]);
    const selfEntry = fresh.stillBlockedEntryFor(r);
    check("(self control) unarmable residue naming R at R's own hash STILL fail-closes R", selfEntry !== undefined);
    check("(self control) R's own branchless record gets the NEUTRAL reason (not 'another repo's hash')",
      /whose content names this repo/.test(selfEntry?.reason ?? "") && !/another repo's hash/.test(selfEntry?.reason ?? ""));
    for (const f of fs.readdirSync(mod.MERGE_QUARANTINE_DIR)) fs.unlinkSync(path.join(mod.MERGE_QUARANTINE_DIR, f));
  }
} finally {
  process.exitCode = failures === 0 ? 0 : 1;
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
}
