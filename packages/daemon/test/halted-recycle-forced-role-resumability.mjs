import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card a4c5f234 — Code Review MAJOR 1 fix. `isDurablyResumable` (sessions/recycle-settle-reconcile.ts)
// used to be a hand-rolled THREE-check replica of `resume()`'s own up-front preconditions
// (engineSessionId set, its transcript exists, its cwd exists) — but `resume()` (sessions/service.ts) has
// a FOURTH shape `isDurablyResumable` never knew about: a codex-pinned row whose RESOLVED role forces
// claude (`isForcedRoleFreshStart`, profiles/codex-compat.ts, ruling 1(b) card 7955458e) skips the
// engine-id/transcript checks entirely and fresh-starts via `resumeForcedRoleAsFreshClaude` instead of
// `--resume`ing — it needs neither to come back, only a real `cwd`. A legacy codex-pinned MANAGER row
// (TRANSCRIPT_ROOT_DENY_ROLES includes "manager") with no engine id would therefore have been wrongly
// classified "not durably resumable" by the OLD `isDurablyResumable`, routing it into
// `reconcileHaltedRecycleSuccessorsEarly`'s both-dead `consolidated` branch and unlinking its successor —
// even though `resume()` itself would have happily brought it back live moments later via the fresh-start
// path, breaking NEVER RESURRECT through exactly that side door.
//
// The fix: `isForcedRoleFreshStart` (profiles/codex-compat.ts) is now the ONE place this shape is
// computed; both `resume()` and `isDurablyResumable` call it, so the two can never classify a row
// differently again.
//
// Proves, directly against `reconcileHaltedRecycleSuccessorsEarly` + `isDurablyResumable` (unit-level,
// independent of the full Db+PtyHost+SessionService harness — mirrors is-superseded-by-recycle.mjs's own
// style), that a halted predecessor P reaching the "is P itself viable" decision point lands in the
// RIGHT bucket for each of the three shapes a `resume()` precondition can fail on:
//   (1) CODEX FORCED-ROLE — P is harness:"codex", role:"manager" (a TRANSCRIPT_ROOT_DENY_ROLES member),
//       with NO engine id and NO transcript at all. FIX: isDurablyResumable(P) is now TRUE (the
//       engine-id/transcript checks are skipped for this shape) — P lands in `recovered`, never
//       `consolidated`, and S1's lineage is reparented onto it exactly like any other `recovered` case.
//   (2) MISSING TRANSCRIPT — P is an ordinary claude manager with a real engineSessionId but no matching
//       transcript file on disk. isDurablyResumable(P) is FALSE (unchanged) — P lands in `consolidated`.
//   (3) MISSING CWD — P has a real engineSessionId AND a real transcript file, but its `cwd` directory
//       does not exist. isDurablyResumable(P) is FALSE (unchanged) — P lands in `consolidated`.
// In every case S1 (the successor) is constructed to be unresumable itself (no engine id), so the scan
// actually reaches the "is P viable" decision point `reconcileHaltedRecycleSuccessorsEarly` guards on.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic: a plain Db, no git repo, no claude, no pty.
//
// Run: 1) build (turbo builds shared first), 2) node test/halted-recycle-forced-role-resumability.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Db } from "../dist/db.js";
import { reconcileHaltedRecycleSuccessorsEarly } from "../dist/sessions/halted-recycle-reconcile.js";
import { isDurablyResumable } from "../dist/sessions/recycle-settle-reconcile.js";
import { encodeProjectDir } from "../dist/sessions/transcript.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const dbFiles = [];
const scratchDirs = [];

function makeDb() {
  const dbFile = path.join(os.tmpdir(), `loom-hrfrr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  dbFiles.push(dbFile);
  const projId = `p-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `a-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  db.insertProject({ id: projId, name: "HRFRR", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "mgr", position: 0 });
  return { db, projId, agentId };
}

function makeRealCwd() {
  const dir = path.join(os.tmpdir(), `loom-hrfrr-cwd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  scratchDirs.push(dir);
  return dir;
}

function writeFakeTranscript(cwd, engineSessionId) {
  const engineDir = path.join(os.homedir(), ".claude", "projects", encodeProjectDir(path.resolve(cwd)));
  fs.mkdirSync(engineDir, { recursive: true });
  fs.writeFileSync(path.join(engineDir, `${engineSessionId}.jsonl`), "");
}

function seedSession(e, id, { role = "manager", harness, engineSessionId = null, cwd, gen, recycledFrom = null } = {}) {
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId, title: null, cwd: cwd ?? e.projId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: new Date().toISOString(), lastActivity: new Date().toISOString(), lastError: null, role,
    parentSessionId: null, taskId: null, ctxInputTokens: null, ctxTurns: null, model: null,
    gen, recycledFrom, harness,
  });
}

function haltEvent(predecessorId, successorId, { gen = 1, ts } = {}) {
  return {
    id: randomUUID(), ts: ts ?? new Date().toISOString(),
    managerSessionId: successorId, workerSessionId: predecessorId, taskId: null,
    kind: "recycle_ownership_transfer_failed",
    detail: { recycledFrom: predecessorId, gen, failedSteps: ["wakes"] },
  };
}

