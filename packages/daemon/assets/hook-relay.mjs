#!/usr/bin/env node
// Loom hook relay. Claude Code invokes this as: node hook-relay.mjs <sessionId> <port>
// Reads the hook JSON on stdin and POSTs {sessionId, hook} to the daemon. Always exits 0
// so a relay failure never blocks the CLI. (Validated in the spike.)
const [sessionId, port] = process.argv.slice(2);

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let hook;
  try { hook = JSON.parse(raw); } catch { return; }
  await fetch(`http://127.0.0.1:${port}/internal/hook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, hook }),
  }).catch(() => {});
}

main().catch(() => {}).finally(() => process.exit(0));
