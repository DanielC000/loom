import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Preset Prompt SUGGESTIONS — the "Suggested from your usage" store + its deduped write, lifecycle,
// REST, and the role-gated preset_suggestion_suggest MCP tool. HERMETIC + CLAUDE-FREE + NETWORK-FREE,
// in the style of preset-prompts.mjs + audit-surface.mjs:
//   • PART A — the Db methods directly: a fresh suggest INSERTS a pending row (list = pending only,
//     ordered); DEDUPE is a no-op across ALL THREE sources — (a) an existing preset_prompts row,
//     (b) an existing PENDING suggestion, (c) an existing DISMISSED/ADOPTED suggestion (no re-nag);
//     adopt → mints a real preset + marks the suggestion adopted (kept, drops off the pending list);
//     dismiss → marks dismissed (kept); both 404-shaped (undefined/false) on a missing id.
//   • PART B — the REST routes through the REAL buildServer via app.inject: GET (pending only), POST
//     (201 fresh / 200 deduped / 400 invalid), adopt (201 preset / 404 missing), dismiss (200 / 404).
//   • PART C — the role-gated MCP tool: an "auditor" session reaches preset_suggestion_suggest over an
//     in-process MCP transport; it inserts when novel + dedupes when not; a manager/worker session gets
//     NO audit surface (resolveRole null) so it can never reach the tool.
// Run: 1) build (turbo builds shared first), 2) node test/preset-prompt-suggestions.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hermetic LOOM_HOME (+ a sandboxed HOME) set BEFORE importing dist (paths.ts reads LOOM_HOME at import).
const tmpHome = path.join(os.tmpdir(), `loom-preset-suggestions-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = "45394";
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows
process.env.HOME = sandboxHome;        // POSIX

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { AuditMcpRouter } = await import("../dist/mcp/audit.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

try {
  // ====================================================================================================
  // PART A — the Db methods directly
  // ====================================================================================================
  const db = new Db(path.join(tmpHome, "a.db"));
  check("A list is empty on a fresh store", db.listPresetPromptSuggestions().length === 0);

  // a fresh, novel suggestion INSERTS a pending row
  const r1 = db.suggestPresetPrompt({ label: "Run tests", prompt: "Run the test suite.", rationale: "typed 5×" });
  check("A suggest (novel) returns {deduped:false, suggestion}", r1.deduped === false && !!r1.suggestion);
  check("A suggest mints id + timestamps + status pending + carries rationale",
    typeof r1.suggestion.id === "string" && r1.suggestion.status === "pending" && r1.suggestion.rationale === "typed 5×" &&
    typeof r1.suggestion.createdAt === "string" && typeof r1.suggestion.updatedAt === "string");
  const r2 = db.suggestPresetPrompt({ label: "Commit", prompt: "Commit and report SHA." });
  check("A second novel suggest APPENDS ascending positions (0,1)", r1.suggestion.position === 0 && r2.suggestion.position === 1);
  check("A rationale defaults to null when omitted", r2.suggestion.rationale === null);

  const pendingList = db.listPresetPromptSuggestions();
  check("A list returns pending rows, ordered by position", pendingList.length === 2 && pendingList[0].id === r1.suggestion.id && pendingList[1].id === r2.suggestion.id);

  // DEDUPE source (b): an existing PENDING suggestion with the same (trimmed) prompt → no-op
  const dupPending = db.suggestPresetPrompt({ label: "Run tests again", prompt: "  Run the test suite.  ", rationale: "noticed again" });
  check("A dedupe source (b) — matches an existing PENDING suggestion (trim-normalized) → no-op", dupPending.deduped === true && typeof dupPending.reason === "string");
  check("A dedupe (b) inserted nothing", db.listPresetPromptSuggestions().length === 2);

  // DEDUPE source (a): an existing preset_prompts row with the same prompt → no-op
  db.createPresetPrompt({ label: "Build", prompt: "pnpm build" });
  const dupPreset = db.suggestPresetPrompt({ label: "Build it", prompt: "  pnpm build  " });
  check("A dedupe source (a) — matches an existing preset_prompts row → no-op", dupPreset.deduped === true);
  check("A dedupe (a) inserted nothing", db.listPresetPromptSuggestions().length === 2);

  // adopt → mints a real preset, marks the suggestion adopted (kept; drops off the pending list)
  const presetsBefore = db.listPresetPrompts().length;
  const adopted = db.adoptPresetPromptSuggestion(r1.suggestion.id);
  check("A adopt mints a real preset from label+prompt", adopted && adopted.label === "Run tests" && adopted.prompt === "Run the test suite.");
  check("A adopt added exactly one preset", db.listPresetPrompts().length === presetsBefore + 1);
  check("A adopt marks the suggestion adopted (off the pending list)", db.getPresetPromptSuggestion(r1.suggestion.id).status === "adopted" && !db.listPresetPromptSuggestions().some((s) => s.id === r1.suggestion.id));
  check("A adopt on a missing id → undefined", db.adoptPresetPromptSuggestion("does-not-exist") === undefined);
  let reAdoptThrew = false;
  try { db.adoptPresetPromptSuggestion(r1.suggestion.id); } catch { reAdoptThrew = true; }
  check("A re-adopting a non-pending suggestion throws", reAdoptThrew);

  // dismiss → marks dismissed (kept)
  const dismissed = db.dismissPresetPromptSuggestion(r2.suggestion.id);
  check("A dismiss returns true + marks dismissed (off the pending list)", dismissed === true && db.getPresetPromptSuggestion(r2.suggestion.id).status === "dismissed" && db.listPresetPromptSuggestions().length === 0);
  check("A dismiss on a missing id → false", db.dismissPresetPromptSuggestion("nope") === false);

  // DEDUPE source (c): the prompt now lives ONLY as an adopted + a dismissed suggestion — still a no-op
  const dupAdopted = db.suggestPresetPrompt({ label: "x", prompt: "Run the test suite." });
  check("A dedupe source (c1) — matches an ADOPTED suggestion → no-op (no re-nag)", dupAdopted.deduped === true);
  const dupDismissed = db.suggestPresetPrompt({ label: "y", prompt: "Commit and report SHA." });
  check("A dedupe source (c2) — matches a DISMISSED suggestion → no-op (no re-nag)", dupDismissed.deduped === true);
  check("A all three dedupe sources inserted nothing", db.listPresetPromptSuggestions().length === 0);
  db.close();

  // ====================================================================================================
  // PART B — the REST routes via the REAL buildServer (every non-db dep stubbed; app.inject, no network)
  // ====================================================================================================
  const dbB = new Db(path.join(tmpHome, "b.db"));
  const stub = {};
  const app = await buildServer({ db: dbB, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });

  const empty = await app.inject({ method: "GET", url: "/api/preset-prompt-suggestions" });
  check("B GET empty → 200 []", empty.statusCode === 200 && Array.isArray(empty.json()) && empty.json().length === 0);

  const c1 = await app.inject({ method: "POST", url: "/api/preset-prompt-suggestions", payload: { label: "Run tests", prompt: "Run the suite.", rationale: "typed often" } });
  check("B POST (novel) → 201 with {id,status:pending,rationale}",
    c1.statusCode === 201 && typeof c1.json().id === "string" && c1.json().status === "pending" && c1.json().rationale === "typed often" && c1.json().position === 0);
  const id1 = c1.json().id;

  // dedupe via REST → 200 {deduped:true}
  const dup = await app.inject({ method: "POST", url: "/api/preset-prompt-suggestions", payload: { label: "Run tests 2", prompt: "  Run the suite.  " } });
  check("B POST (dup) → 200 {deduped:true,reason}", dup.statusCode === 200 && dup.json().deduped === true && typeof dup.json().reason === "string");
  const afterDup = await app.inject({ method: "GET", url: "/api/preset-prompt-suggestions" });
  check("B deduped POST created nothing", afterDup.json().length === 1);

  // 400s: missing/blank/oversized fields + bad rationale type
  const noPrompt = await app.inject({ method: "POST", url: "/api/preset-prompt-suggestions", payload: { label: "L" } });
  check("B POST missing prompt → 400", noPrompt.statusCode === 400);
  const blankLabel = await app.inject({ method: "POST", url: "/api/preset-prompt-suggestions", payload: { label: "  ", prompt: "p" } });
  check("B POST blank label → 400", blankLabel.statusCode === 400);
  const badRationale = await app.inject({ method: "POST", url: "/api/preset-prompt-suggestions", payload: { label: "L", prompt: "fresh prompt", rationale: 42 } });
  check("B POST non-string rationale → 400", badRationale.statusCode === 400);

  // dismiss → 200; missing id → 404
  const d1 = await app.inject({ method: "POST", url: `/api/preset-prompt-suggestions/${id1}/dismiss` });
  check("B dismiss → 200 {ok:true}", d1.statusCode === 200 && d1.json().ok === true);
  check("B dismiss drops it off the pending list", (await app.inject({ method: "GET", url: "/api/preset-prompt-suggestions" })).json().length === 0);
  const dismiss404 = await app.inject({ method: "POST", url: "/api/preset-prompt-suggestions/nope/dismiss" });
  check("B dismiss unknown id → 404", dismiss404.statusCode === 404);

  // adopt → 201 with the created preset; missing id → 404
  const c2 = await app.inject({ method: "POST", url: "/api/preset-prompt-suggestions", payload: { label: "Commit", prompt: "Commit & push." } });
  const adoptRes = await app.inject({ method: "POST", url: `/api/preset-prompt-suggestions/${c2.json().id}/adopt` });
  check("B adopt → 201 with the created preset", adoptRes.statusCode === 201 && adoptRes.json().label === "Commit" && adoptRes.json().prompt === "Commit & push.");
  const presets = await app.inject({ method: "GET", url: "/api/preset-prompts" });
  check("B adopt created a real preset", presets.json().length === 1 && presets.json()[0].prompt === "Commit & push.");
  const adopt404 = await app.inject({ method: "POST", url: "/api/preset-prompt-suggestions/nope/adopt" });
  check("B adopt unknown id → 404", adopt404.statusCode === 404);

  // 409: a non-pending id (stale list / double-click) — re-adopt an adopted one, re-dismiss a dismissed one.
  const reAdopt = await app.inject({ method: "POST", url: `/api/preset-prompt-suggestions/${c2.json().id}/adopt` });
  check("B re-adopt an already-adopted id → 409 with error", reAdopt.statusCode === 409 && typeof reAdopt.json().error === "string");
  const reDismiss = await app.inject({ method: "POST", url: `/api/preset-prompt-suggestions/${id1}/dismiss` });
  check("B re-dismiss an already-dismissed id → 409 with error", reDismiss.statusCode === 409 && typeof reDismiss.json().error === "string");
  // adopting an already-DISMISSED id (and dismissing an already-ADOPTED id) is likewise a 409, not a 500.
  const adoptDismissed = await app.inject({ method: "POST", url: `/api/preset-prompt-suggestions/${id1}/adopt` });
  check("B adopt an already-dismissed id → 409 (not 500)", adoptDismissed.statusCode === 409);

  await app.close();
  dbB.close();

  // ====================================================================================================
  // PART C — the role-gated MCP tool (preset_suggestion_suggest), driven over an in-process transport
  // ====================================================================================================
  const dbC = new Db(path.join(tmpHome, "c.db"));
  const now = new Date().toISOString();
  dbC.insertProject({ id: "p", name: "Proj", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });
  dbC.insertAgent({ id: "a", projectId: "p", name: "Agent", startupPrompt: "GO", position: 0, profileId: null });
  const seedSession = (id, role) => dbC.insertSession({
    id, projectId: "p", agentId: "a", engineSessionId: null, title: null, cwd: tmpHome,
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role, parentSessionId: null,
  });
  seedSession("AUD", "auditor");
  seedSession("MGR", "manager");
  seedSession("WRK", "worker");
  const auditRouter = new AuditMcpRouter(dbC, {}); // sessions stub — preset_suggestion_suggest only uses db

  // Role gate: ONLY the auditor session has the surface.
  check("C audit router: auditor session HAS the surface", !!auditRouter.resolveRole("AUD"));
  check("C audit router: manager gets NO audit surface (can't reach the tool)", auditRouter.resolveRole("MGR") === null);
  check("C audit router: worker gets NO audit surface (can't reach the tool)", auditRouter.resolveRole("WRK") === null);

  const server = auditRouter.buildServer("AUD");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "preset-suggest-test", version: "0" });
  await client.connect(clientT);
  const parse = (res) => JSON.parse(res.content[0].text);
  const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));

  const tools = (await client.listTools()).tools.map((t) => t.name);
  check("C preset_suggestion_suggest is on the auditor surface", tools.includes("preset_suggestion_suggest"));

  const novel = await call("preset_suggestion_suggest", { label: "Lint", prompt: "Run the linter.", rationale: "typed 4×" });
  check("C tool (novel) → {created:true,id}", novel.created === true && typeof novel.id === "string");
  check("C tool inserted a pending suggestion", dbC.listPresetPromptSuggestions().some((s) => s.id === novel.id && s.rationale === "typed 4×"));

  const dupTool = await call("preset_suggestion_suggest", { label: "Lint again", prompt: "  Run the linter.  " });
  check("C tool (dup) → {deduped:true,reason} — hostile-transcript spam guard", dupTool.deduped === true && typeof dupTool.reason === "string");
  check("C tool dedupe inserted nothing", dbC.listPresetPromptSuggestions().filter((s) => s.prompt.trim() === "Run the linter.").length === 1);

  await client.close();
  dbC.close();
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { await sleep(50); } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Preset Prompt Suggestions: db suggest-dedupes across all three sources (existing preset / pending / adopted+dismissed suggestion), adopt mints a real preset, dismiss keeps the row, the REST surface (list pending / dedupe-guarded POST / adopt / dismiss with 404s), and the role-gated preset_suggestion_suggest MCP tool (auditor-only, deduped) — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
