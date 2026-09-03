import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Memory read surface — GET /api/projects/:id/memory (card 7ea6ce71; `backlinks` added by card
// d371a9bf). HERMETIC + CLAUDE-FREE + NETWORK-FREE: Db + buildServer via app.inject against two
// projects seeded with project_memory rows. Modeled on vault-raw.mjs (inject) + project-memory.mjs (db
// seeding). Proves the contract the /memory page reads:
//   (1) PROJECT-SCOPING — a project's memory read returns THIS project's entries ONLY, never another
//       project's (the one correctness thing the reviewer checks hard);
//   (2) SHAPE — each row carries pinned (bool) / retrievalCount (num) / updatedAt (str) / key/title/text;
//   (3) ORDER — pinned first, then most-recently-updated (db.listProjectMemory ordering);
//   (4) 404 on an unknown project; read-only (no write/forget counterpart on this path).
//   (5) BACKLINKS (card d371a9bf) — each row carries a structured `{keys, totalFound}` (NOT the agent-
//       facing prose annotation lines), resolved from THIS project's own store only (backlinks must
//       never leak across the same project-scoping boundary as (1)); a MEASURED zero for a note nothing
//       links to; the MAX_BACKLINKS cap + "showing N of M" truncation at scale, mirroring the tool
//       contract; and — the field this route deliberately does NOT carry — no `requestAnnotations` /
//       `everDelivered` anywhere in the response (the card's DoD-2 exclusion, verified negatively).
// Run after build: node test/memory-rest.mjs
import fs from "node:fs";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

const TMP = mkdtempManaged("loom-memory-rest-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = "45361";
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { MAX_BACKLINKS } = await import("../dist/sessions/project-memory-backlinks.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const stub = {};
const buildApp = (db) => buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });

const db = new Db(path.join(TMP, "loom.db"));
const now = new Date().toISOString();
db.insertProject({ id: "projA", name: "Project A", repoPath: TMP, vaultPath: TMP, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertProject({ id: "projB", name: "Project B", repoPath: TMP, vaultPath: TMP, config: {}, createdAt: now, archivedAt: null, reserved: false });

// Seed A: two pinned + two unpinned. Bump retrieval on one so retrievalCount surfaces non-zero.
db.upsertProjectMemory("projA", { key: "a-pinned-1", text: "A pinned one body", title: "A Pinned One", pinned: true }, 500);
db.upsertProjectMemory("projA", { key: "a-pinned-2", text: "A pinned two body", title: "A Pinned Two", pinned: true }, 500);
const aHot = db.upsertProjectMemory("projA", { key: "a-hot", text: "A hot unpinned body", title: "A Hot" }, 500);
db.upsertProjectMemory("projA", { key: "a-cold", text: "A cold unpinned body", title: "A Cold" }, 500);
db.touchProjectMemoryRetrieved([aHot.id, aHot.id, aHot.id]); // retrievalCount → 3
// (5) a companion note in A that backlinks to a-hot — a-cold stays a MEASURED-zero control (nothing links to it).
db.upsertProjectMemory("projA", { key: "a-hot-companion", text: "overflow, see [[a-hot]] for the parent", title: "A Hot Companion" }, 500);

// Seed B with a DISTINCT key so a scope leak is unambiguous. Also links to A's "a-hot" key by name — a
// same-named key existing only in A, so if backlink resolution ever forgot to scope by project, this
// would leak into A's a-hot backlink count.
db.upsertProjectMemory("projB", { key: "b-secret-note", text: "B-only body — must never appear under A", title: "B Secret" }, 500);
db.upsertProjectMemory("projB", { key: "b-cross-project-linker", text: "mentions [[a-hot]] but this is project B, not A", title: "B Cross-Project Linker" }, 500);

// A third project, scaled past MAX_BACKLINKS, to prove the cap + "showing N of M" truncation.
db.insertProject({ id: "projC", name: "Project C", repoPath: TMP, vaultPath: TMP, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.upsertProjectMemory("projC", { key: "c-popular", text: "a note many others link to", title: "C Popular" }, 500);
const cLinkerCount = MAX_BACKLINKS + 4;
for (let i = 0; i < cLinkerCount; i++) {
  db.upsertProjectMemory("projC", { key: `c-linker-${String(i).padStart(2, "0")}`, text: `references [[c-popular]] among ${i}` }, 500);
}

const app = await buildApp(db);
const mem = (id) => app.inject({ method: "GET", url: `/api/projects/${id}/memory` });

try {
  const a = await mem("projA");
  check("(1) GET A/memory → 200", a.statusCode === 200);
  const aRows = a.json();
  check("(1) A returns exactly its 5 entries", Array.isArray(aRows) && aRows.length === 5);
  const aKeys = aRows.map((r) => r.key);
  check("(1) A includes its own keys", ["a-pinned-1", "a-pinned-2", "a-hot", "a-cold", "a-hot-companion"].every((k) => aKeys.includes(k)));
  check("(1) PROJECT-SCOPING: A NEVER leaks B's entry", !aKeys.includes("b-secret-note"));
  check("(1) PROJECT-SCOPING: no A row carries projectId B", aRows.every((r) => r.projectId === "projA"));

  const b = await mem("projB");
  const bRows = b.json();
  check("(1) B returns ONLY its own two entries", b.statusCode === 200 && bRows.length === 2);
  check("(1) PROJECT-SCOPING: B NEVER leaks any of A's entries", !bRows.some((r) => aKeys.includes(r.key)));

  // (2) shape — the fields the /memory page reads
  const hot = aRows.find((r) => r.key === "a-hot");
  check("(2) SHAPE: pinned is a boolean", typeof hot.pinned === "boolean" && hot.pinned === false);
  check("(2) SHAPE: retrievalCount is a number and reflects the 3 touches", typeof hot.retrievalCount === "number" && hot.retrievalCount === 3);
  check("(2) SHAPE: updatedAt is a non-empty string", typeof hot.updatedAt === "string" && hot.updatedAt.length > 0);
  check("(2) SHAPE: key/title/text present", typeof hot.key === "string" && typeof hot.title === "string" && typeof hot.text === "string");
  check("(2) SHAPE: content body is served for the detail view", hot.text === "A hot unpinned body");
  const pinnedRow = aRows.find((r) => r.key === "a-pinned-1");
  check("(2) SHAPE: a pinned row reports pinned:true", pinnedRow.pinned === true);

  // (3) order — pinned first (db.listProjectMemory: ORDER BY pinned DESC, updated_at DESC)
  const firstTwoPinned = aRows.slice(0, 2).every((r) => r.pinned === true);
  const lastTwoUnpinned = aRows.slice(2).every((r) => r.pinned === false);
  check("(3) ORDER: pinned entries sort ahead of unpinned", firstTwoPinned && lastTwoUnpinned);

  // (4) unknown project → 404
  check("(4) unknown project → 404", (await mem("nope")).statusCode === 404);

  // (5) BACKLINKS (card d371a9bf)
  const aHotRow = aRows.find((r) => r.key === "a-hot");
  const aColdRow = aRows.find((r) => r.key === "a-cold");
  check("(5) SHAPE: backlinks is a structured {keys, totalFound}, not the agent-facing string[] annotation lines",
    !!aHotRow.backlinks && Array.isArray(aHotRow.backlinks.keys) && typeof aHotRow.backlinks.totalFound === "number");
  check("(5) POSITIVE: a-hot's backlinks names its companion by bare key (navigable, not a prose line)",
    aHotRow.backlinks.keys.length === 1 && aHotRow.backlinks.keys[0] === "a-hot-companion" &&
    aHotRow.backlinks.totalFound === 1);
  check("(5) NEGATIVE / MEASURED ZERO: a-cold (nothing links to it) reports keys:[] totalFound:0, present not omitted",
    "backlinks" in aColdRow && aColdRow.backlinks.keys.length === 0 && aColdRow.backlinks.totalFound === 0);
  check("(5) PAIRED CONTROL SANITY: a-hot and a-cold are NOT both zero (a broken resolver would make both empty)",
    !(aHotRow.backlinks.keys.length === 0 && aColdRow.backlinks.keys.length === 0));
  check("(5) PROJECT-SCOPING: a-hot's backlinks NEVER counts B's same-named-key mention (cross-project leak guard)",
    !aHotRow.backlinks.keys.includes("b-cross-project-linker"));

  // (5) cap + truncation, at scale, mirroring the agent-facing tool contract
  const c = await mem("projC");
  check("(5) GET C/memory → 200", c.statusCode === 200);
  const cPopular = c.json().find((r) => r.key === "c-popular");
  check(`(5) CAP: totalFound reports the TRUE total (${cLinkerCount}), uncapped`, cPopular.backlinks.totalFound === cLinkerCount);
  check(`(5) CAP: keys is capped at MAX_BACKLINKS (${MAX_BACKLINKS})`, cPopular.backlinks.keys.length === MAX_BACKLINKS);
  check("(5) CAP: every capped key is a real linker key (no placeholder/truncation-notice string mixed into keys)",
    cPopular.backlinks.keys.every((k) => k.startsWith("c-linker-")));

  // (5) DoD-2: the response NEVER carries requestAnnotations/everDelivered anywhere — the card's explicit
  // exclusion, checked on the RAW serialized JSON so a field added anywhere in the shape would be caught.
  const rawA = JSON.stringify(aRows);
  const rawC = JSON.stringify(c.json());
  check("(5) DoD-2 EXCLUSION: no row anywhere carries requestAnnotations", !rawA.includes("requestAnnotations") && !rawC.includes("requestAnnotations"));
  check("(5) DoD-2 EXCLUSION: no row anywhere carries everDelivered", !rawA.includes("everDelivered") && !rawC.includes("everDelivered"));
} finally {
  try { await app.close(); } catch { /* ignore */ }
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — GET /api/projects/:id/memory is project-scoped (A never leaks B and vice-versa), returns the pinned/retrievalCount/updatedAt shape with note content, orders pinned-first, 404s an unknown project, and (card d371a9bf) carries a structured, project-scoped, capped `backlinks` field while never leaking requestAnnotations/everDelivered."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
