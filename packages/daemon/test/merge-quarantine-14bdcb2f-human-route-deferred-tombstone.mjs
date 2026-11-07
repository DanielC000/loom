import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 14bdcb2f — the human identity-wide clear (clearMergeQuarantineByRecordedPath) delegated to
// clearMergeQuarantineByKey, which wrote its durable tombstone IMMEDIATELY, before the same public call's own
// pending sweep ran. A later unlink failure in that sweep could not withhold the earlier tombstone: the clear
// reported latchKept, yet a reboot dropped the token (fail-open). Fixed by deferring the tombstone decision to
// the end of the call (decideDeferredTombstones), as the token path already does.
//
// Shape (P1): active entry A {token t}; same-identity PENDING P {other token, orphanLatchFiles:[O]}; O holds
// only t and is TRACKED via P, so ByKey's push-time disk scan excludes it. Unlink(O) is forced to fail.
// Run: 1) pnpm build, 2) node test/merge-quarantine-14bdcb2f-human-route-deferred-tombstone.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

const loomHome = useOwnLoomHome("loom-mq14bd-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mqHref = pathToFileURL(path.join(__dirname, "..", "dist", "git", "merge-quarantine.js")).href;
const { enterMergeQuarantine, MERGE_QUARANTINE_DIR } = await import(mqHref);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mq14bd@loom -c user.name=mq14bd";
let bootCounter = 0;
const freshBoot = async () => await import(`${mqHref}?b=${++bootCounter}`);
const sidecarPath = path.join(loomHome, "merge-quarantine-cleared-tokens.dat");
const tombstoned = (tok) => fs.existsSync(sidecarPath) && JSON.parse(fs.readFileSync(sidecarPath, "utf8"))[tok] !== undefined;

function makeRepo(tag) {
  const repo = mkdtempManaged(`loom-mq14bd-${tag}-`);
  fs.writeFileSync(path.join(repo, "README.md"), `# ${tag}\n`);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "mq14bd@loom"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "mq14bd"], { cwd: repo });
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

// ── P1 — ByRecordedPath, pending-sweep orphan unlink failure ─────────────────────────────────────────────
for (const faulted of [false, true]) {
  const tag = faulted ? "FAULT" : "control";
  const repo = makeRepo(`p1-${tag}`);
  const t = enterMergeQuarantine(repo, "b", "active");
  const mod = await freshBoot();
  mod.reenterMergeQuarantinesAtBoot([repo]);
  const src = `pending-14bd-p1-${tag}.json`;
  const orphan = `aaaa14bd${faulted ? "f" : "c"}0000000000000000.json`;
  const orphanPath = path.join(MERGE_QUARANTINE_DIR, orphan);
  fs.writeFileSync(orphanPath, JSON.stringify({ repoPath: repo, branch: "o", reason: "orphan holds t", enteredAt: Date.now(), tokens: [t] }));
  const pe = { repoPath: repo, branch: "p", reason: "pending independent", enteredAt: Date.now(), tokens: [`other-p1-${tag}`], orphanLatchFiles: [orphan] };
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, src), JSON.stringify(pe));
  mod.pushPendingQuarantineTestOnly(pe, src);
  const inj = injectUnlinkFault(orphanPath, faulted);
  let res;
  try { res = mod.clearMergeQuarantineByRecordedPath(repo); } finally { inj.restore(); }
  if (faulted) {
    check(`(P1 ${tag}) precondition: the orphan's unlink was forced to fail`, inj.hits() >= 1);
    check(`(P1 ${tag}) the orphan still holds t`, fs.existsSync(orphanPath) && fs.readFileSync(orphanPath, "utf8").includes(t));
    check(`(P1 ${tag}) the clear reports latchKept`, res.latchKept === true);
    check(`(P1 ${tag}) *** THE FIX *** t is NOT durably tombstoned`, !tombstoned(t));
    const boot2 = await freshBoot();
    boot2.reenterMergeQuarantinesAtBoot([repo]);
    check(`(P1 ${tag}) fail-closed: a fresh boot re-arms from the surviving orphan`, boot2.assertRepoNotQuarantined(repo).ok === false);
  } else {
    check(`(P1 ${tag}) control: orphan deleted and t tombstoned`, !fs.existsSync(orphanPath) && tombstoned(t));
    const boot2 = await freshBoot();
    boot2.reenterMergeQuarantinesAtBoot([repo]);
    check(`(P1 ${tag}) control: repo unblocked after reboot`, boot2.assertRepoNotQuarantined(repo).ok === true);
  }
}

