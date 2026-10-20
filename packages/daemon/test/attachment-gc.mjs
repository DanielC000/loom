import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 6f27469b (epic 7d1d66ab, child 3) — GC for the `question_ask` attachment store card 432765ab
// landed. Hermetic: a REAL Db (temp LOOM_HOME) + REAL `<LOOM_HOME>/attachments/<questionId>` dirs on
// disk, no live claude/network. Mirrors scratch-gc-boot-sweep.mjs's own fixture shape and injected-seam
// style (ScratchGcDeps -> AttachmentGcDeps). See docs/decisions/6f27469b-attachment-gc.md for the design.
//
// Covers the card's full DoD list:
//   1. terminal-state + window eligibility: consumed/cancelled(both cancelled_by values)/read-notice past
//      the retention window ARE reaped; the same states INSIDE the window are NOT.
//   2. non-terminal untouched: pending, answered, and an UNREAD notice (however old) are NEVER reaped —
//      proving there is no age-based fallback for an unread notice (the deleted NOTICE_INBOX_WINDOW_MS).
//   3. containment level 1 (the check that actually fires): a question dir planted AS a symlink/junction,
//      and a question dir path that exists but isn't a directory at all, are each refused with their OWN
//      distinct reason string — two separate real-UUID fixtures, one per branch (Code Review 1: the
//      original single fixture used a non-UUID id, so it was refused by the id-shape guard before lstat
//      ever ran — level 1 was never actually exercised. Fixed.).
//   3c. containment level 2 (defense-in-depth, NOT independently reachable via any planted-link fixture
//      in production — see the decision record): driven directly via `containmentRootOverride`, proving
//      the `isProperlyUnder` comparison itself refuses on a genuine root mismatch and allows on a match.
//   4. id shape check: a row whose id is not a v4-UUID is refused, never touched.
//   5. the third hazard needs no special-case: a symlink/junction PLANTED INSIDE an otherwise-legitimate
//      question dir, pointing at an external directory with a sentinel file, is removed as an ENTRY
//      (never followed) by the real OS-level killableRemoveDir — the sentinel survives, the question dir
//      (junction included) is gone.
//   6. a hung/never-settling removal resolves (never hangs), is reported wedged (not reaped), is left on
//      disk for the next sweep, and is never retried in-process.
//   7. concurrency stays bounded under a large eligible set.
//   8. the read surface (`toQuestionAttachments`'s live `available` flag) flips to false after a REAL
//      sweep actually removes the store dir.
//
// Run: 1) build (turbo builds shared first), 2) node packages/daemon/test/attachment-gc.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
// MONOTONIC (see CLAUDE.md's CI timing-flake note) + slack, so a loaded runner can't flake a lower bound.
const TIMER_SLACK_MS = 80;

const tmpHome = path.join(os.tmpdir(), `loom-attgc-${Date.now()}-${process.pid}`);
fs.mkdirSync(tmpHome, { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { sweepExpiredAttachments, ATTACHMENT_GC_CONCURRENCY } = await import("../dist/mcp/attachment-gc.js");
const { ATTACHMENTS_DIR, questionAttachmentDir } = await import("../dist/paths.js");

fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });

// A SIBLING of tmpHome (LOOM_HOME), never nested inside it and never bare in os.tmpdir() — a dedicated,
// namespaced root for every "outside the store" fixture target this file creates.
const scratch = path.join(os.tmpdir(), `loom-attgc-scratch-${Date.now()}-${process.pid}`);
fs.mkdirSync(scratch, { recursive: true });

