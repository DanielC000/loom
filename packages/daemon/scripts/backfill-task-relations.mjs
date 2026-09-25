// ─────────────────────────────────────────────────────────────────────────────────────────────
// backfill-task-relations.mjs — ONE-OFF, HUMAN-RUN backfill (card 753092fe; NOT wired into boot, NOT an agent tool).
//
// WHY: before card 3df86c87 (parent links + blocks/related/discovered-from relations) agents wrote task
// structure as prose. This turns the unambiguous prose into real data, through the SAME validator + writer the
// tools use (tasks/relations.ts planTaskStructure -> applyTaskPlan). It hand-writes no SQL for relations.
//
// CONVERSIONS
//   related  : a body line `Related to: <full task uuid>[, <uuid>...]` => a `related` relation (same project only).
//   parentId : a TITLE tag `[epic <id>...]` / `(epic <id>...)` / `[umbrella <id>...]` (tag must START with the word
//              followed by the id), or a body line `Epic: <id>` / `Parent: <id>` / `Umbrella: <id>` => parentId.
//              ONLY when <id> is a full uuid or a UNIQUE 8+-hex prefix of a card on the SAME board, is not the card
//              itself, the card has no parent yet, and planTaskStructure accepts it (depth cap + cycle).
//   deferredUntilTaskId => blocks: NOT converted here. The one-shot boot backfill already turned it into
//              gates_deferral edges; the report counts those as "already handled".
//   A bare `(umbrella)` / `(EPIC anchor)` marker names no parent (the card IS the parent) => listed as skipped.
//
// SAFETY
//   * DRY-RUN is the default: it prints counts per conversion + samples and writes nothing that survives (the
//     plan is applied inside one transaction that is rolled back, so later cards see earlier ones' effect on the
//     depth cap exactly as a real --write would). --write persists.
//   * It operates ONLY on an explicit `--db <file>` and REFUSES the live Loom DB (DB_PATH) by DEFAULT, in EVERY
//     mode: opening it through Db would run migrations. Make a copy first: `--snapshot-live <dest>` (sqlite
//     .backup(), source opened read-only) and point --db at the copy.
//   * The real run is the explicit escape hatch `--db <live> --allow-live --backup <new.db> [--write]` (a HUMAN
//     decision made on the dry-run counts). It REFUSES unless the daemon is verifiably down (`loom status`
//     exit 1 via bin/loom.mjs, nothing accepting TCP on the configured port, no live pid in daemon.pid /
//     daemon-supervisor.pid; any check that cannot be made counts as "up"), and it writes the --backup via
//     .backup() BEFORE the live DB is opened for write. Port: --port, else LOOM_PORT, else the pid-file's, else 4317.
//
// RUN (repo root, after `pnpm build`):
//   node packages/daemon/scripts/backfill-task-relations.mjs --snapshot-live <copy.db>
//   node packages/daemon/scripts/backfill-task-relations.mjs --db <copy.db> [--samples 10] [--json]
//   node packages/daemon/scripts/backfill-task-relations.mjs --db <copy.db> --write
// ─────────────────────────────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import net from "node:net";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (p) => pathToFileURL(path.join(here, "..", "dist", p)).href;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_RE = new RegExp(UUID, "g");
const REF = `(?:${UUID}|[0-9a-f]{8,})`;
// A tag that STARTS with epic/umbrella and is immediately followed by a ref: `[epic 1a2b3c4d …]`, `(umbrella <uuid>)`.
const TITLE_PARENT_RE = new RegExp(`[\\[(]\\s*(?:epic|umbrella)[:\\s]+(${REF})\\b[^\\])]*[\\])]`, "i");
const BODY_PARENT_RE = new RegExp(`^\\s*(?:[-*]\\s*)?(?:epic|parent|umbrella)\\s*:\\s*(${REF})\\b`, "im");
// Bare anchor markers that name no parent.
const ANCHOR_MARKER_RE = /\(\s*(?:umbrella|epic anchor)\s*\)|\[\s*(?:epic|umbrella)\s*\]|\(\s*epic\s+anchor[^)]*\)/i;
const RELATED_LINE_RE = /^\s*(?:[-*]\s*)?Related to:[ \t]*(.*)$/gim;

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** Pure extraction of the prose references on ONE card (no db). */
export function extractProse(task) {
  const relatedIds = [];
  const relatedShort = [];
  for (const m of (task.body ?? "").matchAll(RELATED_LINE_RE)) {
    const line = m[1];
    for (const u of line.match(UUID_RE) ?? []) if (!relatedIds.includes(u.toLowerCase())) relatedIds.push(u.toLowerCase());
    for (const s of line.replace(UUID_RE, " ").match(/\b[0-9a-f]{8}\b/gi) ?? []) relatedShort.push(s.toLowerCase());
  }
  const t = TITLE_PARENT_RE.exec(task.title ?? "");
  const b = BODY_PARENT_RE.exec(task.body ?? "");
  const parentRefs = [...new Set([t?.[1], b?.[1]].filter(Boolean).map((s) => s.toLowerCase()))];
  const anchorMarker = ANCHOR_MARKER_RE.test(task.title ?? "") && parentRefs.length === 0;
  return { relatedIds, relatedShort, parentRefs, anchorMarker };
}

