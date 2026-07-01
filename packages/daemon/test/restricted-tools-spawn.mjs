import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Companion RESTRICTED-tools profile flag (blast-radius control). DETERMINISTIC + CLAUDE-FREE +
// NETWORK-FREE, hermetic like browser-testing-spawn.mjs / disallow-prompt-tools.mjs: isolated LOOM_HOME +
// a sandboxed HOME (so resume's transcript check never touches the real ~/.claude), a REAL Db +
// SessionService driven against a FAKE pty injected via PtyHost's createPty() seam. A real temp git repo
// backs spawnWorker's createWorktree; the only thing faked is the claude pty.
//
// The flag: a HUMAN-set Profile boolean (restrictedTools) that, when on, UNIONs a curated, HARDCODED set
// of dangerous NATIVE tools (Bash/Edit/Write/NotebookEdit/MultiEdit) into the spawn's --disallowedTools —
// removing them from the model's tool list — ON TOP of the role's human-prompt disallow. Subtractive:
// unlike browserTesting it withdraws capability. Default OFF + byte-identical when off.
//
// Proves:
//   (P) RESTRICTED_NATIVE_TOOLS content + frozen; disallowedToolsForSpawn OFF == disallowedToolsForRole
//       (byte-identical), ON == the de-duped union (role human-prompt tools + the restricted set).
//   (A) buildSpawnArgs with the restricted list emits --disallowedTools INCLUDING the restricted set AND
//       still the role's human-prompt tools, before --strict-mcp-config (the H2 ordering invariant), with
//       the prompt still last behind `--`; flag OFF ⇒ argv BYTE-IDENTICAL to today.
//   (B) resolveProfile backstops restrictedTools to false (null/absent/unset profile) + passes it through.
//   (H) HUMAN-set-only: the PROFILE validator (human REST) accepts it, and the AGENT-facing project-config
//       validator REJECTS it (it is not a config field — no agent path can smuggle it in).
//   (e2e) the flag threads through startNew (worker AND assistant/companion) → spawn opts + the persisted
//       row; a plain agent stays false (byte-identical); RESUME/fork/recycleWorker re-apply it from the row.
//
// Run: 1) build (turbo builds shared first), 2) node test/restricted-tools-spawn.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- Hermetic LOOM_HOME + sandboxed HOME (resume's engineTranscriptExists reads under the temp dir). ---
const tmpHome = path.join(os.tmpdir(), `loom-rt-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { Db } = await import("../dist/db.js");
const { PtyHost, buildSpawnArgs, disallowedToolsForRole, disallowedToolsForSpawn, RESTRICTED_NATIVE_TOOLS, HUMAN_PROMPT_TOOLS } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");
const { validateProfile } = await import("../dist/profiles/validate.js");
const { validateAgentProjectConfigOverride } = await import("../dist/mcp/platform.js");
const { resolveProfile } = await import("@loom/shared");

const AGENT = { startupPrompt: "agent own prompt" };
const mcpServers = { "loom-tasks": { type: "http", url: `http://127.0.0.1:${process.env.LOOM_PORT || 4317}/mcp/s1` } };
const RESTRICTED = ["Bash", "Edit", "Write", "NotebookEdit", "MultiEdit", "Task", "Agent", "WebFetch", "WebSearch"];

// ===================== (P) the restricted set + the merge helper =====================
check("(P) RESTRICTED_NATIVE_TOOLS = shell/host-writes + subagent-delegation (Task/Agent) + network egress (WebFetch/WebSearch)",
  eq([...RESTRICTED_NATIVE_TOOLS], RESTRICTED));
check("(P) the residual-bypass tools are in the set: subagent-delegation (Task+Agent) + network egress (WebFetch+WebSearch)",
  ["Task", "Agent", "WebFetch", "WebSearch"].every((t) => RESTRICTED_NATIVE_TOOLS.includes(t)));
check("(P) RESTRICTED_NATIVE_TOOLS does NOT restrict Read/Glob/Grep (read-only) or MCP tools",
  !["Read", "Glob", "Grep"].some((t) => RESTRICTED_NATIVE_TOOLS.includes(t)) &&
  ![...RESTRICTED_NATIVE_TOOLS].some((t) => t.startsWith("mcp__")));
// The exported constant is frozen — a caller can't mutate the shared set.
check("(P) RESTRICTED_NATIVE_TOOLS is frozen (immutable)", Object.isFrozen(RESTRICTED_NATIVE_TOOLS));

// OFF: disallowedToolsForSpawn(role, false) is EXACTLY disallowedToolsForRole(role) — byte-identical.
for (const role of ["worker", "assistant", "manager", null, undefined]) {
  check(`(P) OFF role '${String(role)}': disallowedToolsForSpawn == disallowedToolsForRole (byte-identical)`,
    eq(disallowedToolsForSpawn(role, false), disallowedToolsForRole(role)));
  check(`(P) absent restrictedTools arg role '${String(role)}': also byte-identical`,
    eq(disallowedToolsForSpawn(role), disallowedToolsForRole(role)));
}
// ON, worker: the union is the role's human-prompt tools FOLLOWED BY the restricted native set, de-duped.
{
  const merged = disallowedToolsForSpawn("worker", true);
  check("(P) ON worker: union = human-prompt tools + restricted native set (role tools first)",
    eq(merged, [...HUMAN_PROMPT_TOOLS, ...RESTRICTED]));
  check("(P) ON worker: every restricted native tool present", RESTRICTED.every((t) => merged.includes(t)));
  check("(P) ON worker: the human-prompt disallow is STILL present (union, not replacement)",
    HUMAN_PROMPT_TOOLS.every((t) => merged.includes(t)));
  check("(P) ON worker: no duplicate tokens", merged.length === new Set(merged).size);
}
// ON, a role with NO human-prompt disallow (manager/plain): just the restricted set (orthogonal to role).
check("(P) ON manager: only the restricted native set (manager has no human-prompt disallow)",
  eq(disallowedToolsForSpawn("manager", true), RESTRICTED));
check("(P) ON null role: only the restricted native set (orthogonal to role)",
  eq(disallowedToolsForSpawn(null, true), RESTRICTED));
// The returned array is a fresh copy (no shared-state mutation of the frozen constant / role list).
{ const a = disallowedToolsForSpawn("worker", true); a.push("X"); check("(P) returns a fresh array (no shared-state mutation)", disallowedToolsForSpawn("worker", true).length === HUMAN_PROMPT_TOOLS.length + RESTRICTED.length); }

// ===================== (A) buildSpawnArgs emits + orders the merged --disallowedTools =====================
{
  const tools = disallowedToolsForSpawn("assistant", true); // a companion: human-prompt + restricted union
  const args = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: "chat back", disallowedTools: tools });
  const d = args.indexOf("--disallowedTools");
  const strict = args.indexOf("--strict-mcp-config");
  const cfg = args.indexOf("--mcp-config");
  const sep = args.indexOf("--");
  check("(A) companion(restricted): --disallowedTools is present", d !== -1);
  check("(A) companion(restricted): the merged names follow the flag, in union order",
    eq(args.slice(d + 1, d + 1 + tools.length), tools));
  check("(A) companion(restricted): every restricted native tool is in argv before `--`",
    RESTRICTED.every((t) => { const i = args.indexOf(t); return i !== -1 && i < sep; }));
  check("(A) companion(restricted): the human-prompt tools are ALSO in argv (union)",
    HUMAN_PROMPT_TOOLS.every((t) => args.indexOf(t) !== -1 && args.indexOf(t) < sep));
  check("(A) companion(restricted): --disallowedTools precedes --strict-mcp-config (variadic terminated by it)",
    d < strict && d + 1 + tools.length === strict);
  check("(A) companion(restricted): --mcp-config value still sits right before `--`", cfg !== -1 && sep === args.length - 2 && sep > cfg + 1);
  check("(A) companion(restricted): the prompt is still the LAST arg behind `--`", args[args.length - 2] === "--" && args[args.length - 1] === "chat back");
}
// Flag OFF ⇒ argv BYTE-IDENTICAL to today. A worker spawned WITHOUT the restriction is the role's
// human-prompt-only disallow — byte-identical to feeding disallowedToolsForRole("worker") directly.
{
  const off = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: "x", disallowedTools: disallowedToolsForSpawn("worker", false) });
  const legacy = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: "x", disallowedTools: disallowedToolsForRole("worker") });
  check("(A) OFF worker: argv byte-identical to the pre-flag (disallowedToolsForRole) argv", eq(off, legacy));
  check("(A) OFF worker: NO restricted native tool leaked into the argv", !RESTRICTED.some((t) => off.includes(t)));
  // A plain/manager (no role disallow) with the flag OFF has NO --disallowedTools at all (fully additive).
  const base = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: "x" });
  const mgrOff = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: "x", disallowedTools: disallowedToolsForSpawn("manager", false) });
  check("(A) OFF manager: NO --disallowedTools flag (byte-identical to the no-arg argv)", eq(mgrOff, base));
}