try {
  // ==================== (1) CODEX FORCED-ROLE — FIX: now routes to `recovered`, never `consolidated` ====================
  {
    const e = makeDb();
    const pCwd = makeRealCwd(); // real cwd — the ONE precondition a forced-role row still needs
    // P: harness "codex" + role "manager" (a TRANSCRIPT_ROOT_DENY_ROLES member) — the "legacy codex-
    // pinned manager" shape. NO engineSessionId, NO transcript — would fail the OLD isDurablyResumable.
    seedSession(e, "p-codex", { role: "manager", harness: "codex", engineSessionId: null, cwd: pCwd });
    // S1: confirmed unresumable itself (no engine id) — reaches the "is P viable" decision point.
    seedSession(e, "s-codex", { gen: 1, recycledFrom: "p-codex" });
    e.db.appendEvent(haltEvent("p-codex", "s-codex", { gen: 1 }));

    check("(1) FIX a4c5f234: isDurablyResumable(P) is TRUE for a codex forced-role row with no engine id (only cwd matters)",
      isDurablyResumable(e.db.getSession("p-codex")) === true);

    const early = reconcileHaltedRecycleSuccessorsEarly(e.db);
    check("(1) FIX a4c5f234: P lands in `recovered`", early.recovered.some((r) => r.predecessorId === "p-codex" && r.freshId === "s-codex"));
    check("(1) FIX a4c5f234: P does NOT land in `consolidated`", !early.consolidated.some((c) => c.predecessorId === "p-codex"));
    check("(1) the successor's lineage WAS reparented (the ordinary `recovered` path)", e.db.getSession("s-codex")?.recycledFrom === null);
    check("(1) hasSuccessor(P) is now false", e.db.hasSuccessor("p-codex") === false);
  }

  // ==================== (2) MISSING TRANSCRIPT — unchanged: still routes to `consolidated` ====================
  {
    const e = makeDb();
    const pCwd = makeRealCwd(); // cwd exists...
    // ...but no transcript file is ever written for this engineSessionId — engineTranscriptExists is FALSE.
    seedSession(e, "p-notrans", { role: "manager", harness: "claude", engineSessionId: "eng-p-notrans", cwd: pCwd });
    seedSession(e, "s-notrans", { gen: 1, recycledFrom: "p-notrans" });
    e.db.appendEvent(haltEvent("p-notrans", "s-notrans", { gen: 1 }));

    check("(2) isDurablyResumable(P) is FALSE — real engine id, but no matching transcript file",
      isDurablyResumable(e.db.getSession("p-notrans")) === false);

    const early = reconcileHaltedRecycleSuccessorsEarly(e.db);
    check("(2) P lands in `consolidated` (both dead)", early.consolidated.some((c) => c.predecessorId === "p-notrans" && c.freshId === "s-notrans"));
    check("(2) P does NOT land in `recovered`", !early.recovered.some((r) => r.predecessorId === "p-notrans"));
  }

  // ==================== (3) MISSING CWD — unchanged: still routes to `consolidated` ====================
  {
    const e = makeDb();
    const pCwd = path.join(os.tmpdir(), `loom-hrfrr-missing-cwd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    // Deliberately never created on disk — fs.existsSync(pCwd) is FALSE. Write the transcript under this
    // same (non-existent-as-a-real-cwd) path anyway — engineTranscriptExists resolves its OWN directory
    // under ~/.claude/projects, independent of pCwd actually existing as a real working directory, so the
    // transcript check alone would pass; only the cwd-existence check fails here.
    writeFakeTranscript(pCwd, "eng-p-nocwd");
    seedSession(e, "p-nocwd", { role: "manager", harness: "claude", engineSessionId: "eng-p-nocwd", cwd: pCwd });
    seedSession(e, "s-nocwd", { gen: 1, recycledFrom: "p-nocwd" });
    e.db.appendEvent(haltEvent("p-nocwd", "s-nocwd", { gen: 1 }));

    check("(3) setup: the transcript DOES exist (isolates this case to cwd alone)", fs.existsSync(path.join(os.homedir(), ".claude", "projects", encodeProjectDir(path.resolve(pCwd)))));
    check("(3) setup: the cwd itself does NOT exist on disk", fs.existsSync(pCwd) === false);
    check("(3) isDurablyResumable(P) is FALSE — real engine id + transcript, but cwd is gone",
      isDurablyResumable(e.db.getSession("p-nocwd")) === false);

    const early = reconcileHaltedRecycleSuccessorsEarly(e.db);
    check("(3) P lands in `consolidated` (both dead)", early.consolidated.some((c) => c.predecessorId === "p-nocwd" && c.freshId === "s-nocwd"));
    check("(3) P does NOT land in `recovered`", !early.recovered.some((r) => r.predecessorId === "p-nocwd"));
  }
} finally {
  for (const f of dbFiles) { try { fs.rmSync(f, { force: true }); } catch { /* best-effort */ } }
  for (const d of scratchDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — `isDurablyResumable` now agrees with `resume()`'s own preconditions on EVERY shape, including the codex forced-role fresh-start bypass (card a4c5f234, Code Review MAJOR 1) — a legacy codex-pinned manager with no engine id correctly routes to `recovered`, never `consolidated`, while a genuinely dead row (missing transcript, or missing cwd) still correctly consolidates."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
