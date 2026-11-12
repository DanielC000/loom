import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Agent CREATE / CLONE name checks (card 46d1faa5) — the create-side twin of agent-rename-name-checks.mjs.
// An agent name is an identity: worker_spawn resolves `agentId` by case-insensitive name then by slug, and
// the setup home's seeders find their agents by exact name. Every path that mints an agent with a
// caller-supplied name must clear the SAME rules the rename path does.
//
// Covers:
//   (0) resolveAgentName / uniqueAgentName (pure): trim, empty, dup name, dup slug, reserved name; the
//       auto-suffix walk finds a free name AND slug, the suffixed name passes resolveAgentName, and the walk
//       is bounded (refuses clearly past AGENT_NAME_SUFFIX_LIMIT).
//   (1) REST POST /api/projects/:id/agents: trimmed, empty/whitespace/dup-name/dup-slug are 400 with
//       NOTHING written; the same name in ANOTHER project is fine; in the setup home a reserved seeded name
//       ("companion", "Workspace Auditor") is refused.
//   (2) EXISTING data: a project that already holds two same-slug agents (from before this change) can still
//       re-save each one (REST rename to its own name, prompt-only patch) and create a third DISTINCT name;
//       only a NEW collision is refused.
//   (3) Platform Lead agent_create / agent_clone / agent_clone_batch (createAgentCore): dup refused, a clone
//       into the setup home as "Companion" / "Workspace Auditor" refused, clone_batch reports a per-item
//       refusal while the other targets still clone; each with a positive control on the same tool.
//   (4) Setup agent_create: dup name / slug refused with nothing written; positive control.
//   (5) applyWorkflowTemplate: applying a roster onto a project that already holds one of its names, and a
//       template naming one agent twice, both throw with NOTHING written (atomic); a clean apply lands.
//   (6) cloneAgentCore autoSuffixFrom (the companion-provision unnamed label): a colliding label walks to
//       a free name; an EXPLICIT colliding nameOverride is refused.
//   (7) Seeders keep their idempotent path: seeding the setup home / Companion / Auditor / Operator twice
//       mints no duplicates (boot-twice).
//
// Negative control: a --mutant that deletes the resolveAgentName call in createAgentCore turns (3)/(6) RED.
//
// Run: 1) build (turbo builds shared first), 2) node test/agent-create-name-checks.mjs
import path from "node:path";
import { useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";

const tmpHome = useOwnLoomHome("loom-agent-create-");
requireHermeticEnv();
delete process.env.LOOM_DEV; // the setup home + Companion seed are CORE; pin the default path

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { resolveAgentName, uniqueAgentName, AGENT_NAME_SUFFIX_LIMIT, resolveAgentRename } = await import("../dist/agents/validate.js");
const { cloneAgentCore } = await import("../dist/agents/clone-core.js");
const { seedDefaultProfiles } = await import("../dist/profiles/seed.js");
const { seedSetupHome, seedCompanionAgent, seedSetupAuditorAgent, COMPANION_AGENT_NAME, newAgentNameScope } = await import("../dist/setup/seed.js");
const { resolveSetupHome } = await import("../dist/projects/reserved-home-markers.js");
const { applyWorkflowTemplate, WORKFLOW_TEMPLATES } = await import("../dist/setup/templates.js");
const { slugifyAgentName } = await import("@loom/shared");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// ===================== (0) resolveAgentName / uniqueAgentName (pure) =====================
{
  const scope = { siblings: [{ id: "a1", name: "QA Tester" }, { id: "a2", name: "Web Designer" }], reservedNames: ["Platform"] };
  const ok =resolveAgentName("  Reviewer  ", scope);
  check("(0) a fresh name passes, trimmed", ok.ok === true && ok.name === "Reviewer");
  check("(0) empty refused", resolveAgentName("", scope).ok === false);
  const ws = resolveAgentName("  \t ", scope);
  check("(0) whitespace-only refused", ws.ok === false && /must not be empty/.test(ws.error));
  const dupName = resolveAgentName("qa tester", scope);
  check("(0) a case-insensitive duplicate NAME is refused, naming the other agent", dupName.ok === false && /already named "QA Tester"/.test(dupName.error));
  const dupSlug = resolveAgentName("web-designer!", scope);
  check("(0) a duplicate SLUG is refused", dupSlug.ok === false && /"Web Designer"/.test(dupSlug.error) && /"web-designer"/.test(dupSlug.error));
  const rsv = resolveAgentName("platform", scope);
  check("(0) a reserved seeded name is refused, case-insensitively", rsv.ok === false && /reserved for a built-in agent/.test(rsv.error));
  // No self-exclusion: the create twin has no "own name" to re-save, so an identical name is a collision.
  check("(0) no self-exclusion: the exact name of an existing agent is refused", resolveAgentName("QA Tester", scope).ok === false);
  // Same rules as the rename twin for a third party (the shared tail): both refuse the same names.
  const renameSame = resolveAgentRename("qa-tester", { agentId: "zz", currentName: "Other", siblings: scope.siblings, reservedNames: scope.reservedNames });
  check("(0) the rename twin refuses the same slug twin (shared tail)", renameSame.ok === false && resolveAgentName("qa-tester", scope).ok === false);

  const u = uniqueAgentName("QA Tester", scope, 2);
  check("(0) uniqueAgentName walks to `QA Tester 2`", u.ok === true && u.name === "QA Tester 2");
  check("(0) ...and that suffixed name passes the same checks", resolveAgentName(u.name, scope).ok === true);
  // A suffixed name can itself collide by SLUG with an existing agent: "QA Tester 2" vs an existing "qa-tester-2".
  const tricky = { siblings: [{ id: "a1", name: "QA Tester" }, { id: "a3", name: "qa-tester-2" }], reservedNames: [] };
  const u2 = uniqueAgentName("QA Tester", tricky, 2);
  check("(0) the walk skips a candidate that collides by SLUG (qa-tester-2) and lands on 3", u2.ok === true && u2.name === "QA Tester 3");
  const crowded = { siblings: Array.from({ length: AGENT_NAME_SUFFIX_LIMIT + 2 }, (_, i) => ({ id: `c${i}`, name: i === 0 ? "Pal" : `Pal ${i + 1}` })), reservedNames: [] };
  const full = uniqueAgentName("Pal", crowded, 2);
  check("(0) the walk is BOUNDED: with every candidate taken it refuses clearly", full.ok === false && /no free name/.test(full.error));
  const justFits = uniqueAgentName("Pal", { siblings: crowded.siblings.filter((s) => s.name !== `Pal ${AGENT_NAME_SUFFIX_LIMIT + 1}`), reservedNames: [] }, 2);
  check("(0) ...but a free slot at the last allowed attempt is still found (the bound is not off by one)", justFits.ok === true && justFits.name === `Pal ${AGENT_NAME_SUFFIX_LIMIT + 1}`);
  check("(0) slugifyAgentName comes from @loom/shared", slugifyAgentName("QA  Tester!") === "qa-tester");
}

const db = new Db(path.join(tmpHome, "create.db"));
const now = new Date().toISOString();
db.insertProject({ id: "pA", name: "A", repoPath: "pA", vaultPath: "pA", config: {}, createdAt: now, archivedAt: null });
db.insertProject({ id: "pB", name: "B", repoPath: "pB", vaultPath: "pB", config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agA1", projectId: "pA", name: "QA Tester", startupPrompt: "src prompt", position: 0, profileId: null });
db.insertAgent({ id: "agA2", projectId: "pA", name: "Builder", startupPrompt: "", position: 1, profileId: null });
seedDefaultProfiles(db);
seedSetupHome(db);
seedCompanionAgent(db);
const setupHome = resolveSetupHome(db);
const countIn = (projectId) => db.listAgents(projectId).length;

// ===================== (1) REST POST /api/projects/:id/agents =====================
{
  const stub = {};
  const app = await buildServer({
    db, pty: { enqueueStdin: () => ({ delivered: true }) }, sessions: stub, mcp: stub, orchMcp: stub,
    platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub,
  });
  const create = (projectId, name) => app.inject({ method: "POST", url: `/api/projects/${projectId}/agents`, payload: { name, startupPrompt: "p" } });

  const before = countIn("pA");
  const good = await create("pA", "  Architect  ");
  check("(1) a create succeeds (201) with the TRIMMED name", good.statusCode === 201 && good.json().name === "Architect");
  check("(1) it reads back trimmed from the DB", db.getAgent(good.json().id).name === "Architect");
  for (const [label, name, re] of [
    ["whitespace-only", "   ", /name required|must not be empty/],
    ["dup name (case-insensitive)", "qa TESTER", /already named "QA Tester"/],
    ["dup slug", "qa-tester", /"QA Tester"/],
    ["dup of the one just created", "architect", /already named "Architect"/],
  ]) {
    const res = await create("pA", name);
    check(`(1) ${label}: refused 400 with the reason`, res.statusCode === 400 && re.test(res.json().error));
  }
  check("(1) ...and none of the refused creates wrote a row", countIn("pA") === before + 1);
  const cross = await create("pB", "QA Tester");
  check("(1) the same name in ANOTHER project is allowed", cross.statusCode === 201);

  const homeBefore = countIn(setupHome.id);
  for (const name of ["platform", "PLATFORM"]) {
    const res = await create(setupHome.id, name);
    check(`(1) setup home: "${name}" is refused 400 as reserved`, res.statusCode === 400 && /reserved for a built-in agent/.test(res.json().error));
  }
  check("(1) ...nothing written into the setup home", countIn(setupHome.id) === homeBefore);
  check("(1) ...so exactly one Companion still exists",
    db.listAllAgents().filter((a) => a.name.toLowerCase() === COMPANION_AGENT_NAME.toLowerCase()).length === 1);
  const homeOk = await create(setupHome.id, "Notetaker");
  check("(1) positive control: an ordinary name in the setup home still works", homeOk.statusCode === 201);

  // ===================== (2) existing same-slug data is never bricked =====================
  db.insertProject({ id: "pLegacy", name: "Legacy", repoPath: "pLegacy", vaultPath: "pLegacy", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "lg1", projectId: "pLegacy", name: "QA Tester", startupPrompt: "", position: 0, profileId: null });
  db.insertAgent({ id: "lg2", projectId: "pLegacy", name: "qa-tester", startupPrompt: "", position: 1, profileId: null });
  const post = (id, payload) => app.inject({ method: "POST", url: `/api/agents/${id}`, payload });
  for (const id of ["lg1", "lg2"]) {
    const name = db.getAgent(id).name;
    const resave = await post(id, { name });
    check(`(2) legacy ${id}: re-saving its own name passes`, resave.statusCode === 200 && db.getAgent(id).name === name);
    const prompt = await post(id, { startupPrompt: `edited ${id}` });
    check(`(2) legacy ${id}: a prompt-only update passes`, prompt.statusCode === 200 && db.getAgent(id).startupPrompt === `edited ${id}`);
  }
  const third = await create("pLegacy", "Reviewer");
  check("(2) legacy project: creating a third DISTINCT name passes", third.statusCode === 201);
  const fourth = await create("pLegacy", "QA-Tester!");
  check("(2) ...but a NEW collision with the legacy pair is still refused", fourth.statusCode === 400);
  check("(2) ...the legacy pair is untouched", db.getAgent("lg1").name === "QA Tester" && db.getAgent("lg2").name === "qa-tester");
  await app.close();
}

// Seam session service + MCP plumbing for (3)/(4)
class SeamHost extends createSeamHost(PtyHost) { stop() {} }
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); }, onBusy(id, b) { db.setBusy(id, b); },
  onContextStats() {}, onRateLimited() {}, onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const svc = new SessionService(db, new SeamHost(events), new OrchestrationControl());
const connect = async (router, sessionId) => {
  const server = router.buildServer(sessionId);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "agent-create-name-checks", version: "0" });
  await client.connect(clientT);
  return async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
};

