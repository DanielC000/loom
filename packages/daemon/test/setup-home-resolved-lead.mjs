import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card b2b69ec8 (M3): GET /api/setup/home's `resolvedLead` field — the ONE server-side authority
// (`resolveHomeLeadAgent`) for "which agent is the home's operator, and what spawn role would it
// actually run under". Before this card the web re-derived the same answer by LIST ORDER (first
// platform-role agent, then name), which can disagree with the daemon the moment a second human-bound
// platform-role agent exists in the home — this test proves the REST field itself, not the (removed) web
// re-derivation. HERMETIC + CLAUDE-FREE + NETWORK-FREE, modeled on platform-home-rest.mjs. Proves:
//   (1) non-dev, fresh seed → the seeded agent IS the Lead directly: resolvedLead.agentId === that
//       agent's id, role "platform".
//   (2) non-dev, the home's operator agent is bound to a NON-platform profile (the not-yet-upgraded
//       shape) → resolvedLead.agentId still resolves (the marker identifies "the home's operator agent"
//       independent of its current role), but role "setup".
//   (3) non-dev, AMBIGUOUS — a second agent in the home is ALSO bound to a platform-role profile →
//       resolveHomeLeadAgent refuses to guess → resolvedLead is {agentId: null, role: null}, even though
//       `agents` on the same response is non-empty. This is the exact regression M3 fixes: a client-side
//       `agents.find(role === "platform")` would have silently picked ONE of the two by list order.
//   (4) a DEV install (LOOM_DEV=1) — `resolveHomeLeadAgent` is unconditionally undefined there (the dev
//       Lead lives in the separate "Loom Platform" home), so resolvedLead stays {agentId: null, role:
//       null} even though a real, non-ambiguous setup-home operator agent exists.
// Run: 1) build (turbo builds shared first), 2) node test/setup-home-resolved-lead.mjs
import fs from "node:fs";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";

const TMP = mkdtempManaged("loom-setup-home-resolved-lead-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = String(hermeticPort());
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const buildApp = async (db) => {
  const { buildServer } = await import("../dist/gateway/server.js");
  const stub = {};
  return buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });
};

// ===== (1) non-dev, fresh seed → the seeded agent resolves directly as the Lead =====
{
  delete process.env.LOOM_DEV; // non-dev install
  requireHermeticEnv();
  const { Db } = await import("../dist/db.js");
  const { seedDefaultProfiles } = await import("../dist/profiles/seed.js");
  const { seedSetupHome, SETUP_AGENT_NAME } = await import("../dist/setup/seed.js");

  const db = new Db(path.join(TMP, "loom-fresh.db"));
  seedDefaultProfiles(db);
  seedSetupHome(db); // non-dev: seeds the operator DIRECTLY as the full Lead (Platform-lead profile)
  const home = db.listAllProjects().find((p) => p.reserved);
  const agent = db.listAgents(home.id).find((a) => a.name === SETUP_AGENT_NAME);

  const app = await buildApp(db);
  try {
    const r = await app.inject({ method: "GET", url: "/api/setup/home" });
    check("(1) GET /api/setup/home → 200", r.statusCode === 200);
    const body = r.json();
    check("(1) resolvedLead is present", typeof body.resolvedLead === "object" && body.resolvedLead !== null);
    check("(1) resolvedLead.agentId === the seeded operator agent's id", body.resolvedLead.agentId === agent.id);
    check("(1) resolvedLead.role === 'platform' (the fresh non-dev seed is already the sanctioned Lead)",
      body.resolvedLead.role === "platform");
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    db.close();
  }
}

// ===== (2) non-dev, operator bound to a NON-platform profile → agentId still resolves, role "setup" =====
{
  delete process.env.LOOM_DEV;
  requireHermeticEnv();
  const { Db } = await import("../dist/db.js");
  const { seedDefaultProfiles } = await import("../dist/profiles/seed.js");
  const { seedSetupHome, SETUP_AGENT_NAME } = await import("../dist/setup/seed.js");

  const db = new Db(path.join(TMP, "loom-customized.db"));
  seedDefaultProfiles(db);
  seedSetupHome(db);
  const home = db.listAllProjects().find((p) => p.reserved);
  const agent = db.listAgents(home.id).find((a) => a.name === SETUP_AGENT_NAME);
  const setupProfile = db.listProfiles().find((p) => p.name === "Setup Assistant"); // role "setup"
  db.updateAgent(agent.id, { profileId: setupProfile.id }); // simulate the not-yet-upgraded shape

  const app = await buildApp(db);
  try {
    const body = (await app.inject({ method: "GET", url: "/api/setup/home" })).json();
    check("(2) resolvedLead.agentId still resolves the SAME agent (the marker, not the current role)",
      body.resolvedLead.agentId === agent.id);
    check("(2) resolvedLead.role === 'setup' (not the sanctioned Lead — bound profile role isn't 'platform')",
      body.resolvedLead.role === "setup");
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    db.close();
  }
}

