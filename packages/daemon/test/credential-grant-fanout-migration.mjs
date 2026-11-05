import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Boot-test for card afe1bc90's profile→agent credential-grant fan-out (backfillProfileCredentialGrantsToAgentsOnce).
// The starting DB is built from the COMMITTED v0.31.0 base SCHEMA (test/fixtures/v0.31.0-schema.sql, extracted
// with `git show v0.31.0:packages/daemon/src/db.ts` — never the real DB, never HEAD): agents there have NO
// connections/capabilities columns, profiles DO. Cases: two projects, two agents on one grant-carrying profile
// (one per project), a cross-project-dead connection grant AND capability grant, a dangling connection id,
// an orphan (zero-agent) profile, an empty-grant profile, an unbound agent, and a live session row.
// Asserts (every agent): the per-agent effective reach after the migration equals the OLD union reach minus
// the cross-project-dead grants; the session row is byte-identical; the second boot is a no-op.
//
// Run: 1) build (turbo builds shared first), 2) node test/credential-grant-fanout-migration.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `lcg-fanout-${Date.now().toString(36)}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaSql = fs.readFileSync(path.join(here, "fixtures", "v0.31.0-schema.sql"), "utf8");
const dbFile = path.join(tmpHome, "v0310.db");

const P1 = "proj-1", P2 = "proj-2";
const G = "conn-global", C1 = "conn-p1", C2 = "conn-p2", GHOST = "conn-ghost-deleted";
const PA = "prof-grants", PB = "prof-orphan", PC = "prof-empty", PN = "prof-nullrole";
const A1 = "agent-p1", A2 = "agent-p2", A3 = "agent-unbound", A4 = "agent-emptyprof";
const A5 = "agent-null-plain", A6 = "agent-null-own", A7 = "agent-worker-own";
const S1 = "sess-live";
const now = "2026-01-01T00:00:00.000Z";

{
  const raw = new Database(dbFile);
  raw.pragma("journal_mode = WAL");
  raw.exec(schemaSql);
  check("fixture: v0.31.0 agents table has NO connections column (a genuinely pre-migration shape)",
    !raw.prepare("PRAGMA table_info(agents)").all().some((c) => c.name === "connections"));
  check("fixture: v0.31.0 profiles table HAS the connections column", raw.prepare("PRAGMA table_info(profiles)").all().some((c) => c.name === "connections"));
  const insP = raw.prepare("INSERT INTO projects (id,name,repo_path,vault_path,created_at) VALUES (?,?,?,?,?)");
  insP.run(P1, "Proj One", "/x/one", "/x/v1", now); insP.run(P2, "Proj Two", "/x/two", "/x/v2", now);
  const insC = raw.prepare("INSERT INTO connections (id,name,host,auth_scheme,secret_blob,created_at,project_id) VALUES (?,?,?,?,?,?,?)");
  insC.run(G, "global", "g.example", "bearer", "blob", now, null);
  insC.run(C1, "p1-scoped", "a.example", "bearer", "blob", now, P1);
  insC.run(C2, "p2-scoped", "b.example", "bearer", "blob", now, P2);
  const insPr = raw.prepare("INSERT INTO profiles (id,name,role,connections,capabilities) VALUES (?,?,?,?,?)");
  insPr.run(PA, "Granting", "worker", JSON.stringify([G, C1, C2, GHOST]), JSON.stringify([{ slug: "cap-x", connectionId: C1 }, { slug: "cap-y" }]));
  insPr.run(PB, "Orphan", "worker", JSON.stringify([G]), "[]");
  insPr.run(PC, "Empty", "worker", "[]", "[]");
  const insA = raw.prepare("INSERT INTO agents (id,project_id,name,startup_prompt,position,profile_id) VALUES (?,?,?,?,?,?)");
  insA.run(A1, P1, "A One", "p", 0, PA); insA.run(A2, P2, "A Two", "p", 0, PA);
  insA.run(A3, P1, "A Unbound", "p", 1, null); insA.run(A4, P1, "A Empty", "p", 2, PC);
  // caca806c-era shape: the agent-level grant columns exist already (Card A), so an agent can carry its OWN grants
  // alongside the profile's. Added AFTER the "genuinely pre-migration" assertions above, via the same DDL migrateAgents uses.
  raw.exec("ALTER TABLE agents ADD COLUMN connections TEXT NOT NULL DEFAULT '[]'");
  raw.exec("ALTER TABLE agents ADD COLUMN capabilities TEXT NOT NULL DEFAULT '[]'");
  insPr.run(PN, "Null role", null, JSON.stringify([G]), JSON.stringify([{ slug: "cap-n" }, { slug: "cap-shared" }]));
  insA.run(A5, P1, "A Null Plain", "p", 3, PN);
  insA.run(A6, P1, "A Null Own", "p", 4, PN);
  raw.prepare("UPDATE agents SET connections = ?, capabilities = ? WHERE id = ?").run(JSON.stringify([C1]), JSON.stringify([{ slug: "cap-shared" }]), A6);
  insA.run(A7, P1, "A Worker Own", "p", 5, PA);
  raw.prepare("UPDATE agents SET connections = ? WHERE id = ?").run(JSON.stringify([G]), A7);
  raw.prepare("INSERT INTO sessions (id,project_id,agent_id,cwd,created_at,last_activity,connections,capabilities) VALUES (?,?,?,?,?,?,?,?)")
    .run(S1, P1, A1, "/x/one", now, now, JSON.stringify([G]), JSON.stringify([{ slug: "pinned-cap" }]));
  raw.close();
}

