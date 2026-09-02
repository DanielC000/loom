import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card `350bc307`: wire codescapeUnclassifiedTools (pty/host.ts) to the REAL mounted Codescape MCP
// server — nothing called it against a live server before this card; it was only exercised against
// two in-memory arrays (codescape-mcp-spawn.mjs) or a hand-rolled "not a real MCP handshake" fixture
// stand-in. This file proves the NEW pieces, hermetically, network-free beyond loopback:
//
//   (probeAdvertisedTools) a REAL `initialize` + `tools/list` round-trip via the SAME
//     `@modelcontextprotocol/sdk` streamable-HTTP CLIENT class every `claude` spawn's own MCP client
//     uses — against a genuinely spec-compliant fixture server built from the SDK's own SERVER pieces
//     (McpServer + StreamableHTTPServerTransport), the identical machinery this daemon's OWN MCP routers
//     (mcp/server.ts et al.) run in production. Shared mechanism (DoD-5): both sides speak the real
//     protocol via the same SDK package, so a server that genuinely drifted its tool registration would
//     be observed here exactly as it would in production — this is not a hand-rolled stand-in.
//     - clean set (no drift) -> codescapeUnclassifiedTools finds nothing.
//     - POSITIVE CONTROL: one extra, unclassified tool name -> caught, and ONLY that name.
//     - unreachable server -> ok:false, never throws.
//
//   (writeToolDriftState / readCodescapeToolDriftNote) the persisted-state round trip that is the
//     ADDRESSED signal (DoD-2, not a log line): no state / empty finding / corrupt file all read back
//     as "", a real finding reads back as a `[loom:codescape-tool-drift]`-tagged note naming every tool.
//
//   (composeResumeDocOperationalNotes integration) the note actually lands in the SAME already-
//     established `[loom:*]` operational-note channel injected into every Platform Lead kickoff
//     (sessions/platform-lead-prompt.ts) — end to end, not just "the two functions compose in theory".
//
//   (CodescapeSupervisor.checkToolDrift, via the runToolDriftProbeForTest seam) the actual call site
//     wired into the health-probe cycle: port + a resolvable project id (test-seeded, mirroring the
//     class's existing `port` seam) -> a real probe against the SDK fixture server -> persisted state
//     -> getUnclassifiedTools() latch. Fail-soft (DoD-3): no live port, and no registered project id,
//     both clean-skip rather than throw or persist anything. Also proves DoD-5: a pre-seeded STALE,
//     pre-fix-shaped persisted state (the old bogus all-tools-unclassified finding) is overwritten by
//     the very next successful probe — no manual clearing needed.
//
// Card `76a57ff3`: every fixture in this file registers BARE tool names (`bareToolNames`), not the
// PREFIXED names `CODESCAPE_TOOL_ALLOW`/`CODESCAPE_WRITE_TOOLS` store — a real Codescape MCP server has
// no way to know the "codescape" mount name THIS client chooses for it, so it can only ever advertise
// bare names. The PRIOR version of this file registered fixtures under the prefixed array names
// directly, which made every negative/positive control CIRCULAR: it reproduced the arrays' own naming
// convention rather than a real server's, so it could never observe the real bug (probeAdvertisedTools
// comparing bare probe names against a prefixed known-set, reporting the entire advertised set as
// unclassified forever). probeAdvertisedTools itself now normalizes at the boundary
// (`toPrefixedCodescapeToolNames`, `pty/host.ts`) — this file's fixtures matching real-server shape is
// what makes that normalization actually get exercised, rather than silently never engaging.
//
// Run: 1) build (turbo builds shared first), 2) node test/codescape-tool-drift-probe.mjs
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-cs-tooldrift-${Date.now()}-${process.pid}`);
fs.mkdirSync(tmpHome, { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { probeAdvertisedTools } = await import("../dist/codescape/tools-probe.js");
const { writeToolDriftState, readCodescapeToolDriftNote, toolDriftStatePath, TOOL_DRIFT_STATE_BASENAME } = await import("../dist/codescape/drift-notice.js");
const { CodescapeSupervisor } = await import("../dist/codescape/supervisor.js");
const { CODESCAPE_TOOL_ALLOW, CODESCAPE_WRITE_TOOLS, CODESCAPE_TOOL_PREFIX, codescapeUnclassifiedTools } = await import("../dist/pty/host.js");
const { composeResumeDocOperationalNotes } = await import("../dist/sessions/platform-lead-prompt.js");
const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");

const fullyKnownTools = [...CODESCAPE_TOOL_ALLOW, ...CODESCAPE_WRITE_TOOLS];
// Card 76a57ff3: a REAL Codescape MCP server advertises its OWN, BARE tool names — it has no way to know
// the "codescape" mount name THIS client chooses for it, so it can never advertise the mcp__codescape__
// prefix itself. Every fixture below registers BARE names for exactly this reason. The prior version of
// this file registered fixtures under the PREFIXED names taken straight from CODESCAPE_TOOL_ALLOW/
// CODESCAPE_WRITE_TOOLS — which made every negative/positive control CIRCULAR: it could never observe the
// real bug, since it reproduced the ARRAYS' own naming convention rather than a real server's.
const bareToolNames = fullyKnownTools.map((t) => t.slice(CODESCAPE_TOOL_PREFIX.length));

function pickPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const p = addr && typeof addr === "object" ? addr.port : null;
      srv.close(() => (p ? resolve(p) : reject(new Error("no free port"))));
    });
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      if (!body) return resolve(undefined);
      try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}

// A genuinely spec-compliant, STATELESS (sessionIdGenerator: undefined) MCP server, mirroring how
// mcp/server.ts's own `handle()` builds a fresh McpServer+transport per request — the exact production
// shape, not a simplification. Registers `toolNames` as trivial no-op tools; `/mcp/*` is the only route,
// matching the real mount's path shape (the id segment itself is never inspected — tools/list is a
// property of the server's own registration, not of a specific scope, per this card's own evidence).
function startFixtureMcpServer(toolNames) {
  const httpServer = http.createServer((req, res) => {
    (async () => {
      if (!req.url.startsWith("/mcp/")) { res.writeHead(404); res.end(); return; }
      const server = new McpServer({ name: "fixture-codescape", version: "1.0.0" });
      for (const name of toolNames) {
        server.registerTool(name, { description: `fixture tool ${name}`, inputSchema: {} }, async () => ({ content: [{ type: "text", text: "ok" }] }));
      }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { void transport.close(); void server.close(); });
      let body;
      try { body = await readBody(req); } catch { res.writeHead(400); res.end(); return; }
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    })().catch((err) => { try { res.writeHead(500); res.end(String(err)); } catch { /* response may already be sent */ } });
  });
  return new Promise((resolve, reject) => {
    httpServer.on("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      const addr = httpServer.address();
      resolve({ port: addr.port, close: () => new Promise((r) => httpServer.close(r)) });
    });
  });
}

