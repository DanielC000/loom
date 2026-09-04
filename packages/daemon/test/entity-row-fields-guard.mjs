// entityRowFields key-set pin (card 4f2b2da7, same class as f8d53712's worker-status-projection-guard).
//
// THE DEFECT THIS CLOSES: the platform + setup MCP routers' single-record Project/Agent/Profile reads
// and writes (agent_get/profile_get/project_get/*_update/*_assign/list_all_*) used to spread or return
// the RAW db.getProject()/getAgent()/getProfile() row straight into the tool response (an OPT-OUT
// projection: any column added to those tables in future would silently reach the calling agent, no
// code change, no review step). The fix (`projectFields`/`agentFields`/`profileFields` in
// mcp/entityRowFields.ts) names every field explicitly, so TypeScript enforces totality at compile
// time. This test pins the exact key SET each helper returns today AND proves — with a REAL fixture,
// not a simulated one — that an unnamed field on the input row does NOT leak into the output, which is
// the actual property the fix exists to guarantee.
//
// HERMETIC: pure unit test against the compiled helpers directly, no db/MCP/network involved.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/entity-row-fields-guard.mjs
import { projectFields, agentFields, profileFields } from "../dist/mcp/entityRowFields.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const assertKeySet = (actual, expected, label) => {
  const actualKeys = Object.keys(actual).sort();
  const expectedSorted = [...expected].sort();
  const missing = expectedSorted.filter((k) => !actualKeys.includes(k));
  const extra = actualKeys.filter((k) => !expectedSorted.includes(k));
  check(`${label}: no missing keys (${missing.join(", ") || "none"})`, missing.length === 0);
  check(`${label}: no extra keys (${extra.join(", ") || "none"})`, extra.length === 0);
};

// --- fixtures: a fully-populated row for each entity, PLUS an unnamed field simulating "a column added
// to the table after this projection was written" — the exact scenario the opt-out defect used to leak.
const projectRow = {
  id: "proj-1", name: "Demo", repoPath: "/repo", vaultPath: "/vault",
  referenceRepos: ["/ref1"], repos: [{ key: "r1", repoPath: "/repo2" }],
  config: { orchestration: {} }, createdAt: "2026-09-04T00:00:00.000Z", archivedAt: null,
  reserved: false, noGateByDesign: false, denyGlobs: ["mockups/**"],
  futureColumnFromTheDb: "leak-me", // NOT a real Project field — must never appear in the projection
};

const agentRow = {
  id: "agent-1", projectId: "proj-1", name: "Dev", startupPrompt: "go build things",
  position: 0, profileId: "profile-1", endpoint: false, ioSchema: null,
  futureColumnFromTheDb: "leak-me",
};

const profileRow = {
  id: "profile-1", name: "Dev Rig", role: "worker", description: "a rig",
  allowDelta: ["Bash(npm run *)"], skills: ["worker"], model: "claude-opus-4-8", icon: "🛠",
  browserTesting: true, documentConversion: false, restrictedTools: false, noCommit: false,
  connections: ["conn-1"], capabilities: [{ slug: "github-binary" }], vaultWrite: true,
  futureColumnFromTheDb: "leak-me",
};

// The EXACT key set each helper returns today (deliberately excludes `futureColumnFromTheDb` above —
// that's the whole point: an unnamed field on the input row must not reach the output).
const EXPECTED_PROJECT_KEYS = [
  "id", "name", "repoPath", "vaultPath", "referenceRepos", "repos", "config", "createdAt",
  "archivedAt", "reserved", "noGateByDesign", "denyGlobs",
];
const EXPECTED_AGENT_KEYS = [
  "id", "projectId", "name", "startupPrompt", "position", "profileId", "endpoint", "ioSchema",
];
const EXPECTED_PROFILE_KEYS = [
  "id", "name", "role", "description", "allowDelta", "skills", "model", "icon", "browserTesting",
  "documentConversion", "restrictedTools", "noCommit", "connections", "capabilities", "vaultWrite",
];

