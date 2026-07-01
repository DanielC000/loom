// Hermetic unit test for the Companion → Manage overhaul (Companion epic): the pure logic that makes the
// Manage tab the single home for everything companion.
//   1. Profiles split (lib/profileRoles.ts): the companion's assistant-role rig is HIDDEN from the agent
//      Profiles page (agentProfiles); companionProfile resolves the shared rig itself (not a specific
//      running companion's live settings — those are pinned per-session, see restricted-tools below).
//   2. Persona-prompt bounds (lib/companion.ts): validatePersonaPrompt / COMPANION_PROMPT_MAX mirror the
//      daemon's 10k guard so the editor rejects an over-long prompt inline, not at a 400.
//   3. The api.ts client mirrors for the NEW human-only REST — prompt (GET/PUT), skills (GET list/single,
//      DELETE), and session-row restricted-tools (GET/PUT) — driven against a mocked global fetch: request
//      shapes + response unwrapping.
//   4. restartCompanionSession (api.ts): stop → poll until truly exited → resume, and — the live-apply
//      fix's silent-failure guard — it THROWS instead of calling resume() if the session is still
//      live/starting at the poll deadline (a resume() against a still-alive pty is a server-side no-op, so
//      calling it there would report success without applying anything).
// No daemon, no claude, no network: imports the TS source directly via Node type stripping.
//
// The web package has no test runner, so this is a self-contained node script, auto-globbed by
// test/run-all.mjs (wired into @loom/web's `build`). Run standalone with:
//   node --experimental-strip-types packages/web/test/companion-manage.mjs
import assert from "node:assert/strict";
import { agentProfiles, companionProfile } from "../src/lib/profileRoles.ts";
import { validatePersonaPrompt, COMPANION_PROMPT_MAX } from "../src/lib/companion.ts";
// api.ts has only a type-only `@loom/shared` import (erased under --experimental-strip-types), so it loads
// here with no daemon/build — letting us drive the companion prompt/skills client against a mocked fetch.
import { api, restartCompanionSession } from "../src/lib/api.ts";

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

// ── Profiles split: hide the companion rig from Profiles, resolve it for the inline toggle ──────────────

// A minimal profiles fixture: a few agent rigs plus the bundled assistant-role Companion rig.
const profilesFixture = () => [
  { id: "p1", role: null, name: "Dev" },
  { id: "p2", role: "manager", name: "Orchestrator" },
  { id: "pC", role: "assistant", name: "Companion", restrictedTools: true },
  { id: "p3", role: "worker", name: "Bugfix" },
];

check("agentProfiles: drops the assistant-role Companion rig, keeps every other, in order", () => {
  const shown = agentProfiles(profilesFixture());
  assert.deepEqual(shown.map((p) => p.id), ["p1", "p2", "p3"], "the assistant rig is hidden; order preserved");
  assert.ok(!shown.some((p) => p.role === "assistant"), "no assistant-role profile survives the filter");
});

check("agentProfiles: an empty list stays empty (no throw)", () => {
  assert.deepEqual(agentProfiles([]), []);
});

check("agentProfiles: never mutates its input", () => {
  const input = profilesFixture();
  agentProfiles(input);
  assert.equal(input.length, 4, "the original list is untouched");
});

check("companionProfile: returns the assistant-role rig (the shared Companion Profile, not a per-session pin)", () => {
  const p = companionProfile(profilesFixture());
  assert.equal(p?.id, "pC");
  assert.equal(p?.restrictedTools, true, "carries the restrictedTools value the Manage toggle reads");
});

check("companionProfile: null when there is no assistant-role rig", () => {
  assert.equal(companionProfile([{ id: "p1", role: null }, { id: "p2", role: "worker" }]), null);
  assert.equal(companionProfile([]), null);
});

// agentProfiles ∪ companionProfile partitions on role=assistant — nothing is both shown AND resolved.
check("the split is a partition: the companion rig is never among the shown agent profiles", () => {
  const all = profilesFixture();
  const shown = agentProfiles(all);
  const companion = companionProfile(all);
  assert.ok(companion && !shown.some((p) => p.id === companion.id), "the resolved companion rig is never in the Profiles list");
});

// ── Persona-prompt bounds mirror the daemon's COMPANION_PROMPT_MAX (10k) ────────────────────────────────

check("COMPANION_PROMPT_MAX mirrors the daemon constant (10,000)", () => {
  assert.equal(COMPANION_PROMPT_MAX, 10_000);
});

check("validatePersonaPrompt: an empty prompt is allowed (the base brief still layers under it)", () => {
  assert.equal(validatePersonaPrompt(""), null);
});