// ── P2 — clearMergeQuarantine's freshIsForeign ("unreduced") branch ──────────────────────────────────────
// R and R/sub both hold an active record; sub's .git is removed so sub's FRESH key collapses onto R's (a
// foreign occupant). A same-identity PENDING entry for sub tracks an orphan O holding sub's own token.
for (const faulted of [false, true]) {
  const tag = faulted ? "FAULT" : "control";
  const R = makeRepo(`p2-${tag}`);
  const sub = path.join(R, "sub");
  fs.mkdirSync(path.join(sub, ".git"), { recursive: true });
  const mod = await freshBoot();
  mod.enterMergeQuarantine(R, "bR", "R raise");
  const tSub = mod.enterMergeQuarantine(sub, "bS", "sub raise");
  fs.rmSync(path.join(sub, ".git"), { recursive: true, force: true });
  const orphan = `bbbb14bd${faulted ? "f" : "c"}0000000000000000.json`;
  const orphanPath = path.join(MERGE_QUARANTINE_DIR, orphan);
  fs.writeFileSync(orphanPath, JSON.stringify({ repoPath: sub, branch: "o", reason: "orphan holds tSub", enteredAt: Date.now(), tokens: [tSub] }));
  const src = `pending-14bd-p2-${tag}.json`;
  const pe = { repoPath: sub, branch: "p", reason: "pending independent", enteredAt: Date.now(), tokens: [`other-p2-${tag}`], orphanLatchFiles: [orphan] };
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, src), JSON.stringify(pe));
  mod.pushPendingQuarantineTestOnly(pe, src);
  const inj = injectUnlinkFault(orphanPath, faulted);
  let res;
  try { res = mod.clearMergeQuarantine(sub); } finally { inj.restore(); }
  if (faulted) {
    check(`(P2 ${tag}) precondition: the orphan's unlink was forced to fail`, inj.hits() >= 1);
    check(`(P2 ${tag}) the orphan still holds sub's token`, fs.existsSync(orphanPath) && fs.readFileSync(orphanPath, "utf8").includes(tSub));
    check(`(P2 ${tag}) *** THE FIX *** sub's token is NOT durably tombstoned`, !tombstoned(tSub));
  } else {
    check(`(P2 ${tag}) control: orphan deleted and sub's token tombstoned`, !fs.existsSync(orphanPath) && tombstoned(tSub));
  }
}

