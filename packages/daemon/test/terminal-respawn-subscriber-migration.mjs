import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 019d2e7a — a `/ws/term` viewer must SURVIVE a same-session respawn (Stop→Resume, recycle, fork).
//
// THE DEFECT THIS PINS: `PtyHost.subscribe()` adds the viewer to whichever `Live` holds the sessionId at
// attach time, but every (re)spawn builds a BRAND-NEW `Live` with `subscribers: new Set()` and overwrites
// the map entry. The pre-existing subscriber was left in the discarded, dead `Live` — its socket stayed
// OPEN and silent forever, while `writeStdin`'s own id lookup happily reached the NEW pty. So a resumed
// session's tile looked alive, echoed nothing, and could only be recovered by navigating away and back.
// `adoptSubscribers` (pty/host.ts) now carries the set across and announces the swap.
//
// RED ON PRE-FIX CODE: assertions (3)/(4)/(5) all fail — no `reset`/`geometry` frame is emitted at all and
// the successor pty's bytes never reach the subscriber.
//
// POSITIVE CONTROL (assertion (1)): the SAME recorder is first proven to receive the FIRST pty's bytes.
// Without it, "the recorder saw nothing" after the respawn is indistinguishable from a broken recorder —
// and every post-respawn assertion here is an absence-shaped claim in the direction that passes silently.
//
// HERMETIC + CLAUDE-FREE + NETWORK-FREE + NO REAL PROCESS: the real PtyHost driven through its own
// `createPty` seam with a fake pty whose onData/onExit callbacks this file holds and fires by hand.
//
// RUN (after `pnpm build`): node test/terminal-respawn-subscriber-migration.mjs
import fs from "node:fs";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failures++;
};

const TMP = mkdtempManaged("loom-term-respawn-");
fs.mkdirSync(path.join(TMP, "logs"), { recursive: true });
process.env.LOOM_HOME = TMP;
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME
requireHermeticEnv();

const { PtyHost } = await import("../dist/pty/host.js");

// A fake pty that HANDS BACK its onData/onExit callbacks, so this file drives every byte and every exit
// explicitly — no timing, no sleeps, no real process. The shared `_seam-host-fixture.mjs` discards the
// onData callback (nothing it serves needs to push bytes), which is exactly what this test does need.
const ptys = [];
function makeFakePty() {
  const p = {
    pid: 5100 + ptys.length,
    dataCb: null,
    exitCb: null,
    writes: [],
    write(d) { p.writes.push(d); },
    onData(cb) { p.dataCb = cb; return { dispose() {} }; },
    onExit(cb) { p.exitCb = cb; return { dispose() {} }; },
    kill() { const cb = p.exitCb; p.exitCb = null; cb?.({ exitCode: 0 }); },
    resize() {},
    emit(text) { p.dataCb?.(text); },
  };
  ptys.push(p);
  return p;
}

class SeamHost extends PtyHost {
  reapExitedDescendants(_rootPid) {}
  createPty(_opts) { return makeFakePty(); }
}

const events = {
  onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {},
};
const host = new SeamHost(events);

const SID = "respawn-subscriber-test";
const ENGINE_ID = "6f1c7f7e-0000-4000-8000-respawnengine";
const permission = { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 };
const geometry = { cols: 120, rows: 40 };
const sessionEnv = {};

// The viewer: exactly the shape `/ws/term`'s handler registers (gateway/server.ts) — an onData sink plus
// an onControl sink, nothing else.
const seen = { data: [], control: [] };
const viewer = {
  onData: (b) => { seen.data.push(b.toString("utf8")); },
  onControl: (e) => { seen.control.push(e); },
};
const controlTypes = () => seen.control.map((e) => e.type);

