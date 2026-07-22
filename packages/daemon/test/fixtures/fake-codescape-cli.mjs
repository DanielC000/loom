#!/usr/bin/env node
// Fixture stand-in for the real `codescape` CLI, used by the real-spawn integration coverage in
// test/codescape-supervisor.mjs (card 894b9b02) and test/codescape-mcp-spawn.mjs (card C2 rewrite,
// e068a2ab). Mimics the subcommands the daemon drives:
//   - `ingest <repoPath> [--out <path>]` — records the call, exits 0 (mirrors the real one-shot ingest).
//     With `--out`, ALSO writes a tiny stub JSON file there (mirrors the real CLI writing a graph.json) so
//     a downstream `fs.existsSync(graphPath)` gate (codescapeMcpServer) sees a real file.
//   - `serve --port <p>`  — records the call, then stays alive (a long-lived foreground process, exactly
//     like the real `serve`) until the supervisor kills it. Card 088afc94 (P4 dynamic registration): ALSO
//     binds a minimal real HTTP listener on that port answering `POST /project` — a simple counter-based
//     id per unique repoRoot (never codescape's real slugify+sha algorithm; this fixture only needs to be
//     internally CONSISTENT, not to reimplement their hash), `mode:"ingested"` the first time a repoRoot
//     is seen, `"already-registered"` on every repeat — so registerProject/resolveProjectId tests can
//     exercise a REAL network round-trip instead of a fake in-process http.Server. Deliberately does NOT
//     append to `fake-codescape-calls.jsonl` (that log is for SUBPROCESS invocations; a registration is an
//     HTTP call against the already-recorded `serve` process, and mixing it in would shift the
//     position-indexed assertions elsewhere in codescape-supervisor.mjs that read that file).
//   - `mcp --graph <path>` — records the call, prints a "server ready on stdio" line (mirrors the real
//     CLI's own startup line), then stays alive reading stdin (a real stdio MCP server would too) until
//     killed — never actually speaks JSON-RPC (no test here exercises the protocol, only the spawn shape).
// Every invocation appends ONE JSON line to `fake-codescape-calls.jsonl` IN ITS OWN CWD (never an
// absolute/env-supplied path) — so the test can prove the CWD CONTRACT (ingest and serve sharing the
// exact same working directory) purely by reading that one file.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";

const args = process.argv.slice(2);
const cwd = process.cwd();
const logFile = path.join(cwd, "fake-codescape-calls.jsonl");

function record(fields) {
  fs.appendFileSync(logFile, `${JSON.stringify({ ...fields, cwd, pid: process.pid })}\n`);
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
} else if (args[0] === "mcp") {
  const graphIdx = args.indexOf("--graph");
  record({ cmd: "mcp", graph: graphIdx === -1 ? null : args[graphIdx + 1] });
  console.log("[fake-codescape] mcp: server ready on stdio");
  setInterval(() => {}, 1 << 30);
} else if (args[0] === "serve") {
  const portIdx = args.indexOf("--port");
  const port = portIdx === -1 ? null : Number(args[portIdx + 1]);
  record({ cmd: "serve", port: portIdx === -1 ? null : args[portIdx + 1] });
  if (port) {
    const registered = new Map(); // repoRoot -> id
    let nextId = 1;
    const server = http.createServer((req, res) => {
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
    server.listen(port, "127.0.0.1");
  }
  // Long-lived foreground, like the real `serve` — stays up until killed.
  setInterval(() => {}, 1 << 30);
} else {
  process.exit(1);
}
