import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 267fd215 — a SOLO worker_merge_confirm uses a card's title VERBATIM as the squash commit
// subject; a title carrying an HTML entity has already landed in mainline history this way once
// (commit fe2c1c6b, unrewritable per this repo's do-not-rewrite-published-history rule). This proves
// the WRITE-boundary guard: createProjectTaskChecked (tasks_create's backing fn) and updateProjectTask
// (tasks_update's backing fn, shared with the cross-project project_task_update) reject a title
// carrying &lt;/&gt;/&amp;/&quot;/&#NN; by default, and that the rejection is escapable via
// allowHtmlEntities:true — including for a title genuinely ABOUT escaped HTML, where a hard reject with
// no override would incorrectly block a legitimate title. HERMETIC like task-title-no-html-escape.mjs:
// no daemon, no real claude — drives the built business logic (dist/) against a throwaway SQLite Db.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { createProjectTaskChecked, updateProjectTask, checkTitleHtmlEntities } from "../dist/mcp/tasks.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const file = path.join(os.tmpdir(), `loom-task-title-entity-guard-${Date.now()}-${process.pid}.db`);
const now = new Date().toISOString();

// The exact bad-shape specimen that actually shipped as commit fe2c1c6b (card 267fd215's own evidence).
const ACCIDENTAL_ENTITY_TITLE =
  "feat(orchestration): add an explicit supersedes:&lt;id&gt; param to question_ask that auto-cancels the named prior pending ask";
// A real, already-on-this-board title genuinely ABOUT escaped HTML — the false-positive case the card
// explicitly warns a hard reject would incorrectly block.
const LEGITIMATE_ESCAPING_TITLE = 'Release list shows literal &quot;Sub: &amp;mdash;&quot; when subs missing';