// ===================== probeAdvertisedTools: real handshake, real server, both polarities =====================
{
  // Fixture registers BARE names — what a real Codescape MCP server actually advertises.
  const fixture = await startFixtureMcpServer(bareToolNames);
  try {
    const res = await probeAdvertisedTools(`http://127.0.0.1:${fixture.port}/mcp/fake-id`, 5000);
    check("(probe, e2e) a real round-trip against a real SDK server succeeds", res.ok === true);
    check("(probe, e2e) it returns the registered BARE names NORMALIZED to the mcp__codescape__-prefixed form",
      Array.isArray(res.tools) && res.tools.length === fullyKnownTools.length && fullyKnownTools.every((t) => res.tools.includes(t)));
    check("(probe, e2e, negative control) codescapeUnclassifiedTools on a clean (bare-advertising) server finds nothing",
      codescapeUnclassifiedTools(res.tools).length === 0);
  } finally {
    await fixture.close();
  }
}
{
  // POSITIVE CONTROL (DoD-5): a server genuinely advertising ONE extra, unclassified BARE name — proves
  // the check can fail, wired against a real protocol round-trip, not just the in-memory arrays.
  const drifted = [...bareToolNames, "mystery_tool"];
  const fixture = await startFixtureMcpServer(drifted);
  try {
    const res = await probeAdvertisedTools(`http://127.0.0.1:${fixture.port}/mcp/fake-id`, 5000);
    check("(probe, e2e, positive control) round-trip against a DRIFTED real server succeeds", res.ok === true);
    const unclassified = codescapeUnclassifiedTools(res.tools ?? []);
    check("(probe, e2e, positive control) the drift check catches EXACTLY the one extra tool over the wire",
      JSON.stringify(unclassified) === JSON.stringify(["mcp__codescape__mystery_tool"]));
  } finally {
    await fixture.close();
  }
}
{
  // Negative case: nothing listening at all — never throws, ok:false.
  const deadPort = await pickPort(); // reserved-then-released, so nothing is listening
  const res = await probeAdvertisedTools(`http://127.0.0.1:${deadPort}/mcp/fake-id`, 1500);
  check("(probe, negative) an unreachable server resolves ok:false, never throws", res.ok === false);
  check("(probe, negative) it reports an error string", typeof res.error === "string" && res.error.length > 0);
}

