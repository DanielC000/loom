import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 5d6e0ace — the Platform Lead reproduced, first-hand, that `project_configure` echoed a project's
// FULL stored config override (sessionEnv plaintext included) on a response to a ONE-KEY patch of an
// unrelated field, on a live credential. A one-key patch to an unrelated field discloses every secret
// that project stores, into the caller's transcript — a caller cannot defend against this by declining
// to read.
//
// SCOPE (narrowed by manager redirect, 2026-09-18): the WRITE surface only — `project_configure` on
// BOTH the loom-platform (Lead, platform.ts:1190) and loom-setup (Setup Assistant, setup.ts:240)
// routers. The DoD-3 sweep also found the SAME shape on `project_get`/`project_update`/
// `list_all_projects` on both routers, but those are HELD — card `ba976a73` gates them on a still-
// pending owner request (`3c7cd17d`, filed 2026-09-04) that explicitly offers "leave as-is" as an
// option, so this branch must not pre-empt that decision.
//
// THE FIX (v2, Code Reviewer follow-up — see docs/decisions/5d6e0ace-project-configure-response-never-
// echoes-a-value-shaped-sessionenv.md for the full incident): v1 masked sessionEnv with same-length
// bullet filler (`maskSessionEnvRecord`), but that mask is ITSELF an accepted `sessionEnv` write payload
// — feeding a v1 response's `config` straight back into `project_configure` (plausible given
// `replace:true`'s "clear keys by omission" framing) OVERWRITES the real secret with the mask,
// INVISIBLY (the masker is idempotent) and UNRECOVERABLY (config history also masks both prior/next).
// v2 instead returns `sessionEnvKeys` (names + VALUE LENGTHS ONLY, e.g. `{FOO: 38}`) in place of
// `sessionEnv` — a key neither validator (`.strict()`, both routers) recognizes, so resubmitting the
// response `config` verbatim is REJECTED outright, in EITHER merge or replace:true mode, before any
// write logic runs.
//
// This proves, per site, with a THROWAWAY secret (never a real credential):
//   (1) the response NEVER carries a value-shaped sessionEnv (masked OR real) — only key names + lengths.
//   (2) the length is the SAME as the real value's length (mirrors the REST masking's own invariant —
//       the Settings editor's truncated-paste detector depends on a length signal surviving).
//   (3) the UNDERLYING STORED value is untouched — a response must never become a stored value.
//   (4) sibling (non-secret) config values still round-trip verbatim, unmasked — the load-bearing
//       "confirm a deep-merge preserved siblings" use case the card explicitly wants preserved.
//   (5) a project with NO sessionEnv at all round-trips with no sessionEnvKeys key (the masker's own
//       early-return, not a crash) — both sites, and the call ACTUALLY SUCCEEDED (not a vacuous pass on
//       a failed call — Code Reviewer finding: `cfg?.sessionEnv === undefined` passes whether the call
//       succeeded with no sessionEnv OR failed outright and returned no `config` at all).
//   (6) ⭐ THE REGRESSION GUARD: feeding a `project_configure` response's `config` straight back as a
//       LATER `project_configure` write (both default-merge and `replace:true` mode) is REJECTED, and
//       the REAL secret survives untouched in storage — this is the assertion that would have caught
//       the CRITICAL defect v1 shipped.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like project-config-patch.mjs: a REAL Db + the
// REAL Platform + Setup routers driven over an in-process MCP InMemoryTransport (no HTTP, no role gate).
//
// Run: 1) build (turbo builds shared first), 2) node test/project-mcp-sessionenv-redaction.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME (set BEFORE importing dist; paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-mcpredact-${Date.now()}-${process.pid}`);
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
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const now = new Date().toISOString();
const db = new Db();

// A THROWAWAY value, never a real credential — same-shape secret name as the specimen that filed this card.
const REAL_SECRET = "throwaway-not-a-real-credential-xyz789";
const REAL_SHORT = "ab";

