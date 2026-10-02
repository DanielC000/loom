import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card eccd874c — `projectFields` (mcp/entityRowFields.ts) masked `config.sessionEnv` (card bb267ade)
// but left `config.orchestration.alertWebhook.url` — a Slack/Discord webhook URL, a bearer credential —
// verbatim on every MCP project read (`project_get`/`project_update`/`list_all_projects`, both the
// Platform Lead and Setup Assistant routers). alertWebhook is already human-only to WRITE
// (agentOrchestrationOverride omits it); reading the secret gave an agent a credential it could never
// otherwise obtain.
//
// THE FIX: `redactAlertWebhookInConfig` (@loom/shared) masks `orchestration.alertWebhook.url` down to
// `<scheme>//***` at the same chokepoint sessionEnv uses — `projectFields`. Round 2 (card eccd874c)
// strips the HOST too, not just the path/query — some providers (e.g. Pipedream's
// `https://<token>.m.pipedream.net`) carry their bearer-credential material in the SUBDOMAIN, which
// round 1's `<scheme>//<host>/***` form still leaked. Only the scheme survives as a non-secret
// "configured" indicator. `events` is untouched.
//
// This proves, mirroring project-mcp-read-sessionenv-masking.mjs's structure:
//   (1) list_all_projects / project_get / project_update (both routers) return the masked url, never the
//       real one — host AND path/query/token gone, only the scheme survives.
//   (2) sibling config values (events, gateCommandTimeoutMs) round-trip verbatim.
//   (3) the underlying STORED alertWebhook.url is untouched by any read or by project_update's unrelated write.
//   (4) a project with NO alertWebhook at all round-trips with no alertWebhook key, proven against an
//       ACTUALLY-SUCCEEDED call.
//   (5) ⭐ THE REGRESSION GUARD — feeding a masked project_get response's config.orchestration.alertWebhook
//       straight back into the Platform Lead's project_configure (the ONE write surface that is both
//       reachable by a masked-read session AND validated by the FULL validator that accepts alertWebhook
//       at all) is REJECTED, with the exact rejection text, and the real URL survives in storage.
//   (6) the ordinary agent validator (manager/Setup Assistant project_configure) still REJECTS
//       orchestration.alertWebhook outright — confirmed by execution, unchanged by this card.
//   (7) a Pipedream-shaped URL (secret in the SUBDOMAIN) masks to the same scheme-only placeholder, with
//       no trace of the subdomain token anywhere in the response — the round-2 host-stripping fix.
//   (8) ROUND 2's echo-guard fix: a project whose STORED url is already a fixed point of its own mask
//       (host literally `***`) still accepts an unrelated config write (the fixed-point lockout); a
//       case/trailing-slash VARIANT of the mask is still rejected as an echo even though it isn't an
//       exact string match of this stored url's own mask (the shape-match fix); and a genuinely NEW url
//       is still accepted on the elevated surface (the guard doesn't reject every write to this field).
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like project-mcp-read-sessionenv-masking.mjs: a
// REAL Db + the REAL Platform + Setup routers driven over an in-process MCP InMemoryTransport.
//
// Run: 1) build (turbo builds shared first), 2) node test/project-mcp-read-alertwebhook-masking.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME (set BEFORE importing dist; paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-webhookmask-${Date.now()}-${process.pid}`);
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
const { validateAgentProjectConfigOverride } = await import("../dist/mcp/platform.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const now = new Date().toISOString();
const db = new Db();

// A THROWAWAY webhook URL, never a real credential — same shape (host + token-looking path) as a real
// Slack incoming-webhook URL.
const REAL_URL = "https://hooks.example.com/services/T000/B111/throwaway-not-a-real-token-xyz789";
const EXPECTED_MASK = "https://***";
// A Pipedream-shaped URL (round 2, card eccd874c): the bearer-credential material lives in the
// SUBDOMAIN, not the path — round 1's host-preserving mask (`<scheme>//<host>/***`) would have leaked it.
const PIPEDREAM_URL = "https://eoabc123secrettoken456.m.pipedream.net/webhook";

db.insertProject({
  id: "pWebhookMask", name: "WebhookMask", repoPath: tmpHome, vaultPath: tmpHome,
  config: {
    orchestration: { alertWebhook: { url: REAL_URL, events: ["merge_done"] }, gateCommandTimeoutMs: 60000 },
  },
  createdAt: now, archivedAt: null, reserved: false,
});
db.insertProject({
  id: "pWebhookMaskBare", name: "WebhookMaskBare", repoPath: tmpHome, vaultPath: tmpHome,
  config: {}, createdAt: now, archivedAt: null, reserved: false,
});
db.insertProject({
  id: "pWebhookMaskPipedream", name: "WebhookMaskPipedream", repoPath: tmpHome, vaultPath: tmpHome,
  config: {
    orchestration: { alertWebhook: { url: PIPEDREAM_URL, events: ["merge_done"] } },
  },
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
  const client = new Client({ name: "mcp-read-alertwebhook-masking-test", version: "0" });
  await client.connect(clientT);
  return async (name, args) => parse(await client.callTool({ name, arguments: args }));
};

// A response is "genuinely masked": the url is present (round-trip shape preserved), never the real url,
// is EXACTLY the expected scheme-only placeholder, and carries none of the real host/path/query/token text.
const assertMasked = (label, config) => {
  const got = config?.orchestration?.alertWebhook?.url;
  check(`${label}: alertWebhook.url present`, typeof got === "string");
  check(`${label}: alertWebhook.url is NOT the real url`, got !== REAL_URL);
  check(`${label}: alertWebhook.url is exactly the scheme-only placeholder`, got === EXPECTED_MASK);
  check(`${label}: alertWebhook.url carries none of the real host/path/token text`, typeof got === "string" && !got.includes("hooks.example.com") && !got.includes("T000") && !got.includes("B111") && !got.includes("throwaway-not-a-real-token-xyz789"));
};

try {
  const platform = await connect(new PlatformMcpRouter(db, svc).buildServer());
  const setup = await connect(new SetupMcpRouter(db, svc).buildServer());

  // ============ (1) list_all_projects — both routers ============
  const platformList = await platform("list_all_projects", {});
  const pRow = platformList.find((p) => p.id === "pWebhookMask");
  check("(platform list_all_projects) found the fixture project", pRow !== undefined);
  assertMasked("(platform list_all_projects)", pRow?.config);
  check("(platform list_all_projects) ★ sibling events array round-trips verbatim", JSON.stringify(pRow?.config?.orchestration?.alertWebhook?.events) === JSON.stringify(["merge_done"]));
  check("(platform list_all_projects) ★ sibling config value round-trips verbatim", pRow?.config?.orchestration?.gateCommandTimeoutMs === 60000);

  const setupList = await setup("list_all_projects", {});
  const sRow = setupList.find((p) => p.id === "pWebhookMask");
  check("(setup list_all_projects) found the fixture project", sRow !== undefined);
  assertMasked("(setup list_all_projects)", sRow?.config);

  check("★ the STORED alertWebhook.url is untouched after both list_all_projects reads", db.getProject("pWebhookMask").config.orchestration.alertWebhook.url === REAL_URL);

  // ============ (2) project_get — both routers ============
  const pGet = await platform("project_get", { projectId: "pWebhookMask" });
  assertMasked("(platform project_get)", pGet.config);
  check("(platform project_get) ★ non-config fields (e.g. columns) still present", Array.isArray(pGet.columns));

  const sGet = await setup("project_get", { projectId: "pWebhookMask" });
  assertMasked("(setup project_get)", sGet.config);

  check("★ the STORED alertWebhook.url is untouched after both project_get reads", db.getProject("pWebhookMask").config.orchestration.alertWebhook.url === REAL_URL);

  // ============ (3) project_update — both routers. Each performs a REAL unrelated write (name), which
  // must land, while the echoed config's alertWebhook stays masked and the stored url stays untouched. ============
  const pUpd = await platform("project_update", { projectId: "pWebhookMask", name: "WebhookMask-Renamed-Platform" });
  check("(platform project_update) accepted (no error)", !pUpd.error);
  check("(platform project_update) ★ the unrelated write landed", pUpd.name === "WebhookMask-Renamed-Platform");
  assertMasked("(platform project_update)", pUpd.config);
  check("(platform project_update) ★ the STORED alertWebhook.url is untouched", db.getProject("pWebhookMask").config.orchestration.alertWebhook.url === REAL_URL);

  const sUpd = await setup("project_update", { projectId: "pWebhookMask", name: "WebhookMask-Renamed-Setup" });
  check("(setup project_update) accepted (no error)", !sUpd.error);
  check("(setup project_update) ★ the unrelated write landed", sUpd.name === "WebhookMask-Renamed-Setup");
  assertMasked("(setup project_update)", sUpd.config);
  check("(setup project_update) ★ the STORED alertWebhook.url is untouched", db.getProject("pWebhookMask").config.orchestration.alertWebhook.url === REAL_URL);

  // ============ (4) a project with NO alertWebhook at all: no alertWebhook key on the response, proven
  // against an ACTUALLY-SUCCEEDED call. ============
  const bareList = (await platform("list_all_projects", {})).find((p) => p.id === "pWebhookMaskBare");
  check("(no alertWebhook) platform list_all_projects: no alertWebhook key on response", bareList !== undefined && bareList.config?.orchestration?.alertWebhook === undefined);
  const bareGet = await platform("project_get", { projectId: "pWebhookMaskBare" });
  check("(no alertWebhook) platform project_get: no alertWebhook key on response", bareGet.config?.orchestration?.alertWebhook === undefined);
  const bareUpd = await platform("project_update", { projectId: "pWebhookMaskBare", name: "WebhookMaskBare2" });
  check("(no alertWebhook) platform project_update: accepted", !bareUpd.error && bareUpd.name === "WebhookMaskBare2");
  check("(no alertWebhook) platform project_update: no alertWebhook key on response", bareUpd.config?.orchestration?.alertWebhook === undefined);
  const bareCfg = await platform("project_configure", { projectId: "pWebhookMaskBare", config: { docLint: true } });
  check("(no alertWebhook) platform project_configure: accepted", !bareCfg.error && bareCfg.ok === true);
  check("(no alertWebhook) platform project_configure: no alertWebhook key on response", bareCfg.config?.orchestration?.alertWebhook === undefined);

  // ============ (7) a Pipedream-shaped URL — the secret lives in the SUBDOMAIN, not the path. Round 1's
  // host-preserving mask (`<scheme>//<host>/***`) would have leaked it; round 2 strips the host too, so
  // this masks down to the SAME scheme-only placeholder as any other https URL, with no trace of the
  // subdomain token anywhere in the response. ============
  const pipedreamGet = await platform("project_get", { projectId: "pWebhookMaskPipedream" });
  assertMasked("(pipedream) platform project_get", pipedreamGet.config);
  check("(pipedream) ★ masked response carries none of the subdomain secret-token text", !JSON.stringify(pipedreamGet.config).includes("eoabc123secrettoken456"));
  check("(pipedream) ★ the STORED url is untouched", db.getProject("pWebhookMaskPipedream").config.orchestration.alertWebhook.url === PIPEDREAM_URL);

  const echoRejectionText =
    "orchestration.alertWebhook.url write rejected: looks like a masked read-response echoed back (matches the masked-placeholder shape for the stored value) rather than a real URL — re-read the ACTUAL URL before writing it, or leave alertWebhook out of the payload to keep it unchanged";

  // ============ (4b) ⭐ card eccd874c's expanded scope — project_configure's OWN write-response (BOTH
  // platform.ts and setup.ts) is a READ of this project's config in disguise: it echoes the full stored
  // config as a side effect of an UNRELATED write. Setup's agent validator can never WRITE alertWebhook,
  // but it must still mask one that's already stored — an agent that can only make a benign change
  // (docLint) must never read the credential back this way. Then: feeding THAT write-response's own
  // config straight back into project_configure must be REJECTED, with the real url surviving — this is
  // the regression guard for the write-response path specifically, distinct from (5) below (which
  // round-trips a project_get READ response, not a project_configure WRITE response). ============
  const pCfgResp = await platform("project_configure", { projectId: "pWebhookMask", config: { docLint: true } });
  check("(platform project_configure) accepted (unrelated write)", pCfgResp.ok === true && !pCfgResp.error);
  assertMasked("(platform project_configure write-response)", pCfgResp.config);
  check("(platform project_configure) ★ the unrelated write landed", pCfgResp.config?.docLint === true);
  check("★ the STORED alertWebhook.url is untouched by the platform project_configure write-response echo", db.getProject("pWebhookMask").config.orchestration.alertWebhook.url === REAL_URL);

  const sCfgResp = await setup("project_configure", { projectId: "pWebhookMask", config: { docLint: false } });
  check("(setup project_configure) accepted (unrelated write)", sCfgResp.ok === true && !sCfgResp.error);
  assertMasked("(setup project_configure write-response)", sCfgResp.config);
  check("(setup project_configure) ★ the unrelated write landed", sCfgResp.config?.docLint === false);
  check("★ the STORED alertWebhook.url is untouched by the setup project_configure write-response echo", db.getProject("pWebhookMask").config.orchestration.alertWebhook.url === REAL_URL);

  const roundTripFromPlatformWriteResponse = await platform("project_configure", { projectId: "pWebhookMask", config: { orchestration: { alertWebhook: pCfgResp.config.orchestration.alertWebhook } } });
  check("(round-trip the platform WRITE-response) ★ REJECTED, not silently written", typeof roundTripFromPlatformWriteResponse.error === "string" && !roundTripFromPlatformWriteResponse.ok);
  check("(round-trip the platform WRITE-response) ★ rejection names the echo guard", roundTripFromPlatformWriteResponse.error === echoRejectionText);
  check("(round-trip the platform WRITE-response) ★ the REAL url SURVIVES in storage", db.getProject("pWebhookMask").config.orchestration.alertWebhook.url === REAL_URL);

  const roundTripFromSetupWriteResponse = await setup("project_configure", { projectId: "pWebhookMask", config: { orchestration: { alertWebhook: sCfgResp.config.orchestration.alertWebhook } } });
  check("(round-trip the setup WRITE-response) ★ REJECTED outright (agent validator never accepts alertWebhook)", typeof roundTripFromSetupWriteResponse.error === "string" && !roundTripFromSetupWriteResponse.ok);
  check("(round-trip the setup WRITE-response) ★ the REAL url SURVIVES in storage", db.getProject("pWebhookMask").config.orchestration.alertWebhook.url === REAL_URL);

  // ============ (5) ⭐ THE REGRESSION GUARD — feed a masked project_get response's config straight back
  // into the Platform Lead's project_configure (the FULL validator, which — unlike the agent validator —
  // accepts orchestration.alertWebhook at all) and confirm it is REJECTED, not silently stored, and the
  // REAL url survives. ============
  const roundTripMerge = await platform("project_configure", { projectId: "pWebhookMask", config: { orchestration: { alertWebhook: pGet.config.orchestration.alertWebhook } } });
  check("(round-trip, platform project_configure, merge) ★ REJECTED, not silently written", typeof roundTripMerge.error === "string" && !roundTripMerge.ok);
  check("(round-trip, platform project_configure, merge) ★ rejection names the echo guard", roundTripMerge.error === echoRejectionText);
  check("(round-trip, platform project_configure, merge) ★ the REAL url SURVIVES in storage", db.getProject("pWebhookMask").config.orchestration.alertWebhook.url === REAL_URL);

  const roundTripReplace = await platform("project_configure", { projectId: "pWebhookMask", config: pGet.config, replace: true });
  check("(round-trip, platform project_configure, replace:true) ★ REJECTED, not silently written", typeof roundTripReplace.error === "string" && !roundTripReplace.ok);
  check("(round-trip, platform project_configure, replace:true) ★ rejection names the echo guard", roundTripReplace.error === echoRejectionText);
  check("(round-trip, platform project_configure, replace:true) ★ the REAL url SURVIVES in storage", db.getProject("pWebhookMask").config.orchestration.alertWebhook.url === REAL_URL);

  // A genuinely NEW webhook (not an echo of the stored mask) must still be settable on this elevated
  // surface — the guard must not accidentally reject every write to this field.
  const genuineSet = await platform("project_configure", { projectId: "pWebhookMask", config: { orchestration: { alertWebhook: { url: "https://hooks.example.com/services/NEW/REAL/rotated-token", events: ["merge_done"] } } } });
  check("(genuine rotation, platform project_configure) ★ a REAL new url (not an echo) is ACCEPTED", genuineSet.ok === true && !genuineSet.error);
  check("(genuine rotation, platform project_configure) ★ the NEW url is stored", db.getProject("pWebhookMask").config.orchestration.alertWebhook.url === "https://hooks.example.com/services/NEW/REAL/rotated-token");

  // ============ (8) ROUND 2 — the echo-guard fixes. THE ROUND-1 BUG, reproduced exactly: round 1's mask
  // was `<scheme>//<host>/***` (host preserved), so a stored url whose PATH already happened to be
  // literally `/***` was a FIXED POINT of that mask — `maskAlertWebhookUrl(storedUrl) === storedUrl`. The
  // old exact-match check then rejected every write that round-tripped this UNCHANGED value, human REST
  // included. ============
  const OLD_MASK_FIXED_POINT_URL = "https://hooks.example.com/***";
  db.insertProject({
    id: "pWebhookMaskFixedPoint", name: "WebhookMaskFixedPoint", repoPath: tmpHome, vaultPath: tmpHome,
    config: {
      orchestration: { alertWebhook: { url: OLD_MASK_FIXED_POINT_URL, events: ["merge_done"] }, gateCommandTimeoutMs: 60000 },
    },
    createdAt: now, archivedAt: null, reserved: false,
  });

  // 8a: an UNRELATED project_configure write (never touches alertWebhook) must still succeed — the
  // merged `next.orchestration.alertWebhook.url` is byte-identical to the stored fixed-point value, so
  // the echo guard's `url === priorUrl` exemption must let it through untouched. Pre-fix, this is exactly
  // the round-1 lockout: REJECTED, forever, for this project.
  const fixedPointUnrelated = await platform("project_configure", { projectId: "pWebhookMaskFixedPoint", config: { docLint: true } });
  check("(8a fixed-point) ★ an UNRELATED write still succeeds (pre-fix: blocked every write to this project forever)", fixedPointUnrelated.ok === true && !fixedPointUnrelated.error);
  check("(8a fixed-point) the STORED alertWebhook.url is still the fixed-point value, untouched", db.getProject("pWebhookMaskFixedPoint").config.orchestration.alertWebhook.url === OLD_MASK_FIXED_POINT_URL);

  // 8b: a case/trailing-slash VARIANT of the CURRENT mask shape — genuinely DIFFERENT from the stored
  // value (so it is not exempted by the unchanged-value check) — must still be rejected as an echo by
  // SHAPE, not by an exact string match against this project's own `maskAlertWebhookUrl(priorUrl)` output
  // (which, for this fixture, isn't even this variant's shape — it's a DIFFERENT URL's mask entirely).
  const variantAttempt = await platform("project_configure", { projectId: "pWebhookMaskFixedPoint", config: { orchestration: { alertWebhook: { url: "HTTPS://***/", events: ["merge_done"] } } } });
  check("(8b variant) ★ a case/trailing-slash mask VARIANT is REJECTED (shape match, not exact match)", typeof variantAttempt.error === "string" && !variantAttempt.ok);
  check("(8b variant) rejection names the echo guard", variantAttempt.error === echoRejectionText);
  check("(8b variant) the STORED url is untouched", db.getProject("pWebhookMaskFixedPoint").config.orchestration.alertWebhook.url === OLD_MASK_FIXED_POINT_URL);

  // 8c: a genuinely NEW, non-mask-shaped url must still be accepted on a project that WAS a fixed point —
  // the guard rejects echoes, not every write to this field.
  const genuineOnFixedPoint = await platform("project_configure", { projectId: "pWebhookMaskFixedPoint", config: { orchestration: { alertWebhook: { url: "https://hooks.example.com/services/BRAND/NEW/real-token", events: ["merge_done"] } } } });
  check("(8c genuine) ★ a genuinely new url is ACCEPTED even on a project that WAS a fixed point", genuineOnFixedPoint.ok === true && !genuineOnFixedPoint.error);
  check("(8c genuine) the NEW url is stored", db.getProject("pWebhookMaskFixedPoint").config.orchestration.alertWebhook.url === "https://hooks.example.com/services/BRAND/NEW/real-token");

  // ============ (6) the ordinary AGENT validator still rejects orchestration.alertWebhook outright
  // (unchanged by this card) — setup's project_configure routes through it exclusively. ============
  check("(6) validateAgentProjectConfigOverride REJECTS alertWebhook (agent path unchanged)",
    validateAgentProjectConfigOverride({ orchestration: { alertWebhook: { url: "https://e.com/hook", events: [] } } }).ok === false);
  const setupAttempt = await setup("project_configure", { projectId: "pWebhookMask", config: { orchestration: { alertWebhook: { url: "https://attacker.example/x", events: [] } } } });
  check("(setup project_configure) ★ REJECTED outright (agent validator never accepts alertWebhook)", typeof setupAttempt.error === "string" && !setupAttempt.ok);
} finally {
  db.close();
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — project_get/project_update/list_all_projects AND project_configure's own write-response, on BOTH the platform and setup MCP routers, mask config.orchestration.alertWebhook.url down to a scheme-only placeholder (never the real URL, never the host/path/query/token — including a Pipedream-shaped URL whose secret lives in the subdomain); sibling config values (events, gateCommandTimeoutMs, docLint) round-trip verbatim; the unrelated writes project_update/project_configure also perform still land; the underlying STORED url survives every read AND every unrelated write (including the write-response echo on both routers); a project with no alertWebhook round-trips with no alertWebhook key on any of these tools; feeding a masked response's alertWebhook straight back into the Platform Lead's project_configure — whether from a project_get READ response (merge or replace:true) or from project_configure's own prior WRITE-response, on either router — is REJECTED outright with the real url intact, while a genuinely NEW url (not an echo) is still accepted; round 2's echo-guard fixes hold — a stored url that is already a fixed point of its own mask no longer blocks an unrelated write, a case/trailing-slash variant of the mask is still rejected by shape, and a genuinely new url still writes even on a project that was a fixed point; and the ordinary agent validator (setup's project_configure) still rejects orchestration.alertWebhook outright as a write, unchanged."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
