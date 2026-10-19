// loom:not-a-test: this is a standalone stub CHILD PROCESS substituted for the real `claude` binary via
// LOOM_CLAUDE_BIN (and a generated `.cmd` wrapper) — it is DRIVEN BY test/kickoff-real-spawn.mjs, never
// run as a test itself, and has no PASS/FAIL/check() output of its own. It only trips the discovery
// heuristic by living under test/fixtures/ with a claude/cli-shaped name.
//
// Test fixture ONLY (not a shipped asset) — a real, standalone Node process substituted for `claude` via
// LOOM_CLAUDE_BIN, used by test/kickoff-real-spawn.mjs to exercise card 0050a17e's kickoff-delivery
// mechanism through a REAL node-pty spawn (genuine OS process creation, genuine pty I/O), not a mocked
// exec. Mirrors the LOOM_CLAUDE_BIN substitution technique test/spawn-command-line-preflight.mjs already
// established, extended here to actually receive what arrives on its real stdin.
//
// Contract with the harness:
//  - On startup, asserts it received NO positional (non-flag) argument — the direct proof that the
//    kickoff never rode argv (a regression here would show up as an extra argv entry).
//  - After FIXTURE_READY_DELAY_MS (env, default 0), prints a single sentinel line `FIXTURE_READY` to
//    stdout — the harness waits for this line (via the REAL pty's data stream) before calling
//    `host.deliverHook(sessionId, {hook_event_name:"SessionStart"})`, exactly mirroring how a real
//    claude boot precedes the real hook. This lets the harness simulate "SessionStart arrives late" (the
//    large-paste-before-SessionStart ordering case) by setting the delay high.
//  - Accumulates every byte it receives on stdin. After DEBOUNCE_MS (env, default 300) of no new input,
//    writes the RAW accumulated bytes to `FIXTURE_OUTPUT_FILE` (env, required) — a plain file write,
//    NEVER echoed back over the pty's own OUTPUT stream. A CODE REVIEW catch on this card found that an
//    earlier version DID echo the received bytes back as base64 over stdout, and that a real terminal's
//    bounded screen buffer (rows × cols, here 120×40) silently drops/scrolls-away content past a few KB —
//    a corruption signature that looked like an INPUT-side ConPTY defect but was actually this fixture's
//    own OUTPUT-side echo hitting the terminal's screen geometry. Writing to a file sidesteps pty output
//    entirely — decisive, and removes any payload-size ceiling from the verification method itself. Only
//    a SHORT stdout summary line is still printed: `FIXTURE_RECEIVED len=<n> sha256=<hex>` (order-of-100
//    chars, well within one terminal row, so it survives regardless of geometry) — the harness reads the
//    FILE for the actual content, and MAY cross-check the summary line's len/sha256 against it.
//  - Never exits on its own (mirrors a real claude staying up after a turn) — the harness kills it via
//    `host.stop(sessionId, "hard")`.
//  - Emits a `FIXTURE_ALIVE` heartbeat every FIXTURE_HEARTBEAT_MS (env, default 500) from boot onward —
//    card ae476ab1: the harness's delivery wait used to be a flat deadline that couldn't tell "still
//    working, just slow" apart from "hung/dead", and a measured, reproducible real-OS scheduling jitter
//    (2.6-4.4x this fixture's own typical delivery time, observed on an otherwise-idle solo host with
//    nothing else in the suite running) tripped that flat deadline. The heartbeat gives the harness a
//    liveness signal to poll instead of guessing a bigger fixed number (see doc in kickoff-real-spawn.mjs).
//  - Card 75f6bdcf: FIXTURE_HEARTBEAT_PAUSE_MS (env, default 0 — additive, every other caller of this
//    fixture leaves it unset and sees byte-identical behavior) delays the FIRST heartbeat tick by that many
//    ms, deterministically simulating the real failure mode a loaded host can produce (the child process
//    itself not getting scheduled long enough to emit even its own heartbeat) WITHOUT any synthetic host
//    load — used to prove the harness's stall-aware wait budget RED under the old flat formula and GREEN
//    under the new ambient-scaled one, for the same silent-window duration either way.
import fs from "node:fs";
import crypto from "node:crypto";

const outputFile = process.env.FIXTURE_OUTPUT_FILE;
if (!outputFile) {
  process.stdout.write("FIXTURE_FAIL FIXTURE_OUTPUT_FILE env var is required but was not set\n");
  process.exit(1);
}

