import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Opt-in Open Design (OD, github.com/nexu-io/open-design) capability (per-session OD MCP server, opt-in
// via profile flag). DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic:
// isolated LOOM_HOME + a sandboxed HOME, a REAL Db + SessionService driven against a FAKE pty injected via
// PtyHost's createPty() seam. A real temp git repo backs spawnWorker's createWorktree; the only thing
// faked is the claude pty (and LOOM_OPEN_DESIGN_BIN, pointed at a fixture file so the resolver's existence
// check passes without a real OD install).
//
// Proves the DoD point + the load-bearing threading:
//   (public) OD is a PUBLIC OSS project (github.com/nexu-io/open-design) — buildMcpServers'
//       "open-design" grant is NEVER gated by isLoomDev(): it mounts on a plain non-dev build (LOOM_DEV
//       unset) as long as openDesign=true AND LOOM_OPEN_DESIGN_BIN resolves.
//   (a) the spawn mcp-config (buildMcpServers) INCLUDES the per-session open-design stdio server when
//       openDesign=true and LOOM_OPEN_DESIGN_BIN resolves, and OMITS it when openDesign=false
//       (byte-identical to a no-flag spawn) OR when LOOM_OPEN_DESIGN_BIN is unset/unresolvable
//       (clean-skip, never throws) — this is the PRIMARY real-world shipping case (OD absent on this host).
//   (b) resolveProfile backstops openDesign to FALSE for a null/absent profile and for a profile that
//       doesn't set it, and PASSES IT THROUGH when set;
//   (c) capabilityToolAllowlist contributes the whole `mcp__open-design` server-prefix allow iff
//       openDesign is granted (OD's exact tool surface isn't known);
//   plus end-to-end: an OD-profile agent threads openDesign=true through startNew → spawn opts + the
//       persisted session row; a plain agent stays false (byte-identical); RESUME re-passes it; a
//       agent MCP profile write REJECTS openDesign (exfil-class, human-only).
//
// Run: 1) build (turbo builds shared first), 2) node test/open-design-spawn.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME (host.ts log dir) AND a sandboxed HOME so resume()'s engineTranscriptExists
// reads under the temp dir, never the real ~/.claude. Set BEFORE importing dist. ---
const tmpHome = path.join(os.tmpdir(), `loom-od-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME
// OD is deliberately NOT isLoomDev()-gated — but delete any inherited LOOM_DEV=1 anyway
// (e.g. this test running inside a LOOM_DEV=1 self-hosting/orchestration shell) so the "public, un-gated"
// assertion below is proven against the TRUE default-off state, not accidentally masked by an ambient flag.
delete process.env.LOOM_DEV;

const { Db } = await import("../dist/db.js");
const { PtyHost, buildMcpServers, openDesignMcpServer, capabilityToolAllowlist } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");
const { resolveProfile, resolveProfileCapabilities } = await import("@loom/shared");
const { agentProfileKeyError, validateProfile } = await import("../dist/profiles/validate.js");
const { isLoomDev } = await import("../dist/paths.js");

const AGENT = { startupPrompt: "agent own prompt" };
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fakeCli = path.join(__dirname, "fixtures", "fake-open-design-cli.mjs");

const origOdBin = process.env.LOOM_OPEN_DESIGN_BIN;
delete process.env.LOOM_OPEN_DESIGN_BIN;

// ===================== (b) resolveProfile backstop + passthrough (claude-free, pure) =====================
check("(b) null profile ⇒ openDesign backstops to false", resolveProfile(AGENT, null).openDesign === false);
check("(b) absent profile (undefined) ⇒ false", resolveProfile(AGENT, undefined).openDesign === false);
const profNoFlag = { id: "p1", name: "NoFlag", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null };
check("(b) a profile that doesn't set openDesign ⇒ false", resolveProfile(AGENT, profNoFlag).openDesign === false);
check("(b) a profile with openDesign:false ⇒ false", resolveProfile(AGENT, { ...profNoFlag, openDesign: false }).openDesign === false);
check("(b) a profile with openDesign:true ⇒ true (passthrough)", resolveProfile(AGENT, { ...profNoFlag, openDesign: true }).openDesign === true);

// ===================== openDesignMcpServer(): the clean-skip resolver =====================
check("(resolver) LOOM_OPEN_DESIGN_BIN unset ⇒ null (clean-skip)", openDesignMcpServer() === null);
process.env.LOOM_OPEN_DESIGN_BIN = "od"; // a bare, non-absolute command
check("(resolver) LOOM_OPEN_DESIGN_BIN not absolute ⇒ null (clean-skip)", openDesignMcpServer() === null);
process.env.LOOM_OPEN_DESIGN_BIN = path.join(tmpHome, "does-not-exist");
check("(resolver) LOOM_OPEN_DESIGN_BIN absolute but missing on disk ⇒ null (clean-skip)", openDesignMcpServer() === null);
process.env.LOOM_OPEN_DESIGN_BIN = fakeCli;
const resolved = openDesignMcpServer();
check("(resolver) LOOM_OPEN_DESIGN_BIN absolute + existing ⇒ a stdio entry", resolved?.type === "stdio");
check("(resolver) command is the OD binary ITSELF (no process.execPath wrapper)", resolved?.command === fakeCli);
check("(resolver) args are ['mcp']", JSON.stringify(resolved?.args) === JSON.stringify(["mcp"]));

// ===================== PUBLIC, un-gated: OD mounts on a plain non-dev build ========
check("(public) isLoomDev() is FALSE by default (LOOM_DEV unset)", isLoomDev() === false);
const nonDevOn = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker", openDesign: true });
check("(public) non-dev build: openDesign=true + LOOM_OPEN_DESIGN_BIN resolvable ⇒ 'open-design' server IS mounted (public OSS, never gated)",
  "open-design" in nonDevOn);

// ===================== (a) buildMcpServers includes/omits the open-design stdio server =====================
const off = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker", openDesign: false });
const on = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker", openDesign: true });
check("(a) openDesign=false ⇒ NO 'open-design' server in the mcp-config", !("open-design" in off));
check("(a) openDesign=true ⇒ 'open-design' server IS in the mcp-config", "open-design" in on);
// byte-identical-when-off: the OFF map equals a spawn that never passed the flag at all.
const noFlag = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker" });
check("(a) OFF map is byte-identical to a no-flag spawn (fully additive)",
  JSON.stringify(off) === JSON.stringify(noFlag));
// turning the flag on adds EXACTLY the one 'open-design' key, nothing else changes.
check("(a) ON adds exactly the open-design key (everything else unchanged)",
  JSON.stringify({ ...on, "open-design": undefined }) === JSON.stringify({ ...off, "open-design": undefined }));
check("(a) buildMcpServers' open-design entry matches openDesignMcpServer() directly", JSON.stringify(on["open-design"]) === JSON.stringify(openDesignMcpServer()));

// openDesign=true but LOOM_OPEN_DESIGN_BIN unresolvable ⇒ clean-skip — THIS IS THE PRIMARY SHIPPING CASE
// (OD is not installed on the vast majority of hosts): a rig opts in, OD is absent, spawn stays clean.
delete process.env.LOOM_OPEN_DESIGN_BIN;
const onNoBin = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker", openDesign: true });
check("(a) [PRIMARY CASE] openDesign=true + no OD install (LOOM_OPEN_DESIGN_BIN unresolvable) ⇒ NO 'open-design' server (clean-skip, never throws)", !("open-design" in onNoBin));
check("(a) [PRIMARY CASE] the rest of the spawn config is otherwise byte-identical to a no-flag spawn",
  JSON.stringify(onNoBin) === JSON.stringify(noFlag));
process.env.LOOM_OPEN_DESIGN_BIN = fakeCli; // restore for the rest of the test

// a plain (role-null) OD session still gets the server (OD is orthogonal to role).
const plainOd = buildMcpServers({ sessionId: "s2", port: 4317, openDesign: true });
check("(a) openDesign works for a role-null session too (orthogonal to role)",
  "open-design" in plainOd && !("loom-orchestration" in plainOd));

// ===================== (c) capabilityToolAllowlist contributes the whole mcp__open-design prefix ========
const grants = resolveProfileCapabilities({ openDesign: true });
check("(c) resolveProfileCapabilities bridges openDesign to the 'open-design' slug",
  JSON.stringify(grants) === JSON.stringify([{ slug: "open-design" }]));
const allow = capabilityToolAllowlist(grants, []);
check("(c) allowlist includes the whole mcp__open-design server prefix", JSON.stringify(allow) === JSON.stringify(["mcp__open-design"]));
check("(c) openDesign=false contributes NO allowlist entries",
  capabilityToolAllowlist(resolveProfileCapabilities({ openDesign: false }), []).length === 0);

// ===================== profile validation: human-settable, agent-forbidden (exfil-class) =====================
const vOk = validateProfile({ name: "OD rig", openDesign: true });
check("(validate) openDesign:true round-trips through validateProfile (human REST path)", vOk.ok === true && vOk.value.openDesign === true);
check("(validate) omitted openDesign normalizes to false", validateProfile({ name: "x" }).value.openDesign === false);
check("(agent-forbidden) agentProfileKeyError REJECTS a payload setting openDesign",
  typeof agentProfileKeyError({ openDesign: true }) === "string");
check("(agent-forbidden) agentProfileKeyError allows a payload that doesn't touch openDesign",
  agentProfileKeyError({ name: "x" }) === null);

// ===================== end-to-end threading through SessionService (seam-captured opts) =====================
const repo = path.join(os.tmpdir(), `loom-od-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# open-design-spawn test\n");
execSync(`git init -q && git add . && git -c user.email=od@loom -c user.name=od commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pP", name: "P", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
// THE OD-capable profile (mirrors a "Web Designer + Open Design" variant) + a plain worker profile.
db.insertProfile({ id: "profOd", name: "Web Designer + Open Design", role: "worker", description: "od rig", allowDelta: [], skills: null, model: null, icon: "🎨", openDesign: true });
db.insertProfile({ id: "profDev", name: "Dev", role: "worker", description: "dev rig", allowDelta: [], skills: null, model: null, icon: null });
db.insertAgent({ id: "agentOd", projectId: "pP", name: "Designer", startupPrompt: "DESIGNER_PROMPT", position: 0, profileId: "profOd" });
db.insertAgent({ id: "agentPlain", projectId: "pP", name: "Plain", startupPrompt: "PLAIN_PROMPT", position: 1, profileId: null });
db.insertAgent({ id: "agentDev", projectId: "pP", name: "Dev", startupPrompt: "DEV_PROMPT", position: 2, profileId: "profDev" });
db.insertSession({ id: "mgr1", projectId: "pP", agentId: "agentPlain", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
const tW1 = "22222222-2222-4222-8222-222222222222";
db.insertTask({ id: tW1, projectId: "pP", title: "t", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

check("(roundtrip) OD profile persists openDesign=true", db.getProfile("profOd").openDesign === true);
check("(roundtrip) Dev profile defaults openDesign=false", db.getProfile("profDev").openDesign === false);

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
  // startNew on an OD-profile agent → openDesign threads to spawn opts + the persisted row.
  const sOd = svc.startNew("agentOd");
  const oOd = optsFor(sOd.id);
  check("(e2e) OD agent: spawn opts.openDesign === true", oOd?.openDesign === true);
  check("(e2e) OD agent: returned session.openDesign === true", sOd.openDesign === true);
  check("(e2e) OD agent: DB persists open_design=1 (pins it for respawns)", db.getSession(sOd.id).openDesign === true);
  const odMcp = buildMcpServers({ sessionId: sOd.id, port: 4317, role: oOd.role, openDesign: oOd.openDesign });
  check("(e2e) OD agent: the spawn's mcp-config includes the open-design server", "open-design" in odMcp);

  // startNew on a plain agent → false, byte-identical (no open-design).
  const sPlain = svc.startNew("agentPlain");
  const oPlain = optsFor(sPlain.id);
  check("(e2e) plain agent: spawn opts.openDesign is falsy", !oPlain?.openDesign);
  check("(e2e) plain agent: DB persists open_design=0", db.getSession(sPlain.id).openDesign === false);

  // RESUME the OD session → the capability is re-passed (carried from the pinned row), exactly like role.
  const engId = "33333333-4444-5555-6666-777777777777";
  db.setEngineSessionId(sOd.id, engId);
  const tpath = engineTranscriptPath(repo, engId);
  fs.mkdirSync(path.dirname(tpath), { recursive: true });
  fs.writeFileSync(tpath, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");
  host.capture.length = 0; // isolate the resume's captured opts
  svc.resume(sOd.id);
  const oResume = optsFor(sOd.id);
  check("(e2e) RESUME re-passes openDesign=true (a resumed OD-worker keeps its corpus MCP)",
    oResume?.openDesign === true);

  // spawnWorker pointed at the OD agent → resolves openDesign from THAT agent's profile.
  const wOd = await svc.spawnWorker("mgr1", { taskId: tW1, agentId: "agentOd", kickoffPrompt: "GO" });
  workerWorktree = wOd.worktreePath;
  const oWOd = optsFor(wOd.id);
  check("(e2e) spawnWorker(OD agent): spawn opts.openDesign === true", oWOd?.openDesign === true);
  check("(e2e) spawnWorker(OD agent): DB row persists open_design=1", db.getSession(wOd.id).openDesign === true);
} finally {
  try {
    const { removeWorktree } = await import("../dist/git/worktrees.js");
    for (const wt of [].concat(workerWorktree).filter(Boolean)) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } }
  } catch { /* best-effort */ }
  db.close();
  if (origOdBin === undefined) delete process.env.LOOM_OPEN_DESIGN_BIN; else process.env.LOOM_OPEN_DESIGN_BIN = origOdBin;
  delete process.env.LOOM_DEV;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — opt-in Open Design: resolveProfile backstops/passes openDesign; the open-design stdio MCP is injected iff openDesign AND LOOM_OPEN_DESIGN_BIN resolves (clean-skip otherwise, byte-identical off — the primary real-world case since OD isn't installed on most hosts); never gated by isLoomDev() (public OSS); the allowlist/profile-validation/agent-forbidden posture holds; the flag threads through startNew/resume/spawnWorker + the persisted row — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
