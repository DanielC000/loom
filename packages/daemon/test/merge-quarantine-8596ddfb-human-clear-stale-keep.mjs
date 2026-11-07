import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 8596ddfb — two findings on the identity-wide human clear (clearMergeQuarantineByRecordedPath).
//
// (1) STALE DISCLOSURE. A same-identity tmp `<pending hash>.json.tmp-…` holding only the pending entry's own token is
//     content-kept by ByKey's cross-hash tmp loop (no blockedBy), then DELETED by the pending branch's own tmp sweep.
//     The result used to keep reporting latchKept:true + contentKeptRepoPaths for a file that no longer exists.
//     Characterized, NOT fixed (won't-fix, fail-closed): t and `other` stay un-tombstoned although no file holds them.
// (2) TWO-PATH ASYMMETRY. ByKey's own-sourceFile sweep folded a REAL failed unlink only into anyKeptUnattributed, never
//     into anyWriteFailed, so it withheld its own job but not ANOTHER job of the same identity in the same call.
//
// Run: 1) pnpm build, 2) node test/merge-quarantine-8596ddfb-human-clear-stale-keep.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

const loomHome = useOwnLoomHome("loom-mq8596-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mqHref = pathToFileURL(path.join(__dirname, "..", "dist", "git", "merge-quarantine.js")).href;
const { enterMergeQuarantine, MERGE_QUARANTINE_DIR } = await import(mqHref);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mq8596@loom -c user.name=mq8596";
let bootCounter = 0;
const freshBoot = async () => await import(`${mqHref}?b=${++bootCounter}`);
const sidecarPath = path.join(loomHome, "merge-quarantine-cleared-tokens.dat");
const tombstoned = (tok) => fs.existsSync(sidecarPath) && JSON.parse(fs.readFileSync(sidecarPath, "utf8"))[tok] !== undefined;
const quiet = (fn) => { const e = console.error, w = console.warn; console.error = () => {}; console.warn = () => {}; try { return fn(); } finally { console.error = e; console.warn = w; } };

function makeRepo(tag) {
  const repo = mkdtempManaged(`loom-mq8596-${tag}-`);
  fs.writeFileSync(path.join(repo, "README.md"), `# ${tag}\n`);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "mq8596@loom"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "mq8596"], { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}
function injectUnlinkFault(target) {
  const real = fs.unlinkSync;
  let hits = 0;
  fs.unlinkSync = (p, ...rest) => {
    if (p === target) { hits++; throw Object.assign(new Error("EPERM: simulated unlink failure"), { code: "EPERM" }); }
    return real(p, ...rest);
  };
  return { restore: () => { fs.unlinkSync = real; }, hits: () => hits };
}

// Active A{t} + same-identity pending P{other} whose sourceFile has a same-hash tmp naming the repo's own repoPath.
async function stageStaleKeep(tag, tmpTokens) {
  const repo = makeRepo(`s1-${tag}`);
  const t = enterMergeQuarantine(repo, "b", "active");
  const mod = await freshBoot();
  mod.reenterMergeQuarantinesAtBoot([repo]);
  const src = `pending-8596-${tag}.json`;
  const tmpPath = path.join(MERGE_QUARANTINE_DIR, `${src}.tmp-1234-abcd`);
  fs.writeFileSync(tmpPath, JSON.stringify({ repoPath: repo, branch: "p", reason: "same-identity tmp", enteredAt: Date.now(), tokens: tmpTokens }));
  const pe = { repoPath: repo, branch: "p", reason: "pending independent", enteredAt: Date.now(), tokens: ["other-" + tag] };
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, src), JSON.stringify(pe));
  mod.pushPendingQuarantineTestOnly(pe, src);
  return { repo, t, mod, tmpPath, other: "other-" + tag };
}

// ── S1 — the pending tmp sweep deletes the file ByKey content-kept: the keep must not be disclosed ─────────
{
  const { repo, t, mod, tmpPath, other } = await stageStaleKeep("gone", ["other-gone"]);
  const res = quiet(() => mod.clearMergeQuarantineByRecordedPath(repo));
  check("(S1) precondition: the tmp is gone after the call (the pending sweep deleted it)", !fs.existsSync(tmpPath));
  check("(S1) the quarantine dir is empty", fs.readdirSync(MERGE_QUARANTINE_DIR).length === 0);
  check("*** THE FIX (S1) *** no latchKept for a file that no longer exists", res.latchKept !== true);
  check("*** THE FIX (S1) *** no contentKeptRepoPaths / contentKeptBlockedBy for it", res.contentKeptRepoPaths === undefined && res.contentKeptBlockedBy === undefined);
  check("(S1) the rebuilt reason names no kept-latch clause", res.reason === undefined);
  check("(S1) the repo is released", !(mod.assertRepoNotQuarantined(repo).ok === false));
  // CHARACTERIZATION of the documented won't-fix: neither token is tombstoned although no file holds them.
  check("(S1 characterization, won't-fix) t is NOT durably tombstoned", !tombstoned(t));
  check("(S1 characterization, won't-fix) other is NOT durably tombstoned", !tombstoned(other));
  const boot2 = await freshBoot();
  boot2.reenterMergeQuarantinesAtBoot([repo]);
  check("(S1) a reboot stays unblocked (fail-closed side unchanged)", boot2.assertRepoNotQuarantined(repo).ok === true);
}

