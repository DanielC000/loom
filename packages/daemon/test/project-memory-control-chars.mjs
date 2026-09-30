import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card ea5fb00a — defense-in-depth for project memory: since project memory is injected verbatim into
// EVERY future kickoff (retrieveProjectMemoryForKickoff/appendMemoryRecallToStartupPrompt), an ESC/C0/C1
// control byte written to it today is untrusted content in tomorrow's prompt. Card 49b382d9 already
// strips these bytes at the submit() chokepoint (defense #1); this card REJECTS them at the memory
// STORE boundary (defense #2, independent of #1) — `Db.upsertProjectMemory` (db.ts), the ONE function
// every writer funnels through: the checked memory_write MCP path (upsertProjectMemoryChecked) and the
// raw e2e test-seed REST route (gateway/server.ts's /internal/test/seed) both call it directly, so a
// check placed here can't be skipped by either.
//
// Proves, in order:
//   (1) the DB-layer boundary (Db.upsertProjectMemory) rejects ESC/C0/C1 in text/title/tags/triggerGlob/
//       key/requestIds, reporting byte class + character index — never the offending bytes or content;
//   (2) `\t`/`\n`/`\r` are NOT rejected (ordinary multi-line text survives, matching 49b382d9's own
//       carve-out — the two mechanisms share one classification, security/control-chars.ts);
//   (3) upsertProjectMemoryChecked surfaces the SAME rejection, discriminable from a version conflict;
//   (4) the memory_write MCP tool's business logic (writeProjectMemory, mcp/memory.ts) rejects the same
//       way for title/tags (fields KEY_RE does NOT already cover) — and that a control byte in `key`
//       specifically is ALREADY caught upstream by the pre-existing KEY_RE format check, with a DIFFERENT
//       message, before it would ever reach the new DB-layer check;
//   (5) the raw e2e test-seed REST route (gateway/server.ts) — which bypasses mcp/memory.ts entirely —
//       still rejects via the SAME DB-layer boundary, proving no writer can skip it;
//   (6) a clean (control-byte-free) write on every path still succeeds — this is a REJECTION, not a
//       tightening of what's normally accepted;
//   (7) RENDER-time defense (project-memory-request-links.ts's annotateRequestLink): a `requestIds` entry
//       that reached the row BEFORE this check existed (a legacy row, simulated here via a raw connection
//       that bypasses Db entirely) still renders SAFELY — the control byte is stripped, never echoed into
//       the annotation line the kickoff digest and memory_read/memory_list both surface.
//
// Card 9f02dee5 (Code Review of 4bf8369e) found the ORIGINAL version of this card's `requestIds` exclusion
// was WRONG: `annotateRequestLink` interpolates a linked id's raw string directly into its rendered
// "not found" line, reachable by construction for ANY control-byte-bearing id (such an id can never
// resolve to a real Request). Checks (1)/(7) close that gap — RED on 4bf8369e (requestIds accepted with
// no rejection at the store, and its control byte reached the rendered annotation line unstripped).
//
// RED on main before card ea5fb00a (Db.upsertProjectMemory had no such check at all — every assertion
// below that checks for `rejected`/400 would instead see the control byte written straight into the row
// and echoed back in the entry, and `writeProjectMemory`/the seed route would both return 200/ok).
//
// Run after build: node test/project-memory-control-chars.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-pm-control-chars-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = "45362";

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const dbFile = path.join(tmpHome, "control-chars.db");
const { Db } = await import("../dist/db.js");
const { writeProjectMemory } = await import("../dist/mcp/memory.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { findControlCharViolation, stripEscapeAndControlChars } = await import("../dist/security/control-chars.js");
const { annotateRequestLink, annotateRequestLinks } = await import("../dist/sessions/project-memory-request-links.js");

let db;
try {
  db = new Db(dbFile);
  const now = new Date().toISOString();
  const projId = randomUUID();
  db.insertProject({ id: projId, name: "Control Chars Project", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });

  const ESC = "\x1b";
  const C0 = "\x07"; // BEL — an ordinary C0 byte, not ESC
  const C1 = "\x9b"; // CSI in the C1 range (0x80-0x9F)

  // ===== (0) shared-module sanity: the classification is exactly 49b382d9's own carve-out =====
  check("(0) findControlCharViolation: clean text -> null", findControlCharViolation("all clean, no bytes here") === null);
  check("(0) findControlCharViolation: \\t\\n\\r survive (not violations)", findControlCharViolation("a\tb\nc\rd") === null);
  const escViolation = findControlCharViolation(`abc${ESC}def`);
  check("(0) findControlCharViolation: classifies ESC correctly", escViolation?.byteClass === "ESC" && escViolation?.index === 3);
  const c1Violation = findControlCharViolation(`abc${C1}def`);
  check("(0) findControlCharViolation: classifies C1 correctly", c1Violation?.byteClass === "C1" && c1Violation?.index === 3);
  const stripped = stripEscapeAndControlChars(`x${ESC}y${C0}z`);
  check("(0) stripEscapeAndControlChars: strips both classes, counts them", stripped.text === "xyz" && stripped.escCount === 1 && stripped.c0Count === 1);

  // ===== (1) DB-layer boundary: Db.upsertProjectMemory rejects per free-text field =====
  const rejText = db.upsertProjectMemory(projId, { key: "note-1", text: `hello ${ESC} world` }, 500);
  check("(1) ESC in text -> rejected", "rejected" in rejText && rejText.rejected === true);
  check("(1) rejection names field=text, byteClass=ESC", rejText.field === "text" && rejText.byteClass === "ESC");
  check("(1) rejection error string never echoes the surrounding content", !rejText.error.includes("hello") && !rejText.error.includes("world"));

  const rejKey = db.upsertProjectMemory(projId, { key: `bad${C1}key`, text: "clean text" }, 500);
  check("(2) C1 in key -> rejected, field=key (the raw-writer path KEY_RE never sees)", "rejected" in rejKey && rejKey.field === "key" && rejKey.byteClass === "C1");

  const rejTitle = db.upsertProjectMemory(projId, { key: "note-2", title: `Title${C0}Bad`, text: "clean text" }, 500);
  check("(3) C0 (non-ESC) in title -> rejected, field=title, byteClass=C0", "rejected" in rejTitle && rejTitle.field === "title" && rejTitle.byteClass === "C0");

  const rejTags = db.upsertProjectMemory(projId, { key: "note-3", text: "clean text", tags: ["ok-tag", `bad${ESC}tag`] }, 500);
  check("(4) ESC in a tags[] entry -> rejected, field=tags", "rejected" in rejTags && rejTags.field === "tags" && rejTags.byteClass === "ESC");

  const rejTrigger = db.upsertProjectMemory(projId, { key: "note-4", text: "clean text", triggerGlob: `packages/${C1}/**` }, 500);
  check("(5) C1 in triggerGlob -> rejected, field=triggerGlob", "rejected" in rejTrigger && rejTrigger.field === "triggerGlob");

  // ===== (5b) card 9f02dee5 (Code Review correction): ESC in a requestIds[] entry -> rejected at the
  // store boundary. `requestIds` is a free-text injection surface too (annotateRequestLink renders a
  // linked id's raw string DIRECTLY into its "not found" line for any id that doesn't resolve — see (7)
  // below) — NOT the opaque-id exception this card originally, wrongly, assumed. =====
  const rejRequestIds = db.upsertProjectMemory(projId, { key: "note-5", text: "clean text", requestIds: [`req${ESC}bad`] }, 500);
  check("(5b) ESC in a requestIds[] entry -> rejected, field=requestIds", "rejected" in rejRequestIds && rejRequestIds.field === "requestIds" && rejRequestIds.byteClass === "ESC");
  check("(5b) the rejection error never echoes the id's own content", !rejRequestIds.error.includes("bad"));

  // ===== (6) \t \n \r are ordinary multi-line text, never rejected =====
  const cleanMultiline = db.upsertProjectMemory(projId, { key: "note-multiline", text: "line one\nline two\ttabbed\rcr" }, 500);
  check("(6) \\t\\n\\r in text is NOT rejected (survives as a real written entry)", !("rejected" in cleanMultiline) && cleanMultiline.text === "line one\nline two\ttabbed\rcr");

  // ===== (7) a genuinely clean write still succeeds end to end (this is a rejection, not new friction) =====
  const cleanWrite = db.upsertProjectMemory(projId, { key: "note-clean", title: "Clean Title", text: "perfectly ordinary text", tags: ["a", "b"] }, 500);
  check("(7) a clean write is unaffected", !("rejected" in cleanWrite) && cleanWrite.text === "perfectly ordinary text");

  // ===== (8) upsertProjectMemoryChecked surfaces the SAME rejection, distinct from a version conflict =====
  const checkedReject = db.upsertProjectMemoryChecked(projId, { key: "note-clean", text: `now has ${ESC} in it` }, 500, cleanWrite.version);
  check("(8) upsertProjectMemoryChecked: control-char rejection -> ok:false, rejected:true", checkedReject.ok === false && "rejected" in checkedReject && checkedReject.rejected === true);
  check("(8) the rejection shape carries NO `current` field (distinct from a version conflict)", !("current" in checkedReject));

  const bumped = db.upsertProjectMemoryChecked(projId, { key: "note-clean", text: "a real, clean follow-up edit" }, 500, cleanWrite.version);
  check("(9 setup) a real clean follow-up write succeeds and bumps the version", bumped.ok === true && bumped.entry.version === cleanWrite.version + 1);
  const conflictReject = db.upsertProjectMemoryChecked(projId, { key: "note-clean", text: "stale writer's text" }, 500, cleanWrite.version /* now stale */);
  check("(9) a genuine version conflict is STILL distinguishable: ok:false, has `current`, no `rejected`", conflictReject.ok === false && "current" in conflictReject && !("rejected" in conflictReject));

  // ===== (10) the memory_write MCP business logic (mcp/memory.ts's writeProjectMemory) =====
  const mcpTitleReject = writeProjectMemory(db, projId, { key: "note-mcp-1", title: `Bad${ESC}Title`, text: "clean" });
  check("(10) writeProjectMemory: ESC in title -> {error}, no conflict flag", "error" in mcpTitleReject && !("conflict" in mcpTitleReject));
  check("(10) writeProjectMemory: error names the byte class", mcpTitleReject.error.includes("ESC"));
  check("(10) writeProjectMemory: error never echoes content", !mcpTitleReject.error.includes("Title") && !mcpTitleReject.error.toLowerCase().includes("bad"));

  const mcpTagsReject = writeProjectMemory(db, projId, { key: "note-mcp-2", text: "clean", tags: [`x${C1}y`] });
  check("(11) writeProjectMemory: C1 in tags -> {error}", "error" in mcpTagsReject && mcpTagsReject.error.includes("tags"));

  // Key: memory_write's PRE-EXISTING KEY_RE check catches a control byte in `key` FIRST, with its own
  // (different) message — proving this path was already covered before ea5fb00a, by a different mechanism.
  const mcpKeyReject = writeProjectMemory(db, projId, { key: `bad${ESC}key`, text: "clean" });
  check("(12) writeProjectMemory: ESC in key -> rejected by the PRE-EXISTING KEY_RE check, not the new one",
    "error" in mcpKeyReject && mcpKeyReject.error.includes("slug") && !mcpKeyReject.error.includes("ESC"));

  const mcpCleanWrite = writeProjectMemory(db, projId, { key: "note-mcp-clean", title: "Fine", text: "fine text", tags: ["fine-tag"] });
  check("(13) writeProjectMemory: a clean write still succeeds normally", !("error" in mcpCleanWrite) && mcpCleanWrite.text === "fine text");

  // ===== (14) the raw e2e test-seed REST route bypasses mcp/memory.ts entirely, but still hits the SAME
  // DB-layer boundary — proving no writer, present or future, can skip it. =====
  const stub = {};
  const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });
  const seedRes = await app.inject({
    method: "POST",
    url: "/internal/test/seed",
    payload: { projectMemory: [{ projectId: projId, key: "note-seed-1", text: `seeded ${ESC} bad` }] },
  });
  check("(14) POST /internal/test/seed with a control byte in projectMemory text -> 400 (not 200, not 500)", seedRes.statusCode === 400);
  check("(14) the 400 body names the byte class", JSON.parse(seedRes.body).error?.includes("ESC"));
  check("(14) the note was NOT actually written", db.getProjectMemoryByKey(projId, "note-seed-1") === undefined);

  const seedCleanRes = await app.inject({
    method: "POST",
    url: "/internal/test/seed",
    payload: { projectMemory: [{ projectId: projId, key: "note-seed-clean", text: "perfectly clean seeded text" }] },
  });
  check("(15) POST /internal/test/seed with clean text -> 201, still works", seedCleanRes.statusCode === 201);
  check("(15) the clean seeded note IS written", db.getProjectMemoryByKey(projId, "note-seed-clean")?.text === "perfectly clean seeded text");

  // ===== (16) structural backstop: host.ts must NOT keep a second, independently-drifting copy of the
  // classification regex — it imports the shared module instead (card 49b382d9's "Don't write a second
  // copy" now enforced structurally, not just by doc comment). =====
  const hostSrcPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "pty", "host.js");
  const hostSrc = fs.readFileSync(hostSrcPath, "utf8");
  check("(16) host.js no longer defines its own ESC_C0_C1_RE (imports the shared one instead)",
    !/const ESC_C0_C1_RE\s*=/.test(hostSrc));
  check("(16) host.js imports stripEscapeAndControlChars from the shared security/control-chars module",
    /security\/control-chars\.js/.test(hostSrc));

  // ===== (17) card 9f02dee5 (Code Review): RENDER-time backstop for a LEGACY row — one whose
  // `request_ids` already carries a control byte, simulated via a raw connection to the SAME db file
  // (bypassing Db.upsertProjectMemory's own store-boundary check entirely, exactly as a row written before
  // this check existed, or by any future path that skips it, would look). Proves annotateRequestLink
  // strips the byte before ever rendering it, on the "not found" branch that a control-byte id ALWAYS
  // takes (it can never resolve to a real Request). =====
  const legacyNote = db.upsertProjectMemory(projId, { key: "note-legacy-requestid", text: "clean text" }, 500);
  {
    const raw = new Database(dbFile);
    try {
      const poisonedId = `req-legacy${ESC}poison${C1}tail`;
      const changed = raw.prepare("UPDATE project_memory SET request_ids = ? WHERE id = ?")
        .run(JSON.stringify([poisonedId]), legacyNote.id).changes;
      check("(17 setup) the raw connection forced a control-byte-bearing requestIds into the row (bypassing the store check)", changed === 1);

      const line = annotateRequestLink(db, projId, poisonedId, new Date("2026-09-30"));
      check("(17) the rendered line contains NO ESC byte", !line.includes(ESC));
      check("(17) the rendered line contains NO C1 byte", !line.includes(C1));
      check("(17) the rendered line still says 'not found' (a control-byte id can never resolve)", line.includes("not found"));
      check("(17) the rendered line still identifies the STRIPPED id (the printable parts survive)", line.includes("req-legacy") && line.includes("poison") && line.includes("tail"));

      const lines = annotateRequestLinks(db, projId, [poisonedId], new Date("2026-09-30"));
      check("(17) annotateRequestLinks (the real call site annotateNote/withLinks use) is equally safe", lines.length === 1 && !lines[0].includes(ESC) && !lines[0].includes(C1));
    } finally {
      raw.close();
    }
  }
} finally {
  try { db?.close(); } catch { /* ignore */ }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — project memory's store boundary (Db.upsertProjectMemory) rejects an ESC/C0/C1 control byte in text/title/tags/triggerGlob/key/requestIds, reporting byte class + position (never content); the memory_write MCP tool and the raw e2e test-seed REST route both funnel through it and both reject identically; a clean write on every path is unaffected; a legacy row bypassing the store check still renders its requestIds annotation safely (stripped at annotateRequestLink); and host.ts's own strip helper now imports the shared classification instead of keeping a second copy."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