const db = new Db();
const now = new Date().toISOString();
db.insertProject({ id: "proj1", name: "P", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agent1", projectId: "proj1", name: "A", startupPrompt: "", position: 0 });
db.insertSession({
  id: "mgr1", projectId: "proj1", agentId: "agent1", engineSessionId: null, title: null, cwd: tmpHome,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "manager",
});

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 7 * DAY_MS;
const nowMs = Date.now();
const oldIso = new Date(nowMs - 10 * DAY_MS).toISOString(); // past the 7-day retention window
const freshIso = new Date(nowMs - 2 * DAY_MS).toISOString(); // inside the 7-day retention window
const ancientIso = new Date(nowMs - 400 * DAY_MS).toISOString(); // far older than any plausible window

/** Creates a real attachment store dir with one real file and a matching StoredQuestionAttachment entry. */
function mkAttachmentStore(id) {
  const dir = questionAttachmentDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const storedFilename = "0-note.txt";
  fs.writeFileSync(path.join(dir, storedFilename), "hello\n");
  return [{ id: "0", label: "note.txt", kind: "other", sizeBytes: 6, imageDimensions: null, storedFilename, originalPath: "/src/note.txt", openedAt: null }];
}

function baseQuestion(id, overrides) {
  return {
    id, sessionId: "mgr1", filedBySessionId: "mgr1", projectId: "proj1", type: overrides.type ?? "decision",
    title: "T", body: "B", options: null, recommendation: null, taskId: null,
    permissionAction: null, permissionScopeHint: null, permissionExpiresAt: null,
    decidedScope: null, decidedExpiresAt: null, credentialEnvVar: null, credentialByteLength: null,
    provisionTarget: null, fulfillmentTarget: null, provisionConnectionId: null, provisionBindingState: "none",
    chosenOption: null, note: null,
    createdAt: overrides.createdAt ?? now, answeredAt: overrides.answeredAt ?? null, consumedAt: overrides.consumedAt ?? null,
    cancelledReason: overrides.cancelledReason ?? null, cancelledBy: overrides.cancelledBy ?? null, cancelledAt: overrides.cancelledAt ?? null,
    escalatedAt: null, acknowledgedUntil: null, readAt: null,
    attachments: [],
    state: overrides.state,
  };
}

/** Inserts a GC-candidate question row WITH a real attachment store on disk; returns its dir. */
function mkCandidate(id, overrides) {
  const stored = mkAttachmentStore(id);
  db.insertQuestion(baseQuestion(id, overrides), stored);
  if (overrides.readAt) db.markQuestionsRead([id], overrides.readAt);
  return questionAttachmentDir(id);
}

const removeDirReal = (target, timeoutMs) => import("../dist/git/worktrees.js").then((m) => m.killableRemoveDir(target, timeoutMs));

// A `removeDir` seam that NEVER settles — proves a wedged removal is bounded, never looped (bd9fc808's shape).
function neverSettlingRemoveDir() {
  const calls = [];
  const fn = (target, timeoutMs) => { calls.push({ target, timeoutMs }); return new Promise(() => {}); };
  fn.calls = calls;
  return fn;
}

// A `removeDir` seam that resolves after `delayMs`, tracking concurrent in-flight calls.
function trackingRemoveDir(delayMs) {
  let inFlight = 0;
  let maxInFlight = 0;
  const calls = [];
  const fn = async (target) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    calls.push(target);
    await new Promise((r) => setTimeout(r, delayMs));
    inFlight--;
    return { removed: true, killed: false };
  };
  fn.calls = calls;
  fn.maxInFlight = () => maxInFlight;
  return fn;
}

// ============================== 1. terminal-state + window eligibility ==============================
// Every id here is a REAL v4-UUID (production shape, randomUUID()) — a human-readable fixture id would
// be refused by the SAME id-shape guard section 4 tests on purpose, which would silently turn these
// "should be reaped" cases into false negatives indistinguishable from a real eligibility bug.
{
  const consumedOld = randomUUID();
  const dir1 = mkCandidate(consumedOld, { state: "consumed", consumedAt: oldIso });
  const consumedFresh = randomUUID();
  const dir2 = mkCandidate(consumedFresh, { state: "consumed", consumedAt: freshIso });
  const cancelledAgentOld = randomUUID();
  const dir3 = mkCandidate(cancelledAgentOld, { state: "cancelled", cancelledAt: oldIso, cancelledBy: "agent", cancelledReason: "stale" });
  const cancelledHumanOld = randomUUID(); // dismiss shape — same state, different cancelledBy
  const dir4 = mkCandidate(cancelledHumanOld, { state: "cancelled", cancelledAt: oldIso, cancelledBy: "human", cancelledReason: null });
  const noticeReadOld = randomUUID();
  const dir5 = mkCandidate(noticeReadOld, { state: "notice", createdAt: ancientIso, readAt: oldIso });
  const noticeReadFresh = randomUUID();
  const dir6 = mkCandidate(noticeReadFresh, { state: "notice", createdAt: ancientIso, readAt: freshIso });

  const result = await sweepExpiredAttachments(db, RETENTION_MS, { nowMs });

  check("1a consumed past the window IS reaped", !fs.existsSync(dir1) && result.reaped.includes(consumedOld));
  check("1b consumed inside the window is NOT reaped", fs.existsSync(dir2) && !result.reaped.includes(consumedFresh));
  check("1c cancelled (question_cancel shape, cancelled_by:agent) past the window IS reaped", !fs.existsSync(dir3) && result.reaped.includes(cancelledAgentOld));
  check("1d cancelled (dismiss shape, cancelled_by:human) past the window IS ALSO reaped — dismiss isn't special-cased", !fs.existsSync(dir4) && result.reaped.includes(cancelledHumanOld));
  check("1e a READ notice past the window IS reaped (terminal time = read_at)", !fs.existsSync(dir5) && result.reaped.includes(noticeReadOld));
  check("1f a READ notice inside the window is NOT reaped", fs.existsSync(dir6) && !result.reaped.includes(noticeReadFresh));
}

// ============================== 2. non-terminal untouched, incl. an UNREAD notice however old ==============================
{
  const pendingId = randomUUID();
  const dirP = mkCandidate(pendingId, { state: "pending", createdAt: ancientIso });
  const answeredId = randomUUID();
  const dirA = mkCandidate(answeredId, { state: "answered", createdAt: ancientIso, answeredAt: ancientIso });
  const noticeUnreadId = randomUUID();
  const dirN = mkCandidate(noticeUnreadId, { state: "notice", createdAt: ancientIso }); // no readAt at all

  const result = await sweepExpiredAttachments(db, RETENTION_MS, { nowMs });

  check("2a a pending request, however old, is NEVER reaped (no terminal timestamp exists)", fs.existsSync(dirP));
  check("2b an answered-but-unconsumed request, however old, is NEVER reaped", fs.existsSync(dirA));
  check("2c an UNREAD notice, however old, is NEVER reaped — no age-based fallback exists for it", fs.existsSync(dirN));
  check("2d none of pending/answered/unread-notice is ever reported reaped", !result.reaped.includes(pendingId) && !result.reaped.includes(answeredId) && !result.reaped.includes(noticeUnreadId));
  check("2e the SQL candidate set structurally excludes all three (never even considered, not merely spared)", !result.refused.some((r) => r.id === pendingId || r.id === answeredId || r.id === noticeUnreadId));
}

// ============================== 3a. containment level 1, branch 1: the question dir ITSELF is a symlink/junction ==============================
// A REAL v4-UUID id — see the header comment on why a human-readable fixture id here would be a false
// positive (refused by the id-shape guard, never actually reaching the symlink check at all).
{
  const id = randomUUID();
  const outside = path.join(scratch, "outside-l1");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "sentinel.txt"), "keep-me\n");

  const stored = [{ id: "0", label: "x", kind: "other", sizeBytes: 1, imageDimensions: null, storedFilename: "0-x.txt", originalPath: "/x", openedAt: null }];
  db.insertQuestion(baseQuestion(id, { state: "consumed", consumedAt: oldIso }), stored);

  const dir = questionAttachmentDir(id);
  let junctionOk = false;
  try { fs.symlinkSync(outside, dir, process.platform === "win32" ? "junction" : "dir"); junctionOk = true; } catch { /* no link privilege on this host */ }

  if (junctionOk) {
    const result = await sweepExpiredAttachments(db, RETENTION_MS, { nowMs });
    check("3a a question dir planted AS a symlink/junction is refused, never removed", fs.existsSync(dir));
    check("3a the link's target (and its sentinel) survives untouched", fs.existsSync(path.join(outside, "sentinel.txt")));
    check("3a not reported reaped", !result.reaped.includes(id));
    const entry = result.refused.find((r) => r.id === id);
    check("3a reported as refused", entry !== undefined);
    check("3a the SPECIFIC refusal reason names the symlink/junction branch, not a generic refusal",
      entry?.reason === "attachment store dir is itself a symlink/junction — refused, never followed");
    fs.unlinkSync(dir); // drop the link itself before any cleanup walks it
  } else {
    console.log("SKIP  (3a) junction case — could not create a junction/symlink on this host");
  }
  fs.rmSync(outside, { recursive: true, force: true });
}

