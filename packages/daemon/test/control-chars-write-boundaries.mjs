import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card e7dabf95 — follow-up to ea5fb00a (project memory's own control-char store boundary): the OTHER
// three agent-writable text stores that reach a session prompt and relied SOLELY on 49b382d9's submit()-
// time strip, plus the Platform Lead resume doc (a file, not a DB store). See
// docs/decisions/e7dabf95-control-chars-at-task-and-agent-write-boundaries.md for the per-store reasoning
// (reject vs strip, and why).
//
// Proves, per store:
//   (A) Companion MEMORY.md (skills/companion-memory-store.ts, authorCompanionMemory) — REJECTS an
//       ESC/C0/C1 byte in `content`, reporting byte class + index, never the surrounding content; \t\n\r
//       survive; a clean write is unaffected.
//   (B) Task title/body (db.ts, insertTask + updateTask) — STRIPS (never rejects) an ESC/C0/C1 byte,
//       including via the exact `appendEscalationDetail`-shaped bypass (a direct db.updateTask call that
//       never goes through the agent-facing updateProjectTask chokepoint) — proving the fix covers the
//       writer ea5fb00a's own "Do not" section warns can't be gated at a higher layer alone.
//   (C) Agent startupPrompt (db.ts, insertAgent + updateAgent) — STRIPS, including via a direct
//       insertAgent call shaped like Loom's own boot-time seeding (which must never throw).
//   (D) Platform Lead resume doc seed-copy (sessions/platform-lead-prompt.ts,
//       resolvePlatformLeadResumeDocPath) — a SECOND (non-primary) lineage's seeded copy of the base doc
//       has its ESC/C0/C1 bytes stripped, never copied byte-for-byte.
//   (E)-(G) Code Review `f19a98e5`'s regression on this card's first commit (a7e3feee): the ENTRY-POINT
//       functions `createProjectTaskChecked`/`updateProjectTask` (mcp/tasks.ts) ran the title guards
//       (checkTitleHtmlEntities/checkTitleConventionalType) on the RAW title, with db.ts's strip happening
//       only later at the actual write — so a control byte hidden INSIDE a would-be-rejected token broke
//       the guard's own regex match, and the later strip then silently reassembled the rejected shape.
//       Proves the exact three reviewer repros are now REJECTED (or, for the duplicate detector, that it
//       receives the STRIPPED title) at both entry points.
//   (H) A real, non-db-direct agent path for startupPrompt — the human REST route (gateway/server.ts,
//       POST /api/agents/:id and POST /api/projects/:id/agents), which shares `validateAgentPatch`/
//       `db.insertAgent`/`db.updateAgent` with every elevated MCP `agent_update`/`agent_create` surface.
//   (I) A real, non-db-direct companion-memory path — the `/internal/test/seed` REST route's
//       `companionMemories` field (gateway/server.ts), which calls `authorCompanionMemory` directly, the
//       SAME function the real `memory_write` MCP tool calls (see that route's own comment).
//
// RED on main before card e7dabf95: (A) `authorCompanionMemory` wrote the control byte straight into
// MEMORY.md with no rejection; (B)/(C) `insertTask`/`updateTask`/`insertAgent`/`updateAgent` persisted the
// control byte verbatim; (D) `resolvePlatformLeadResumeDocPath` used a raw `fs.copyFileSync`, copying the
// control byte byte-for-byte into the new lineage's file.
//
// RED on a7e3feee (this card's first commit, BEFORE the f19a98e5 fix) for (E)-(G): all three reviewer
// repros were silently ACCEPTED (and, for the duplicate case, the detector missed a real duplicate) —
// see each assertion's own comment for the exact pre-fix behavior.
//
// Run after build: node test/control-chars-write-boundaries.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-control-chars-write-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const dbFile = path.join(tmpHome, "control-chars-write.db");
const { Db } = await import("../dist/db.js");
const { companionMemoryDir } = await import("../dist/paths.js");
const { authorCompanionMemory, readCompanionMemory } = await import("../dist/skills/companion-memory-store.js");
const {
  resolvePlatformLeadResumeDocPath, platformLeadBaseResumeDocPath, platformLeadLineageResumeDocPath,
} = await import("../dist/sessions/platform-lead-prompt.js");
const { stripEscapeAndControlChars } = await import("../dist/security/control-chars.js");
const { createProjectTaskChecked, updateProjectTask } = await import("../dist/mcp/tasks.js");
const { buildServer } = await import("../dist/gateway/server.js");

const ESC = "\x1b";
const C0 = "\x07"; // BEL — an ordinary C0 byte, not ESC
const C1 = "\x9b"; // CSI in the C1 range (0x80-0x9F)

let db;
try {
  db = new Db(dbFile);
  const now = new Date().toISOString();
  const projId = randomUUID();
  db.insertProject({ id: projId, name: "Control Chars Write Project", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });

  // ===== (A) Companion MEMORY.md — REJECT =====
  const compSession = "comp-sess-1";
  const rejContent = authorCompanionMemory(compSession, "fact-one", `---\nname: fact-one\ndescription: d\n---\n\nbad${ESC}byte`);
  check("(A1) ESC in content -> rejected", rejContent.ok === false);
  check("(A1) rejection names the byte class", rejContent.ok === false && rejContent.error.includes("ESC"));
  // "byte" legitimately appears in the generic error text ("control byte") — only "bad" (the actual
  // surrounding content) must never appear.
  check("(A1) rejection never echoes the surrounding content", rejContent.ok === false && !rejContent.error.includes("bad"));
  check("(A1) nothing was written to disk", readCompanionMemory(compSession, "fact-one") === null);

  const rejContentC1 = authorCompanionMemory(compSession, "fact-two", `body with a ${C1} byte`);
  check("(A2) C1 in content -> rejected, names C1", rejContentC1.ok === false && rejContentC1.error.includes("C1"));

  const cleanMultiline = authorCompanionMemory(compSession, "fact-three", "line one\nline two\ttabbed\rcr");
  check("(A3) \\t\\n\\r are NOT rejected (ordinary multi-line text)", cleanMultiline.ok === true);
  check("(A3) the clean multiline content is written verbatim", readCompanionMemory(compSession, "fact-three") === "line one\nline two\ttabbed\rcr");

  const cleanWrite = authorCompanionMemory(compSession, "fact-four", "perfectly ordinary content");
  check("(A4) a clean write is unaffected", cleanWrite.ok === true);
  check("(A4) the file actually exists on disk under the companion's own base dir", fs.existsSync(path.join(companionMemoryDir(compSession), "fact-four", "MEMORY.md")));

  // ===== (B) Task title/body — STRIP =====
  const taskId1 = randomUUID();
  db.insertTask({
    id: taskId1, projectId: projId, title: `Bad${ESC}Title`, body: `Bad ${C1} Body`,
    columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now,
  });
  const fetched1 = db.getTask(taskId1);
  check("(B1) insertTask: ESC stripped from title", fetched1.title === "BadTitle" && !fetched1.title.includes(ESC));
  check("(B1) insertTask: C1 stripped from body", fetched1.body === "Bad  Body" && !fetched1.body.includes(C1));

  db.updateTask(taskId1, { title: `Updated${C0}Title` });
  const fetched2 = db.getTask(taskId1);
  check("(B2) updateTask: C0 stripped from title", fetched2.title === "UpdatedTitle" && !fetched2.title.includes(C0));
  check("(B2) updateTask: body untouched by a title-only patch", fetched2.body === fetched1.body);

  // The exact appendEscalationDetail shape: a direct db.updateTask({body}) call that bypasses the
  // agent-facing updateProjectTask chokepoint entirely.
  db.updateTask(taskId1, { body: `## Re-escalation — now\n\n- **Severity:** high\n\n${ESC}payload here` });
  const fetched3 = db.getTask(taskId1);
  check("(B3) updateTask (direct, bypassing updateProjectTask): ESC stripped from an appended-escalation-shaped body",
    !fetched3.body.includes(ESC) && fetched3.body.includes("payload here"));

  const taskId2 = randomUUID();
  db.insertTask({
    id: taskId2, projectId: projId, title: "line one\nline two\ttabbed", body: "multi\nline\r\nbody",
    columnKey: "backlog", position: 2, priority: "p2", createdAt: now, updatedAt: now,
  });
  const fetched4 = db.getTask(taskId2);
  check("(B4) \\t\\n\\r in title/body are NOT stripped", fetched4.title === "line one\nline two\ttabbed" && fetched4.body === "multi\nline\r\nbody");

  const taskId3 = randomUUID();
  db.insertTask({
    id: taskId3, projectId: projId, title: "Perfectly Clean Title", body: "perfectly clean body",
    columnKey: "backlog", position: 3, priority: "p2", createdAt: now, updatedAt: now,
  });
  const fetched5 = db.getTask(taskId3);
  check("(B5) a clean title/body is unaffected", fetched5.title === "Perfectly Clean Title" && fetched5.body === "perfectly clean body");

  // A field-only move (no title/body in the patch) must never touch the stored, already-clean title/body.
  db.updateTask(taskId3, { columnKey: "backlog", position: 99 });
  const fetched6 = db.getTask(taskId3);
  check("(B6) a field-only patch (no title/body) leaves title/body untouched", fetched6.title === "Perfectly Clean Title" && fetched6.body === "perfectly clean body");

  // ===== (C) Agent startupPrompt — STRIP =====
  const agentId1 = randomUUID();
  db.insertAgent({ id: agentId1, projectId: projId, name: "Test Agent", startupPrompt: `You are helpful.${ESC}\nDo X.`, position: 0 });
  const fetchedAgent1 = db.getAgent(agentId1);
  check("(C1) insertAgent: ESC stripped from startupPrompt", !fetchedAgent1.startupPrompt.includes(ESC) && fetchedAgent1.startupPrompt === "You are helpful.\nDo X.");

  db.updateAgent(agentId1, { startupPrompt: `Revised prompt with a ${C1} byte in it.` });
  const fetchedAgent2 = db.getAgent(agentId1);
  check("(C2) updateAgent: C1 stripped from startupPrompt", !fetchedAgent2.startupPrompt.includes(C1) && fetchedAgent2.startupPrompt === "Revised prompt with a  byte in it.");

  // A boot-seeding-shaped insertAgent call (mirrors platform/seed.ts / setup/seed.ts: a raw insertAgent,
  // no MCP surface involved) must not throw even when it happens to carry a control byte.
  const agentId2 = randomUUID();
  let bootSeedThrew = false;
  try {
    db.insertAgent({ id: agentId2, projectId: projId, name: "Seeded Agent", startupPrompt: `Seeded${C0}prompt`, position: 1 });
  } catch {
    bootSeedThrew = true;
  }
  check("(C3) a boot-seeding-shaped insertAgent call with a control byte never throws", !bootSeedThrew);
  check("(C3) and the byte is stripped, not silently persisted", db.getAgent(agentId2).startupPrompt === "Seededprompt");

  const agentId3 = randomUUID();
  db.insertAgent({ id: agentId3, projectId: projId, name: "Clean Agent", startupPrompt: "line one\nline two\ttabbed\rcr", position: 2 });
  check("(C4) \\t\\n\\r in startupPrompt are NOT stripped", db.getAgent(agentId3).startupPrompt === "line one\nline two\ttabbed\rcr");

  db.updateAgent(agentId3, { name: "Renamed Clean Agent" });
  check("(C5) a name-only patch leaves startupPrompt untouched", db.getAgent(agentId3).startupPrompt === "line one\nline two\ttabbed\rcr");

  // ===== (D) Platform Lead resume doc seed-copy — STRIP =====
  const leadHome = path.join(tmpHome, "lead-home");
  fs.mkdirSync(leadHome, { recursive: true });
  const poisonedBaseContent = `# Platform Lead Resume\n\nSome notes.${ESC}[2J${C1}more.`;
  fs.writeFileSync(platformLeadBaseResumeDocPath(leadHome), poisonedBaseContent);

  const primaryLineage = randomUUID();
  const primaryPath = resolvePlatformLeadResumeDocPath(db, leadHome, primaryLineage);
  check("(D1) the FIRST lineage claims the base file (no seed copy happens)", primaryPath === platformLeadBaseResumeDocPath(leadHome));

  const secondLineage = randomUUID();
  const secondPath = resolvePlatformLeadResumeDocPath(db, leadHome, secondLineage);
  check("(D2) a SECOND lineage gets its own per-lineage file", secondPath === platformLeadLineageResumeDocPath(leadHome, secondLineage));
  check("(D2) that file was actually seeded (exists on disk)", fs.existsSync(secondPath));

  const seededContent = fs.readFileSync(secondPath, "utf8");
  const expectedClean = stripEscapeAndControlChars(poisonedBaseContent).text;
  check("(D3) the seeded copy's ESC byte was stripped (never a raw byte-for-byte copy)", !seededContent.includes(ESC));
  check("(D3) the seeded copy's C1 byte was stripped", !seededContent.includes(C1));
  check("(D3) the seeded copy matches the base content run through the SAME strip helper", seededContent === expectedClean);
  check("(D3) the printable parts of the base content survive (this is a strip, not a wipe)", seededContent.includes("Platform Lead Resume") && seededContent.includes("Some notes.") && seededContent.includes("more."));

  // A THIRD lineage whose base doc is perfectly clean must be byte-identical (never a lossy strip on
  // content that had nothing to strip).
  const thirdLineage = randomUUID();
  fs.writeFileSync(platformLeadBaseResumeDocPath(leadHome), "# Clean Resume\n\nAll good here.\n");
  // Force a fresh per-lineage path by using a different home so the base file's mtime/content genuinely
  // reflects this section — reuse leadHome (base file was just overwritten above, lineage file didn't exist yet).
  const thirdPath = resolvePlatformLeadResumeDocPath(db, leadHome, thirdLineage);
  check("(D4) a clean base doc is seeded byte-identical", fs.readFileSync(thirdPath, "utf8") === "# Clean Resume\n\nAll good here.\n");

  // ===== (E) createProjectTaskChecked — title-guard-ordering regression (Code Review f19a98e5) =====
  // Pre-fix (a7e3feee): the raw title "fea\x01ture(x): y" has NO type-shaped prefix (the \x01 breaks
  // TYPE_PREFIXED_TITLE_RE's contiguous match), so checkTitleConventionalType saw nothing to reject and
  // the card was CREATED — then db.ts's strip silently reassembled "feature(x): y", a bogus (unrecognized)
  // conventional type that would ship to main verbatim on a solo squash merge, with no merge-time backstop.
  const badType = createProjectTaskChecked(db, projId, { title: `fea${C0}ture(x): y` });
  check("(E1) a control byte hidden inside a bogus conventional-type prefix is now REJECTED",
    "error" in badType && !("id" in badType));
  check("(E1) the rejection is the type-guard's own (post-strip 'feature' is not a recognized type)",
    "error" in badType && badType.error.includes("feature") && badType.error.includes("not a recognized Conventional Commits type"));

  // Pre-fix: the raw title "fix(web): a &\x1bamp; b" has no CONTIGUOUS "&amp;" (the ESC breaks it), so
  // checkTitleHtmlEntities saw nothing to reject and the card was CREATED — then db.ts's strip silently
  // reassembled a real "&amp;" HTML entity into the stored, permanent title.
  const badEntity = createProjectTaskChecked(db, projId, { title: `fix(web): a &${ESC}amp; b` });
  check("(E2) a control byte hidden inside a would-be HTML entity is now REJECTED",
    "error" in badEntity && !("id" in badEntity));
  check("(E2) the rejection is the HTML-entity guard's own (post-strip '&amp;' is a real entity)",
    "error" in badEntity && badEntity.error.includes("&amp;") && badEntity.error.includes("HTML entity"));

  // Pre-fix: a title of just ESC has no type prefix and no HTML entity, so both guards passed and the
  // card was CREATED — then db.ts's strip reduced it to an EMPTY title, stored as "".
  const allControlTitle = createProjectTaskChecked(db, projId, { title: ESC });
  check("(E3) a title that is ALL control/escape bytes is now REJECTED (never silently stored as empty)",
    "error" in allControlTitle && !("id" in allControlTitle));
  check("(E3) the rejection names the empty-after-strip reason", "error" in allControlTitle && allControlTitle.error.includes("empty"));

  // A genuinely clean, already-valid conventional title is unaffected — this is a rejection of the
  // exploit shape, not new friction on ordinary titles.
  const goodCreate = createProjectTaskChecked(db, projId, { title: "fix(daemon): a perfectly normal title" });
  check("(E4) a clean, valid conventional title still succeeds", !("error" in goodCreate) && goodCreate.title === "fix(daemon): a perfectly normal title");

  // ===== (F) updateProjectTask — the SAME title-guard-ordering regression, on the update path =====
  // Each case gets its OWN fresh task with its OWN correct baseVersion: reusing one task/version across
  // cases would let an earlier case's unrejected write (a false PASS on the buggy code) advance the row's
  // real version, so a LATER case's call with the now-stale `toUpdate.version` hits a version CONFLICT
  // instead of the title guard — a false PASS for the wrong reason, masking the exact regression being
  // tested. Independent fixtures make each assertion discriminate on the title guard alone.
  const seedF1 = createProjectTaskChecked(db, projId, { title: "fix(daemon): F1 seed title" });
  const badTypeUpdate = await updateProjectTask(db, projId, seedF1.id, { title: `fea${C0}ture(x): y` }, undefined, seedF1.version);
  check("(F1) updateProjectTask: hidden-byte bogus conventional type is now REJECTED", "error" in badTypeUpdate);
  check("(F1) the row is untouched by the rejected attempt", db.getTask(seedF1.id).title === "fix(daemon): F1 seed title");

  const seedF2 = createProjectTaskChecked(db, projId, { title: "fix(daemon): F2 seed title" });
  const badEntityUpdate = await updateProjectTask(db, projId, seedF2.id, { title: `fix(web): a &${ESC}amp; b` }, undefined, seedF2.version);
  check("(F2) updateProjectTask: hidden-byte HTML entity is now REJECTED", "error" in badEntityUpdate);
  check("(F2) the row is untouched by the rejected attempt", db.getTask(seedF2.id).title === "fix(daemon): F2 seed title");

  const seedF3 = createProjectTaskChecked(db, projId, { title: "fix(daemon): F3 seed title" });
  const allControlUpdate = await updateProjectTask(db, projId, seedF3.id, { title: ESC }, undefined, seedF3.version);
  check("(F3) updateProjectTask: an all-control-byte title is now REJECTED, never stored empty", "error" in allControlUpdate && allControlUpdate.error.includes("empty"));
  check("(F3) the row is untouched by the rejected attempt", db.getTask(seedF3.id).title === "fix(daemon): F3 seed title");

  const seedF4 = createProjectTaskChecked(db, projId, { title: "fix(daemon): F4 seed title" });
  const goodUpdate = await updateProjectTask(db, projId, seedF4.id, { title: "fix(daemon): a clean revised title" }, undefined, seedF4.version);
  check("(F4) a clean title update still succeeds", !("error" in goodUpdate) && db.getTask(seedF4.id).title === "fix(daemon): a clean revised title");

  // ===== (G) the duplicate detector (findSuspectedDuplicate) receives the STRIPPED title, not the raw one =====
  // Pre-fix: `coreInput.title` (fed to findSuspectedDuplicate) was the RAW, unstripped title — a control
  // byte hidden INSIDE a strong identifier (a UUID) breaks STRONG_PATTERNS' contiguous match, so the
  // detector would see NO shared identifier and miss a real duplicate.
  const sharedUuid = randomUUID();
  const dupBase = createProjectTaskChecked(db, projId, { title: `Investigate crash in session ${sharedUuid}` });
  check("(G setup) base task (carrying the real, clean UUID) created cleanly", !("error" in dupBase));

  const brokenUuid = `${sharedUuid.slice(0, 8)}${ESC}${sharedUuid.slice(8)}`;
  const dupCandidate = createProjectTaskChecked(db, projId, { title: `Investigate crash in session ${brokenUuid}` });
  check("(G1) the second create itself succeeds (a hidden ESC inside a UUID is not itself a guard violation)", !("error" in dupCandidate));
  check("(G2) the stored title's UUID is the CLEAN one (ESC stripped) — same UUID as the base task's",
    dupCandidate.title === `Investigate crash in session ${sharedUuid}`);
  check("(G3) the duplicate detector matched on the (stripped) shared UUID — 'related' is populated, naming the base task",
    dupCandidate.related !== undefined && dupCandidate.related.taskId === dupBase.id);

  // ===== (H) a REAL, non-db-direct agent path for startupPrompt: the human REST route, which shares
  // validateAgentPatch/db.insertAgent/db.updateAgent with every elevated MCP agent_update/agent_create
  // surface (see docs/decisions/e7dabf95-....md §3). Should already be GREEN on a7e3feee — no ordering bug
  // exists for this store (no pre-storage guard runs on startupPrompt at all, see §2a's "Scope" note). =====
  const stub = {};
  const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });
  const restCreateRes = await app.inject({
    method: "POST",
    url: `/api/projects/${projId}/agents`,
    payload: { name: "REST Agent", startupPrompt: `You are helpful.${ESC}\nDo X.` },
  });
  check("(H1) REST agent create with a control byte in startupPrompt -> 201 (never rejected)", restCreateRes.statusCode === 201);
  const restCreatedAgent = JSON.parse(restCreateRes.body);
  check("(H1) the stored startupPrompt is STRIPPED, via the real REST entry point", restCreatedAgent.startupPrompt === "You are helpful.\nDo X.");

  const restUpdateRes = await app.inject({
    method: "POST",
    url: `/api/agents/${restCreatedAgent.id}`,
    payload: { startupPrompt: `Revised with a ${C1} byte.` },
  });
  check("(H2) REST agent update with a control byte -> 200", restUpdateRes.statusCode === 200);
  check("(H2) the stored startupPrompt is STRIPPED, via the real REST entry point", db.getAgent(restCreatedAgent.id).startupPrompt === "Revised with a  byte.");

  // ===== (I) a REAL, non-db-direct companion-memory path: the /internal/test/seed REST route's
  // companionMemories field, which calls authorCompanionMemory DIRECTLY (gateway/server.ts's own comment:
  // "the same writer the companion's own memory_author MCP tool calls"). Should already be GREEN on
  // a7e3feee — no ordering bug exists for this store (REJECT happens before any write, see §1). =====
  const seedRejRes = await app.inject({
    method: "POST",
    url: "/internal/test/seed",
    payload: { companionMemories: [{ sessionId: "comp-sess-seed", name: "seeded-fact", content: `bad ${ESC} content` }] },
  });
  check("(I1) seeding a companion memory with a control byte -> 400 (not 200, not 500)", seedRejRes.statusCode === 400);
  check("(I1) the 400 body names the byte class", JSON.parse(seedRejRes.body).error?.includes("ESC"));
  check("(I1) nothing was written to disk", readCompanionMemory("comp-sess-seed", "seeded-fact") === null);

  const seedCleanRes = await app.inject({
    method: "POST",
    url: "/internal/test/seed",
    payload: { companionMemories: [{ sessionId: "comp-sess-seed", name: "seeded-fact", content: "perfectly clean seeded content" }] },
  });
  check("(I2) seeding a clean companion memory -> 201, still works", seedCleanRes.statusCode === 201);
  check("(I2) the clean seeded memory IS written", readCompanionMemory("comp-sess-seed", "seeded-fact") === "perfectly clean seeded content");
} finally {
  try { db?.close(); } catch { /* ignore */ }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — companion MEMORY.md rejects an ESC/C0/C1 control byte at authorCompanionMemory (never echoing content); task title/body and agent startupPrompt are silently STRIPPED at the shared db.ts write boundary (insertTask/updateTask/insertAgent/updateAgent), covering both the agent-facing chokepoints and the direct, non-retryable bypasses (appendEscalationDetail-shaped task writes, boot-seeding-shaped agent inserts) that would otherwise skip a higher-layer-only check; the Platform Lead resume doc's seed-copy strips a poisoned base doc's control bytes instead of a raw byte-for-byte fs.copyFileSync; createProjectTaskChecked/updateProjectTask now strip a title BEFORE the HTML-entity/conventional-type guards run (and before the duplicate detector sees it), closing the guard-ordering regression Code Review f19a98e5 found in this card's first commit; and a real REST entry point per store (agent create/update, companion-memory seed) confirms the fix reaches through more than a direct Db call. \\t\\n\\r survive everywhere, and every clean write/copy/create/update is unaffected."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
