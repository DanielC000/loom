import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card fafae623: `passEnv` — the HUMAN-ONLY, per-capability-def escape hatch widening a stdio mount's
// env-isolating launcher allow-list with named AMBIENT env vars (for a tool that relies on something
// outside Loom's secretEnvVar delivery mechanism). DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE.
//
// Proves:
//   (a) validatePassEnv/passEnvReservedReason: charset rejection, the LOOM_MCP_TOKEN/CLAUDE_CODE_*/LOOM_*
//       reserved-name denylist (case-insensitive), a max-count bound, dedupe, and a well-formed pass.
//   (b) DB round-trip: createCapabilityDef persists passEnv; updateCapabilityDefPassEnv updates ONLY that
//       field (every other field on the row is untouched) and returns undefined for an unknown id;
//       toCapabilityDefRow degrades a malformed pass_env_json to [], never throws.
//   (c) MIGRATION boot-test per the project's DB-schema-change doctrine: a copy of a REAL pre-card
//       `capability_defs` table (no pass_env_json column, a real pre-existing row) migrates cleanly —
//       the constructor doesn't throw, the column exists, and the old row backfills to passEnv:[].
//   (d) buildMcpServers' chokepoint: passEnv widens the launcher's --allow list with an ambient var name
//       (reaching the real mounted server) while an unrelated ambient var NOT in passEnv still doesn't
//       reach it — proven via a REAL child_process spawn of the resolved {command,args,env}.
//   (e) seed rows (github/image-gen) always carry passEnv:[] — never widened at seed time.
//   (f) REAL HTTP: PATCH /api/capabilities/:id with a primitive JSON body (string/number/boolean) is a
//       400, never a 500/TypeError (Code Review round 2, reviewer 7b1b9aa0) — a well-formed object body
//       (incl. one that omits `passEnv`, or a genuine update) is unaffected.
//
// Run: 1) build (turbo builds shared first), 2) node test/capability-pass-env.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { useOwnLoomHome, cleanupPathSync } from "./_tmp-fixture.mjs";

const execFileAsync = promisify(execFile);
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = useOwnLoomHome("loom-cap-passenv-");

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ECHO_ENV_FIXTURE = path.join(__dirname, "fixtures", "echo-env.mjs");

const {
  validatePassEnv, passEnvReservedReason, createCapabilityDef, updateCapabilityDefPassEnv, requirePassEnvKey,
} = await import("../dist/capabilities/registry.js");
const { bundledCapabilities } = await import("../dist/capabilities/seed.js");
const { buildMcpServers } = await import("../dist/pty/host.js");
const { unwrapLauncherMount } = await import("./_env-isolation-helpers.mjs");

// ===================== (a) validatePassEnv / passEnvReservedReason =====================
check("(a) undefined ⇒ [] (omitted, defaults clean)", validatePassEnv(undefined).ok === true && JSON.stringify(validatePassEnv(undefined).value) === "[]");
check("(a) a well-formed list validates ok, deduped", validatePassEnv(["FOO_BAR", "FOO_BAR", "BAZ"]).ok === true
  && JSON.stringify(validatePassEnv(["FOO_BAR", "FOO_BAR", "BAZ"]).value) === JSON.stringify(["FOO_BAR", "BAZ"]));
check("(a) not an array ⇒ rejected", validatePassEnv("FOO_BAR").ok === false);
check("(a) a non-string entry ⇒ rejected", validatePassEnv([42]).ok === false);
check("(a) a blank entry ⇒ rejected (fails the charset regex)", validatePassEnv([""]).ok === false);
check("(a) an entry with a space ⇒ rejected", validatePassEnv(["FOO BAR"]).ok === false);
check("(a) an entry starting with a digit ⇒ rejected (not a valid env-var-name shape)", validatePassEnv(["1FOO"]).ok === false);
check("(a) an entry with '=' ⇒ rejected", validatePassEnv(["FOO=BAR"]).ok === false);
check("(a) over the max-count bound ⇒ rejected", validatePassEnv(Array.from({ length: 100 }, (_, i) => `K${i}`)).ok === false);

