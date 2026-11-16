import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 936dd348 — resume() refuses a role:"worker" row onto a task that already has a (pty-VERIFIED) live
// worker, through the SAME claimTaskWorktreeRefusal predicate worker_spawn/worker_recycle use. Both human
// paths pass allowSuperseded:true (REST /resume, archive restore); the bypass must NOT reach this check.
//
// DETERMINISTIC + CLAUDE-FREE: a REAL Db + SessionService over a FAKE pty (createSeamHost), like
// setup-session-resume-barred.mjs (the 39b58667 sibling-liveness posture this mirrors).
//
//   (A) REST-shaped resume ({allowSuperseded:true}) of an exited worker while another worker on the SAME
//       task is pty-alive → refused with the clear error; nothing spawned, rows untouched.
//   (B) archive restore (restoreSession) of an ARCHIVED exited worker, same occupied task → refused, and
//       the row stays archived.
//   (C) the other worker is only PHANTOM-live (DB "live", not pty-alive) → resume succeeds.
//   (D) the other worker is gone (exited) → resume succeeds (control).
//   (E) a worker on a DIFFERENT task, and a non-worker row on the occupied task → unaffected (controls).
//   (F) boot/crash-recovery shape: two exited-then-DB-live workers for ONE task, neither pty-alive →
//       the first resume succeeds, the second is then refused (exactly one engine on the task).
//   (G) the live worker itself re-resumed → idempotent no-op (pre-existing isAlive short-circuit).
//   (H) REST routes map the refusal to 409 (resume) and 409 (restore), not 500/400.
//
// Run: build first, then node test/resume-refuses-occupied-task.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `lrot-${process.pid}`); // SHORT prefix (Windows path-length)
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
const { commitAll } = await import("./_git-commit.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService, TASK_CLAIM_RESUME_REFUSAL_PREFIX } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { CLEAN_STALENESS } = await import("./_deploy-staleness-fixture.mjs");
const { encodeProjectDir } = await import("../dist/sessions/transcript.js");
const { buildServer } = await import("../dist/gateway/server.js");

const repo = path.join(os.tmpdir(), `lrot-r-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# resume-occupied-task test repo\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=occ@loom -c user.name=occ");

const writeTranscript = (cwd, eng) => {
  const dir = path.join(sandboxHome, ".claude", "projects", encodeProjectDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${eng}.jsonl`), `{"type":"user","message":{"content":"hi"}}\n`);
};

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pW", name: "pW", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "agentW", projectId: "pW", name: "W", startupPrompt: "WORK", position: 0, profileId: null });

