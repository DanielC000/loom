import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 753092fe — scripts/backfill-task-relations.mjs: the one-off, human-run prose -> relations backfill.
//
// HERMETIC: a real Db on a temp file (never the live one), driving the script's exported backfill() and, for the
// safety refusals, the script's own CLI as a child process.
//
// Proves: (R) `Related to: <uuid>` => related; (P) title tag / body `Parent:` => parentId; (S) skips with a
// reason — ambiguous prefix, cross-project, self, depth cap, short 8-hex related, bare anchor marker, an
// already-set parent; (D) dry-run persists NOTHING yet reports the same counts a write does; (I) a second
// --write converts 0; (X) the CLI refuses the live DB path and a missing --db.
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(here, "..", "scripts", "backfill-task-relations.mjs");
const { Db } = await import("../dist/db.js");
const { backfill, extractProse } = await import(pathToFileURL(scriptPath).href);

const file = path.join(os.tmpdir(), `loom-backfill-rel-${Date.now()}-${process.pid}.db`);
const db = new Db(file);
const now = new Date().toISOString();
const uid = (n) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
let seq = 0;
const mk = (projectId, title, body = "", extra = {}) => {
  ++seq;
  const id = extra.id ?? uid(0xa0000000 + seq);
  db.insertTask({
    id, projectId, title, body, columnKey: "todo", position: seq, priority: "p2",
    createdAt: new Date(Date.parse(now) + seq).toISOString(), updatedAt: now, version: 1, ...extra, id,
  });
  return extra.id ?? id;
};
const parentOf = (id) => db.getTask(id).parentId ?? null;
const relatedOf = (p) => db.listRelations(p).filter((e) => e.type === "related").map((e) => `${e.fromTaskId}|${e.toTaskId}`).sort();
const snapshot = () => JSON.stringify([db.listTasks("pA").map((t) => [t.id, t.parentId ?? null, t.updatedAt, t.version]), db.listRelations("pA").length, db.listRelations("pB").length]);