check("(a) passEnvReservedReason: exact LOOM_MCP_TOKEN is reserved", typeof passEnvReservedReason("LOOM_MCP_TOKEN") === "string");
check("(a) passEnvReservedReason: case-insensitive on LOOM_MCP_TOKEN", typeof passEnvReservedReason("loom_mcp_token") === "string");
check("(a) passEnvReservedReason: any CLAUDE_CODE_* prefix is reserved", typeof passEnvReservedReason("CLAUDE_CODE_SESSION_ID") === "string");
check("(a) passEnvReservedReason: any LOOM_* prefix is reserved (covers LOOM_PROJECT_WORK_DIR etc, not just the token)", typeof passEnvReservedReason("LOOM_PROJECT_WORK_DIR") === "string");
check("(a) passEnvReservedReason: an ordinary name is NOT reserved", passEnvReservedReason("MY_OWN_API_KEY") === null);
check("(a) validatePassEnv rejects a reserved name even though it matches the charset regex", validatePassEnv(["LOOM_MCP_TOKEN"]).ok === false);
check("(a) validatePassEnv rejects CLAUDE_CODE_* too", validatePassEnv(["CLAUDE_CODE_FOO"]).ok === false);
check("(a) validatePassEnv rejects a GOOD name alongside a reserved one (whole-array fails, not partial)",
  validatePassEnv(["MY_OWN_API_KEY", "LOOM_MCP_TOKEN"]).ok === false);

// ===================== Code Review round 1 (reviewer b5883c03), item 4: PATCH body must name `passEnv` =====================
check("(a) requirePassEnvKey rejects an EMPTY body ({}) — never silently clears passEnv", typeof requirePassEnvKey({}) === "string");
check("(a) requirePassEnvKey rejects a typo'd key name (passenv, wrong case)", typeof requirePassEnvKey({ passenv: [] }) === "string");
check("(a) requirePassEnvKey accepts a body naming passEnv explicitly, even as []", requirePassEnvKey({ passEnv: [] }) === null);
check("(a) requirePassEnvKey accepts a body naming passEnv as null too (the VALUE's own validity is validatePassEnv's job, not this one's)", requirePassEnvKey({ passEnv: null }) === null);

