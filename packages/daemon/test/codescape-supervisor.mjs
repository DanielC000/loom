import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Codescape fleet-daemon supervisor (card 894b9b02, epic 369dde3c C1 — FOUNDATION). REAL-SPAWN, hermetic:
// a fixture `codescape` CLI (test/fixtures/fake-codescape-cli.mjs, invoked via node — no shell, no real
// codescape install needed) stands in for the real binary. Claude-free, network-free (the control-plane
// client is exercised against a fake in-process http.Server, never a real Codescape serve).
//
// Proves the DoD:
//   (neg)   LOOM_DEV unset ⇒ the supervisor NEVER spawns anything: getPort()/getPid() stay null, no
//           fake-codescape-calls.jsonl is ever written, boot is behaviorally byte-identical to today.
//   (a)     with LOOM_DEV=1 + LOOM_CODESCAPE_ENABLED=1: ingest runs (one call recorded), THEN serve spawns
//           on the loopback port getPort() returns — and BOTH ran from the exact SAME shared cwd (the
//           CWD CONTRACT).
//   (b)     killing the live child triggers a BOUNDED restart: a fresh serve call is recorded (new pid),
//           reusing the SAME port, without the caller doing anything.
//   (c)     stop() disarms restart-on-death and clears getPort()/getPid().
//   (d)     the control-plane client methods (registerWorktree/reingestMain/dropWorktree/overlay) hit the
//           right method+URL+body on a fake HTTP server, resolve `{ok:false}` (never throw) against an
//           unreachable port within their own bound, and short-circuit instantly with no live port at all.
//
// Run: 1) build (turbo builds shared first), 2) node test/codescape-supervisor.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureCli = path.join(__dirname, "fixtures", "fake-codescape-cli.mjs");

// --- Hermetic LOOM_HOME, set BEFORE importing dist (CODESCAPE_HOME_DIR derives from it at import time) ---
const tmpHome = path.join(os.tmpdir(), `loom-cs-${Date.now()}-${process.pid}`);
fs.mkdirSync(tmpHome, { recursive: true });
process.env.LOOM_HOME = tmpHome;
// The isLoomDev()/isCodescapeSupervisorEnabled() checks below need the TRUE default-off state — delete
// any inherited flags (e.g. this test running inside a LOOM_DEV=1 self-hosting shell).
delete process.env.LOOM_DEV;
delete process.env.LOOM_CODESCAPE_ENABLED;
delete process.env.LOOM_CODESCAPE_BIN;

const { CodescapeSupervisor } = await import("../dist/codescape/supervisor.js");
const { isLoomDev, isCodescapeSupervisorEnabled, resolveCodescapeBin, CODESCAPE_HOME_DIR } = await import("../dist/paths.js");

// ===================== paths.ts resolvers (claude-free, pure) =====================
check("(resolver) CODESCAPE_HOME_DIR derives from LOOM_HOME", CODESCAPE_HOME_DIR === path.join(tmpHome, "codescape"));
check("(resolver) resolveCodescapeBin() with no override falls back to the bare 'codescape' command",
  (() => { const r = resolveCodescapeBin(); return r.command !== process.execPath && r.args.length === 0; })());
process.env.LOOM_CODESCAPE_BIN = fixtureCli;
const resolvedBin = resolveCodescapeBin();
check("(resolver) a .mjs override resolves to {command: node, args:[fixture]} (mirrors dejaMcpServer's node-invocation shape)",
  resolvedBin.command === process.execPath && JSON.stringify(resolvedBin.args) === JSON.stringify([fixtureCli]));