// ============================== 3b. containment level 1, branch 2: the question dir path exists but is NOT a directory ==============================
{
  const id = randomUUID();
  const stored = [{ id: "0", label: "x", kind: "other", sizeBytes: 1, imageDimensions: null, storedFilename: "0-x.txt", originalPath: "/x", openedAt: null }];
  db.insertQuestion(baseQuestion(id, { state: "consumed", consumedAt: oldIso }), stored);

  const dir = questionAttachmentDir(id);
  fs.writeFileSync(dir, "a plain file sitting where a directory was expected\n"); // no mkdir at all

  const result = await sweepExpiredAttachments(db, RETENTION_MS, { nowMs });
  check("3b a question dir path that is a plain FILE is refused, never removed", fs.existsSync(dir) && fs.statSync(dir).isFile());
  check("3b not reported reaped", !result.reaped.includes(id));
  const entry = result.refused.find((r) => r.id === id);
  check("3b reported as refused", entry !== undefined);
  check("3b the SPECIFIC refusal reason names the not-a-directory branch, distinct from 3a's symlink reason",
    entry?.reason === "attachment store path exists but is not a directory");
  fs.unlinkSync(dir);
}

// ============================== 3c. containment level 2: defense-in-depth, driven via containmentRootOverride ==============================
// Level 2 cannot be independently exercised by any planted-link fixture — `questionAttachmentDir(id)` is
// always a flat `ATTACHMENTS_DIR/<id>` child, so once level 1 confirms a real directory sits there,
// canonicalizing it is structurally guaranteed to land under the canonicalized ATTACHMENTS_DIR. This
// drives the ACTUAL `isProperlyUnder` comparison the sweep runs, with a deliberately mismatched root
// (never reachable in production — deps.containmentRootOverride is TEST-ONLY), to prove the check itself
// discriminates correctly in both directions. RED-before-fix: the pre-fix code had no such deps field at
// all, so passing it was a silent no-op against the real (always-matching) root — "3c mismatched root is
// refused" would FAIL on that code (nothing ever refuses), the exact regression this seam closes.
{
  const id = randomUUID();
  const dir = mkCandidate(id, { state: "consumed", consumedAt: oldIso });

  const mismatchedRoot = path.join(scratch, "unrelated-root-l2");
  fs.mkdirSync(mismatchedRoot, { recursive: true });
  const mismatchResult = await sweepExpiredAttachments(db, RETENTION_MS, { nowMs, containmentRootOverride: mismatchedRoot });
  check("3c a genuinely MISMATCHED containment root refuses the dir (not removed)", fs.existsSync(dir));
  check("3c not reported reaped under a mismatched root", !mismatchResult.reaped.includes(id));
  const mismatchEntry = mismatchResult.refused.find((r) => r.id === id);
  check("3c reported as refused under a mismatched root", mismatchEntry !== undefined);
  check("3c the SPECIFIC refusal reason names the outside-root branch",
    mismatchEntry?.reason === "attachment store dir resolves outside the attachments root");

  // Negative control: the SAME dir, with the override pointed at the REAL root instead — must be allowed
  // (and actually removed) — proves 3c's mismatch result isn't just "always refuses when this deps field
  // is set," but a genuine comparison.
  const matchResult = await sweepExpiredAttachments(db, RETENTION_MS, { nowMs, containmentRootOverride: ATTACHMENTS_DIR });
  check("3c negative control: a MATCHING containment root allows the exact same dir shape through (genuinely removed)",
    !fs.existsSync(dir) && matchResult.reaped.includes(id));
}

