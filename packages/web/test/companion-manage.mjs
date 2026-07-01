// Hermetic unit test for the Companion → Manage overhaul (Companion epic): the pure logic that makes the
// Manage tab the single home for everything companion.
//   1. Profiles split (lib/profileRoles.ts): the companion's assistant-role rig is HIDDEN from the agent
//      Profiles page (agentProfiles) and resolved for the inline restricted-tools toggle (companionProfile).
//   2. Persona-prompt bounds (lib/companion.ts): validatePersonaPrompt / COMPANION_PROMPT_MAX mirror the
//      daemon's 10k guard so the editor rejects an over-long prompt inline, not at a 400.
//   3. The api.ts client mirrors for the NEW human-only REST — prompt (GET/PUT), skills (GET list/single,
//      DELETE) — driven against a mocked global fetch: request shapes + response unwrapping.
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
import { api } from "../src/lib/api.ts";

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

check("companionProfile: returns the assistant-role rig (the inline restricted-tools toggle edits it)", () => {
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

console.log(`\n${pass} passed`);
