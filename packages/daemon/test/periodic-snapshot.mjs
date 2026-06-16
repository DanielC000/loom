// Periodic transcript-snapshot test (card 1eacc6ce, item 1). HERMETIC like shutdown-snapshot.mjs:
// no daemon, no real claude — drives a real setInterval ticking SessionService.snapshotAllLive()
// against a throwaway Db + an isolated LOOM_HOME, with fake ~/.claude transcript JSONLs as the source.
// Proves the PERIODIC backstop (the hard-crash-no-signal gap the graceful SIGINT hook can't cover):
//   (1) the periodic tick invokes the snapshot path for live sessions (snapshots appear on disk);
//   (2) it is a NO-OP when unchanged — later ticks do NOT re-copy (the snapshot's mtime is stable,
//       proving snapshotTranscript's mtime guard short-circuits on an unchanged JSONL);
//   (3) wiring: the built daemon arms a periodic setInterval that calls snapshotAllLive, and clears
//       that timer on the SIGINT/SIGTERM shutdown path (no dangling timer).
// Run: 1) build the daemon, 2) node test/periodic-snapshot.mjs
import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-periodic-snap-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
requireHermeticEnv(); // confirm LOOM_HOME is the throwaway temp dir, never the real ~/.loom

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { encodeProjectDir, archivedTranscriptExists, archivedTranscriptPath } =
  await import("../dist/sessions/transcript.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const now = new Date().toISOString();
const mkSession = (id, over = {}) => ({
  id, projectId: "pA", agentId: "aA", engineSessionId: null, title: null,
  cwd: "C:/tmp/loom-periodic-snap",
  processState: "live", resumability: "resumable", busy: false,
  createdAt: now, lastActivity: now, lastError: null, ...over,
});

const fakeCwd = path.join(os.tmpdir(), `loom-periodic-snap-cwd-${Date.now()}`);
const claudeDir = path.join(os.homedir(), ".claude", "projects", encodeProjectDir(fakeCwd));
const engineA = `periodic-engine-A-${Date.now()}`;
const engineB = `periodic-engine-B-${Date.now()}`;
const jsonl = '{"type":"user","message":{"content":"hello"}}\n' +
  '{"type":"assistant","message":{"content":[{"type":"text","text":"hi there"}]}}\n';

try {
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, `${engineA}.jsonl`), jsonl);
  fs.writeFileSync(path.join(claudeDir, `${engineB}.jsonl`), jsonl);

  const db = new Db();
  db.insertProject({ id: "pA", name: "PeriodicSnap", repoPath: fakeCwd, vaultPath: fakeCwd, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "aA", projectId: "pA", name: "agentA", startupPrompt: "", position: 0 });
  const sessions = new SessionService(db, {}, {});

  db.insertSession(mkSession("liveA", { engineSessionId: engineA, cwd: fakeCwd }));
  db.insertSession(mkSession("liveB", { engineSessionId: engineB, cwd: fakeCwd }));

  // ════════ (1) a real periodic timer ticks the snapshot path ════════
  // Mirror index.ts EXACTLY: setInterval(() => snapshotAllLive(), N). Tiny interval so the test is fast.
  let ticks = 0;
  let lastCount = 0;
  const timer = setInterval(() => { ticks++; lastCount = sessions.snapshotAllLive(); }, 25);

  // Wait for the first tick to land a snapshot, then confirm both live sessions were snapshotted.
  for (let i = 0; i < 40 && !archivedTranscriptExists("pA", "liveA"); i++) await sleep(10);
  check("(1) periodic tick fired at least once", ticks >= 1);
  check("(1) liveA snapshotted by the periodic tick", archivedTranscriptExists("pA", "liveA"));
  check("(1) liveB snapshotted by the periodic tick", archivedTranscriptExists("pA", "liveB"));
  check("(1) tick returns 2 (both live+engine+JSONL sessions)", lastCount === 2);

  // ════════ (2) no-op when unchanged — later ticks do NOT re-copy (mtime stable) ════════
  const snapPath = archivedTranscriptPath("pA", "liveA");
  const mtimeAfterFirst = fs.statSync(snapPath).mtimeMs;
  const ticksAtMark = ticks;
  // Let several MORE ticks fire without touching the source JSONL.
  for (let i = 0; i < 40 && ticks < ticksAtMark + 3; i++) await sleep(10);
  clearInterval(timer);
  check("(2) several more ticks fired", ticks >= ticksAtMark + 3);
  check("(2) snapshot NOT re-copied on unchanged ticks (mtime stable)",
    fs.statSync(snapPath).mtimeMs === mtimeAfterFirst);
  check("(2) tick still reports 2 on the no-op ticks (idempotent)", lastCount === 2);

  db.close();

  // ════════ (3) wiring: built daemon arms a periodic snapshot timer + clears it on shutdown ════════
  const indexJs = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js"), "utf8");
  // A setInterval whose body calls snapshotAllLive = the periodic backstop (the SHUTDOWN call is a bare
  // snapshotAllLive() in the signal handler, NOT inside a setInterval — so this isolates the timer).
  const periodicWired = (() => {
    let i = indexJs.indexOf("setInterval(");
    while (i !== -1) {
      if (/snapshotAllLive/.test(indexJs.slice(i, i + 200))) return true;
      i = indexJs.indexOf("setInterval(", i + 1);
    }
    return false;
  })();
  check("(3) built daemon arms a setInterval that calls snapshotAllLive", periodicWired);
  // The graceful-shutdown path must clear the periodic timer (alongside the existing reconcile timer) so
  // no snapshot ticker dangles past shutdown. The teardown now lives in the SHARED gracefulShutdown()
  // (invoked by the SIGINT/SIGTERM handler AND the POST /internal/shutdown control hook) — anchor there
  // and assert it clears TWO intervals.
  const sigIdx = indexJs.indexOf("gracefulShutdown = (");
  const region = sigIdx >= 0 ? indexJs.slice(sigIdx, sigIdx + 1400) : "";
  check("(3) shutdown clears the periodic snapshot timer (≥2 clearInterval calls)",
    (region.match(/clearInterval\(/g) || []).length >= 2);
} finally {
  try { fs.rmSync(path.join(claudeDir, `${engineA}.jsonl`), { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(path.join(claudeDir, `${engineB}.jsonl`), { force: true }); } catch { /* ignore */ }
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the periodic tick snapshots every live transcript, is a mtime-guarded no-op on unchanged ticks, and the built daemon arms+clears the snapshot timer on shutdown."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
