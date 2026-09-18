import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card bb267ade — the released "other half" of card 5d6e0ace: that card fixed project_configure's own
// response (both routers) so it never echoes a value-shaped sessionEnv. The SAME sweep found six more
// MCP sites returning a project's FULL config (sessionEnv plaintext included) on an ordinary read:
// project_get, project_update, and list_all_projects, on BOTH mcp/platform.ts (Platform Lead) and
// mcp/setup.ts (Setup Assistant). list_all_projects is the worst of the six — every project's sessionEnv
// on the daemon, in cleartext, in ONE call — and on setup.ts that is the ungated operator surface
// shipping to every loomctl user.
//
// THE FIX: all six sites flow through one chokepoint, `projectFields` (mcp/entityRowFields.ts), which now
// masks config.sessionEnv with `maskSessionEnvRecord` (@loom/shared) — same-length bullet filler, never
// the real secret. Verified before choosing the chokepoint: none of the six call sites re-saves `config`
// built from what `projectFields` returns (see docs/decisions/bb267ade-*.md), so masking at the
// chokepoint can never poison a write on its own.
//
// THE BLOCKER THIS CARD WAS GATED ON: a masked response is itself a VALID write payload for
// project_configure's `config` (unlike project_configure's OWN v2 fix, which reshapes sessionEnv into
// sessionEnvKeys — a key neither validator recognizes). Card a253cec8 landed FIRST (setProjectConfigSafe,
// tasks/columns.ts) so feeding a masked echo back as a later write is REJECTED at the one chokepoint every
// config writer shares, not silently stored. This test's regression-guard section (6) is what would have
// caught shipping the mask without that guard.
//
// This proves, per site (project_get / project_update / list_all_projects, both routers):
//   (1) the response NEVER carries the real secret verbatim.
//   (2) the mask is same-length bullet filler (mirrors maskSessionEnvRecord's own invariant).
//   (3) the UNDERLYING STORED value is untouched by the read (or, for project_update, by the unrelated
//       write that call also performs).
//   (4) non-secret sibling config values still round-trip verbatim (the load-bearing "confirm a
//       deep-merge preserved siblings" use case).
//   (5) a project with NO sessionEnv at all round-trips with no sessionEnv key on the response at all
//       (the masker's own early-return, not a crash) — proven against an ACTUALLY-SUCCEEDED call.
//   (6) ⭐ THE REGRESSION GUARD — feeding a masked response's `config` straight back into project_configure
//       (both routers, merge AND replace:true) is REJECTED, and the REAL secret survives untouched.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like project-mcp-sessionenv-redaction.mjs: a REAL
// Db + the REAL Platform + Setup routers driven over an in-process MCP InMemoryTransport.
//
// Run: 1) build (turbo builds shared first), 2) node test/project-mcp-read-sessionenv-masking.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME (set BEFORE importing dist; paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-mcpreadmask-${Date.now()}-${process.pid}`);
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
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { SESSION_ENV_MASK_CHAR } = await import("@loom/shared");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const now = new Date().toISOString();
const db = new Db();

// THROWAWAY values, never real credentials.
const REAL_SECRET = "throwaway-not-a-real-credential-abc123";
const REAL_SHORT = "xy";

db.insertProject({
  id: "pReadMask", name: "ReadMask", repoPath: tmpHome, vaultPath: tmpHome,
  config: { sessionEnv: { GSC_SERVICE_ACCOUNT_JSON: REAL_SECRET, SHORT: REAL_SHORT }, orchestration: { gateCommandTimeoutMs: 60000 } },
  createdAt: now, archivedAt: null, reserved: false,
});
db.insertProject({
  id: "pReadMaskBare", name: "ReadMaskBare", repoPath: tmpHome, vaultPath: tmpHome,
  config: {}, createdAt: now, archivedAt: null, reserved: false,
});

class SeamHost extends createSeamHost(PtyHost) {
  createPty(opts) { return { ...super.createPty(opts), pid: 1 }; }
  stop() {}
}
const host = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
const svc = new SessionService(db, host, new OrchestrationControl());

const parse = (res) => JSON.parse(res.content[0].text);
const connect = async (server) => {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "mcp-read-sessionenv-masking-test", version: "0" });
  await client.connect(clientT);
  return async (name, args) => parse(await client.callTool({ name, arguments: args }));
};

const isAllFiller = (s) => s.length > 0 && [...s].every((ch) => ch === SESSION_ENV_MASK_CHAR);