try {
  const db = new Db(file);
  db.insertProject({
    id: "projA", name: "Alpha", repoPath: "C:/a", vaultPath: "C:/a", config: {},
    createdAt: now, archivedAt: null, reserved: false, referenceRepos: [],
  });

  // --- NEGATIVE CONTROL: an ordinary title with no entities is completely unaffected. ---
  const clean = createProjectTaskChecked(db, "projA", { title: "fix(web): correct the footer padding" });
  check("(control) a clean title creates successfully", "id" in clean && !("error" in clean));

  // --- (1) tasks_create backing fn: FIRES on the accidental-entity title, by default. ---
  const rejected = createProjectTaskChecked(db, "projA", { title: ACCIDENTAL_ENTITY_TITLE });
  check("(1) create REJECTS an entity-bearing title by default", "error" in rejected);
  check("(1) rejection names the decoded form (a literal <id>) and quotes the offending entity (&lt;)",
    "error" in rejected && rejected.error.includes("supersedes:<id>") && rejected.error.includes('"&lt;"'));
  check("(1) rejection mentions the override", "error" in rejected && rejected.error.includes("allowHtmlEntities"));

  // --- (2) tasks_create backing fn: does NOT fire once the caller explicitly says it's deliberate. ---
  const allowedCreate = createProjectTaskChecked(db, "projA", { title: ACCIDENTAL_ENTITY_TITLE }, undefined, true);
  check("(2) create with allowHtmlEntities:true succeeds", "id" in allowedCreate && !("error" in allowedCreate));
  check("(2) stored title is byte-identical to what was passed (no silent rewrite)",
    "id" in allowedCreate && allowedCreate.title === ACCIDENTAL_ENTITY_TITLE);

  // --- (3) The legitimate escaping-about-escaping title: rejected by default (same shape as (1); this
  //     board really does contain this exact title today), but creatable via the SAME override — proving
  //     the guard never permanently blocks a deliberate title, only an unflagged one. ---
  const legitRejected = createProjectTaskChecked(db, "projA", { title: LEGITIMATE_ESCAPING_TITLE });
  check("(3a) the legitimate escaping title is ALSO caught by default (it genuinely contains entities)", "error" in legitRejected);
  const legitAllowed = createProjectTaskChecked(db, "projA", { title: LEGITIMATE_ESCAPING_TITLE }, undefined, true);
  check("(3b) DOES NOT FIRE once flagged deliberate — the legitimate title is created, untouched",
    "id" in legitAllowed && !("error" in legitAllowed) && legitAllowed.title === LEGITIMATE_ESCAPING_TITLE);
  const reread = db.getTask(legitAllowed.id);
  check("(3c) stored byte-identical on readback (never decoded/rewritten)", reread.title === LEGITIMATE_ESCAPING_TITLE);

  // --- (4) tasks_update backing fn (shared choke point with project_task_update): DoD-4 — a title can be
  //     entity-free at creation and edited into one later; the guard must catch that too, not just create. ---
  const editRejected = await updateProjectTask(db, "projA", clean.id, { title: ACCIDENTAL_ENTITY_TITLE }, undefined, clean.version);
  check("(4a) update REJECTS an entity-bearing title edit by default", "error" in editRejected);
  const rereadUnchanged = db.getTask(clean.id);
  check("(4b) rejected update left the stored title untouched", rereadUnchanged.title === clean.title);
  const editAllowed = await updateProjectTask(db, "projA", clean.id, { title: ACCIDENTAL_ENTITY_TITLE }, undefined, clean.version, undefined, undefined, true);
  check("(4c) update with allowHtmlEntities:true succeeds", "title" in editAllowed && editAllowed.title === ACCIDENTAL_ENTITY_TITLE);

  // --- (5) A patch that never touches `title` is completely unaffected by this guard (whole-patch-reject
  //     convention: the guard only ever looks at patch.title, never fires on an unrelated field-only move). ---
  const fieldOnly = await updateProjectTask(db, "projA", editAllowed.id, { priority: "p0" }, undefined, undefined);
  check("(5) a title-less patch is never touched by this guard", "priority" in fieldOnly && fieldOnly.priority === "p0" && !("error" in fieldOnly));

  // --- (6) Manager code-review Finding 1: an out-of-range decimal numeric entity must not THROW. Before
  //     the fix, `Number.isFinite(999999999)` is true, so it passed straight to `String.fromCodePoint`,
  //     which throws RangeError above 0x10FFFF — turning a guard whose entire job is a clean {error} into
  //     an unhandled exception. Exercised at both the raw checkTitleHtmlEntities level AND through
  //     createProjectTaskChecked, so a caller of the actual MCP tool is also proven never to see a throw. ---
  const OUT_OF_RANGE_NUMERIC_TITLE = "feat: broken &#999999999; title";
  let threw = false;
  let guardResult;
  try {
    guardResult = checkTitleHtmlEntities(OUT_OF_RANGE_NUMERIC_TITLE, undefined);
  } catch {
    threw = true;
  }
  check("(6a) an out-of-range decimal numeric entity does not throw", !threw);
  check("(6a) ...and still returns a clean {error} rejection", !!guardResult && "error" in guardResult);
  check("(6a) ...whose decoded suggestion falls back to the original entity (never a garbage code point)",
    !!guardResult && "error" in guardResult && guardResult.error.includes("&#999999999;"));
  let createThrew = false;
  let createResult;
  try {
    createResult = createProjectTaskChecked(db, "projA", { title: OUT_OF_RANGE_NUMERIC_TITLE });
  } catch {
    createThrew = true;
  }
  check("(6b) the same title through createProjectTaskChecked also does not throw", !createThrew);
  check("(6b) ...and is rejected (not silently created)", !!createResult && "error" in createResult);

  // --- (7) Manager code-review Finding 2: the doc comment claims "numeric entities" generically, but the
  //     pattern implemented DECIMAL only — a hex numeric entity (&#x3C;, a real serializer output) passed
  //     through undetected. Widened the pattern rather than narrowing the comment (manager's weak
  //     preference, taken): the class this guard exists to make impossible should cover both forms. ---
  const HEX_ENTITY_TITLE = "feat: a &#x3C;id&#x3E; thing";
  const hexRejected = checkTitleHtmlEntities(HEX_ENTITY_TITLE, undefined);
  check("(7a) a hex numeric entity (&#x3C;) is detected, not silently ignored", !!hexRejected && "error" in hexRejected);
  check("(7a) ...and decodes to the literal characters in the suggestion",
    !!hexRejected && "error" in hexRejected && hexRejected.error.includes("<id>"));
  // In-range DECIMAL numeric entity still decodes correctly too — the bound fix in (6) must not have
  // regressed the ordinary case while capping the out-of-range one.
  const decimalDecoded = checkTitleHtmlEntities("feat: x &#60; y", undefined);
  check("(7b) an ordinary in-range decimal numeric entity (&#60;) still decodes to '<'",
    !!decimalDecoded && "error" in decimalDecoded && decimalDecoded.error.includes('"feat: x < y"'));

  db.close();
} finally {
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}-wal`, { force: true });
  fs.rmSync(`${file}-shm`, { force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — createProjectTaskChecked/updateProjectTask reject an entity-bearing title by default, name the decoded form, are escapable via allowHtmlEntities:true (including for a genuinely-about-escaping title), never touch a title-less patch, never throw on an out-of-range numeric entity, and detect hex numeric entities alongside decimal."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
