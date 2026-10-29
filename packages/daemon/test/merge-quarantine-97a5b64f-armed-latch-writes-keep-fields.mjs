import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision 5d0820c7 — pins that the field-parity arm closes card 97a5b64f's own two write-site shapes
// (mergeTokenIntoPendingEntries, rewriteOrphanLatchFilesAfterPartialClear) with no rebase-onto-disk fix
// of their own — investigated, not fixed: both reproduced RED at bf191152 (pre-5d0820c7), GREEN here.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq97a5-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);
const mod = await import(mergeQuarantineModuleHref);
const { enterMergeQuarantine } = mod;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mq97a5@loom -c user.name=mq97a5";
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mq97a5-repo-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), `# merge-quarantine-97a5b64f (${tag})\n`);
  execSync(`git init -q && git config user.email mq97a5@loom && git config user.name mq97a5`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

let bootReimportCounter = 0;
async function freshBootModule() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

// Same technique as 1dd00dca's/028837ad's/5d0820c7's own test files: fold `orphanBasename` into
// `repoPath`'s own on-disk final JSON BEFORE `orphanBasename` itself exists.
function foldOrphanRefIntoOwnFinal(repoPath, againstModule) {
  const files = fs.readdirSync(againstModule.MERGE_QUARANTINE_DIR).filter((f) => f.endsWith(".json") && (() => {
    try { return JSON.parse(fs.readFileSync(path.join(againstModule.MERGE_QUARANTINE_DIR, f), "utf8")).repoPath === repoPath; } catch { return false; }
  })());
  const finalPath = path.join(againstModule.MERGE_QUARANTINE_DIR, files[0]);
  const orphanBasename = `${createHash("sha256").update(`${repoPath}-${freshSfx()}`).digest("hex").slice(0, 24)}.json`;
  const record = JSON.parse(fs.readFileSync(finalPath, "utf8"));
  record.orphanLatchFiles = [orphanBasename];
  fs.writeFileSync(finalPath, JSON.stringify(record));
  return orphanBasename;
}

function writeOrphanContent(orphanBasename, repoPath, branch, reason, tokens, againstModule, extra = {}) {
  fs.mkdirSync(againstModule.MERGE_QUARANTINE_DIR, { recursive: true });
  const orphanPath = path.join(againstModule.MERGE_QUARANTINE_DIR, orphanBasename);
  fs.writeFileSync(orphanPath, JSON.stringify({ repoPath, branch, reason, enteredAt: Date.now(), tokens, ...extra }));
  return orphanPath;
}

try {
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // (a) mergeTokenIntoPendingEntries (~:3800, no rebase) — card 97a5b64f's own shape: O = {T = B/
  // gone-subdir (unresolvable, B a real repo), tokens [tF] only, resolvedKey key(B)}. clear(A,tA) arms
  // T pending (no reduce: O lacks tA, so this is a pure arm, never 028837ad's own reduce-write). A LATER
  // enterMergeQuarantine(T) routes through mergeTokenIntoPendingEntries (T stays unresolvable) — asserts
  // resolvedKey=key(B) SURVIVES the merge+write, on disk, so B stays blocked in-process and after reboot.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  console.log("=== (a) mergeTokenIntoPendingEntries ===");
  {
    const A = makeRepo("a-a");
    const tA = enterMergeQuarantine(A, "loom/a-branch", "merge in progress for A (97a5b64f scenario a)");
    const orphanBasename = foldOrphanRefIntoOwnFinal(A, mod);

    const booted = await freshBootModule();
    booted.reenterMergeQuarantinesAtBoot([A]);

    const B = makeRepo("a-b");
    const keyB = canonicalRepoLockKey(B);
    const T = path.join(B, "gone-subdir-never-exists");
    const tF = randomUUID();
    writeOrphanContent(orphanBasename, T, "loom/t-branch", "merge in progress for T (97a5b64f scenario a)", [tF], booted, { resolvedKey: keyB });

    booted.clearMergeQuarantineByToken(A, tA); // arms T PENDING (resolvedKey=keyB, field-parity carried by 5d0820c7)
    check("(a) sanity: B reads blocked right after the bare arm (pre-merge)", booted.stillBlockedEntryFor(B) !== undefined);

    const tR = booted.enterMergeQuarantine(T, "loom/t-branch-2", "a later raise of T itself (97a5b64f scenario a)");
    check("(a) sanity: the later raise returned a real token", typeof tR === "string" && tR.length > 0);
    check("(a) IN-PROCESS: B still reads blocked right after the later raise/merge", booted.stillBlockedEntryFor(B) !== undefined);

    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([A, B]);
    check("(a) REBOOT: B still reads blocked after a reboot", fresh.stillBlockedEntryFor(B) !== undefined);

    const pendingFiles = fs.readdirSync(mod.MERGE_QUARANTINE_DIR).filter((f) => f.endsWith(".json") && (() => {
      try { return JSON.parse(fs.readFileSync(path.join(mod.MERGE_QUARANTINE_DIR, f), "utf8")).repoPath === T; } catch { return false; }
    })());
    check("(a) ON-DISK: exactly one file now holds T's merged pending record", pendingFiles.length === 1);
    const onDisk = pendingFiles.length === 1 ? JSON.parse(fs.readFileSync(path.join(mod.MERGE_QUARANTINE_DIR, pendingFiles[0]), "utf8")) : {};
    check("(a) ON-DISK: T's own merged record still carries resolvedKey=key(B) — the field THE MERGE must not strip", onDisk.resolvedKey === keyB);
    check("(a) ON-DISK: T's own merged record unions both tokens (the arm's tF, the later raise's own)", Array.isArray(onDisk.tokens) && onDisk.tokens.includes(tF) && onDisk.tokens.includes(tR));
  }
} catch (e) {
  console.error("(a) THREW:", e);
  failures++;
}

try {
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // (b) rewriteOrphanLatchFilesAfterPartialClear (~:4600->:4957, no rebase) — card 97a5b64f's own shape:
  // O = {T a real repo, tokens [tA,tF], contributorRepoPaths:[C]}. clear(A,tA) arms T ACTIVE (T
  // resolvable, Step A carries contributorRepoPaths through); since tA is ALSO one of T's own on-disk
  // tokens, the SAME active loop revisits T and partial-clears tA from T's own entry too, which calls
  // rewriteOrphanLatchFilesAfterPartialClear -> writePendingDivertFile(O, updated, {tA}) with no rebase.
  // Asserts contributorRepoPaths=[C] SURVIVES on disk, so C stays blocked in-process and after reboot.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  console.log("=== (b) rewriteOrphanLatchFilesAfterPartialClear ===");
  {
    const A = makeRepo("b-a");
    const tA = enterMergeQuarantine(A, "loom/a-branch", "merge in progress for A (97a5b64f scenario b)");
    const orphanBasename = foldOrphanRefIntoOwnFinal(A, mod);

    const booted = await freshBootModule();
    booted.reenterMergeQuarantinesAtBoot([A]);

    const T = makeRepo("b-t");
    const C = path.join(os.tmpdir(), `loom-mq97a5-b-c-never-exists-${freshSfx()}`);
    const tF = randomUUID();
    // O's own bytes carry BOTH A's token (tA) and T's own token (tF) — a prior union/duplicate record
    // naming T but still holding A's own outstanding token too.
    writeOrphanContent(orphanBasename, T, "loom/t-branch", "merge in progress for T (97a5b64f scenario b)", [tA, tF], booted, { contributorRepoPaths: [C] });

    booted.clearMergeQuarantineByToken(A, tA); // arms T ACTIVE, then (same active loop) partial-clears T's own tA too
    check("(b) sanity: C reads blocked right after the arm+partial-clear", booted.stillBlockedEntryFor(C) !== undefined);

    const tEntry = booted.activeMergeQuarantineFor(T);
    check("(b) IN-PROCESS: T's own entry still carries contributorRepoPaths=[C]", !!tEntry && Array.isArray(tEntry.contributorRepoPaths) && tEntry.contributorRepoPaths.includes(C));
    check("(b) IN-PROCESS: T's own entry was genuinely reduced (tA dropped, tF kept — proves the partial-clear write ran)", !!tEntry && !tEntry.tokens.includes(tA) && tEntry.tokens.includes(tF));
    check("(b) IN-PROCESS: C still reads blocked", booted.stillBlockedEntryFor(C) !== undefined);

    const orphanPath = path.join(mod.MERGE_QUARANTINE_DIR, orphanBasename);
    check("(b) ON-DISK: O still exists (ownership confirmed, rewritten in place — never deleted)", fs.existsSync(orphanPath));
    const onDisk = fs.existsSync(orphanPath) ? JSON.parse(fs.readFileSync(orphanPath, "utf8")) : {};
    check("(b) ON-DISK: O's own tokens were reduced to [tF] only — proves the write actually ran, not just left stale", Array.isArray(onDisk.tokens) && !onDisk.tokens.includes(tA) && onDisk.tokens.includes(tF));
    check("(b) ON-DISK: O still carries contributorRepoPaths=[C] — the field THE PARTIAL-CLEAR WRITE must not strip", Array.isArray(onDisk.contributorRepoPaths) && onDisk.contributorRepoPaths.includes(C));

    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([A, T, C]);
    check("(b) REBOOT: C still reads blocked after a reboot", fresh.stillBlockedEntryFor(C) !== undefined);
  }
} catch (e) {
  console.error("(b) THREW:", e);
  failures++;
}

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
