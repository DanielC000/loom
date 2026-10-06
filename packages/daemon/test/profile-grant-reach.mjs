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
// Card be447b3f extends the same mechanism to two non-grant keys (`role`, `restrictedTools` — neither
// joins AGENT_FORBIDDEN_PROFILE_KEYS, @decision 8c27ae8e) and to the two agent-facing `profile_update`
// MCP tools, where this durable event is the ONLY signal a human gets:
//   (J) profileWideningsOf: role ANY-change, restrictedTools true->false ONLY, both at once, negative
//       controls (unchanged role, restrictedTools false->true) — mirrors (A)/(B) for the new keys.
//   (K) PUT /api/profiles/:id with a role change + a restrictedTools relax -> grantReach.roleChange and
//       both keys in addedKeys; a NEGATIVE CONTROL (unrelated patch, pre-existing role/restrictedTools
//       state untouched) files nothing.
//   (L) mcp/setup.ts's profile_update fires the SAME event (source "setup") with a grantReach response
//       field; a NEGATIVE CONTROL (unrelated patch) fires nothing.
//   (M) mcp/platform.ts's profile_update fires it too (source "platform"), INCLUDING on an elevated/
//       locked-role profile (an assistant/Companion rig) the setup surface could never touch; a NEGATIVE
//       CONTROL (unrelated patch) fires nothing.
//
// Code Review of 8298bcdb (round 2) found the "fires on every write path" claim false: profile_delete had
// no in-use guard and no reach computation at all.
//   (N) mcp/platform.ts's profile_delete: the dangling-profileId backstop itself widens reach (role/
//       restrictedTools), same mechanism as an update; a BEHAVIOURAL NEGATIVE CONTROL (deleting a profile
//       already AT the backstop state) fires nothing, on the same instrument that just fired above.
//   (O) mcp/setup.ts's profile_update filters the RESPONSE's grantReach.agents to live projects only (this
//       least-privilege surface's other reads already exclude archived ones) while agentCount and the
//       durable event stay the TRUE, unfiltered total.
//
// Code Review of d027ce92 (round 3, blocking Major) found profile_delete had TWO more write paths round 2
// never touched — the manager's own MCP tool and the human REST route — each still skipping the reach
// computation entirely. Both now route through the SAME shared compute/file helpers (N) already
// exercises for the platform tool:
//   (P) sessions/service.ts's deleteProfileAsManager (source "manager"); a BEHAVIOURAL NEGATIVE CONTROL
//       (deleting a profile already AT the backstop state) fires nothing.
//   (Q) REST DELETE /api/profiles/:id (source "rest"); a BEHAVIOURAL NEGATIVE CONTROL, plus the idempotent
//       unknown-id delete (no row to snapshot) stays a clean 200 with no grantReach.
//   (R) PROFILE_DELETE_BACKSTOP_FIELDS is now DERIVED from resolveProfile's own backstop rather than
//       hand-copied (round 3, Minor: nothing caught the two drifting) — a confirming positive proof of the
//       derivation's field mapping (allow->allowDelta, harness null->undefined), not a drift detector in
//       its own right; the derivation itself is what removes the drift risk.
//
// Card 8fd36112 (be447b3f round-3 Minor): recordProfileDeleteGrantReach used to run AFTER db.deleteProfile
// with no transaction — a listAllAgents() fault post-delete left the profile gone with no audit event.
//   (S) FAULT INJECTION: a listAllAgents() throw aborts the REST delete BEFORE db.deleteProfile runs (the
//       profile survives, no event fires); a NEGATIVE CONTROL (clearing the same fault) proves the abort
//       was caused by the injected fault, by showing the identical request then succeeds normally.
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
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { addedProfileGrants, profileWideningsOf, agentsBoundToProfile, GRANT_REACH_AGENTS_CAP, resolveProfile } = await import("@loom/shared");