class SeamHost extends createSeamHost(PtyHost) {
  constructor(events) { super(events); this.spawned = []; }
  createPty(opts) { this.spawned.push(opts); return super.createPty(opts); }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

const seed = (id, role, processState, taskId, extra = {}) => {
  writeTranscript(repo, `eng-${id}`);
  db.insertSession({
    id, projectId: "pW", agentId: "agentW", engineSessionId: `eng-${id}`, title: null,
    cwd: repo, processState, resumability: "unknown", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role, parentSessionId: null, taskId,
    ...extra,
  });
};
const refusedWithPrefix = (e) => !!e && typeof e.message === "string" && e.message.startsWith(TASK_CLAIM_RESUME_REFUSAL_PREFIX);

check("(setup) TASK_CLAIM_RESUME_REFUSAL_PREFIX is a non-empty string", typeof TASK_CLAIM_RESUME_REFUSAL_PREFIX === "string" && TASK_CLAIM_RESUME_REFUSAL_PREFIX.length > 0);

try {
  // (A) REST-shaped resume refused onto an occupied task
  seed("liveA", "worker", "live", "taskA");
  svc.resume("liveA");
  check("(A) liveA is genuinely pty-alive", host.isAlive("liveA"));
  seed("exitedA", "worker", "exited", "taskA");
  const spawnedA = host.spawned.length;
  let errA;
  try { svc.resume("exitedA", { allowSuperseded: true }); } catch (e) { errA = e; }
  check("(A) resume({allowSuperseded:true}) of a worker onto an occupied task is refused", refusedWithPrefix(errA));
  check("(A) the error names the holder and says what to do", !!errA && errA.message.includes("liveA") && /stop|recycle/.test(errA.message));
  check("(A) no spawn happened and exitedA stays exited", host.spawned.length === spawnedA && db.getSession("exitedA")?.processState === "exited" && !host.isAlive("exitedA"));
  check("(A) the holder stays live", host.isAlive("liveA") && db.getSession("liveA")?.processState === "live");

  // (B) archive restore refused, row stays archived
  seed("archB", "worker", "exited", "taskA");
  db.archiveSession("archB");
  let errB;
  try { svc.restoreSession("archB"); } catch (e) { errB = e; }
  check("(B) restoreSession of an archived worker onto an occupied task is refused", refusedWithPrefix(errB));
  check("(B) the row stays archived and exited", db.getSession("archB")?.archivedAt != null && db.getSession("archB")?.processState === "exited");

  // (C) phantom-live other worker → resume succeeds
  seed("phantomC", "worker", "live", "taskC"); // DB-live, never pty-spawned
  seed("exitedC", "worker", "exited", "taskC");
  check("(C) phantomC is DB-live but NOT pty-alive", !host.isAlive("phantomC") && db.getSession("phantomC")?.processState === "live");
  let errC, resC;
  try { resC = svc.resume("exitedC", { allowSuperseded: true }); } catch (e) { errC = e; }
  check("(C) a phantom-live holder does not refuse the resume", !errC && resC?.id === "exitedC" && host.isAlive("exitedC"));

  // (D) other worker gone → succeeds
  seed("goneD", "worker", "exited", "taskD");
  seed("exitedD", "worker", "exited", "taskD");
  let errD, resD;
  try { resD = svc.resume("exitedD", { allowSuperseded: true }); } catch (e) { errD = e; }
  check("(D) CONTROL: no live holder → resume succeeds", !errD && resD?.id === "exitedD" && host.isAlive("exitedD"));

  // (E) controls: different task / non-worker role on occupied task
  seed("exitedE1", "worker", "exited", "taskE-other");
  let errE1; try { svc.resume("exitedE1", { allowSuperseded: true }); } catch (e) { errE1 = e; }
  check("(E) CONTROL: a worker on a different task is unaffected", !errE1 && host.isAlive("exitedE1"));
  seed("exitedE2", "assistant", "exited", "taskA");
  let errE2; let resE2; try { resE2 = svc.resume("exitedE2"); } catch (e) { errE2 = e; }
  check("(E) CONTROL: a non-worker row on an occupied task is unaffected — it ACTUALLY resumed", !errE2 && resE2?.id === "exitedE2" && host.isAlive("exitedE2") && db.getSession("exitedE2")?.processState === "live");

  // (F) boot-race / crash-recovery shape
  seed("bootF1", "worker", "live", "taskF");
  seed("bootF2", "worker", "live", "taskF");
  let errF1, errF2;
  try { svc.resume("bootF1"); } catch (e) { errF1 = e; }
  try { svc.resume("bootF2"); } catch (e) { errF2 = e; }
  check("(F) first of two DB-live (not pty-alive) workers resumes", !errF1 && host.isAlive("bootF1"));
  check("(F) the second is then refused — one engine per task", refusedWithPrefix(errF2) && !host.isAlive("bootF2"));

  // (G) already-live idempotency
  const spawnedG = host.spawned.length;
  let errG; try { svc.resume("liveA", { allowSuperseded: true }); } catch (e) { errG = e; }
  check("(G) re-resuming the live holder itself is a no-op", !errG && host.spawned.length === spawnedG);

  // (I) merge in flight for the task (no live holder at all) → refused with resume wording; free after settle
  seed("exitedI", "worker", "exited", "taskI");
  svc.inFlightMergeTaskIds.set("taskI", new Set(["op-I"]));
  let errI; try { svc.resume("exitedI", { allowSuperseded: true }); } catch (e) { errI = e; }
  check("(I) a merge in flight for the task refuses the resume", refusedWithPrefix(errI) && errI.message.includes("op-I") && /resume after it settles/.test(errI.message) && !/re-spawn/.test(errI.message));
  check("(I) the row stayed exited and nothing spawned for it", db.getSession("exitedI")?.processState === "exited" && !host.isAlive("exitedI"));
  svc.inFlightMergeTaskIds.delete("taskI");
  let errI2; try { svc.resume("exitedI", { allowSuperseded: true }); } catch (e) { errI2 = e; }
  check("(I) once the merge settles the same resume succeeds", !errI2 && host.isAlive("exitedI"));

  // (J) spawn/recycle in flight for the task (createWorktree window — no live row yet) → refused
  seed("exitedJ", "worker", "exited", "taskJ");
  svc.inFlightSpawnTaskIds.add("taskJ");
  let errJ; try { svc.resume("exitedJ", { allowSuperseded: true }); } catch (e) { errJ = e; }
  check("(J) a spawn/recycle in flight for the task refuses the resume", refusedWithPrefix(errJ) && /in flight/.test(errJ.message) && !host.isAlive("exitedJ"));
  svc.inFlightSpawnTaskIds.delete("taskJ");
  let errJ2; try { svc.resume("exitedJ", { allowSuperseded: true }); } catch (e) { errJ2 = e; }
  check("(J) once the spawn settles the same resume succeeds", !errJ2 && host.isAlive("exitedJ"));

  // (K) findTaskClaimRefusal (the watcher's read-only twin) agrees with resume()
  seed("exitedK", "worker", "exited", "taskA");
  check("(K) findTaskClaimRefusal names the holder for an occupied task", /liveA/.test(svc.findTaskClaimRefusal("exitedK") ?? ""));
  check("(K) findTaskClaimRefusal is undefined for a free task, a taskless worker, a non-worker and an unknown id",
    svc.findTaskClaimRefusal("exitedD") === undefined && svc.findTaskClaimRefusal("nope") === undefined && svc.findTaskClaimRefusal("exitedE2") === undefined);

  // (L) boot: a claim refusal is a skipped, not-a-failure outcome (never in `failed`, no fleet_resume_failed)
  seed("mgrL", "manager", "live", null);
  seed("exitedL", "worker", "exited", "taskA", { parentSessionId: "mgrL" });
  const intentL = {
    reason: "deploy", managerSessionId: "mgrL", requestedAt: now,
    resume: [
      { sessionId: "mgrL", role: "manager", parentSessionId: null },
      { sessionId: "exitedL", role: "worker", parentSessionId: "mgrL" },
    ],
  };
  const resumeOneL = (sid) => { if (sid === "mgrL") return { ok: true }; try { svc.resume(sid); return { ok: true }; } catch (e) { return { ok: false, reason: e.message }; } };
  const resL = svc.resumeFleetOnBoot(intentL, { resumeOne: resumeOneL, deployStaleness: CLEAN_STALENESS });
  check("(L) boot: the held worker is in taskClaimSkipped with its reason", resL.taskClaimSkipped.length === 1 && resL.taskClaimSkipped[0].sessionId === "exitedL" && refusedWithPrefix({ message: resL.taskClaimSkipped[0].reason }));
  check("(L) boot: it is NOT in failed or resumed, and no fleet_resume_failed is filed",
    !resL.failed.includes("exitedL") && !resL.resumed.includes("exitedL") && db.listEvents("mgrL").filter((ev) => ev.kind === "fleet_resume_failed" || ev.kind === "fleet_resume_entry_failed").length === 0);

  // (H) REST mapping through the real service
  const stub = {};
  const app = await buildServer({ db, pty: host, sessions: svc, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });
  const rResume = await app.inject({ method: "POST", url: "/api/sessions/exitedA/resume" });
  check("(H) POST /resume onto an occupied task ⇒ 409 with the reason", rResume.statusCode === 409 && String(JSON.parse(rResume.body).error).startsWith(TASK_CLAIM_RESUME_REFUSAL_PREFIX));
  const rRestore = await app.inject({ method: "POST", url: "/api/sessions/archB/restore" });
  check("(H) POST /restore onto an occupied task ⇒ 409 with the reason", rRestore.statusCode === 409 && String(JSON.parse(rRestore.body).error).startsWith(TASK_CLAIM_RESUME_REFUSAL_PREFIX));
  await app.close();
} finally {
  db.close();
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n✅ ALL PASS — resume()/restore refuse a worker onto an occupied task on verified liveness." : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
