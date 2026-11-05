import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 97516691 — see docs/decisions/97516691-lifted-reresolve-shared-helper.md.
// Every clear route's `liftedRepoPaths` must agree with `assertRepoNotQuarantined`: lifted => assert passes (the code can be slightly stricter than assert).
// SENSITIVITY NOTE: sections (B) and (E) are AGREEMENT/REGRESSION pins only — they stay green under a revert of
// the helper (B is masked by the queried-identity backstop in tryClearMergeQuarantineByOwnIdentity, E by the
// hard-coded liftedRepoPaths on that route). The sections that only the shared helper can decide (a NON-queried
// candidate) are (F), (G), (H1), (H2) below.
// STATE: raise R; a foreign D (a real subdir of R sharing R's canonical key K) is armed IN MEMORY during R's
// own clear (1dd00dca/25d0d45b orphan-arm), so R still refuses (D sits at K) although R's own entry is gone.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq9751-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mqHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);
const mod = await import(mqHref);
const { enterMergeQuarantine } = mod;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mq9751@loom -c user.name=mq9751";
const tmpDirs = [];
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mq9751-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# mq-97516691 (${tag})\n`);
  execSync(`git init -q && git config user.email mq9751@loom && git config user.name mq9751`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}
let boots = 0;
const freshBoot = async () => import(`${mqHref}?b=${++boots}`);

