import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 158cb01a — GET /api/sessions/:id/grant-drift: the read-only, counts-only dry-run of
// POST /api/sessions/:id/repin-grants that backs the web drift badge. Contract pinned here:
//   (a) same refusals as the POST (404 unknown, 409 companion / superseded), a real unexpected throw -> 500;
//   (b) COUNTS ONLY — no connection id appears anywhere in the body;
//   (c) READ-ONLY — the session row is untouched and no grants_repinned event is filed;
//   (d) it reports the ZERO-pinned case (agent has N grants, session pinned 0) with firstTimeGrant:true,
//       a partial pin, and an EQUAL-COUNT swap (counts alone would hide it, `drifted` must not);
//   (e) it agrees with what the POST then applies: after the re-pin the drift is gone.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE: real Db, real SessionService on a fake pty seam, real
// buildServer through app.inject (same hermetic shape as repin-grants-gateway.mjs).
// Run: 1) build (turbo builds shared first), 2) node test/grant-drift-route.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-grantdrift-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
delete process.env.CLAUDE_CONFIG_DIR;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { routeTier } = await import("../dist/gateway/trust-tier.js");

const repo = path.join(os.tmpdir(), `loom-grantdrift-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# grant-drift\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=gd@loom -c user.name=gd");

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pD", name: "D", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
db.insertProfile({
  id: "profD", name: "Rig", role: "manager", description: "", allowDelta: [], skills: null, model: null, icon: null,
  connections: [], capabilities: [], browserTesting: false, documentConversion: false, restrictedTools: false, noCommit: false, vaultWrite: false,
});
db.insertAgent({ id: "agentD", projectId: "pD", name: "Profiled", startupPrompt: "", position: 0, profileId: "profD" });

const mkSession = (id, role, extra = {}) => db.insertSession({
  id, projectId: "pD", agentId: "agentD", engineSessionId: null, title: null, cwd: repo,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role, parentSessionId: null, ...extra,
});
mkSession("s-mgr", "manager");
mkSession("s-companion", "assistant");
db.insertSession({
  id: "s-stale-pred", projectId: "pD", agentId: "agentD", engineSessionId: null, title: null, cwd: repo,
  processState: "exited", resumability: "dead", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role: "manager", parentSessionId: null,
});
mkSession("s-stale-succ", "manager", { recycledFrom: "s-stale-pred" });

class SeamHost extends createSeamHost(PtyHost) { isAlive() { return false; } }
const host = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
const svc = new SessionService(db, host, new OrchestrationControl());
const stub = {};
const mkApp = (sessions) => buildServer({
  db, pty: stub, sessions, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub,
  setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub, requestShutdown: () => {},
});
const eventsFor = (id) => db.listEventsForSession(id).filter((e) => e.kind === "grants_repinned");

{
  const app = await mkApp(svc);
  const get = async (id) => { const r = await app.inject({ method: "GET", url: `/api/sessions/${id}/grant-drift` }); return { code: r.statusCode, raw: r.payload, body: (() => { try { return JSON.parse(r.payload); } catch { return {}; } })() }; };
  try {
    // (a) refusals mirror the POST
    check("(1) unknown id -> 404", (await get("00000000-0000-0000-0000-000000000000")).code === 404);
    const comp = await get("s-companion");
    check("(2) a companion -> 409 pointing at /upgrade", comp.code === 409 && /upgrade/i.test(comp.body.error ?? ""));
    const stale = await get("s-stale-pred");
    check("(3) a superseded row -> 409 naming the successor", stale.code === 409 && (stale.body.error ?? "").includes("s-stale-succ"));

    // no drift yet: agent has no grants, session pinned none
    const none = await get("s-mgr");
    check("(4) agent 0 / session 0 -> 200, drifted:false", none.code === 200 && none.body.drifted === false);

    // (d) ZERO-pinned: agent granted 3 after the session spawned
    db.updateAgent("agentD", { connections: ["secret-conn-aaa", "secret-conn-bbb", "secret-conn-ccc"] });
    const zero = await get("s-mgr");
    check("(5) zero-pinned: drifted:true, connections 0 -> 3, firstTimeGrant:true",
      zero.body.drifted === true && zero.body.connections?.pinned === 0 && zero.body.connections?.current === 3 && zero.body.firstTimeGrant === true);
    // (b) counts only
    check("(6) COUNTS ONLY: no connection id appears anywhere in the body", !/secret-conn/.test(zero.raw));
    // (c) read-only
    check("(7) READ-ONLY: the session row's connections are untouched", (db.getSession("s-mgr").connections ?? []).length === 0);
    check("(7) READ-ONLY: no grants_repinned event was filed", eventsFor("s-mgr").length === 0);

    // partial pin
    db.setSessionCapabilitySurface("s-mgr", { ...snapshotSurface(db.getSession("s-mgr")), connections: ["secret-conn-aaa"] });
    const partial = await get("s-mgr");
    check("(8) partial pin: 1 -> 3, drifted:true, firstTimeGrant:false",
      partial.body.drifted === true && partial.body.connections?.pinned === 1 && partial.body.connections?.current === 3 && partial.body.firstTimeGrant === false);

    // equal-count swap: counts alone say nothing changed, `drifted` must still be true
    db.updateAgent("agentD", { connections: ["secret-conn-zzz"] });
    const swap = await get("s-mgr");
    check("(9) equal-count swap (1 vs 1, different ids): drifted:true although the counts match",
      swap.body.drifted === true && swap.body.connections?.pinned === 1 && swap.body.connections?.current === 1);

    // (e) the POST applies exactly what the dry-run reported, then the drift is gone
    db.updateAgent("agentD", { connections: ["secret-conn-aaa", "secret-conn-bbb", "secret-conn-ccc"] });
    const post = await app.inject({ method: "POST", url: `/api/sessions/s-mgr/repin-grants` });
    check("(10) POST re-pin -> 200", post.statusCode === 200);
    const after = await get("s-mgr");
    check("(10) after the re-pin the drift is gone and pinned == current == 3",
      after.body.drifted === false && after.body.connections?.pinned === 3 && after.body.connections?.current === 3);
    check("(10) the pinned set now equals the agent's", JSON.stringify(db.getSession("s-mgr").connections) === JSON.stringify(db.getAgent("agentD").connections));

    // revocation direction (pinned > current) also reports
    db.updateAgent("agentD", { connections: [] });
    const revoked = await get("s-mgr");
    check("(11) a revocation (pinned 3 -> current 0) reports drifted:true, firstTimeGrant:false",
      revoked.body.drifted === true && revoked.body.connections?.current === 0 && revoked.body.firstTimeGrant === false);

    // trust tier: identical to the POST it mirrors, and not Tier 1
    check("(12) trust tier of GET grant-drift equals the POST repin-grants tier and is Tier 0",
      routeTier("GET", "/api/sessions/:id/grant-drift") === routeTier("POST", "/api/sessions/:id/repin-grants")
      && routeTier("GET", "/api/sessions/:id/grant-drift") === 0);
  } finally {
    try { await app.close(); } catch { /* ignore */ }
  }
}

// Review-round fixtures (card 158cb01a): non-counted fields, first-time ssh_exec, archived 409, read-only skills/warn.
{
  const mkProfile = (id, extra) => db.insertProfile({
    id, name: id, role: "manager", description: "", allowDelta: [], skills: null, model: null, icon: null,
    connections: [], capabilities: [], browserTesting: false, documentConversion: false, restrictedTools: false, noCommit: false, vaultWrite: false, ...extra,
  });
  const mkAgent = (id, profileId, extra = {}) => db.insertAgent({ id, projectId: "pD", name: id, startupPrompt: "", position: 0, profileId, ...extra });
  const mk = (id, agentId, role, extra = {}) => db.insertSession({
    id, projectId: "pD", agentId, engineSessionId: null, title: null, cwd: repo,
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
    role, parentSessionId: null, ...extra,
  });
  const app = await mkApp(svc);
  const get = async (id) => { const r = await app.inject({ method: "GET", url: `/api/sessions/${id}/grant-drift` }); return { code: r.statusCode, body: (() => { try { return JSON.parse(r.payload); } catch { return {}; } })() }; };
  const kinds = (id, kind) => db.listEventsForSession(id).filter((e) => e.kind === kind);
  try {
    // (14) drift in ONLY a non-counted field: the agent's profile restricts tools, the session was pinned unrestricted
    mkProfile("profR", { restrictedTools: true });
    mkAgent("agentR", "profR");
    mk("s-restr", "agentR", "manager");
    const tight = await get("s-restr");
    check("(14) restrictedTools-only drift: drifted:true, restrictedTools false->true, counts unchanged, otherChanged names it",
      tight.body.drifted === true && tight.body.restrictedTools?.pinned === false && tight.body.restrictedTools?.current === true
      && tight.body.connections?.pinned === 0 && tight.body.connections?.current === 0
      && tight.body.capabilities?.pinned === 0 && tight.body.capabilities?.current === 0
      && JSON.stringify(tight.body.otherChanged) === JSON.stringify(["restrictedTools"]) && tight.body.firstTimeGrant === false);
    check("(14) restrictedTools is a spawn-time field => spawnTimeChanged:true", tight.body.spawnTimeChanged === true);
    // loosening direction: pinned true, agent now resolves false
    mk("s-loose", "agentD", "manager", { restrictedTools: true });
    const loose = await get("s-loose");
    check("(15) restriction LOOSENING (pinned true -> current false) is reported", loose.body.drifted === true
      && loose.body.restrictedTools?.pinned === true && loose.body.restrictedTools?.current === false);
    // noCommit-only
    mkProfile("profN", { noCommit: true });
    mkAgent("agentN", "profN");
    mk("s-nocommit", "agentN", "manager");
    const nc = await get("s-nocommit");
    check("(16) noCommit-only drift reports noCommit and names it in otherChanged, not spawn-time",
      nc.body.drifted === true && nc.body.noCommit?.current === true && nc.body.otherChanged?.includes("noCommit") && nc.body.spawnTimeChanged === false);
    // a connections-only drift is NOT spawn-time
    db.updateAgent("agentD", { connections: ["secret-conn-zzz"] });
    mk("s-conn-only", "agentD", "manager");
    const co = await get("s-conn-only");
    check("(17) connections-only drift: spawnTimeChanged:false, otherChanged empty",
      co.body.drifted === true && co.body.spawnTimeChanged === false && co.body.otherChanged?.length === 0);
    db.updateAgent("agentD", { connections: [] });

    // (18) first-time ssh_exec although the session already pins another connection
    const http = db.createConnection({ name: "DriftHttp", host: "api.example.test", authScheme: "api-key", secretBlob: "x", projectId: null });
    const ssh = db.createConnection({ name: "DriftSsh", host: "pve.lan", authScheme: "ssh", secretBlob: "x", projectId: null, sshPort: 22, sshUser: "u", sshHostKeyFingerprint: "SHA256:" + "A".repeat(43), sshReadOnly: true });
    db.updateAgent("agentD", { connections: [http.id, ssh.id] });
    mk("s-ssh-new", "agentD", "manager", { connections: [http.id] });
    const sshNew = await get("s-ssh-new");
    check("(18) pinned [http] -> [http, ssh]: firstTimeGrant:true (ssh_exec absent -> present) although pinned.connections > 0",
      sshNew.body.connections?.pinned === 1 && sshNew.body.firstTimeGrant === true);
    mk("s-ssh-had", "agentD", "manager", { connections: [ssh.id] });
    const sshHad = await get("s-ssh-had");
    check("(18) control: pinned [ssh] -> [ssh, http]: firstTimeGrant:false (ssh_exec was already registered)",
      sshHad.body.drifted === true && sshHad.body.firstTimeGrant === false);
    db.updateAgent("agentD", { connections: [] });

    // (19) archived session -> 409 naming "archived"
    mk("s-archived", "agentD", "manager");
    db.archiveSession("s-archived");
    const arch = await get("s-archived");
    check("(19) an archived session -> 409 naming it archived", arch.code === 409 && /archived/i.test(arch.body.error ?? ""));

    // (20) READ-ONLY where skills WOULD be dropped: platform-role session on a manager-role profile with a skills subset
    mkProfile("profS", { role: "manager", skills: ["some-skill"] });
    mkAgent("agentS", "profS");
    mk("s-skills", "agentS", "platform");
    const sk = await get("s-skills");
    check("(20) skills-dropped fixture: GET answers 200", sk.code === 200);
    check("(20) READ-ONLY: a GET where skills would be dropped files NO locked_role_skills_dropped event", kinds("s-skills", "locked_role_skills_dropped").length === 0);
    const skPost = await app.inject({ method: "POST", url: `/api/sessions/s-skills/repin-grants` });
    check("(20) positive control: the POST on the same fixture DOES file locked_role_skills_dropped (the fixture can produce it)",
      skPost.statusCode === 200 && kinds("s-skills", "locked_role_skills_dropped").length === 1);

    // (21) the dry-run does not emit the codex-provider-dropped console line (polled every 15s); the POST still does
    mkProfile("profP", { codexProvider: { id: "ollama" } });
    mkAgent("agentP", "profP");
    mk("s-prov", "agentP", "manager");
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...a) => { warns.push(a.join(" ")); };
    let provGet, provPost;
    try {
      provGet = await get("s-prov");
      const afterGet = warns.filter((w) => w.includes("[codex-provider-dropped]")).length;
      provPost = await app.inject({ method: "POST", url: `/api/sessions/s-prov/repin-grants` });
      const afterPost = warns.filter((w) => w.includes("[codex-provider-dropped]")).length;
      check("(21) the GET dry-run logs NO [codex-provider-dropped] warning", provGet.code === 200 && afterGet === 0);
      check("(21) positive control: the POST still logs it (real-spawn/POST logging unchanged)", provPost.statusCode === 200 && afterPost === 1);
    } finally { console.warn = origWarn; }
  } finally {
    try { await app.close(); } catch { /* ignore */ }
  }
}

// (a) an UNEXPECTED (non-refusal) throw surfaces as 500, never a 409
{
  const app = await mkApp({ sessionGrantDrift() { throw new TypeError("boom — not a RepinGrantsRefusalError"); } });
  try {
    const res = await app.inject({ method: "GET", url: `/api/sessions/s-mgr/grant-drift` });
    check("(13) an unexpected throw -> 500, never 409", res.statusCode === 500);
  } finally {
    try { await app.close(); } catch { /* ignore */ }
  }
}

function snapshotSurface(s) {
  return {
    browserTesting: s.browserTesting ?? false, documentConversion: s.documentConversion ?? false, capabilities: s.capabilities ?? [],
    restrictedTools: s.restrictedTools ?? false, noCommit: s.noCommit ?? false, skills: s.skills ?? null,
    connections: s.connections ?? [], vaultWrite: s.vaultWrite ?? false,
  };
}

db.close();
cleanupPathSync(tmpHome);
try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — GET /api/sessions/:id/grant-drift: same refusals as the POST, counts only, read-only, covers zero-pinned / partial / equal-count-swap / revocation, agrees with the re-pin, Tier 0."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
