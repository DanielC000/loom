import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Profiles REST test (Agents→Profiles P3). Boots an ISOLATED daemon (temp LOOM_HOME + a
// non-4317 LOOM_PORT) so it never touches a live :4317 daemon, exercises the new HTTP surface, then
// tears the daemon down. NO claude is spawned (we never POST /sessions — the role→spawn seam is
// covered claude-free by profiles-crud.mjs / profile-spawn.mjs). Covers:
//   • Profile CRUD round-trip: POST create (201) → GET list/get → PUT partial update → POST reset →
//     DELETE; plus GET/PUT/POST-reset 404s and 400 validation (bad role / unknown key).
//   • Agent assignment: POST /api/agents/:id SETS and CLEARS profileId; 404 on a bogus profileId.
// Run (self-contained): node test/profiles-rest.mjs   (honors LOOM_HOME/LOOM_PORT if you pre-set them
// to target an externally-started daemon instead).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.LOOM_PORT) || 4318 + (process.pid % 900); // non-4317, low-collision
const BASE = `http://127.0.0.1:${PORT}`;
const ownDaemon = !process.env.LOOM_HOME; // if the operator pre-set LOOM_HOME we reuse their daemon
const LOOM_HOME = process.env.LOOM_HOME || path.join(os.tmpdir(), `loom-prest-${Date.now()}-${process.pid}`);
fs.mkdirSync(LOOM_HOME, { recursive: true });

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const json = async (method, u, body) => {
  const r = await fetch(BASE + u, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed = null; try { parsed = await r.json(); } catch { /* empty body */ }
  return { status: r.status, body: parsed };
};

// --- boot the isolated daemon (dist/index.js) ---
let daemon = null;
if (ownDaemon) {
  daemon = spawn(process.execPath, [path.join(__dirname, "..", "dist", "index.js")], {
    env: { ...process.env, LOOM_HOME, LOOM_PORT: String(PORT) },
    stdio: "ignore",
  });
}
async function waitReady(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(`${BASE}/api/profiles`); if (r.ok) return true; } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 200));
  }
  return false;
}

try {
  if (!(await waitReady())) { console.error("daemon did not become ready"); process.exit(2); }

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
  // Need a project + agent. Create them via REST (project requires a real-ish path; vault browser/git
  // aren't touched here, so any existing dir works — use LOOM_HOME).
  const proj = await json("POST", "/api/projects", { name: "RestProj", repoPath: LOOM_HOME, vaultPath: LOOM_HOME });
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
  if (daemon) { try { daemon.kill(); } catch { /* ignore */ } }
  if (ownDaemon) { try { fs.rmSync(LOOM_HOME, { recursive: true, force: true }); } catch { /* best-effort (WAL handle) */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — profile CRUD round-trips over REST (201/404/400 validation), reset-to-bundled works, and POST /api/agents/:id sets+clears profileId (404 on a bogus one) — isolated daemon, claude-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
