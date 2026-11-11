import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 613e4592 — a latch id handed out in route / reason text must, when FOLLOWED, release exactly the named
// claimant and nobody else. Guard under test: routeIdsReleaseOnlyClaimant (merge-quarantine.ts), four clauses:
//   (i) every entry the ids match is the claimant's, (ii) every active AND pending entry of the claimant is matched,
//   (iii) the by-id clear would not refuse an id, (iv) nothing else (a foreign host / a contributor fold) still blocks it.
// Sections:
//   A. multi-file shapes (sibling tmps, json+tmp, json+safety-tmp) x 2 and 3 claimants: for EVERY claimant and EVERY
//      producer (single-file route, two-file route) the id is offered exactly when the table says so, and FOLLOWING what
//      was produced (the id, else the repoPath) releases the named claimant while every other claimant keeps its
//      blocked state, its pending entries and its files.
//   B. mixed active + pending claimant: the text sites (assertRepoNotQuarantined, the clear's still-quarantined reason)
//      print the latch id descriptively but only OFFER {"id":...} when the guard passes.
//   C. clause units, each with a control that flips it: (i)(ii)(iii)(iv-blocker)(iv-contributor), blockedBy.id.
//   D. the round-6 sibling-file shape (c4f0d786 test I) followed through every produced route.
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-613e4592-route-id-releases-exactly-claimant.mjs
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
useOwnLoomHome("loom-mq613-");
requireHermeticEnv();

const distGitDir = path.join(__dirname, "..", "dist", "git");
const href = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const { MERGE_QUARANTINE_DIR } = await import(href);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mq613@loom -c user.name=mq613";
const tmpDirs = [];
const sfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
let moduleCounter = 0;
const freshModule = () => import(`${href}?m=${++moduleCounter}`);
const sha24 = (s) => createHash("sha256").update(s).digest("hex").slice(0, 24);

function makeRepo(tag) {
  const y = path.join(os.tmpdir(), `loom-mq613-${tag}-${sfx()}`);
  fs.mkdirSync(y, { recursive: true });
  tmpDirs.push(y);
  fs.writeFileSync(path.join(y, "README.md"), `# ${tag}\n`);
  execSync("git init -q", { cwd: y });
  commitAll(y, "init", GIT_ID);
  return y;
}
const gone = (tag) => path.join(os.tmpdir(), `loom-mq613-gone-${tag}-${sfx()}`);
const wipeQuarantineDir = () => {
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  for (const f of fs.readdirSync(MERGE_QUARANTINE_DIR)) fs.rmSync(path.join(MERGE_QUARANTINE_DIR, f), { recursive: true, force: true });
};
const rec = (rp, b, tokens) => ({ repoPath: rp, branch: b, reason: b, enteredAt: Date.now(), tokens });
const pendingCount = (mq, p) => mq.listPendingMergeQuarantinesTestOnly().filter((e) => e.repoPath === p).length;
const writeLatch = (name) => fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, name), "{");

// ---- A. multi-file shapes -----------------------------------------------------------------------------------------------------
// j, t1, t2 share the BARE hash id H; each safety-tmp has its own id (a hash of its full basename).
const H = "ab12".repeat(6);
const FILES = {
  j: `${H}.json`,
  t1: `${H}.json.tmp-1111-aa11`,
  t2: `${H}.json.tmp-2222-bb22`,
  s: `${H}.json.tmp-safety-3333-cc33dd44`,
  s2: `${H}.json.tmp-safety-4444-ee55ff66`,
};
// expect: "<claimant>:<producer>" -> is a route id OFFERED? ("both" = the two-file route for a claimant holding exactly two files)
const LAYOUTS = [
  { name: "sibling tmps x2", claimants: { A: ["t1"], B: ["t2"] }, expect: { "A:t1": false, "B:t2": false } },
  { name: "sibling tmps + json x3", claimants: { A: ["t1"], B: ["t2"], C: ["j"] }, expect: { "A:t1": false, "B:t2": false, "C:j": false } },
  { name: "json + tmp x2", claimants: { A: ["j"], B: ["t1"] }, expect: { "A:j": false, "B:t1": false } },
  { name: "json + safety-tmp, one claimant holds both x2", claimants: { A: ["j", "s"], B: ["j"] }, expect: { "A:j": false, "A:s": false, "A:both": false, "B:j": false } },
  { name: "json + safety-tmp x3", claimants: { A: ["j", "s"], B: ["j"], C: ["s"] }, expect: { "A:j": false, "A:s": false, "A:both": false, "B:j": false, "C:s": false } },
  { name: "control: one claimant, two files", claimants: { A: ["j", "s"] }, expect: { "A:j": false, "A:s": false, "A:both": true } },
  { name: "one claimant, THREE files (the two-file route's ids leave the third)", claimants: { A: ["j", "s", "s2"] }, expect: { "A:j": false, "A:s": false, "A:s2": false, "A:both": false } },
  { name: "control: one claimant, one tmp", claimants: { A: ["t1"] }, expect: { "A:t1": true } },
  { name: "distinct ids x2 (json, safety-tmp)", claimants: { A: ["j"], B: ["s"] }, expect: { "A:j": true, "B:s": true } },
  { name: "distinct ids x3 (json, safety-tmp, safety-tmp)", claimants: { A: ["j"], B: ["s"], C: ["s2"] }, expect: { "A:j": true, "B:s": true, "C:s2": true } },
];