const BARE = { connections: [], capabilities: [], allowDelta: [], role: null, restrictedTools: false };
const added = (before, after) => addedProfileGrants({ ...BARE, ...before }, { ...BARE, ...after });
const widened = (before, after) => profileWideningsOf({ ...BARE, ...before }, { ...BARE, ...after });

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

// ===================== (J) profileWideningsOf: role + restrictedTools (card be447b3f) =====================
check("(J) profileWideningsOf is a strict superset of addedProfileGrants — a plain grant alone is unchanged",
  widened({}, { vaultWrite: true }).join() === "vaultWrite");
check("(J) role: ANY change is reported, including a 'narrowing' one",
  widened({ role: "worker" }, { role: "manager" }).join() === "role"
  && widened({ role: "manager" }, { role: "worker" }).join() === "role");
check("(J) role: NEGATIVE CONTROL — an unchanged role (incl. both null) reports nothing",
  widened({ role: "worker" }, { role: "worker" }).length === 0
  && widened({ role: null }, { role: null }).length === 0);
check("(J) restrictedTools: true->false (removing the restriction) is reported",
  widened({ restrictedTools: true }, { restrictedTools: false }).join() === "restrictedTools");
check("(J) restrictedTools: NEGATIVE CONTROL — false->true (adding it) is a narrowing, not reported",
  widened({ restrictedTools: false }, { restrictedTools: true }).length === 0);
check("(J) role + a grant + restrictedTools at once, in the fixed order (grants, then role, then restrictedTools)",
  widened({ role: "worker", restrictedTools: true }, { vaultWrite: true, role: "manager", restrictedTools: false }).join()
    === "vaultWrite,role,restrictedTools");
check("(J) NEGATIVE CONTROL: an unrelated save with role/restrictedTools unchanged reports only the grant",
  widened({ role: "worker", restrictedTools: true, vaultWrite: false }, { role: "worker", restrictedTools: true, vaultWrite: true }).join()
    === "vaultWrite");
check("(J) role: null -> a value is reported (the profile_delete backstop direction)",
  widened({ role: null }, { role: "worker" }).join() === "role");
check("(J) role: a value -> null is reported (the direction profile_delete's backstop actually produces)",
  widened({ role: "worker" }, { role: null }).join() === "role");
check("(J) restrictedTools: undefined reads as false — undefined->true is a narrowing, not reported",
  widened({ restrictedTools: undefined }, { restrictedTools: true }).length === 0);
check("(J) restrictedTools: true->undefined is reported (undefined reads as false, same widening as true->false)",
  widened({ restrictedTools: true }, { restrictedTools: undefined }).join() === "restrictedTools");

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

// ===================== MCP test harness for (L)/(M): a tool client over an in-process transport =====================
async function mcpClient(router, sessionId) {
  const server = router.buildServer(sessionId);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "profile-grant-reach-test", version: "0" });
  await client.connect(clientT);
  return client;
}
const parseMcp = (res) => JSON.parse(res.content[0].text);

// ===================== (K) REST PUT: role change + restrictedTools relax, same mechanism as grants =====================
{
  const e = mkDb("widen-rest");
  const app = await mkApp(e);
  const prof = mkProfile(e, "prof-widen", { role: "worker", restrictedTools: true });
  mkAgent(e, "agent-widen", "proj-wi", "Widen", prof);

  const res = await putProfile(app, prof, { role: "manager", restrictedTools: false });
  check("(K) PUT -> 200", res.statusCode === 200);
  const body = JSON.parse(res.payload);
  check("(K) the response carries grantReach", !!body.grantReach);
  check("(K) grantReach names BOTH widened keys, role before restrictedTools",
    body.grantReach?.addedKeys?.join() === "role,restrictedTools");
  check("(K) grantReach.roleChange names the real from/to",
    body.grantReach?.roleChange?.from === "worker" && body.grantReach?.roleChange?.to === "manager");
  check("(K) grantReach counts the bound agent", body.grantReach?.agentCount === 1);

  const evs = reachEvents(e);
  check("(K) exactly one durable event filed", evs.length === 1);
  check("(K) the event records the write path", evs[0]?.detail?.source === "rest");
  check("(K) the event carries the same roleChange", evs[0]?.detail?.roleChange?.from === "worker" && evs[0]?.detail?.roleChange?.to === "manager");

  // ===== NEGATIVE CONTROL, same db, same instrument that just fired above =====
  const before = reachEvents(e).length;
  const plain = await putProfile(app, prof, { icon: "🔧" });
  check("(K) NEGATIVE CONTROL: an unrelated PUT -> 200", plain.statusCode === 200);
  check("(K) ...returns NO grantReach", JSON.parse(plain.payload).grantReach === undefined);
  check("(K) ...and files NO new event", reachEvents(e).length === before);
  // and the already-landed role/restrictedTools state is untouched by the unrelated save
  check("(K) ...the landed widening is still there, not re-reported", e.db.getProfile(prof).role === "manager" && e.db.getProfile(prof).restrictedTools === false);
  cleanup(e);
}

