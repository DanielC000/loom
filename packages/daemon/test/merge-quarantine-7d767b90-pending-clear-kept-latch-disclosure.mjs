import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 7d767b90 — the PENDING-branch clear's kept-latch disclosure tells the truth about the next boot.
// Disclosure only: nothing lifted, deleted or re-armed may differ from what the clear did before this card.
//   A. a shared corrupt `<hash>.json` (all claimants still pending): the cleared claimant re-arms on the next
//      boot too, so the reason must NOT say it "will NOT itself re-divert" (it MAY RE-DIVERT, with the siblings)
//   B. a shared corrupt tmp / safety-tmp residue: since c4f0d786 the pending clear KEEPS it (siblings name it as
//      their sourceFile), so it is the same kept-latch disclosure as A and a restart re-arms every claimant
//      (7d767b90's interim "removed / IN THIS PROCESS ONLY" wording is unreachable and was removed)
//   C. (control) a non-shared kept referencer keeps the pending text unchanged
// Each truth claim is checked against what a FRESH boot actually arms.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-7d767b90-pending-clear-kept-latch-disclosure.mjs
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
useOwnLoomHome("loom-mq7d-");
requireHermeticEnv();

const distGitDir = path.join(__dirname, "..", "dist", "git");
const href = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const { MERGE_QUARANTINE_DIR } = await import(href);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mq7d@loom -c user.name=mq7d";
const tmpDirs = [];
const sfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
let moduleCounter = 0;
const freshModule = () => import(`${href}?m=${++moduleCounter}`);

function makeRepo(tag) {
  const y = path.join(os.tmpdir(), `loom-mq7d-${tag}-${sfx()}`);
  fs.mkdirSync(y, { recursive: true });
  tmpDirs.push(y);
  fs.writeFileSync(path.join(y, "README.md"), `# ${tag}\n`);
  execSync("git init -q", { cwd: y });
  commitAll(y, "init", GIT_ID);
  return { y, w1: path.join(y, "a"), w2: path.join(y, "b"), w3: path.join(y, "c") };
}

function wipeQuarantineDir() {
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  for (const f of fs.readdirSync(MERGE_QUARANTINE_DIR)) fs.rmSync(path.join(MERGE_QUARANTINE_DIR, f), { recursive: true, force: true });
}

const hashOf = (y) => createHash("sha256").update(canonicalRepoLockKey(y)).digest("hex").slice(0, 24);
const dirNames = () => JSON.stringify(fs.readdirSync(MERGE_QUARANTINE_DIR).sort());
const base = (p) => path.basename(p);

// What a fresh boot arms for `paths`, as a sorted list of basenames.
async function bootArmed(paths) {
  const fresh = await freshModule();
  fresh.reenterMergeQuarantinesAtBoot(paths);
  return paths.filter((p) => !!fresh.activeMergeQuarantineFor(p)).map(base).sort();
}

try {
  // ---- A / B: every pending-branch route, every shared-corrupt shape -------------------------------------------------
  // Two-file shapes: a shared corrupt `<hash>.json` BESIDE a residue of the same hash. Each claimant carries one
  // pending entry per file; the clear unlinks the residue only, the json survives and re-arms everybody.
  const SHAPES = [
    ["json", (h) => [`${h}.json`], true],
    ["tmp", (h) => [`${h}.json.tmp-4242-ab12`], true],
    ["safety-tmp", (h) => [`${h}.json.tmp-safety-4242-ab12cd34`], true],
    ["json+tmp", (h) => [`${h}.json`, `${h}.json.tmp-4242-ab12`], true],
    ["json+safety-tmp", (h) => [`${h}.json`, `${h}.json.tmp-safety-4242-ab12cd34`], true],
  ];
  for (const [kind, fileNames, fileSurvives] of SHAPES) {
    for (const claimants of [2, 3]) {
      for (const route of ["clearMergeQuarantine", "clearMergeQuarantineByRecordedPath", "clearMergeQuarantineReporting"]) {
        const label = `[${kind} x${claimants} ${route}]`;
        const { y, w1, w2, w3 } = makeRepo(`${kind}-${claimants}-${route}`);
        wipeQuarantineDir();
        for (const f of fileNames(hashOf(y))) fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, f), "{");
        const paths = claimants === 2 ? [w1, w2] : [w1, w2, w3];
        const siblings = paths.slice(1);
        const mq = await freshModule();
        mq.reenterMergeQuarantinesAtBoot(paths); // all claimants PENDING (none graduated)
        const filesBefore = fs.readdirSync(MERGE_QUARANTINE_DIR).length;
        const res = mq[route](w1);
        const filesAfter = fs.readdirSync(MERGE_QUARANTINE_DIR).length;
        const armedAfter = await bootArmed(paths);
        const reason = res.reason ?? "";
        // STATE line: identical before/after this card (the card changes the disclosure only).
        console.log(`STATE ${label} lifted=${(res.liftedRepoPaths ?? []).map(base).sort()} filesBefore=${filesBefore} filesAfter=${filesAfter} dir=${dirNames()} armedNextBoot=${armedAfter}`);
        check(`${label} (precondition) the shared file existed and w1 was lifted`, filesBefore === fileNames(hashOf(y)).length && (res.liftedRepoPaths ?? []).includes(w1));
        check(`${label} (disk truth) every shared file survives this clear (c4f0d786: a sibling still names each one)`, filesAfter === fileNames(hashOf(y)).length);
        check(`${label} (reason is never the old unconditional text) no "will NOT itself re-divert"`, reason.length > 0 && !/will NOT itself re-divert/.test(reason));
        if (fileSurvives) {
          check(`${label} *** 7d767b90 *** a fresh boot re-arms w1 AND every sibling (what the text must be true against)`, JSON.stringify(armedAfter) === JSON.stringify(paths.map(base).sort()));
          check(`${label} *** 7d767b90 *** latchKept:true naming every sibling`, res.latchKept === true && siblings.every((s) => (res.referencingRepoPaths ?? []).includes(s)));
          check(`${label} *** 7d767b90 *** says the claimant MAY RE-DIVERT and names the 24-hex latch-id clear`, /MAY RE-DIVERT/.test(reason) && /24-hex/.test(reason));
        }
        // c4f0d786: no shape removes a file a sibling still names, so the "removed from disk / IN THIS PROCESS ONLY" wording is gone.
        check(`${label} *** c4f0d786 *** never claims a removal / "IN THIS PROCESS ONLY" / "will NOT re-arm"`, !/removed from disk/.test(reason) && !/IN THIS PROCESS ONLY/.test(reason) && !/will NOT re-arm/.test(reason));
        check(`${label} (unchanged) the siblings are still blocked in this process and not reported as lifted`, siblings.every((s) => !!mq.activeMergeQuarantineFor(s) && !(res.liftedRepoPaths ?? []).includes(s)));
      }
    }
  }

  // ---- C: control — a ref that is NOT a shared-corrupt claimant keeps the pending-branch text ---------------------
  {
    const mq = await freshModule();
    const reason = mq.keptReasonForRefsTestOnly(["/r/other"], []);
    check("[control] a non-shared kept referencer keeps 'will NOT itself re-divert' (true there)", /will NOT itself re-divert/.test(reason) && !/MAY RE-DIVERT/.test(reason));
  }
} finally {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
