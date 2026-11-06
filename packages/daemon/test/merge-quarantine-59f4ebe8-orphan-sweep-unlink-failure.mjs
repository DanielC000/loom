import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 59f4ebe8 — SITE 2: `orphanLatchFileSweepDecision`'s "safe to delete" branch called a void
// `unlinkLatchFile(filename)` and returned `{outcome:"deleted"}` even when the unlink FAILED (EPERM/EBUSY).
// The orphan survived, the clear reported success (`anyWriteFailed:false`), and the next boot re-armed the
// quarantine from it. Now `{outcome:"unlink-failed"}`, folded into the caller's write-failure signal.
//
// Shapes: (identity) clearMergeQuarantine, (token) clearMergeQuarantineByToken (full lift), each with a
// NO-FAULT control proving the fixture reaches the delete.
// Run: 1) pnpm build, 2) node test/merge-quarantine-59f4ebe8-orphan-sweep-unlink-failure.mjs
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

const loomHome = useOwnLoomHome("loom-mq59f4-o-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mqHref = pathToFileURL(path.join(__dirname, "..", "dist", "git", "merge-quarantine.js")).href;
const { enterMergeQuarantine, MERGE_QUARANTINE_DIR } = await import(mqHref);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mq59f4@loom -c user.name=mq59f4";
let bootCounter = 0;
const freshBoot = async () => await import(`${mqHref}?b=${++bootCounter}`);

function makeRepo(tag) {
  const repo = mkdtempManaged(`loom-mq59f4o-${tag}-`);
  fs.writeFileSync(path.join(repo, "README.md"), `# ${tag}\n`);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "mq59f4@loom"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "mq59f4"], { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}
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

// Raises `repo`, hand-edits its final to name an orphan O (same technique as the orphan-sweep-content-aware
// test), boots a module instance that arms it, then writes O holding the entry's own token — the stale-
// duplicate shape the sweep is meant to delete.
async function setupOrphan(repo) {
  const tok = enterMergeQuarantine(repo, "b", "first");
  const finalName = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.endsWith(".json") && JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f), "utf8")).repoPath === repo)[0];
  const finalPath = path.join(MERGE_QUARANTINE_DIR, finalName);
  const orphan = `${randomBytes(12).toString("hex")}.json`;
  const rec = JSON.parse(fs.readFileSync(finalPath, "utf8"));
  rec.orphanLatchFiles = [orphan];
  fs.writeFileSync(finalPath, JSON.stringify(rec));
  const booted = await freshBoot();
  booted.reenterMergeQuarantinesAtBoot([repo]);
  const orphanPath = path.join(MERGE_QUARANTINE_DIR, orphan);
  fs.writeFileSync(orphanPath, JSON.stringify({ repoPath: repo, branch: "b-stale", reason: "stale duplicate", enteredAt: Date.now(), tokens: [tok], resolvedKey: repo.toLowerCase(), provenanceTracked: true }));
  return { tok, orphanPath, booted };
}

for (const faulted of [false, true]) {
  const tag = faulted ? "FAULT" : "control";
  for (const mode of ["identity", "token"]) {
    const repo = makeRepo(`${mode}-${tag}`);
    const { tok, orphanPath, booted } = await setupOrphan(repo);
    const inj = injectUnlinkFault(orphanPath, faulted);
    let res;
    try { res = mode === "identity" ? booted.clearMergeQuarantine(repo) : (booted.clearMergeQuarantineByToken(repo, tok), undefined); } finally { inj.restore(); }
    if (faulted) {
      check(`(${mode} ${tag}) precondition: the orphan's unlink was forced to fail`, inj.hits() >= 1);
      check(`(${mode} ${tag}) the orphan still exists`, fs.existsSync(orphanPath));
      if (mode === "identity") {
        check(`(${mode} ${tag}) *** THE FIX *** the clear reports anyWriteFailed`, res.anyWriteFailed === true);
        check(`(${mode} ${tag}) ...and latchKept`, res.latchKept === true);
      }
      check(`(${mode} ${tag}) *** THE FIX *** the token is NOT durably tombstoned`, !tombstoned(tok));
      const boot2 = await freshBoot();
      boot2.reenterMergeQuarantinesAtBoot([repo]);
      check(`(${mode} ${tag}) fail-closed: a fresh boot re-arms from the surviving orphan`, boot2.assertRepoNotQuarantined(repo).ok === false);
    } else {
      check(`(${mode} ${tag}) control: orphan deleted, no write failure, token tombstoned`, !fs.existsSync(orphanPath) && res?.anyWriteFailed !== true && tombstoned(tok));
    }
  }
}

// ── (token-pending-tracked) — the token route's pending REMOVE branch's orphan sweep (SHOULD-1) ──────────
// `live` is pending-only {tokens:[s], orphanLatchFiles:[O]}; O holds [s]; a same-identity pending P2
// {tokens:[other], orphanLatchFiles:[O]} makes O TRACKED (the sweep's own referencer check excludes the
// clearing identity, so O is still deleted), blinding the decide-time/push-time disk scans. Only the
// orphan sweep's unlink-failure fold withholds the tombstone.
for (const faulted of [false, true]) {
  const tag = faulted ? "FAULT" : "control";
  const repo = makeRepo(`tpt-${tag}`);
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const s = `tok-59f4ebe8-orph-tpt-${tag}-s`;
  const orphan = `${randomBytes(12).toString("hex")}.json`;
  const orphanPath = path.join(MERGE_QUARANTINE_DIR, orphan);
  fs.writeFileSync(orphanPath, JSON.stringify({ repoPath: repo, branch: "b-stale", reason: "stale duplicate", enteredAt: Date.now(), tokens: [s] }));
  const liveSource = `pending-59f4ebe8-orph-live-${tag}.json`;
  const liveEntry = { repoPath: repo, branch: "b", reason: "live pending", enteredAt: Date.now() - 2000, tokens: [s], orphanLatchFiles: [orphan] };
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, liveSource), JSON.stringify(liveEntry));
  const mod = await import(mqHref);
  mod.pushPendingQuarantineTestOnly(liveEntry, liveSource);
  mod.pushPendingQuarantineTestOnly({ repoPath: repo, branch: "p2", reason: "P2 tracks the orphan", enteredAt: Date.now(), tokens: [`other-orph-${tag}`], orphanLatchFiles: [orphan] }, `pending-59f4ebe8-orph-p2-${tag}.json`);
  const inj = injectUnlinkFault(orphanPath, faulted);
  try { mod.clearMergeQuarantineByToken(repo, s); } finally { inj.restore(); }
  if (faulted) {
    check(`(token-pending-tracked ${tag}) precondition: the orphan's unlink was forced to fail`, inj.hits() >= 1);
    check(`(token-pending-tracked ${tag}) the orphan still holds the token`, fs.existsSync(orphanPath) && fs.readFileSync(orphanPath, "utf8").includes(s));
    check(`(token-pending-tracked ${tag}) *** THE FIX *** the token is NOT durably tombstoned`, !tombstoned(s));
  } else {
    check(`(token-pending-tracked ${tag}) control: orphan deleted and the token tombstoned`, !fs.existsSync(orphanPath) && tombstoned(s));
  }
}

console.log(failures === 0 ? "\nALL CHECKS PASS" : `\n${failures} CHECK(S) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