// ── S2 — CONTROL: a keep whose file SURVIVES the call is still disclosed ───────────────────────────────────
// The tmp also holds a token the clear does not account for, so every sweep leaves it on disk; the ghost drop must not hide it.
{
  const { repo, mod, tmpPath } = await stageStaleKeep("kept", ["other-kept", "foreign-unaccounted-token"]);
  const res = quiet(() => mod.clearMergeQuarantineByRecordedPath(repo));
  check("(S2 control precondition) the tmp survives the call", fs.existsSync(tmpPath));
  check("(S2 control) the surviving keep is still disclosed (latchKept)", res.latchKept === true);
  const boot2 = await freshBoot();
  boot2.reenterMergeQuarantinesAtBoot([repo]);
  check("(S2 control) a reboot re-arms from the surviving file", boot2.assertRepoNotQuarantined(repo).ok === false);
}

// ── S3 — identity-wide withhold: a real failed own-sourceFile unlink on the by-key delegate withholds ANOTHER job ──
// Two active entries share one stored repoPath under two keys (E1 under the real key, E2 under a second key). E1 is
// ALSO a tied pending twin, so ByKey's own-sourceFile sweep tries to unlink the twin's file — forced to fail. E2's job is
// pushed by a SEPARATE ByKey call; nothing else withholds it (the failed file holds only t1).
for (const faulted of [false, true]) {
  const tag = faulted ? "FAULT" : "control";
  const repo = makeRepo(`s3-${tag}`);
  const t1 = enterMergeQuarantine(repo, "b1", "E1 active");
  const mod = await freshBoot();
  mod.reenterMergeQuarantinesAtBoot([repo]);
  const e1 = mod.stillBlockedEntryFor(repo);
  const t2 = `t2-${tag}`;
  const e2 = { repoPath: repo, branch: "b2", reason: "E2 second active key, same stored repoPath", enteredAt: Date.now(), tokens: [t2] };
  mod.setActiveQuarantineTestOnly(`8596-second-key-${tag}`, e2);
  const tiedSrc = `tied-8596-${tag}.json`;
  const tiedPath = path.join(MERGE_QUARANTINE_DIR, tiedSrc);
  fs.writeFileSync(tiedPath, JSON.stringify({ repoPath: repo, branch: "b1", reason: "E1 tied twin file", enteredAt: Date.now(), tokens: [t1] }));
  mod.pushPendingQuarantineTestOnly(e1, tiedSrc);
  const inj = injectUnlinkFault(faulted ? tiedPath : "<never>");
  let res;
  try { res = quiet(() => mod.clearMergeQuarantineByRecordedPath(repo)); } finally { inj.restore(); }
  if (faulted) {
    check("(S3 FAULT precondition) the twin file's unlink was forced to fail", inj.hits() >= 1 && fs.existsSync(tiedPath));
    check("(S3 FAULT) the clear reports latchKept", res.latchKept === true);
    check("(S3 FAULT) E1's own token t1 is NOT tombstoned", !tombstoned(t1));
    check("*** THE FIX (S3) *** E2's token t2 (ANOTHER job of the same identity) is NOT tombstoned", !tombstoned(t2));
  } else {
    check("(S3 control) no fault: t1 and t2 are both tombstoned", tombstoned(t1) && tombstoned(t2));
  }
}

// ── S4 — the file is deleted by a LATER ByKey call in the matched loop, not by the body's own pending branch ──
// Two active keys share one stored repoPath (A{t} under the real key, E2{t2} under a second key); P [t2] is pending
// (variant "twin": the E2 object itself; variant "indep": an independent entry) and its sourceFile has a same-hash tmp
// naming the repo with [t2]. ByKey(K1)'s cross-hash loop keeps the tmp; ByKey(K2) drops P and its sweep deletes the file.
// matchedPending is empty in the body, so the ghost drop must run after the matched loop too, not only in the pending branch.
for (const variant of ["twin", "indep"]) {
  const repo = makeRepo(`s4-${variant}`);
  const t = enterMergeQuarantine(repo, "b1", "A active");
  const mod = await freshBoot();
  mod.reenterMergeQuarantinesAtBoot([repo]);
  const t2 = `t2-s4-${variant}`;
  const e2 = { repoPath: repo, branch: "b2", reason: "E2 second active key, same stored repoPath", enteredAt: Date.now(), tokens: [t2] };
  mod.setActiveQuarantineTestOnly(`8596-s4-second-key-${variant}`, e2);
  const src = `pending-8596-s4-${variant}.json`;
  const tmpPath = path.join(MERGE_QUARANTINE_DIR, `${src}.tmp-1234-abcd`);
  fs.writeFileSync(tmpPath, JSON.stringify({ repoPath: repo, branch: "p", reason: "same-identity tmp naming the repo with t2", enteredAt: Date.now(), tokens: [t2] }));
  const pe = variant === "twin" ? e2 : { repoPath: repo, branch: "p", reason: "independent pending", enteredAt: Date.now(), tokens: [t2] };
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, src), JSON.stringify(pe));
  mod.pushPendingQuarantineTestOnly(pe, src);
  const res = quiet(() => mod.clearMergeQuarantineByRecordedPath(repo));
  // (own files only: the dir is shared with earlier scenarios' deliberate leftovers, e.g. S2's surviving tmp)
  check(`(S4 ${variant} precondition) P's tmp and sourceFile are both gone after the call`, !fs.existsSync(tmpPath) && !fs.existsSync(path.join(MERGE_QUARANTINE_DIR, src)));
  check(`*** THE FIX (S4 ${variant}) *** no latchKept for a file a later ByKey call deleted`, res.latchKept !== true);
  check(`*** THE FIX (S4 ${variant}) *** no contentKeptRepoPaths / contentKeptBlockedBy / reason`, res.contentKeptRepoPaths === undefined && res.contentKeptBlockedBy === undefined && res.reason === undefined);
  const boot2 = await freshBoot();
  boot2.reenterMergeQuarantinesAtBoot([repo]);
  check(`(S4 ${variant}) a reboot stays unblocked`, boot2.assertRepoNotQuarantined(repo).ok === true);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
