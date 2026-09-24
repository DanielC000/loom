import "./_guard.mjs";
// Card 5b4ddca5 — PtyHost.repaint() (a Ctrl-L / form feed written into the agent pty) must be a no-op while a
// chunked write (bracketed paste / backspace burst) is mid-flight for that session, so a viewer's repaint can
// never land at a chunk seam inside the paste. The gateway's per-socket remote rate limit is covered in
// ws-term-remote-token-stdin.mjs.
// HERMETIC: real PtyHost + fake pty (no claude). A wide, deterministic chunk window via the env seams.
// RUN: node test/pty-repaint-inflight-paste.mjs   (needs a built dist)
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

const TMP = mkdtempManaged("loom-repaint-inflight-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PTY_WRITE_CHUNK_BYTES = "4";
process.env.LOOM_PTY_WRITE_CHUNK_DELAY_MS = "60";
requireHermeticEnv();

const { PtyHost } = await import("../dist/pty/host.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const writes = [];
const fake = {
  pid: 4242, write: (d) => { writes.push(d); }, onData: () => ({ dispose() {} }), onExit: (cb) => { void cb; return { dispose() {} }; },
  kill() {}, resize() {},
};
class TestPtyHost extends PtyHost { createPty() { return fake; } }
const host = new TestPtyHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
const SID = "sess-repaint-inflight";
host.spawn({ sessionId: SID, cwd: TMP, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
host.deliverHook(SID, { hook_event_name: "SessionStart" });
const FF = (d) => d === "\x0c";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // Positive control: an idle repaint DOES write exactly one Ctrl-L.
  const base = writes.length;
  host.repaint(SID);
  check("control: idle repaint writes one Ctrl-L", writes.slice(base).filter(FF).length === 1);

  // 40 units / 4 per chunk = 10 chunks, 60ms apart. Flood repaints while the burst is mid-flight.
  const before = writes.length;
  let done = false;
  host.writeChunked(SID, "abcdefgh".repeat(5), () => { done = true; });
  for (let i = 0; i < 100; i++) host.repaint(SID); // synchronous flood: first chunk written, burst provably in flight
  check("in-flight: burst is still mid-flight during the flood (positive witness)", !done);
  await new Promise((r) => { const t = setInterval(() => { if (done) { clearInterval(t); r(); } }, 10); });
  const burst = writes.slice(before);
  check("in-flight: ZERO Ctrl-L written during the chunked burst", burst.filter(FF).length === 0);
  check("in-flight: the paste itself arrived intact and in order", burst.join("") === "abcdefgh".repeat(5));

  // After the burst completes, repaint works again (the counter is released).
  const after = writes.length;
  host.repaint(SID);
  check("post-burst: repaint writes again (in-flight counter released)", writes.slice(after).filter(FF).length === 1);
} finally {
  await sleep(0);
}
await finishAndExit(failures === 0 ? 0 : 1);