// ===================== (neg) LOOM_DEV unset — the hard negative case =====================
check("(neg) isLoomDev() is FALSE by default", isLoomDev() === false);
check("(neg) isCodescapeSupervisorEnabled() is FALSE by default", isCodescapeSupervisorEnabled() === false);
const negHomeDir = path.join(tmpHome, "neg-home");
const negSup = new CodescapeSupervisor({ homeDir: negHomeDir });
await negSup.start(["/some/repo"]);
check("(neg) start() with LOOM_DEV unset never spawns — getPort() is null", negSup.getPort() === null);
check("(neg) start() with LOOM_DEV unset never spawns — getPid() is null", negSup.getPid() === null);
check("(neg) start() with LOOM_DEV unset never creates the home dir (zero side effects)", !fs.existsSync(negHomeDir));

// Even LOOM_CODESCAPE_ENABLED alone (no LOOM_DEV) must not enable it — isLoomDev() is a HARD prerequisite.
process.env.LOOM_CODESCAPE_ENABLED = "1";
check("(neg) LOOM_CODESCAPE_ENABLED=1 alone (LOOM_DEV still unset) does NOT enable the supervisor",
  isCodescapeSupervisorEnabled() === false);
delete process.env.LOOM_CODESCAPE_ENABLED;

// ===================== enable: LOOM_DEV=1 + LOOM_CODESCAPE_ENABLED=1 =====================
process.env.LOOM_DEV = "1";
check("(gate) isLoomDev() is TRUE once LOOM_DEV=1 (still not enabled — the opt-in toggle is separate)",
  isLoomDev() === true && isCodescapeSupervisorEnabled() === false);
process.env.LOOM_CODESCAPE_ENABLED = "1";
check("(gate) isCodescapeSupervisorEnabled() is TRUE once BOTH are set", isCodescapeSupervisorEnabled() === true);

// ===================== (a) REAL-SPAWN: ingest-then-serve, shared cwd =====================
const homeDir = path.join(tmpHome, "codescape-home");
const callsFile = path.join(homeDir, "fake-codescape-calls.jsonl");
const readCalls = () => fs.existsSync(callsFile)
  ? fs.readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];

const sup = new CodescapeSupervisor({
  homeDir,
  restartBackoffMs: [150, 250, 400], // fast — this test proves restart-on-death without waiting real minutes
  healthyRunMs: 60_000, // never hit "healthy" mid-test — keeps the attempt counter deterministic
  ingestTimeoutMs: 15_000,
});

await sup.start(["/fake/repo/one"]);
// Give the long-lived `serve` fixture a moment to actually spawn + write its call record.
for (let i = 0; i < 50 && readCalls().length < 2; i++) await sleep(50);

const calls1 = readCalls();
check("(a) exactly 2 calls recorded (1 ingest + 1 serve)", calls1.length === 2);
check("(a) call 1 is 'ingest /fake/repo/one'", calls1[0]?.cmd === "ingest" && calls1[0]?.repoPath === "/fake/repo/one");
check("(a) call 2 is 'serve'", calls1[1]?.cmd === "serve");
check("(a) getPort() returns a live numeric port", typeof sup.getPort() === "number" && sup.getPort() > 0);
check("(a) the serve call's --port matches getPort()", Number(calls1[1]?.port) === sup.getPort());
check("(a) getPid() returns the live child's pid", typeof sup.getPid() === "number" && sup.getPid() > 0);
check("(a) CWD CONTRACT: ingest ran from the shared homeDir",
  path.resolve(calls1[0]?.cwd || "") === path.resolve(homeDir));
check("(a) CWD CONTRACT: serve ran from the SAME shared homeDir as ingest",
  calls1[0]?.cwd === calls1[1]?.cwd);

// ===================== (b) restart-on-death: bounded, same port, new pid =====================
const portBefore = sup.getPort();
const pidBefore = sup.getPid();
process.kill(pidBefore); // simulate a crash — NOT supervisor.stop()

// Wait for the FIXTURE's own respawned process to actually run and append its call record — getPid()
// flips to the new child's pid synchronously on spawn, well before that child's script has executed, so
// poll the call log itself (the actual observable proof of a restart), not just the pid.
for (let i = 0; i < 100 && readCalls().length < 3; i++) await sleep(50);

