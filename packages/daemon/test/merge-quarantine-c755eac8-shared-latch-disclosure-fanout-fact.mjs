import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card c755eac8 — the graduated-clear shared-latch disclosure (0dcba62c) keys on the fan-out FACT, not on
// content shape, and discloses the same residues the pending path does. Disclosure only: nothing lifted,
// deleted or re-armed may differ from what the clear did before this card.
//   1. a READABLE file whose stored content is itself a placeholder record is another identity's latch: NOT disclosed
//   2. a sibling pending on a shared corrupt `<hash>.json.tmp-*` residue IS disclosed (no `.json` needed)
//   3. a MIX of graduated-shared and otherwise-kept referencers never states "will NOT itself re-divert"
//   4. the same-identity skip has a negative control
//
// Scenarios run in ONE process: each gets its own repo + a wiped quarantine dir + a fresh module instance.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-c755eac8-shared-latch-disclosure-fanout-fact.mjs
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
useOwnLoomHome("loom-mqc7-");
requireHermeticEnv();

const distGitDir = path.join(__dirname, "..", "dist", "git");
const href = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const { MERGE_QUARANTINE_DIR, PLACEHOLDER_BRANCH_UNRESOLVED } = await import(href);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqc7@loom -c user.name=mqc7";
const tmpDirs = [];
const sfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
let moduleCounter = 0;
const freshModule = () => import(`${href}?m=${++moduleCounter}`);

function makeRepo(tag) {
  const y = path.join(os.tmpdir(), `loom-mqc7-${tag}-${sfx()}`);
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
const dirSnapshot = () => JSON.stringify(fs.readdirSync(MERGE_QUARANTINE_DIR).sort().map((f) => [f, createHash("sha256").update(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f))).digest("hex")]));
const dirNames = () => JSON.stringify(fs.readdirSync(MERGE_QUARANTINE_DIR).sort());
// The clear itself legitimately removes w1's own graduated record, so "disclosure only" is asserted as: what
// the clear leaves behind is EXACTLY the shared file, byte-identical to before — printed as a STATE line so a
// run at the pre-fix ref can be diffed against this one (only the disclosure fields may differ).
const stateLine = (label, res, extra = "") => console.log(`STATE ${label} lifted=${(res.liftedRepoPaths ?? []).map((p) => path.basename(p)).sort()} dir=${dirNames()} ${extra}`);

// Graduate w1 (remount + query), then unmount it again so its clear runs unresolvable.
function graduateThenUnmount(mq, w1) {
  fs.mkdirSync(w1, { recursive: true });
  execSync("git init -q", { cwd: w1 });
  fs.writeFileSync(path.join(w1, "README.md"), "remounted\n");
  commitAll(w1, "init", GIT_ID);
  mq.activeMergeQuarantineFor(w1); // graduates w1
  const parked = `${w1}-parked-${sfx()}`;
  fs.renameSync(w1, parked);
  tmpDirs.push(parked);
}

// Both claimants fanned out from ONE shared corrupt file named `fileName` (a `.json` final or a tmp residue).
async function setupSharedCorrupt(tag, fileName, claimants = 2, graduate = true) {
  const { y, w1, w2, w3 } = makeRepo(tag);
  wipeQuarantineDir();
  const shared = path.join(MERGE_QUARANTINE_DIR, fileName(hashOf(y)));
  fs.writeFileSync(shared, "{");
  const mq = await freshModule();
  const paths = claimants === 1 ? [w1] : [w1, w2];
  mq.reenterMergeQuarantinesAtBoot(paths);
  if (graduate) graduateThenUnmount(mq, w1);
  return { mq, y, w1, w2, w3, paths, shared };
}

// What a boot would arm for `paths` right now, as a sorted list of the paths that are quarantined.
async function bootArmed(paths) {
  const fresh = await freshModule();
  fresh.reenterMergeQuarantinesAtBoot(paths);
  return paths.filter((p) => !!fresh.activeMergeQuarantineFor(p)).sort();
}