try {
  for (const layout of LAYOUTS) {
    for (const [claimant, files] of Object.entries(layout.claimants)) {
      const producers = [...files, ...(files.length >= 2 ? ["both"] : [])]; // "both" = the two-file route over the claimant's first two files
      for (const producer of producers) {
        const key = `${claimant}:${producer}`;
        const label = `[A ${layout.name} | ${key}]`;
        wipeQuarantineDir();
        const mq = await freshModule();
        const paths = Object.fromEntries(Object.keys(layout.claimants).map((n) => [n, gone(n.toLowerCase())]));
        for (const f of new Set(Object.values(layout.claimants).flat())) writeLatch(FILES[f]);
        for (const [n, fl] of Object.entries(layout.claimants)) for (const f of fl) mq.pushPendingQuarantineTestOnly(rec(paths[n], `${n}-${f}`, [`tok-${n}-${f}`]), FILES[f]);
        const others = Object.keys(layout.claimants).filter((n) => n !== claimant);
        const co = producer === "both"
          ? mq.blockedCoOccupantBothRoutesTestOnly(paths[claimant], FILES[files[0]], FILES[files[1]])
          : mq.blockedCoOccupantTestOnly(paths[claimant], FILES[producer]);
        check(`${label} (precondition) the route names the claimant's own repoPath`, co.route.repoPath === paths[claimant]);
        check(`${label} *** 613e4592 *** a route id is ${layout.expect[key] ? "OFFERED" : "WITHHELD (the repoPath route stands in)"}`, (co.route.id !== undefined) === layout.expect[key]);
        // Follow EVERYTHING the producer handed out.
        if (co.route.id !== undefined) {
          mq.clearMergeQuarantineLatchFile(co.route.id);
          if (co.alsoClear?.id !== undefined) mq.clearMergeQuarantineLatchFile(co.alsoClear.id);
        } else {
          mq.clearMergeQuarantineByRecordedPath(paths[claimant]);
        }
        check(`${label} following it RELEASES ${claimant}`, !mq.activeMergeQuarantineFor(paths[claimant]));
        for (const o of others) {
          const want = layout.claimants[o].length;
          check(`${label} ${o} is untouched: still blocked, ${want} pending entr${want === 1 ? "y" : "ies"}, every file it names on disk`,
            !!mq.activeMergeQuarantineFor(paths[o]) && pendingCount(mq, paths[o]) === want && layout.claimants[o].every((f) => fs.existsSync(path.join(MERGE_QUARANTINE_DIR, FILES[f]))));
        }
      }
    }
  }

  // ---- B. text sites: a mixed active + pending claimant --------------------------------------------------------------------------
  {
    const OFFER = '{"id":';
    const build = async (extraPendingFile) => {
      wipeQuarantineDir();
      const mq = await freshModule();
      const g = gone("txt");
      const key = mq.directPathIdentity(g);
      const active = { ...rec(g, "act", ["tok-act"]), armedKeys: [key] };
      mq.setActiveQuarantineTestOnly(key, active);
      const activeId = mq.quarantineLatchFileIdsFor(active)[0];
      const pendingFile = extraPendingFile?.(activeId);
      if (pendingFile) { writeLatch(pendingFile); mq.pushPendingQuarantineTestOnly(rec(g, "pend", ["tok-pend"]), pendingFile); }
      return { mq, g, activeId };
    };
    {
      const { mq, g, activeId } = await build();
      const r = mq.assertRepoNotQuarantined(g);
      check("[B1 assertRepoNotQuarantined, active only] (control) the id is still printed descriptively AND offered", !r.ok && r.reason.includes(`latch id '${activeId}'`) && r.reason.includes(`${OFFER}"${activeId}"}`));
    }
    {
      const { mq, g, activeId } = await build(() => `${H}.json`);
      const r = mq.assertRepoNotQuarantined(g);
      check("[B2 assertRepoNotQuarantined, active + pending on ANOTHER id] *** 613e4592 *** the id is printed but NOT offered as an action", !r.ok && r.reason.includes(`latch id '${activeId}'`) && !r.reason.includes(OFFER) && r.reason.includes('{"repoPath":'));
      mq.clearMergeQuarantineByRecordedPath(g);
      check("[B2] following the repoPath route releases it", !mq.activeMergeQuarantineFor(g));
    }
    {
      const { mq, g, activeId } = await build((id) => `${id}.json.tmp-5555-dd55`);
      const r = mq.assertRepoNotQuarantined(g);
      check("[B3 assertRepoNotQuarantined, active + pending on the SAME id] *** 613e4592 *** the by-id clear takes the ACTIVE branch and leaves the same-id pending entry, so the id is NOT offered", !r.ok && r.reason.includes(`latch id '${activeId}'`) && !r.reason.includes(OFFER));
      const probe = mq.clearMergeQuarantineLatchFile(activeId);
      check("[B3] (evidence) following that id really does leave the claimant blocked by its pending entry", probe.stillQuarantined === true && !!mq.activeMergeQuarantineFor(g) && pendingCount(mq, g) === 1);
      mq.clearMergeQuarantineByRecordedPath(g);
      check("[B3] following the repoPath route releases it (both entries)", !mq.activeMergeQuarantineFor(g) && pendingCount(mq, g) === 0);
    }
    // stillQuarantinedReason: Q (a real repo) has no entry; a foreign host H armed at Q's key blocks it.
    const buildHost = async (withOtherIdPending) => {
      wipeQuarantineDir();
      const mq = await freshModule();
      const q = makeRepo("txt-q");
      const hostPath = gone("txt-host");
      const key = canonicalRepoLockKey(q);
      const host = { ...rec(hostPath, "host", ["tok-host"]), armedKeys: [key] };
      mq.setActiveQuarantineTestOnly(key, host);
      const hostId = mq.quarantineLatchFileIdsFor(host)[0];
      if (withOtherIdPending) { writeLatch(`${H}.json`); mq.pushPendingQuarantineTestOnly(rec(hostPath, "host-pend", ["tok-host-pend"]), `${H}.json`); }
      return { mq, q, hostPath, hostId };
    };
    {
      const { mq, q, hostId } = await buildHost(false);
      const r = mq.clearMergeQuarantineByRecordedPath(q);
      check("[B4 still-quarantined reason, host holds only that id] (control) names the host's id and offers it", typeof r.reason === "string" && r.reason.includes(`latch id '${hostId}'`) && r.reason.includes(`${OFFER}"${hostId}"}`));
    }
    {
      const { mq, q, hostPath, hostId } = await buildHost(true);
      const r = mq.clearMergeQuarantineByRecordedPath(q);
      check("[B5 still-quarantined reason, host ALSO pending on another id] *** 613e4592 *** the id is named, not offered; the host's repoPath is", typeof r.reason === "string" && r.reason.includes(`latch id '${hostId}'`) && !r.reason.includes(OFFER) && r.reason.includes(JSON.stringify({ repoPath: hostPath })));
      mq.clearMergeQuarantineByRecordedPath(hostPath);
      check("[B5] following the host's repoPath route releases the host and then Q", !mq.activeMergeQuarantineFor(hostPath) && !mq.activeMergeQuarantineFor(q));
    }
  }

  // ---- C. clause units ---------------------------------------------------------------------------------------------------------------
  {
    const guard = (mq, p, ids) => mq.routeIdsReleaseOnlyClaimantTestOnly(p, ids);
    // (i) an id that also matches ANOTHER identity's entry
    {
      wipeQuarantineDir();
      const mq = await freshModule();
      const a = gone("c-i-a"), b = gone("c-i-b"), c = gone("c-i-c");
      mq.pushPendingQuarantineTestOnly(rec(a, "a", ["ta"]), FILES.j);
      mq.pushPendingQuarantineTestOnly(rec(b, "b", ["tb"]), FILES.t1);
      mq.pushPendingQuarantineTestOnly(rec(c, "c", ["tc"]), FILES.s);
      check("[C(i)] an id shared with another identity's pending entry is withheld", guard(mq, a, [H]) === false);
      check("[C(i)] (control) an id only the claimant's own entry matches is offered", guard(mq, c, [sha24(FILES.s)]) === true);
    }
    // (ii) pending entry left behind, and active entry left behind
    {
      wipeQuarantineDir();
      const mq = await freshModule();
      const a = gone("c-ii-a");
      mq.pushPendingQuarantineTestOnly(rec(a, "a1", ["ta1"]), FILES.j);
      mq.pushPendingQuarantineTestOnly(rec(a, "a2", ["ta2"]), FILES.s);
      check("[C(ii) pending] one id leaving a second pending entry of the claimant is withheld", guard(mq, a, [H]) === false);
      check("[C(ii) pending] (control) both ids together are offered", guard(mq, a, [H, sha24(FILES.s)]) === true);
    }
    {
      wipeQuarantineDir();
      const mq = await freshModule();
      const a = gone("c-ii-act");
      const key = mq.directPathIdentity(a);
      const active = { ...rec(a, "act", ["tact"]), armedKeys: [key] };
      mq.setActiveQuarantineTestOnly(key, active);
      const activeId = mq.quarantineLatchFileIdsFor(active)[0];
      mq.pushPendingQuarantineTestOnly(rec(a, "pend", ["tpend"]), FILES.j);
      check("[C(ii) active] the pending entry's id leaving the claimant's ACTIVE entry behind is withheld", guard(mq, a, [H]) === false);
      check("[C(ii) active] the active id leaving the claimant's PENDING entry behind is withheld", guard(mq, a, [activeId]) === false);
      check("[C(ii) active] (control) both ids together are offered", guard(mq, a, [activeId, H]) === true);
      mq.pushPendingQuarantineTestOnly(rec(a, "pend2", ["tpend2"]), `${activeId}.json.tmp-6666-ee66`);
      check("[C(ii) active] a pending entry sharing the ACTIVE id is not removed by the active branch: the active id alone is withheld", guard(mq, a, [activeId, H]) === false);
    }
    // (iii) the by-id clear refuses the id (an active union of unknown provenance)
    {
      wipeQuarantineDir();
      const mq = await freshModule();
      const a = gone("c-iii-a");
      const key = mq.directPathIdentity(a);
      const entry = { ...rec(a, "act", ["tact"]), armedKeys: [key], provenanceUnknown: true };
      mq.setActiveQuarantineTestOnly(key, entry);
      const id = mq.quarantineLatchFileIdsFor(entry)[0];
      check("[C(iii)] (precondition) the by-id clear would refuse this id", mq.routeIdWouldBeRefusedTestOnly(id) === true);
      check("[C(iii)] an id the by-id clear refuses is withheld even though (i)(ii)(iv) hold", guard(mq, a, [id]) === false);
      const mq2 = await freshModule();
      const entry2 = { ...rec(a, "act", ["tact"]), armedKeys: [key] };
      mq2.setActiveQuarantineTestOnly(key, entry2);
      check("[C(iii)] (control) the same shape without provenanceUnknown is offered", guard(mq2, a, [mq2.quarantineLatchFileIdsFor(entry2)[0]]) === true);
    }
    // (iv) another identity still blocks the claimant: a foreign host holds its key
    {
      wipeQuarantineDir();
      const mq = await freshModule();
      const q = makeRepo("c-iv-q");
      const host = gone("c-iv-host");
      const key = canonicalRepoLockKey(q);
      mq.setActiveQuarantineTestOnly(key, { ...rec(host, "host", ["thost"]), armedKeys: [key] });
      mq.pushPendingQuarantineTestOnly(rec(q, "q", ["tq"]), FILES.t1);
      check("[C(iv) blocker] (precondition) Q's only blocker is a different identity", mq.stillBlockedEntryFor(q)?.repoPath === host);
      check("[C(iv) blocker] Q's own id would not release it (the host still blocks): withheld", guard(mq, q, [H]) === false);
      const mq2 = await freshModule();
      mq2.pushPendingQuarantineTestOnly(rec(q, "q", ["tq"]), FILES.t1);
      check("[C(iv) blocker] (control) with no host, the same id is offered", guard(mq2, q, [H]) === true);
    }
    // (iv) a surviving entry folds the claimant in as a contributor
    {
      wipeQuarantineDir();
      const mq = await freshModule();
      const z = gone("c-iv-z");
      const x = makeRepo("c-iv-x");
      const keyX = canonicalRepoLockKey(x);
      mq.pushPendingQuarantineTestOnly(rec(z, "z", ["tz"]), FILES.s);
      mq.setActiveQuarantineTestOnly(keyX, { ...rec(x, "x", ["tx"]), armedKeys: [keyX], contributorRepoPaths: [z] });
      check("[C(iv) contributor] (precondition) Z's own pending entry is what stillBlockedEntryFor names", mq.stillBlockedEntryFor(z)?.repoPath === z);
      check("[C(iv) contributor] an id that leaves Z folded into X's union is withheld", guard(mq, z, [sha24(FILES.s)]) === false);
      const mq2 = await freshModule();
      mq2.pushPendingQuarantineTestOnly(rec(z, "z", ["tz"]), FILES.s);
      check("[C(iv) contributor] (control) without the fold the id is offered", guard(mq2, z, [sha24(FILES.s)]) === true);
    }
    // blockedBy.id (classifyKeptRepoPath): the host's id is named only when it releases the HOST exactly
    for (const withOtherPending of [false, true]) {
      wipeQuarantineDir();
      const mq = await freshModule();
      const q = makeRepo(`c-by-${withOtherPending}`);
      const host = gone(`c-by-host-${withOtherPending}`);
      const key = canonicalRepoLockKey(q);
      const hostEntry = { ...rec(host, "host", ["thost"]), armedKeys: [key] };
      mq.setActiveQuarantineTestOnly(key, hostEntry);
      const hostId = mq.quarantineLatchFileIdsFor(hostEntry)[0];
      if (withOtherPending) mq.pushPendingQuarantineTestOnly(rec(host, "host-pend", ["thp"]), FILES.j);
      const k = mq.classifyKeptRepoPathTestOnly(q, FILES.t1);
      check(`[C blockedBy ${withOtherPending ? "host also pending on another id" : "control"}] Q is content-kept, blocked by the host`, k.live === false && k.blockedBy?.repoPath === host);
      check(`[C blockedBy ${withOtherPending ? "host also pending on another id" : "control"}] *** 613e4592 *** blockedBy.id is ${withOtherPending ? "WITHHELD" : "the host's id"}`, withOtherPending ? k.blockedBy?.id === undefined : k.blockedBy?.id === hostId);
    }
  }

  // ---- D. round-6 sibling-file shape (c4f0d786 test I): y's reduced entry on tmp-B, z1 on tmp-A, a foreign host holds y's key -------
  {
    const base0 = makeRepo("d-sib");
    const y = path.join(base0, "sub");
    fs.mkdirSync(y, { recursive: true });
    const other = makeRepo("d-foreign");
    const z1 = gone("d-z1");
    wipeQuarantineDir();
    const mq = await freshModule();
    const freshKey = canonicalRepoLockKey(y);
    const id = mq.directPathIdentity(y);
    const hId = sha24(id);
    const tA = `${hId}.json.tmp-77777-abc123`;
    const tB = `${hId}.json.tmp-88888-def456`;
    mq.setActiveQuarantineTestOnly(freshKey, { ...rec(other, "f", ["tf"]), armedKeys: [freshKey] });
    mq.setActiveQuarantineTestOnly(id, { ...rec(y, "a", ["ta"]), armedKeys: [id] });
    writeLatch(tA);
    mq.pushPendingQuarantineTestOnly(rec(y, "q", ["tq"]), tA);
    mq.pushPendingQuarantineTestOnly(rec(z1, "z1", ["tz1"]), tA);
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, tB), JSON.stringify(rec(y, "q2", ["tq2"]), null, 2) + "\n");
    mq.pushPendingQuarantineTestOnly({ ...rec(y, "q2", ["tq2"]), armedKeys: [id] }, tB);
    const res = mq.clearMergeQuarantine(y);
    const cos = res.stillBlockedCoOccupants ?? [];
    const ids = cos.flatMap((c) => [c.route.id, c.alsoClear?.id]).filter((v) => v !== undefined);
    check("[D] (precondition) z1 is named and y's reduced entry survives on tmp-B", cos.some((c) => c.repoPath === z1) && listPending(mq).some((p) => p.repoPath === y && p.sourceFile === tB));
    check("[D] *** 613e4592 *** the bare-hash id (shared by tmp-A and tmp-B) is offered to NOBODY", ids.length === 0);
    check("[D] *** 613e4592 *** y is content-kept and its blocker is the foreign host", (res.contentKeptBlockedBy ?? []).some((e) => e.repoPath === y && e.blockedBy.repoPath === other));
    const zRoute = cos.find((c) => c.repoPath === z1)?.route;
    check("[D] z1's produced route is the plain repoPath route", zRoute?.repoPath === z1 && zRoute?.id === undefined);
    mq.clearMergeQuarantineByRecordedPath(z1);
    check("[D] following z1's route releases z1", !mq.activeMergeQuarantineFor(z1));
    check("[D] ... and leaves y's reduced entry (and its file) alone, y still blocked", listPending(mq).some((p) => p.repoPath === y && p.sourceFile === tB) && fs.existsSync(path.join(MERGE_QUARANTINE_DIR, tB)) && !!mq.stillBlockedEntryFor(y));
  }

  // ---- E. a "still blocked" list names ONLY what the in-memory oracle says is blocked (resolved ruling) ---------------------------------
  // E is armed at a fake key; Y's pending entry names the file `<hash(K2)>.json` that E would write. E physically owns that file but
  // stillBlockedEntryFor / assertRepoNotQuarantined say E is NOT blocked, so E is disclosed as content-kept, never as a blocked co-occupant.
  {
    const E = makeRepo("e-owner");
    const Y = makeRepo("e-victim");
    wipeQuarantineDir();
    const mq = await freshModule();
    const f = `${sha24(canonicalRepoLockKey(E))}.json`;
    mq.setActiveQuarantineTestOnly("fakeK1-613e4592", { ...rec(E, "e", ["te"]), armedKeys: ["fakeK1-613e4592"] });
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, f), JSON.stringify(rec(Y, "y", ["ty"]), null, 2) + "\n");
    mq.pushPendingQuarantineTestOnly(rec(Y, "y", ["ty"]), f);
    const res = mq.clearMergeQuarantine(Y);
    const eCo = (res.stillBlockedCoOccupants ?? []).find((c) => c.repoPath === E);
    check("[E] (precondition) the kept file is disclosed: latchKept, E is content-kept", res.latchKept === true && (res.contentKeptRepoPaths ?? []).includes(E));
    check("[E] *** 613e4592 *** E is NOT in stillBlockedCoOccupants (the in-memory oracle says it is not blocked), so it is offered no route and no id", eCo === undefined && !(res.referencingRepoPaths ?? []).includes(E));
    check("[E] (evidence) E is NOT blocked as far as enforcement and the in-memory oracle go: its active entry sits at a stale key", mq.assertRepoNotQuarantined(E).ok === true && !mq.stillBlockedEntryFor(E));
  }

  // ---- F (round 2). (iv) is judged AFTER the matched entries are gone: an UNRESOLVABLE claimant's own entry must not hide a foreign blocker ----
  {
    const build = async (withForeign) => {
      wipeQuarantineDir();
      const mq = await freshModule();
      const x = gone("f-x");
      const f = gone("f-foreign");
      const key = canonicalRepoLockKey(x);
      writeLatch(FILES.t1);
      mq.pushPendingQuarantineTestOnly(rec(x, "x", ["tx"]), FILES.t1);
      if (withForeign) mq.setActiveQuarantineTestOnly(key, { ...rec(f, "f", ["tf"]), armedKeys: [key] });
      return { mq, x, f };
    };
    {
      const { mq, x, f } = await build(true);
      check("[F] (precondition) the current-state lookup sees only X's OWN entry (the blindness this closes)", mq.stillBlockedEntryFor(x)?.repoPath === x);
      check("[F] *** round 2 *** the guard withholds X's id: F still blocks X once X's entry is gone", mq.routeIdsReleaseOnlyClaimantTestOnly(x, [H]) === false);
      check("[F] blockedCoOccupant(X) offers no id", mq.blockedCoOccupantTestOnly(x, FILES.t1).route.id === undefined);
      const asserted = mq.assertRepoNotQuarantined(x);
      check("[F] assertRepoNotQuarantined(X) does not OFFER the id", !asserted.ok && !asserted.reason.includes('{"id":'));
      const k = mq.classifyKeptRepoPathTestOnly(x, FILES.t1);
      check("[F] *** round 4 *** X is classified LIVE (its own entry is oracle-blocked, so it keeps its id-less {repoPath} route) AND the disclosure names F as the blocker, both at once", k.live === true && k.coOccupant.route.id === undefined && k.coOccupant.route.repoPath === x && k.blockedBy?.repoPath === f);
    }
    {
      const { mq, x } = await build(false);
      check("[F] (control) with no foreign blocker the same id is offered", mq.routeIdsReleaseOnlyClaimantTestOnly(x, [H]) === true && mq.blockedCoOccupantTestOnly(x, FILES.t1).route.id === H);
    }
  }

  // ---- I (round 3). the exclusion INSIDE the peek / findPendingIndicesFor: a RESOLVABLE claimant's own entry must not hide a sibling that
  // shares its canonical key (a resolvable pending entry of a subdirectory identity collapses onto R's key once R's own entry is gone).
  {
    const R = makeRepo("i-r");
    const sub = path.join(R, "sub");
    fs.mkdirSync(sub, { recursive: true });
    const older = Date.now() - 100000;
    // I1: R is PENDING-only (findPendingIndicesFor tier 1 would find R's own entry unless it is excluded).
    for (const withSibling of [true, false]) {
      wipeQuarantineDir();
      const mq = await freshModule();
      const fR = `${"cd34".repeat(6)}.json`;
      writeLatch(fR);
      mq.pushPendingQuarantineTestOnly({ ...rec(R, "r", ["tr"]), enteredAt: older }, fR);
      if (withSibling) { writeLatch(FILES.s); mq.pushPendingQuarantineTestOnly(rec(sub, "sub", ["tsub"]), FILES.s); }
      check(`[I1 pending claimant${withSibling ? " + resolvable sibling on its key" : " (control)"}] *** round 3 *** the id is ${withSibling ? "WITHHELD: the sibling still blocks R once R's own entry is gone" : "offered"}`,
        mq.routeIdsReleaseOnlyClaimantTestOnly(R, ["cd34".repeat(6)]) === !withSibling);
    }
    // I2: R's own ACTIVE entry is the armed `direct`; a resolvable pending sibling shares the key. The id is already refused as ambiguous, so the
    // claimant classification (own entries excluded) is what must see the sibling: content-kept, blockedBy the sibling, NOT live.
    for (const withSibling of [true, false]) {
      wipeQuarantineDir();
      const mq = await freshModule();
      const key = canonicalRepoLockKey(R);
      const active = { ...rec(R, "r", ["tr"]), enteredAt: older, armedKeys: [key] };
      mq.setActiveQuarantineTestOnly(key, active);
      const idR = mq.quarantineLatchFileIdsFor(active)[0];
      if (withSibling) { writeLatch(FILES.s); mq.pushPendingQuarantineTestOnly(rec(sub, "sub", ["tsub"]), FILES.s); }
      const k = mq.classifyKeptRepoPathTestOnly(R, `${idR}.json`);
      check(`[I2 active direct claimant${withSibling ? " + resolvable sibling on its key" : " (control)"}] *** round 4 *** ${withSibling ? "live with an id-less {repoPath} route AND blocked by the sibling" : "live, with its id"}`,
        withSibling ? (k.live === true && k.coOccupant.route.id === undefined && k.coOccupant.route.repoPath === R && k.blockedBy?.repoPath === sub) : (k.live === true && k.coOccupant.route.id === idR && k.blockedBy === undefined));
    }
  }

  // ---- G (round 2). mergeKeptAndRelocatedCoOccupant judges the UNION of its two inputs' ids ----------------------------------------------
  for (const entries of [2, 3]) {
    const label = `[G merge x${entries} entries]`;
    wipeQuarantineDir();
    const mq = await freshModule();
    const a = gone(`g-${entries}`);
    const names = [FILES.j, FILES.s, FILES.s2].slice(0, entries);
    for (const n of names) { writeLatch(n); mq.pushPendingQuarantineTestOnly(rec(a, `a-${n}`, [`tok-${n}`]), n); }
    const relocCo = mq.blockedCoOccupantTestOnly(a, FILES.j);
    const keptCo = mq.blockedCoOccupantTestOnly(a, FILES.s);
    check(`${label} (precondition) each input route was judged ALONE and its id withheld (the claimant has more than one entry)`, relocCo.route.id === undefined && keptCo.route.id === undefined);
    const merged = mq.mergeKeptAndRelocatedCoOccupantTestOnly(relocCo, keptCo);
    if (entries === 2) {
      check(`${label} *** round 2 *** the union of both ids releases the claimant: id1 then id2 are handed out`, merged.route.id === H && merged.alsoClear?.id === sha24(FILES.s));
      mq.clearMergeQuarantineLatchFile(merged.route.id);
      mq.clearMergeQuarantineLatchFile(merged.alsoClear.id);
      check(`${label} following id1 then id2 releases the claimant`, !mq.activeMergeQuarantineFor(a));
    } else {
      check(`${label} the union still leaves a third entry: no id is offered, the repoPath route stands in`, merged.route.id === undefined && merged.alsoClear === undefined && merged.route.repoPath === a);
      mq.clearMergeQuarantineByRecordedPath(a);
      check(`${label} following the repoPath route releases the claimant`, !mq.activeMergeQuarantineFor(a));
    }
  }

  // ---- H (round 2). repoPathStepFollows: exactly ONE of the two ids is refused; the other step is a {repoPath} clear -------------------------------
  for (const foreignSharesId of [false, true]) {
    const label = `[H one-refused ${foreignSharesId ? "foreign shares the live id" : "control"}]`;
    wipeQuarantineDir();
    const mq = await freshModule();
    const a = gone(`h-a-${foreignSharesId}`);
    const b = gone(`h-b-${foreignSharesId}`);
    writeLatch(FILES.j); writeLatch(FILES.s);
    mq.pushPendingQuarantineTestOnly(rec(a, "a-j", ["taj"]), FILES.j);
    mq.pushPendingQuarantineTestOnly({ ...rec(a, "a-s", ["tas"]), provenanceUnknown: true }, FILES.s); // its id is refused by the by-id clear
    if (foreignSharesId) mq.pushPendingQuarantineTestOnly(rec(b, "b-j", ["tbj"]), `${H}.json.tmp-9999-ff99`);
    check(`${label} (precondition) exactly one of the two ids is refused`, mq.routeIdWouldBeRefusedTestOnly(sha24(FILES.s)) === true && mq.routeIdWouldBeRefusedTestOnly(H) === false);
    const co = mq.blockedCoOccupantBothRoutesTestOnly(a, FILES.j, FILES.s);
    if (!foreignSharesId) {
      check(`${label} *** round 2 *** the live id is offered for the first step, the second step is an id-less repoPath step`, co.route.id === H && co.alsoClear?.id === undefined && co.alsoClear?.repoPath === a);
      mq.clearMergeQuarantineLatchFile(co.route.id);
      mq.clearMergeQuarantineByRecordedPath(a);
      check(`${label} following both steps releases the claimant`, !mq.activeMergeQuarantineFor(a));
    } else {
      check(`${label} the live id also matches another identity: no id at all, plain repoPath route`, co.route.id === undefined && co.alsoClear === undefined);
      mq.clearMergeQuarantineByRecordedPath(a);
      check(`${label} following the repoPath route releases the claimant and leaves the other identity blocked`, !mq.activeMergeQuarantineFor(a) && !!mq.activeMergeQuarantineFor(b));
    }
  }

  // ---- J (round 4). a claimant that is BOTH oracle-blocked by its own entry AND held behind a foreign blocker is a LIVE co-occupant with its id-less
  // {repoPath} route AND names the blocker (`contentKeptBlockedBy`) in the SAME first result, with the order "blocker, then claimant" in the reason.
  // Each shape is FOLLOWED step by step in the order the result gives it; the claimant ends released and a bystander is untouched.
  const idents = (mq) => [...mq.listActiveMergeQuarantines().map((q) => q.repoPath), ...mq.listPendingMergeQuarantinesTestOnly().map((p) => p.repoPath)];
  const followRoundFour = async (label, mq, first, claimant, blocker, bystander, mutantRegression) => {
    const co = (first.stillBlockedCoOccupants ?? []).find((c) => c.repoPath === claimant);
    check(`${label} the FIRST result names the claimant's own {repoPath} step (live co-occupant, no id)`, co !== undefined && co.route.id === undefined && co.route.repoPath === claimant && (first.referencingRepoPaths ?? []).includes(claimant));
    const blockedBy = (first.contentKeptBlockedBy ?? []).find((e) => e.repoPath === claimant)?.blockedBy;
    check(`${label} the FIRST result records blockedBy naming the foreign blocker, and the claimant is NOT content-kept`, blockedBy?.repoPath === blocker && !(first.contentKeptRepoPaths ?? []).includes(claimant));
    const reason = first.reason ?? "";
    const iBlocker = reason.indexOf(`clear '${blocker}' first`);
    const iClaimant = reason.indexOf(`THEN clear '${claimant}'`);
    check(`${label} the reason renders the order: blocker first, then claimant, naming both`, iBlocker >= 0 && iClaimant > iBlocker);
    const before = idents(mq);
    // follow EVERY step in the order the result gives it
    const steps = [blockedBy ? { id: blockedBy.id, repoPath: blockedBy.repoPath } : undefined, co ? { id: co.route.id, repoPath: co.route.repoPath } : undefined].filter(Boolean);
    for (const s of steps) { if (s.id) mq.clearMergeQuarantineLatchFile(s.id); else mq.clearMergeQuarantine(s.repoPath); }
    check(`${label} following every step releases the claimant (oracle undefined, not quarantined)`, mq.stillBlockedEntryFor(claimant) === undefined && mq.assertRepoNotQuarantined(claimant).ok === true);
    const after = idents(mq);
    check(`${label} nothing else was released: the bystander stays, and only the claimant/blocker entries left`, after.includes(bystander) && after.every((p) => before.includes(p)) && before.filter((p) => !after.includes(p)).every((p) => p === claimant || p === blocker));
    void mutantRegression;
  };
  {
    wipeQuarantineDir();
    const mq = await freshModule();
    const x = gone("j-f-x"), f = gone("j-f-f"), w = gone("j-f-w"), z = gone("j-f-z");
    writeLatch(FILES.t1); writeLatch(FILES.t2);
    const key = canonicalRepoLockKey(x);
    mq.pushPendingQuarantineTestOnly(rec(x, "x", ["tx"]), FILES.t1);
    mq.pushPendingQuarantineTestOnly(rec(w, "w", ["tw"]), FILES.t1);
    mq.pushPendingQuarantineTestOnly(rec(z, "z", ["tz"]), FILES.t2);
    mq.setActiveQuarantineTestOnly(key, { ...rec(f, "f", ["tf"]), armedKeys: [key] });
    await followRoundFour("[F follow]", mq, mq.clearMergeQuarantine(w), x, f, z);
  }
  {
    // I1: R pending-only, a resolvable sub-identity sibling collapses onto its key once R's own entry is gone.
    const R = makeRepo("j-i1-r");
    const sub = path.join(R, "sub");
    fs.mkdirSync(sub, { recursive: true });
    wipeQuarantineDir();
    const mq = await freshModule();
    const w = gone("j-i1-w"), z = gone("j-i1-z");
    const fR = `${"cd34".repeat(6)}.json`;
    writeLatch(fR); writeLatch(FILES.s); writeLatch(FILES.t2);
    mq.pushPendingQuarantineTestOnly({ ...rec(R, "r", ["tr"]), enteredAt: Date.now() - 100000 }, fR);
    mq.pushPendingQuarantineTestOnly(rec(w, "w", ["tw"]), fR);
    mq.pushPendingQuarantineTestOnly(rec(sub, "sub", ["tsub"]), FILES.s);
    mq.pushPendingQuarantineTestOnly(rec(z, "z", ["tz"]), FILES.t2);
    await followRoundFour("[I1 follow]", mq, mq.clearMergeQuarantine(w), R, sub, z);
  }
  {
    // I2: R's own ACTIVE entry is the armed `direct`, a resolvable pending sibling shares its key.
    const R = makeRepo("j-i2-r");
    const sub = path.join(R, "sub");
    fs.mkdirSync(sub, { recursive: true });
    wipeQuarantineDir();
    const mq = await freshModule();
    const w = gone("j-i2-w"), z = gone("j-i2-z");
    const key = canonicalRepoLockKey(R);
    const active = { ...rec(R, "r", ["tr"]), enteredAt: Date.now() - 100000, armedKeys: [key] };
    mq.setActiveQuarantineTestOnly(key, active);
    const fR = `${mq.quarantineLatchFileIdsFor(active)[0]}.json`;
    writeLatch(fR); writeLatch(FILES.s); writeLatch(FILES.t2);
    mq.pushPendingQuarantineTestOnly(rec(w, "w", ["tw"]), fR);
    mq.pushPendingQuarantineTestOnly(rec(sub, "sub", ["tsub"]), FILES.s);
    mq.pushPendingQuarantineTestOnly(rec(z, "z", ["tz"]), FILES.t2);
    await followRoundFour("[I2 follow]", mq, mq.clearMergeQuarantine(w), R, sub, z);
  }
} finally {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
}

function listPending(mq) { return mq.listPendingMergeQuarantinesTestOnly(); }

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