// ===================== writeToolDriftState / readCodescapeToolDriftNote: the addressed-signal round trip =====================
{
  const homeA = path.join(tmpHome, "home-a");
  const csHomeA = path.join(homeA, "codescape");
  check("(notice) no state file at all ⇒ note is empty", readCodescapeToolDriftNote(homeA) === "");

  writeToolDriftState(csHomeA, { checkedAt: "2026-08-28T00:00:00.000Z", unclassified: [], advertisedCount: 15 });
  check("(notice) a CLEAN state (empty unclassified) ⇒ note is still empty", readCodescapeToolDriftNote(homeA) === "");
  check("(notice) toolDriftStatePath resolves under <codescapeHomeDir>/" + TOOL_DRIFT_STATE_BASENAME,
    toolDriftStatePath(csHomeA) === path.join(csHomeA, TOOL_DRIFT_STATE_BASENAME) && fs.existsSync(toolDriftStatePath(csHomeA)));

  writeToolDriftState(csHomeA, { checkedAt: "2026-08-28T01:23:45.000Z", unclassified: ["mcp__codescape__mystery_tool", "mcp__codescape__another"], advertisedCount: 17 });
  const note = readCodescapeToolDriftNote(homeA);
  check("(notice) a real finding ⇒ a non-empty, tagged note", note.startsWith("[loom:codescape-tool-drift]"));
  check("(notice) the note names every unclassified tool", note.includes("mcp__codescape__mystery_tool") && note.includes("mcp__codescape__another"));
  check("(notice) the note names the fix (codescapeUnclassifiedTools + the two arrays in pty/host.ts)",
    note.includes("codescapeUnclassifiedTools") && note.includes("CODESCAPE_TOOL_ALLOW") && note.includes("CODESCAPE_WRITE_TOOLS"));
  check("(notice) the note carries the checkedAt timestamp", note.includes("2026-08-28T01:23:45.000Z"));
  check("(notice) the note is explicit about observing the RUNNING process, not source",
    /running.?process|LIVE server/i.test(note));

  // Corrupt/garbage state file: fail soft, never throw.
  fs.mkdirSync(csHomeA, { recursive: true });
  fs.writeFileSync(toolDriftStatePath(csHomeA), "{ not valid json");
  check("(notice) a corrupt state file ⇒ note is empty, no throw", readCodescapeToolDriftNote(homeA) === "");
}

// ===================== composeResumeDocOperationalNotes: the note actually lands in the Lead's own kickoff channel =====================
{
  const homeB = path.join(tmpHome, "home-b");
  const csHomeB = path.join(homeB, "codescape");
  const resumeDocPath = path.join(homeB, "PLATFORM-LEAD-RESUME.md");
  fs.mkdirSync(homeB, { recursive: true });
  fs.writeFileSync(resumeDocPath, "# resume\n");

  const notesClean = composeResumeDocOperationalNotes(homeB, resumeDocPath);
  check("(integration) no codescape state yet ⇒ notes carry nothing tool-drift-related", !notesClean.includes("codescape-tool-drift"));

  writeToolDriftState(csHomeB, { checkedAt: "2026-08-28T02:00:00.000Z", unclassified: ["mcp__codescape__drift_x"], advertisedCount: 16 });
  const notesDrifted = composeResumeDocOperationalNotes(homeB, resumeDocPath);
  check("(integration) a real finding rides the SAME [loom:*] operational-note channel every Lead spawn already reads",
    notesDrifted.includes("[loom:codescape-tool-drift]") && notesDrifted.includes("mcp__codescape__drift_x"));

  writeToolDriftState(csHomeB, { checkedAt: "2026-08-28T03:00:00.000Z", unclassified: [], advertisedCount: 16 });
  const notesRecovered = composeResumeDocOperationalNotes(homeB, resumeDocPath);
  check("(integration) once the finding clears, the next kickoff carries nothing tool-drift-related",
    !notesRecovered.includes("codescape-tool-drift"));
}

