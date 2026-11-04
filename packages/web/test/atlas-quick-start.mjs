// Hermetic unit test for the Atlas Sessions tab quick-start's derivations — src/lib/atlasAgents.ts,
// card f3b18f27 (the owner's Atlas feedback: `Tab "Sessions": Add a quick agent session start UI
// element.`). No daemon, no browser: it imports the real functions and asserts on plain objects.
//
// Record: docs/decisions/f3b18f27-atlas-sessions-quick-start.md
//
// Run it with: node --experimental-strip-types packages/web/test/atlas-quick-start.mjs
import assert from "node:assert/strict";
import { register } from "node:module";

// atlasAgents.ts has REAL runtime imports of ./api and ./sessions, written extensionless in the
// bundler style the app uses, which Node's own resolver cannot follow. `_tsxLoaderHook.mjs` exists
// for exactly that. Registering it means the import below must be DYNAMIC — a static one in this
// file would be hoisted and resolved before `register()` ever ran.
//
// ⭐ `./sessions` is the POINT, not an inconvenience to route around: `spawnPickLabel`'s `· live`
// marker is defined as "whatever `holdsGoLiveSlot` says", via the `live` field `rosterAgent` fills
// from it. Building the roster rows through the REAL `rosterAgent`/`splitRoster` below — rather than
// hand-writing `{ live: true }` literals — is what makes these assertions fail if that predicate
// changes under them.
register("./_tsxLoaderHook.mjs", import.meta.url);

const { resolveSpawnPick, rosterAgent, spawnPickLabel, splitRoster } =
  await import("../src/lib/atlasAgents.ts");

/** An agent row as GET /api/projects/:id/agents returns it — only the fields the join reads. */
const agent = (id, name, profileId = null) => ({ id, name, profileId, projectId: "p1" });

/** A profile summary, which is what decides whether its agents are spawnable at all. */
const profile = (id, name, role) => ({ id, name, role });

/** A session row, shaped for `holdsGoLiveSlot` — `processState` is what that predicate reads. */
const session = (agentId, over = {}) => ({
  id: over.id ?? `sess-${agentId}`,
  agentId,
  processState: over.processState ?? "live",
  busy: over.busy ?? false,
  role: over.role ?? "manager",
});

const LEAD_RIG = profile("rig-lead", "Orchestrator rig", "manager");
const DEV_RIG = profile("rig-dev", "Dev rig", "worker");
const PROFILES = [LEAD_RIG, DEV_RIG];

// The project's agents in the order the API returns them — which is the order the picker shows, and
// the order its "first spawnable" fallback resolves against. `Zed Lead` leads deliberately: it sorts
// LAST alphabetically, so a fallback that silently sorted instead of taking the list's own first
// entry would be caught here rather than passing by coincidence.
const AGENTS = [
  agent("a-zed", "Zed Lead", LEAD_RIG.id),
  agent("a-dev", "Dev", DEV_RIG.id),
  agent("a-plain", "Plain Probe"),
];

// ── splitRoster: the spawnable list the picker offers is not this surface's own rule ─────────────
{
  const roster = splitRoster(AGENTS, PROFILES, []);
  assert.deepEqual(
    roster.spawnable.map((e) => e.agent.id),
    ["a-zed", "a-plain"],
    "the picker's options are splitRoster's spawnable list, in the project's own agent order",
  );
  assert.deepEqual(
    roster.workers.map((e) => e.agent.id),
    ["a-dev"],
    "a worker rig is excluded from spawnable — a manager dispatches those, never a picker",
  );
}

