// full:true field-projection pin for the cross-project agent/session list tools (card b6e3493f).
//
// THE DEFECT THIS CLOSES: `list_all_agents`/`list_all_sessions` (platform.ts + setup.ts) and the
// auditor's `list_sessions` (transcript-read.ts) returned `full:true` rows UNPROJECTED — a bare
// `...page` spread of whatever the db handed back. That's an OPT-OUT shape identical in kind to the
// one entity-row-fields-guard.mjs already closed for the platform/setup single-record Project/Agent/
// Profile reads (card 4f2b2da7): any column added to `Agent`/`Session`/`SessionListItem` in future
// reaches the calling agent automatically, no code change, no review step. The fix
// (`projectAgentList`/`projectSessionList` in mcp/agentView.ts + mcp/sessionView.ts) now projects the
// full:true path too, via a `Record<keyof T, 1>` sentinel that forces TypeScript totality the same way
// entityRowFields.ts's PROJECT_FIELDS/AGENT_FIELDS/PROFILE_FIELDS already do.
//
// THE PROPERTY THIS CARD ACTUALLY EXISTS TO GUARANTEE: `SessionListItem`/`AgentListItem` are Session/
// Agent PLUS enrichment fields (`projectName`, and for sessions also `agentName`) not present on the
// bare row type. A naive `Record<keyof Session, 1>` sentinel would have silently DROPPED those two
// fields from every real `list_all_sessions`/`list_sessions` caller today (all three feed it real
// `SessionListItem[]` rows) — so this test asserts `projectName`/`agentName` SURVIVE the session
// full:true path, not just that "some key set" is pinned. The agent side is the mirror-image finding:
// no CURRENT caller of `projectAgentList` ever passes an `AgentListItem` (they all pass plain
// `Agent[]`), so `projectName` is legitimately absent from a full:true agent row today — but the
// sentinel is still built against `AgentListItem` (not `Agent`) so a FUTURE caller that does pass
// enriched rows (`db.listAllAgents()` already returns exactly that type) doesn't silently lose it.
//
// HERMETIC: pure unit test against the compiled helpers directly, no db/MCP/network involved.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/agent-session-full-field-guard.mjs
import { projectAgentList } from "../dist/mcp/agentView.js";
import { projectSessionList } from "../dist/mcp/sessionView.js";

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
// Agent fixture is a PLAIN Agent row (no projectName) — this is what every real caller of
// projectAgentList passes today (db.listAgents), never an AgentListItem.
const agentRow = {
  id: "agent-1", projectId: "proj-1", name: "Dev", startupPrompt: "go build things",
  position: 0, profileId: "profile-1", endpoint: false, ioSchema: null,
  futureColumnFromTheDb: "leak-me",
};

// Session fixture IS a real SessionListItem — enriched with projectName/agentName — matching what
// every real caller of projectSessionList (list_all_sessions x2, list_sessions) actually passes.
const sessionRow = {
  id: "sess-1", projectId: "proj-1", agentId: "agent-1", engineSessionId: "eng-1",
  title: "My Session", cwd: "/repo", processState: "live", resumability: "resumable",
  busy: false, createdAt: "2026-09-04T00:00:00.000Z", lastActivity: "2026-09-04T00:01:00.000Z",
  lastError: null, role: "worker", parentSessionId: "mgr-1", taskId: "task-1",
  worktreePath: "/wt/sess-1", branch: "loom/sess-1", reviewBaseSha: null, repoKey: null,
  gen: 0, recycledFrom: null, ctxInputTokens: 1234, ctxTurns: 3, turnSeq: 3,
  ctxUpdatedAt: "2026-09-04T00:01:00.000Z", model: "claude-opus-4-8", rateLimitedUntil: null,
  rateLimitDeadline: null, browserTesting: false, documentConversion: false,
  restrictedTools: false, noCommit: false, skills: null, connections: [], vaultWrite: false,
  companionLeadMode: false, capabilities: [], archivedAt: null, scheduledSpawn: false,
  // enrichment fields SessionListItem adds over bare Session — the property this card guarantees:
  projectName: "Demo Project", agentName: "Dev",
  futureColumnFromTheDb: "leak-me",
};

// The EXACT key set the full:true path returns today for each — deliberately excludes
// `futureColumnFromTheDb` (the whole point) and, for the agent row, `projectName` (genuinely absent
// from a plain Agent row — see the module doc comment on why the sentinel still names it).
const EXPECTED_AGENT_FULL_KEYS = [
  "id", "projectId", "name", "startupPrompt", "position", "profileId", "endpoint", "ioSchema",
];
const EXPECTED_SESSION_FULL_KEYS = [
  "id", "projectId", "agentId", "engineSessionId", "title", "cwd", "processState", "resumability",
  "busy", "createdAt", "lastActivity", "lastError", "role", "parentSessionId", "taskId",
  "worktreePath", "branch", "reviewBaseSha", "repoKey", "gen", "recycledFrom", "ctxInputTokens",
  "ctxTurns", "turnSeq", "ctxUpdatedAt", "model", "rateLimitedUntil", "rateLimitDeadline",
  "browserTesting", "documentConversion", "restrictedTools", "noCommit", "skills", "connections",
  "vaultWrite", "companionLeadMode", "capabilities", "archivedAt", "scheduledSpawn",
  "projectName", "agentName",
];

