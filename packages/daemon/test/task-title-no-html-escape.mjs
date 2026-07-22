import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 9c46cd7a — a mainline squash commit (fe2c1c6) shipped with `&lt;id&gt;` in place of a card
// title's literal `<id>`. HERMETIC like tasks-priority.mjs: no daemon, no real claude — drives the
// built business logic (dist/) against a throwaway SQLite Db. Proves the storage layer (createProjectTask
// / updateProjectTask / db.insertTask / db.getTask) never HTML-entity-escapes `<`, `>`, `&`, `"` in a
// title OR a body — a stored title/body is the literal text the caller passed, byte-identical on
// readback. (The render side is proven safe separately: `packages/web/src` has ZERO
// `dangerouslySetInnerHTML` usages — every `task.title`/`task.body` site is a plain JSX child or an
// HTML `title=` tooltip attribute, both of which React escapes on display by default; grepped clean.)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { createProjectTask, updateProjectTask } from "../dist/mcp/tasks.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const file = path.join(os.tmpdir(), `loom-task-title-escape-${Date.now()}.db`);
const now = new Date().toISOString();

try {
  const db = new Db(file);
  db.insertProject({
    id: "projA", name: "Alpha", repoPath: "C:/a", vaultPath: "C:/a", config: {},
    createdAt: now, archivedAt: null, reserved: false, referenceRepos: [],
  });

  // (a) createProjectTask: a title naming a param/type round-trips byte-identical through storage.
  const angleTitle = "feat(orchestration): add an explicit supersedes:<id> param to question_ask";
  const created = createProjectTask(db, "projA", { title: angleTitle, body: "See `Partial<T>` & `A & B`." });
  check("(a) createProjectTask returns the title unescaped", created.title === angleTitle);
  check("(a) createProjectTask returns the body unescaped", created.body === "See `Partial<T>` & `A & B`.");
  const reread = db.getTask(created.id);
  check("(a) stored title reads back byte-identical (no &lt;/&gt;/&amp;)", reread.title === angleTitle);
  check("(a) stored body reads back byte-identical", reread.body === "See `Partial<T>` & `A & B`.");
  check("(a) stored title contains a literal '<', never '&lt;'", reread.title.includes("<id>") && !reread.title.includes("&lt;"));

  // (b) updateProjectTask: patching a title/body with the same characters is equally unescaped.
  const quoteTitle = `fix(web): guard the "A & B" <Partial> case`;
  const updated = await updateProjectTask(db, "projA", created.id, { title: quoteTitle, body: 'quotes: " and \' and & too' });
  check("(b) updateProjectTask returns the patched title unescaped", updated.title === quoteTitle);
  const reread2 = db.getTask(created.id);
  check("(b) stored title after update reads back byte-identical", reread2.title === quoteTitle);
  check("(b) stored body after update reads back byte-identical", reread2.body === 'quotes: " and \' and & too');

  db.close();
} finally {
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}-wal`, { force: true });
  fs.rmSync(`${file}-shm`, { force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — createProjectTask/updateProjectTask never HTML-entity-escape `<`, `>`, `&`, `\"` in a title or body; storage holds the literal text, byte-identical on readback."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
