import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 37d4325d: a `/ws/term` frame that is a well-formed JSON OBJECT (so it clears `parseWsJsonObject`'s
// object-only guard — ws-json-hardening.mjs already covers THAT class) can still crash the daemon if one
// of its FIELDS is the wrong type. `{"type":"stdin","data":null}` reached `PtyHost.writeStdin`, which
// reads `data.length` unconditionally on its first line, throwing a TypeError straight out of the ws
// 'message' listener — an uncaught exception that (under the real crashlog handler) exits the process
// with a plain `exit(1)` the supervisor does NOT relaunch on, taking the WHOLE fleet down from one
// malformed frame. A `resize` frame with a non-finite/negative/oversized `cols`/`rows` reached
// `PtyHost.resize`/node-pty unchecked the same way (that call is wrapped in its own try/catch downstream,
// so it was never the CRASH vector null-data was — but it still let a bogus value overwrite the shell's
// tracked geometry, which the DoD's "finite positive ints within a bound" asks to reject at the source).
//
// This test proves, for /ws/term:
//   1. `data: null` / a MISSING `data` field genuinely reproduce the real crash mechanism — the stub's
//      `writeStdin` does the SAME unconditional `data.length` read `pty/host.ts` does on its first line —
//      and old code crashes the handler on them; new code does not (canary technique, same as
//      ws-json-hardening.mjs: a unique canary frame right after each malformed one, polled for its
//      landing, proves in-order handling rather than guessing a fixed sleep was enough).
//   2. EVERY malformed-field frame (null/missing/numeric/object/array/boolean data; NaN/string/negative/
//      zero/huge/non-integer/Infinity/null cols-or-rows) never actually reaches PtyHost.writeStdin/resize
//      at all — proving the fix is real field-type validation at the handler, not merely "happened not to
//      crash this particular stub".
//   3. A valid frame on the same socket afterward is still handled, and the daemon process is still
//      serving other requests.
// HERMETIC + CLAUDE-FREE + NETWORK-FREE (Db + buildServer via @fastify/websocket's injectWS, like
// ws-json-hardening.mjs / ws-fleet.mjs).
import fs from "node:fs";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

const TMP = mkdtempManaged("loom-ws-field-type-hardening-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = "45349"; // distinct from every other test's LOOM_PORT (see sibling ws-*.mjs comments)
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

async function waitFor(cond, timeoutMs = 1000) {
  try {
    return await sharedWaitUntil(cond, { timeoutMs, intervalMs: 20, label: "ws-field-type-hardening: cond" });
  } catch (err) {
    if (err?.exhaustedOnThrow !== false) throw err;
    return cond();
  }
}

const db = new Db(path.join(TMP, "loom.db"));

const ptyCalls = { stdin: [], repaint: [], resize: [] };
const pty = {
  subscribe: () => () => {},
  // Mirrors the ACTUAL first line `PtyHost.writeStdin` executes for a live session (pty/host.ts, the
  // `if (live && data.length > 20)` diagnostic) — an unconditional `data.length` read that throws the
  // exact `TypeError: Cannot read properties of null (reading 'length')` the real daemon crashed on for
  // `data: null` (card 37d4325d's own repro). Genuinely reproduces the crash for null/undefined `data`;
  // other non-string types (number/object/array/boolean) don't throw on `.length` alone, but the real
  // PtyHost goes on to crash on THEM too a few calls further down its string-processing pipeline
  // (`writeChunked` -> `surrogateSafeChunkEnd` -> `text.charCodeAt`, traced by hand against pty/host.ts
  // while writing this test) — reproducing that whole chain here would just be re-implementing PtyHost,
  // so for those types the "never reached PtyHost.writeStdin" assertion below (not a crash claim) is
  // what proves the field-type guard, which is what the DoD actually asks the gateway handler to do.
  writeStdin: (sessionId, data) => { void data.length; ptyCalls.stdin.push({ sessionId, data }); },
  repaint: (sessionId) => ptyCalls.repaint.push(sessionId),
  resize: (sessionId, cols, rows) => ptyCalls.resize.push({ sessionId, cols, rows }),
};

const app = await buildServer({
  db, pty, sessions: {}, mcp: {}, orchMcp: {}, platformMcp: {}, auditMcp: {}, userAuditMcp: {},
  setupMcp: {}, runMcp: {}, control: {}, usageStatus: {}, requestShutdown: () => {},
});

try {
  await app.ready();

  const ws = await app.injectWS("/ws/term/sess-term", { headers: { host: "127.0.0.1" }, socket: { remoteAddress: "127.0.0.1" } });

  // --- stdin, GROUP A: genuinely reproduces the real crash mechanism (`data.length` throws) -------------
  const CRASHING_STDIN = [
    ["null data", { type: "stdin", data: null }],
    ["missing data field", { type: "stdin" }],
  ];
  for (let i = 0; i < CRASHING_STDIN.length; i++) {
    const [label, frame] = CRASHING_STDIN[i];
    const canaryData = `canary-stdin-crash-${i}\n`;
    const stdinCallsBefore = ptyCalls.stdin.length;
    ws.send(JSON.stringify(frame));
    ws.send(JSON.stringify({ type: "stdin", data: canaryData }));
    await waitFor(() => ptyCalls.stdin.some((c) => c.sessionId === "sess-term" && c.data === canaryData));
    check(`(stdin ${label}) does not crash the handler (socket stays open)`, ws.readyState === ws.OPEN);
    check(`(stdin ${label}) never reached PtyHost.writeStdin`, ptyCalls.stdin.length === stdinCallsBefore + 1);
  }

  // --- stdin, GROUP B: wrong type, but the stub's `.length` read alone doesn't throw for these — the
  // real crash is further down PtyHost's own pipeline (see the stub's doc comment above), so here we only
  // assert the field-type guard actually stops the dispatch, not a crash. ------------------------------
  const NONSTRING_STDIN = [
    ["numeric data", { type: "stdin", data: 42 }],
    ["object data", { type: "stdin", data: { nested: true } }],
    ["array data", { type: "stdin", data: [1, 2, 3] }],
    ["boolean data", { type: "stdin", data: true }],
  ];
  for (let i = 0; i < NONSTRING_STDIN.length; i++) {
    const [label, frame] = NONSTRING_STDIN[i];
    const canaryData = `canary-stdin-type-${i}\n`;
    const stdinCallsBefore = ptyCalls.stdin.length;
    ws.send(JSON.stringify(frame));
    ws.send(JSON.stringify({ type: "stdin", data: canaryData }));
    await waitFor(() => ptyCalls.stdin.some((c) => c.sessionId === "sess-term" && c.data === canaryData));
    check(`(stdin ${label}) the socket survives the frame`, ws.readyState === ws.OPEN);
    check(`(stdin ${label}) never reached PtyHost.writeStdin`, ptyCalls.stdin.length === stdinCallsBefore + 1);
  }

  // --- resize: cols/rows must be finite positive integers within bounds. PtyHost.resize already wraps its
  // own `live.pty.resize()` call in a try/catch downstream, so a bogus value was never the CRASH vector
  // null `data` was — this asserts the value never overwrites tracked geometry / reaches PtyHost at all,
  // per the DoD's "finite positive ints within a bound" ask, not a crash claim. --------------------------
  const MALFORMED_RESIZE = [
    ["NaN cols", { type: "resize", cols: NaN, rows: 40 }],
    ["string cols", { type: "resize", cols: "80", rows: 40 }],
    ["negative cols", { type: "resize", cols: -5, rows: 40 }],
    ["zero rows", { type: "resize", cols: 80, rows: 0 }],
    ["huge cols", { type: "resize", cols: 10_000_000, rows: 40 }],
    ["non-integer cols", { type: "resize", cols: 80.5, rows: 40 }],
    ["Infinity rows", { type: "resize", cols: 80, rows: Infinity }],
    ["null cols", { type: "resize", cols: null, rows: 40 }],
  ];
  for (let i = 0; i < MALFORMED_RESIZE.length; i++) {
    const [label, frame] = MALFORMED_RESIZE[i];
    const canaryData = `canary-resize-${i}\n`;
    const resizeCallsBefore = ptyCalls.resize.length;
    ws.send(JSON.stringify(frame));
    ws.send(JSON.stringify({ type: "stdin", data: canaryData }));
    await waitFor(() => ptyCalls.stdin.some((c) => c.sessionId === "sess-term" && c.data === canaryData));
    check(`(resize ${label}) the socket survives the frame`, ws.readyState === ws.OPEN);
    check(`(resize ${label}) never reached PtyHost.resize`, ptyCalls.resize.length === resizeCallsBefore);
  }

  // A valid resize still works after all the malformed ones (proves the guard isn't just rejecting everything).
  ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
  check("(resize) a valid frame after the malformed ones is still handled",
    await waitFor(() => ptyCalls.resize.some((c) => c.sessionId === "sess-term" && c.cols === 80 && c.rows === 24)));

  // A valid stdin frame still works after all the malformed ones.
  ws.send(JSON.stringify({ type: "stdin", data: "echo hi\n" }));
  check("(stdin) a valid frame after the malformed ones is still handled",
    await waitFor(() => ptyCalls.stdin.some((c) => c.sessionId === "sess-term" && c.data === "echo hi\n")));

  ws.terminate();

  // --- process-level survival: still serving other requests after every malformed field-shaped frame -----
  const stillUp = await app.inject({ method: "GET", url: "/api/version", headers: { host: "127.0.0.1" } });
  check("(process) the daemon is still serving requests after every malformed-field frame", stillUp.statusCode === 200);
} finally {
  await app.close();
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — /ws/term survives stdin/resize frames whose FIELDS (not just top-level shape) are malformed; the malformed value never reaches PtyHost; a valid frame afterward is still handled; the daemon process stays up."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