// ── P3 — a THROW out of the body, AFTER the phase-1 delegate pushed its job, DROPS the jobs ─────────────────
// The pending entry's `orphanLatchFiles` is a counting getter. A dry run counts how many times the clear reads
// it; the real run throws on the LAST read, which is inside the pending branch — after ByKey (the first reader)
// already computed and pushed its tombstone job. Fail-closed means no tombstone for t.
async function p3Run(throwAtRead) {
  const repo = makeRepo(`p3-${throwAtRead ? "throw" : "dry"}`);
  const t = enterMergeQuarantine(repo, "b", "active");
  const mod = await freshBoot();
  mod.reenterMergeQuarantinesAtBoot([repo]);
  const orphan = `cccc14bd${throwAtRead ? "t" : "d"}0000000000000000.json`;
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, orphan), JSON.stringify({ repoPath: repo, branch: "o", reason: "orphan does NOT hold t", enteredAt: Date.now(), tokens: ["unrelated-p3"] }));
  // ^ nothing on disk holds t, so the decide-time re-scan cannot withhold it: only DROPPING the jobs on a throw does.
  const src = `pending-14bd-p3-${throwAtRead ? "t" : "d"}.json`;
  let reads = 0, counting = false, threwInGetter = false, thrownStack = "";
  const pe = { repoPath: repo, branch: "p", reason: "pending independent", tokens: ["other-p3"], enteredAt: Date.now() };
  Object.defineProperty(pe, "orphanLatchFiles", { enumerable: true, get() {
    if (counting) { reads++; if (throwAtRead && reads === throwAtRead) { threwInGetter = true; const err = new Error("boom-phase2"); thrownStack = String(err.stack); throw err; } }
    return [orphan];
  } });
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, src), JSON.stringify({ ...pe, orphanLatchFiles: [orphan] }));
  mod.pushPendingQuarantineTestOnly(pe, src);
  counting = true;
  let threw = false;
  try { mod.clearMergeQuarantineByRecordedPath(repo); } catch { threw = true; }
  counting = false;
  return { t, reads, threw, threwInGetter, thrownStack };
}
{
  const dry = await p3Run(0);
  check(`(P3 dry) precondition: the clear reads orphanLatchFiles several times (${dry.reads}) and does not throw; t is tombstoned`, dry.reads >= 2 && !dry.threw && tombstoned(dry.t));
  const real = await p3Run(dry.reads);
  check(`(P3) precondition: the clear THREW from the getter at read ${dry.reads}/${dry.reads} (the last body read, after ByKey's first reads)`, real.threw && real.threwInGetter);
  // N1: the throwing frame must be inside the PENDING branch (the body function), past ByKey's own reads — a
  // silent shift of the throw into ByKey/the wrapper would otherwise leave this case green for the wrong reason.
  check(`(P3) the throw originates in the body's pending branch, not in ByKey`, /tryClearMergeQuarantineByOwnIdentityBody/.test(real.thrownStack) && !/clearMergeQuarantineByKey/.test(real.thrownStack));
  check(`(P3) *** THE FIX *** a throw after the phase-1 push leaves t NOT tombstoned (jobs dropped, never decided)`, !tombstoned(real.t));
}

// ── P4 — a survivor still TRACKED by a live entry of a DIFFERENT identity ─────────────────────────────────
{
  const repo = makeRepo("p4");
  const other = makeRepo("p4-other");
  const t = enterMergeQuarantine(repo, "b", "active");
  const mod = await freshBoot();
  mod.reenterMergeQuarantinesAtBoot([repo]);
  const orphan = "dddd14bd0000000000000000.json";
  const orphanPath = path.join(MERGE_QUARANTINE_DIR, orphan);
  fs.writeFileSync(orphanPath, JSON.stringify({ repoPath: repo, branch: "o", reason: "orphan holds t", enteredAt: Date.now(), tokens: [t] }));
  const mk = (rp, nm, tok) => {
    const e = { repoPath: rp, branch: nm, reason: nm, enteredAt: Date.now(), tokens: [tok], orphanLatchFiles: [orphan] };
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `pending-14bd-p4-${nm}.json`), JSON.stringify(e));
    mod.pushPendingQuarantineTestOnly(e, `pending-14bd-p4-${nm}.json`);
  };
  mk(repo, "mine", "other-p4-mine");
  mk(other, "theirs", "other-p4-theirs"); // a different identity also tracks O
  const res = mod.clearMergeQuarantineByRecordedPath(repo);
  console.log(`      (P4 info) orphanSurvives=${fs.existsSync(orphanPath)} latchKept=${res.latchKept} tombstoned(t)=${tombstoned(t)}`);
  const survives = fs.existsSync(orphanPath);
  const boot2 = await freshBoot();
  boot2.reenterMergeQuarantinesAtBoot([repo, other]);
  check(`(P4) consistency: if the foreign-tracked orphan survives holding t, t must NOT be tombstoned and repo must stay blocked after reboot`,
    !survives || (!tombstoned(t) && boot2.assertRepoNotQuarantined(repo).ok === false));
}

