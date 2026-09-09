import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 3a833d94 — a SOLO worker_merge_confirm uses a card's title VERBATIM as the squash commit
// subject. A title carrying a `type(scope):`-shaped prefix whose type is NOT one of Loom's recognized
// Conventional Commits types (the specimen: card fd799f0f, titled `design(pty): …`) is invisible to the
// merge-time coercion net (`toConventionalSubject`, git/worktrees.ts) — that net only fixes BARE prose,
// so an already type-shaped-but-invalid prefix ships untouched, or (observed in production) gets a SECOND
// `chore: ` prefix bolted on top, producing a double-prefixed permanent mainline artifact. This proves the
// WRITE-boundary guard: createProjectTaskChecked (tasks_create's backing fn) and updateProjectTask
// (tasks_update's backing fn) reject such a title by default, and that the rejection is escapable via
// allowNonConventionalType:true. HERMETIC like task-title-html-entity-guard.mjs: no daemon, no real
// claude — drives the built business logic (dist/) against a throwaway SQLite Db.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { createProjectTaskChecked, updateProjectTask, checkTitleConventionalType } from "../dist/mcp/tasks.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const file = path.join(os.tmpdir(), `loom-task-title-type-guard-${Date.now()}-${process.pid}.db`);
const now = new Date().toISOString();

// The exact bad-shape specimen from card 3a833d94's own filing: fd799f0f, titled `design(pty): …`.
const INVALID_TYPE_TITLE = "design(pty): decide whether human terminal input to a codex session should be ASCII-folded";
// Prose that merely CONTAINS a colon but has no type-shaped prefix (capitalized leading word) — the
// bare-prose case the merge-time coercion net already handles correctly (bare prose -> `chore:`), and
// which this guard must NEVER touch (two legitimate non-work cards on the real board rely on this).
const NO_PREFIX_TITLE = "Release list shows literal quoting: needs a fix";

try {
  const db = new Db(file);
  db.insertProject({
    id: "projA", name: "Alpha", repoPath: "C:/a", vaultPath: "C:/a", config: {},
    createdAt: now, archivedAt: null, reserved: false, referenceRepos: [],
  });

  // --- NEGATIVE CONTROL: a title with no type-shaped prefix at all is completely unaffected. ---
  const noPrefix = createProjectTaskChecked(db, "projA", { title: NO_PREFIX_TITLE });
  check("(control-a) a title with no type-shaped prefix creates successfully", "id" in noPrefix && !("error" in noPrefix));

  // --- POSITIVE CONTROL: an ordinary, ALLOWED type still passes — proves this is a discriminator on the
  //     TYPE, not a blanket refusal of every type(scope): shaped title. ---
  const validType = createProjectTaskChecked(db, "projA", { title: "fix(web): correct the footer padding" });
  check("(control-b) a VALID type (fix) creates successfully — the guard discriminates, not blanket-refuses", "id" in validType && !("error" in validType));

  // --- (1) tasks_create backing fn: FIRES on the invalid-type title, by default. ---
  const rejected = createProjectTaskChecked(db, "projA", { title: INVALID_TYPE_TITLE });
  check("(1) create REJECTS a title whose type-shaped prefix is not an allowed type", "error" in rejected);
  check("(1) rejection names the offending type", "error" in rejected && rejected.error.includes('"design:"'));
  check("(1) rejection names the allowed set", "error" in rejected && rejected.error.includes("feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert"));
  check("(1) rejection mentions the override", "error" in rejected && rejected.error.includes("allowNonConventionalType"));

  // --- (2) tasks_create backing fn: does NOT fire once the caller explicitly says it's deliberate. ---
  const allowedCreate = createProjectTaskChecked(db, "projA", { title: INVALID_TYPE_TITLE }, undefined, undefined, true);
  check("(2) create with allowNonConventionalType:true succeeds", "id" in allowedCreate && !("error" in allowedCreate));
  check("(2) stored title is byte-identical to what was passed (no silent rewrite)",
    "id" in allowedCreate && allowedCreate.title === INVALID_TYPE_TITLE);

  // --- (3) tasks_update backing fn (shared choke point with project_task_update): a title can be valid at
  //     creation and edited into an invalid-type prefix later; the guard must catch that too, not just create. ---
  const editRejected = await updateProjectTask(db, "projA", noPrefix.id, { title: INVALID_TYPE_TITLE }, undefined, noPrefix.version);
  check("(3a) update REJECTS an invalid-type title edit by default", "error" in editRejected);
  const rereadUnchanged = db.getTask(noPrefix.id);
  check("(3b) rejected update left the stored title untouched", rereadUnchanged.title === noPrefix.title);
  const editAllowed = await updateProjectTask(db, "projA", noPrefix.id, { title: INVALID_TYPE_TITLE }, undefined, noPrefix.version, undefined, undefined, undefined, true);
  check("(3c) update with allowNonConventionalType:true succeeds", "title" in editAllowed && editAllowed.title === INVALID_TYPE_TITLE);

  // --- (4) A patch that never touches `title` is completely unaffected by this guard — including for a
  //     task whose STORED title already carries an invalid type (editAllowed, just above). Deliberate
  //     design choice (card 3a833d94 DoD-4): an unrelated field-only patch never retroactively blocks on a
  //     pre-existing invalid title, same convention checkTitleHtmlEntities already established. ---
  const fieldOnly = await updateProjectTask(db, "projA", editAllowed.id, { priority: "p0" }, undefined, undefined);
  check("(4) a title-less patch on a card with an already-invalid stored title is never touched by this guard",
    "priority" in fieldOnly && fieldOnly.priority === "p0" && !("error" in fieldOnly));

  // --- (5) Raw checkTitleConventionalType: a title with a VALID type but an invalid-looking value passed
  //     through `allow` returns null (never fires when allow:true), and a title with a scope + `!` breaking
  //     change marker is still parsed correctly (scope/bang don't confuse the type extraction). ---
  check("(5a) allow:true short-circuits even for an invalid type", checkTitleConventionalType(INVALID_TYPE_TITLE, true) === null);
  const bangResult = checkTitleConventionalType("design(pty)!: breaking change with a bang", undefined);
  check("(5b) a scope + `!` breaking-change marker doesn't confuse type extraction — still catches the bad type",
    !!bangResult && bangResult.type === "design");

  db.close();
} finally {
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}-wal`, { force: true });
  fs.rmSync(`${file}-shm`, { force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — createProjectTaskChecked/updateProjectTask reject a title whose type-shaped prefix isn't an allowed Conventional Commits type, by default; leave a no-prefix title and a valid-type title untouched (discriminator, not blanket refusal); are escapable via allowNonConventionalType:true; never retroactively block an unrelated field-only patch; and correctly extract the type past a scope + breaking-change bang."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