// ===================== (3) Platform Lead agent_create / agent_clone / agent_clone_batch =====================
{
  const lead = await connect(new PlatformMcpRouter(db, svc));
  const bBefore = countIn("pB");
  const dup = await lead("agent_create", { projectId: "pB", name: "QA TESTER" });
  check("(3) agent_create: a dup name in pB is refused", typeof dup.error === "string" && /already named "QA Tester"/.test(dup.error));
  const slug = await lead("agent_create", { projectId: "pB", name: "qa-tester" });
  check("(3) agent_create: a dup slug is refused", typeof slug.error === "string" && /"qa-tester"/.test(slug.error));
  const empty = await lead("agent_create", { projectId: "pB", name: "  " });
  check("(3) agent_create: a whitespace name is refused", typeof empty.error === "string" && /must not be empty/.test(empty.error));
  check("(3) ...nothing written", countIn("pB") === bBefore);
  const okc = await lead("agent_create", { projectId: "pB", name: "  Fresh  " });
  check("(3) positive control: a clean agent_create lands, trimmed", !okc.error && okc.name === "Fresh");

  const hBefore = countIn(setupHome.id);
  const rsv = await lead("agent_create", { projectId: setupHome.id, name: "Platform" });
  check("(3) agent_create into the setup home as `Platform` is refused", typeof rsv.error === "string" && /reserved/.test(rsv.error));
  const cloneRsv = await lead("agent_clone", { sourceAgentId: "agA1", targetProjectId: setupHome.id, nameOverride: "Platform" });
  check("(3) agent_clone into the setup home as `Platform` is refused", typeof cloneRsv.error === "string" && /reserved/.test(cloneRsv.error));
  const cloneRsv2 = await lead("agent_clone", { sourceAgentId: "agA1", targetProjectId: setupHome.id, nameOverride: "platform" });
  check("(3) ...and `platform` in any case", typeof cloneRsv2.error === "string" && /reserved/.test(cloneRsv2.error));
  check("(3) ...nothing minted into the setup home", countIn(setupHome.id) === hBefore);
  check("(3) ...so exactly one Companion exists",
    db.listAllAgents().filter((a) => a.name.toLowerCase() === COMPANION_AGENT_NAME.toLowerCase()).length === 1);

  const cloneDup = await lead("agent_clone", { sourceAgentId: "agA1", targetProjectId: "pA" });
  check("(3) agent_clone with no nameOverride into the SAME project (source name taken) is refused", typeof cloneDup.error === "string" && /already named "QA Tester"/.test(cloneDup.error));
  const cloneOk = await lead("agent_clone", { sourceAgentId: "agA1", targetProjectId: "pA", nameOverride: "QA Tester Two" });
  check("(3) positive control: agent_clone with a free nameOverride lands", !cloneOk.error && cloneOk.name === "QA Tester Two");

  // clone_batch: one refused item, two good — the refusal is per-item and the rest still clone.
  db.insertProject({ id: "pC", name: "C", repoPath: "pC", vaultPath: "pC", config: {}, createdAt: now, archivedAt: null });
  db.insertProject({ id: "pD", name: "D", repoPath: "pD", vaultPath: "pD", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "agD1", projectId: "pD", name: "Taken", startupPrompt: "", position: 0, profileId: null });
  const batch = await lead("agent_clone_batch", { sourceAgentId: "agA1", targets: [
    { targetProjectId: "pC", nameOverride: "Batch One" },
    { targetProjectId: "pD", nameOverride: "taken" },
    { targetProjectId: setupHome.id, nameOverride: "Platform" },
    { targetProjectId: "pD", nameOverride: "Batch Two" },
  ] });
  check("(3) clone_batch: one result per target, in order", Array.isArray(batch) && batch.length === 4);
  check("(3) clone_batch: item 0 cloned", !!batch[0]?.agent && batch[0].agent.name === "Batch One");
  check("(3) clone_batch: item 1 (dup name) reports ITS OWN error", typeof batch[1]?.error === "string" && /already named "Taken"/.test(batch[1].error) && batch[1].targetProjectId === "pD");
  check("(3) clone_batch: item 2 (reserved name in the setup home) reports its own error", typeof batch[2]?.error === "string" && /reserved/.test(batch[2].error));
  check("(3) clone_batch: item 3 still cloned after the refusals", !!batch[3]?.agent && batch[3].agent.name === "Batch Two");
  check("(3) clone_batch: only the two good rows landed", db.listAgents("pC").length === 1 && db.listAgents("pD").length === 2);
}

