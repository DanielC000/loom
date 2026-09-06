import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
// Card ac90ca8e (extended by 44fa586a) — closes the native-Read/Glob/Grep bypass of the MCP-mediated
// read gates (companion transcript_read: owner-turn + DM-scope + project-scope; auditor/workspace-auditor
// repo_read_*) by DENYING `assistant`, `auditor` and `workspace-auditor` role native Read/Glob/Grep access
// to the engine transcript root (`~/.claude/projects/**`) via a role-scoped `permissions.deny` entry.
//
// Card 3388be4d MOVED the actual union from `resolveAgentSpawn` (sessions/service.ts) to
// `withTranscriptRootDenyForSpawn` at the single `PtyHost.createPty` spawn chokepoint (pty/host.ts) —
// see that function's own doc for why (it fixes the agent-row-missing resume/fork fallback that used to
// drop the deny). This file's SeamHost captures `opts` BEFORE createPty runs (createSeamHost's fake
// createPty never calls the real one — see _seam-host-fixture.mjs), so `opts.permission.deny` alone no
// longer reflects the deny a real spawn would end up with; every assertion below instead feeds the
// captured `(opts.permission, opts.role)` through the REAL exported `withTranscriptRootDenyForSpawn` —
// the exact function the real (unfaked) createPty calls — via `finalDeny()`. This still proves the SAME
// thing end to end: SessionService threads the right `role`/`permission` for each fresh-spawn path, AND
// the chokepoint function turns that into the correct final `.deny`. See
// transcript-root-deny-chokepoint.mjs for a REAL (unfaked) createPty proof, and
// transcript-root-deny-spawn-paths.mjs for the other six spawn paths (resume/fork/recycle*/startRun),
// including the headline agent-row-missing regression this card exists to fix.
//
// The engine actually HONOURING a `Read(<glob>)`-shaped deny rule (kickoff bite-point 3) was verified
// SEPARATELY, live, against a real installed `claude` binary (headless `-p`, scrubbed CLAUDECODE env,
// a scratch project + scratch HOME) — not re-derived here: an unrestricted control read succeeded, an
// absolute-path read of a file under a `~/`-anchored denied directory was refused (blocked BEFORE the
// file was touched, confirmed by the model's own refusal text), and the identical deny rule ALSO
// blocked a Glob enumeration of the denied directory. See the worker_report for the full transcript.
// That live check ran in headless `-p` mode, NOT interactive `auto` — the rule is a `settings.json`
// permission entry and should be mode-independent, but that leg is inferred, not measured.
//
// PROVES:
//   1. An ASSISTANT/AUDITOR/WORKSPACE-AUDITOR-role spawn's permission.deny includes the role-scoped
//      entry — in a DEFAULT-config project AND in a project with its OWN CUSTOM permission.deny
//      (resolveConfig REPLACES deny wholesale for a custom override — config.ts:1589 — so this must be
//      a UNION at the spawn boundary, exactly like BASELINE_SESSION_ALLOW is for `allow`, or a project's
//      own deny config would silently strip this protection).
//   2. A custom project's OWN deny entry survives (union ADDS, never replaces).
//   3. Every OTHER role (worker, plain) gets permission.deny BYTE-IDENTICAL (same array reference) to
//      what resolveConfig alone would have produced — the role scoping is real, not a blanket add.
//   4. No duplicate entry when the config already carries the exact rule.
//
// Run: 1) build (turbo builds shared first), 2) node test/assistant-transcript-read-deny.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-assistdeny-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { PtyHost, withTranscriptRootDenyForSpawn } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { resolveConfig } = await import("@loom/shared");

// The REAL chokepoint function applied to a captured spawn's (permission, role) — this IS what the real
// (unfaked) createPty computes and writes into settings.json, since the SeamHost never calls it itself.
const finalDeny = (o) => withTranscriptRootDenyForSpawn(o?.permission, o?.role).deny;

const ROLE_DENY = "Read(~/.claude/projects/**)";
const CUSTOM_DENY = "Bash(rm -rf /:*)";

const now = new Date().toISOString();

