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
import fs from "node:fs";
import crypto from "node:crypto";

const outputFile = process.env.FIXTURE_OUTPUT_FILE;
if (!outputFile) {
  process.stdout.write("FIXTURE_FAIL FIXTURE_OUTPUT_FILE env var is required but was not set\n");
  process.exit(1);
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

setTimeout(() => {
  process.stdout.write("FIXTURE_READY\n");
}, readyDelayMs);

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