// ===================== (B) resolveProfile backstop + passthrough =====================
check("(B) null profile ⇒ restrictedTools backstops to false", resolveProfile(AGENT, null).restrictedTools === false);
check("(B) absent profile (undefined) ⇒ false", resolveProfile(AGENT, undefined).restrictedTools === false);
const profNoFlag = { id: "p1", name: "NoFlag", role: "assistant", description: "", allowDelta: [], skills: null, model: null, icon: null };
check("(B) a profile that doesn't set restrictedTools ⇒ false", resolveProfile(AGENT, profNoFlag).restrictedTools === false);
check("(B) a profile with restrictedTools:false ⇒ false", resolveProfile(AGENT, { ...profNoFlag, restrictedTools: false }).restrictedTools === false);
check("(B) a profile with restrictedTools:true ⇒ true (passthrough)", resolveProfile(AGENT, { ...profNoFlag, restrictedTools: true }).restrictedTools === true);

// ===================== (H) HUMAN-set-only: profile validator accepts; agent config validator rejects =====================
{
  const okOn = validateProfile({ name: "Companion", role: "assistant", restrictedTools: true });
  check("(H) PROFILE validator (human REST) ACCEPTS restrictedTools:true (carried through)", okOn.ok === true && okOn.value.restrictedTools === true);
  const okDefault = validateProfile({ name: "Companion", role: "assistant" });
  check("(H) PROFILE validator normalizes an absent restrictedTools to false", okDefault.ok === true && okDefault.value.restrictedTools === false);
  // The AGENT-facing PROJECT-CONFIG validator (the gateCommand/alertWebhook rejecter) must NOT accept
  // restrictedTools — it is a PROFILE field, not a config field, so a strict schema rejects it. This is
  // the "no agent path to set it via config" guard (an agent CAN patch project config; it must not smuggle
  // a capability flag through it).
  const cfg = validateAgentProjectConfigOverride({ restrictedTools: true });
  check("(H) AGENT project-config validator REJECTS restrictedTools (not a config field)", cfg.ok === false);
}