// ===================== (4) Setup agent_create =====================
{
  db.insertProject({ id: "pS", name: "S", repoPath: "pS", vaultPath: "pS", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "agS1", projectId: "pS", name: "Cartographer", startupPrompt: "", position: 0, profileId: null });
  const comp = db.listAllAgents().find((a) => a.name === COMPANION_AGENT_NAME);
  db.insertSession({
    id: "setupS", projectId: setupHome.id, agentId: comp.id, engineSessionId: null, title: null, cwd: tmpHome, processState: "live",
    resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "setup", parentSessionId: null,
  });
  const router = new SetupMcpRouter(db, svc);
  check("(4) fixture: the setup session has the loom-setup surface", !!router.resolveRole("setupS"));
  const setup = await connect(router, "setupS");
  const before = countIn("pS");
  const dup = await setup("agent_create", { projectId: "pS", name: "cartographer" });
  check("(4) setup agent_create: a dup name is refused", typeof dup.error === "string" && /already named "Cartographer"/.test(dup.error));
  const slug = await setup("agent_create", { projectId: "pS", name: "Cartographer!" });
  check("(4) setup agent_create: a dup slug is refused", typeof slug.error === "string" && /"cartographer"/.test(slug.error));
  check("(4) ...nothing written", countIn("pS") === before);
  const okc = await setup("agent_create", { projectId: "pS", name: "  Ferryman  " });
  check("(4) positive control: a clean setup agent_create lands, trimmed", !okc.error && okc.name === "Ferryman");
}