// ===================== (L) mcp/setup.ts's profile_update: the agent-facing surface, source "setup" =====================
{
  const e = mkDb("widen-setup");
  const prof = mkProfile(e, "prof-setup-widen", { role: "worker", restrictedTools: true });
  mkAgent(e, "agent-setup-widen", "proj-su", "SetupWiden", prof);
  const client = await mcpClient(new SetupMcpRouter(e.db, {}), "any-caller");
  const call = (name, args) => client.callTool({ name, arguments: args }).then(parseMcp);

  const res = await call("profile_update", { profileId: prof, patch: { role: "manager", restrictedTools: false } });
  check("(L) profile_update: the patch applied (no error)", !res.error && res.role === "manager" && res.restrictedTools === false);
  check("(L) ...the response carries grantReach", !!res.grantReach);
  check("(L) ...naming both widened keys", res.grantReach?.addedKeys?.join() === "role,restrictedTools");
  check("(L) ...naming the bound agent", res.grantReach?.agentCount === 1);

  const evs = reachEvents(e);
  check("(L) exactly one durable event filed", evs.length === 1);
  check("(L) ...recording source \u0022setup\u0022 — this surface is the ONLY signal a human gets here",
    evs[0]?.detail?.source === "setup");
  check("(L) ...carrying the real roleChange", evs[0]?.detail?.roleChange?.from === "worker" && evs[0]?.detail?.roleChange?.to === "manager");

  // ===== NEGATIVE CONTROL: an unrelated patch on the SAME now-widened profile files nothing new =====
  const before = reachEvents(e).length;
  const plain = await call("profile_update", { profileId: prof, patch: { icon: "⚙️" } });
  check("(L) NEGATIVE CONTROL: an unrelated patch applies with no error", !plain.error && plain.icon === "⚙️");
  check("(L) ...returns NO grantReach", plain.grantReach === undefined);
  check("(L) ...and files NO new event", reachEvents(e).length === before);
  cleanup(e);
}

