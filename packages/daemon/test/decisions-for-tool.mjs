import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// decisions_for (card dbad4b59): the @decision-anchor index MCP tool, backed by a trivial index built by
// grepping the CALLING PROJECT'S OWN repo at call time — never a persisted snapshot. Exercises all four
// query shapes (path / 8-hex id reverse lookup / symbol / omitted-enumerate-all) against a REAL, hermetic
// fixture repo carrying real anchors and real docs/adr, docs/decisions, docs/investigations records —
// mirrors decision-records.mjs's own three-store resolution, and both DoD-4 orphan directions (an
// anchored id with no record, and a record nothing anchors). DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE,
// hermetic like tasks-get-taskid-alias.mjs: an isolated LOOM_HOME + sandboxed HOME, a REAL Db, and the
// REAL TaskMcpRouter over an in-process MCP InMemoryTransport (no HTTP, no daemon, no pty).
//
// Run: 1) build (turbo builds shared first), 2) node test/decisions-for-tool.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-dft-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { WakeService } = await import("../dist/orchestration/wake.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// --- Fixture repo: a throwaway directory with a real anchor+record convention, entirely disjoint from
// this repo's own docs/adr etc. (so this test can never accidentally observe or corrupt real records). ---
const repoRoot = path.join(tmpHome, "fixture-repo");
const mk = (rel) => fs.mkdirSync(path.join(repoRoot, rel), { recursive: true });
const write = (rel, content) => { fs.mkdirSync(path.dirname(path.join(repoRoot, rel)), { recursive: true }); fs.writeFileSync(path.join(repoRoot, rel), content); };

mk("docs/adr");
mk("docs/decisions");
mk("docs/investigations/cccccccc-some-investigation");
mk("src");

// aaaaaaaa: a real ADR record, anchored once in src/foo.ts.
write("docs/adr/aaaaaaaa-example-decision.md", "# aaaaaaaa — Example decision title\n\n## Status\n\naccepted\n");
// bbbbbbbb: a real decisions/ record with NO inbound anchor anywhere (orphan-record signal).
write("docs/decisions/bbbbbbbb-local-decision.md", "# bbbbbbbb — Local decision title\n\nBody.\n");
// cccccccc: an investigations/ record (register #3), anchored in src/bar.ts.
write("docs/investigations/cccccccc-some-investigation/findings.md", "# cccccccc — Investigation title\n\nFindings body.\n");

// src/foo.ts: TWO anchors — aaaaaaaa (resolves) and dddddddd (a dangling anchor: no record anywhere).
write(
  "src/foo.ts",
  "// @decision aaaaaaaa — do not do X, see the record\n" +
  "export function doThing() {}\n" +
  "\n" +
  "// @decision dddddddd — this id has no record on purpose\n" +
  "export const ORPHAN_MARKER = 1;\n",
);
// src/bar.ts: cccccccc anchored right above a const declaration used for the symbol-mode test.
write("src/bar.ts", "// @decision cccccccc — see the investigation findings\nexport const BAR_SYMBOL = 42;\n");

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pDecisions", name: "Decisions Fixture", repoPath: repoRoot, vaultPath: repoRoot, config: {}, createdAt: now, archivedAt: null, reserved: false });

const fakePty = { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getActiveTurnOrigin: () => null };
const wakes = new WakeService({ db, pty: fakePty, resume: () => {} });