// ── P5 — a FOREIGN keep in the pending branch must NOT withhold phase 1's job (over-retain regression) ──────
// Active A{t}; same-identity pending P{other-p5, orphanLatchFiles:[O2]}; O2 is a FOREIGN repo's record holding
// only "foreign-tok". Nothing holds t afterwards, so t MUST be durably tombstoned. Feeding a foreign keep
// (pendingAnyKept) into the call-scoped write-failed set wrongly withheld it (card 14bdcb2f fix round).
{
  const repo = makeRepo("p5");
  const foreign = makeRepo("p5-foreign");
  const t = enterMergeQuarantine(repo, "b", "active");
  const mod = await freshBoot();
  mod.reenterMergeQuarantinesAtBoot([repo]);
  const o2 = "eeee14bd0000000000000000.json";
  const o2Path = path.join(MERGE_QUARANTINE_DIR, o2);
  fs.writeFileSync(o2Path, JSON.stringify({ repoPath: foreign, branch: "f", reason: "foreign orphan", enteredAt: Date.now(), tokens: ["foreign-tok-p5"] }));
  const src = "pending-14bd-p5.json";
  const pe = { repoPath: repo, branch: "p", reason: "pending independent", enteredAt: Date.now(), tokens: ["other-p5"], orphanLatchFiles: [o2] };
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, src), JSON.stringify(pe));
  mod.pushPendingQuarantineTestOnly(pe, src);
  mod.clearMergeQuarantineByRecordedPath(repo);
  const holdsT = fs.readdirSync(MERGE_QUARANTINE_DIR).some((f) => (f.endsWith(".json") || /\.json\.tmp-/.test(f)) && fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f), "utf8").includes(t));
  check("(P5) precondition: no file in the quarantine dir holds t after the clear", !holdsT);
  check("(P5) *** THE FIX *** t IS durably tombstoned (a foreign keep must not withhold another site's job)", tombstoned(t));
}

// ── P6 — CHARACTERIZATION (passes on main too; NOT a proof of this fix): a failed tmp-residue unlink ───────
// withholds the tombstone. The pending branch's own tmp feed is pinned separately by P11.
// Active A{t}; a stranded tmp T (same hash as the repo's key) holds t; a same-identity pending Q tracks T as its
// sourceFile (so the disk re-scans are blind to it). ByRecordedPath drops Q and sweeps T; T's unlink fails.
for (const faulted of [false, true]) {
  const tag = faulted ? "FAULT" : "control";
  const repo = makeRepo(`p6-${tag}`);
  const t = enterMergeQuarantine(repo, "b", "active");
  const mod = await freshBoot();
  mod.reenterMergeQuarantinesAtBoot([repo]);
  const finalName = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.endsWith(".json") && JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f), "utf8")).repoPath === repo)[0];
  const tmpName = `${finalName}.tmp-77777-abc123`;
  const tmpPath = path.join(MERGE_QUARANTINE_DIR, tmpName);
  fs.writeFileSync(tmpPath, JSON.stringify({ repoPath: repo, branch: "b", reason: "stranded tmp", enteredAt: Date.now() - 1000, tokens: [t] }, null, 2) + "\n");
  mod.pushPendingQuarantineTestOnly({ repoPath: repo, branch: "q", reason: "Q sourced from the tmp", enteredAt: Date.now(), tokens: [`other-p6-${tag}`] }, tmpName);
  const inj = injectUnlinkFault(tmpPath, faulted);
  try { mod.clearMergeQuarantineByRecordedPath(repo); } finally { inj.restore(); }
  if (faulted) {
    check(`(P6 ${tag}) precondition: the tmp's unlink was forced to fail`, inj.hits() >= 1);
    check(`(P6 ${tag}) the tmp still holds t`, fs.existsSync(tmpPath) && fs.readFileSync(tmpPath, "utf8").includes(t));
    check(`(P6 ${tag}) *** THE FIX *** t is NOT durably tombstoned`, !tombstoned(t));
  } else {
    check(`(P6 ${tag}) control: tmp deleted and t tombstoned`, !fs.existsSync(tmpPath) && tombstoned(t));
  }
}

