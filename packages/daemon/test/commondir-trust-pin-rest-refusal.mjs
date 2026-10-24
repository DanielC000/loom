import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
// CARD 4d60366b, Code Review ec8816e4 — S2/S3: a commondir-trust-pin conflict must surface as a NORMAL
// REST refusal (409 {error}), never an uncaught 500, and — for a route that bootstraps a fresh directory
// BEFORE binding it (POST /api/setup/project-init) — must be checked BEFORE that bootstrap runs, so a
// refused create never leaves a stray directory on disk. HERMETIC + CLAUDE-FREE + NETWORK-FREE, modeled on
// setup-project-init-rest.mjs (Db + buildServer via app.inject).
//
// The conflict is constructed the SAME way commondir-trust-pin-ownership.mjs's N1 case does: bind a
// project to a SUBDIR of a real repo (no own .git — the walk resolves UP to the ancestor's toplevel), then
// plant a FRESH, real `.git` directory directly inside that subdir. A later bind attempt to the SAME
// literal path now walks successfully (so `isGitRepo` passes, same as before) but resolves to a DIFFERENT
// toplevel than the existing pin recorded — a genuine, deterministic conflict with no corrupted git state.
//
// Proves:
//   (1) POST /api/projects onto a conflicting path → 409 {error}, the SECOND project is never written.
//   (2) PATCH /api/projects/:id rebinding an EXISTING project onto a conflicting path → 409 {error}, and
//       the WHOLE patch is refused atomically (an unrelated field in the same PATCH stays unchanged).
//   (3) POST /api/setup/project-init whose PREDICTED target conflicts → 409 {error}, AND — the actual S2
//       invariant — no stray directory is left on disk, and no project row is written.
// Run: 1) pnpm build, 2) node packages/daemon/test/commondir-trust-pin-rest-refusal.mjs
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";

const TMP = mkdtempManaged("loom-cgcr-rest-refusal-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = String(hermeticPort());
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { WORKSPACE_ROOT } = await import("../dist/paths.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const stub = {};
const buildApp = (db) => buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });

const SCRATCH = path.join(TMP, "scratch");
fs.mkdirSync(SCRATCH, { recursive: true });
const git = (cwd, args) => execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const GIT_ID = "-c user.email=cgcrrest@loom -c user.name=cgcrrest";
function initRepo(name) {
  const dir = path.join(SCRATCH, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init -q -b main");
  fs.writeFileSync(path.join(dir, "f.txt"), `${name}\n`);
  git(dir, "add -A");
  git(dir, `${GIT_ID} commit -q -m "${name}: init"`);
  return dir;
}
/** Binds project A to a SUBDIR of a real repo (no own .git), then plants a fresh real .git directly in
 *  that subdir — a later bind to the SAME literal path now walks successfully but to a DIFFERENT toplevel
 *  than A's existing pin. Returns the subdir path to bind the SECOND (conflicting) attempt to. */
function makeConflictingPath(label) {
  const ancestor = initRepo(`${label}-ancestor`);
  const nested = path.join(ancestor, "nested-dir");
  fs.mkdirSync(nested);
  return nested;
}
function plantOwnGit(nested) {
  fs.mkdirSync(path.join(nested, ".git"));
}

// ===================== (1) POST /api/projects onto a conflicting path → 409 =====================
{
  const db = new Db(path.join(TMP, "loom-1.db"));
  const app = await buildApp(db);
  try {
    const nested = makeConflictingPath("r1");
    const first = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "First", repoPath: nested } });
    check("(1, setup) first bind succeeds (201)", first.statusCode === 201);
    plantOwnGit(nested);
    const second = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "Second", repoPath: nested } });
    check("(1) the conflicting second bind is REFUSED with 409", second.statusCode === 409);
    check("(1) the 409 body names the conflict", typeof second.json().error === "string" && /commondir-trust pin/i.test(second.json().error));
    check("(1) only ONE project exists — the second was never written", db.listAllProjects().length === 1);
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    db.close();
  }
}

// ===================== (2) PATCH /api/projects/:id onto a conflicting path → 409, atomic =====================
{
  const db = new Db(path.join(TMP, "loom-2.db"));
  const app = await buildApp(db);
  try {
    const nested = makeConflictingPath("r2");
    const owner = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "Owner", repoPath: nested } });
    check("(2, setup) owner bind succeeds (201)", owner.statusCode === 201);
    plantOwnGit(nested);
    const other = initRepo("r2-other");
    const otherProject = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "Other", repoPath: other } });
    check("(2, setup) a second, unrelated project binds fine", otherProject.statusCode === 201);
    const otherId = otherProject.json().id;
    const patch = await app.inject({
      method: "PATCH", url: `/api/projects/${otherId}`,
      payload: { name: "renamed-by-refused-patch", repoPath: nested },
    });
    check("(2) rebinding the SECOND project onto the conflicting path is REFUSED with 409", patch.statusCode === 409);
    check("(2) the 409 body names the conflict", typeof patch.json().error === "string" && /commondir-trust pin/i.test(patch.json().error));
    const afterPatch = db.getProject(otherId);
    check("(2) the WHOLE patch is refused atomically — name is unchanged too", afterPatch?.name === "Other" && afterPatch?.repoPath === other);
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    db.close();
  }
}