// ============================== 4. a non-v4-UUID id is refused, never touched ==============================
{
  const id = "not-a-real-uuid";
  const dir = mkCandidate(id, { state: "consumed", consumedAt: oldIso });

  const result = await sweepExpiredAttachments(db, RETENTION_MS, { nowMs });
  check("4 a non-v4-UUID-shaped question id is refused", fs.existsSync(dir));
  check("4 not reported reaped", !result.reaped.includes(id));
  check("4 reported as refused", result.refused.some((r) => r.id === id));
}

// ============================== 5. a link INSIDE the dir, pointing outside, needs no special-case ==============================
{
  const id = randomUUID();
  const dir = mkCandidate(id, { state: "consumed", consumedAt: oldIso });
  const outside = path.join(scratch, "outside-l3");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "sentinel.txt"), "keep-me-too\n");

  const linkPath = path.join(dir, "escape-link");
  let junctionOk = false;
  try { fs.symlinkSync(outside, linkPath, process.platform === "win32" ? "junction" : "dir"); junctionOk = true; } catch { /* no link privilege on this host */ }

  if (junctionOk) {
    const result = await sweepExpiredAttachments(db, RETENTION_MS, { nowMs });
    check("5 the external target survives (killableRemoveDir removes the LINK ENTRY, never recurses into it)", fs.existsSync(path.join(outside, "sentinel.txt")));
    check("5 the question dir itself (junction included) IS removed", !fs.existsSync(dir));
    check("5 reported as reaped", result.reaped.includes(id));
  } else {
    console.log("SKIP  (5) junction case — could not create a junction/symlink on this host");
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.rmSync(outside, { recursive: true, force: true });
}

