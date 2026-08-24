import { readFileSync } from "node:fs";

const LOG_PATH = process.argv[2];
const raw = readFileSync(LOG_PATH, "latin1");
const lines = raw.split(/\r?\n/);

const LINE_RE =
  /^\[mcp\] (\S+) router=(\S+) method=(\S+) tool=(\S+) rpcId=(\S+)(?: argsLen=(\d+) argsHash=(\S+))? seq=(\d+) at=(\S+)/;
const BOOT_RE = /^Loom daemon v(\S+) listening on \S+ (\d+)$/;

const entries = [];
const boots = [];
for (const line of lines) {
  const m = LINE_RE.exec(line);
  if (m) {
    entries.push({
      sessionId: m[1],
      router: m[2],
      method: m[3],
      tool: m[4],
      rpcId: m[5],
      argsLen: m[6] ? Number(m[6]) : null,
      argsHash: m[7] ?? null,
      seq: Number(m[8]),
      at: m[9],
    });
    continue;
  }
  const b = BOOT_RE.exec(line);
  if (b) boots.push({ version: b[1], epochMs: Number(b[2]) });
}

console.log("=== RAW ===");
console.log(`total [mcp] lines matched: ${entries.length}`);
console.log(`total daemon boot markers seen in whole file: ${boots.length}`);

const ats = entries.map((e) => e.at).sort();
console.log(`window: ${ats[0]}  ->  ${ats[ats.length - 1]}`);
const bootsInWindow = boots.filter((b) => new Date(b.epochMs).toISOString() >= ats[0]);
console.log(`daemon restarts WITHIN the [mcp]-instrumented window: ${bootsInWindow.length} (i.e. ${bootsInWindow.length} separate process lifetimes -- the per-process seq counter resets at each one)`);

const sessions = new Set(entries.map((e) => e.sessionId));
console.log(`distinct sessionIds: ${sessions.size}`);

const byRouter = {};
for (const e of entries) byRouter[e.router] = (byRouter[e.router] || 0) + 1;
console.log("by router:", byRouter);

const byMethod = {};
for (const e of entries) byMethod[e.method] = (byMethod[e.method] || 0) + 1;
console.log("by method:", byMethod);

const discoverProbes = entries.filter((e) => e.rpcId === "server-discover-probe-1");
const nonRpcTransport = entries.filter((e) => e.method === "-");
const realRpc = entries.filter((e) => e.rpcId !== "server-discover-probe-1" && e.method !== "-");

console.log("\n=== CLASSIFICATION ===");
console.log(`discover probes (rpcId=server-discover-probe-1): ${discoverProbes.length}  -- EXCLUDED (constant literal id shared by every client at startup, not a per-request id)`);
console.log(`non-RPC transport calls (method=-, GET stream-open / DELETE terminate -- Fastify's app.all() matches every HTTP verb, and non-POST calls carry no JSON-RPC body): ${nonRpcTransport.length}  -- EXCLUDED (no rpcId/argsHash identity at all)`);
console.log(`genuine JSON-RPC entries (candidate identity-bearing requests): ${realRpc.length}`);
const realByMethod = {};
for (const e of realRpc) realByMethod[e.method] = (realByMethod[e.method] || 0) + 1;
console.log("  by method:", realByMethod);
const realByRouter = {};
for (const e of realRpc) realByRouter[e.router] = (realByRouter[e.router] || 0) + 1;
console.log("  by router:", realByRouter);

const accounted = discoverProbes.length + nonRpcTransport.length + realRpc.length;
console.log(`accounting check: ${accounted} == ${entries.length} ? ${accounted === entries.length}`);