// ===================== CodescapeSupervisor.checkToolDrift (via the test seam): the ACTUAL call site =====================
{
  // Fixture registers BARE names, exactly like a real Codescape MCP server would — this is the
  // production call site, so it's the one place a stale, pre-fix all-unclassified persisted state
  // (DoD-5) can be proven to self-heal on the very next successful probe.
  const fixture = await startFixtureMcpServer([...bareToolNames, "wired_e2e_drift"]);
  // Mirrors the real relationship (paths.ts's CODESCAPE_HOME_DIR = path.join(LOOM_HOME, "codescape")):
  // `homeLoomC` is the LOOM_HOME equivalent readCodescapeToolDriftNote expects, `homeCodescapeC` is what
  // the supervisor's own `homeDir` opt takes (it operates in terms of ITS OWN home, one level down).
  const homeLoomC = path.join(tmpHome, "home-c");
  const homeCodescapeC = path.join(homeLoomC, "codescape");
  // DoD-5: simulate the exact stale residue the PRE-FIX bug would have left behind — every advertised
  // tool (all 16, including the genuinely-drifted one) reported unclassified — written under an old
  // timestamp, as if by a probe tick that ran before this fix went live.
  writeToolDriftState(homeCodescapeC, {
    checkedAt: "2026-01-01T00:00:00.000Z",
    unclassified: [...fullyKnownTools, "mcp__codescape__wired_e2e_drift"],
    advertisedCount: fullyKnownTools.length + 1,
  });
  try {
    const sup = new CodescapeSupervisor({
      homeDir: homeCodescapeC,
      port: fixture.port,
      seedProjectId: { repoRoot: path.join(tmpHome, "repo-c"), projectId: "fixture-project-id" },
      toolsProbeTimeoutMs: 5000,
    });
    check("(wired) getUnclassifiedTools() is null before any probe has run (in-memory latch, independent of the pre-seeded stale file)",
      sup.getUnclassifiedTools() === null);
    check("(wired, DoD-5 setup) the pre-seeded STALE state still reads back as the old bogus all-16 finding",
      readCodescapeToolDriftNote(homeLoomC).includes("mcp__codescape__list_flows") && readCodescapeToolDriftNote(homeLoomC).includes("2026-01-01"));
    await sup.runToolDriftProbeForTest();
    check("(wired) after one probe pass, getUnclassifiedTools() reflects EXACTLY the one genuinely-drifted (prefixed) tool — not the whole advertised set",
      JSON.stringify(sup.getUnclassifiedTools()) === JSON.stringify(["mcp__codescape__wired_e2e_drift"]));
    const noteAfter = readCodescapeToolDriftNote(homeLoomC);
    check("(wired) it ALSO persisted the same finding to the state file checkToolDrift owns",
      noteAfter.includes("mcp__codescape__wired_e2e_drift"));
    check("(wired, DoD-5) the stale all-16 finding is GONE — a genuinely-known tool like list_flows is no longer reported",
      !noteAfter.includes("mcp__codescape__list_flows"));
    check("(wired, DoD-5) the stale checkedAt timestamp is GONE — the fresh probe's own timestamp replaced it",
      !noteAfter.includes("2026-01-01"));
  } finally {
    await fixture.close();
  }
}
{
  // Fail-soft (DoD-3): no live port at all ⇒ clean skip, never throws, nothing persisted.
  const homeD = path.join(tmpHome, "home-d-codescape");
  const sup = new CodescapeSupervisor({ homeDir: homeD, seedProjectId: { repoRoot: path.join(tmpHome, "repo-d"), projectId: "fixture-project-id" } });
  await sup.runToolDriftProbeForTest();
  check("(wired, fail-soft) no live port ⇒ clean skip, getUnclassifiedTools() stays null", sup.getUnclassifiedTools() === null);
  check("(wired, fail-soft) nothing was persisted", !fs.existsSync(toolDriftStatePath(homeD)));
}
{
  // Fail-soft (DoD-3): a live port but NO registered project id yet ⇒ clean skip (nothing resolvable to probe against).
  const fixture = await startFixtureMcpServer(fullyKnownTools);
  const homeE = path.join(tmpHome, "home-e-codescape");
  try {
    const sup = new CodescapeSupervisor({ homeDir: homeE, port: fixture.port });
    await sup.runToolDriftProbeForTest();
    check("(wired, fail-soft) no project id registered yet ⇒ clean skip, getUnclassifiedTools() stays null", sup.getUnclassifiedTools() === null);
    check("(wired, fail-soft) nothing was persisted", !fs.existsSync(toolDriftStatePath(homeE)));
  } finally {
    await fixture.close();
  }
}

try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — Codescape tool-drift live-wiring (card 350bc307, naming fix card 76a57ff3): every fixture below registers BARE tool names (what a real server actually advertises — it cannot know the \"codescape\" mount-name prefix a client will choose), so probeAdvertisedTools's own boundary normalization (toPrefixedCodescapeToolNames) is exercised for real, not against a circular fixture built from the arrays under test; catches a clean set as clean AND a one-tool drift over the wire (positive control), and never throws against an unreachable server; writeToolDriftState/readCodescapeToolDriftNote round-trip correctly (absent/clean/corrupt all read back empty, fail-soft); the note lands in composeResumeDocOperationalNotes — the SAME [loom:*] channel already injected into every Platform Lead kickoff, the ADDRESSED signal DoD-2 requires, not a log line; and CodescapeSupervisor.checkToolDrift (via its runToolDriftProbeForTest seam) is the real call site — wired end to end against a live server (including DoD-5: a pre-seeded STALE pre-fix all-unclassified state file is overwritten by the very next successful probe, no manual clearing needed) AND fail-soft (no port, or no registered project id) in both negative cases, never persisting or throwing."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
