import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// applyWorkflowTemplate adds only the agents a project lacks, writes atomically, and the setup home's
// standing-agent re-seed never mints a name/slug twin.
//
//   (1) Skip: applying "Software team" onto a project that ran "Solo builder" adds ONLY the missing agents,
//       skips the shared ones (case-insensitive exact name) reporting `skipped` {name, existingAgentId,
//       promptDiffers, profileDiffers}, never overwrites the existing agent, never returns prompt text, and
//       dedupes starter cards by title (trim, case-insensitive, any column) into `skippedCards` — the upgrade
//       adds no second orient card, nor does a re-apply after deleting one agent. Added agents get
//       max(existing position)+1.. in template order.
//   (1b) Every agent already present: throws (naming them), writes NOTHING (no agents, no cards).
//   (1c) A slug-only twin of an existing agent is still refused (not a name match), nothing written; a
//        reserved built-in name in the setup home is still refused, never skipped. (5) A template that names an
//        agent twice is refused even when that name already exists in the project (hand-built template).
//   (2) Transaction: a card insert that throws part-way rolls back the agents inserted before it.
//   (3) Re-seed: the auditor / operator (flag-gated) / companion seeder, after the seeded agent is deleted
//       and a user created the bundled name (or, separately, its slug twin), re-seeds under a free numbered
//       name with the marker stamped to it; the user's agent is untouched. Also pins that the "Platform"
//       name's slug twin is refused while the Platform agent exists, and that nothing re-seeds a deleted Platform.
//       The seeders return the name actually inserted.
//
// Negative controls (negative-control --mutant): (A) the skip branch removed (an exact-name match falls
// through to resolveAgentName) -> (1) RED. (B) the write phase run outside runInTransaction -> (2) RED.
// (C) freeSeededAgentName returns the bundled name unconditionally -> (3) RED. (D) the card-title dedupe
// disabled -> (1) RED. (E) the within-template duplicate check moved after the skip -> (5) RED.
//
// Run: 1) build (turbo builds shared first), 2) node test/template-apply-skip-existing.mjs
import path from "node:path";
import { useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";

const tmpHome = useOwnLoomHome("loom-tpl-skip-");
requireHermeticEnv();
delete process.env.LOOM_DEV; // pin the default (non-dev) path

const { Db } = await import("../dist/db.js");
const { seedDefaultProfiles } = await import("../dist/profiles/seed.js");
const seed = await import("../dist/setup/seed.js");
const { resolveAgentName } = await import("../dist/agents/validate.js");
const { applyWorkflowTemplate, findWorkflowTemplate } = await import("../dist/setup/templates.js");
const { resolveSetupHome, SETUP_HOME_WORKSPACE_AUDITOR_AGENT_ID_KEY, SETUP_HOME_COMPANION_AGENT_ID_KEY } =
  await import("../dist/projects/reserved-home-markers.js");
const { slugifyAgentName } = await import("@loom/shared");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const db = new Db(path.join(tmpHome, "tpl-skip.db"));
seedDefaultProfiles(db);
const now = new Date().toISOString();
let pn = 0;
const newProject = () => {
  const id = `p${++pn}`;
  db.insertProject({ id, name: id, repoPath: id, vaultPath: id, config: {}, createdAt: now, archivedAt: null });
  return id;
};
const HUMAN = { humanAuthorized: true };
const solo = findWorkflowTemplate("Solo builder");
const team = findWorkflowTemplate("Software team (orchestrated)");
const names = (pid) => db.listAgents(pid).map((a) => a.name);

// ===================== (1) skip what exists, add the rest =====================
try {
  const pid = newProject();
  const first = applyWorkflowTemplate(db, solo, pid, HUMAN);
  check("(1) fixture: solo builder lands its agents with no skips", first.agents.length === solo.agents.length && first.skipped.length === 0);
  const dev = db.listAgents(pid).find((a) => a.name === "Dev");
  db.updateAgent(dev.id, { startupPrompt: "my own dev prompt" }); // customised: promptDiffers must be true
  const cardsBefore = db.listTasks(pid).length;
  const r = applyWorkflowTemplate(db, team, pid, HUMAN);
  const soloNames = solo.agents.map((a) => a.name);
  const missing = team.agents.filter((a) => !soloNames.includes(a.name)).map((a) => a.name);
  check("(1) only the agents the project lacks are added", JSON.stringify(r.agents.map((a) => a.name)) === JSON.stringify(missing) && missing.length > 0);
  check("(1) the shared agents are skipped and reported", JSON.stringify(r.skipped.map((s) => s.name).sort()) === JSON.stringify([...soloNames].sort()));
  check("(1) each skip names the existing agent's id", r.skipped.every((s) => db.getAgent(s.existingAgentId)?.name === s.name));
  check("(1) promptDiffers: true for the customised agent, false for the untouched ones",
    r.skipped.find((s) => s.name === "Dev")?.promptDiffers === true && r.skipped.filter((s) => s.name !== "Dev").every((s) => s.promptDiffers === false));
  check("(1) profileDiffers: false when the existing agents are bound to the template's own profiles", r.skipped.every((s) => s.profileDiffers === false));
  check("(1) no prompt text is returned (skipped entries carry exactly name/existingAgentId/promptDiffers/profileDiffers)",
    r.skipped.every((s) => JSON.stringify(Object.keys(s).sort()) === JSON.stringify(["existingAgentId", "name", "profileDiffers", "promptDiffers"])) && !JSON.stringify(r.skipped).includes("my own dev prompt"));
  check("(1) the existing agent is never overwritten", db.getAgent(dev.id)?.startupPrompt === "my own dev prompt");
  check("(1) the roster is the union, no duplicates", names(pid).length === new Set([...soloNames, ...missing]).size && names(pid).length === soloNames.length + missing.length);
  // Both templates share the same starter card: the upgrade must not seed it a second time.
  const sharedTitle = team.boardSeed.find((c) => solo.boardSeed.some((s) => s.title === c.title))?.title;
  check("(1) fixture: the two templates share a starter card", !!sharedTitle);
  check("(1) the upgrade adds NO duplicate starter card, and reports it as skipped",
    r.tasks.length === 0 && db.listTasks(pid).length === cardsBefore
    && r.skippedCards.length === 1 && r.skippedCards[0].title === sharedTitle && db.getTask(r.skippedCards[0].existingTaskId)?.title === sharedTitle);
  // Added agents continue the existing ordering: no tie with an existing position, template order preserved.
  const maxExisting = Math.max(...first.agents.map((a) => a.position));
  check("(1) added agents get max(existing)+1, +2, ... in template order",
    JSON.stringify(r.agents.map((a) => a.position)) === JSON.stringify(r.agents.map((_, i) => maxExisting + 1 + i)));
  check("(1) ...so no two agents share a position", new Set(db.listAgents(pid).map((a) => a.position)).size === db.listAgents(pid).length);

  // The user deleted one template agent and re-applies: that agent comes back, the card is not duplicated.
  const pidR = newProject();
  applyWorkflowTemplate(db, solo, pidR, HUMAN);
  const codeReviewer = db.listAgents(pidR).find((a) => a.name === "Code Reviewer");
  db.deleteAgent(codeReviewer.id);
  const cardsR = db.listTasks(pidR).length;
  const rr = applyWorkflowTemplate(db, solo, pidR, HUMAN);
  check("(1) re-apply after deleting one agent adds just that agent", rr.agents.length === 1 && rr.agents[0].name === "Code Reviewer" && rr.skipped.length === solo.agents.length - 1);
  check("(1) ...and does not duplicate the starter card", rr.tasks.length === 0 && db.listTasks(pidR).length === cardsR && rr.skippedCards.length === solo.boardSeed.length);
  // the title match is trimmed, case-insensitive and column-agnostic
  const pidT = newProject();
  db.insertTask({ id: "t-move", projectId: pidT, title: `  ${solo.boardSeed[0].title.toUpperCase()}  `, body: "", columnKey: "done", position: 0, priority: "p2", createdAt: now, updatedAt: now, version: 1 });
  const rt = applyWorkflowTemplate(db, solo, pidT, HUMAN);
  check("(1) a card with the same title in ANY column (trim + case-insensitive) is not seeded again",
    rt.tasks.length === 0 && rt.skippedCards.length === 1 && rt.skippedCards[0].existingTaskId === "t-move");

  // profileDiffers: an existing worker-profile "Orchestrator" against the template's manager profile
  const devProfile = db.listProfiles().find((p) => p.name === "Dev");
  const pidP = newProject();
  db.insertAgent({ id: "worker-orch", projectId: pidP, name: "Orchestrator", startupPrompt: "x", position: 0, profileId: devProfile.id, endpoint: false, ioSchema: null });
  const rp = applyWorkflowTemplate(db, solo, pidP, HUMAN);
  check("(1) profileDiffers: true for an existing worker-profile \"Orchestrator\", false for the matching ones",
    rp.skipped.length === 1 && rp.skipped[0].profileDiffers === true && rp.skipped[0].existingAgentId === "worker-orch"
    && db.getAgent("worker-orch")?.profileId === devProfile.id);

  // case-insensitive: an existing "orchestrator" (lower case) is the same agent
  const pid2 = newProject();
  db.insertAgent({ id: "lc-orch", projectId: pid2, name: "orchestrator", startupPrompt: "x", position: 0, profileId: null, endpoint: false, ioSchema: null });
  const r2 = applyWorkflowTemplate(db, solo, pid2, HUMAN);
  check("(1) the name match is case-insensitive", r2.skipped.length === 1 && r2.skipped[0].existingAgentId === "lc-orch" && r2.agents.length === solo.agents.length - 1);
} catch (e) {
  check(`(1) applying onto a project that already holds some of the template's agents must not throw: ${e.message}`, false);
}

// ===================== (1b) nothing to add: throws, writes nothing =====================
{
  const pid = newProject();
  applyWorkflowTemplate(db, solo, pid, HUMAN);
  const agentsBefore = db.listAgents(pid).length;
  const tasksBefore = db.listTasks(pid).length;
  let threw = null;
  try { applyWorkflowTemplate(db, solo, pid, HUMAN); } catch (e) { threw = e; }
  check("(1b) re-applying the same template throws, naming the agents that already exist",
    !!threw && /already exists/.test(threw.message) && solo.agents.every((a) => threw.message.includes(`"${a.name}"`)));
  check("(1b) ...and writes nothing (no agents, no starter cards)", db.listAgents(pid).length === agentsBefore && db.listTasks(pid).length === tasksBefore);
}

// ===================== (1c) slug-only twins and reserved names still refuse =====================
{
  const pid = newProject();
  db.insertAgent({ id: "qa-twin", projectId: pid, name: slugifyAgentName("QA Tester"), startupPrompt: "", position: 0, profileId: null, endpoint: false, ioSchema: null });
  let threw = null;
  try { applyWorkflowTemplate(db, team, pid, HUMAN); } catch (e) { threw = e; }
  check("(1c) a slug-only twin of a template agent still throws", !!threw && /too close/.test(threw.message) && /"QA Tester"/.test(threw.message));
  check("(1c) ...with nothing written", db.listAgents(pid).length === 1 && db.listTasks(pid).length === 0);

  // A template naming one agent twice is refused even when that name ALREADY exists in the project (the
  // within-template duplicate check runs over all specs before the skip). Hand-built: bundled templates can't.
  const pidD = newProject();
  applyWorkflowTemplate(db, solo, pidD, HUMAN); // the project already holds "Dev"
  const agentsD = db.listAgents(pidD).length;
  const spec = (name) => ({ name, profileName: "Dev", startupPrompt: "p", position: 0 });
  for (const [label, dupName] of [["name twin", "dev"], ["slug twin", "Dev!"]]) {
    let thrownD = null;
    try { applyWorkflowTemplate(db, { name: "x", description: "x", agents: [spec("Dev"), spec(dupName), spec("Extra Helper")], boardSeed: [] }, pidD, HUMAN); } catch (e) { thrownD = e; }
    check(`(5) a template naming "Dev" twice (${label}) throws even though "Dev" already exists in the project`,
      !!thrownD && /already named|too close/.test(thrownD.message) && thrownD.message.includes(`agent "${dupName}"`));
    check(`(5) ...with nothing written (${label})`, db.listAgents(pidD).length === agentsD);
  }

  seed.seedSetupHome(db);
  const home = resolveSetupHome(db);
  const reservedTpl = { name: "x", description: "x", agents: [{ name: "Platform", profileName: "Dev", startupPrompt: "p", position: 0 }], boardSeed: [] };
  const homeAgents = db.listAgents(home.id).length;
  threw = null;
  try { applyWorkflowTemplate(db, reservedTpl, home.id, HUMAN); } catch (e) { threw = e; }
  check("(1c) a reserved built-in name in the setup home is refused, never skipped", !!threw && /reserved for a built-in agent/.test(threw.message) && db.listAgents(home.id).length === homeAgents);

  // The "Platform" name's slug twin: refused while the Platform agent exists (sibling slug check)...
  const scope = seed.newAgentNameScope(db, home.id);
  check("(1c) fixture: the setup home holds the Platform agent", scope.siblings.some((s) => s.name === "Platform"));
  check("(1c) a slug twin of \"Platform\" is refused while the Platform agent exists",
    ["Platform!", "platform-", "PLATFORM"].every((n) => resolveAgentName(n, scope).ok === false));

  // ...and nothing re-seeds the Platform agent once it is deleted (so a slug twin of it can't collide with a re-seed).
  db.deleteAgent(db.listAgents(home.id).find((a) => a.name === "Platform").id);
  seed.seedSetupHome(db);
  seed.seedSetupAuditorAgent(db);
  seed.seedCompanionAgent(db);
  check("(1c) no seeder re-seeds a deleted Platform agent", !db.listAgents(home.id).some((a) => a.name === "Platform"));
}

// ===================== (2) the write phase is one transaction =====================
{
  const pid = newProject();
  let inserts = 0;
  const flaky = new Proxy(db, {
    get(target, prop) {
      if (prop === "insertTask") return (t) => { if (++inserts === 2) throw new Error("boom: second card insert"); return target.insertTask(t); };
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const twoCards = { ...solo, boardSeed: [{ title: "one", body: "b" }, { title: "two", body: "b" }] };
  let threw = null;
  try { applyWorkflowTemplate(flaky, twoCards, pid, HUMAN); } catch (e) { threw = e; }
  check("(2) the failing card insert propagates", !!threw && /boom/.test(threw.message) && inserts === 2);
  check("(2) ...and rolls back the agents AND the first card (nothing half-applied)", db.listAgents(pid).length === 0 && db.listTasks(pid).length === 0);
  const ok = applyWorkflowTemplate(db, twoCards, pid, HUMAN);
  check("(2) positive control: the same template applies cleanly on the real Db", ok.agents.length === solo.agents.length && ok.tasks.length === 2);
}

// ===================== (3) a re-seed never mints a name or slug twin =====================
const SEEDERS = [
  { label: "auditor", fn: seed.seedSetupAuditorAgent, name: seed.SETUP_AUDITOR_AGENT_NAME, key: SETUP_HOME_WORKSPACE_AUDITOR_AGENT_ID_KEY },
  { label: "companion", fn: seed.seedCompanionAgent, name: seed.COMPANION_AGENT_NAME, key: SETUP_HOME_COMPANION_AGENT_ID_KEY },
];
let sn = 0;
for (const s of SEEDERS) {
  for (const shape of ["same name", "slug twin"]) {
    const sdb = new Db(path.join(tmpHome, `seed-${++sn}.db`));
    seedDefaultProfiles(sdb);
    seed.seedSetupHome(sdb);
    const home = resolveSetupHome(sdb);
    s.fn(sdb);
    const gone = sdb.listAgents(home.id).find((a) => a.name === s.name);
    sdb.deleteAgent(gone.id);
    const userName = shape === "same name" ? s.name : slugifyAgentName(s.name);
    sdb.insertAgent({ id: `user-${sn}`, projectId: home.id, name: userName, startupPrompt: "mine", position: 70, profileId: null, endpoint: false, ioSchema: null });
    const returned = s.fn(sdb); // the next boot
    const marker = sdb.getMeta(s.key);
    const seeded = sdb.getAgent(marker);
    const all = sdb.listAgents(home.id);
    const slugs = all.map((a) => slugifyAgentName(a.name));
    check(`(3 ${s.label}, ${shape}) re-seed lands under a free numbered name`, seeded?.name === `${s.name} 2` && seeded.id !== gone.id);
    check(`(3 ${s.label}, ${shape}) ...and the seeder returns the name it actually inserted`, returned === `${s.name} 2`);
    check(`(3 ${s.label}, ${shape}) ...no two agents in the home share a slug`, new Set(slugs).size === slugs.length);
    check(`(3 ${s.label}, ${shape}) ...the user's agent is untouched`, sdb.getAgent(`user-${sn}`)?.name === userName && sdb.getAgent(`user-${sn}`)?.startupPrompt === "mine");
    check(`(3 ${s.label}, ${shape}) ...a further boot adds nothing`, s.fn(sdb) === null && sdb.listAgents(home.id).length === all.length && sdb.getMeta(s.key) === marker);
    sdb.close();
  }
  // control: no user agent in the way -> the bundled name is used unchanged
  const cdb = new Db(path.join(tmpHome, `seed-${++sn}.db`));
  seedDefaultProfiles(cdb);
  seed.seedSetupHome(cdb);
  const chome = resolveSetupHome(cdb);
  s.fn(cdb);
  const g = cdb.listAgents(chome.id).find((a) => a.name === s.name);
  cdb.deleteAgent(g.id);
  const cret = s.fn(cdb);
  check(`(3 ${s.label}) control: nothing in the way, so the bundled name is re-used (and returned)`, cdb.getAgent(cdb.getMeta(s.key))?.name === s.name && cret === s.name);
  cdb.close();
}

db.close();
finishAndExit(failures);
