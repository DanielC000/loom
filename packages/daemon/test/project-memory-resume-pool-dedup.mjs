import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card e1864a31 — regression test for the resume-time project-memory dedup gate's interaction with card
// 6def8bf4's pinned-tier LRU-fairness rotation. The existing project-memory-cross-session.mjs dedup
// coverage uses a corpus small enough that nothing ever gets budget-truncated, so `sortPinnedByRecency`'s
// rotation never actually reorders which notes are INCLUDED between renders — that small-corpus shape is
// exactly why the original bug (a rendered-text/included-set dedup key) shipped undetected. THIS file uses
// a deliberately budget-truncated pinned set (6 notes, budget room for ~2-3) so the rotation is live.
//
// Proves:
//   1. (anti-flip-flop) a same-session resume with UNCHANGED memory, against a budget-truncated pinned
//      set, enqueues NOTHING — across several consecutive resumes with zero writes in between (the exact
//      shape that used to alternate forever once ANY real delivery touched lastRetrievedAt).
//   2. (spawn -> first resume) a fresh spawn's OWN stamp is computed the SAME way resume()'s check is, so
//      the very first resume after a spawn does not spuriously mismatch on this same truncated corpus.
//   3. (genuine resend settles) after a real memory_write forces a genuine resend, the VERY NEXT resume
//      (with no further writes) still enqueues nothing — proving the resend's own retrieval-stat bump does
//      not itself seed a fresh rotation-driven mismatch.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, same SeamHost harness as project-memory-cross-session.mjs.
// Run: 1) build (turbo builds shared first), 2) node test/project-memory-resume-pool-dedup.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-pm-pool-dedup-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");
const { PROJECT_MEMORY_TAG, composeProjectMemoryDigest } = await import("../dist/sessions/project-memory-recall.js");