// ===================== (M) mcp/platform.ts's profile_update: reaches an ELEVATED/locked-role profile too =====================
{
  const e = mkDb("widen-platform");
  // An assistant (Companion)-shaped profile, restrictedTools ON — exactly the rig the setup surface's
  // own role-lock (LOCKED_PROFILE_ROLES) can NEVER touch, but the Platform Lead administers by design.
  const prof = mkProfile(e, "prof-platform-widen", { role: "assistant", restrictedTools: true });
  mkAgent(e, "agent-platform-widen", "proj-pl", "PlatformWiden", prof);
  const client = await mcpClient(new PlatformMcpRouter(e.db, {}), "any-caller");
  const call = (name, args) => client.callTool({ name, arguments: args }).then(parseMcp);

  const res = await call("profile_update", { profileId: prof, patch: { restrictedTools: false } });
  check("(M) profile_update: the patch applied on an elevated/locked-role (assistant) profile", !res.error && res.restrictedTools === false);
  check("(M) ...the response carries grantReach", !!res.grantReach);
  check("(M) ...naming the widened key", res.grantReach?.addedKeys?.join() === "restrictedTools");
  check("(M) ...naming the bound agent", res.grantReach?.agentCount === 1);
  check("(M) ...no roleChange field (role did not change)", res.grantReach?.roleChange === undefined);

  const evs = reachEvents(e);
  check("(M) exactly one durable event filed", evs.length === 1);
  check("(M) ...recording source \u0022platform\u0022", evs[0]?.detail?.source === "platform");

  // ===== NEGATIVE CONTROL: an unrelated patch on the same profile files nothing new =====
  const before = reachEvents(e).length;
  const plain = await call("profile_update", { profileId: prof, patch: { description: "still the companion rig" } });
  check("(M) NEGATIVE CONTROL: an unrelated patch applies with no error", !plain.error);
  check("(M) ...returns NO grantReach", plain.grantReach === undefined);
  check("(M) ...and files NO new event", reachEvents(e).length === before);
  cleanup(e);
}

// ===================== (N) mcp/platform.ts's profile_delete: deletion itself is a widening write path =====================
// Card be447b3f, round 2 (Code Review of 8298bcdb, Major): the original cut covered profile_update on
// every surface but missed that profile_delete has no in-use guard — a dangling profileId falls back to
// resolveProfile's plain backstop (role:null, restrictedTools:false), which un-restricts and re-roles
// every still-bound agent exactly like an update would.
{
  const e = mkDb("widen-platform-delete");
  const prof = mkProfile(e, "prof-platform-delete", { role: "worker", restrictedTools: true });
  mkAgent(e, "agent-platform-delete", "proj-pd", "PlatformDelete", prof);
  const client = await mcpClient(new PlatformMcpRouter(e.db, {}), "any-caller");
  const call = (name, args) => client.callTool({ name, arguments: args }).then(parseMcp);

  const res = await call("profile_delete", { profileId: prof });
  check("(N) profile_delete: deleted with no error", !res.error && res.deleted === true);
  check("(N) ...the profile is really gone", !e.db.getProfile(prof));
  check("(N) ...the response carries grantReach (the backstop un-restricts the bound agent)", !!res.grantReach);
  check("(N) ...naming both widened keys, role before restrictedTools",
    res.grantReach?.addedKeys?.join() === "role,restrictedTools");
  check("(N) ...roleChange names the real from/to — to null, the backstop",
    res.grantReach?.roleChange?.from === "worker" && res.grantReach?.roleChange?.to === null);
  check("(N) ...naming the bound agent", res.grantReach?.agentCount === 1);

  const evs = reachEvents(e);
  check("(N) exactly one durable event filed", evs.length === 1);
  check('(N) ...recording source "platform"', evs[0]?.detail?.source === "platform");
  check("(N) ...carrying the same roleChange", evs[0]?.detail?.roleChange?.from === "worker" && evs[0]?.detail?.roleChange?.to === null);

  // ===== BEHAVIOURAL NEGATIVE CONTROL: deleting a profile already AT the backstop state widens nothing =====
  // (role:null, restrictedTools:false) — the SAME instrument that just fired above, proving it is not
  // unconditionally true for every delete.
  const before = reachEvents(e).length;
  const plainProf = mkProfile(e, "prof-platform-delete-plain", { role: null, restrictedTools: false });
  const plain = await call("profile_delete", { profileId: plainProf });
  check("(N) NEGATIVE CONTROL: deleting a profile already at the backstop state applies with no error",
    !plain.error && plain.deleted === true);
  check("(N) ...returns NO grantReach", plain.grantReach === undefined);
  check("(N) ...and files NO new event", reachEvents(e).length === before);

  // ===== 404 is unaffected by the new reach computation =====
  const missing = await call("profile_delete", { profileId: "does-not-exist" });
  check("(N) deleting an unknown id still 404s cleanly", missing.error === "profile not found");
  cleanup(e);
}

