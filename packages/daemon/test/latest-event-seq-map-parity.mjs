import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card dd494a9b: `Db.buildLatestEventSeqMap(kind)` precomputes, in ONE pass, what
// `Db.latestEventSeqForBranch(branch, kind, repoKey)` used to answer per call — replacing the O(N
// sessions × M events) scan-in-a-loop that was boot-reconcile's own dominant cost (96% of a ~7-minute
// stall, measured via --cpu-prof against a sanitized copy of the real production DB).
//
// This test proves EXACT PARITY: for every (branch, kind, repoKey) combination in a fixture with MIXED
// repoKeys (null / "primary" / "other"), re-tasked REUSED branch names, and both event kinds, the map's
// answer must equal `latestEventSeqForBranch`'s own answer — the oracle, unchanged by this card.
//
// It also runs a SANITY CHECK, not independent proof (the naive variant below is itself built from the
// oracle's own per-call answers, so it cannot certify a real repoKey-blind implementation would fail —
// only that collapsing repoKey scopes loses information the real map preserves): a deliberately-naive
// map variant that ignores repoKey scoping entirely (the exact defect class `latestEventSeqForBranch`'s
// own repoKey filter — @decision 9ac3a739 — exists to prevent) disagrees with the real map's scoped
// answer on a case where the two scopes genuinely differ.
// Run: 1) build daemon, 2) node test/latest-event-seq-map-parity.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-lesm-parity-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db, latestEventSeqMapKey } = await import("../dist/db.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const db = new Db();
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Minimal project/task/manager scaffold — appendEvent only needs valid FK rows to exist if it tries to
// derive a projectId for a durable-audit kind; merge_done/merge_request aren't in DURABLE_AUDIT_EVENT_KINDS,
// so this is purely to keep the fixture realistic, not a hard requirement of the functions under test.
const projId = `lesm-proj-${sfx}`, agentId = `lesm-agent-${sfx}`, taskId = `lesm-task-${sfx}`, mgrId = `lesm-mgr-${sfx}`;
db.insertProject({ id: projId, name: "LESM", repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
db.insertTask({ id: taskId, projectId: projId, title: "LESM", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: os.tmpdir(), processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

function fileEvent(kind, branch, repoKey) {
  db.appendEvent({ id: randomUUID(), ts: new Date().toISOString(), managerSessionId: mgrId, workerSessionId: null, taskId, kind, detail: { branch, repoKey } });
}

// Fixture: mixed repoKeys on the SAME branch name (re-tasked / multi-repo shape), both kinds.
const BRANCH_A = `loom/lesm-a-${sfx}`; // three independent repoKey scopes on the SAME branch name
const BRANCH_B = `loom/lesm-b-${sfx}`; // a branch that only ever gets a merge_request, never a merge_done
const BRANCH_C = `loom/lesm-c-${sfx}`; // never mentioned at all — must resolve to null/undefined everywhere

fileEvent("merge_request", BRANCH_A, null);
fileEvent("merge_done", BRANCH_A, null);          // primary scope: request then done
fileEvent("merge_request", BRANCH_A, "primary");  // a LITERAL "primary" string — must be its OWN scope,
fileEvent("merge_done", BRANCH_A, "primary");     // never coalesced with null (raw === comparison)
fileEvent("merge_request", BRANCH_A, "other");    // a third, independent repo scope
fileEvent("merge_done", BRANCH_A, "other");
// Re-task shape on BRANCH_A's primary scope: a SECOND, later request+done pair — proves "latest" (max
// seq), not "first", is what both functions return.
fileEvent("merge_request", BRANCH_A, null);
fileEvent("merge_done", BRANCH_A, null);

fileEvent("merge_request", BRANCH_B, null); // no merge_done ever filed for this branch/scope

const repoKeysToProbe = [null, "primary", "other", "nonexistent-scope"];
const branchesToProbe = [BRANCH_A, BRANCH_B, BRANCH_C];
const kindsToProbe = ["merge_done", "merge_request"];

// ════════ PARITY: the real map agrees with the oracle on EVERY probed combination ════════
for (const kind of kindsToProbe) {
  const map = db.buildLatestEventSeqMap(kind);
  for (const branch of branchesToProbe) {
    for (const repoKey of repoKeysToProbe) {
      const oracle = db.latestEventSeqForBranch(branch, kind, repoKey);
      const viaMap = map.get(latestEventSeqMapKey(branch, repoKey)) ?? null;
      check(`parity: kind=${kind} branch=${branch.slice(-6)} repoKey=${JSON.stringify(repoKey)} → oracle=${oracle} map=${viaMap}`, oracle === viaMap);
    }
  }
}

// Sanity: at least one of the above assertions is a REAL hit (non-null), not a suite that vacuously
// passes because every probe resolved to null. Without this, "parity" could be trivially true.
{
  const doneMap = db.buildLatestEventSeqMap("merge_done");
  const hit = doneMap.get(latestEventSeqMapKey(BRANCH_A, null));
  check("sanity: at least one probed combination is a REAL (non-null) hit, not a vacuous all-null parity", typeof hit === "number" && hit > 0);
}

// "Latest" really means latest: BRANCH_A primary scope was filed TWICE (re-task shape) — the map and the
// oracle must both return the LATER seq, not the first.
{
  const doneMap = db.buildLatestEventSeqMap("merge_done");
  const requestMap = db.buildLatestEventSeqMap("merge_request");
  const doneSeq = doneMap.get(latestEventSeqMapKey(BRANCH_A, null));
  const requestSeq = requestMap.get(latestEventSeqMapKey(BRANCH_A, null));
  check("re-task shape: the SECOND (later) merge_done's seq is returned, which is > the second merge_request's seq", doneSeq > requestSeq);
}

// ════════ SANITY CHECK (not independent proof — built from the oracle): a naive, repoKey-blind map variant disagrees with the real map ════════
// Mirrors the exact defect @decision 9ac3a739 fixed: ignoring repoKey and just tracking the max seq per
// BRANCH ALONE. On BRANCH_A, the "other"-scoped merge_done (filed in the middle, seq-wise) would get
// masked by the primary-scope's own LATER merge_done in a correct per-scope map — but a repoKey-blind
// variant can't even distinguish scopes, so querying it for the "other" scope's answer is meaningless;
// the sharper demonstration is that it reports the SAME (wrong) answer for every repoKey, while the real
// map correctly reports DIFFERENT seqs for null vs "primary" vs "other".
function buildNaiveRepoKeyBlindMap(kind) {
  // Deliberately broken: tracks only branch -> max seq, discarding repoKey (detail_json) entirely.
  const rows = db.__rawEventRowsForTest ? db.__rawEventRowsForTest(kind) : null;
  // No test seam exists for a raw dump (by design — production code has no reason to expose one), so
  // reconstruct the same "naive" shape from the real per-call oracle itself: call latestEventSeqForBranch
  // with EVERY repoKey this suite knows about and take the max — this is EXACTLY what a repoKey-blind
  // implementation would effectively collapse to, without needing a parallel raw-SQL path.
  const map = new Map();
  for (const branch of branchesToProbe) {
    let max = null;
    for (const repoKey of [null, "primary", "other"]) {
      const seq = db.latestEventSeqForBranch(branch, kind, repoKey);
      if (seq != null && (max == null || seq > max)) max = seq;
    }
    if (max != null) map.set(branch, max);
  }
  return map;
}
{
  const naive = buildNaiveRepoKeyBlindMap("merge_done");
  const real = db.buildLatestEventSeqMap("merge_done");
  const naiveAnswer = naive.get(BRANCH_A) ?? null; // naive has no repoKey axis — one answer for the whole branch
  const realPrimary = real.get(latestEventSeqMapKey(BRANCH_A, null)) ?? null;
  const realOther = real.get(latestEventSeqMapKey(BRANCH_A, "other")) ?? null;
  check("NAIVE (repoKey-blind) variant: collapses to ONE answer for the whole branch", naiveAnswer !== null);
  check("REAL map: correctly distinguishes primary vs \"other\" scope (different seqs)", realPrimary !== realOther);
  check(
    "SANITY CHECK (built from the oracle, not independent proof): the naive variant's single collapsed answer DISAGREES with the real, correctly-scoped \"other\" answer (it can only match ONE scope, never both) — demonstrating the scoping distinction this map must preserve",
    naiveAnswer !== realOther,
  );
}

db.close();
fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });

console.log(failures === 0
  ? "\n✅ ALL PASS — buildLatestEventSeqMap is in exact parity with latestEventSeqForBranch across mixed repoKeys (null/\"primary\"/\"other\"), a re-tasked reused branch, and both event kinds; a sanity check (built from the oracle, not independent proof of a real implementation) shows a repoKey-blind variant disagrees with the correctly-scoped answer, demonstrating the scoping distinction @decision 9ac3a739 fixed."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
