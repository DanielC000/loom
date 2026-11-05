import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// The ssh_exec risky-command HOLD (design record a3d5c7f4): a command matching the connection's risky list does
// NOT run; the daemon files an owner `permission` Request scoped to the EXACT connection + command, and the
// identical command later runs only if that Request is authorized and not lapsed. Fully hermetic: a REAL Db on
// a temp LOOM_HOME, the REAL envelope key, the REAL buildServer (app.inject) for the answer-route nudge, and a
// STUB runner (a counter shown able to move) so "never executed" is a measured zero.
//
// Run: 1) build (turbo builds shared first), 2) node test/ssh-risky-hold.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `lsh-${process.pid}`);
fs.rmSync(tmpHome, { recursive: true, force: true }); // a recycled pid must not inherit a prior run's db
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { createSshConnection } = await import("../dist/connections/store.js");
const { performSshExec, __resetSshRateLimitState } = await import("../dist/connections/sshExec.js");
const { computeHostKeyFingerprint } = await import("../dist/connections/ssh.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { generateParseableEd25519 } = await import("./_ssh-test-keys.mjs");
const { buildQuestionAsk, amendQuestionForAgent, resolveQuestionForAgent, cancelQuestionForAgent, pullQuestionsForAgent } = await import("../dist/mcp/questionTool.js");
const ssh2 = (await import("ssh2")).default;

const clientKey = generateParseableEd25519(ssh2.utils);
const hostKey = generateParseableEd25519(ssh2.utils);
const HOST_FP = computeHostKeyFingerprint(ssh2.utils.parseKey(hostKey.public).getPublicSSH());
const PORT = 2222;

try {
  const db = new Db(path.join(tmpHome, "h.db"));
  const now = new Date().toISOString();
  const P = "pHold";
  db.insertProject({ id: P, name: "Hold", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
  db.insertTask({ id: "task-hold-1", projectId: P, title: "feat(x): the card", body: "", columnKey: "in_progress", position: 1, priority: "p2", createdAt: now, updatedAt: now });
  db.insertAgent({ id: "agA", projectId: P, name: "WorkerA", startupPrompt: "", position: 0 });
  db.insertAgent({ id: "agB", projectId: P, name: "WorkerB", startupPrompt: "", position: 1 });
  const mkSession = (id, agentId, extra = {}) => db.insertSession({
    id, projectId: P, agentId, engineSessionId: `eng-${id}`, title: null, cwd: tmpHome, processState: "live", resumability: "resumable",
    busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", taskId: "task-hold-1", ...extra,
  });
  db.insertAgent({ id: "agM", projectId: P, name: "Mgr", startupPrompt: "", position: 2 });
  mkSession("W1", "agA");
  mkSession("W2", "agA", { createdAt: new Date(Date.now() + 1000).toISOString() }); // a CONCURRENT sibling on the same agent (not a recycle)
  mkSession("W3", "agA", { createdAt: new Date(Date.now() + 2000).toISOString(), recycledFrom: "W1" }); // W1's recycle successor
  mkSession("X1", "agB", { taskId: null });
  mkSession("M1", "agM", { role: "manager", taskId: null }); // a manager-shaped session that holds an ssh grant

  const ALL = []; // every connection id any session of this test is granted (mk appends)
  const mk = (name, extra = {}) => {
    const c = createSshConnection(db, { name, host: "127.0.0.1", port: PORT, user: "loom", privateKey: clientKey.private, hostKeyFingerprint: HOST_FP, readOnly: false, ...extra });
    ALL.push(c.id);
    return c;
  };
  const rw = mk("RW box");
  const ro = mk("RO box", { readOnly: true });
  const al = mk("AL box", { commandAllowlist: [{ kind: "prefix", pattern: "ls" }] });
  const GUARD = { requestTimeoutMs: 5000, maxResponseBytes: 100000, rateLimitMax: 1000, rateLimitWindowMs: 60000 };
  const calls = [];
  const runner = async (input) => { calls.push(input.command); return { ok: true, stdout: "done\n", stderr: "", exitCode: 0, truncated: false }; };
  let clock = Date.now();
  const run = (sessionId, conn, command, extra = {}) =>
    performSshExec({ db, sessionId, projectId: P, guard: GUARD, runner, now: () => clock, ...extra }, ALL, { connectionId: conn.id, command });
  const questions = () => db.db.prepare("SELECT * FROM questions WHERE type = 'permission' ORDER BY created_at, rowid").all();
  const outcomes = () => db.db.prepare("SELECT * FROM orchestration_events WHERE kind = 'ssh_command_run' ORDER BY seq").all()
    .map((r) => JSON.parse(r.detail_json)).filter((d) => d.phase === "outcome");
  // The per-connection pending cap would otherwise couple the sections; the cap has its own section (9).
  const clearPending = () => { for (const r of db.db.prepare("SELECT id FROM questions WHERE state = 'pending' AND type = 'permission'").all()) db.cancelQuestion(r.id, { reason: "test cleanup", cancelledBy: "human" }); };
  // `via` defaults to "human": the stamp the REAL answer route writes. Pass `null` to model every non-human writer.
  const answer = (id, decision, scope = "once", expiresAt = null, via = "human") =>
    db.answerQuestion(id, { chosenOption: decision, note: null, answeredAt: new Date().toISOString(), decidedScope: decision === "authorize" ? scope : null, decidedExpiresAt: expiresAt, answeredVia: via });
  const enq = [];
  const stubDeps = {};
  const app = await buildServer({ db, pty: { enqueueStdin: (...a) => { enq.push(a); return { delivered: true }; } }, sessions: stubDeps, mcp: stubDeps, orchMcp: stubDeps, platformMcp: stubDeps, auditMcp: stubDeps, userAuditMcp: stubDeps, setupMcp: stubDeps, runMcp: stubDeps, control: stubDeps, usageStatus: stubDeps });

  // ============ 1. a matching command is HELD: never executes before an approved answer ============
  const h1 = await run("W1", rw, "reboot");
  check("1a risky command: not ok, status awaiting-owner-approval, reason risky-pattern-requires-approval, request id returned",
    h1.ok === false && h1.status === "awaiting-owner-approval" && h1.reason === "risky-pattern-requires-approval" && typeof h1.approvalRequestId === "string");
  check("1b the runner (the wire) was NEVER called", calls.length === 0);
  const q1 = questions();
  check("1c exactly ONE Request was filed, type permission, state pending", q1.length === 1 && q1[0].type === "permission" && q1[0].state === "pending" && q1[0].id === h1.approvalRequestId);
  check("1d attribution: owned and filed by the calling worker session, linked to its task, in its project",
    q1[0].session_id === "W1" && q1[0].filed_by_session_id === "W1" && q1[0].task_id === "task-hold-1" && q1[0].project_id === P);
  const body1 = q1[0].body;
  check("1e owner text names the connection, host:port, remote user and the exact command in a code span",
    body1.includes(JSON.stringify("RW box")) && body1.includes(`\`127.0.0.1:${PORT}\``) && body1.includes("`loom`") && body1.includes("`reboot`"));
  check("1f owner text says approving runs that exact text once (or until expiry if standing)", /exactly that command text once/.test(body1) && /standing grant/.test(body1) && /expires/.test(body1));
  check("1g the binding is stored in permission_action (connection id + exact command), and the pin itself is NOT in any owner-visible text",
    q1[0].permission_action.includes(`connection=${rw.id} `) && q1[0].permission_action.endsWith(`command="reboot"`) && ![q1[0].title, q1[0].body, q1[0].permission_action].some((t) => t.includes(HOST_FP)));
  check("1h audited: outcome row is `held` with the request id and the exact command", outcomes().some((d) => d.outcome === "held" && d.approvalRequestId === h1.approvalRequestId && d.command === "reboot" && d.connectionId === rw.id));

  // ============ 2. re-calling while pending does not spam the inbox ============
  const h2 = await run("W1", rw, "reboot");
  check("2 a repeat call while pending returns the SAME request id and files nothing new, still not run", h2.approvalRequestId === h1.approvalRequestId && questions().length === 1 && calls.length === 0);

  // ============ 3. authorized (once) -> runs; spent -> a new hold ============
  answer(h1.approvalRequestId, "authorize", "once");
  const r3 = await run("W1", rw, "reboot");
  check("3a after an authorize answer the IDENTICAL command runs (runner called once with that exact text)", r3.ok === true && calls.length === 1 && calls[0] === "reboot");
  check("3b the once-grant is claimed (state consumed) and the run is audited with the approval id + scope", db.getQuestion(h1.approvalRequestId).state === "consumed"
    && outcomes().some((d) => d.outcome === "ran" && d.approvalRequestId === h1.approvalRequestId && d.approvalScope === "once"));
  const h3 = await run("W1", rw, "reboot");
  check("3c a SPENT once-approval does not run again: the next identical call files a NEW hold", h3.ok === false && h3.status === "awaiting-owner-approval" && h3.approvalRequestId !== h1.approvalRequestId && calls.length === 1);

  // ============ 4. a changed command after approval is refused (no bait-and-switch) ============
  answer(h3.approvalRequestId, "authorize", "once");
  const bait = ["reboot now", "sudo reboot", "REBOOT", "reboot  now", "shutdown", "/sbin/reboot"];
  for (const cmd of bait) {
    const r = await run("W1", rw, cmd);
    check(`4 approved "reboot"; changed text ${JSON.stringify(cmd)} is NOT run (held for its own approval)`, r.ok === false && r.status === "awaiting-owner-approval" && !calls.includes(cmd));
    db.cancelQuestion(r.approvalRequestId, { reason: "test cleanup", cancelledBy: "human" });
  }
  check("4 none of the changed texts reached the runner", calls.length === 1);
  const r4 = await run("W1", rw, "reboot");
  check("4 (flip control) the exactly-approved text still runs afterwards — the approval was never widened or burned by the others", r4.ok === true && calls.length === 2 && calls[1] === "reboot");

  // ============ 5. denied / lapsed refuse, then are acknowledged ============
  clearPending();
  const h5 = await run("W1", rw, "rm -rf /srv/x");
  answer(h5.approvalRequestId, "deny");
  const d5 = await run("W1", rw, "rm -rf /srv/x");
  check("5a a DENIED approval refuses with ssh-approval-denied and does not run", d5.ok === false && d5.reason === "ssh-approval-denied" && !calls.includes("rm -rf /srv/x"));
  check("5b audited as refused/ssh-approval-denied with the request id", outcomes().some((d) => d.outcome === "refused" && d.reason === "ssh-approval-denied" && d.approvalRequestId === h5.approvalRequestId));
  const qCountDeny = questions().length;
  const d5again = await run("W1", rw, "rm -rf /srv/x");
  check("5c DENY COOLDOWN: an identical call is refused again (ssh-approval-denied) and files NOTHING", d5again.reason === "ssh-approval-denied" && questions().length === qCountDeny && !calls.includes("rm -rf /srv/x"));
  check("5c2 the denial text names the cooldown end", /until \d{4}-\d{2}-\d{2}T/.test(d5again.error) && /clears the denial/.test(d5again.error));
  check("5c3 a deny is NOT acknowledged: the row stays answered", db.getQuestion(h5.approvalRequestId).state === "answered");
  clock += 25 * 3600_000; // past the 24h cooldown
  const d5b = await run("W1", rw, "rm -rf /srv/x");
  clock -= 25 * 3600_000;
  check("5c4 after 24h the deny no longer governs: a fresh hold is filed", d5b.status === "awaiting-owner-approval" && d5b.approvalRequestId !== h5.approvalRequestId);
  // owner CLEAR route ends a deny early
  const hClear = await run("W1", rw, "rm -rf /srv/clearme");
  answer(hClear.approvalRequestId, "deny");
  check("5c5 (control) before the clear the deny governs", (await run("W1", rw, "rm -rf /srv/clearme")).reason === "ssh-approval-denied");
  const clr = await app.inject({ method: "POST", url: `/api/questions/${hClear.approvalRequestId}/clear-ssh-approval` });
  check("5c6 the human clear route answers 200 and the row becomes cancelled", clr.statusCode === 200 && db.getQuestion(hClear.approvalRequestId).state === "cancelled");
  const afterClear = await run("W1", rw, "rm -rf /srv/clearme");
  check("5c7 after a clear, an identical call files a FRESH hold", afterClear.status === "awaiting-owner-approval" && afterClear.approvalRequestId !== hClear.approvalRequestId);
  check("5c8 the clear is audited (approval-cleared event naming the request)", db.db.prepare("SELECT detail_json FROM orchestration_events WHERE kind = 'ssh_command_run'").all().some((r) => { const d = JSON.parse(r.detail_json); return d.phase === "approval-cleared" && d.approvalRequestId === hClear.approvalRequestId; }));
  check("5c9 clearing a still-PENDING hold is refused (409) and an unknown id is 404",
    (await app.inject({ method: "POST", url: `/api/questions/${afterClear.approvalRequestId}/clear-ssh-approval` })).statusCode === 409
    && (await app.inject({ method: "POST", url: `/api/questions/no-such-question/clear-ssh-approval` })).statusCode === 404);
  db.insertQuestion({ id: "q-generic", sessionId: "W1", filedBySessionId: "W1", projectId: P, type: "permission", title: "Other grant", body: "b", options: null, recommendation: null, taskId: null, permissionAction: "do something else", state: "pending", chosenOption: null, note: null, createdAt: now, answeredAt: null, consumedAt: null, attachments: [] });
  check("5c10 clearing a NON-ssh Request is refused (400)", (await app.inject({ method: "POST", url: "/api/questions/q-generic/clear-ssh-approval" })).statusCode === 400);

  const soon = new Date(clock + 3600_000).toISOString();
  answer(d5b.approvalRequestId, "authorize", "standing", soon);
  const s1 = await run("W1", rw, "rm -rf /srv/x");
  const s2 = await run("W1", rw, "rm -rf /srv/x");
  check("5d a STANDING grant is reusable until it expires (ran twice, request stays answered)", s1.ok && s2.ok && calls.filter((c) => c === "rm -rf /srv/x").length === 2 && db.getQuestion(d5b.approvalRequestId).state === "answered");
  clock += 2 * 3600_000; // past the expiry
  const lapsed = await run("W1", rw, "rm -rf /srv/x");
  check("5e a LAPSED approval refuses with ssh-approval-lapsed and does not run", lapsed.ok === false && lapsed.reason === "ssh-approval-lapsed" && calls.filter((c) => c === "rm -rf /srv/x").length === 2);
  check("5f audited as refused/ssh-approval-lapsed", outcomes().some((d) => d.outcome === "refused" && d.reason === "ssh-approval-lapsed" && d.approvalRequestId === d5b.approvalRequestId));
  const afterLapse = await run("W1", rw, "rm -rf /srv/x");
  check("5g after a lapse report, the next call files a fresh hold", afterLapse.status === "awaiting-owner-approval" && afterLapse.approvalRequestId !== d5b.approvalRequestId);

  // an authorize answer with an already-past expiry written directly (not via the clock) also lapses
  const h5h = await run("W1", rw, "pkill nginx");
  answer(h5h.approvalRequestId, "authorize", "standing", new Date(clock - 1000).toISOString());
  const l2 = await run("W1", rw, "pkill nginx");
  check("5h a standing grant whose expiry is already in the past is lapsed, not run", l2.reason === "ssh-approval-lapsed" && !calls.includes("pkill nginx"));

  // ============ 6. a cancelled/dismissed Request is not an approval ============
  const h6 = await run("W1", rw, "kill 1234");
  db.cancelQuestion(h6.approvalRequestId, { reason: "dismissed", cancelledBy: "human" });
  const r6 = await run("W1", rw, "kill 1234");
  check("6 a cancelled Request does not approve: the call files a new hold, nothing runs", r6.status === "awaiting-owner-approval" && r6.approvalRequestId !== h6.approvalRequestId && !calls.includes("kill 1234"));

  // ============ 7. editing the connection invalidates an approval (address/user/pin are in the binding) ============
  for (const [label, sql] of [
    ["port", (id) => db.db.prepare("UPDATE connections SET ssh_port = ? WHERE id = ?").run(PORT + 1, id)],
    ["user", (id) => db.db.prepare("UPDATE connections SET ssh_user = ? WHERE id = ?").run("other", id)],
    ["pin", (id) => db.db.prepare("UPDATE connections SET ssh_host_key_fingerprint = ? WHERE id = ?").run("SHA256:" + "A".repeat(43), id)],
  ]) {
    const c = mk(`EDIT ${label}`);
    const cmd = `reboot ${label}`;
    const hh = await run("W1", c, cmd);
    answer(hh.approvalRequestId, "authorize", "once");
    const before = calls.length;
    sql(c.id);
    const rr = await run("W1", c, cmd);
    check(`7 approval then the connection's ${label} is edited: the command is NOT run (new hold)`, rr.ok === false && rr.status === "awaiting-owner-approval" && rr.approvalRequestId !== hh.approvalRequestId && calls.length === before);
  }

  // ============ 8. approval never widens read-only or an allowlist; nothing is filed ============
  const qBefore = questions().length;
  const ro1 = await run("W1", ro, "systemctl restart nginx");
  const al1 = await run("W1", al, "reboot");
  check("8a risky command on a READ-ONLY connection is refused not-read-only-verb and files NO Request", ro1.reason === "not-read-only-verb" && questions().length === qBefore);
  check("8b risky command outside an ALLOWLIST is refused not-in-allowlist and files NO Request", al1.reason === "not-in-allowlist" && questions().length === qBefore);
  const al2 = await run("W1", al, "ls reboot");
  check("8c (flip control) a risky command INSIDE the allowlist is held", al2.status === "awaiting-owner-approval");

  // ============ 9. per-connection pending cap (5) ============
  const capConn = mk("CAP box");
  const ids = [];
  for (let i = 0; i < 5; i++) { const r = await run("W1", capConn, `reboot ${i}`); ids.push(r.approvalRequestId); }
  const nBefore = questions().length;
  const sixth = await run("W1", capConn, "reboot 5");
  check("9a the 6th pending hold on one connection is refused ssh-approval-cap", sixth.ok === false && sixth.reason === "ssh-approval-cap");
  check("9b the refusal names the cap and the OLDEST pending request id", sixth.error.includes("cap 5") && sixth.error.includes(ids[0]));
  check("9c nothing was filed and nothing ran", questions().length === nBefore && !calls.includes("reboot 5"));
  const otherConn = await run("W1", rw, "reboot cap-other");
  check("9d (control) the cap is per connection: another connection still holds normally", otherConn.status === "awaiting-owner-approval");
  db.cancelQuestion(ids[0], { reason: "x", cancelledBy: "human" });
  const seventh = await run("W1", capConn, "reboot 5");
  check("9e (control) freeing a slot lets a new hold be filed", seventh.status === "awaiting-owner-approval");

  // ============ 10. binding: the FILING session or its recycle chain on the SAME task; never a sibling on one agent ============
  clearPending();
  const h10 = await run("W1", rw, "docker rm web");
  const sibling = await run("W2", rw, "docker rm web");
  check("10a a concurrent SIBLING on the same agent does not see W1's pending hold: it files its own", sibling.status === "awaiting-owner-approval" && sibling.approvalRequestId !== h10.approvalRequestId);
  answer(h10.approvalRequestId, "authorize", "once");
  const sib2 = await run("W2", rw, "docker rm web");
  check("10b the sibling cannot redeem W1's authorized grant (still its own pending hold, nothing ran)", sib2.ok !== true && sib2.approvalRequestId === sibling.approvalRequestId && !calls.includes("docker rm web"));
  const other = await run("X1", rw, "docker rm web");
  check("10c a DIFFERENT agent files its own hold and cannot redeem it either", other.ok !== true && other.approvalRequestId !== h10.approvalRequestId && !calls.includes("docker rm web"));
  const w3 = await run("W3", rw, "docker rm web");
  check("10d W1's RECYCLE successor on the same task redeems W1's grant", w3.ok === true && calls.includes("docker rm web") && db.getQuestion(h10.approvalRequestId).state === "consumed");
  mkSession("W4", "agA", { createdAt: new Date(Date.now() + 3000).toISOString(), recycledFrom: "W3", taskId: null }); // W1 -> W3 -> W4: in W1's chain, but on no task
  const h10b = await run("W1", rw, "docker rm web2");
  answer(h10b.approvalRequestId, "authorize", "once");
  const w4 = await run("W4", rw, "docker rm web2");
  check("10e a recycle successor on a DIFFERENT task (taskId differs) cannot redeem", w4.ok !== true && !calls.includes("docker rm web2"));
  const w1b = await run("W1", rw, "docker rm web2");
  check("10f (flip control) the filing session itself still redeems that grant", w1b.ok === true && calls.includes("docker rm web2"));

  // ============ 11. racing redemptions of ONE once-approval: exactly one runs ============
  const h11 = await run("W1", rw, "poweroff");
  answer(h11.approvalRequestId, "authorize", "once");
  const before11 = calls.filter((c) => c === "poweroff").length;
  const [a11, b11] = await Promise.all([run("W1", rw, "poweroff"), run("W3", rw, "poweroff")]);
  check("11 two concurrent calls on one once-approval: the wire is reached exactly once", calls.filter((c) => c === "poweroff").length === before11 + 1 && [a11, b11].filter((r) => r.ok === true).length === 1);

  // ============ 12. no key material anywhere ============
  const everything = JSON.stringify([questions(), outcomes()]);
  check("12 no private key text in any Request or audit row", !/PRIVATE KEY/.test(everything) && !everything.includes(clientKey.private.split("\n")[1] ?? "@@none@@"));

  // ============ 13. the answer route's nudge for the filing worker ============
  {
    clearPending();
    const holdFor = async (cmd) => (await run("W1", rw, cmd)).approvalRequestId;
    const idAuth = await holdFor("mkfs /dev/null");
    // a card deferred ON this exact Request: the answer nudge must still append the trigger pointer
    db.insertTask({ id: "task-deferred-1", projectId: P, title: "feat(x): waits", body: "", columnKey: "backlog", position: 2, priority: "p2", createdAt: now, updatedAt: now, deferred: true, deferredUntilEvent: { kind: "request-answered", key: idAuth } });
    const rAuth = await app.inject({ method: "POST", url: `/api/questions/${idAuth}/answer`, payload: { decision: "authorize", scope: "standing", expiresAt: new Date(clock + 86400_000).toISOString() } });
    const nAuth = enq.find((a) => a[5] === "agent" && a[6] === idAuth);
    check("13a authorize answers 200", rAuth.statusCode === 200);
    check("13b the filing worker gets the SPECIFIC nudge (tag, connection name, authorized, standing + expiry, IDENTICAL command)",
      !!nAuth && nAuth[1].startsWith("[loom:ssh-approval-answered]") && nAuth[1].includes(JSON.stringify("RW box")) && /authorized \(standing, expires /.test(nAuth[1]) && nAuth[1].includes("IDENTICAL command"));
    check("13c the nudge says nothing about question_pull and carries no pin/host key", !/question_pull/.test(nAuth?.[1] ?? "") && !(nAuth?.[1] ?? "").includes(HOST_FP));
    check("13d it is addressed to the FILING session W1 — not the live sibling W2 or successor W3 on the same agent", nAuth?.[0] === "W1");
    check("13d2 the answer is stamped answeredVia:human by the real route", db.getQuestion(idAuth).answeredVia === "human");
    check("13d3 the ssh nudge STILL carries the request-answered deferred-trigger pointer", /\[loom:deferred-trigger\] request /.test(nAuth?.[1] ?? "") && (nAuth?.[1] ?? "").includes("task-deferred-1"));
    const runAfterRoute = await run("W1", rw, "mkfs /dev/null");
    check("13d4 end to end: a standing grant answered through the REAL route redeems", runAfterRoute.ok === true && calls.includes("mkfs /dev/null"));
    const idNoExp = await holdFor("mkfs /dev/null9");
    const rNoExp = await app.inject({ method: "POST", url: `/api/questions/${idNoExp}/answer`, payload: { decision: "authorize", scope: "standing" } });
    check("13d5 a STANDING ssh grant without expiresAt is rejected (400) and the row stays pending", rNoExp.statusCode === 400 && db.getQuestion(idNoExp).state === "pending");
    const rOnce = await app.inject({ method: "POST", url: `/api/questions/${idNoExp}/answer`, payload: { decision: "authorize", scope: "once" } });
    check("13d6 (control) a once grant needs no expiry", rOnce.statusCode === 200);
    db.insertQuestion({ id: "q-generic-standing", sessionId: "W1", filedBySessionId: "W1", projectId: P, type: "permission", title: "G", body: "b", options: null, recommendation: null, taskId: null, permissionAction: "other thing", state: "pending", chosenOption: null, note: null, createdAt: now, answeredAt: null, consumedAt: null, attachments: [] });
    const rGen = await app.inject({ method: "POST", url: "/api/questions/q-generic-standing/answer", payload: { decision: "authorize", scope: "standing" } });
    check("13d7 (control) a NON-ssh standing grant without expiry is still accepted (200)", rGen.statusCode === 200);
    const idDeny = await holdFor("mkfs /dev/zero");
    await app.inject({ method: "POST", url: `/api/questions/${idDeny}/answer`, payload: { decision: "deny" } });
    const nDeny = enq.find((a) => a[6] === idDeny);
    check("13e a denial nudge says denied and that the exact command will not run", !!nDeny && /was denied/.test(nDeny[1]) && /will not run/.test(nDeny[1]));
    // filer exited but its recycle successor W3 is live (W2 is a live non-chain sibling): the nudge goes to W3
    db.db.prepare("UPDATE sessions SET process_state = 'exited' WHERE id = 'W1'").run();
    const idSucc = await holdFor("mkfs /dev/succ");
    await app.inject({ method: "POST", url: `/api/questions/${idSucc}/answer`, payload: { decision: "authorize" } });
    check("13h filer W1 exited: the nudge goes to its live recycle successor W3, never the sibling W2", enq.find((a) => a[6] === idSucc)?.[0] === "W3");
    // filing session AND its chain gone: dropped silently even though the sibling W2 is live; answer still persists
    db.db.prepare("UPDATE sessions SET process_state = 'exited' WHERE id IN ('W3', 'W4')").run();
    const idGone = await holdFor("mkfs /dev/null2");
    const enqBefore = enq.length;
    const rGone = await app.inject({ method: "POST", url: `/api/questions/${idGone}/answer`, payload: { decision: "authorize" } });
    check("13f filing session + chain gone (sibling W2 still live): answer persists (200, answered) and NO nudge is sent to anyone", rGone.statusCode === 200 && db.getQuestion(idGone).state === "answered" && enq.length === enqBefore);
    db.db.prepare("UPDATE sessions SET process_state = 'live' WHERE agent_id = 'agA'").run();
    // control: an ordinary (non-ssh) permission question keeps the generic nudge
    db.insertQuestion({ id: "q-generic-2", sessionId: "W1", filedBySessionId: "W1", projectId: P, type: "permission", title: "Other grant 2", body: "b", options: null, recommendation: null, taskId: null, permissionAction: "do something else 2", state: "pending", chosenOption: null, note: null, createdAt: now, answeredAt: null, consumedAt: null, attachments: [] });
    await app.inject({ method: "POST", url: "/api/questions/q-generic-2/answer", payload: { decision: "authorize" } });
    const nGen = enq.find((a) => a[6] === "q-generic-2");
    check("13g (control) a non-ssh permission answer keeps the generic `question_pull` nudge", !!nGen && /question_pull/.test(nGen[1]) && !/ssh-approval-answered/.test(nGen[1]));
  }

  // ============ 14. NO agent path can authorize, ask for, amend or consume a hold ============
  {
    clearPending();
    const ctxM = { sessionId: "M1", projectId: P, db, role: "manager" };
    // (a) a manager-shaped session with an ssh grant holds a command, then tries to question_resolve it itself
    const hm = await run("M1", rw, "reboot m1");
    check("14a the manager-shaped session's risky command is held", hm.status === "awaiting-owner-approval");
    const resolved = resolveQuestionForAgent(db, "M1", hm.approvalRequestId, "authorize", "owner said yes", false);
    check("14b question_resolve on its OWN ssh hold is refused", "error" in resolved && /owner in the decision inbox/.test(resolved.error));
    check("14c the hold is still pending and answeredVia is null", db.getQuestion(hm.approvalRequestId).state === "pending" && !db.getQuestion(hm.approvalRequestId).answeredVia);
    const again = await run("M1", rw, "reboot m1");
    check("14d the next ssh_exec still does not run (same pending hold)", again.ok !== true && again.approvalRequestId === hm.approvalRequestId && !calls.includes("reboot m1"));
    // (b) control: question_resolve works on an ordinary pending permission ask by the same session
    db.insertQuestion({ id: "q-m1-generic", sessionId: "M1", filedBySessionId: "M1", projectId: P, type: "permission", title: "G", body: "b", options: null, recommendation: null, taskId: null, permissionAction: "ordinary", state: "pending", chosenOption: null, note: null, createdAt: now, answeredAt: null, consumedAt: null, attachments: [] });
    const okResolve = resolveQuestionForAgent(db, "M1", "q-m1-generic", "authorize", "owner said yes", false);
    check("14e (control) the same resolve path DOES work for an ordinary permission ask", okResolve.resolved === true);
    check("14e2 the marker stays NULL on a question_resolve answer (agent path)", !db.getQuestion("q-m1-generic").answeredVia);
    db.insertQuestion({ id: "q-m1-decision", sessionId: "M1", filedBySessionId: "M1", projectId: P, type: "decision", title: "D", body: "b", options: ["a", "b"], recommendation: null, taskId: null, permissionAction: null, state: "pending", chosenOption: null, note: null, createdAt: now, answeredAt: null, consumedAt: null, attachments: [] });
    await app.inject({ method: "POST", url: "/api/questions/q-m1-decision/answer", payload: { chosenOption: "a" } });
    check("14e3 the marker is generic: the REST route also stamps it on a decision answer", db.getQuestion("q-m1-decision").answeredVia === "human");
    db.insertQuestion({ id: "q-m1-credential", sessionId: "M1", filedBySessionId: "M1", projectId: P, type: "credential", title: "C", body: "b", options: null, recommendation: null, taskId: null, permissionAction: null, credentialEnvVar: "SOME_TOKEN", state: "pending", chosenOption: null, note: null, createdAt: now, answeredAt: null, consumedAt: null, attachments: [] });
    const credRes = await app.inject({ method: "POST", url: "/api/questions/q-m1-credential/answer", payload: { secret: "not-a-real-secret-value" } });
    check("14e4 a credential answer through the REST route carries the human stamp too (answered, 200)", credRes.statusCode === 200 && db.getQuestion("q-m1-credential").state === "answered" && db.getQuestion("q-m1-credential").answeredVia === "human");
    // (c) a row answered by ANY non-human writer never authorizes, even with chosenOption=authorize
    const hn = await run("M1", rw, "reboot m1-nonhuman");
    answer(hn.approvalRequestId, "authorize", "once", null, null);
    const nonHuman = await run("M1", rw, "reboot m1-nonhuman");
    check("14f an authorize answered WITHOUT the human marker does not run (a fresh hold is filed instead)", nonHuman.ok !== true && !calls.includes("reboot m1-nonhuman"));
    const hn2 = await run("M1", rw, "reboot m1-nonhuman-standing");
    answer(hn2.approvalRequestId, "authorize", "standing", new Date(clock + 3600_000).toISOString(), null);
    const nonHuman2 = await run("M1", rw, "reboot m1-nonhuman-standing");
    check("14f2 a STANDING authorize with a future expiry but WITHOUT the human marker does not run either", nonHuman2.ok !== true && !calls.includes("reboot m1-nonhuman-standing"));
    // (d) question_ask refuses the reserved action prefix, in any spacing/case; the daemon's own filing is exempt
    const connAction = (extra = "") => `${extra}ssh_exec connection=${rw.id} target=loom@127.0.0.1:${PORT} pin=000000000000 command="reboot"`;
    for (const action of [connAction(), `  ${connAction()}`, connAction().toUpperCase()]) {
      const r = buildQuestionAsk({ type: "permission", title: "t", body: "b", action }, ctxM);
      check(`14g question_ask refuses a hand-built ssh action ${JSON.stringify(action.slice(0, 24))}…`, "error" in r && /reserved/.test(r.error));
    }
    check("14h (control) an ordinary permission action is accepted by question_ask", "question" in buildQuestionAsk({ type: "permission", title: "t", body: "b", action: "do a thing" }, ctxM));
    check("14i (control) the daemon-internal filer (daemonFiled) is exempt", "question" in buildQuestionAsk({ type: "permission", title: "t", body: "b", action: connAction() }, { ...ctxM, daemonFiled: true }));
    // (e) question_amend refuses a hold; works for an ordinary pending ask
    const am = amendQuestionForAgent(db, "M1", hm.approvalRequestId, { title: "approve everything" });
    check("14j question_amend refuses an ssh hold and leaves its title unchanged", "error" in am && db.getQuestion(hm.approvalRequestId).title !== "approve everything");
    // (f) question_pull / answered-stuck watchdog never consume or list an answered hold
    const hp = await run("M1", rw, "reboot m1-pull");
    answer(hp.approvalRequestId, "authorize", "once");
    db.insertQuestion({ id: "q-m1-answered", sessionId: "M1", filedBySessionId: "M1", projectId: P, type: "permission", title: "A", body: "b", options: null, recommendation: null, taskId: null, permissionAction: "ordinary2", state: "pending", chosenOption: null, note: null, createdAt: now, answeredAt: null, consumedAt: null, attachments: [] });
    answer("q-m1-answered", "authorize", "once");
    const stuck = db.listAnsweredStuckQuestions(new Date(Date.now() + 1000).toISOString()).map((q) => q.id);
    check("14k the answered-stuck watchdog list skips the hold (and still lists an ordinary answered ask — control)", !stuck.includes(hp.approvalRequestId) && stuck.includes("q-m1-answered"));
    const pulled = pullQuestionsForAgent(db, "agM", new Date().toISOString());
    check("14l question_pull consumes the ordinary answered ask (control) but SKIPS the answered hold", pulled.consumedIds.includes("q-m1-answered") && !pulled.consumedIds.includes(hp.approvalRequestId));
    check("14m the hold is still 'answered' after the pull", db.getQuestion(hp.approvalRequestId).state === "answered");
    const afterPull = await run("M1", rw, "reboot m1-pull");
    check("14n the pulled-past hold is still redeemable: the command runs", afterPull.ok === true && calls.includes("reboot m1-pull"));
    const hp2 = await run("M1", rw, "reboot m1-pull2");
    answer(hp2.approvalRequestId, "authorize", "once");
    const legacy = db.pullAnsweredQuestions("M1", new Date().toISOString());
    check("14o the per-session pull also skips the hold", !legacy.some((q) => q.id === hp2.approvalRequestId) && db.getQuestion(hp2.approvalRequestId).state === "answered");
    // the atomic claim is a SECOND, independent line of defence: it refuses a non-human row on its own
    const hc1 = await run("M1", rw, "reboot m1-claim-a");
    answer(hc1.approvalRequestId, "authorize", "once", null, null);
    check("14q the claim itself refuses an answered row without the human marker", db.claimApprovedQuestion(hc1.approvalRequestId, "authorize", new Date().toISOString()) === false && db.getQuestion(hc1.approvalRequestId).state === "answered");
    const hc2 = await run("M1", rw, "reboot m1-claim-b");
    answer(hc2.approvalRequestId, "authorize", "once");
    check("14r (control) the same claim succeeds on a human-answered row", db.claimApprovedQuestion(hc2.approvalRequestId, "authorize", new Date().toISOString()) === true);
    const cancelOwn = cancelQuestionForAgent(db, "M1", "q-none", undefined);
    check("14p (sanity) cancel of an unknown id still just errors", "error" in cancelOwn);
  }
  await app.close?.();

  __resetSshRateLimitState();
  db.close();
} catch (err) {
  console.log(`FAIL  uncaught: ${err?.stack ?? err}`);
  failures++;
}
console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
setTimeout(() => process.exit(process.exitCode), 50).unref();