try {
  // ---- ITEM 1: a readable placeholder-content sibling is NOT a shared corrupt latch -----------------------------
  for (const placeholderBranch of [PLACEHOLDER_BRANCH_UNRESOLVED, "(unknown — boot found a corrupt/unparsable quarantine latch)"]) {
    const { y, w1, w2 } = makeRepo("p1");
    wipeQuarantineDir();
    const shared = path.join(MERGE_QUARANTINE_DIR, `${hashOf(y)}.json`);
    fs.writeFileSync(shared, JSON.stringify({ repoPath: w2, branch: placeholderBranch, reason: "w2's own latch whose stored content is itself a placeholder record", enteredAt: Date.now(), tokens: ["w2-tok"], placeholder: true }, null, 2) + "\n");
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
    const label = `[item1 ${placeholderBranch.slice(0, 20)}]`;
    check(`${label} (precondition) w2 is pending on its own READABLE placeholder-content latch, file present`, !!mq.activeMergeQuarantineFor(w2) && fs.existsSync(shared));
    const sharedBytes = fs.readFileSync(shared);
    const res = mq.clearMergeQuarantine(w1);
    stateLine(`item1`, res);
    check(`${label} *** c755eac8 *** no latchKept claimed for a readable placeholder-content sibling`, res.latchKept !== true);
    check(`${label} *** c755eac8 *** w2 is NOT named, and no latch-id advice is given`, !(res.referencingRepoPaths ?? []).includes(w2) && !(res.stillBlockedCoOccupants ?? []).some((c) => c.repoPath === w2) && !/24-hex/.test(res.reason ?? ""));
    check(`${label} disclosure only: w1 lifted, w2's file byte-identical and the only file left, w2 still blocked`, (res.liftedRepoPaths ?? []).includes(w1) && dirNames() === JSON.stringify([path.basename(shared)]) && fs.readFileSync(shared).equals(sharedBytes) && !!mq.activeMergeQuarantineFor(w2));
  }

  // ---- ITEM 2: a sibling pending on a shared corrupt tmp residue is disclosed --------------------------------------
  for (const [kind, fileName] of [["tmp", (h) => `${h}.json.tmp-4242-ab12`], ["safety-tmp", (h) => `${h}.json.tmp-safety-4242-ab12cd34`]]) {
    for (const route of ["clearMergeQuarantine", "clearMergeQuarantineByRecordedPath", "clearMergeQuarantineReporting"]) {
      const { mq, w1, w2, paths, shared } = await setupSharedCorrupt(`res-${kind}-${route}`, fileName);
      const label = `[item2 ${kind} ${route}]`;
      check(`${label} (precondition) w2 is still pending on the shared ${kind} residue`, !!mq.activeMergeQuarantineFor(w2) && fs.existsSync(shared));
      const armedBefore = await bootArmed(paths);
      const sharedBytes = fs.readFileSync(shared);
      const res = mq[route](w1);
      const armedAfter = await bootArmed(paths);
      stateLine(`item2 ${kind} ${route}`, res, `armedAfter=${armedAfter.map((p) => path.basename(p))}`);
      check(`${label} *** c755eac8 *** clearing the graduated claimant reports latchKept:true naming the sibling`, res.latchKept === true && (res.referencingRepoPaths ?? []).includes(w2));
      check(`${label} disclosure only: w1 lifted, the residue byte-identical and the only file left`, (res.liftedRepoPaths ?? []).includes(w1) && dirNames() === JSON.stringify([path.basename(shared)]) && fs.readFileSync(shared).equals(sharedBytes));
      check(`${label} (unchanged) the same claimants re-arm on the next boot as before the clear`, JSON.stringify(armedAfter) === JSON.stringify(armedBefore));
    }
  }

  // ---- the pending path and the graduated path name the SAME sibling for a tmp residue (narrow guarantee) ---------------
  {
    for (const [kind, fileName] of [["tmp", (h) => `${h}.json.tmp-4242-ab12`], ["safety-tmp", (h) => `${h}.json.tmp-safety-4242-ab12cd34`]]) {
      const { mq: mqG, w1: g1, w2: g2 } = await setupSharedCorrupt(`parity-grad-${kind}`, fileName);
      const grad = mqG.clearMergeQuarantine(g1);
      const { mq: mqP, w1: p1, w2: p2 } = await setupSharedCorrupt(`parity-pend-${kind}`, fileName, 2, false);
      const pend = mqP.clearMergeQuarantine(p1); // both claimants still PENDING: the pending-clear branch
      const names = (r, other) => r.latchKept === true && (r.referencingRepoPaths ?? []).includes(other);
      console.log(`INFO  [parity ${kind}] graduated refs=${(grad.referencingRepoPaths ?? []).map((p) => path.basename(p))} pending refs=${(pend.referencingRepoPaths ?? []).map((p) => path.basename(p))}`);
      check(`[parity ${kind}] the pending-branch clear of w1 names its sibling w2`, names(pend, p2));
      check(`[parity ${kind}] the graduated-branch clear of w1 names the SAME sibling w2 (same disclosure set, this shape)`, names(grad, g2) && (grad.referencingRepoPaths ?? []).length === (pend.referencingRepoPaths ?? []).length);
    }
  }

  // ---- ITEM 3: mixed referencers --------------------------------------------------------------------------------
  // UNIT-LEVEL by necessity: no end-to-end scenario was found where a graduated clear's disclosure CO-OCCURS with
  // an otherwise-kept referencer. The graduated clear only reaches the shared file's disclosure because that
  // file SURVIVES, so the by-key delete's same-hash sweep (the other keep route) never runs; a tmp residue
  // owned by a third claimant via `orphanLatchFiles` was tried (readable and corrupt) and was NOT named.
  // This pins the SELECTION RULE the call site applies, not the co-occurrence.
  {
    const mq = await freshModule();
    const reason = mq.keptReasonForRefsTestOnly(["/r/w2", "/r/w3"], ["/r/w2"]);
    check("[mixed] *** c755eac8 *** a mix never states 'will NOT itself re-divert'", reason.length > 0 && !/will NOT itself re-divert/.test(reason));
    check("[mixed] a mix says the claimant MAY RE-DIVERT, names BOTH referencers and the 24-hex id clear", /MAY RE-DIVERT/.test(reason) && reason.includes("/r/w2") && reason.includes("/r/w3") && /24-hex/.test(reason));
    const gradOnly = mq.keptReasonForRefsTestOnly(["/r/w2"], ["/r/w2"]);
    check("[mixed] graduated-only keeps the 0dcba62c text", /MAY RE-DIVERT/.test(gradOnly) && !/will NOT itself re-divert/.test(gradOnly) && !/Separately/.test(gradOnly));
    const noneGrad = mq.keptReasonForRefsTestOnly(["/r/w3"], []);
    check("[mixed] (control) no graduated ref keeps the pending-branch text unchanged", /will NOT itself re-divert/.test(noneGrad) && !/MAY RE-DIVERT/.test(noneGrad));
  }

  // ---- ITEM 4: same-identity skip negative control -------------------------------------------------------------------
  // HELPER-LEVEL: through the clear route the skip is unreachable (the caller only consults the helper when the
  // identity has NO matched pending, so a same-identity pending never coexists). It is defence in depth; this
  // pins it on the helper directly.
  {
    const { mq, w1, w2, shared } = await setupSharedCorrupt("same-identity", (h) => `${h}.json`);
    const sourceFile = path.basename(shared);
    mq.pushPendingQuarantineTestOnly({ repoPath: w1, branch: "(unknown)", reason: "w1's own stale pending", enteredAt: Date.now(), tokens: ["w1-own"], placeholder: true }, sourceFile, true);
    const named = mq.sharedPendingLatchReferencersForTestOnly(w1, mq.directPathIdentity(w1)).map((r) => r.repoPath);
    check("[same-identity] (precondition) the sibling w2 is named", named.includes(w2));
    check("[same-identity] *** negative control *** the asking identity itself is never named as its own referencer", !named.includes(w1));
  }

  // ---- ITEM 5: a READABLE content-attributed (byContent) tmp is not a shared corrupt latch ---------------------------
  // X's own `<H>.json` is corrupt (shared fact); `<H>.json.tmp-*` PARSES, names an unresolvable absolute Y, and only
  // fails the branch/reason check — so boot attributes it to Y by CONTENT. Naming Y would steer a latch-id clear
  // that lifts Y's genuine quarantine.
  // (`.json.tmp-<pid>` only: the `.tmp-safety-*` shape is minted in the migrate pass, not this content-attribution loop.)
  for (const tmpName of ["tmp"]) {
    const { y, w1, w2 } = makeRepo(`bycontent-${tmpName}`);
    wipeQuarantineDir();
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashOf(y)}.json`), "{");
    const tmpFile = path.join(MERGE_QUARANTINE_DIR, tmpName === "tmp" ? `${hashOf(y)}.json.tmp-4242-ab12` : `${hashOf(y)}.json.tmp-safety-4242-ab12cd34`);
    fs.writeFileSync(tmpFile, JSON.stringify({ repoPath: w2, tokens: ["y-tok"] }));
    const mq = await freshModule();
    mq.reenterMergeQuarantinesAtBoot([w1]);
    graduateThenUnmount(mq, w1);
    const label = `[item5 byContent ${tmpName}]`;
    check(`${label} (precondition) Y=w2 is pending by content on the readable tmp, file present`, !!mq.activeMergeQuarantineFor(w2) && fs.existsSync(tmpFile));
    const armedBefore = await bootArmed([w1, w2]);
    const tmpBytes = fs.readFileSync(tmpFile);
    const res = mq.clearMergeQuarantine(w1);
    const armedAfter = await bootArmed([w1, w2]);
    stateLine(`item5 ${tmpName}`, res, `armedAfter=${armedAfter.map((p) => path.basename(p))}`);
    check(`${label} *** c755eac8 *** Y is NOT named, plain lifted result, no 24-hex advice`, !(res.referencingRepoPaths ?? []).includes(w2) && !(res.stillBlockedCoOccupants ?? []).some((c) => c.repoPath === w2) && res.latchKept !== true && !/24-hex|MAY RE-DIVERT/.test(res.reason ?? "") && (res.liftedRepoPaths ?? []).includes(w1));
    check(`${label} disclosure only: Y's readable file byte-identical and still present, same boot re-arm as before the clear`, fs.existsSync(tmpFile) && fs.readFileSync(tmpFile).equals(tmpBytes) && armedBefore.includes(w2) && armedAfter.includes(w2) && !armedAfter.includes(w1));
  }

  // ---- ITEM 6: residue ownership is read off the TAGGED pending's own entry ---------------------------------------------
  // T = tagged pending of Y whose own file is gone and which owns nothing; U = UNTAGGED readable entry of the same Y
  // that owns same-hash residue B. Y must NOT be named on the strength of T. Positive control: T itself owning B IS named.
  {
    const { y, w1, w2, mq } = await setupSharedCorrupt("owner", (h) => `${h}.json`, 1);
    const h = hashOf(y);
    const residueB = `${h}.json.tmp-7777-beef`;
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, residueB), "{");
    const mkEntry = (extra) => ({ repoPath: w2, branch: "(unknown)", reason: "Y", enteredAt: Date.now(), tokens: [`y-${sfx()}`], placeholder: true, ...extra });
    mq.pushPendingQuarantineTestOnly(mkEntry({}), `${h}.json.tmp-1111-gone`, true); // T: tagged, file absent
    mq.pushPendingQuarantineTestOnly(mkEntry({ orphanLatchFiles: [residueB] }), "unrelated-readable.json", false); // U: untagged owner of B
    const named = mq.sharedPendingLatchReferencersForTestOnly(w1, mq.directPathIdentity(w1)).map((r) => r.repoPath);
    check("[item6] *** negative control *** an UNTAGGED readable owner of residue B does not get Y named via a tagged-but-missing pending", !named.includes(w2));
    mq.pushPendingQuarantineTestOnly(mkEntry({ orphanLatchFiles: [residueB] }), `${h}.json.tmp-2222-gone`, true); // T2: tagged AND owns B
    const named2 = mq.sharedPendingLatchReferencersForTestOnly(w1, mq.directPathIdentity(w1)).map((r) => r.repoPath);
    check("[item6] (positive control) a TAGGED pending that itself owns residue B still names Y", named2.includes(w2));
  }

  // ---- ITEM 7: PIN (source text, NOT behaviour) — every in-place rewrite site drops the tag -------------------------------
  // Behavioural coverage of these rewrites would need a write-success/failure harness per site; this only pins that the
  // three sites (replaceEntryEverywhere, the token-clear live.sourceFile and twin-clear p.sourceFile reassignments)
  // keep an untag. It does not prove each fires on the right path.
  {
    const js = fs.readFileSync(path.join(distGitDir, "merge-quarantine.js"), "utf8");
    const untags = (js.match(/delete (?:p|live)\.sharedCorruptLatch/g) ?? []).length;
    check(`[item7 pin] the compiled module untags at all three in-place rewrite sites (found ${untags})`, untags === 3);
  }
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

console.log(failures === 0 ? "\n[c755eac8] all checks passed" : `\n[c755eac8] ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