// Card a50b8afd: ADDITIVE-WHEN-ABSENT — every other test using this fixture never sets this var, so this
// is a no-op for them. Dumps this process's OWN LOOM_MCP_TOKEN env value (never argv, never stdin — the
// real claude process's actual environment block) so a test can assert the real spawn env carries the
// per-session mcpToken, proving the mcp-config.json FILE's own placeholder is backed by a real value
// somewhere other than the file itself.
// Card 2be634f2: ALSO dumps every `LOOM_CAP_SECRET_*`-named var this process's env actually carries. Card
// 2be634f2 CONSIDERED AND REJECTED putting a capability secret here (claude's own env is inherited by
// everything it spawns, including the agent's own shell) — this scan exists so a test can assert the
// NEGATIVE: this set is always empty, on every platform, proving the rejected design never shipped.
// Card 836c40b7: WRITE ATOMICALLY. `fs.writeFileSync` is open()+write()+close() as separate syscalls —
// a reader polling `fs.existsSync` alone can observe the file the instant it's CREATED, before its
// content is actually written and flushed, and get 0 bytes or a truncated read (crashing on
// `JSON.parse`). Under heavy host contention that window is wide enough to hit for real — it crashed
// two separate full merge gates on this exact file. Writing to a sibling temp path then renaming onto
// the real path closes the gap: a same-volume rename is atomic at the filesystem level, so the real
// path only ever appears fully formed.
if (process.env.FIXTURE_ENV_DUMP_FILE) {
  const capSecrets = {};
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith("LOOM_CAP_SECRET_")) capSecrets[k] = v;
  const payload = JSON.stringify({ LOOM_MCP_TOKEN: process.env.LOOM_MCP_TOKEN ?? null, capabilitySecrets: capSecrets });
  const dumpFile = process.env.FIXTURE_ENV_DUMP_FILE;
  const slowWriteMs = Number(process.env.FIXTURE_ENV_DUMP_SLOW_WRITE_MS || 0);
  if (slowWriteMs > 0) {
    // TEST-ONLY: deterministically reproduces the pre-fix race for test/wait-json-file.mjs — create
    // the file EMPTY, hold it open that way for slowWriteMs, THEN write the real content directly
    // (never atomically, unlike the real path above). Never set outside that one regression test.
    fs.writeFileSync(dumpFile, "");
    sleepSync(slowWriteMs);
    fs.writeFileSync(dumpFile, payload);
  } else {
    const tmpFile = `${dumpFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmpFile, payload);
    renameAtomic(tmpFile, dumpFile);
  }
}

// A true synchronous sleep (never a busy-loop) — this top-level script has nothing else to do before
// the real write runs, so blocking the single thread here costs nothing a real caller would notice.
function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

// Windows can transiently EPERM/EBUSY a rename if something still holds a handle on the destination —
// it normally doesn't exist yet here, but retry briefly rather than assume that.
function renameAtomic(tmpPath, destPath) {
  const maxAttempts = 10;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      fs.renameSync(tmpPath, destPath);
      return;
    } catch (err) {
      if (attempt === maxAttempts || !(err && (err.code === "EPERM" || err.code === "EBUSY"))) throw err;
      sleepSync(20);
    }
  }
}

// A real spawn's argv is all FLAGS (--settings, --permission-mode, --strict-mcp-config, etc.) — that's
// expected and fine. What must NEVER appear is the OLD positional-prompt shape: a `--` end-of-options
// separator followed by the prompt text (buildSpawnArgs' pre-0050a17e contract). Its absence is the
// direct proof the kickoff never rode argv.
if (process.argv.slice(2).includes("--")) {
  process.stdout.write(`FIXTURE_FAIL a \`--\` positional-prompt separator was found in argv: ${JSON.stringify(process.argv.slice(2))}\n`);
  process.exit(1);
}

// A real claude (like any real interactive terminal app) puts its stdin into RAW mode, which disables
// the pty/tty driver's OWN canonical-mode line discipline (echo, line buffering, and — the part that
// matters here — INTERPRETING certain bytes specially: Ctrl+C as SIGINT, Ctrl+D as EOF, backspace as an
// edit, etc.) at the KERNEL/driver level, beneath any application-level protocol like bracketed paste.
// Real prose can legitimately contain a byte that collides with one of those special characters; without
// raw mode the tty driver intercepts/mangles it before this process's own `data` handler ever sees it —
// a real, silent corruption source this fixture must avoid to faithfully stand in for `claude`.
if (process.stdin.isTTY) process.stdin.setRawMode(true);

const readyDelayMs = Number(process.env.FIXTURE_READY_DELAY_MS) || 0;
const debounceMs = Number(process.env.FIXTURE_DEBOUNCE_MS) || 300;
const heartbeatMs = Number(process.env.FIXTURE_HEARTBEAT_MS) || 500;
const heartbeatPauseMs = Number(process.env.FIXTURE_HEARTBEAT_PAUSE_MS) || 0;

setTimeout(() => {
  process.stdout.write("FIXTURE_READY\n");
}, readyDelayMs);

// Independent of the ready delay / debounce timers above — ticks for as long as this real process's own
// event loop is genuinely alive, which is exactly the property the harness needs to distinguish "real but
// slow" from "hung/crashed" (see the header doc). Card 75f6bdcf: delaying the FIRST tick by
// FIXTURE_HEARTBEAT_PAUSE_MS (default 0, so unset callers are unaffected) deterministically reproduces a
// real silent window of that exact duration — the heartbeat is the only RECURRING output this fixture
// ever emits unprompted, so once FIXTURE_READY has already fired (or with readyDelayMs itself held past
// the pause), pausing it genuinely leaves the pty silent for the whole pause duration.
setTimeout(() => {
  setInterval(() => {
    process.stdout.write("FIXTURE_ALIVE\n");
  }, heartbeatMs);
}, heartbeatPauseMs);

let chunks = [];
let debounceTimer = null;
let flushSeq = 0;
process.stdin.on("data", (d) => {
  chunks.push(Buffer.from(d));
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const buf = Buffer.concat(chunks);
    const hash = crypto.createHash("sha256").update(buf).digest("hex");
    flushSeq++;
    // A SEPARATE file per flush (never appended/overwritten) so the harness can tell multiple flushes
    // apart unambiguously, mirroring how FIXTURE_RECEIVED already appeared once per flush on stdout.
    fs.writeFileSync(`${outputFile}.${flushSeq}`, buf);
    process.stdout.write(`FIXTURE_RECEIVED len=${buf.length} sha256=${hash} file=${flushSeq}\n`);
    chunks = [];
  }, debounceMs);
});

// Stay alive — a real claude does too. The harness stops us explicitly.
process.stdin.resume();
