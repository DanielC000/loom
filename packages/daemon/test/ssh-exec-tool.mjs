import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// The `ssh_exec` MCP tool (design record a3d5c7f4). SECURITY-CRITICAL, fully hermetic: a REAL Db on a temp
// LOOM_HOME + the real envelope key + the REAL TaskMcpRouter / SessionService, with a THROWAWAY loopback
// `ssh2.Server` (127.0.0.1, throwaway host + client keys generated in this process) for the paths that
// really run a command. Policy / audit / rate-limit scenarios call `performSshExec` directly with a stub
// `runner` seam so "the wire was never touched" is a counter that is shown able to move (see section 1).
//
// Covers: registration on the SESSION row (agent-row-only grant registers, a sibling agent on the SAME
// profile without it does not, revoke removes it); a permitted command runs on a loopback server and is
// audited with its exit code; read-only / allowlist / risky refusals are refused AND audited AND never
// reach the wire; every shell-syntax bypass shape is refused; length cap; ReDoS bounded without starving the
// event loop; host-shape validation; auth-refused vs unreachable surfaced distinctly; per-connection rate
// limit (only genuine dispatches count); the attempt-row-first / outcome-row audit protocol incl. a forced
// throw; and planted-leak flips for the key marker in the result, the audit rows and any thrown error text.
//
// Run: 1) build (turbo builds shared first), 2) node test/ssh-exec-tool.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const tmpHome = path.join(os.tmpdir(), `loom-sshx-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { createSshConnection, createConnection } = await import("../dist/connections/store.js");
const { performSshExec, __resetSshRateLimitState } = await import("../dist/connections/sshExec.js");
const { testRegexesBounded } = await import("../dist/connections/sshRegex.js");
const { computeHostKeyFingerprint } = await import("../dist/connections/ssh.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const ssh2 = (await import("ssh2")).default;
const { Server, utils } = ssh2;
const net = (await import("node:net")).default;

// ---- fixture keys (pure JS) --------------------------------------------------------------------------
// ssh2's generateKeyPairSync output was seen ONCE (≈1 in 15 runs, cause not investigated) failing its own
// parseKey with "getPrivatePEM is not a function"; regenerate until the pair round-trips so a fixture
// hiccup cannot masquerade as a product failure. Bounded: gives up loudly after 10 tries.
function genKey() {
  for (let i = 0; i < 10; i++) {
    const kp = utils.generateKeyPairSync("ed25519");
    const priv = utils.parseKey(kp.private);
    const pub = utils.parseKey(kp.public);
    if (!(priv instanceof Error) && typeof priv.getPrivatePEM === "function" && !(pub instanceof Error)) return kp;
  }
  throw new Error("could not generate a parseable ed25519 fixture key in 10 tries");
}
const hostKeyPair = genKey();
const clientKey = genKey();
const wrongKey = genKey();
const allowedPub = utils.parseKey(clientKey.public);
const HOST_FP = computeHostKeyFingerprint(utils.parseKey(hostKeyPair.public).getPublicSSH());

/** A per-key secret marker (the raw 32-byte seed, base64) — NEVER the constant openssh-key-v1 header. */
function seedMarker(pem) {
  const parsed = utils.parseKey(pem);
  const der = Buffer.from(parsed.getPrivatePEM().replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
  if (der.length !== 48) throw new Error("unexpected ed25519 PKCS8 length");
  return der.subarray(16).toString("base64");
}
const MARKER_A = seedMarker(clientKey.private);
const MARKER_B = seedMarker(wrongKey.private);
check("marker is secret-bearing and DIFFERS across keys", MARKER_A.length >= 40 && MARKER_A !== MARKER_B);

// ---- throwaway loopback server -----------------------------------------------------------------------
const serverFlags = { execs: [] };
const sockets = new Set();
const server = new Server({ hostKeys: [hostKeyPair.private] }, (conn) => {
  conn.on("error", () => {});
  conn.on("authentication", (ctx) => {
    if (ctx.method !== "publickey") return ctx.reject(["publickey"]);
    if (ctx.key.algo !== allowedPub.type || Buffer.compare(ctx.key.data, allowedPub.getPublicSSH()) !== 0) return ctx.reject(["publickey"]);
    if (ctx.signature && allowedPub.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) return ctx.reject(["publickey"]);
    ctx.accept();
  });
  conn.on("ready", () => conn.on("session", (accept) => {
    const session = accept();
    session.once("exec", (acc, _rej, info) => {
      serverFlags.execs.push(info.command);
      const stream = acc();
      if (info.command === "ls /exit7") { stream.write("seven\n"); stream.exit(7); } else { stream.write("listing\n"); stream.exit(0); }
      stream.end();
    });
  }));
});
server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
const port = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));
const deadPort = await new Promise((r) => { const p = net.createServer(); p.listen(0, "127.0.0.1", () => { const pt = p.address().port; p.close(() => r(pt)); }); });