// ===================== (5) applyWorkflowTemplate is atomic and name-checked =====================
{
  const tpl = WORKFLOW_TEMPLATES[0];
  const first = tpl.agents[0];
  db.insertProject({ id: "pT1", name: "T1", repoPath: "pT1", vaultPath: "pT1", config: {}, createdAt: now, archivedAt: null });
  db.insertProject({ id: "pT2", name: "T2", repoPath: "pT2", vaultPath: "pT2", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "tExisting", projectId: "pT1", name: first.name.toUpperCase(), startupPrompt: "", position: 0, profileId: null });
  let threw = null;
  // A slug-only twin of an existing agent is still refused (not a name match, so never a skip), nothing written.
  db.insertAgent({ id: "tTwin", projectId: "pT1", name: slugifyAgentName(tpl.agents[3].name), startupPrompt: "", position: 1, profileId: null });
  try { applyWorkflowTemplate(db, tpl, "pT1", { humanAuthorized: true }); } catch (e) { threw = e; }
  check("(5) a slug-only twin of an existing agent still throws, naming the agent",
    !!threw && new RegExp(`agent "${tpl.agents[3].name}"`).test(String(threw.message)));
  check("(5) ...and NOTHING was written (atomic)", countIn("pT1") === 2);
  const twice = { ...tpl, agents: [tpl.agents[0], { ...tpl.agents[0], name: slugifyAgentName(tpl.agents[0].name) }] };
  threw = null;
  try { applyWorkflowTemplate(db, twice, "pT2", { humanAuthorized: true }); } catch (e) { threw = e; }
  check("(5) a template naming one agent twice (name/slug twin) throws", !!threw && /too close|already named/.test(String(threw.message)));
  check("(5) ...with nothing written", countIn("pT2") === 0);
  const applied = applyWorkflowTemplate(db, tpl, "pT2", { humanAuthorized: true });
  check("(5) positive control: a clean apply lands every agent", applied.agents.length === tpl.agents.length && countIn("pT2") === tpl.agents.length);
}

