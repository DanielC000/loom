import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Guard for card afe1bc90: profiles.connections / profiles.capabilities are DORMANT — nothing reads them
// except the one-shot fan-out migration. Two layers, each shown RED on a known-bad input:
//   (S) SOURCE-TEXT scan of packages/daemon/src (name: a text scan of profile-table SQL + the toProfile
//       row mapper, NOT a proof that no code path reads a Profile's value some other way — the Profile
//       TYPE has no such fields any more, which tsc enforces separately).
//   (B) BEHAVIOUR: plant grants straight into a profile row; resolution, the profile read model and the
//       pending-bindings queue must be unaffected.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.join(here, "..", "src");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".ts") ? [path.join(d, e.name)] : []));

/** Lines (comment-stripped) that touch the profiles TABLE and name a dormant column, plus any `toProfile` body that does. */
export function dormantProfileColumnReaders(file, text) {
  const hits = [];
  const code = strip(text);
  const lines = code.split("\n");
  lines.forEach((ln, i) => {
    if (/\b(FROM|INTO|UPDATE|JOIN)\s+profiles\b/i.test(ln) && /\b(connections|capabilities)\b/.test(ln)) hits.push(`${path.basename(file)}:${i + 1} profile-table SQL names a dormant column`);
  });
  const m = /function toProfile\(([\s\S]*?)\n}\n/.exec(code);
  if (m && /\b(connections|capabilities)\b/.test(m[1])) hits.push(`${path.basename(file)} toProfile mapper reads a dormant column`);
  // the SELECT above may span lines: look for a multi-line statement window too
  const win = code.match(/FROM\s+profiles[^;`]{0,200}/gi) ?? [];
  for (const w of win) if (/\b(connections|capabilities)\b/.test(w)) hits.push(`${path.basename(file)} multi-line profiles SELECT names a dormant column`);
  return hits;
}

// ----- (S) the real corpus: the ONE sanctioned reader is the fan-out migration's SELECT -----
const real = walk(srcRoot).flatMap((f) => dormantProfileColumnReaders(f, fs.readFileSync(f, "utf8")));
check("(S) real corpus: the only profile-table reader of a dormant column is the fan-out SELECT (db.ts)",
  real.length >= 1 && real.every((h) => h.startsWith("db.ts")) && real.length === 1);

// (S) negative control — a PLANTED reader (a toProfile that parses the column back) must be flagged.
const planted = `function toProfile(r0) {\n  const r = r0;\n  return { connections: JSON.parse(r.connections || "[]") };\n}\n`;
check("(S) NEGATIVE CONTROL: a planted toProfile reader of connections is flagged", dormantProfileColumnReaders("planted.ts", planted).length === 1);
const planted2 = "const x = db.prepare(`SELECT capabilities FROM profiles WHERE id = ?`);";
check("(S) NEGATIVE CONTROL: a planted `SELECT capabilities FROM profiles` is flagged", dormantProfileColumnReaders("planted2.ts", planted2).length === 1);
// positive control: the scanner must hit on the PRE-change tree (fixed sha, never HEAD) where toProfile DID read them.
const repoRoot = path.join(here, "..", "..", "..");
const pre = execFileSync("git", ["--no-pager", "show", "403b397f:packages/daemon/src/db.ts"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
check("(S) POSITIVE CONTROL: pre-change db.ts (sha 403b397f) is flagged for its toProfile + profile SQL", dormantProfileColumnReaders("db.ts", pre).length >= 2);
check("(S) bogus-pattern control: a clean snippet returns 0", dormantProfileColumnReaders("clean.ts", "const a = 1; // connections\n").length === 0);

// ----- (B) behaviour -----
const tmpHome = path.join(os.tmpdir(), `lcg-dormant-${Date.now().toString(36)}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();
const Database = (await import("better-sqlite3")).default;
const { Db } = await import("../dist/db.js");
const { resolveProfile } = await import("@loom/shared");
const dbFile = path.join(tmpHome, "d.db");
const db = new Db(dbFile);
const now = new Date().toISOString();
db.insertProject({ id: "p1", name: "P", repoPath: "/x", vaultPath: "/v", config: {}, createdAt: now });
db.insertProfile({ id: "pf", name: "Prof", role: null, description: "", allowDelta: [], skills: null, model: null, icon: null, browserTesting: false, documentConversion: false, vaultWrite: false, restrictedTools: false, noCommit: false });
db.insertAgent({ id: "ag", projectId: "p1", name: "A", startupPrompt: "", position: 0, profileId: "pf", endpoint: false, ioSchema: null });
// A REAL pending credential binding: the agent's session filed a credential ask naming profile `pf`, and the
// answer boundary provisioned connection "planted-conn" but (by design) never applied it.
db.insertSession({
  id: "sess-ag", projectId: "p1", agentId: "ag", engineSessionId: "eng-ag", title: null, cwd: "p1",
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager",
});
{
  const { buildQuestionAsk } = await import("../dist/mcp/questionTool.js");
  const built = buildQuestionAsk(
    { type: "credential", title: "Need a token", body: "x", provisionTo: { connection: { name: "Planted", host: "api.planted.example" }, binding: { profileId: "pf" } } },
    { sessionId: "sess-ag", projectId: "p1", db, role: "manager" },
  );
  if ("error" in built) throw new Error(`unexpected buildQuestionAsk error: ${built.error}`);
  db.insertQuestion({ ...built.question, id: "q-pending" });
}
db.close?.();
// PLANT grants straight into the dormant columns, and mark the question answered-with-pending-binding (what the answer boundary writes).
{
  const raw = new Database(dbFile);
  raw.prepare("UPDATE profiles SET connections = ?, capabilities = ? WHERE id = 'pf'").run(JSON.stringify(["planted-conn"]), JSON.stringify([{ slug: "planted-cap" }]));
  raw.prepare("UPDATE questions SET state = 'answered', provision_connection_id = 'planted-conn', provision_binding_state = 'pending' WHERE id = 'q-pending'").run();
  raw.close();
}
const db2 = new Db(dbFile);
const prof = db2.getProfile("pf");
check("(B) getProfile carries NO connections/capabilities keys", !("connections" in prof) && !("capabilities" in prof));
check("(B) listProfiles rows carry no such keys", db2.listProfiles().every((p) => !("connections" in p) && !("capabilities" in p)));
const resolved = resolveProfile(db2.getAgent("ag"), prof);
check("(B) resolveProfile ignores the planted profile grants (agent-only)", resolved.connections.length === 0 && resolved.capabilities.length === 0);
const pend = db2.listPendingBindings();
check("(B) the seeded pending binding IS listed (so the next check can fail)", pend.length === 1 && pend[0].questionId === "q-pending" && pend[0].connectionId === "planted-conn" && pend[0].agentId === "ag");
check("(B) a planted profile grant does NOT mark the binding alreadyGranted (agent-keyed)", pend[0]?.alreadyGranted === false);
db2.updateAgent("ag", { connections: ["planted-conn"] });
check("(B) CONTROL: the AGENT holding the connection DOES flip alreadyGranted (the check can go true)", db2.listPendingBindings()[0]?.alreadyGranted === true);
db2.updateAgent("ag", { connections: [] });
db2.close?.();
// the 2nd boot must NOT re-run the fan-out and so must not copy the planted values onto the agent: read the RAW agents columns.
{
  const raw = new Database(dbFile, { readonly: true });
  const row = raw.prepare("SELECT connections, capabilities FROM agents WHERE id = 'ag'").get();
  raw.close();
  check("(B) RAW agents.connections/capabilities columns are still '[]' — the planted profile values were not fanned out", row.connections === "[]" && row.capabilities === "[]");
}
db2.close?.();
fs.rmSync(tmpHome, { recursive: true, force: true });
if (failures) { console.log(`\n${failures} FAILURE(S)`); process.exit(1); }
console.log("\nALL PASS");
