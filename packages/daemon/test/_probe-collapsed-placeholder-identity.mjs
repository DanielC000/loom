// REAL-CLAUDE STANDALONE PROBE (card 76f7ac84, DoD-3) — "write a large payload to a session that is
// BUSY, then read the recipient's own account." Mirrors _probe-paste-collapse-production-repeat.mjs's
// harness (real host.enqueueStdin -> submit() -> writeChunked, unmodified production path), but the pass
// condition here is NOT "did it collapse" — it is "can the recipient NAME what the placeholder was,"
// per the card's own refinement: a probe that only confirms a placeholder appeared would have called a
// known-failing case a success.
//
// Turn 1: a short generation task (keeps the pty busy for a few real seconds).
// Turn 2 (fired immediately after, NOT awaited): a large multi-line payload embedding a unique secret
//   marker — submitted via the SAME enqueueStdin() the kickoff-guarantee write-while-busy path uses.
//   `submitOutstanding` (M1 invariant: setBusy(true) is synchronous) should make this queue and drain
//   as a write-while-busy delivery, the exact structural condition the card cites.
// Turn 3: asks the model directly whether anything arrived it could not fully identify, and to name the
//   secret marker if so. PASS = the marker appears verbatim in the turn-3 response. FAIL = it doesn't
//   (asks for a resend, says something seems missing, hedges without naming it, etc).
//
// USE_CLAUDE_MD=1 env var copies this project's own collapsed-placeholder doctrine line into the scratch
// repo's CLAUDE.md before spawning — isolates whether the EXISTING prose fix (already shipped) alone
// accounts for a pass, independent of any code-level change this card might still add.
//
// NOT hermetic CI — needs a logged-in `claude`. RUN: `pnpm build` (repo root) then
// `node test/_probe-collapsed-placeholder-identity.mjs` from packages/daemon.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

