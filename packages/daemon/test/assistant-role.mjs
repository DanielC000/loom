import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion (epic Phase 1) — the long-lived `assistant` (companion) SessionRole, end to end.
// DETERMINISTIC + CLAUDE-FREE + hermetic (isolated LOOM_HOME, a REAL Db + SessionService driven against
// a FAKE pty via PtyHost's createPty() seam; the MCP surface round-tripped over an in-memory client/server
// pair). NO real claude, NO daemon, NO network. Proves the card's DoD:
//   (a) an assistant session spawns + persists a row, NON-worktree (cwd == the project repo, not a worktree);
//   (b) it RESUMES across a simulated daemon restart carrying role `assistant` (resume re-passes the row's
//       role + resumeId, injects no prompt) — plus the fleet CAPTURE/round-trip carries the role;
//   (c) its server-owned base BRIEF (companion identity + untrusted-input posture + chat_reply doctrine) is
//       injected AHEAD of the agent's own prompt;
//   (d) its spawn argv carries `--disallowedTools AskUserQuestion ExitPlanMode EnterPlanMode`, while a
//       non-assistant role's argv stays BYTE-IDENTICAL;
//   (e) resolveRole ADMITS `assistant` with a MINIMAL orchestration surface — my_context + the companion-
//       gated chat_reply present, the manager coordination surface (worker_spawn/…) + worker_report ABSENT.
// Run: 1) build (turbo builds shared first), 2) node test/assistant-role.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Hermetic LOOM_HOME (host.ts opens a per-session log under $LOOM_HOME/logs). Set BEFORE importing dist.
const tmpHome = path.join(os.tmpdir(), `loom-asst-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { PtyHost, buildSpawnArgs, buildMcpServers, disallowedToolsForRole, HUMAN_PROMPT_TOOLS } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { ASSISTANT_BASE_BRIEF, composeAssistantStartupPrompt } = await import("../dist/sessions/assistant-prompt.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");
const { setupRoleError } = await import("../dist/mcp/setup.js");
const { resolveConfig } = await import("@loom/shared");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

// A real temp git repo backs the project (cwd must exist for resume()'s cwd guard + a real dir for spawn).
const repo = path.join(os.tmpdir(), `loom-asst-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# assistant-role test\n");
execSync(`git init -q && git -c user.email=a@loom -c user.name=a add . && git -c user.email=a@loom -c user.name=a commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const baseAllow = resolveConfig({}).permission.allow;

// --- seed: a project + an ASSISTANT-role profile + agent (with its own prompt), and a plain agent -----
const db = new Db();
db.insertProject({ id: "pC", name: "Companion", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
db.insertProfile({ id: "profAsst", name: "Companion", role: "assistant", description: "the standing companion rig", allowDelta: [], skills: null, model: null, icon: "💬" });
db.insertProfile({ id: "profMgr", name: "Orchestrator", role: "manager", description: "", allowDelta: [], skills: null, model: null, icon: null });
db.insertAgent({ id: "agentAsst", projectId: "pC", name: "Companion", startupPrompt: "COMPANION_AGENT_PROMPT", position: 0, profileId: "profAsst" });
db.insertAgent({ id: "agentMgr", projectId: "pC", name: "Manager", startupPrompt: "MGR_PROMPT", position: 1, profileId: "profMgr" });

// The fake-pty PtyHost that captures every SpawnOpts via the createPty() seam (mirrors profile-spawn.mjs).
class SeamHost extends PtyHost {
  constructor(events) { super(events); this.capture = []; }
  createPty(opts) {
    this.capture.push(opts);
    return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} };
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
const optsFor = (h, sid) => h.capture.find((o) => o.sessionId === sid);

try {
  // =================== (a) spawn + persist a NON-worktree assistant row ===================
  const sA = svc.startNew("agentAsst");
  const oA = optsFor(host, sA.id);
  check("(a) startNew on an assistant-profile agent confers role=assistant (profile-spawnable, NOT clamped)", sA.role === "assistant");
  check("(a) DB persists role=assistant (drives the server-side role gate + resume)", db.getSession(sA.id).role === "assistant");
  check("(a) spawn opts.role === 'assistant' (the value host.ts maps to the loom-orchestration surface)", oA?.role === "assistant");
  check("(a) NON-worktree: cwd is the project repo, not a per-task worktree", oA?.cwd === repo && db.getSession(sA.id).cwd === repo && !oA.cwd.includes("worktrees"));
  check("(a) session is live", db.getSession(sA.id).processState === "live");

  // =================== (c) the server-owned base brief is injected AHEAD of the agent prompt ===================
  const sp = oA?.startupPrompt ?? "";
  check("(c) the base brief is present (companion identity)", sp.includes("Loom Companion"));
  check("(c) the base brief carries the untrusted-input posture", /UNTRUSTED DATA/.test(sp) && /prompt-injection/i.test(sp));
  check("(c) the base brief carries the chat_reply doctrine (only channel back)", sp.includes("chat_reply(text)") && /ONLY channel/i.test(sp));
  check("(c) the WHOLE base brief is prepended verbatim", sp.startsWith(ASSISTANT_BASE_BRIEF));
  check("(c) the agent's OWN prompt follows the base brief", sp.includes("COMPANION_AGENT_PROMPT") && sp.indexOf(ASSISTANT_BASE_BRIEF) < sp.indexOf("COMPANION_AGENT_PROMPT"));
  check("(c) Claude-first — no multi-vendor language leaked into the brief", !/OpenAI|GPT|Gemini|Llama|multi-vendor/i.test(ASSISTANT_BASE_BRIEF));

  // composeAssistantStartupPrompt is PURE: empty/whitespace agent brief ⇒ the base brief ALONE.
  check("(c) compose(undefined) === the base brief alone", composeAssistantStartupPrompt(undefined) === ASSISTANT_BASE_BRIEF);
  check("(c) compose('   ') (whitespace) === the base brief alone", composeAssistantStartupPrompt("   ") === ASSISTANT_BASE_BRIEF);
  check("(c) compose(brief) prepends base then '---' then the agent brief", composeAssistantStartupPrompt("MY BRIEF") === `${ASSISTANT_BASE_BRIEF}\n\n---\n\nMY BRIEF`);

  // =================== least-privilege: the ungated Setup operator CANNOT mint an assistant rig ===================
  // True by construction today (SETUP_ALLOWED_PROFILE_ROLES omits "assistant"), but PIN it so a future edit
  // adding "assistant" to that allowlist can't silently pass CI — the operator surface must stay human-only
  // for this role (mirrors workspace-auditor-role.mjs G2). The validateProfile enum DOES allow it (human REST).
  check("(lp) setupRoleError('assistant') returns an error (Setup operator can never mint an assistant rig)",
    typeof setupRoleError("assistant") === "string" && setupRoleError("assistant").length > 0);
  check("(lp regression) setupRoleError still ALLOWS manager/worker/setup/null (returns null)",
    setupRoleError("manager") === null && setupRoleError("worker") === null && setupRoleError("setup") === null && setupRoleError(null) === null);

  // =================== (b) RESUME across a simulated daemon restart carries role assistant ===================
  // (b-i) CAPTURE: the live assistant is in the restart fleet resume set WITH role assistant, and the
  // resume-set round-trips it (the persisted analogue of "resumes carrying its role").
  const restart = await import("../dist/orchestration/restart.js");
  const fleet = svc.liveFleetResumeSet();
  const capA = fleet.find((e) => e.sessionId === sA.id);
  check("(b) liveFleetResumeSet CAPTURES the assistant with role=assistant", capA && capA.role === "assistant");
  const roundTrip = restart.resumeSetFromIntent({ reason: "deploy", managerSessionId: sA.id, resume: fleet, requestedAt: now });
  check("(b) resumeSetFromIntent round-trips the assistant's role", roundTrip.find((e) => e.sessionId === sA.id)?.role === "assistant");

  // (b-ii) resume() ITSELF re-spawns carrying role assistant. Give the row an engine id + a real transcript
  // at the computed path so resume()'s transcript + cwd guards pass, then resume on a FRESH host/service
  // (so the pty is not already-live) and assert the resume spawn opts carry role assistant + the resumeId
  // and inject NO prompt (resume injects nothing).
  const eng = `eng-asst-${Date.now()}`;
  db.setEngineSessionId(sA.id, eng);
  const tFile = engineTranscriptPath(repo, eng);
  fs.mkdirSync(path.dirname(tFile), { recursive: true });
  var transcriptDir = path.dirname(tFile);
  fs.writeFileSync(tFile, JSON.stringify({ type: "user", message: { content: "seed" } }) + "\n");
  db.setProcessState(sA.id, "exited"); // as it would be after a daemon restart (pty gone)
  const host2 = new SeamHost(events);
  const svc2 = new SessionService(db, host2, new OrchestrationControl());
  const resumed = svc2.resume(sA.id);
  const oR = optsFor(host2, sA.id);
  check("(b) resume() re-spawns the assistant carrying role=assistant", oR?.role === "assistant");
  check("(b) resume() passes the engine resumeId (a real --resume)", oR?.resumeId === eng);
  check("(b) resume() injects NO startup prompt (resume injects nothing)", oR?.startupPrompt === undefined);
  check("(b) resumed row is back on the live rail", db.getSession(sA.id).processState === "live" && resumed.processState === "live");

  // =================== (d) argv: assistant gets the human-prompt disallow; manager stays byte-identical ===================
  check("(d) disallowedToolsForRole('assistant') === the full human-prompt tool list", JSON.stringify(disallowedToolsForRole("assistant")) === JSON.stringify([...HUMAN_PROMPT_TOOLS]));
  check("(d) disallowedToolsForRole('manager') === [] (out of scope, unchanged)", disallowedToolsForRole("manager").length === 0);
  const mcpServers = buildMcpServers({ sessionId: "s1", port: 4317, role: "assistant" });
  const asstArgs = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: "hi", disallowedTools: disallowedToolsForRole("assistant") });
  const d = asstArgs.indexOf("--disallowedTools");
  check("(d) assistant argv carries `--disallowedTools` with the three tools in order",
    d !== -1 && asstArgs[d + 1] === "AskUserQuestion" && asstArgs[d + 2] === "ExitPlanMode" && asstArgs[d + 3] === "EnterPlanMode");
  check("(d) assistant argv: `--disallowedTools` precedes `--strict-mcp-config` (its variadic is terminated by it)", d < asstArgs.indexOf("--strict-mcp-config") && d + 4 === asstArgs.indexOf("--strict-mcp-config"));
  // Byte-identical proof for the out-of-scope path: a manager's argv (disallow []) == the no-arg argv.
  const base = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers: { "loom-tasks": { type: "http", url: "http://127.0.0.1:4317/mcp/s1" } }, startupPrompt: "hi" });
  const mgr = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers: { "loom-tasks": { type: "http", url: "http://127.0.0.1:4317/mcp/s1" } }, startupPrompt: "hi", disallowedTools: disallowedToolsForRole("manager") });
  check("(d) manager argv is BYTE-IDENTICAL to the no-disallow argv (out-of-scope role unchanged)", JSON.stringify(mgr) === JSON.stringify(base));

  // buildMcpServers is additive: assistant mounts loom-orchestration + loom-tasks; a plain/no-role map is
  // byte-identical to today (just loom-tasks) — the new `|| assistant` term didn't perturb other roles.
  const asstMap = buildMcpServers({ sessionId: "s1", port: 4317, role: "assistant" });
  check("(d) buildMcpServers(assistant) mounts loom-orchestration + loom-tasks", !!asstMap["loom-orchestration"] && !!asstMap["loom-tasks"]);
  const plainMap = buildMcpServers({ sessionId: "s1", port: 4317, role: undefined });
  check("(d) buildMcpServers(plain) is byte-identical (loom-tasks only — no orchestration)", JSON.stringify(plainMap) === JSON.stringify({ "loom-tasks": { type: "http", url: "http://127.0.0.1:4317/mcp/s1" } }));

  // =================== (e) resolveRole admits assistant with a MINIMAL surface ===================
  // Stub db.getSession so resolveRole reads the role; companion hooks bind ONE session id (the Phase-0 gate).
  const stubDb = { getSession: (id) => ({ role: id === "asst-sess" ? "assistant" : id === "mgr-sess" ? "manager" : null }) };
  const delivered = [];
  const deliverReply = async (sid, text) => { delivered.push({ sid, text }); return { delivered: true }; };
  const router = new OrchestrationMcpRouter(stubDb, {}, { companionSessionId: "asst-sess", deliverReply });

  check("(e) resolveRole ADMITS an assistant session (returns role assistant, not 404)", router.resolveRole("asst-sess")?.role === "assistant");
  check("(e) resolveRole still 404s a plain session", router.resolveRole("plain-sess") === null);

  async function toolsFor(sessionId, role) {
    const server = router.buildServer(sessionId, role); // TS-private, plain method at runtime
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientT);
    const { tools } = await client.listTools();
    return { client, names: tools.map((t) => t.name), close: async () => { await client.close(); await server.close(); } };
  }

  // The COMPANION-bound assistant: minimal surface = my_context + chat_reply; NO manager surface.
  {
    const { client, names, close } = await toolsFor("asst-sess", "assistant");
    check("(e) companion assistant HAS my_context", names.includes("my_context"));
    check("(e) companion assistant HAS chat_reply (the companion gate)", names.includes("chat_reply"));
    check("(e) companion assistant does NOT have worker_spawn (no manager surface)", !names.includes("worker_spawn"));
    check("(e) companion assistant does NOT have worker_report", !names.includes("worker_report"));
    // Phase 2 (self-authored skills + memory) adds the four skill_* tools and the four memory_* tools to
    // the bound companion surface — still NO manager/writer surface. The full companion surface is
    // chat_reply + my_context + the skill tools + the memory tools.
    check("(e) companion assistant surface is EXACTLY {my_context, chat_reply, skill_*, memory_*}",
      JSON.stringify([...names].sort()) === JSON.stringify([
        "chat_reply", "memory_list", "memory_read", "memory_remove", "memory_write",
        "my_context", "skill_author", "skill_list", "skill_read", "skill_remove",
      ]));
    const res = await client.callTool({ name: "chat_reply", arguments: { text: "hi from the companion" } });
    check("(e) chat_reply routes to deliverReply", JSON.parse(res.content[0].text).delivered === true && delivered.length === 1 && delivered[0].sid === "asst-sess");
    await close();
  }
  // An assistant session that is NOT the bound companion: my_context only, chat_reply ABSENT (gated).
  {
    const { names, close } = await toolsFor("other-asst", "assistant");
    check("(e) a non-companion assistant HAS my_context", names.includes("my_context"));
    check("(e) a non-companion assistant does NOT have chat_reply (single-session companion gate)", !names.includes("chat_reply"));
    await close();
  }
  // Regression: a manager session's surface is unchanged (still has worker_spawn).
  {
    const { names, close } = await toolsFor("mgr-sess", "manager");
    check("(e) a manager session still has its full surface (worker_spawn present) — no regression", names.includes("worker_spawn"));
    await close();
  }
} finally {
  db.close();
  try { if (typeof transcriptDir === "string") fs.rmSync(transcriptDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the assistant (Companion) role spawns a NON-worktree persistent row, resumes across a simulated restart carrying its role, carries the server-owned base brief (identity + untrusted-input posture + chat_reply doctrine), gets the human-prompt disallow while other roles stay byte-identical, and reaches a MINIMAL loom-orchestration surface (my_context + companion-gated chat_reply; no manager surface) — claude-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