const projected = {
  project: projectFields(projectRow),
  agent: agentFields(agentRow),
  profile: profileFields(profileRow),
};

assertKeySet(projected.project, EXPECTED_PROJECT_KEYS, "projectFields(row)");
assertKeySet(projected.agent, EXPECTED_AGENT_KEYS, "agentFields(row)");
assertKeySet(projected.profile, EXPECTED_PROFILE_KEYS, "profileFields(row)");

// --- FUNCTIONAL anti-leak proof (not simulated): the real helper, run against a real fixture carrying
// an unnamed field, must not carry that field through. This is the actual property the fix guarantees —
// a naive `return { ...row }` would fail this immediately.
check("projectFields drops an unnamed input field (real fixture, real function)", !("futureColumnFromTheDb" in projected.project));
check("agentFields drops an unnamed input field (real fixture, real function)", !("futureColumnFromTheDb" in projected.agent));
check("profileFields drops an unnamed input field (real fixture, real function)", !("futureColumnFromTheDb" in projected.profile));

// --- value fidelity: behaviour-preserving means the VALUES carry through unchanged, not just the keys.
check("projectFields preserves values", projected.project.name === "Demo" && projected.project.denyGlobs[0] === "mockups/**");
check("agentFields preserves values", projected.agent.startupPrompt === "go build things" && projected.agent.profileId === "profile-1");
check("profileFields preserves values (incl. fields the tool descriptions don't name)", projected.profile.connections[0] === "conn-1" && projected.profile.vaultWrite === true);

// --- undefined pass-through: db.getProject/getAgent/getProfile all return `T | undefined`, and several
// call sites spread that possibly-undefined value directly (e.g. `{...db.getProject(id)!, extra}`,
// `{...maybeUndefined, promptWarning}`) — spreading `undefined` is a legal no-op in JS, so today's
// degenerate-row behaviour on a not-found race is a real path callers rely on. Each helper must pass
// `undefined` straight through rather than throwing.
check("projectFields(undefined) === undefined", projectFields(undefined) === undefined);
check("agentFields(undefined) === undefined", agentFields(undefined) === undefined);
check("profileFields(undefined) === undefined", profileFields(undefined) === undefined);
// The exact degenerate shape a caller like agent_update relies on: `{...agentFields(undefined), promptWarning}`.
const degenerate = { ...agentFields(undefined), promptWarning: "warn" };
check("spreading agentFields(undefined) into a literal behaves as a no-op (matches pre-fix spread-of-undefined)", Object.keys(degenerate).length === 1 && degenerate.promptWarning === "warn");

// --- POSITIVE CONTROL: prove assertKeySet itself actually goes RED on both a dropped and an added key,
// not just green because nothing ever changes (mirrors worker-status-projection-guard.mjs's precedent).
const droppedField = { ...projected.project };
delete droppedField.vaultPath;
const missingAfterDrop = EXPECTED_PROJECT_KEYS.filter((k) => !Object.keys(droppedField).includes(k));
check("(control) removing a known field from a copy of the response IS caught as missing", missingAfterDrop.length === 1 && missingAfterDrop[0] === "vaultPath");

const addedField = { ...projected.profile, newColumnFromTheFuture: "surprise" };
const extraAfterAdd = Object.keys(addedField).filter((k) => !EXPECTED_PROFILE_KEYS.includes(k));
check("(control) adding an unnamed field to a copy of the response IS caught as extra", extraAfterAdd.length === 1 && extraAfterAdd[0] === "newColumnFromTheFuture");

console.log(failures === 0
  ? "\n✅ ALL PASS — projectFields/agentFields/profileFields' key sets are pinned, a future db column doesn't leak through a real fixture, values + the undefined pass-through path are preserved, and the assertion logic is itself positive-controlled."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
