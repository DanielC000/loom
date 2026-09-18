import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 0c5d6851: `redactSessionEnvForRead()` (card a5ecb6fd, previously applied only to `GET
// /api/projects`) is now ALSO applied to the four project-returning WRITE responses:
//   POST /api/projects, PATCH /api/projects/:id, POST /api/projects/:id/restore,
//   PATCH /api/projects/:id/config.
// `a5ecb6fd`'s own regression guard for the GET route lives in trust-tier.mjs (2a2) — this file is its
// sibling for the four WRITE routes, DELIBERATELY NOT duplicated into trust-tier.mjs (that file is
// scoped to loopback/remote trust, not project-write shape).
//
// Proves, per route:
//   (1) the response NEVER carries the real sessionEnv value.
//   (2) the mask is the SAME LENGTH as the real value, not bucketed/truncated (card 32b23f0f's
//       truncated-paste detector — `storedLength` on the web sessionEnv editor — depends on this
//       surviving; see @decision 0c5d6851 at the masker's own definition in server.ts).
//   (3) the UNDERLYING STORED value is untouched by a request that merely re-reads it back (the
//       destruction-direction check DoD-3 asks for — a route that echoes a masked value must never let
//       that masked value become the new stored value).
//   (4) a project with an EMPTY/absent sessionEnv round-trips unchanged (the masker's own early-return).
//   (5) POST /api/projects also masks a sessionEnv supplied directly in the CREATE payload.
//
// Run: 1) build (turbo builds shared first), 2) node test/project-write-response-redaction.mjs
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";
import { commitAll } from "./_git-commit.mjs";

