#!/usr/bin/env node
// Loom hook relay. Claude Code invokes this as: node hook-relay.mjs <sessionId> <port> <hookToken>
// Reads the hook JSON on stdin and POSTs {sessionId, hook, token} to the daemon. Always exits 0
// so a relay failure never blocks the CLI. (Validated in the spike.)
//
// `hookToken` (card a2407ed4): a per-session credential baked into this command line at spawn time
// (writeSessionSettings, claude-settings.ts) — /internal/hook requires it to match the target
// session's own token before a hook is processed. See PtyHost.verifyHookToken's doc for exactly what
// this does and does not close.
const [sessionId, port, token] = process.argv.slice(2);

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let hook;
  try { hook = JSON.parse(raw); } catch { return; }
  await fetch(`http://127.0.0.1:${port}/internal/hook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, hook, token }),
  }).catch(() => {});
}

main().catch(() => {}).finally(() => process.exit(0));
