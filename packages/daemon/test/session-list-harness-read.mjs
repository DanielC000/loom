import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 589afd55 (the third and last `harness`-reads-are-ambiguous instalment, Session Site A: after
// 3edf6ef7's `profileFields` and 41f35bfe's `worker_status` — see those cards' own
// profile-harness-read.mjs/session-harness-read.mjs for the precedent this mirrors). `list_all_sessions`
// (mcp/platform.ts + mcp/setup.ts) and `list_sessions` (mcp/transcript-read.ts, shared by audit + the
// LOOM_DEV platform auditor) could not tell "this session's harness is unset" apart from "this tool
// doesn't project harness" on their `full:true` path — a NULL `harness` column maps to `undefined`
// (db.ts's `toSession`/`listAllSessions`), and JSON.stringify drops an undefined-valued key entirely, so
// the wire response for an unset session carried no `harness` key at all on that path.
//
// HERMETIC, real AuditMcpRouter + real PlatformMcpRouter + real Db + InMemoryTransport (mirrors
// session-list-summary.mjs's own scaffolding) — no daemon, no real claude, no pty needed for this
// read-only surface (a fake pty seam only satisfies SessionService's constructor).
//
// Covers:
//   (1) REPRO — simulating the actual wire shape (JSON.parse(JSON.stringify(...)), matching the router's
//       `ok()` envelope) on the RAW `db.listAllSessions()` output: a SET harness survives the round-trip,
//       an UNSET one vanishes — the ambiguity, reproduced independent of any fix.
//   (2) FIX — BOTH `list_all_sessions` (platform.ts) and `list_sessions` (transcript-read.ts, the audit
//       surface) resolve an unset harness to explicit `null` on their full:true path, so the key is
//       ALWAYS present, AND an unset session stays distinguishable from one explicitly set to "claude"
//       (the property this card needs: can a reader answer "is this set?", not just "is the key
//       present?"). `null` mirrors what the DB column itself already means.
//   (3) SCOPE — `db.ts`'s shared `toSession()`/`listAllSessions()` mappers are left UNTOUCHED: an unset
//       harness still reads back as `undefined` off `db.getSession()`/`db.listAllSessions()` directly.
//       Negative control on the read fix itself — it must not have leaked into the shared object it
//       wraps. (These mappers stay untouched because `Session.harness` is typed `?: "claude" | "codex"`
//       with no `null` member, so returning an explicit `null` there wouldn't compile without widening
//       that shared type — a TYPE reason, not a partial-update "leave the column as-is" one: no
//       `UPDATE sessions SET` statement in db.ts touches `harness`, unlike the Profile side's
//       `updateProfile` binding, which genuinely does read an unresolved `undefined` that way.)
//   (4) The DEFAULT (summary, non-full) path is UNCHANGED — it never carried `harness` before this card
//       and still doesn't; this card's fix is scoped to full:true only.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/session-list-harness-read.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-slhr-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
import { commitAll } from "./_git-commit.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { AuditMcpRouter } = await import("../dist/mcp/audit.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// A real temp git repo so a spawn has a valid cwd (createPty is faked → no real claude).
const repo = path.join(os.tmpdir(), `loom-slhr-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# session-list-harness-read test repo\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=slhr@loom -c user.name=slhr");

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pHome", name: "Loom Platform", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: true });
db.insertProject({ id: "pOrd", name: "Ordinary", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertProfile({ id: "profAudit", name: "Platform-audit", role: "auditor", description: "audit rig", allowDelta: [], skills: null, model: null, icon: "🔎" });
db.insertAgent({ id: "agentAud", projectId: "pHome", name: "Platform Auditor", startupPrompt: "AUDIT", position: 0, profileId: "profAudit" });
db.insertAgent({ id: "agentWork", projectId: "pOrd", name: "Worker", startupPrompt: "WORK", position: 0, profileId: null });

const auditorSession = { id: "AUD", projectId: "pHome", agentId: "agentAud", engineSessionId: null, title: null, cwd: repo,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "auditor", parentSessionId: null };
db.insertSession(auditorSession);

db.insertSession({ id: "w-unset", projectId: "pOrd", agentId: "agentWork", engineSessionId: "eng-w-unset", title: null, cwd: repo,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: new Date(Date.now() + 2_000).toISOString(), lastError: null, role: "worker", parentSessionId: "mgr", taskId: "task-unset" });
db.insertSession({ id: "w-codex", projectId: "pOrd", agentId: "agentWork", engineSessionId: "eng-w-codex", title: null, cwd: repo,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: new Date(Date.now() + 1_000).toISOString(), lastError: null, role: "worker", parentSessionId: "mgr", taskId: "task-codex", harness: "codex" });

// ===================== (1) REPRO — the ambiguity, on the raw db.listAllSessions() wire shape =====================
const rawAll = db.listAllSessions();
const rawUnset = rawAll.find((s) => s.id === "w-unset");
const rawCodex = rawAll.find((s) => s.id === "w-codex");
const wireRawCodex = JSON.parse(JSON.stringify(rawCodex));
const wireRawUnset = JSON.parse(JSON.stringify(rawUnset));
check("(1 repro) positive control: a SET harness survives the raw wire round-trip", wireRawCodex.harness === "codex");
check("(1 repro) THE DEFECT: an UNSET harness's key is entirely ABSENT from the raw wire round-trip " +
  "(indistinguishable from a tool that never projects harness at all)", !("harness" in wireRawUnset));

// Fake pty seam (no real claude).
class SeamHost extends createSeamHost(PtyHost) {
  createPty(opts) { return { ...super.createPty(opts), pid: 1 }; }
  stop() {}
}
const host = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
const svc = new SessionService(db, host, new OrchestrationControl());
const auditRouter = new AuditMcpRouter(db, svc);
const platformRouter = new PlatformMcpRouter(db, svc);

const parse = (res) => JSON.parse(res.content[0].text);
const toRows = (result) => Array.isArray(result) ? result : result.sessions;

try {
  // ---- platform list_all_sessions (full:true) ----
  const pServer = platformRouter.buildServer();
  const [pcT, psT] = InMemoryTransport.createLinkedPair();
  await pServer.connect(psT);
  const pClient = new Client({ name: "slhr-platform", version: "0" });
  await pClient.connect(pcT);

  const platFull = toRows(parse(await pClient.callTool({ name: "list_all_sessions", arguments: { projectId: "pOrd", full: true } })));
  const platUnset = platFull.find((s) => s.id === "w-unset");
  const platCodex = platFull.find((s) => s.id === "w-codex");

  // ===================== (2) FIX — list_all_sessions always projects harness on full:true =====================
  check("(2 fix) list_all_sessions full:true: a SET harness still reads through unchanged", platCodex.harness === "codex");
  check("(2 fix) list_all_sessions full:true: an UNSET harness now reads back explicitly as `null`, no longer ambiguous",
    platUnset.harness === null);
  check("(2 fix) list_all_sessions full:true: the harness key is present on the wire in BOTH cases now",
    "harness" in platCodex && "harness" in platUnset);
  check("(2 fix) list_all_sessions full:true: UNSET (null) and explicitly-SET-to-a-value remain DISTINGUISHABLE",
    platUnset.harness !== platCodex.harness);

  // ---- (4) DEFAULT (summary) path is UNCHANGED — never carried harness, still doesn't ----
  const platDefault = toRows(parse(await pClient.callTool({ name: "list_all_sessions", arguments: { projectId: "pOrd" } })));
  check("(4) list_all_sessions default summary still OMITS harness for both rows (unchanged, full:true-only fix)",
    platDefault.every((s) => !("harness" in s)));

  await pClient.close();

  // ---- audit list_sessions (full:true) — the transcript-read.ts helper shared by the audit surface ----
  const aServer = auditRouter.buildServer("AUD");
  const [acT, asT] = InMemoryTransport.createLinkedPair();
  await aServer.connect(asT);
  const aClient = new Client({ name: "slhr-audit", version: "0" });
  await aClient.connect(acT);

  const auditFull = toRows(parse(await aClient.callTool({ name: "list_sessions", arguments: { scope: "live", projectId: "pOrd", full: true } })));
  const auditUnset = auditFull.find((s) => s.id === "w-unset");
  const auditCodex = auditFull.find((s) => s.id === "w-codex");
  check("(2 fix) audit list_sessions full:true: a SET harness still reads through unchanged", auditCodex.harness === "codex");
  check("(2 fix) audit list_sessions full:true: an UNSET harness now reads back explicitly as `null`",
    auditUnset.harness === null);
  check("(2 fix) audit list_sessions full:true: the harness key is present on the wire in BOTH cases now",
    "harness" in auditCodex && "harness" in auditUnset);

  await aClient.close();

  // ===================== (3) SCOPE — db.ts's shared mappers are UNTOUCHED =====================
  // Negative control on the fix itself: if the projection's resolution had leaked into the shared
  // db.getSession()/db.listAllSessions() objects, this would go red.
  check("(3 scope) db.getSession() raw output for the UNSET session is untouched: harness is still " +
    "`undefined` (never coerced) — toSession() stays unresolved because Session.harness has no `null` " +
    "member (a type reason, not a partial-update one — no `UPDATE sessions SET` touches harness)",
    db.getSession("w-unset").harness === undefined);
  check("(3 scope) db.getSession() raw output for the SET session is untouched",
    db.getSession("w-codex").harness === "codex");
  check("(3 scope) db.listAllSessions() raw output for the UNSET session is untouched too",
    db.listAllSessions().find((s) => s.id === "w-unset").harness === undefined);
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0 ? "\nAll session-list-harness-read checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