// ── resolveSpawnPick: the request resolves to an entry that is really in the list ────────────────
{
  const roster = splitRoster(AGENTS, PROFILES, []);

  // Nothing chosen yet ⇒ the list's own FIRST entry, not its alphabetical first.
  assert.equal(
    resolveSpawnPick(roster.spawnable, null)?.agent.id, "a-zed",
    "with no request, the pick is the first spawnable agent in the project's own order",
  );

  // A live request is honoured — the only case where the picker's state decides anything.
  assert.equal(
    resolveSpawnPick(roster.spawnable, "a-plain")?.agent.id, "a-plain",
    "a requested agent that is still spawnable is the pick",
  );

  // THE LOAD-BEARING CASE. An id that is no longer in the list falls back rather than being kept:
  // a `<select>` whose `value` matches no `<option>` renders as its FIRST option, so holding the
  // stale id would show one agent while the buttons posted to another's (gone) id.
  assert.equal(
    resolveSpawnPick(roster.spawnable, "a-deleted")?.agent.id, "a-zed",
    "an agent that left the roster falls back to the first spawnable one, never stays pinned",
  );

  // A worker rig is not reachable even by asking for it BY ID — the exclusion is the list's, so a
  // stale request naming one resolves away from it exactly like a deleted agent does.
  assert.equal(
    resolveSpawnPick(roster.spawnable, "a-dev")?.agent.id, "a-zed",
    "requesting a worker-rig agent resolves to a spawnable one — it is not in the list to pick",
  );

  // An empty list has no pick at all, which is what makes the control render its empty note instead
  // of a Spawn button with nothing behind it. `null`, never `undefined`: the component tests it.
  assert.equal(resolveSpawnPick([], null), null, "an empty spawnable list resolves to null");
  assert.equal(resolveSpawnPick([], "a-zed"), null, "…even when something was requested");

  // A project whose ONLY agents are worker rigs: spawnable is empty, so there is nothing to pick.
  const workersOnly = splitRoster([agent("a-dev", "Dev", DEV_RIG.id)], PROFILES, []);
  assert.equal(workersOnly.spawnable.length, 0, "a worker-rig-only project offers no spawnable agent");
  assert.equal(resolveSpawnPick(workersOnly.spawnable, null), null, "…and therefore no pick");
}

// ── spawnPickLabel: the `· live` marker tracks holdsGoLiveSlot, for every role ───────────────────
{
  const idle = rosterAgent(AGENTS[0], PROFILES, []);
  assert.equal(idle.live, false, "an agent with no session does not hold its go-live slot");
  assert.equal(
    spawnPickLabel(idle), "Zed Lead",
    "an agent with no live session is labelled by name alone",
  );

  // The SAME agent, now holding its slot ⇒ the marker appears. This is what tells a reader why the
  // control beside the picker changed shape (held control + Stop) instead of reading as a broken
  // Spawn button.
  const liveMgr = rosterAgent(AGENTS[0], PROFILES, [session("a-zed")]);
  assert.equal(liveMgr.live, true, "a live session makes its agent hold the go-live slot");
  assert.equal(liveMgr.managerLive, true, "…and for a manager rig that is the go-live guard itself");
  assert.equal(spawnPickLabel(liveMgr), "Zed Lead · live", "a live agent carries the `· live` marker");

  // A NON-manager live agent is marked too, even though its Spawn stays enabled: the marker says
  // "already running", which is worth knowing whether or not the guard is holding. A label rule
  // keyed on `managerLive` instead of `live` would leave this row silently unmarked.
  const livePlain = rosterAgent(AGENTS[2], PROFILES, [session("a-plain", { role: null })]);
  assert.equal(livePlain.live, true, "a plain agent with a live session holds its slot too");
  assert.equal(livePlain.managerLive, false, "…but the go-live guard does not hold it");
  assert.equal(
    spawnPickLabel(livePlain), "Plain Probe · live",
    "the marker is keyed on `live`, not on `managerLive` — a running plain agent is marked as well",
  );

  // A session on a DIFFERENT agent must not mark this one. Without the agentId match the whole
  // marker would read as "something is running somewhere".
  const otherLive = rosterAgent(AGENTS[2], PROFILES, [session("a-zed")]);
  assert.equal(
    spawnPickLabel(otherLive), "Plain Probe",
    "another agent's live session leaves this one unmarked",
  );
}

console.log("atlas-quick-start: all assertions passed");
