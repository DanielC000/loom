import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card b11056a9 — a clear that keeps a latch because an unlink FAILED (EPERM/EBUSY) now says so, through the
// reason text of every clear route: /clear, /clear-by-path {repoPath}, /clear-by-path {id}. The reason names
// the stranded latch basename(s) (no directory, no errno text, capped at 5 + "and N more") and the next action.
// Before: /clear and /clear-by-path {repoPath} gave only a generic "a physical latch file ... is still on disk"
// sentence, and /clear-by-path {id} gave NO reason at all (latchKept:true with an empty referencingRepoPaths).
//
// Fixture (reuses 59f4ebe8's EPERM-injection technique): a booted latch whose `orphanLatchFiles` names
// orphan file(s) holding the entry's own token — the stale-duplicate shape the sweep deletes. A forced
// unlink failure on them leaves them on disk, the unattributed-keep shape.
// Run: 1) pnpm build, 2) node test/merge-quarantine-b11056a9-unlink-failed-reason.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";

const loomHome = useOwnLoomHome("loom-mqb11-", { fresh: true });
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const { quarantineLatchIdFor, reenterMergeQuarantinesAtBoot, MERGE_QUARANTINE_DIR } = await import(pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);
const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `lmq-b11-${sfx.slice(-6)}-`));
function makeRepo(tag) {
  const d = path.join(TMP, tag);
  fs.mkdirSync(path.join(d, ".git"), { recursive: true }); // marker-only: resolvable as its own git root
  return d;
}
function injectUnlinkFault(targets) {
  const real = fs.unlinkSync;
  let hits = 0;
  fs.unlinkSync = (p, ...rest) => {
    if (targets.has(p)) { hits++; throw Object.assign(new Error("EPERM: simulated unlink failure"), { code: "EPERM" }); }
    return real(p, ...rest);
  };
  return { restore: () => { fs.unlinkSync = real; }, hits: () => hits };
}

const PORT = 45300 + (process.pid % 400);
const H = { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, "content-type": "application/json" };
const db = new Db(path.join(TMP, "loom.db"));
const stub = {};
const app = await buildServer({
  db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
  userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub,
});

// Boots a latch for a fresh repo whose final names `n` orphan files, each holding the entry's own token.
let seq = 0;
function setup(tag, n) {
  const repo = makeRepo(`${tag}-${++seq}`);
  const tok = `tok-b11056a9-${tag}-${seq}`;
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const orphans = Array.from({ length: n }, () => `${randomBytes(12).toString("hex")}.json`);
  const id = quarantineLatchIdFor(repo);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${id}.json`), JSON.stringify({
    repoPath: repo, branch: "b", reason: "first", enteredAt: Date.now() - 5000, tokens: [tok],
    resolvedKey: canonicalRepoLockKey(repo), orphanLatchFiles: orphans,
  }));
  reenterMergeQuarantinesAtBoot([repo]);
  // Written AFTER the boot re-arm (59f4ebe8's technique): boot itself would otherwise sweep a token-holding orphan.
  for (const o of orphans) {
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, o), JSON.stringify({
      repoPath: repo, branch: "b-stale", reason: "stale duplicate", enteredAt: Date.now(), tokens: [tok], resolvedKey: canonicalRepoLockKey(repo),
    }));
  }
  const projectId = `p-${tag}-${seq}`;
  db.insertProject({ id: projectId, name: projectId, repoPath: repo, vaultPath: repo, config: {}, createdAt: new Date().toISOString(), archivedAt: null, reserved: false, referenceRepos: [], repos: [] });
  return { repo, id, tok, orphans, projectId, orphanPaths: new Set(orphans.map((o) => path.join(MERGE_QUARANTINE_DIR, o))) };
}
const call = (route, s) => app.inject({
  method: "POST", headers: H,
  url: route === "clear" ? "/internal/merge-quarantine/clear" : "/internal/merge-quarantine/clear-by-path",
  payload: route === "clear" ? { projectId: s.projectId } : route === "by-path" ? { repoPath: s.repo } : { id: s.id },
});
const CLAUSE = "An unlink failed for";

for (const route of ["clear", "by-path", "by-id"]) {
  // ── faulted: the clause names the stranded file ──
  {
    const s = setup(`f-${route}`, 1);
    const inj = injectUnlinkFault(s.orphanPaths);
    let res;
    try { res = await call(route, s); } finally { inj.restore(); }
    const body = res.json();
    const name = s.orphans[0];
    check(`(${route} FAULT) precondition: the orphan's unlink was forced to fail and it is still on disk`, inj.hits() >= 1 && fs.existsSync(path.join(MERGE_QUARANTINE_DIR, name)));
    check(`(${route} FAULT) 200 + latchKept (the kept shape this card is about)`, res.statusCode === 200 && body.latchKept === true);
    check(`(${route} FAULT) *** THE FIX *** the reason names the stranded file and the next action`, typeof body.reason === "string" && body.reason.includes(`${CLAUSE} ${name}`) && body.reason.includes("remove it by hand, or restart the daemon and clear again"));
    check(`(${route} FAULT) the reason also keeps the generic unattributed sentence (the clause never hides another cause)`, typeof body.reason === "string" && body.reason.includes("a physical latch file it referenced is still on disk"));
    check(`(${route} FAULT) names only: no directory, no errno text`, typeof body.reason === "string" && !body.reason.includes(MERGE_QUARANTINE_DIR) && !body.reason.includes(loomHome) && !body.reason.includes("EPERM"));
  }
  // ── clean control: no clause on a clean clear ──
  {
    const s = setup(`c-${route}`, 1);
    const res = await call(route, s);
    const body = res.json();
    check(`(${route} control) precondition: the orphan was really deleted`, !fs.existsSync(path.join(MERGE_QUARANTINE_DIR, s.orphans[0])));
    check(`(${route} control) *** no unlink clause on a clean clear ***`, res.statusCode === 200 && !JSON.stringify(body).includes(CLAUSE) && body.latchKept !== true);
  }
}

