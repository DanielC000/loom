import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — pure fs/child_process below, no Db used
// Card 394649cf: fake-codescape-cli.mjs's `serve` HTTP server had no 'error' listener, so a bind failure
// (EADDRINUSE — the port the supervisor told it to use already held by a real listener) emitted 'error'
// with no listener, which Node re-throws as an UNCAUGHT EXCEPTION — the fixture crashed instead of failing
// once, cleanly, with a diagnosable message naming the port and errno.
//
// ⛔ THIS TEST DOES NOT PROVE THE REAL SUPERVISOR IS ROBUST TO A BUSY PORT, AND DOES NOT REDUCE ANY FLAKE
// RATE. codescape-supervisor.mjs's `(f)` assertion still needs a SUCCESSFUL bind; a held port still fails
// it either way. This is a DIAGNOSABILITY fix ONLY: one clean, attributable exit instead of an uncaught
// exception (and, in the real supervisor's restart-on-death loop, a crash-retry storm). FIXTURE ONLY —
// src/codescape/supervisor.ts is untouched by this card; the supervisor's own known-and-accepted
// same-port-retry behavior (supervisor.ts:1050-1069) is NOT "fixed" here either.
//
// RED-FIRST evidence (not re-run by this file — see the card's worker report): temporarily reverting the
// `server.on("error", ...)` handler this card added to fake-codescape-cli.mjs reproducibly crashed this
// same test with Node's default "Unhandled 'error' event" uncaught-exception dump (never the fixture's own
// clean `process.exit(1)`) — verified, then the handler was restored and the test reconfirmed green.
//
// Run: node test/codescape-fixture-port-conflict.mjs (no dist build needed — this only spawns the fixture
// .mjs directly via `node`, it never imports compiled daemon code).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureCli = path.join(__dirname, "fixtures", "fake-codescape-cli.mjs");

// Card 4a3c1f5a's own lesson (codescape-mcp-spawn.mjs): pin the fixture's cwd to a scratch temp dir — it
// appends its call log to `<cwd>/fake-codescape-calls.jsonl`, and an unset cwd would leak that file into
// whatever directory this test happens to be run from.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "loom-cs-portconflict-"));

// ===================== hold a real port so the fixture's own bind is guaranteed to fail =====================
const holder = net.createServer();
const heldPort = await new Promise((resolve, reject) => {
  holder.on("error", reject);
  holder.listen(0, "127.0.0.1", () => {
    const addr = holder.address();
    resolve(addr && typeof addr === "object" ? addr.port : null);
  });
});
check("(setup) holder server is actually bound to a real port before the fixture ever runs", typeof heldPort === "number" && heldPort > 0);

// ===================== spawn the fixture's `serve` against that SAME held port =====================
const child = spawn(process.execPath, [fixtureCli, "serve", "--port", String(heldPort)], {
  cwd: tmpHome,
  stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "";
let stderr = "";
child.stdout.on("data", (c) => { stdout += c; });
child.stderr.on("data", (c) => { stderr += c; });

const result = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ timedOut: true }), 5000);
  child.on("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal, timedOut: false }); });
});

holder.close();

check("(f) the fixture actually exits on its own within 5s (never hangs)", result.timedOut !== true);

if (!result.timedOut) {
  check(
    `(f) exits with a clean, deliberate non-zero code (1), not killed by a signal — got code=${result.code} signal=${result.signal}`,
    result.code === 1 && result.signal === null
  );

  // Distinguishes a clean, intentional `process.exit(1)` from Node's own uncaught-exception crash dump,
  // which prints "Unhandled 'error' event" / "throw er;" plus an internal node:events/node:net stack —
  // never present on a clean, handled exit. This is the line that FAILS pre-fix: that IS the crash shape.
  const looksLikeUncaughtCrash = /Unhandled 'error' event|throw er;|node:events:\d/.test(stderr);
  check(
    "(f) stderr shows NO Node uncaught-exception crash dump — fails RED pre-fix, since an unhandled 'error' IS this exact dump",
    !looksLikeUncaughtCrash
  );

  check(`(f) stderr names the held port (${heldPort}) so the failure is diagnosable`, stderr.includes(String(heldPort)));
  check("(f) stderr names the errno field so the failure is diagnosable", /errno=/.test(stderr));
  check("(f) stderr names the failure code (EADDRINUSE) so the failure is diagnosable", /EADDRINUSE/.test(stderr));

  check("(f) stdout carries NO self-reported-bound-port line (the fixture never actually bound)", !stdout.includes('"url"'));
}

console.log(failures === 0 ? "\n✅ ALL PASS" : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
