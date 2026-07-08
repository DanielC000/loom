import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Opt-in Deja mockup-corpus capability (per-session `deja mcp` server, opt-in via profile flag).
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like browser-testing-spawn.mjs: isolated
// LOOM_HOME + a sandboxed HOME, a REAL Db + SessionService driven against a FAKE pty injected via
// PtyHost's createPty() seam. A real temp git repo backs spawnWorker's createWorktree; the only thing
// faked is the claude pty (and LOOM_DEJA_BIN, pointed at a fixture file so the resolver's existence
// check passes without a real `deja` install).
//
// Proves the DoD point + the load-bearing threading:
//   (a) the spawn mcp-config (buildMcpServers) INCLUDES the per-session deja stdio server when
//       dejaCorpus=true and LOOM_DEJA_BIN resolves, and OMITS it when dejaCorpus=false (byte-identical
//       to a no-flag spawn) OR when LOOM_DEJA_BIN is unset/unresolvable (clean-skip, never throws);
//   (b) resolveProfile backstops dejaCorpus to FALSE for a null/absent profile and for a profile that
//       doesn't set it, and PASSES IT THROUGH when set;
//   (c) capabilityToolAllowlist contributes the three mcp__deja__* tool names iff dejaCorpus is granted;
//   plus end-to-end: a Deja-profile agent threads dejaCorpus=true through startNew → spawn opts + the
//       persisted session row; a plain agent stays false (byte-identical); RESUME re-passes it; a
//       agent MCP profile write REJECTS dejaCorpus (exfil-class, human-only).
//
// Run: 1) build (turbo builds shared first), 2) node test/deja-corpus-spawn.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME (host.ts log dir) AND a sandboxed HOME so resume()'s engineTranscriptExists
// reads under the temp dir, never the real ~/.claude. Set BEFORE importing dist. ---
const tmpHome = path.join(os.tmpdir(), `loom-dc-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { Db } = await import("../dist/db.js");
const { PtyHost, buildMcpServers, dejaMcpServer, capabilityToolAllowlist } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");
const { resolveProfile, resolveProfileCapabilities } = await import("@loom/shared");
const { agentProfileKeyError, validateProfile } = await import("../dist/profiles/validate.js");

const AGENT = { startupPrompt: "agent own prompt" };
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fakeCli = path.join(__dirname, "fixtures", "fake-deja-cli.mjs");

const origDejaBin = process.env.LOOM_DEJA_BIN;
delete process.env.LOOM_DEJA_BIN;

// ===================== (b) resolveProfile backstop + passthrough (claude-free, pure) =====================
check("(b) null profile ⇒ dejaCorpus backstops to false", resolveProfile(AGENT, null).dejaCorpus === false);
check("(b) absent profile (undefined) ⇒ false", resolveProfile(AGENT, undefined).dejaCorpus === false);
const profNoFlag = { id: "p1", name: "NoFlag", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null };
check("(b) a profile that doesn't set dejaCorpus ⇒ false", resolveProfile(AGENT, profNoFlag).dejaCorpus === false);
check("(b) a profile with dejaCorpus:false ⇒ false", resolveProfile(AGENT, { ...profNoFlag, dejaCorpus: false }).dejaCorpus === false);
check("(b) a profile with dejaCorpus:true ⇒ true (passthrough)", resolveProfile(AGENT, { ...profNoFlag, dejaCorpus: true }).dejaCorpus === true);

// ===================== dejaMcpServer(): the clean-skip resolver =====================
check("(resolver) LOOM_DEJA_BIN unset ⇒ null (clean-skip)", dejaMcpServer() === null);
process.env.LOOM_DEJA_BIN = "deja"; // a bare, non-absolute command
check("(resolver) LOOM_DEJA_BIN not absolute ⇒ null (clean-skip)", dejaMcpServer() === null);
process.env.LOOM_DEJA_BIN = path.join(tmpHome, "does-not-exist.js");
check("(resolver) LOOM_DEJA_BIN absolute but missing on disk ⇒ null (clean-skip)", dejaMcpServer() === null);
process.env.LOOM_DEJA_BIN = fakeCli;
const resolved = dejaMcpServer();
check("(resolver) LOOM_DEJA_BIN absolute + existing ⇒ a stdio entry", resolved?.type === "stdio");
check("(resolver) command is process.execPath (absolute node)", resolved?.command === process.execPath);
check("(resolver) args are [cli.js, 'mcp']", JSON.stringify(resolved?.args) === JSON.stringify([fakeCli, "mcp"]));

// ===================== (a) buildMcpServers includes/omits the deja stdio server =====================
const off = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker", dejaCorpus: false });
const on = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker", dejaCorpus: true });
check("(a) dejaCorpus=false ⇒ NO 'deja' server in the mcp-config", !("deja" in off));
check("(a) dejaCorpus=true ⇒ 'deja' server IS in the mcp-config", "deja" in on);
// byte-identical-when-off: the OFF map equals a spawn that never passed the flag at all.
const noFlag = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker" });
check("(a) OFF map is byte-identical to a no-flag spawn (fully additive)",
  JSON.stringify(off) === JSON.stringify(noFlag));
// turning the flag on adds EXACTLY the one 'deja' key, nothing else changes.
check("(a) ON adds exactly the deja key (everything else unchanged)",
  JSON.stringify({ ...on, deja: undefined }) === JSON.stringify({ ...off, deja: undefined }));
check("(a) buildMcpServers' deja entry matches dejaMcpServer() directly", JSON.stringify(on.deja) === JSON.stringify(dejaMcpServer()));

// dejaCorpus=true but LOOM_DEJA_BIN unresolvable ⇒ clean-skip, spawn still succeeds without the server.
delete process.env.LOOM_DEJA_BIN;
const onNoBin = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker", dejaCorpus: true });
check("(a) dejaCorpus=true + unresolvable LOOM_DEJA_BIN ⇒ NO 'deja' server (clean-skip, never throws)", !("deja" in onNoBin));
process.env.LOOM_DEJA_BIN = fakeCli; // restore for the rest of the test

// a plain (role-null) deja session still gets the server (deja is orthogonal to role).
const plainDeja = buildMcpServers({ sessionId: "s2", port: 4317, dejaCorpus: true });
check("(a) dejaCorpus works for a role-null session too (orthogonal to role)",
  "deja" in plainDeja && !("loom-orchestration" in plainDeja));

// ===================== (c) capabilityToolAllowlist contributes the three deja tools =====================
const grants = resolveProfileCapabilities({ dejaCorpus: true });
check("(c) resolveProfileCapabilities bridges dejaCorpus to the 'deja-corpus' slug",
  JSON.stringify(grants) === JSON.stringify([{ slug: "deja-corpus" }]));
const allow = capabilityToolAllowlist(grants, []);
check("(c) allowlist includes find_mockups/submit_mockup/mark_reused",
  allow.includes("mcp__deja__find_mockups") && allow.includes("mcp__deja__submit_mockup") && allow.includes("mcp__deja__mark_reused"));
check("(c) dejaCorpus=false contributes NO allowlist entries",
  capabilityToolAllowlist(resolveProfileCapabilities({ dejaCorpus: false }), []).length === 0);

// ===================== profile validation: human-settable, agent-forbidden (exfil-class) =====================
const vOk = validateProfile({ name: "Deja rig", dejaCorpus: true });
check("(validate) dejaCorpus:true round-trips through validateProfile (human REST path)", vOk.ok === true && vOk.value.dejaCorpus === true);
check("(validate) omitted dejaCorpus normalizes to false", validateProfile({ name: "x" }).value.dejaCorpus === false);
check("(agent-forbidden) agentProfileKeyError REJECTS a payload setting dejaCorpus",
  typeof agentProfileKeyError({ dejaCorpus: true }) === "string");
check("(agent-forbidden) agentProfileKeyError allows a payload that doesn't touch dejaCorpus",
  agentProfileKeyError({ name: "x" }) === null);

// ===================== end-to-end threading through SessionService (seam-captured opts) =====================
const repo = path.join(os.tmpdir(), `loom-dc-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# deja-corpus-spawn test\n");
execSync(`git init -q && git add . && git -c user.email=dc@loom -c user.name=dc commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pP", name: "P", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
// THE deja-capable profile (mirrors a "Web Designer + Deja" variant) + a plain worker profile.
db.insertProfile({ id: "profDeja", name: "Web Designer + Deja", role: "worker", description: "deja rig", allowDelta: [], skills: null, model: null, icon: "🖼️", dejaCorpus: true });
db.insertProfile({ id: "profDev", name: "Dev", role: "worker", description: "dev rig", allowDelta: [], skills: null, model: null, icon: null });
db.insertAgent({ id: "agentDeja", projectId: "pP", name: "Designer", startupPrompt: "DESIGNER_PROMPT", position: 0, profileId: "profDeja" });
db.insertAgent({ id: "agentPlain", projectId: "pP", name: "Plain", startupPrompt: "PLAIN_PROMPT", position: 1, profileId: null });
db.insertAgent({ id: "agentDev", projectId: "pP", name: "Dev", startupPrompt: "DEV_PROMPT", position: 2, profileId: "profDev" });
db.insertSession({ id: "mgr1", projectId: "pP", agentId: "agentPlain", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
const tW1 = "11111111-1111-4111-8111-111111111111";
db.insertTask({ id: tW1, projectId: "pP", title: "t", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

check("(roundtrip) Deja profile persists dejaCorpus=true", db.getProfile("profDeja").dejaCorpus === true);
check("(roundtrip) Dev profile defaults dejaCorpus=false", db.getProfile("profDev").dejaCorpus === false);

class SeamHost extends PtyHost {
  constructor(events) { super(events); this.capture = []; }
  createPty(opts) { this.capture.push(opts); return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
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
  // startNew on a Deja-profile agent → dejaCorpus threads to spawn opts + the persisted row.
  const sDeja = svc.startNew("agentDeja");
  const oDeja = optsFor(sDeja.id);
  check("(e2e) Deja agent: spawn opts.dejaCorpus === true", oDeja?.dejaCorpus === true);
  check("(e2e) Deja agent: returned session.dejaCorpus === true", sDeja.dejaCorpus === true);
  check("(e2e) Deja agent: DB persists deja_corpus=1 (pins it for respawns)", db.getSession(sDeja.id).dejaCorpus === true);
  const dejaMcp = buildMcpServers({ sessionId: sDeja.id, port: 4317, role: oDeja.role, dejaCorpus: oDeja.dejaCorpus });
  check("(e2e) Deja agent: the spawn's mcp-config includes the deja server", "deja" in dejaMcp);

  // startNew on a plain agent → false, byte-identical (no deja).
  const sPlain = svc.startNew("agentPlain");
  const oPlain = optsFor(sPlain.id);
  check("(e2e) plain agent: spawn opts.dejaCorpus is falsy", !oPlain?.dejaCorpus);
  check("(e2e) plain agent: DB persists deja_corpus=0", db.getSession(sPlain.id).dejaCorpus === false);

  // RESUME the Deja session → the capability is re-passed (carried from the pinned row), exactly like role.
  const engId = "11111111-2222-3333-4444-555555555555";
  db.setEngineSessionId(sDeja.id, engId);
  const tpath = engineTranscriptPath(repo, engId);
  fs.mkdirSync(path.dirname(tpath), { recursive: true });
  fs.writeFileSync(tpath, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");
  host.capture.length = 0; // isolate the resume's captured opts
  svc.resume(sDeja.id);
  const oResume = optsFor(sDeja.id);
  check("(e2e) RESUME re-passes dejaCorpus=true (a resumed deja-worker keeps its corpus MCP)",
    oResume?.dejaCorpus === true);

  // spawnWorker pointed at the Deja agent → resolves dejaCorpus from THAT agent's profile.
  const wDeja = await svc.spawnWorker("mgr1", { taskId: tW1, agentId: "agentDeja", kickoffPrompt: "GO" });
  workerWorktree = wDeja.worktreePath;
  const oWDeja = optsFor(wDeja.id);
  check("(e2e) spawnWorker(Deja agent): spawn opts.dejaCorpus === true", oWDeja?.dejaCorpus === true);
  check("(e2e) spawnWorker(Deja agent): DB row persists deja_corpus=1", db.getSession(wDeja.id).dejaCorpus === true);
} finally {
  try {
    const { removeWorktree } = await import("../dist/git/worktrees.js");
    for (const wt of [].concat(workerWorktree).filter(Boolean)) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } }
  } catch { /* best-effort */ }
  db.close();
  if (origDejaBin === undefined) delete process.env.LOOM_DEJA_BIN; else process.env.LOOM_DEJA_BIN = origDejaBin;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — opt-in Deja mockup-corpus: resolveProfile backstops/passes dejaCorpus; the deja stdio MCP is injected iff dejaCorpus AND LOOM_DEJA_BIN resolves (clean-skip otherwise, byte-identical off); the allowlist/profile-validation/agent-forbidden posture holds; the flag threads through startNew/resume/spawnWorker + the persisted row — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
