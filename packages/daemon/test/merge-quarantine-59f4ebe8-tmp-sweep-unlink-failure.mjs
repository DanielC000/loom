import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 59f4ebe8 — SITE 1: `sweepTmpResidueForHashIfUnreferenced`'s same-hash loop silently swallowed a
// non-ENOENT unlink failure of a tmp residue judged safe to delete (never `keptUnreadableLatchFiles`-marked):
// no log, no `anyUnattributed`, no write-failure signal. The clear reported success (`anyWriteFailed:false`)
// while the residue survived and re-armed the whole quarantine at the next boot.
//
// Pins, per shape (each with a NO-FAULT control proving the fixture reaches the delete):
//   (identity)  clearMergeQuarantine — result says anyWriteFailed + latchKept, residue kept, NO durable tombstone.
//   (token)     clearMergeQuarantineByToken over both tokens — neither is durably tombstoned.
//   (tracked)   a same-identity pending entry whose sourceFile IS the residue (the decide-time disk scan is
//               BLIND to a tracked basename) — before this card the token was durably tombstoned while the
//               residue still held it; now the write-failure signal alone withholds it.
// Run: 1) pnpm build, 2) node test/merge-quarantine-59f4ebe8-tmp-sweep-unlink-failure.mjs
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

const loomHome = useOwnLoomHome("loom-mq59f4-t-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mqHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const mod = await import(mqHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);
const { enterMergeQuarantine, clearMergeQuarantine, clearMergeQuarantineByToken, assertRepoNotQuarantined, pushPendingQuarantineTestOnly, MERGE_QUARANTINE_DIR } = mod;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mq59f4@loom -c user.name=mq59f4";
let bootCounter = 0;
const freshBoot = async () => await import(`${mqHref}?b=${++bootCounter}`);

function makeRepo(tag) {
  const repo = mkdtempManaged(`loom-mq59f4-${tag}-`);
  fs.writeFileSync(path.join(repo, "README.md"), `# ${tag}\n`);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "mq59f4@loom"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "mq59f4"], { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}
const hashFor = (key) => createHash("sha256").update(key).digest("hex").slice(0, 24);
function plantTmp(repo, tokens, suffix) {
  const name = `${hashFor(canonicalRepoLockKey(repo))}.json.tmp-${suffix}`;
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, name), JSON.stringify({ repoPath: repo, branch: "b", reason: "stranded tmp", enteredAt: Date.now() - 1000, tokens }, null, 2) + "\n");
  return name;
}
// Faults every unlink of exactly `target` with an EPERM (when `armed`), counting hits.
function injectUnlinkFault(target, armed) {
  const real = fs.unlinkSync;
  let hits = 0;
  fs.unlinkSync = (p, ...rest) => {
    if (armed && p === target) { hits++; throw Object.assign(new Error("EPERM: simulated unlink failure"), { code: "EPERM" }); }
    return real(p, ...rest);
  };
  return { restore: () => { fs.unlinkSync = real; }, hits: () => hits };
}
const sidecarPath = path.join(loomHome, "merge-quarantine-cleared-tokens.dat");
const tombstoned = (tok) => fs.existsSync(sidecarPath) && JSON.parse(fs.readFileSync(sidecarPath, "utf8"))[tok] !== undefined;