check("(b) after the kill, a NEW serve call is recorded (a real restart happened)", readCalls().length === 3);
const calls2 = readCalls();
check("(b) the 3rd call is another 'serve'", calls2[2]?.cmd === "serve");
check("(b) restart reused the SAME port", sup.getPort() === portBefore);
check("(b) restart produced a DIFFERENT pid (a genuinely new process)", sup.getPid() !== pidBefore && sup.getPid() !== null);
check("(b) the restarted serve ran from the SAME shared homeDir", calls2[2]?.cwd === calls2[0]?.cwd);

// ===================== (c) stop() disarms restart + clears state =====================
sup.stop();
check("(c) stop() clears getPort()", sup.getPort() === null);
check("(c) stop() clears getPid()", sup.getPid() === null);
await sleep(600); // longer than the fast backoff schedule — prove NO further restart happens post-stop
const callsAfterStop = readCalls().length;
await sleep(300);
check("(c) no further serve call is recorded after stop() (restart-on-death is disarmed)",
  readCalls().length === callsAfterStop);

// ===================== (bad-bin) CR fix: a spawn-FAILURE (ENOENT) must give up, never phantom-alive =====
// The negative spawn-failure case the original test never exercised (the CR-flagged gap): a bad binary
// fires Node's 'error' event (which per Node's own docs is NOT guaranteed to be followed by 'exit') —
// restart-on-death must be wired off BOTH, or the supervisor wedges phantom-alive (getPort() lying about
// a serve that never started) with the give-up diagnostic never firing.
process.env.LOOM_CODESCAPE_BIN = path.join(tmpHome, "does-not-exist-codescape-binary");
const badBinSup = new CodescapeSupervisor({
  homeDir: path.join(tmpHome, "bad-bin-home"),
  restartBackoffMs: [50, 50, 50], // fast + few — prove the give-up bound without a long wait
  healthyRunMs: 60_000,
});
await badBinSup.start(); // no repoPaths — goes straight to the failing spawnServe()

// Poll until the bounded schedule is exhausted and the supervisor gives up (stays down).
for (let i = 0; i < 100 && badBinSup.getPort() !== null; i++) await sleep(50);

check("(bad-bin) after exhausting the bounded restart schedule, getPort() is null (gave up, NOT phantom-alive)",
  badBinSup.getPort() === null);
check("(bad-bin) getPid() is null too (no live child left dangling)", badBinSup.getPid() === null);
// Give any straggler restart timer a moment to fire (it shouldn't — the schedule is exhausted) and
// re-confirm it STAYS down rather than a stray extra attempt reviving it.
await sleep(300);
check("(bad-bin) stays down (no stray restart revives it after giving up)", badBinSup.getPort() === null);
process.env.LOOM_CODESCAPE_BIN = fixtureCli; // restore for anything after this point

// ===================== (d) control-plane client: bounded, never throws =====================
const requests = [];
const fakeServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    requests.push({ method: req.method, url: req.url, body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
});
await new Promise((resolve) => fakeServer.listen(0, "127.0.0.1", resolve));
const fakePort = fakeServer.address().port;

// Test-only seam: pre-seed a live port with NO real spawn, to exercise the HTTP client hermetically.
const client = new CodescapeSupervisor({ port: fakePort });
check("(d) test-seam port pre-seeds getPort()", client.getPort() === fakePort);

const reg = await client.registerWorktree("proj1", { worktreeId: "wt1", path: "/x/y", baseRef: "main" });
check("(d) registerWorktree resolves ok:true against the fake server", reg.ok === true);
check("(d) registerWorktree POSTs /project/<id>/worktree",
  requests.at(-1)?.method === "POST" && requests.at(-1)?.url === "/project/proj1/worktree");
check("(d) registerWorktree body carries worktreeId/path/baseRef",
  (() => { const b = JSON.parse(requests.at(-1)?.body || "{}"); return b.worktreeId === "wt1" && b.path === "/x/y" && b.baseRef === "main"; })());

