import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// GET /api/sessions/:id/transcript tail param (card 79057de9). HERMETIC + CLAUDE-FREE: Db + buildServer
// via app.inject, reading an ARCHIVED snapshot under a temp LOOM_HOME (no ~/.claude access).
// Pins: (1) no param -> the bare turn array, byte-identical to the unpaged read; (2) ?offset=N -> the shared
// pageTranscript envelope from turn N; (3) bounds (offset past the end, limit paging via nextOffset);
// (4) a bad offset/limit -> 400; (5) bytes per poll, full vs tail, on a ~300-turn fixture.
import fs from "node:fs";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

const TMP = mkdtempManaged("lt-tail-");
process.env.LOOM_HOME = TMP;
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { archivedTranscriptPath, readArchivedTranscript } = await import("../dist/sessions/transcript.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const now = new Date().toISOString();
const db = new Db(path.join(TMP, "loom.db"));
db.insertProject({ id: "pT", name: "T", repoPath: TMP, vaultPath: TMP, config: {}, createdAt: now, archivedAt: null });
db.insertProfile({ id: "prT", name: "Dev", role: "worker", description: "d", allowDelta: [], skills: null, model: null, icon: null });
db.insertAgent({ id: "aT", projectId: "pT", name: "A", startupPrompt: "x", position: 0, profileId: "prT" });
db.insertSession({ id: "sT", projectId: "pT", agentId: "aT", engineSessionId: null, title: null, cwd: TMP,
  processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null });
db.archiveSession("sT");

// ~300 turns of realistic weight (~1.2 KB each): alternating human / assistant lines.
const N = 300;
const lines = [];
for (let i = 0; i < N; i++) {
  const text = `turn ${i} ` + "lorem ipsum dolor sit amet ".repeat(45);
  lines.push(JSON.stringify(i % 2 === 0
    ? { type: "user", message: { role: "user", content: text } }
    : { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } }));
}
const file = archivedTranscriptPath("pT", "sT");
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, lines.join("\n") + "\n");
const expected = readArchivedTranscript("pT", "sT");
check(`fixture parses to ${N} turns`, expected.length === N);

const app = await buildServer({
  db, pty: {}, sessions: {}, mcp: {}, orchMcp: {}, platformMcp: {}, auditMcp: {}, userAuditMcp: {}, setupMcp: {},
  runMcp: {}, control: {}, usageStatus: {}, requestShutdown: () => {},
});
try {
  const get = (q = "") => app.inject({ method: "GET", url: `/api/sessions/sT/transcript${q}` });

  const full = await get();
  check("(1) no param: 200 and the bare array, byte-identical to the unpaged read",
    full.statusCode === 200 && full.body === JSON.stringify(expected));

  const held = 298;
  const tail = await get(`?offset=${held}`);
  const env = JSON.parse(tail.body);
  check("(2) ?offset=N: the pageTranscript envelope",
    tail.statusCode === 200 && env.totalTurns === N && env.offset === held && env.returned === 2 && env.nextOffset === null);
  check("(2) the turns are exactly the tail of the full read", JSON.stringify(env.turns) === JSON.stringify(expected.slice(held)));

  const zero = JSON.parse((await get("?offset=0")).body);
  check("(3) offset=0 is an envelope too (not the bare array) and pages with nextOffset when over budget",
    !Array.isArray(zero) && zero.totalTurns === N && zero.returned > 0 && (zero.returned === N || zero.nextOffset === zero.returned));

  const past = JSON.parse((await get(`?offset=${N + 50}`)).body);
  check("(3) offset past the end: empty turns, offset clamped to the total, no nextOffset",
    past.returned === 0 && past.turns.length === 0 && past.offset === N && past.nextOffset === null && past.totalTurns === N);

  const lim = JSON.parse((await get("?offset=10&limit=5")).body);
  check("(3) limit bounds the page and nextOffset continues it",
    lim.returned === 5 && lim.offset === 10 && lim.nextOffset === 15);

  const limOnly = JSON.parse((await get("?limit=3")).body);
  check("(3) limit alone is an envelope from 0", limOnly.returned === 3 && limOnly.offset === 0 && limOnly.nextOffset === 3);

  for (const bad of ["?offset=-1", "?offset=abc", "?offset=1.5", "?offset=", "?limit=0", "?limit=x", "?offset=0&limit=-2"]) {
    const r = await get(bad);
    check(`(4) ${bad} -> 400`, r.statusCode === 400 && typeof JSON.parse(r.body).error === "string");
  }

  const missing = await app.inject({ method: "GET", url: "/api/sessions/nope/transcript" });
  check("unknown session without a param is still [] (unchanged)", missing.statusCode === 200 && missing.body === "[]");

  console.log(`MEASURE bytes/poll on a ${N}-turn fixture: full=${full.body.length}  tail(2 held-overlap turns)=${tail.body.length}  ratio=${(full.body.length / tail.body.length).toFixed(0)}x`);
} finally {
  await app.close();
  db.close();
}
console.log(failures === 0 ? "\n✅ ALL PASS" : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