/**
 * Run the backfill over an opened Db. `write:false` applies inside a rolled-back transaction so the report is
 * exactly what --write would do. Returns { counts, samples, skipped } (all plain data).
 */
export async function backfill(db, { write = false, samples = 10 } = {}) {
  const { planTaskStructure, applyTaskPlan } = await import(dist("tasks/relations.js"));
  const report = {
    mode: write ? "write" : "dry-run",
    counts: { related: 0, parent: 0, deferralAlreadyHandled: 0, relatedAlreadyPresent: 0, relatedMirroredInRun: 0, parentAlreadySet: 0, skipped: 0 },
    samples: { related: [], parent: [] },
    skipped: [],
  };
  const skip = (task, kind, ref, reason) => { report.counts.skipped++; report.skipped.push({ task: task.id, kind, ref, reason }); };
  const madeThisRun = new Set(); // `a|b` (sorted) — a mirrored `Related to:` on the other card is a duplicate, not pre-existing data
  const sample = (kind, row) => { if (report.samples[kind].length < samples) report.samples[kind].push(row); };

  const run = () => {
    for (const project of db.listAllProjects()) {
      const tasks = db.listTasks(project.id).slice().sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
      report.counts.deferralAlreadyHandled += db.listRelations(project.id).filter((e) => e.type === "blocks" && e.gatesDeferral).length;
      for (const task of tasks) {
        const cur = () => db.getTask(task.id);
        const prose = extractProse(task);

        // ---- related ------------------------------------------------------------------------------------
        if (prose.relatedIds.length || prose.relatedShort.length) {
          for (const s of prose.relatedShort) skip(task, "related", s, "short id prefix (8-hex is ambiguous with a commit sha) — only full uuids are converted");
          const existing = db.listRelations(project.id).filter((e) => e.type === "related" && (e.fromTaskId === task.id || e.toTaskId === task.id));
          const have = new Set(existing.map((e) => (e.fromTaskId === task.id ? e.toTaskId : e.fromTaskId)));
          const fresh = [];
          for (const id of prose.relatedIds) {
            if (id === task.id) { skip(task, "related", id, "self reference"); continue; }
            if (have.has(id)) { report.counts[madeThisRun.has([task.id, id].sort().join("|")) ? "relatedMirroredInRun" : "relatedAlreadyPresent"]++; continue; }
            const target = db.getTask(id);
            if (!target) { skip(task, "related", id, "target not found (deleted or never existed)"); continue; }
            if (target.projectId !== task.projectId) { skip(task, "related", id, "target is on another project's board (relations are same-project only)"); continue; }
            fresh.push(id);
          }
          if (fresh.length) {
            // `related` on update is a whole-set REPLACE, so pass existing + new.
            const r = planTaskStructure(db, project.id, task.id, { related: [...have, ...fresh] });
            if ("error" in r) for (const id of fresh) skip(task, "related", id, `validator refused: ${r.error}`);
            else {
              applyTaskPlan(db, project.id, task.id, r.plan);
              for (const id of fresh) { madeThisRun.add([task.id, id].sort().join("|")); report.counts.related++; sample("related", { from: task.id, to: id, title: task.title.slice(0, 80) }); }
            }
          }
        }

        // ---- parentId -----------------------------------------------------------------------------------
        if (prose.parentRefs.length === 0 && prose.anchorMarker) { skip(task, "parent", null, "anchor marker with no parent reference (this card is the parent, not a child)"); continue; }
        if (prose.parentRefs.length) {
          if (cur().parentId) { report.counts.parentAlreadySet++; continue; }
          if (prose.parentRefs.length > 1) { skip(task, "parent", prose.parentRefs.join(","), "title and body name DIFFERENT parents"); continue; }
          const ref = prose.parentRefs[0];
          const matches = tasks.filter((t) => t.id.toLowerCase() === ref || (ref.length < 36 && t.id.toLowerCase().startsWith(ref)));
          if (matches.length === 0) {
            const elsewhere = db.listAllProjects().some((p) => p.id !== project.id && db.listTasks(p.id).some((t) => t.id.toLowerCase().startsWith(ref)));
            skip(task, "parent", ref, elsewhere ? "parent is on another project's board (same-project only)" : "parent not found on this board");
            continue;
          }
          if (matches.length > 1) { skip(task, "parent", ref, `ambiguous prefix — matches ${matches.length} cards`); continue; }
          const parent = matches[0];
          if (parent.id === task.id) { skip(task, "parent", ref, "self reference"); continue; }
          const r = planTaskStructure(db, project.id, task.id, { parentId: parent.id });
          if ("error" in r) { skip(task, "parent", ref, `validator refused: ${r.error}`); continue; }
          applyTaskPlan(db, project.id, task.id, r.plan);
          report.counts.parent++;
          sample("parent", { child: task.id, parent: parent.id, title: task.title.slice(0, 80) });
        }
      }
    }
  };

  if (write) db.runInTransaction(run);
  else {
    const ROLLBACK = new Error("dry-run rollback");
    try { db.runInTransaction(() => { run(); throw ROLLBACK; }); } catch (e) { if (e !== ROLLBACK) throw e; }
  }
  return report;
}

