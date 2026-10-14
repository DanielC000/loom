import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Companion "lead mode" (Option B, no guardrails — owner decision `b5c606aa`, 2026-07-20; card `4af746ae`).
// BACKEND CORE: `sessions.companion_lead_mode` short-circuits `resolveCompanionGrant` (companion/
// capabilities.ts) to a SYNTHESIZED full act-scope over EVERY live project (`listAllProjects()`, read
// LIVE), superseding — never mutating — this session's own `companion_capability_grants` rows. Reuses
// 100% of the existing lever framework (registration gating, Primitive A/B/C, friction tiers, trust
// windows); lead mode changes SCOPE only. Fully hermetic: a REAL Db on a temp file + the REAL
// OrchestrationMcpRouter over an in-memory MCP transport, a REAL SessionService for the session-steer
// round-trip (mirrors companion-session-control.mjs), and a REAL AttentionPushWatcher for the wildcard
// alert-class expansion. NO network, NO real claude, NO daemon.
//
// Covers the card's DoD:
//   (a) lead mode ON, ZERO grant rows → full act-scope across N projects, INCLUDING one created AFTER
//       enabling (listAllProjects() is read LIVE on every call, never cached).
//   (b) lead mode OFF is byte-identical to today: zero grants ⇒ null, exactly as pre-card.
//   (c) toggling lead mode back OFF reverts to the pre-existing grant rows, which were NEVER mutated by
//       having been superseded.
//   (d) session-steer under lead mode reaches an INFRASTRUCTURE-role session (platform/operator/setup) —
//       NO role exclusion (Option B, "session-steer reaches EVERY session incl. infrastructure").
//   (e) NO MCP path can set `companion_lead_mode` — grep-provable (exactly two source call sites: the
//       db.ts setter's own definition + the gateway/server.ts REST handler, nothing under mcp/**), plus a
//       live tool-listing assertion that no tool name on the full lead-mode surface resembles a lead-mode
//       write.
// Plus: per-capability config synthesis (decisions-relay gets all 3 DECISION_CLASSES; media-out gets
// {roots:[vaultPath]} bounded to the project's own vault, {} when the project has none; attention-push's
// "*" wildcard sentinel expands, via a real AttentionPushWatcher tick, to every class EXCEPT
// FLEET_OPS_ALERT_CLASSES — owner ruling 2026-07-21 (request d024eda7): routine fleet-ops noise
// (merge-gate/worker-blocked/worker-crashed/manager-idle) is excluded from the lead-mode PUSH feed by
// default, owner-signal classes still push, and the exclusion is wildcard-only — an explicit,
// non-lead-mode grant naming a fleet-ops class is never filtered); every hasActGrant-gated lever registers
// (all 17 companion tools) with zero grant rows; a minimal test-double `db` (no listAllProjects) degrades
// to "no grant" rather than throwing.
// Run: 1) build (turbo builds shared first), 2) node test/companion-lead-mode.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { mkdtempManaged } from "./_tmp-fixture.mjs";
import { stripComments } from "./_strip-comments.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import).
// UNCONDITIONAL (card fab07aba Code Review, reviewer 96bb7127): this file is now a
// CHANGED_TS_TEXT_SCANNER_REPO_PATHS member, run bare via `node <path>` on a reduced merge gate — which
// inherits the daemon's own ambient env with no scrub (gate-runner.ts spreads process.env). The prior
// `useOwnLoomHome()` only mints a temp dir when LOOM_HOME is UNSET — correct for every OTHER consumer of
// that helper, which all run THROUGH the test:daemon harness (a fresh LOOM_HOME already set per file
// before the child ever starts, per docs/decisions/dd4349ff-…), but WRONG here: on a bare-node reduced-
// gate run with an inherited, non-default LOOM_HOME it silently wrote into that inherited dir and left
// files behind (requireHermeticEnv only rejects the REAL default ~/.loom, not "inherited-vs-self-minted"
// — see that function's own doc). mkdtempManaged() (unlike the conditional helper) always creates a
// fresh, atomic, kernel-unique dir and registers it for guaranteed cleanup — matching the unconditional
// pattern every OTHER CHANGED_TS_TEXT_SCANNER_REPO_PATHS sibling already uses (decisions-for-tool.mjs,
// operator-surface.mjs, skill-edit.mjs), just via the shared managed-tempdir primitive instead of each
// hand-rolling its own path. ---
const tmpHome = mkdtempManaged("loom-companion-lead-mode-");
process.env.LOOM_HOME = tmpHome;
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { resolveCompanionGrant, isCompanionLeadModeEnabled, DECISION_CLASSES, COMPANION_CAPABILITY_SLUGS } = await import("../dist/companion/capabilities.js");
const { AttentionPushWatcher, ATTENTION_ALERT_CLASSES, FLEET_OPS_ALERT_CLASSES } = await import("../dist/companion/attention-push.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

async function connect(server) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "companion-lead-mode-test", version: "0" });
  await client.connect(clientT);
  return client;
}
const listOf = async (server) => { const c = await connect(server); const names = (await c.listTools()).tools.map((t) => t.name); await c.close(); return names; };
const call = async (client, name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

const now = new Date().toISOString();
function seedProject(db, id, name) {
  db.insertProject({ id, name, repoPath: id, vaultPath: id, config: {}, createdAt: now, archivedAt: null });
}
function seedSession(db, id, projectId, role, opts = {}) {
  const agentId = `a-${id}`;
  db.insertAgent({ id: agentId, projectId, name: role ?? "t", startupPrompt: "", position: 0 });
  db.insertSession({
    id, projectId, agentId, engineSessionId: opts.engineSessionId ?? `eng-${id}`, title: null,
    cwd: opts.cwd ?? os.tmpdir(), processState: "live", resumability: "resumable", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role: role ?? null,
  });
}
const tmpDb = () => new Db(path.join(tmpHome, `${randomUUID()}.db`));

try {
  // ============ (a) lead mode ON, ZERO grant rows → full scope across N projects + one created AFTER ============
  {
    const db = tmpDb();
    const projA = `pa-${randomUUID()}`, projB = `pb-${randomUUID()}`;
    seedProject(db, projA, "A"); seedProject(db, projB, "B");
    const sess = `cs-${randomUUID()}`;
    seedSession(db, sess, projA, "assistant");

    check("lead mode OFF by default on a fresh session", isCompanionLeadModeEnabled(db, sess) === false);
    check("(b) OFF + zero grants ⇒ null, byte-identical to pre-card behavior",
      resolveCompanionGrant(db, sess, "session-status") === null);

    db.setCompanionLeadMode(sess, true);
    check("setCompanionLeadMode persists + is read LIVE", isCompanionLeadModeEnabled(db, sess) === true);

    const scope = resolveCompanionGrant(db, sess, "session-status");
    check("(a) lead mode ON, zero grants ⇒ a non-null synthesized scope", scope !== null);
    check("(a) scope covers every live project (A + B)", scope.projectIds.has(projA) && scope.projectIds.has(projB) && scope.projectIds.size === 2);
    check("(a) every project resolves mode:'act'", scope.modeFor(projA) === "act" && scope.mayAct(projA) === true && scope.mayAct(projB) === true);

    // A project created AFTER lead mode was already enabled — listAllProjects() is read LIVE, so it must
    // appear on the VERY NEXT resolveCompanionGrant call with no extra plumbing.
    const projC = `pc-${randomUUID()}`;
    seedProject(db, projC, "C (created after enabling)");
    const scope2 = resolveCompanionGrant(db, sess, "session-status");
    check("(a) a project created AFTER enabling is included on the next read", scope2.projectIds.has(projC) && scope2.mayAct(projC) === true);

    // ============ (c) an EXISTING grant row is SUPERSEDED, never mutated ============
    db.upsertCompanionCapabilityGrant({ sessionId: sess, capability: "session-status", projectId: projA, mode: "read", config: {} });
    const scopeSuperseded = resolveCompanionGrant(db, sess, "session-status");
    check("(c) lead mode ON supersedes an existing READ grant — project A resolves 'act', not 'read'",
      scopeSuperseded.mayAct(projA) === true);
    check("(c) lead mode ON still covers B/C too (the row only ever named A)", scopeSuperseded.projectIds.has(projB) && scopeSuperseded.projectIds.has(projC));

    db.setCompanionLeadMode(sess, false);
    const scopeReverted = resolveCompanionGrant(db, sess, "session-status");
    check("(c) toggling OFF reverts to the UNTOUCHED grant row: only project A, mode 'read'",
      scopeReverted !== null && scopeReverted.projectIds.size === 1 && scopeReverted.projectIds.has(projA) && scopeReverted.mayAct(projA) === false);
    check("(c) the row itself was never mutated by having been superseded",
      db.getCompanionCapabilityGrant(sess, "session-status", projA).mode === "read");

    db.close();
  }

  // ============ Per-capability config synthesis ============
  {
    const db = tmpDb();
    const proj = `p-${randomUUID()}`;
    seedProject(db, proj, "Proj");
    const sess = `cs-${randomUUID()}`;
    seedSession(db, sess, proj, "assistant");
    db.setCompanionLeadMode(sess, true);

    const decisionsScope = resolveCompanionGrant(db, sess, "decisions-relay");
    const decisionsCfg = decisionsScope.configFor(proj);
    check("decisions-relay: synthesized decisionClasses covers all 3 DECISION_CLASSES",
      Array.isArray(decisionsCfg.decisionClasses) && DECISION_CLASSES.every((c) => decisionsCfg.decisionClasses.includes(c)) && decisionsCfg.decisionClasses.length === DECISION_CLASSES.length);

    const mediaScope = resolveCompanionGrant(db, sess, "media-out");
    check("media-out: synthesized roots default to the project's OWN vaultPath",
      JSON.stringify(mediaScope.configFor(proj).roots) === JSON.stringify([proj] /* vaultPath was seeded === id */));

    // A project with NO vaultPath ⇒ {} (no safe host-wide wildcard — media-out's own tool degrades gracefully).
    const projNoVault = `pnv-${randomUUID()}`;
    db.insertProject({ id: projNoVault, name: "No Vault", repoPath: projNoVault, vaultPath: "", config: {}, createdAt: now, archivedAt: null });
    const mediaScope2 = resolveCompanionGrant(db, sess, "media-out");
    check("media-out: a project with no vaultPath gets {} config (no roots), not a crash",
      mediaScope2.configFor(projNoVault).roots === undefined);

    const sessionSteerScope = resolveCompanionGrant(db, sess, "session-steer");
    check("session-steer: synthesized config has no roleFilter (absent config ⇒ no exclusion, matching Option B)",
      sessionSteerScope.configFor(proj).roleFilter === undefined);

    // git-push (card a3c3ade8) is DELIBERATELY left conservative under lead mode, mirroring board-reach's
    // own authoredContent posture (see synthesizeLeadModeScope's doc: config synthesis only widens where a
    // lever actually reads one — git-push isn't one of them) — lead mode's maximal-control/no-guardrails
    // Option B still leaves targets EMPTY (nothing committable) and authoredContent OFF (verbatim
    // required), never auto-widening the never-grantable floor even for a lead-mode session.
    const gitPushScope = resolveCompanionGrant(db, sess, "git-push");
    check("git-push: synthesized config has NO targets (absent ⇒ nothing committable, even under lead mode)",
      gitPushScope.configFor(proj).targets === undefined);
    check("git-push: synthesized config has NO authoredContent (absent ⇒ verbatim still required, even under lead mode)",
      gitPushScope.configFor(proj).authoredContent === undefined);

    db.close();
  }

  // ============ Registration: every hasActGrant-gated lever registers with ZERO grant rows ============
  {
    const db = tmpDb();
    const proj = `p-${randomUUID()}`;
    seedProject(db, proj, "Proj");
    const sess = `cs-${randomUUID()}`;
    seedSession(db, sess, proj, "assistant");
    db.setCompanionLeadMode(sess, true);

    const orch = new OrchestrationMcpRouter(db, {});
    const tools = await listOf(orch.buildServer(sess, "assistant"));
    const expectedActTools = [
      "sessions_status", "decisions_list", "decision_resolve",
      "board_list", "board_get", "board_create", "board_update", "authored_content_grant", "board_relocate",
      "vault_lookup", "send_media",
      "session_message", "session_steer", "session_stop", "session_resume",
      "transcript_read", "session_spawn", "git_commit", "git_push",
    ];
    for (const name of expectedActTools) {
      check(`lead mode registers "${name}" with zero grant rows`, tools.includes(name));
    }
    check(`(sanity) all ${COMPANION_CAPABILITY_SLUGS.length} catalog capability slugs resolve non-null under lead mode`,
      COMPANION_CAPABILITY_SLUGS.every((slug) => resolveCompanionGrant(db, sess, slug) !== null));

    db.close();
  }

  // ============ (d) session-steer reaches an INFRASTRUCTURE-role session — no exclusion ============
  {
    const db = tmpDb();
    const proj = `p-${randomUUID()}`;
    seedProject(db, proj, "Proj");
    const sess = `cs-${randomUUID()}`;
    seedSession(db, sess, proj, "assistant");
    db.setCompanionLeadMode(sess, true);

    // Infrastructure-role targets — platform/operator/setup, exactly the roles Option B refused to exclude.
    const platformSess = `plat-${randomUUID()}`;
    seedSession(db, platformSess, proj, "platform");
    const operatorSess = `op-${randomUUID()}`;
    seedSession(db, operatorSess, proj, "operator");
    const setupSess = `setup-${randomUUID()}`;
    seedSession(db, setupSess, proj, "setup");

    class PtyStub {
      constructor() { this.q = new Map(); this.live = new Set(); this.busy = new Set(); this.ownerText = "steer the platform session"; }
      getActiveTurnOwnerText() { return this.ownerText; }
      getActiveTurnOrigin() { return null; }
      getActiveTurnSenderId() { return null; }
      enqueueStdin(id, text) { if (!this.live.has(id)) return { delivered: false, reason: "session-dead" }; return { delivered: true }; }
      flushPending() { return []; }
      interruptForRedirect() {}
      getPending() { return []; }
      isAlive(id) { return this.live.has(id); }
      stop(id) { this.live.delete(id); }
      spawn(opts) { this.live.add(opts.sessionId); }
    }
    const pty = new PtyStub();
    pty.live.add(sess); pty.live.add(platformSess); pty.live.add(operatorSess); pty.live.add(setupSess);
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const orch = new OrchestrationMcpRouter(db, sessions, {}, pty);
    const client = await connect(orch.buildServer(sess, "assistant"));

    for (const [label, targetId] of [["platform", platformSess], ["operator", operatorSess], ["setup", setupSess]]) {
      const res = await call(client, "session_message", { target: targetId, message: "hello from lead mode" });
      check(`(d) session_message reaches the ${label} infrastructure session — no role exclusion`, !res.error && res.deliveryStatus === "delivered-live");
    }
    await client.close();
    db.close();
  }

  // ============ (e) NO MCP path can set companion_lead_mode ============
  {
    // grep-provable: the setter is called from EXACTLY the db.ts definition + the gateway/server.ts REST
    // handler — nothing under mcp/** (or companion/**'s own lever registrations) ever calls it.
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const srcDir = path.join(__dirname, "..", "src");
    const offenders = [];
    function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith(".ts")) continue;
        // Card 36afbbdd: comment-stripped before matching — an absence check (any non-exempt file matching
        // is an offender), so a comment merely mentioning setCompanionLeadMode( (e.g. explaining why a
        // router does NOT call it) would otherwise flip a comment-only diff into a false offender.
        const text = stripComments(fs.readFileSync(full, "utf8"));
        if (!text.includes("setCompanionLeadMode(")) continue;
        const rel = path.relative(srcDir, full).replace(/\\/g, "/");
        if (rel === "db.ts" || rel === "gateway/server.ts") continue; // the two expected sites
        offenders.push(rel);
      }
    }
    walk(srcDir);
    check("(e) grep: setCompanionLeadMode is called ONLY from db.ts's own definition + gateway/server.ts's REST handler",
      offenders.length === 0);

    // (e-control, card 36afbbdd) NEGATIVE: a comment-only mention in a non-exempt file no longer flips it.
    // POSITIVE: the identical text as REAL code still does.
    {
      const commentOnly = "// this router intentionally does not call setCompanionLeadMode(\n";
      check("(e-control) NEGATIVE: comment-only mention is gone after stripping",
        !stripComments(commentOnly).includes("setCompanionLeadMode("));
      const realViolation = "export function bad() { setCompanionLeadMode(true); }\n";
      check("(e-control) POSITIVE: the same text as REAL code still trips the check after stripping",
        stripComments(realViolation).includes("setCompanionLeadMode("));
    }

    // Belt-and-suspenders: no tool name on the full lead-mode MCP surface (any router) resembles a
    // lead-mode write — the agent-facing surface is read/act-scoped, never self-elevating.
    const db = tmpDb();
    const proj = `p-${randomUUID()}`;
    seedProject(db, proj, "Proj");
    const sess = `cs-${randomUUID()}`;
    seedSession(db, sess, proj, "assistant");
    db.setCompanionLeadMode(sess, true);
    const orch = new OrchestrationMcpRouter(db, {});
    const tools = await listOf(orch.buildServer(sess, "assistant"));
    check("(e) no MCP tool name on the lead-mode surface mentions lead-mode/leadMode",
      !tools.some((n) => /lead.?mode/i.test(n)));
    db.close();
  }

  // ============ Minimal test-double db (no listAllProjects) degrades safely, never throws ============
  {
    const minimalDb = { getSession: () => ({ companionLeadMode: true, projectId: "p1" }) };
    let threw = false;
    let result;
    try { result = resolveCompanionGrant(minimalDb, "sess", "session-status"); } catch { threw = true; }
    check("a minimal test-double db (no listAllProjects) never throws under lead mode", !threw);
    check("...and degrades to null (no grant), exactly like the pre-existing listCompanionCapabilityGrantsForSession tolerance", result === null);
  }

  // ============ attention-push wildcard: "*" expands to OWNER-SIGNAL classes only (owner ruling 2026-07-21,
  //     request d024eda7) — FLEET_OPS_ALERT_CLASSES (merge-gate/worker-blocked/worker-crashed/manager-idle)
  //     are EXCLUDED from the lead-mode PUSH feed by default; the remaining owner-signal classes still push. ============
  {
    const db = tmpDb();
    const projA = `pa-${randomUUID()}`, projB = `pb-${randomUUID()}`;
    seedProject(db, projA, "A"); seedProject(db, projB, "B");
    const sess = `cs-${randomUUID()}`;
    seedSession(db, sess, projA, "assistant");
    const mgrA = `mgr-a-${randomUUID()}`; seedSession(db, mgrA, projA, "manager");
    const mgrB = `mgr-b-${randomUUID()}`; seedSession(db, mgrB, projB, "manager");
    db.setCompanionLeadMode(sess, true);

    const enqueued = [];
    const pty = {
      isAlive: () => true,
      enqueueStdin: (id, text) => { enqueued.push({ id, text }); return { delivered: true }; },
      getPending: () => [],
    };
    const watcher = new AttentionPushWatcher({ db, pty, sessionId: sess });
    watcher.start(); watcher.stop(); // seed watermark past any backlog

    // Card 68f27faf, owner ruling: "notice" is ALSO excluded from the wildcard, same as the 4 fleet-ops
    // classes, but it is deliberately NOT a member of FLEET_OPS_ALERT_CLASSES (the semantics differ — see
    // resolveConfig's own doc) — so this test must subtract it separately rather than via that set, the
    // same way production code does, or a future ATTENTION_ALERT_CLASSES addition could silently pass
    // this test by accident.
    const ownerSignalClasses = ATTENTION_ALERT_CLASSES.filter((c) => !FLEET_OPS_ALERT_CLASSES.has(c) && c !== "notice");
    check("sanity: FLEET_OPS_ALERT_CLASSES is the expected 4-class denylist",
      [...FLEET_OPS_ALERT_CLASSES].sort().join(",") === ["manager-idle", "merge-gate", "worker-blocked", "worker-crashed"].sort().join(","));
    check("sanity: the remaining owner-signal classes are the other 4 (excluding 'notice', wildcard-excluded on its own)",
      ownerSignalClasses.sort().join(",") === ["context-overflow", "decision-pending", "escalation", "usage-limit"].sort().join(","));

    // One event per alert class, across BOTH projects (proving cross-project reach too), each mapped via
    // attention-push.ts's own classify() so this test never hand-derives the class↔kind mapping itself.
    db.appendEvent({ id: randomUUID(), ts: new Date().toISOString(), managerSessionId: mgrA, kind: "merge_rejected", detail: {} }); // merge-gate (fleet-ops)
    db.appendEvent({ id: randomUUID(), ts: new Date().toISOString(), managerSessionId: mgrB, kind: "worker_stuck", detail: {} }); // worker-blocked (fleet-ops)
    db.appendEvent({ id: randomUUID(), ts: new Date().toISOString(), managerSessionId: mgrA, kind: "worker_exited_without_report", detail: {} }); // worker-crashed (fleet-ops)
    db.appendEvent({ id: randomUUID(), ts: new Date().toISOString(), managerSessionId: mgrB, kind: "question_asked", detail: { title: "t" } }); // decision-pending (owner-signal)
    db.appendEvent({ id: randomUUID(), ts: new Date().toISOString(), managerSessionId: mgrA, kind: "idle_escalated", detail: {} }); // manager-idle (fleet-ops)
    db.appendEvent({ id: randomUUID(), ts: new Date().toISOString(), managerSessionId: mgrB, kind: "context_escalated", detail: {} }); // context-overflow (owner-signal)
    db.appendEvent({ id: randomUUID(), ts: new Date().toISOString(), managerSessionId: mgrA, kind: "platform_escalate", detail: { title: "t" } }); // escalation (owner-signal)
    db.appendEvent({ id: randomUUID(), ts: new Date().toISOString(), managerSessionId: mgrB, kind: "session_rate_limited", detail: {} }); // usage-limit (owner-signal)
    // Card 68f27faf DoD: a notice fired under the SAME lead-mode wildcard must NOT push — this is the one
    // event this test seeds that is deliberately NOT counted in ownerSignalClasses above.
    db.appendEvent({ id: randomUUID(), ts: new Date().toISOString(), managerSessionId: mgrA, kind: "question_asked", detail: { title: "a notice", type: "notice" } }); // notice (wildcard-excluded)

    watcher.tick(new Date());
    check(`attention-push wildcard: only the ${ownerSignalClasses.length} owner-signal classes pushed (fleet-ops + notice excluded by default)`,
      enqueued.length === ownerSignalClasses.length);
    const pushedText = enqueued.map((e) => e.text).join("\n");
    check("attention-push wildcard: none of the 3 rendered fleet-ops lines leaked through",
      !/merge rejected|worker stuck|worker exited without report/.test(pushedText));
    check("attention-push wildcard: manager-idle (idle_escalated) also excluded — 'manager asleep' never rendered",
      !/manager asleep/.test(pushedText));
    check("attention-push wildcard: a lead-mode companion that has NOT explicitly opted in never gets the notice (no FYI line rendered)",
      !/FYI/.test(pushedText));
    check("attention-push wildcard: the owner-signal lines DID render (decision needed / context overflow / escalated to platform / usage limit)",
      /decision needed/.test(pushedText) && /context overflow/.test(pushedText) && /escalated to platform/.test(pushedText) && /usage limit/.test(pushedText));

    db.close();
  }

  // ============ card 68f27faf DoD: an explicit per-grant alertClasses:["notice"] on a NON-lead-mode
  //     companion still pushes a notice — lead mode's own wildcard exclusion above never reaches a
  //     companion the owner explicitly opted in on its own (non-synthesized) grant. ============
  {
    const db = tmpDb();
    const proj = `pn-${randomUUID()}`;
    seedProject(db, proj, "Notice");
    const sess = `cs-notice-${randomUUID()}`;
    seedSession(db, sess, proj, "assistant");
    const mgr = `mgr-notice-${randomUUID()}`; seedSession(db, mgr, proj, "manager");
    // NO lead mode here — an ordinary, human-written grant explicitly naming "notice".
    db.upsertCompanionCapabilityGrant({ sessionId: sess, capability: "attention-push", projectId: proj, mode: "read", config: { alertClasses: ["notice"] } });

    const enqueued = [];
    const pty = { isAlive: () => true, enqueueStdin: (id, text) => { enqueued.push({ id, text }); return { delivered: true }; }, getPending: () => [] };
    const watcher = new AttentionPushWatcher({ db, pty, sessionId: sess });
    watcher.start(); watcher.stop();

    db.appendEvent({ id: randomUUID(), ts: new Date().toISOString(), managerSessionId: mgr, kind: "question_asked", detail: { title: "deploy finished", type: "notice" } }); // notice
    watcher.tick(new Date());
    check("explicit per-grant alertClasses:['notice'] DOES push a notice — the opt-in works outside lead mode",
      enqueued.length === 1 && /FYI/.test(enqueued[0].text) && /deploy finished/.test(enqueued[0].text));

    // Each push is deduped — a second tick with nothing new must not re-fire (same discipline every other
    // alert class already proves in companion-attention-push.mjs; asserted here too since it's this card's
    // own named DoD test, not just inherited coverage).
    const pushedCount = enqueued.length;
    watcher.tick(new Date());
    check("notice push is deduped — a 2nd tick with nothing new does not re-fire", enqueued.length === pushedCount);

    db.close();
  }

  // ============ card 68f27faf round 2 (CR a7a2464e, B2): drive a REAL notice end-to-end through the
  //     ACTUAL question_ask MCP tool (never a hand-fired event) — proving the filing-site stamp
  //     (`type: question.type` on the question_asked event, mcp/orchestration.ts) is what actually keeps
  //     a lead-mode watcher from pushing it, not just that classify()/resolveConfig agree with each other
  //     in isolation. A control "decision" ask on the SAME manager still pushes, so a false-negative
  //     "nothing pushes at all" can never masquerade as this test passing. ============
  {
    const db = tmpDb();
    const proj = `pe2e-${randomUUID()}`;
    seedProject(db, proj, "E2E");
    const sess = `cs-e2e-${randomUUID()}`;
    seedSession(db, sess, proj, "assistant");
    const mgr = `mgr-e2e-${randomUUID()}`; seedSession(db, mgr, proj, "manager");
    db.setCompanionLeadMode(sess, true);

    const enqueued = [];
    const pty = { isAlive: () => true, enqueueStdin: (id, text) => { enqueued.push({ id, text }); return { delivered: true }; }, getPending: () => [] };
    const watcher = new AttentionPushWatcher({ db, pty, sessionId: sess });
    watcher.start(); watcher.stop();

    const orch = new OrchestrationMcpRouter(db, {});
    const client = await connect(orch.buildServer(mgr, "manager"));
    const noticeRes = await call(client, "question_ask", { type: "notice", title: "deploy finished", body: "all good" });
    check("(e2e) question_ask(type:'notice') succeeds", typeof noticeRes.questionId === "string");
    const decisionRes = await call(client, "question_ask", { type: "decision", title: "pick a plan", body: "A or B", options: ["A", "B"] });
    check("(e2e) question_ask(type:'decision') succeeds (control)", typeof decisionRes.questionId === "string");
    await client.close();

    // THE filing-site stamp itself, on the REAL event (not hand-built) — this is what B2 asks for directly.
    const filedEvents = db.listEvents(mgr).filter((e) => e.kind === "question_asked");
    check("(e2e) the notice's REAL question_asked event carries detail.type === 'notice'",
      filedEvents.some((e) => e.detail?.questionId === noticeRes.questionId && e.detail?.type === "notice"));
    check("(e2e) the decision's REAL question_asked event carries detail.type === 'decision' (control)",
      filedEvents.some((e) => e.detail?.questionId === decisionRes.questionId && e.detail?.type === "decision"));

    watcher.tick(new Date());
    const pushedText2 = enqueued.map((e) => e.text).join("\n");
    const decisionNeededCount = (pushedText2.match(/decision needed/g) ?? []).length;
    check("(e2e) the lead-mode wildcard did NOT push the real notice — no FYI line", !/FYI/.test(pushedText2));
    // The discriminating assertion: if the filing-site stamp were ever dropped, the notice would fall back
    // to "decision-pending" and ALSO render "decision needed" — so this reads 2, not 1, exactly on that
    // regression (reverting the one `type: question.type` line reproduces this RED).
    check("(e2e) EXACTLY ONE 'decision needed' line pushed — the control decision, never the notice too",
      decisionNeededCount === 1);

    db.close();
  }

  // ============ the fleet-ops exclusion is WILDCARD-ONLY — an explicit (non-lead-mode) alertClasses config
  //     that NAMES a fleet-ops class still gets it pushed; the owner's own deliberate config is never
  //     touched by the lead-mode-only denylist. ============
  {
    const db = tmpDb();
    const proj = `pe-${randomUUID()}`;
    seedProject(db, proj, "Explicit");
    const sess = `cs-explicit-${randomUUID()}`;
    seedSession(db, sess, proj, "assistant");
    const mgr = `mgr-explicit-${randomUUID()}`; seedSession(db, mgr, proj, "manager");
    // NO lead mode here — an ordinary, human-written grant explicitly naming a fleet-ops class.
    db.upsertCompanionCapabilityGrant({ sessionId: sess, capability: "attention-push", projectId: proj, mode: "read", config: { alertClasses: ["merge-gate"] } });

    const enqueued = [];
    const pty = { isAlive: () => true, enqueueStdin: (id, text) => { enqueued.push({ id, text }); return { delivered: true }; }, getPending: () => [] };
    const watcher = new AttentionPushWatcher({ db, pty, sessionId: sess });
    watcher.start(); watcher.stop();

    db.appendEvent({ id: randomUUID(), ts: new Date().toISOString(), managerSessionId: mgr, kind: "merge_rejected", detail: {} }); // merge-gate
    watcher.tick(new Date());
    check("explicit (non-wildcard) config naming a fleet-ops class is NEVER filtered — the denylist is wildcard-only",
      enqueued.length === 1 && /merge rejected/.test(enqueued[0].text));

    db.close();
  }

  console.log(failures === 0
    ? "\n✅ ALL PASS — Companion lead mode: full act-scope over every live project (incl. one created after enabling), supersedes without mutating existing grants, reverts cleanly on toggle-off, session-steer reaches infrastructure sessions with no exclusion, no MCP write path exists, and every lever/config synthesizes correctly."
    : `\n❌ ${failures} FAILURE(S).`);
  process.exit(failures === 0 ? 0 : 1);
} catch (err) {
  console.error(err);
  process.exit(1);
}