try {
  db.insertProject({ id: "pA", name: "A", repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
  db.insertProject({ id: "pB", name: "B", repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });

  // parents: an epic with a child (title tag, 8-hex prefix) and a child (body `Parent:` with the full uuid)
  const epic = mk("pA", "[Epic] the big thing");
  const kidTag = mk("pA", `feat(x): part one [epic ${epic.slice(0, 8)}, lever 1]`);
  const kidBody = mk("pA", "feat(x): part two", `Parent: ${epic}\nmore text`);
  // depth cap: kidTag is depth 1, grand depth 2 (ok), great would be depth 3 (refused)
  const grand = mk("pA", `feat(x): sub [epic ${kidTag.slice(0, 8)}]`);
  const great = mk("pA", `feat(x): subsub [epic ${grand.slice(0, 8)}]`);
  // ambiguous prefix: two cards share the 8-hex prefix `deadbeef`
  const amb1 = mk("pA", "amb one", "", { id: "deadbeef-0000-4000-8000-000000000001" });
  const amb2 = mk("pA", "amb two", "", { id: "deadbeef-0000-4000-8000-000000000002" });
  void amb1; void amb2;
  const kidAmb = mk("pA", "feat(x): amb child [epic deadbeef]");
  // cross-project parent
  const foreign = mk("pB", "[Epic] other board");
  const kidForeign = mk("pA", `feat(x): foreign child [epic ${foreign.slice(0, 8)}]`);
  // self reference, bare anchor marker, unresolved ref
  const selfCard = mk("pA", "feat(x): selfy [epic 5e1f0000]", "", { id: "5e1f0000-0000-4000-8000-000000000000" });
  const anchorOnly = mk("pA", "Some umbrella (umbrella)");
  const kidMissing = mk("pA", "feat(x): orphan tag [epic 12345678]");
  // already-set parent must not be touched
  const preParented = mk("pA", `feat(x): already placed [epic ${epic.slice(0, 8)}]`, "", { parentId: epic });
  // an unrelated word "epic" without a ref, and a status-narrative mention, must NOT match
  const noise = mk("pA", "[SUPERSEDED → epic df1f94b0] folded in");
  const noise2 = mk("pA", "epic thing with epic 2 in prose, no tag");

  // related
  const r1 = mk("pA", "r1");
  const r2 = mk("pA", "r2", `Related to: ${r1}`);
  const r3 = mk("pA", "r3", `intro\nRelated to: ${r1}, ${r2}\nRelated to: ${foreign}`); // r1,r2 same board; foreign cross-project
  const r4 = mk("pA", "r4", `Related to: ${r1}`);
  const rMirror = mk("pA", "rMirror", `Related to: ${r4}`);
  const r4Back = mk("pA", "r4Back", `Related to: ${rMirror}`); // (kept simple: pair chain r1-r4-rMirror-r4Back)
  const rSelf = mk("pA", "rSelf", "Related to: 5e1f0001-0000-4000-8000-000000000000", { id: "5e1f0001-0000-4000-8000-000000000000" });
  const rShort = mk("pA", "rShort", "Related to: 0123abcd");
  const rDangling = mk("pA", "rDangling", `Related to: ${uid(0xffffffff)}`);

  // ---- pure extraction -------------------------------------------------------------------------------
  const ex = extractProse({ title: "t [epic 1a2b3c4d]", body: "Related to: " + uid(1) + " 0123abcd" });
  check("(E) extractProse: title epic tag ref", ex.parentRefs.length === 1 && ex.parentRefs[0] === "1a2b3c4d");
  check("(E) extractProse: related uuid + short prefix separated", ex.relatedIds.length === 1 && ex.relatedShort.join() === "0123abcd");
  check("(E) extractProse: bare '(umbrella)' is an anchor marker, not a parent ref", extractProse({ title: "x (umbrella)", body: "" }).anchorMarker === true);
  check("(E) extractProse: 'SUPERSEDED → epic df1f94b0' is NOT a parent tag", extractProse({ title: "[SUPERSEDED → epic df1f94b0] x", body: "" }).parentRefs.length === 0);
  check("(E) negative control: a bogus title yields nothing", (() => { const e = extractProse({ title: "plain", body: "plain" }); return !e.parentRefs.length && !e.relatedIds.length && !e.anchorMarker; })());

  // ---- (D) dry-run writes nothing --------------------------------------------------------------------
  const before = snapshot();
  const beforeRelB = relatedOf("pA").join();
  const dry = await backfill(db, { write: false, samples: 3 });
  check("(D) dry-run persisted NOTHING (tasks, versions, parent ids, relation counts unchanged)", snapshot() === before && relatedOf("pA").join() === beforeRelB);
  check("(D) dry-run still reports conversions", dry.mode === "dry-run" && dry.counts.parent > 0 && dry.counts.related > 0);
  check("(D) samples are capped at --samples", dry.samples.related.length <= 3 && dry.samples.parent.length <= 3);

  // ---- write ----------------------------------------------------------------------------------------
  const w = await backfill(db, { write: true, samples: 10 });
  check("(D) write reports the SAME counts as the dry-run", JSON.stringify(w.counts) === JSON.stringify(dry.counts));
  const reasons = (kind) => w.skipped.filter((s) => s.kind === kind).map((s) => `${s.task}:${s.reason}`);

  check("(P) title tag (8-hex prefix) => parentId", parentOf(kidTag) === epic);
  check("(P) body `Parent: <uuid>` => parentId", parentOf(kidBody) === epic);
  check("(P) chained parent within the depth cap (epic -> kidTag -> grand)", parentOf(grand) === kidTag);
  check("(S) a parent beyond the depth cap is SKIPPED by the validator, not written", parentOf(great) === null && reasons("parent").some((r) => r.startsWith(great) && /validator refused.*too deep/.test(r)));
  check("(S) ambiguous 8-hex prefix skipped with a reason", parentOf(kidAmb) === null && reasons("parent").some((r) => r.startsWith(kidAmb) && /ambiguous prefix/.test(r)));
  check("(S) cross-project parent skipped with a reason", parentOf(kidForeign) === null && reasons("parent").some((r) => r.startsWith(kidForeign) && /another project/.test(r)));
  check("(S) unresolvable parent ref skipped with a reason", parentOf(kidMissing) === null && reasons("parent").some((r) => r.startsWith(kidMissing) && /not found/.test(r)));
  check("(S) bare anchor marker skipped with a reason", parentOf(anchorOnly) === null && reasons("parent").some((r) => r.startsWith(anchorOnly) && /anchor marker/.test(r)));
  check("(S) an already-set parent is left alone and counted", parentOf(preParented) === epic && w.counts.parentAlreadySet >= 1);
  check("(S) 'SUPERSEDED → epic X' and prose-only 'epic' are not converted", parentOf(noise) === null && parentOf(noise2) === null && !w.skipped.some((s) => s.task === noise || s.task === noise2));
  check("(S) a self-referencing parent tag is skipped with a reason", parentOf(selfCard) === null && reasons("parent").some((r) => r.startsWith(selfCard) && /self reference/.test(r)));
  check("(S) a self-referencing `Related to:` is skipped with a reason", reasons("related").some((r) => r.startsWith(rSelf) && /self reference/.test(r)));

  const rel = relatedOf("pA");
  const has = (a, b) => rel.includes([a, b].sort().join("|"));
  check("(R) `Related to: <uuid>` => a related edge (stored once, from < to)", has(r2, r1));
  check("(R) multi-uuid line converts every same-board id", has(r3, r1) && has(r3, r2));
  check("(S) cross-project related id skipped with a reason", !rel.some((e) => e.includes(foreign)) && reasons("related").some((r) => r.startsWith(r3) && /another project/.test(r)));
  check("(S) short 8-hex related skipped (ambiguous with a commit sha)", reasons("related").some((r) => r.startsWith(rShort) && /short id prefix/.test(r)) && !rel.some((e) => e.includes(rShort)));
  check("(S) dangling related uuid skipped as not found", reasons("related").some((r) => r.startsWith(rDangling) && /not found/.test(r)));
  check("(R) each related pair is one edge (no duplicates)", new Set(rel).size === rel.length);
  check("(R) a related edge is a real relation in the view of BOTH cards", db.listRelations("pA").some((e) => e.type === "related" && e.fromTaskId <= e.toTaskId));
  check("(R) chained pairs all convert", has(r4, r1) && has(rMirror, r4) && has(r4Back, rMirror));

  // the deferral alias is never touched: 0 gates_deferral edges were created by this run
  check("(S) no gates_deferral / blocks edges were written by the backfill", db.listRelations("pA").every((e) => e.type !== "blocks") && w.counts.deferralAlreadyHandled === 0);

  // ---- (I) idempotence -----------------------------------------------------------------------------
  const after = snapshot();
  const again = await backfill(db, { write: true });
  check("(I) a second --write converts 0 related and 0 parent", again.counts.related === 0 && again.counts.parent === 0);
  check("(I) ...and changes nothing", snapshot() === after);
  check("(I) the first run's related edges now count as already present", again.counts.relatedAlreadyPresent >= w.counts.related);

  // ---- (X) CLI safety ------------------------------------------------------------------------------
  const loomHome = fs.mkdtempSync(path.join(os.tmpdir(), "loom-backfill-home-"));
  const liveDb = path.join(loomHome, "loom.db");
  fs.writeFileSync(liveDb, "");
  const cli = (args) => spawnSync(process.execPath, [scriptPath, ...args], { env: { ...process.env, LOOM_HOME: loomHome }, encoding: "utf8" });
  const refused = cli(["--db", liveDb, "--write"]);
  check("(X) CLI REFUSES the live DB path (exit 2, --write)", refused.status === 2 && /live Loom DB/.test(refused.stderr));
  const refusedDry = cli(["--db", liveDb]);
  check("(X) CLI REFUSES the live DB path in dry-run too (opening it would migrate)", refusedDry.status === 2 && /live Loom DB/.test(refusedDry.stderr));
  check("(X) CLI needs an explicit --db", cli([]).status === 2);
  const okRun = cli(["--db", file, "--json"]);
  check("(X) CLI dry-run on a copy exits 0 and reports mode dry-run", okRun.status === 0 && /"mode": "dry-run"/.test(okRun.stdout));
  fs.rmSync(loomHome, { recursive: true, force: true });

  // ---- (L) --allow-live escape hatch: refuses unless the daemon is verifiably down + a backup is written first
  const freePort = await new Promise((res) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), "loom-backfill-live-"));
  const live2 = path.join(home2, "loom.db");
  db.db.pragma("wal_checkpoint(TRUNCATE)");
  fs.copyFileSync(file, live2);
  const liveSig = () => `${fs.statSync(live2).size}:${fs.readFileSync(live2).length}`;
  const sigBefore = liveSig();
  const bak = path.join(home2, "backup.db");
  const cliLive = (args, extraEnv = {}) => spawnSync(process.execPath, [scriptPath, "--db", live2, ...args], { env: { ...process.env, LOOM_HOME: home2, LOOM_PORT: String(freePort), ...extraEnv }, encoding: "utf8" });
  const noBackup = cliLive(["--allow-live"]);
  check("(L) --allow-live without --backup REFUSES and says back up first", noBackup.status === 2 && /BACK UP FIRST/.test(noBackup.stderr));
  check("(L) --allow-live on a non-live path is rejected", spawnSync(process.execPath, [scriptPath, "--db", file, "--allow-live"], { encoding: "utf8" }).status === 2);

  const httpUp = http.createServer((q, r) => { r.setHeader("content-type", "application/json"); r.end(JSON.stringify({ version: "9.9.9" })); });
  await new Promise((r) => httpUp.listen(freePort, "127.0.0.1", r));
  // async spawn: the in-process HTTP server must keep answering while the child probes it (spawnSync would block it)
  const up1 = await new Promise((resolve) => {
    const c = spawn(process.execPath, [scriptPath, "--db", live2, "--allow-live", "--backup", bak, "--write"], { env: { ...process.env, LOOM_HOME: home2, LOOM_PORT: String(freePort) } });
    let stderr = ""; c.stderr.on("data", (d) => (stderr += d)); c.stdout.resume();
    c.on("close", (status) => resolve({ status, stderr }));
  });
  check("(L) daemon 'up' (HTTP /api/version answering) => REFUSED via loom status, no backup, DB untouched", up1.status === 2 && /not verifiably down/.test(up1.stderr) && /loom status/.test(up1.stderr) && !fs.existsSync(bak) && liveSig() === sigBefore);
  await new Promise((r) => httpUp.close(r));

  const rawUp = net.createServer((sock) => sock.on("error", () => {})).listen(freePort, "127.0.0.1");
  await new Promise((r) => rawUp.once("listening", r));
  const up2 = cliLive(["--allow-live", "--backup", bak, "--write"]);
  check("(L) a NON-HTTP listener on the port also => REFUSED (raw TCP probe), no backup, DB untouched", up2.status === 2 && /accepting connections/.test(up2.stderr) && !fs.existsSync(bak) && liveSig() === sigBefore);
  await new Promise((r) => rawUp.close(r));

  fs.writeFileSync(path.join(home2, "daemon.pid"), JSON.stringify({ pid: process.pid, port: freePort }));
  const up3 = cliLive(["--allow-live", "--backup", bak, "--write"]);
  check("(L) a live pid in daemon.pid => REFUSED, no backup", up3.status === 2 && /live pid/.test(up3.stderr) && !fs.existsSync(bak));
  fs.rmSync(path.join(home2, "daemon.pid"));

  const down = cliLive(["--allow-live", "--backup", bak]);
  check("(L) daemon verifiably down + --backup => dry-run on live proceeds (exit 0), backup written BEFORE, says back up first", down.status === 0 && /back up first/.test(down.stderr) && fs.existsSync(bak) && fs.statSync(bak).size > 0 && /mode: dry-run/.test(down.stdout));
  const again2 = cliLive(["--allow-live", "--backup", bak]);
  check("(L) an existing backup path is never overwritten (REFUSED)", again2.status === 2 && /already exists/.test(again2.stderr));
  const bdb = new Db(bak);
  check("(L) the backup is a real DB holding the pre-run tasks", bdb.listTasks("pA").length === db.listTasks("pA").length);
  bdb.close();
  fs.rmSync(home2, { recursive: true, force: true });
} finally {
  try { db.close?.(); } catch { /* best effort */ }
  for (const f of [file, `${file}-wal`, `${file}-shm`]) try { fs.rmSync(f, { force: true }); } catch { /* best effort */ }
}
if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nall backfill-task-relations checks passed");
