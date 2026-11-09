import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Agent RENAME name checks (card b0495d0b). An agent name is an identity: worker_spawn resolves `agentId`
// by case-insensitive name then by slug, and the setup home's seeders find their agents by exact name.
//
// Covers:
//   (0) resolveAgentRename (pure): a real rename passes, trimmed; empty and whitespace-only are refused;
//       a case-insensitive duplicate NAME and a duplicate SLUG of another agent are refused; re-saving the
//       agent's own unchanged name and a case-only change of its own name both pass; a name-keyed seeded
//       agent can't be renamed (not even case-only) and its name can't be taken.
//   (1) validateAgentPatch fails CLOSED on a `name` key when no rename scope is supplied, and still
//       ignores a patch without `name` (no scope needed).
//   (2) REST POST /api/agents/:id end to end: a rename round-trips (trimmed); empty, whitespace, dup-name
//       and dup-slug are 400 with nothing written; the same name in ANOTHER project is fine; the seeded
//       Companion agent (pinned by an id marker, card de790214) CAN be renamed and a re-seed mints no second
//       one; the setup home's own "Platform" agent (still found by name) is refused 400 and keeps its name,
//       and an ORDINARY setup-home agent can't take that reserved name either.
//   (3) The agent-facing agent_update tools, which bypass the REST route: the MANAGER's (orchestration →
//       sessions.updateAgentPreset) refuses a dup name / dup slug / empty name with an `agent_update: …`
//       error and writes NOTHING of the patch; the SETUP surface's (validateAgentPatch + agentNameScope)
//       refuses a dup name / slug with nothing written. Each has a positive control on the same tool.
//
// Negative control for (3a): a --mutant that deletes the resolveAgentRename call in updateAgentPreset
// (name passed through unchecked) turns the (3a) refusal checks RED.
//
// Run: 1) build (turbo builds shared first), 2) node test/agent-rename-name-checks.mjs
import path from "node:path";
import { useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";

const tmpHome = useOwnLoomHome("loom-agent-rename-");
requireHermeticEnv();
delete process.env.LOOM_DEV; // the setup home + Companion seed are CORE; pin the default path

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { validateAgentPatch, resolveAgentRename } = await import("../dist/agents/validate.js");
const { seedDefaultProfiles } = await import("../dist/profiles/seed.js");
const { seedSetupHome, seedCompanionAgent, COMPANION_AGENT_NAME, agentNameScope } = await import("../dist/setup/seed.js");
const { resolveSetupHome } = await import("../dist/projects/reserved-home-markers.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// ===================== (0) resolveAgentRename (pure) =====================
{
  const siblings = [{ id: "a1", name: "QA Tester" }, { id: "a2", name: "Web Designer" }];
  const scope = (agentId, currentName, reservedNames = []) => ({ agentId, currentName, siblings, reservedNames });

  const ok = resolveAgentRename("  Reviewer  ", scope("a1", "QA Tester"));
  check("(0) a real rename passes and is trimmed", ok.ok === true && ok.name === "Reviewer");
  const empty = resolveAgentRename("", scope("a1", "QA Tester"));
  check("(0) an empty name is refused", empty.ok === false && /must not be empty/.test(empty.error));
  const ws = resolveAgentRename("   \t ", scope("a1", "QA Tester"));
  check("(0) a whitespace-only name is refused", ws.ok === false && /must not be empty/.test(ws.error));
  const dupName = resolveAgentRename("web designer", scope("a1", "QA Tester"));
  check("(0) a case-insensitive duplicate NAME is refused, naming the other agent", dupName.ok === false && /already named "Web Designer"/.test(dupName.error));
  const dupSlug = resolveAgentRename("web-designer", scope("a1", "QA Tester"));
  check("(0) a duplicate SLUG is refused, naming the other agent and the slug", dupSlug.ok === false && /"Web Designer"/.test(dupSlug.error) && /"web-designer"/.test(dupSlug.error));
  const self = resolveAgentRename("QA Tester", scope("a1", "QA Tester"));
  check("(0) re-saving the agent's own unchanged name passes", self.ok === true && self.name === "QA Tester");
  const caseSelf = resolveAgentRename("qa tester", scope("a1", "QA Tester"));
  check("(0) a case-only change of its own name passes", caseSelf.ok === true && caseSelf.name === "qa tester");
  const slugSelf = resolveAgentRename("QA-Tester", scope("a1", "QA Tester"));
  check("(0) a slug-equal change of its own name passes (it only collides with itself)", slugSelf.ok === true);

  const reserved = ["Platform"];
  const rs = { agentId: "c1", currentName: "Platform", siblings: [{ id: "c1", name: "Platform" }, { id: "x", name: "Other" }], reservedNames: reserved };
  const renameReserved = resolveAgentRename("Buddy", rs);
  check("(0) a name-keyed seeded agent can't be renamed", renameReserved.ok === false && /built-in agent/.test(renameReserved.error));
  const caseReserved = resolveAgentRename("platform", rs);
  check("(0) ...not even case-only (the lookups compare exactly)", caseReserved.ok === false);
  check("(0) ...but re-saving its exact name passes", resolveAgentRename("Platform", rs).ok === true);
  const takeReserved = resolveAgentRename("platform", { ...rs, agentId: "x", currentName: "Other", siblings: [{ id: "x", name: "Other" }] });
  check("(0) another agent can't take a reserved seeded name", takeReserved.ok === false && /reserved for a built-in agent/.test(takeReserved.error));
}

// ===================== (1) validateAgentPatch fails closed without a scope =====================
{
  const noScope = validateAgentPatch({ name: "New" }, () => true, { allowEndpointFlags: false });
  check("(1) a `name` key with no rename scope is refused (fail closed)", noScope.ok === false && noScope.kind === "invalid");
  const noName = validateAgentPatch({ startupPrompt: "hi" }, () => true, { allowEndpointFlags: false });
  check("(1) a patch without `name` needs no scope", noName.ok === true && !("name" in noName.patch));
  const scoped = validateAgentPatch({ name: "  New  " }, () => true, { allowEndpointFlags: false, nameScope: { agentId: "a", currentName: "Old", siblings: [], reservedNames: [] } });
  check("(1) with a scope, the patch carries the trimmed name", scoped.ok === true && scoped.patch.name === "New");
}

// ===================== (2) REST POST /api/agents/:id end to end =====================
{
  const db = new Db(path.join(tmpHome, "rest.db"));
  const now = new Date().toISOString();
  db.insertProject({ id: "pA", name: "A", repoPath: "pA", vaultPath: "pA", config: {}, createdAt: now, archivedAt: null });
  db.insertProject({ id: "pB", name: "B", repoPath: "pB", vaultPath: "pB", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "agA1", projectId: "pA", name: "Builder", startupPrompt: "", position: 0, profileId: null });
  db.insertAgent({ id: "agA2", projectId: "pA", name: "QA Tester", startupPrompt: "", position: 1, profileId: null });
  db.insertAgent({ id: "agB1", projectId: "pB", name: "Shipwright", startupPrompt: "", position: 0, profileId: null });
  seedDefaultProfiles(db);
  seedSetupHome(db);
  seedCompanionAgent(db);

  const stub = {};
  const app = await buildServer({
    db, pty: { enqueueStdin: () => ({ delivered: true }) }, sessions: stub, mcp: stub, orchMcp: stub,
    platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub,
  });
  const rename = (id, name) => app.inject({ method: "POST", url: `/api/agents/${id}`, payload: { name } });

  const okRes = await rename("agA1", "  Architect  ");
  check("(2) a rename succeeds (200) and returns the trimmed name", okRes.statusCode === 200 && okRes.json().name === "Architect");
  check("(2) the new name reads back from the DB", db.getAgent("agA1").name === "Architect");

  for (const [label, name, re] of [
    ["empty", "", /must not be empty/],
    ["whitespace-only", "   ", /must not be empty/],
    ["dup name (case-insensitive)", "qa tester", /already named "QA Tester"/],
    ["dup slug", "qa-tester", /"QA Tester"/],
  ]) {
    const res = await rename("agA1", name);
    check(`(2) ${label}: refused 400 with the reason`, res.statusCode === 400 && re.test(res.json().error));
    check(`(2) ${label}: nothing written`, db.getAgent("agA1").name === "Architect");
  }
  const selfRes = await rename("agA2", "QA Tester");
  check("(2) re-saving an agent's own unchanged name passes", selfRes.statusCode === 200 && db.getAgent("agA2").name === "QA Tester");
  const caseRes = await rename("agA2", "QA tester");
  check("(2) a case-only change of its own name passes", caseRes.statusCode === 200 && db.getAgent("agA2").name === "QA tester");
  const crossRes = await rename("agB1", "Architect");
  check("(2) the same name in ANOTHER project is allowed", crossRes.statusCode === 200 && db.getAgent("agB1").name === "Architect");

  const companion = db.listAllAgents().find((a) => a.name === COMPANION_AGENT_NAME);
  check("(2) fixture: the Companion agent was seeded into the setup home", !!companion && !agentNameScope(db, companion).reservedNames.includes(COMPANION_AGENT_NAME));
  // Card de790214: the Companion is pinned by an id marker, so a rename is allowed and a re-seed adds nothing.
  const compRes = await rename(companion.id, "My Buddy");
  check("(2) renaming the seeded Companion is allowed (200)", compRes.statusCode === 200 && db.getAgent(companion.id).name === "My Buddy");
  seedCompanionAgent(db);
  check("(2) so a re-seed does not mint a second Companion",
    db.listAllAgents().filter((a) => a.name === COMPANION_AGENT_NAME).length === 0 && db.listAllAgents().filter((a) => a.name === "My Buddy").length === 1);
  check("(2) an ordinary project's agents get no reserved names", agentNameScope(db, db.getAgent("agA1")).reservedNames.length === 0);

  // The setup home's OWN operator agent is still found by name by the lead fallbacks, so it stays
  // un-renameable, and an ORDINARY setup-home agent can't take its name — end to end over REST.
  const setupHome = resolveSetupHome(db);
  check("(2) fixture: the setup home resolves", !!setupHome && setupHome.id === companion.projectId);
  const platformAgent = db.listAgents(setupHome.id).find((a) => a.name === "Platform");
  check("(2) fixture: the setup home's own agent exists", !!platformAgent);
  const platRes = await rename(platformAgent.id, "Not Platform");
  check("(2) renaming the setup home's own agent is refused 400, saying why", platRes.statusCode === 400 && /built-in agent/.test(platRes.json().error));
  check("(2) ...and it keeps its name", db.getAgent(platformAgent.id).name === "Platform");
  db.insertAgent({ id: "agHomeOrd", projectId: setupHome.id, name: "Notetaker", startupPrompt: "", position: 90, profileId: null });
  const takeRes = await rename("agHomeOrd", "platform");
  check("(2) an ordinary setup-home agent renamed to a reserved name is refused 400, saying why",
    takeRes.statusCode === 400 && /reserved for a built-in agent/.test(takeRes.json().error));
  check("(2) ...and keeps its name", db.getAgent("agHomeOrd").name === "Notetaker");

  await app.close();

  // ===================== (3) the agent-facing agent_update tools =====================
  // Both bypass the REST route, so each must carry the rename check itself. Driven through the REAL
  // routers over an in-memory MCP transport (no claude: a seam pty host).
  class SeamHost extends createSeamHost(PtyHost) { stop() {} }
  const events = {
    onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); }, onBusy(id, b) { db.setBusy(id, b); },
    onContextStats() {}, onRateLimited() {}, onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
  };
  const svc = new SessionService(db, new SeamHost(events), new OrchestrationControl());
  const seedSession = (id, projectId, agentId, role) => db.insertSession({
    id, projectId, agentId, engineSessionId: null, title: null, cwd: tmpHome, processState: "live",
    resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role, parentSessionId: null,
  });
  const connect = async (router, sessionId) => {
    const server = router.buildServer(sessionId);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "agent-rename-name-checks", version: "0" });
    await client.connect(clientT);
    return async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  };
  // Fresh siblings so (3) does not lean on (2)'s renames.
  db.insertAgent({ id: "agA3", projectId: "pA", name: "Cartographer", startupPrompt: "", position: 3, profileId: null });
  db.insertAgent({ id: "agA4", projectId: "pA", name: "Lamplighter", startupPrompt: "", position: 4, profileId: null });

  // (3a) MANAGER agent_update → sessions.updateAgentPreset.
  seedSession("mgrA", "pA", "agA1", "manager");
  const mgr = await connect(new OrchestrationMcpRouter(db, svc), "mgrA");
  const mDupName = await mgr("agent_update", { agentId: "agA3", name: "LAMPLIGHTER" });
  check("(3a) manager agent_update: a duplicate NAME is refused with an agent_update: error",
    typeof mDupName.error === "string" && /^agent_update: .*already named "Lamplighter"/.test(mDupName.error));
  check("(3a) ...and nothing is written", db.getAgent("agA3").name === "Cartographer");
  const mDupSlug = await mgr("agent_update", { agentId: "agA3", name: "Lamplighter!", startupPrompt: "should not land" });
  check("(3a) manager agent_update: a duplicate SLUG is refused", typeof mDupSlug.error === "string" && /^agent_update: /.test(mDupSlug.error));
  check("(3a) ...and the WHOLE patch is dropped (name and prompt both unchanged)",
    db.getAgent("agA3").name === "Cartographer" && db.getAgent("agA3").startupPrompt === "");
  const mEmpty = await mgr("agent_update", { agentId: "agA3", name: "   " });
  check("(3a) manager agent_update: a whitespace-only name is refused", typeof mEmpty.error === "string" && /must not be empty/.test(mEmpty.error));
  const mOk = await mgr("agent_update", { agentId: "agA3", name: "  Surveyor  " });
  check("(3a) positive control: a clean rename through the same tool lands, trimmed",
    !mOk.error && mOk.name === "Surveyor" && db.getAgent("agA3").name === "Surveyor");

  // (3b) SETUP agent_update → validateAgentPatch with agentNameScope.
  seedSession("setupS", setupHome.id, companion.id, "setup");
  const setupRouter = new SetupMcpRouter(db, svc);
  check("(3b) fixture: the setup session has the loom-setup surface", !!setupRouter.resolveRole("setupS"));
  const setup = await connect(setupRouter, "setupS");
  const sDup = await setup("agent_update", { agentId: "agA4", name: "surveyor" });
  check("(3b) setup agent_update: a duplicate NAME is refused, naming the other agent",
    typeof sDup.error === "string" && /already named "Surveyor"/.test(sDup.error));
  check("(3b) ...and nothing is written", db.getAgent("agA4").name === "Lamplighter");
  const sSlug = await setup("agent_update", { agentId: "agA4", name: "Surveyor!" });
  check("(3b) setup agent_update: a duplicate SLUG is refused", typeof sSlug.error === "string" && /"surveyor"/.test(sSlug.error));
  check("(3b) ...and nothing is written", db.getAgent("agA4").name === "Lamplighter");
  const sOk = await setup("agent_update", { agentId: "agA4", name: "Ferryman" });
  check("(3b) positive control: a clean rename through the same tool lands",
    !sOk.error && db.getAgent("agA4").name === "Ferryman");

  db.close();
}

console.log(failures === 0 ? "\n✅ ALL PASS — agent rename name checks." : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
