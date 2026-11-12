import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// The setup home's seeded Workspace Auditor / Companion agents are pinned by an id-keyed
// app_meta marker, not found by name (card de790214). Before, a rename made the next boot seed a SECOND copy.
//
// Covers, per seeder (auditor, companion; the operator seeder was retired by card 7f6c1cbb):
//   (1) boot twice: seeds once, stamps the marker, the second boot adds nothing.
//   (2) rename then reboot: no duplicate, the renamed agent is still the pinned one.
//   (3) migration of a pre-marker install (name match, NO marker): 0 matches seeds + stamps; 1 match stamps
//       and seeds nothing; 2 same-name matches pin the FIRST and seed no third; a same-named agent in
//       ANOTHER project is ignored.
//   (4) a marker whose agent was deleted re-seeds and re-stamps; with a HUMAN agent of the same name in the
//       home the re-seed does NOT adopt it (no name lookup once a marker exists); a marker pointing into
//       another project is treated the same way.
//   (5) the operator's flag-off step: a pre-marker operator renamed while the flag is off is pinned and not
//       re-seeded when the flag flips on; flag off with no agent writes nothing.
//   (6) the pristine-prompt refresh follows the marker, so a renamed pristine agent still refreshes.
//   (7) gateway POST /api/companion/provision resolves the Companion by marker: a renamed Companion is
//       found, and a deleted one is NOT replaced by a human agent named "Companion".
//
//   (8) the name migration is one-shot per key: a same-named agent created AFTER the first post-card boot is
//       never adopted (operator with the flag off then on, and the companion/auditor shape), nor on later boots.
//
// Negative controls (negative-control --mutant): (A) resolveSeededHomeAgent matches by name instead of the
// marker -> (2) goes RED. (B) it falls back to a name match on a dangling marker -> (4) and (7) go RED.
// (C) migrateSeededHomeAgentMarker drops its sentinel check -> (8) goes RED.
//
// Run: 1) build (turbo builds shared first), 2) node test/setup-seeded-agent-id-pin.mjs
import path from "node:path";
import { useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";

const tmpHome = useOwnLoomHome("loom-seed-idpin-");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { seedDefaultProfiles } = await import("../dist/profiles/seed.js");
const seed = await import("../dist/setup/seed.js");
const { resolveSetupHome, migrateSeededHomeAgentMarker, seededMarkerMigratedKey, SETUP_HOME_WORKSPACE_AUDITOR_AGENT_ID_KEY, SETUP_HOME_COMPANION_AGENT_ID_KEY } =
  await import("../dist/projects/reserved-home-markers.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const SEEDERS = [
  { label: "auditor", fn: seed.seedSetupAuditorAgent, name: seed.SETUP_AUDITOR_AGENT_NAME, key: SETUP_HOME_WORKSPACE_AUDITOR_AGENT_ID_KEY },
  { label: "companion", fn: seed.seedCompanionAgent, name: seed.COMPANION_AGENT_NAME, key: SETUP_HOME_COMPANION_AGENT_ID_KEY },
];

let n = 0;
/** A fresh Db with profiles + the setup home seeded (so both remaining seeders run). */
function freshDb() {
  const db = new Db(path.join(tmpHome, `idpin-${++n}.db`));
  seedDefaultProfiles(db);
  seed.seedSetupHome(db);
  return { db, home: resolveSetupHome(db) };
}
const named = (db, home, name) => db.listAgents(home.id).filter((a) => a.name === name);
const insert = (db, projectId, id, name, position = 50) =>
  db.insertAgent({ id, projectId, name, startupPrompt: "", position, profileId: null, endpoint: false, ioSchema: null });

for (const s of SEEDERS) {
  // (1) boot twice
  {
    const { db, home } = freshDb();
    check(`(1 ${s.label}) first boot seeds it`, s.fn(db) === s.name && named(db, home, s.name).length === 1);
    const id = named(db, home, s.name)[0].id;
    check(`(1 ${s.label}) ...and stamps the marker with its id`, db.getMeta(s.key) === id);
    const count = db.listAgents(home.id).length;
    check(`(1 ${s.label}) second boot no-ops`, s.fn(db) === null && db.listAgents(home.id).length === count && named(db, home, s.name).length === 1);
    db.close();
  }
  // (2) rename then reboot
  {
    const { db, home } = freshDb();
    s.fn(db);
    const agent = named(db, home, s.name)[0];
    const before = db.listAgents(home.id).length;
    db.updateAgent(agent.id, { name: `Renamed ${s.label}` });
    check(`(2 ${s.label}) reboot after a rename seeds nothing`, s.fn(db) === null);
    check(`(2 ${s.label}) ...no agent under the bundled name, none added`, named(db, home, s.name).length === 0 && db.listAgents(home.id).length === before);
    check(`(2 ${s.label}) ...the marker still points at the renamed agent`, db.getMeta(s.key) === agent.id);
    db.close();
  }
  // (3) migration: pre-marker install, name match only
  {
    const { db, home } = freshDb();
    check(`(3 ${s.label}) fixture: no marker yet`, !db.getMeta(s.key));
    check(`(3 ${s.label}) zero matches: seeds one and stamps it`, s.fn(db) === s.name && db.getMeta(s.key) === named(db, home, s.name)[0].id);
    db.close();
  }
  {
    const { db, home } = freshDb();
    insert(db, home.id, `pre-${s.label}`, s.name);
    const before = db.listAgents(home.id).length;
    check(`(3 ${s.label}) one match: stamps it, seeds nothing`, s.fn(db) === null && db.getMeta(s.key) === `pre-${s.label}` && db.listAgents(home.id).length === before);
    db.updateAgent(`pre-${s.label}`, { name: "Moved on" });
    check(`(3 ${s.label}) ...and a later rename + reboot adds nothing`, s.fn(db) === null && db.listAgents(home.id).length === before);
    db.close();
  }
  {
    const { db, home } = freshDb();
    insert(db, home.id, `dupA-${s.label}`, s.name, 40);
    insert(db, home.id, `dupB-${s.label}`, s.name, 41);
    const firstId = named(db, home, s.name)[0].id;
    const before = db.listAgents(home.id).length;
    check(`(3 ${s.label}) two same-name matches: pins the first in listAgents order, seeds no third`,
      s.fn(db) === null && db.getMeta(s.key) === firstId && db.listAgents(home.id).length === before);
    db.close();
  }
  {
    const { db, home } = freshDb();
    const now = new Date().toISOString();
    db.insertProject({ id: "pOther", name: "Other", repoPath: "pOther", vaultPath: "pOther", config: {}, createdAt: now, archivedAt: null });
    insert(db, "pOther", `elsewhere-${s.label}`, s.name, 0);
    check(`(3 ${s.label}) a same-named agent in another project is ignored: a fresh one is seeded in the home`,
      s.fn(db) === s.name && named(db, home, s.name).length === 1 && db.getMeta(s.key) !== `elsewhere-${s.label}`);
    db.close();
  }
  // (4) dangling / wrong-project marker: re-seed, never adopt a human's same-named agent
  {
    const { db, home } = freshDb();
    s.fn(db);
    const gone = named(db, home, s.name)[0];
    db.deleteAgent(gone.id);
    check(`(4 ${s.label}) fixture: stamped marker now dangles`, db.getMeta(s.key) === gone.id && !db.getAgent(gone.id));
    check(`(4 ${s.label}) a deleted seeded agent is re-seeded`, s.fn(db) === s.name && named(db, home, s.name).length === 1);
    check(`(4 ${s.label}) ...and the marker re-stamped to the new agent`, db.getMeta(s.key) === named(db, home, s.name)[0].id && db.getMeta(s.key) !== gone.id);
    db.close();
  }
  {
    const { db, home } = freshDb();
    s.fn(db);
    const gone = named(db, home, s.name)[0];
    db.deleteAgent(gone.id);
    insert(db, home.id, `human-${s.label}`, s.name, 60); // a HUMAN agent that happens to carry the bundled name
    check(`(4 ${s.label}) deleted seeded agent + a human agent of the same name: reboot seeds a NEW one (under a free name)`, s.fn(db) === `${s.name} 2` && named(db, home, s.name).length === 1 && named(db, home, `${s.name} 2`).length === 1);
    check(`(4 ${s.label}) ...the marker is NOT the human's agent`, db.getMeta(s.key) !== `human-${s.label}` && !!db.getAgent(db.getMeta(s.key)));
    check(`(4 ${s.label}) ...and the human's agent is untouched`, db.getAgent(`human-${s.label}`)?.name === s.name);
    db.close();
  }
  {
    const { db, home } = freshDb();
    const now = new Date().toISOString();
    db.insertProject({ id: "pOther", name: "Other", repoPath: "pOther", vaultPath: "pOther", config: {}, createdAt: now, archivedAt: null });
    insert(db, "pOther", `foreign-${s.label}`, "Foreign", 0);
    db.setMeta(s.key, `foreign-${s.label}`); // marker pointing at an agent outside the home
    insert(db, home.id, `human-${s.label}`, s.name, 60);
    check(`(4 ${s.label}) a marker pointing into another project is invalid: re-seeds, does not adopt the same-named human agent`,
      s.fn(db) === `${s.name} 2` && db.getMeta(s.key) !== `foreign-${s.label}` && db.getMeta(s.key) !== `human-${s.label}`);
    db.close();
  }
}

// (8) the name migration is ONE-SHOT per key: an agent a human creates under a bundled name AFTER the first
// post-card boot is never adopted, however long the key stays unstamped.
for (const s of SEEDERS) {
  const { db, home } = freshDb();
  // The first post-card boot's migration found nothing under the name (sentinel set, marker unstamped)...
  migrateSeededHomeAgentMarker(db, home, s.key, s.name);
  check(`(8 ${s.label}) fixture: migration ran with no match, so no marker`, !db.getMeta(s.key) && !!db.getMeta(seededMarkerMigratedKey(s.key)));
  insert(db, home.id, `later-${s.label}`, s.name, 80); // ...and a human creates the name afterwards
  check(`(8 ${s.label}) migrated-with-no-match then a later same-named agent: a boot seeds a NEW one (under a free name) and never adopts it`,
    s.fn(db) === `${s.name} 2` && db.getMeta(s.key) !== `later-${s.label}` && named(db, home, s.name).length === 1 && named(db, home, `${s.name} 2`).length === 1);
  const marker = db.getMeta(s.key);
  check(`(8 ${s.label}) ...a second boot adopts nothing either`, s.fn(db) === null && db.getMeta(s.key) === marker);
  db.close();
}

// (6) pristine refresh follows the marker
{
  const { db, home } = freshDb();
  seed.seedCompanionAgent(db);
  const comp = named(db, home, seed.COMPANION_AGENT_NAME)[0];
  db.updateAgent(comp.id, { name: "Buddy", startupPrompt: seed.COMPANION_PROMPT_PRIOR_VALUES[0] });
  const refreshed = seed.refreshSetupHomePromptsPristine(db);
  check("(6) a renamed pristine agent (prior prompt) is still refreshed to the current text",
    refreshed.includes("Buddy") && db.getAgent(comp.id).startupPrompt === seed.COMPANION_PROMPT);
  insert(db, home.id, "human-comp", seed.COMPANION_AGENT_NAME, 70);
  db.updateAgent("human-comp", { startupPrompt: seed.COMPANION_PROMPT_PRIOR_VALUES[0] });
  seed.refreshSetupHomePromptsPristine(db);
  check("(6) a human agent that merely carries the bundled name is NOT refreshed", db.getAgent("human-comp").startupPrompt === seed.COMPANION_PROMPT_PRIOR_VALUES[0]);
  db.close();
}

// (7) gateway provision lookup
{
  const stub = {};
  const mk = async (db) => buildServer({
    db, pty: { enqueueStdin: () => ({ delivered: true }) }, sessions: stub, mcp: stub, orchMcp: stub,
    platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub,
  });
  const noRig = (res) => res.statusCode === 400 && /no default Companion rig/.test(res.json().error);

  const { db, home } = freshDb();
  seed.seedCompanionAgent(db);
  const comp = named(db, home, seed.COMPANION_AGENT_NAME)[0];
  db.updateAgent(comp.id, { name: "Buddy" });
  const app = await mk(db);
  const renamed = await app.inject({ method: "POST", url: "/api/companion/provision", payload: {} });
  check("(7) provision finds a RENAMED Companion by marker (does not answer 'no default Companion rig')", !noRig(renamed));

  db.deleteAgent(comp.id);
  insert(db, home.id, "human-comp", seed.COMPANION_AGENT_NAME, 70);
  const adopted = await app.inject({ method: "POST", url: "/api/companion/provision", payload: {} });
  check("(7) Companion deleted + a human agent named 'Companion': provision does NOT adopt it (400 'no default Companion rig')", noRig(adopted));
  await app.close();
  db.close();
}

console.log(failures === 0 ? "\n✅ ALL PASS — seeded setup-home agents are pinned by id." : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
