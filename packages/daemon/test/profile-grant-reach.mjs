import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Profile grant BLAST RADIUS (card 3c4e0df6, from the a06650d2 security review).
//
// Profiles are GLOBAL (no projectId). Card a06650d2 stops an AGENT from BINDING a profile that already
// carries connections/capabilities/vaultWrite; it structurally cannot cover the other direction — a grant
// a HUMAN adds to a profile LATER reaches every agent already bound to it, in every project. This covers
// the signal that was missing: a `profile_grant_reach` audit event + a `grantReach` field on the save
// response, on all three human write paths.
//
// Covers:
//   (A) addedProfileGrants, per key: false->true booleans, a GROWN list (the case a non-empty check
//       cannot see), a capability RE-BOUND to a different connection, harness onto a non-default binary.
//   (B) the non-grants, so the detector is not simply always-true: a REMOVED grant, a re-save of the
//       same grants, a reorder, and a move BACK to claude all return [].
//   (C) PUT /api/profiles/:id that adds a grant -> `grantReach` on the response naming every bound agent
//       across BOTH projects, and exactly one durable event carrying the same list.
//   (D) NEGATIVE CONTROL: a description-only PUT on a profile that ALREADY carries grants files NO event
//       and returns NO `grantReach`. (Positive control for the same instrument is (C) — the two run
//       against the same db, so a green (D) cannot be a broken-detector artifact.)
//   (E) zero reach still files the event (agentCount:0), so an ABSENT row means "no grant was added",
//       never "added but reached nobody".
//   (F) binding is agent.profileId ONLY — an agent bound to a DIFFERENT profile is never counted.
//   (G) the agents array is CAPPED while agentCount stays exact (a reader must never derive "how many"
//       from agents.length).
//   (H) POST /api/profiles/:id/reset re-adding a shipped grant files the event with source "reset".
//
// Run: 1) build (turbo builds shared first), 2) node test/profile-grant-reach.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-grant-reach-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { addedProfileGrants, agentsBoundToProfile, GRANT_REACH_AGENTS_CAP } = await import("@loom/shared");

const BARE = { connections: [], capabilities: [], allowDelta: [] };
const added = (before, after) => addedProfileGrants({ ...BARE, ...before }, { ...BARE, ...after });

// ===================== (A) what counts as a newly-added grant =====================
check("(A) vaultWrite false->true is a grant", added({}, { vaultWrite: true }).join() === "vaultWrite");
check("(A) browserTesting false->true is a grant", added({}, { browserTesting: true }).join() === "browserTesting");
check("(A) documentConversion false->true is a grant", added({}, { documentConversion: true }).join() === "documentConversion");
check("(A) a first connection is a grant", added({}, { connections: ["c1"] }).join() === "connections");
// The case a non-empty ("is it carried at all") check structurally cannot see — and the whole reason
// this detector is value-level rather than reusing validate.ts's AGENT_FORBIDDEN_PROFILE_KEY_CARRIED.
check("(A) a SECOND connection on a profile that already had one is a grant",
  added({ connections: ["c1"] }, { connections: ["c1", "c2"] }).join() === "connections");
check("(A) a first capability is a grant", added({}, { capabilities: [{ slug: "s" }] }).join() === "capabilities");
check("(A) a capability RE-BOUND to a different connection is a grant",
  added({ capabilities: [{ slug: "s", connectionId: "c1" }] },
        { capabilities: [{ slug: "s", connectionId: "c2" }] }).join() === "capabilities");
check("(A) a new allowDelta entry is a grant",
  added({ allowDelta: ["Bash(ls)"] }, { allowDelta: ["Bash(ls)", "Bash(rm)"] }).join() === "allowDelta");
check("(A) harness unset -> codex is a grant", added({}, { harness: "codex" }).join() === "harness");
check("(A) harness claude -> codex is a grant", added({ harness: "claude" }, { harness: "codex" }).join() === "harness");
check("(A) several at once are all reported, in key order",
  added({}, { vaultWrite: true, connections: ["c1"], browserTesting: true }).join() === "connections,vaultWrite,browserTesting");