try {
  const db = new Db(path.join(tmpHome, "t.db"));
  const now = new Date().toISOString();
  const PROJECT_ID = "pSshExec";
  db.insertProject({ id: PROJECT_ID, name: "SshExecProj", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });

  const mk = (name, extra = {}) => createSshConnection(db, {
    name, host: "127.0.0.1", port, user: "loom", privateKey: clientKey.private, hostKeyFingerprint: HOST_FP, ...extra,
  });
  const roConn = mk("RO", { readOnly: true });                                            // read-only, default risky list
  const rwConn = mk("RW", { readOnly: false });                                           // read-write, default risky list
  const rxConn = mk("REGEX", { readOnly: false, commandAllowlist: [{ kind: "regex", pattern: "^ls" }] }); // unanchored-end regex
  const evilConn = mk("EVIL", { readOnly: false, commandAllowlist: [{ kind: "regex", pattern: "^(a+)+$" }] });
  const authConn = createSshConnection(db, { name: "BADKEY", host: "127.0.0.1", port, user: "loom", privateKey: wrongKey.private, hostKeyFingerprint: HOST_FP, readOnly: false });
  const deadConn = createSshConnection(db, { name: "DEAD", host: "127.0.0.1", port: deadPort, user: "loom", privateKey: clientKey.private, hostKeyFingerprint: HOST_FP, readOnly: false });
  const badHostConn = mk("BADHOST", { readOnly: false });
  db.db.prepare("UPDATE connections SET host = ? WHERE id = ?").run("evil host\nname", badHostConn.id);
  const bearer = createConnection(db, { name: "Bearer", host: "api.example", authScheme: "bearer", secret: "sk-not-ssh-123456" });
  const ALL = [roConn, rwConn, rxConn, evilConn, authConn, deadConn, badHostConn].map((c) => c.id);

  const GUARD = { requestTimeoutMs: 5000, maxResponseBytes: 100000, rateLimitMax: 1000, rateLimitWindowMs: 60000 };

  // ---- sessions via the real SessionService (fake pty) ---------------------------------------------
  db.insertProfile({ id: "profPlain", name: "Plain", role: null, description: "", allowDelta: [], skills: null, model: null, icon: null });
  db.insertAgent({ id: "agGranted", projectId: PROJECT_ID, name: "Granted", startupPrompt: "", position: 0, profileId: "profPlain", connections: ALL });
  db.insertAgent({ id: "agSibling", projectId: PROJECT_ID, name: "Sibling", startupPrompt: "", position: 1, profileId: "profPlain" });
  db.insertAgent({ id: "agBearer", projectId: PROJECT_ID, name: "BearerOnly", startupPrompt: "", position: 2, profileId: "profPlain", connections: [bearer.id] });
  class SeamHost extends createSeamHost(PtyHost) {
    createPty(opts) { return { ...super.createPty(opts), pid: 1 }; }
  }
  const host = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
  const svc = new SessionService(db, host, new OrchestrationControl());
  const sGranted = svc.startNew("agGranted");
  const sSibling = svc.startNew("agSibling");
  const sBearer = svc.startNew("agBearer");

  const router = new TaskMcpRouter(db, {}, async () => { throw new Error("no fetch"); });
  const withClient = async (sessionId, fn) => {
    const server2 = router.buildServer(router.resolveProject(sessionId), sessionId);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server2.connect(st);
    const client = new Client({ name: "sshx", version: "0" });
    await client.connect(ct);
    try { return await fn(client); } finally { await client.close(); }
  };
  const toolsOf = (sessionId) => withClient(sessionId, async (c) => (await c.listTools()).tools);
  const callTool = (sessionId, args) => withClient(sessionId, async (c) => {
    const r = await c.callTool({ name: "ssh_exec", arguments: args });
    return JSON.parse(r.content[0].text);
  });

  // ============ 1. registration is keyed on the SESSION ROW ============
  {
    check("1a agent-row-only grant is pinned on the session row (profile has none)", (db.getSession(sGranted.id).connections ?? []).includes(roConn.id));
    const gTools = await toolsOf(sGranted.id);
    const sTools = await toolsOf(sSibling.id);
    const bTools = await toolsOf(sBearer.id);
    check("1b granted session: ssh_exec PRESENT", gTools.some((t) => t.name === "ssh_exec"));
    check("1c sibling agent on the SAME profile without the grant: ssh_exec ABSENT", !sTools.some((t) => t.name === "ssh_exec"));
    check("1d session granted only a non-ssh connection: ssh_exec ABSENT (authenticated_request present)", !bTools.some((t) => t.name === "ssh_exec") && bTools.some((t) => t.name === "authenticated_request"));
    const desc = gTools.find((t) => t.name === "ssh_exec")?.description ?? "";
    check("1e description says Loom-side filtering is defense-in-depth and the boundary is a least-privileged server user", /defense-in-depth/.test(desc) && /least-privileged/.test(desc));
    check("1f description lists the granted ssh connections (id/name/host) and never key material", desc.includes(roConn.id) && !desc.includes(MARKER_A));
    check("1g description cites no card/decision ids", !/a3d5c7f4|699fdbd9|f6647205|f9972a3d|f7d70f75|b9b34a35|afe1bc90/.test(desc));
    check("1h authenticated_request's usable list never includes an ssh id", !(gTools.find((t) => t.name === "authenticated_request")?.description ?? "").includes(roConn.id));
    // revoke direction: a row write takes effect on the very next listTools
    db.setSessionCapabilitySurface(sGranted.id, { connections: [] });
    check("1i REVOKE: ssh_exec disappears on the next request after the row is rewritten", !(await toolsOf(sGranted.id)).some((t) => t.name === "ssh_exec"));
    db.setSessionCapabilitySurface(sGranted.id, { connections: ALL });
    check("1j re-GRANT: ssh_exec returns", (await toolsOf(sGranted.id)).some((t) => t.name === "ssh_exec"));
    // handler double-check: a connection id NOT on the session list is refused even if it exists
    const r = await callTool(sGranted.id, { connectionId: bearer.id, command: "ls /tmp" });
    check("1k handler refuses an id outside the session grant", r.ok === false && r.reason === "connection-not-permitted");
  }

  // ---- audit helpers ----------------------------------------------------------------------------
  const rows = () => db.db.prepare("SELECT * FROM orchestration_events WHERE kind = 'ssh_command_run' ORDER BY seq").all()
    .map((r) => ({ ...r, detail: JSON.parse(r.detail_json) }));
  const rowsFor = (command) => rows().filter((r) => r.detail.command === command);
  const calls = [];
  const stubRunner = async (input) => { calls.push(input); return { ok: true, stdout: "out\n", stderr: "", exitCode: 0, truncated: false }; };
  const direct = (conn, command, extra = {}) => performSshExec({ db, sessionId: sGranted.id, projectId: PROJECT_ID, guard: GUARD, runner: stubRunner, ...extra }, ALL, { connectionId: conn.id, command });
  const lastOutcome = (command) => rowsFor(command).filter((r) => r.detail.phase === "outcome").at(-1)?.detail;

  // ============ 2. a permitted command RUNS (real loopback) and is audited with its exit code ============
  {
    const r = await callTool(sGranted.id, { connectionId: roConn.id, command: "ls /exit7" });
    check("2a permitted read command ran on the loopback server", r.ok === true && r.exitCode === 7 && r.stdout === "seven\n");
    check("2a server really received it", serverFlags.execs.includes("ls /exit7"));
    const out = lastOutcome("ls /exit7");
    check("2b audited: outcome row has exitCode, host, port, user, connectionId, session", out?.outcome === "ran" && out.exitCode === 7 && out.host === "127.0.0.1" && out.port === port && out.user === "loom" && out.connectionId === roConn.id && out.sessionId === sGranted.id);
    const pair = rowsFor("ls /exit7");
    check("2c exactly two rows (attempt + outcome) sharing one callId", pair.length === 2 && pair[0].detail.phase === "attempt" && pair[1].detail.phase === "outcome" && pair[0].detail.callId === pair[1].detail.callId);
    check("2d attempt row carries the agent id and the exact command", pair[0].detail.agentId === "agGranted" && pair[0].detail.command === "ls /exit7");
    check("2e rows are stamped with the project (durable audit kind)", pair[0].detail.projectId === PROJECT_ID);
    // counters CAN move: flip proof for every later "never reached the wire" claim
    const before = serverFlags.execs.length;
    await callTool(sGranted.id, { connectionId: rwConn.id, command: "ls /tmp" });
    check("2f (flip control) a permitted call DOES move the server's exec counter", serverFlags.execs.length === before + 1);
  }

  // ============ 3. refusals: refused AND audited AND the wire is never touched ============
  {
    const refusedCases = [
      // [label, conn, command, expected reason]
      ["read-only: non-read verb", roConn, "cp a b", "not-read-only-verb"],
      ["read-only: hostname with arg", roConn, "hostname newname", "not-read-only-verb"],
      ["read-only: date -s", roConn, "date -s 2020-01-01", "not-read-only-verb"],
      ["read-only: docker run", roConn, "docker run alpine", "not-read-only-verb"],
      ["read-only: systemctl restart", roConn, "systemctl restart nginx", "risky-pattern-requires-approval"],
      ["allowlist regex: not matching", rxConn, "cat /etc/hostname", "not-in-allowlist"],
      ["risky: reboot", rwConn, "reboot", "risky-pattern-requires-approval"],
      ["risky: sudo reboot", rwConn, "sudo reboot", "risky-pattern-requires-approval"],
      ["risky: /sbin/reboot", rwConn, "/sbin/reboot", "risky-pattern-requires-approval"],
      ["risky: env prefix", rwConn, "FOO=1 reboot", "risky-pattern-requires-approval"],
      ["risky: nice reboot", rwConn, "nice reboot", "risky-pattern-requires-approval"],
      ["risky: systemctl --force reboot", rwConn, "systemctl --force reboot", "risky-pattern-requires-approval"],
      ["risky: rm -rf", rwConn, "rm -rf /tmp/x", "risky-pattern-requires-approval"],
      ["risky: docker compose down (extra spaces)", rwConn, "docker  compose   down", "risky-pattern-requires-approval"],
      ["risky: regex-allowlisted but risky", rxConn, "ls reboot", "risky-pattern-requires-approval"],
      ["empty", rwConn, "   ", "invalid-command"],
    ];
    const metaShapes = [";", "&&", "||", "|", "&", "`id`", "$(id)", "${IFS}", ">", "<", ">>", "2>&1", "\\", "'", '"', "*", "?", "[a]", "~", "#", "!", "{a,b}", "^", "ls\treboot"];
    for (const m of metaShapes) refusedCases.push([`shell syntax ${JSON.stringify(m)} (read-only)`, roConn, `ls /tmp ${m} x`, m === "ls\treboot" ? "control-characters" : "shell-metacharacters"]);
    for (const m of [";", "&&", "|", "`id`", "$(id)", ">"]) {
      refusedCases.push([`shell syntax ${JSON.stringify(m)} (UNANCHORED regex allowlist, ls; reboot shape)`, rxConn, `ls ${m} reboot`, "shell-metacharacters"]);
      refusedCases.push([`shell syntax ${JSON.stringify(m)} (read-write, no allowlist)`, rwConn, `ls ${m} reboot`, "shell-metacharacters"]);
    }
    refusedCases.push(["newline", rwConn, "ls\nreboot", "control-characters"]);
    refusedCases.push(["carriage return", rwConn, "ls\rreboot", "control-characters"]);
    refusedCases.push(["NUL", rwConn, "ls\0reboot", "control-characters"]);
    refusedCases.push(["unicode lookalike", rwConn, "ls ․ /tmp", "non-ascii-characters"]);
    refusedCases.push(["over length cap", rwConn, "a".repeat(4097), "command-too-long"]);

    const execsBefore = serverFlags.execs.length;
    calls.length = 0;
    for (const [label, conn, command, reason] of refusedCases) {
      const r = await direct(conn, command);
      const outcome = lastOutcome(command.length > 4096 ? command.slice(0, 4096) : command);
      check(`3 ${label}: refused as ${reason}`, r.ok === false && r.reason === reason);
      check(`3 ${label}: audited (outcome=refused, same reason)`, outcome?.outcome === "refused" && outcome.reason === reason);
    }
    check(`3 none of the ${refusedCases.length} refusals reached the runner`, calls.length === 0);
    check("3 none reached the loopback server either", serverFlags.execs.length === execsBefore);
    // exemption + flip: the same stack lets a clean command through
    const okRun = await direct(rwConn, "systemctl status nginx");
    check("3 (flip control) systemctl with an exact read-only subcommand passes the risky check and DOES reach the runner", okRun.ok === true && calls.length === 1);
    const okRo = await direct(roConn, "ls /tmp");
    check("3 (flip control) a read verb on a read-only connection is allowed", okRo.ok === true && calls.length === 2);
    const okRx = await direct(rxConn, "ls /var/log");
    check("3 (flip control) the regex allowlist matches a clean command", okRx.ok === true && calls.length === 3);
    const longRefused = rows().find((r) => r.detail.commandLength === 4097);
    check("3 over-cap command is stored clipped to the cap with its true length", longRefused?.detail.command.length === 4096);
  }

  // ============ 3b. option-value shifting: a subcommand is NEVER inferred past an option ============
  {
    const shifted = [
      ["systemctl -o cat stop sshd", "risky-pattern-requires-approval"],
      ["systemctl -p status disable sshd", "risky-pattern-requires-approval"],
      ["docker -l info stop db", "not-read-only-verb"],
      ["docker -l info run --privileged -v /:/h alpine chroot /h touch /h/pwn", "not-read-only-verb"],
      ["docker --log-level info compose down", "not-read-only-verb"],
      ["docker -l info system prune -af", "not-read-only-verb"],
      ["docker -l info exec db touch x", "not-read-only-verb"],
    ];
    calls.length = 0;
    for (const [command, reason] of shifted) {
      const r = await direct(roConn, command);
      const pair = rowsFor(command);
      check(`3b ${command}: refused as ${reason}`, r.ok === false && r.reason === reason);
      check(`3b ${command}: audited as an attempt+outcome pair`, pair.length === 2 && pair[0].detail.phase === "attempt" && pair[1].detail.reason === reason);
    }
    // the same shapes on a read-WRITE connection must still not slip past the risky exemption
    const rwShift = await direct(rwConn, "systemctl -o cat stop sshd");
    check("3b systemctl exemption is dropped when an option precedes the subcommand (read-write connection)", rwShift.ok === false && rwShift.reason === "risky-pattern-requires-approval");
    check("3b none of the shifted shapes reached the runner", calls.length === 0);

    // tightened read-only list: removed verbs refused, the narrow forms still pass (flip controls)
    for (const [command, reason] of [
      ["file -C -m x", "not-read-only-verb"], ["docker logs web", "not-read-only-verb"], ["docker inspect web", "not-read-only-verb"],
      ["docker ps --format x", "not-read-only-verb"], ["systemctl status -l nginx", "not-read-only-verb"],
      ["systemctl show nginx", "risky-pattern-requires-approval"], ["systemctl status a b", "not-read-only-verb"],
    ]) {
      const r = await direct(roConn, command);
      check(`3b read-only list: ${command} refused as ${reason}`, r.ok === false && r.reason === reason);
    }
    const before = calls.length;
    const okA = await direct(roConn, "systemctl status nginx");
    const okB = await direct(roConn, "docker ps -a");
    const okC = await direct(roConn, "systemctl is-active nginx");
    check("3b (flip control) systemctl <status|is-active> <unit> and docker ps -a DO pass and reach the runner", okA.ok && okB.ok && okC.ok && calls.length === before + 3);
  }

  // ============ 3c. grant-check / not-found refusals are audited as a full attempt+outcome PAIR ============
  {
    for (const [label, ids, connectionId, command, reason] of [
      ["connection-not-permitted", ALL, bearer.id, "ls /not-permitted", "connection-not-permitted"],
      ["connection-not-found", [...ALL, "ghost-connection-id"], "ghost-connection-id", "ls /not-found", "connection-not-found"],
    ]) {
      calls.length = 0;
      const r = await performSshExec({ db, sessionId: sGranted.id, projectId: PROJECT_ID, guard: GUARD, runner: stubRunner }, ids, { connectionId, command });
      const pair = rowsFor(command);
      check(`3c ${label}: refused`, r.ok === false && r.reason === reason && calls.length === 0);
      check(`3c ${label}: attempt row THEN outcome row, same callId, outcome carries the reason`, pair.length === 2 && pair[0].detail.phase === "attempt" && pair[1].detail.phase === "outcome" && pair[0].detail.callId === pair[1].detail.callId && pair[1].detail.reason === reason);
    }
  }

  // ============ 3d. regex worker concurrency is capped daemon-wide ============
  {
    const { getSshRegexWorkerStats, SSH_REGEX_MAX_CONCURRENT_WORKERS } = await import("../dist/connections/sshRegex.js");
    const evilInput = "a".repeat(4000) + "b";
    const before = getSshRegexWorkerStats();
    const p = [1, 2, 3].map(() => testRegexesBounded(["^(a+)+$"], evilInput, 300));
    await delay(0);
    const mid = getSshRegexWorkerStats();
    check(`3d with 3 concurrent calls, exactly ${SSH_REGEX_MAX_CONCURRENT_WORKERS} hold a worker and the 3rd WAITS`, mid.active === SSH_REGEX_MAX_CONCURRENT_WORKERS && mid.queued === 1);
    const results = await Promise.all(p);
    const after = getSshRegexWorkerStats();
    check("3d all three still end in a bounded timeout once running (budget applies after the wait)", results.every((x) => x.ok === false && x.reason === "timeout"));
    check("3d peak live workers never exceeded the cap, and everything drained", after.peak <= SSH_REGEX_MAX_CONCURRENT_WORKERS && after.active === 0 && after.queued === 0 && before.active === 0);
  }

  // ============ 4. ReDoS: bounded, audited, event loop stays responsive ============
  {
    const evil = "a".repeat(4000) + "b";
    let maxLate = 0; let last = Date.now();
    const iv = setInterval(() => { const n = Date.now(); maxLate = Math.max(maxLate, n - last - 20); last = n; }, 20);
    const t0 = Date.now();
    calls.length = 0;
    const r = await direct(evilConn, evil);
    const elapsed = Date.now() - t0;
    clearInterval(iv);
    check("4a catastrophic owner regex: refused as allowlist-regex-timeout", r.ok === false && r.reason === "allowlist-regex-timeout");
    check(`4b refusal landed within the bound (${elapsed}ms < 3000)`, elapsed < 3000);
    check(`4c event loop stayed responsive during the match (worst timer lateness ${maxLate}ms < 200)`, maxLate < 200);
    check("4d audited + never reached the runner", lastOutcome(evil)?.reason === "allowlist-regex-timeout" && calls.length === 0);
    // flip control: the SAME pattern is quick on benign input, and a benign pattern is not timed out
    const benign = await testRegexesBounded(["^(a+)+$"], "aaaa");
    check("4e (flip control) the evil pattern completes normally on short input", benign.ok === true && benign.results[0] === true);
    const bounded = await testRegexesBounded(["^(a+)+$"], evil, 150);
    check("4f the bounded matcher itself reports a timeout on the evil input", bounded.ok === false && bounded.reason === "timeout");
  }

  // ============ 5. host shape ============
  {
    calls.length = 0;
    const r = await direct(badHostConn, "ls /tmp");
    check("5a host with whitespace/newline refused before connecting", r.ok === false && r.reason === "invalid-connection-target" && calls.length === 0);
    check("5b audited with the refusal reason", lastOutcome("ls /tmp")?.reason !== undefined);
  }

  // ============ 6. auth-refused vs unreachable (real loopback, through the tool) ============
  {
    const a = await callTool(sGranted.id, { connectionId: authConn.id, command: "ls /tmp" });
    const u = await callTool(sGranted.id, { connectionId: deadConn.id, command: "ls /tmp" });
    check("6a wrong key: kind auth-refused", a.ok === false && a.kind === "auth-refused");
    check("6b dead port: kind unreachable", u.ok === false && u.kind === "unreachable");
    check("6c the two are distinct to the agent", a.kind !== u.kind && a.error !== u.error);
    const outs = rows().filter((x) => x.detail.phase === "outcome" && (x.detail.connectionId === authConn.id || x.detail.connectionId === deadConn.id));
    check("6d audit rows carry the distinct errorKinds", outs.some((x) => x.detail.errorKind === "auth-refused") && outs.some((x) => x.detail.errorKind === "unreachable"));
  }

  // ============ 7. rate limit — only genuine dispatches count ============
  {
    __resetSshRateLimitState();
    const tight = { ...GUARD, rateLimitMax: 2, rateLimitWindowMs: 60000 };
    for (let i = 0; i < 5; i++) await direct(rwConn, "ls ; reboot", { guard: tight }); // policy refusals: must NOT burn quota
    const r1 = await direct(rwConn, "ls /a", { guard: tight });
    const r2 = await direct(rwConn, "ls /b", { guard: tight });
    const r3 = await direct(rwConn, "ls /c", { guard: tight });
    check("7a two genuine dispatches pass after five policy refusals", r1.ok && r2.ok);
    check("7b the third is rate-limited", r3.ok === false && r3.reason === "rate-limited");
    check("7c the rate-limit refusal is audited", lastOutcome("ls /c")?.reason === "rate-limited");
    const other = await direct(roConn, "ls /a", { guard: tight });
    check("7d the limit is per connection", other.ok === true);
    __resetSshRateLimitState();
  }

  // ============ 8. audit protocol: attempt row first; forced throws; unwritable audit ============
  {
    // 8a. a throw AFTER the attempt row (connection lookup explodes): attempt row exists, outcome row too.
    const exploding = new Proxy(db, { get: (t, p) => (p === "getConnection" ? () => { throw new Error("db exploded with " + MARKER_A); } : Reflect.get(t, p, t)) });
    const cmd = "ls /forced-throw";
    const r = await performSshExec({ db: exploding, sessionId: sGranted.id, projectId: PROJECT_ID, guard: GUARD, runner: stubRunner }, ALL, { connectionId: rwConn.id, command: cmd });
    const pair = rowsFor(cmd);
    check("8a forced throw: attempt row exists", pair.some((x) => x.detail.phase === "attempt"));
    check("8b forced throw: outcome row written for the caught path", pair.some((x) => x.detail.phase === "outcome" && x.detail.errorKind === "internal-error"));
    check("8c forced throw: caller gets fixed text, never the thrown message", r.ok === false && !JSON.stringify(r).includes("exploded") && !JSON.stringify(r).includes(MARKER_A));
    check("8d forced throw: audit rows never carry the thrown text", !JSON.stringify(pair).includes("exploded") && !JSON.stringify(pair).includes(MARKER_A));
    check("8e (flip control) the planted marker WAS in the thrown error", (() => { try { exploding.getConnection("x"); } catch (e) { return String(e.message).includes(MARKER_A); } return false; })());

    // 8f. attempt row unwritable ⇒ refused, nothing runs
    calls.length = 0;
    const noAudit = new Proxy(db, { get: (t, p) => (p === "appendEvent" ? () => { throw new Error("disk full"); } : Reflect.get(t, p, t)) });
    const r2 = await performSshExec({ db: noAudit, sessionId: sGranted.id, projectId: PROJECT_ID, guard: GUARD, runner: stubRunner }, ALL, { connectionId: rwConn.id, command: "ls /x" });
    check("8f unwritable audit: call refused and the runner never invoked", r2.ok === false && r2.reason === "audit-unavailable" && calls.length === 0);

    // 8g. outcome row unwritable (attempt succeeded) ⇒ the completed call still returns normally
    let n = 0;
    const flaky = new Proxy(db, { get: (t, p) => (p === "appendEvent" ? (e) => { if (++n > 1) throw new Error("disk full"); return t.appendEvent(e); } : Reflect.get(t, p, t)) });
    const warned = [];
    const origWarn = console.warn;
    console.warn = (...a) => { warned.push(a.join(" ")); };
    let r3;
    try {
      r3 = await performSshExec({ db: flaky, sessionId: sGranted.id, projectId: PROJECT_ID, guard: GUARD, runner: stubRunner }, ALL, { connectionId: rwConn.id, command: "ls /y" });
    } finally { console.warn = origWarn; }
    check("8g outcome-write failure does not turn a completed call into a throw", r3.ok === true && rowsFor("ls /y").length === 1);
    const attemptCallId = rowsFor("ls /y")[0]?.detail.callId;
    check("8g one command-free breadcrumb naming the callId and connection id", warned.length === 1 && warned[0].includes(attemptCallId) && warned[0].includes(rwConn.id) && !warned[0].includes("ls /y"));

    // 8h. a refused call and a run call each produce exactly attempt+outcome (attempt is first, by seq)
    const refused = rowsFor("cp a b");
    check("8h refused call: attempt precedes outcome, same callId", refused.length === 2 && refused[0].detail.phase === "attempt" && refused[0].detail.callId === refused[1].detail.callId);
  }

  // ============ 9. planted-leak flips: key marker in result / rows / thrown text ============
  {
    // The runner echoes the decrypted key back in stdout AND throws an error embedding it.
    let seenKey = "";
    const echoRunner = async (input) => { seenKey = input.privateKey; return { ok: true, stdout: `KEY:${input.privateKey}\n`, stderr: "", exitCode: 0, truncated: false }; };
    const r = await performSshExec({ db, sessionId: sGranted.id, projectId: PROJECT_ID, guard: GUARD, runner: echoRunner }, ALL, { connectionId: rwConn.id, command: "ls /leak" });
    check("9a (flip control) the runner really was handed the key and echoed it", seedMarker(seenKey) === MARKER_A);
    check("9b the key is scrubbed from the returned stdout", r.ok === true && !r.stdout.includes(seenKey) && r.stdout.includes("[REDACTED]"));
    const throwRunner = async (input) => { throw new Error(`ssh2 blew up: ${input.privateKey}`); };
    const r2 = await performSshExec({ db, sessionId: sGranted.id, projectId: PROJECT_ID, guard: GUARD, runner: throwRunner }, ALL, { connectionId: rwConn.id, command: "ls /leak2" });
    check("9c a runner throw embedding the key yields fixed text only", r2.ok === false && !JSON.stringify(r2).includes("blew up") && !JSON.stringify(r2).includes(MARKER_A));
    const all = JSON.stringify(rows());
    check("9d NO audit row (any call in this file) contains either per-key marker or any key header", !all.includes(MARKER_A) && !all.includes(MARKER_B) && !all.includes("BEGIN OPENSSH"));
    // and over the real MCP path
    const viaMcp = JSON.stringify(await callTool(sGranted.id, { connectionId: rwConn.id, command: "ls /tmp" }));
    check("9e real MCP result carries no key marker", !viaMcp.includes(MARKER_A) && !viaMcp.includes(MARKER_B));
  }

  db.close();
  console.log(failures === 0 ? "\n✅ ALL PASS — ssh_exec" : `\n❌ ${failures} FAILURE(S).`);
} finally {
  for (const s of sockets) { try { s.destroy(); } catch { /* gone */ } }
  server.close();
  cleanupPathSync(tmpHome);
}
process.exit(failures === 0 ? 0 : 1);