// ── cap: 7 stranded files → exactly 5 named + "and 2 more" (route: by-id, the one that had NO reason at all) ──
{
  const s = setup("cap", 7);
  const inj = injectUnlinkFault(s.orphanPaths);
  let res;
  try { res = await call("by-id", s); } finally { inj.restore(); }
  const reason = res.json().reason ?? "";
  const named = s.orphans.filter((o) => reason.includes(o));
  check("(cap) precondition: all 7 unlinks were forced to fail", inj.hits() >= 7);
  check("(cap) exactly 5 of the 7 basenames are named", named.length === 5);
  check("(cap) the remainder is summarised as 'and 2 more'", reason.includes("and 2 more") && reason.includes("remove them by hand, or restart the daemon and clear again"));
}

// ── S2a: the identity is STILL quarantined after the clear (a diverted nested entry still blocks it) AND a latch
// was kept on a failed unlink: /clear rebuilt its reason from the still-blocked text and dropped the clause.
// Shape (clear-by-path H7): N is a nested repo that vanished, so its diverted entry degrades onto R's own key.
for (const route of ["clear", "by-path"]) {
  const R = makeRepo(`s2a-${route}`);
  const N = path.join(R, "nested");
  fs.mkdirSync(path.join(N, ".git"), { recursive: true });
  const kN = canonicalRepoLockKey(N);
  const kR = canonicalRepoLockKey(R);
  const rTok = `tok-s2a-r-${route}`;
  const orphan = `${randomBytes(12).toString("hex")}.json`;
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${quarantineLatchIdFor(N)}.json`), JSON.stringify({
    repoPath: N, branch: "n-branch", reason: "nested's own prior raise", enteredAt: Date.now() - 60_000, tokens: [`tok-s2a-n-${route}`], resolvedKey: kN,
  }));
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${quarantineLatchIdFor(R)}.json`), JSON.stringify({
    repoPath: R, branch: "r-branch", reason: "R's own raise", enteredAt: Date.now() - 5000, tokens: [rTok], resolvedKey: kR, orphanLatchFiles: [orphan],
  }));
  fs.rmSync(N, { recursive: true, force: true }); // N vanishes: its degraded walk now lands on R's key
  reenterMergeQuarantinesAtBoot([R, N]);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, orphan), JSON.stringify({ repoPath: R, branch: "r-stale", reason: "stale duplicate", enteredAt: Date.now(), tokens: [rTok], resolvedKey: kR }));
  const projectId = `p-s2a-${route}`;
  db.insertProject({ id: projectId, name: projectId, repoPath: R, vaultPath: R, config: {}, createdAt: new Date().toISOString(), archivedAt: null, reserved: false, referenceRepos: [], repos: [] });
  const inj = injectUnlinkFault(new Set([path.join(MERGE_QUARANTINE_DIR, orphan)]));
  let res;
  try { res = await call(route, { projectId, repo: R }); } finally { inj.restore(); }
  const body = res.json();
  check(`(S2a ${route}) precondition: the unlink was forced to fail, the orphan is still on disk`, inj.hits() >= 1 && fs.existsSync(path.join(MERGE_QUARANTINE_DIR, orphan)));
  check(`(S2a ${route}) precondition: the identity is STILL quarantined (the still-blocked reason shape)`, res.statusCode === 200 && (body.stillQuarantined === true || (typeof body.reason === "string" && body.reason.includes(N))));
  check(`(S2a ${route}) *** THE FIX *** the still-quarantined reason also names the stranded file`, typeof body.reason === "string" && body.reason.includes(`${CLAUSE} ${orphan}`));
}

