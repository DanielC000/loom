import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card f021e26d — reject bypassPermissions, deny-list removal, and invalid pty geometry in agent project
// config. Full narrative + Do-nots: docs/decisions/f021e26d-reject-bypasspermissions-deny-removal-
// invalid-pty-geometry.md.
//
// Before this fix, validateAgentProjectConfigOverride (mcp/platform.ts) accepted
// {permission:{mode:"bypassPermissions",deny:[]}} and {pty:{cols:0,rows:-5}} — arrays REPLACE on merge,
// so an agent patch could WIPE a human-set deny list, and bypassPermissions contradicts the
// worker_set_mode boundary (service.ts's WORKER_SETTABLE_MODES, @decision 610abe29) by letting an agent
// set a PROJECT'S OWN stored boot mode to the one value that disables the sandbox outright.
//
// Layers:
//   1. Schema/validator unit tests: agentPermissionOverride excludes bypassPermissions (human validator
//      is a CONTROL — unchanged); ptyOverride bounds cols/rows on BOTH validators; mergeConfigOverride's
//      new additiveOnlyPermissionDenyGuard (deny UNIONS, never shrinks; allow is unaffected; OFF stays
//      plain replace, unchanged for the human-equivalent Lead/REST path).
//   2. Real wiring: SessionService.updateProjectStructural (the manager's project_update tool) rejects
//      bypassPermissions + invalid pty geometry, and blocks a deny-removal attempt, end-to-end.
//   3. Real wiring: SetupMcpRouter's project_configure AND project_update (both agent-facing routers)
//      reject bypassPermissions and block deny-removal, via a real MCP client call.
//   4. Real wiring: PlatformMcpRouter's ELEVATED project_configure (full human-equivalent validator,
//      gateCommand/alertWebhook settable) STILL rejects bypassPermissions — the Lead is "human-driven but
//      still an agent" — while the human/REST validator (validateProjectConfigOverride) keeps accepting
//      it unchanged (the deliberate human-only escape valve, via the REST PATCH / Settings UI).
//
// HERMETIC + CLAUDE-FREE + NETWORK-FREE: a real Db + SessionService/routers against a no-op fake pty, no
// real claude, no daemon.
//
// Run: 1) build (turbo builds shared first), 2) node test/agent-config-permission-pty-guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-apg-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { validateAgentProjectConfigOverride, validateProjectConfigOverride, mergeConfigOverride, PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

