import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 05a3b6ad — a pending claimant Y cleared by a human must not be re-armed at the next boot because an ACTIVE
// entry E's aspirational "fresh write target" claim kept the file holding only Y's (now cleared) record.
//   A. (the bug) E armed at a fake key, Y pending at E's fresh write target <hash(canonicalKey(E))>.json holding ONLY Y's
//      record, Y resolvable: per pending-clear route (by-recorded-path, by-path, by-id, by-token) the file is gone, the
//      result names no kept file/referencer for E, and a fresh boot does NOT re-arm Y.
//   B. (controls — must stay KEPT) the file also names an uncleared token; the file is corrupt; the file is E's OWN
//      record; a second pending claimant (different identity) shares the file.
//   C. (control) Y unresolvable (`gone`): the file is deleted both before and after the fix.
// Named limits: a failed unlink (EPERM/EBUSY) is not exercised here; a write by ANOTHER process landing between the coverage
// read and the unlink is not closed (see docs/decisions/05a3b6ad-*.md).
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-05a3b6ad-fresh-target-covered-clear.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
useOwnLoomHome("loom-mq05-");
requireHermeticEnv();

const distGitDir = path.join(__dirname, "..", "dist", "git");
const href = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const { MERGE_QUARANTINE_DIR } = await import(href);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const G = "-c user.email=mq05@loom -c user.name=mq05";
const mkRepo = (p) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), p));
  execSync("git init -q", { cwd: d });
  fs.writeFileSync(path.join(d, "f"), "x");
  execSync(`git ${G} add . && git ${G} commit -qm i`, { cwd: d });
  return d;
};
const hashOf = (k) => createHash("sha256").update(k).digest("hex").slice(0, 24);
const rec = (rp, b, t) => ({ repoPath: rp, branch: b, reason: b, enteredAt: Date.now(), tokens: t });

let inst = 0;
const freshModule = () => import(`${href}?i=${++inst}`);
const wipeDir = () => { fs.rmSync(MERGE_QUARANTINE_DIR, { recursive: true, force: true }); fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true }); };
const wipeTombstone = () => { for (const f of fs.readdirSync(path.dirname(MERGE_QUARANTINE_DIR))) if (f.includes("cleared-tokens")) fs.rmSync(path.join(path.dirname(MERGE_QUARANTINE_DIR), f), { force: true }); };

