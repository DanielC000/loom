// Fixture stdio MCP (card fafae623, real-spawn env-isolation proof). Logs process.env KEY NAMES and, per
// named sentinel, only a boolean PRESENCE + VALUE-MATCH — never a value itself. Speaks just enough
// JSON-RPC (initialize/notifications/initialized/tools/list) to let a real claude connect and list tools.
// Usage: node mcp-env-probe.mjs <logFile> <sentinelName1> [<sentinelName2> ...]
import fs from "node:fs";

const [logFile, ...sentinelNames] = process.argv.slice(2);
const log = (o) => fs.appendFileSync(logFile, JSON.stringify(o) + "\n");

log({
  ev: "start",
  keyCount: Object.keys(process.env).length,
  sentinelPresence: Object.fromEntries(sentinelNames.map((k) => [k, k in process.env])),
  sentinelValueMatches: Object.fromEntries(sentinelNames.map((k) => [k, process.env[k] === `sentinel-${k}`])),
});

let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "loom-env-probe", version: "0" } } }) + "\n");
    } else if (m.method === "tools/list") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "noop", description: "probe", inputSchema: { type: "object", properties: {} } }] } }) + "\n");
      log({ ev: "tools-list-served" });
    } else if (m.id !== undefined && m.method) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} }) + "\n");
    }
  }
});
process.stdin.on("end", () => { log({ ev: "stdin-end" }); setTimeout(() => process.exit(0), 50); });
process.on("SIGTERM", () => { log({ ev: "sigterm" }); process.exit(0); });