// Fold a not-yet-existing orphan basename into R's own on-disk final (same technique as 1dd00dca).
function foldOrphanRefIntoOwnFinal(repoPath) {
  const dir = mod.MERGE_QUARANTINE_DIR;
  const f = fs.readdirSync(dir).find((n) => n.endsWith(".json") && (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")).repoPath === repoPath; } catch { return false; } })());
  const finalPath = path.join(dir, f);
  const orphan = `${randomBytes(12).toString("hex")}.json`;
  const rec = JSON.parse(fs.readFileSync(finalPath, "utf8"));
  rec.orphanLatchFiles = [orphan];
  fs.writeFileSync(finalPath, JSON.stringify(rec));
  return orphan;
}

/** Builds the armed-co-occupant state in a fresh boot: R raised + booted, D = R/sub (real dir, no .git, same key K). */
async function buildState(tag, { withD = true } = {}) {
  const R = makeRepo(`${tag}-r`);
  const D = path.join(R, "sub-d");
  fs.mkdirSync(D);
  const tR = enterMergeQuarantine(R, `loom/${tag}`, `merge in progress for R (97516691 ${tag})`);
  const orphan = withD ? foldOrphanRefIntoOwnFinal(R) : null;
  const booted = await freshBoot();
  booted.reenterMergeQuarantinesAtBoot([R]);
  if (withD) {
    fs.writeFileSync(path.join(booted.MERGE_QUARANTINE_DIR, orphan), JSON.stringify({ repoPath: D, branch: "loom/d", reason: `foreign D (${tag})`, enteredAt: Date.now(), tokens: [randomUUID()] }));
  }
  return { R, D, tR, booted };
}
const liftedHas = (res, p) => (res.liftedRepoPaths ?? []).some((x) => path.resolve(x) === path.resolve(p));

try {
  check("(precondition) D really shares R's canonical key", (() => { const R = makeRepo("pre"); const D = path.join(R, "s"); fs.mkdirSync(D); return canonicalRepoLockKey(D) === canonicalRepoLockKey(R); })());

  // ---- (A) /clear (clearMergeQuarantineReporting) ----------------------------------------------------
  {
    const { R, booted } = await buildState("a");
    const res = booted.clearMergeQuarantineReporting(R);
    const refuses = booted.assertRepoNotQuarantined(R).ok === false;
    check("(A precondition) R still refuses after /clear (D armed at K)", refuses);
    check("*** THE FIX *** (A) /clear: lifted(R) <=> assert(R).ok", liftedHas(res, R) === !refuses);
  }
  // ---- (B) /clear-by-path (clearMergeQuarantineByRecordedPath) ---------------------------------------
  {
    const { R, booted } = await buildState("b");
    const res = booted.clearMergeQuarantineByRecordedPath(R);
    const refuses = booted.assertRepoNotQuarantined(R).ok === false;
    check("(B precondition) R still refuses after /clear-by-path", refuses);
    check("(B) /clear-by-path: lifted(R) <=> assert(R).ok", liftedHas(res, R) === !refuses);
  }
  // ---- (C) /clear and /clear-by-path agree with each other on the same state (each built+cleared in turn) ----
  {
    const a = await buildState("c1");
    const ra = a.booted.clearMergeQuarantineReporting(a.R);
    const liftedA = liftedHas(ra, a.R);
    const b = await buildState("c2");
    const rb = b.booted.clearMergeQuarantineByRecordedPath(b.R);
    check("(C) both routes agree on whether R is lifted", liftedA === liftedHas(rb, b.R));
  }
  // ---- (D) POSITIVE CONTROL: no foreign D -> R really is lifted, and still reported lifted ------------
  {
    const { R, booted } = await buildState("d", { withD: false });
    const res = booted.clearMergeQuarantineReporting(R);
    check("(D precondition) R passes assert once cleared (no D)", booted.assertRepoNotQuarantined(R).ok === true);
    check("(D) positive control: /clear still reports R lifted", liftedHas(res, R));
    const { R: R2, booted: b2 } = await buildState("d2", { withD: false });
    const res2 = b2.clearMergeQuarantineByRecordedPath(R2);
    check("(D) positive control: /clear-by-path still reports R lifted", b2.assertRepoNotQuarantined(R2).ok === true && liftedHas(res2, R2));
  }
  // ---- (E) /clear-by-id (clearMergeQuarantineLatchFile) on the SAME shape ------------------------------
  {
    const { R, booted } = await buildState("e");
    const id = createHash("sha256").update(canonicalRepoLockKey(R)).digest("hex").slice(0, 24);
    const res = booted.clearMergeQuarantineLatchFile(id);
    const refuses = booted.assertRepoNotQuarantined(R).ok === false;
    check("(E precondition) the id route ran ok and R still refuses (D armed at K)", res.ok === true && refuses);
    check("(E) /clear-by-id: lifted(R) <=> assert(R).ok", res.ok === true && liftedHas(res, R) === !refuses);
  }
  // ======================================================================================================
  // ROUND 2 (Code Review finding 1): RELEASED (this clear discarded the candidate's own tokens) is a
  // different set from LIFTED (released AND admitted). A released candidate that a DIFFERENT identity still
  // blocks must not vanish from the response: it stays in `releasedRepoPaths` (so alsoReleased + the
  // provenanceUnknown notice are computed over it) and is named, with its blocker, in
  // `releasedStillBlockedRepoPaths`.
  // ======================================================================================================
  const hashForKey = (key) => createHash("sha256").update(key).digest("hex").slice(0, 24);
  const sameP = (a, b) => path.resolve(a) === path.resolve(b);
  const hasP = (list, p) => (list ?? []).some((x) => sameP(typeof x === "string" ? x : x.repoPath, p));
  /** A 6de79dc0-shaped union written by hand: S owns Ks (+ a stale resolvedKey Kq); Q is a real independent
   *  sibling repo (own key Kq) folded in as a contributor. `blocked` picks the side a FOREIGN identity F then
   *  holds armed at that side's key once the clear runs (orphan-armed, same technique as buildState):
   *  "primary" => F under S at Ks; "contributor" => F under Q at Kq. */
  async function buildUnionState(tag, { blocked, provenanceUnknown = false }) {
    const S = makeRepo(`${tag}-s`);
    const Q = makeRepo(`${tag}-q`);
    const ks = canonicalRepoLockKey(S);
    const kq = canonicalRepoLockKey(Q);
    const F = path.join(blocked === "primary" ? S : Q, "sub-f");
    fs.mkdirSync(F);
    const orphan = `${randomBytes(12).toString("hex")}.json`;
    fs.writeFileSync(path.join(mod.MERGE_QUARANTINE_DIR, `${hashForKey(ks)}.json`), JSON.stringify({
      repoPath: S, branch: "s-branch", reason: `union (97516691 ${tag})`, enteredAt: Date.now() - 60_000,
      tokens: [randomUUID(), randomUUID()], resolvedKey: kq, identityAtRaise: ks, contributorRepoPaths: [Q],
      orphanLatchFiles: [orphan], ...(provenanceUnknown ? { provenanceUnknown: true } : {}),
    }, null, 2) + "\n");
    const booted = await freshBoot();
    booted.reenterMergeQuarantinesAtBoot([]);
    fs.writeFileSync(path.join(booted.MERGE_QUARANTINE_DIR, orphan), JSON.stringify({ repoPath: F, branch: "loom/f", reason: `foreign F (${tag})`, enteredAt: Date.now(), tokens: [randomUUID()] }));
    return { S, Q, F, booted };
  }

  // ---- (F) /clear(Q): S (the union's primary, NON-queried) is released but blocked by F at Ks; Q is genuinely lifted ----
  {
    const { S, Q, F, booted } = await buildUnionState("f", { blocked: "primary" });
    const res = booted.clearMergeQuarantineReporting(Q);
    check("(F precondition) S still refuses after /clear(Q) (F armed at Ks) and Q is clear", booted.assertRepoNotQuarantined(S).ok === false && booted.assertRepoNotQuarantined(Q).ok === true);
    check("*** (F) *** S is NOT in liftedRepoPaths (lifted <=> admitted stays)", !hasP(res.liftedRepoPaths, S));
    check("(F, nit 4) the SAME clear's other candidate Q IS lifted (one blocked + one genuinely lifted)", hasP(res.liftedRepoPaths, Q));
    check("*** (F) *** S IS in releasedRepoPaths (its own tokens were discarded)", hasP(res.releasedRepoPaths, S) && hasP(res.releasedRepoPaths, Q));
    const blockedEntry = (res.releasedStillBlockedRepoPaths ?? []).find((e) => sameP(e.repoPath, S));
    check("*** (F) *** releasedStillBlockedRepoPaths names S and its blocker F", !!blockedEntry && sameP(blockedEntry.blockedByRepoPath, F));
    check("(F) releasedStillBlockedRepoPaths does NOT name the genuinely lifted Q", !hasP(res.releasedStillBlockedRepoPaths, Q));
    check("(F) the entries carry ONLY repoPath + blockedByRepoPath (no tokens/secrets)", (res.releasedStillBlockedRepoPaths ?? []).every((e) => JSON.stringify(Object.keys(e).sort()) === JSON.stringify(["blockedByRepoPath", "repoPath"])));
    check("*** (F) *** alsoReleased (computed over RELEASED, as the REST route does) names S", hasP(mod.alsoReleasedRepoPaths(res.releasedRepoPaths ?? [], [Q]), S));
    check("(F, documents the old gap) alsoReleased over the ADMITTED set alone would have hidden S", !hasP(mod.alsoReleasedRepoPaths(res.liftedRepoPaths, [Q]), S));
  }
  // ---- (F2) provenanceUnknown still fires when the blocked-but-released S is the ONLY unknown-provenance candidate ----
  {
    const { S, Q, booted } = await buildUnionState("f2", { blocked: "primary", provenanceUnknown: true });
    const res = booted.clearMergeQuarantineReporting(Q);
    check("(F2 precondition) S is released-but-blocked and Q is lifted", hasP(res.releasedStillBlockedRepoPaths, S) && hasP(res.liftedRepoPaths, Q) && !hasP(res.liftedRepoPaths, S));
    check("*** (F2) *** provenanceUnknown notice fires (S is the only unknown candidate, and it is NOT admitted)", res.provenanceUnknown === true);
    const clean = await buildUnionState("f2c", { blocked: "primary" });
    const resClean = clean.booted.clearMergeQuarantineReporting(clean.Q);
    check("(F2 negative control) no provenanceUnknown when no candidate was marked", resClean.provenanceUnknown !== true);
  }
  // ---- (G) the contributor Q is the blocked, NON-queried side: clear-broad-union(S) ----
  {
    const { S, Q, F, booted } = await buildUnionState("g", { blocked: "contributor" });
    const dry = booted.clearBroadUnion(S, [], true);
    const res = booted.clearBroadUnion(S, dry.victimPaths ?? [], false);
    check("(G precondition) the broad-union clear ran ok and Q still refuses (F armed at Kq)", res.ok === true && booted.assertRepoNotQuarantined(Q).ok === false);
    check("*** (G) *** broad-union: Q is NOT lifted, S is", !hasP(res.liftedRepoPaths, Q) && hasP(res.liftedRepoPaths, S));
    const e = (res.releasedStillBlockedRepoPaths ?? []).find((x) => sameP(x.repoPath, Q));
    check("*** (G) *** broad-union: releasedStillBlockedRepoPaths names Q and its blocker F", !!e && sameP(e.blockedByRepoPath, F));
  }
  // ---- (H) AGREEMENT/NON-QUERIED shape for /clear-by-path and /clear: contributor C nested under R shares R's key K,
  //          D is armed at K. R (queried) refuses; C (NON-queried) is the candidate only the helper can decide. ----
  async function buildNestedContributorState(tag) {
    const R = makeRepo(`${tag}-r`);
    const C = path.join(R, "sub-c");
    const D = path.join(R, "sub-d");
    fs.mkdirSync(C); fs.mkdirSync(D);
    enterMergeQuarantine(R, `loom/${tag}`, `merge in progress for R (97516691 ${tag})`);
    enterMergeQuarantine(C, `loom/${tag}-c`, `nested contributor C (97516691 ${tag})`);
    const orphan = foldOrphanRefIntoOwnFinal(R);
    const booted = await freshBoot();
    booted.reenterMergeQuarantinesAtBoot([R]);
    fs.writeFileSync(path.join(booted.MERGE_QUARANTINE_DIR, orphan), JSON.stringify({ repoPath: D, branch: "loom/d", reason: `foreign D (${tag})`, enteredAt: Date.now(), tokens: [randomUUID()] }));
    return { R, C, D, booted };
  }
  {
    const { R, C, D, booted } = await buildNestedContributorState("h1");
    const res = booted.clearMergeQuarantineByRecordedPath(R);
    check("(H1 precondition) R and C both still refuse (D armed at K)", booted.assertRepoNotQuarantined(R).ok === false && booted.assertRepoNotQuarantined(C).ok === false);
    check("*** (H1) *** /clear-by-path: the NON-queried C is NOT lifted", !hasP(res.liftedRepoPaths, C));
    const e = (res.releasedStillBlockedRepoPaths ?? []).find((x) => sameP(x.repoPath, C));
    check("*** (H1) *** /clear-by-path: C is named in releasedStillBlockedRepoPaths with blocker D", !!e && sameP(e.blockedByRepoPath, D));
    check("(H1) /clear-by-path: C is in releasedRepoPaths (alsoReleased input)", hasP(res.releasedRepoPaths, C));
  }
  {
    const { R, C, booted } = await buildNestedContributorState("h2");
    const res = booted.clearMergeQuarantineReporting(R);
    check("*** (H2) *** /clear: the NON-queried C is NOT lifted and is disclosed as released-but-blocked", !hasP(res.liftedRepoPaths, C) && hasP(res.releasedStillBlockedRepoPaths, C));
  }
} finally {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
}
console.log(failures === 0 ? "\n✅ ALL PASS — card 97516691" : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