db.insertProject({
  id: "pMcpRedact", name: "McpRedact", repoPath: tmpHome, vaultPath: tmpHome,
  config: { sessionEnv: { GSC_SERVICE_ACCOUNT_JSON: REAL_SECRET, SHORT: REAL_SHORT }, orchestration: { gateCommandTimeoutMs: 60000 } },
  createdAt: now, archivedAt: null, reserved: false,
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
  const client = new Client({ name: "mcp-sessionenv-redaction-test", version: "0" });
  await client.connect(clientT);
  return async (name, args) => parse(await client.callTool({ name, arguments: args }));
};

// A response is "genuinely non-leaking": NO sessionEnv key at all (masked or real), and sessionEnvKeys
// carries the real value's exact LENGTH under the real key name — never the value itself.
const assertKeysOnly = (label, config, name, realValue) => {
  check(`${label}: no value-shaped sessionEnv key at all`, config?.sessionEnv === undefined);
  const gotLen = config?.sessionEnvKeys?.[name];
  check(`${label}: sessionEnvKeys.${name} is the real length, never the value`, gotLen === realValue.length);
};

try {
  const platform = await connect(new PlatformMcpRouter(db, svc).buildServer());
  const setup = await connect(new SetupMcpRouter(db, svc).buildServer());

  // ============ (1) platform project_configure — patch an UNRELATED key ============
  const pCfg = await platform("project_configure", { projectId: "pMcpRedact", config: { orchestration: { gateCommandTimeoutMs: 300000 } } });
  check("(platform project_configure) accepted", pCfg.ok === true && !pCfg.error);
  assertKeysOnly("(platform project_configure)", pCfg.config, "GSC_SERVICE_ACCOUNT_JSON", REAL_SECRET);
  assertKeysOnly("(platform project_configure)", pCfg.config, "SHORT", REAL_SHORT);
  check("(platform project_configure) ★ the unrelated write landed (sibling confirmation preserved)", pCfg.config?.orchestration?.gateCommandTimeoutMs === 300000);
  check("(platform project_configure) ★ the STORED sessionEnv is untouched (real value, not the mask)", db.getProject("pMcpRedact").config.sessionEnv.GSC_SERVICE_ACCOUNT_JSON === REAL_SECRET);

  // ============ (2) setup project_configure — patch an UNRELATED key (this surface can never SET
  // sessionEnv itself — the agent validator omits it — but must still never echo the PRE-EXISTING value) ============
  const sCfg = await setup("project_configure", { projectId: "pMcpRedact", config: { docLint: true } });
  check("(setup project_configure) accepted", sCfg.ok === true && !sCfg.error);
  assertKeysOnly("(setup project_configure)", sCfg.config, "GSC_SERVICE_ACCOUNT_JSON", REAL_SECRET);
  assertKeysOnly("(setup project_configure)", sCfg.config, "SHORT", REAL_SHORT);
  check("(setup project_configure) ★ the unrelated write landed", sCfg.config?.docLint === true);
  check("(setup project_configure) ★ the STORED sessionEnv is untouched", db.getProject("pMcpRedact").config.sessionEnv.GSC_SERVICE_ACCOUNT_JSON === REAL_SECRET);

  // ============ (3) ⭐ THE REGRESSION GUARD — feeding a response's `config` straight back as a LATER
  // write must be REJECTED (structurally invalid: sessionEnvKeys is an unrecognized key), and the REAL
  // secret must survive untouched. Both default-merge and replace:true modes, both routers. ============
  const roundTripMerge = await platform("project_configure", { projectId: "pMcpRedact", config: pCfg.config });
  check("(round-trip, platform, merge) ★ REJECTED, not silently written", typeof roundTripMerge.error === "string" && !roundTripMerge.ok);
  check("(round-trip, platform, merge) ★ the REAL secret SURVIVES in storage", db.getProject("pMcpRedact").config.sessionEnv.GSC_SERVICE_ACCOUNT_JSON === REAL_SECRET);

  const roundTripReplace = await platform("project_configure", { projectId: "pMcpRedact", config: pCfg.config, replace: true });
  check("(round-trip, platform, replace:true) ★ REJECTED, not silently written", typeof roundTripReplace.error === "string" && !roundTripReplace.ok);
  check("(round-trip, platform, replace:true) ★ the REAL secret SURVIVES in storage", db.getProject("pMcpRedact").config.sessionEnv.GSC_SERVICE_ACCOUNT_JSON === REAL_SECRET);

  const roundTripSetup = await setup("project_configure", { projectId: "pMcpRedact", config: sCfg.config });
  check("(round-trip, setup, merge) ★ REJECTED, not silently written", typeof roundTripSetup.error === "string" && !roundTripSetup.ok);
  check("(round-trip, setup, merge) ★ the REAL secret SURVIVES in storage", db.getProject("pMcpRedact").config.sessionEnv.GSC_SERVICE_ACCOUNT_JSON === REAL_SECRET);

  // ============ (4) a project with NO sessionEnv at all round-trips with no sessionEnvKeys key, on both
  // routers — the masker's own early-return, not a crash. Code Reviewer finding: assert the call
  // ACTUALLY SUCCEEDED first — `cfg?.sessionEnv === undefined` alone would pass on a FAILED call too. ============
  db.insertProject({ id: "pBareMcp", name: "BareMcp", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });
  const bareCfgPlatform = await platform("project_configure", { projectId: "pBareMcp", config: { docLint: true } });
  check("(no sessionEnv) platform project_configure: accepted", bareCfgPlatform.ok === true && !bareCfgPlatform.error);
  check("(no sessionEnv) platform project_configure: no sessionEnvKeys key on response", bareCfgPlatform.config?.sessionEnvKeys === undefined);
  const bareCfgSetup = await setup("project_configure", { projectId: "pBareMcp", config: { docLint: true } });
  check("(no sessionEnv) setup project_configure: accepted", bareCfgSetup.ok === true && !bareCfgSetup.error);
  check("(no sessionEnv) setup project_configure: no sessionEnvKeys key on response", bareCfgSetup.config?.sessionEnvKeys === undefined);
} finally {
  db.close();
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — both project_configure sites (platform Lead + setup Setup Assistant) NEVER return a value-shaped sessionEnv (masked or real) — only sessionEnvKeys (names + real lengths); the unrelated write each call was actually testing still landed correctly (the sibling-confirmation use case the card calls load-bearing); the underlying STORED sessionEnv is never touched by a response; feeding a response's config straight back as a later write (merge OR replace:true, both routers) is REJECTED outright and the real secret survives — the regression guard for the CRITICAL round-trip-destroys-the-secret defect the v1 fix introduced; and a project with no sessionEnv round-trips with no sessionEnvKeys key on either site, proven against an ACTUALLY-SUCCEEDED call."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