// ===================== (O) mcp/setup.ts's profile_update: filters grantReach.agents to LIVE projects =====================
// Card be447b3f, round 2 (Code Review of 8298bcdb, Minor): the setup operator's other reads
// (list_all_projects/list_all_agents) already exclude archived projects — an unfiltered reach would leak
// an archived project's existence/agent name through a side channel those tools don't expose.
{
  const e = mkDb("setup-live-filter");
  const prof = mkProfile(e, "prof-setup-filter", { role: "worker", restrictedTools: true });
  mkAgent(e, "agent-live", "proj-live", "Live", prof);
  mkAgent(e, "agent-archived", "proj-archived", "Archived", prof);
  e.db.archiveProject("proj-archived");
  const client = await mcpClient(new SetupMcpRouter(e.db, {}), "any-caller");
  const call = (name, args) => client.callTool({ name, arguments: args }).then(parseMcp);

  const res = await call("profile_update", { profileId: prof, patch: { restrictedTools: false } });
  check("(O) profile_update: the patch applied (no error)", !res.error && res.restrictedTools === false);
  check("(O) ...the response carries grantReach", !!res.grantReach);
  check("(O) ...agentCount stays the TRUE total, including the archived-project agent",
    res.grantReach?.agentCount === 2);
  const names = (res.grantReach?.agents ?? []).map((a) => a.name).sort();
  check("(O) ...but agents[] lists ONLY the live-project agent", names.length === 1 && names[0] === "agent-live");

  const evs = reachEvents(e);
  check("(O) exactly one durable event filed", evs.length === 1);
  check("(O) ...the event's OWN agents[] is UNFILTERED (both agents, archived included)",
    evs[0]?.detail?.agentCount === 2
    && (evs[0]?.detail?.agents ?? []).some((a) => a.name === "agent-archived")
    && (evs[0]?.detail?.agents ?? []).some((a) => a.name === "agent-live"));
  cleanup(e);
}

// ===================== (P) sessions/service.ts's deleteProfileAsManager: a SECOND delete path =====================
// Code Review of d027ce92 (round 3, blocking Major): the manager surface's profile_delete had NO reach
// computation at all — an agent manager could delete a restrictedTools:true rig (e.g. the bundled
// Companion profile, profiles/seed.ts) and silently un-restrict every bound agent. Routed through the
// SAME shared compute/file helpers (N) above exercises for the platform tool.
{
  const { SessionService } = await import("../dist/sessions/service.js");
  const { OrchestrationControl } = await import("../dist/orchestration/control.js");
  const e = mkDb("widen-manager-delete");
  const prof = mkProfile(e, "prof-manager-delete", { role: "assistant", restrictedTools: true });
  mkAgent(e, "agent-manager-delete", "proj-mgr-own", "MgrOwn", prof);
  const nowMgr = new Date().toISOString();
  e.db.insertSession({
    id: "mgr-sess", projectId: "proj-mgr-own", agentId: "agent-manager-delete", engineSessionId: null,
    title: null, cwd: tmpHome, processState: "live", resumability: "unknown", busy: false,
    createdAt: nowMgr, lastActivity: nowMgr, lastError: null, role: "manager", parentSessionId: null,
  });
  const pty = { enqueueStdin: () => ({ delivered: false }) };
  const svc = new SessionService(e.db, pty, new OrchestrationControl());

  const res = svc.deleteProfileAsManager("mgr-sess", prof);
  check("(P) deleteProfileAsManager: deleted with no error", res.deleted === true);
  check("(P) ...the profile is really gone", !e.db.getProfile(prof));
  check("(P) ...the response carries grantReach (the backstop un-restricts the bound agent)", !!res.grantReach);
  check("(P) ...naming both widened keys, role before restrictedTools",
    res.grantReach?.addedKeys?.join() === "role,restrictedTools");
  check("(P) ...roleChange names the real from/to — to null, the backstop",
    res.grantReach?.roleChange?.from === "assistant" && res.grantReach?.roleChange?.to === null);
  check("(P) ...naming the bound agent", res.grantReach?.agentCount === 1);

  const evs = reachEvents(e);
  check("(P) exactly one durable event filed", evs.length === 1);
  check("(P) ...recording source \"manager\"", evs[0]?.detail?.source === "manager");

  // ===== BEHAVIOURAL NEGATIVE CONTROL: deleting a profile already AT the backstop state widens nothing =====
  const before = reachEvents(e).length;
  const plainProf = mkProfile(e, "prof-manager-delete-plain", { role: null, restrictedTools: false });
  const plain = svc.deleteProfileAsManager("mgr-sess", plainProf);
  check("(P) NEGATIVE CONTROL: deleting a profile already at the backstop state applies with no error",
    plain.deleted === true);
  check("(P) ...returns NO grantReach", plain.grantReach === undefined);
  check("(P) ...and files NO new event", reachEvents(e).length === before);
  cleanup(e);
}