try {
  // ── LAYER 1: schema/validator unit tests ────────────────────────────────────────────────────────────
  {
    // -- permission.mode: bypassPermissions --
    const agentBypass = validateAgentProjectConfigOverride({ permission: { mode: "bypassPermissions" } });
    check("agent validator REJECTS permission.mode:bypassPermissions", agentBypass.ok === false);
    check("rejection names permission.mode", agentBypass.ok === false && /permission\.mode/.test(agentBypass.error));
    for (const mode of ["default", "acceptEdits", "plan"]) {
      const r = validateAgentProjectConfigOverride({ permission: { mode } });
      check(`agent validator still ACCEPTS permission.mode:${mode}`, r.ok === true && r.value.permission?.mode === mode);
    }
    // CONTROL: the human/REST validator is UNCHANGED — still accepts bypassPermissions (the deliberate
    // human-only escape valve, via the REST PATCH / Settings UI).
    const humanBypass = validateProjectConfigOverride({ permission: { mode: "bypassPermissions" } });
    check("human validator CONTROL: still ACCEPTS permission.mode:bypassPermissions (unchanged)",
      humanBypass.ok === true && humanBypass.value.permission?.mode === "bypassPermissions");
    // Surgical narrowing, not a blanket break: an override without permission.mode still parses, and
    // permission.deny/allow (no mode) are still accepted on the agent path too.
    check("agent validator: an override without permission at all still accepted", validateAgentProjectConfigOverride({ docLint: false }).ok === true);
    const agentDeny = validateAgentProjectConfigOverride({ permission: { deny: ["Bash(rm -rf:*)"] } });
    check("agent validator: permission.deny (no mode) still accepted", agentDeny.ok === true && agentDeny.value.permission?.deny?.[0] === "Bash(rm -rf:*)");

    // -- pty geometry bounds --
    const badGeometries = [
      { cols: 0, rows: 40 }, { cols: 120, rows: -5 }, { cols: -1, rows: -1 },
      { cols: 1.5, rows: 40 }, { cols: 120, rows: 2001 }, { cols: Number.NaN, rows: 40 },
    ];
    for (const pty of badGeometries) {
      const a = validateAgentProjectConfigOverride({ pty });
      check(`agent validator REJECTS invalid pty geometry ${JSON.stringify(pty)}`, a.ok === false);
      const h = validateProjectConfigOverride({ pty });
      check(`human validator REJECTS invalid pty geometry too (not just agent-gated) ${JSON.stringify(pty)}`, h.ok === false);
    }
    const goodPty = { cols: 120, rows: 40 };
    const a = validateAgentProjectConfigOverride({ pty: goodPty });
    check("agent validator ACCEPTS a sane pty geometry", a.ok === true && a.value.pty?.cols === 120 && a.value.pty?.rows === 40);
    const h = validateProjectConfigOverride({ pty: goodPty });
    check("human validator ACCEPTS a sane pty geometry too", h.ok === true && h.value.pty?.cols === 120 && h.value.pty?.rows === 40);
    // Boundary values (1 and the 2000 ceiling) are accepted, not off-by-one rejected.
    check("agent validator ACCEPTS the exact boundary values (1 and 2000)",
      validateAgentProjectConfigOverride({ pty: { cols: 1, rows: 2000 } }).ok === true);

    // -- mergeConfigOverride additiveOnlyPermissionDenyGuard --
    const existing = { permission: { deny: ["Bash(rm -rf:*)", "Bash(curl:*)"], allow: ["Bash(git status:*)"] } };
    const dropAttempt = { permission: { deny: ["Bash(curl:*)"] } }; // drops "Bash(rm -rf:*)"
    const guarded = mergeConfigOverride(existing, dropAttempt, { additiveOnlyPermissionDenyGuard: true });
    check("deny guard ON: a dropped deny entry SURVIVES the patch", guarded.permission.deny.includes("Bash(rm -rf:*)"));
    check("deny guard ON: the patch's own entry is present too", guarded.permission.deny.includes("Bash(curl:*)"));
    check("deny guard ON: result is the union, exactly 2 entries (deduped)", guarded.permission.deny.length === 2);

    const addAttempt = { permission: { deny: ["Bash(curl:*)", "Bash(wget:*)"] } };
    const grown = mergeConfigOverride(existing, addAttempt, { additiveOnlyPermissionDenyGuard: true });
    check("deny guard ON: a NEW deny entry (wget) is appended", grown.permission.deny.includes("Bash(wget:*)"));
    check("deny guard ON: a legitimate add grows to 3 entries", grown.permission.deny.length === 3);

    // allow is unaffected by the guard (plain replace either way — an agent widening its OWN allowlist
    // is not the same escalation as an agent narrowing a human's deny list).
    const allowReplace = mergeConfigOverride(existing, { permission: { allow: ["Bash(ls:*)"] } }, { additiveOnlyPermissionDenyGuard: true });
    check("deny guard ON: permission.allow is UNAFFECTED (plain replace, not additive)",
      allowReplace.permission.allow.length === 1 && allowReplace.permission.allow[0] === "Bash(ls:*)");

    // Guard OFF (default, omitted) — plain symmetric replace, UNCHANGED from before this card: the
    // human-equivalent Lead project_configure path and the REST PATCH path must still be able to shrink
    // the list (a deliberate owner-directed retirement of a deny entry).
    const symmetricReplace = mergeConfigOverride(existing, dropAttempt);
    check("deny guard OFF (default): a patch CAN remove a deny entry (plain array replace, human path)",
      symmetricReplace.permission.deny.length === 1 && symmetricReplace.permission.deny[0] === "Bash(curl:*)");

    // A patch that never touches permission.deny at all — guard is a no-op, deny stays byte-identical.
    const untouched = mergeConfigOverride(existing, { kanbanColumns: [] }, { additiveOnlyPermissionDenyGuard: true });
    check("deny guard ON: a patch that never touches permission.deny leaves it untouched",
      untouched.permission.deny.join(",") === existing.permission.deny.join(","));

    // A patch that sets permission.mode but omits deny — guard only engages for a field the patch names.
    const modeOnlyPatch = mergeConfigOverride(existing, { permission: { mode: "plan" } }, { additiveOnlyPermissionDenyGuard: true });
    check("deny guard ON: a patch that sets permission.mode but not deny leaves deny untouched",
      modeOnlyPatch.permission.deny.join(",") === existing.permission.deny.join(","));

    // First-ever write (no existing deny at all) — guard is a no-op; the whole patch lands.
    const firstWrite = mergeConfigOverride({}, { permission: { deny: ["Bash(rm:*)"] } }, { additiveOnlyPermissionDenyGuard: true });
    check("deny guard ON: first-ever write (no existing state) lands the whole patch", firstWrite.permission.deny.join(",") === "Bash(rm:*)");
  }

  // ── LAYER 2: the REAL agent-facing wiring (manager's project_update) ────────────────────────────────
  {
    const now = new Date().toISOString();
    const db = new Db();
    const seededConfig = { permission: { deny: ["Bash(rm -rf:*)", "Bash(curl:*)"] } };
    db.insertProject({ id: "pPerm", name: "PermProj", repoPath: tmpHome, vaultPath: tmpHome, config: seededConfig, createdAt: now, archivedAt: null, reserved: false });
    db.insertAgent({ id: "aPerm", projectId: "pPerm", name: "Mgr", startupPrompt: "do it", position: 0, profileId: null });
    db.insertSession({
      id: "MPerm", projectId: "pPerm", agentId: "aPerm", engineSessionId: null, title: null, cwd: tmpHome,
      processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
      lastError: null, role: "manager", parentSessionId: null,
    });
    const pty = { enqueueStdin: () => ({ delivered: false }) };
    const svc = new SessionService(db, pty, new OrchestrationControl());

    // bypassPermissions is REJECTED (throws) end-to-end — stored config untouched.
    let threw = null;
    try {
      await svc.updateProjectStructural("MPerm", "pPerm", { config: { permission: { mode: "bypassPermissions" } } });
    } catch (e) { threw = e; }
    check("project_update (manager): a permission.mode:bypassPermissions patch is REJECTED end-to-end", threw !== null);
    check("project_update (manager): the rejection names permission.mode", threw !== null && /permission\.mode/.test(String(threw.message ?? threw)));
    check("project_update (manager): the stored config is UNCHANGED after the rejected attempt", db.getProject("pPerm").config.permission.mode === undefined);

    // a deny-removal attempt is BLOCKED end-to-end (additive-only merge).
    await svc.updateProjectStructural("MPerm", "pPerm", { config: { permission: { deny: ["Bash(curl:*)"] } } });
    const after = db.getProject("pPerm").config;
    check("project_update (manager): a deny-removal attempt is BLOCKED end-to-end — Bash(rm -rf:*) survives", after.permission.deny.includes("Bash(rm -rf:*)"));
    check("project_update (manager): the patch's own entry is still present too", after.permission.deny.includes("Bash(curl:*)"));

    // legitimate growth still works.
    await svc.updateProjectStructural("MPerm", "pPerm", { config: { permission: { deny: ["Bash(curl:*)", "Bash(wget:*)"] } } });
    const after2 = db.getProject("pPerm").config;
    check("project_update (manager): the SAME manager can freely ADD a new deny entry", after2.permission.deny.includes("Bash(wget:*)"));

    // an invalid pty geometry patch is rejected too.
    let threwPty = null;
    try { await svc.updateProjectStructural("MPerm", "pPerm", { config: { pty: { cols: 0, rows: -5 } } }); } catch (e) { threwPty = e; }
    check("project_update (manager): an invalid pty geometry patch is REJECTED end-to-end", threwPty !== null);
    db.close();
  }

  // ── LAYER 3: the REAL agent-facing wiring (setup's project_configure + project_update) ──────────────
  {
    const now = new Date().toISOString();
    const db = new Db();
    const seededConfig = { permission: { deny: ["Bash(rm -rf:*)", "Bash(curl:*)"] } };
    db.insertProject({ id: "pSetup", name: "SetupProj", repoPath: tmpHome, vaultPath: tmpHome, config: seededConfig, createdAt: now, archivedAt: null, reserved: false });
    const pty = { enqueueStdin: () => ({ delivered: false }) };
    const svc = new SessionService(db, pty, new OrchestrationControl());
    const router = new SetupMcpRouter(db, svc);
    const server = router.buildServer("SETUP");
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "agent-config-permission-pty-guard-setup-test", version: "0" });
    await client.connect(clientT);
    const parse = (res) => JSON.parse(res.content[0].text);
    const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));

    // project_configure: bypassPermissions is REJECTED (error field), stored config unchanged.
    const cfgBypass = await call("project_configure", { projectId: "pSetup", config: { permission: { mode: "bypassPermissions" } } });
    check("setup project_configure: REJECTS permission.mode:bypassPermissions", typeof cfgBypass.error === "string" && /permission\.mode/.test(cfgBypass.error));
    check("setup project_configure: stored config is UNCHANGED after the rejected attempt", db.getProject("pSetup").config.permission.mode === undefined);

    // project_configure: a deny-removal attempt is BLOCKED (additive-only merge).
    const cfgDenyDrop = await call("project_configure", { projectId: "pSetup", config: { permission: { deny: ["Bash(curl:*)"] } } });
    check("setup project_configure: no error on a legitimate (if narrowing) deny patch", !cfgDenyDrop.error);
    const afterCfg = db.getProject("pSetup").config;
    check("setup project_configure: a deny-removal attempt is BLOCKED end-to-end — Bash(rm -rf:*) survives", afterCfg.permission.deny.includes("Bash(rm -rf:*)"));

    // project_configure: invalid pty geometry REJECTED.
    const cfgPty = await call("project_configure", { projectId: "pSetup", config: { pty: { cols: 0, rows: -5 } } });
    check("setup project_configure: REJECTS invalid pty geometry", typeof cfgPty.error === "string");

    // project_update (setup's structural-edit tool): bypassPermissions REJECTED.
    const updBypass = await call("project_update", { projectId: "pSetup", config: { permission: { mode: "bypassPermissions" } } });
    check("setup project_update: REJECTS permission.mode:bypassPermissions", typeof updBypass.error === "string" && /permission\.mode/.test(updBypass.error));

    // project_update: a deny-removal attempt is BLOCKED (additive-only merge) — reseed first so this
    // assertion is independent of LAYER 3's earlier project_configure deny-narrowing call above.
    db.updateProject("pSetup", {}); // no-op touch; config write below goes through setProjectConfigSafe directly
    const beforeUpd = db.getProject("pSetup").config.permission.deny.slice();
    const updDenyDrop = await call("project_update", { projectId: "pSetup", config: { permission: { deny: [] } } });
    check("setup project_update: no error on a legitimate (if narrowing) deny patch", !updDenyDrop.error);
    const afterUpd = db.getProject("pSetup").config;
    check("setup project_update: a deny-WIPE attempt (deny:[]) is BLOCKED end-to-end — every prior entry survives",
      beforeUpd.every((d) => afterUpd.permission.deny.includes(d)));

    db.close();
  }

  // ── LAYER 4: PlatformMcpRouter's ELEVATED project_configure STILL rejects bypassPermissions ─────────
  {
    const now = new Date().toISOString();
    const db = new Db();
    db.insertProject({ id: "pLead", name: "LeadProj", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });
    const pty = { enqueueStdin: () => ({ delivered: false }) };
    const svc = new SessionService(db, pty, new OrchestrationControl());
    const router = new PlatformMcpRouter(db, svc); // 2-arg: GitWriter falls back to its bounded module-const defaults
    const server = router.buildServer();
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "agent-config-permission-pty-guard-platform-test", version: "0" });
    await client.connect(clientT);
    const parse = (res) => JSON.parse(res.content[0].text);
    const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));

    // CONTROL: the elevated route accepts an ordinary human-only field (gateCommand) — the full
    // validator is genuinely in play here, not a stand-in that would reject everything.
    const cfgOrdinary = await call("project_configure", { projectId: "pLead", config: { orchestration: { gateCommand: "echo ok" } } });
    check("platform project_configure CONTROL: accepts gateCommand (full validator genuinely in play)", !cfgOrdinary.error);

    // The Lead is "human-driven but still an agent" (card f021e26d ruling) — bypassPermissions is
    // rejected on THIS elevated route too, even though its schema (validateProjectConfigOverride) would
    // otherwise accept it.
    const cfgBypass = await call("project_configure", { projectId: "pLead", config: { permission: { mode: "bypassPermissions" } } });
    check("platform project_configure (Lead-elevated): REJECTS permission.mode:bypassPermissions", typeof cfgBypass.error === "string" && /bypassPermissions/.test(cfgBypass.error));
    check("platform project_configure (Lead-elevated): stored config is UNCHANGED after the rejected attempt", db.getProject("pLead").config.permission?.mode === undefined);

    // A legitimate mode (acceptEdits) still passes on the elevated route.
    const cfgOk = await call("project_configure", { projectId: "pLead", config: { permission: { mode: "acceptEdits" } } });
    check("platform project_configure (Lead-elevated): still ACCEPTS a legitimate mode (acceptEdits)", !cfgOk.error && db.getProject("pLead").config.permission?.mode === "acceptEdits");

    // CONTROL: the human/REST validator (the Settings UI's actual backing function) is UNTOUCHED — it
    // still accepts bypassPermissions directly (the deliberate human-only escape valve).
    const humanBypass = validateProjectConfigOverride({ permission: { mode: "bypassPermissions" } });
    check("human/REST validator CONTROL: still ACCEPTS permission.mode:bypassPermissions directly (unchanged)",
      humanBypass.ok === true && humanBypass.value.permission?.mode === "bypassPermissions");

    db.close();
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the agent config validator rejects permission.mode:bypassPermissions (human validator "
    + "unchanged), bounds pty cols/rows to sane positive integers on both validators, and "
    + "additiveOnlyPermissionDenyGuard makes permission.deny union-only on mergeConfigOverride; all three "
    + "are wired end-to-end on every agent-facing config-write surface (manager project_update, setup "
    + "project_configure/project_update) AND on the elevated Platform Lead project_configure (which "
    + "otherwise shares the full human validator), while the human/REST validator keeps accepting "
    + "bypassPermissions unchanged."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