check("validatePersonaPrompt: a normal prompt passes", () => {
  assert.equal(validatePersonaPrompt("You are Ada, a calm, terse companion."), null);
});

check("validatePersonaPrompt: exactly at the cap passes; one over is rejected", () => {
  assert.equal(validatePersonaPrompt("x".repeat(COMPANION_PROMPT_MAX)), null);
  const err = validatePersonaPrompt("x".repeat(COMPANION_PROMPT_MAX + 1));
  assert.ok(err && /at most 10000 characters/.test(err), "over-length is rejected with a readable reason");
});

// ── The api.ts client mirrors over a MOCKED fetch (request shapes + response unwrapping) ────────────────

const realFetch = globalThis.fetch;
async function acheck(name, fn) {
  try { await fn(); pass++; console.log(`ok   ${name}`); }
  finally { globalThis.fetch = realFetch; }
}

await acheck("companionPrompt: GETs /api/companion/prompt/:sessionId and returns { startupPrompt, baseBrief }", async () => {
  let captured = null;
  globalThis.fetch = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, status: 200, json: async () => ({ sessionId: "sess 1", startupPrompt: "MY_PERSONA", baseBrief: "BASE" }) };
  };
  const r = await api.companionPrompt("sess 1");
  assert.equal(captured.url, "/api/companion/prompt/sess%201", "sessionId is URL-encoded into the path");
  assert.ok(!captured.opts || captured.opts.method === undefined || captured.opts.method === "GET");
  assert.equal(r.startupPrompt, "MY_PERSONA");
  assert.equal(r.baseBrief, "BASE");
});

await acheck("updateCompanionPrompt: PUTs { startupPrompt } and surfaces a 400 reason verbatim", async () => {
  let captured = null;
  globalThis.fetch = async (url, opts) => { captured = { url, opts }; return { ok: true, status: 200, json: async () => ({ sessionId: "s", startupPrompt: "NEW", baseBrief: "BASE" }) }; };
  const r = await api.updateCompanionPrompt("s", "NEW");
  assert.equal(captured.url, "/api/companion/prompt/s");
  assert.equal(captured.opts.method, "PUT");
  assert.equal(captured.opts.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(captured.opts.body), { startupPrompt: "NEW" }, "the PUT carries ONLY startupPrompt (never baseBrief)");
  assert.equal(r.startupPrompt, "NEW");

  // An over-length 400 surfaces the server's { error } message (putErr), not an opaque status string.
  globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: "startupPrompt must be a string of at most 10000 characters" }) });
  let threw = null;
  try { await api.updateCompanionPrompt("s", "x".repeat(20_000)); } catch (e) { threw = e; }
  assert.ok(threw && /at most 10000 characters/.test(threw.message), "the 400 reason is surfaced verbatim");
});

await acheck("companionSkills: GETs the list endpoint and UNWRAPS { skills } to the array", async () => {
  let captured = null;
  globalThis.fetch = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, status: 200, json: async () => ({ skills: [{ name: "git-flow", description: "commit cleanly" }] }) };
  };
  const skills = await api.companionSkills("sess 1");
  assert.equal(captured.url, "/api/companion/skills/sess%201");
  assert.ok(Array.isArray(skills), "the client unwraps { skills } to the bare array");
  assert.equal(skills[0].name, "git-flow");
  assert.equal(skills[0].description, "commit cleanly");
});

await acheck("companionSkill: GETs a single skill's SKILL.md by name (name URL-encoded)", async () => {
  let captured = null;
  globalThis.fetch = async (url, opts) => { captured = { url, opts }; return { ok: true, status: 200, json: async () => ({ name: "git flow", content: "# body" }) }; };
  const r = await api.companionSkill("s", "git flow");
  assert.equal(captured.url, "/api/companion/skills/s/git%20flow", "the skill name is URL-encoded into the path");
  assert.equal(r.content, "# body");
});

await acheck("deleteCompanionSkill: DELETEs by name, returns the updated { ok, skills }, surfaces a 404 reason", async () => {
  let captured = null;
  globalThis.fetch = async (url, opts) => { captured = { url, opts }; return { ok: true, status: 200, json: async () => ({ ok: true, skills: [] }) }; };
  const r = await api.deleteCompanionSkill("s", "git-flow");
  assert.equal(captured.url, "/api/companion/skills/s/git-flow");
  assert.equal(captured.opts.method, "DELETE");
  assert.equal(r.ok, true);
  assert.deepEqual(r.skills, [], "returns the post-delete list so the UI can update the cache");

  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({ error: 'no skill "git-flow"' }) });
  let threw = null;
  try { await api.deleteCompanionSkill("s", "git-flow"); } catch (e) { threw = e; }
  assert.ok(threw && /no skill/.test(threw.message), "an unknown skill's 404 reason is surfaced verbatim");
});

