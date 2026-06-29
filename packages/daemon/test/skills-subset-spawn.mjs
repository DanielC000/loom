import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Profile skills-SUBSET delivery at spawn (card 866ba64b). DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE,
// hermetic like browser-testing-spawn.mjs: isolated LOOM_HOME (the store ~/.loom/skills lives here) + a
// sandboxed HOME (so resume()'s transcript check never touches the real ~/.claude), a REAL Db +
// SessionService driven against a FAKE pty via PtyHost's createPty() seam.
//
// Proves the four DoD lines:
//   (A) injectSkills filesystem semantics (the correctness core):
//       (a) a pinned subset → ONLY those skills delivered into <cwd>/.claude/skills;
//       (b) null/empty subset → ALL store skills delivered (the regression-guarded default);
//       (d) LANDMINE 2 — two concurrent sessions sharing ONE cwd with DIFFERENT subsets do NOT strip each
//           other (the shared dir holds the union; a subset change prunes only the owner's stale skills),
//           and the repo's OWN skill is never clobbered.
//   (C) the pinned subset SURVIVES resume + fork + boot: skills is pinned on the session ROW at fresh
//       spawn and re-passed from the row on resume/fork (boot resumes via the same row read) — never
//       re-resolved — so the subset is carried verbatim. Plus resolveProfile backstop/passthrough.
//
// Run: 1) build (turbo builds shared first), 2) node test/skills-subset-spawn.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

