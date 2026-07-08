// Deja-capture PostToolUse hook test (card b3bd4841). Fully deterministic — no claude, no live daemon
// process (the gateway route is exercised via fastify `app.inject` + one real `app.listen`, never a
// spawned daemon). Exercises the shipped deja-capture.mjs relay as a pure-function import (origin_prompt
// resolution against a session->task fixture, both mocked AND against the real GET
// /internal/deja-context/:sessionId route), as a spawned CLI (the non-blocking exit-0 contract), and
// asserts writeSessionSettings wires the opt-in PostToolUse Write|Edit hook ADDITIVELY alongside (never
// instead of) the existing docLint vault-lint hook. Also asserts dejaCapture is HUMAN-only on the
// agent-facing config validator (card b3bd4841 direction: it shells out to an external host binary,
// unlike docLint's bundled pure-node relay).
//
// RUN with an isolated LOOM_HOME (no daemon needed — writeSessionSettings just needs the settings dir):
//   LOOM_HOME=<temp> node test/deja-capture.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "@loom/shared";
import { DEJA_CAPTURE_SCRIPT, SETTINGS_DIR, ensureDirs } from "../dist/paths.js";
import { writeSessionSettings } from "../dist/pty/claude-settings.js";
import { validateProjectConfigOverride, validateAgentProjectConfigOverride } from "../dist/mcp/platform.js";
import { Db } from "../dist/db.js";
import { buildServer } from "../dist/gateway/server.js";
import { isCaptureCandidate, resolveOriginContext, resolveDejaDbPath, runDejaCapture, resolveDejaBin } from "../assets/deja-capture.mjs";

if (!process.env.LOOM_HOME) { console.error("LOOM_HOME must be set."); process.exit(2); }

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Invoke the hook script as Claude would: PostToolUse payload JSON on stdin, sessionId + port as argv.
function runHook(filePath, tool = "Write") {
  const payload = { hook_event_name: "PostToolUse", tool_name: tool, tool_input: { file_path: filePath }, cwd: __dirname };
  return spawnSync(process.execPath, [DEJA_CAPTURE_SCRIPT, "sess-1", "59999"], { input: JSON.stringify(payload), encoding: "utf8", timeout: 20000 });
}