const E = mkRepo("mq05e-");
const Y = mkRepo("mq05y-");
const Y2 = mkRepo("mq05y2-");
const GONE = path.join(os.tmpdir(), `mq05-gone-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
const h2 = hashOf(canonicalRepoLockKey(E));
// Two shapes of E's claim on the file Y is pending at: "fresh" = E's fresh write target <hash(canonicalKey(E))>.json (E armed at a fake key),
// "armed" = E is ARMED at ARMED_KEY and the file is <hash(ARMED_KEY)>.json. Both are settled by the same coverage rule.
const ARMED_KEY = "mq05-armed-key";
const fileFor = (shape) => (shape === "armed" ? `${hashOf(ARMED_KEY)}.json` : `${h2}.json`);
let file = fileFor("fresh");
let filePath = path.join(MERGE_QUARANTINE_DIR, file);

/** Build the shape in a FRESH module instance; `content` is the on-disk body (string) of the file Y is pending at. */
async function setup({ yPath = Y, content, extraPending = false, shape = "fresh" }) {
  wipeDir(); wipeTombstone();
  file = fileFor(shape);
  filePath = path.join(MERGE_QUARANTINE_DIR, file);
  const mq = await freshModule();
  const armedAt = shape === "armed" ? ARMED_KEY : "fakeK1";
  mq.setActiveQuarantineTestOnly(armedAt, { ...rec(E, "e", ["te"]), armedKeys: [armedAt] });
  fs.writeFileSync(filePath, content ?? JSON.stringify(rec(yPath, "y", ["ty"]), null, 2) + "\n");
  mq.pushPendingQuarantineTestOnly(rec(yPath, "y", ["ty"]), file);
  if (extraPending) mq.pushPendingQuarantineTestOnly(rec(Y2, "y2", ["ty2"]), file);
  return mq;
}
const bootBlocks = async (paths, target) => {
  const fresh = await freshModule();
  fresh.reenterMergeQuarantinesAtBoot(paths);
  return !!fresh.activeMergeQuarantineFor(target);
};
const namesE = (res) => JSON.stringify(res).includes(JSON.stringify(E).slice(1, -1));

const routes = {
  "by-recorded-path": (mq, y) => mq.clearMergeQuarantineByRecordedPath(y),
  "by-path": (mq, y) => mq.clearMergeQuarantine(y),
  "by-id": (mq) => mq.clearMergeQuarantineLatchFile(file.replace(/\.json$/, "")),
  "by-token": (mq, y) => { mq.clearMergeQuarantineByToken(y, "ty"); return {}; }, // void route: returns no result to assert on
};

// ---- A: the bug, every pending-clear route, both claim shapes ----
for (const shape of ["fresh", "armed"]) {
  for (const [name, run] of Object.entries(routes)) {
    // by-id with the ARMED-key hash addresses E's own active entry (the active branch lifts E, not Y), so it is not a route that clears Y here.
    if (shape === "armed" && name === "by-id") continue;
    const mq = await setup({ shape });
    const res = run(mq, Y);
    const tag = `A/${shape}/${name}`;
    check(`${tag}: file holding only Y's cleared record is removed`, !fs.existsSync(filePath));
    check(`${tag}: Y is no longer blocked in memory`, !mq.activeMergeQuarantineFor(Y));
    // by-token returns no result object (the route is void), so there is nothing to assert about a disclosure for it; the file/boot checks carry it.
    if (name !== "by-token") check(`${tag}: result does not claim a kept file for E`, !(res.latchKept === true) && !namesE(res));
    check(`${tag}: a fresh boot does NOT re-arm Y`, !(await bootBlocks([E, Y], Y)));
  }
}

// ---- B: controls that must stay kept (uncleared token, E's own record), on every route and both claim shapes ----
for (const shape of ["fresh", "armed"]) {
  for (const [name, run] of Object.entries(routes)) {
    if (shape === "armed" && name === "by-id") continue; // see A: that id addresses E's own entry
    const tag = `B/${shape}/${name}`;
    {
      const mq = await setup({ shape, content: JSON.stringify(rec(Y, "y", ["ty", "uncleared"]), null, 2) + "\n" });
      const res = run(mq, Y);
      check(`${tag} uncleared token in the file: file kept on disk`, fs.existsSync(filePath));
      if (name !== "by-token") check(`${tag} uncleared token: result still discloses the keep for E`, res.latchKept === true);
    }
    {
      const mq = await setup({ shape, content: JSON.stringify(rec(E, "e", ["ty"]), null, 2) + "\n" });
      run(mq, Y);
      check(`${tag} file is E's OWN record: kept on disk`, fs.existsSync(filePath));
    }
  }
}
{
  const mq = await setup({ content: "{ not json" });
  mq.clearMergeQuarantineByRecordedPath(Y);
  check("B2 corrupt content: file kept (coverage unprovable)", fs.existsSync(filePath));
}
{
  const mq = await setup({ extraPending: true });
  mq.clearMergeQuarantineByRecordedPath(Y);
  check("B4 a second pending claimant shares the file: kept", fs.existsSync(filePath));
}

// ---- C: unresolvable Y unchanged ----
{
  const mq = await setup({ yPath: GONE });
  mq.clearMergeQuarantineByRecordedPath(GONE);
  check("C unresolvable Y: file removed", !fs.existsSync(filePath));
  check("C unresolvable Y: a fresh boot does NOT re-arm Y", !(await bootBlocks([E], GONE)));
}

for (const d of [E, Y, Y2]) fs.rmSync(d, { recursive: true, force: true });
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