// ── S2b: clear-broad-union's real result carries the clause for a kept latch (reason only) ──
{
  const { clearBroadUnion } = await import(pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href);
  const s = makeRepo("s2b-s");
  const r = makeRepo("s2b-r");
  const ks = canonicalRepoLockKey(s);
  const kr = canonicalRepoLockKey(r);
  const orphan = `${randomBytes(12).toString("hex")}.json`;
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  // The stranded-union shape of the broad-union route's own test (9497bb7e): s holds a contributor r under r's key.
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${quarantineLatchIdFor(s)}.json`), JSON.stringify({
    repoPath: s, branch: "s-branch", reason: "pre-existing union (s2b)", enteredAt: Date.now() - 60_000, tokens: ["s2b-s-token", "s2b-r-token"],
    resolvedKey: kr, identityAtRaise: ks, contributorRepoPaths: [r], orphanLatchFiles: [orphan],
  }));
  reenterMergeQuarantinesAtBoot([]);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, orphan), JSON.stringify({ repoPath: s, branch: "s-stale", reason: "stale duplicate", enteredAt: Date.now(), tokens: ["s2b-s-token", "s2b-r-token"], resolvedKey: kr }));
  const dry = clearBroadUnion(s, [], true);
  const inj = injectUnlinkFault(new Set([path.join(MERGE_QUARANTINE_DIR, orphan)]));
  let real;
  try { real = clearBroadUnion(s, dry.victimPaths ?? [], false); } finally { inj.restore(); }
  check("(S2b) precondition: the broad-union route accepted the union and the unlink was forced to fail", real?.ok === true && inj.hits() >= 1 && fs.existsSync(path.join(MERGE_QUARANTINE_DIR, orphan)));
  check("(S2b) the kept latch is reported", real?.latchKept === true);
  check("(S2b) *** THE FIX *** the real result's reason names the stranded file and the next action", typeof real?.reason === "string" && real.reason.includes(`${CLAUSE} ${orphan}`) && real.reason.includes("remove it by hand, or restart the daemon and clear again"));
}

// ── S3: the still-on-disk filter. A basename visited by TWO sweeps in one call whose FIRST unlink fails once
// (a brief Windows EBUSY) and whose later sweep deletes it must NOT be named: the file is gone.
{
  const { pushPendingQuarantineTestOnly, activeMergeQuarantineFor: activeFor } = await import(pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href);
  const repo = makeRepo("s3");
  const kR = canonicalRepoLockKey(repo);
  const tok = "tok-s3";
  const orphan = `${randomBytes(12).toString("hex")}.json`;
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${quarantineLatchIdFor(repo)}.json`), JSON.stringify({
    repoPath: repo, branch: "b", reason: "active", enteredAt: Date.now() - 5000, tokens: [tok], resolvedKey: kR, orphanLatchFiles: [orphan],
  }));
  reenterMergeQuarantinesAtBoot([repo]);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, orphan), JSON.stringify({ repoPath: repo, branch: "b-stale", reason: "stale duplicate", enteredAt: Date.now(), tokens: [tok], resolvedKey: kR }));
  // A same-identity pending entry listing the SAME orphan: the pending-branch orphan sweep visits it a second time.
  const pendSource = "pending-s3.json";
  const pendEntry = { repoPath: repo, branch: "p", reason: "same-identity pending", enteredAt: Date.now() - 4000, tokens: ["tok-s3-pending"], orphanLatchFiles: [orphan] };
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, pendSource), JSON.stringify(pendEntry));
  pushPendingQuarantineTestOnly(pendEntry, pendSource);
  // Fault ONLY the first unlink of the orphan (brief EBUSY); every later attempt really deletes it.
  const real = fs.unlinkSync;
  const orphanPath = path.join(MERGE_QUARANTINE_DIR, orphan);
  let hits = 0;
  fs.unlinkSync = (p, ...rest) => { if (p === orphanPath && hits++ === 0) throw Object.assign(new Error("EBUSY: simulated transient"), { code: "EBUSY" }); return real(p, ...rest); };
  let res;
  try { res = await call("by-path", { repo }); } finally { fs.unlinkSync = real; }
  const body = res.json();
  check("(S3) precondition: the orphan's first unlink failed AND a later sweep removed it", hits >= 2 && !fs.existsSync(orphanPath));
  check("(S3) precondition: the clear still reports a kept latch (the first failure was recorded)", body.latchKept === true && activeFor(repo) === undefined);
  check("(S3) *** the filter *** a name whose file a later sweep deleted is NOT reported", !JSON.stringify(body).includes(orphan) && !JSON.stringify(body).includes(CLAUSE));
}

await app.close();
db.close?.();
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
console.log(failures === 0 ? "\nALL CHECKS PASS" : `\n${failures} CHECK(S) FAILED.`);
await finishAndExit(failures === 0 ? 0 : 1);