const TMP = mkdtempManaged("loom-writeredact-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = String(hermeticPort());
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");

// POST /api/projects (unlike the other three routes below, driven via a raw db.insertProject fixture)
// validates repoPath as a REAL git repo — a real one, created here, so the create-route assertions below
// exercise the actual route instead of hitting its own 400 before ever reaching the response we're testing.
const createRepo = path.join(TMP, "create-repo");
fs.mkdirSync(createRepo, { recursive: true });
fs.writeFileSync(path.join(createRepo, "README.md"), "# create-repo\n");
execSync("git init -q", { cwd: createRepo });
commitAll(createRepo, "init", "-c user.email=r@loom -c user.name=r");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const now = new Date().toISOString();
const dbFile = path.join(TMP, "loom.db");
const db = new Db(dbFile);
const stub = {};
let app;

// A value is "genuinely masked" when it (a) differs from the real secret and (b) preserves its exact
// length — same predicate `redactSessionEnvForRead` itself is built to satisfy, checked from the outside
// through the real HTTP response rather than by calling the masker directly.
const assertMasked = (label, sessionEnv, name, realValue) => {
  const got = sessionEnv?.[name];
  check(`${label}: ${name} is present but never the real value`, typeof got === "string" && got !== realValue);
  check(`${label}: ${name} mask preserves the exact length (${realValue.length})`, got?.length === realValue.length);
};

try {
  app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });

  const REAL_ALPHA = "alpha-secret-value-1234567890";
  const REAL_SHORT = "ab";

  // ===================== (5) POST /api/projects — create-time sessionEnv is masked on the response =====================
  const created = await app.inject({
    method: "POST", url: "/api/projects",
    payload: { name: "Created", repoPath: createRepo, vaultPath: createRepo, config: { sessionEnv: { ALPHA: REAL_ALPHA, SHORT: REAL_SHORT } } },
  });
  check("(create) POST /api/projects → 201", created.statusCode === 201);
  const createdBody = created.json();
  assertMasked("(create) response", createdBody.config.sessionEnv, "ALPHA", REAL_ALPHA);
  assertMasked("(create) response", createdBody.config.sessionEnv, "SHORT", REAL_SHORT);
  check("(create) ★ the STORED row keeps the REAL value (masking is response-only, never persisted)",
    db.getProject(createdBody.id).config.sessionEnv.ALPHA === REAL_ALPHA);

  // ===================== shared fixture for the remaining three routes =====================
  db.insertProject({
    id: "pRedact", name: "Redact", repoPath: TMP, vaultPath: TMP,
    config: { sessionEnv: { ALPHA: REAL_ALPHA, SHORT: REAL_SHORT }, orchestration: { gateCommand: "pnpm build" } },
    createdAt: now, archivedAt: null, reserved: false,
  });

  // ===================== (1)+(2)+(3) PATCH /api/projects/:id (structural) =====================
  const patched = await app.inject({ method: "PATCH", url: "/api/projects/pRedact", payload: { name: "Redact Renamed" } });
  check("(structural PATCH) 200", patched.statusCode === 200);
  const patchedBody = patched.json();
  assertMasked("(structural PATCH) response", patchedBody.config.sessionEnv, "ALPHA", REAL_ALPHA);
  assertMasked("(structural PATCH) response", patchedBody.config.sessionEnv, "SHORT", REAL_SHORT);
  check("(structural PATCH) ★ the STORED sessionEnv is UNTOUCHED by a rename that never named sessionEnv",
    db.getProject("pRedact").config.sessionEnv.ALPHA === REAL_ALPHA && db.getProject("pRedact").config.sessionEnv.SHORT === REAL_SHORT);

  // ===================== (1)+(2)+(3) PATCH /api/projects/:id/config, including a SIBLING-only write =====================
  // The patch below never mentions sessionEnv at all — a config-PATCH's response is redacted regardless
  // of whether THIS request touched sessionEnv, since the response is always the post-write full row.
  const cfgPatched = await app.inject({ method: "PATCH", url: "/api/projects/pRedact/config", payload: { config: { orchestration: { gateCommand: "pnpm build && pnpm test" } } } });
  check("(config PATCH, sibling-only write) 200", cfgPatched.statusCode === 200);
  const cfgPatchedBody = cfgPatched.json();
  assertMasked("(config PATCH, sibling-only) response", cfgPatchedBody.config.sessionEnv, "ALPHA", REAL_ALPHA);
  check("(config PATCH, sibling-only) ★ the unrelated write landed", cfgPatchedBody.config.orchestration.gateCommand === "pnpm build && pnpm test");
  check("(config PATCH, sibling-only) ★ the STORED sessionEnv is UNTOUCHED by a write that never named it",
    db.getProject("pRedact").config.sessionEnv.ALPHA === REAL_ALPHA);

  // Now a config-PATCH that DOES write a NEW sessionEnv value — the response must mask THAT new value
  // (proving the masker runs on the post-write result, not a stale pre-write snapshot), while the
  // underlying stored value is the genuine new one, not the mask.
  const REAL_ROTATED = "rotated-secret-value-xyz";
  const cfgRotated = await app.inject({ method: "PATCH", url: "/api/projects/pRedact/config", payload: { config: { sessionEnv: { ALPHA: REAL_ROTATED } } } });
  check("(config PATCH, sessionEnv write) 200", cfgRotated.statusCode === 200);
  const cfgRotatedBody = cfgRotated.json();
  assertMasked("(config PATCH, sessionEnv write) response", cfgRotatedBody.config.sessionEnv, "ALPHA", REAL_ROTATED);
  check("(config PATCH, sessionEnv write) ★ the STORED value is the genuine NEW secret, never the mask",
    db.getProject("pRedact").config.sessionEnv.ALPHA === REAL_ROTATED);

  // ===================== (1)+(2)+(3) POST /api/projects/:id/restore =====================
  const arch = await app.inject({ method: "DELETE", url: "/api/projects/pRedact" });
  check("(restore fixture) archive → 200", arch.statusCode === 200);
  const restored = await app.inject({ method: "POST", url: "/api/projects/pRedact/restore" });
  check("(restore) 200", restored.statusCode === 200);
  const restoredBody = restored.json();
  assertMasked("(restore) response", restoredBody.config.sessionEnv, "ALPHA", REAL_ROTATED);
  check("(restore) ★ archivedAt cleared", restoredBody.archivedAt === null);
  check("(restore) ★ the STORED sessionEnv is UNTOUCHED by a restore that never named it",
    db.getProject("pRedact").config.sessionEnv.ALPHA === REAL_ROTATED);

  // ===================== (4) empty/absent sessionEnv round-trips unchanged on every route =====================
  db.insertProject({ id: "pBare", name: "Bare", repoPath: TMP, vaultPath: TMP, config: {}, createdAt: now, archivedAt: null, reserved: false });
  const barePatched = await app.inject({ method: "PATCH", url: "/api/projects/pBare", payload: { name: "Bare Renamed" } });
  check("(no sessionEnv) structural PATCH 200", barePatched.statusCode === 200);
  check("(no sessionEnv) ★ response carries no sessionEnv key (masker's early-return, not a crash)",
    barePatched.json().config.sessionEnv === undefined);
  const bareCfgPatched = await app.inject({ method: "PATCH", url: "/api/projects/pBare/config", payload: { config: { orchestration: { gateCommand: "pnpm build" } } } });
  check("(no sessionEnv) config PATCH 200", bareCfgPatched.statusCode === 200);
  check("(no sessionEnv) ★ config PATCH response carries no sessionEnv key either",
    bareCfgPatched.json().config.sessionEnv === undefined);
} finally {
  try { if (app) await app.close(); } catch { /* ignore */ }
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — POST /api/projects, PATCH /api/projects/:id, POST /api/projects/:id/restore and PATCH /api/projects/:id/config all mask config.sessionEnv on their response (never the real value, exact length preserved — the truncated-paste detector's own invariant), a config-PATCH that writes a NEW sessionEnv value masks THAT new value (not a stale pre-write snapshot) while the underlying store keeps the genuine new secret, a route that never names sessionEnv at all leaves the STORED value untouched (destruction-direction check), and a project with no sessionEnv round-trips with no sessionEnv key on every route (the masker's early-return, not a crash)."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
