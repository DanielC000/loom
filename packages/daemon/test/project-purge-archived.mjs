import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 54017db2 — the human-confirmed PURGE of an ARCHIVED project (REST only; no agent MCP path).
//
//   (A) CENSUS: every table that carries a project_id column or an FK to projects/agents is one this file
//       knows how to seed — a NEW project-keyed table fails here, so it cannot silently dodge the cascade.
//   (B) CASCADE: a purge of an archived fixture leaves EVERY table at the row counts it had before the
//       fixture was seeded (a sibling's rows, seeded first, survive untouched). RED on the pre-card
//       deleteProject, which threw FOREIGN KEY constraint failed on event_triggers / memory / links / etc.
//   (C) REFUSALS: a LIVE (non-archived) project, a RESERVED project, an unknown id, a wrong confirmName and
//       a project with a live session are all refused, and nothing is deleted.
//   (D) BACKUP: a successful purge takes a pre-purge DB snapshot first and reports its path; the preview
//       route names per-kind counts.
//
// HERMETIC: own temp LOOM_HOME, Db + buildServer via app.inject, no claude, no network.
// Run: 1) build, 2) node test/project-purge-archived.mjs
import fs from "node:fs";
import path from "node:path";
import { useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const loomHome = fs.realpathSync(useOwnLoomHome("loom-purge-", { fresh: true }));
import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");

const now = new Date().toISOString();
const db = new Db();
const raw = db.db;

// ---- generic seeder: fills every NOT NULL column that has no default, FKs/ids passed explicitly ----
let filler = 0; // unique dummy text, so two seeded projects never collide on a defaulted PK/unique column
function seed(table, vals) {
  const cols = raw.prepare(`PRAGMA table_info(${table})`).all();
  const row = {};
  for (const c of cols) {
    if (c.name in vals) row[c.name] = vals[c.name];
    else if ((c.notnull || c.pk) && c.dflt_value === null && !(c.pk && /INT/i.test(c.type))) row[c.name] = /INT|REAL|NUM/i.test(c.type) ? 0 : `x${++filler}`;
  }
  const names = Object.keys(row);
  raw.prepare(`INSERT INTO ${table} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`).run(...names.map((n) => row[n]));
}

// Everything a project can own, seeded under one id prefix. Returns nothing; counts are read generically.
function seedProject(pid, { archived }) {
  db.insertProject({ id: pid, name: `name-${pid}`, repoPath: path.join(loomHome, pid), vaultPath: "", config: {}, createdAt: now, archivedAt: archived ? now : null, reserved: false });
  const a = `${pid}-agent`, s = `${pid}-sess`, t = `${pid}-task`, conn = `${pid}-conn`, ep = `${pid}-ep`;
  seed("agents", { id: a, project_id: pid });
  seed("sessions", { id: s, project_id: pid, agent_id: a, process_state: "exited", worktree_path: path.join(loomHome, `${pid}-wt`) });
  seed("tasks", { id: t, project_id: pid });
  seed("task_relations", { id: `${pid}-rel`, project_id: pid, from_task_id: t, to_task_id: t, declared: 1 });
  seed("schedules", { agent_id: a });
  seed("runs", { id: `${pid}-run`, project_id: pid, agent_id: a });
  seed("run_events", { project_id: pid, run_id: `${pid}-run` });
  seed("api_keys", { id: `${pid}-key`, project_id: pid });
  seed("orchestration_events", { manager_session_id: s });
  seed("event_triggers", { id: `${pid}-trg1`, project_id: pid });
  seed("event_triggers", { id: `${pid}-trg2`, project_id: null, agent_id: a });
  seed("connections", { id: conn, project_id: pid });
  seed("poll_jobs", { id: `${pid}-poll`, agent_id: a, connection_id: conn });
  seed("webhook_endpoints", { id: ep, agent_id: a });
  seed("webhook_deliveries", { endpoint_id: ep });
  seed("project_memory", { project_id: pid, key: "k" });
  seed("project_memory_history", { project_id: pid, key: "k" });
  seed("project_config_history", { project_id: pid });
  seed("questions", { id: `${pid}-q`, project_id: pid, session_id: s });
  seed("delivered_credentials", { project_id: pid });
  seed("mainline_landed_commits", { project_id: pid });
  seed("batch_landed_worker_tips", { project_id: pid });
  seed("pending_gate_ops", { project_id: pid });
  seed("project_merge_gate_state", { project_id: pid });
  seed("session_usage_samples", { session_id: s, project_id: pid });
  seed("companion_capability_grants", { session_id: s, project_id: pid });
  seed("card_policy_matches", { task_id: t });
  seed("card_policy_waivers", { task_id: t });
  seed("card_policy_matches_v2", { task_id: t, project_id: pid });
  seed("card_policy_waivers_v2", { task_id: t, project_id: pid });
  for (const ct of ["companion_bindings", "companion_allowed_senders", "companion_config", "companion_voice_prefs", "companion_pairing_codes"]) seed(ct, { session_id: s });
  seed("companion_conversations", { session_id: s, seq: 1 });
  seed("companion_messages", { session_id: s, seq: 1 });
  seed("companion_reminders", { session_id: s });
  seed("wakes", { session_id: s });
  seed("mcp_call_log", { session_id: s });
  db.setMeta(`mainline-watermark:${pid}:primary`, "x");
}
const otherId = (pid) => `${pid}-other`;

const tables = () => raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'project_memory_fts%' ORDER BY name").all().map((r) => r.name);
const counts = () => Object.fromEntries(tables().map((t) => [t, raw.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c]));

// ===== (A) census, DERIVED from the schema: every table keyed to a project/agent/session/task is flagged,
// and each flagged table must have gained rows when the fixture was seeded (checked after seeding below) —
// so a NEW such table can neither dodge the cascade nor be "covered" by merely being named in a list. =====
const KEY_COL = /(^|_)(project|session|agent|task)_id$/;
const censusFlagged = () => tables().filter((t) => {
  const cols = raw.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  const fks = raw.prepare(`PRAGMA foreign_key_list(${t})`).all().map((f) => f.table);
  return cols.some((c) => KEY_COL.test(c)) || fks.some((x) => x === "projects" || x === "agents" || x === "sessions");
}).filter((t) => t !== "projects");

// ===== fixtures =====
seedProject("pKeep", { archived: false });          // a LIVE sibling whose rows must survive
db.insertProject({ id: "pReserved", name: "Reserved", repoPath: loomHome, vaultPath: loomHome, config: {}, createdAt: now, archivedAt: now, reserved: true, vaultOnly: true });
db.insertProject({ id: "pLiveSess", name: "LiveSess", repoPath: path.join(loomHome, "ls"), vaultPath: "", config: {}, createdAt: now, archivedAt: now, reserved: false });
seed("agents", { id: "pLiveSess-agent", project_id: "pLiveSess" });
seed("sessions", { id: "pLiveSess-sess", project_id: "pLiveSess", agent_id: "pLiveSess-agent", process_state: "live" });
const doomed = "9b1c5d2e-3f4a-4b6c-8d7e-0a1b2c3d4e5f"; // UUID-shaped, so the archive/work-dir removals really run
const baseline = counts();                           // everything EXCEPT the doomed project and its link
seedProject(doomed, { archived: true });
raw.prepare("INSERT INTO project_links (id, project_a_id, project_b_id, created_at) VALUES (?,?,?,?)").run("lnk1", doomed, "pKeep", now);
const seededCounts = counts();
const flagged = censusFlagged();
const unseeded = flagged.filter((t) => !(seededCounts[t] > baseline[t]));
check(`(A) every census-flagged table (${flagged.length}) gained rows from the fixture (not seeded: ${unseeded.join(",") || "none"})`, unseeded.length === 0);
check("(A) the census is a real population (the known keyed tables are in it)", ["agents", "sessions", "tasks", "event_triggers", "project_memory", "questions", "mcp_call_log", "poll_jobs"].every((t) => flagged.includes(t)));
check("(B) setup: project_links gained the link row", seededCounts.project_links > baseline.project_links);
const beforeRefusals = counts();

let gateLive = false;
let backupHook = null; // (realBackup) => Promise<string|null>; null = the real snapshot
const { takePrePurgeBackup } = await import("../dist/orchestration/db-backup.js");
const stub = {};
const sessionsStub = { hasLiveGateForProject: () => gateLive };
const app = await buildServer({
  db, pty: stub, sessions: sessionsStub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub,
  takePurgeBackup: async () => (backupHook ? backupHook(takePrePurgeBackup) : takePrePurgeBackup()),
});
const preDir = path.join(loomHome, "backups", "pre-purge");

try {
  // ===== (C) refusals =====
  const post = (id, body) => app.inject({ method: "POST", url: `/api/projects/${id}/purge`, payload: body });
  const live = await post("pKeep", { confirmName: "name-pKeep" });
  check("(C) a LIVE (non-archived) project is refused with 400", live.statusCode === 400 && /ARCHIVED/.test(live.json().error));
  const res = await post("pReserved", { confirmName: "Reserved" });
  check("(C) a RESERVED project is refused with 400", res.statusCode === 400 && /reserved/.test(res.json().error));
  const unk = await post("nope", { confirmName: "x" });
  check("(C) an unknown project is 404", unk.statusCode === 404);
  const ls = await post("pLiveSess", { confirmName: "LiveSess" });
  check("(C) an archived project with a LIVE session is refused", ls.statusCode === 400 && /live sessions/.test(ls.json().error));
  const wrong = await post(doomed, { confirmName: `name-${doomed}-typo` });
  check("(C) a wrong confirmName is refused", wrong.statusCode === 400 && /confirmName/.test(wrong.json().error));
  const none = await post(doomed, {});
  check("(C) a missing confirmName is refused", none.statusCode === 400);
  const prevLive = await app.inject({ method: "GET", url: "/api/projects/pKeep/purge-preview" });
  check("(C) the preview route also refuses a live project", prevLive.statusCode === 400);
  check("(C) NOTHING was deleted by any refusal (every table's row count unchanged)",
    JSON.stringify(counts()) === JSON.stringify(beforeRefusals));
  check("(C) the refusals took no backup", !fs.existsSync(preDir) || fs.readdirSync(preDir).length === 0);

  // ----- a running/queued gate, a STARTING session, a failed backup, and a state flip DURING the backup -----
  const confirm = { confirmName: `name-${doomed}` };
  gateLive = true;
  const g = await post(doomed, confirm);
  check("(C) a live/queued gate for the project refuses the purge", g.statusCode === 400 && /gate/.test(g.json().error));
  gateLive = false;
  raw.prepare("UPDATE sessions SET process_state = 'starting' WHERE id = ?").run(`${doomed}-sess`);
  const st = await post(doomed, confirm);
  check("(C) a STARTING session counts as live and refuses the purge", st.statusCode === 400 && /live sessions/.test(st.json().error));
  raw.prepare("UPDATE sessions SET process_state = 'exited' WHERE id = ?").run(`${doomed}-sess`);
  check("(C) the gate and starting refusals deleted nothing", JSON.stringify(counts()) === JSON.stringify(beforeRefusals));

  fs.mkdirSync(path.dirname(preDir), { recursive: true });
  fs.writeFileSync(preDir, "a FILE where the backup dir must go"); // mkdir of it now fails -> the snapshot fails
  const bf = await post(doomed, confirm);
  check(`(C) a failed backup refuses with 500 (status ${bf.statusCode})`, bf.statusCode === 500 && /backup/.test(bf.json().error));
  check("(C) a failed backup deleted nothing", JSON.stringify(counts()) === JSON.stringify(beforeRefusals));
  fs.rmSync(preDir, { force: true });

  // The snapshot is awaited, so the project can change underneath the purge. Each flip happens AFTER the real
  // snapshot succeeded and BEFORE the delete: the purge must re-check and refuse with 409, keeping the snapshot.
  const flips = [
    ["a session started during the backup", () => raw.prepare("UPDATE sessions SET process_state = 'live' WHERE id = ?").run(`${doomed}-sess`), () => raw.prepare("UPDATE sessions SET process_state = 'exited' WHERE id = ?").run(`${doomed}-sess`)],
    ["the project was restored (un-archived) during the backup", () => db.restoreProject(doomed), () => db.archiveProject(doomed)],
    ["a gate started during the backup", () => { gateLive = true; }, () => { gateLive = false; }],
  ];
  for (const [what, flip, unflip] of flips) {
    const snapsBefore = fs.existsSync(preDir) ? fs.readdirSync(preDir).length : 0;
    backupHook = async (real) => { const p = await real(); flip(); return p; };
    const r = await post(doomed, confirm);
    backupHook = null;
    unflip();
    const snapsAfter = fs.existsSync(preDir) ? fs.readdirSync(preDir).length : 0;
    check(`(C) ${what}: 409, nothing deleted, snapshot kept (status ${r.statusCode})`,
      r.statusCode === 409 && /changed while the backup/.test(r.json().error) && JSON.stringify(counts()) === JSON.stringify(beforeRefusals) && snapsAfter === snapsBefore + 1);
  }

  // ===== (D) preview names per-kind counts =====
  const prev = await app.inject({ method: "GET", url: `/api/projects/${doomed}/purge-preview` });
  const items = prev.json().items ?? [];
  const byKind = Object.fromEntries(items.map((i) => [i.kind, i.count]));
  check("(D) preview: 200 with per-kind counts incl. sessions, tasks, worktree rows, memory notes, event triggers",
    prev.statusCode === 200 && byKind.sessions === 1 && byKind.tasks === 1 && byKind["worktree rows"] === 1 && byKind["memory notes"] === 1 && byKind["event triggers"] === 2);

  // ===== (B) the purge itself =====
  const ok = await post(doomed, { confirmName: `name-${doomed}` });
  check(`(B) the purge of an archived fixture succeeds (status ${ok.statusCode} ${ok.statusCode === 200 ? "" : ok.body})`, ok.statusCode === 200 && ok.json().ok === true);
  const after = counts();
  const leaks = Object.keys(baseline).filter((t) => after[t] !== baseline[t]);
  check(`(B) every table is back at its pre-fixture row count — nothing of the doomed project survives, the live sibling's rows do (leaks: ${leaks.map((t) => `${t}:${after[t]}≠${baseline[t]}`).join(", ") || "none"})`, leaks.length === 0);
  check("(B) the project row itself is gone", !db.getProject(doomed));
  check("(B) the doomed project's app_meta key is gone, the sibling's remains",
    db.getMeta(`mainline-watermark:${doomed}:primary`) === undefined && db.getMeta("mainline-watermark:pKeep:primary") === "x");
  const bk = ok.json().backup;
  check("(D) a pre-delete DB backup was taken first, its file exists, and it is in backups/pre-purge (outside the rotated auto/ dir)",
    typeof bk === "string" && fs.existsSync(bk) && path.dirname(bk) === preDir);
  const again = await post(doomed, { confirmName: `name-${doomed}` });
  check("(C) a second purge of the now-gone project is 404", again.statusCode === 404);

  // ===== (E) rotation can never prune a pre-purge snapshot; preview names the dir and a connection a
  // foreign poll job still uses is neither counted nor deleted =====
  const { rotateBackups } = await import("../dist/orchestration/db-backup.js");
  rotateBackups(path.join(loomHome, "backups", "auto"), 1);
  check("(E) rotateBackups on the auto dir leaves pre-purge snapshots alone", fs.existsSync(bk));

  db.insertProject({ id: "pConn", name: "ConnProj", repoPath: path.join(loomHome, "pc"), vaultPath: "", config: {}, createdAt: now, archivedAt: now, reserved: false });
  seed("connections", { id: "pConn-conn", project_id: "pConn" });
  seed("connections", { id: "pConn-conn2", project_id: "pConn" });
  seed("poll_jobs", { id: "pConn-foreign-poll", agent_id: "pKeep-agent", connection_id: "pConn-conn" }); // another project's agent
  const pv = (await app.inject({ method: "GET", url: "/api/projects/pConn/purge-preview" })).json();
  check("(E) preview reports backupDir and counts only the connection that will really be removed (1 of 2)",
    pv.backupDir === preDir && pv.items.find((i) => i.kind === "connections").count === 1);
  const pc = await post("pConn", { confirmName: "ConnProj" });
  check("(E) the purge succeeds; the still-referenced connection and the foreign poll job survive, the other connection is gone",
    pc.statusCode === 200 && !!raw.prepare("SELECT 1 FROM connections WHERE id = 'pConn-conn'").get() && !raw.prepare("SELECT 1 FROM connections WHERE id = 'pConn-conn2'").get()
    && !!raw.prepare("SELECT 1 FROM poll_jobs WHERE id = 'pConn-foreign-poll'").get());
  raw.prepare("DELETE FROM poll_jobs WHERE id = 'pConn-foreign-poll'").run();
  raw.prepare("DELETE FROM connections WHERE id = 'pConn-conn'").run();

  // ===== (F) the LIVE /permanent path takes the same mandatory backup and re-checks after it =====
  const base2 = counts();
  seedProject("pPerm", { archived: false });
  const delPerm = () => app.inject({ method: "DELETE", url: "/api/projects/pPerm/permanent" });
  backupHook = async () => null;
  const pf = await delPerm();
  backupHook = null;
  check("(F) /permanent with a failed backup is 500 and deletes nothing", pf.statusCode === 500 && !!db.getProject("pPerm"));
  backupHook = async (real) => { const p = await real(); raw.prepare("UPDATE sessions SET process_state = 'live' WHERE id = 'pPerm-sess'").run(); return p; };
  const pfl = await delPerm();
  backupHook = null;
  raw.prepare("UPDATE sessions SET process_state = 'exited' WHERE id = 'pPerm-sess'").run();
  check("(F) /permanent: a session started during the backup is a 409 and deletes nothing", pfl.statusCode === 409 && !!db.getProject("pPerm"));
  const pp = await delPerm();
  const after2 = counts();
  const leaks2 = Object.keys(base2).filter((t) => after2[t] !== base2[t]);
  check(`(F) /permanent of a live project succeeds, reports a pre-purge backup, and removes every dependent row (leaks: ${leaks2.join(",") || "none"})`,
    pp.statusCode === 200 && path.dirname(pp.json().backup) === preDir && fs.existsSync(pp.json().backup) && !db.getProject("pPerm") && leaks2.length === 0);
} finally {
  await app.close();
}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
await finishAndExit(failures === 0 ? 0 : 1);