// ===================== (3) POST /api/setup/project-init whose PREDICTED target conflicts → 409, NO stray dir =====================
{
  const db = new Db(path.join(TMP, "loom-3.db"));
  const app = await buildApp(db);
  try {
    // Make WORKSPACE_ROOT itself a real repo, bind a project to a SUBDIR leaf under it (no own .git — the
    // walk resolves UP to WORKSPACE_ROOT), then DELETE just that leaf. project-init's OWN dirName-leaf
    // resolution (resolveProjectInitTarget) is confined to this SAME base, so a SECOND call naming the
    // SAME leaf predicts the EXACT SAME literal path — which no longer exists on disk (so the leaf-exists
    // guard doesn't refuse it first) but still carries the FIRST bind's pin, owned by a different project.
    const root = path.resolve(WORKSPACE_ROOT);
    fs.mkdirSync(root, { recursive: true });
    git(root, "init -q -b main");
    fs.writeFileSync(path.join(root, "f.txt"), "r3\n");
    git(root, "add -A");
    git(root, `${GIT_ID} commit -q -m "r3: init"`);
    const dirName = "reused-leaf-r3";
    const nested = path.join(root, dirName);
    fs.mkdirSync(nested);
    const owner = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "Owner3", repoPath: nested } });
    check("(3, setup) owner bind at the subdir leaf succeeds (201)", owner.statusCode === 201);
    fs.rmSync(nested, { recursive: true, force: true }); // the leaf vanishes; WORKSPACE_ROOT's own repo survives
    const before = db.listAllProjects().length;
    const init = await app.inject({ method: "POST", url: "/api/setup/project-init", payload: { name: "Second3", dirName } });
    check("(3) the conflicting project-init is REFUSED with 409", init.statusCode === 409);
    check("(3) the 409 body names the conflict", typeof init.json().error === "string" && /commondir-trust pin/i.test(init.json().error));
    check("(3) NO stray directory was created at the predicted target (the S2 invariant)", !fs.existsSync(nested));
    check("(3) NO new project row was written", db.listAllProjects().length === before);
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    db.close();
  }
}

// ===================== (4) card 87b1c8a1 (Code Review R3): a NON-conflict throw becomes a real 500, not a false 409 =====================
// insertProject's catch is narrowed to CommondirPinConflictError (card 87b1c8a1) — a genuine internal
// fault (here: a plain Error with nothing to do with a pin conflict) must propagate as a real 500, never
// be laundered into the SAME 409 shape the three cases above use for an actual conflict. A bare
// `statusCode === 500` alone would stay green for ANY unrelated 500 (e.g. a route-level bug), so the
// monkey-patch also sets a `reached` flag — asserted TRUE — proving the 500 we're checking really did
// come from insertProject's own narrowed catch, not from somewhere else in the handler.
{
  const db = new Db(path.join(TMP, "loom-4.db"));
  const app = await buildApp(db);
  let reached = false;
  const origInsertProject = Db.prototype.insertProject;
  Db.prototype.insertProject = function () { reached = true; throw new Error("injected non-conflict internal fault"); };
  try {
    const res = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "Fourth", repoPath: initRepo("r4") } });
    check("(4) insertProject's injected throw was actually reached", reached === true);
    check("(4) a non-conflict throw from insertProject returns 500, NOT 409", res.statusCode === 500);
  } finally {
    Db.prototype.insertProject = origInsertProject;
    try { await app.close(); } catch { /* ignore */ }
    db.close();
  }
}

// ===================== (4b) card 87b1c8a1 (Code Review R3): the SAME narrowing on PATCH /api/projects/:id =====================
{
  const db = new Db(path.join(TMP, "loom-4b.db"));
  const app = await buildApp(db);
  let reached = false;
  const origUpdateProject = Db.prototype.updateProject;
  Db.prototype.updateProject = function () { reached = true; throw new Error("injected non-conflict internal fault"); };
  try {
    const owner = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "FourthB", repoPath: initRepo("r4b") } });
    check("(4b, setup) owner bind succeeds (201)", owner.statusCode === 201);
    const ownerId = owner.json().id;
    const res = await app.inject({ method: "PATCH", url: `/api/projects/${ownerId}`, payload: { name: "renamed" } });
    check("(4b) updateProject's injected throw was actually reached", reached === true);
    check("(4b) a non-conflict throw from updateProject returns 500, NOT 409", res.statusCode === 500);
  } finally {
    Db.prototype.updateProject = origUpdateProject;
    try { await app.close(); } catch { /* ignore */ }
    db.close();
  }
}

await finishAndExit(failures === 0 ? 0 : 1);
