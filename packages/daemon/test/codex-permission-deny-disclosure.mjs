import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 7955458e — createCodexPty never ENFORCES opts.permission (it reads opts.permission.deny/opts.role
// ONLY to loudly DISCLOSE the gap, never to act on it), so claude's spawn-time permission.deny chokepoint
// (SETTINGS_DIR read-deny, the blanket transcript-root deny, and the worker per-other-project transcript
// pair — all built inside createPty ONLY) is silently dropped on every codex spawn. This proves:
//   (1)-(3) createCodexPty's own report payload (unaffected by the Code Review MAJOR fix — same shapes as
//       before, just now on the SEPARATE `onCodexIsolationGapDisclosed` event instead of
//       `onCodexUnsupportedCapability`): settingsDirReadDeny (unconditional), transcriptRootReadDeny
//       (role-gated), workerProjectTranscriptDeny (worker + other-live-projects-gated).
//   (4) Code Review item 3 — permissionDeny is NOW ALSO disclosed here (surfacing the explicit-profile/
//       pinned-resume cases `defaultHarnessForSpawn`'s skip-to-claude never reaches), via the SAME
//       isolationGapItems report.
//   (5) Code Review MAJOR fix, SessionService-level: `onCodexIsolationGapDisclosed` MUST route through
//       `handleCodexIsolationGapDisclosed`, never `handleCodexUnsupportedCapability` — the recipient (the
//       codex session's OWN turn input) must NEVER see these items, only the durable event + a manager-side
//       nudge, deduped per (RECYCLE LINEAGE, item-id set) — SECOND Code Review MAJOR 2 fix, replacing a
//       wrong agentId-keyed dedup (agentId is the agent DEFINITION, shared by every session ever spawned
//       from it, not a recycle lineage) and a `nudged` field that was recorded `true` even when there was
//       no recipient to actually send to.
//   (6) Card ed0858dc — the PARENTLESS invariant the web attention surface now reads off these rows
//       (`managerSessionId === workerSessionId`, since the handler files `parentSessionId ?? sessionId`),
//       with a negative control proving the id-equality leg is what discriminates, not `nudged` alone.
// Fully hermetic: a bare `new PtyHost(events)` for (1)-(4), a real Db + SessionService for (5), NO real
// codex (LOOM_CODEX_BIN points at a nonexistent path — the report fires BEFORE the doomed spawn attempt,
// mirroring companion-codex-restricted-tools-refusal.mjs's section 3 recipe).
// Run: 1) build, 2) node test/codex-permission-deny-disclosure.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-codex-perm-deny-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
process.env.LOOM_CODEX_BIN = path.join(tmpHome, "definitely-not-a-real-codex-binary");
delete process.env.CODEX_HOME;

import { requireHermeticEnv } from "./_guard.mjs";
import { cleanupPathSync } from "./_tmp-fixture.mjs";
requireHermeticEnv();

const { PtyHost } = await import("../dist/pty/host.js");

const cwd = path.join(tmpHome, "cwd");
fs.mkdirSync(cwd, { recursive: true });
// permission must be a COMPLETE PermissionPolicy (deny: string[] is non-optional on the real type) — an
// incomplete `{}` here would crash createCodexPty's own `opts.permission.deny.length` read with an
// unrelated-looking TypeError, since no real caller ever hands it anything less than the full shape.
const base = { cwd, permission: { deny: [] }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} };

function reportFor(host, opts) {
  const reports = [];
  const h = host ?? new PtyHost({ onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onBusy() {}, onExit() {}, onCodexIsolationGapDisclosed: (sid, info) => reports.push({ sid, info }) });
  try { h.createCodexPty(opts); } catch { /* the fake binary cannot spawn — the report fires BEFORE that */ }
  return reports.find((r) => r.sid === opts.sessionId)?.info.items ?? [];
}
function hostWithOtherProjects(otherProjects) {
  const reports = [];
  const h = new PtyHost(
    { onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onBusy() {}, onExit() {}, onCodexIsolationGapDisclosed: (sid, info) => reports.push({ sid, info }) },
    { getOtherProjects: () => otherProjects },
  );
  return { h, reports };
}

