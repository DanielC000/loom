#!/usr/bin/env node
// loom:not-a-test: card fa52f555 — a fixture CLI stub spawned BY sibling tests as a child process, not a
// standalone test itself; only trips the looksLikeTest heuristic via its own error handling.
// Fixture stand-in for the real `codescape` CLI, used by the real-spawn integration coverage in
// test/codescape-supervisor.mjs (card 894b9b02) and test/codescape-mcp-spawn.mjs (card C2 rewrite,
// e068a2ab). Mimics the subcommands the daemon drives:
//   - `ingest <repoPath> [--out <path>]` — records the call, exits 0 (mirrors the real one-shot ingest).
//     With `--out`, ALSO writes a tiny stub JSON file there (mirrors the real CLI writing a graph.json) so
//     a downstream `fs.existsSync(graphPath)` gate (codescapeMcpServer) sees a real file.
//   - `serve --port <p>`  — records the call, then stays alive (a long-lived foreground process, exactly
//     like the real `serve`) until the supervisor kills it. Card 4e0df6ce: DEFAULT behavior models a
//     capable (>= f7a5684) installed binary — `--port 0` binds an OS-assigned ephemeral port (Node's own
//     `listen(0, ...)` semantics), and on EVERY successful invocation (any port, not just 0) the fixture
//     prints the self-reported-bound-port contract line on stdout: `{"url":"http://127.0.0.1:<port>",
//     "port":<port>}`. Env `FAKE_CODESCAPE_PORT_ZERO_UNSUPPORTED=1` instead models an OLDER, pre-f7a5684
//     binary: `--port 0` is rejected outright (exit 1, stderr-only banner, no server, before anything
//     else), and no invocation of this fixture (any port) ever prints the report line. Card 088afc94 (P4 dynamic registration): ALSO
//     binds a minimal real HTTP listener on that port answering `POST /project` — a simple counter-based
//     id per unique repoRoot (never codescape's real slugify+sha algorithm; this fixture only needs to be
//     internally CONSISTENT, not to reimplement their hash), `mode:"ingested"` the first time a repoRoot
//     is seen, `"already-registered"` on every repeat — so registerProject/resolveProjectId tests can
//     exercise a REAL network round-trip instead of a fake in-process http.Server. Deliberately does NOT
//     append to `fake-codescape-calls.jsonl` (that log is for SUBPROCESS invocations; a registration is an
//     HTTP call against the already-recorded `serve` process, and mixing it in would shift the
//     position-indexed assertions elsewhere in codescape-supervisor.mjs that read that file).
//     Card 44d45f81: env `FAKE_CODESCAPE_PORT_REPORT_DELAY_MS=<n>` delays ONLY the self-reported-bound-port
//     stdout line by that many ms after the HTTP listener is already bound and answering — models a real
//     installed binary that is merely SLOW to report under host contention (never an old-binary rejection,
//     which stays synchronous), so a test can exercise `spawnServeSelfReporting`'s timeout/abandon branch
//     and the "slow but within budget" success path without a real subprocess actually taking that long.
//     Companion env `FAKE_CODESCAPE_PORT_REPORT_DELAY_ATTEMPTS=<n>` (default: every invocation) bounds the
//     delay to only the first N `serve` invocations, counted PER CWD via a counter file — same shape as
//     FAKE_CODESCAPE_VERSION_HANG_ATTEMPTS below, and for the same reason: a "slow once, then recovers"
//     scenario needs attempt #1 slow and attempt #2 instant, and a later parent-process env mutation can
//     never reach a child that already spawned with the old env baked in.
//     Card 5a7491d3: ALSO answers `POST /mcp/<anything>` with a minimal `tools/list` JSON-RPC stand-in —
//     the caller passes the tool names to advertise via `params.advertise` and gets them echoed back as
//     `result.tools`; used by codescape-mcp-spawn.mjs's list-completeness check, not a real MCP handshake.
//     Also answers `GET /graph/health` — `{live:true, projects, version:"fake", build:"fake"}` normally.
//     If env `FAKE_CODESCAPE_HEALTH_WEDGE_FILE` is set AND that path exists on disk at request time, the
//     handler deliberately never responds (no `res.end`, connection just sits open) — simulating a serve
//     that's alive and port-bound but genuinely not answering, the exact "wedged" case the supervisor's
//     periodic health probe exists to catch. Checked live per-request (not just at spawn), so a test can
//     flip a running fixture from healthy to wedged (and back) by creating/removing that file.
//     Card 545ef479: env `FAKE_CODESCAPE_HEALTH_500_FILE` — same shape, checked live per-request — answers
//     a 500 (with a JSON body) instead of 200 while that path exists, simulating a route that ANSWERS but
//     can't determine something. Deliberately distinct from the wedge file: the connection is accepted AND
//     a response is sent, never left hanging — this is NOT the wedge case, it is what {@link
//     ../../src/codescape/supervisor.ts}'s health probe must treat as a THIRD outcome (arrived, but not
//     `res.ok`), never counted as wedge evidence.
//     The `build` field is driven by env `FAKE_CODESCAPE_HEALTH_BUILD` (default `"fake"` — matches the
//     `--version` default below, so an env-untouched test sees NO drift): the literal `"__ABSENT__"`
//     omits the `build` key entirely (simulating a pre-build-id serve), `"__NULL__"` sends `build:null`
//     (simulating a build that genuinely can't resolve), anything else is sent verbatim. `version` is
//     independently driven by env `FAKE_CODESCAPE_HEALTH_VERSION` (default `"fake"`) — lets a test vary
//     `version` while `build` matches, to prove drift detection never reads it.
//   - `--version` — build-id drift coverage (card 90550a97): standing in for the INSTALLED binary's own
//     version report the supervisor's bounded `readInstalledBuild()` reads. Driven by env
//     `FAKE_CODESCAPE_INSTALLED_BUILD` (default `"fake"`), modeling the AGREED three-way contract (never
//     two): default/anything else -> exits 0, prints `{version:"fake", build:<value>}` on stdout (a
//     comparable build). `"__NULL__"` -> exits 0, prints `{version:"fake", build:null}` — the HONEST
//     "no build id" answer (e.g. a dist built outside a git checkout), NOT a failure. `"__FAIL__"` ->
//     exits 1 with EMPTY stdout and a usage banner on STDERR ONLY — the real CLI's actual shape today for
//     any unrecognized flag (confirmed by direct repro; an earlier report of "exits 0 with a banner" was
//     wrong — it came from a test that piped `2>&1` into `head`, merging the two streams under test and
//     reading `$?` through the pipe). `"__NONJSON__"` -> exits 0 but prints non-JSON stdout — a
//     hypothetical defect case (never expected in practice, since stdout is guaranteed clean JSON at exit
//     0) kept as defensive coverage that the parser never lenient-rescues a guarantee violation. Only
//     `"__NULL__"` is a non-failure; `"__FAIL__"` and `"__NONJSON__"` must both resolve `failed:true`
//     (never a fabricated build), and they are INDEPENDENT failure paths (a non-zero exit vs. malformed
//     stdout at exit 0), not one case wearing two names.
//     Card f0718488 (version-probe retry-on-timeout): env `FAKE_CODESCAPE_VERSION_HANG_ATTEMPTS=N` makes
//     the first N `--version` invocations (counted PER CWD, via a `fake-codescape-version-hangs.count`
//     file written alongside the calls log — so parallel scenarios using distinct homeDirs never share a
//     counter) HANG — never write stdout, never exit — genuinely exercising the daemon's own bounded
//     subprocess timeout (`runBoundedSplit`'s timer kills it), the same shape a real host-contention stall
//     produces. Invocation N+1 onward responds normally per `FAKE_CODESCAPE_INSTALLED_BUILD` as above. Lets
//     a test drive "timeout once, then succeed on retry" (N=1) or "always times out" (N >= max attempts)
//     without any wall-clock assertion on the RETRY LOGIC itself — only the fixture's own hang duration is
//     wall-clock (bounded by the caller's `versionProbeTimeoutMs`), same as every other timeout in this file.
//   - `mcp --graph <path>` — records the call, prints a "server ready on stdio" line (mirrors the real
//     CLI's own startup line), then stays alive reading stdin (a real stdio MCP server would too) until
//     killed — never actually speaks JSON-RPC (no test here exercises the protocol, only the spawn shape).
// Every invocation appends ONE JSON line to `fake-codescape-calls.jsonl` IN ITS OWN CWD (never an
// absolute/env-supplied path) — so the test can prove the CWD CONTRACT (ingest and serve sharing the
// exact same working directory) purely by reading that one file. Each recorded line also carries
// `codescapeHomeEnv` (the invocation's own `CODESCAPE_HOME` env var, or `null` if unset) — card 194d343d:
// proves the daemon pins the store explicitly via env on both ingest and serve, not just cwd.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";