// ===================== (B) the non-grants (the detector is not always-true) =====================
check("(B) an unchanged profile grants nothing",
  added({ connections: ["c1"], vaultWrite: true }, { connections: ["c1"], vaultWrite: true }).length === 0);
check("(B) REMOVING a connection is not a grant", added({ connections: ["c1"] }, { connections: [] }).length === 0);
check("(B) turning vaultWrite OFF is not a grant", added({ vaultWrite: true }, { vaultWrite: false }).length === 0);
check("(B) reordering connections is not a grant",
  added({ connections: ["c1", "c2"] }, { connections: ["c2", "c1"] }).length === 0);
check("(B) harness codex -> claude is not a grant", added({ harness: "codex" }, { harness: "claude" }).length === 0);
check("(B) an unrelated save on a rig already pinned to codex is not a grant",
  added({ harness: "codex", connections: ["c1"] }, { harness: "codex", connections: ["c1"] }).length === 0);

// ===================== (F) binding is agent.profileId, nothing else =====================
{
  const agents = [
    { id: "a1", name: "Dev", projectId: "p1", projectName: "Alpha", profileId: "prof-x" },
    { id: "a2", name: "QA", projectId: "p2", projectName: "Beta", profileId: "prof-y" },
    { id: "a3", name: "Plain", projectId: "p1", projectName: "Alpha", profileId: null },
  ];
  const bound = agentsBoundToProfile(agents, "prof-x");
  check("(F) only the agent bound to THIS profile is counted", bound.length === 1 && bound[0].id === "a1");
  check("(F) the bound row carries its project name", bound[0].projectName === "Alpha");
  check("(F) a profile nobody is bound to returns empty", agentsBoundToProfile(agents, "prof-z").length === 0);
}

// ===================== REST fixtures =====================
function mkDb(name) {
  const dbFile = path.join(tmpHome, `${name}.db`);
  const db = new Db(dbFile);
  const now = new Date().toISOString();
  return { dbFile, db, now, projects: new Set() };
}
function cleanup(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}
function mkApp(e) {
  const stub = {};
  return buildServer({
    db: e.db, pty: { enqueueStdin: () => ({ delivered: true }) }, sessions: stub, mcp: stub, orchMcp: stub,
    platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub,
  });
}
const mkProfile = (e, id, over = {}) => {
  e.db.insertProfile({
    id, name: `Rig ${id}`, role: "worker", description: "", allowDelta: [], skills: null, model: null,
    icon: null, connections: [], capabilities: [], ...over,
  });
  return id;
};
const mkAgent = (e, id, projectId, projectName, profileId) => {
  if (!e.projects.has(projectId)) {
    e.db.insertProject({ id: projectId, name: projectName, repoPath: projectId, vaultPath: projectId, config: {}, createdAt: e.now, archivedAt: null });
    e.projects.add(projectId);
  }
  e.db.insertAgent({ id, projectId, name: id, startupPrompt: "", position: 0, profileId });
};
const putProfile = (app, id, patch) =>
  app.inject({ method: "PUT", url: `/api/profiles/${id}`, payload: patch });
const reachEvents = (e) => e.db.listEvents("").filter((x) => x.kind === "profile_grant_reach");

