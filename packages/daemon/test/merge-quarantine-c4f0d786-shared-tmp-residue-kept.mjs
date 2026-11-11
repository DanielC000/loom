import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card c4f0d786 — a PENDING-path clear of one claimant must not unlink a shared corrupt tmp / safety-tmp
// residue that its pending siblings still name as their sourceFile (the `<hash>.json` shape already kept its
// file; the tmp shapes did not, so the siblings were blocked in memory only and a restart armed nobody).
//   A. per shape (tmp, safety-tmp, json+tmp, json+safety-tmp) x claimants (2, 3) x by-path route (clearMergeQuarantine,
//      clearMergeQuarantineByRecordedPath, clearMergeQuarantineReporting): every shared file survives the clear,
//      and a fresh boot (#1) re-arms every claimant; then the siblings are released ONE AT A TIME through the route
//      the clear handed back (its id when it has one, else its repoPath): at every step the files are still on
//      disk and a fresh boot re-arms every sibling that is still blocked in memory; after the LAST release the
//      directory is empty (no leak) and a fresh boot (#2) arms nobody.
//   B. clear-by-id of the shared tmp's id: lifts every claimant and leaves nothing behind.
//   C. (control) a single claimant: its own residue is still unlinked, nothing is kept, a fresh boot arms nobody.
//   D. (write path) a successful latch write still removes its OWN stale tmp when the writer is a dual-tracked twin
//      (active AND pending, the tmp being its sourceFile). Named limit: today the write's own graduation absorbs the
//      twin before the same-hash sweep runs, so this does NOT discriminate the write sites' own-identity exemption
//      (a mutant dropping it stays green); it pins the no-leak outcome only.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-c4f0d786-shared-tmp-residue-kept.mjs
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
useOwnLoomHome("loom-mqc4-");
requireHermeticEnv();

const distGitDir = path.join(__dirname, "..", "dist", "git");
const href = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const { MERGE_QUARANTINE_DIR } = await import(href);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqc4@loom -c user.name=mqc4";
const tmpDirs = [];
const sfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
let moduleCounter = 0;
const freshModule = () => import(`${href}?m=${++moduleCounter}`);

function makeRepo(tag) {
  const y = path.join(os.tmpdir(), `loom-mqc4-${tag}-${sfx()}`);
  fs.mkdirSync(y, { recursive: true });
  tmpDirs.push(y);
  fs.writeFileSync(path.join(y, "README.md"), `# ${tag}\n`);
  execSync("git init -q", { cwd: y });
  commitAll(y, "init", GIT_ID);
  return { y, w: [path.join(y, "a"), path.join(y, "b"), path.join(y, "c")] };
}

function wipeQuarantineDir() {
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  for (const f of fs.readdirSync(MERGE_QUARANTINE_DIR)) fs.rmSync(path.join(MERGE_QUARANTINE_DIR, f), { recursive: true, force: true });
}

const hashOf = (y) => createHash("sha256").update(canonicalRepoLockKey(y)).digest("hex").slice(0, 24);
const base = (p) => path.basename(p);
const listDir = () => fs.readdirSync(MERGE_QUARANTINE_DIR).sort();

// What a fresh boot arms for `paths`. A boot may rewrite/consume latch files, so the directory is snapshotted
// first and restored byte-for-byte afterwards: the caller's own chain then continues on the untouched files.
async function bootArmed(paths) {
  const snap = listDir().map((f) => [f, fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f))]);
  const fresh = await freshModule();
  fresh.reenterMergeQuarantinesAtBoot(paths);
  const armed = paths.filter((p) => !!fresh.activeMergeQuarantineFor(p)).map(base).sort();
  wipeQuarantineDir();
  for (const [f, bytes] of snap) fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, f), bytes);
  return armed;
}

const SHAPES = [
  ["tmp", (h) => [`${h}.json.tmp-4242-ab12`]],
  ["safety-tmp", (h) => [`${h}.json.tmp-safety-4242-ab12cd34`]],
  ["json+tmp", (h) => [`${h}.json`, `${h}.json.tmp-4242-ab12`]],
  ["json+safety-tmp", (h) => [`${h}.json`, `${h}.json.tmp-safety-4242-ab12cd34`]],
];
const ROUTES = ["clearMergeQuarantine", "clearMergeQuarantineByRecordedPath", "clearMergeQuarantineReporting"];

