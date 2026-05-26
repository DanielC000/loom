#!/usr/bin/env node
// Loom spike hook relay. Claude Code invokes this as: node relay.mjs <loomId> <port>
// Reads the hook JSON on stdin and POSTs {loomId, hook} to the daemon. Always exits 0
// so a relay failure never blocks the CLI.
const [loomId, port] = process.argv.slice(2);

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let hook;
  try { hook = JSON.parse(raw); } catch { return; }
  await fetch(`http://127.0.0.1:${port}/hook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ loomId, hook }),
  }).catch(() => {});
}

main().catch(() => {}).finally(() => process.exit(0));