// ===================== (C) a grant-adding PUT: response + event =====================
{
  const e = mkDb("grant");
  const app = await mkApp(e);
  const prof = mkProfile(e, "prof-shared");
  mkAgent(e, "agent-alpha", "proj-a", "Alpha", prof);
  mkAgent(e, "agent-beta", "proj-b", "Beta", prof);
  mkAgent(e, "agent-other", "proj-a", "Alpha", mkProfile(e, "prof-unrelated"));

  const res = await putProfile(app, prof, { vaultWrite: true });
  check("(C) PUT -> 200", res.statusCode === 200);
  const body = JSON.parse(res.payload);
  check("(C) the response carries grantReach", !!body.grantReach);
  check("(C) grantReach names the added key", body.grantReach?.addedKeys?.join() === "vaultWrite");
  check("(C) grantReach counts BOTH bound agents, across both projects", body.grantReach?.agentCount === 2);
  const names = (body.grantReach?.agents ?? []).map((a) => `${a.projectName}/${a.name}`).sort().join(",");
  check("(C) grantReach names each Project / Agent", names === "Alpha/agent-alpha,Beta/agent-beta");
  check("(C) the agent bound to a DIFFERENT profile is absent",
    !(body.grantReach?.agents ?? []).some((a) => a.id === "agent-other"));

  const evs = reachEvents(e);
  check("(C) exactly one durable event filed", evs.length === 1);
  check("(C) the event names the profile", evs[0]?.detail?.profileId === prof);
  check("(C) the event records the write path", evs[0]?.detail?.source === "rest");
  check("(C) the event agrees with the response about reach", evs[0]?.detail?.agentCount === 2);
  check("(C) the event has no owning session (a Profile is global)", evs[0]?.managerSessionId === "");

  // ===== (D) NEGATIVE CONTROL, same db, same instrument that just fired in (C) =====
  const before = reachEvents(e).length;
  const plain = await putProfile(app, prof, { description: "just a blurb" });
  check("(D) a grant-free PUT -> 200", plain.statusCode === 200);
  check("(D) ...returns NO grantReach", JSON.parse(plain.payload).grantReach === undefined);
  check("(D) ...and files NO new event", reachEvents(e).length === before);
  // and the pre-existing grant is still there, so this is a real "already carried" case, not an empty one
  check("(D) the profile still carries the grant that was NOT re-reported", e.db.getProfile(prof).vaultWrite === true);

  // ===== PUT echo: the computed key must not trip validateProfile's .strict() =====
  const echo = await putProfile(app, prof, JSON.parse(res.payload));
  check("(C) echoing the PUT response back as a patch is accepted (grantReach is stripped)", echo.statusCode === 200);

  cleanup(e);
}

// ===================== (E) zero reach still files the event =====================
{
  const e = mkDb("zero");
  const app = await mkApp(e);
  const prof = mkProfile(e, "prof-unbound");
  const res = await putProfile(app, prof, { browserTesting: true });
  check("(E) PUT -> 200", res.statusCode === 200);
  const body = JSON.parse(res.payload);
  check("(E) grantReach is present even with nobody bound", !!body.grantReach);
  check("(E) ...reporting agentCount 0", body.grantReach?.agentCount === 0);
  check("(E) ...with an empty agent list", (body.grantReach?.agents ?? []).length === 0);
  check("(E) the event is filed anyway", reachEvents(e).length === 1);
  cleanup(e);
}

// ===================== (G) the agents list is capped; agentCount stays exact =====================
{
  const e = mkDb("cap");
  const app = await mkApp(e);
  const prof = mkProfile(e, "prof-wide");
  const total = GRANT_REACH_AGENTS_CAP + 7;
  for (let i = 0; i < total; i++) mkAgent(e, `wide-${i}`, "proj-w", "Wide", prof);

  const body = JSON.parse((await putProfile(app, prof, { vaultWrite: true })).payload);
  check("(G) agentCount is the TRUE total", body.grantReach?.agentCount === total);
  check("(G) the listed agents are capped", body.grantReach?.agents?.length === GRANT_REACH_AGENTS_CAP);
  check("(G) truncation is declared", body.grantReach?.truncated === true);
  const ev = reachEvents(e)[0];
  check("(G) the event is capped the same way, with the true count intact",
    ev?.detail?.agentCount === total && ev?.detail?.agents?.length === GRANT_REACH_AGENTS_CAP && ev?.detail?.truncated === true);
  cleanup(e);
}