// ============================== 6. a wedged removal resolves (never hangs), is left for the next sweep ==============================
{
  const id = randomUUID();
  const dir = mkCandidate(id, { state: "consumed", consumedAt: oldIso });

  const removeDir = neverSettlingRemoveDir();
  const timeoutMs = 150;
  const t0 = performance.now();
  const result = await Promise.race([
    sweepExpiredAttachments(db, RETENTION_MS, { nowMs, removeDir, timeoutMs }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("watchdog: sweep did not settle")), timeoutMs * 10)),
  ]);
  const elapsed = performance.now() - t0;

  check("6 a wedged removal routes through the injected removeDir seam exactly once (no retry)", removeDir.calls.length === 1);
  check("6 the sweep resolves (never hangs) against a never-settling removeDir", elapsed < timeoutMs * 10);
  check(`6 the outer bound fires ~at timeoutMs (${Math.round(elapsed)}ms >= ${timeoutMs}ms)`, elapsed >= timeoutMs - TIMER_SLACK_MS);
  check("6 the dir is left on disk (never removed) for the next boot sweep", fs.existsSync(dir));
  check("6 reported as wedged, not reaped", result.wedged.includes(id) && !result.reaped.includes(id));
  fs.rmSync(dir, { recursive: true, force: true });
}

// ============================== 7. concurrency stays BOUNDED under a large eligible set ==============================
{
  const n = ATTACHMENT_GC_CONCURRENCY * 3;
  const ids = [];
  for (let i = 0; i < n; i++) {
    const id = randomUUID();
    mkCandidate(id, { state: "consumed", consumedAt: oldIso });
    ids.push(id);
  }

  const removeDir = trackingRemoveDir(60);
  const result = await sweepExpiredAttachments(db, RETENTION_MS, { nowMs, removeDir, timeoutMs: 5000 });

  check(`7 removeDir was invoked for every candidate (${removeDir.calls.length} of ${n})`, removeDir.calls.length === n);
  check(`7 concurrency never exceeded ATTACHMENT_GC_CONCURRENCY (max observed ${removeDir.maxInFlight()}, cap ${ATTACHMENT_GC_CONCURRENCY})`, removeDir.maxInFlight() <= ATTACHMENT_GC_CONCURRENCY);
  check("7 concurrency is genuinely PARALLELIZED, not serial (max observed > 1)", removeDir.maxInFlight() > 1);
  check("7 every candidate reported reaped (the injected removeDir always resolves {removed:true})", ids.every((id) => result.reaped.includes(id)));
}

// ============================== 8. the read surface flips to available:false after a REAL sweep ==============================
{
  const id = randomUUID();
  mkCandidate(id, { state: "consumed", consumedAt: oldIso });

  const before = db.getQuestion(id);
  check("8 before GC: the read surface reports available:true", before.attachments.length === 1 && before.attachments[0].available === true);

  await sweepExpiredAttachments(db, RETENTION_MS, { nowMs, removeDir: removeDirReal });

  const after = db.getQuestion(id);
  check("8 after a REAL sweep: the read surface reports available:false — computed live, nothing in the row changed", after.attachments.length === 1 && after.attachments[0].available === false);
  check("8 the row's own state/consumedAt are untouched (GC is deliberately non-consuming)", after.state === "consumed" && after.consumedAt === oldIso);
}

db.close();
fs.rmSync(tmpHome, { recursive: true, force: true });

console.log(failures === 0
  ? "\n✅ ALL PASS — attachment GC reaps only genuinely terminal + past-window requests (consumed/cancelled-either-way/read-notice), never a pending/answered/unread-notice row regardless of age; level 1 (the check that actually fires) refuses a symlinked/junctioned dir AND a plain-file dir path, each with its own distinct reason, via real-UUID fixtures; level 2 (defense-in-depth, unreachable via any planted link in production) is driven directly via containmentRootOverride and discriminates a genuine root mismatch from a match, both directions; a non-UUID-shaped id is refused; killableRemoveDir removes a link planted INSIDE a dir as an entry (never recursing into its target); a wedged removal is bounded instead of hanging; concurrency is bounded under a large eligible set; and the read surface's available flag flips to false purely from a real removal with the DB row left untouched."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