// Snapshot only the columns that EXIST in the v0.31.0 shape (later migrations legitimately ADD columns to
// sessions; what must not change is any pre-existing value, the pinned connections/capabilities above all).
const sessionCols = (() => { const r = new Database(dbFile, { readonly: true }); try { return r.prepare("PRAGMA table_info(sessions)").all().map((c) => c.name); } finally { r.close(); } })();
const snapshotSession = () => { const r = new Database(dbFile, { readonly: true }); try { return JSON.stringify(r.prepare(`SELECT ${sessionCols.join(",")} FROM sessions WHERE id = ?`).get(S1)); } finally { r.close(); } };
const sessionBefore = snapshotSession();
const profileColsBefore = (() => { const r = new Database(dbFile, { readonly: true }); try { return JSON.stringify(r.prepare("SELECT id,connections,capabilities FROM profiles ORDER BY id").all()); } finally { r.close(); } })();

const { Db } = await import("../dist/db.js");
const { resolveProfile, unionConnections, unionCapabilities } = await import("@loom/shared");

let db; let ctorError = null;
try { db = new Db(dbFile); } catch (e) { ctorError = e; console.log(String(e?.stack ?? e)); }
check("(1) constructing Db on the v0.31.0-shape DB does not throw", ctorError === null);

// Independent expectation, computed from the SEED values (not from the migration's code path): the OLD
// resolution (profile ∪ agent, profile first) minus anything scoped to a different project.
const scope = { [G]: null, [C1]: P1, [C2]: P2 };
const usable = (id, proj) => !(id in scope) || scope[id] === null || scope[id] === proj; // dangling id: kept (fails closed at use)
const profGrants = { [PA]: { c: [G, C1, C2, GHOST], k: [{ slug: "cap-x", connectionId: C1 }, { slug: "cap-y" }] }, [PB]: { c: [G], k: [] }, [PC]: { c: [], k: [] }, [PN]: { c: [G], k: [{ slug: "cap-n" }, { slug: "cap-shared" }] } };
// [project, profile, agent's OWN connections, agent's OWN capabilities] — the last two are the caca806c-era shape.
const agentSeed = { [A1]: [P1, PA, [], []], [A2]: [P2, PA, [], []], [A3]: [P1, null, [], []], [A4]: [P1, PC, [], []], [A5]: [P1, PN, [], []], [A6]: [P1, PN, [C1], [{ slug: "cap-shared" }]], [A7]: [P1, PA, [G], []] };
for (const [aid, [proj, pid, ownC, ownK]] of Object.entries(agentSeed)) {
  const oldC = unionConnections(pid ? profGrants[pid].c : [], ownC);
  const oldK = unionCapabilities(pid ? profGrants[pid].k : [], ownK);
  const expC = oldC.filter((id) => usable(id, proj));
  // R10: a cross-project capability binding is STRIPPED (slug kept), never the whole capability dropped.
  const expK = oldK.map((g) => (g.connectionId && !usable(g.connectionId, proj) ? { slug: g.slug } : g));
  const a = db.getAgent(aid);
  const resolved = resolveProfile(a, pid ? db.getProfile(pid) : null);
  check(`(2) ${aid}: agent-only resolved connections == OLD union reach minus cross-project-dead`, JSON.stringify(resolved.connections) === JSON.stringify(expC));
  check(`(2) ${aid}: agent-only resolved capabilities == OLD union reach minus cross-project-dead`, JSON.stringify(resolved.capabilities) === JSON.stringify(expK));
}
check("(3) A2 (project 2) KEPT cap-x by slug with its project-1 binding stripped (R10), and lost the project-1 connection, kept project-2's",
  JSON.stringify(db.getAgent(A2).capabilities) === JSON.stringify([{ slug: "cap-x" }, { slug: "cap-y" }]) && !db.getAgent(A2).connections.includes(C1) && db.getAgent(A2).connections.includes(C2));