// A response is "genuinely masked": the sessionEnv value is present (round-trip shape preserved), never
// the real secret, all-filler-char, and the SAME length as the real value.
const assertMasked = (label, config, name, realValue) => {
  const got = config?.sessionEnv?.[name];
  check(`${label}: sessionEnv.${name} present`, typeof got === "string");
  check(`${label}: sessionEnv.${name} is NOT the real secret`, got !== realValue);
  check(`${label}: sessionEnv.${name} is all-filler-char, same length as the real value`, got !== undefined && isAllFiller(got) && got.length === realValue.length);
};

try {
  const platform = await connect(new PlatformMcpRouter(db, svc).buildServer());
  const setup = await connect(new SetupMcpRouter(db, svc).buildServer());

  // ============ (1) list_all_projects — both routers ============
  const platformList = await platform("list_all_projects", {});
  const pRow = platformList.find((p) => p.id === "pReadMask");
  check("(platform list_all_projects) found the fixture project", pRow !== undefined);
  assertMasked("(platform list_all_projects)", pRow?.config, "GSC_SERVICE_ACCOUNT_JSON", REAL_SECRET);
  assertMasked("(platform list_all_projects)", pRow?.config, "SHORT", REAL_SHORT);
  check("(platform list_all_projects) ★ sibling config value round-trips verbatim", pRow?.config?.orchestration?.gateCommandTimeoutMs === 60000);

  const setupList = await setup("list_all_projects", {});
  const sRow = setupList.find((p) => p.id === "pReadMask");
  check("(setup list_all_projects) found the fixture project", sRow !== undefined);
  assertMasked("(setup list_all_projects)", sRow?.config, "GSC_SERVICE_ACCOUNT_JSON", REAL_SECRET);
  assertMasked("(setup list_all_projects)", sRow?.config, "SHORT", REAL_SHORT);
  check("(setup list_all_projects) ★ sibling config value round-trips verbatim", sRow?.config?.orchestration?.gateCommandTimeoutMs === 60000);

  check("★ the STORED sessionEnv is untouched after both list_all_projects reads", db.getProject("pReadMask").config.sessionEnv.GSC_SERVICE_ACCOUNT_JSON === REAL_SECRET);

  // ============ (2) project_get — both routers ============
  const pGet = await platform("project_get", { projectId: "pReadMask" });
  assertMasked("(platform project_get)", pGet.config, "GSC_SERVICE_ACCOUNT_JSON", REAL_SECRET);
  check("(platform project_get) ★ sibling config value round-trips verbatim", pGet.config?.orchestration?.gateCommandTimeoutMs === 60000);
  check("(platform project_get) ★ non-config fields (e.g. columns) still present", Array.isArray(pGet.columns));

  const sGet = await setup("project_get", { projectId: "pReadMask" });
  assertMasked("(setup project_get)", sGet.config, "GSC_SERVICE_ACCOUNT_JSON", REAL_SECRET);
  check("(setup project_get) ★ sibling config value round-trips verbatim", sGet.config?.orchestration?.gateCommandTimeoutMs === 60000);

  check("★ the STORED sessionEnv is untouched after both project_get reads", db.getProject("pReadMask").config.sessionEnv.GSC_SERVICE_ACCOUNT_JSON === REAL_SECRET);

  // ============ (3) project_update — both routers. Each performs a REAL unrelated write (name), which
  // must land, while the echoed config's sessionEnv stays masked and the stored secret stays untouched. ============
  const pUpd = await platform("project_update", { projectId: "pReadMask", name: "ReadMask-Renamed-Platform" });
  check("(platform project_update) accepted (no error)", !pUpd.error);
  check("(platform project_update) ★ the unrelated write landed", pUpd.name === "ReadMask-Renamed-Platform");
  assertMasked("(platform project_update)", pUpd.config, "GSC_SERVICE_ACCOUNT_JSON", REAL_SECRET);
  check("(platform project_update) ★ sibling config value round-trips verbatim", pUpd.config?.orchestration?.gateCommandTimeoutMs === 60000);
  check("(platform project_update) ★ the STORED sessionEnv is untouched", db.getProject("pReadMask").config.sessionEnv.GSC_SERVICE_ACCOUNT_JSON === REAL_SECRET);

  const sUpd = await setup("project_update", { projectId: "pReadMask", name: "ReadMask-Renamed-Setup", config: { docLint: true } });
  check("(setup project_update) accepted (no error)", !sUpd.error);
  check("(setup project_update) ★ the unrelated writes landed (name + docLint)", sUpd.name === "ReadMask-Renamed-Setup" && sUpd.config?.docLint === true);
  assertMasked("(setup project_update)", sUpd.config, "GSC_SERVICE_ACCOUNT_JSON", REAL_SECRET);
  check("(setup project_update) ★ sibling config value round-trips verbatim", sUpd.config?.orchestration?.gateCommandTimeoutMs === 60000);
  check("(setup project_update) ★ the STORED sessionEnv is untouched", db.getProject("pReadMask").config.sessionEnv.GSC_SERVICE_ACCOUNT_JSON === REAL_SECRET);

  // ============ (4) a project with NO sessionEnv at all: no sessionEnv key on the response at all, on
  // every one of the six sites, proven against an ACTUALLY-SUCCEEDED call. ============
  const bareList = (await platform("list_all_projects", {})).find((p) => p.id === "pReadMaskBare");
  check("(no sessionEnv) platform list_all_projects: no sessionEnv key on response", bareList !== undefined && bareList.config?.sessionEnv === undefined);
  const bareGet = await platform("project_get", { projectId: "pReadMaskBare" });
  check("(no sessionEnv) platform project_get: no sessionEnv key on response", bareGet.config?.sessionEnv === undefined);
  const bareUpd = await platform("project_update", { projectId: "pReadMaskBare", name: "ReadMaskBare2" });
  check("(no sessionEnv) platform project_update: accepted", !bareUpd.error && bareUpd.name === "ReadMaskBare2");
  check("(no sessionEnv) platform project_update: no sessionEnv key on response", bareUpd.config?.sessionEnv === undefined);
  const bareSetupUpd = await setup("project_update", { projectId: "pReadMaskBare", name: "ReadMaskBare3" });
  check("(no sessionEnv) setup project_update: accepted", !bareSetupUpd.error && bareSetupUpd.name === "ReadMaskBare3");
  check("(no sessionEnv) setup project_update: no sessionEnv key on response", bareSetupUpd.config?.sessionEnv === undefined);

  // ============ (5) ⭐ THE REGRESSION GUARD — feed a masked read response's `config` straight back into
  // project_configure (the write surface both routers share) and confirm it is REJECTED, not silently
  // stored, and the REAL secret survives. This is the assertion that makes masking these six read sites
  // safe — without card a253cec8's write-side guard, this section would instead show the mask silently
  // overwriting the real secret. ============
  const roundTripMerge = await platform("project_configure", { projectId: "pReadMask", config: pGet.config });
  check("(round-trip, platform project_configure, merge) ★ REJECTED, not silently written", typeof roundTripMerge.error === "string" && !roundTripMerge.ok);
  check("(round-trip, platform project_configure, merge) ★ the REAL secret SURVIVES in storage", db.getProject("pReadMask").config.sessionEnv.GSC_SERVICE_ACCOUNT_JSON === REAL_SECRET);

  const roundTripReplace = await platform("project_configure", { projectId: "pReadMask", config: pGet.config, replace: true });
  check("(round-trip, platform project_configure, replace:true) ★ REJECTED, not silently written", typeof roundTripReplace.error === "string" && !roundTripReplace.ok);
  check("(round-trip, platform project_configure, replace:true) ★ the REAL secret SURVIVES in storage", db.getProject("pReadMask").config.sessionEnv.GSC_SERVICE_ACCOUNT_JSON === REAL_SECRET);

  // setup's project_configure validator rejects `sessionEnv` as an unknown/human-only key outright (a
  // SEPARATE, structural reason a masked echo can never be written back here) — confirm that holds too,
  // so this surface's own round-trip is provably safe by whichever mechanism actually fires.
  const roundTripSetup = await setup("project_configure", { projectId: "pReadMask", config: sGet.config });
  check("(round-trip, setup project_configure) ★ REJECTED, not silently written", typeof roundTripSetup.error === "string" && !roundTripSetup.ok);
  check("(round-trip, setup project_configure) ★ the REAL secret SURVIVES in storage", db.getProject("pReadMask").config.sessionEnv.GSC_SERVICE_ACCOUNT_JSON === REAL_SECRET);
} finally {
  db.close();
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — project_get/project_update/list_all_projects on BOTH the platform and setup MCP routers mask config.sessionEnv (same-length filler, never the real secret); non-secret sibling config values round-trip verbatim; the unrelated writes project_update also performs still land; the underlying STORED sessionEnv survives every read AND every unrelated write; a project with no sessionEnv round-trips with no sessionEnv key at all on any of the six sites; and feeding a masked response's config straight back into project_configure (merge or replace:true, either router) is REJECTED outright with the real secret intact — the regression guard for the class of defect this card exists to prevent."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