const args = process.argv.slice(2);
const cwd = process.cwd();
const logFile = path.join(cwd, "fake-codescape-calls.jsonl");

function record(fields) {
  // Card 194d343d: also record the spawn's CODESCAPE_HOME env var (null if unset) so a test can prove
  // the daemon pins it explicitly on both ingest and serve, not just shares a cwd.
  fs.appendFileSync(logFile, `${JSON.stringify({ ...fields, cwd, codescapeHomeEnv: process.env.CODESCAPE_HOME ?? null, pid: process.pid })}\n`);
}

if (args[0] === "ingest") {
  const outIdx = args.indexOf("--out");
  const out = outIdx === -1 ? null : args[outIdx + 1];
  record({ cmd: "ingest", repoPath: args[1], out });
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ nodes: [], edges: [], flows: [] }));
  }
  process.exit(0);
} else if (args[0] === "--version") {
  // Wrapped in a function so the hang branch can `return` early — `setInterval` does NOT block, so
  // without an early return the code below it would still run synchronously and defeat the hang.
  (function runVersion() {
    const hangAttempts = Number(process.env.FAKE_CODESCAPE_VERSION_HANG_ATTEMPTS || "0");
    if (hangAttempts > 0) {
      const counterFile = path.join(cwd, "fake-codescape-version-hangs.count");
      let prior = 0;
      try { prior = Number(fs.readFileSync(counterFile, "utf8")) || 0; } catch { /* first invocation — starts at 0 */ }
      const invocationNumber = prior + 1;
      fs.writeFileSync(counterFile, String(invocationNumber));
      if (invocationNumber <= hangAttempts) {
        // Never write stdout, never exit — the caller's own bounded timeout (runBoundedSplit) is what
        // ends this, exactly like a real subprocess stalled by host contention.
        setInterval(() => {}, 1 << 30);
        return;
      }
    }
    const raw = process.env.FAKE_CODESCAPE_INSTALLED_BUILD;
    if (raw === "__FAIL__") {
      // The real CLI's actual shape today: non-zero exit, EMPTY stdout, usage banner on STDERR ONLY.
      process.stderr.write("usage: codescape ingest <path-to-loom> ...\n       codescape diff ... / mcp ... / mcp-usage ... / serve ...\n");
      process.exit(1);
    }
    if (raw === "__NONJSON__") { console.log("not json"); process.exit(0); } // exit 0 but malformed stdout (hypothetical defect)
    console.log(JSON.stringify({ version: "fake", build: raw === "__NULL__" ? null : (raw === undefined ? "fake" : raw) }));
    process.exit(0);
  })();
} else if (args[0] === "mcp") {
  const graphIdx = args.indexOf("--graph");
  record({ cmd: "mcp", graph: graphIdx === -1 ? null : args[graphIdx + 1] });
  console.log("[fake-codescape] mcp: server ready on stdio");
  setInterval(() => {}, 1 << 30);
} else if (args[0] === "serve") {
  const portIdx = args.indexOf("--port");
  const portArg = portIdx === -1 ? null : args[portIdx + 1];
  const requestedPort = portArg == null ? null : Number(portArg);
  // Card 4e0df6ce: env FAKE_CODESCAPE_PORT_ZERO_UNSUPPORTED=1 makes this fixture stand in for a codescape
  // build PREDATING f7a5684 (the real shape today, per the Codescape peer's own delivered contract):
  // `--port 0` is rejected OUTRIGHT — exit 1, stderr only, no server ever starts, before doing anything
  // else — and this "old" binary never emits the self-reported-bound-port JSON contract line on stdout AT
  // ALL, even on an ordinary explicit-port invocation (that reporting was added in the SAME commit as
  // --port 0 support), unlike the capable default behavior below.
  const portZeroUnsupported = process.env.FAKE_CODESCAPE_PORT_ZERO_UNSUPPORTED === "1";
  // Card 44d45f81: FAKE_CODESCAPE_PORT_REPORT_DELAY_ATTEMPTS bounds the delay to the first N `serve`
  // invocations (counted PER CWD, via a counter file — same shape as FAKE_CODESCAPE_VERSION_HANG_ATTEMPTS
  // above, and for the same reason: a delayed-then-recovers scenario needs attempt #1 slow and attempt #2
  // instant WITHOUT racing a parent-process env mutation against an already-spawned child, which cannot
  // observe an env change made after it started). Omitted (or 0) means "every invocation", matching the
  // simpler unconditional-delay case a single-attempt test needs.
  const delayAttempts = Number(process.env.FAKE_CODESCAPE_PORT_REPORT_DELAY_ATTEMPTS || "0");
  let delayAppliesThisInvocation = true;
  if (delayAttempts > 0) {
    const delayCounterFile = path.join(cwd, "fake-codescape-port-delay.count");
    let priorDelayCount = 0;
    try { priorDelayCount = Number(fs.readFileSync(delayCounterFile, "utf8")) || 0; } catch { /* first invocation — starts at 0 */ }
    const thisInvocationNumber = priorDelayCount + 1;
    fs.writeFileSync(delayCounterFile, String(thisInvocationNumber));
    delayAppliesThisInvocation = thisInvocationNumber <= delayAttempts;
  }
  if (portZeroUnsupported && portArg === "0") {
    record({ cmd: "serve", port: portArg, rejected: "port-zero-unsupported" });
    process.stderr.write(`invalid --port "0"\n`);
    process.exit(1);
  }
  record({ cmd: "serve", port: portArg });
  if (requestedPort != null) {
    const registered = new Map(); // repoRoot -> id
    let nextId = 1;
    const server = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/graph/health") {
        const wedgeFile = process.env.FAKE_CODESCAPE_HEALTH_WEDGE_FILE;
        if (wedgeFile && fs.existsSync(wedgeFile)) return; // simulate wedged: accept, never respond
        // Card 545ef479 (Defect 2): env FAKE_CODESCAPE_HEALTH_500_FILE, checked live per-request (same
        // shape as the wedge file above) — when set AND that path exists, answers a 500 instead of 200,
        // simulating a route that genuinely can't determine something (e.g. their own from-source build-id
        // resolution failing) WITHOUT ever failing to respond at all. This is deliberately NOT the wedge
        // case: the connection is accepted AND answered, just with an error status.
        const errorFile = process.env.FAKE_CODESCAPE_HEALTH_500_FILE;
        if (errorFile && fs.existsSync(errorFile)) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "simulated internal error" }));
          return;
        }
        const rawBuild = process.env.FAKE_CODESCAPE_HEALTH_BUILD;
        const rawVersion = process.env.FAKE_CODESCAPE_HEALTH_VERSION;
        const body = { live: true, projects: registered.size, version: rawVersion === undefined ? "fake" : rawVersion };
        if (rawBuild !== "__ABSENT__") body.build = rawBuild === "__NULL__" ? null : (rawBuild === undefined ? "fake" : rawBuild);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
        return;
      }
      // Card 5a7491d3: a minimal `tools/list` JSON-RPC stand-in on the mounted MCP route itself
      // (`/mcp/<id>` or `/mcp/<id>/<worktreeId>`) — real enough to round-trip a real HTTP POST for the
      // list-completeness check in codescape-mcp-spawn.mjs, without implementing the full MCP handshake
      // (no test here needs anything beyond tools/list). The caller supplies the advertised tool names
      // itself via `params.advertise` — this fixture has no opinion on what a "real" codescape server
      // would list, it only echoes back whatever the test wants to simulate being mounted.
      if (req.method === "POST" && req.url.startsWith("/mcp/")) {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => {
          let parsed;
          try { parsed = JSON.parse(body); } catch { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "invalid JSON body" })); return; }
          const { id, method, params } = parsed ?? {};
          if (method !== "tools/list") {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code: -32601, message: `method not found: ${method}` } }));
            return;
          }
          const advertise = Array.isArray(params?.advertise) ? params.advertise : [];
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result: { tools: advertise.map((name) => ({ name })) } }));
        });
        return;
      }
      if (req.method === "POST" && req.url === "/project") {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => {
          let parsed;
          try { parsed = JSON.parse(body); } catch { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "project registration requires a JSON body" })); return; }
          const { repoRoot, graphPath } = parsed ?? {};
          if (typeof repoRoot !== "string" || !repoRoot) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "project registration requires a string repoRoot" }));
            return;
          }
          let id = registered.get(repoRoot);
          const mode = id ? "already-registered" : "ingested";
          if (!id) { id = `fake-proj-${nextId++}`; registered.set(repoRoot, id); }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, id, repoRoot, graphPath: graphPath ?? null, mode, nodes: 0, edges: 0, flows: 0 }));
        });
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "not found" }));
    });
    server.listen(requestedPort, "127.0.0.1", () => {
      // Card 4e0df6ce: the self-reported-bound-port contract — printed on stdout on EVERY successful
      // `serve` invocation (NOT gated to --port 0; both fields derive from the real bound address, never
      // the requested one), unless this fixture is standing in for an old, pre-f7a5684 binary
      // (portZeroUnsupported), which never had this capability at all.
      if (!portZeroUnsupported) {
        const bound = server.address().port;
        // Card 44d45f81: FAKE_CODESCAPE_PORT_REPORT_DELAY_MS delays only THIS line — the server is already
        // listening (and answering /graph/health etc.) before it fires, mirroring a real installed binary
        // that is slow to REPORT, never slow to actually bind.
        const delayMs = delayAppliesThisInvocation ? Number(process.env.FAKE_CODESCAPE_PORT_REPORT_DELAY_MS || "0") : 0;
        const emit = () => console.log(JSON.stringify({ url: `http://127.0.0.1:${bound}`, port: bound }));
        if (delayMs > 0) setTimeout(emit, delayMs);
        else emit();
      }
    });
  }
  // Long-lived foreground, like the real `serve` — stays up until killed.
  setInterval(() => {}, 1 << 30);
} else {
  process.exit(1);
}