const repo = path.join(os.tmpdir(), `loom-pm-pool-dedup-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# project-memory-resume-pool-dedup test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=pm@loom -c user.name=pm");

const now = new Date().toISOString();
const db = new Db();
const projA = "poolDedupProj";
// A SMALL budget relative to 6 pinned notes forces truncation every render — this is what makes card
// 6def8bf4's rotation actually fire between renders (the shape the small-corpus cross-session test can't
// exercise).
const BUDGET_TOKENS = 260;
db.insertProject({ id: projA, name: "Pool Dedup Project", repoPath: repo, vaultPath: repo, config: { memory: { budgetTokens: BUDGET_TOKENS, topK: 8, maxNotes: 500 } }, createdAt: now, archivedAt: null });
db.insertAgent({ id: "workerAgent", projectId: projA, name: "Dev", startupPrompt: "WORKER_PROMPT", position: 0, profileId: null });
const tA = "aaaaaaaa-1111-4111-8111-111111111111";
db.insertTask({ id: tA, projectId: projA, title: "Investigate the resume dedup rotation bug", body: "unrelated to any pinned note's own wording", columnKey: "backlog", position: 1, priority: "p1", createdAt: now, updatedAt: now });

class SeamHost extends createSeamHost(PtyHost) {
  constructor(events) { super(events); this.capture = []; this.enqueued = []; }
  createPty(opts) { this.capture.push(opts); return super.createPty(opts); }
  isAlive() { return false; }
  enqueueStdin(sessionId, text, source, _onDeliver, _route, kind = "warning") {
    this.enqueued.push({ sessionId, text, source, kind });
    return { delivered: false };
  }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());
const optsFor = (sid) => host.capture.find((o) => o.sessionId === sid);

try {
  // ===================== fixture: 6 pinned notes, sized so the budget forces truncation =====================
  const noteBody = (n) => `note ${n} body text — padded so each block costs a non-trivial share of the ${BUDGET_TOKENS}-token budget, forcing several of these six notes to be dropped on any single render. filler filler filler ${n}.`;
  for (let i = 1; i <= 6; i++) {
    db.upsertProjectMemory(projA, { key: `note-${i}`, title: `Note ${i}`, text: noteBody(i), pinned: true }, 500);
  }

  // Sanity (mirrors project-memory-pinned-fairness.mjs's own DoD-5 sanity check): confirm THIS fixture
  // actually forces truncation at THIS budget — otherwise every assertion below proves nothing. Pure,
  // side-effect-free (composeProjectMemoryDigest never touches retrieval stats).
  {
    const allPinned = db.listPinnedProjectMemory(projA);
    check("(sanity) fixture has all 6 pinned notes", allPinned.length === 6);
    const probe = composeProjectMemoryDigest(allPinned, [], BUDGET_TOKENS);
    check("(sanity) this budget/corpus combination actually drops at least one pinned note — otherwise this fixture proves nothing",
      probe.droppedRestKeys.length > 0 && probe.includedIds.length < 6);
  }

  // ===================== (1) ANTI-FLIP-FLOP: a raw (never-spawned-through-svc) session's first resume is
  // guaranteed to enqueue (no prior stamp) — every resume AFTER that, with zero writes in between, must
  // enqueue NOTHING, across several rounds. Under the old rendered-text/included-set dedup key, rotation
  // driven purely by the FIRST resume's own retrieval-stat bump would make EVERY subsequent round's
  // truncated subset differ from the last, so this loop would alternate/resend forever. =====================
  const rawId = "rawWorker";
  const rawEngId = "bbbbbbbb-2222-4222-8222-222222222222";
  db.insertSession({
    id: rawId, projectId: projA, agentId: "workerAgent", engineSessionId: rawEngId, title: null,
    cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "worker", taskId: tA,
  });
  const rawTpath = engineTranscriptPath(repo, rawEngId);
  fs.mkdirSync(path.dirname(rawTpath), { recursive: true });
  fs.writeFileSync(rawTpath, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");

  host.enqueued.length = 0;
  svc.resume(rawId);
  const firstResumeMsg = host.enqueued.find((e) => e.sessionId === rawId);
  check("(round 1) the raw session's FIRST-EVER resume enqueues the truncated project-memory block (no prior stamp)",
    !!firstResumeMsg && firstResumeMsg.text.includes(PROJECT_MEMORY_TAG));

  for (let round = 2; round <= 6; round++) {
    host.enqueued.length = 0;
    svc.resume(rawId);
    check(`(round ${round}) unchanged memory, zero writes since the last resume — enqueues NOTHING (the flip-flop this card fixes would resend here)`,
      !host.enqueued.some((e) => e.sessionId === rawId && e.text.includes(PROJECT_MEMORY_TAG)));
  }

  // ===================== (2) SPAWN -> FIRST RESUME, on the SAME truncated corpus: a fresh spawn's own
  // stamp must be computed the identical way the resume-time check is, or the very first resume after
  // every spawn would mismatch purely from a format difference — independent of any real content change. =====================
  host.capture.length = 0;
  const freshSpawned = svc.startNew("workerAgent");
  const freshOpts = optsFor(freshSpawned.id);
  check("(spawn) the fresh spawn's own startupPrompt carries the truncated project-memory block",
    typeof freshOpts?.startupPrompt === "string" && freshOpts.startupPrompt.includes(PROJECT_MEMORY_TAG));

  const freshEngId = "cccccccc-3333-4333-8333-333333333333";
  db.setEngineSessionId(freshSpawned.id, freshEngId);
  const freshTpath = engineTranscriptPath(repo, freshEngId);
  fs.mkdirSync(path.dirname(freshTpath), { recursive: true });
  fs.writeFileSync(freshTpath, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");

  host.enqueued.length = 0;
  svc.resume(freshSpawned.id);
  check("(spawn -> first resume) unchanged memory since the fresh spawn's own stamp — first resume enqueues NOTHING",
    !host.enqueued.some((e) => e.sessionId === freshSpawned.id && e.text.includes(PROJECT_MEMORY_TAG)));

  // ===================== (3) GENUINE RESEND SETTLES: a real memory_write forces a genuine resend on rawId
  // (which has been sitting dedup-stable through rounds 2-6 above) — the resend's OWN retrieval-stat bump
  // must not itself seed a fresh mismatch on the VERY NEXT resume. =====================
  db.upsertProjectMemory(projA, { key: "note-7-genuinely-new", title: "Note 7", text: "a genuinely new pinned note written after the stable rounds above.", pinned: true }, 500);
  host.enqueued.length = 0;
  svc.resume(rawId);
  const resendMsg = host.enqueued.find((e) => e.sessionId === rawId);
  check("(resend) a resume AFTER a genuinely new pinned note enqueues again (the pool identity changed)",
    !!resendMsg && resendMsg.text.includes(PROJECT_MEMORY_TAG));

  host.enqueued.length = 0;
  svc.resume(rawId);
  check("(resend settles) the VERY NEXT resume, no further writes, enqueues NOTHING — the resend's own retrieval-stat bump did not seed a fresh mismatch",
    !host.enqueued.some((e) => e.sessionId === rawId && e.text.includes(PROJECT_MEMORY_TAG)));
  // One more round for good measure — the exact 2-round oscillation window the bug produced.
  host.enqueued.length = 0;
  svc.resume(rawId);
  check("(resend settles, round 2) still nothing, two resumes after the resend",
    !host.enqueued.some((e) => e.sessionId === rawId && e.text.includes(PROJECT_MEMORY_TAG)));
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card e1864a31: the resume-time project-memory dedup gate no longer flip-flops against a budget-truncated, rotating pinned set. Against a REAL 6-note pool that genuinely exceeds its budget (card 6def8bf4's LRU-fairness rotation is live, not incidental): several consecutive same-session resumes with zero writes enqueue nothing; a fresh spawn's own stamp is format-consistent with the resume-time check so the very first resume after a spawn doesn't mismatch either; and a genuine resend's own retrieval-stat bump does not itself seed the next mismatch. Claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
