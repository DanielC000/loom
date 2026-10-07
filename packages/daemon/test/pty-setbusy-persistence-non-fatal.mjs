// Card 72c58b1c, round 3 (Code Review aeae8525) — PtyHost's `events.onBusy` persistence callout must
// NEVER throw back out of the caller that triggered it, for EITHER harness.
//
// THE BUG (reproduced by the reviewer, claude path): `events.onBusy`, in the real wiring, mirrors the
// in-memory busy flip to the DB AND drives the manager idle-notification (index.ts's onBusy -> db.setBusy,
// then notifyManagerOfIdleWorker/purgeStaleIdleNudgeForReengagedWorker) — a failure there can skip ANY of
// the three, not just the DB write. That failure used to propagate straight out of `setBusy`, and `setBusy`
// is called AFTER the real side effect in BOTH of its two callers:
//   (A) `PtyHost.spawn()`'s own spawn-time optimistic set (`spawn-startup-prompt`, host.ts) — called AFTER
//       `createPty` has already returned a live pty process (NOT inside `createPty` itself). A throw there
//       made `SessionService.startNew`/`startManager` look like a failed spawn (`reconcileFailedSpawn`
//       marks the row "exited") even though a real session is running — the exact shape that broke webhook
//       ingress's "startNew() throws <=> no live session" invariant
//       docs/decisions/72c58b1c-webhook-dedupe-record-after-fire.md depends on.
//   (B) `submit()`'s own last, synchronous statement (`this.setBusy(sessionId, true, reason)`) — called
//       AFTER the paste/Enter has already been written to the pty. A throw there made `enqueueStdin`
//       (which calls `submit()` synchronously for an idle session) look like a failed delivery, even
//       though the nudge/turn text had already gone out.
//
// ROUND 3b (manager follow-up): a webhook's target agent can be codex-harnessed (profile- or
// platform-default-derived) — `setCodexBusy` had the IDENTICAL unguarded `this.events.onBusy(...)` call,
// reachable synchronously from `enqueueStdin` -> `enqueueStdinCodex` -> `submitCodex` for an idle codex
// session (case C below). `submitCodex` calls `setCodexBusy(true,"submit")` BEFORE its own text write
// (the opposite order from claude's `submit()`), so this specific site's failure mode is "enqueueStdin
// throws when nothing was actually delivered yet" rather than a genuine double-fire — but that still
// violates the SAME invariant webhook ingress depends on (`enqueueStdin` never throws), so it needed the
// same fix regardless of ordering.
//
// THE FIX: BOTH `setBusy` and `setCodexBusy` now route their `events.onBusy(...)` callout through ONE
// shared, private `persistBusy(sessionId, busy)` helper (host.ts) — a single try/catch, not two copies —
// which logs and never rethrows. The in-memory busy flip in each caller stays unconditional either way.
//
// All three cases below are proven RED on the pre-fix code and GREEN after: (A) via a REAL SessionService
// + Db + fake-pty fixture (needs the real DB row to check `processState`/`lastError`), (B) via a pure
// PtyHost + fake-pty fixture (mirrors pty-busy-drain.mjs's own style), (C) via a fake CODEX pty fixture
// (mirrors codex-submit-marker-in-gap.mjs's own FakeCodexHost/bootSession technique) — none need
// SessionService/Db since only `enqueueStdin`'s return value is asserted. Section (D) is a cheap
// structural pin, independent of the dynamic cases: host.ts's source is parsed with the TypeScript
// compiler API (mirroring live-flip-reconcile-guard.mjs's own technique) and walked for CallExpression
// nodes whose callee is `<expr>.events.onBusy`, confirming `persistBusy` remains the ONLY direct caller —
// so a future THIRD caller that bypasses the helper (rather than a future harness routing through it) is
// caught even if nobody thinks to extend this file's dynamic cases for it. AST-based, deliberately NOT a
// source-TEXT/grep scan (manager review aeae8525's follow-up): a text match would flip on a COMMENT
// mentioning `events.onBusy(` and would also make this file invisible to the reduced merge gate's own
// `CHANGED_TS_TEXT_SCANNER_REPO_PATHS` list for a comment-only host.ts diff (that list is for TEXT
// scanners specifically — an AST scanner doesn't belong on it, and doesn't need to). Proven below with a
// synthetic poison-comment negative control AND a synthetic positive control, checked BEFORE trusting the
// scan's verdict on the real file.
//
// (D)'s OWN LIMIT, stated plainly rather than overclaimed as a proof of exhaustive coverage: the matcher
// only recognizes the LITERAL shape `<expr>.events.onBusy(...)` (a direct PropertyAccessExpression chain).
// A call reached via element access (`this.events["onBusy"](...)`) or via destructuring
// (`const { onBusy } = this.events; onBusy(...)`) would bypass it undetected. Neither shape appears
// anywhere in the real corpus today (checked at the time this was written), but a green run here is
// evidence against the ONE bypass shape this section actually polices, not a guarantee against every way
// `events.onBusy` could ever be reached.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import ts from "typescript";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-sbpnf-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

