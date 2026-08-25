import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Profiles REST test (Agents→Profiles P3). Boots an ISOLATED daemon (own temp LOOM_HOME + a
// non-4317 LOOM_PORT) so it never touches a live :4317 daemon, exercises the new HTTP surface, then
// tears the daemon down. NO claude is spawned (we never POST /sessions — the role→spawn seam is
// covered claude-free by profiles-crud.mjs / profile-spawn.mjs). Covers:
//   • Profile CRUD round-trip: POST create (201) → GET list/get → PUT partial update → POST reset →
//     DELETE; plus GET/PUT/POST-reset 404s and 400 validation (bad role / unknown key).
//   • Agent assignment: POST /api/agents/:id SETS and CLEARS profileId; 404 on a bogus profileId.
// Run: node test/profiles-rest.mjs — self-contained, ALWAYS boots its own daemon on its own fresh
// LOOM_HOME (card 4f1d4276: this used to reuse an operator-pre-set LOOM_HOME as an externally-started
// daemon to hit, but that collided with the test harness's OWN use of that identical var for per-test
// isolation — every runOne child inherits a LOOM_HOME pointed at a free port with nothing listening on
// it, so under the gate the "reuse" branch was ALWAYS taken and ALWAYS hit a dead port. Removed; this
// file now self-isolates unconditionally, like every sibling test that spawns dist/index.js
// (periodic-snapshot.mjs, shutdown-snapshot.mjs, deploy-staleness.mjs, codescape-privacy-guard.mjs).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execSync } from "node:child_process";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";
import { requireHermeticEnv } from "./_guard.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.LOOM_PORT) || 4318 + (process.pid % 900); // non-4317, low-collision
const BASE = `http://127.0.0.1:${PORT}`;
// Always true now (see header) — kept as a named const (rather than inlining `true` at every use below)
// so a future reader auditing this file for the mode-switch this card removed finds a single, obvious
// definition instead of a literal scattered across the boot/teardown logic.
const ownDaemon = true;
process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-prest-${Date.now()}-${process.pid}`); // never ambient
process.env.LOOM_PORT = String(PORT);
const LOOM_HOME = process.env.LOOM_HOME;
fs.mkdirSync(LOOM_HOME, { recursive: true });
requireHermeticEnv({ port: true });
console.log(`profiles-rest: ownDaemon=${ownDaemon} PORT=${PORT} LOOM_HOME=${LOOM_HOME}`);

// POST /api/projects validates repoPath is a real git repo — LOOM_HOME itself isn't one, so the
// agent-assignment section below needs its own throwaway repo dir.
const REPO_DIR = path.join(os.tmpdir(), `loom-prest-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(REPO_DIR, { recursive: true });
fs.writeFileSync(path.join(REPO_DIR, "README.md"), "# profiles-rest test\n");
execSync(`git init -q && git add . && git -c user.email=prest@loom -c user.name=prest commit -q -m init`, { cwd: REPO_DIR });

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
// The gateway's loopback write guard (card 4ff9a073, 2026-08-07) requires an
// `Authorization: Bearer <loopback secret>` header on every non-GET /api/* request — set once the
// daemon has booted (below) and the secret file is readable. GET is never guarded, so `loopbackToken`
// stays null until then and an early GET (the seed reads) still works with no header at all.
let loopbackToken = null;
const json = async (method, u, body) => {
  const headers = body === undefined ? {} : { "content-type": "application/json" };
  if (loopbackToken) headers.authorization = `Bearer ${loopbackToken}`;
  const r = await fetch(BASE + u, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed = null; try { parsed = await r.json(); } catch { /* empty body */ }
  return { status: r.status, body: parsed };
};

// --- boot the isolated daemon (dist/index.js) ---
const daemon = spawn(process.execPath, [path.join(__dirname, "..", "dist", "index.js")], {
  env: { ...process.env, LOOM_HOME, LOOM_PORT: String(PORT) },
  stdio: "ignore",
});
// Retrofitted onto the shared _wait.mjs waitUntil (card a19e4c02): pure poll-until-predicate loop, no
// externally-anchored budget — a thrown predicate is a real bug and should propagate, not fold into false.
async function waitReady(timeoutMs = 20000) {
  try {
    return !!(await sharedWaitUntil(
      async () => { try { const r = await fetch(`${BASE}/api/profiles`); return r.ok; } catch { return false; } },
      { timeoutMs, intervalMs: 200, label: "profiles-rest: daemon ready" },
    ));
  } catch (err) {
    if (!/waitUntil: timed out/.test(err?.message ?? "")) throw err;
    return false;
  }
}

try {
  if (!(await waitReady())) { console.error("daemon did not become ready"); process.exit(2); }
  // index.ts calls getOrCreateLoopbackSecret() before the HTTP listener opens (see gateway/
  // loopback-secret.ts), so by the time waitReady() observes a response the file is already there.
  loopbackToken = fs.readFileSync(path.join(LOOM_HOME, "gateway-loopback.key"), "utf8").trim();

  // The daemon seeds the bundled profiles on boot — grab one for the reset/assign cases.
  const seeded = (await json("GET", "/api/profiles")).body;
  check("seed: bundled profiles present on boot", Array.isArray(seeded) && seeded.length >= 6);
  const bundledDev = seeded.find((p) => p.name === "Dev");
  check("seed: bundled 'Dev' (role worker) present", bundledDev?.role === "worker");

  // ===================== CRUD round-trip =====================
  // CREATE (201) — a valid writable shape, defaults filled by the validator.
  const created = await json("POST", "/api/profiles", { name: "Reviewer", role: "worker", description: "review carefully" });
  check("POST /api/profiles → 201 with a server-assigned id", created.status === 201 && !!created.body.id && created.body.name === "Reviewer");
  check("POST: validator filled defaults (allowDelta [], skills null)", JSON.stringify(created.body.allowDelta) === "[]" && created.body.skills === null);
  const id = created.body.id;

  // LIST + GET
  const list = await json("GET", "/api/profiles");
  check("GET /api/profiles includes the created profile", list.body.some((p) => p.id === id));
  const got = await json("GET", `/api/profiles/${id}`);
  check("GET /api/profiles/:id returns it", got.status === 200 && got.body.id === id && got.body.role === "worker");
  check("GET /api/profiles/:id → 404 for an unknown id", (await json("GET", "/api/profiles/no-such")).status === 404);

  // PUT partial update — only `role` provided; name/description preserved via the merge.
  const put = await json("PUT", `/api/profiles/${id}`, { role: "manager" });
  check("PUT /api/profiles/:id partial update applies (role→manager)", put.status === 200 && put.body.role === "manager");
  check("PUT partial: untouched fields preserved (name + description)", put.body.name === "Reviewer" && put.body.description === "review carefully");
  check("PUT /api/profiles/:id → 404 for an unknown id", (await json("PUT", "/api/profiles/no-such", { role: "worker" })).status === 404);
  // Validation on the MERGED result: a bad role enum and an unknown key are both rejected (.strict()).
  check("PUT rejects a bad role enum → 400", (await json("PUT", `/api/profiles/${id}`, { role: "boss" })).status === 400);
  check("PUT rejects an unknown key → 400", (await json("PUT", `/api/profiles/${id}`, { bogus: 1 })).status === 400);
  check("POST rejects a bad role enum → 400", (await json("POST", "/api/profiles", { name: "X", role: "boss" })).status === 400);
  check("POST rejects an unknown key → 400", (await json("POST", "/api/profiles", { name: "X", bogus: 1 })).status === 400);
  check("POST rejects a missing name → 400", (await json("POST", "/api/profiles", { role: "worker" })).status === 400);

  // RESET-to-bundled: edit a bundled profile, then reset restores the shipped fields.
  await json("PUT", `/api/profiles/${bundledDev.id}`, { description: "EDITED", role: "manager" });
  const resetRes = await json("POST", `/api/profiles/${bundledDev.id}/reset`);
  check("POST /api/profiles/:id/reset restores bundled fields", resetRes.status === 200 && resetRes.body.role === "worker" && resetRes.body.description !== "EDITED");
  check("reset → 404 for a non-bundled profile (the user-created 'Reviewer')", (await json("POST", `/api/profiles/${id}/reset`)).status === 404);

  // DELETE — idempotent; removed from the list afterwards.
  const del = await json("DELETE", `/api/profiles/${id}`);
  check("DELETE /api/profiles/:id → ok", del.status === 200 && del.body.ok === true);
  check("DELETE: profile gone from GET list", !(await json("GET", "/api/profiles")).body.some((p) => p.id === id));
  check("DELETE: GET the deleted id → 404", (await json("GET", `/api/profiles/${id}`)).status === 404);
  check("DELETE on an already-gone id is idempotent (ok)", (await json("DELETE", `/api/profiles/${id}`)).status === 200);

  // ===================== Agent profile assignment via POST /api/agents/:id =====================
  // Need a project + agent. Create them via REST (repoPath must be a real git repo — REPO_DIR above;
  // vault browser/git aren't touched here, so vaultPath can stay LOOM_HOME).
  const proj = await json("POST", "/api/projects", { name: "RestProj", repoPath: REPO_DIR, vaultPath: LOOM_HOME });
  check("setup: project created", proj.status === 201 && !!proj.body.id);
  const agent = await json("POST", `/api/projects/${proj.body.id}/agents`, { name: "AssignAgent" });
  check("setup: agent created, profile-less", agent.status === 201 && agent.body.profileId === null);
  const tid = agent.body.id;

  // SET profileId → the bundled Dev profile.
  const setRes = await json("POST", `/api/agents/${tid}`, { profileId: bundledDev.id });
  check("POST /api/agents/:id SETS profileId", setRes.status === 200 && setRes.body.profileId === bundledDev.id);
  // A patch omitting profileId leaves the assignment intact.
  const nameOnly = await json("POST", `/api/agents/${tid}`, { name: "Renamed" });
  check("POST /api/agents/:id without profileId leaves the assignment as-is", nameOnly.body.profileId === bundledDev.id && nameOnly.body.name === "Renamed");
  // CLEAR profileId (null) → falls back to the plain backstop.
  const clearRes = await json("POST", `/api/agents/${tid}`, { profileId: null });
  check("POST /api/agents/:id CLEARS profileId (null)", clearRes.status === 200 && clearRes.body.profileId === null);
  // 404 on a bogus (non-null) profileId — and it must NOT mutate the agent.
  const bogus = await json("POST", `/api/agents/${tid}`, { profileId: "no-such-profile" });
  check("POST /api/agents/:id → 404 for a bogus profileId", bogus.status === 404);
  check("POST /api/agents/:id: a rejected bogus assignment did NOT change the agent", (await json("GET", `/api/projects/${proj.body.id}/agents`)).body.find((t) => t.id === tid).profileId === null);
  check("POST /api/agents/:id → 404 for an unknown agent id", (await json("POST", "/api/agents/no-such-agent", { name: "x" })).status === 404);
} finally {
  try { daemon.kill(); } catch { /* ignore */ }
  try { fs.rmSync(LOOM_HOME, { recursive: true, force: true }); } catch { /* best-effort (WAL handle) */ }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — profile CRUD round-trips over REST (201/404/400 validation), reset-to-bundled works, and POST /api/agents/:id sets+clears profileId (404 on a bogus one) — isolated daemon, claude-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