try {
  const server = new TaskMcpRouter(db, wakes).buildServer("pDecisions", "S");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "decisions-for-tool-test", version: "0" });
  await client.connect(clientT);
  const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

  // (1) PATH mode: src/foo.ts carries both a resolvable anchor and a dangling (orphan) one.
  const byPath = await call("decisions_for", { query: "src/foo.ts" });
  check("(1a) path mode reports mode:\"path\" and the right file", byPath.mode === "path" && byPath.path === "src/foo.ts");
  check("(1b) path mode finds BOTH anchor sites", byPath.anchorCount === 2);
  const aaaa = byPath.decisions.find((d) => d.id === "aaaaaaaa");
  check("(1c) the resolvable anchor resolves to its record path+title, orphan:false",
    !!aaaa && !aaaa.orphan && aaaa.record?.path === "docs/adr/aaaaaaaa-example-decision.md" && aaaa.record?.title === "Example decision title");
  const dddd = byPath.decisions.find((d) => d.id === "dddddddd");
  check("(1d) the dangling anchor (no record) is reported, not silently skipped — orphan:true, record:null (DoD-4)",
    !!dddd && dddd.orphan === true && dddd.record === null);
  check("(1e) path mode's own orphanAnchorCount matches the one orphan found", byPath.orphanAnchorCount === 1);

  // (2) A path escape is refused, not silently resolved outside the repo root.
  const escape = await call("decisions_for", { query: "../../outside.ts" });
  check("(2) a path escaping the repo root is refused with {error}", typeof escape.error === "string");

  // (3) ID reverse-lookup mode — "what does this record govern": aaaaaaaa IS cited, orphan:false.
  const idHit = await call("decisions_for", { query: "aaaaaaaa" });
  check("(3a) id mode reports mode:\"record\" with the resolved record", idHit.mode === "record" && idHit.record?.title === "Example decision title");
  check("(3b) id mode's anchoredIn names the real citing site", idHit.anchoredIn.length === 1 && idHit.anchoredIn[0].file === "src/foo.ts" && idHit.anchoredIn[0].line === 1);
  check("(3c) a cited, resolvable id is NOT orphan", idHit.orphan === false);

  // (4) ID reverse-lookup, orphan-RECORD direction: bbbbbbbb has a real record but NO inbound anchor.
  const idOrphanRecord = await call("decisions_for", { query: "bbbbbbbb" });
  check("(4a) bbbbbbbb's record resolves", idOrphanRecord.record?.title === "Local decision title");
  check("(4b) but nothing anchors it — anchoredIn:[] and orphan:true (DoD-4, the OTHER orphan direction)",
    idOrphanRecord.anchoredIn.length === 0 && idOrphanRecord.orphan === true);

  // (5) ID reverse-lookup, orphan-ANCHOR direction: dddddddd is cited but has no record.
  const idOrphanAnchor = await call("decisions_for", { query: "dddddddd" });
  check("(5) dddddddd is anchored but has no record — record:null, orphan:true even though anchoredIn is non-empty",
    idOrphanAnchor.record === null && idOrphanAnchor.anchoredIn.length === 1 && idOrphanAnchor.orphan === true);

  // (6) SYMBOL mode: resolve BAR_SYMBOL -> src/bar.ts -> its anchored decision (cccccccc, register #3:
  // docs/investigations/.../findings.md — the "either register" text some card carried was wrong; this
  // mirrors the REAL three-store resolver, not that description).
  const bySymbol = await call("decisions_for", { query: "BAR_SYMBOL" });
  check("(6a) symbol mode resolves to the defining file", bySymbol.mode === "symbol" && bySymbol.resolvedFiles.includes("src/bar.ts") && !bySymbol.ambiguous);
  const barResult = bySymbol.results.find((r) => r.path === "src/bar.ts");
  check("(6b) the resolved file's own decisions include the investigations-register record",
    !!barResult && barResult.decisions.some((d) => d.id === "cccccccc" && d.record?.path === "docs/investigations/cccccccc-some-investigation/findings.md"));

  // (7) SYMBOL mode, no definition found anywhere — reported as an explicit error, not an empty crash.
  const noSymbol = await call("decisions_for", { query: "ThisSymbolDoesNotExistAnywhere" });
  check("(7) an unresolvable symbol reports {mode:\"symbol\", error, resolvedFiles:[]}", noSymbol.mode === "symbol" && typeof noSymbol.error === "string" && noSymbol.resolvedFiles.length === 0);

  // (8) NO query — full-repo enumeration reporting BOTH orphan directions at once (DoD-4).
  const all = await call("decisions_for", {});
  check("(8a) enumerate-all reports mode:\"index\" with the right totals", all.mode === "index" && all.recordCount === 3 && all.uniqueAnchorIds === 3);
  check("(8b) orphanAnchors names dddddddd (an anchored id with no record)", all.orphanAnchors.items.some((o) => o.id === "dddddddd"));
  check("(8c) orphanRecords names bbbbbbbb (a record with no inbound anchor), advisory:true", all.orphanRecords.items.some((o) => o.id === "bbbbbbbb") && all.orphanRecords.advisory === true);
  check("(8d) aaaaaaaa/cccccccc — properly anchored+recorded — are NOT reported as orphans in either direction",
    !all.orphanAnchors.items.some((o) => o.id === "aaaaaaaa" || o.id === "cccccccc")
    && !all.orphanRecords.items.some((o) => o.id === "aaaaaaaa" || o.id === "cccccccc"));

  // (9) A project with no repoPath at all gets a clean {error}, never a throw.
  db.insertProject({ id: "pNoRepo", name: "No Repo", repoPath: "", vaultPath: "", config: {}, createdAt: now, archivedAt: null, reserved: false });
  const noRepoServer = new TaskMcpRouter(db, wakes).buildServer("pNoRepo", "S2");
  const [clientT2, serverT2] = InMemoryTransport.createLinkedPair();
  await noRepoServer.connect(serverT2);
  const client2 = new Client({ name: "decisions-for-tool-test-2", version: "0" });
  await client2.connect(clientT2);
  const noRepoResult = JSON.parse((await client2.callTool({ name: "decisions_for", arguments: {} })).content[0].text);
  check("(9) a project with no repoPath returns a clean {error}, not a throw", typeof noRepoResult.error === "string");
  await client2.close();

  await client.close();
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — decisions_for resolves path/id/symbol/enumerate-all queries against a real fixture repo, across all three record stores, reporting BOTH orphan directions (DoD-4) instead of silently skipping either."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