try {
  // ============ (1) settingsDirReadDeny — unconditional ============
  for (const [label, role] of [["role:worker", "worker"], ["role:manager", "manager"], ["role:undefined", undefined]]) {
    const items = reportFor(undefined, { ...base, sessionId: `sdrd-${label}`, role });
    check(`(1) settingsDirReadDeny present for ${label}`, items.some((i) => i.id === "settingsDirReadDeny"));
  }

  // ============ (2) transcriptRootReadDeny — TRANSCRIPT_ROOT_DENY_ROLES-gated ============
  {
    const mgr = reportFor(undefined, { ...base, sessionId: "trd-manager", role: "manager" });
    check("(2) role:manager (a TRANSCRIPT_ROOT_DENY_ROLES member) → transcriptRootReadDeny present", mgr.some((i) => i.id === "transcriptRootReadDeny"));
    check("(2) …names the role in the reason", mgr.find((i) => i.id === "transcriptRootReadDeny")?.reason.includes('role "manager"'));

    const wrk = reportFor(undefined, { ...base, sessionId: "trd-worker", role: "worker" });
    check("(2) CONTROL: role:worker (NOT a blanket-rule member — gets the narrower item instead) → transcriptRootReadDeny absent", !wrk.some((i) => i.id === "transcriptRootReadDeny"));

    const runRole = reportFor(undefined, { ...base, sessionId: "trd-run", role: "run" });
    check("(2) NEGATIVE CONTROL: role:run (card ac90ca8e's deliberate exclusion) → transcriptRootReadDeny absent", !runRole.some((i) => i.id === "transcriptRootReadDeny"));

    const none = reportFor(undefined, { ...base, sessionId: "trd-none", role: undefined });
    check("(2) CONTROL: role:undefined → transcriptRootReadDeny absent", !none.some((i) => i.id === "transcriptRootReadDeny"));
  }

  // ============ (3) workerProjectTranscriptDeny — worker + non-empty getOtherProjects only ============
  {
    const { h: hostWith2, reports: r2 } = hostWithOtherProjects([{ id: "pOther1", repoPath: "/x" }, { id: "pOther2", repoPath: "/y" }]);
    try { hostWith2.createCodexPty({ ...base, sessionId: "wptd-2", role: "worker", projectId: "pThis" }); } catch { /* expected */ }
    const items2 = r2.find((r) => r.sid === "wptd-2")?.info.items ?? [];
    check("(3) role:worker + 2 other live projects → workerProjectTranscriptDeny present", items2.some((i) => i.id === "workerProjectTranscriptDeny"));
    check("(3) …names the count (2) in the reason", items2.find((i) => i.id === "workerProjectTranscriptDeny")?.reason.includes("2 other live projects"));

    const { h: hostWith0, reports: r0 } = hostWithOtherProjects([]);
    try { hostWith0.createCodexPty({ ...base, sessionId: "wptd-0", role: "worker", projectId: "pThis" }); } catch { /* expected */ }
    const items0 = r0.find((r) => r.sid === "wptd-0")?.info.items ?? [];
    check("(3) CONTROL: role:worker + ZERO other live projects → workerProjectTranscriptDeny absent (nothing was actually dropped)", !items0.some((i) => i.id === "workerProjectTranscriptDeny"));

    const { h: hostNoProj, reports: rNoProj } = hostWithOtherProjects([{ id: "pOther1", repoPath: "/x" }]);
    try { hostNoProj.createCodexPty({ ...base, sessionId: "wptd-noproj", role: "worker" }); } catch { /* expected */ }
    const itemsNoProj = rNoProj.find((r) => r.sid === "wptd-noproj")?.info.items ?? [];
    check("(3) CONTROL: role:worker with NO projectId → workerProjectTranscriptDeny absent", !itemsNoProj.some((i) => i.id === "workerProjectTranscriptDeny"));

    const { h: hostMgr, reports: rMgr } = hostWithOtherProjects([{ id: "pOther1", repoPath: "/x" }]);
    try { hostMgr.createCodexPty({ ...base, sessionId: "wptd-mgr", role: "manager", projectId: "pThis" }); } catch { /* expected */ }
    const itemsMgr = rMgr.find((r) => r.sid === "wptd-mgr")?.info.items ?? [];
    check("(3) CONTROL: role:manager (not worker) with other live projects → workerProjectTranscriptDeny still absent", !itemsMgr.some((i) => i.id === "workerProjectTranscriptDeny"));
  }

  // ============ (4) Code Review item 3 — permissionDeny IS now disclosed here ============
  {
    const items1 = reportFor(undefined, { ...base, sessionId: "pd-one", role: "worker", permission: { deny: ["Read(/some/secret/**)"] } });
    check("(4) opts.permission.deny non-empty (1 rule) → permissionDeny present, naming the count", items1.some((i) => i.id === "permissionDeny") && items1.find((i) => i.id === "permissionDeny").reason.includes("1 authored permission.deny rule that"));
    const items2 = reportFor(undefined, { ...base, sessionId: "pd-two", role: "worker", permission: { deny: ["Read(/a/**)", "Read(/b/**)"] } });
    check("(4) 2 rules → plural reason", items2.find((i) => i.id === "permissionDeny")?.reason.includes("2 authored permission.deny rules that"));
    const itemsEmpty = reportFor(undefined, { ...base, sessionId: "pd-empty", role: "worker", permission: { deny: [] } });
    check("(4) CONTROL: opts.permission.deny empty → permissionDeny absent", !itemsEmpty.some((i) => i.id === "permissionDeny"));
  }

  // ============ (5) SessionService-level routing: recipient NEVER sees it; manager nudge once per lineage ============
  // Reuses the SAME tmpHome/LOOM_HOME as (1)-(4) above (never a second one) — `paths.js` caches LOOM_HOME
  // at its own FIRST import, which already happened transitively via this file's top-level `pty/host.js`
  // import; reassigning `process.env.LOOM_HOME` afterward would have no effect on that cached constant.
  {
    const { Db } = await import("../dist/db.js");
    const { SessionService } = await import("../dist/sessions/service.js");
    const { OrchestrationControl } = await import("../dist/orchestration/control.js");

    const now = new Date().toISOString();
    const db = new Db();
    const projId = "pSvc";
    const cwd2 = path.join(tmpHome, "svc-cwd");
    fs.mkdirSync(cwd2, { recursive: true });
    db.insertProject({ id: projId, name: "Svc", repoPath: cwd2, vaultPath: cwd2, config: {}, createdAt: now, archivedAt: null });
    const agentId = "agSvc";
    db.insertAgent({ id: agentId, projectId: projId, name: agentId, startupPrompt: "", position: 0, profileId: null });
    const mgrId = "mgrSvc";
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: cwd2, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

    // Capture every enqueueStdin call (the real mechanism enqueueSystemNudge routes through) — bypasses
    // the need for a live registered pty entirely; see _seam-host-fixture.mjs's own doc for this pattern.
    const enqueued = [];
    class CaptureHost extends PtyHost {
      sweepOrphanedDescendants(_rootPid) {}
      reapExitedDescendants() {} async probeRootSurvival(_rootPid, _sessionId) { return { foundAlive: false, identityConfirmed: false, enumerationFailed: false }; }
      async captureRootCreationRow(_pid) { return null; }
      enqueueStdin(sessionId, text) { enqueued.push({ sessionId, text }); return { delivered: false, deliveryState: "dropped" }; }
    }
    const host = new CaptureHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
    const svc = new SessionService(db, host, new OrchestrationControl());

    const mkWorker = (id, taskId, extra = {}) => {
      db.insertTask({ id: taskId, projectId: projId, title: taskId, body: "", columnKey: "todo", position: 1, createdAt: now, updatedAt: now });
      db.insertSession({ id, projectId: projId, agentId, engineSessionId: null, title: null, cwd: cwd2, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, gen: 0, ...extra });
    };
    const items = [{ id: "settingsDirReadDeny", reason: "claude denies Read() of SOME SECRET PATH for every role" }, { id: "permissionDeny", reason: "this project has 1 authored permission.deny rule that codex cannot honour" }];
    const itemsPlusNew = [...items, { id: "transcriptRootReadDeny", reason: "a NEW item added later in this lineage's life" }];
    const mgrNudgeCount = () => enqueued.filter((e) => e.sessionId === mgrId).length;

    // ---- a fresh lineage, first occurrence (nudged) ----
    mkWorker("w1", "t1");
    svc.handleCodexIsolationGapDisclosed("w1", { items });
    check("(5) the RECIPIENT (codex session itself) NEVER receives an isolation-gap nudge", enqueued.filter((e) => e.sessionId === "w1").length === 0);
    check("(5) the manager receives EXACTLY ONE nudge naming both items (first occurrence of this lineage+item-set)", mgrNudgeCount() === 1 && enqueued[0].text.includes("settingsDirReadDeny") && enqueued[0].text.includes("permissionDeny") && enqueued[0].text.includes("SECRET PATH"));
    check("(5) …none of which leaked SECRET PATH into the recipient's own queue", !enqueued.some((e) => e.sessionId === "w1" && e.text.includes("SECRET PATH")));
    const durable1 = db.listEventsForWorker("w1").find((e) => e.kind === "codex_isolation_gap_disclosed");
    check("(5) durable event filed: nudged:true, lineageRootId is w1 itself (fresh lineage), itemsKey sorted", durable1?.detail.nudged === true && durable1.detail.lineageRootId === "w1" && durable1.detail.itemsKey === "permissionDeny,settingsDirReadDeny" && durable1.detail.items.length === 2);

    // ---- (i) a DISTINCT-TASK worker of the SAME agent is a DIFFERENT lineage — must ALSO nudge ----
    // (proves agentId alone is the wrong key: w1b shares agentId with w1 but is a fresh, unrelated lineage)
    mkWorker("w1b", "t1b");
    svc.handleCodexIsolationGapDisclosed("w1b", { items });
    check("(5)(i) a distinct-task worker of the SAME agent (different lineage) still gets its own manager nudge", mgrNudgeCount() === 2);
    const durable1b = db.listEventsForWorker("w1b").find((e) => e.kind === "codex_isolation_gap_disclosed");
    check("(5)(i) its OWN lineageRootId is w1b, not w1 (agentId is shared, lineage is not)", durable1b?.detail.lineageRootId === "w1b" && durable1b.detail.nudged === true);

    // ---- (ii) a true resume/recycle of the SAME lineage (recycledFrom: w1) with the SAME items: no re-nudge ----
    mkWorker("w1r", "t1r", { recycledFrom: "w1" });
    svc.handleCodexIsolationGapDisclosed("w1r", { items });
    check("(5)(ii) recipient still never sees it", enqueued.filter((e) => e.sessionId === "w1r").length === 0);
    check("(5)(ii) same lineage (walks recycledFrom to w1) + same item-set: manager nudge does NOT repeat", mgrNudgeCount() === 2);
    const durable1r = db.listEventsForWorker("w1r").find((e) => e.kind === "codex_isolation_gap_disclosed");
    check("(5)(ii) durable event STILL fires, lineageRootId resolves to w1 (the root), nudged:false", durable1r?.detail.nudged === false && durable1r.detail.lineageRootId === "w1");

    // ---- (iii) same lineage, a NEW item added later: must nudge again ----
    mkWorker("w1r2", "t1r2", { recycledFrom: "w1r" });
    svc.handleCodexIsolationGapDisclosed("w1r2", { items: itemsPlusNew });
    check("(5)(iii) same lineage but a DIFFERENT (larger) item-set: manager IS nudged again", mgrNudgeCount() === 3);
    const durable1r2 = db.listEventsForWorker("w1r2").find((e) => e.kind === "codex_isolation_gap_disclosed");
    check("(5)(iii) durable event: nudged:true, lineageRootId still w1, itemsKey reflects the NEW set", durable1r2?.detail.nudged === true && durable1r2.detail.lineageRootId === "w1" && durable1r2.detail.itemsKey === "permissionDeny,settingsDirReadDeny,transcriptRootReadDeny");
    // A later re-occurrence of this SAME (lineage, new item-set) pair is deduped exactly like (ii).
    mkWorker("w1r3", "t1r3", { recycledFrom: "w1r2" });
    svc.handleCodexIsolationGapDisclosed("w1r3", { items: itemsPlusNew });
    check("(5)(iii) CONTROL: the now-seen item-set on the same lineage is deduped on its NEXT occurrence too", mgrNudgeCount() === 3);

    // ---- (iv) a PARENTLESS first spawn (nothing sent, since there's no recipient) must NOT permanently ----
    // suppress a LATER, managed (has-parent) spawn of the same continued lineage.
    const parentlessId = "w-parentless";
    db.insertSession({ id: parentlessId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: cwd2, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: null, gen: 0 });
    svc.handleCodexIsolationGapDisclosed(parentlessId, { items });
    check("(5)(iv) a parentless spawn sends nothing (nowhere to send it)", enqueued.filter((e) => e.sessionId === parentlessId).length === 0 && mgrNudgeCount() === 3);
    const durableParentless = db.listEventsForWorker(parentlessId).find((e) => e.kind === "codex_isolation_gap_disclosed");
    check("(5)(iv) its OWN durable event honestly records nudged:false (no recipient, not a dedup)", durableParentless?.detail.nudged === false && durableParentless.detail.lineageRootId === parentlessId);
    mkWorker("w-managed", "t-managed", { recycledFrom: parentlessId });
    svc.handleCodexIsolationGapDisclosed("w-managed", { items });
    check("(5)(iv) the SAME lineage's later MANAGED spawn IS nudged — the parentless occurrence never counted as 'already nudged'", mgrNudgeCount() === 4);
    const durableManaged = db.listEventsForWorker("w-managed").find((e) => e.kind === "codex_isolation_gap_disclosed");
    check("(5)(iv) its durable event: nudged:true, lineageRootId resolves back to the parentless root", durableManaged?.detail.nudged === true && durableManaged.detail.lineageRootId === parentlessId);

    // ============ (6) THE PARENTLESS INVARIANT A WEB READER NOW DEPENDS ON (card ed0858dc) ============
    // `web/src/lib/fleet.ts`'s `activeCodexIsolationGapAlerts` surfaces a PARENTLESS session's disclosure
    // as a human attention item (a run session has no manager, so (5)(iv)'s row above reached NOBODY until
    // that card). It cannot read `parentSessionId` — it only has the event row — so it derives
    // parentlessness from `managerSessionId === workerSessionId`, which holds because this handler files
    // `managerSessionId: s?.parentSessionId ?? sessionId`. That invariant lives HERE, so it is pinned here:
    // an edit to that fallback would silently blind the UI with nothing else to catch it.
    //
    // The predicate below MIRRORS the web helper's two filters (a daemon test cannot import web TS). A
    // mirror is only worth as much as the equivalence behind it, so it is exercised against the REAL rows
    // (5) just produced — both polarities — and then against a counterfeit, so the id-equality leg is
    // proven to be what actually discriminates rather than riding along on `nudged`.
    const webPredicate = (e) => !!e && e.managerSessionId === e.workerSessionId && e.detail.nudged === false;

    check("(6) the real PARENTLESS row satisfies the web predicate (managerSessionId === workerSessionId, nudged:false)", webPredicate(durableParentless) === true);
    check("(6) …and it is genuinely the id-equality that holds, not an accident of the fixture", durableParentless.managerSessionId === parentlessId && durableParentless.workerSessionId === parentlessId);
    check("(6) a real MANAGED row is REJECTED (the manager was nudged — not this surface's job)", webPredicate(durableManaged) === false);
    check("(6) a real managed row that is lineage-DEDUPED (nudged:false, but it HAD a parent) is also rejected", durable1r.detail.nudged === false && webPredicate(durable1r) === false);

    // NEGATIVE CONTROL — the predicate must go RED on a row whose ONLY defect is the manager id. Without
    // this, every assertion above would pass on `nudged:false` alone and prove nothing about the id
    // equality that does the real discriminating (the `nudged` leg cannot tell "nobody to tell" apart from
    // "already told"). Filed through the SAME `db.appendEvent` writer the handler uses, so the only
    // difference from the genuine parentless row is the field under test.
    const counterfeitId = randomUUID();
    db.appendEvent({
      id: counterfeitId, ts: new Date().toISOString(),
      managerSessionId: mgrId, // ← the single mutation: a real parent, where the genuine row has itself
      workerSessionId: parentlessId, taskId: null,
      kind: "codex_isolation_gap_disclosed",
      detail: { ...durableParentless.detail }, // nudged:false and the same item-set, verbatim
    });
    const counterfeit = db.listEventsForWorker(parentlessId).find((e) => e.id === counterfeitId);
    check("(6) NEGATIVE CONTROL: the counterfeit row really was stored with a DIFFERENT managerSessionId and nudged:false", counterfeit?.managerSessionId === mgrId && counterfeit.workerSessionId === parentlessId && counterfeit.detail.nudged === false);
    check("(6) NEGATIVE CONTROL: the web predicate goes RED on it — so the id-equality leg is load-bearing, not decorative", webPredicate(counterfeit) === false);

    db.close();
  }
} finally {
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — createCodexPty's isolation-gap report (a SEPARATE signal from capability drops) discloses the SETTINGS_DIR / transcript-root / worker-per-project / permissionDeny read-denies claude's permission.deny chokepoint silently drops on codex, and SessionService routes it correctly: never into the affected session's own turn input, a manager nudge once per (recycle lineage, item-set), a durable event every spawn — and a PARENTLESS row stays identifiable as one by managerSessionId === workerSessionId, the invariant the web attention surface reads (card ed0858dc)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
