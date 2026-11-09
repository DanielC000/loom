import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 0dcba62c — clearing a GRADUATED claimant of a shared corrupt latch (remount, then unmount
// again) while a sibling claimant is still pending on the same file must DISCLOSE the kept shared latch
// (`latchKept` + `referencingRepoPaths`), exactly as the pending-clear branch does. Disclosure only: what
// is lifted and what survives is unchanged — the cleared claimant still re-arms on the next boot (the
// documented 882d6cff round-4 behaviour; no durable per-claimant tombstone, by ruling).
//
// Scenarios run in ONE process: each gets its own repo + a wiped quarantine dir + a fresh module instance
// (a stale latch from an earlier scenario would otherwise be fanned out to every registered claimant).
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-0dcba62c-graduated-clear-discloses-shared-latch.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
useOwnLoomHome("loom-mq0dc-");
requireHermeticEnv();

const distGitDir = path.join(__dirname, "..", "dist", "git");
const href = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const { MERGE_QUARANTINE_DIR } = await import(href);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mq0dc@loom -c user.name=mq0dc";
const tmpDirs = [];
const sfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
let moduleCounter = 0;
const freshModule = () => import(`${href}?m=${++moduleCounter}`);

function makeRepo(tag) {
  const y = path.join(os.tmpdir(), `loom-mq0dc-${tag}-${sfx()}`);
  fs.mkdirSync(y, { recursive: true });
  tmpDirs.push(y);
  fs.writeFileSync(path.join(y, "README.md"), `# ${tag}\n`);
  execSync("git init -q", { cwd: y });
  commitAll(y, "init", GIT_ID);
  return { y, w1: path.join(y, "a"), w2: path.join(y, "b") };
}

function wipeQuarantineDir() {
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  for (const f of fs.readdirSync(MERGE_QUARANTINE_DIR)) fs.rmSync(path.join(MERGE_QUARANTINE_DIR, f), { recursive: true, force: true });
}

// Both claimants armed from ONE corrupt shared latch; w1 remounts, graduates via a query, unmounts again.
async function setupGraduatedThenUnmounted(tag, claimants) {
  const { y, w1, w2 } = makeRepo(tag);
  wipeQuarantineDir();
  const shared = path.join(MERGE_QUARANTINE_DIR, `${createHash("sha256").update(canonicalRepoLockKey(y)).digest("hex").slice(0, 24)}.json`);
  fs.writeFileSync(shared, "{");
  const mq = await freshModule();
  const paths = claimants === 1 ? [w1] : [w1, w2];
  mq.reenterMergeQuarantinesAtBoot(paths);
  fs.mkdirSync(w1, { recursive: true });
  execSync("git init -q", { cwd: w1 });
  fs.writeFileSync(path.join(w1, "README.md"), "remounted\n");
  commitAll(w1, "init", GIT_ID);
  mq.activeMergeQuarantineFor(w1); // graduates w1
  const parked = `${w1}-parked-${sfx()}`;
  fs.renameSync(w1, parked);
  tmpDirs.push(parked);
  return { mq, w1, w2, paths, shared };
}

try {
  for (const route of ["clearMergeQuarantine", "clearMergeQuarantineByRecordedPath", "clearMergeQuarantineReporting"]) {
    const { mq, w1, w2, paths, shared } = await setupGraduatedThenUnmounted(`share-${route}`, 2);
    check(`[${route}] (precondition) w2 is still pending on the shared file`, !!mq.activeMergeQuarantineFor(w2) && fs.existsSync(shared));
    const res = mq[route](w1);
    check(`[${route}] *** 0dcba62c *** clearing the graduated claimant reports latchKept:true`, res.latchKept === true);
    check(`[${route}] *** 0dcba62c *** the report names the sibling claimant`, Array.isArray(res.referencingRepoPaths) && res.referencingRepoPaths.includes(w2));
    check(`[${route}] disclosure only: the shared file survives and w1 is lifted`, fs.existsSync(shared) && (res.liftedRepoPaths ?? []).includes(w1));
    const fresh = await freshModule();
    fresh.reenterMergeQuarantinesAtBoot(paths);
    check(`[${route}] (unchanged) both claimants re-arm on the next boot`, !!fresh.activeMergeQuarantineFor(w1) && !!fresh.activeMergeQuarantineFor(w2));
  }

  // NEGATIVE CONTROL (behavioural): a SOLE claimant that graduated and unmounted leaves no shared latch,
  // so its clear must NOT claim one is kept.
  {
    const { mq, w1, shared } = await setupGraduatedThenUnmounted("sole", 1);
    check("[sole] (precondition) no shared latch file remains after the sole claimant graduated", !fs.existsSync(shared));
    const res = mq.clearMergeQuarantine(w1);
    check("[sole] a sole graduated claimant's clear reports NO latchKept", res.latchKept !== true && !(res.referencingRepoPaths ?? []).length);
  }

  // NEGATIVE CONTROL (behavioural, code-review finding 1): the surviving file is a READABLE latch owned by a
  // different identity (w2's genuine tokens), not the shared corrupt latch. w1 raised its OWN quarantine at its
  // own key while resolvable, then unmounted; its clear must NOT claim w2 is a kept sibling of a shared latch
  // (w1 never re-diverts from w2's readable file), and must keep the plain lifted result.
  {
    const { y, w1, w2 } = makeRepo("readable-sibling");
    wipeQuarantineDir();
    const shared = path.join(MERGE_QUARANTINE_DIR, `${createHash("sha256").update(canonicalRepoLockKey(y)).digest("hex").slice(0, 24)}.json`);
    fs.writeFileSync(shared, JSON.stringify({ repoPath: w2, branch: "w2-branch", reason: "w2's own genuine readable latch", enteredAt: Date.now(), tokens: ["w2-tok"] }, null, 2) + "\n");
    const mq = await freshModule();
    mq.reenterMergeQuarantinesAtBoot([w2]);
    fs.mkdirSync(w1, { recursive: true });
    execSync("git init -q", { cwd: w1 });
    fs.writeFileSync(path.join(w1, "README.md"), "w1\n");
    commitAll(w1, "init", GIT_ID);
    mq.enterMergeQuarantine(w1, "w1-branch", "w1's own raise");
    const parked = `${w1}-parked-${sfx()}`;
    fs.renameSync(w1, parked);
    tmpDirs.push(parked);
    check("[readable-sibling] (precondition) w2 is pending on its own readable latch, file present", !!mq.activeMergeQuarantineFor(w2) && fs.existsSync(shared));
    const res = mq.clearMergeQuarantine(w1);
    check("[readable-sibling] *** finding 1 *** no latchKept claimed for a readable sibling's file", res.latchKept !== true);
    check("[readable-sibling] *** finding 1 *** w2 is NOT named as a referencer", !(res.referencingRepoPaths ?? []).includes(w2) && !(res.stillBlockedCoOccupants ?? []).some((c) => c.repoPath === w2));
    check("[readable-sibling] plain lifted result kept (w1 lifted) and w2's file untouched", (res.liftedRepoPaths ?? []).includes(w1) && fs.existsSync(shared));
    check("[readable-sibling] the reason does not advise a latch-id clear", !/24-hex/.test(res.reason ?? ""));
  }

  // Reason text on the graduated/shared-corrupt path must not claim the cleared claimant won't re-divert.
  {
    const { mq, w1, w2 } = await setupGraduatedThenUnmounted("reason", 2);
    const res = mq.clearMergeQuarantine(w1);
    const reason = res.reason ?? "";
    check("[reason] graduated path does not say the claimant 'will NOT itself re-divert'", reason.length > 0 && !/will NOT itself re-divert/.test(reason));
    check("[reason] graduated path says the claimant MAY RE-DIVERT, names the sibling and the 24-hex id clear", /MAY RE-DIVERT/.test(reason) && reason.includes(w2) && /24-hex/.test(reason));
  }

  // The documented durable escape still lifts everything.
  {
    const { mq, w1, w2, paths, shared } = await setupGraduatedThenUnmounted("escape", 2);
    mq.clearMergeQuarantine(w1);
    const r = mq.clearMergeQuarantineLatchFile(path.basename(shared, ".json"));
    check("[escape] clearing the shared latch by id succeeds and removes the file", r.ok === true && !fs.existsSync(shared));
    const fresh = await freshModule();
    fresh.reenterMergeQuarantinesAtBoot(paths);
    check("[escape] neither claimant re-arms after the latch-id clear", !fresh.activeMergeQuarantineFor(w1) && !fresh.activeMergeQuarantineFor(w2));
  }
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

console.log(failures === 0 ? "\n[0dcba62c] all checks passed" : `\n[0dcba62c] ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