// Two projects: DEFAULT config, and a CUSTOM one whose own permission.deny replaces the (empty) default.
const pDefault = "pDefault";
const pCustom = "pCustom";
const db = new Db();
db.insertProject({ id: pDefault, name: "Default", repoPath: pDefault, vaultPath: pDefault, config: {}, createdAt: now, archivedAt: null });
db.insertProject({ id: pCustom, name: "Custom-Deny", repoPath: pCustom, vaultPath: pCustom, config: { permission: { deny: [CUSTOM_DENY] } }, createdAt: now, archivedAt: null });

check("setup: default config resolves permission.deny to []", resolveConfig({}).permission.deny.length === 0);
check("setup: custom config's resolved permission.deny is EXACTLY the custom entry (replace, not union — the defect BASELINE_SESSION_ALLOW-style unioning must compensate for)",
  JSON.stringify(resolveConfig({ permission: { deny: [CUSTOM_DENY] } }).permission.deny) === JSON.stringify([CUSTOM_DENY]));

// A global "assistant"-role Profile and a "worker"-role Profile, bound into agents on both projects.
const assistantProfileId = randomUUID();
db.insertProfile({ id: assistantProfileId, name: "Companion", role: "assistant", description: "", allowDelta: [], skills: null, model: null, icon: null, browserTesting: false, documentConversion: false, restrictedTools: false, noCommit: false });
const workerProfileId = randomUUID();
db.insertProfile({ id: workerProfileId, name: "Dev", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null, browserTesting: false, documentConversion: false, restrictedTools: false, noCommit: false });

const agAssistantDefault = randomUUID();
db.insertAgent({ id: agAssistantDefault, projectId: pDefault, name: "Companion", startupPrompt: "", position: 0, profileId: assistantProfileId });
const agPlainDefault = randomUUID();
db.insertAgent({ id: agPlainDefault, projectId: pDefault, name: "Plain", startupPrompt: "P", position: 1, profileId: null });
const agWorkerDefault = randomUUID();
db.insertAgent({ id: agWorkerDefault, projectId: pDefault, name: "Dev", startupPrompt: "", position: 2, profileId: workerProfileId });

const agAssistantCustom = randomUUID();
db.insertAgent({ id: agAssistantCustom, projectId: pCustom, name: "Companion", startupPrompt: "", position: 0, profileId: assistantProfileId });
const agWorkerCustom = randomUUID();
db.insertAgent({ id: agWorkerCustom, projectId: pCustom, name: "Dev", startupPrompt: "", position: 1, profileId: workerProfileId });

// Auditor/workspace-auditor agents: no profile needed — startAuditor/startWorkspaceAuditor lock the
// role via an EXPLICIT caller role that always wins over any profile role (see their own doc comments).
const agAuditorDefault = randomUUID();
db.insertAgent({ id: agAuditorDefault, projectId: pDefault, name: "Auditor", startupPrompt: "", position: 3, profileId: null });
const agWorkspaceAuditorDefault = randomUUID();
db.insertAgent({ id: agWorkspaceAuditorDefault, projectId: pDefault, name: "Workspace Auditor", startupPrompt: "", position: 4, profileId: null });
const agAuditorCustom = randomUUID();
db.insertAgent({ id: agAuditorCustom, projectId: pCustom, name: "Auditor", startupPrompt: "", position: 2, profileId: null });
const agWorkspaceAuditorCustom = randomUUID();
db.insertAgent({ id: agWorkspaceAuditorCustom, projectId: pCustom, name: "Workspace Auditor", startupPrompt: "", position: 3, profileId: null });

class SeamHost extends createSeamHost(PtyHost) {
  constructor(events) { super(events); this.capture = []; }
  createPty(opts) {
    this.capture.push(opts);
    return { ...super.createPty(opts), pid: 1 };
  }
}
const events = { onEngineSessionId() {}, onBusy(id, b) { db.setBusy(id, b); }, onContextStats() {}, onRateLimited() {}, onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); } };
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());
const optsFor = (sid) => host.capture.find((o) => o.sessionId === sid);

