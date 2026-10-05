import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 8db0c289 (discovered from db1ceb7d, itself discovered from f021e26d): the agent-facing
// `permission.mode` schema (agentPermissionOverride, mcp/platform.ts) excluded only "bypassPermissions" —
// "default" and "plan" stayed agent-settable via the manager's project_update and the setup router's
// project_configure/project_update. Full narrative + role/escape table:
// docs/decisions/8db0c289-reject-default-plan-permission-mode-on-agent-config-write.md.
//
// THE MECHANISM (identical fallback f021e26d already proved for bypassPermissions):
// `withRolePermissionModeCyclesPin` (sessions/service.ts) pins a boot-cycle target to `auto` ONLY for
// worker/assistant. Every other role (manager/platform/setup/auditor/workspace-auditor/run) that reaches
// a fresh spawn with no resumeModeTarget and the typical startupModeCycles:0 falls straight through
// `computeBootMode` (pty/host.ts) to the raw STORED permission.mode as the real `--permission-mode` boot
// flag. A stored "default" boots as the CLI's "manual" (ask-every-non-preapproved-action) mode, with no
// escape, for every one of those unattended roles. A stored "plan" boots DIRECTLY into plan mode, which
// PERMANENTLY traps setup/auditor/workspace-auditor/run (all in LOOM_DRIVEN_ROLES — disallowedToolsForRole
// strips ExitPlanMode, their only tool-level escape, and none has a human at its live PTY to answer one
// either).
//
// Layers:
//   0. The boot-mode mechanism itself (hermetic, pure functions, no real claude/daemon): which
//      `--permission-mode` flag a stored "default"/"plan" produces, and which roles have no escape.
//   1. Schema/validator unit tests: agentPermissionOverride is now an ALLOWLIST (AGENT_PERMISSION_MODE_
//      ALLOWLIST, extracted from permissionOverride.shape.mode — only "acceptEdits" is agent-settable, so
//      a future enum addition starts FORBIDDEN by construction, not silently inherited as agent-settable
//      the way the round-1 denylist would have); the rejection carries a clear, human-authored message
//      (not zod's generic enum error); human validator is a CONTROL — unchanged, still accepts all four
//      modes; acceptEdits stays agent-settable and still boots unattended (the CONTROL that this isn't a
//      blanket break).
//   2. Real wiring: SessionService.updateProjectStructural (manager's project_update) rejects default/plan.
//   3. Real wiring: SetupMcpRouter's project_configure AND project_update reject default/plan.
//   4. Real wiring: PlatformMcpRouter's ELEVATED project_configure (full human-equivalent validator) also
//      rejects default/plan now (lead decision, Loom manager gen 401, card 8db0c289 — mirrors f021e26d's
//      bypassPermissions stance: the human REST/UI path stays the escape hatch; no owner Request backs
//      this ruling), while the human/REST validator itself keeps accepting them (CONTROL, unchanged).
//   5. A human-set stored "plan"/"default" mode SURVIVES an unrelated agent patch (memory.topK) through
//      all three agent-facing write paths — the merge never silently touches a field the patch didn't
//      name (round-2 Code Review addition — this previously rested on a single comment, not an assertion).
//   6. Card d8f5de04 (follow-up): a HUMAN-set stored "plan"/"default"/"bypassPermissions" mode must never
//      be changed or removed in EITHER direction (tighten or loosen) — not by an agent patch writing
//      permission.mode:"acceptEdits" over it (manager/setup/elevated Lead, all three write paths), not by
//      the elevated Lead's unset:["permission.mode"] or an ancestor unset:["permission"], and not by
//      replace:true omitting it. Every case REFUSES outright (never a silent reshape) naming the stored
//      mode. Negative/no-over-fire controls (round 2, Code Reviewer bf8988d7's follow-up review — a
//      mutated, over-firing guard condition had left the round-1 version of this layer fully green):
//      isHumanSetPermissionMode itself (undefined/"acceptEdits" are NOT human-set); a WRITE of acceptEdits
//      when the stored mode is ALREADY acceptEdits or absent still SUCCEEDS, on manager project_update AND
//      BOTH setup tools (project_configure + project_update); the elevated Lead's own
//      unset:["permission.mode"] and replace:true (omitting the key) BOTH still SUCCEED when the stored
//      mode is already acceptEdits or absent; and an unset of a sibling leaf (permission.allow, not an
//      ancestor of mode) still succeeds and leaves a human-set mode untouched.
//
// HERMETIC + CLAUDE-FREE + NETWORK-FREE: a real Db + SessionService/routers against a no-op fake pty, no
// real claude, no daemon, no real ~/.loom (a throwaway temp LOOM_HOME, removed at the end).
//
// Run: 1) build (turbo builds shared first), 2) node test/agent-permission-mode-default-plan-guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-apmdp-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { computeBootMode, disallowedToolsForRole } = await import("../dist/pty/host.js");
const { validateAgentProjectConfigOverride, validateProjectConfigOverride, PlatformMcpRouter, isHumanSetPermissionMode, humanSetPermissionModeRejectionMessage } = await import("../dist/mcp/platform.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

try {
  // ── LAYER 0: the boot-mode mechanism itself ─────────────────────────────────────────────────────────
  {
    // A fresh spawn with no resumeModeTarget and the typical startupModeCycles:0 — the ordinary case for
    // every role except worker/assistant (pinned to auto elsewhere, never reaching this fallback).
    check('computeBootMode: stored "default" (no target) boots as the real CLI\'s "manual" flag',
      computeBootMode({ mode: "default", startupModeCycles: 0 }, undefined) === "manual");
    check('computeBootMode: stored "plan" (no target) boots DIRECTLY as "plan"',
      computeBootMode({ mode: "plan", startupModeCycles: 0 }, undefined) === "plan");
    // NEGATIVE CONTROL for the boot-mode check above: a benign stored mode must NOT trip the same flag —
    // proves the two checks above actually discriminate rather than always returning a fixed value.
    check('computeBootMode: stored "acceptEdits" (no target) boots unattended, UNCHANGED — negative control',
      computeBootMode({ mode: "acceptEdits", startupModeCycles: 0 }, undefined) === "acceptEdits");

    // Roles that reach this fallback (NOT pinned by withRolePermissionModeCyclesPin) AND are in
    // LOOM_DRIVEN_ROLES (ExitPlanMode structurally disallowed, no human at the live PTY either) are
    // PERMANENTLY trapped by a direct `plan` boot — no escape. manager/platform keep ExitPlanMode.
    const trappedRoles = ["setup", "auditor", "workspace-auditor", "run"];
    const notTrappedRoles = ["manager", "platform"];
    for (const role of trappedRoles) {
      check(`disallowedToolsForRole("${role}"): ExitPlanMode is disallowed — no escape from a direct plan boot`,
        disallowedToolsForRole(role).includes("ExitPlanMode"));
    }
    for (const role of notTrappedRoles) {
      check(`disallowedToolsForRole("${role}"): ExitPlanMode is NOT disallowed — negative control (not trapped)`,
        !disallowedToolsForRole(role).includes("ExitPlanMode"));
    }
    // worker/assistant are themselves in LOOM_DRIVEN_ROLES (ExitPlanMode disallowed too) but are pinned to
    // `auto` by withRolePermissionModeCyclesPin and so never reach computeBootMode's fallback at all —
    // confirm the pin independently so this test doesn't silently rely on an assumption read elsewhere.
    const { withRolePermissionModeCyclesPin } = await import("../dist/sessions/service.js");
    for (const role of ["worker", "assistant"]) {
      const pinned = withRolePermissionModeCyclesPin({ mode: "plan", startupModeCycles: 0 }, role);
      check(`withRolePermissionModeCyclesPin("${role}"): pinned to auto regardless of stored mode/cycles`,
        pinned.startupModeCycles > 0);
    }
  }

  // ── LAYER 1: schema/validator unit tests ────────────────────────────────────────────────────────────
  {
    for (const mode of ["default", "plan"]) {
      const r = validateAgentProjectConfigOverride({ permission: { mode } });
      check(`agent validator REJECTS permission.mode:${mode}`, r.ok === false);
      check(`rejection names permission.mode (mode:${mode})`, r.ok === false && /permission\.mode/.test(r.error));
      // The rejection carries the CLEAR, human-authored message, never zod's generic enum error.
      check(`rejection has the clear human-only message (mode:${mode})`,
        r.ok === false && r.error === `permission.mode "${mode}" is human-only; agents may set only "acceptEdits"`);
      check(`rejection is NOT zod's generic enum error (mode:${mode})`,
        r.ok === false && !/Invalid (input|enum|option)/i.test(r.error));
    }
    // CONTROL: acceptEdits remains agent-settable, and still round-trips to the direct unattended boot
    // flag (ties LAYER 0's boot-mode fact to the schema so a future edit can't silently decouple them).
    const r = validateAgentProjectConfigOverride({ permission: { mode: "acceptEdits" } });
    check("agent validator CONTROL: still ACCEPTS permission.mode:acceptEdits",
      r.ok === true && r.value.permission?.mode === "acceptEdits");
    check("CONTROL: acceptEdits still boots unattended (ties schema to the LAYER 0 boot-mode fact)",
      r.ok === true && computeBootMode({ mode: r.value.permission.mode, startupModeCycles: 0 }, undefined) === "acceptEdits");
    // bypassPermissions stays rejected too (f021e26d, unchanged by this card).
    check("agent validator CONTROL: still REJECTS permission.mode:bypassPermissions (f021e26d, unchanged)",
      validateAgentProjectConfigOverride({ permission: { mode: "bypassPermissions" } }).ok === false);

    // CONTROL: the human/REST validator is UNCHANGED — still accepts default/plan (the deliberate
    // human-only path; a human setting these for a manager/platform-only project is legitimate).
    for (const mode of ["default", "plan"]) {
      const h = validateProjectConfigOverride({ permission: { mode } });
      check(`human validator CONTROL: still ACCEPTS permission.mode:${mode} (unchanged)`,
        h.ok === true && h.value.permission?.mode === mode);
    }
  }

  // ── LAYER 2: the REAL agent-facing wiring (manager's project_update) ────────────────────────────────
  {
    const now = new Date().toISOString();
    const db = new Db();
    db.insertProject({ id: "pPermDP", name: "PermDPProj", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });
    db.insertAgent({ id: "aPermDP", projectId: "pPermDP", name: "Mgr", startupPrompt: "do it", position: 0, profileId: null });
    db.insertSession({
      id: "MPermDP", projectId: "pPermDP", agentId: "aPermDP", engineSessionId: null, title: null, cwd: tmpHome,
      processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
      lastError: null, role: "manager", parentSessionId: null,
    });
    const pty = { enqueueStdin: () => ({ delivered: false }) };
    const svc = new SessionService(db, pty, new OrchestrationControl());

    for (const mode of ["default", "plan"]) {
      let threw = null;
      try {
        await svc.updateProjectStructural("MPermDP", "pPermDP", { config: { permission: { mode } } });
      } catch (e) { threw = e; }
      check(`project_update (manager): a permission.mode:${mode} patch is REJECTED end-to-end`, threw !== null);
      check(`project_update (manager): the rejection names permission.mode (mode:${mode})`,
        threw !== null && /permission\.mode/.test(String(threw.message ?? threw)));
    }
    check("project_update (manager): the stored config is UNCHANGED after both rejected attempts",
      db.getProject("pPermDP").config.permission?.mode === undefined);

    // CONTROL: a legitimate mode (acceptEdits) still lands.
    await svc.updateProjectStructural("MPermDP", "pPermDP", { config: { permission: { mode: "acceptEdits" } } });
    check("project_update (manager) CONTROL: a legitimate mode (acceptEdits) still lands",
      db.getProject("pPermDP").config.permission?.mode === "acceptEdits");
    db.close();
  }

  // ── LAYER 3: the REAL agent-facing wiring (setup's project_configure + project_update) ──────────────
  {
    const now = new Date().toISOString();
    const db = new Db();
    db.insertProject({ id: "pSetupDP", name: "SetupDPProj", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });
    const pty = { enqueueStdin: () => ({ delivered: false }) };
    const svc = new SessionService(db, pty, new OrchestrationControl());
    const router = new SetupMcpRouter(db, svc);
    const server = router.buildServer("SETUP");
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "agent-permission-mode-default-plan-guard-setup-test", version: "0" });
    await client.connect(clientT);
    const parse = (res) => JSON.parse(res.content[0].text);
    const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));

    for (const mode of ["default", "plan"]) {
      const cfgRes = await call("project_configure", { projectId: "pSetupDP", config: { permission: { mode } } });
      check(`setup project_configure: REJECTS permission.mode:${mode}`, typeof cfgRes.error === "string" && /permission\.mode/.test(cfgRes.error));
      const updRes = await call("project_update", { projectId: "pSetupDP", config: { permission: { mode } } });
      check(`setup project_update: REJECTS permission.mode:${mode}`, typeof updRes.error === "string" && /permission\.mode/.test(updRes.error));
    }
    check("setup: the stored config is UNCHANGED after all rejected attempts",
      db.getProject("pSetupDP").config.permission?.mode === undefined);

    // CONTROL: a legitimate mode (acceptEdits) still lands via project_configure.
    const cfgOk = await call("project_configure", { projectId: "pSetupDP", config: { permission: { mode: "acceptEdits" } } });
    check("setup project_configure CONTROL: a legitimate mode (acceptEdits) still lands",
      !cfgOk.error && db.getProject("pSetupDP").config.permission?.mode === "acceptEdits");
    db.close();
  }

  // ── LAYER 4: PlatformMcpRouter's ELEVATED project_configure ALSO rejects default/plan (8db0c289) ────
  {
    const now = new Date().toISOString();
    const db = new Db();
    db.insertProject({ id: "pLeadDP", name: "LeadDPProj", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });
    const pty = { enqueueStdin: () => ({ delivered: false }) };
    const svc = new SessionService(db, pty, new OrchestrationControl());
    const router = new PlatformMcpRouter(db, svc); // 2-arg: GitWriter falls back to its bounded module-const defaults
    const server = router.buildServer();
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "agent-permission-mode-default-plan-guard-platform-test", version: "0" });
    await client.connect(clientT);
    const parse = (res) => JSON.parse(res.content[0].text);
    const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));

    // CONTROL: the elevated route accepts an ordinary human-only field (gateCommand) — the full
    // validator is genuinely in play here, not a stand-in that would reject everything.
    const cfgOrdinary = await call("project_configure", { projectId: "pLeadDP", config: { orchestration: { gateCommand: "echo ok" } } });
    check("platform project_configure CONTROL: accepts gateCommand (full validator genuinely in play)", !cfgOrdinary.error);

    for (const mode of ["default", "plan"]) {
      const cfgRes = await call("project_configure", { projectId: "pLeadDP", config: { permission: { mode } } });
      check(`platform project_configure (Lead-elevated): REJECTS permission.mode:${mode}`,
        typeof cfgRes.error === "string" && new RegExp(mode).test(cfgRes.error));
      // Same wording as the agent schema's own rejection (minus the "invalid config: " prefix the caller
      // adds and this route's own REST/UI tail) — the two routes read the SAME allowlist + message fn.
      check(`platform project_configure (Lead-elevated): rejection wording MATCHES the agent schema's (mode:${mode})`,
        typeof cfgRes.error === "string"
        && cfgRes.error.includes(`permission.mode "${mode}" is human-only; agents may set only "acceptEdits"`));
    }
    check("platform project_configure (Lead-elevated): stored permission.mode is UNCHANGED after both rejections",
      db.getProject("pLeadDP").config.permission?.mode === undefined);

    // A legitimate mode (acceptEdits) still passes on the elevated route.
    const cfgOk = await call("project_configure", { projectId: "pLeadDP", config: { permission: { mode: "acceptEdits" } } });
    check("platform project_configure (Lead-elevated): still ACCEPTS a legitimate mode (acceptEdits)",
      !cfgOk.error && db.getProject("pLeadDP").config.permission?.mode === "acceptEdits");

    // CONTROL: the human/REST validator (the Settings UI's actual backing function) is UNTOUCHED — it
    // still accepts default/plan directly (the deliberate human-only escape valve, unchanged).
    for (const mode of ["default", "plan"]) {
      const humanR = validateProjectConfigOverride({ permission: { mode } });
      check(`human/REST validator CONTROL: still ACCEPTS permission.mode:${mode} directly (unchanged)`,
        humanR.ok === true && humanR.value.permission?.mode === mode);
    }

    db.close();
  }

  // ── LAYER 5: a human-set stored "plan"/"default" mode SURVIVES an unrelated agent patch ───────────
  // (round-2 Code Review addition, card 8db0c289 review) — a human can legitimately set either mode for
  // a manager/platform-only project via the REST/UI path; an agent's own, UNRELATED patch (memory.topK)
  // through any agent-facing write path must never silently touch it.
  {
    const now = new Date().toISOString();
    for (const seedMode of ["plan", "default"]) {
      // -- manager's project_update (SessionService.updateProjectStructural) --
      {
        const db = new Db();
        const pid = `pSurviveMgr-${seedMode}`;
        db.insertProject({ id: pid, name: pid, repoPath: tmpHome, vaultPath: tmpHome, config: { permission: { mode: seedMode } }, createdAt: now, archivedAt: null, reserved: false });
        db.insertAgent({ id: `aSurviveMgr-${seedMode}`, projectId: pid, name: "Mgr", startupPrompt: "do it", position: 0, profileId: null });
        db.insertSession({
          id: `mSurviveMgr-${seedMode}`, projectId: pid, agentId: `aSurviveMgr-${seedMode}`, engineSessionId: null, title: null, cwd: tmpHome,
          processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
          lastError: null, role: "manager", parentSessionId: null,
        });
        const pty = { enqueueStdin: () => ({ delivered: false }) };
        const svc = new SessionService(db, pty, new OrchestrationControl());
        let threw = null;
        try {
          await svc.updateProjectStructural(`mSurviveMgr-${seedMode}`, pid, { config: { memory: { topK: 7 } } });
        } catch (e) { threw = e; }
        check(`manager project_update: an unrelated memory.topK patch SUCCEEDS (seed mode:${seedMode})`, threw === null);
        const after = db.getProject(pid).config;
        check(`manager project_update: permission.mode:${seedMode} SURVIVES the unrelated patch`, after.permission?.mode === seedMode);
        check(`manager project_update: the unrelated patch's own field actually landed (mode:${seedMode})`, after.memory?.topK === 7);
        db.close();
      }

      // -- setup's project_configure --
      {
        const db = new Db();
        const pid = `pSurviveSetup-${seedMode}`;
        db.insertProject({ id: pid, name: pid, repoPath: tmpHome, vaultPath: tmpHome, config: { permission: { mode: seedMode } }, createdAt: now, archivedAt: null, reserved: false });
        const pty = { enqueueStdin: () => ({ delivered: false }) };
        const svc = new SessionService(db, pty, new OrchestrationControl());
        const router = new SetupMcpRouter(db, svc);
        const server = router.buildServer("SETUP");
        const [clientT, serverT] = InMemoryTransport.createLinkedPair();
        await server.connect(serverT);
        const client = new Client({ name: `apmdp-survive-setup-${seedMode}`, version: "0" });
        await client.connect(clientT);
        const parse = (res) => JSON.parse(res.content[0].text);
        const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));

        const res = await call("project_configure", { projectId: pid, config: { memory: { topK: 7 } } });
        check(`setup project_configure: an unrelated memory.topK patch SUCCEEDS (seed mode:${seedMode})`, !res.error);
        const after = db.getProject(pid).config;
        check(`setup project_configure: permission.mode:${seedMode} SURVIVES the unrelated patch`, after.permission?.mode === seedMode);
        check(`setup project_configure: the unrelated patch's own field actually landed (mode:${seedMode})`, after.memory?.topK === 7);
        db.close();
      }

      // -- the elevated Platform Lead's project_configure --
      {
        const db = new Db();
        const pid = `pSurviveLead-${seedMode}`;
        db.insertProject({ id: pid, name: pid, repoPath: tmpHome, vaultPath: tmpHome, config: { permission: { mode: seedMode } }, createdAt: now, archivedAt: null, reserved: false });
        const pty = { enqueueStdin: () => ({ delivered: false }) };
        const svc = new SessionService(db, pty, new OrchestrationControl());
        const router = new PlatformMcpRouter(db, svc);
        const server = router.buildServer();
        const [clientT, serverT] = InMemoryTransport.createLinkedPair();
        await server.connect(serverT);
        const client = new Client({ name: `apmdp-survive-lead-${seedMode}`, version: "0" });
        await client.connect(clientT);
        const parse = (res) => JSON.parse(res.content[0].text);
        const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));

        const res = await call("project_configure", { projectId: pid, config: { memory: { topK: 7 } } });
        check(`platform project_configure (Lead-elevated): an unrelated memory.topK patch SUCCEEDS (seed mode:${seedMode})`, !res.error);
        const after = db.getProject(pid).config;
        check(`platform project_configure (Lead-elevated): permission.mode:${seedMode} SURVIVES the unrelated patch`, after.permission?.mode === seedMode);
        check(`platform project_configure (Lead-elevated): the unrelated patch's own field actually landed (mode:${seedMode})`, after.memory?.topK === 7);
        db.close();
      }
    }
  }

  // ── LAYER 6: a HUMAN-set stored mode must never be CHANGED OR REMOVED, either direction (card d8f5de04) ──
  {
    // Unit: isHumanSetPermissionMode itself + the shared rejection message.
    for (const mode of ["default", "plan", "bypassPermissions"]) {
      check(`isHumanSetPermissionMode("${mode}") is true (human-set)`, isHumanSetPermissionMode(mode) === true);
    }
    check('isHumanSetPermissionMode(undefined) is false — negative control (no override is not human-set)',
      isHumanSetPermissionMode(undefined) === false);
    check('isHumanSetPermissionMode("acceptEdits") is false — negative control (agent-settable is not human-set)',
      isHumanSetPermissionMode("acceptEdits") === false);
    check("humanSetPermissionModeRejectionMessage names the stored mode and the human path",
      humanSetPermissionModeRejectionMessage("plan")
        === 'permission.mode is "plan" (human-set); agents may not change or remove it — use the REST config PATCH / Settings UI');

    for (const seedMode of ["plan", "default"]) {
      // -- manager's project_update: writing acceptEdits over a human-set mode is REFUSED --
      {
        const now = new Date().toISOString();
        const db = new Db();
        const pid = `pOverwriteMgr-${seedMode}`;
        db.insertProject({ id: pid, name: pid, repoPath: tmpHome, vaultPath: tmpHome, config: { permission: { mode: seedMode } }, createdAt: now, archivedAt: null, reserved: false });
        db.insertAgent({ id: `aOverwriteMgr-${seedMode}`, projectId: pid, name: "Mgr", startupPrompt: "do it", position: 0, profileId: null });
        db.insertSession({
          id: `mOverwriteMgr-${seedMode}`, projectId: pid, agentId: `aOverwriteMgr-${seedMode}`, engineSessionId: null, title: null, cwd: tmpHome,
          processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
          lastError: null, role: "manager", parentSessionId: null,
        });
        const pty = { enqueueStdin: () => ({ delivered: false }) };
        const svc = new SessionService(db, pty, new OrchestrationControl());
        let threw = null;
        try {
          await svc.updateProjectStructural(`mOverwriteMgr-${seedMode}`, pid, { config: { permission: { mode: "acceptEdits" } } });
        } catch (e) { threw = e; }
        check(`manager project_update: writing acceptEdits over a human-set "${seedMode}" is REFUSED`, threw !== null);
        check(`manager project_update: the refusal names the stored mode (mode:${seedMode})`,
          threw !== null && String(threw.message).includes(humanSetPermissionModeRejectionMessage(seedMode)));
        check(`manager project_update: stored permission.mode is UNCHANGED after the refused overwrite (mode:${seedMode})`,
          db.getProject(pid).config.permission?.mode === seedMode);
        db.close();
      }

      // -- setup's project_configure + project_update: same overwrite REFUSED --
      {
        const db = new Db();
        const pid = `pOverwriteSetup-${seedMode}`;
        db.insertProject({ id: pid, name: pid, repoPath: tmpHome, vaultPath: tmpHome, config: { permission: { mode: seedMode } }, createdAt: new Date().toISOString(), archivedAt: null, reserved: false });
        const pty = { enqueueStdin: () => ({ delivered: false }) };
        const svc = new SessionService(db, pty, new OrchestrationControl());
        const router = new SetupMcpRouter(db, svc);
        const server = router.buildServer("SETUP");
        const [clientT, serverT] = InMemoryTransport.createLinkedPair();
        await server.connect(serverT);
        const client = new Client({ name: `apmdp-overwrite-setup-${seedMode}`, version: "0" });
        await client.connect(clientT);
        const parse = (res) => JSON.parse(res.content[0].text);
        const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));

        const cfgRes = await call("project_configure", { projectId: pid, config: { permission: { mode: "acceptEdits" } } });
        check(`setup project_configure: writing acceptEdits over a human-set "${seedMode}" is REFUSED`,
          typeof cfgRes.error === "string" && cfgRes.error.includes(humanSetPermissionModeRejectionMessage(seedMode)));
        check(`setup project_configure: stored permission.mode is UNCHANGED after the refused overwrite (mode:${seedMode})`,
          db.getProject(pid).config.permission?.mode === seedMode);

        const updRes = await call("project_update", { projectId: pid, config: { permission: { mode: "acceptEdits" } } });
        check(`setup project_update: writing acceptEdits over a human-set "${seedMode}" is REFUSED`,
          typeof updRes.error === "string" && updRes.error.includes(humanSetPermissionModeRejectionMessage(seedMode)));
        check(`setup project_update: stored permission.mode is UNCHANGED after the refused overwrite (mode:${seedMode})`,
          db.getProject(pid).config.permission?.mode === seedMode);
        db.close();
      }

      // -- the elevated Platform Lead's project_configure: write / unset / unset-ancestor / replace-omit --
      {
        const db = new Db();
        const pid = `pOverwriteLead-${seedMode}`;
        db.insertProject({ id: pid, name: pid, repoPath: tmpHome, vaultPath: tmpHome, config: { permission: { mode: seedMode, allow: ["Read"] } }, createdAt: new Date().toISOString(), archivedAt: null, reserved: false });
        const pty = { enqueueStdin: () => ({ delivered: false }) };
        const svc = new SessionService(db, pty, new OrchestrationControl());
        const router = new PlatformMcpRouter(db, svc);
        const server = router.buildServer();
        const [clientT, serverT] = InMemoryTransport.createLinkedPair();
        await server.connect(serverT);
        const client = new Client({ name: `apmdp-overwrite-lead-${seedMode}`, version: "0" });
        await client.connect(clientT);
        const parse = (res) => JSON.parse(res.content[0].text);
        const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));

        const writeRes = await call("project_configure", { projectId: pid, config: { permission: { mode: "acceptEdits" } } });
        check(`platform project_configure (Lead-elevated): WRITING acceptEdits over a human-set "${seedMode}" is REFUSED`,
          typeof writeRes.error === "string" && writeRes.error.includes(humanSetPermissionModeRejectionMessage(seedMode)));

        const unsetExactRes = await call("project_configure", { projectId: pid, unset: ["permission.mode"] });
        check(`platform project_configure (Lead-elevated): UNSET of permission.mode over a human-set "${seedMode}" is REFUSED`,
          typeof unsetExactRes.error === "string" && unsetExactRes.error.includes(humanSetPermissionModeRejectionMessage(seedMode)));

        const unsetAncestorRes = await call("project_configure", { projectId: pid, unset: ["permission"] });
        check(`platform project_configure (Lead-elevated): UNSET of the ancestor "permission" over a human-set "${seedMode}" is REFUSED`,
          typeof unsetAncestorRes.error === "string" && unsetAncestorRes.error.includes(humanSetPermissionModeRejectionMessage(seedMode)));

        const replaceOmitRes = await call("project_configure", { projectId: pid, config: { memory: { topK: 3 } }, replace: true });
        check(`platform project_configure (Lead-elevated): REPLACE:true omitting permission.mode over a human-set "${seedMode}" is REFUSED`,
          typeof replaceOmitRes.error === "string" && replaceOmitRes.error.includes(humanSetPermissionModeRejectionMessage(seedMode)));

        check(`platform project_configure (Lead-elevated): stored permission.mode is UNCHANGED after all four refusals (mode:${seedMode})`,
          db.getProject(pid).config.permission?.mode === seedMode);

        // NEGATIVE CONTROL: unsetting a SIBLING leaf (permission.allow, not an ancestor of mode) is NOT
        // caught by the guard — proves unsetDropsConfigPath's ancestor/descendant logic, not a blanket
        // "unset touched permission at all" trip wire.
        const siblingUnsetRes = await call("project_configure", { projectId: pid, unset: ["permission.allow"] });
        check(`platform project_configure (Lead-elevated) CONTROL: unset of a SIBLING leaf (permission.allow) SUCCEEDS (mode:${seedMode})`,
          !siblingUnsetRes.error);
        check(`platform project_configure (Lead-elevated) CONTROL: permission.mode:${seedMode} SURVIVES the sibling unset`,
          db.getProject(pid).config.permission?.mode === seedMode);
        db.close();
      }
    }

    // CONTROL (requested by the reviewing manager): writing "acceptEdits" when the stored mode is ALREADY
    // "acceptEdits" (the no-op case) still SUCCEEDS on every surface — proves the guard discriminates on
    // the EXISTING value, not on "a write to permission.mode happened at all".
    {
      const now = new Date().toISOString();
      const db = new Db();
      const pid = "pNoopMgr";
      db.insertProject({ id: pid, name: pid, repoPath: tmpHome, vaultPath: tmpHome, config: { permission: { mode: "acceptEdits" } }, createdAt: now, archivedAt: null, reserved: false });
      db.insertAgent({ id: "aNoopMgr", projectId: pid, name: "Mgr", startupPrompt: "do it", position: 0, profileId: null });
      db.insertSession({
        id: "mNoopMgr", projectId: pid, agentId: "aNoopMgr", engineSessionId: null, title: null, cwd: tmpHome,
        processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
        lastError: null, role: "manager", parentSessionId: null,
      });
      const pty = { enqueueStdin: () => ({ delivered: false }) };
      const svc = new SessionService(db, pty, new OrchestrationControl());
      let threw = null;
      try {
        await svc.updateProjectStructural("mNoopMgr", pid, { config: { permission: { mode: "acceptEdits" } } });
      } catch (e) { threw = e; }
      check('manager project_update CONTROL: re-writing acceptEdits when ALREADY acceptEdits SUCCEEDS (no-op)', threw === null);
      check('manager project_update CONTROL: permission.mode stays acceptEdits', db.getProject(pid).config.permission?.mode === "acceptEdits");
      db.close();
    }
    {
      const db = new Db();
      const pidSetup = "pNoopSetup";
      db.insertProject({ id: pidSetup, name: pidSetup, repoPath: tmpHome, vaultPath: tmpHome, config: { permission: { mode: "acceptEdits" } }, createdAt: new Date().toISOString(), archivedAt: null, reserved: false });
      const pty = { enqueueStdin: () => ({ delivered: false }) };
      const svc = new SessionService(db, pty, new OrchestrationControl());
      const router = new SetupMcpRouter(db, svc);
      const server = router.buildServer("SETUP");
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await server.connect(serverT);
      const client = new Client({ name: "apmdp-noop-setup", version: "0" });
      await client.connect(clientT);
      const parse = (res) => JSON.parse(res.content[0].text);
      const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));
      const res = await call("project_configure", { projectId: pidSetup, config: { permission: { mode: "acceptEdits" } } });
      check('setup project_configure CONTROL: re-writing acceptEdits when ALREADY acceptEdits SUCCEEDS (no-op)', !res.error);
      check('setup project_configure CONTROL: permission.mode stays acceptEdits', db.getProject(pidSetup).config.permission?.mode === "acceptEdits");
      db.close();
    }
    {
      const db = new Db();
      const pidUnset = "pNoopUnset";
      db.insertProject({ id: pidUnset, name: pidUnset, repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: new Date().toISOString(), archivedAt: null, reserved: false });
      const pty = { enqueueStdin: () => ({ delivered: false }) };
      const svc = new SessionService(db, pty, new OrchestrationControl());
      const router = new SetupMcpRouter(db, svc);
      const server = router.buildServer("SETUP");
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await server.connect(serverT);
      const client = new Client({ name: "apmdp-noop-unset", version: "0" });
      await client.connect(clientT);
      const parse = (res) => JSON.parse(res.content[0].text);
      const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));
      const res = await call("project_configure", { projectId: pidUnset, config: { permission: { mode: "acceptEdits" } } });
      check('setup project_configure CONTROL: writing acceptEdits when the mode was previously UNSET (no override) SUCCEEDS', !res.error);
      check('setup project_configure CONTROL: permission.mode is now acceptEdits', db.getProject(pidUnset).config.permission?.mode === "acceptEdits");
      db.close();
    }

    // Same no-op/absent CONTROL for setup's project_update (the sibling tool — not covered above, only
    // project_configure was; Code Reviewer bf8988d7's follow-up review asked for this gap closed).
    {
      const db = new Db();
      const pidSetupUpdAcc = "pNoopSetupUpdAcc";
      db.insertProject({ id: pidSetupUpdAcc, name: pidSetupUpdAcc, repoPath: tmpHome, vaultPath: tmpHome, config: { permission: { mode: "acceptEdits" } }, createdAt: new Date().toISOString(), archivedAt: null, reserved: false });
      const pty = { enqueueStdin: () => ({ delivered: false }) };
      const svc = new SessionService(db, pty, new OrchestrationControl());
      const router = new SetupMcpRouter(db, svc);
      const server = router.buildServer("SETUP");
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await server.connect(serverT);
      const client = new Client({ name: "apmdp-noop-setup-update-acc", version: "0" });
      await client.connect(clientT);
      const parse = (res) => JSON.parse(res.content[0].text);
      const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));
      const res = await call("project_update", { projectId: pidSetupUpdAcc, config: { permission: { mode: "acceptEdits" } } });
      check('setup project_update CONTROL: re-writing acceptEdits when ALREADY acceptEdits SUCCEEDS (no-op)', !res.error);
      check('setup project_update CONTROL: permission.mode stays acceptEdits', db.getProject(pidSetupUpdAcc).config.permission?.mode === "acceptEdits");
      db.close();
    }
    {
      const db = new Db();
      const pidSetupUpdUnset = "pNoopSetupUpdUnset";
      db.insertProject({ id: pidSetupUpdUnset, name: pidSetupUpdUnset, repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: new Date().toISOString(), archivedAt: null, reserved: false });
      const pty = { enqueueStdin: () => ({ delivered: false }) };
      const svc = new SessionService(db, pty, new OrchestrationControl());
      const router = new SetupMcpRouter(db, svc);
      const server = router.buildServer("SETUP");
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await server.connect(serverT);
      const client = new Client({ name: "apmdp-noop-setup-update-unset", version: "0" });
      await client.connect(clientT);
      const parse = (res) => JSON.parse(res.content[0].text);
      const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));
      const res = await call("project_update", { projectId: pidSetupUpdUnset, config: { permission: { mode: "acceptEdits" } } });
      check('setup project_update CONTROL: writing acceptEdits when the mode was previously UNSET (no override) SUCCEEDS', !res.error);
      check('setup project_update CONTROL: permission.mode is now acceptEdits', db.getProject(pidSetupUpdUnset).config.permission?.mode === "acceptEdits");
      db.close();
    }

    // Lead project_configure CONTROLs (Code Reviewer bf8988d7's follow-up review: the earlier test never
    // exercised unset/replace SUCCEEDING — it showed a mutated, over-firing guard condition still passing
    // fully green). unset:["permission.mode"] and replace:true (omitting the key) must both SUCCEED when
    // the stored mode is NOT human-set — already "acceptEdits", or absent entirely — proving the guard is
    // keyed on the EXISTING stored value, not on "unset/replace touched permission.mode at all".
    for (const seedConfig of [{ permission: { mode: "acceptEdits" } }, {}]) {
      const seedLabel = seedConfig.permission ? "acceptEdits" : "absent";

      {
        const db = new Db();
        const pid = `pLeadUnsetOk-${seedLabel}`;
        db.insertProject({ id: pid, name: pid, repoPath: tmpHome, vaultPath: tmpHome, config: seedConfig, createdAt: new Date().toISOString(), archivedAt: null, reserved: false });
        const pty = { enqueueStdin: () => ({ delivered: false }) };
        const svc = new SessionService(db, pty, new OrchestrationControl());
        const router = new PlatformMcpRouter(db, svc);
        const server = router.buildServer();
        const [clientT, serverT] = InMemoryTransport.createLinkedPair();
        await server.connect(serverT);
        const client = new Client({ name: `apmdp-lead-unset-ok-${seedLabel}`, version: "0" });
        await client.connect(clientT);
        const parse = (res) => JSON.parse(res.content[0].text);
        const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));
        const res = await call("project_configure", { projectId: pid, unset: ["permission.mode"] });
        check(`platform project_configure (Lead-elevated) CONTROL: unset:["permission.mode"] SUCCEEDS when the stored mode is ${seedLabel} (not human-set)`, !res.error);
        db.close();
      }

      {
        const db = new Db();
        const pid = `pLeadReplaceOk-${seedLabel}`;
        db.insertProject({ id: pid, name: pid, repoPath: tmpHome, vaultPath: tmpHome, config: seedConfig, createdAt: new Date().toISOString(), archivedAt: null, reserved: false });
        const pty = { enqueueStdin: () => ({ delivered: false }) };
        const svc = new SessionService(db, pty, new OrchestrationControl());
        const router = new PlatformMcpRouter(db, svc);
        const server = router.buildServer();
        const [clientT, serverT] = InMemoryTransport.createLinkedPair();
        await server.connect(serverT);
        const client = new Client({ name: `apmdp-lead-replace-ok-${seedLabel}`, version: "0" });
        await client.connect(clientT);
        const parse = (res) => JSON.parse(res.content[0].text);
        const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));
        const res = await call("project_configure", { projectId: pid, config: { memory: { topK: 3 } }, replace: true });
        check(`platform project_configure (Lead-elevated) CONTROL: replace:true omitting permission.mode SUCCEEDS when the stored mode is ${seedLabel} (not human-set)`, !res.error);
        db.close();
      }
    }
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the agent config validator ALLOWLISTS permission.mode to \"acceptEdits\" only (rejecting "
    + "\"default\"/\"plan\" alongside the pre-existing bypassPermissions rejection, with a clear human-only "
    + "message instead of zod's generic enum error), on every agent-facing config-write surface (manager "
    + "project_update, setup project_configure/project_update) AND on the elevated Platform Lead "
    + "project_configure (lead decision, Loom manager gen 401, card 8db0c289 — mirrors f021e26d's "
    + "bypassPermissions stance; no owner Request backs this ruling), while the human/REST validator keeps "
    + "accepting both unchanged, acceptEdits stays agent-settable and still boots unattended, and a "
    + "human-set stored plan/default mode survives an unrelated agent patch on all three write paths. "
    + "(card d8f5de04) A human-set stored mode (incl. bypassPermissions) also can never be CHANGED OR "
    + "REMOVED in either direction, tighten or loosen, by an agent-facing write (even to the allowed "
    + "acceptEdits), the elevated Lead's unset (exact or ancestor), or replace:true omitting it — all "
    + "REFUSE outright naming the stored mode, while an already-acceptEdits/unset mode and a sibling-leaf "
    + "unset are unaffected on every surface, including the elevated Lead's own unset/replace:true."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