// `pickFields` assigns EVERY sentinel key onto the output object, including ones absent from the input
// row — `out.projectName = row.projectName` sets an OWN property with value `undefined` when the row
// has no `projectName`. `Object.keys()` (unlike `JSON.stringify`) does NOT drop undefined-valued own
// keys, so the RAW in-memory object briefly carries a `projectName`/`pendingMerge` key sitting at
// `undefined`. That never reaches a real caller — every router here wraps its response in
// `JSON.stringify`, which DOES drop it — so `assertKeySet` below (and the "extra keys" bar it enforces)
// is deliberately run against the WIRE shape (post round-trip), not the raw pickFields output, since the
// wire shape is what this card's "byte-identical for today's callers" claim is actually about.
const agentFullRaw = projectAgentList([agentRow], { full: true })[0];
const sessionFullRaw = projectSessionList([sessionRow], { full: true })[0];
const agentFull = JSON.parse(JSON.stringify(agentFullRaw));
const sessionFull = JSON.parse(JSON.stringify(sessionFullRaw));

assertKeySet(agentFull, EXPECTED_AGENT_FULL_KEYS, "wire shape of projectAgentList([agentRow], {full:true})[0]");
assertKeySet(sessionFull, EXPECTED_SESSION_FULL_KEYS, "wire shape of projectSessionList([sessionRow], {full:true})[0]");

// --- FUNCTIONAL anti-leak proof (not simulated): the real function, run against a real fixture
// carrying an unnamed field, must not carry that field through (checked on the raw output too — a
// field absent from the sentinel is absent full stop, not merely undefined-valued).
check("projectAgentList(full:true) drops an unnamed input field (real fixture, real function)", !("futureColumnFromTheDb" in agentFullRaw));
check("projectSessionList(full:true) drops an unnamed input field (real fixture, real function)", !("futureColumnFromTheDb" in sessionFullRaw));

// --- THE PROPERTY THIS CARD EXISTS TO GUARANTEE: projectName/agentName SURVIVE the session full:true
// path (a naive `keyof Session` sentinel would have silently dropped both).
check("projectSessionList(full:true) preserves projectName", sessionFull.projectName === "Demo Project");
check("projectSessionList(full:true) preserves agentName", sessionFull.agentName === "Dev");

// --- value fidelity: behaviour-preserving means the VALUES carry through unchanged, not just the keys.
check("projectAgentList(full:true) preserves values", agentFull.startupPrompt === "go build things" && agentFull.profileId === "profile-1");
check("projectSessionList(full:true) preserves values", sessionFull.branch === "loom/sess-1" && sessionFull.ctxInputTokens === 1234);

// --- JSON.stringify wire check, explicit: a plain Agent row's absent `projectName` never reaches the
// wire as a visible `"projectName":null`/`"projectName":undefined` key — it's simply not a key at all
// once parsed back, confirming the byte-identical-for-today's-callers claim above.
check("JSON.stringify(agentFullRaw) never emits a projectName key for a plain Agent row", !("projectName" in agentFull));

// --- summary (default, full:false) path is UNCHANGED by this fix — still drops projectName/agentName
// and the heavy fields, for both entities.
const agentSummary = projectAgentList([agentRow])[0];
const sessionSummary = projectSessionList([sessionRow])[0];
check("projectAgentList() default summary still omits startupPrompt/ioSchema", !("startupPrompt" in agentSummary) && !("ioSchema" in agentSummary));
check("projectSessionList() default summary still omits heavy fields (title/cwd/worktreePath)", !("title" in sessionSummary) && !("cwd" in sessionSummary) && !("worktreePath" in sessionSummary));
check("projectSessionList() default summary still carries projectName/agentName (unchanged)", sessionSummary.projectName === "Demo Project" && sessionSummary.agentName === "Dev");

// --- POSITIVE CONTROL: prove assertKeySet itself actually goes RED on both a dropped and an added key,
// not just green because nothing ever changes (mirrors entity-row-fields-guard.mjs's own precedent).
const droppedField = { ...sessionFull };
delete droppedField.branch;
const missingAfterDrop = EXPECTED_SESSION_FULL_KEYS.filter((k) => !Object.keys(droppedField).includes(k));
check("(control) removing a known field from a copy of the response IS caught as missing", missingAfterDrop.length === 1 && missingAfterDrop[0] === "branch");

const addedField = { ...agentFull, newColumnFromTheFuture: "surprise" };
const extraAfterAdd = Object.keys(addedField).filter((k) => !EXPECTED_AGENT_FULL_KEYS.includes(k));
check("(control) adding an unnamed field to a copy of the response IS caught as extra", extraAfterAdd.length === 1 && extraAfterAdd[0] === "newColumnFromTheFuture");

// --- SECOND POSITIVE CONTROL, specific to the property this card guarantees: prove the projectName
// preservation assertion above would actually go RED if the field were dropped — don't just trust a
// green that never had a chance to fail.
const withoutProjectName = { ...sessionFull };
delete withoutProjectName.projectName;
check("(control) a row missing projectName fails the preservation assertion", withoutProjectName.projectName !== "Demo Project");

console.log(failures === 0
  ? "\n✅ ALL PASS — projectAgentList/projectSessionList's full:true key sets are pinned, a future db " +
    "column doesn't leak through a real fixture, projectName/agentName survive the session full:true " +
    "path (the property this card exists to guarantee), the default summary path is unchanged, and the " +
    "assertion logic is itself positive-controlled."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