try {
  for (const faulted of [false, true]) {
    const tag = faulted ? "FAULT" : "control";
    // ── (identity) ────────────────────────────────────────────────────────────────────────────────────
    {
      const r = makeRepo(`id-${tag}`);
      const t1 = enterMergeQuarantine(r, "b1", "first");
      const t2 = enterMergeQuarantine(r, "b2", "second");
      const name = plantTmp(r, [t1, t2], "88881-cafed001");
      const tmpPath = path.join(MERGE_QUARANTINE_DIR, name);
      const inj = injectUnlinkFault(tmpPath, faulted);
      let res;
      try { res = clearMergeQuarantine(r); } finally { inj.restore(); }
      if (faulted) {
        check(`(identity ${tag}) precondition: the residue's unlink was forced to fail`, inj.hits() >= 1);
        check(`(identity ${tag}) *** THE FIX *** the clear reports anyWriteFailed`, res.anyWriteFailed === true);
        check(`(identity ${tag}) ...and latchKept (it kept something, nameless)`, res.latchKept === true);
        check(`(identity ${tag}) the residue still exists`, fs.existsSync(tmpPath));
        check(`(identity ${tag}) neither token is durably tombstoned`, !tombstoned(t1) && !tombstoned(t2));
        const boot = await freshBoot();
        boot.reenterMergeQuarantinesAtBoot([r]);
        check(`(identity ${tag}) fail-closed: a fresh boot re-arms from the surviving residue`, boot.assertRepoNotQuarantined(r).ok === false);
      } else {
        check(`(identity ${tag}) control: no write failure reported`, res.anyWriteFailed !== true);
        check(`(identity ${tag}) control: the residue is deleted`, !fs.existsSync(tmpPath));
        check(`(identity ${tag}) control: tokens durably tombstoned`, tombstoned(t1) && tombstoned(t2));
        const boot = await freshBoot();
        boot.reenterMergeQuarantinesAtBoot([r]);
        check(`(identity ${tag}) control: a fresh boot leaves the repo unblocked`, boot.assertRepoNotQuarantined(r).ok === true);
      }
    }
    // ── (token) ───────────────────────────────────────────────────────────────────────────────────────
    {
      const r = makeRepo(`tok-${tag}`);
      const t1 = enterMergeQuarantine(r, "b1", "first");
      const t2 = enterMergeQuarantine(r, "b2", "second");
      const name = plantTmp(r, [t1], "88882-cafed002");
      const tmpPath = path.join(MERGE_QUARANTINE_DIR, name);
      const inj = injectUnlinkFault(tmpPath, faulted);
      try { clearMergeQuarantineByToken(r, t1); clearMergeQuarantineByToken(r, t2); } finally { inj.restore(); }
      if (faulted) {
        check(`(token ${tag}) precondition: the residue's unlink was forced to fail`, inj.hits() >= 1);
        check(`(token ${tag}) the residue still exists`, fs.existsSync(tmpPath));
        check(`(token ${tag}) *** THE FIX *** the token the residue holds is NOT durably tombstoned`, !tombstoned(t1));
        check(`(token ${tag}) ...and neither is the sibling token of the same identity (write failure is identity-scoped)`, !tombstoned(t2));
      } else {
        check(`(token ${tag}) control: the residue is deleted and both tokens tombstoned`, !fs.existsSync(tmpPath) && tombstoned(t1) && tombstoned(t2));
      }
    }
    // ── (tracked) ─────────────────────────────────────────────────────────────────────────────────────
    {
      const r = makeRepo(`trk-${tag}`);
      const s = enterMergeQuarantine(r, "b", "W active");
      const name = plantTmp(r, [s], "77777-abc123");
      const tmpPath = path.join(MERGE_QUARANTINE_DIR, name);
      pushPendingQuarantineTestOnly({ repoPath: r, branch: "p2", reason: "P2 pending sourced from the tmp", enteredAt: Date.now(), tokens: [`other-${tag}`] }, name);
      const inj = injectUnlinkFault(tmpPath, faulted);
      let res;
      try { res = clearMergeQuarantine(r); } finally { inj.restore(); }
      if (faulted) {
        check(`(tracked ${tag}) precondition: the residue's unlink was forced to fail`, inj.hits() >= 1);
        check(`(tracked ${tag}) the residue still holds the token`, fs.existsSync(tmpPath) && fs.readFileSync(tmpPath, "utf8").includes(s));
        check(`(tracked ${tag}) *** THE FIX *** anyWriteFailed reported even though the disk scan is blind to the tracked residue`, res.anyWriteFailed === true);
        check(`(tracked ${tag}) *** THE FIX *** the token is NOT durably tombstoned`, !tombstoned(s));
      } else {
        check(`(tracked ${tag}) control: reaches the delete (residue gone) with no write failure`, !fs.existsSync(tmpPath) && res.anyWriteFailed !== true);
      }
    }
    // ── (token-pending-tracked) — the token route's pending REMOVE branch (clearTokenFromPendingIndices) ──
    // `live` is pending-only {tokens:[s]}, sourceFile `<h>.json`; a same-identity pending P2 {tokens:[other]}
    // has the surviving tmp as its sourceFile, so the tmp is TRACKED and the decide-time/push-time disk scans
    // are blind to it: only the sweep's unlink-failure fold withholds the tombstone.
    {
      const r = makeRepo(`tpt-${tag}`);
      const h = hashFor(canonicalRepoLockKey(r));
      fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
      const s = `tok-59f4ebe8-tpt-${tag}-s`;
      const liveSource = `${h}.json`;
      fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, liveSource), JSON.stringify({ repoPath: r, branch: "b", reason: "live pending", enteredAt: Date.now() - 2000, tokens: [s] }, null, 2) + "\n");
      pushPendingQuarantineTestOnly({ repoPath: r, branch: "b", reason: "live pending", enteredAt: Date.now() - 2000, tokens: [s] }, liveSource);
      const tmpName = `${h}.json.tmp-77777-abc123`;
      const tmpPath = path.join(MERGE_QUARANTINE_DIR, tmpName);
      fs.writeFileSync(tmpPath, JSON.stringify({ repoPath: r, branch: "b", reason: "stranded tmp", enteredAt: Date.now() - 1000, tokens: [s] }, null, 2) + "\n");
      pushPendingQuarantineTestOnly({ repoPath: r, branch: "p2", reason: "P2 pending sourced from the tmp", enteredAt: Date.now(), tokens: [`other-tpt-${tag}`] }, tmpName);
      const inj = injectUnlinkFault(tmpPath, faulted);
      try { clearMergeQuarantineByToken(r, s); } finally { inj.restore(); }
      if (faulted) {
        check(`(token-pending-tracked ${tag}) precondition: the residue's unlink was forced to fail (the remove branch's tmp sweep reached it)`, inj.hits() >= 1);
        check(`(token-pending-tracked ${tag}) the residue still holds the token`, fs.existsSync(tmpPath) && fs.readFileSync(tmpPath, "utf8").includes(s));
        check(`(token-pending-tracked ${tag}) *** THE FIX *** the token is NOT durably tombstoned`, !tombstoned(s));
      } else {
        check(`(token-pending-tracked ${tag}) control: reaches the delete (residue gone) and the token is tombstoned`, !fs.existsSync(tmpPath) && tombstoned(s));
      }
    }
    // ── (twin, differing sourceFile stem) — clearMergeQuarantineByKey's pending tmp sweep, DEFERRED (token) mode ──
    // Active E {tokens:[s]} at `<h>.json` is also a pending dual-tracked twin (883e29bc) with sourceFile
    // `<h2>.json`, h2 != h; a same-identity pending P2 tracks a tmp under h2 holding [s]. The job's writeFailed
    // is pushed BEFORE the sweep, and the end-of-call decide pass excludes tracked basenames, so only folding
    // the sweep's unlinkFailed into the deferred set withholds the tombstone.
    {
      const r = makeRepo(`twin-${tag}`);
      const key = canonicalRepoLockKey(r);
      const h = hashFor(key);
      const h2 = "ab".repeat(12);
      fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
      const s = `tok-59f4ebe8-twin-${tag}-s`;
      const live = { repoPath: r, branch: "b", reason: "live", enteredAt: Date.now() - 2000, tokens: [s], armedKeys: [key] };
      const wj = (n, o) => fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, n), JSON.stringify(o, null, 2) + "\n");
      wj(`${h}.json`, live);
      wj(`${h2}.json`, live);
      mod.setActiveQuarantineTestOnly(key, live);
      pushPendingQuarantineTestOnly(live, `${h2}.json`);
      const tmpName = `${h2}.json.tmp-77777-abc123`;
      const tmpPath = path.join(MERGE_QUARANTINE_DIR, tmpName);
      wj(tmpName, { repoPath: r, branch: "b", reason: "stranded", enteredAt: Date.now() - 1000, tokens: [s] });
      pushPendingQuarantineTestOnly({ repoPath: r, branch: "p2", reason: "P2 tracks the tmp", enteredAt: Date.now(), tokens: [`other-twin-${tag}`] }, tmpName);
      const inj = injectUnlinkFault(tmpPath, faulted);
      try { clearMergeQuarantineByToken(r, s); } finally { inj.restore(); }
      if (faulted) {
        check(`(twin ${tag}) precondition: the residue's unlink was forced to fail (the by-key pending tmp sweep reached it)`, inj.hits() >= 1);
        check(`(twin ${tag}) the residue still holds the token`, fs.existsSync(tmpPath) && fs.readFileSync(tmpPath, "utf8").includes(s));
        check(`(twin ${tag}) *** THE FIX *** the token is NOT durably tombstoned`, !tombstoned(s));
      } else {
        check(`(twin ${tag}) control: reaches the delete (residue gone) and the token is tombstoned`, !fs.existsSync(tmpPath) && tombstoned(s));
      }
    }
  }
} finally {
  // temp repos are cleaned by mkdtempManaged's registered cleanup
}

console.log(failures === 0 ? "\nALL CHECKS PASS" : `\n${failures} CHECK(S) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