// ── Session-ROW restrictedTools (live-apply fix): resolved by sessionId, distinct from the shared Profile ──

await acheck("companionRestrictedTools: GETs /api/companion/restricted-tools/:sessionId", async () => {
  let captured = null;
  globalThis.fetch = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, status: 200, json: async () => ({ sessionId: "sess 1", restrictedTools: true }) };
  };
  const r = await api.companionRestrictedTools("sess 1");
  assert.equal(captured.url, "/api/companion/restricted-tools/sess%201", "sessionId is URL-encoded into the path");
  assert.ok(!captured.opts || captured.opts.method === undefined || captured.opts.method === "GET");
  assert.equal(r.restrictedTools, true);
});

await acheck("updateCompanionRestrictedTools: PUTs { restrictedTools } scoped to the one sessionId, surfaces a 400 reason", async () => {
  let captured = null;
  globalThis.fetch = async (url, opts) => { captured = { url, opts }; return { ok: true, status: 200, json: async () => ({ sessionId: "s", restrictedTools: false }) }; };
  const r = await api.updateCompanionRestrictedTools("s", false);
  assert.equal(captured.url, "/api/companion/restricted-tools/s");
  assert.equal(captured.opts.method, "PUT");
  assert.equal(captured.opts.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(captured.opts.body), { restrictedTools: false });
  assert.equal(r.restrictedTools, false);

  globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: "restrictedTools must be a boolean" }) });
  let threw = null;
  try { await api.updateCompanionRestrictedTools("s", /** @type {any} */ ("nope")); } catch (e) { threw = e; }
  assert.ok(threw && /must be a boolean/.test(threw.message), "the 400 reason is surfaced verbatim");
});

// ── restartCompanionSession: stop → poll allSessions until truly exited → resume (never resume-while-live) ──
// Both checks fake `setTimeout` to fire immediately (no real 500ms waits), and the second also fakes
// `Date.now` so the 15s deadline is reached in a tight loop instead of a real 15-second test.

await acheck("restartCompanionSession: stops, polls allSessions until the session has EXITED, then resumes", async () => {
  const calls = [];
  let pollCount = 0;
  globalThis.fetch = async (url, opts) => {
    calls.push(`${opts?.method ?? "GET"} ${url}`);
    if (url === "/api/sessions/s1/stop") return { ok: true, status: 200, json: async () => ({ ok: true }) };
    if (url === "/api/sessions") {
      pollCount++;
      // First poll: still live. Second poll: gone from the list entirely (exited).
      const body = pollCount === 1 ? [{ id: "s1", processState: "live" }] : [];
      return { ok: true, status: 200, json: async () => body };
    }
    if (url === "/api/sessions/s1/resume") return { ok: true, status: 200, json: async () => ({ id: "s1", processState: "live" }) };
    throw new Error(`unexpected fetch: ${url}`);
  };
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => { fn(); return 0; };
  try {
    await restartCompanionSession("s1");
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.deepEqual(calls, [
    "POST /api/sessions/s1/stop",
    "GET /api/sessions",
    "GET /api/sessions",
    "POST /api/sessions/s1/resume",
  ], "stops, polls (still-live, then exited), THEN resumes — in that order, resume only after exit is observed");
});

await acheck("restartCompanionSession: throws (and NEVER calls resume) if the session is still live at the deadline", async () => {
  let resumeCalled = false;
  globalThis.fetch = async (url) => {
    if (url === "/api/sessions/s2/stop") return { ok: true, status: 200, json: async () => ({ ok: true }) };
    if (url === "/api/sessions") return { ok: true, status: 200, json: async () => [{ id: "s2", processState: "live" }] }; // NEVER exits
    if (url === "/api/sessions/s2/resume") { resumeCalled = true; return { ok: true, status: 200, json: async () => ({}) }; }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const realSetTimeout = globalThis.setTimeout;
  const realDateNow = Date.now;
  let fakeNow = 0;
  Date.now = () => fakeNow;
  globalThis.setTimeout = (fn) => { fakeNow += 500; fn(); return 0; }; // fast-forward the 15s deadline
  let threw = null;
  try {
    await restartCompanionSession("s2");
  } catch (e) { threw = e; }
  finally {
    globalThis.setTimeout = realSetTimeout;
    Date.now = realDateNow;
  }
  assert.ok(threw && /didn.t stop in time/i.test(threw.message), "throws a readable 'didn't stop in time' error, not a silent success");
  assert.equal(resumeCalled, false, "resume() is NEVER called when the session never exited — the silent-failure guard the security review flagged");
});

console.log(`\n${pass} passed`);