// ===================== (Q) REST DELETE /api/profiles/:id: the THIRD delete path =====================
{
  const e = mkDb("widen-rest-delete");
  const app = await mkApp(e);
  const prof = mkProfile(e, "prof-rest-delete", { role: "worker", restrictedTools: true });
  mkAgent(e, "agent-rest-delete", "proj-rd", "RestDelete", prof);

  const res = await app.inject({ method: "DELETE", url: `/api/profiles/${prof}` });
  check("(Q) DELETE -> 200", res.statusCode === 200);
  const body = JSON.parse(res.payload);
  check("(Q) ok:true", body.ok === true);
  check("(Q) the profile is really gone", !e.db.getProfile(prof));
  check("(Q) ...the response carries grantReach", !!body.grantReach);
  check("(Q) ...naming both widened keys, role before restrictedTools", body.grantReach?.addedKeys?.join() === "role,restrictedTools");
  check("(Q) ...naming the bound agent", body.grantReach?.agentCount === 1);

  const evs = reachEvents(e);
  check("(Q) exactly one durable event filed", evs.length === 1);
  check("(Q) ...recording source \"rest\"", evs[0]?.detail?.source === "rest");

  // ===== BEHAVIOURAL NEGATIVE CONTROL: deleting a profile already AT the backstop state widens nothing =====
  const before = reachEvents(e).length;
  const plainProf = mkProfile(e, "prof-rest-delete-plain", { role: null, restrictedTools: false });
  const plain = await app.inject({ method: "DELETE", url: `/api/profiles/${plainProf}` });
  check("(Q) NEGATIVE CONTROL: deleting a profile already at the backstop state -> 200", plain.statusCode === 200);
  check("(Q) ...returns NO grantReach", JSON.parse(plain.payload).grantReach === undefined);
  check("(Q) ...and files NO new event", reachEvents(e).length === before);

  // ===== idempotent delete of an unknown id: no row to snapshot, no crash, no grantReach =====
  const missing = await app.inject({ method: "DELETE", url: "/api/profiles/does-not-exist" });
  check("(Q) deleting an unknown id still 200s (idempotent, no 404)", missing.statusCode === 200);
  const missingBody = JSON.parse(missing.payload);
  check("(Q) ...ok:true, no grantReach, nothing filed", missingBody.ok === true && missingBody.grantReach === undefined && reachEvents(e).length === before);
  cleanup(e);
}

