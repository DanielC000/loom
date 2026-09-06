import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
// Card ac90ca8e — closes the native-Read/Glob/Grep bypass of the companion's own attested read gates
// (transcript_read: owner-turn + DM-scope + project-scope) by DENYING the `assistant` role's native
// Read/Glob/Grep access to the engine transcript root (`~/.claude/projects/**`) via a role-scoped
// `permissions.deny` entry. Hermetic like spawn-allow-baseline.mjs: a REAL Db + SessionService driven
// against a FAKE pty injected via PtyHost's createPty() seam, capturing the `permission` object threaded
// to `pty.spawn()` — this is the SAME object `resolveAgentSpawn` computes and the real (unfaked)
// createPty (host.ts) passes straight through, unmodified for `.deny`, into `writeSessionSettings`
// (claude-settings.ts), so capturing it here IS capturing what would land in the real session's
// settings.json `permissions.deny`.
//
// The engine actually HONOURING a `Read(<glob>)`-shaped deny rule (kickoff bite-point 3) was verified
// SEPARATELY, live, against a real installed `claude` binary (headless `-p`, scrubbed CLAUDECODE env,
// a scratch project + scratch HOME) — not re-derived here: an unrestricted control read succeeded, an
// absolute-path read of a file under a `~/`-anchored denied directory was refused (blocked BEFORE the
// file was touched, confirmed by the model's own refusal text), and the identical deny rule ALSO
// blocked a Glob enumeration of the denied directory. See the worker_report for the full transcript.
//
// PROVES:
//   1. An ASSISTANT-role spawn's permission.deny includes the role-scoped entry — in a DEFAULT-config
//      project AND in a project with its OWN CUSTOM permission.deny (resolveConfig REPLACES deny
//      wholesale for a custom override — config.ts:1589 — so this must be a UNION at the spawn
//      boundary, exactly like BASELINE_SESSION_ALLOW is for `allow`, or a project's own deny config
//      would silently strip this protection).
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
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { resolveConfig } = await import("@loom/shared");

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
  check("(1) assistant spawn (default config) permission.deny INCLUDES the role-scoped transcript-root deny",
    oAssistantDefault?.permission.deny.includes(ROLE_DENY));
  check("(1) assistant spawn (default config) deny has exactly one entry (no duplication of the empty baseline)",
    oAssistantDefault?.permission.deny.length === 1);

  const sPlainDefault = svc.startNew(agPlainDefault);
  const oPlainDefault = optsFor(sPlainDefault.id);
  const defaultDeny = resolveConfig({}).permission.deny;
  check("(3) plain spawn (default config) permission.deny is BYTE-IDENTICAL (same value) to the resolved config — no role-scoped entry leaked",
    JSON.stringify(oPlainDefault?.permission.deny) === JSON.stringify(defaultDeny));
  check("(3) plain spawn (default config) permission.deny does NOT include the role-scoped entry", !oPlainDefault?.permission.deny.includes(ROLE_DENY));

  const sWorkerDefault = svc.startNew(agWorkerDefault);
  const oWorkerDefault = optsFor(sWorkerDefault.id);
  check("(3) worker spawn (default config) permission.deny does NOT include the role-scoped entry", !oWorkerDefault?.permission.deny.includes(ROLE_DENY));
  check("(3) worker spawn (default config) permission.deny is BYTE-IDENTICAL (same value) to the resolved config",
    JSON.stringify(oWorkerDefault?.permission.deny) === JSON.stringify(defaultDeny));

  // ============ (2) CUSTOM-deny project: assistant gets BOTH the custom entry AND the role-scoped one ============
  const sAssistantCustom = svc.startNew(agAssistantCustom);
  const oAssistantCustom = optsFor(sAssistantCustom.id);
  check("(1)+(2) assistant spawn (custom-deny project) INCLUDES the role-scoped transcript-root deny (union, not replaced by the project's own deny)",
    oAssistantCustom?.permission.deny.includes(ROLE_DENY));
  check("(2) assistant spawn (custom-deny project) KEEPS the project's own custom deny entry",
    oAssistantCustom?.permission.deny.includes(CUSTOM_DENY));
  check("(2) assistant spawn (custom-deny project) has exactly the two expected entries, no more",
    oAssistantCustom?.permission.deny.length === 2);

  // Worker in the SAME custom-deny project: proves the union is ROLE-scoped, not project-scoped — a
  // non-assistant role in a project with its own deny gets ONLY that project's deny, unmodified.
  const sWorkerCustom = svc.startNew(agWorkerCustom);
  const oWorkerCustom = optsFor(sWorkerCustom.id);
  check("(3) worker spawn (custom-deny project) permission.deny is BYTE-IDENTICAL to the project's own resolved deny (no role-scoped entry)",
    JSON.stringify(oWorkerCustom?.permission.deny) === JSON.stringify([CUSTOM_DENY]));
  check("(3) worker spawn (custom-deny project) permission.deny does NOT include the role-scoped entry", !oWorkerCustom?.permission.deny.includes(ROLE_DENY));

  // ============ (4) Idempotency: a project whose OWN deny already carries the exact rule gets no duplicate ============
  const pAlready = "pAlready";
  db.insertProject({ id: pAlready, name: "Already-Has-It", repoPath: pAlready, vaultPath: pAlready, config: { permission: { deny: [ROLE_DENY] } }, createdAt: now, archivedAt: null });
  const agAssistantAlready = randomUUID();
  db.insertAgent({ id: agAssistantAlready, projectId: pAlready, name: "Companion", startupPrompt: "", position: 0, profileId: assistantProfileId });
  const sAssistantAlready = svc.startNew(agAssistantAlready);
  const oAssistantAlready = optsFor(sAssistantAlready.id);
  check("(4) assistant spawn whose project ALREADY carries the exact rule gets no duplicate (exactly one entry)",
    oAssistantAlready?.permission.deny.filter((t) => t === ROLE_DENY).length === 1);
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the assistant role's permission.deny gets the transcript-root Read deny UNIONED in (surviving a project's own custom deny, no duplicates), and every other role's permission.deny stays byte-identical to what resolveConfig alone produces."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