try {
  // ---- A: every shape x claimant count x by-path route ------------------------------------------------------------
  for (const [kind, fileNames] of SHAPES) {
    for (const claimants of [2, 3]) {
      for (const route of ROUTES) {
        const label = `[${kind} x${claimants} ${route}]`;
        const { y, w } = makeRepo(`${kind}-${claimants}-${route}`);
        wipeQuarantineDir();
        const names = fileNames(hashOf(y));
        for (const f of names) fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, f), "{");
        const paths = w.slice(0, claimants);
        const mq = await freshModule();
        mq.reenterMergeQuarantinesAtBoot(paths); // every claimant PENDING
        check(`${label} (precondition) every claimant is pending-blocked`, paths.every((p) => !!mq.activeMergeQuarantineFor(p)));
        const res = mq[route](paths[0]);
        const co = new Map((res.stillBlockedCoOccupants ?? []).map((c) => [c.repoPath, c.route]));
        check(`${label} (precondition) w1 was lifted`, (res.liftedRepoPaths ?? []).includes(paths[0]));
        check(`${label} *** c4f0d786 *** every shared file survives the clear`, JSON.stringify(listDir()) === JSON.stringify([...names].sort()));
        const armed1 = await bootArmed(paths);
        check(`${label} *** c4f0d786 *** boot #1 re-arms EVERY claimant (nothing lost across a restart)`, JSON.stringify(armed1) === JSON.stringify(paths.map(base).sort()));
        check(`${label} the siblings are still blocked in this process and named by the result`, paths.slice(1).every((p) => !!mq.activeMergeQuarantineFor(p) && co.has(p)));
        // Release the siblings one at a time through the route the result handed back.
        const routes = co;
        let step = 0;
        let blocked = paths.slice(1).filter((p) => !!mq.activeMergeQuarantineFor(p));
        while (blocked.length > 0 && step++ < 6) {
          const target = blocked[0];
          const rt = routes.get(target) ?? { repoPath: target };
          // a route.id the result offers must actually release the claimant (asserted just below); json+safety-tmp
          // offers none (an id clearing only one of its two pending files would not), so it falls back to the repoPath.
          const r2 = rt.id !== undefined ? mq.clearMergeQuarantineLatchFile(rt.id) : mq[route](target);
          check(`${label} (step ${step}) following ${rt.id !== undefined ? "the id" : "the repoPath"} route RELEASES ${base(target)}`, !mq.activeMergeQuarantineFor(target) && ((r2.liftedRepoPaths ?? []).includes(target) || (r2.releasedRepoPaths ?? []).includes(target)));
          for (const c of r2.stillBlockedCoOccupants ?? []) routes.set(c.repoPath, c.route);
          blocked = paths.slice(1).filter((p) => !!mq.activeMergeQuarantineFor(p));
          if (blocked.length > 0) {
            check(`${label} (step ${step}) files still on disk while a claimant is blocked`, listDir().length === names.length);
            const armedMid = await bootArmed(paths);
            check(`${label} (step ${step}) *** c4f0d786 *** a fresh boot still re-arms every claimant that is blocked in memory`, blocked.every((p) => armedMid.includes(base(p))));
          }
        }
        check(`${label} *** c4f0d786 *** after the LAST release the directory is empty (no leak)`, listDir().length === 0);
        const armed2 = await bootArmed(paths);
        check(`${label} boot #2 arms nobody`, armed2.length === 0);
      }
    }
  }

  // ---- B2 (round 2): clear-by-id of ONE file's id on json+safety-tmp. Every claimant has TWO pending entries (one per
  // file, two ids); the by-id clear removes only the entries of the id it matched, so the OTHER file is still named
  // by the same identities' surviving entries and must stay on disk (an identity-level exemption deleted it).
  for (const claimants of [2, 3]) {
    for (const which of ["json-id", "safety-id"]) {
      const label = `[by-id json+safety-tmp x${claimants} ${which}]`;
      const { y, w } = makeRepo(`byid2-${claimants}-${which}`);
      wipeQuarantineDir();
      const h = hashOf(y);
      const safety = `${h}.json.tmp-safety-4242-ab12cd34`;
      fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${h}.json`), "{");
      fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, safety), "{");
      const paths = w.slice(0, claimants);
      const mq = await freshModule();
      mq.reenterMergeQuarantinesAtBoot(paths);
      const id = which === "json-id" ? h : createHash("sha256").update(safety).digest("hex").slice(0, 24);
      const survivor = which === "json-id" ? safety : `${h}.json`;
      const res = mq.clearMergeQuarantineLatchFile(id);
      console.log(`INFO  ${label} dir=${JSON.stringify(listDir())} lifted=${(res.liftedRepoPaths ?? []).map(base)} reason=${(res.reason ?? "").slice(0, 100)}`);
      check(`${label} (precondition) the id matched something`, res.wasQuarantined === true);
      check(`${label} *** c4f0d786 *** the OTHER file survives on disk (the surviving pending entries still name it)`, listDir().includes(survivor));
      const blocked = paths.filter((p) => !!mq.activeMergeQuarantineFor(p));
      const armed = await bootArmed(paths);
      check(`${label} *** c4f0d786 *** a fresh boot re-arms EVERY claimant still blocked in memory (${blocked.length})`, blocked.length > 0 && blocked.every((p) => armed.includes(base(p))));
      check(`${label} the result never claims a removal / "IN THIS PROCESS ONLY"`, !/removed from disk|IN THIS PROCESS ONLY/.test(res.reason ?? ""));
      // release the rest by repoPath: nothing may be left behind
      for (const p of blocked) mq.clearMergeQuarantine(p);
      check(`${label} after releasing the rest the directory is empty (no leak) and nobody re-arms`, listDir().length === 0 && (await bootArmed(paths)).length === 0);
    }
  }

  // ---- B: clear-by-id of the shared tmp's id lifts everyone and leaves nothing behind ----------------------------
  {
    const { y, w } = makeRepo("byid");
    wipeQuarantineDir();
    const h = hashOf(y);
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${h}.json.tmp-4242-ab12`), "{");
    const mq = await freshModule();
    mq.reenterMergeQuarantinesAtBoot(w);
    const r = mq.clearMergeQuarantineLatchFile(h);
    check("[by-id tmp] every claimant lifted", w.every((p) => !mq.activeMergeQuarantineFor(p)) && w.every((p) => (r.liftedRepoPaths ?? []).includes(p)));
    check("[by-id tmp] the directory is empty and a fresh boot arms nobody", listDir().length === 0 && (await bootArmed(w)).length === 0);
  }

  // ---- C: single-claimant control — unchanged: its own residue is unlinked ---------------------------------------
  for (const [kind, fileNames] of SHAPES.slice(0, 2)) {
    for (const route of ROUTES) {
      const label = `[control ${kind} single ${route}]`;
      const { y, w } = makeRepo(`ctl-${kind}-${route}`);
      wipeQuarantineDir();
      for (const f of fileNames(hashOf(y))) fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, f), "{");
      const mq = await freshModule();
      mq.reenterMergeQuarantinesAtBoot([w[0]]);
      const res = mq[route](w[0]);
      check(`${label} lifted, the residue is unlinked, nothing kept`, (res.liftedRepoPaths ?? []).includes(w[0]) && listDir().length === 0 && res.latchKept !== true && !mq.activeMergeQuarantineFor(w[0]));
      check(`${label} a fresh boot arms nobody`, (await bootArmed([w[0]])).length === 0);
    }
  }

  // ---- D: write path — a successful write still removes its own stale tmp (no LEAK) ------------------------------
  {
    const { y } = makeRepo("write");
    wipeQuarantineDir();
    const mq = await freshModule();
    const key = canonicalRepoLockKey(y);
    const h = hashOf(y);
    const t1 = "tok-c4f0d786-write-t1";
    const tmpName = `${h}.json.tmp-4242-ab12`;
    const tmpPath = path.join(MERGE_QUARANTINE_DIR, tmpName);
    // a dual-tracked twin (883e29bc): ONE entry that is both ACTIVE at its key and PENDING with the tmp as its sourceFile
    const live = { repoPath: y, branch: "loom/b1", reason: "live, boot-armed from a tmp", enteredAt: Date.now() - 1000, tokens: [t1], armedKeys: [key] };
    fs.writeFileSync(tmpPath, JSON.stringify(live, null, 2) + "\n");
    mq.setActiveQuarantineTestOnly(key, live);
    mq.pushPendingQuarantineTestOnly(live, tmpName);
    check("[write] (precondition) the stale tmp exists before the write", fs.existsSync(tmpPath));
    mq.enterMergeQuarantine(y, "loom/b2", "second raise (a superset write)");
    check("[write] *** c4f0d786 (no-leak) *** a successful latch write still removes its OWN stale tmp", !fs.existsSync(tmpPath));
    check("[write] the live final latch is still on disk", fs.existsSync(path.join(MERGE_QUARANTINE_DIR, `${h}.json`)));
  }

  // ---- E (round 3): the trailing tmp sweep must not un-own a same-identity pending entry that STAYS pending ---------
  // Shape: active A{t} at the repo's key + a stranded tmp T beside it, and a same-identity pending Q (other tokens)
  // whose sourceFile IS T. clearMergeQuarantine(repo) lifts A but does not tie Q: Q stays blocked in memory, so T
  // (Q's only durable backing) must stay on disk, a fresh boot must re-arm Q, and releasing Q must empty the dir.
  for (const content of ["readable", "corrupt"]) {
    const label = `[E untied same-identity P2, tmp ${content}]`;
    const { y } = makeRepo(`e-${content}`);
    wipeQuarantineDir();
    const mq = await freshModule();
    const t = mq.enterMergeQuarantine(y, "loom/b", "W active");
    const h = hashOf(y);
    const tmpName = `${h}.json.tmp-77777-abc123`;
    const tmpPath = path.join(MERGE_QUARANTINE_DIR, tmpName);
    const qTokens = ["tok-c4f0d786-q"];
    fs.writeFileSync(tmpPath, content === "corrupt" ? "{" : JSON.stringify({ repoPath: y, branch: "q", reason: "Q's own record", enteredAt: Date.now(), tokens: qTokens }, null, 2) + "\n");
    mq.pushPendingQuarantineTestOnly({ repoPath: y, branch: "q", reason: "Q sourced from the tmp", enteredAt: Date.now(), tokens: qTokens }, tmpName);
    const res = mq.clearMergeQuarantine(y);
    // read the file BEFORE any activeMergeQuarantineFor call: that lookup lazily graduates a resolvable pending entry
    // and unlinks its source, which would mask what the clear itself did to the tmp.
    const tmpAfterClear = fs.existsSync(tmpPath);
    console.log(`INFO  ${label} lifted=${(res.liftedRepoPaths ?? []).length} tmp=${tmpAfterClear} t=${t.slice(0, 6)}`);
    check(`${label} *** c4f0d786 *** the tmp (Q's only durable backing) survives the clear`, tmpAfterClear);
    check(`${label} (precondition) Q keeps the repo blocked in memory after the clear`, !!mq.activeMergeQuarantineFor(y));
    const armed = await bootArmed([y]);
    check(`${label} *** c4f0d786 *** a fresh boot re-arms the repo`, armed.length === 1);
    mq.clearMergeQuarantineByRecordedPath(y);
    check(`${label} releasing Q (identity-wide human clear) empties the directory (no leak) and nothing re-arms`, listDir().filter((f) => f.startsWith(h)).length === 0 && (await bootArmed([y])).length === 0);
  }

  // E2: the token route — a surviving untied same-identity P2 keeps its tmp (clearTokenFromPendingIndices remove branch)
  {
    const label = "[E token route, untied P2]";
    const { y } = makeRepo("e-token");
    wipeQuarantineDir();
    const mq = await freshModule();
    const h = hashOf(y);
    const s = "tok-c4f0d786-tr-s";
    const liveSource = `${h}.json`;
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, liveSource), JSON.stringify({ repoPath: y, branch: "b", reason: "live pending", enteredAt: Date.now() - 2000, tokens: [s] }, null, 2) + "\n");
    mq.pushPendingQuarantineTestOnly({ repoPath: y, branch: "b", reason: "live pending", enteredAt: Date.now() - 2000, tokens: [s] }, liveSource);
    const tmpName = `${h}.json.tmp-77777-abc123`;
    const tmpPath = path.join(MERGE_QUARANTINE_DIR, tmpName);
    fs.writeFileSync(tmpPath, JSON.stringify({ repoPath: y, branch: "p2", reason: "P2's own record", enteredAt: Date.now(), tokens: ["tok-c4f0d786-p2"] }, null, 2) + "\n");
    mq.pushPendingQuarantineTestOnly({ repoPath: y, branch: "p2", reason: "P2 sourced from the tmp", enteredAt: Date.now(), tokens: ["tok-c4f0d786-p2"] }, tmpName);
    mq.clearMergeQuarantineByToken(y, s);
    check(`${label} *** c4f0d786 *** the surviving untied P2 keeps its tmp on disk`, fs.existsSync(tmpPath));
    check(`${label} a fresh boot still re-arms the repo (P2 not lost)`, (await bootArmed([y])).length === 1);
  }

  // E3 (round 4): the REAL "unreduced" / freshIsForeign path. y is a SUBDIR of repo R, so canonicalRepoLockKey(y) (R's key)
  // differs from directPathIdentity(y); a FOREIGN entry is armed at that fresh key and y has its own active entry at its
  // direct identity. clearMergeQuarantine(y) then takes freshIsForeign -> pendingSweep "unreduced" -> ByKey(directIdentity).
  // Variant "removed": Q (pending, sourced from a tmp under hash(directIdentity)) is untouched by the active loop, so the
  // body's own pending pass REMOVES it and its tmp: nothing may then claim the file is kept or name y with a dead id.
  // Variant "survives": Q is tied via y's armed key with tokens left over, so the active loop REDUCES it and it STAYS
  // pending: the tmp must be kept, the disclosure must be truthful (every offered id maps to a file), and a boot re-arms.
  for (const variant of ["removed", "survives"]) {
    const label = `[E3 unreduced ${variant}]`;
    const base0 = makeRepo(`e3-${variant}`).y;
    const y = path.join(base0, "sub");
    fs.mkdirSync(y, { recursive: true });
    const other = makeRepo(`e3-${variant}-foreign`).y;
    wipeQuarantineDir();
    const mq = await freshModule();
    const freshKey = canonicalRepoLockKey(y);
    const id = mq.directPathIdentity(y);
    check(`${label} (precondition) freshKey differs from y's direct identity (the freshIsForeign shape)`, freshKey !== id);
    const hId = createHash("sha256").update(id).digest("hex").slice(0, 24);
    const tmpName = `${hId}.json.tmp-77777-abc123`;
    const tmpPath = path.join(MERGE_QUARANTINE_DIR, tmpName);
    fs.writeFileSync(tmpPath, JSON.stringify({ repoPath: y, branch: "q", reason: "Q's own record", enteredAt: Date.now(), tokens: ["tq"] }, null, 2) + "\n");
    mq.setActiveQuarantineTestOnly(freshKey, { repoPath: other, branch: "f", reason: "foreign occupant of the fresh key", enteredAt: Date.now(), tokens: ["tf"], armedKeys: [freshKey] });
    mq.setActiveQuarantineTestOnly(id, { repoPath: y, branch: "a", reason: "y's own active entry", enteredAt: Date.now(), tokens: ["ta"], armedKeys: [id] });
    mq.pushPendingQuarantineTestOnly({ repoPath: y, branch: "q", reason: "Q sourced from the tmp", enteredAt: Date.now(), tokens: ["tq"], ...(variant === "survives" ? { armedKeys: [id] } : {}) }, tmpName);
    const res = mq.clearMergeQuarantine(y);
    const tmpAfter = fs.existsSync(tmpPath);
    const pendingAfter = mq.listPendingMergeQuarantinesTestOnly().filter((p) => p.sourceFile === tmpName).length;
    const cos = res.stillBlockedCoOccupants ?? [];
    console.log(`INFO  ${label} latchKept=${res.latchKept} cos=${cos.length} tmp=${tmpAfter} pending=${pendingAfter} stillQuarantined=${res.stillQuarantined}`);
    check(`${label} *** the freshIsForeign branch was taken (the result is the foreign-host still-quarantined shape)`, res.stillQuarantined === true && /reduced under another/.test(res.reason ?? ""));
    if (variant === "removed") {
      check(`${label} *** c4f0d786 round 4 *** Q and its tmp are gone (nothing names the file any more)`, pendingAfter === 0 && !tmpAfter && listDir().length === 0);
      check(`${label} *** c4f0d786 round 4 *** no false disclosure: no latchKept, no referencingRepoPaths, no co-occupant naming y`, res.latchKept !== true && (res.referencingRepoPaths ?? []).length === 0 && !cos.some((c) => mq.directPathIdentity(c.repoPath) === id));
    } else {
      check(`${label} *** c4f0d786 *** the surviving pending entry keeps its tmp on disk`, pendingAfter === 1 && tmpAfter);
      // 613e4592 round 4: the foreign host at y's fresh key still blocks y after ANY clear of y's own entry, so no id is offered for y; y is oracle-blocked by its
      // own entry, so it stays a LIVE co-occupant with its id-less {repoPath} route AND names the host as its blocker (was: y named with the shared bare-hash id).
      check(`${label} the disclosure is concrete: latchKept, y a live co-occupant (id-less {repoPath} route) with the foreign host as its blocker, not content-kept`, res.latchKept === true && !(res.contentKeptRepoPaths ?? []).includes(y) && (res.contentKeptBlockedBy ?? []).some((e) => e.repoPath === y && e.blockedBy.repoPath === other) && cos.some((c) => mq.directPathIdentity(c.repoPath) === id && c.route.id === undefined && c.alsoClear?.id === undefined));
      const livePending = mq.listPendingMergeQuarantinesTestOnly();
      check(`${label} the disclosure is truthful: y's surviving pending entry is still held IN MEMORY under the tmp, and the file exists`, livePending.some((p) => mq.directPathIdentity(p.repoPath) === id && p.sourceFile === tmpName) && listDir().includes(tmpName));
      check(`${label} a fresh boot re-arms y from the surviving tmp`, (await bootArmed([y])).length === 1);
    }
  }

  // E3 "three" (round 5): the reviewer's shape — y's own Q is removed, but two OTHER identities (unresolvable z1 on the SAME
  // tmp, z2 on a sibling tmp of the same hash) stay pending. The bare-hash id still maps to files on disk, so a disk test
  // would wrongly keep y; the answer must come from memory: y is dropped, z1 and z2 are named with ids they can follow.
  {
    const label = "[E3 unreduced three]";
    const base0 = makeRepo("e3-three").y;
    const y = path.join(base0, "sub");
    fs.mkdirSync(y, { recursive: true });
    const other = makeRepo("e3-three-foreign").y;
    const z1 = path.join(os.tmpdir(), `loom-mqc4-gone-z1-${sfx()}`);
    const z2 = path.join(os.tmpdir(), `loom-mqc4-gone-z2-${sfx()}`);
    wipeQuarantineDir();
    const mq = await freshModule();
    const freshKey = canonicalRepoLockKey(y);
    const id = mq.directPathIdentity(y);
    const hId = createHash("sha256").update(id).digest("hex").slice(0, 24);
    const tA = `${hId}.json.tmp-77777-abc123`;
    const tB = `${hId}.json.tmp-88888-def456`;
    const rec = (rp, b, t) => ({ repoPath: rp, branch: b, reason: b, enteredAt: Date.now(), tokens: t });
    const wr = (n, o) => fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, n), JSON.stringify(o, null, 2) + "\n");
    mq.setActiveQuarantineTestOnly(freshKey, { ...rec(other, "f", ["tf"]), armedKeys: [freshKey] });
    mq.setActiveQuarantineTestOnly(id, { ...rec(y, "a", ["ta"]), armedKeys: [id] });
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, tA), "{"); // a shared CORRUPT tmp: a boot fans it out to every candidate path
    mq.pushPendingQuarantineTestOnly(rec(y, "q", ["tq"]), tA);
    mq.pushPendingQuarantineTestOnly(rec(z1, "z1", ["tz1"]), tA);
    wr(tB, rec(z2, "z2", ["tz2"]));
    mq.pushPendingQuarantineTestOnly(rec(z2, "z2", ["tz2"]), tB);
    const res = mq.clearMergeQuarantine(y);
    const cos = res.stillBlockedCoOccupants ?? [];
    const names = new Set(cos.map((c) => c.repoPath));
    console.log(`INFO  ${label} latchKept=${res.latchKept} refs=${(res.referencingRepoPaths ?? []).length} cos=${cos.map((c) => path.basename(c.repoPath) + ":" + c.route.id)} dir=${JSON.stringify(listDir())}`);
    check(`${label} (precondition) the freshIsForeign branch was taken`, res.stillQuarantined === true && /reduced under another/.test(res.reason ?? ""));
    check(`${label} *** c4f0d786 round 5 *** y is NOT named (its Q was removed), and neither in referencingRepoPaths`, !names.has(y) && !(res.referencingRepoPaths ?? []).includes(y));
    check(`${label} z1 and z2 are both named`, names.has(z1) && names.has(z2));
    const co1 = cos.find((c) => c.repoPath === z1);
    check(`${label} z1's route id is the shared bare hash, backed in memory by z1's own pending entry on that tmp`, co1.route.id === hId && mq.listPendingMergeQuarantinesTestOnly().some((p) => p.repoPath === z1 && p.sourceFile === tA));
    check(`${label} a fresh boot re-arms z1 and z2`, (await bootArmed([z1, z2])).length === 2);
    const r1 = mq.clearMergeQuarantineLatchFile(co1.route.id);
    check(`${label} following z1's route id lifts z1 (it acts on z1, not on another identity)`, (r1.liftedRepoPaths ?? []).includes(z1));
  }

  // ---- H (round 6): a live owner whose file is on disk is kept by BOTH routes, which agree on one state ---------------
  // Active E is armed at a FAKE key K1, but its fresh write target `<hash(K2)>.json` is Y's pending sourceFile holding Y's
  // content, so physicalOwnerRepoPaths counts E as that file's owner. clearing Y (ByRecordedPath and clearMergeQuarantine,
  // each on its own fresh state) must disclose E as the kept file's owner (latchKept + contentKeptRepoPaths; E is NOT blocked
  // per the in-memory oracle, so it is not a blocked co-occupant, 613e4592), leave the file, and
  // a boot re-arms Y. An id-keyed re-check (E's armed-key ids never contain this file's id) used to drop E.
  // HONEST SCOPE: H pins parity between the two routes and guards against the round-5 id predicate. It does NOT discriminate
  // the round-6 delegated-keep branch, because E is re-kept by the body's own pending pass after the removals. The test that
  // pins a delegated keep SURVIVING that branch is "[E3 unreduced survives]".
  {
    const outcomes = {};
    for (const route of ["clearMergeQuarantineByRecordedPath", "clearMergeQuarantine"]) {
      const label = `[H fresh-write-target owner ${route}]`;
      const E = makeRepo(`h-e-${route}`).y;
      const Y = makeRepo(`h-y-${route}`).y;
      wipeQuarantineDir();
      const mq = await freshModule();
      const K2 = canonicalRepoLockKey(E);
      const f = `${createHash("sha256").update(K2).digest("hex").slice(0, 24)}.json`;
      const rec = (rp, b, t) => ({ repoPath: rp, branch: b, reason: b, enteredAt: Date.now(), tokens: t });
      mq.setActiveQuarantineTestOnly("fakeK1-c4f0d786", { ...rec(E, "e", ["te"]), armedKeys: ["fakeK1-c4f0d786"] });
      fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, f), JSON.stringify(rec(Y, "y", ["ty"]), null, 2) + "\n");
      mq.pushPendingQuarantineTestOnly(rec(Y, "y", ["ty"]), f);
      const res = mq[route](Y);
      const cos = res.stillBlockedCoOccupants ?? [];
      const nm = (p) => (p === E ? "E" : p === Y ? "Y" : path.basename(p));
      outcomes[route] = { latchKept: res.latchKept === true, refs: (res.referencingRepoPaths ?? []).map(nm).sort().join(","), kept: (res.contentKeptRepoPaths ?? []).map(nm).sort().join(","), named: cos.map((c) => nm(c.repoPath)).sort().join(",") };
      console.log(`INFO  ${label} ${JSON.stringify(outcomes[route])}`);
      // 613e4592: a "still blocked" list names ONLY what the in-memory oracle (stillBlockedEntryFor / assertRepoNotQuarantined) says is blocked. E's active entry sits at a
      // stale key, so the oracle says E is NOT blocked (asserted below): E is disclosed as the kept file's owner (latchKept + contentKeptRepoPaths), never as a blocked co-occupant with a route.
      check(`${label} E is NOT blocked per the in-memory oracle`, !mq.stillBlockedEntryFor(E) && mq.assertRepoNotQuarantined(E).ok === true);
      check(`${label} *** 613e4592 *** E (the kept file's owner) is disclosed as content-kept (latchKept) and is NOT in stillBlockedCoOccupants or referencingRepoPaths`, res.latchKept === true && (res.contentKeptRepoPaths ?? []).includes(E) && !(res.referencingRepoPaths ?? []).includes(E) && !cos.some((c) => c.repoPath === E));
      check(`${label} the file stays on disk and Y was lifted`, listDir().includes(f) && (res.liftedRepoPaths ?? []).includes(Y));
      if (route === "clearMergeQuarantineByRecordedPath") check(`${label} the reason says the file was kept rather than destroyed and will re-divert`, /kept rather than destroyed/.test(res.reason ?? "") && /re-divert/.test(res.reason ?? ""));
      check(`${label} a fresh boot re-arms Y from the file`, (await bootArmed([Y])).length === 1);
    }
    check("[H] PARITY: both routes report the same kept state for the same shape (latchKept, referencers, named co-occupants)", JSON.stringify(outcomes.clearMergeQuarantineByRecordedPath) === JSON.stringify(outcomes.clearMergeQuarantine));
  }

  // ---- I (round 6): sibling-file shape — y's REDUCED entry survives on tmp-B while the kept residue was tmp-A -------------
  // Whatever the result names must be true: if y is named, y really has a live entry.
  {
    const label = "[I sibling file]";
    const base0 = makeRepo("i-sib").y;
    const y = path.join(base0, "sub");
    fs.mkdirSync(y, { recursive: true });
    const other = makeRepo("i-sib-foreign").y;
    const z1 = path.join(os.tmpdir(), `loom-mqc4-gone-iz1-${sfx()}`);
    wipeQuarantineDir();
    const mq = await freshModule();
    const freshKey = canonicalRepoLockKey(y);
    const id = mq.directPathIdentity(y);
    const hId = createHash("sha256").update(id).digest("hex").slice(0, 24);
    const tA = `${hId}.json.tmp-77777-abc123`;
    const tB = `${hId}.json.tmp-88888-def456`;
    const rec = (rp, b, t) => ({ repoPath: rp, branch: b, reason: b, enteredAt: Date.now(), tokens: t });
    mq.setActiveQuarantineTestOnly(freshKey, { ...rec(other, "f", ["tf"]), armedKeys: [freshKey] });
    mq.setActiveQuarantineTestOnly(id, { ...rec(y, "a", ["ta"]), armedKeys: [id] });
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, tA), "{");
    mq.pushPendingQuarantineTestOnly(rec(y, "q", ["tq"]), tA);
    mq.pushPendingQuarantineTestOnly(rec(z1, "z1", ["tz1"]), tA);
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, tB), JSON.stringify(rec(y, "q2", ["tq2"]), null, 2) + "\n");
    mq.pushPendingQuarantineTestOnly({ ...rec(y, "q2", ["tq2"]), armedKeys: [id] }, tB); // tied via y's key with tokens left over -> REDUCED, stays pending
    const res = mq.clearMergeQuarantine(y);
    const cos = res.stillBlockedCoOccupants ?? [];
    const pend = mq.listPendingMergeQuarantinesTestOnly();
    const yPendingOnB = pend.some((p) => mq.directPathIdentity(p.repoPath) === id && p.sourceFile === tB);
    console.log(`INFO  ${label} cos=${cos.map((c) => path.basename(c.repoPath))} yOnB=${yPendingOnB} dir=${JSON.stringify(listDir())}`);
    check(`${label} (precondition) y's reduced entry survives on tmp-B and z1 keeps tmp-A`, yPendingOnB && pend.some((p) => p.repoPath === z1 && p.sourceFile === tA) && listDir().includes(tA) && listDir().includes(tB));
    check(`${label} z1 is named (it owns tmp-A)`, cos.some((c) => c.repoPath === z1));
    check(`${label} *** whatever names y is true: y is named only because its own entry on tmp-B is live`, !cos.some((c) => mq.directPathIdentity(c.repoPath) === id) || yPendingOnB);
  }

  // ---- G (round 5): ByKey's plan-"remove" half of the trailing sweep's exemption decides the durable tombstone ---------
  // Active at the repo's key with tokens [ta, tq]; pending Q {tq} sourced from a tmp under the same hash. Q is TIED (its tokens
  // are a subset), so ByKey's pendingPlan marks it "remove" and the trailing sweep must not count it as a keeper: otherwise the
  // early keep feeds ByKey's nonFailureOk and the durable cleared-tokens tombstone is never written.
  for (const armed of [false, true]) {
    const label = `[G plan-remove ${armed ? "armedKeys" : "no armedKeys"}]`;
    const { y } = makeRepo(`g-${armed}`);
    wipeQuarantineDir();
    const mq = await freshModule();
    const key = canonicalRepoLockKey(y);
    const h = hashOf(y);
    const ta = `tok-g-${armed}-ta`;
    const tq = `tok-g-${armed}-tq`;
    const tmpName = `${h}.json.tmp-77777-abc123`;
    const rec = (b, t) => ({ repoPath: y, branch: b, reason: b, enteredAt: Date.now(), tokens: t });
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, tmpName), JSON.stringify(rec("q", [tq]), null, 2) + "\n");
    mq.setActiveQuarantineTestOnly(key, { ...rec("a", [ta, tq]), armedKeys: [key] });
    mq.pushPendingQuarantineTestOnly({ ...rec("q", [tq]), ...(armed ? { armedKeys: [key] } : {}) }, tmpName);
    mq.clearMergeQuarantine(y);
    const sidecar = path.join(process.env.LOOM_HOME, "merge-quarantine-cleared-tokens.dat");
    const tomb = fs.existsSync(sidecar) ? JSON.parse(fs.readFileSync(sidecar, "utf8")) : {};
    check(`${label} *** c4f0d786 round 5 *** the tied pending entry's tmp is gone and the durable tombstone covers its token`, !fs.existsSync(path.join(MERGE_QUARANTINE_DIR, tmpName)) && tomb[tq] !== undefined);
  }

  // ---- F (round 3): the TWO-step (route + alsoClear) id check counts EVERY id handed out -----------------------------
  {
    const x = path.join(os.tmpdir(), `loom-mqc4-both-x-${sfx()}`);
    const names = ["a1".repeat(12) + ".json", "b2".repeat(12) + ".json", "c3".repeat(12) + ".json"];
    const mkEntry = (n) => ({ repoPath: x, branch: "b", reason: `x via ${n}`, enteredAt: Date.now(), tokens: [`tok-${n}`] });
    {
      const mq = await freshModule();
      mq.pushPendingQuarantineTestOnly(mkEntry(names[0]), names[0]);
      mq.pushPendingQuarantineTestOnly(mkEntry(names[1]), names[1]);
      const co = mq.blockedCoOccupantBothRoutesTestOnly(x, names[0], names[1]);
      check("[F 2 pending] control: the two ids (route + alsoClear) cover every pending entry, so both are handed out", co.route.id === names[0].slice(0, 24) && co.alsoClear?.id === names[1].slice(0, 24));
    }
    {
      const mq = await freshModule();
      for (const n of names) mq.pushPendingQuarantineTestOnly(mkEntry(n), n);
      const co = mq.blockedCoOccupantBothRoutesTestOnly(x, names[0], names[1]);
      check("[F 3 pending] *** c4f0d786 *** route + alsoClear still leave a third pending entry: the result is the plain {repoPath} route", co.route.id === undefined && co.alsoClear === undefined && co.route.repoPath === x);
    }
  }
} finally {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