// ===================== (S) fault injection: a listAllAgents() fault must abort BEFORE the delete =====================
// Card 8fd36112 (be447b3f round-3 Minor): the old recordProfileDeleteGrantReach ran AFTER db.deleteProfile,
// with no transaction wrapping the two — a listAllAgents() fault post-delete left the profile gone with NO
// audit event, and the caller facing a bare error indistinguishable from "the delete failed" when it had
// actually already succeeded. The fix computes the reach BEFORE deleting, so a fault there aborts the
// request before the destructive write ever runs. This is the behavioural proof, on the REST delete path.
{
  const e = mkDb("delete-fault-injection");
  const app = await mkApp(e);
  const prof = mkProfile(e, "prof-fault", { role: "worker", restrictedTools: true });
  mkAgent(e, "agent-fault", "proj-fault", "Fault", prof);

  const originalListAllAgents = e.db.listAllAgents.bind(e.db);
  e.db.listAllAgents = () => { throw new Error("injected fault: listAllAgents"); };

  const res = await app.inject({ method: "DELETE", url: `/api/profiles/${prof}` });
  check("(S) a listAllAgents() fault during the widening compute surfaces as a server error", res.statusCode >= 500);
  check("(S) ...and the profile is STILL THERE — db.deleteProfile never ran", !!e.db.getProfile(prof));
  check("(S) ...and NO event was filed (nothing to roll back)", reachEvents(e).length === 0);

  // ===== NEGATIVE CONTROL: clearing the SAME fault lets the SAME request succeed normally — proving the
  // abort above is caused by the injected fault, not by some other defect in the fixture/request shape. =====
  e.db.listAllAgents = originalListAllAgents;
  const res2 = await app.inject({ method: "DELETE", url: `/api/profiles/${prof}` });
  check("(S) NEGATIVE CONTROL: with the fault cleared, the SAME delete now succeeds", res2.statusCode === 200);
  check("(S) ...the profile really is gone now", !e.db.getProfile(prof));
  check("(S) ...and the event fires normally, naming the bound agent", reachEvents(e).length === 1 && reachEvents(e)[0]?.detail?.agentCount === 1);

  cleanup(e);
}

// ===================== (R) PROFILE_DELETE_BACKSTOP_FIELDS tracks resolveProfile's own backstop =====================
// Round 3, Minor: round 2's constant was a hand-copy with nothing to catch it drifting against a future
// change to resolveProfile's own backstop. It is now DERIVED (grantReach.ts), so this is a confirming
// positive proof of the derivation's field mapping, not a drift detector in its own right — the
// derivation itself is what removes the risk.
{
  const { PROFILE_DELETE_BACKSTOP_FIELDS } = await import("../dist/profiles/grantReach.js");
  const backstop = resolveProfile({ startupPrompt: null }, null);
  check("(R) role matches", PROFILE_DELETE_BACKSTOP_FIELDS.role === backstop.role);
  check("(R) restrictedTools matches", PROFILE_DELETE_BACKSTOP_FIELDS.restrictedTools === backstop.restrictedTools);
  check("(R) vaultWrite matches", PROFILE_DELETE_BACKSTOP_FIELDS.vaultWrite === backstop.vaultWrite);
  check("(R) browserTesting matches", PROFILE_DELETE_BACKSTOP_FIELDS.browserTesting === backstop.browserTesting);
  check("(R) documentConversion matches", PROFILE_DELETE_BACKSTOP_FIELDS.documentConversion === backstop.documentConversion);
  check("(R) harness: backstop's null correctly maps to undefined (the one non-identity translation)",
    PROFILE_DELETE_BACKSTOP_FIELDS.harness === undefined && backstop.harness === null);
  check("(R) allowDelta matches resolveProfile's allow (the one renamed field)",
    JSON.stringify(PROFILE_DELETE_BACKSTOP_FIELDS.allowDelta) === JSON.stringify(backstop.allow));
  check("(R) connections matches", JSON.stringify(PROFILE_DELETE_BACKSTOP_FIELDS.connections) === JSON.stringify(backstop.connections));
  check("(R) capabilities matches", JSON.stringify(PROFILE_DELETE_BACKSTOP_FIELDS.capabilities) === JSON.stringify(backstop.capabilities));
}

console.log(failures === 0 ? "\nAll profile-grant-reach checks passed" : `\n${failures} check(s) FAILED`);
try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
process.exit(failures === 0 ? 0 : 1);