// ===================== (H) reset re-adding a shipped grant is audited too =====================
{
  const e = mkDb("reset");
  const app = await mkApp(e);
  // `resetProfileToBundled` matches a row to its shipped def BY NAME, so a row named exactly after a
  // bundled browser-capable rig is all the reset path needs — no boot seeder involved. Starting it with
  // browserTesting OFF makes the reset genuinely RE-ADD a grant the human had dropped, which is the
  // whole reason reset is audited alongside the editor save.
  const { BUNDLED_PROFILES } = await import("../dist/profiles/seed.js");
  const shipped = BUNDLED_PROFILES.find((b) => b.browserTesting === true);
  check("(H) fixture identity: a bundled rig ships browserTesting on", !!shipped);
  const prof = mkProfile(e, "prof-reset", { ...shipped, browserTesting: false });
  mkAgent(e, "agent-reset", "proj-r", "Reset", prof);
  check("(H) fixture identity: the row starts WITHOUT the grant", e.db.getProfile(prof).browserTesting !== true);

  const before = reachEvents(e).length;
  const res = await app.inject({ method: "POST", url: `/api/profiles/${prof}/reset` });
  check("(H) reset -> 200", res.statusCode === 200);
  const body = JSON.parse(res.payload);
  check("(H) the reset actually restored the shipped grant", body.browserTesting === true);
  check("(H) ...which is reported as an added grant", body.grantReach?.addedKeys?.join() === "browserTesting");
  check("(H) ...naming the bound agent", body.grantReach?.agentCount === 1);
  const ev = reachEvents(e).slice(-1)[0];
  check("(H) ...and files exactly one event, recording source \u0022reset\u0022",
    reachEvents(e).length === before + 1 && ev?.detail?.source === "reset");

  // NEGATIVE CONTROL for the reset path specifically: resetting an ALREADY-pristine row grants nothing.
  const beforeSecond = reachEvents(e).length;
  const again = await app.inject({ method: "POST", url: `/api/profiles/${prof}/reset` });
  check("(H) a second, no-op reset -> 200", again.statusCode === 200);
  check("(H) ...returns NO grantReach", JSON.parse(again.payload).grantReach === undefined);
  check("(H) ...and files NO new event", reachEvents(e).length === beforeSecond);
  cleanup(e);
}
// ===================== (I) adopt pulling in a shipped grant is audited too =====================
{
  const e = mkDb("adopt");
  const app = await mkApp(e);
  // `adoptProfileUpdate` needs base != shipped (an update to adopt). Pinning base to the shipped def
  // MINUS browserTesting, with `mine` matching base, makes the incoming update a pure, conflict-free
  // addition of that grant — the case where a human clicks Adopt and takes on a capability they never
  // typed. That is the whole reason adopt is audited alongside the editor save.
  const { BUNDLED_PROFILES } = await import("../dist/profiles/seed.js");
  const shipped = BUNDLED_PROFILES.find((b) => b.browserTesting === true);
  check("(I) fixture identity: a bundled rig ships browserTesting on", !!shipped);
  const prof = mkProfile(e, "prof-adopt", { ...shipped, browserTesting: false });
  e.db.setProfileBaseSnapshot(prof, JSON.stringify({ ...shipped, browserTesting: false }));
  mkAgent(e, "agent-adopt", "proj-ad", "Adopt", prof);
  check("(I) fixture identity: the row starts WITHOUT the grant", e.db.getProfile(prof).browserTesting !== true);

  const before = reachEvents(e).length;
  const res = await app.inject({ method: "POST", url: `/api/profiles/${prof}/adopt`, payload: {} });
  check("(I) adopt -> 200", res.statusCode === 200);
  const body = JSON.parse(res.payload);
  check("(I) the adopt actually pulled the shipped grant in", body.browserTesting === true);
  check("(I) ...which is reported as an added grant", body.grantReach?.addedKeys?.join() === "browserTesting");
  check("(I) ...naming the bound agent", body.grantReach?.agentCount === 1);
  const ev = reachEvents(e).slice(-1)[0];
  check("(I) ...and files exactly one event, recording source \u0022adopt\u0022",
    reachEvents(e).length === before + 1 && ev?.detail?.source === "adopt");

  // NEGATIVE CONTROL for the adopt path: nothing left to adopt (base is now shipped) grants nothing.
  const beforeSecond = reachEvents(e).length;
  const again = await app.inject({ method: "POST", url: `/api/profiles/${prof}/adopt`, payload: {} });
  check("(I) a second adopt with no update pending is refused, and files NO event",
    again.statusCode === 409 && reachEvents(e).length === beforeSecond);
  cleanup(e);
}

console.log(failures === 0 ? "\nAll profile-grant-reach checks passed" : `\n${failures} check(s) FAILED`);
try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
process.exit(failures === 0 ? 0 : 1);