// ── P8–P11 — each write-failed FEED of the pending branch, pinned by name ────────────────────────────────────
// Policy (accepted, cf. 59f4ebe8): the feeds are IDENTITY-keyed, so a REAL failed unlink of a file that does NOT
// hold t still withholds t (fail-closed, needs a real I/O failure). In P9–P11 the failed file never holds t, so
// the decide-time re-scan cannot be what withholds it: each feed is the SOLE withhold. P8 is the converse: a
// keep that never attempted an unlink must NOT withhold.
const holdsToken = (tok) => fs.readdirSync(MERGE_QUARANTINE_DIR).some((f) => (f.endsWith(".json") || /\.json\.tmp-/.test(f)) && fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f), "utf8").includes(tok));
async function feedFixture(tag) {
  const repo = makeRepo(tag);
  const t = enterMergeQuarantine(repo, "b", "active");
  const mod = await freshBoot();
  mod.reenterMergeQuarantinesAtBoot([repo]);
  return { repo, t, mod };
}

// P8 — a marked-unreadable sourceFile keep (no unlink attempted) must NOT withhold t.
for (const variant of ["foreign-record", "same-identity-other-token", "corrupt"]) {
  const { repo, t, mod } = await feedFixture(`p8-${variant}`);
  const foreign = makeRepo(`p8-${variant}-foreign`);
  const src = `pending-14bd-p8-${variant}.json`;
  const content = variant === "foreign-record" ? JSON.stringify({ repoPath: foreign, branch: "f", reason: "foreign", enteredAt: Date.now(), tokens: ["ftok-p8"] })
    : variant === "same-identity-other-token" ? JSON.stringify({ repoPath: repo, branch: "x", reason: "other", enteredAt: Date.now(), tokens: ["other-tok-p8"] })
      : "{ not json";
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, src), content);
  mod.pushPendingQuarantineTestOnly({ repoPath: repo, branch: "p", reason: "pending", enteredAt: Date.now(), tokens: [`other-p8-${variant}`] }, src);
  mod.markLatchFileUnreadableTestOnly(src);
  mod.clearMergeQuarantineByRecordedPath(repo);
  check(`(P8 ${variant}) precondition: the marked sourceFile survived (no unlink attempted) and nothing holds t`, fs.existsSync(path.join(MERGE_QUARANTINE_DIR, src)) && !holdsToken(t));
  check(`(P8 ${variant}) *** THE FIX *** t IS tombstoned (a keep that attempted no unlink is not a write failure)`, tombstoned(t));
}

// P9 — the sourceFile sweep's REAL unlink failure is the SOLE withhold.
for (const faulted of [false, true]) {
  const tag = faulted ? "FAULT" : "control";
  const { repo, t, mod } = await feedFixture(`p9-${tag}`);
  const src = `pending-14bd-p9-${tag}.json`;
  const srcPath = path.join(MERGE_QUARANTINE_DIR, src);
  fs.writeFileSync(srcPath, JSON.stringify({ repoPath: repo, branch: "p", reason: "pending", enteredAt: Date.now(), tokens: [`other-p9-${tag}`] }));
  mod.pushPendingQuarantineTestOnly({ repoPath: repo, branch: "p", reason: "pending", enteredAt: Date.now(), tokens: [`other-p9-${tag}`] }, src);
  const inj = injectUnlinkFault(srcPath, faulted);
  try { mod.clearMergeQuarantineByRecordedPath(repo); } finally { inj.restore(); }
  if (faulted) {
    check(`(P9 ${tag}) precondition: the sourceFile unlink failed, and the failed file does NOT hold t`, inj.hits() >= 1 && fs.existsSync(srcPath) && !holdsToken(t));
    check(`(P9 ${tag}) *** SOLE WITHHOLD *** t is NOT tombstoned`, !tombstoned(t));
  } else {
    check(`(P9 ${tag}) control: sourceFile deleted and t tombstoned`, !fs.existsSync(srcPath) && tombstoned(t));
  }
}