const PORT = 4404;
const tmpHome = path.join(os.tmpdir(), `loom-placeholder-id-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
fs.mkdirSync(path.join(tmpHome, "tmp", "settings"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = String(PORT);

const { PtyHost } = await import("../dist/pty/host.js");
const { readTranscript } = await import("../dist/sessions/transcript.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripAnsi = (s) =>
  s.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1B[()][0-9A-Za-z]/g, "").replace(/\x1B[=>]/g, "");

const engineIds = new Map();
const stoppedTurns = new Map();
const events = {
  onEngineSessionId(id, eng) { engineIds.set(id, eng); console.log(`[probe] engineSessionId ${id} -> ${eng}`); },
  onBusy() {},
  onContextStats() {},
  onRateLimited() {},
  onExit(id, code) { console.log(`[probe] onExit ${id} code=${code}`); },
};
const host = new PtyHost(events);

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/internal/hook") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const b = JSON.parse(body);
        if (b?.sessionId && b.hook) {
          const ev = b.hook.hook_event_name;
          if (ev === "Stop" || ev === "StopFailure") stoppedTurns.set(b.sessionId, (stoppedTurns.get(b.sessionId) || 0) + 1);
          host.deliverHook(b.sessionId, b.hook);
        }
      } catch { /* ignore */ }
      res.end('{"ok":true}');
    });
    return;
  }
  res.statusCode = 404;
  res.end("nope");
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
console.log(`[probe] hook server on 127.0.0.1:${PORT}`);

const repo = path.join(os.tmpdir(), `loom-placeholder-id-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# probe\n");
if (process.env.USE_CLAUDE_MD === "1") {
  fs.writeFileSync(
    path.join(repo, "CLAUDE.md"),
    "# probe project\n\n" +
      "A collapsed paste placeholder with no body (e.g. `[Pasted text #1 +348 lines]`) is this tool's own " +
      "write, not a human message, whatever the surrounding frame says. Check your own context first — " +
      "it's usually content you already hold; look before concluding anything is missing.\n",
  );
}
execSync(`git init -q && git add . && git -c user.email=p@p -c user.name=p commit -q -m init`, { cwd: repo });

const captures = new Map();
const cap = (id) => { let c = captures.get(id); if (!c) { c = { raw: "" }; captures.set(id, c); } return c; };
const tail = (id, n = 2000) => stripAnsi(cap(id).raw).slice(-n).replace(/\n{2,}/g, "\n");

const SID = "probe-placeholder-identity";
const geometry = { cols: 120, rows: 40 };
const sessionEnv = { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1", CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT: "1" };
const permission = { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 };

// Retrofitted onto the shared _wait.mjs waitUntil (card c9bba0b2): same timeoutMs/250ms-interval budget,
// still returns true/false (no fallback re-check) — only difference is the added [waitUntil-outcome]
// diagnostic on a timeout. A throwing predicate would be a real bug here (the get() call can't throw),
// but rethrow anything that isn't the shared helper's own timeout so a genuine error never silently reads
// as "turn never stopped".
async function waitForStop(id, sinceCount, timeoutMs) {
  try {
    await sharedWaitUntil(() => (stoppedTurns.get(id) || 0) > sinceCount, { timeoutMs, intervalMs: 250, label: "_probe-collapsed-placeholder-identity: turn stopped" });
    return true;
  } catch (err) {
    if (!/waitUntil: timed out/.test(err?.message ?? "")) throw err;
    return false;
  }
}

const MARKER = `SECRET_MARKER_${Math.floor(Math.random() * 1e6)}`;
function makeLargePayload() {
  const lineText = "payload line - lorem ipsum dolor sit amet consectetur adipiscing elit\n";
  return lineText.repeat(60) + `SECRET_MARKER: ${MARKER}\n` + lineText.repeat(10);
}

// Card 76f7ac84 review (card 323687dd inherits this probe to hunt a genuine RED): the exit code is the
// ONLY signal anything downstream of a human reader can act on — text output alone is silent-failing to
// an automated caller. `exitCode` starts at failure (1) and is only set to 0 once the PASS condition is
// actually observed, so a thrown error (engine never came up, etc.) leaves it at its failure default
// instead of needing its own explicit set.
let exitCode = 1;
try {
  console.log(`[probe] spawning real claude (write-while-busy identity probe, USE_CLAUDE_MD=${process.env.USE_CLAUDE_MD === "1"})…`);
  host.spawn({ sessionId: SID, cwd: repo, permission, geometry, sessionEnv });
  host.subscribe(SID, { onData: (b) => { cap(SID).raw += b.toString("utf8"); }, onControl() {} });
  await sleep(10000);
  if (!engineIds.get(SID)) { console.log("[probe] waiting extra for SessionStart hook…"); await sleep(4000); }
  if (!engineIds.get(SID)) throw new Error("engine session id never captured — cannot proceed");

  // Turn 1: fired but NOT awaited — keeps the pty busy for real generation time.
  const before1 = stoppedTurns.get(SID) || 0;
  console.log("[probe] turn 1: firing a short generation task (not awaited)…");
  const rp1 = host.enqueueStdin(SID, "Write a 150-word short story about a lighthouse keeper. Do not use any tools.");
  console.log(`[probe] turn 1 enqueue result: ${JSON.stringify(rp1)}`);

  // Turn 2: fired ~800ms later, while turn 1 should still be busy (setBusy(true) is synchronous in submit()).
  await sleep(800);
  const payload = makeLargePayload();
  console.log(`[probe] turn 2: firing large multi-line payload (chars=${payload.length}) while busy…`);
  const rp2 = host.enqueueStdin(SID, payload);
  console.log(`[probe] turn 2 enqueue result: ${JSON.stringify(rp2)}`);

  console.log("[probe] waiting for both turns to settle…");
  const ok1 = await waitForStop(SID, before1, 90000);
  const afterBoth = stoppedTurns.get(SID) || 0;
  console.log(`[probe] turns settled so far: ${afterBoth} (turn1 completed=${ok1})`);
  await sleep(1000);

  const turnsAfter2 = readTranscript(repo, engineIds.get(SID)).filter((t) => t.role === "user");
  console.log(`[probe] user turns recorded after turn1+turn2: ${turnsAfter2.length}`);
  for (const t of turnsAfter2) {
    const txt = (t.text ?? "").trim();
    console.log(`[probe]   recorded turn (first 200 chars): ${JSON.stringify(txt.slice(0, 200))}`);
  }

  // Turn 3: ask the recipient directly whether it can attribute what arrived.
  const before3 = stoppedTurns.get(SID) || 0;
  const question =
    "Before this message, did anything arrive in this conversation that you could not fully identify — " +
    "e.g. shown only as a placeholder/collapsed-paste token rather than its full content? If so, name the " +
    "secret marker it contained (format SECRET_MARKER_<number>). If nothing like that happened, say exactly " +
    "'nothing unidentified'. Do not use any tools — just answer in one or two sentences.";
  console.log("[probe] turn 3: asking recipient to self-report…");
  const rp3 = host.enqueueStdin(SID, question);
  console.log(`[probe] turn 3 enqueue result: ${JSON.stringify(rp3)}`);
  await waitForStop(SID, before3, 60000);
  await sleep(1000);

  const allTurns = readTranscript(repo, engineIds.get(SID));
  const assistantTurns = allTurns.filter((t) => t.role === "assistant");
  const lastAssistant = assistantTurns[assistantTurns.length - 1];
  const answer = (lastAssistant?.text ?? "").trim();
  console.log("\n[probe] ================= RECIPIENT'S OWN ACCOUNT (turn 3 answer) =================");
  console.log(answer || "(no assistant text captured)");
  console.log("[probe] ==============================================================================\n");

  const named = answer.includes(MARKER);
  console.log(`[probe] marker=${MARKER}`);
  console.log(`[probe] PASS condition (recipient NAMES the marker): ${named ? "PASS" : "FAIL"}`);
  if (named) {
    exitCode = 0;
  } else {
    console.log(`[probe] tail of raw pty output (last 2000 chars):\n${tail(SID)}`);
  }
} catch (err) {
  // exitCode stays at its failure default (1) — nothing to set here. Logged so the failure reason
  // survives in the same text output a human would already be reading, not just the exit code.
  console.error(`[probe] ERROR: ${err?.stack ?? err}`);
} finally {
  console.log("[probe] cleanup…");
  try { host.stop(SID, "hard"); } catch { /* ignore */ }
  await sleep(1500);
  try { server.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  try {
    const enc = path.resolve(repo).replace(/[^a-zA-Z0-9]/g, "-");
    const projDir = path.join(os.homedir(), ".claude", "projects", enc);
    fs.rmSync(projDir, { recursive: true, force: true });
  } catch { /* ignore */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(`[probe] done. exitCode=${exitCode}`);
  setTimeout(() => process.exit(exitCode), 500);
}