try {
  // --- pure-function unit coverage (no subprocess) ---

  // isCaptureCandidate: only Write/Edit/MultiEdit + .html(.htm) files trigger.
  check("isCaptureCandidate: Write + .html -> true", isCaptureCandidate({ tool_name: "Write", tool_input: { file_path: "mock.html" } }));
  check("isCaptureCandidate: Edit + .htm -> true", isCaptureCandidate({ tool_name: "Edit", tool_input: { file_path: "mock.htm" } }));
  check("isCaptureCandidate: MultiEdit + .HTML -> true", isCaptureCandidate({ tool_name: "MultiEdit", tool_input: { file_path: "mock.HTML" } }));
  check("isCaptureCandidate: Write + .md -> false", !isCaptureCandidate({ tool_name: "Write", tool_input: { file_path: "notes.md" } }));
  check("isCaptureCandidate: Read + .html -> false (wrong tool)", !isCaptureCandidate({ tool_name: "Read", tool_input: { file_path: "mock.html" } }));
  check("isCaptureCandidate: no tool_input -> false", !isCaptureCandidate({ tool_name: "Write" }));

  // resolveDejaBin: bare "deja" (PATH-dependent) by default; the human-only LOOM_DEJA_BIN override
  // (mirrors LOOM_MARKITDOWN_BIN) is used AS GIVEN when set, so a daemon whose launch env's PATH
  // doesn't reach the installed `deja` binary can still resolve it.
  delete process.env.LOOM_DEJA_BIN;
  check("resolveDejaBin: no override -> bare \"deja\" (relies on inherited PATH)", resolveDejaBin() === "deja");
  process.env.LOOM_DEJA_BIN = "/opt/deja/bin/deja";
  check("resolveDejaBin: LOOM_DEJA_BIN override -> used as given (absolute path)", resolveDejaBin() === "/opt/deja/bin/deja");
  delete process.env.LOOM_DEJA_BIN;

  // resolveOriginContext (DoD b): resolves origin_prompt from a session->task fixture (a mocked
  // daemon response), decoupled from any live daemon/gateway endpoint.
  const fixture = { originPrompt: "Task title\n\nTask body describing the mockup.", project: "Fire Studio" };
  const okFetch = async (url) => {
    check("resolveOriginContext: requests the session-scoped deja-context endpoint", url.includes("/internal/deja-context/sess-fixture"));
    return { ok: true, json: async () => fixture };
  };
  const ctxOk = await resolveOriginContext("sess-fixture", "4317", okFetch);
  check("resolveOriginContext: resolves originPrompt from the session->task fixture", ctxOk?.originPrompt === fixture.originPrompt);
  check("resolveOriginContext: resolves project from the session->task fixture", ctxOk?.project === fixture.project);

  const notFoundFetch = async () => ({ ok: false, json: async () => ({}) });
  const ctxMiss = await resolveOriginContext("sess-unknown", "4317", notFoundFetch);
  check("resolveOriginContext: a non-ok daemon response resolves to null (never throws)", ctxMiss === null);

  const throwingFetch = async () => { throw new Error("ECONNREFUSED"); };
  const ctxErr = await resolveOriginContext("sess-x", "4317", throwingFetch);
  check("resolveOriginContext: a fetch failure resolves to null (never throws)", ctxErr === null);

  const malformedFetch = async () => ({ ok: true, json: async () => ({ originPrompt: 42 }) });
  const ctxBad = await resolveOriginContext("sess-y", "4317", malformedFetch);
  check("resolveOriginContext: a malformed daemon response resolves to null", ctxBad === null);

  // --- CLI (subprocess) coverage: the non-blocking exit-0 contract (DoD c) ---
  // No real daemon is listening on 59999 and no `deja` binary is installed in this hermetic test env,
  // so every .html run below exercises BOTH the daemon-resolution-failure path AND the Deja-CLI-failure
  // path for real (never a mock) while still asserting the relay never blocks.

  const nonHtml = runHook(path.join(__dirname, "notes.md"));
  check("CLI: a non-.html write exits 0 (never blocks)", nonHtml.status === 0);

  const htmlNoDaemonNoCli = runHook(path.join(__dirname, "mockup.html"));
  check("CLI: an .html write with no daemon + no `deja` binary STILL exits 0 (never blocks)", htmlNoDaemonNoCli.status === 0);

  const wrongTool = runHook(path.join(__dirname, "mockup.html"), "Read");
  check("CLI: a Read (non-Write/Edit) tool exits 0 (never blocks)", wrongTool.status === 0);

  const badStdin = spawnSync(process.execPath, [DEJA_CAPTURE_SCRIPT, "sess-1", "59999"], { input: "not json", encoding: "utf8", timeout: 20000 });
  check("CLI: malformed stdin JSON exits 0 (never blocks)", badStdin.status === 0);

  const missingArgs = spawnSync(process.execPath, [DEJA_CAPTURE_SCRIPT], { input: "{}", encoding: "utf8", timeout: 20000 });
  check("CLI: missing sessionId/port args exits 0 (never blocks)", missingArgs.status === 0);

  // --- writeSessionSettings wiring (DoD a) ---
  ensureDirs();
  const perm = { mode: "acceptEdits", allow: [], deny: [] };

  // dejaCapture ON, no vaultPath -> exactly the deja-capture hook group.
  const dejaOnly = JSON.parse(fs.readFileSync(writeSessionSettings("dc-on", perm, undefined, true), "utf8"));
  const dejaOnlyPtu = dejaOnly.hooks.PostToolUse;
  check("writeSessionSettings(dejaCapture=true): PostToolUse has exactly one Write|Edit group",
    Array.isArray(dejaOnlyPtu) && dejaOnlyPtu.length === 1 && dejaOnlyPtu[0].matcher === "Write|Edit");
  check("writeSessionSettings(dejaCapture=true): command points at deja-capture.mjs + sessionId",
    dejaOnlyPtu[0].hooks[0].command.includes("deja-capture.mjs") && dejaOnlyPtu[0].hooks[0].command.includes("dc-on"));

  // dejaCapture OFF, no vaultPath -> no PostToolUse entry at all (byte-identical to before this card).
  const bothOff = JSON.parse(fs.readFileSync(writeSessionSettings("dc-off", perm), "utf8"));
  check("writeSessionSettings(no vaultPath, dejaCapture off/omitted): NO PostToolUse entry", bothOff.hooks.PostToolUse === undefined);
  const bothOffExplicit = JSON.parse(fs.readFileSync(writeSessionSettings("dc-off-explicit", perm, undefined, false), "utf8"));
  check("writeSessionSettings(dejaCapture=false explicit): NO PostToolUse entry", bothOffExplicit.hooks.PostToolUse === undefined);

  // BOTH docLint (vaultPath) and dejaCapture ON -> two independent Write|Edit groups, docLint's untouched.
  const VAULT = path.join(__dirname, "vault-scratch-deja-capture-test");
  const both = JSON.parse(fs.readFileSync(writeSessionSettings("dc-both", perm, VAULT, true), "utf8"));
  const bothPtu = both.hooks.PostToolUse;
  check("writeSessionSettings(vaultPath + dejaCapture=true): TWO PostToolUse groups", Array.isArray(bothPtu) && bothPtu.length === 2);
  check("writeSessionSettings(vaultPath + dejaCapture=true): the docLint group is unaffected (vault-lint.mjs + vault path)",
    bothPtu[0].matcher === "Write|Edit" && bothPtu[0].hooks[0].command.includes("vault-lint.mjs") && bothPtu[0].hooks[0].command.includes(VAULT));
  check("writeSessionSettings(vaultPath + dejaCapture=true): the deja-capture group is present alongside it",
    bothPtu[1].matcher === "Write|Edit" && bothPtu[1].hooks[0].command.includes("deja-capture.mjs"));

  // vaultPath ON, dejaCapture OFF -> the pre-existing docLint-only shape is completely unaffected by this card.
  const vaultOnly = JSON.parse(fs.readFileSync(writeSessionSettings("dc-vault-only", perm, VAULT), "utf8"));
  const vaultOnlyPtu = vaultOnly.hooks.PostToolUse;
  check("writeSessionSettings(vaultPath only, dejaCapture off): docLint hook unaffected by this card",
    Array.isArray(vaultOnlyPtu) && vaultOnlyPtu.length === 1 && vaultOnlyPtu[0].hooks[0].command.includes("vault-lint.mjs"));

  // Relay/SessionStart hooks (hook-relay.mjs) are untouched regardless of dejaCapture.
  check("writeSessionSettings(dejaCapture=true): SessionStart relay hook unaffected",
    dejaOnly.hooks.SessionStart[0].hooks[0].command.includes("hook-relay.mjs"));

  // --- config resolution + validator posture: dejaCapture is HUMAN-only (card b3bd4841 direction) ---

  check("resolveConfig: dejaCapture defaults to false", resolveConfig(undefined).dejaCapture === false);
  check("resolveConfig: a project override can turn dejaCapture on", resolveConfig({ dejaCapture: true }).dejaCapture === true);
  check("resolveConfig: docLint's own default (true) is unaffected by this card", resolveConfig(undefined).docLint === true);

  check("human/REST validator: dejaCapture:true is ACCEPTED", validateProjectConfigOverride({ dejaCapture: true }).ok === true);
  const agentAttempt = validateAgentProjectConfigOverride({ dejaCapture: true });
  check("agent-facing validator: dejaCapture:true is REJECTED (unknown key, mirrors gateCommand/obsidian.path)", agentAttempt.ok === false);
  check("agent-facing validator: docLint:true still ACCEPTED alongside the dejaCapture rejection",
    validateAgentProjectConfigOverride({ docLint: true }).ok === true);

  // --- GET /internal/deja-context/:sessionId (the daemon-side resolution route) ---

  const dbFile = path.join(process.env.LOOM_HOME, "deja-capture-test.db");
  const db = new Db(dbFile);
  const now = new Date().toISOString();
  const repo = path.join(__dirname, "fixture-repo");
  db.insertProject({ id: "pDeja", name: "Fire Studio", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
  db.insertAgent({ id: "agentDeja", projectId: "pDeja", name: "Deja Worker", startupPrompt: "", position: 0 });
  db.insertTask({ id: "tDeja", projectId: "pDeja", title: "feat: build the landing mockup", body: "Design a landing page mockup for the new pricing tier.", columnKey: "in_progress", position: 1, priority: "p2", createdAt: now, updatedAt: now });
  db.insertSession({ id: "sDeja", projectId: "pDeja", agentId: "agentDeja", engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", taskId: "tDeja" });
  db.insertSession({ id: "sNoTask", projectId: "pDeja", agentId: "agentDeja", engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker" });

  const stub = {};
  const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });
  const expectedOriginPrompt = "feat: build the landing mockup\n\nDesign a landing page mockup for the new pricing tier.";
  try {
    const ok = await app.inject({ method: "GET", url: "/internal/deja-context/sDeja", remoteAddress: "127.0.0.1" });
    check("route: loopback + a session with a task -> 200", ok.statusCode === 200);
    const okBody = ok.json();
    check("route: originPrompt = task title+body", okBody.originPrompt === expectedOriginPrompt);
    check("route: project = the project's name", okBody.project === "Fire Studio");

    const forbidden = await app.inject({ method: "GET", url: "/internal/deja-context/sDeja", remoteAddress: "203.0.113.7" });
    check("route: NON-loopback caller -> 403 (same trust posture as /internal/hook)", forbidden.statusCode === 403);

    const noTask = await app.inject({ method: "GET", url: "/internal/deja-context/sNoTask", remoteAddress: "127.0.0.1" });
    check("route: a session with NO task -> 404 (never blocks the relay's caller)", noTask.statusCode === 404);

    const unknownSession = await app.inject({ method: "GET", url: "/internal/deja-context/does-not-exist", remoteAddress: "127.0.0.1" });
    check("route: an unknown sessionId -> 404", unknownSession.statusCode === 404);

    // --- end-to-end integration: the relay's resolveOriginContext against the REAL live route (no
    // mock), proving resolveOriginContext's proposed URL/response shape actually round-trips, and that
    // runDejaCapture shapes the `deja capture` args exactly as proposed to the manager — via a SPY
    // execFileImpl (no real `deja` binary needed) so the exact invocation shape is asserted directly.
    await app.listen({ port: 0, host: "127.0.0.1" });
    const livePort = app.server.address().port;
    const liveCtx = await resolveOriginContext("sDeja", livePort);
    check("integration: resolveOriginContext against the REAL live route resolves originPrompt", liveCtx?.originPrompt === expectedOriginPrompt);
    check("integration: resolveOriginContext against the REAL live route resolves project", liveCtx?.project === "Fire Studio");

    // resolveDejaDbPath (card b37efb19, RELAY-side, not daemon-side): <home>/.deja/store.sqlite —
    // matches where `deja mcp`/`retrieve` themselves default to via os.homedir(). Pure computation, no
    // filesystem touched, so a plain HOME/USERPROFILE save-and-restore around the call is enough.
    const savedHome = process.env.HOME;
    const savedUserProfile = process.env.USERPROFILE;
    const fakeHome = path.join(__dirname, "fake-home-for-resolve-test");
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    const resolvedDbPath = resolveDejaDbPath();
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUserProfile;
    check("resolveDejaDbPath: <home>/.deja/store.sqlite", resolvedDbPath === path.join(fakeHome, ".deja", "store.sqlite"));

    // A sample dbPath contained within this test's own LOOM_HOME (never touches the real ~/.deja) —
    // runDejaCapture mkdir's its containing dir, so every dbPath used below must stay sandboxed.
    const sampleDbPath = path.join(process.env.LOOM_HOME, "sample-deja-db", "store.sqlite");

    let capturedArgs = null;
    let capturedOpts = null;
    const spyExecFile = (cmd, args, opts, cb) => { capturedArgs = { cmd, args }; capturedOpts = opts; cb(); };
    await runDejaCapture("/tmp/mockup.html", liveCtx.originPrompt, liveCtx.project, sampleDbPath, spyExecFile);
    check("integration: runDejaCapture shells out to the CONFIRMED `deja capture` args, including --db (file positional, then flag pairs)",
      capturedArgs?.cmd === "deja" && JSON.stringify(capturedArgs.args) === JSON.stringify([
        "capture", "/tmp/mockup.html", "--prompt", expectedOriginPrompt, "--project", "Fire Studio", "--db", sampleDbPath,
      ]));
    check("integration: a bare (non-.js) bin is exec'd with NO shell (never — args carry agent-influenced content; shelling them would be an injection surface)",
      capturedOpts?.shell === undefined);
    check("integration: runDejaCapture creates --db's containing directory (best-effort, so a first-ever capture can write)",
      fs.existsSync(path.dirname(sampleDbPath)));

    // Injection-safety regression (blocking fix, post-review): filePath/originPrompt/project are
    // agent/task-influenced content, so NEITHER branch may ever shell them — a `shell:true` win32
    // fallback (the earlier, now-reverted approach) would let shell metacharacters in any of these
    // inject an arbitrary command. Assert no `shell` option on both the bare-command AND node-script
    // branches, with a payload carrying real metacharacters, and that the metacharacters survive
    // UNMANGLED as a single literal arg (proving no shell ever tokenized/interpreted them).
    const hostileOriginPrompt = "task prompt with metachars: & | > < ^ ; $(whoami) `id` \"quoted\"";
    const hostileProject = "proj & echo INJECTED";
    const hostileFilePath = "/tmp/mock up & echo INJECTED.html";

    let hostileBareOpts = null, hostileBareArgs = null;
    await runDejaCapture(hostileFilePath, hostileOriginPrompt, hostileProject, undefined,
      (cmd, args, opts, cb) => { hostileBareArgs = args; hostileBareOpts = opts; cb(); });
    check("injection-safety: bare-command branch never sets shell, even with shell-metacharacter-laden args",
      hostileBareOpts?.shell === undefined);
    check("injection-safety: bare-command branch passes the hostile args through as literal, unmangled array entries",
      hostileBareArgs?.[1] === hostileFilePath && hostileBareArgs?.[3] === hostileOriginPrompt && hostileBareArgs?.[5] === hostileProject);

    process.env.LOOM_DEJA_BIN = "/opt/deja/dist/cli.js";
    let hostileJsOpts = null, hostileJsArgs = null;
    await runDejaCapture(hostileFilePath, hostileOriginPrompt, hostileProject, undefined,
      (cmd, args, opts, cb) => { hostileJsArgs = args; hostileJsOpts = opts; cb(); });
    delete process.env.LOOM_DEJA_BIN;
    check("injection-safety: node-script branch never sets shell either", hostileJsOpts?.shell === undefined);
    check("injection-safety: node-script branch passes the hostile args through as literal, unmangled array entries",
      hostileJsArgs?.[2] === hostileFilePath && hostileJsArgs?.[4] === hostileOriginPrompt && hostileJsArgs?.[6] === hostileProject);

    // With LOOM_DEJA_BIN set to a .js path (the realistic override — an absolute dist/cli.js), the
    // Windows fix routes it THROUGH node (execFile(process.execPath, [bin, ...args])) instead of
    // execing the .js directly (which throws `spawn EFTYPE` on Windows with no shell resolution).
    process.env.LOOM_DEJA_BIN = "/opt/deja/dist/cli.js";
    let jsArgs = null;
    await runDejaCapture("/tmp/mockup.html", "p", "proj", undefined, (cmd, args, opts, cb) => { jsArgs = { cmd, args }; cb(); });
    check("integration: a .js LOOM_DEJA_BIN is invoked via process.execPath (the Windows EFTYPE fix)",
      jsArgs?.cmd === process.execPath && jsArgs.args[0] === "/opt/deja/dist/cli.js" && jsArgs.args[1] === "capture");
    delete process.env.LOOM_DEJA_BIN;

    // With LOOM_DEJA_BIN set to a non-.js path (e.g. a resolved .cmd/.exe or a bare install), runDejaCapture
    // execs the override directly (not bare "deja") — the PATH-unreliable fallback.
    process.env.LOOM_DEJA_BIN = "/opt/deja/bin/deja";
    let overrideArgs = null;
    await runDejaCapture("/tmp/mockup.html", "p", "proj", undefined, (cmd, args, opts, cb) => { overrideArgs = { cmd, args }; cb(); });
    check("integration: LOOM_DEJA_BIN override is used as the exec target instead of bare \"deja\"", overrideArgs?.cmd === "/opt/deja/bin/deja");
    delete process.env.LOOM_DEJA_BIN;

    // ALWAYS called, even with no resolvable context (empty prompt/project) — capturing the mockup
    // source is make-or-break; a Deja-context miss must never skip the capture call.
    let emptyArgs = null;
    await runDejaCapture("/tmp/mockup.html", undefined, undefined, undefined, (cmd, args, opts, cb) => { emptyArgs = args; cb(); });
    check("runDejaCapture: called with empty --prompt/--project when context resolution fails (never skipped)",
      JSON.stringify(emptyArgs) === JSON.stringify(["capture", "/tmp/mockup.html", "--prompt", "", "--project", ""]));

    // --- REAL SPAWN integration (the load-bearing DoD, card b37efb19): every case above injects
    // execFileImpl, so none of them ever actually spawn a process — that gap is exactly what let a
    // Windows `spawn EFTYPE` (execFile-ing a raw .js with no shell) ship silently swallowed. This
    // spawns the RELAY ITSELF as Claude Code would (stdin payload, argv sessionId+port), with
    // HOME/USERPROFILE overridden to a temp dir so the relay's OWN resolveDejaDbPath() call (inside
    // its own process) resolves under that temp dir instead of the human's real ~/.deja, and
    // LOOM_DEJA_BIN pointed at a tiny fixture CLI (test/fixtures/fake-deja-cli.mjs) that mimics
    // `deja capture ... --db <path>` by writing a marker into --db — no built `deja` binary needed.
    const FIXTURE_CLI = path.join(__dirname, "fixtures", "fake-deja-cli.mjs");
    const realSpawnHome = fs.mkdtempSync(path.join(os.tmpdir(), "loom-deja-home-"));
    const realSpawnDb = path.join(realSpawnHome, ".deja", "store.sqlite");
    const realSpawnHtmlFile = path.join(__dirname, "real-spawn-mockup.html");
    const realSpawnPayload = { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: realSpawnHtmlFile }, cwd: __dirname };
    let realSpawnResult;
    try {
      realSpawnResult = spawnSync(process.execPath, [DEJA_CAPTURE_SCRIPT, "sess-1", "59999"], {
        input: JSON.stringify(realSpawnPayload),
        encoding: "utf8",
        timeout: 20000,
        env: { ...process.env, LOOM_DEJA_BIN: FIXTURE_CLI, HOME: realSpawnHome, USERPROFILE: realSpawnHome },
      });
      check("real-spawn: the relay process itself always exits 0 (never blocks the write)", realSpawnResult.status === 0);
      const realSpawnWritten = fs.existsSync(realSpawnDb) ? fs.readFileSync(realSpawnDb, "utf8").trim() : null;
      check("real-spawn: the relay actually spawns the .js fixture CLI cross-platform without throwing EFTYPE/ENOENT (fails on pre-fix code)",
        realSpawnWritten !== null);
      if (realSpawnWritten) {
        const record = JSON.parse(realSpawnWritten.split("\n").pop());
        check("real-spawn: --db resolves to (and the capture lands in) resolveDejaDbPath() under the overridden HOME (proves BUG 2's fix)",
          record.db === realSpawnDb);
        check("real-spawn: the captured file path round-trips through the real spawn", record.file === realSpawnHtmlFile);
      }
    } finally {
      fs.rmSync(realSpawnHome, { recursive: true, force: true });
    }

    // Missing-binary path: a .js LOOM_DEJA_BIN that doesn't exist still never blocks (exit-0 contract).
    process.env.LOOM_DEJA_BIN = path.join(__dirname, "fixtures", "does-not-exist.js");
    let missingBinThrew = false;
    try {
      await runDejaCapture("/tmp/x.html", "p", "proj", undefined);
    } catch {
      missingBinThrew = true;
    } finally {
      delete process.env.LOOM_DEJA_BIN;
    }
    check("real-spawn: a missing .js binary path never throws (non-blocking contract preserved)", !missingBinThrew);
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    db.close();
  }
} finally {
  for (const s of ["dc-on", "dc-off", "dc-off-explicit", "dc-both", "dc-vault-only"]) {
    try { fs.rmSync(path.join(SETTINGS_DIR, `${s}.json`), { force: true }); } catch { /* ignore */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — deja-capture resolves origin_prompt from a session->task fixture (mocked AND against the real GET /internal/deja-context/:sessionId route), its CLI always exits 0 (non-.html / no daemon / no deja binary / malformed input / missing args), writeSessionSettings wires it as an ADDITIVE opt-in PostToolUse Write|Edit hook alongside (never instead of) the existing docLint vault-lint hook, and dejaCapture is HUMAN-only on the agent-facing config validator."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
