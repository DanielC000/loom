import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 43084723: `Db.listRecentEventsByKinds` + `GET /api/orchestration/events?kinds=` — the cross-session,
// kind-filtered read that replaced a per-manager fan-out (see docs/decisions/43084723-*.md). HERMETIC +
// CLAUDE-FREE + NETWORK-FREE, same shape as audit-log.mjs: a seeded in-process Db + the REAL buildServer
// driven by app.inject.
// Run: 1) build (turbo builds shared first), 2) node test/boot-stuck-events-by-kind.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-bootstuckkind-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = "45397";
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows
process.env.HOME = sandboxHome;        // POSIX

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");

const now = Date.now();
const ts = (n) => new Date(now + n * 1000).toISOString();

try {
  const db = new Db(path.join(tmpHome, "boot-stuck-kind.db"));
  const ev = (id, ms, kind, manager, worker, detail = {}) =>
    db.appendEvent({ id, ts: ts(ms), managerSessionId: manager, workerSessionId: worker, taskId: null, kind, detail });

  // The exact card 43084723 scenario: worker W stuck under pre-boot manager M1, M1 later recycled to M2.
  // The stuck row's managerSessionId stays M1 forever (never rewritten) — see b1da256d's own "copy, never
  // re-derive" rule. A real fleet also has UNRELATED kinds (merge_request, under a different manager
  // entirely) that must NEVER leak into a kinds-filtered read.
  ev("stuck-w", 1, "claude_boot_dialog_stuck", "M1", "W", { parentNudged: false });
  ev("resolved-other", 2, "claude_boot_dialog_resolved", "M3", "X", {});
  ev("noise-1", 3, "merge_request", "M2", "W2", {});
  ev("noise-2", 4, "idle_report", "M1", null, { state: "working" });

  // =====================================================================================================
  // (db) listRecentEventsByKinds — cross-session, kind-filtered, independent of manager liveness
  // =====================================================================================================
  const kinds = ["claude_boot_dialog_stuck", "claude_boot_dialog_resolved"];
  const rows = db.listRecentEventsByKinds(kinds);
  check("(db) returns exactly the 2 matching-kind rows across DIFFERENT managers (M1 and M3)",
    rows.length === 2 && rows.some((e) => e.id === "stuck-w") && rows.some((e) => e.id === "resolved-other"));
  check("(db) never returns a non-matching kind (merge_request/idle_report excluded)",
    rows.every((e) => kinds.includes(e.kind)));
  check("(db) the M1-filed stuck row is present — reachable with NO regard to M1's own liveness (the exact card 43084723 fix: this read takes no manager/session-liveness filter at all)",
    rows.find((e) => e.id === "stuck-w")?.managerSessionId === "M1" && rows.find((e) => e.id === "stuck-w")?.workerSessionId === "W");

  // limit (newest-first): with 2 matching rows and limit=1, only the NEWER one survives.
  const limited = db.listRecentEventsByKinds(kinds, 1);
  check("(db) limit keeps the NEWEST row, drops the older one first",
    limited.length === 1 && limited[0].id === "resolved-other");

  // =====================================================================================================
  // (rest) GET /api/orchestration/events — kinds= is additive; managerId-only and omitted-both unchanged
  // =====================================================================================================
  const stub = {};
  const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });

  const rKinds = await app.inject({ method: "GET", url: `/api/orchestration/events?kinds=${kinds.join(",")}` });
  check("(rest) GET ?kinds= → 200 with the same 2 cross-session rows the db call returned",
    rKinds.statusCode === 200 && rKinds.json().length === 2 && rKinds.json().some((e) => e.id === "stuck-w"));

  const rManagerOnly = await app.inject({ method: "GET", url: "/api/orchestration/events?managerId=M1" });
  check("(rest) existing managerId=M1 behaviour is UNCHANGED — only M1's own 2 rows, kinds param absent",
    rManagerOnly.statusCode === 200 && rManagerOnly.json().length === 2
    && rManagerOnly.json().every((e) => e.managerSessionId === "M1"));

  const rOmitted = await app.inject({ method: "GET", url: "/api/orchestration/events" });
  check("(rest) omitted-param control — neither managerId nor kinds → [] (pre-existing behaviour)",
    rOmitted.statusCode === 200 && Array.isArray(rOmitted.json()) && rOmitted.json().length === 0);

  const rBadKind = await app.inject({ method: "GET", url: "/api/orchestration/events?kinds=not_a_real_kind" });
  check("(rest) an unknown kind in 'kinds' → 400, never silently ignored or SQL-interpolated",
    rBadKind.statusCode === 400);

  const rMixedKinds = await app.inject({ method: "GET", url: "/api/orchestration/events?kinds=claude_boot_dialog_stuck,not_a_real_kind" });
  check("(rest) ONE bad kind in an otherwise-valid list still 400s — no partial/best-effort filtering",
    rMixedKinds.statusCode === 400);

  await app.close();
  db.close();
} finally {
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Db.listRecentEventsByKinds + GET /api/orchestration/events?kinds= return matching-kind rows across every session regardless of filing manager, reject an unknown kind, and leave the existing managerId/omitted-param behaviour byte-identical."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