// ===================== (6) cloneAgentCore autoSuffixFrom (companion-provision unnamed label) =====================
{
  db.insertProject({ id: "pP", name: "P", repoPath: "pP", vaultPath: "pP", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "pp1", projectId: "pP", name: "Pal 2", startupPrompt: "", position: 0, profileId: null });
  db.insertAgent({ id: "pp2", projectId: "pP", name: "pal-3", startupPrompt: "", position: 1, profileId: null });
  db.insertAgent({ id: "src", projectId: "pB", name: "Pal", startupPrompt: "s", position: 9, profileId: null });
  const r = cloneAgentCore(db, "src", "pP", { nameOverride: "Pal" }, { humanAuthorized: true, autoSuffixFrom: 2 });
  check("(6) an unnamed clone walks past `Pal 2` (name) and `pal-3` (slug) to `Pal 4`", r.ok === true && r.agent.name === "Pal 4");
  check("(6) ...and the suffixed name passes the same checks against the project it was minted into",
    resolveAgentName("Pal 4", { siblings: db.listAgents("pP").filter((a) => a.name !== "Pal 4").map((a) => ({ id: a.id, name: a.name })), reservedNames: [] }).ok === true);
  const explicit = cloneAgentCore(db, "src", "pP", { nameOverride: "Pal 2" }, { humanAuthorized: true });
  check("(6) an EXPLICIT colliding nameOverride is refused, not suffixed", explicit.ok === false && /already named "Pal 2"/.test(explicit.error));
  const scope = newAgentNameScope(db, "pP");
  check("(6) newAgentNameScope lists the project's agents and no reserved names outside the setup home", scope.siblings.length === 3 && scope.reservedNames.length === 0);
  check("(6) ...and the reserved names inside the setup home", newAgentNameScope(db, setupHome.id).reservedNames.includes("Platform") && !newAgentNameScope(db, setupHome.id).reservedNames.includes(COMPANION_AGENT_NAME));
}

// ===================== (7) seeders keep their idempotent path (boot twice) =====================
{
  const snapshot = () => db.listAgents(setupHome.id).map((a) => a.name).sort().join("|");
  seedSetupAuditorAgent(db);
  const once = snapshot();
  seedSetupHome(db);
  seedCompanionAgent(db);
  seedSetupAuditorAgent(db);
  const twice = snapshot();
  check("(7) re-running every setup-home seeder mints no duplicate agent", once === twice);
  check("(7) ...and each reserved name is held by at most one agent",
    new Set(db.listAgents(setupHome.id).map((a) => a.name.toLowerCase())).size === db.listAgents(setupHome.id).length);
}

db.close();
console.log(failures === 0 ? "\n✅ ALL PASS — agent create/clone name checks." : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
