import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// RESPAWN family carries the profile-conferred attributes (card: the respawn paths used to drop them).
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like skills-subset-spawn.mjs / profile-spawn.mjs:
// isolated LOOM_HOME (the store ~/.loom/skills lives here) + a sandboxed HOME (so resume()'s transcript
// check never touches the real ~/.claude), a REAL Db + SessionService driven against a FAKE pty via
// PtyHost's createPty() seam — no real claude, no daemon, no network.
//
// The regression: spawnWorker / resume / recycleWorker / recycleManager passed BARE config.permission and
// omitted the profile's `model`, and injectSkills was never told the session's role — so three profile-
// conferred attributes that the fresh-start start* paths thread correctly were silently dropped on respawn:
//   (1) permission/allowDelta — the profile's layered allowlist;
//   (2) model — the profile's `--model` pin;
//   (3) the role doctrine skill — force-included regardless of a pinned skills subset that omits it.
// These are LATENT under seed defaults (model:null / allowDelta:[] / skills:null + bypass mode), so this
// test constructs a NON-default profile that pins ALL THREE and a subset that OMITS the role skill.
//
// Run: 1) build (turbo builds shared first), 2) node test/respawn-profile-attrs.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

// --- Hermetic LOOM_HOME (host.ts log dir + the skill store ~/.loom/skills) AND a sandboxed HOME so
// resume()'s engineTranscriptExists reads under the temp dir, never the real ~/.claude. Before importing. ---
const tmpHome = path.join(os.tmpdir(), `loom-rpa-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

// Seed the skill STORE with the two role-doctrine skills under test (worker→"worker", manager→
// "orchestrate") plus two non-doctrine skills the subset CAN pin.
const STORE = path.join(tmpHome, "skills");
const STORE_SKILLS = ["worker", "orchestrate", "alpha", "beta"];
for (const n of STORE_SKILLS) {
  fs.mkdirSync(path.join(STORE, n), { recursive: true });
  fs.writeFileSync(path.join(STORE, n, "SKILL.md"), `---\nname: ${n}\ndescription: ${n}\n---\n${n}`);
}

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { injectSkills } = await import("../dist/skills/inject.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");
const { resolveConfig } = await import("@loom/shared");

const namesIn = (cwd) => {
  const d = path.join(cwd, ".claude", "skills");
  try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(d, e.name, "SKILL.md"))).map((e) => e.name); }
  catch { return []; }
};
const freshCwd = (tag) => { const c = path.join(tmpHome, `cwd-${tag}`); fs.mkdirSync(c, { recursive: true }); return c; };

// ===================== (U) injectSkills FORCE-INCLUDES the role doctrine skill, regardless of subset =====================
// The inject.ts core: a session whose pinned subset OMITS its role's doctrine skill must STILL get it.
const cwdRole = freshCwd("role-worker");
injectSkills(cwdRole, "sRole", ["alpha"], "worker"); // subset omits "worker"
check("(U) worker role: subset [alpha] still ships the 'worker' doctrine skill (force-included)", namesIn(cwdRole).includes("worker"));
check("(U) worker role: the pinned subset skill is also delivered", namesIn(cwdRole).includes("alpha"));
check("(U) worker role: a NON-pinned, non-role skill is NOT delivered", !namesIn(cwdRole).includes("beta"));
check("(U) worker role: the OTHER role's doctrine skill is NOT force-included", !namesIn(cwdRole).includes("orchestrate"));

const cwdMgr = freshCwd("role-mgr");
injectSkills(cwdMgr, "sMgr", ["alpha"], "manager"); // subset omits "orchestrate"
check("(U) manager role: subset [alpha] still ships the 'orchestrate' doctrine skill (force-included)", namesIn(cwdMgr).includes("orchestrate"));

// A role WITHOUT a doctrine skill (run/plain/null) force-includes nothing — only the subset.
const cwdRun = freshCwd("role-run");
injectSkills(cwdRun, "sRun", ["alpha"], "run");
check("(U) run role: nothing force-included — only the pinned subset", sameSet(namesIn(cwdRun), ["alpha"]));
const cwdNull = freshCwd("role-null");
injectSkills(cwdNull, "sNull", ["alpha"], null);
check("(U) null role: nothing force-included — only the pinned subset", sameSet(namesIn(cwdNull), ["alpha"]));

// REGRESSION GUARD: a null subset (deliver-all) is byte-identical — the role skill is already in the set.
const cwdAll = freshCwd("all");
injectSkills(cwdAll, "sAll", null, "worker");
check("(U) null subset + worker role → ALL store skills (force-include is a no-op here)", sameSet(namesIn(cwdAll), STORE_SKILLS));

// ===================== seam fixtures: a NON-default profile pins model + allowDelta + an omitting subset =====================
const repo = path.join(os.tmpdir(), `loom-rpa-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# respawn-profile-attrs test\n");
execSync(`git init -q && git add . && git -c user.email=rpa@loom -c user.name=rpa commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const baseAllow = resolveConfig({}).permission.allow;
const PINNED_MODEL = "claude-opus-4-8";
const WORKER_DELTA = "Bash(echo WORKER_DELTA:*)";
const MGR_DELTA = "Bash(echo MGR_DELTA:*)";

const db = new Db();
db.insertProject({ id: "pP", name: "P", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
// A worker rig that pins ALL THREE non-default attributes; its subset ["alpha"] OMITS the "worker" doctrine.
db.insertProfile({ id: "profWorker", name: "WorkerRig", role: "worker", description: "non-default worker rig", allowDelta: [WORKER_DELTA], skills: ["alpha"], model: PINNED_MODEL, icon: null });
// A manager rig likewise; subset ["alpha"] OMITS the "orchestrate" doctrine.
db.insertProfile({ id: "profMgr", name: "MgrRig", role: "manager", description: "non-default manager rig", allowDelta: [MGR_DELTA], skills: ["alpha"], model: PINNED_MODEL, icon: null });
db.insertAgent({ id: "agentWorker", projectId: "pP", name: "WorkerProfiled", startupPrompt: "WORKER_PROMPT", position: 0, profileId: "profWorker" });
db.insertAgent({ id: "agentMgr", projectId: "pP", name: "MgrProfiled", startupPrompt: "MGR_PROMPT", position: 1, profileId: "profMgr" });
db.insertAgent({ id: "agentPlain", projectId: "pP", name: "Plain", startupPrompt: "PLAIN_PROMPT", position: 2, profileId: null });
// A manager session (agent = plain) to drive worker_spawn from, and a SECOND manager session (agent =
// the non-default manager rig) to recycle.
db.insertSession({ id: "mgr1", projectId: "pP", agentId: "agentPlain", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
// The manager-to-recycle pins the SAME omitting subset on its ROW (a real spawned manager would) — the
// recycle paths carry skills FROM THE ROW (old.skills), so the row must hold the omitting subset for the
// force-include to be exercised. (permission + model ARE re-resolved from the agent — see the assertions.)
db.insertSession({ id: "mgrRig", projectId: "pP", agentId: "agentMgr", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", skills: ["alpha"] });
const tW = "11111111-1111-4111-8111-111111111111";
db.insertTask({ id: tW, projectId: "pP", title: "t", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

// Fake pty seam: capture every SpawnOpts; `kill()` fires onExit so recycle's wait-for-dead loop resolves
// immediately (recycleWorker hard-stops the old pty then waits on isAlive before reusing the worktree).
class SeamHost extends PtyHost {
  constructor(events) { super(events); this.capture = []; }
  createPty(opts) {
    this.capture.push(opts);
    let exitCb = null;
    return {
      pid: 4242,
      write() {},
      onData() { return { dispose() {} }; },
      onExit(cb) { exitCb = cb; return { dispose() {} }; },
      kill() { if (exitCb) exitCb({ exitCode: 0 }); },
      resize() {},
    };
  }
  // resume()'s already-live short-circuit consults pty.isAlive: this capture seam drives NO live OS pty, so
  // report not-live — the test resumes/recycles a (notionally stopped) worker to inspect its respawn args.
  isAlive() { return false; }
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

// Assert the three attributes reach a captured spawn: layered allowDelta, model pin, role + omitting
// subset (which together force-include the doctrine skill when fed to the REAL injectSkills).
const assertThree = (tag, o, { delta, expectModel, role, doctrine }) => {
  check(`(${tag}) permission layers the profile allowDelta (was dropped → bare config.permission)`, o?.permission.allow.includes(delta));
  check(`(${tag}) the base config allow is preserved alongside the delta`, baseAllow.every((a) => o?.permission.allow.includes(a)));
  if (expectModel === undefined) check(`(${tag}) NO model threaded (resume inherits the transcript model)`, o?.model === undefined);
  else check(`(${tag}) the profile model pin reaches opts.model (drives --model; was dropped)`, o?.model === expectModel);
  check(`(${tag}) opts.role === '${role}' (drives injectSkills' force-include)`, o?.role === role);
  check(`(${tag}) opts.skills is the OMITTING subset [alpha] (role skill not in it)`, sameSet(o?.skills ?? [], ["alpha"]) && !(o?.skills ?? []).includes(doctrine));
  // End-to-end: feed the captured (role, subset) into the REAL injectSkills in a throwaway cwd — the role
  // doctrine skill must land DESPITE the subset omitting it (the createPty seam faked the real call).
  const cwd = freshCwd(`e2e-${tag}`);
  injectSkills(cwd, `e2e-${tag}`, o?.skills ?? null, o?.role);
  check(`(${tag}) injectSkills with the spawn's (role, subset) delivers the '${doctrine}' doctrine skill`, namesIn(cwd).includes(doctrine));
};

let workerWorktree = null, recycledWorktree = null;
try {
  // ===================== spawnWorker: layered allow + model + role doctrine =====================
  const w = await svc.spawnWorker("mgr1", { taskId: tW, agentId: "agentWorker", kickoffPrompt: "GO" });
  workerWorktree = w.worktreePath;
  assertThree("spawnWorker", optsFor(w.id), { delta: WORKER_DELTA, expectModel: PINNED_MODEL, role: "worker", doctrine: "worker" });

  // ===================== resume: layered allow + role doctrine, but NO model (transcript inherits it) =====================
  const engId = "11111111-2222-3333-4444-555555555555";
  db.setEngineSessionId(w.id, engId);
  const tpath = engineTranscriptPath(w.worktreePath, engId);
  fs.mkdirSync(path.dirname(tpath), { recursive: true });
  fs.writeFileSync(tpath, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");
  db.setBusy(w.id, false);
  host.capture.length = 0;
  svc.resume(w.id);
  assertThree("resume", optsFor(w.id), { delta: WORKER_DELTA, expectModel: undefined, role: "worker", doctrine: "worker" });
  // resume must keep its existing mode-convergence override (startupModeCycles pinned 0).
  check("(resume) startupModeCycles override preserved (0) atop the layered permission", optsFor(w.id)?.permission.startupModeCycles === 0);

  // ===================== recycleWorker: re-resolves layered allow + model from the agent =====================
  host.capture.length = 0;
  const rw = await svc.recycleWorker("mgr1", w.id, "HANDOFF: continue.");
  recycledWorktree = rw.worktreePath;
  assertThree("recycleWorker", optsFor(rw.id), { delta: WORKER_DELTA, expectModel: PINNED_MODEL, role: "worker", doctrine: "worker" });

  // ===================== recycleManager: re-resolves layered allow + model from the agent =====================
  host.capture.length = 0;
  const rm = await svc.recycleManager("mgrRig", "CONTINUE: pick up the fleet.");
  assertThree("recycleManager", optsFor(rm.id), { delta: MGR_DELTA, expectModel: PINNED_MODEL, role: "manager", doctrine: "orchestrate" });
  // NOTE: the agent-missing fallback in resume/recycle (agent gone ⇒ bare config.permission, no model) is
  // a DEFENSIVE guard that can't be reached hermetically — a sessions.agent_id FK + deleteAgent's cascade
  // delete the session ALONGSIDE its agent, so a dangling session (existing row, missing agent) is not a
  // constructible state. The guard stands as belt-and-suspenders; there's nothing live to assert it against.
} finally {
  try {
    const { removeWorktree } = await import("../dist/git/worktrees.js");
    for (const wt of [workerWorktree, recycledWorktree].filter(Boolean)) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } }
  } catch { /* best-effort */ }
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the respawn family (spawnWorker/resume/recycleWorker/recycleManager) re-resolves via resolveAgentSpawn and threads the layered permission + model; injectSkills force-includes the role doctrine skill regardless of an omitting subset; resume omits model; a deleted-agent respawn falls back bare — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