function skippedSummary(skipped) {
  const by = new Map();
  for (const s of skipped) {
    const key = `${s.kind}: ${s.reason.replace(/validator refused: .*/, "validator refused").replace(/matches \d+ cards/, "matches N cards")}`;
    by.set(key, [...(by.get(key) ?? []), s]);
  }
  return [...by.entries()].sort((a, b) => b[1].length - a[1].length);
}

const tcpAccepts = (port) => new Promise((resolve) => {
  const sock = net.connect({ host: "127.0.0.1", port });
  const done = (v) => { sock.destroy(); resolve(v); };
  sock.setTimeout(1500, () => done(true)); // connected-or-hanging is not "down"
  sock.on("connect", () => done(true));
  sock.on("error", (e) => done(!(e && (e.code === "ECONNREFUSED" || e.code === "ECONNRESET")))); // only an active refusal proves nothing listens
});
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === "EPERM"; } };

/** null when the daemon is VERIFIABLY down, else the reason to refuse. Reuses `loom status` (bin/loom.mjs) for
 *  the running-daemon check rather than hand-rolling one; the port + pid-file probes are extra, fail-closed. */
export async function daemonDownReason(loomHome, portArg) {
  let recPort;
  for (const name of ["daemon.pid", "daemon-supervisor.pid"]) {
    let rec = null;
    try { rec = JSON.parse(fs.readFileSync(path.join(loomHome, name), "utf8")); } catch { /* absent or unreadable => no claim */ }
    if (rec && Number.isInteger(rec.port) && recPort === undefined) recPort = rec.port;
    if (rec && Number.isInteger(rec.pid) && pidAlive(rec.pid)) return `${name} names live pid ${rec.pid}`;
  }
  const port = portArg ?? (process.env.LOOM_PORT ? Number(process.env.LOOM_PORT) : recPort ?? 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return `invalid port ${port}`;
  const cli = path.join(here, "..", "..", "..", "bin", "loom.mjs");
  if (!fs.existsSync(cli)) return `cannot verify: ${cli} not found (the daemon-status check is unavailable)`;
  const st = spawnSync(process.execPath, [cli, "status", "--port", String(port)], { env: { ...process.env, LOOM_HOME: loomHome }, encoding: "utf8", timeout: 15000 });
  if (st.status !== 1) return `\`loom status\` did not report "not running" (exit ${st.status}${st.error ? `, ${st.error.message}` : ""}): ${(st.stdout || "").trim()}`;
  if (await tcpAccepts(port)) return `something is accepting connections on 127.0.0.1:${port}`;
  return null;
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (n) => argv.includes(n);
  const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const { DB_PATH } = await import(dist("paths.js"));

  const snap = val("--snapshot-live");
  if (snap) {
    if (fs.existsSync(snap)) { console.error(`refusing to overwrite existing ${snap}`); process.exit(2); }
    const { default: Database } = await import("better-sqlite3");
    const src = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    await src.backup(snap);
    src.close();
    console.log(`snapshot of ${DB_PATH} written to ${snap} (source opened read-only)`);
    return;
  }

  const file = val("--db");
  if (!file) { console.error("usage: --db <copy.db> [--write] [--samples N] [--json]   |   --snapshot-live <dest.db>"); process.exit(2); }
  const isLive = samePath(file, DB_PATH);
  if (flag("--allow-live") && !isLive) { console.error("--allow-live only applies to the live Loom DB path; pass a copy without it."); process.exit(2); }
  if (isLive && !flag("--allow-live")) { console.error(`REFUSED: ${file} is the live Loom DB. Use --snapshot-live <dest> and run against the copy (or, as a deliberate human step, --allow-live --backup <path>).`); process.exit(2); }
  if (!fs.existsSync(file)) { console.error(`no such db: ${file}`); process.exit(2); }
  if (isLive) {
    const backup = val("--backup");
    if (!backup) { console.error("REFUSED: --allow-live requires --backup <new file>. BACK UP FIRST — the backup is written before anything touches the live DB."); process.exit(2); }
    if (fs.existsSync(backup)) { console.error(`REFUSED: backup target ${backup} already exists — pick a new path.`); process.exit(2); }
    const port = val("--port") !== undefined ? Number(val("--port")) : undefined;
    const why = await daemonDownReason(path.dirname(DB_PATH), port);
    if (why) { console.error(`REFUSED: the daemon is not verifiably down — ${why}. Stop it (loom stop / pnpm daemon:stable:stop) and retry.`); process.exit(2); }
    console.error("back up first: writing the backup before touching the live DB...");
    const { default: Database } = await import("better-sqlite3");
    const src = new Database(file, { readonly: true, fileMustExist: true });
    await src.backup(backup);
    src.close();
    if (!fs.existsSync(backup) || fs.statSync(backup).size === 0) { console.error("REFUSED: backup did not produce a file."); process.exit(2); }
    console.error(`backup written to ${backup}`);
  }

  const { Db } = await import(dist("db.js"));
  const db = new Db(file);
  const report = await backfill(db, { write: flag("--write"), samples: Number(val("--samples") ?? 10) });
  if (flag("--json")) { console.log(JSON.stringify(report, null, 2)); return; }
  console.log(`mode: ${report.mode}${report.mode === "dry-run" ? " (nothing persisted)" : ""}   db: ${file}`);
  console.log("counts:", JSON.stringify(report.counts));
  for (const kind of ["related", "parent"]) {
    console.log(`\n${kind} samples (${report.samples[kind].length}):`);
    for (const s of report.samples[kind]) console.log("  ", JSON.stringify(s));
  }
  console.log(`\nskipped/ambiguous: ${report.counts.skipped}`);
  for (const [key, rows] of skippedSummary(report.skipped)) {
    console.log(`  [${rows.length}] ${key}`);
    for (const r of rows.slice(0, 3)) console.log(`       ${r.task.slice(0, 8)} ref=${r.ref ?? "-"}`);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
