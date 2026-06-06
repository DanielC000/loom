// Graceful-shutdown transcript backstop test (card 695993fe). HERMETIC like session-archive.mjs:
// no daemon, no real claude — drives SessionService.snapshotAllLive() against a throwaway Db + an
// isolated LOOM_HOME, with fake ~/.claude transcript JSONLs as the snapshot source. Proves:
//   (1) snapshotAllLive snapshots EVERY live session that has an engineSessionId AND a JSONL on disk;
//   (2) it SKIPS exited sessions, live sessions with NO engineSessionId, and live sessions whose JSONL
//       is already gone (the count reflects only sessions actually preserved);
//   (3) it is idempotent — a second call is an mtime-guarded no-op that re-reports the same count and
//       leaves the snapshots intact;
//   (4) it NEVER throws across a mixed dataset;
//   (5) wiring: the built daemon's SIGINT/SIGTERM handler invokes snapshotAllLive before exiting.
// Run: 1) build the daemon, 2) node test/shutdown-snapshot.mjs
import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-shutdown-snap-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
requireHermeticEnv(); // confirm LOOM_HOME is the throwaway temp dir, never the real ~/.loom

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { encodeProjectDir, archivedTranscriptExists } = await import("../dist/sessions/transcript.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const now = new Date().toISOString();
const mkSession = (id, over = {}) => ({
  id, projectId: "pA", agentId: "aA", engineSessionId: null, title: null,
  cwd: "C:/tmp/loom-shutdown-snap",
  processState: "live", resumability: "resumable", busy: false,
  createdAt: now, lastActivity: now, lastError: null, ...over,
});

// ── fake ~/.claude transcript fixtures (a real engine JSONL is the snapshot source) ──
const fakeCwd = path.join(os.tmpdir(), `loom-shutdown-snap-cwd-${Date.now()}`);
const claudeDir = path.join(os.homedir(), ".claude", "projects", encodeProjectDir(fakeCwd));
const engineA = `shutdown-engine-A-${Date.now()}`;
const engineB = `shutdown-engine-B-${Date.now()}`;
const jsonl = '{"type":"user","message":{"content":"hello"}}\n' +
  '{"type":"assistant","message":{"content":[{"type":"text","text":"hi there"}]}}\n';

try {
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, `${engineA}.jsonl`), jsonl);
  fs.writeFileSync(path.join(claudeDir, `${engineB}.jsonl`), jsonl);

  const db = new Db();
  db.insertProject({ id: "pA", name: "SnapShutdown", repoPath: fakeCwd, vaultPath: fakeCwd, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "aA", projectId: "pA", name: "agentA", startupPrompt: "", position: 0 });
  const sessions = new SessionService(db, {}, {});

  // Two LIVE sessions with an engineSessionId AND a JSONL on disk → both must be snapshotted.
  db.insertSession(mkSession("liveA", { engineSessionId: engineA, cwd: fakeCwd }));
  db.insertSession(mkSession("liveB", { engineSessionId: engineB, cwd: fakeCwd }));
  // LIVE but its JSONL is already gone (the 'dead' case) → snapshotTranscript returns false, NOT counted.
  db.insertSession(mkSession("liveNoJsonl", { engineSessionId: "ghost-engine-no-file", cwd: fakeCwd }));
  // EXITED with a real JSONL → skipped by the live filter (onExit already handled it).
  db.insertSession(mkSession("exitedC", { engineSessionId: engineA, cwd: fakeCwd, processState: "exited" }));
  // LIVE but no engineSessionId (e.g. a shell terminal / pre-SessionStart) → skipped.
  db.insertSession(mkSession("liveNoEngine", { engineSessionId: null, cwd: fakeCwd }));

  // ════════ (1)+(2) snapshot live+engine+JSONL, skip the rest ════════
  let count;
  let threw = false;
  try { count = sessions.snapshotAllLive(); } catch { threw = true; }
  check("(4) snapshotAllLive never throws on a mixed dataset", threw === false);
  check("(1) returns 2 (only the two live sessions with an on-disk JSONL)", count === 2);
  check("(1) liveA transcript snapshotted", archivedTranscriptExists("pA", "liveA"));
  check("(1) liveB transcript snapshotted", archivedTranscriptExists("pA", "liveB"));
  check("(2) liveNoJsonl NOT snapshotted (JSONL already gone)", !archivedTranscriptExists("pA", "liveNoJsonl"));
  check("(2) exitedC NOT snapshotted (skipped — not live)", !archivedTranscriptExists("pA", "exitedC"));
  check("(2) liveNoEngine NOT snapshotted (skipped — no engine id)", !archivedTranscriptExists("pA", "liveNoEngine"));

  // ════════ (3) idempotent — mtime-guarded no-op, same count, snapshots intact ════════
  let count2;
  let threw2 = false;
  try { count2 = sessions.snapshotAllLive(); } catch { threw2 = true; }
  check("(3) second call never throws", threw2 === false);
  check("(3) idempotent: second call re-reports 2", count2 === 2);
  check("(3) snapshots still present after the no-op re-run",
    archivedTranscriptExists("pA", "liveA") && archivedTranscriptExists("pA", "liveB"));

  // ════════ (4b) never throws when there are NO live sessions at all (empty sweep) ════════
  const db2 = new Db(path.join(process.env.LOOM_HOME, "empty.db"));
  const empty = new SessionService(db2, {}, {});
  let emptyCount, emptyThrew = false;
  try { emptyCount = empty.snapshotAllLive(); } catch { emptyThrew = true; }
  check("(4) empty fleet: returns 0 and never throws", emptyThrew === false && emptyCount === 0);
  db2.close();
  db.close();

  // ════════ (5) wiring: the built SIGINT/SIGTERM handler invokes snapshotAllLive ════════
  const indexJs = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js"), "utf8");
  // Isolate the signal-handler region (the `for (const sig of [...SIGINT...SIGTERM...]` loop body) and
  // assert it calls snapshotAllLive BEFORE process.exit(0) — the shutdown backstop must run on a kill.
  const sigIdx = indexJs.indexOf('"SIGINT"');
  const region = sigIdx >= 0 ? indexJs.slice(sigIdx, sigIdx + 1200) : "";
  check("(5) built daemon references snapshotAllLive", /snapshotAllLive\s*\(/.test(indexJs));
  check("(5) the SIGINT/SIGTERM handler invokes snapshotAllLive before exit",
    /snapshotAllLive\s*\(/.test(region) && region.indexOf("snapshotAllLive") < region.indexOf("process.exit(0)"));
} finally {
  try { fs.rmSync(path.join(claudeDir, `${engineA}.jsonl`), { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(path.join(claudeDir, `${engineB}.jsonl`), { force: true }); } catch { /* ignore */ }
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — snapshotAllLive snapshots every live+engine+JSONL session, skips exited/no-engine/dead, is idempotent, never throws, and the SIGINT/SIGTERM handler invokes it before exit."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