try {
  // ── FIRST spawn + attach ───────────────────────────────────────────────────────────────────────────
  host.spawn({ sessionId: SID, cwd: TMP, permission, geometry, sessionEnv });
  const unsub = host.subscribe(SID, viewer);
  check("(0) attach emits the pinned geometry (subscribe's own contract, unchanged)",
    controlTypes().includes("geometry"));

  seen.data.length = 0;
  ptys[0].emit("FIRST-PTY-BYTES");
  // POSITIVE CONTROL for every absence-shaped assertion below: this recorder DOES receive pty bytes when
  // it is correctly wired, so a later empty `seen.data` is a measured zero, not a broken instrument's
  // default output.
  check("(1) CONTROL: the attached viewer receives the FIRST pty's bytes",
    seen.data.join("").includes("FIRST-PTY-BYTES"), `got ${JSON.stringify(seen.data)}`);

  // ── Stop → Resume: the exact sequence the cockpit's Stop/Resume buttons drive ───────────────────────
  ptys[0].kill(); // the real pty's 'exit' event; the Live stays in the map with alive:false
  check("(2) the first pty is no longer alive", host.isAlive(SID) === false);

  seen.control.length = 0;
  seen.data.length = 0;
  host.spawn({ sessionId: SID, cwd: TMP, permission, geometry, sessionEnv, resumeId: ENGINE_ID });
  check("respawn built a second pty", ptys.length === 2);

  // ── The fix ────────────────────────────────────────────────────────────────────────────────────────
  check("(3) the respawn tells the surviving viewer to clear its screen (`reset`)",
    controlTypes().includes("reset"), `control frames: ${JSON.stringify(controlTypes())}`);
  check("(4) …and re-announces the successor's pinned geometry",
    seen.control.some((e) => e.type === "geometry" && e.cols === geometry.cols && e.rows === geometry.rows),
    `control frames: ${JSON.stringify(seen.control)}`);
  check("(4b) …and the resumed engine session id, so the pane is not left naming the dead process",
    seen.control.some((e) => e.type === "sessionId" && e.id === ENGINE_ID),
    `control frames: ${JSON.stringify(seen.control)}`);

  ptys[1].emit("SECOND-PTY-BYTES");
  check("(5) the viewer attached BEFORE the respawn receives the SUCCESSOR pty's bytes",
    seen.data.join("").includes("SECOND-PTY-BYTES"), `got ${JSON.stringify(seen.data)}`);

  // ── The stale-exit half: the dying pty's exit event can land AFTER the successor is up ──────────────
  // A hard kill's exit is asynchronous, so `broadcastControl` on the OUTGOING Live must find nobody home
  // — otherwise the viewer now watching a healthy process is told its session exited.
  seen.control.length = 0;
  ptys[0].exitCb?.({ exitCode: 0 }); // no-op today (kill() consumed it); belt-and-braces if that changes
  check("(6) the outgoing Live retains no subscribers, so its late `exit` reaches nobody",
    !seen.control.some((e) => e.type === "exit"), `control frames: ${JSON.stringify(controlTypes())}`);

  // ── Detach must still work after a migration ───────────────────────────────────────────────────────
  // `subscribe()` closed over the FIRST Live; without the current-entry lookup in its returned unsub, the
  // viewer would stay wired into the successor forever and keep being pushed at a closed socket.
  unsub();
  seen.data.length = 0;
  ptys[1].emit("POST-UNSUB-BYTES");
  check("(7) unsub detaches from the live entry the viewer was MIGRATED into, not just the original",
    !seen.data.join("").includes("POST-UNSUB-BYTES"), `got ${JSON.stringify(seen.data)}`);

  // ── A SECOND respawn must not resurrect the detached viewer ────────────────────────────────────────
  seen.control.length = 0;
  seen.data.length = 0;
  host.spawn({ sessionId: SID, cwd: TMP, permission, geometry, sessionEnv, resumeId: ENGINE_ID });
  ptys[2].emit("THIRD-PTY-BYTES");
  check("(8) a later respawn does not re-adopt an already-detached viewer",
    seen.data.length === 0 && seen.control.length === 0,
    `data=${JSON.stringify(seen.data)} control=${JSON.stringify(controlTypes())}`);
} finally {
  try { host.stop(SID, "hard"); } catch { /* ignore */ }
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
await finishAndExit(failures === 0 ? 0 : 1);