await client.reingestMain("proj1");
check("(d) reingestMain POSTs /project/<id>/reingest-main",
  requests.at(-1)?.method === "POST" && requests.at(-1)?.url === "/project/proj1/reingest-main");

await client.dropWorktree("proj1", "wt1");
check("(d) dropWorktree DELETEs /project/<id>/worktree/<worktreeId>",
  requests.at(-1)?.method === "DELETE" && requests.at(-1)?.url === "/project/proj1/worktree/wt1");

await client.overlay("proj1", "wt1");
check("(d) overlay POSTs /project/<id>/worktree/<worktreeId>/overlay",
  requests.at(-1)?.method === "POST" && requests.at(-1)?.url === "/project/proj1/worktree/wt1/overlay");

await new Promise((resolve) => fakeServer.close(resolve));

// Bounded against an unreachable (just-closed) port — never throws, resolves within its own timeout.
const deadClient = new CodescapeSupervisor({ port: fakePort, registerTimeoutMs: 500, reingestTimeoutMs: 500 });
const t0 = Date.now();
const deadReg = await deadClient.registerWorktree("p", { worktreeId: "w", path: "/a", baseRef: "main" });
check("(d) an unreachable server resolves ok:false (never throws)", deadReg.ok === false);
check("(d) bounded — resolves quickly, doesn't hang past its own timeout", Date.now() - t0 < 5_000);

// No live port at all (never started) ⇒ immediate ok:false, no fetch attempted.
const noPortSup = new CodescapeSupervisor({ homeDir: path.join(tmpHome, "never-started") });
const t1 = Date.now();
const noPortReg = await noPortSup.registerWorktree("p", { worktreeId: "w", path: "/a", baseRef: "main" });
check("(d) no live port ⇒ ok:false immediately (no fetch attempted)", noPortReg.ok === false && Date.now() - t1 < 200);

// ===================== (d-hang) CR fix: prove the AbortController bound actually FIRES =====================
// The dead-port case above proves "never throws" but resolves via a fast connection-refused error, never
// actually exercising the timeout/AbortController path. This server ACCEPTS the connection but never
// responds — the only way to prove the bound itself (not just an OS-level refusal) is what stops the call.
const hungServer = http.createServer(() => { /* never responds — simulates a hung codescape serve */ });
await new Promise((resolve) => hungServer.listen(0, "127.0.0.1", resolve));
const hungPort = hungServer.address().port;
const HUNG_TIMEOUT_MS = 300;
const hungClient = new CodescapeSupervisor({ port: hungPort, registerTimeoutMs: HUNG_TIMEOUT_MS });
const t2 = Date.now();
const hungReg = await hungClient.registerWorktree("p", { worktreeId: "w", path: "/a", baseRef: "main" });
const hungElapsed = Date.now() - t2;
check("(d-hang) a connected-but-never-responds server resolves ok:false (the AbortController bound fires)", hungReg.ok === false);
check(`(d-hang) the abort fires around its OWN timeout (${hungElapsed}ms), not instantly and not way past it`,
  hungElapsed >= HUNG_TIMEOUT_MS - 50 && hungElapsed < HUNG_TIMEOUT_MS + 4_000);
hungServer.closeAllConnections();
await new Promise((resolve) => hungServer.close(resolve));

// ===================== cleanup =====================
delete process.env.LOOM_CODESCAPE_BIN;
delete process.env.LOOM_CODESCAPE_ENABLED;
delete process.env.LOOM_DEV;
try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — Codescape supervisor (C1): LOOM_DEV unset never spawns anything (getPort/getPid null, zero side effects); enabled ingest-then-serve run from the SAME shared cwd (CWD CONTRACT) on a real loopback port; killing the child triggers a bounded restart (same port, new pid); stop() disarms restart-on-death; the control-plane client (register/reingest/drop/overlay) hits the right method+URL+body, is bounded, and NEVER throws — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