// P10 — the orphan sweep's unlinkFailed is the SOLE withhold (the orphan does not hold t).
for (const faulted of [false, true]) {
  const tag = faulted ? "FAULT" : "control";
  const { repo, t, mod } = await feedFixture(`p10-${tag}`);
  const orphan = `a10a14bd${faulted ? "f" : "c"}0000000000000000.json`;
  const orphanPath = path.join(MERGE_QUARANTINE_DIR, orphan);
  fs.writeFileSync(orphanPath, JSON.stringify({ repoPath: repo, branch: "o", reason: "orphan, not t", enteredAt: Date.now(), tokens: [`other-p10-${tag}`] }));
  const src = `pending-14bd-p10-${tag}.json`;
  const pe = { repoPath: repo, branch: "p", reason: "pending", enteredAt: Date.now(), tokens: [`other-p10-${tag}`], orphanLatchFiles: [orphan] };
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, src), JSON.stringify(pe));
  mod.pushPendingQuarantineTestOnly(pe, src);
  const inj = injectUnlinkFault(orphanPath, faulted);
  try { mod.clearMergeQuarantineByRecordedPath(repo); } finally { inj.restore(); }
  if (faulted) {
    check(`(P10 ${tag}) precondition: the orphan unlink failed, and the orphan does NOT hold t`, inj.hits() >= 1 && fs.existsSync(orphanPath) && !holdsToken(t));
    check(`(P10 ${tag}) *** SOLE WITHHOLD *** t is NOT tombstoned`, !tombstoned(t));
  } else {
    check(`(P10 ${tag}) control: orphan deleted and t tombstoned`, !fs.existsSync(orphanPath) && tombstoned(t));
  }
}

// P11 — the pending branch's own TMP sweep unlinkFailed is the SOLE withhold: pending P sourceFile
// `<24hex>.json` {other}; a tmp `<same hash>.json.tmp-…` holding only {other}; its unlink faulted.
for (const faulted of [false, true]) {
  const tag = faulted ? "FAULT" : "control";
  const { repo, t, mod } = await feedFixture(`p11-${tag}`);
  const hash = `b11b14bd${faulted ? "f" : "c"}`.padEnd(24, "0");
  const src = `${hash}.json`;
  const tmpPath = path.join(MERGE_QUARANTINE_DIR, `${src}.tmp-77777-abc123`);
  const other = `other-p11-${tag}`;
  const rec = { repoPath: repo, branch: "p", reason: "pending", enteredAt: Date.now(), tokens: [other] };
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, src), JSON.stringify(rec));
  // The tmp names a DIFFERENT repoPath than P: a tmp naming P's own identity collapses onto the freed key and
  // ByKey's cross-hash tmp scan keeps/arms it at phase 1 (withholding t for an unrelated, pre-existing reason),
  // which would make the control here unreachable. At P's hash it is still swept by the pending branch's tmp sweep.
  fs.writeFileSync(tmpPath, JSON.stringify({ ...rec, repoPath: `${repo}-x` }));
  mod.pushPendingQuarantineTestOnly(rec, src);
  const inj = injectUnlinkFault(tmpPath, faulted);
  try { mod.clearMergeQuarantineByRecordedPath(repo); } finally { inj.restore(); }
  if (faulted) {
    check(`(P11 ${tag}) precondition: the tmp unlink failed, and the tmp does NOT hold t`, inj.hits() >= 1 && fs.existsSync(tmpPath) && !holdsToken(t));
    check(`(P11 ${tag}) *** SOLE WITHHOLD *** t is NOT tombstoned`, !tombstoned(t));
  } else {
    check(`(P11 ${tag}) control: tmp deleted and t tombstoned`, !fs.existsSync(tmpPath) && tombstoned(t));
  }
}

console.log(failures === 0 ? "\nALL CHECKS PASS" : `\n${failures} CHECK(S) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
