import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card a4637a0c — the SEVENTH project-echo MCP site, found by Code Reviewer 1e7efc4f while reviewing
// bb267ade (which masked the six project_get/project_update/list_all_projects sites on the platform +
// setup routers). mcp/operator.ts's `my_project` (loom-operator, the Bounded Elevated Operator surface)
// returned `db.getProject(...)` RAW via `ok(p)`, bypassing `projectFields()` entirely — its own tool
// description advertised "the FULL record (... config override)". Driven over a real in-process MCP
// transport against a real Db with a throwaway sessionEnv value, the response came back with the real
// secret verbatim.
//
// THE FIX: route `my_project` through the SAME chokepoint bb267ade established — `projectFields()`
// (mcp/entityRowFields.ts), which masks config.sessionEnv with `maskSessionEnvRecord` (@loom/shared).
// No second masker; no per-site redaction.
//
// This proves:
//   (1) the response NEVER carries the real secret verbatim.
//   (2) the mask is same-length bullet filler (mirrors maskSessionEnvRecord's own invariant).
//   (3) the UNDERLYING STORED value is untouched by the read.
//   (4) non-secret sibling config values still round-trip verbatim.
//   (5) a project with NO sessionEnv at all round-trips with no sessionEnv key on the response at all
//       (the masker's own early-return, not a crash), proven against an ACTUALLY-SUCCEEDED call.
//   (6) non-config fields (id, repoPath, vaultPath) still resolve correctly — the fix didn't break the
//       own-project resolution mechanism itself.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like project-mcp-read-sessionenv-masking.mjs: a
// REAL Db + the REAL OperatorMcpRouter driven over an in-process MCP InMemoryTransport (no HTTP, no role
// gate — resolveRole is tested elsewhere, in operator-surface.mjs).
//
// Run: 1) build (turbo builds shared first), 2) node test/operator-my-project-sessionenv-masking.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME (set BEFORE importing dist; paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-opmyproj-mask-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

import { requireHermeticEnv } from "./_guard.mjs";
import { cleanupPathSync } from "./_tmp-fixture.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { OperatorMcpRouter } = await import("../dist/mcp/operator.js");
const { SESSION_ENV_MASK_CHAR } = await import("@loom/shared");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const now = new Date().toISOString();
const db = new Db();

// THROWAWAY values, never real credentials.
const REAL_SECRET = "throwaway-not-a-real-credential-op789";
const REAL_SHORT = "zq";

db.insertProject({
  id: "pOpMask", name: "OpMask", repoPath: tmpHome, vaultPath: tmpHome,
  config: { sessionEnv: { GSC_SERVICE_ACCOUNT_JSON: REAL_SECRET, SHORT: REAL_SHORT }, orchestration: { gateCommandTimeoutMs: 60000 } },
  createdAt: now, archivedAt: null, reserved: false,
});
db.insertProject({
  id: "pOpMaskBare", name: "OpMaskBare", repoPath: tmpHome, vaultPath: tmpHome,
  config: {}, createdAt: now, archivedAt: null, reserved: false,
});
db.insertAgent({ id: "agentOp", projectId: "pOpMask", name: "Operator Agent", startupPrompt: "OP", position: 0, profileId: null });
db.insertAgent({ id: "agentOpBare", projectId: "pOpMaskBare", name: "Operator Agent Bare", startupPrompt: "OP", position: 0, profileId: null });

const seedSession = (id, projectId, agentId) => db.insertSession({
  id, projectId, agentId, engineSessionId: null,
  title: null, cwd: tmpHome, processState: "live", resumability: "unknown", busy: false,
  createdAt: now, lastActivity: now, lastError: null, role: "operator", parentSessionId: null,
});
seedSession("OP", "pOpMask", "agentOp");
seedSession("OPBARE", "pOpMaskBare", "agentOpBare");

// No SessionService/gitWriteTimeouts needed — my_project touches only db.getSession/db.getProject.
const router = new OperatorMcpRouter(db, /* sessions */ undefined, undefined);

const parse = (res) => JSON.parse(res.content[0].text);
const connect = async (server) => {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "operator-my-project-masking-test", version: "0" });
  await client.connect(clientT);
  return async (name, args) => parse(await client.callTool({ name, arguments: args }));
};

const isAllFiller = (s) => s.length > 0 && [...s].every((ch) => ch === SESSION_ENV_MASK_CHAR);

const assertMasked = (label, config, name, realValue) => {
  const got = config?.sessionEnv?.[name];
  check(`${label}: sessionEnv.${name} present`, typeof got === "string");
  check(`${label}: sessionEnv.${name} is NOT the real secret`, got !== realValue);
  check(`${label}: sessionEnv.${name} is all-filler-char, same length as the real value`, got !== undefined && isAllFiller(got) && got.length === realValue.length);
};

try {
  const call = await connect(router.buildServer("OP"));

  // ============ (1)-(4) my_project on the session bound to pOpMask (real sessionEnv present) ============
  const res = await call("my_project", {});
  check("(my_project) resolves to the caller's OWN project", res.id === "pOpMask");
  assertMasked("(my_project)", res.config, "GSC_SERVICE_ACCOUNT_JSON", REAL_SECRET);
  assertMasked("(my_project)", res.config, "SHORT", REAL_SHORT);
  check("(my_project) ★ sibling config value round-trips verbatim", res.config?.orchestration?.gateCommandTimeoutMs === 60000);
  check("(my_project) ★ the STORED sessionEnv is untouched by the read", db.getProject("pOpMask").config.sessionEnv.GSC_SERVICE_ACCOUNT_JSON === REAL_SECRET);

  // ============ (6) non-config fields still resolve correctly ============
  check("(my_project) ★ repoPath still present (projection didn't drop other fields)", res.repoPath === tmpHome);
  check("(my_project) ★ vaultPath still present", res.vaultPath === tmpHome);

  // ============ (5) a project with NO sessionEnv at all round-trips with no sessionEnv key at all,
  // proven against an ACTUALLY-SUCCEEDED call (a different session, bound to the bare project). ============
  const callBare = await connect(router.buildServer("OPBARE"));
  const bareRes = await callBare("my_project", {});
  check("(no sessionEnv) my_project: resolved the right project", bareRes.id === "pOpMaskBare");
  check("(no sessionEnv) my_project: no sessionEnv key on response", bareRes.config?.sessionEnv === undefined);
} finally {
  db.close();
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — operator.ts's my_project masks config.sessionEnv (same-length filler, never the real secret) by routing through the SAME projectFields() chokepoint bb267ade established; non-secret sibling config values and non-config fields (id/repoPath/vaultPath) round-trip verbatim; the underlying STORED sessionEnv survives the read untouched; and a project with no sessionEnv round-trips with no sessionEnv key at all, proven against an ACTUALLY-SUCCEEDED call."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