// ===================== (c) MIGRATION boot-test: a real PRE-CARD capability_defs table =====================
{
  const dbFile = path.join(tmpHome, "pre-card-capability-defs.db");
  const legacyId = randomUUID();
  const raw = new Database(dbFile);
  raw.pragma("journal_mode = WAL");
  raw.exec(`
    CREATE TABLE capability_defs (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      transport TEXT NOT NULL DEFAULT 'stdio',
      kind TEXT NOT NULL,
      provision_json TEXT NOT NULL,
      tool_allowlist_json TEXT NOT NULL DEFAULT '[]',
      wants_scratch_dir INTEGER NOT NULL DEFAULT 0,
      requires_connection INTEGER NOT NULL DEFAULT 0,
      secret_env_var TEXT,
      created_at TEXT NOT NULL
    );
  `);
  raw.prepare(
    "INSERT INTO capability_defs (id,slug,name,description,transport,kind,provision_json,tool_allowlist_json,wants_scratch_dir,requires_connection,secret_env_var,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(legacyId, "legacy-cap", "Legacy", "d", "stdio", "bundled", JSON.stringify({ kind: "bundled", command: process.execPath, args: [] }), "[]", 0, 0, null, "2026-01-01T00:00:00.000Z");
  const colsBefore = new Set(raw.prepare("PRAGMA table_info(capability_defs)").all().map((c) => c.name));
  check("(c-setup) the synthesized legacy capability_defs table has NO pass_env_json column yet", !colsBefore.has("pass_env_json"));
  raw.close();

  let ctorError = null;
  let db;
  try {
    const { Db } = await import("../dist/db.js");
    db = new Db(dbFile);
  } catch (err) { ctorError = err; }
  check("(c) constructing Db against a pre-card capability_defs DB does not throw", ctorError === null);
  if (!ctorError) {
    const raw2 = new Database(dbFile, { readonly: true });
    const colsAfter = new Set(raw2.prepare("PRAGMA table_info(capability_defs)").all().map((c) => c.name));
    raw2.close();
    check("(c) column 'pass_env_json' was added by migrateCapabilityDefs()", colsAfter.has("pass_env_json"));
    const legacyRow = db.getCapabilityDefBySlug("legacy-cap");
    check("(c) the legacy row still exists post-migration", legacyRow !== undefined);
    check("(c) the legacy row backfills passEnv to [] (never undefined, never throws reading it)", Array.isArray(legacyRow.passEnv) && legacyRow.passEnv.length === 0);
    check("(c) the legacy row's other fields are UNCHANGED", legacyRow.name === "Legacy" && legacyRow.kind === "bundled");
  }
  try { db?.close(); } catch { /* ignore */ }
  try { fs.rmSync(dbFile, { force: true }); fs.rmSync(dbFile + "-wal", { force: true }); fs.rmSync(dbFile + "-shm", { force: true }); } catch { /* best-effort */ }
}

// ===================== (b) DB round-trip (fresh DB) =====================
const { Db } = await import("../dist/db.js");
const db2 = new Db();
const created = createCapabilityDef(db2, {
  slug: "pe-thing", name: "PE Thing", description: "d", transport: "stdio", kind: "bundled",
  provision: { command: process.execPath, args: [] }, toolAllowlist: [], passEnv: ["MY_OWN_API_KEY"],
});
check("(b) createCapabilityDef persists passEnv", JSON.stringify(created.passEnv) === JSON.stringify(["MY_OWN_API_KEY"]));
const rowAfterCreate = db2.getCapabilityDefBySlug("pe-thing");
check("(b) the stored row round-trips passEnv exactly", JSON.stringify(rowAfterCreate.passEnv) === JSON.stringify(["MY_OWN_API_KEY"]));

const updated = updateCapabilityDefPassEnv(db2, rowAfterCreate.id, ["MY_OWN_API_KEY", "ANOTHER_VAR"]);
check("(b) updateCapabilityDefPassEnv widens the list", JSON.stringify(updated.passEnv) === JSON.stringify(["MY_OWN_API_KEY", "ANOTHER_VAR"]));
const rowAfterUpdate = db2.getCapabilityDefBySlug("pe-thing");
check("(b) every OTHER field on the row is untouched by the passEnv-only update", rowAfterUpdate.name === "PE Thing" && rowAfterUpdate.kind === "bundled" && JSON.parse(rowAfterUpdate.provisionJson).command === process.execPath);

let threwOnUnknownId = false;
try { updateCapabilityDefPassEnv(db2, "not-a-real-id", ["X"]); } catch { threwOnUnknownId = true; }
check("(b) updateCapabilityDefPassEnv throws a descriptive error for an unknown id (never silently no-ops)", threwOnUnknownId);

let threwOnInvalidPassEnv = false;
try { updateCapabilityDefPassEnv(db2, rowAfterCreate.id, ["LOOM_MCP_TOKEN"]); } catch { threwOnInvalidPassEnv = true; }
check("(b) updateCapabilityDefPassEnv rejects a reserved name (validated same as create)", threwOnInvalidPassEnv);
check("(b) a rejected update leaves the row's passEnv UNCHANGED", JSON.stringify(db2.getCapabilityDefBySlug("pe-thing").passEnv) === JSON.stringify(["MY_OWN_API_KEY", "ANOTHER_VAR"]));

// toCapabilityDefRow never throws on a malformed pass_env_json (defense-in-depth, mirrors every other
// malformed-JSON-row guard in this module) — write one directly via raw SQL, bypassing the validator.
db2.db.prepare("UPDATE capability_defs SET pass_env_json = ? WHERE id = ?").run("{not valid json", rowAfterCreate.id);
let malformedRowThrew = false;
let malformedRow;
try { malformedRow = db2.getCapabilityDefBySlug("pe-thing"); } catch { malformedRowThrew = true; }
check("(b) a malformed pass_env_json degrades to [] rather than throwing", !malformedRowThrew && Array.isArray(malformedRow.passEnv) && malformedRow.passEnv.length === 0);

// ===================== (e) seed rows always carry passEnv:[] =====================
for (const c of bundledCapabilities()) {
  check(`(e) seed row '${c.slug}' carries passEnv:[] (never widened at seed time)`, Array.isArray(c.passEnv) && c.passEnv.length === 0);
}

// ===================== (d) REAL spawn: passEnv widens the launcher's allow-list end to end =====================
{
  const fixtureRow = {
    id: "cap-pe-fixture", slug: "pe-fixture", name: "PE Fixture", description: "", transport: "stdio", kind: "bundled",
    provisionJson: JSON.stringify({ kind: "bundled", command: process.execPath, args: [ECHO_ENV_FIXTURE] }),
    toolAllowlistJson: "[]", wantsScratchDir: false, requiresConnection: false, secretEnvVar: null,
    passEnv: ["AMBIENT_ALLOWED_VAR"], createdAt: new Date().toISOString(),
  };
  // Card fafae623, Code Review round 1 item 3: env-isolation wrapping (and the passEnv-widened allow
  // list) now happens in buildMcpServers' OWN chokepoint loop, not inside resolveCapabilityServer itself
  // — route through buildMcpServers to exercise it, exactly as a real spawn would.
  const mcpServers = buildMcpServers({
    sessionId: "s-passenv-fixture", port: 4317, role: "worker",
    capabilities: [{ slug: "pe-fixture" }], capabilityCatalog: [fixtureRow],
  });
  const resolved = mcpServers["pe-fixture"];
  const unwrapped = unwrapLauncherMount(resolved);
  check("(d) buildMcpServers' chokepoint --allow list carries the row's passEnv entry", unwrapped?.allowKeys.includes("AMBIENT_ALLOWED_VAR"));

  const { stdout } = await execFileAsync(resolved.command, resolved.args, {
    env: {
      PATH: process.env.PATH ?? process.env.Path ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "",
      TEMP: process.env.TEMP ?? process.env.TMP ?? os.tmpdir(), HOME: process.env.HOME ?? "", USERPROFILE: process.env.USERPROFILE ?? "",
      AMBIENT_ALLOWED_VAR: "should-survive-via-passenv",
      AMBIENT_NOT_ALLOWED_VAR: "should-NEVER-survive",
    },
  });
  const echoed = JSON.parse(stdout);
  check("(d) the real spawned target received the passEnv-named ambient var", echoed.env.AMBIENT_ALLOWED_VAR === "should-survive-via-passenv");
  check("(d) the real spawned target did NOT receive an ambient var NOT named in passEnv", !("AMBIENT_NOT_ALLOWED_VAR" in echoed.env));
}

// ===================== (f) REAL HTTP: PATCH /api/capabilities/:id rejects a non-object body =====================
// Code Review round 2 (reviewer 7b1b9aa0): `requirePassEnvKey`'s own `"passEnv" in body` throws a
// TypeError (surfacing as a 500) when `body` is a primitive JSON value (a bare string/number/boolean) —
// the route handler now checks the body is a plain object FIRST, before that call. Real HTTP, not a
// unit call, since the bug lived in the route handler's own cast, not in requirePassEnvKey itself.
{
  const stub = {};
  const { buildServer } = await import("../dist/gateway/server.js");
  const app = await buildServer({
    db: db2, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
    runMcp: stub, control: stub, usageStatus: stub, requestShutdown: () => {}, beginSelfUpdate: () => {},
  });
  for (const [label, rawPayload] of [
    // A bare STRING body must ride as valid JSON TEXT (`"hello"`, quotes included) — light-my-request's
    // `inject()` sends a JS string payload as raw bytes AS-IS, so an unquoted "hello" is a JSON PARSE
    // error (a 400 for an unrelated reason, never reaching the handler at all) rather than exercising
    // the `"passEnv" in body` TypeError this check exists to catch.
    ["a bare JSON string", '"hello"'],
    ["a bare number", "42"],
    ["a bare boolean", "true"],
  ]) {
    const res = await app.inject({
      method: "PATCH", url: `/api/capabilities/${rowAfterCreate.id}`, remoteAddress: "127.0.0.1",
      payload: rawPayload, headers: { "content-type": "application/json" },
    });
    check(`(f) PATCH with ${label} as the whole body is a 400, never a 500/TypeError`, res.statusCode === 400);
    check(`(f) PATCH with ${label}: the 400 body carries an error message, not an unhandled-exception page`,
      (() => { try { return typeof JSON.parse(res.payload).error === "string"; } catch { return false; } })());
  }
  // Still correctly 400 (not 500) for a well-formed OBJECT body that merely omits the key — unaffected.
  const resEmptyObj = await app.inject({ method: "PATCH", url: `/api/capabilities/${rowAfterCreate.id}`, remoteAddress: "127.0.0.1", payload: {} });
  check("(f) PATCH with an empty OBJECT body ({}) is still the pre-existing 400 (requirePassEnvKey's own rejection), unaffected by this fix", resEmptyObj.statusCode === 400);
  // And the real, well-formed update still works end to end through the same route.
  const resOk = await app.inject({ method: "PATCH", url: `/api/capabilities/${rowAfterCreate.id}`, remoteAddress: "127.0.0.1", payload: { passEnv: ["MY_OWN_API_KEY"] } });
  check("(f) PATCH with a well-formed object body still succeeds (200)", resOk.statusCode === 200);
  await app.close();
}

db2.close();
cleanupPathSync(process.env.LOOM_HOME);

console.log(failures === 0
  ? "\n✅ ALL PASS — capability passEnv (card fafae623): validatePassEnv/passEnvReservedReason's charset + LOOM_MCP_TOKEN/CLAUDE_CODE_*/LOOM_* reserved-denylist (case-insensitive) + max-count + dedupe; a real pre-card capability_defs DB migrates cleanly with the legacy row backfilling to passEnv:[]; DB round-trip (create/update-only/unknown-id refusal/rejected-update-leaves-row-unchanged/malformed-JSON-never-throws); every seed row carries passEnv:[]; and a REAL child_process spawn proves passEnv widens the env-isolating launcher's allow-list with exactly the named ambient var, nothing else — claude-free, network-free."
  + " A real HTTP PATCH /api/capabilities/:id with a primitive JSON body (string/number/boolean) is a 400, never a 500/TypeError."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