// ===== (3) non-dev, AMBIGUOUS — two platform-role agents in the home → resolvedLead refuses to guess =====
// This is the exact case M3 fixes: before the fix, a client-side `agents.find(role==="platform")` would
// silently pick ONE of the two by list order; the daemon's own authority refuses instead.
{
  delete process.env.LOOM_DEV;
  requireHermeticEnv();
  const { Db } = await import("../dist/db.js");
  const { seedDefaultProfiles } = await import("../dist/profiles/seed.js");
  const { seedSetupHome, SETUP_HOME_LEAD_AGENT_ID_KEY } = await import("../dist/setup/seed.js");

  const db = new Db(path.join(TMP, "loom-ambiguous.db"));
  seedDefaultProfiles(db);
  seedSetupHome(db); // seeds ONE platform-role operator agent + stamps the marker onto it
  const home = db.listAllProjects().find((p) => p.reserved);
  const platformProfile = db.listProfiles().find((p) => p.name === "Platform-lead");
  // A SECOND agent, also bound to the platform-role profile, in the SAME home — e.g. a human adding a
  // second Lead-capable agent manually.
  db.insertAgent({
    id: "second-platform-agent", projectId: home.id, name: "A second Lead-capable agent",
    startupPrompt: "", position: 1, profileId: platformProfile.id, endpoint: false, ioSchema: null,
  });
  // The marker from seedSetupHome above still points at the FIRST agent, so resolution would resolve
  // it there WITHOUT ever reaching the ambiguity check (step 1 wins outright). Force a dangling marker
  // (an id that resolves to no real agent) so resolution falls through to the lockout-repair step (step
  // 2) — the one that actually sees BOTH platform-role agents in the home and refuses to guess.
  db.setMeta(SETUP_HOME_LEAD_AGENT_ID_KEY, "a-dangling-marker-id-pointing-nowhere");

  const app = await buildApp(db);
  try {
    const body = (await app.inject({ method: "GET", url: "/api/setup/home" })).json();
    check("(3) agents on the response include both platform-role agents",
      (body.agents ?? []).some((a) => a.id === "second-platform-agent"));
    check("(3) resolvedLead refuses to guess between them: {agentId: null, role: null}",
      body.resolvedLead.agentId === null && body.resolvedLead.role === null);
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    db.close();
  }
}

// ===== (4) a DEV install — resolveHomeLeadAgent is unconditionally undefined there =====
{
  process.env.LOOM_DEV = "1";
  requireHermeticEnv();
  const { Db } = await import("../dist/db.js");
  const { seedDefaultProfiles } = await import("../dist/profiles/seed.js");
  const { seedSetupHome, SETUP_AGENT_NAME } = await import("../dist/setup/seed.js");

  const db = new Db(path.join(TMP, "loom-dev.db"));
  seedDefaultProfiles(db);
  seedSetupHome(db); // dev: UNGATED setup home still seeds, but as the narrower (non-Lead) shape
  const home = db.listAllProjects().find((p) => p.reserved);
  const agent = db.listAgents(home.id).find((a) => a.name === SETUP_AGENT_NAME);
  check("(4) a real, unambiguous setup-home operator agent exists on this dev install", !!agent);

  const app = await buildApp(db);
  try {
    const body = (await app.inject({ method: "GET", url: "/api/setup/home" })).json();
    check("(4) resolvedLead is {agentId: null, role: null} on a dev install (no cross-fallback to the dev Lead)",
      body.resolvedLead.agentId === null && body.resolvedLead.role === null);
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    db.close();
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — GET /api/setup/home's resolvedLead field resolves the SAME agent id + spawn role resolveHomeLeadAgent/isSanctionedPlatformLeadAgent would, refuses to guess when ambiguous (two platform-role agents in the home), and stays {agentId:null, role:null} on a dev install rather than cross-falling-back to the dev Lead."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