// ===================== (A) onBusy throws DURING SPAWN => startNew does NOT throw, row stays "live" =====
{
  const repo = path.join(os.tmpdir(), `loom-sbpnf-repo-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# pty-setbusy-persistence-non-fatal (A) test\n");
  execSync(`git init -q`, { cwd: repo });
  commitAll(repo, "init", "-c user.email=sbpnf@loom -c user.name=sbpnf");

  const now = new Date().toISOString();
  const db = new Db();
  const host = new (createSeamHost(PtyHost))({
    onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
    onBusy() { throw new Error("simulated SQLITE_BUSY (onBusy persistence)"); },
    onContextStats() {}, onRateLimited() {},
    onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
  });
  const svc = new SessionService(db, host, new OrchestrationControl());

  db.insertProject({ id: "pA", name: "A", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  // A non-empty startupPrompt is required so `opts.startupPrompt` is truthy in PtyHost.spawn(), which is
  // what gates the `setBusy(sessionId, true, "spawn-startup-prompt")` call this case targets (host.ts) —
  // that check and call both run AFTER spawn()'s own `createPty(...)` call has already returned.
  db.insertAgent({ id: "agentA", projectId: "pA", name: "A", startupPrompt: "PLAIN_DOCTRINE", position: 0, profileId: null });

  try {
    let spawnError;
    let session;
    try {
      session = svc.startNew("agentA");
    } catch (e) {
      spawnError = e;
    }

    check("(A) startNew does NOT throw even though its spawn-time onBusy callout fails", !spawnError);
    if (session) {
      check("(A) ...and the session it returned is genuinely LIVE (not reported as a failed spawn)", session.processState === "live");
      const row = db.getSession(session.id);
      check("(A) ...and the REAL db row (re-read fresh) is 'live', NOT reconciled to 'exited'", row?.processState === "live");
      check("(A) ...and lastError was never stamped (reconcileFailedSpawn never ran)", row?.lastError == null);
      check("(A) ...and the pty is genuinely alive (a real process backs this row)", host.isAlive(session.id) === true);
    }
  } finally {
    db.close();
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

// ===================== (B) onBusy throws during an IDLE-PATH ENQUEUE => enqueueStdin does NOT throw =====
{
  class SeamHost extends createSeamHost(PtyHost) {}
  const host2 = new SeamHost({
    onEngineSessionId() {},
    onBusy() { throw new Error("simulated SQLITE_BUSY (onBusy persistence)"); },
    onContextStats() {}, onRateLimited() {},
    onExit() {},
  });
  const SID = "sbpnf-sess-b";
  try {
    // Spawn WITHOUT a startupPrompt — busy starts false, isolating this case from (A)'s spawn-time path.
    host2.spawn({
      sessionId: SID, cwd: tmpHome,
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    host2.deliverHook(SID, { hook_event_name: "SessionStart" }); // reach ready synchronously (startupModeCycles:0)

    let enqueueError;
    let result;
    try {
      // First enqueue on an idle, ready session delivers IMMEDIATELY via submit() — submit()'s own LAST
      // synchronous statement is `this.setBusy(sessionId, true, reason)` (host.ts), called AFTER the
      // paste/Enter has already been written. This is exactly the reviewer-reproduced trigger.
      result = host2.enqueueStdin(SID, "WEBHOOK_NUDGE_TEXT");
    } catch (e) {
      enqueueError = e;
    }

    check("(B) enqueueStdin does NOT throw even though submit()'s trailing onBusy callout fails", !enqueueError);
    check("(B) ...and it still reports delivered (the turn genuinely went out)", result?.delivered === true);

    // The in-memory busy flip must stay UNCONDITIONAL despite onBusy's failure (manager's explicit
    // requirement) — prove it structurally: a SECOND enqueue right after must now QUEUE, not deliver
    // immediately, which is only possible if live.busy actually flipped to true.
    const second = host2.enqueueStdin(SID, "SECOND_MSG");
    check("(B) ...and the in-memory busy flip still happened (a concurrent enqueue right after QUEUES, proving busy=true)", second.delivered === false && second.position === 1);
  } finally {
    try { host2.stop(SID, "hard"); } catch { /* ignore */ }
  }
}

// ===================== (C) CODEX path: onBusy throws during submitCodex => enqueueStdin doesn't throw ===
{
  function makeFakeCodexPty() {
    let onDataCb = null, onExitCb = null;
    const writes = [];
    return {
      pid: 6363,
      write(data) { writes.push(data); },
      onData(cb) { onDataCb = cb; return { dispose() { onDataCb = null; } }; },
      onExit(cb) { onExitCb = cb; return { dispose() { onExitCb = null; } }; },
      kill() { const cb = onExitCb; onExitCb = null; cb?.({ exitCode: 0 }); },
      resize() {},
      push(text) { onDataCb?.(text); },
      writes,
    };
  }
  class FakeCodexHost extends PtyHost {
    sweepOrphanedDescendants(_rootPid) {}
    reapExitedDescendants(_rootPid) {} async probeRootSurvival(_rootPid, _sessionId) { return { foundAlive: false, identityConfirmed: false, enumerationFailed: false }; }
    constructor(events) { super(events); this.fakeCodexPtys = new Map(); }
    createCodexPty(opts) {
      const fake = makeFakeCodexPty();
      this.fakeCodexPtys.set(opts.sessionId, fake);
      return fake;
    }
  }
  const host3 = new FakeCodexHost({
    onEngineSessionId() {}, onContextStats() {}, onRateLimited() {},
    onBusy() { throw new Error("simulated SQLITE_BUSY (onBusy persistence)"); },
    onExit() {}, onCodexSubmitUnconfirmed() {},
  });
  const SID_C = "sbpnf-sess-c-codex";
  try {
    host3.spawn({
      sessionId: SID_C, cwd: "/fake/codex/worktree", permission: {}, geometry: { cols: 120, rows: 40 },
      sessionEnv: {}, role: "worker", harness: "codex",
    });
    const fakeC = host3.fakeCodexPtys.get(SID_C);
    // Same boot-readiness chunk codex-submit-marker-in-gap.mjs uses — latches bootReady SYNCHRONOUSLY
    // (ready marker + model-loaded + no pending trust dialog), so the enqueue below delivers immediately
    // via submitCodex rather than queuing behind boot.
    fakeC.push("OpenAI Codex (v1.2.3)\n│ model:     gpt-6-astra medium                          │\n›  Ask Codex to do anything\n");

    let enqueueErrorC;
    let resultC;
    try {
      resultC = host3.enqueueStdin(SID_C, "WEBHOOK_NUDGE_TEXT_CODEX", "system", undefined, undefined, "agent");
    } catch (e) {
      enqueueErrorC = e;
    }
    check("(C) codex path: enqueueStdin does NOT throw even though submitCodex's setCodexBusy(true,\"submit\") fails", !enqueueErrorC);
    check("(C) ...and it still reports delivered", resultC?.delivered === true);
  } finally {
    try { host3.stop(SID_C, "hard"); } catch { /* ignore */ }
  }
}

// ===================== (D) structural pin: persistBusy is the ONLY direct caller of events.onBusy( =====
// AST-BASED (TypeScript compiler API), never a source-TEXT/grep scan — a text scan would (a) flip on a
// COMMENT merely mentioning `events.onBusy(`, and (b) sit outside what the reduced merge gate's
// CHANGED_TS_TEXT_SCANNER_REPO_PATHS list is FOR (that list exists for genuine text scanners; an AST
// scanner reads syntax, not text, so a comment-only host.ts diff correctly can't fool it and it has no
// business on that list). Independent of the dynamic cases above — catches a future THIRD onBusy callout
// (a new harness, a new call site) that bypasses the shared helper even if nobody thinks to extend
// (A)/(B)/(C) for it.
{
  /** Is `node` a call `<expr>.events.onBusy(...)`? Matches on the CALLEE'S SHAPE (a property access named
   *  "onBusy" on an object that is itself a property access named "events") — never on source text, so a
   *  comment or string literal containing the same characters can never match. */
  function isDirectEventsOnBusyCall(node) {
    if (!ts.isCallExpression(node)) return false;
    if (!ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== "onBusy") return false;
    const obj = node.expression.expression;
    return ts.isPropertyAccessExpression(obj) && obj.name.text === "events";
  }

  /** Walk up from `node` to the nearest enclosing MethodDeclaration and return its name, or null. */
  function enclosingMethodName(node) {
    let cur = node.parent;
    while (cur) {
      if (ts.isMethodDeclaration(cur) && cur.name && ts.isIdentifier(cur.name)) return cur.name.text;
      cur = cur.parent;
    }
    return null;
  }

  /** Parse `sourceText` and return every direct `<expr>.events.onBusy(...)` CallExpression found, each
   *  tagged with its enclosing method's name (or null if not inside one). */
  function findDirectOnBusyCalls(sourceText) {
    const sf = ts.createSourceFile("scan.ts", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const hits = [];
    const visit = (n) => {
      if (isDirectEventsOnBusyCall(n)) hits.push({ line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, method: enclosingMethodName(n) });
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return hits;
  }

  // POISON-COMMENT NEGATIVE CONTROL — checked FIRST, before trusting this scan's verdict on the real file.
  // A bare source-text/grep scan (the very thing this AST approach replaces) WOULD match this synthetic
  // snippet; the AST scan must not, since neither occurrence is a real CallExpression.
  const poisonSnippet = [
    "class Poison {",
    "  // a comment mentioning this.events.onBusy( must never be treated as a real call",
    "  method() {",
    "    /* this.events.onBusy(x, y) — also inside a block comment */",
    "    const s = \"this.events.onBusy(x, y) — also inside a string literal\";",
    "    this.somethingUnrelated();",
    "  }",
    "}",
  ].join("\n");
  check("(D) POISON CONTROL: a comment/string mentioning 'events.onBusy(' does NOT flip the AST scan (proves this is AST-based, not source-text matching)",
    findDirectOnBusyCalls(poisonSnippet).length === 0);

  // POSITIVE CONTROL: the same kind of snippet, but with a GENUINE call, must be found — an empty result
  // from a broken matcher would otherwise look identical to a clean file (the same discipline the poison
  // control above exists to satisfy, in the other direction).
  const realCallSnippet = [
    "class Real {",
    "  persistBusy(id, busy) {",
    "    try {",
    "      this.events.onBusy(id, busy);",
    "    } catch (e) { /* ignore */ }",
    "  }",
    "}",
  ].join("\n");
  const realHits = findDirectOnBusyCalls(realCallSnippet);
  check("(D) POSITIVE CONTROL: a genuine this.events.onBusy(...) call IS found by the same scan", realHits.length === 1 && realHits[0].method === "persistBusy");

  // THE REAL CHECK, now trusted by the two controls above: scan the actual host.ts source.
  const hostSrc = fs.readFileSync(new URL("../src/pty/host.ts", import.meta.url), "utf8");
  const realFileHits = findDirectOnBusyCalls(hostSrc);
  check("(D) exactly ONE direct `<expr>.events.onBusy(...)` CallExpression exists in host.ts (AST count, not a text match)", realFileHits.length === 1);
  check("(D) ...and it is inside `persistBusy`'s own method body (setBusy/setCodexBusy call persistBusy, never events.onBusy directly)",
    realFileHits.length === 1 && realFileHits[0].method === "persistBusy");
}

try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — the events.onBusy persistence callout is non-fatal on BOTH harnesses, through the ONE shared persistBusy helper: a DB failure there never makes a genuinely successful claude spawn (PtyHost.spawn()'s own spawn-startup-prompt busy set, called after createPty returns), a genuinely successful claude idle-path delivery (submit()'s trailing busy set), or a codex idle-path delivery (submitCodex's leading busy set) look like a failure — while each caller's in-memory busy flip stays unconditional. A structural pin (AST-based, with a stated shape limit) confirms persistBusy remains the ONLY direct caller of events.onBusy( in host.ts, catching a future bypass even without a matching dynamic case."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
