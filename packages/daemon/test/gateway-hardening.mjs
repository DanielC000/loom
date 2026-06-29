import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Three small gateway hardening guards on the loopback REST surface (gateway/server.ts), driven via
// buildServer + app.inject (HERMETIC + CLAUDE-FREE + NETWORK-FREE, like csrf-rebind.mjs). Proves:
//   A. task CREATE (POST /api/projects/:id/tasks) with a bogus columnKey lands on the default landing
//      lane (not a phantom lane), an explicit VALID columnKey is honored, and an omitted key still lands;
//   A. task UPDATE (POST /api/tasks/:id) with a bogus columnKey is re-keyed to the landing lane (not
//      written blind), while a move to a VALID column is honored;
//   B. PATCH /api/projects/:id that would CHANGE repoPath on a RESERVED project is REFUSED (400), while
//      a non-reserved repoPath change still succeeds and a benign metadata edit (name) on a reserved
//      project still succeeds.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { requireHermeticEnv } from "./_guard.mjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "loom-gwhard-"));
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = "45341";
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Real temp git repos so the non-reserved repoPath rebind (checkRepoRebind › isGitRepo) can succeed.
const mkRepo = (tag) => {
  const r = path.join(TMP, `repo-${tag}`);
  fs.mkdirSync(r, { recursive: true });
  fs.writeFileSync(path.join(r, "README.md"), `# ${tag}\n`);
  execSync(`git init -q && git add . && git -c user.email=r@loom -c user.name=r commit -q -m init`, { cwd: r });
  return r;
};
const repoA = mkRepo("A");
const repoB = mkRepo("B");

const now = new Date().toISOString();
const db = new Db(path.join(TMP, "loom.db"));
db.insertProject({ id: "pHome", name: "Loom Platform", repoPath: repoA, vaultPath: repoA, config: {}, createdAt: now, archivedAt: null, reserved: true });
db.insertProject({ id: "pProj", name: "Project", repoPath: repoA, vaultPath: repoA, config: {}, createdAt: now, archivedAt: null, reserved: false });

const stub = {};
const app = await buildServer({
  db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
  userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub,
  requestShutdown: () => {},
});

// Loopback headers so the CSRF/DNS-rebind onRequest hook lets every request through to the handler.
const H = { host: "127.0.0.1:45341", origin: "http://127.0.0.1:45341", "content-type": "application/json" };
const post = (url, payload) => app.inject({ method: "POST", url, headers: H, payload });
const patch = (url, payload) => app.inject({ method: "PATCH", url, headers: H, payload });

try {
  // --- Fix A: task CREATE columnKey validation (default landing on a project is "backlog"). ---
  const cBogus = await post("/api/projects/pProj/tasks", { title: "bogus", columnKey: "nope-phantom" });
  const tBogus = JSON.parse(cBogus.body);
  check("(A.create) bogus columnKey → 201 and lands on the landing lane (backlog), NOT the phantom key",
    cBogus.statusCode === 201 && tBogus.columnKey === "backlog");

  const cValid = await post("/api/projects/pProj/tasks", { title: "valid", columnKey: "in_progress" });
  check("(A.create) explicit VALID columnKey (in_progress) is honored",
    cValid.statusCode === 201 && JSON.parse(cValid.body).columnKey === "in_progress");

  const cOmit = await post("/api/projects/pProj/tasks", { title: "omitted" });
  check("(A.create) omitted columnKey still lands on the landing lane (backlog)",
    cOmit.statusCode === 201 && JSON.parse(cOmit.body).columnKey === "backlog");

  // --- Fix A: task UPDATE columnKey validation. ---
  const tid = tBogus.id;
  const uBogus = await post(`/api/tasks/${tid}`, { columnKey: "still-phantom" });
  check("(A.update) bogus columnKey move → 200 and re-keyed to the landing lane (backlog), not written blind",
    uBogus.statusCode === 200 && db.getTask(tid).columnKey === "backlog");

  const uValid = await post(`/api/tasks/${tid}`, { columnKey: "done" });
  check("(A.update) move to a VALID column (done) is honored",
    uValid.statusCode === 200 && db.getTask(tid).columnKey === "done");

  // --- Fix B: reserved-project repoPath rebind refusal. ---
  const rebindReserved = await patch("/api/projects/pHome", { repoPath: repoB });
  check("(B) repoPath rebind on a RESERVED project → 400 refused",
    rebindReserved.statusCode === 400 && /reserved/.test(JSON.parse(rebindReserved.body).error));
  check("(B) the refused rebind left the reserved project's repoPath UNCHANGED",
    db.getProject("pHome").repoPath === repoA);

  const renameReserved = await patch("/api/projects/pHome", { name: "Loom Platform (renamed)" });
  check("(B) a benign metadata edit (name) on a RESERVED project still succeeds",
    renameReserved.statusCode === 200 && db.getProject("pHome").name === "Loom Platform (renamed)");

  const rebindNonReserved = await patch("/api/projects/pProj", { repoPath: repoB });
  check("(B) a repoPath change on a NON-reserved project still succeeds",
    rebindNonReserved.statusCode === 200 && db.getProject("pProj").repoPath === repoB);
} finally {
  try { await app.close(); } catch { /* ignore */ }
  db.close();
}

for (let i = 0; i < 5; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch { /* retry */ } }

console.log(failures === 0
  ? "\n✅ ALL PASS — REST task create/update re-key a bogus columnKey to the landing lane (no phantom lane), and a reserved project refuses a repoPath rebind while benign metadata + non-reserved rebinds still work."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