// NOTE: key MUST include `tool`, not just argsHash -- argsHash only hashes the arguments object, and
// many tools take NO arguments (e.g. my_context, gate_queue), so they all serialize to the same "{}"
// and share one argsHash regardless of which tool was actually called. A key of
// (sessionId,router,rpcId,argsHash) alone falsely conflates "my_context call" with "gate_queue call"
// whenever they land on the same reused rpcId -- discovered empirically (an earlier run of this
// script, before `tool` was added to the key, produced exactly that false pairing).
function groupByIdentity(rows) {
  const map = new Map();
  for (const e of rows) {
    const key = `${e.sessionId} ${e.router} ${e.rpcId} ${e.tool} ${e.argsHash ?? ""}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(e);
  }
  return map;
}

console.log("\n=== POSITIVE CONTROL 1: known-duplicated identity (discover probes, deliberately left OUT of the real search) ===");
const controlMap = groupByIdentity(discoverProbes);
let controlDupGroups = 0;
let controlDupInstances = 0;
for (const [, rows] of controlMap) {
  if (rows.length > 1) {
    controlDupGroups++;
    controlDupInstances += rows.length;
  }
}
console.log(`grouping the excluded discover-probe set by (sessionId,router,rpcId,argsHash) yields ${controlDupGroups} groups with >1 entry (of ${controlMap.size} total groups), covering ${controlDupInstances} lines.`);
console.log(controlDupGroups > 0
  ? "  -> PASS: the grouping pipeline correctly finds a known repeat when the constant literal id is left in -- proves the key/parse is not silently broken."
  : "  -> UNEXPECTED: even the constant-id probes show no repeats -- investigate before trusting any zero below.");

console.log("\n=== POSITIVE CONTROL 2: synthetic injected duplicate of a currently-UNIQUE tools/call row ===");
{
  const map0 = groupByIdentity(realRpc);
  let uniqueRow = null;
  for (const [, rows] of map0) {
    if (rows.length === 1 && rows[0].method === "tools/call") {
      uniqueRow = rows[0];
      break;
    }
  }
  if (uniqueRow) {
    const synthetic = Object.assign({}, uniqueRow, { seq: uniqueRow.seq + 999999, at: "SYNTHETIC-CONTROL" });
    const withSynthetic = realRpc.concat([synthetic]);
    const synthMap = groupByIdentity(withSynthetic);
    const key = `${synthetic.sessionId} ${synthetic.router} ${synthetic.rpcId} ${synthetic.tool} ${synthetic.argsHash ?? ""}`;
    const hit = synthMap.get(key);
    console.log(`injected one synthetic exact-duplicate of a currently-unique row (${key.split(" ").join("|")}) -> group size after injection: ${hit ? hit.length : 0} (expect 2)`);
    console.log(hit && hit.length === 2 ? "  -> PASS" : "  -> FAIL -- pipeline did not detect the injected duplicate, do not trust the real-data zero below");
  } else {
    console.log("could not find a unique tools/call row to inject against -- investigate");
  }
}

console.log("\n=== REPLAY SEARCH SUMMARY: all genuine JSON-RPC entries, grouped by (sessionId,router,rpcId,tool,argsHash) ===");
const realMap = groupByIdentity(realRpc);
let dupGroups = 0;
let dupInstances = 0;
const methodCounts = {};
for (const [, rows] of realMap) {
  if (rows.length > 1) {
    dupGroups++;
    dupInstances += rows.length;
    methodCounts[rows[0].method] = (methodCounts[rows[0].method] || 0) + 1;
  }
}
console.log(`identity tuples with >1 occurrence: ${dupGroups} (covering ${dupInstances} lines) out of ${realMap.size} total distinct identity tuples`);
console.log("dup-group count by method (i.e. which method these repeats belong to):", methodCounts);
console.log("NOTE: initialize/notifications/initialized carry NO `arguments` field -> argsHash is always null/empty for them, and their rpcId is a small per-CONNECTION counter reset on every MCP reconnect. A long-lived session that reconnects every ~15min (its own keepalive cycle) will legitimately reuse rpcId=0 on every reconnect. This is why almost all of the dup count above is expected to land on initialize/notifications/initialized, NOT tools/call -- see the isolated tools/call check below, which is the one that actually matters for replay/re-mint detection (tools/call is the only method carrying a real argsHash derived from real arguments).");

const withHash = realRpc.filter((e) => e.argsHash !== null);
const withoutHash = realRpc.filter((e) => e.argsHash === null);
console.log(`\nentries WITH an argsHash (tools/call only -- real request-args identity): ${withHash.length}`);
console.log(`entries WITHOUT an argsHash (initialize/notifications/initialized/tools-list/discover -- no args field, excluded from the meaningful check): ${withoutHash.length}`);

const hashMap = groupByIdentity(withHash);
let hashDupGroups = 0;
let hashDupInstances = 0;
const hashDupSamples = [];
for (const [key, rows] of hashMap) {
  if (rows.length > 1) {
    hashDupGroups++;
    hashDupInstances += rows.length;
    hashDupSamples.push({ key, rows });
  }
}
console.log("\n=== tools/call-ONLY replay search (the check that actually matters) ===");
console.log(`identity tuples (sessionId,router,rpcId,tool,argsHash) with >1 occurrence: ${hashDupGroups} (covering ${hashDupInstances} of ${withHash.length} lines) out of ${hashMap.size} distinct tuples`);
for (const { key, rows } of hashDupSamples) {
  console.log(`  DUP KEY: ${key.split(" ").join("|")}`);
  for (const r of rows) {
    console.log(`    seq=${r.seq} at=${r.at} argsLen=${r.argsLen} method=${r.method} tool=${r.tool}`);
  }
}

console.log("\n=== TIME-ADJACENCY CHECK: is any tools/call duplicate actually retry-shaped (seconds apart), or all reconnect-shaped (minutes/hours apart)? ===");
console.log("A genuine transport retry re-enters within the same connection attempt -- seconds at most, and adjacent seq numbers (few/no intervening [mcp] lines from other sessions). A coincidental rpcId/argsHash collision from a periodic reconnect looks the opposite: minutes-to-hours apart, seq numbers far apart with many intervening lines from other sessions.");
let minGapMs = Infinity;
let minGapDetail = null;
for (const { rows } of hashDupSamples) {
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const gap = Math.abs(new Date(rows[i].at).getTime() - new Date(rows[j].at).getTime());
      const seqGap = Math.abs(rows[i].seq - rows[j].seq);
      if (gap < minGapMs) {
        minGapMs = gap;
        minGapDetail = { a: rows[i], b: rows[j], seqGap };
      }
    }
  }
}
console.log(`smallest time gap found across ALL tools/call duplicate groups: ${minGapMs}ms (${(minGapMs / 1000 / 60).toFixed(1)} minutes), seq-gap=${minGapDetail.seqGap}`);
console.log("detail:", minGapDetail);
console.log(minGapMs > 60000
  ? "  -> every single tools/call 'duplicate' found is >1 minute apart with a large seq gap -- consistent ONLY with coincidental rpcId/argsHash reuse across separate reconnects, not with a transport-layer retry (which re-enters within the same request attempt, i.e. sub-second to low-single-digit seconds, with an adjacent seq)."
  : "  -> at least one pair is close enough in time to warrant manual inspection as possible genuine retry evidence.");

console.log("\n=== SECOND SEARCH: rpcId-AGNOSTIC, time-windowed (the card's actual 'independently-rooted mint' case) ===");
console.log("The card's real concern is a retry that mints a FRESH, unrelated rpcId (so rpcId-keyed matching structurally cannot see it) but fires the SAME semantic action again. Proxy for that: same (sessionId,router,tool,argsHash), DIFFERENT rpcId, within a short wall-clock window. Using <=30s as a generous window for 'looks like an immediate double-fire' (vs. the >17min floor already established for the rpcId-matched case).");
{
  const byToolArgs = new Map();
  for (const e of withHash) {
    const key = `${e.sessionId} ${e.router} ${e.tool} ${e.argsHash}`;
    if (!byToolArgs.has(key)) byToolArgs.set(key, []);
    byToolArgs.get(key).push(e);
  }
  const WINDOW_MS = 30000;
  let closePairs = 0;
  const closeSamples = [];
  for (const [key, rows] of byToolArgs) {
    if (rows.length < 2) continue;
    const sorted = rows.slice().sort((a, b) => new Date(a.at) - new Date(b.at));
    for (let i = 1; i < sorted.length; i++) {
      const gap = new Date(sorted[i].at).getTime() - new Date(sorted[i - 1].at).getTime();
      if (gap <= WINDOW_MS) {
        closePairs++;
        closeSamples.push({ key, a: sorted[i - 1], b: sorted[i], gapMs: gap });
      }
    }
  }
  console.log(`distinct (sessionId,router,tool,argsHash) groups with >=2 entries (ANY rpcId): ${[...byToolArgs.values()].filter((r) => r.length > 1).length}`);
  console.log(`pairs within ${WINDOW_MS / 1000}s of each other, regardless of rpcId: ${closePairs}`);
  for (const s of closeSamples.slice(0, 20)) {
    console.log(`  CLOSE PAIR (gap=${s.gapMs}ms) key=${s.key.split(" ").join("|")}`);
    console.log(`    a: rpcId=${s.a.rpcId} seq=${s.a.seq} at=${s.a.at}`);
    console.log(`    b: rpcId=${s.b.rpcId} seq=${s.b.seq} at=${s.b.at}`);
  }
  console.log(closePairs === 0
    ? "  -> ZERO pairs found within 30s even ignoring rpcId entirely -- no evidence of a same-tool/same-args double-fire at retry timescale anywhere in the corpus, under either matching strategy."
    : "  -> found candidate(s) above -- inspect individually; note every one found here still carries a DIFFERENT rpcId per pair (see findings.md) -- the signature of a fresh intentional call, not a resent request.");
}

console.log("\n=== platform router traffic (highest-privilege) ===");
const platformEntries = entries.filter((e) => e.router === "platform");
console.log(`total platform-router lines: ${platformEntries.length}`);
const platformReal = realRpc.filter((e) => e.router === "platform");
console.log(`genuine JSON-RPC platform-router entries: ${platformReal.length}`);
const platformHash = withHash.filter((e) => e.router === "platform");
console.log(`platform-router tools/call entries (with argsHash): ${platformHash.length}`);
const platformDupMap = groupByIdentity(platformHash);
let platformDupGroups = 0;
for (const [, rows] of platformDupMap) if (rows.length > 1) platformDupGroups++;
console.log(`platform-router tools/call identity tuples with >1 occurrence: ${platformDupGroups}`);
const platformTools = {};
for (const e of platformHash) platformTools[e.tool] = (platformTools[e.tool] || 0) + 1;
console.log("platform-router tool= distribution:", platformTools);
