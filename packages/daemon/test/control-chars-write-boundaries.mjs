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
//
// RED on main before card e7dabf95: (A) `authorCompanionMemory` wrote the control byte straight into
// MEMORY.md with no rejection; (B)/(C) `insertTask`/`updateTask`/`insertAgent`/`updateAgent` persisted the
// control byte verbatim; (D) `resolvePlatformLeadResumeDocPath` used a raw `fs.copyFileSync`, copying the
// control byte byte-for-byte into the new lineage's file.
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
} finally {
  try { db?.close(); } catch { /* ignore */ }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — companion MEMORY.md rejects an ESC/C0/C1 control byte at authorCompanionMemory (never echoing content); task title/body and agent startupPrompt are silently STRIPPED at the shared db.ts write boundary (insertTask/updateTask/insertAgent/updateAgent), covering both the agent-facing chokepoints and the direct, non-retryable bypasses (appendEscalationDetail-shaped task writes, boot-seeding-shaped agent inserts) that would otherwise skip a higher-layer-only check; and the Platform Lead resume doc's seed-copy strips a poisoned base doc's control bytes instead of a raw byte-for-byte fs.copyFileSync. \\t\\n\\r survive everywhere, and every clean write/copy is unaffected."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