// --- Hermetic LOOM_HOME (host.ts log dir + the skill store ~/.loom/skills) AND a sandboxed HOME so
// resume()'s engineTranscriptExists reads under the temp dir, never the real ~/.claude. Before importing. ---
const tmpHome = path.join(os.tmpdir(), `loom-ss-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

// Seed the skill STORE (~/.loom/skills = LOOM_HOME/skills) with four named skills to filter against.
const STORE = path.join(tmpHome, "skills");
const STORE_SKILLS = ["alpha", "beta", "gamma", "delta"];
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
const { resolveProfile } = await import("@loom/shared");

const AGENT = { startupPrompt: "agent own prompt" };

// ===================== resolveProfile backstop + passthrough (claude-free, pure) =====================
check("resolveProfile: null profile ⇒ skills backstops to null (deliver all)", resolveProfile(AGENT, null).skills === null);
const profSub = { id: "p1", name: "Sub", role: "worker", description: "", allowDelta: [], skills: ["alpha", "beta"], model: null, icon: null };
check("resolveProfile: a profile subset passes through verbatim", sameSet(resolveProfile(AGENT, profSub).skills, ["alpha", "beta"]));
check("resolveProfile: a profile with skills:null ⇒ null (all)", resolveProfile(AGENT, { ...profSub, skills: null }).skills === null);

// ===================== (A) injectSkills filesystem delivery semantics =====================
const namesIn = (cwd) => {
  const d = path.join(cwd, ".claude", "skills");
  try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(d, e.name, "SKILL.md"))).map((e) => e.name); }
  catch { return []; }
};
const freshCwd = (tag) => { const c = path.join(tmpHome, `cwd-${tag}`); fs.mkdirSync(c, { recursive: true }); return c; };

// (a) a pinned subset → ONLY those skills (a worker's OWN worktree cwd: exact delivery, no union).
const cwdA = freshCwd("subset");
injectSkills(cwdA, "sA", ["alpha", "gamma"]);
check("(a) subset [alpha,gamma] → exactly those delivered", sameSet(namesIn(cwdA), ["alpha", "gamma"]));
check("(a) subset → beta/delta NOT delivered", !namesIn(cwdA).includes("beta") && !namesIn(cwdA).includes("delta"));

// (a') a subset name not in the store is silently dropped (a stale profile can't conjure a missing skill).
const cwdStale = freshCwd("stale");
injectSkills(cwdStale, "sStale", ["alpha", "ghost"]);
check("(a') subset with a non-store name drops it", sameSet(namesIn(cwdStale), ["alpha"]));

// (b) null subset → ALL store skills (the regression-guarded default — today's behavior).
const cwdAll = freshCwd("all");
injectSkills(cwdAll, "sAll", null);
check("(b) null subset → ALL store skills delivered", sameSet(namesIn(cwdAll), STORE_SKILLS));
// (b') empty array is equivalent to null ⇒ ALL.
const cwdEmpty = freshCwd("empty");
injectSkills(cwdEmpty, "sEmpty", []);
check("(b') empty-array subset → ALL store skills delivered (empty ⇒ all)", sameSet(namesIn(cwdEmpty), STORE_SKILLS));

// (d) LANDMINE 2 — two concurrent sessions SHARE one cwd with DIFFERENT subsets. The repo also has its
// OWN project-local skill that must never be clobbered.
const shared = freshCwd("shared");
execSync("git init -q", { cwd: shared });
fs.mkdirSync(path.join(shared, ".claude", "skills", "repo-own"), { recursive: true });
fs.writeFileSync(path.join(shared, ".claude", "skills", "repo-own", "SKILL.md"), "---\nname: repo-own\ndescription: theirs\n---\nKEEP");

injectSkills(shared, "sX", ["alpha"]);          // session X wants alpha
injectSkills(shared, "sY", ["beta"]);           // session Y wants beta (must NOT strip alpha)
check("(d) shared cwd: BOTH X's alpha and Y's beta present (union, nothing stripped)",
  namesIn(shared).includes("alpha") && namesIn(shared).includes("beta"));
check("(d) shared cwd: the repo's OWN skill is untouched",
  fs.readFileSync(path.join(shared, ".claude", "skills", "repo-own", "SKILL.md"), "utf8").includes("KEEP"));
// the manifest is keyed PER SESSION (map form), each recording only what IT injected.
const manifest = JSON.parse(fs.readFileSync(path.join(shared, ".claude", "skills", ".loom-skills.json"), "utf8"));
check("(d) manifest is per-session keyed", sameSet(manifest.sX, ["alpha"]) && sameSet(manifest.sY, ["beta"]));

// X re-injects (a resume) with its SAME subset → must not strip Y's beta.
injectSkills(shared, "sX", ["alpha"]);
check("(d) X's resume keeps alpha AND does not strip Y's beta",
  namesIn(shared).includes("alpha") && namesIn(shared).includes("beta"));

// X CHANGES its subset alpha→gamma while Y still claims beta: alpha pruned (only X had it), gamma added,
// beta KEPT (Y still claims it), repo-own untouched.
injectSkills(shared, "sX", ["gamma"]);
check("(d) X subset change alpha→gamma: gamma added", namesIn(shared).includes("gamma"));
check("(d) X subset change: X's own stale alpha pruned", !namesIn(shared).includes("alpha"));
check("(d) X subset change: Y's beta survives (not X's to prune)", namesIn(shared).includes("beta"));
check("(d) X subset change: repo-own STILL untouched",
  fs.existsSync(path.join(shared, ".claude", "skills", "repo-own", "SKILL.md")));

// Y now drops its subset → ALL (null). The shared dir becomes the union of {gamma (X)} ∪ {all (Y)} = all.
// Crucially X's gamma is NOT stripped by Y delivering all.
injectSkills(shared, "sY", null);
check("(d) Y→all does not strip X's gamma", namesIn(shared).includes("gamma"));
check("(d) Y→all delivers the full store", STORE_SKILLS.every((n) => namesIn(shared).includes(n)));

// ===================== (C) the pinned subset survives resume / fork / boot (row + threading) =====================
const repo = path.join(os.tmpdir(), `loom-ss-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# skills-subset-spawn test\n");
execSync(`git init -q && git add . && git -c user.email=ss@loom -c user.name=ss commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pP", name: "P", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
// A profile that PINS a skills subset, and a plain (no-subset) profile to regression-guard the default.
db.insertProfile({ id: "profSub", name: "Subset", role: null, description: "subset rig", allowDelta: [], skills: ["alpha", "beta"], model: null, icon: null });
db.insertProfile({ id: "profWorkerSub", name: "WorkerSubset", role: "worker", description: "worker subset rig", allowDelta: [], skills: ["gamma"], model: null, icon: null });
db.insertAgent({ id: "agentSub", projectId: "pP", name: "Sub", startupPrompt: "SUB_PROMPT", position: 0, profileId: "profSub" });
db.insertAgent({ id: "agentPlain", projectId: "pP", name: "Plain", startupPrompt: "PLAIN_PROMPT", position: 1, profileId: null });
db.insertAgent({ id: "agentWorkerSub", projectId: "pP", name: "WSub", startupPrompt: "WSUB_PROMPT", position: 2, profileId: "profWorkerSub" });
db.insertSession({ id: "mgr1", projectId: "pP", agentId: "agentPlain", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
// worker_spawn validates taskId (PL finding #1): the success-case spawn needs a real, non-terminal task.
const tW1 = "11111111-1111-4111-8111-111111111111";
db.insertTask({ id: tW1, projectId: "pP", title: "t", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

check("(roundtrip) profile persists its skills subset", sameSet(db.getProfile("profSub").skills, ["alpha", "beta"]));
check("(roundtrip) a plain profile reads skills:null", db.getProfile("profWorkerSub") && db.getProfile("profSub") && db.getProfile("profSub").skills !== null);

class SeamHost extends PtyHost {
  constructor(events) { super(events); this.capture = []; }
  createPty(opts) { this.capture.push(opts); return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
  // resume()'s already-live short-circuit consults pty.isAlive: this capture seam drives NO live OS pty,
  // so report not-live — the test resumes a (notionally stopped) session to inspect its resume spawn args.
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

let workerWorktree = null;
try {
  // startNew on a subset-profile agent → skills threads to spawn opts + the persisted row.
  const sSub = svc.startNew("agentSub");
  const oSub = optsFor(sSub.id);
  check("(C) startNew: spawn opts.skills === the profile subset", sameSet(oSub?.skills ?? [], ["alpha", "beta"]));
  check("(C) startNew: returned session.skills === subset", sameSet(sSub.skills ?? [], ["alpha", "beta"]));
  check("(C) startNew: DB ROW pins the subset (what boot/resume read)", sameSet(db.getSession(sSub.id).skills ?? [], ["alpha", "beta"]));

  // startNew on a plain agent → null (regression-guard: byte-identical, all skills).
  const sPlain = svc.startNew("agentPlain");
  const oPlain = optsFor(sPlain.id);
  check("(C) startNew plain agent: spawn opts.skills is null (deliver all)", (oPlain?.skills ?? null) === null);
  check("(C) startNew plain agent: DB row skills is null (today's default)", db.getSession(sPlain.id).skills === null);

  // RESUME the subset session → skills re-passed from the PINNED ROW (not re-resolved), exactly like role.
  const engId = "11111111-2222-3333-4444-555555555555";
  db.setEngineSessionId(sSub.id, engId);
  const tpath = engineTranscriptPath(repo, engId);
  fs.mkdirSync(path.dirname(tpath), { recursive: true });
  fs.writeFileSync(tpath, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");
  host.capture.length = 0;
  svc.resume(sSub.id);
  check("(C) RESUME re-passes the pinned subset from the row", sameSet(optsFor(sSub.id)?.skills ?? [], ["alpha", "beta"]));

  // Mutate the PROFILE after spawn — resume must STILL use the pinned row value, never re-resolve.
  db.updateProfile("profSub", { skills: ["delta"] });
  host.capture.length = 0;
  svc.resume(sSub.id);
  check("(C) RESUME ignores a post-spawn profile change (uses the pinned row, not re-resolution)",
    sameSet(optsFor(sSub.id)?.skills ?? [], ["alpha", "beta"]));

  // FORK the subset session → the fork inherits the source row's subset (opts + the new fork row).
  db.setBusy(sSub.id, false);
  const fork = svc.forkSession(sSub.id);
  check("(C) FORK: spawn opts.skills inherits the source subset", sameSet(optsFor(fork.id)?.skills ?? [], ["alpha", "beta"]));
  check("(C) FORK: the fork's DB row pins the same subset", sameSet(db.getSession(fork.id).skills ?? [], ["alpha", "beta"]));

  // BOOT: resumeFleetOnBoot resumes each captured session via resume(), which reads skills FROM THE ROW.
  // Drive it directly to prove a daemon-restart carries the subset forward.
  host.capture.length = 0;
  const bootRes = svc.resumeFleetOnBoot(
    { managerSessionId: "mgr1", reason: "test", resume: [{ sessionId: sSub.id, role: null, parentSessionId: null }], pending: {} },
    { resumeOne: (id) => { try { svc.resume(id); return true; } catch { return false; } } },
  );
  check("(C) BOOT: resumeFleetOnBoot resumed the subset session", bootRes.resumed.includes(sSub.id));
  check("(C) BOOT: the resumed spawn carries the pinned subset (survives daemon restart)",
    sameSet(optsFor(sSub.id)?.skills ?? [], ["alpha", "beta"]));

  // spawnWorker pointed at a subset worker profile → resolves + pins the subset (worker = own worktree).
  const wSub = await svc.spawnWorker("mgr1", { taskId: tW1, agentId: "agentWorkerSub", kickoffPrompt: "GO" });
  workerWorktree = wSub.worktreePath;
  check("(C) spawnWorker: spawn opts.skills === the worker profile subset", sameSet(optsFor(wSub.id)?.skills ?? [], ["gamma"]));
  check("(C) spawnWorker: DB row pins the worker subset", sameSet(db.getSession(wSub.id).skills ?? [], ["gamma"]));
} finally {
  try {
    const { removeWorktree } = await import("../dist/git/worktrees.js");
    for (const wt of [].concat(workerWorktree).filter(Boolean)) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } }
  } catch { /* best-effort */ }
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — profile skills-subset: injectSkills delivers only the pinned subset (null/empty ⇒ all); two concurrent sessions sharing a cwd never strip each other (per-session manifest, union delivery, repo-own safe); the subset is pinned on the row + survives resume/fork/boot — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