// ===================== end-to-end threading through SessionService (seam-captured opts) =====================
const repo = path.join(os.tmpdir(), `loom-rt-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# restricted-tools-spawn test\n");
execSync(`git init -q && git add . && git -c user.email=rt@loom -c user.name=rt commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pP", name: "P", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
// A restricted companion rig (role assistant) + a restricted worker rig + a plain (unflagged) worker rig.
db.insertProfile({ id: "profComp", name: "Companion", role: "assistant", description: "companion rig", allowDelta: [], skills: null, model: null, icon: "💬", restrictedTools: true });
db.insertProfile({ id: "profRW", name: "RestrictedWorker", role: "worker", description: "locked worker", allowDelta: [], skills: null, model: null, icon: null, restrictedTools: true });
db.insertProfile({ id: "profDev", name: "Dev", role: "worker", description: "dev rig", allowDelta: [], skills: null, model: null, icon: null });
db.insertAgent({ id: "agentComp", projectId: "pP", name: "Comp", startupPrompt: "COMP_PROMPT", position: 0, profileId: "profComp" });
db.insertAgent({ id: "agentRW", projectId: "pP", name: "RW", startupPrompt: "RW_PROMPT", position: 1, profileId: "profRW" });
db.insertAgent({ id: "agentPlain", projectId: "pP", name: "Plain", startupPrompt: "PLAIN_PROMPT", position: 2, profileId: null });
db.insertAgent({ id: "agentDev", projectId: "pP", name: "Dev", startupPrompt: "DEV_PROMPT", position: 3, profileId: "profDev" });
db.insertSession({ id: "mgr1", projectId: "pP", agentId: "agentPlain", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
const tRW = "11111111-1111-4111-8111-111111111111", tDev = "22222222-2222-4222-8222-222222222222";
for (const id of [tRW, tDev])
  db.insertTask({ id, projectId: "pP", title: "t", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

// roundtrip: the profile's flag persists through the DB
check("(roundtrip) Companion profile persists restrictedTools=true", db.getProfile("profComp").restrictedTools === true);
check("(roundtrip) Dev profile defaults restrictedTools=false", db.getProfile("profDev").restrictedTools === false);

class SeamHost extends PtyHost {
  constructor(events) { super(events); this.capture = []; }
  createPty(opts) {
    this.capture.push(opts);
    let exitCb = null;
    return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit(cb) { exitCb = cb; return { dispose() {} }; }, kill() { if (exitCb) exitCb({ exitCode: 0 }); }, resize() {} };
  }
  isAlive() { return false; } // capture seam drives no live pty — resume/recycle inspect the respawn args
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

let workerWorktree = null, recycledWorktree = null;
try {
  // startNew on the assistant/companion rig → restrictedTools threads to spawn opts + the persisted row,
  // and the spawn's disallow list is the human-prompt + restricted union.
  const sC = svc.startNew("agentComp");
  const oC = optsFor(sC.id);
  check("(e2e) companion: spawn opts.restrictedTools === true", oC?.restrictedTools === true);
  check("(e2e) companion: role resolved to 'assistant'", oC?.role === "assistant");
  check("(e2e) companion: returned session.restrictedTools === true", sC.restrictedTools === true);
  check("(e2e) companion: DB persists restricted_tools=1 (pins it for respawns)", db.getSession(sC.id).restrictedTools === true);
  check("(e2e) companion: the spawn's disallow list = human-prompt + restricted union (dangerous native tools removed)",
    eq(disallowedToolsForSpawn(oC.role, oC.restrictedTools), [...HUMAN_PROMPT_TOOLS, ...RESTRICTED]));

  // startNew on a plain agent → false, byte-identical (no restriction beyond role).
  const sPlain = svc.startNew("agentPlain");
  const oPlain = optsFor(sPlain.id);
  check("(e2e) plain agent: spawn opts.restrictedTools is falsy", !oPlain?.restrictedTools);
  check("(e2e) plain agent: DB persists restricted_tools=0", db.getSession(sPlain.id).restrictedTools === false);
  check("(e2e) plain agent: disallow list is byte-identical to today (no restriction)",
    eq(disallowedToolsForSpawn(oPlain?.role, oPlain?.restrictedTools), disallowedToolsForRole(oPlain?.role)));

  // RESUME the companion → the restriction is re-passed (carried from the pinned row), like role.
  const engId = "11111111-2222-3333-4444-555555555555";
  db.setEngineSessionId(sC.id, engId);
  const tpath = engineTranscriptPath(repo, engId);
  fs.mkdirSync(path.dirname(tpath), { recursive: true });
  fs.writeFileSync(tpath, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");
  host.capture.length = 0;
  svc.resume(sC.id);
  check("(e2e) RESUME re-passes restrictedTools=true (a resumed companion keeps its lockdown)", optsFor(sC.id)?.restrictedTools === true);

  // FORK the companion → the fork inherits the restriction from the source row.
  host.capture.length = 0;
  const fk = svc.forkSession(sC.id);
  check("(e2e) FORK inherits restrictedTools=true from the source", optsFor(fk.id)?.restrictedTools === true);
  check("(e2e) FORK row persists restricted_tools=1", db.getSession(fk.id).restrictedTools === true);

  // spawnWorker pointed at the restricted worker rig → resolves restrictedTools from THAT agent's profile.
  const wRW = await svc.spawnWorker("mgr1", { taskId: tRW, agentId: "agentRW", kickoffPrompt: "GO" });
  workerWorktree = wRW.worktreePath;
  const oWRW = optsFor(wRW.id);
  check("(e2e) spawnWorker(restricted rig): spawn opts.restrictedTools === true", oWRW?.restrictedTools === true);
  check("(e2e) spawnWorker(restricted rig): DB row persists restricted_tools=1", db.getSession(wRW.id).restrictedTools === true);
  check("(e2e) spawnWorker(restricted rig): the worker disallow list unions human-prompt + restricted set",
    eq(disallowedToolsForSpawn(oWRW.role, oWRW.restrictedTools), [...HUMAN_PROMPT_TOOLS, ...RESTRICTED]));

  // RECYCLE the restricted worker → the successor carries the restriction from the old row.
  host.capture.length = 0;
  const rw = await svc.recycleWorker("mgr1", wRW.id, "HANDOFF: continue.");
  recycledWorktree = rw.worktreePath;
  check("(e2e) recycleWorker: successor carries restrictedTools=true from the old row", optsFor(rw.id)?.restrictedTools === true);
  check("(e2e) recycleWorker: successor row persists restricted_tools=1", db.getSession(rw.id).restrictedTools === true);

  // spawnWorker pointed at a plain Dev rig (no flag) → false, byte-identical.
  const wDev = await svc.spawnWorker("mgr1", { taskId: tDev, agentId: "agentDev", kickoffPrompt: "GO" });
  const oWDev = optsFor(wDev.id);
  check("(e2e) spawnWorker(Dev rig): restrictedTools is falsy (no restriction)", !oWDev?.restrictedTools);
  check("(e2e) spawnWorker(Dev rig): the worker disallow list is byte-identical to today (role-only)",
    eq(disallowedToolsForSpawn(oWDev.role, oWDev.restrictedTools), disallowedToolsForRole(oWDev.role)));
  workerWorktree = [workerWorktree, recycledWorktree, wDev.worktreePath];
  recycledWorktree = null;
} finally {
  try {
    const { removeWorktree } = await import("../dist/git/worktrees.js");
    for (const wt of [].concat(workerWorktree, recycledWorktree).filter(Boolean)) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } }
  } catch { /* best-effort */ }
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — restricted-tools profile flag: the curated dangerous native set unions into --disallowedTools iff restrictedTools (byte-identical off, human-prompt disallow preserved, ordering intact); resolveProfile backstops/passes it; the profile validator accepts + the agent config validator rejects it (human-only); the flag threads through startNew/resume/fork/spawnWorker/recycleWorker + the persisted row — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