check("(3) A1 (project 1) lost project 2's connection, kept its own + global + the dangling id",
  !db.getAgent(A1).connections.includes(C2) && db.getAgent(A1).connections.includes(C1) && db.getAgent(A1).connections.includes(GHOST));

const sum = db.getCredentialGrantFanoutSummary();
check("(4) summary stored", !!sum && sum.v === 1);
const sPA = sum?.profiles.find((p) => p.profileId === PA);
const sPB = sum?.profiles.find((p) => p.profileId === PB);
check("(4) summary: granting profile has all three bound agents, not orphaned", sPA?.agents.length === 3 && sPA.orphaned === false);
check("(4) summary: A2's dead connection C1 recorded as dropped, and cap-x's C1 binding recorded as STRIPPED (slug kept)",
  sPA?.agents.find((a) => a.agentId === A2)?.droppedCrossProject.some((d) => d.kind === "connection" && d.connectionId === C1)
  && sPA?.agents.find((a) => a.agentId === A2)?.strippedCapabilityBindings.some((s) => s.slug === "cap-x" && s.connectionId === C1)
  && !sPA?.agents.find((a) => a.agentId === A2)?.droppedCrossProject.some((d) => d.kind !== "connection"));
// R9: durable per-agent provenance of what arrived from a role:null profile (null→worker exemption), written in the fan-out txn.
check("(4b) provenance: A5 (null-role profile, no own grants) exempts the profile's connection + both slugs",
  JSON.stringify(db.getFanoutExemption(A5)) === JSON.stringify({ connections: [G], capabilities: ["cap-n", "cap-shared"] }));
check("(4b) provenance: A6's OWN pre-existing cap-shared / C1 are NOT exempt (caca806c-era grant keeps its refusal); only the fanned-out remainder is",
  JSON.stringify(db.getFanoutExemption(A6)) === JSON.stringify({ connections: [G], capabilities: ["cap-n"] }));
check("(4b) provenance: agents on a role:'worker' profile (A1, A7) carry NO exemption (the old exemption was null-role only)",
  [A1, A2, A7].every((id) => db.getFanoutExemption(id).connections.length === 0 && db.getFanoutExemption(id).capabilities.length === 0));
check("(4b) provenance record and marker keys are both PRESENT (key presence only — not their ordering or same-txn atomicity)", !!db.getMeta("profile_credential_grants_fanout_exempt") && !!db.getMeta("profile_credential_grants_fanout_done"));
check("(4) summary: dangling connection id recorded", sPA?.agents.find((a) => a.agentId === A1)?.dangling.includes(GHOST));
check("(4) summary: orphan profile recorded with no agents", sPB?.orphaned === true && sPB.agents.length === 0);
check("(4) summary: empty-grant profile NOT recorded", !sum?.profiles.some((p) => p.profileId === PC));

check("(5) a live session row is byte-identical across the migration", snapshotSession() === sessionBefore);
const profileColsAfter = (() => { const r = new Database(dbFile, { readonly: true }); try { return JSON.stringify(r.prepare("SELECT id,connections,capabilities FROM profiles ORDER BY id").all()); } finally { r.close(); } })();
check("(6) profiles.connections/capabilities columns are left DORMANT, untouched", profileColsAfter === profileColsBefore);
check("(7) the one-shot marker is stamped", !!db.getMeta("profile_credential_grants_fanout_done"));
const agentsAfterFirst = JSON.stringify([A1, A2, A3, A4].map((id) => db.getAgent(id)));
// Mutate an agent AFTER the first boot: a re-run of the fan-out would clobber this with the profile union.
db.updateAgent(A1, { connections: [G] });
const mutated = JSON.stringify(db.getAgent(A1));
db.close?.();

// ----- second boot: idempotent -----
const db2 = new Db(dbFile);
check("(8) second boot: the fan-out does NOT re-run (a post-migration agent edit survives)", JSON.stringify(db2.getAgent(A1)) === mutated);
check("(8) second boot: untouched agents unchanged", JSON.stringify([A2, A3, A4].map((id) => db2.getAgent(id))) === JSON.stringify(JSON.parse(agentsAfterFirst).slice(1)));
check("(8) second boot: backfill call returns undefined (already done)", db2.backfillProfileCredentialGrantsToAgentsOnce() === undefined);
check("(8) second boot: summary unchanged", JSON.stringify(db2.getCredentialGrantFanoutSummary()) === JSON.stringify(sum));
check("(8) second boot: session row still byte-identical", snapshotSession() === sessionBefore);
db2.close?.();

fs.rmSync(tmpHome, { recursive: true, force: true });
if (failures) { console.log(`\n${failures} FAILURE(S)`); process.exit(1); }
console.log("\nALL PASS");