try {
  // ============ (1) DEFAULT config: assistant gets the role-scoped deny; worker/plain do NOT ============
  const sAssistantDefault = svc.startNew(agAssistantDefault);
  const oAssistantDefault = optsFor(sAssistantDefault.id);
  check("(1) assistant spawn (default config) chokepoint deny INCLUDES the role-scoped transcript-root deny",
    finalDeny(oAssistantDefault).includes(ROLE_DENY));
  check("(1) assistant spawn (default config) chokepoint deny has exactly one entry (no duplication of the empty baseline)",
    finalDeny(oAssistantDefault).length === 1);

  const sPlainDefault = svc.startNew(agPlainDefault);
  const oPlainDefault = optsFor(sPlainDefault.id);
  const defaultDeny = resolveConfig({}).permission.deny;
  check("(3) plain spawn (default config) chokepoint deny is BYTE-IDENTICAL (same value) to the resolved config — no role-scoped entry leaked",
    JSON.stringify(finalDeny(oPlainDefault)) === JSON.stringify(defaultDeny));
  check("(3) plain spawn (default config) chokepoint deny does NOT include the role-scoped entry", !finalDeny(oPlainDefault).includes(ROLE_DENY));

  const sWorkerDefault = svc.startNew(agWorkerDefault);
  const oWorkerDefault = optsFor(sWorkerDefault.id);
  check("(3) worker spawn (default config) chokepoint deny does NOT include the role-scoped entry", !finalDeny(oWorkerDefault).includes(ROLE_DENY));
  check("(3) worker spawn (default config) chokepoint deny is BYTE-IDENTICAL (same value) to the resolved config",
    JSON.stringify(finalDeny(oWorkerDefault)) === JSON.stringify(defaultDeny));

  const sAuditorDefault = svc.startAuditor(agAuditorDefault);
  const oAuditorDefault = optsFor(sAuditorDefault.id);
  check("(1) auditor spawn (default config) chokepoint deny INCLUDES the role-scoped transcript-root deny",
    finalDeny(oAuditorDefault).includes(ROLE_DENY));
  check("(1) auditor spawn (default config) chokepoint deny has exactly one entry (no duplication of the empty baseline)",
    finalDeny(oAuditorDefault).length === 1);

  const sWorkspaceAuditorDefault = svc.startWorkspaceAuditor(agWorkspaceAuditorDefault);
  const oWorkspaceAuditorDefault = optsFor(sWorkspaceAuditorDefault.id);
  check("(1) workspace-auditor spawn (default config) chokepoint deny INCLUDES the role-scoped transcript-root deny",
    finalDeny(oWorkspaceAuditorDefault).includes(ROLE_DENY));
  check("(1) workspace-auditor spawn (default config) chokepoint deny has exactly one entry (no duplication of the empty baseline)",
    finalDeny(oWorkspaceAuditorDefault).length === 1);

  // ============ (2) CUSTOM-deny project: assistant gets BOTH the custom entry AND the role-scoped one ============
  const sAssistantCustom = svc.startNew(agAssistantCustom);
  const oAssistantCustom = optsFor(sAssistantCustom.id);
  check("(1)+(2) assistant spawn (custom-deny project) chokepoint deny INCLUDES the role-scoped transcript-root deny (union, not replaced by the project's own deny)",
    finalDeny(oAssistantCustom).includes(ROLE_DENY));
  check("(2) assistant spawn (custom-deny project) chokepoint deny KEEPS the project's own custom deny entry",
    finalDeny(oAssistantCustom).includes(CUSTOM_DENY));
  check("(2) assistant spawn (custom-deny project) chokepoint deny has exactly the two expected entries, no more",
    finalDeny(oAssistantCustom).length === 2);

  // Worker in the SAME custom-deny project: proves the union is ROLE-scoped, not project-scoped — a
  // non-assistant role in a project with its own deny gets ONLY that project's deny, unmodified.
  const sWorkerCustom = svc.startNew(agWorkerCustom);
  const oWorkerCustom = optsFor(sWorkerCustom.id);
  check("(3) worker spawn (custom-deny project) chokepoint deny is BYTE-IDENTICAL to the project's own resolved deny (no role-scoped entry)",
    JSON.stringify(finalDeny(oWorkerCustom)) === JSON.stringify([CUSTOM_DENY]));
  check("(3) worker spawn (custom-deny project) chokepoint deny does NOT include the role-scoped entry", !finalDeny(oWorkerCustom).includes(ROLE_DENY));

  const sAuditorCustom = svc.startAuditor(agAuditorCustom);
  const oAuditorCustom = optsFor(sAuditorCustom.id);
  check("(1)+(2) auditor spawn (custom-deny project) chokepoint deny INCLUDES the role-scoped transcript-root deny (union, not replaced by the project's own deny)",
    finalDeny(oAuditorCustom).includes(ROLE_DENY));
  check("(2) auditor spawn (custom-deny project) chokepoint deny KEEPS the project's own custom deny entry",
    finalDeny(oAuditorCustom).includes(CUSTOM_DENY));
  check("(2) auditor spawn (custom-deny project) chokepoint deny has exactly the two expected entries, no more",
    finalDeny(oAuditorCustom).length === 2);

  const sWorkspaceAuditorCustom = svc.startWorkspaceAuditor(agWorkspaceAuditorCustom);
  const oWorkspaceAuditorCustom = optsFor(sWorkspaceAuditorCustom.id);
  check("(1)+(2) workspace-auditor spawn (custom-deny project) chokepoint deny INCLUDES the role-scoped transcript-root deny (union, not replaced by the project's own deny)",
    finalDeny(oWorkspaceAuditorCustom).includes(ROLE_DENY));
  check("(2) workspace-auditor spawn (custom-deny project) chokepoint deny KEEPS the project's own custom deny entry",
    finalDeny(oWorkspaceAuditorCustom).includes(CUSTOM_DENY));
  check("(2) workspace-auditor spawn (custom-deny project) chokepoint deny has exactly the two expected entries, no more",
    finalDeny(oWorkspaceAuditorCustom).length === 2);

  // ============ (4) Idempotency: a project whose OWN deny already carries the exact rule gets no duplicate ============
  const pAlready = "pAlready";
  db.insertProject({ id: pAlready, name: "Already-Has-It", repoPath: pAlready, vaultPath: pAlready, config: { permission: { deny: [ROLE_DENY] } }, createdAt: now, archivedAt: null });
  const agAssistantAlready = randomUUID();
  db.insertAgent({ id: agAssistantAlready, projectId: pAlready, name: "Companion", startupPrompt: "", position: 0, profileId: assistantProfileId });
  const sAssistantAlready = svc.startNew(agAssistantAlready);
  const oAssistantAlready = optsFor(sAssistantAlready.id);
  check("(4) assistant spawn whose project ALREADY carries the exact rule gets no duplicate (exactly one entry)",
    finalDeny(oAssistantAlready).filter((t) => t === ROLE_DENY).length === 1);

  const agAuditorAlready = randomUUID();
  db.insertAgent({ id: agAuditorAlready, projectId: pAlready, name: "Auditor", startupPrompt: "", position: 1, profileId: null });
  const sAuditorAlready = svc.startAuditor(agAuditorAlready);
  const oAuditorAlready = optsFor(sAuditorAlready.id);
  check("(4) auditor spawn whose project ALREADY carries the exact rule gets no duplicate (exactly one entry)",
    finalDeny(oAuditorAlready).filter((t) => t === ROLE_DENY).length === 1);

  const agWorkspaceAuditorAlready = randomUUID();
  db.insertAgent({ id: agWorkspaceAuditorAlready, projectId: pAlready, name: "Workspace Auditor", startupPrompt: "", position: 2, profileId: null });
  const sWorkspaceAuditorAlready = svc.startWorkspaceAuditor(agWorkspaceAuditorAlready);
  const oWorkspaceAuditorAlready = optsFor(sWorkspaceAuditorAlready.id);
  check("(4) workspace-auditor spawn whose project ALREADY carries the exact rule gets no duplicate (exactly one entry)",
    finalDeny(oWorkspaceAuditorAlready).filter((t) => t === ROLE_DENY).length === 1);
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the assistant/auditor/workspace-auditor roles' permission.deny gets the transcript-root Read deny UNIONED in (surviving a project's own custom deny, no duplicates), and every other role's permission.deny stays byte-identical to what resolveConfig alone produces."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
